//! Native saved-control tests: temporary stores and fake adapters only. No
//! private service, phone credential, live OBS, system tool or media action.
use std::{collections::VecDeque, future::Future, path::PathBuf, pin::Pin, sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}}, time::Duration};
use deck_lib::{actions::{ActionDispatcher, ActionErrorCode, CommandResult, CommandState, DesktopActions, DesktopCommand}, deck::{default_deck, Control, ControlAction, DeckStore, DECK_FILE_NAME}, obs::ObsState, plugin::PluginRegistry, system::{CommandRunner, CommandSpec, RunOutput, SystemError, SystemState, Timeouts}};
use serde_json::{json, Value};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("zdeck-desktop-{}-{}",std::process::id(),NEXT.fetch_add(1,Ordering::Relaxed)));
        std::fs::create_dir(&path).unwrap(); Self(path)
    }
}
impl Drop for TempDir { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
struct FakeRunner { queue: Mutex<VecDeque<Result<RunOutput,SystemError>>>, calls: Mutex<Vec<CommandSpec>>, delay: Duration }
impl FakeRunner {
    fn new(outputs: &[&str], delay: Duration) -> Self {
        Self { queue: Mutex::new(outputs.iter().map(|s| Ok(RunOutput {success:true,stdout:s.to_string()})).collect()),calls:Mutex::new(Vec::new()),delay }
    }
    fn calls(&self) -> Vec<CommandSpec> { self.calls.lock().unwrap().clone() }
}
impl CommandRunner for FakeRunner {
    fn run<'a>(&'a self,spec:&'a CommandSpec) -> Pin<Box<dyn Future<Output=Result<RunOutput,SystemError>>+Send+'a>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(spec.clone());
            tokio::time::sleep(self.delay).await;
            self.queue.lock().unwrap().pop_front().expect("unexpected adapter call (possible retry)")
        })
    }
}
struct Env { dir:TempDir, store:Arc<DeckStore>, dispatcher:Arc<ActionDispatcher>, desktop:Arc<DesktopActions>, runner:Arc<FakeRunner>, plugin:Arc<PluginRegistry> }
impl Env {
    async fn new(outputs:&[&str],delay:Duration,deadline:Duration) -> Self {
        let dir=TempDir::new(); let store=Arc::new(DeckStore::new(dir.0.join(DECK_FILE_NAME)));
        store.save(0,default_deck()).await.unwrap();
        let runner=Arc::new(FakeRunner::new(outputs,delay));
        let system=Arc::new(SystemState::with_runner_and_timeouts(runner.clone(),Timeouts {command:deadline}));
        let plugin=Arc::new(PluginRegistry::default());
        let dispatcher=Arc::new(ActionDispatcher::new(Arc::new(ObsState::default()),system,plugin.clone()));
        let desktop=Arc::new(DesktopActions::new(dispatcher.clone()));
        Self {dir,store,dispatcher,desktop,runner,plugin}
    }
    async fn standard(outputs:&[&str]) -> Self { Self::new(outputs,Duration::ZERO,Duration::from_secs(1)).await }
    async fn run(&self,id:&str,control:&str,value:Option<f64>) -> Result<CommandResult,deck_lib::actions::ActionError> {
        self.desktop.run(&self.store,command(id,1,control,value)).await
    }
}
fn command(id:&str,revision:u64,control:&str,value:Option<f64>) -> DesktopCommand {
    DesktopCommand {command_id:id.into(),revision,control_id:control.into(),value}
}
fn without_timestamps(mut result:Value) -> Value {
    fn strip(v:&mut Value) {
        match v {
            Value::Object(m)=>{m.remove("observedAtMs");for v in m.values_mut(){strip(v);}},
            Value::Array(a)=>for v in a {strip(v);}, _=>(),
        }
    }
    strip(&mut result);result
}

#[tokio::test]
async fn runs_without_a_service_and_matches_the_shared_phone_dispatcher() {
    let env=Env::standard(&["Playing","","Paused","Playing","","Paused"]).await;
    let native=env.run("same","ctl_play_pause",None).await.unwrap();
    assert_eq!(native.state,CommandState::Confirmed);
    let deck=env.store.load().await.unwrap().deck;
    let control=deck.pages.iter().flat_map(|p|&p.sections).flat_map(|s|&s.controls).find(|c|c.id=="ctl_play_pause").unwrap();
    let direct=env.dispatcher.execute("same",control,None).await.unwrap();
    assert_eq!(without_timestamps(serde_json::to_value(native).unwrap()),without_timestamps(serde_json::to_value(direct).unwrap()));
    assert_eq!(env.runner.calls().iter().filter(|c|c.args==["play-pause"]).count(),2);
}

#[tokio::test]
async fn disconnected_obs_and_plugin_have_identical_shared_error_outcomes() {
    let env=Env::standard(&[]).await;
    let mut deck=default_deck();let obs=deck.pages[0].sections[0].controls[0].clone();
    let native=env.run("obs",&obs.id,None).await.unwrap();
    let direct=env.dispatcher.execute("obs",&obs,None).await.unwrap();
    assert_eq!(native.state,CommandState::Failed);
    assert_eq!(serde_json::to_value(native).unwrap(),serde_json::to_value(direct).unwrap());
    let plugin=Control {id:"disconnected-plugin".into(),label:"Plugin".into(),row_span:None,column_span:None,icon:None,presentation:None,action:ControlAction::Plugin {plugin_id:"fake".into(),plugin_action:"go".into(),plugin_args:Default::default()}};
    deck.pages[0].sections[0].controls.push(plugin.clone());env.store.save(1,deck).await.unwrap();
    let native=env.desktop.run(&env.store,command("plugin",2,&plugin.id,None)).await.unwrap();
    let direct=env.dispatcher.execute("plugin",&plugin,None).await.unwrap();
    assert_eq!(native.state,CommandState::Failed);assert_eq!(native.code,Some("plugin_unavailable"));
    assert_eq!(serde_json::to_value(native).unwrap(),serde_json::to_value(direct).unwrap());
    assert!(env.runner.calls().is_empty());
}

#[tokio::test]
async fn stale_unsaved_missing_and_invalid_requests_never_reach_adapters() {
    let env=Env::standard(&[]).await;
    assert_eq!(env.desktop.run(&env.store,command("stale",0,"ctl_volume",None)).await.unwrap_err().code,ActionErrorCode::StaleRevision);
    // A local edited control is not authoritative until explicitly saved.
    let mut unsaved=default_deck();unsaved.pages[0].sections[0].controls.push(Control {id:"unsaved".into(),label:"Unsaved".into(),row_span:None,column_span:None,icon:None,presentation:None,action:ControlAction::MediaPlayPause});
    assert_eq!(env.run("missing","unsaved",None).await.unwrap_err().code,ActionErrorCode::ControlNotFound);
    for (id,control,value) in [("","ctl_volume",None),("bad\nid","ctl_volume",None),("valid","",None),("valid","ctl_volume",Some(f64::NAN)),("valid","ctl_volume",Some(f64::INFINITY)),("valid","ctl_volume",Some(-1.0)),("valid","ctl_volume",Some(101.0)),("valid","ctl_mic",Some(1.0)),("valid","ctl_play_pause",Some(1.0))] {
        assert_eq!(env.run(id,control,value).await.unwrap_err().code,ActionErrorCode::InvalidRequest);
    }
    assert!(env.run(&"x".repeat(129),"ctl_volume",None).await.is_err());
    assert!(env.run("long-control",&"x".repeat(129),None).await.is_err());
    let missing=DeckStore::new(env.dir.0.join("missing.json"));
    assert_eq!(env.desktop.run(&missing,command("no-file",0,"ctl_play_pause",None)).await.unwrap_err().code,ActionErrorCode::DeckUnavailable);
    let bad=env.dir.0.join("bad.json");std::fs::write(&bad,b"{secret-invalid").unwrap();
    let error=env.desktop.run(&DeckStore::new(bad),command("corrupt",1,"ctl_play_pause",None)).await.unwrap_err();
    assert_eq!(error.code,ActionErrorCode::DeckUnavailable);
    assert!(!serde_json::to_string(&error).unwrap().contains("secret"));
    let mut deck = default_deck();
    deck.pages.iter_mut().flat_map(|p| &mut p.sections).flat_map(|s| &mut s.controls).find(|c| c.id == "ctl_volume").unwrap().presentation = Some("button".into());
    env.store.save(1, deck).await.unwrap();
    assert_eq!(env.desktop.run(&env.store, command("button-target", 2, "ctl_volume", Some(50.0))).await.unwrap_err().code, ActionErrorCode::InvalidRequest);
    assert!(env.runner.calls().is_empty());
}

#[test]
fn native_json_is_exact_and_null_is_not_omission() {
    let valid=json!({"commandId":"click1","revision":1,"controlId":"ctl_volume"});
    assert!(serde_json::from_value::<DesktopCommand>(valid.clone()).is_ok());
    for (key,value) in [("value",Value::Null),("value",json!("50")),("commandId",json!([])),("args",json!({})),("action",json!("volume")),("program",json!("/bin/sh")),("revision",json!(-1)),("revision",json!(1.5))] {
        let mut request=valid.clone();request[key]=value;
        assert!(serde_json::from_value::<DesktopCommand>(request).is_err(),"{key}");
    }
}

#[tokio::test]
async fn identical_concurrent_commands_execute_once_and_conflicts_fail() {
    let env=Env::new(&["","Volume: 0.40"],Duration::from_millis(20),Duration::from_secs(1)).await;
    let (a,b)=tokio::join!(env.run("click","ctl_volume",Some(40.0)),env.run("click","ctl_volume",Some(40.0)));
    assert_eq!(a.unwrap().state,CommandState::Confirmed);
    assert!(matches!(b.unwrap().state,CommandState::Pending|CommandState::Confirmed));
    let cached=env.run("click","ctl_volume",Some(40.0)).await.unwrap();assert_eq!(cached.state,CommandState::Confirmed);
    assert_eq!(env.run("click","ctl_volume",Some(60.0)).await.unwrap_err().code,ActionErrorCode::CommandConflict);
    assert_eq!(env.run("click","ctl_mic",Some(40.0)).await.unwrap_err().code,ActionErrorCode::CommandConflict);
    let mut deck=default_deck();
    deck.pages.iter_mut().flat_map(|p|&mut p.sections).flat_map(|s|&mut s.controls).find(|c|c.id=="ctl_volume").unwrap().action=ControlAction::MediaPlayPause;
    env.store.save(1,deck).await.unwrap();
    let duplicate=env.desktop.run(&env.store,command("click",2,"ctl_volume",Some(40.0))).await.unwrap();
    assert_eq!(serde_json::to_value(duplicate).unwrap(),serde_json::to_value(cached).unwrap());
    assert_eq!(env.runner.calls().len(),2,"save/retry must not replay under changed bindings");
    assert_eq!(env.run("fresh-stale","ctl_volume",None).await.unwrap_err().code,ActionErrorCode::StaleRevision);
}

#[tokio::test]
async fn native_and_phone_dispatch_serialize_read_modify_read() {
    let env=Env::new(&["Volume: 0.50","","Volume: 0.50 [MUTED]","Volume: 0.50 [MUTED]","","Volume: 0.50"],Duration::from_millis(5),Duration::from_secs(1)).await;
    let deck=env.store.load().await.unwrap().deck;
    let control=deck.pages.iter().flat_map(|p|&p.sections).flat_map(|s|&s.controls).find(|c|c.id=="ctl_mic").unwrap();
    let (native,phone)=tokio::join!(env.run("native-toggle","ctl_mic",None),env.dispatcher.execute("phone-toggle",control,None));
    assert_eq!(native.unwrap().state,CommandState::Confirmed);
    assert_eq!(phone.unwrap().state,CommandState::Confirmed);
    let calls=env.runner.calls();
    assert_eq!(calls.iter().map(|c|c.args[0].as_str()).collect::<Vec<_>>(),["get-volume","set-mute","get-volume","get-volume","set-mute","get-volume"]);
    assert_eq!(calls[1].args.last().unwrap(),"1");assert_eq!(calls[4].args.last().unwrap(),"0");
}

#[tokio::test]
async fn cancellation_keeps_admitted_action_and_eventual_result_without_replay() {
    let env=Env::new(&["Playing","","Paused"],Duration::from_millis(30),Duration::from_secs(1)).await;
    let desktop=env.desktop.clone();let store=env.store.clone();
    let caller=tokio::spawn(async move {desktop.run(&store,command("cancelled",1,"ctl_play_pause",None)).await});
    for _ in 0..100 {if !env.runner.calls().is_empty(){break;}tokio::time::sleep(Duration::from_millis(2)).await;}
    assert!(!env.runner.calls().is_empty());caller.abort();
    let mut finished=false;
    for _ in 0..100 {
        let result=env.run("cancelled","ctl_play_pause",None).await.unwrap();
        if result.state!=CommandState::Pending {assert_eq!(result.state,CommandState::Confirmed);finished=true;break;}
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(finished);assert_eq!(env.runner.calls().len(),3);
    assert_eq!(env.runner.calls().iter().filter(|c|c.args==["play-pause"]).count(),1);
}

#[tokio::test]
async fn timeout_failed_readback_and_not_applied_are_cached_without_retry() {
    let env=Env::new(&[],Duration::from_millis(100),Duration::from_millis(10)).await;
    assert_eq!(env.run("timeout","ctl_volume",None).await.unwrap().state,CommandState::Unknown);
    assert_eq!(env.run("timeout","ctl_volume",None).await.unwrap().state,CommandState::Unknown);
    assert_eq!(env.runner.calls().len(),1);
    let env=Env::standard(&["","bad-readback"]).await;
    assert_eq!(env.run("readback","ctl_volume",None).await.unwrap().state,CommandState::Unknown);
    assert_eq!(env.run("readback","ctl_volume",None).await.unwrap().state,CommandState::Unknown);
    assert_eq!(env.runner.calls().len(),2);
    let env=Env::standard(&["","Volume: 0.20"]).await;
    assert_eq!(env.run("not-applied","ctl_volume",Some(80.0)).await.unwrap().state,CommandState::NotApplied);
    assert_eq!(env.runner.calls().len(),2);
}

#[tokio::test]
async fn interrupted_worker_retains_an_unknown_result_without_replay() {
    // Empty fake queue intentionally panics inside the admitted worker.
    let env=Env::standard(&[]).await;
    assert_eq!(env.run("interrupted","ctl_volume",None).await.unwrap().state,CommandState::Unknown);
    let mut retained=false;
    for _ in 0..100 {
        let result=env.run("interrupted","ctl_volume",None).await.unwrap();
        if result.state!=CommandState::Pending {assert_eq!(result.state,CommandState::Unknown);retained=true;break;}
        tokio::task::yield_now().await;
    }
    assert!(retained);assert_eq!(env.runner.calls().len(),1);
}

#[tokio::test]
async fn inflight_is_bounded_without_a_queue_of_unadmitted_actions() {
    let env=Env::new(&["","Volume: 0.50","","Volume: 0.50","","Volume: 0.50","","Volume: 0.50"],Duration::from_millis(10),Duration::from_secs(1)).await;
    let (a,b,c,d,e)=tokio::join!(env.run("a","ctl_volume",None),env.run("b","ctl_volume",None),env.run("c","ctl_volume",None),env.run("d","ctl_volume",None),env.run("e","ctl_volume",None));
    for r in [a,b,c,d]{assert_eq!(r.unwrap().state,CommandState::Confirmed);}
    assert_eq!(e.unwrap_err().code,ActionErrorCode::Busy);assert_eq!(env.runner.calls().len(),8);
}

#[tokio::test]
async fn capacity_fails_closed_and_never_evicts_an_old_failed_id() {
    let env=Env::standard(&[]).await;
    let id=default_deck().pages[0].sections[0].controls[0].id.clone();
    for i in 0..DesktopActions::CAPACITY {assert_eq!(env.run(&format!("id-{i}"),&id,None).await.unwrap().state,CommandState::Failed);}
    assert_eq!(env.run("overflow",&id,None).await.unwrap_err().code,ActionErrorCode::Capacity);
    assert_eq!(env.run("id-0",&id,None).await.unwrap().state,CommandState::Failed);
    assert!(env.runner.calls().is_empty());
}

#[tokio::test]
async fn saved_plugin_args_and_unknown_outcome_use_the_same_dispatcher() {
    for crash in [false,true] {
        let env=Env::standard(&[]).await;
        let entry=env.dir.0.join("fake.cjs");let log=env.dir.0.join("execute.log");
        let source=format!("const log={},crash={};\n",json!(log.to_str().unwrap()),crash)+r#"
const fs=require('node:fs');let count=0;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line),base={protocolVersion:1,id:r.id,type:'result'};
 if(r.type==='describe') {process.stdout.write(JSON.stringify({...base,manifest:{id:'fake',version:'0.0.1',protocolVersion:1,actions:[{id:'go',title:'Go',config:{n:{type:'integer',minimum:0,maximum:10}}}]}})+'\n');return;}
 if(r.type==='execute') {fs.appendFileSync(log,JSON.stringify(r.args)+'\n');count++;if(crash)process.exit(7);}
 process.stdout.write(JSON.stringify({...base,state:{count,n:r.args?.n??0}})+'\n');
});
"#;
        std::fs::write(&entry,source).unwrap();
        let node=std::process::Command::new("node").args(["-p","process.execPath"]).output().expect("Node required for fake desktop plugin test; not skipped");assert!(node.status.success());
        env.plugin.connect("fake",String::from_utf8(node.stdout).unwrap().trim().into(),entry.to_str().unwrap().into()).await.unwrap();
        assert!(!log.exists(),"connect describes only");
        let mut deck=default_deck();deck.pages[0].sections[0].controls.push(Control {id:"plugin".into(),label:"Plugin".into(),row_span:None,column_span:None,icon:None,presentation:None,action:ControlAction::Plugin {plugin_id:"fake".into(),plugin_action:"go".into(),plugin_args:json!({"n":7}).as_object().unwrap().clone()}});
        env.store.save(1,deck).await.unwrap();
        assert_eq!(env.desktop.run(&env.store,command("invalid-value",2,"plugin",Some(8.0))).await.unwrap_err().code,ActionErrorCode::InvalidRequest);
        assert!(!log.exists());
        let result=env.desktop.run(&env.store,command("execute",2,"plugin",None)).await.unwrap();
        if crash {assert_eq!(result.state,CommandState::Unknown);assert_eq!(result.code,Some("plugin_outcome_unknown"));}
        else {assert_eq!(result.state,CommandState::Confirmed);assert_eq!(result.observed.as_ref().unwrap()["n"],7);}
        let repeated=env.desktop.run(&env.store,command("execute",2,"plugin",None)).await.unwrap();
        assert_eq!(serde_json::to_value(result).unwrap(),serde_json::to_value(repeated).unwrap());
        let lines=std::fs::read_to_string(&log).unwrap();assert_eq!(lines.lines().count(),1);assert_eq!(serde_json::from_str::<Value>(lines.trim()).unwrap(),json!({"n":7}));
        env.plugin.disconnect("fake").await.unwrap();
        assert!(env.runner.calls().is_empty());
    }
}
