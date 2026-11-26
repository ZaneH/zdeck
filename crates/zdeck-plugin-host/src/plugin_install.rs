//! Local discovery, trust and fingerprint-bound enabled preferences.
//! Runtime probes execute --version, never a shell or a plugin entrypoint.
use std::{collections::{BTreeMap, HashSet}, fs, io::{Read, Write}, path::{Path, PathBuf}, process::Stdio, sync::Arc, time::Duration};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::{io::AsyncReadExt, process::Command, time::{timeout, Instant}};
use crate::plugin::{identifier, manifest, ErrorKind, LaunchFailure, Manifest, Outcome, PluginError, PluginSnapshot, PluginRegistry, SettingsField};

#[path = "plugin_archive.rs"]
mod archive;
pub use archive::{ArchiveReview, PreparedArchive};

const MAX_RUNTIMES: usize = 32;
/// Combined settings budget, measured as Windows credential UTF-16 bytes. A single
/// credential blob stays within the 2560-byte Windows limit and is written atomically.
pub const MAX_SETTINGS_BYTES: usize = 2400;
pub const MAX_SETTING_VALUE_BYTES: usize = 2048;
// Separate installers share one settings file; serialize lifecycle intent and read-modify-write.
static PREFERENCES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const TRUST_FILE: &str = "plugin-trust.v1.json";
const TRUST_BYTES: u64 = 65_536;
const MAX_TRUSTED: usize = 4096;
/// Bounds on the package fingerprint walk; larger packages cannot be trusted safely.
const MAX_FINGERPRINT_FILES: usize = 4096;
const MAX_FINGERPRINT_ENTRIES: usize = 32_768;
const MAX_FINGERPRINT_DEPTH: usize = 24;
const MAX_FINGERPRINT_BYTES: u64 = 64 * 1024 * 1024;
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
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginRuntime { Node, Python }
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
    /// Optional embedded plugin-identity thumbnail data URL.
    pub icon: Option<String>,
    pub runtime: PluginRuntime,
    /// True only when the current package fingerprint matches a persisted trust record.
    pub trusted: bool,
    /// Opaque validated package identity for ready plugins; null when not ready.
    /// Confirming trust must echo the identity from the reviewed catalog, never re-derive it
    /// from whatever happens to be on disk when the user clicks the button.
    pub identity: Option<String>,
    /// Declared settings metadata only; omitted when the manifest declares none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings: Option<BTreeMap<String, SettingsField>>,
}
#[derive(Debug, Serialize)]
pub struct PluginCatalog {
    pub directory: String,
    pub node: NodeRuntime,
    pub python: NodeRuntime,
    pub plugins: Vec<InstalledPlugin>,
}

/// A validated ready plugin with its disk fingerprint.
struct Ready { entrypoint: PathBuf, manifest: Manifest, fingerprint: String, runtime: PluginRuntime }

fn failure(hint: &'static str) -> PluginError {
    let mut error = PluginError::new(ErrorKind::InvalidLaunch, Outcome::NotStarted);
    error.hint = hint;
    error
}
fn settings_required() -> PluginError {
    let mut error = PluginError::new(ErrorKind::Unavailable, Outcome::NotStarted);
    error.code = Some("settings_required");
    error.message = "This plugin needs its settings configured before it can be enabled.";
    error.hint = "Open the plugin's settings on the desktop, save the declared values, then enable it again.";
    error
}
/// JSON text budget in Windows credential UTF-16 bytes; the same limit guards IPC and storage.
pub fn settings_within_limit(settings: &BTreeMap<String, String>) -> bool {
    serde_json::to_string(settings).is_ok_and(|record| record.encode_utf16().count() * 2 <= MAX_SETTINGS_BYTES)
}
fn checked_settings(declared: &BTreeMap<String, SettingsField>, values: BTreeMap<String, String>) -> Result<BTreeMap<String, String>, PluginError> {
    let complete = values.len() == declared.len() && values.iter().all(|(key, value)| {
        declared.contains_key(key) && value.len() <= MAX_SETTING_VALUE_BYTES
    });
    let secret_missing = declared.iter().any(|(key, field)| matches!(field, SettingsField::Secret { .. })
        && values.get(key).is_none_or(String::is_empty));
    if !complete || secret_missing || !settings_within_limit(&values) { return Err(settings_required()); }
    Ok(values)
}
fn trust_error() -> PluginError {
    let mut error = PluginError::new(ErrorKind::Unavailable, Outcome::NotStarted);
    error.code = Some("not_trusted");
    error.hint = "Confirm trust for this exact installed package, then enable it. If its files changed, review them again before enabling.";
    error
}
fn stale_identity_error() -> PluginError {
    let mut error = PluginError::new(ErrorKind::Unavailable, Outcome::NotStarted);
    error.code = Some("stale_identity");
    error.hint = "This plugin changed on disk after the confirmation was opened. Refresh the catalog, review the current files, and confirm trust again.";
    error
}
fn valid_identity(identity: &str) -> bool {
    identity.len() == 64 && identity.bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn path_string(path: &Path) -> Result<String, PluginError> {
    path.to_str().filter(|s| s.len() <= 4096 && !s.chars().any(char::is_control))
        .map(str::to_owned).ok_or_else(|| failure("Use a local plugin directory with a bounded Unicode path and no control characters."))
}

/// Paths/candidates are trusted desktop configuration, never deserialized from IPC.
pub type SettingsLoader = Arc<dyn Fn(&str, &Manifest) -> Result<BTreeMap<String, String>, PluginError> + Send + Sync>;

#[derive(Clone)]
pub struct PluginInstall {
    directory: PathBuf, candidates: Vec<PathBuf>, python_candidates: Vec<PathBuf>,
    settings: Option<SettingsLoader>,
}
impl PluginInstall {
    /// Also permits isolated tests to inject temporary roots and fake runtimes.
    pub fn new(directory: PathBuf, candidates: Vec<PathBuf>) -> Result<Self, PluginError> {
        if !directory.is_absolute() || candidates.len() > MAX_RUNTIMES || candidates.iter().any(|p| !p.is_absolute()) {
            return Err(failure("Use absolute local plugin and runtime paths."));
        }
        path_string(&directory)?;
        Ok(Self { directory, candidates, python_candidates: vec![], settings: None })
    }
    /// Optional native credential loader. It runs only after exact package trust validation
    /// and before launch, and only for manifests that declare settings.
    pub fn with_settings_loader(mut self, loader: SettingsLoader) -> Self {
        self.settings = Some(loader);
        self
    }
    pub fn with_python_candidates(mut self, candidates: Vec<PathBuf>) -> Result<Self, PluginError> {
        if candidates.len() > MAX_RUNTIMES || candidates.iter().any(|p| !p.is_absolute()) {
            return Err(failure("Use absolute local runtime paths."));
        }
        self.python_candidates = candidates;
        Ok(self)
    }
    /// The home comes from Tauri's path resolver, not HOME or a caller-supplied path.
    pub fn for_home(home: PathBuf) -> Result<Self, PluginError> {
        #[cfg(target_os = "linux")]
        let config = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| home.join(".config"));
        #[cfg(not(target_os = "linux"))]
        let config = home.join(".config");
        let candidates = runtime_candidates(&home, std::env::var_os("PATH").as_deref());
        Self::new(config.join("zdeck/plugins"), candidates)?.with_python_candidates(python_runtime_candidates(&home, std::env::var_os("PATH").as_deref()))
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
    fn discover(&self) -> Result<Vec<InstalledPlugin>, PluginError> {
        let Some(root) = self.root()? else { return Ok(vec![]); };
        let trust = self.load_trust();
        let entries = fs::read_dir(&root).map_err(|_| failure("The plugin directory cannot be read. Check its local permissions."))?;
        let mut plugins = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|_| failure("A plugin directory entry cannot be read. Check its local permissions."))?;
            let kind = entry.file_type().map_err(|_| failure("A plugin directory entry cannot be read. Check its local permissions."))?;
            if !kind.is_dir() && !kind.is_symlink() { continue; }
            let id = entry.file_name().to_str().filter(|s| identifier(s)).unwrap_or("").to_owned();
            let (mut row, ready) = inspect_folder(&root, &entry.path(), &id);
            if let Some(ready) = ready {
                row.trusted = trust.get(&id) == Some(&ready.fingerprint);
                row.identity = Some(ready.fingerprint);
            }
            plugins.push(row);
        }
        plugins.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(plugins)
    }
    pub async fn catalog(&self) -> Result<PluginCatalog, PluginError> {
        let _guard = PREFERENCES.lock().await;
        let install = self.clone();
        let plugins = tokio::task::spawn_blocking(move || install.discover()).await
            .map_err(|_| failure("Plugin discovery failed. Check the local directory and retry explicitly."))??;
        let (node, python) = tokio::join!(detect_node(&self.candidates), detect_python(&self.python_candidates));
        Ok(PluginCatalog { directory: path_string(&self.directory)?, node, python, plugins })
    }
    /// Persist trust for the reviewed package identity. The caller must pass the identity from
    /// the catalog the user actually reviewed; a fresh fingerprint that differs is refused rather
    /// than silently authorizing a changed package. Bounded and symlink-safe.
    pub async fn trust(&self, plugin_id: &str, expected_identity: &str) -> Result<(), PluginError> {
        if !identifier(plugin_id) { return Err(failure("Choose a valid plugin ID from the local catalog.")); }
        let _guard = PREFERENCES.lock().await;
        let expected = expected_identity.to_owned();
        if !valid_identity(&expected) { return Err(stale_identity_error()); }
        let install = self.clone(); let id = plugin_id.to_owned();
        tokio::task::spawn_blocking(move || {
            let root = install.root()?.ok_or_else(|| failure("The plugin directory was removed. Refresh the catalog."))?;
            let folder = validated_folder(&root, &id)?;
            let (row, ready) = inspect_folder(&root, &folder, &id);
            let ready = ready.ok_or_else(|| failure(row.message.unwrap_or("The selected plugin is not ready in the local catalog.")))?;
            // The reviewed identity must still match the fresh one before trust is written.
            if ready.fingerprint != expected { return Err(stale_identity_error()); }
            let mut trust = install.load_trust();
            if !trust.contains_key(&id) && trust.len() >= MAX_TRUSTED {
                return Err(failure("Too many plugins are trusted. Remove a trusted plugin before adding another."));
            }
            trust.insert(id.clone(), ready.fingerprint);
            install.write_trust(&trust)
        }).await.map_err(|_| failure("Plugin trust could not be saved. Check local permissions."))?
    }
    fn trust_path(&self) -> Option<PathBuf> { self.directory.parent().map(|parent| parent.join(TRUST_FILE)) }
    /// Corrupt, oversized or unreadable trust data is treated as no trust; launch is never blocked.
    fn load_trust(&self) -> BTreeMap<String, String> { self.load_records("plugins") }
    fn load_records(&self, field: &str) -> BTreeMap<String, String> {
        let Some(path) = self.trust_path() else { return BTreeMap::new(); };
        let Ok(meta) = fs::symlink_metadata(&path) else { return BTreeMap::new(); };
        if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > TRUST_BYTES { return BTreeMap::new(); }
        let Ok(file) = fs::File::open(&path) else { return BTreeMap::new(); };
        let mut bytes = Vec::new();
        if file.take(TRUST_BYTES + 1).read_to_end(&mut bytes).is_err() || bytes.len() as u64 > TRUST_BYTES { return BTreeMap::new(); }
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else { return BTreeMap::new(); };
        let Some(plugins) = value.get(field).and_then(Value::as_object) else { return BTreeMap::new(); };
        plugins.iter().filter(|(id, fingerprint)| identifier(id) && fingerprint.as_str().is_some_and(|fp| fp.len() == 64 && fp.bytes().all(|b| b.is_ascii_hexdigit())))
            .take(MAX_TRUSTED).filter_map(|(id, fingerprint)| fingerprint.as_str().map(|fp| (id.clone(), fp.to_ascii_lowercase()))).collect()
    }
    fn write_trust(&self, plugins: &BTreeMap<String, String>) -> Result<(), PluginError> {
        self.write_preferences(plugins, &self.load_records("enabled"))
    }
    fn write_preferences(&self, plugins: &BTreeMap<String, String>, enabled: &BTreeMap<String, String>) -> Result<(), PluginError> {
        let path = self.trust_path().ok_or_else(|| failure("The plugin trust file has no parent directory."))?;
        let bytes = serde_json::to_vec(&serde_json::json!({ "version": 1, "plugins": plugins, "enabled": enabled }))
            .map_err(|_| failure("The plugin trust file could not be encoded."))?;
        if bytes.len() as u64 > TRUST_BYTES { return Err(failure("The plugin trust file is too large to save safely.")); }
        let parent = path.parent().ok_or_else(|| failure("The plugin trust file has no parent directory."))?;
        fs::create_dir_all(parent).map_err(|_| failure("The plugin configuration directory could not be created. Check local permissions."))?;
        let mut nonce = [0u8; 8];
        getrandom::fill(&mut nonce).map_err(|_| failure("A unique trust file could not be created."))?;
        let temp = parent.join(format!(".{TRUST_FILE}.{:016x}.tmp", u64::from_le_bytes(nonce)));
        let write = (|| -> std::io::Result<()> {
            let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
            file.write_all(&bytes)?; file.flush()?; file.sync_all()?; drop(file);
            fs::rename(&temp, &path)
        })();
        if write.is_err() { let _ = fs::remove_file(&temp); }
        write.map_err(|_| failure("The plugin trust file could not be written. Check local permissions."))
    }
    pub async fn enable(&self, registry: &PluginRegistry, plugin_id: &str) -> Result<PluginSnapshot, PluginError> {
        if !identifier(plugin_id) { return Err(failure("Choose a valid plugin ID from the local catalog.")); }
        let install = self.clone(); let id = plugin_id.to_owned();
        let _guard = PREFERENCES.lock().await;
        registry.manage(plugin_id, true, false, move |state| async move { install.enable_session(&state, &id, None).await }).await
    }
    /// One startup pass; saved intent must match both current trust and current package bytes.
    pub async fn restore(&self, registry: &PluginRegistry) -> Result<(), PluginError> {
        let _guard = PREFERENCES.lock().await;
        let enabled = self.load_records("enabled");
        if enabled.len() > crate::plugin::MAX_RUNNING_PLUGINS {
            return Err(failure("Too many plugins are saved as enabled. Use Disable on next launch in the row menus to keep at most 16, then enable the intended plugins."));
        }
        let mut first_error = None;
        for (id, fingerprint) in enabled {
            let install = self.clone(); let selected = id.clone();
            if let Err(error) = registry.manage(&id, true, false, move |state| async move {
                install.enable_session(&state, &selected, Some(fingerprint)).await
            }).await { first_error.get_or_insert(error); }
        }
        first_error.map_or(Ok(()), Err)
    }
    pub async fn disable(&self, registry: &PluginRegistry, plugin_id: &str) -> Result<PluginSnapshot, PluginError> {
        if !identifier(plugin_id) { return Err(failure("Choose a valid plugin ID from the local catalog.")); }
        let _guard = PREFERENCES.lock().await;
        let saved = self.save_enabled(plugin_id, None);
        let stopped = registry.disconnect(plugin_id).await;
        saved.map_err(|_| failure("The plugin was stopped, but disabling it could not be saved. It may start again after relaunch. Check local settings permissions and retry Disable before quitting."))?;
        stopped
    }
    fn save_enabled(&self, id: &str, fingerprint: Option<String>) -> Result<(), PluginError> {
        let mut enabled = self.load_records("enabled");
        match fingerprint { Some(fp) => { enabled.insert(id.to_owned(), fp); }, None => { enabled.remove(id); } }
        self.write_preferences(&self.load_trust(), &enabled)
    }
    async fn enable_session(&self, state: &crate::plugin::PluginState, plugin_id: &str, restore_identity: Option<String>) -> Result<PluginSnapshot, PluginError> {
        let restoring = restore_identity.is_some();
        let install = self.clone();
        let id = plugin_id.to_owned();
        let (entrypoint, expected, fingerprint, runtime) = tokio::task::spawn_blocking(move || {
            let plugins = install.discover()?;
            let selected = plugins.iter().find(|p| p.id == id).ok_or_else(|| failure("The selected plugin is not in the local catalog. Refresh and select it explicitly."))?;
            if selected.status != InstallStatus::Ready {
                return Err(if selected.message == Some(SDK_MISSING) {
                    PluginError::launch(LaunchFailure::MissingDependency)
                } else { failure(selected.message.unwrap_or("The selected plugin is not ready in the local catalog.")) });
            }
            let root = install.root()?.ok_or_else(|| failure("The plugin directory was removed. Refresh the catalog."))?;
            let ready = inspect_folder(&root, &root.join(&id), &id).1.ok_or_else(|| failure("The plugin changed or is invalid. Refresh the catalog before enabling it."))?;
            // Trust is bound to the exact current package fingerprint, never a UI flag.
            if install.load_trust().get(&id) != Some(&ready.fingerprint)
                || restore_identity.as_ref().is_some_and(|fp| fp != &ready.fingerprint) { return Err(trust_error()); }
            Ok::<_, PluginError>((ready.entrypoint, ready.manifest, ready.fingerprint, ready.runtime))
        }).await.map_err(|_| failure("Plugin discovery failed. Refresh the local catalog."))??;
        let detected = match runtime {
            PluginRuntime::Node => detect_node(&self.candidates).await,
            PluginRuntime::Python => detect_python(&self.python_candidates).await,
        };
        if detected.status != NodeStatus::Detected {
            let mut error = PluginError::launch(if detected.status == NodeStatus::Unsupported {
                LaunchFailure::RuntimeIncompatible
            } else { LaunchFailure::RuntimeMissing });
            if runtime == PluginRuntime::Python {
                error.hint = "Install Python 3.10 or newer, then refresh the catalog and enable explicitly.";
            }
            return Err(error);
        }
        // Runtime probes can take time: recheck paths and the full disk contract before launch.
        let install = self.clone();
        let id = plugin_id.to_owned();
        let expected_path = entrypoint.clone();
        let expected_manifest = expected.clone();
        let expected_fingerprint = fingerprint.clone();
        tokio::task::spawn_blocking(move || {
            let root = install.root()?.ok_or_else(|| failure("The plugin directory was removed. Refresh the catalog."))?;
            match inspect_folder(&root, &root.join(&id), &id).1 {
                Some(ready) if ready.entrypoint == expected_path && ready.manifest == expected_manifest && ready.fingerprint == expected_fingerprint => Ok(()),
                _ => Err(failure("The plugin changed during runtime detection. Refresh the catalog before enabling it.")),
            }
        }).await.map_err(|_| failure("Plugin revalidation failed. Refresh the local catalog."))??;
        // Settings come from the OS credential store only after the exact package is trusted,
        // and are delivered to the plugin solely through its stdin configure request.
        let settings = match &expected.settings {
            None => None,
            // An empty declaration needs no fields, but the protocol still expects one configure request.
            Some(declared) if declared.is_empty() => Some(BTreeMap::new()),
            Some(declared) => {
                let loader = self.settings.clone().ok_or_else(settings_required)?;
                let manifest = expected.clone();
                let id = plugin_id.to_owned();
                let values = tokio::task::spawn_blocking(move || loader(&id, &manifest)).await
                    .map_err(|_| settings_required())??;
                Some(checked_settings(declared, values)?)
            }
        };
        // Persist the validated identity, never a fresh fingerprint of changed files.
        if !restoring { self.save_enabled(plugin_id, Some(fingerprint))?; }
        state.connect_manifest_settings(detected.path.expect("detected runtime"), path_string(&entrypoint)?, expected, settings).await
    }
    /// Current trusted package metadata for IPC key validation; never launches the plugin.
    pub async fn trusted_manifest(&self, plugin_id: &str) -> Result<Manifest, PluginError> {
        if !identifier(plugin_id) { return Err(failure("Choose a valid plugin ID from the local catalog.")); }
        let install = self.clone();
        let id = plugin_id.to_owned();
        tokio::task::spawn_blocking(move || {
            let root = install.root()?.ok_or_else(|| failure("The plugin directory was removed. Refresh the catalog."))?;
            let folder = validated_folder(&root, &id)?;
            let (row, ready) = inspect_folder(&root, &folder, &id);
            let ready = ready.ok_or_else(|| failure(row.message.unwrap_or("The selected plugin is not ready in the local catalog.")))?;
            if install.load_trust().get(&id) != Some(&ready.fingerprint) { return Err(trust_error()); }
            Ok(ready.manifest)
        }).await.map_err(|_| failure("Plugin discovery failed. Refresh the local catalog."))?
    }
    /// Metadata and runtime --version only: never describes or reads a plugin.
    pub async fn diagnostics(&self, plugin_id: &str) -> Result<PluginDiagnostics, PluginError> {
        if !identifier(plugin_id) { return Err(failure("Choose a valid plugin ID from the local catalog.")); }
        let install = self.clone(); let id = plugin_id.to_owned();
        let (mut checks, kind) = tokio::task::spawn_blocking(move || {
            let mut checks = Vec::new();
            let mut kind = PluginRuntime::Node;
            let root = install.root();
            checks.push(DiagnosticCheck { name: "catalog", status: if matches!(&root, Ok(Some(_))) { "pass" } else { "fail" }, message: "The plugin catalog must be a readable real directory, not a symlink." });
            let folder = root.ok().flatten().and_then(|root| validated_folder(&root, &id).ok());
            checks.push(DiagnosticCheck { name: "folder", status: if folder.is_some() { "pass" } else { "fail" }, message: "The selected folder must be a real directory directly inside the catalog." });
            if let Some(folder) = folder {
                let root = folder.parent().expect("validated parent");
                let (row, _) = inspect_folder(root, &folder, &id);
                let manifest_ok = row.protocol_version == 1;
                checks.push(DiagnosticCheck { name: "manifest", status: if manifest_ok { "pass" } else { "fail" }, message: if manifest_ok { "Manifest ID, schema and protocol version 1 are valid." } else { "A bounded valid manifest matching the folder ID and protocol version 1 is required." } });
                kind = row.runtime;
                let main_ok = fixed_entrypoint(&folder).is_ok();
                checks.push(DiagnosticCheck { name: "entrypoint", status: if main_ok { "pass" } else { "fail" }, message: "Exactly one fixed main.js or main.py entrypoint must be a readable regular file, not a symlink." });
                let sdk = if kind == PluginRuntime::Python { check_python_sdk(&folder) } else { check_bundled_sdk(&folder) };
                checks.push(DiagnosticCheck { name: if kind == PluginRuntime::Python { "python sdk" } else { "sdk" }, status: if sdk.is_ok() { "pass" } else { "fail" }, message: sdk.err().unwrap_or("Declared public SDK files are valid; no plugin code or other dependencies were evaluated.") });
            } else {
                for name in ["manifest", "entrypoint", "sdk"] {
                    checks.push(DiagnosticCheck { name, status: "warning", message: "Not checked because the selected folder is missing or unsafe." });
                }
            }
            (checks, kind)
        }).await.map_err(|_| failure("Plugin diagnostics failed. Refresh the catalog explicitly."))?;
        let runtime = if kind == PluginRuntime::Python { detect_python(&self.python_candidates).await } else { detect_node(&self.candidates).await };
        checks.push(DiagnosticCheck { name: "runtime", status: if runtime.status == NodeStatus::Detected { "pass" } else { "fail" }, message: match (kind, runtime.status) {
            (PluginRuntime::Python, NodeStatus::Detected) => "A supported Python runtime was detected using version probes only.",
            (PluginRuntime::Python, _) => "Install Python 3.10 or newer and refresh. No supported Python executable was detected.",
            (_, NodeStatus::Detected) => "A supported Node.js runtime was detected using version probes only.",
            (_, NodeStatus::Unsupported) => "Node.js is too old; install Node.js 22.18.0 or newer and refresh.",
            (_, NodeStatus::NotFound) => "No supported Node.js executable was found; install Node.js 22.18.0 or newer and refresh.",
        } });
        Ok(PluginDiagnostics { plugin_id: plugin_id.to_owned(), checks })
    }
    /// Stop one session and move its exact folder to a reversible, exclusive backup.
    pub async fn uninstall(&self, registry: &PluginRegistry, plugin_id: &str) -> Result<(), PluginError> {
        let _guard = PREFERENCES.lock().await;
        if !identifier(plugin_id) { return Err(failure("Choose a valid plugin ID from the local catalog.")); }
        let install = self.clone(); let id = plugin_id.to_owned();
        registry.manage(plugin_id, true, true, move |state| async move {
            // Validate before stopping anything, but do not require a ready manifest/SDK.
            let root = install.root()?.ok_or_else(|| failure("The plugin catalog is unavailable."))?;
            validated_folder(&root, &id)?;
            let saved = install.save_enabled(&id, None);
            state.disconnect().await;
            saved?;
            let backup = install.clone(); let backup_id = id.clone();
            tokio::task::spawn_blocking(move || backup.backup(&backup_id)).await
                .map_err(|_| failure("Plugin backup failed. No permanent deletion was requested."))??;
            // Drop persisted trust for the removed package; a reinstall must be trusted again.
            let mut trust = install.load_trust();
            if trust.remove(&id).is_some() { install.write_trust(&trust)?; }
            Ok(())
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

fn fixed_entrypoint(folder: &Path) -> Result<PathBuf, &'static str> {
    let entries: Vec<_> = ["main.js", "main.py"].into_iter().map(|name| folder.join(name))
        .filter(|path| fs::symlink_metadata(path).is_ok()).collect();
    if entries.len() != 1 { return Err("Exactly one main.js or main.py entrypoint is required, alongside manifest.json."); }
    let path = &entries[0];
    let meta = fs::symlink_metadata(path).map_err(|_| "The plugin entrypoint is unreadable.")?;
    if meta.file_type().is_symlink() || !meta.is_file() { return Err("Plugin entrypoints must be regular files, not symlinks."); }
    fs::File::open(path).map_err(|_| "The plugin entrypoint is unreadable.")?;
    Ok(path.clone())
}
fn check_python_sdk(folder: &Path) -> Result<(), &'static str> {
    let sdk = folder.join("zdeck_plugin_sdk");
    let meta = fs::symlink_metadata(&sdk).map_err(|_| "Bundle the complete zdeck_plugin_sdk directory beside main.py.")?;
    if !meta.is_dir() || meta.file_type().is_symlink() { return Err("The bundled Python SDK must be a regular local directory, not a symlink."); }
    for name in ["__init__.py", "types.py"] {
        let path = sdk.join(name);
        let meta = fs::symlink_metadata(&path).map_err(|_| "The bundled Python SDK is incomplete; include __init__.py and types.py.")?;
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() == 0 { return Err("Python SDK files must be nonempty regular files, not symlinks."); }
        fs::File::open(path).map_err(|_| "The bundled Python SDK is unreadable.")?;
    }
    Ok(())
}

fn inspect_folder(root: &Path, folder: &Path, id: &str) -> (InstalledPlugin, Option<Ready>) {
    let mut row = InstalledPlugin { id: id.to_owned(), name: if id.is_empty() { "Invalid plugin folder".into() } else { id.into() },
        version: String::new(), protocol_version: 0, status: InstallStatus::Invalid, message: None, icon: None, runtime: PluginRuntime::Node, trusted: false, identity: None, settings: None };
    let checked = (|| -> Result<Ready, &'static str> {
        if id.is_empty() { return Err("Folder names must be lowercase plugin identifiers (1–64 characters)."); }
        // Reject symlinks even within the root: no duplicate aliases or escapes.
        let meta = fs::symlink_metadata(folder).map_err(|_| "The plugin folder is unreadable.")?;
        if meta.file_type().is_symlink() || !meta.is_dir() { return Err("Plugin folders must be real directories, not symlinks."); }
        let canonical = fs::canonicalize(folder).map_err(|_| "The plugin folder is unreadable.")?;
        if canonical.parent() != Some(root) { return Err("Plugin folders must stay directly inside the plugin directory."); }
        row.runtime = if fs::symlink_metadata(canonical.join("main.py")).is_ok() { PluginRuntime::Python } else { PluginRuntime::Node };
        let manifest_path = canonical.join("manifest.json");
        let meta = fs::symlink_metadata(&manifest_path).map_err(|_| "A readable manifest.json and one regular main.js or main.py file are required.")?;
        if meta.file_type().is_symlink() || !meta.is_file() { return Err("manifest.json must be a regular file, not a symlink."); }
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
        row.version = m.version.clone(); row.protocol_version = protocol; row.icon = m.icon.clone();
        row.settings = m.settings.clone();
        if protocol != 1 {
            row.status = InstallStatus::Incompatible;
            return Err("This plugin protocol version is not supported; protocol version 1 is required.");
        }
        let entrypoint = fixed_entrypoint(&canonical)?;
        if row.runtime == PluginRuntime::Python { check_python_sdk(&canonical)?; } else { check_bundled_sdk(&canonical)?; }
        let fingerprint = fingerprint_folder(&canonical)?;
        Ok(Ready { entrypoint, manifest: m, fingerprint, runtime: row.runtime })
    })();
    match checked {
        Ok(ready) => { row.status = InstallStatus::Ready; (row, Some(ready)) }
        Err(message) => { row.message = Some(message); (row, None) }
    }
}

/// Deterministic SHA-256 over every regular file in the package.
/// Bounded in file count, entry count, directory depth and actual bytes read; any symlink,
/// oversize package or file that changes type at reopen is untrustable.
/// shortcut: same-user concurrent writes can still race the walk. Detecting or excluding that
/// fully needs OS-level file handles (openat/O_NOFOLLOW) and is not attempted here; the reopen
/// type check and byte accounting only narrow the window.
fn fingerprint_folder(folder: &Path) -> Result<String, &'static str> {
    let mut files: Vec<PathBuf> = Vec::new();
    let mut declared_bytes: u64 = 0;
    let mut entries_seen: usize = 0;
    let mut stack = vec![(folder.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        if depth > MAX_FINGERPRINT_DEPTH { return Err("The plugin package is nested too deeply to fingerprint safely."); }
        let entries = fs::read_dir(&dir).map_err(|_| "Plugin package files are unreadable.")?;
        for entry in entries {
            entries_seen = entries_seen.checked_add(1).ok_or("The plugin package is too large to fingerprint safely.")?;
            if entries_seen > MAX_FINGERPRINT_ENTRIES { return Err("The plugin package is too large to fingerprint safely."); }
            let entry = entry.map_err(|_| "Plugin package files are unreadable.")?;
            let meta = fs::symlink_metadata(entry.path()).map_err(|_| "Plugin package files are unreadable.")?;
            if meta.file_type().is_symlink() { return Err("Plugin package files must not be symlinks."); }
            if meta.is_dir() { stack.push((entry.path(), depth + 1)); }
            else if meta.is_file() {
                declared_bytes = declared_bytes.checked_add(meta.len()).ok_or("The plugin package is too large to fingerprint safely.")?;
                if files.len() >= MAX_FINGERPRINT_FILES || declared_bytes > MAX_FINGERPRINT_BYTES {
                    return Err("The plugin package is too large to fingerprint safely.");
                }
                files.push(entry.path());
            } else { return Err("Plugin packages may contain only regular files and directories."); }
        }
    }
    files.sort();
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 16 * 1024];
    let mut read_bytes: u64 = 0;
    for path in &files {
        let relative = path.strip_prefix(folder).map_err(|_| "Plugin package paths are invalid.")?;
        let relative = relative.to_str().ok_or("Plugin package paths must be valid Unicode.")?;
        // Recheck the type after discovery: a file replaced by a symlink or directory is refused, never followed.
        let meta = fs::symlink_metadata(path).map_err(|_| "Plugin package files are unreadable.")?;
        if meta.file_type().is_symlink() || !meta.is_file() { return Err("Plugin package files changed while fingerprinting."); }
        hasher.update((relative.len() as u64).to_le_bytes());
        hasher.update(relative.as_bytes());
        hasher.update(meta.len().to_le_bytes());
        let mut file = fs::File::open(path).map_err(|_| "Plugin package files are unreadable.")?;
        loop {
            let count = file.read(&mut buffer).map_err(|_| "Plugin package files are unreadable.")?;
            if count == 0 { break; }
            read_bytes = read_bytes.checked_add(count as u64).ok_or("The plugin package is too large to fingerprint safely.")?;
            if read_bytes > MAX_FINGERPRINT_BYTES { return Err("The plugin package is too large to fingerprint safely."); }
            hasher.update(&buffer[..count]);
        }
    }
    Ok(hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect())
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
/// Python interpreter paths only: never a shell or the Windows py launcher.
pub fn python_runtime_candidates(home: &Path, path: Option<&std::ffi::OsStr>) -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    let names = ["python3.exe", "python.exe"];
    #[cfg(not(target_os = "windows"))]
    let names = ["python3", "python"];
    let mut directories: Vec<_> = path.map(|p| std::env::split_paths(p).take(8).filter(|p| p.is_absolute()).collect()).unwrap_or_default();
    #[cfg(not(target_os = "windows"))]
    directories.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from));
    directories.push(home.join(".pyenv/shims"));
    directories.push(home.join(".local/share/mise/shims"));
    #[cfg(target_os = "windows")]
    for root in [home.join("AppData/Local/Programs/Python"), PathBuf::from("C:/Program Files")] {
        if let Ok(entries) = fs::read_dir(root) {
            let mut versions: Vec<_> = entries.take(64).filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_str().is_some_and(|name| name.starts_with("Python3")))
                .map(|entry| entry.path()).collect();
            versions.sort(); versions.reverse();
            directories.extend(versions.into_iter().take(3));
        }
    }
    directories.into_iter().flat_map(|dir| names.map(|name| dir.join(name))).take(MAX_RUNTIMES).collect()
}
fn node_version(text: &str) -> Option<(u32, u32, u32)> {
    let parts: Vec<_> = text.strip_prefix('v').unwrap_or(text).split('.').collect();
    if parts.len() != 3 || parts.iter().any(|p| p.is_empty() || p.len() > 4 || !p.bytes().all(|b| b.is_ascii_digit())) { return None; }
    Some((parts[0].parse().ok()?, parts[1].parse().ok()?, parts[2].parse().ok()?))
}
async fn probe(path: &Path, budget: Duration, python: bool) -> Option<String> {
    let mut command = Command::new(path);
    if python { command.args(["-E", "-s", "-B"]); }
    let mut child = command.arg("--version").env_remove("NODE_OPTIONS").env_remove("NODE_PATH")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true).spawn().ok()?;
    let mut stdout = child.stdout.take()?.take(PROBE_BYTES + 1);
    let result = timeout(budget, async {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).await.ok()?;
        if bytes.len() as u64 > PROBE_BYTES || !child.wait().await.ok()?.success() { return None; }
        let text = std::str::from_utf8(&bytes).ok()?.trim();
        let version = node_version(if python { text.strip_prefix("Python ")? } else { text })?;
        Some(format!("{}.{}.{}", version.0, version.1, version.2))
    }).await.ok().flatten();
    // Reap failed, oversized and timed-out probes too; stderr is never retained.
    let _ = child.start_kill(); let _ = child.wait().await;
    result
}
pub async fn detect_node(candidates: &[PathBuf]) -> NodeRuntime { detect_runtime(candidates, false).await }
pub async fn detect_python(candidates: &[PathBuf]) -> NodeRuntime { detect_runtime(candidates, true).await }
async fn detect_runtime(candidates: &[PathBuf], python: bool) -> NodeRuntime {
    let mut result = NodeRuntime { status: NodeStatus::NotFound, version: None, path: None };
    let mut seen = HashSet::new();
    let deadline = Instant::now() + Duration::from_secs(3);
    for path in candidates.iter().take(MAX_RUNTIMES) {
        if !path.is_absolute() { continue; }
        let Ok(canonical) = fs::canonicalize(path) else { continue; };
        if !seen.insert(canonical) { continue; }
        let Ok(display) = path_string(path) else { continue; };
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else { break; };
        if let Some(version) = probe(path, remaining.min(Duration::from_millis(1000)), python).await {
            let supported = node_version(&version).expect("validated runtime version") >= if python { (3, 10, 0) } else { (22, 18, 0) };
            let candidate = NodeRuntime { status: if supported { NodeStatus::Detected } else { NodeStatus::Unsupported }, version: Some(version), path: Some(display) };
            if supported { return candidate; }
            if result.status == NodeStatus::NotFound { result = candidate; }
        }
    }
    result
}
