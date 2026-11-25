//! Real process transport tests; only fake Node programs, no media/Automation.
use std::{path::PathBuf, process::Command, sync::atomic::{AtomicU64, Ordering}, time::Duration};
use zdeck_plugin_host::plugin::{ErrorKind, Outcome, PluginHost, TrustedLaunch};
use serde_json::json;

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture { host: PluginHost, log: PathBuf }
impl Fixture {
    fn new(mode: &str) -> Self {
        let output = Command::new("node").args(["-p", "process.execPath"]).output()
            .expect("Node is required for plugin_host integration tests; unavailable (not silently skipped)");
        assert!(output.status.success(), "Node executable resolution failed");
        let node = PathBuf::from(String::from_utf8(output.stdout).unwrap().trim());
        let log = std::env::temp_dir().join(format!("zdeck-plugin-{}-{}.log", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        let launch = TrustedLaunch::new(node, vec!["-e".into(), SCRIPT.into(), mode.into(), log.to_str().unwrap().into()], std::env::current_dir().unwrap()).unwrap();
        Self { host: PluginHost::with_timeout(launch, Duration::from_millis(800)), log }
    }
    fn calls(&self) -> Vec<String> {
        std::fs::read_to_string(&self.log).unwrap_or_default().lines().map(str::to_owned).collect()
    }
    fn assert_reaped(&self) {
        let calls = self.calls();
        let pid = calls.first().unwrap().split(':').nth(2).unwrap();
        let status = Command::new("node").args(["-e", "try { process.kill(Number(process.argv[1]),0); process.exit(1); } catch(e) { process.exit(e.code==='ESRCH'?0:2); }", pid]).status().unwrap();
        assert!(status.success(), "child must be killed and reaped before returning");
    }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_file(&self.log); } }
const SCRIPT: &str = r#"
const fs = require('node:fs');
const readline = require('node:readline');
const [mode, log] = process.argv.slice(1);
if (mode.startsWith('startup-')) {
  fs.appendFileSync(log, 'startup:r0:' + process.pid + '\n');
  if (mode === 'startup-module') {
    fs.writeSync(2, "Error [ERR_MODULE_NOT_FOUND]: private-path secret-password\n");
    for(let i=0;i<256;i++) fs.writeSync(2, 'secret-password'.repeat(1024));
  } else if (mode === 'startup-private') fs.writeSync(2, 'private-path secret-password\n');
  else if (mode === 'startup-invalid-utf8') fs.writeSync(2, Buffer.alloc(16384,255));
  process.exit(7);
}
const manifest = {id:'fake',version:'0.0.1',protocolVersion:1,actions:[{id:'go',title:'Go',config:{n:{type:'integer',minimum:0,maximum:9}}}]};
let count = 0;
const lines = readline.createInterface({input:process.stdin});
lines.on('line', line => {
  const r = JSON.parse(line);
  fs.appendFileSync(log, r.type + ':' + r.id + ':' + process.pid + '\n');
  const result = payload => process.stdout.write(JSON.stringify({protocolVersion:1,id:r.id,type:'result',...payload})+'\n');
  if (r.type === 'describe') {
    if (mode === 'bad-manifest') manifest.extra = true;
    result({manifest}); return;
  }
  if (r.type === 'execute') count++;
  if (mode === 'timeout') { setInterval(()=>{}, 1000); return; }
  if (mode === 'exit') process.exit(7);
  if (mode === 'malformed') { process.stdout.write('not json\n'); return; }
  if (mode === 'oversize') { process.stdout.write('x'.repeat(65537)); return; }
  if (mode === 'utf8') { process.stdout.write(Buffer.from([255,10])); return; }
  if (mode === 'partial') { process.stdout.write('{'); process.exit(0); }
  if (mode === 'wrong-id') { process.stdout.write(JSON.stringify({protocolVersion:1,id:'wrong',type:'result',state:{}})+'\n'); return; }
  if (mode === 'array') { result({state:[]}); return; }
  if (mode === 'boundary') {
    const response = {protocolVersion:1,id:r.id,type:'result',state:{pad:''}};
    response.state.pad = 'x'.repeat(65536 - Buffer.byteLength(JSON.stringify(response)));
    process.stdout.write(JSON.stringify(response)+'\n'); return;
  }
  if (mode === 'crlf') {
    process.stdout.write(JSON.stringify({protocolVersion:1,id:r.id,type:'result',state:{count}})+'\r\n'); return;
  }
  if (mode === 'error' || mode === 'not-started') {
    process.stdout.write(JSON.stringify({protocolVersion:1,id:r.id,type:'error',error:{code:'/private/token',message:'secret-password',hint:'secret-hint',outcome:mode==='error'?'unknown':'not_started'}})+'\n'); return;
  }
  if (mode === 'stderr') for(let i=0;i<256;i++) fs.writeSync(2, 'secret-password'.repeat(1024));
  if (mode === 'delay') { setTimeout(()=>result({state:{count,pid:process.pid}}),100); return; }
  result({state:{count,pid:process.pid}});
});
lines.on('close',()=> { if(mode==='stubborn') setInterval(()=>{},1000); });
"#;

struct RegistryFixture { dir: PathBuf, node: String }
impl RegistryFixture {
    fn new() -> Self {
        let node=Command::new("node").args(["-p","process.execPath"]).output().expect("Node required for fake registry tests");assert!(node.status.success());
        let dir=std::env::temp_dir().join(format!("zdeck-registry-{}-{}",std::process::id(),NEXT.fetch_add(1,Ordering::Relaxed)));
        std::fs::create_dir(&dir).unwrap();Self {dir,node:String::from_utf8(node.stdout).unwrap().trim().into()}
    }
    fn entry(&self,id:&str,mode:&str)->String {
        let log=self.dir.join(format!("{id}.log"));
        let source=SCRIPT.replace("const [mode, log] = process.argv.slice(1);",&format!("const mode={},log={};",json!(mode),json!(log.to_str().unwrap())))
            .replace("id:'fake'",&format!("id:{}",json!(id))).replace("),100);","),1000);");
        let entry=self.dir.join(format!("{id}.cjs"));std::fs::write(&entry,source).unwrap();entry.to_str().unwrap().into()
    }
    fn calls(&self,id:&str)->Vec<String>{std::fs::read_to_string(self.dir.join(format!("{id}.log"))).unwrap_or_default().lines().map(str::to_owned).collect()}
    fn reaped(&self,id:&str){for call in self.calls(id){let pid=call.split(':').nth(2).unwrap();let output=Command::new(&self.node).args(["-e","try {process.kill(Number(process.argv[1]),0);process.exit(1)}catch(e){process.exit(e.code==='ESRCH'?0:2)}",pid]).status().unwrap();assert!(output.success(),"leaked plugin process");}}
}
impl Drop for RegistryFixture {fn drop(&mut self){let _=std::fs::remove_dir_all(&self.dir);}}

#[tokio::test]
async fn registry_routes_two_plugins_and_isolates_failure_and_disabling() {
    use zdeck_plugin_host::plugin::{PluginRegistry,ConnectionStatus};
    let f=RegistryFixture::new();let registry=PluginRegistry::default();
    registry.connect("alpha",f.node.clone(),f.entry("alpha","ok")).await.unwrap();
    registry.connect("beta",f.node.clone(),f.entry("beta","exit")).await.unwrap();
    assert_eq!(registry.snapshots().await.len(),2);
    assert_eq!(f.calls("alpha").len(),1);assert_eq!(f.calls("beta").len(),1);
    assert_eq!(registry.execute("alpha".into(),"go".into(),json!({"n":7})).await.unwrap().state.unwrap()["count"],1);
    let error=registry.execute("beta".into(),"go".into(),json!({"n":2})).await.unwrap_err();assert_eq!(error.outcome,Outcome::Unknown);
    assert_eq!(registry.snapshot("beta").await.unwrap().status,ConnectionStatus::Stopped);
    assert_eq!(registry.snapshot("alpha").await.unwrap().status,ConnectionStatus::Connected);
    registry.disconnect("beta").await.unwrap();assert_eq!(registry.snapshots().await.len(),1);
    assert_eq!(registry.state("alpha").await.unwrap().state.unwrap()["count"],1);
    assert_eq!(registry.snapshot("beta").await.unwrap().status,ConnectionStatus::Disconnected);
    assert_eq!(registry.execute("beta".into(),"go".into(),json!({"n":2})).await.unwrap_err().outcome,Outcome::NotStarted);
    registry.disconnect("alpha").await.unwrap();assert!(registry.snapshots().await.is_empty());
    f.reaped("alpha");f.reaped("beta");
}

#[tokio::test]
async fn registry_independent_io_duplicate_enable_and_cancellation_do_not_leak_hosts() {
    use zdeck_plugin_host::plugin::{PluginRegistry,ConnectionStatus};
    let f=RegistryFixture::new();let registry=std::sync::Arc::new(PluginRegistry::default());
    let alpha=f.entry("alpha","delay");let beta=f.entry("beta","ok");
    registry.connect("alpha",f.node.clone(),alpha.clone()).await.unwrap();registry.connect("beta",f.node.clone(),beta).await.unwrap();
    let other=registry.clone();let operation=tokio::spawn(async move {other.state("alpha").await});
    tokio::time::timeout(Duration::from_secs(2),async {while f.calls("alpha").len()<2 {tokio::time::sleep(Duration::from_millis(5)).await;}}).await.unwrap();
    tokio::time::timeout(Duration::from_millis(500),registry.state("beta")).await.unwrap().unwrap();operation.await.unwrap().unwrap();
    let (first,second)=tokio::join!(registry.connect("alpha",f.node.clone(),alpha.clone()),registry.connect("alpha",f.node.clone(),alpha.clone()));
    first.unwrap();second.unwrap();
    let other=registry.clone();let node=f.node.clone();let task=tokio::spawn(async move {other.connect("alpha",node,alpha).await});
    tokio::time::timeout(Duration::from_secs(2),async {while f.calls("alpha").iter().filter(|l|l.starts_with("describe:")).count()<4 {tokio::time::sleep(Duration::from_millis(5)).await;}}).await.unwrap();
    task.abort();assert_eq!(registry.snapshot("alpha").await.unwrap().status,ConnectionStatus::Connected);
    registry.disconnect("alpha").await.unwrap();registry.disconnect("beta").await.unwrap();
    f.reaped("alpha");f.reaped("beta");
}

#[tokio::test]
async fn registry_capacity_is_bounded_and_disabled_slots_are_reclaimed() {
    use zdeck_plugin_host::plugin::PluginRegistry;
    let registry=PluginRegistry::default();let missing=std::env::temp_dir().join("zdeck-no-such-runtime").to_str().unwrap().to_owned();
    let entry=std::env::temp_dir().join("zdeck-no-such-entry.js").to_str().unwrap().to_owned();
    for i in 0..16 {assert_eq!(registry.connect(&format!("p{i}"),missing.clone(),entry.clone()).await.unwrap_err().code,Some("runtime_missing"));}
    assert_eq!(registry.snapshots().await.len(),16);
    assert_eq!(registry.connect("overflow",missing.clone(),entry.clone()).await.unwrap_err().code,Some("capacity"));
    for i in 0..32 {let id=format!("new{i}");registry.disconnect(if i==0 {"p0"} else {"unused"}).await.unwrap();registry.connect(&id,missing.clone(),entry.clone()).await.unwrap_err();registry.disconnect(&id).await.unwrap();}
    assert_eq!(registry.snapshots().await.len(),15);
    for i in 1..16 {registry.disconnect(&format!("p{i}")).await.unwrap();}assert!(registry.snapshots().await.is_empty());
}

#[tokio::test]
async fn lazy_validation_correlation_and_serialization() {
    let f = Fixture::new("ok");
    assert!(f.calls().is_empty());
    assert_eq!(f.host.describe().await.unwrap().id, "fake");
    for (action, args, kind) in [("missing",json!({}),ErrorKind::UnknownAction),("go",json!({"n":10}),ErrorKind::InvalidArguments),("go",json!({"n":1,"extra":2}),ErrorKind::InvalidArguments)] {
        let e = f.host.execute(action,args).await.unwrap_err();
        assert_eq!(e.kind,kind); assert_eq!(e.outcome,Outcome::NotStarted);
    }
    assert_eq!(f.calls().len(),1,"invalid executes must not reach stdin");
    let (a,b) = tokio::join!(f.host.execute("go",json!({"n":1})), f.host.execute("go",json!({"n":2})));
    let mut counts = vec![a.unwrap()["count"].as_u64().unwrap(),b.unwrap()["count"].as_u64().unwrap()];
    counts.sort(); assert_eq!(counts,vec![1,2]);
    assert_eq!(f.host.state().await.unwrap()["count"],2);
    let calls = f.calls();
    let ids: std::collections::HashSet<_> = calls.iter().map(|s|s.split(':').nth(1).unwrap()).collect();
    assert_eq!(ids.len(),calls.len());
    f.host.stop().await.unwrap();
    assert_eq!(f.host.state().await.unwrap_err().kind,ErrorKind::Stopped);
}

#[tokio::test]
async fn failures_latch_and_never_replay_execute() {
    for mode in ["malformed","oversize","utf8","partial","wrong-id","array","timeout","exit","error","not-started"] {
        let f = Fixture::new(mode);
        f.host.describe().await.unwrap();
        let e = f.host.execute("go",json!({"n":1})).await.unwrap_err();
        assert_eq!(e.outcome,if mode=="not-started" {Outcome::NotStarted} else {Outcome::Unknown},"{mode}");
        if mode=="timeout" { assert_eq!(e.kind,ErrorKind::Timeout); }
        let safe = serde_json::to_string(&e).unwrap();
        assert!(!safe.contains("private") && !safe.contains("secret"));
        assert_eq!(f.host.execute("go",json!({"n":1})).await.unwrap_err().kind,ErrorKind::Stopped);
        assert_eq!(f.host.state().await.unwrap_err().kind,ErrorKind::Stopped);
        assert_eq!(f.calls().iter().filter(|s|s.starts_with("execute:")).count(),1,"{mode}");
        assert_eq!(f.calls().iter().filter(|s|s.starts_with("describe:")).count(),1,"{mode}");
        f.host.stop().await.unwrap();
        f.assert_reaped();
    }
}

#[tokio::test]
async fn invalid_manifest_and_spawn_failure_are_not_started() {
    let f = Fixture::new("bad-manifest");
    let e = f.host.execute("go",json!({"n":1})).await.unwrap_err();
    assert_eq!(e.kind,ErrorKind::InvalidManifest); assert_eq!(e.outcome,Outcome::NotStarted);
    assert_eq!(f.calls().len(),1);
    let launch = TrustedLaunch::new(std::env::temp_dir().join("zdeck-nonexistent-plugin-program"),vec![],std::env::current_dir().unwrap()).unwrap();
    let h = PluginHost::new(launch);
    let e = h.state().await.unwrap_err(); assert_eq!(e.kind,ErrorKind::Unavailable); assert_eq!(e.outcome,Outcome::NotStarted);
    assert_eq!(e.code,Some("runtime_missing"));
    assert_eq!(h.state().await.unwrap_err().kind,ErrorKind::Stopped);
    assert!(TrustedLaunch::new(PathBuf::from("relative"),vec![],std::env::current_dir().unwrap()).is_err());
}

#[tokio::test]
async fn startup_diagnostics_are_bounded_sanitized_and_never_replayed() {
    for mode in ["startup-module","startup-private","startup-invalid-utf8","startup-empty"] {
        let f=Fixture::new(mode);
        let error=f.host.describe().await.unwrap_err();
        assert_eq!(error.kind,ErrorKind::Unavailable);assert_eq!(error.outcome,Outcome::NotStarted);
        assert_eq!(error.code,Some(if mode=="startup-module" {"missing_dependency"} else {"startup_exit"}));
        let safe=serde_json::to_string(&error).unwrap();
        assert!(!safe.contains("secret-password") && !safe.contains("private-path"));
        assert!(safe.len()<1024);
        assert_eq!(f.host.describe().await.unwrap_err().kind,ErrorKind::Stopped);
        assert_eq!(f.calls().len(),1,"startup failure cannot automatically relaunch");
        f.assert_reaped();
    }
}

#[tokio::test]
async fn stderr_is_discarded_and_shutdown_is_bounded() {
    let f = Fixture::new("stderr");
    assert_eq!(f.host.execute("go",json!({"n":1})).await.unwrap()["count"],1);
    f.host.stop().await.unwrap();
    let f = Fixture::new("stubborn");
    f.host.describe().await.unwrap();
    tokio::time::timeout(Duration::from_secs(3),f.host.stop()).await.unwrap().unwrap();
    f.assert_reaped();
}

#[tokio::test]
async fn accepts_exact_response_limit_and_crlf() {
    let f = Fixture::new("boundary");
    assert!(f.host.state().await.unwrap()["pad"].as_str().unwrap().len() > 65000);
    f.host.stop().await.unwrap();
    let f = Fixture::new("crlf");
    assert_eq!(f.host.execute("go",json!({"n":1})).await.unwrap()["count"],1);
    f.host.stop().await.unwrap();
}

struct ManagedFixture {
    fixture: Fixture,
    manager: zdeck_plugin_host::plugin::PluginState,
    program: String,
    entrypoint: PathBuf,
}
impl ManagedFixture {
    fn new(mode: &str) -> Self {
        let fixture = Fixture::new(mode);
        let entrypoint = fixture.log.with_extension("cjs");
        let source = SCRIPT.replace("const [mode, log] = process.argv.slice(1);", &format!("const [mode, log] = {};", json!([mode,fixture.log.to_str().unwrap()])));
        std::fs::write(&entrypoint,source).unwrap();
        let program = Command::new("node").args(["-p","process.execPath"]).output().unwrap();
        Self { fixture, manager: Default::default(), program: String::from_utf8(program.stdout).unwrap().trim().into(), entrypoint }
    }
    async fn connect(&self) -> Result<zdeck_plugin_host::plugin::PluginSnapshot, zdeck_plugin_host::plugin::PluginError> {
        self.manager.connect(self.program.clone(),self.entrypoint.to_str().unwrap().into()).await
    }
}
impl Drop for ManagedFixture { fn drop(&mut self) { let _ = std::fs::remove_file(&self.entrypoint); } }

#[tokio::test]
async fn session_connect_describes_only_and_snapshots_do_not_call_plugin() {
    use zdeck_plugin_host::plugin::ConnectionStatus;
    let f = ManagedFixture::new("ok");
    assert_eq!(f.manager.snapshot().await.status, ConnectionStatus::Disconnected);
    assert!(f.fixture.calls().is_empty());
    assert_eq!(f.manager.state().await.unwrap_err().outcome, Outcome::NotStarted);
    assert!(f.manager.connect("node".into(),f.entrypoint.to_str().unwrap().into()).await.is_err());
    assert!(f.fixture.calls().is_empty());
    let connected = f.connect().await.unwrap();
    assert_eq!(connected.status,ConnectionStatus::Connected);
    assert!(connected.state.is_none());
    assert_eq!(f.fixture.calls().len(),1);
    let snapshot = f.manager.snapshot().await;
    assert_eq!(f.fixture.calls().len(),1);
    let wire = serde_json::to_string(&snapshot).unwrap();
    assert!(!wire.contains(f.entrypoint.to_str().unwrap()));
    assert!(!wire.contains(&f.program));
    assert_eq!(f.manager.state().await.unwrap().state.unwrap()["count"],0);
    assert_eq!(f.manager.execute("fake".into(),"go".into(),json!({"n":1})).await.unwrap().state.unwrap()["count"],1);
    assert_eq!(f.manager.disconnect().await.status,ConnectionStatus::Disconnected);
    f.fixture.assert_reaped();
    assert_eq!(f.manager.execute("fake".into(),"go".into(),json!({"n":1})).await.unwrap_err().outcome,Outcome::NotStarted);
}

#[tokio::test]
async fn invalid_reconnect_closes_previous_session_without_launching() {
    use zdeck_plugin_host::plugin::ConnectionStatus;
    let f = ManagedFixture::new("ok");
    f.connect().await.unwrap();
    let error = f.manager.connect("node".into(),f.entrypoint.to_str().unwrap().into()).await.unwrap_err();
    assert_eq!(error.kind,ErrorKind::InvalidLaunch);
    assert_eq!(error.outcome,Outcome::NotStarted);
    let snapshot = f.manager.snapshot().await;
    assert_eq!(snapshot.status,ConnectionStatus::Stopped);
    assert!(snapshot.manifest.is_none()); assert!(snapshot.state.is_none());
    assert_eq!(f.fixture.calls().len(),1);
    f.fixture.assert_reaped();
    assert!(f.manager.state().await.is_err());
}

#[tokio::test]
async fn session_errors_stop_and_require_explicit_connect_without_replay() {
    use zdeck_plugin_host::plugin::ConnectionStatus;
    for mode in ["error","exit","ok"] {
        let f = ManagedFixture::new(mode);
        f.connect().await.unwrap();
        let identity = if mode=="ok" {"wrong-plugin"} else {"fake"};
        let error = f.manager.execute(identity.into(),"go".into(),json!({"n":1})).await.unwrap_err();
        assert_eq!(error.outcome,if mode=="ok" {Outcome::NotStarted} else {Outcome::Unknown});
        let snapshot = f.manager.snapshot().await;
        assert_eq!(snapshot.status,ConnectionStatus::Stopped);
        assert!(snapshot.state.is_none()); assert!(snapshot.last_error.is_some());
        let calls = f.fixture.calls().len();
        assert!(f.manager.state().await.is_err());
        assert!(f.manager.execute("fake".into(),"go".into(),json!({"n":1})).await.is_err());
        assert_eq!(f.fixture.calls().len(),calls);
        f.fixture.assert_reaped();
        f.connect().await.unwrap();
        assert!(f.manager.snapshot().await.state.is_none());
        assert_eq!(f.fixture.calls().len(),calls+1,"reconnect only describes, never replays");
        f.manager.disconnect().await;
    }
}

#[tokio::test]
async fn cancellation_does_not_abandon_an_admitted_action() {
    let f = Fixture::new("delay");
    f.host.describe().await.unwrap();
    let h = f.host.clone();
    let task = tokio::spawn(async move { h.execute("go",json!({"n":1})).await });
    for _ in 0..100 {
        if f.calls().iter().any(|s|s.starts_with("execute:")) { break; }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(f.calls().iter().any(|s|s.starts_with("execute:")));
    task.abort();
    assert_eq!(f.host.state().await.unwrap()["count"],1);
    assert_eq!(f.calls().iter().filter(|s|s.starts_with("execute:")).count(),1);
    f.host.stop().await.unwrap();
}
