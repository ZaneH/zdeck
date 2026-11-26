//! Isolated discovery/runtime tests. No real installed plugin directory or folder opener.
//! The reference Spotify process is exercised with describe ONLY in a temporary
//! source/artifact snapshot; never state, execute or Automation.
#![cfg(unix)]
use std::{fs, os::unix::fs::{symlink, PermissionsExt}, path::PathBuf, sync::atomic::{AtomicU64, Ordering}, time::{Duration, Instant}};
use zdeck_plugin_host::{plugin::{ConnectionStatus, ErrorKind, Outcome, PluginRegistry}, plugin_install::{detect_node, runtime_candidates, InstallStatus, NodeStatus, PluginInstall}};
use serde_json::{json, Value};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture { temp: PathBuf, root: PathBuf }
impl Fixture {
    fn new() -> Self {
        let temp = std::env::temp_dir().join(format!("zdeck-install-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir(&temp).unwrap();
        let root = temp.join("home/.config/zdeck/plugins");
        Self { temp, root }
    }
    fn install(&self, candidates: Vec<PathBuf>) -> PluginInstall { PluginInstall::new(self.root.clone(), candidates).unwrap() }
    fn executable(&self, name: &str, script: &str) -> PathBuf {
        let path = self.temp.join(name);
        if let Some(parent) = path.parent() { fs::create_dir_all(parent).unwrap(); }
        fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        path
    }
    fn runtime(&self, name: &str, version: &str) -> PathBuf {
        self.executable(name, &format!("printf '%s\\n' '{version}'"))
    }
    fn plugin(&self, id: &str, value: &Value) -> PathBuf {
        let folder = self.root.join(id);
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("manifest.json"), serde_json::to_vec(value).unwrap()).unwrap();
        // Discovery must never try this executable-looking plugin entrypoint.
        fs::write(folder.join("main.js"), "throw new Error('discovery must not execute plugins');").unwrap();
        folder
    }
    fn spotify_source_snapshot(&self) -> PathBuf {
        let folder = self.root.join("spotify"); fs::create_dir_all(&folder).unwrap();
        let files: [(&str, &[u8]); 4] = [
            ("manifest.json", include_bytes!("../../../plugins/spotify/manifest.json")),
            ("main.js", include_bytes!("../../../plugins/spotify/main.js")),
            ("spotify.js", include_bytes!("../../../plugins/spotify/spotify.js")),
            ("package.json", include_bytes!("../../../plugins/spotify/package.json")),
        ];
        for (name, bytes) in files { fs::write(folder.join(name), bytes).unwrap(); }
        folder
    }
    fn bundle_sdk(&self, folder: &std::path::Path) {
        let sdk = folder.join("node_modules/@zdeck/plugin-sdk"); fs::create_dir_all(&sdk).unwrap();
        let files: [(&str, &[u8]); 4] = [
            ("index.js", include_bytes!("../../../packages/plugin-sdk/index.js")),
            ("index.d.ts", include_bytes!("../../../packages/plugin-sdk/index.d.ts")),
            ("package.json", include_bytes!("../../../packages/plugin-sdk/package.json")),
            ("LICENSE", include_bytes!("../../../packages/plugin-sdk/LICENSE")),
        ];
        for (name, bytes) in files { fs::write(sdk.join(name), bytes).unwrap(); }
    }
    fn node(&self) -> PathBuf {
        let node=std::process::Command::new("node").args(["-p","process.execPath"]).output().expect("Node required for isolated fake plugin management tests");assert!(node.status.success());
        PathBuf::from(String::from_utf8(node.stdout).unwrap().trim())
    }
    fn fake_plugin(&self,id:&str,fail:bool)->PathBuf {
        let folder=self.plugin(id,&manifest(id));
        let source=format!("const manifest={},log={},fail={};\n",manifest(id),json!(self.temp.join("calls").to_str().unwrap()),fail)+r#"
const fs=require('node:fs');let count=0;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line),base={protocolVersion:1,id:r.id,type:'result'};
 fs.appendFileSync(log,manifest.id+':'+r.type+'\n');
 if(r.type==='describe'){process.stdout.write(JSON.stringify({...base,manifest})+'\n');return;}
 if(fail)process.exit(7);
 if(r.type==='execute')count++;
 process.stdout.write(JSON.stringify({...base,state:{count,plugin:manifest.id}})+'\n');
});
"#;
        fs::write(folder.join("main.js"),source).unwrap();folder
    }
    fn calls(&self) -> Vec<String> { fs::read_to_string(self.temp.join("calls")).unwrap_or_default().lines().map(str::to_owned).collect() }
    fn protocol_runtime(&self, described: &Value) -> PathBuf {
        let manifest = serde_json::to_string(described).unwrap();
        // All tests use a fixed r1 describe response. Subsequent state/execute would be logged
        // and fail, so successful enable proves no implicit media/state exchange happened.
        self.executable("fake-node", &format!(r#"
if [ "$1" = '--version' ]; then printf 'v22.18.0\n'; exit 0; fi
printf 'launch\n' >> '{log}'
while IFS= read -r line; do
  printf '%s\n' "$line" >> '{log}'
  printf '%s\n' '{{"protocolVersion":1,"id":"r1","type":"result","manifest":{manifest}}}'
done
"#, log = self.temp.join("calls").display()))
    }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.temp); } }
fn manifest(id: &str) -> Value { json!({"id":id,"version":"0.1.0","protocolVersion":1,"actions":[{"id":"play","title":"Play","config":{}}]}) }

impl Fixture {
    /// Ready identity from a probe-free catalog; never runs a fake runtime in `node` mode.
    async fn identity(&self, id: &str) -> String {
        self.install(vec![]).catalog().await.unwrap().plugins.into_iter()
            .find(|plugin| plugin.id == id).expect("catalog entry").identity.expect("ready identity")
    }
}
async fn trust_current(f: &Fixture, install: &PluginInstall, id: &str) {
    install.trust(id, &f.identity(id).await).await.unwrap();
}

#[tokio::test]
async fn missing_root_stays_missing_and_catalog_has_frozen_shape() {
    let f = Fixture::new();
    let catalog = f.install(vec![]).catalog().await.unwrap();
    assert!(catalog.plugins.is_empty()); assert!(!f.root.exists());
    assert_eq!(serde_json::to_value(&catalog).unwrap(), json!({"directory":f.root.to_str().unwrap(),"node":{"status":"not_found","version":null,"path":null},"python":{"status":"not_found","version":null,"path":null},"plugins":[]}));
}

#[tokio::test]
async fn versions_minimum_ordering_and_unsupported_fallback() {
    let f = Fixture::new();
    for (version, supported) in [("v22.17.9",false),("v22.18.0",true),("v22.19.0",true),("v23.0.0",true),("v26.12.1",true),("v21.99.0",false)] {
        let path = f.runtime(&format!("node-{version}"), version);
        let detected = detect_node(&[path.clone()]).await;
        assert_eq!(detected.status, if supported { NodeStatus::Detected } else { NodeStatus::Unsupported });
        assert_eq!(detected.path.as_deref(), path.to_str());
        assert_eq!(detected.version.as_deref(), Some(version.trim_start_matches('v')));
    }
    let old = f.runtime("old", "v20.0.0");
    let new = f.runtime("gui-fallback", "v23.0.0");
    assert_eq!(detect_node(&[old, new.clone()]).await.path.as_deref(), new.to_str());
    for version in ["v22.18.0-rc.1", "secret/path", "v22.18", "v99999.1.1", "v22.18.0 extra"] {
        let path = f.runtime("malformed", version);
        let result = detect_node(&[path]).await;
        assert_eq!(result.status, NodeStatus::NotFound);
        assert!(result.version.is_none()); assert!(result.path.is_none());
    }
}

#[tokio::test]
async fn runtime_probes_are_bounded_deduplicated_and_do_not_inherit_node_preload_options() {
    let f = Fixture::new();
    let node = f.executable("env-check", r#"if [ "${NODE_OPTIONS+x}" ] || [ "${NODE_PATH+x}" ]; then exit 1; fi
printf 'v22.18.0\n'"#);
    assert_eq!(detect_node(&[node]).await.status, NodeStatus::Detected);
    let log = f.temp.join("probes");
    let old = f.executable("old", &format!("printf 'probe\\n' >> '{}'; printf 'v20.0.0\\n'", log.display()));
    let alias = f.temp.join("alias"); symlink(&old, &alias).unwrap();
    assert_eq!(detect_node(&[old.clone(), alias, old]).await.status, NodeStatus::Unsupported);
    assert_eq!(fs::read_to_string(log).unwrap().lines().count(), 1);
    let oversized = f.executable("oversized", "printf '%0200d' 0");
    let stalled = f.executable("stalled", "exec /bin/sleep 10");
    let bad_exit = f.executable("bad-exit", "printf 'v22.18.0\\n'; exit 1");
    let start = Instant::now();
    assert_eq!(detect_node(&[oversized, stalled, bad_exit]).await.status, NodeStatus::NotFound);
    assert!(start.elapsed() < Duration::from_secs(2));
    assert_eq!(detect_node(&[PathBuf::from("relative/node")]).await.status, NodeStatus::NotFound);
}

#[tokio::test]
async fn finder_style_empty_path_can_detect_a_user_runtime_fallback() {
    let f = Fixture::new();
    let home = f.temp.join("home");
    let node = f.runtime("home/.volta/bin/node", "v23.0.0");
    // Filter out system locations: this test must never probe the real installed Node.
    let candidates: Vec<_> = runtime_candidates(&home, Some(std::ffi::OsStr::new("")))
        .into_iter().filter(|p| p.starts_with(&home)).collect();
    let detected = detect_node(&candidates).await;
    assert_eq!(detected.status, NodeStatus::Detected);
    assert_eq!(detected.path.as_deref(), node.to_str());
}

#[test]
fn gui_candidates_work_without_path_and_are_bounded() {
    let f = Fixture::new();
    let home = f.temp.join("home");
    fs::create_dir_all(home.join(".nvm/versions/node/v22.18.0")).unwrap();
    let fallback = runtime_candidates(&home, Some(std::ffi::OsStr::new("")));
    #[cfg(target_os = "macos")]
    for node in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] { assert!(fallback.contains(&PathBuf::from(node))); }
    assert!(fallback.contains(&home.join(".volta/bin/node")));
    assert!(fallback.contains(&home.join(".local/share/mise/shims/node")));
    assert!(fallback.contains(&home.join(".nvm/versions/node/v22.18.0/bin/node")));
    let first = f.temp.join("path-bin");
    let path = std::env::join_paths([first.clone(), PathBuf::from("relative")]).unwrap();
    let with_path = runtime_candidates(&home, Some(&path));
    assert_eq!(with_path[0], first.join("node"));
    assert!(with_path.iter().all(|p| p.is_absolute())); assert!(with_path.len() <= 32);
    let large = std::env::join_paths((0..100).map(|i| f.temp.join(format!("bin{i}")))).unwrap();
    assert!(runtime_candidates(&home, Some(&large)).len() <= 32);
}

#[tokio::test]
async fn discovery_lists_sanitized_invalid_and_incompatible_folders_without_executing_any_plugin() {
    let f = Fixture::new();
    f.plugin("good", &manifest("good"));
    f.plugin("alias", &manifest("good"));
    let malformed = f.plugin("malformed", &manifest("malformed"));
    fs::write(malformed.join("manifest.json"), "private-path malformed JSON").unwrap();
    let oversized = f.plugin("oversized", &manifest("oversized"));
    fs::write(oversized.join("manifest.json"), vec![b'x'; 16385]).unwrap();
    let mut future = manifest("future"); future["protocolVersion"] = json!(2);
    f.plugin("future", &future);
    let missing = f.plugin("missing", &manifest("missing")); fs::remove_file(missing.join("main.js")).unwrap();
    f.plugin("Bad folder", &manifest("bad"));
    let c = f.install(vec![]).catalog().await.unwrap();
    assert_eq!(c.plugins.len(), 7);
    assert_eq!(c.plugins.iter().find(|p|p.id=="good").unwrap().status, InstallStatus::Ready);
    assert_eq!(c.plugins.iter().find(|p|p.id=="future").unwrap().status, InstallStatus::Incompatible);
    assert_eq!(c.plugins.iter().find(|p|p.id=="future").unwrap().protocol_version, 2);
    for p in c.plugins.iter().filter(|p| p.id!="good" && p.id!="future") { assert_eq!(p.status, InstallStatus::Invalid); assert!(p.message.is_some()); }
    let text = serde_json::to_string(&c.plugins).unwrap();
    assert!(!text.contains("private-path") && !text.contains("Bad folder"));
    assert!(f.calls().is_empty());
}

#[tokio::test]
async fn symlink_escape_aliases_and_traversal_are_rejected() {
    let f = Fixture::new();
    f.plugin("good", &manifest("good"));
    let outside = f.temp.join("outside"); fs::create_dir(&outside).unwrap();
    symlink(&outside, f.root.join("escape")).unwrap();
    symlink(f.root.join("good"), f.root.join("alias")).unwrap();
    let link = f.plugin("file-link", &manifest("file-link"));
    fs::remove_file(link.join("manifest.json")).unwrap(); symlink(f.root.join("good/manifest.json"), link.join("manifest.json")).unwrap();
    let link = f.plugin("main-link", &manifest("main-link"));
    fs::remove_file(link.join("main.js")).unwrap(); symlink(f.root.join("good/main.js"), link.join("main.js")).unwrap();
    let install = f.install(vec![]);
    let c = install.catalog().await.unwrap();
    assert_eq!(c.plugins.iter().filter(|p| p.status==InstallStatus::Ready).count(), 1);
    for id in ["../outside", "/outside", "good/../outside", "escape", "alias", "file-link", "main-link"] {
        assert_eq!(install.enable(&PluginRegistry::default(), id).await.unwrap_err().outcome, Outcome::NotStarted);
    }
    let root_link = f.temp.join("linked-root"); symlink(&f.root, &root_link).unwrap();
    assert!(PluginInstall::new(root_link, vec![]).unwrap().catalog().await.is_err());
}

#[tokio::test]
async fn discovery_lists_more_than_sixteen_plugins_without_truncation() {
    let f = Fixture::new();
    for i in 0..40 { f.plugin(&format!("p{i:02}"), &manifest(&format!("p{i:02}"))); }
    let install = f.install(vec![]);
    let c = install.catalog().await.unwrap();
    assert_eq!(c.plugins.len(), 40);
    assert_eq!(c.plugins.iter().filter(|p| p.status == InstallStatus::Ready).count(), 40);
    assert_eq!(serde_json::to_value(&c).unwrap()["plugins"].as_array().unwrap().len(), 40);
}

#[tokio::test]
async fn trust_is_bound_to_package_identity_and_revokes_on_any_file_change() {
    let f = Fixture::new(); let m = manifest("fake"); f.plugin("fake", &m);
    let install = f.install(vec![f.protocol_runtime(&m)]);
    assert!(install.catalog().await.unwrap().plugins[0].trusted == false);
    trust_current(&f, &install, "fake").await;
    assert!(install.catalog().await.unwrap().plugins[0].trusted);
    // Same id and version, changed entrypoint bytes: trust must be revoked.
    fs::write(f.root.join("fake/main.js"), "console.log('changed package');").unwrap();
    assert!(!install.catalog().await.unwrap().plugins[0].trusted, "changed same-version code must revoke trust");
    assert_eq!(install.enable(&PluginRegistry::default(), "fake").await.unwrap_err().code, Some("not_trusted"));
    let trust_path = f.root.parent().unwrap().join("plugin-trust.v1.json");
    let persisted: Value = serde_json::from_slice(&fs::read(&trust_path).unwrap()).unwrap();
    assert_eq!(persisted["version"], 1); assert!(persisted["plugins"]["fake"].as_str().unwrap().len() == 64);
    trust_current(&f, &install, "fake").await;
    assert!(install.catalog().await.unwrap().plugins[0].trusted);
}

#[tokio::test]
async fn stale_confirmation_identity_cannot_authorize_changed_package() {
    let f = Fixture::new(); let m = manifest("fake"); f.plugin("fake", &m);
    let install = f.install(vec![]);
    let identity_a = f.identity("fake").await;
    // Same id and version, different files: the reviewed identity is now stale.
    fs::write(f.root.join("fake/main.js"), "console.log('package B');").unwrap();
    let error = install.trust("fake", &identity_a).await.unwrap_err();
    assert_eq!(error.code, Some("stale_identity")); assert_eq!(error.outcome, Outcome::NotStarted);
    assert!(error.hint.contains("Refresh the catalog"));
    // B stays untrusted and cannot be enabled through the stale confirmation.
    assert!(!install.catalog().await.unwrap().plugins[0].trusted);
    assert_eq!(install.enable(&PluginRegistry::default(), "fake").await.unwrap_err().code, Some("not_trusted"));
    // A malformed identity is refused before any disk comparison.
    assert_eq!(install.trust("fake", "not-an-identity").await.unwrap_err().code, Some("stale_identity"));
    // A fresh catalog exposes B's identity, which can be explicitly trusted and enabled.
    let identity_b = f.identity("fake").await;
    assert_ne!(identity_a, identity_b);
    install.trust("fake", &identity_b).await.unwrap();
    assert!(install.catalog().await.unwrap().plugins[0].trusted);
}

#[tokio::test]
async fn fingerprint_rejects_deeply_nested_and_oversized_packages() {
    let f = Fixture::new();
    let deep = f.plugin("deep", &manifest("deep"));
    let mut nested = deep.clone();
    for _ in 0..30 { nested.push("d"); fs::create_dir(&nested).unwrap(); }
    let big = f.plugin("big", &manifest("big"));
    // Sparse 64 MiB+1 file: over the declared-byte bound, no large write needed.
    fs::File::create(big.join("blob.bin")).unwrap().set_len(64 * 1024 * 1024 + 1).unwrap();
    let catalog = f.install(vec![]).catalog().await.unwrap();
    for id in ["deep", "big"] {
        let row = catalog.plugins.iter().find(|plugin| plugin.id == id).unwrap();
        assert_eq!(row.status, InstallStatus::Invalid, "{id}");
        assert!(row.identity.is_none(), "{id}");
    }
}

#[tokio::test]
async fn corrupt_missing_or_symlinked_trust_never_blocks_catalog_or_launch_validation() {
    let f = Fixture::new(); let m = manifest("fake"); f.plugin("fake", &m);
    let install = f.install(vec![f.protocol_runtime(&m)]);
    let trust_path = f.root.parent().unwrap().join("plugin-trust.v1.json");
    for bytes in [b"{not json".to_vec(), vec![b'x'; 65_537]] {
        fs::write(&trust_path, bytes).unwrap();
        let catalog = install.catalog().await.unwrap();
        assert_eq!(catalog.plugins.len(), 1); assert!(!catalog.plugins[0].trusted);
    }
    let real = f.temp.join("real-trust.json"); fs::write(&real, "{}").unwrap();
    fs::remove_file(&trust_path).unwrap(); symlink(&real, &trust_path).unwrap();
    assert!(!install.catalog().await.unwrap().plugins[0].trusted);
    assert_eq!(install.trust("unused", &"0".repeat(64)).await.unwrap_err().outcome, Outcome::NotStarted);
}

#[tokio::test]
async fn enabled_preference_restores_exact_identity_and_disable_persists_off() {
    let f = Fixture::new(); let m = manifest("fake"); f.plugin("fake", &m);
    let install = f.install(vec![f.protocol_runtime(&m)]);
    trust_current(&f, &install, "fake").await;
    let first = PluginRegistry::default();
    install.enable(&first, "fake").await.unwrap();
    first.disconnect("fake").await.unwrap();
    let restarted = PluginRegistry::default();
    let prefs = f.root.parent().unwrap().join("plugin-trust.v1.json");
    let modified = fs::metadata(&prefs).unwrap().modified().unwrap();
    f.install(vec![f.protocol_runtime(&m)]).restore(&restarted).await.unwrap();
    assert_eq!(fs::metadata(&prefs).unwrap().modified().unwrap(), modified, "restoring must not rewrite unchanged preferences");
    assert_eq!(restarted.snapshot("fake").await.unwrap().status, ConnectionStatus::Connected);
    assert!(restarted.snapshot("fake").await.unwrap().state.is_none());
    assert_eq!(f.calls().len(), 4, "restore must only launch and describe");
    install.disable(&restarted, "fake").await.unwrap();
    install.restore(&PluginRegistry::default()).await.unwrap();
    assert_eq!(f.calls().len(), 4, "disabled intent survives restart");
}

#[tokio::test]
async fn disable_stops_process_even_when_saving_off_fails() {
    let f = Fixture::new(); let m = manifest("fake"); f.plugin("fake", &m);
    let install = f.install(vec![f.protocol_runtime(&m)]);
    trust_current(&f, &install, "fake").await;
    let registry = PluginRegistry::default(); install.enable(&registry, "fake").await.unwrap();
    let prefs = f.root.parent().unwrap().join("plugin-trust.v1.json");
    fs::remove_file(&prefs).unwrap(); fs::create_dir(&prefs).unwrap();
    let error = install.disable(&registry, "fake").await.unwrap_err();
    assert!(error.hint.contains("may start again after relaunch"));
    assert_eq!(registry.snapshot("fake").await.unwrap().status, ConnectionStatus::Disconnected);
}

#[tokio::test]
async fn changed_retrusted_package_does_not_inherit_enabled_intent_and_corrupt_prefs_are_safe() {
    let f = Fixture::new(); let m = manifest("fake"); f.plugin("fake", &m);
    let install = f.install(vec![f.protocol_runtime(&m)]);
    trust_current(&f, &install, "fake").await;
    let first = PluginRegistry::default(); install.enable(&first, "fake").await.unwrap();
    first.disconnect("fake").await.unwrap();
    fs::write(f.root.join("fake/main.js"), "// changed").unwrap();
    assert!(install.restore(&PluginRegistry::default()).await.is_err());
    trust_current(&f, &install, "fake").await;
    assert!(install.restore(&PluginRegistry::default()).await.is_err());
    assert_eq!(f.calls().len(), 2, "even newly trusted bytes need explicit enabled intent");
    fs::write(f.root.parent().unwrap().join("plugin-trust.v1.json"), "broken").unwrap();
    install.restore(&PluginRegistry::default()).await.unwrap();
    assert_eq!(f.calls().len(), 2);
}

#[tokio::test]
async fn oversized_enabled_set_is_reported_without_launching_any_plugin() {
    let f = Fixture::new();
    fs::create_dir_all(f.root.parent().unwrap()).unwrap();
    let enabled: serde_json::Map<String, Value> = (0..17)
        .map(|index| (format!("fake{index}"), json!("a".repeat(64)))).collect();
    fs::write(f.root.parent().unwrap().join("plugin-trust.v1.json"),
        serde_json::to_vec(&json!({"version":1,"plugins":{},"enabled":enabled})).unwrap()).unwrap();
    let error = f.install(vec![]).restore(&PluginRegistry::default()).await.unwrap_err();
    assert!(error.hint.contains("at most 16"));
    assert!(f.calls().is_empty());
}

#[tokio::test]
async fn enabling_revalidates_and_only_describes_never_reads_state_or_plays() {
    let f = Fixture::new();
    let m = manifest("fake"); f.plugin("fake", &m);
    let install = f.install(vec![f.protocol_runtime(&m)]);
    assert_eq!(install.catalog().await.unwrap().plugins[0].status, InstallStatus::Ready);
    assert!(f.calls().is_empty(), "catalog must never launch main.js");
    let raw_install = f.install(vec![f.protocol_runtime(&m)]);
    assert_eq!(raw_install.enable(&PluginRegistry::default(), "fake").await.unwrap_err().code, Some("not_trusted"), "untrusted packages must not enable");
    trust_current(&f, &install, "fake").await;
    let state = PluginRegistry::default();
    let connected = install.enable(&state, "fake").await.unwrap();
    assert_eq!(connected.status, ConnectionStatus::Connected); assert!(connected.state.is_none());
    assert_eq!(f.calls().len(), 2); assert_eq!(f.calls()[0], "launch");
    let r: Value = serde_json::from_str(&f.calls()[1]).unwrap(); assert_eq!(r["type"], "describe");
    state.disconnect("fake").await.unwrap();
    fs::write(f.root.join("fake/manifest.json"), "{}").unwrap();
    assert!(install.enable(&state, "fake").await.is_err());
    assert_eq!(f.calls().len(), 2, "a previous ready catalog must not authorize changed files");
}

#[tokio::test]
async fn runtime_probe_mutation_is_caught_by_final_revalidation() {
    let f = Fixture::new(); f.plugin("fake", &manifest("fake"));
    for replacement in [json!({}), { let mut m = manifest("fake"); m["actions"][0]["title"] = json!("Changed"); m }] {
        fs::write(f.root.join("fake/manifest.json"), serde_json::to_vec(&manifest("fake")).unwrap()).unwrap();
        let runtime = f.executable("mutating-node", &format!("if [ \"$1\" = '--version' ]; then printf '%s' '{}' > '{}'; printf 'v22.18.0\\n'; else printf 'launch\\n' >> '{}'; fi",
            replacement, f.root.join("fake/manifest.json").display(), f.temp.join("calls").display()));
        let install = f.install(vec![runtime]);
        trust_current(&f, &install, "fake").await;
        assert!(install.enable(&PluginRegistry::default(), "fake").await.is_err());
        assert!(f.calls().is_empty());
    }
}

#[tokio::test]
async fn describe_must_match_entire_disk_contract_and_mismatch_stops_session() {
    for field in ["id", "version", "title", "config"] {
        let f = Fixture::new(); let m = manifest("fake"); f.plugin("fake", &m);
        let mut actual = m.clone();
        match field {
            "id" => actual["id"] = json!("other"),
            "version" => actual["version"] = json!("0.2.0"),
            "title" => actual["actions"][0]["title"] = json!("Different"),
            "config" => actual["actions"][0]["config"] = json!({"n":{"type":"integer","minimum":0,"maximum":1}}),
            _ => unreachable!(),
        }
        let state = PluginRegistry::default();
        let install = f.install(vec![f.protocol_runtime(&actual)]);
        trust_current(&f, &install, "fake").await;
        let error = install.enable(&state, "fake").await.unwrap_err();
        assert_eq!(error.kind, ErrorKind::InvalidManifest); assert_eq!(error.outcome, Outcome::NotStarted);
        let stopped = state.snapshot("fake").await.unwrap();
        assert_eq!(stopped.status, ConnectionStatus::Disconnected); assert!(stopped.manifest.is_none()); assert!(stopped.state.is_none());
        assert_eq!(f.calls().len(), 2);
    }
}

#[tokio::test]
async fn copied_source_snapshot_is_invalid_before_execution_until_bundled_sdk_exists() {
    let f=Fixture::new();let folder=f.spotify_source_snapshot();
    let actual: Value=serde_json::from_slice(include_bytes!("../../../plugins/spotify/manifest.json")).unwrap();
    let install=f.install(vec![f.protocol_runtime(&actual)]);
    let catalog=install.catalog().await.unwrap();
    assert_eq!(catalog.plugins[0].status,InstallStatus::Invalid);
    assert!(catalog.plugins[0].message.unwrap().contains("node_modules"));
    let error=install.enable(&PluginRegistry::default(),"spotify").await.unwrap_err();
    assert_eq!(error.code,Some("missing_dependency"));assert_eq!(error.outcome,Outcome::NotStarted);
    assert!(error.hint.contains("complete packaged"));assert!(f.calls().is_empty());
    f.bundle_sdk(&folder);
    assert_eq!(install.catalog().await.unwrap().plugins[0].status,InstallStatus::Ready);
    trust_current(&f, &install, "spotify").await;
    let state=PluginRegistry::default();let result=install.enable(&state,"spotify").await.unwrap();
    assert!(result.state.is_none());assert_eq!(f.calls().len(),2);
    let request:Value=serde_json::from_str(&f.calls()[1]).unwrap();assert_eq!(request["type"],"describe");
    state.disconnect("spotify").await.unwrap();
}

#[tokio::test]
async fn real_node_describe_reproduces_source_failure_and_accepts_complete_snapshot_via_symlink_runtime() {
    let f=Fixture::new();let folder=f.spotify_source_snapshot();
    let node=std::process::Command::new("node").args(["-p","process.execPath"]).output().expect("Node required for describe-only regression; not skipped");
    assert!(node.status.success());
    let canonical=fs::canonicalize(String::from_utf8(node.stdout).unwrap().trim()).unwrap();
    let alias=f.temp.join("node-alias");symlink(&canonical,&alias).unwrap();
    let detected=detect_node(&[alias.clone(),canonical.clone()]).await;
    assert_eq!(detected.status,NodeStatus::Detected,"Node >=22.18.0 required");
    assert_eq!(detected.path.as_deref(),alias.to_str());
    let state=PluginRegistry::default();
    let error=state.connect("spotify",canonical.to_str().unwrap().into(),folder.join("main.js").to_str().unwrap().into()).await.unwrap_err();
    assert_eq!(error.code,Some("missing_dependency"));assert_eq!(error.outcome,Outcome::NotStarted);
    assert_eq!(state.snapshot("spotify").await.unwrap().status,ConnectionStatus::Disconnected);
    assert!(!serde_json::to_string(&error).unwrap().contains(f.temp.to_str().unwrap()));
    f.bundle_sdk(&folder);
    let install=f.install(vec![alias]);trust_current(&f, &install, "spotify").await;
    let result=install.enable(&state,"spotify").await.unwrap();
    assert_eq!(result.status,ConnectionStatus::Connected);assert_eq!(result.manifest.unwrap().id,"spotify");assert!(result.state.is_none());
    state.disconnect("spotify").await.unwrap();
}

#[tokio::test]
async fn nested_sdk_symlinks_missing_files_and_invalid_metadata_fail_closed_without_execution() {
    for relative in ["node_modules","node_modules/@zdeck","node_modules/@zdeck/plugin-sdk","node_modules/@zdeck/plugin-sdk/index.js","node_modules/@zdeck/plugin-sdk/package.json","package.json"] {
        let f=Fixture::new();let folder=f.spotify_source_snapshot();f.bundle_sdk(&folder);
        let target=folder.join(relative);let outside=f.temp.join("alias-target");fs::rename(&target,&outside).unwrap();symlink(&outside,&target).unwrap();
        let catalog=f.install(vec![]).catalog().await.unwrap();
        assert_eq!(catalog.plugins[0].status,InstallStatus::Invalid,"{relative}");
        assert!(catalog.plugins[0].message.unwrap().contains("symlink"));assert!(f.calls().is_empty());
    }
    for file in ["index.js","package.json"] {
        let f=Fixture::new();let folder=f.spotify_source_snapshot();f.bundle_sdk(&folder);
        fs::remove_file(folder.join("node_modules/@zdeck/plugin-sdk").join(file)).unwrap();
        assert_eq!(f.install(vec![]).catalog().await.unwrap().plugins[0].status,InstallStatus::Invalid);
    }
    let f=Fixture::new();let folder=f.spotify_source_snapshot();f.bundle_sdk(&folder);
    let sdk=folder.join("node_modules/@zdeck/plugin-sdk/package.json");
    for bytes in [b"{private-secret invalid JSON".to_vec(),vec![b'x';16385],br#"{"name":"@zdeck/plugin-sdk","type":"module","exports":{}}"#.to_vec()] {
        fs::write(&sdk,bytes).unwrap();let catalog=f.install(vec![]).catalog().await.unwrap();
        assert_eq!(catalog.plugins[0].status,InstallStatus::Invalid);assert!(!serde_json::to_string(&catalog.plugins).unwrap().contains("private-secret"));
    }
}

#[tokio::test]
async fn launch_runtime_errors_are_actionable_fixed_and_not_started() {
    let f=Fixture::new();f.plugin("fake",&manifest("fake"));
    for (candidates,code) in [(vec![],"runtime_missing"),(vec![f.runtime("old","v20.0.0")],"runtime_incompatible"),(vec![f.executable("startup-exit","if [ \"$1\" = '--version' ]; then printf 'v22.18.0\\n'; fi")],"startup_exit")] {
        let install=f.install(candidates);trust_current(&f, &install, "fake").await;
        let error=install.enable(&PluginRegistry::default(),"fake").await.unwrap_err();
        assert_eq!(error.code,Some(code));assert_eq!(error.outcome,Outcome::NotStarted);
        assert!(error.hint.contains("22.18.0"));assert!(!serde_json::to_string(&error).unwrap().contains(f.temp.to_str().unwrap()));
    }
}

#[tokio::test]
async fn diagnostics_explain_source_sdk_link_without_executing_or_exposing_paths() {
    let f=Fixture::new();let folder=f.spotify_source_snapshot();f.bundle_sdk(&folder);
    let sdk=folder.join("node_modules/@zdeck/plugin-sdk");fs::rename(&sdk,f.temp.join("private-secret-sdk")).unwrap();
    symlink("../../../../packages/plugin-sdk",&sdk).unwrap();
    let install=f.install(vec![f.runtime("node","v22.18.0")]);
    let result=install.diagnostics("spotify").await.unwrap();assert_eq!(result.plugin_id,"spotify");assert_eq!(result.checks.len(),6);
    let sdk=result.checks.iter().find(|c|c.name=="sdk").unwrap();assert_eq!(sdk.status,"fail");assert!(sdk.message.contains("npm source-development"));assert!(sdk.message.contains("distribution"));
    assert!(result.checks.iter().filter(|c|c.name!="sdk").all(|c|c.status=="pass"));
    let serialized=serde_json::to_string(&result).unwrap();assert!(!serialized.contains("private-secret") && !serialized.contains(f.temp.to_str().unwrap()));
    assert!(f.calls().is_empty());assert!(fs::symlink_metadata(&sdk_path(&folder)).unwrap().file_type().is_symlink());
    assert!(install.diagnostics("../spotify").await.is_err());
    fs::write(folder.join("manifest.json"),"private-secret malformed").unwrap();
    let result=install.diagnostics("spotify").await.unwrap();assert_eq!(result.checks.iter().find(|c|c.name=="manifest").unwrap().status,"fail");
    assert!(!serde_json::to_string(&result).unwrap().contains("private-secret"));
    let absent=Fixture::new();let result=absent.install(vec![]).diagnostics("missing").await.unwrap();assert_eq!(result.checks.len(),6);assert!(!absent.root.exists());
}
fn sdk_path(folder:&std::path::Path)->PathBuf{folder.join("node_modules/@zdeck/plugin-sdk")}

#[tokio::test]
async fn uninstall_preserves_bytes_in_unique_reversible_backups_and_leaves_other_plugin_running() {
    let f=Fixture::new();let alpha=f.fake_plugin("alpha",false);f.fake_plugin("beta",false);
    let original=fs::read(alpha.join("main.js")).unwrap();let install=f.install(vec![f.node()]);let registry=PluginRegistry::default();
    trust_current(&f, &install, "alpha").await;trust_current(&f, &install, "beta").await;
    install.enable(&registry,"alpha").await.unwrap();install.enable(&registry,"beta").await.unwrap();
    assert_eq!(f.calls(),vec!["alpha:describe","beta:describe"]);
    install.uninstall(&registry,"alpha").await.unwrap();assert!(!alpha.exists());
    let prefs: Value = serde_json::from_slice(&fs::read(f.root.parent().unwrap().join("plugin-trust.v1.json")).unwrap()).unwrap();
    assert!(prefs["enabled"].get("alpha").is_none());
    assert!(prefs["plugins"].get("alpha").is_none());
    assert!(prefs["enabled"].get("beta").is_some());
    assert_eq!(registry.snapshot("alpha").await.unwrap().status,ConnectionStatus::Disconnected);
    assert_eq!(registry.snapshot("beta").await.unwrap().status,ConnectionStatus::Connected);
    assert_eq!(registry.execute("beta".into(),"play".into(),json!({})).await.unwrap().state.unwrap()["plugin"],"beta");
    let backups=f.root.parent().unwrap().join("plugin-backups");let first=fs::read_dir(&backups).unwrap().next().unwrap().unwrap().path();
    assert!(first.file_name().unwrap().to_str().unwrap().starts_with("alpha-"));assert_eq!(fs::read(first.join("main.js")).unwrap(),original);
    fs::rename(&first,&alpha).unwrap();trust_current(&f, &install, "alpha").await;install.enable(&registry,"alpha").await.unwrap();
    fs::create_dir(&first).unwrap();fs::write(first.join("keep"),"existing backup").unwrap();
    install.uninstall(&registry,"alpha").await.unwrap();let second=fs::read_dir(&backups).unwrap().map(Result::unwrap).find(|e|e.path()!=first).unwrap().path();assert_ne!(first,second);
    assert_eq!(fs::read_to_string(first.join("keep")).unwrap(),"existing backup");
    assert_eq!(fs::read(second.join("main.js")).unwrap(),original);
    // Invalid source/dependency trees can be removed without executing them.
    let invalid=f.spotify_source_snapshot();let bytes=fs::read(invalid.join("main.js")).unwrap();
    fs::create_dir_all(invalid.join("node_modules/@zdeck")).unwrap();symlink("../../../../packages/plugin-sdk",sdk_path(&invalid)).unwrap();
    install.uninstall(&registry,"spotify").await.unwrap();assert!(!invalid.exists());
    let backup=fs::read_dir(&backups).unwrap().map(Result::unwrap).find(|e|e.file_name().to_str().unwrap().starts_with("spotify-")).unwrap().path();assert_eq!(fs::read(backup.join("main.js")).unwrap(),bytes);
    assert_eq!(fs::read_link(sdk_path(&backup)).unwrap(),PathBuf::from("../../../../packages/plugin-sdk"));
    assert_eq!(registry.state("beta").await.unwrap().status,ConnectionStatus::Connected);registry.disconnect("beta").await.unwrap();
}

#[tokio::test]
async fn uninstall_rejects_traversal_aliases_and_unsafe_backups_without_touching_other_sessions() {
    let f=Fixture::new();let alpha=f.fake_plugin("alpha",false);f.fake_plugin("beta",false);
    let install=f.install(vec![f.node()]);let registry=PluginRegistry::default();
    trust_current(&f, &install, "alpha").await;trust_current(&f, &install, "beta").await;
    install.enable(&registry,"alpha").await.unwrap();install.enable(&registry,"beta").await.unwrap();
    let outside=f.temp.join("outside");fs::create_dir(&outside).unwrap();fs::write(outside.join("keep"),"private-secret").unwrap();symlink(&outside,f.root.join("alias")).unwrap();
    for id in ["../outside","/outside","alias","missing"] {let error=install.uninstall(&registry,id).await.unwrap_err();assert!(!serde_json::to_string(&error).unwrap().contains("private-secret"));}
    assert!(alpha.exists());assert_eq!(registry.snapshots().await.len(),2);
    symlink(&outside,f.root.parent().unwrap().join("plugin-backups")).unwrap();
    let error=install.uninstall(&registry,"alpha").await.unwrap_err();assert!(error.hint.contains("not a symlink"));assert!(alpha.exists());
    assert_eq!(registry.snapshot("alpha").await.unwrap().status,ConnectionStatus::Disconnected);
    assert_eq!(registry.state("beta").await.unwrap().status,ConnectionStatus::Connected);
    assert_eq!(fs::read_to_string(outside.join("keep")).unwrap(),"private-secret");registry.disconnect("beta").await.unwrap();
}

#[tokio::test]
async fn duplicate_enable_and_uninstall_are_serialized_for_the_same_plugin() {
    let f=Fixture::new();let folder=f.fake_plugin("alpha",false);let install=f.install(vec![f.node()]);let registry=PluginRegistry::default();
    trust_current(&f, &install, "alpha").await;
    let (one,two,removed)=tokio::join!(install.enable(&registry,"alpha"),install.enable(&registry,"alpha"),install.uninstall(&registry,"alpha"));
    one.unwrap();two.unwrap();removed.unwrap();assert!(!folder.exists());assert!(registry.snapshots().await.is_empty());assert_eq!(f.calls(),vec!["alpha:describe","alpha:describe"]);
    assert!(install.enable(&registry,"alpha").await.is_err());assert!(registry.snapshots().await.is_empty());
}

#[tokio::test]
async fn uninstall_disabled_folder_works_while_running_capacity_is_full() {
    let f=Fixture::new();let folder=f.plugin("unused",&manifest("unused"));f.fake_plugin("alpha",false);
    let registry=PluginRegistry::with_capacity(1);
    let install=f.install(vec![f.node()]);trust_current(&f, &install, "alpha").await;install.enable(&registry,"alpha").await.unwrap();
    let missing=f.temp.join("missing-runtime").to_str().unwrap().to_owned();let entry=f.temp.join("missing.js").to_str().unwrap().to_owned();
    assert_eq!(registry.connect("overflow",missing,entry).await.unwrap_err().code,Some("capacity"));
    f.install(vec![]).uninstall(&registry,"unused").await.unwrap();assert!(!folder.exists());
    assert_eq!(registry.snapshots().await.len(),1);assert_eq!(f.calls(),vec!["alpha:describe"]);
    registry.disconnect("alpha").await.unwrap();
}

#[test]
fn open_helper_creates_only_fixed_folder_and_prepares_opener_without_running_it() {
    let f = Fixture::new();
    let command = f.install(vec![]).prepare_open().unwrap();
    assert!(f.root.is_dir()); assert_eq!(fs::read_dir(&f.root).unwrap().count(), 0);
    let command = command.as_std();
    let args: Vec<_> = command.get_args().collect();
    assert_eq!(args, vec![fs::canonicalize(&f.root).unwrap().as_os_str()]);
    #[cfg(target_os = "macos")]
    assert_eq!(command.get_program(), "/usr/bin/open");
    #[cfg(target_os = "linux")]
    assert_eq!(command.get_program(), "/usr/bin/xdg-open");
    assert!(f.calls().is_empty());
}
