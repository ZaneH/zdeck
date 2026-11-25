//! Local discovery only: no package installation, plugin execution, or persistent enabling.
//! Runtime probes execute --version, never a shell or a plugin entrypoint.
use std::{collections::HashSet, fs, io::Read, path::{Path, PathBuf}, process::Stdio, time::Duration};
use serde::Serialize;
use serde_json::Value;
use tokio::{io::AsyncReadExt, process::Command, time::{timeout, Instant}};
use crate::plugin::{identifier, manifest, ErrorKind, LaunchFailure, Manifest, Outcome, PluginError, PluginSnapshot, PluginRegistry};

const MAX_FOLDERS: usize = 64;
const MAX_RUNTIMES: usize = 32;
const MANIFEST_BYTES: u64 = 16_384;
const PROBE_BYTES: u64 = 128;
const SDK: &str = "@zdeck/plugin-sdk";
const SDK_MISSING: &str = "Required bundled @zdeck/plugin-sdk files are missing. Copy the complete packaged plugin folder, including node_modules; do not copy the source folder alone.";
const SDK_INVALID: &str = "Bundled SDK files must be readable regular local files, with valid package metadata and no symlinks. Copy the complete packaged plugin folder.";
const SDK_LINK: &str = "The SDK is symlinked, as created by npm source-development installs. Copy the complete generated distribution folder with regular bundled SDK files instead.";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDiagnostics { pub plugin_id: String, pub checks: Vec<DiagnosticCheck> }
#[derive(Debug, Serialize)]
pub struct DiagnosticCheck { pub name: &'static str, pub status: &'static str, pub message: &'static str }


#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeStatus { Detected, NotFound, Unsupported }
#[derive(Debug, Clone, Serialize)]
pub struct NodeRuntime { pub status: NodeStatus, pub version: Option<String>, pub path: Option<String> }
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallStatus { Ready, Invalid, Incompatible }
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    /// Empty for an invalid folder name; never usable as an enable argument.
    pub id: String,
    pub name: String,
    pub version: String,
    pub protocol_version: u8,
    pub status: InstallStatus,
    pub message: Option<&'static str>,
}
#[derive(Debug, Serialize)]
pub struct PluginCatalog {
    pub directory: String,
    pub node: NodeRuntime,
    pub plugins: Vec<InstalledPlugin>,
    /// More than 64 directory entries: remove extras before enabling anything.
    pub truncated: bool,
}

fn failure(hint: &'static str) -> PluginError {
    let mut error = PluginError::new(ErrorKind::InvalidLaunch, Outcome::NotStarted);
    error.hint = hint;
    error
}
fn path_string(path: &Path) -> Result<String, PluginError> {
    path.to_str().filter(|s| s.len() <= 4096 && !s.chars().any(char::is_control))
        .map(str::to_owned).ok_or_else(|| failure("Use a local plugin directory with a bounded Unicode path and no control characters."))
}

/// Paths/candidates are trusted desktop configuration, never deserialized from IPC.
#[derive(Clone)]
pub struct PluginInstall { directory: PathBuf, candidates: Vec<PathBuf> }
impl PluginInstall {
    /// Also permits isolated tests to inject temporary roots and fake runtimes.
    pub fn new(directory: PathBuf, candidates: Vec<PathBuf>) -> Result<Self, PluginError> {
        if !directory.is_absolute() || candidates.len() > MAX_RUNTIMES || candidates.iter().any(|p| !p.is_absolute()) {
            return Err(failure("Use absolute local plugin and runtime paths."));
        }
        path_string(&directory)?;
        Ok(Self { directory, candidates })
    }
    /// The home comes from Tauri's path resolver, not HOME or a caller-supplied path.
    pub fn for_home(home: PathBuf) -> Result<Self, PluginError> {
        #[cfg(target_os = "linux")]
        let config = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| home.join(".config"));
        #[cfg(not(target_os = "linux"))]
        let config = home.join(".config");
        let candidates = runtime_candidates(&home, std::env::var_os("PATH").as_deref());
        Self::new(config.join("zdeck/plugins"), candidates)
    }
    fn root(&self) -> Result<Option<PathBuf>, PluginError> {
        match fs::symlink_metadata(&self.directory) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {
                fs::canonicalize(&self.directory).map(Some).map_err(|_| failure("The plugin directory cannot be read. Check its local permissions."))
            }
            _ => Err(failure("The plugin directory must be a readable real directory, not a symlink or file.")),
        }
    }
    fn discover(&self) -> Result<(Vec<InstalledPlugin>, bool), PluginError> {
        let Some(root) = self.root()? else { return Ok((vec![], false)); };
        let entries = fs::read_dir(&root).map_err(|_| failure("The plugin directory cannot be read. Check its local permissions."))?;
        let mut plugins = Vec::new();
        let mut truncated = false;
        for (index, entry) in entries.enumerate() {
            if index == MAX_FOLDERS { truncated = true; break; }
            let entry = entry.map_err(|_| failure("A plugin directory entry cannot be read. Check its local permissions."))?;
            let kind = entry.file_type().map_err(|_| failure("A plugin directory entry cannot be read. Check its local permissions."))?;
            if !kind.is_dir() && !kind.is_symlink() { continue; }
            let id = entry.file_name().to_str().filter(|s| identifier(s)).unwrap_or("").to_owned();
            plugins.push(inspect_folder(&root, &entry.path(), &id).0);
        }
        plugins.sort_by(|a, b| a.id.cmp(&b.id));
        Ok((plugins, truncated))
    }
    pub async fn catalog(&self) -> Result<PluginCatalog, PluginError> {
        let install = self.clone();
        let (plugins, truncated) = tokio::task::spawn_blocking(move || install.discover()).await
            .map_err(|_| failure("Plugin discovery failed. Check the local directory and retry explicitly."))??;
        Ok(PluginCatalog { directory: path_string(&self.directory)?, node: detect_node(&self.candidates).await, plugins, truncated })
    }
    pub async fn enable(&self, registry: &PluginRegistry, plugin_id: &str) -> Result<PluginSnapshot, PluginError> {
        if !identifier(plugin_id) { return Err(failure("Choose a valid plugin ID from the local catalog.")); }
        let install = self.clone(); let id = plugin_id.to_owned();
        registry.manage(plugin_id, true, false, move |state| async move { install.enable_session(&state, &id).await }).await
    }
    async fn enable_session(&self, state: &crate::plugin::PluginState, plugin_id: &str) -> Result<PluginSnapshot, PluginError> {
        let install = self.clone();
        let id = plugin_id.to_owned();
        let (entrypoint, expected) = tokio::task::spawn_blocking(move || {
            // A truncated catalog must not give filesystem order authority over enabling.
            let (plugins, truncated) = install.discover()?;
            if truncated { return Err(failure("The plugin directory has more than 64 entries. Remove extras, refresh, and enable explicitly.")); }
            let selected = plugins.iter().find(|p| p.id == id).ok_or_else(|| failure("The selected plugin is not in the local catalog. Refresh and select it explicitly."))?;
            if selected.status != InstallStatus::Ready {
                return Err(if selected.message == Some(SDK_MISSING) {
                    PluginError::launch(LaunchFailure::MissingDependency)
                } else { failure(selected.message.unwrap_or("The selected plugin is not ready in the local catalog.")) });
            }
            let root = install.root()?.ok_or_else(|| failure("The plugin directory was removed. Refresh the catalog."))?;
            inspect_folder(&root, &root.join(&id), &id).1.ok_or_else(|| failure("The plugin changed or is invalid. Refresh the catalog before enabling it."))
        }).await.map_err(|_| failure("Plugin discovery failed. Refresh the local catalog."))??;
        let node = detect_node(&self.candidates).await;
        if node.status != NodeStatus::Detected {
            return Err(PluginError::launch(if node.status == NodeStatus::Unsupported {
                LaunchFailure::RuntimeIncompatible
            } else { LaunchFailure::RuntimeMissing }));
        }
        // Runtime probes can take time: recheck paths and the full disk contract before launch.
        let install = self.clone();
        let id = plugin_id.to_owned();
        let expected_path = entrypoint.clone();
        let expected_manifest = expected.clone();
        tokio::task::spawn_blocking(move || {
            let root = install.root()?.ok_or_else(|| failure("The plugin directory was removed. Refresh the catalog."))?;
            if inspect_folder(&root, &root.join(&id), &id).1 != Some((expected_path, expected_manifest)) {
                return Err(failure("The plugin changed during runtime detection. Refresh the catalog before enabling it."));
            }
            Ok(())
        }).await.map_err(|_| failure("Plugin revalidation failed. Refresh the local catalog."))??;
        state.connect_manifest(node.path.expect("detected runtime"), path_string(&entrypoint)?, expected).await
    }
    /// Metadata and Node --version only: never describes or reads a plugin.
    pub async fn diagnostics(&self, plugin_id: &str) -> Result<PluginDiagnostics, PluginError> {
        if !identifier(plugin_id) { return Err(failure("Choose a valid plugin ID from the local catalog.")); }
        let install = self.clone(); let id = plugin_id.to_owned();
        let mut checks = tokio::task::spawn_blocking(move || {
            let mut checks = Vec::new();
            let root = install.root();
            checks.push(DiagnosticCheck { name: "catalog", status: if matches!(&root, Ok(Some(_))) { "pass" } else { "fail" }, message: "The plugin catalog must be a readable real directory, not a symlink." });
            let folder = root.ok().flatten().and_then(|root| validated_folder(&root, &id).ok());
            checks.push(DiagnosticCheck { name: "folder", status: if folder.is_some() { "pass" } else { "fail" }, message: "The selected folder must be a real directory directly inside the catalog." });
            if let Some(folder) = folder {
                let root = folder.parent().expect("validated parent");
                let (row, _) = inspect_folder(root, &folder, &id);
                let manifest_ok = row.protocol_version == 1;
                checks.push(DiagnosticCheck { name: "manifest", status: if manifest_ok { "pass" } else { "fail" }, message: if manifest_ok { "Manifest ID, schema and protocol version 1 are valid." } else { "A bounded valid manifest matching the folder ID and protocol version 1 is required." } });
                let main = folder.join("main.js");
                let main_ok = fs::symlink_metadata(&main).is_ok_and(|m| m.is_file() && !m.file_type().is_symlink()) && fs::File::open(&main).is_ok();
                checks.push(DiagnosticCheck { name: "entrypoint", status: if main_ok { "pass" } else { "fail" }, message: "The fixed main.js entrypoint must be a readable regular file, not a symlink." });
                let sdk = check_bundled_sdk(&folder);
                checks.push(DiagnosticCheck { name: "sdk", status: if sdk.is_ok() { "pass" } else { "fail" }, message: sdk.err().unwrap_or("Declared public SDK files are valid; no plugin code or other dependencies were evaluated.") });
            } else {
                for name in ["manifest", "entrypoint", "sdk"] {
                    checks.push(DiagnosticCheck { name, status: "warning", message: "Not checked because the selected folder is missing or unsafe." });
                }
            }
            checks
        }).await.map_err(|_| failure("Plugin diagnostics failed. Refresh the catalog explicitly."))?;
        let runtime = detect_node(&self.candidates).await;
        checks.push(DiagnosticCheck { name: "runtime", status: if runtime.status == NodeStatus::Detected { "pass" } else { "fail" }, message: match runtime.status {
            NodeStatus::Detected => "A supported Node.js runtime was detected using version probes only.",
            NodeStatus::Unsupported => "Node.js is too old; install Node.js 22.18.0 or newer and refresh.",
            NodeStatus::NotFound => "No supported Node.js executable was found; install Node.js 22.18.0 or newer and refresh.",
        } });
        Ok(PluginDiagnostics { plugin_id: plugin_id.to_owned(), checks })
    }
    /// Stop one session and move its exact folder to a reversible, exclusive backup.
    pub async fn uninstall(&self, registry: &PluginRegistry, plugin_id: &str) -> Result<(), PluginError> {
        if !identifier(plugin_id) { return Err(failure("Choose a valid plugin ID from the local catalog.")); }
        let install = self.clone(); let id = plugin_id.to_owned();
        registry.manage(plugin_id, true, true, move |state| async move {
            // Validate before stopping anything, but do not require a ready manifest/SDK.
            let root = install.root()?.ok_or_else(|| failure("The plugin catalog is unavailable."))?;
            validated_folder(&root, &id)?;
            state.disconnect().await;
            tokio::task::spawn_blocking(move || install.backup(&id)).await
                .map_err(|_| failure("Plugin backup failed. No permanent deletion was requested."))?
        }).await
    }
    fn backup(&self, id: &str) -> Result<(), PluginError> {
        let root = self.root()?.ok_or_else(|| failure("The plugin catalog is unavailable."))?;
        let source = validated_folder(&root, id)?;
        let parent = root.parent().ok_or_else(|| failure("The plugin catalog has no backup parent."))?;
        let backups = parent.join("plugin-backups");
        match fs::create_dir(&backups) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(_) => return Err(failure("The plugin backup directory could not be created. Check local permissions.")),
        }
        let meta = fs::symlink_metadata(&backups).map_err(|_| failure("The plugin backup directory is unreadable."))?;
        if !meta.is_dir() || meta.file_type().is_symlink() || fs::canonicalize(&backups).ok().as_deref() != Some(backups.as_path()) {
            return Err(failure("The plugin backup directory must be a real local directory, not a symlink."));
        }
        let mut nonce = [0u8; 16];
        getrandom::fill(&mut nonce).map_err(|_| failure("A unique plugin backup could not be generated. Nothing was deleted."))?;
        let destination = backups.join(format!("{id}-{:032x}", u128::from_le_bytes(nonce)));
        // Unix can replace an empty directory: reserve it exclusively first.
        // Windows directory rename already refuses an existing destination.
        #[cfg(not(target_os = "windows"))]
        fs::create_dir(&destination).map_err(|_| failure("A unique plugin backup could not be reserved. Nothing was deleted."))?;
        validated_folder(&root, id)?;
        fs::rename(source, destination).map_err(|_| failure("Plugin backup failed. The selected plugin is stopped; its folder was not permanently deleted."))
    }
    /// Creates only the app plugin folder. Preparing this command never opens it.
    pub fn prepare_open(&self) -> Result<Command, PluginError> {
        if self.root()?.is_none() {
            fs::create_dir_all(&self.directory).map_err(|_| failure("The plugin directory could not be created. Check parent directory permissions."))?;
        }
        let root = self.root()?.ok_or_else(|| failure("The plugin directory is unavailable."))?;
        #[cfg(target_os = "macos")]
        let program = "/usr/bin/open";
        #[cfg(target_os = "windows")]
        let program = "explorer.exe";
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let program = "/usr/bin/xdg-open";
        let mut command = Command::new(program);
        command.arg(root).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
        Ok(command)
    }
    pub async fn open_directory(&self) -> Result<(), PluginError> {
        let mut child = self.prepare_open()?.spawn().map_err(|_| failure("The system folder opener is unavailable. Open the catalog directory manually."))?;
        match timeout(Duration::from_secs(2), child.wait()).await {
            Ok(Ok(status)) if status.success() => Ok(()),
            _ => {
                let _ = child.start_kill(); let _ = child.wait().await;
                Err(failure("The folder opener failed or timed out. Open the catalog directory manually."))
            }
        }
    }
}

fn validated_folder(root: &Path, id: &str) -> Result<PathBuf, PluginError> {
    if !identifier(id) { return Err(failure("Choose a valid plugin ID from the local catalog.")); }
    let folder = root.join(id);
    path_string(&folder)?;
    let meta = fs::symlink_metadata(&folder).map_err(|_| failure("The selected plugin folder is unavailable."))?;
    if !meta.is_dir() || meta.file_type().is_symlink() { return Err(failure("The selected plugin folder must be a real directory, not a symlink.")); }
    let canonical = fs::canonicalize(&folder).map_err(|_| failure("The selected plugin folder is unreadable."))?;
    if canonical.parent() != Some(root) { return Err(failure("The selected plugin must stay directly inside the catalog.")); }
    Ok(canonical)
}

fn inspect_folder(root: &Path, folder: &Path, id: &str) -> (InstalledPlugin, Option<(PathBuf, Manifest)>) {
    let mut row = InstalledPlugin { id: id.to_owned(), name: if id.is_empty() { "Invalid plugin folder".into() } else { id.into() },
        version: String::new(), protocol_version: 0, status: InstallStatus::Invalid, message: None };
    let checked = (|| -> Result<(PathBuf, Manifest), &'static str> {
        if id.is_empty() { return Err("Folder names must be lowercase plugin identifiers (1–64 characters)."); }
        // Reject symlinks even within the root: no duplicate aliases or escapes.
        let meta = fs::symlink_metadata(folder).map_err(|_| "The plugin folder is unreadable.")?;
        if meta.file_type().is_symlink() || !meta.is_dir() { return Err("Plugin folders must be real directories, not symlinks."); }
        let canonical = fs::canonicalize(folder).map_err(|_| "The plugin folder is unreadable.")?;
        if canonical.parent() != Some(root) { return Err("Plugin folders must stay directly inside the plugin directory."); }
        let manifest_path = canonical.join("manifest.json");
        let meta = fs::symlink_metadata(&manifest_path).map_err(|_| "Both a readable manifest.json and a regular main.js file are required.")?;
        if meta.file_type().is_symlink() || !meta.is_file() { return Err("manifest.json and main.js must be regular files, not symlinks."); }
        let manifest_path = fs::canonicalize(&manifest_path).map_err(|_| "Plugin files are unreadable.")?;
        if manifest_path.parent() != Some(canonical.as_path()) { return Err("Plugin files must stay inside their plugin folder."); }
        if meta.len() > MANIFEST_BYTES { return Err("manifest.json exceeds the 16384-byte limit."); }
        let mut bytes = Vec::new();
        fs::File::open(&manifest_path).map_err(|_| "manifest.json cannot be read.")?.take(MANIFEST_BYTES + 1)
            .read_to_end(&mut bytes).map_err(|_| "manifest.json cannot be read.")?;
        if bytes.len() as u64 > MANIFEST_BYTES { return Err("manifest.json exceeds the 16384-byte limit."); }
        let mut value: Value = serde_json::from_slice(&bytes).map_err(|_| "manifest.json is not valid JSON.")?;
        let protocol = value.get("protocolVersion").and_then(Value::as_f64).filter(|n| n.fract() == 0.0 && *n > 0.0 && *n <= u8::MAX as f64)
            .ok_or("The manifest does not match the plugin contract.")? as u8;
        // Validate the complete schema before classifying an otherwise valid future protocol.
        value["protocolVersion"] = Value::from(1);
        let m = manifest(value).map_err(|_| "The manifest does not match the plugin contract.")?;
        if m.id != id { return Err("The folder name must equal manifest.id; aliases and duplicate IDs are not supported."); }
        row.version = m.version.clone(); row.protocol_version = protocol;
        if protocol != 1 {
            row.status = InstallStatus::Incompatible;
            return Err("This plugin protocol version is not supported; protocol version 1 is required.");
        }
        let entrypoint = canonical.join("main.js");
        let meta = fs::symlink_metadata(&entrypoint).map_err(|_| "Both a readable manifest.json and a regular main.js file are required.")?;
        if meta.file_type().is_symlink() || !meta.is_file() { return Err("manifest.json and main.js must be regular files, not symlinks."); }
        let entrypoint = fs::canonicalize(&entrypoint).map_err(|_| "Plugin files are unreadable.")?;
        if entrypoint.parent() != Some(canonical.as_path()) { return Err("Plugin files must stay inside their plugin folder."); }
        fs::File::open(&entrypoint).map_err(|_| "main.js cannot be read.")?;
        check_bundled_sdk(&canonical)?;
        Ok((entrypoint, m))
    })();
    match checked {
        Ok(ready) => { row.status = InstallStatus::Ready; (row, Some(ready)) }
        Err(message) => { row.message = Some(message); (row, None) }
    }
}

fn package_metadata(path: &Path) -> Result<Value, &'static str> {
    let bad = "Plugin package.json must be readable bounded JSON in a regular file, not a symlink.";
    let meta = fs::symlink_metadata(path).map_err(|_| bad)?;
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > MANIFEST_BYTES { return Err(bad); }
    let mut bytes = Vec::new();
    fs::File::open(path).map_err(|_| bad)?.take(MANIFEST_BYTES + 1).read_to_end(&mut bytes).map_err(|_| bad)?;
    if bytes.len() as u64 > MANIFEST_BYTES { return Err(bad); }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| bad)?;
    if !value.is_object() { return Err(bad); }
    Ok(value)
}
fn check_bundled_sdk(folder: &Path) -> Result<(), &'static str> {
    let package = folder.join("package.json");
    match fs::symlink_metadata(&package) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("Plugin package.json is unreadable."),
        _ => (),
    }
    let metadata = package_metadata(&package)?;
    let Some(dependencies) = metadata.get("dependencies") else { return Ok(()); };
    let dependencies = dependencies.as_object().ok_or("Plugin dependencies must be an object in package.json.")?;
    let Some(requirement) = dependencies.get(SDK) else { return Ok(()); };
    if !requirement.is_string() { return Err("Plugin SDK dependency must be declared in package.json."); }
    // shortcut: preflight only the declared public SDK, extend for other runtime
    // dependencies when supported; do not parse JS or execute package resolution.
    let mut current = folder.to_path_buf();
    for part in ["node_modules", "@zdeck", "plugin-sdk"] {
        current.push(part);
        let meta = fs::symlink_metadata(&current).map_err(|_| SDK_MISSING)?;
        if meta.file_type().is_symlink() { return Err(SDK_LINK); }
        if !meta.is_dir() { return Err(SDK_INVALID); }
    }
    for name in ["package.json", "index.js"] {
        let path = current.join(name);
        let meta = fs::symlink_metadata(&path).map_err(|_| SDK_MISSING)?;
        if meta.file_type().is_symlink() || !meta.is_file() || meta.len() == 0 { return Err(SDK_INVALID); }
        fs::File::open(&path).map_err(|_| SDK_INVALID)?;
    }
    let sdk = package_metadata(&current.join("package.json")).map_err(|_| SDK_INVALID)?;
    if sdk["name"] != SDK || sdk["type"] != "module" || sdk.pointer("/exports/./import").and_then(Value::as_str) != Some("./index.js") {
        return Err(SDK_INVALID);
    }
    Ok(())
}

/// Ordered PATH candidates, then explicit GUI-friendly locations, then bounded nvm versions.
/// Relative PATH entries are deliberately ignored (never execute from an incidental cwd).
pub fn runtime_candidates(home: &Path, path: Option<&std::ffi::OsStr>) -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    let executable = "node.exe";
    #[cfg(not(target_os = "windows"))]
    let executable = "node";
    let mut candidates: Vec<_> = path.map(|p| std::env::split_paths(p).take(16).filter(|p| p.is_absolute()).map(|p| p.join(executable)).collect()).unwrap_or_default();
    #[cfg(not(target_os = "windows"))]
    candidates.extend(["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"].map(PathBuf::from));
    candidates.push(home.join(".volta/bin").join(executable));
    candidates.push(home.join(".local/share/mise/shims").join(executable));
    if let Ok(entries) = fs::read_dir(home.join(".nvm/versions/node")) {
        let mut versions: Vec<_> = entries.take(8).filter_map(Result::ok).filter_map(|entry| {
            let version = node_version(entry.file_name().to_str()?)?;
            Some((version, entry.path().join("bin").join(executable)))
        }).collect();
        versions.sort_by(|a, b| b.0.cmp(&a.0));
        candidates.extend(versions.into_iter().map(|(_, path)| path));
    }
    candidates.truncate(MAX_RUNTIMES);
    candidates
}
fn node_version(text: &str) -> Option<(u32, u32, u32)> {
    let parts: Vec<_> = text.strip_prefix('v').unwrap_or(text).split('.').collect();
    if parts.len() != 3 || parts.iter().any(|p| p.is_empty() || p.len() > 4 || !p.bytes().all(|b| b.is_ascii_digit())) { return None; }
    Some((parts[0].parse().ok()?, parts[1].parse().ok()?, parts[2].parse().ok()?))
}
async fn probe(path: &Path, budget: Duration) -> Option<String> {
    let mut child = Command::new(path).arg("--version").env_remove("NODE_OPTIONS").env_remove("NODE_PATH")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true).spawn().ok()?;
    let mut stdout = child.stdout.take()?.take(PROBE_BYTES + 1);
    let result = timeout(budget, async {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).await.ok()?;
        if bytes.len() as u64 > PROBE_BYTES || !child.wait().await.ok()?.success() { return None; }
        let text = std::str::from_utf8(&bytes).ok()?.trim();
        let version = node_version(text)?;
        Some(format!("{}.{}.{}", version.0, version.1, version.2))
    }).await.ok().flatten();
    // Reap failed, oversized and timed-out probes too; stderr is never retained.
    let _ = child.start_kill(); let _ = child.wait().await;
    result
}
pub async fn detect_node(candidates: &[PathBuf]) -> NodeRuntime {
    let mut result = NodeRuntime { status: NodeStatus::NotFound, version: None, path: None };
    let mut seen = HashSet::new();
    let deadline = Instant::now() + Duration::from_secs(3);
    for path in candidates.iter().take(MAX_RUNTIMES) {
        if !path.is_absolute() { continue; }
        let Ok(canonical) = fs::canonicalize(path) else { continue; };
        if !seen.insert(canonical) { continue; }
        let Ok(display) = path_string(path) else { continue; };
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else { break; };
        if let Some(version) = probe(path, remaining.min(Duration::from_millis(500))).await {
            let supported = node_version(&version).expect("validated runtime version") >= (22, 18, 0);
            let candidate = NodeRuntime { status: if supported { NodeStatus::Detected } else { NodeStatus::Unsupported }, version: Some(version), path: Some(display) };
            if supported { return candidate; }
            if result.status == NodeStatus::NotFound { result = candidate; }
        }
    }
    result
}
