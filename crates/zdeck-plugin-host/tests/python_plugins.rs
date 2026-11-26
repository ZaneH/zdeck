//! Cross-platform Python discovery and real stdio integration in temporary roots.
//! No installed plugins, external applications or OS permissions are used.
use std::{fs, path::{Path, PathBuf}, process::Command, sync::atomic::{AtomicU64, Ordering}};
use zdeck_plugin_host::{plugin::{ConnectionStatus, PluginRegistry}, plugin_install::{detect_python, python_runtime_candidates, InstallStatus, NodeStatus, PluginInstall, PluginRuntime}};
use serde_json::json;

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture { temp: PathBuf, root: PathBuf }
impl Fixture {
    fn new() -> Self {
        let temp = std::env::temp_dir().join(format!("zdeck-python-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        let root = temp.join("plugins"); fs::create_dir_all(&root).unwrap();
        Self { temp, root }
    }
    fn plugin(&self) -> PathBuf {
        let folder = self.root.join("hello-python"); fs::create_dir(&folder).unwrap();
        fs::write(folder.join("manifest.json"), include_bytes!("../../../packages/plugin-sdk-python/examples/hello/manifest.json")).unwrap();
        fs::write(folder.join("main.py"), include_bytes!("../../../packages/plugin-sdk-python/examples/hello/main.py")).unwrap();
        fs::create_dir(folder.join("zdeck_plugin_sdk")).unwrap();
        fs::write(folder.join("zdeck_plugin_sdk/__init__.py"), include_bytes!("../../../packages/plugin-sdk-python/zdeck_plugin_sdk/__init__.py")).unwrap();
        fs::write(folder.join("zdeck_plugin_sdk/types.py"), include_bytes!("../../../packages/plugin-sdk-python/zdeck_plugin_sdk/types.py")).unwrap();
        folder
    }
    fn install(&self, python: Vec<PathBuf>) -> PluginInstall {
        PluginInstall::new(self.root.clone(), vec![]).unwrap().with_python_candidates(python).unwrap()
    }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.temp); } }
fn python() -> PathBuf {
    for program in ["python3", "python"] {
        if let Ok(output) = Command::new(program).args(["-E", "-s", "-B", "-c", "import sys; print(sys.executable)"]).output() {
            if output.status.success() {
                return PathBuf::from(String::from_utf8(output.stdout).unwrap().trim());
            }
        }
    }
    panic!("Python 3.10+ is required for Python plugin integration tests");
}

#[tokio::test]
async fn python_plugin_trust_execute_and_restart_round_trip() {
    let f = Fixture::new(); let folder = f.plugin();
    let install = f.install(vec![python()]);
    let catalog = install.catalog().await.unwrap();
    assert_eq!(catalog.node.status, NodeStatus::NotFound);
    assert_eq!(catalog.python.status, NodeStatus::Detected);
    assert_eq!(catalog.plugins[0].runtime, PluginRuntime::Python);
    assert_eq!(catalog.plugins[0].status, InstallStatus::Ready);
    let identity = catalog.plugins[0].identity.clone().unwrap();
    let registry = PluginRegistry::default();
    assert_eq!(install.enable(&registry, "hello-python").await.unwrap_err().code, Some("not_trusted"));
    install.trust("hello-python", &identity).await.unwrap();
    let snapshot = install.enable(&registry, "hello-python").await.unwrap();
    assert_eq!(snapshot.status, ConnectionStatus::Connected);
    assert!(snapshot.state.is_none(), "enable describes only; no state read");
    let snapshot = registry.execute("hello-python".into(), "set-level".into(), json!({"level":25})).await.unwrap();
    assert_eq!(snapshot.state.unwrap()["level"], 25);
    assert!(registry.execute("hello-python".into(), "set-level".into(), json!({"level":23})).await.is_err());
    registry.disconnect("hello-python").await.unwrap();
    let restarted = f.install(vec![python()]); let restored = PluginRegistry::default();
    restarted.restore(&restored).await.unwrap();
    assert_eq!(restored.snapshots().await["hello-python"].status, ConnectionStatus::Connected);
    assert!(restored.snapshots().await["hello-python"].state.is_none());
    assert_eq!(restarted.catalog().await.unwrap().plugins[0].identity.as_ref(), Some(&identity), "-B must keep the fingerprint stable");
    assert!(!folder.join("zdeck_plugin_sdk/__pycache__").exists());
    restarted.disable(&restored, "hello-python").await.unwrap();
    let disabled = PluginRegistry::default(); f.install(vec![python()]).restore(&disabled).await.unwrap();
    assert!(disabled.snapshots().await.is_empty());
    fs::write(folder.join("zdeck_plugin_sdk/__init__.py"), "# changed").unwrap();
    assert!(!restarted.catalog().await.unwrap().plugins[0].trusted);
}

#[tokio::test]
async fn python_discovery_is_inert_and_rejects_missing_sdk_and_ambiguous_entrypoints() {
    let f = Fixture::new(); let folder = f.plugin();
    fs::write(folder.join("main.py"), "raise RuntimeError('discovery must not execute')").unwrap();
    let install = f.install(vec![]);
    assert_eq!(install.catalog().await.unwrap().plugins[0].status, InstallStatus::Ready);
    let identity = install.catalog().await.unwrap().plugins[0].identity.clone().unwrap();
    install.trust("hello-python", &identity).await.unwrap();
    assert_eq!(install.enable(&PluginRegistry::default(), "hello-python").await.unwrap_err().code, Some("runtime_missing"));
    let checks = install.diagnostics("hello-python").await.unwrap().checks;
    assert!(checks.iter().any(|c| c.name == "runtime" && c.status == "fail" && c.message.contains("Python")));
    fs::write(folder.join("main.js"), "").unwrap();
    assert_eq!(install.catalog().await.unwrap().plugins[0].status, InstallStatus::Invalid);
    fs::remove_file(folder.join("main.js")).unwrap(); fs::remove_file(folder.join("zdeck_plugin_sdk/__init__.py")).unwrap();
    assert_eq!(install.catalog().await.unwrap().plugins[0].status, InstallStatus::Invalid);
}

#[tokio::test]
async fn python_startup_dependency_errors_are_sanitized() {
    let f = Fixture::new(); let folder = f.plugin();
    fs::write(folder.join("main.py"), "import zdeck_missing_dependency_private_token\n").unwrap();
    let install = f.install(vec![python()]);
    let identity = install.catalog().await.unwrap().plugins[0].identity.clone().unwrap();
    install.trust("hello-python", &identity).await.unwrap();
    let error = install.enable(&PluginRegistry::default(), "hello-python").await.unwrap_err();
    assert_eq!(error.code, Some("missing_dependency"));
    let public = serde_json::to_string(&error).unwrap();
    assert!(!public.contains("private_token"));
    assert!(!public.contains(folder.to_str().unwrap()));
}

#[test]
fn python_paths_are_bounded_absolute_and_include_platform_interpreters() {
    let home = std::env::temp_dir();
    let path = std::env::join_paths([Path::new("relative"), home.as_path()]).unwrap();
    let candidates = python_runtime_candidates(&home, Some(&path));
    assert!(candidates.len() <= 32);
    assert!(candidates.iter().all(|p| p.is_absolute()));
    assert!(candidates.iter().all(|p| p.file_name().unwrap().to_string_lossy().starts_with("python")));
    let f = Fixture::new();
    assert!(PluginInstall::new(f.root.clone(), vec![]).unwrap().with_python_candidates(vec!["relative".into()]).is_err());
}

#[tokio::test]
async fn python_version_detection_and_invalid_candidates() {
    assert_eq!(detect_python(&[python()]).await.status, NodeStatus::Detected);
    assert_eq!(detect_python(&[PathBuf::from("relative"), std::env::temp_dir().join("missing-python-executable")]).await.status, NodeStatus::NotFound);
}

#[cfg(unix)]
#[tokio::test]
async fn python_rejects_symlinks_and_old_versions() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let f = Fixture::new(); let folder = f.plugin();
    let runtime = f.temp.join("old-python"); fs::write(&runtime, "#!/bin/sh\nprintf 'Python 3.9.9\\n'\n").unwrap();
    fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(detect_python(&[runtime]).await.status, NodeStatus::Unsupported);
    fs::remove_file(folder.join("main.py")).unwrap(); symlink(folder.join("manifest.json"), folder.join("main.py")).unwrap();
    assert_eq!(f.install(vec![]).catalog().await.unwrap().plugins[0].status, InstallStatus::Invalid);
}
