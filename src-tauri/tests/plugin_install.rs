//! Isolated discovery/runtime tests. No real installed plugin directory or folder opener.
//! The reference Spotify process is exercised with describe ONLY in a temporary
//! source/artifact snapshot; never state, execute or Automation.
#![cfg(unix)]
use std::{fs, os::unix::fs::{symlink, PermissionsExt}, path::PathBuf, sync::atomic::{AtomicU64, Ordering}, time::{Duration, Instant}};
use deck_lib::{plugin::{ConnectionStatus, ErrorKind, Outcome, PluginState}, plugin_install::{detect_node, runtime_candidates, InstallStatus, NodeStatus, PluginInstall}};
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
            ("manifest.json", include_bytes!("../../plugins/spotify/manifest.json")),
            ("main.js", include_bytes!("../../plugins/spotify/main.js")),
            ("spotify.js", include_bytes!("../../plugins/spotify/spotify.js")),
            ("package.json", include_bytes!("../../plugins/spotify/package.json")),
        ];
        for (name, bytes) in files { fs::write(folder.join(name), bytes).unwrap(); }
        folder
    }
    fn bundle_sdk(&self, folder: &std::path::Path) {
        let sdk = folder.join("node_modules/@zdeck/plugin-sdk"); fs::create_dir_all(&sdk).unwrap();
        let files: [(&str, &[u8]); 4] = [
            ("index.js", include_bytes!("../../packages/plugin-sdk/index.js")),
            ("index.d.ts", include_bytes!("../../packages/plugin-sdk/index.d.ts")),
            ("package.json", include_bytes!("../../packages/plugin-sdk/package.json")),
            ("LICENSE", include_bytes!("../../packages/plugin-sdk/LICENSE")),
        ];
        for (name, bytes) in files { fs::write(sdk.join(name), bytes).unwrap(); }
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

#[tokio::test]
async fn missing_root_stays_missing_and_catalog_has_frozen_shape() {
    let f = Fixture::new();
    let catalog = f.install(vec![]).catalog().await.unwrap();
    assert!(catalog.plugins.is_empty()); assert!(!catalog.truncated); assert!(!f.root.exists());
    assert_eq!(serde_json::to_value(&catalog).unwrap(), json!({"directory":f.root.to_str().unwrap(),"node":{"status":"not_found","version":null,"path":null},"plugins":[],"truncated":false}));
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
        assert_eq!(install.enable(&PluginState::default(), id).await.unwrap_err().outcome, Outcome::NotStarted);
    }
    let root_link = f.temp.join("linked-root"); symlink(&f.root, &root_link).unwrap();
    assert!(PluginInstall::new(root_link, vec![]).unwrap().catalog().await.is_err());
}

#[tokio::test]
async fn directory_entry_cap_is_explicit_and_enable_fails_closed_on_truncation() {
    let f = Fixture::new();
    for i in 0..65 { f.plugin(&format!("p{i}"), &manifest(&format!("p{i}"))); }
    let install = f.install(vec![]);
    let c = install.catalog().await.unwrap();
    assert!(c.truncated); assert!(c.plugins.len() <= 64);
    assert!(install.enable(&PluginState::default(), "p0").await.unwrap_err().hint.contains("64"));
}

#[tokio::test]
async fn enabling_revalidates_and_only_describes_never_reads_state_or_plays() {
    let f = Fixture::new();
    let m = manifest("fake"); f.plugin("fake", &m);
    let install = f.install(vec![f.protocol_runtime(&m)]);
    assert_eq!(install.catalog().await.unwrap().plugins[0].status, InstallStatus::Ready);
    assert!(f.calls().is_empty(), "catalog must never launch main.js");
    let state = PluginState::default();
    let connected = install.enable(&state, "fake").await.unwrap();
    assert_eq!(connected.status, ConnectionStatus::Connected); assert!(connected.state.is_none());
    assert_eq!(f.calls().len(), 2); assert_eq!(f.calls()[0], "launch");
    let r: Value = serde_json::from_str(&f.calls()[1]).unwrap(); assert_eq!(r["type"], "describe");
    state.disconnect().await;
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
        assert!(f.install(vec![runtime]).enable(&PluginState::default(), "fake").await.is_err());
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
        let state = PluginState::default();
        let error = f.install(vec![f.protocol_runtime(&actual)]).enable(&state, "fake").await.unwrap_err();
        assert_eq!(error.kind, ErrorKind::InvalidManifest); assert_eq!(error.outcome, Outcome::NotStarted);
        let stopped = state.snapshot().await;
        assert_eq!(stopped.status, ConnectionStatus::Stopped); assert!(stopped.manifest.is_none()); assert!(stopped.state.is_none());
        assert_eq!(f.calls().len(), 2);
    }
}

#[tokio::test]
async fn copied_source_snapshot_is_invalid_before_execution_until_bundled_sdk_exists() {
    let f=Fixture::new();let folder=f.spotify_source_snapshot();
    let actual: Value=serde_json::from_slice(include_bytes!("../../plugins/spotify/manifest.json")).unwrap();
    let install=f.install(vec![f.protocol_runtime(&actual)]);
    let catalog=install.catalog().await.unwrap();
    assert_eq!(catalog.plugins[0].status,InstallStatus::Invalid);
    assert!(catalog.plugins[0].message.unwrap().contains("node_modules"));
    let error=install.enable(&PluginState::default(),"spotify").await.unwrap_err();
    assert_eq!(error.code,Some("missing_dependency"));assert_eq!(error.outcome,Outcome::NotStarted);
    assert!(error.hint.contains("complete packaged"));assert!(f.calls().is_empty());
    f.bundle_sdk(&folder);
    assert_eq!(install.catalog().await.unwrap().plugins[0].status,InstallStatus::Ready);
    let state=PluginState::default();let result=install.enable(&state,"spotify").await.unwrap();
    assert!(result.state.is_none());assert_eq!(f.calls().len(),2);
    let request:Value=serde_json::from_str(&f.calls()[1]).unwrap();assert_eq!(request["type"],"describe");
    state.disconnect().await;
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
    let state=PluginState::default();
    let error=state.connect(canonical.to_str().unwrap().into(),folder.join("main.js").to_str().unwrap().into()).await.unwrap_err();
    assert_eq!(error.code,Some("missing_dependency"));assert_eq!(error.outcome,Outcome::NotStarted);
    assert_eq!(state.snapshot().await.status,ConnectionStatus::Stopped);
    assert!(!serde_json::to_string(&error).unwrap().contains(f.temp.to_str().unwrap()));
    f.bundle_sdk(&folder);
    let result=f.install(vec![alias]).enable(&state,"spotify").await.unwrap();
    assert_eq!(result.status,ConnectionStatus::Connected);assert_eq!(result.manifest.unwrap().id,"spotify");assert!(result.state.is_none());
    state.disconnect().await;
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
        let error=f.install(candidates).enable(&PluginState::default(),"fake").await.unwrap_err();
        assert_eq!(error.code,Some(code));assert_eq!(error.outcome,Outcome::NotStarted);
        assert!(error.hint.contains("22.18.0"));assert!(!serde_json::to_string(&error).unwrap().contains(f.temp.to_str().unwrap()));
    }
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
