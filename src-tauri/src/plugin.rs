//! Trusted-local stdio plugin host. Process separation is NOT a sandbox.
//! Never construct launch records from deck, phone, manifest or remote data.
//! Stderr is drained independently, retaining only an internal 8 KiB prefix
//! until exit for fixed startup-error classification. Nothing is logged or
//! returned verbatim; the remainder is discarded.
//! State is plugin-authored JSON, not trusted/sanitized support-log material.

use std::{collections::{BTreeMap, HashSet}, path::PathBuf, process::Stdio, sync::{Arc, Mutex as MapMutex}, time::Duration};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::{io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader}, process::{Child, ChildStdin, ChildStdout, Command}, sync::Mutex, time::timeout};

const REQUEST_BYTES: usize = 16_384;
const RESPONSE_BYTES: usize = 65_536;
const STDERR_BYTES: usize = 8192;
const SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// Deliberately not deserializable or serializable. Only explicit local trust
/// configuration may supply this record. Path arguments must be absolute;
/// literal flags/values are passed verbatim, never through a shell.
pub struct TrustedLaunch {
    program: PathBuf,
    args: Vec<String>,
    cwd: PathBuf,
}
impl TrustedLaunch {
    pub fn new(program: PathBuf, args: Vec<String>, cwd: PathBuf) -> Result<Self, PluginError> {
        if !program.is_absolute() || !cwd.is_absolute()
            || args.iter().any(|arg| arg.contains('\0')) {
            return Err(PluginError::new(ErrorKind::InvalidLaunch, Outcome::NotStarted));
        }
        Ok(Self { program, args, cwd })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome { NotStarted, Unknown }
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind { InvalidLaunch, Unavailable, Stopped, InvalidManifest, InvalidArguments, UnknownAction, Protocol, Timeout, PluginFailed }
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PluginError {
    pub kind: ErrorKind,
    pub code: Option<&'static str>,
    pub outcome: Outcome,
    pub message: &'static str,
    pub hint: &'static str,
}
#[derive(Clone, Copy)]
pub(crate) enum LaunchFailure { MissingDependency, RuntimeMissing, RuntimeIncompatible, StartupExit }
impl PluginError {
    pub(crate) fn launch(failure: LaunchFailure) -> Self {
        let (code, message, hint) = match failure {
            LaunchFailure::MissingDependency => ("missing_dependency", "Plugin could not load a required runtime dependency.", "Copy the complete packaged plugin folder, including node_modules. Do not copy the source folder alone; refresh the catalog and enable explicitly."),
            LaunchFailure::RuntimeMissing => ("runtime_missing", "The selected plugin runtime could not be started.", "Install or select a readable executable Node.js 22.18.0 or newer, then refresh the catalog and enable explicitly."),
            LaunchFailure::RuntimeIncompatible => ("runtime_incompatible", "The detected Node.js runtime is too old.", "Use Node.js 22.18.0 or newer, refresh the catalog, and enable explicitly."),
            LaunchFailure::StartupExit => ("startup_exit", "Plugin exited before describing its actions.", "Check Node.js 22.18.0 or newer and a complete packaged plugin folder. Refresh the catalog and enable explicitly; no action was sent."),
        };
        Self { kind: ErrorKind::Unavailable, code: Some(code), outcome: Outcome::NotStarted, message, hint }
    }
    pub(crate) fn new(kind: ErrorKind, outcome: Outcome) -> Self {
        let message = match kind {
            ErrorKind::InvalidLaunch => "Invalid trusted local launch record.",
            ErrorKind::Unavailable => "Plugin process unavailable.",
            ErrorKind::Stopped => "Plugin host stopped; create a new host to reconnect.",
            ErrorKind::InvalidManifest => "Invalid plugin manifest.",
            ErrorKind::InvalidArguments => "Arguments do not match the action configuration.",
            ErrorKind::UnknownAction => "Action is not declared by the plugin.",
            ErrorKind::Protocol => "Invalid plugin protocol response.",
            ErrorKind::Timeout => "Plugin request timed out.",
            ErrorKind::PluginFailed => "Plugin operation failed.",
        };
        Self { kind, code: None, outcome, message, hint: match outcome {
            Outcome::Unknown => "Inspect state before manually retrying; never automatically retry an action.",
            Outcome::NotStarted => "Check trusted local configuration and the plugin contract before trying again.",
        } }
    }
}
impl std::fmt::Display for PluginError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(self.message) }
}
impl std::error::Error for PluginError {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Manifest { pub id: String, pub version: String, pub protocol_version: u8, pub actions: Vec<Action> }
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Action { pub id: String, pub title: String, pub config: BTreeMap<String, IntegerField> }
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntegerField { #[serde(rename = "type")] pub field_type: String, pub minimum: Value, pub maximum: Value }

pub(crate) fn identifier(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.as_bytes()[0].is_ascii_lowercase()
        && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
pub(crate) fn integer(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= SAFE_INTEGER)
}
pub(crate) fn manifest(mut value: Value) -> Result<Manifest, ErrorKind> {
    // JSON.parse/JSON.stringify in the SDK canonicalize integer-valued numbers
    // (including 1.0 and -0) before measuring the manifest.
    fn canonicalize(v: &mut Value) {
        match v {
            Value::Number(_) => { if let Some(n) = integer(v) { *v = Value::from(n as i64); } }
            Value::Array(a) => { for v in a { canonicalize(v); } }
            Value::Object(o) => { for v in o.values_mut() { canonicalize(v); } }
            _ => (),
        }
    }
    canonicalize(&mut value);
    if serde_json::to_vec(&value).map_err(|_| ErrorKind::InvalidManifest)?.len() > REQUEST_BYTES {
        return Err(ErrorKind::InvalidManifest);
    }
    let m: Manifest = serde_json::from_value(value).map_err(|_| ErrorKind::InvalidManifest)?;
    let parts: Vec<_> = m.version.split('.').collect();
    let mut seen = HashSet::new();
    if !identifier(&m.id) || m.protocol_version != 1 || parts.len() != 3
        || !parts.iter().all(|p| !p.is_empty() && p.len() <= 4 && p.bytes().all(|b| b.is_ascii_digit()))
        || m.actions.is_empty() || m.actions.len() > 32 { return Err(ErrorKind::InvalidManifest); }
    for a in &m.actions {
        if !identifier(&a.id) || !seen.insert(&a.id) || a.title.is_empty()
            || a.title.encode_utf16().count() > 80 || a.title.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
            || a.config.len() > 8 { return Err(ErrorKind::InvalidManifest); }
        for (key, field) in &a.config {
            if !identifier(key) || field.field_type != "integer" { return Err(ErrorKind::InvalidManifest); }
            match (integer(&field.minimum), integer(&field.maximum)) {
                (Some(min), Some(max)) if min <= max => (),
                _ => return Err(ErrorKind::InvalidManifest),
            }
        }
    }
    Ok(m)
}
fn arguments(action: &Action, args: &Value) -> bool {
    let Some(args) = args.as_object() else { return false; };
    args.len() == action.config.len() && action.config.iter().all(|(key, f)| {
        matches!((args.get(key).and_then(integer), integer(&f.minimum), integer(&f.maximum)),
            (Some(n), Some(min), Some(max)) if n >= min && n <= max)
    })
}
fn exact(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|o| o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k)))
}

// Read bounded chunks into a bounded line, never read_line/read_until (which
// allocate until LF). The BufReader itself has a fixed 8 KiB buffer.
async fn frame(reader: &mut BufReader<ChildStdout>) -> Result<Value, ErrorKind> {
    let mut line = Vec::with_capacity(RESPONSE_BYTES);
    loop {
        let buf = reader.fill_buf().await.map_err(|_| ErrorKind::Unavailable)?;
        if buf.is_empty() { return Err(ErrorKind::Unavailable); }
        let end = buf.iter().position(|b| *b == b'\n');
        let count = end.unwrap_or(buf.len());
        if count > RESPONSE_BYTES - line.len() { return Err(ErrorKind::Protocol); }
        line.extend_from_slice(&buf[..count]);
        reader.consume(count + usize::from(end.is_some()));
        if end.is_some() {
            let text = std::str::from_utf8(&line).map_err(|_| ErrorKind::Protocol)?;
            return serde_json::from_str(text).map_err(|_| ErrorKind::Protocol);
        }
    }
}
fn response(value: Value, id: &str, describe: bool, executing: bool) -> Result<Value, PluginError> {
    let outcome = if executing { Outcome::Unknown } else { Outcome::NotStarted };
    let bad = || PluginError::new(ErrorKind::Protocol, outcome);
    if value.get("protocolVersion").and_then(Value::as_f64) != Some(1.0)
        || value.get("id").and_then(Value::as_str) != Some(id) { return Err(bad()); }
    match value.get("type").and_then(Value::as_str) {
        Some("result") => {
            let key = if describe { "manifest" } else { "state" };
            if !exact(&value, &["protocolVersion", "id", "type", key]) || !value[key].is_object() { return Err(bad()); }
            Ok(value[key].clone())
        }
        Some("error") => {
            let e = &value["error"];
            if !exact(&value, &["protocolVersion", "id", "type", "error"])
                || !exact(e, &["code", "message", "hint", "outcome"])
                || !["code", "message", "hint"].iter().all(|k| e[*k].is_string()) { return Err(bad()); }
            let reported = match e["outcome"].as_str() {
                Some("not_started") => Outcome::NotStarted,
                Some("unknown") if executing => Outcome::Unknown,
                _ => return Err(bad()),
            };
            // Fixed mapping only: never reflect even an apparently familiar
            // plugin message, hint or code containing paths/credentials.
            let mut error = PluginError::new(if e["code"] == "timeout" { ErrorKind::Timeout } else { ErrorKind::PluginFailed }, reported);
            let known = match e["code"].as_str() {
                Some("unsupported_platform") => Some(("unsupported_platform", "Spotify control requires macOS.", "Run this plugin on macOS with Spotify desktop installed.")),
                Some("app_missing") => Some(("app_missing", "Spotify was not found at /Applications/Spotify.app.", "Install Spotify desktop in /Applications.")),
                Some("app_not_running") => Some(("app_not_running", "Spotify is not running.", "Open Spotify manually, then try again.")),
                Some("automation_denied") => Some(("automation_denied", "macOS denied Spotify Automation access.", "Allow the launching application to control Spotify in Privacy & Security > Automation.")),
                Some("outcome_unknown") => Some(("outcome_unknown", "Action may have applied, but state could not be read.", "Read state before deciding whether to retry; never automatically retry.")),
                _ => None,
            };
            if let Some((code, message, hint)) = known {
                error.code = Some(code);
                error.message = message;
                error.hint = hint;
            }
            Err(error)
        }
        _ => Err(bad()),
    }
}

struct Process {
    child: Child, stdin: Option<ChildStdin>, stdout: BufReader<ChildStdout>,
    stderr: Option<tokio::task::JoinHandle<Option<LaunchFailure>>>,
}
impl Process {
    async fn kill(&mut self) -> Option<LaunchFailure> {
        self.stdin.take(); let _ = self.child.start_kill(); let _ = self.child.wait().await;
        let mut task = self.stderr.take()?;
        // A descendant may inherit stderr: never let it hold cleanup open.
        match timeout(Duration::from_millis(100), &mut task).await {
            Ok(Ok(diagnostic)) => diagnostic,
            _ => { task.abort(); None }
        }
    }
}
impl Drop for Process {
    fn drop(&mut self) { if let Some(task) = self.stderr.take() { task.abort(); } }
}
async fn startup_diagnostic(mut stderr: tokio::process::ChildStderr) -> Option<LaunchFailure> {
    let mut prefix = Vec::with_capacity(STDERR_BYTES);
    let mut chunk = [0u8; 1024];
    loop {
        let count = match stderr.read(&mut chunk).await { Ok(0) | Err(_) => break, Ok(n) => n };
        let keep = count.min(STDERR_BYTES - prefix.len());
        prefix.extend_from_slice(&chunk[..keep]);
    }
    // Match only Node-owned codes. Raw text/paths/exception strings never leave
    // this task; even forged diagnostics can only select a fixed host message.
    let text = String::from_utf8_lossy(&prefix);
    if text.contains("ERR_MODULE_NOT_FOUND") || text.contains("MODULE_NOT_FOUND") {
        Some(LaunchFailure::MissingDependency)
    } else { None }
}
struct Inner { launch: TrustedLaunch, process: Option<Process>, manifest: Option<Manifest>, stopped: bool, next_id: u64 }
/// Cloneable shared host. All operations (including stop) are serialized. Once
/// stopped/failed it never restarts: explicitly create another host and read
/// state before deciding whether to manually retry an action.
#[derive(Clone)]
pub struct PluginHost { inner: Arc<Mutex<Inner>>, deadline: Duration }
enum Operation { Describe, State, Execute(String, Value), Stop }
impl PluginHost {
    pub fn new(launch: TrustedLaunch) -> Self { Self::with_timeout(launch, Duration::from_secs(12)) }
    /// Short deadlines are useful for local transport tests. Production should
    /// use new() so the SDK's 10-second cooperative timeout can respond first.
    pub fn with_timeout(launch: TrustedLaunch, deadline: Duration) -> Self {
        Self { inner: Arc::new(Mutex::new(Inner { launch, process: None, manifest: None, stopped: false, next_id: 0 })), deadline }
    }
    pub async fn describe(&self) -> Result<Manifest, PluginError> {
        let v = self.run(Operation::Describe).await?;
        manifest(v).map_err(|k| PluginError::new(k, Outcome::NotStarted))
    }
    pub async fn state(&self) -> Result<Map<String, Value>, PluginError> {
        Ok(self.run(Operation::State).await?.as_object().expect("validated state").clone())
    }
    pub async fn execute(&self, action: &str, args: Value) -> Result<Map<String, Value>, PluginError> {
        Ok(self.run(Operation::Execute(action.to_owned(), args)).await?.as_object().expect("validated state").clone())
    }
    pub async fn stop(&self) -> Result<(), PluginError> { self.run(Operation::Stop).await.map(|_| ()) }
    async fn run(&self, op: Operation) -> Result<Value, PluginError> {
        let mut guard = self.inner.clone().lock_owned().await;
        let deadline = self.deadline;
        // Once admitted, finish/kill/reap even if the caller drops its future.
        // Waiting callers hold no process or pre-spawned worker task.
        tokio::spawn(async move { guard.operation(op, deadline).await }).await
            .unwrap_or_else(|_| Err(PluginError::new(ErrorKind::Unavailable, Outcome::Unknown)))
    }
}
impl Inner {
    async fn terminate(&mut self) -> Option<LaunchFailure> {
        self.stopped = true;
        let diagnostic = if let Some(p) = self.process.as_mut() { p.kill().await } else { None };
        self.process = None;
        self.manifest = None;
        diagnostic
    }
    async fn exchange(&mut self, kind: &str, action: Option<(&str, &Value)>, deadline: Duration) -> Result<Value, PluginError> {
        let executing = kind == "execute";
        let mut outcome = Outcome::NotStarted;
        let result = timeout(deadline, async {
            self.next_id = self.next_id.checked_add(1).ok_or(ErrorKind::Protocol)?;
            let id = format!("r{}", self.next_id);
            let mut request = serde_json::json!({"protocolVersion":1,"id":id,"type":kind});
            if let Some((name, args)) = action { request["action"] = name.into(); request["args"] = args.clone(); }
            let mut bytes = serde_json::to_vec(&request).map_err(|_| ErrorKind::Protocol)?;
            if bytes.len() > REQUEST_BYTES { return Err(ErrorKind::InvalidArguments); }
            bytes.push(b'\n');
            let p = self.process.as_mut().ok_or(ErrorKind::Unavailable)?;
            if executing { outcome = Outcome::Unknown; }
            p.stdin.as_mut().ok_or(ErrorKind::Unavailable)?.write_all(&bytes).await.map_err(|_| ErrorKind::Unavailable)?;
            let value = frame(&mut p.stdout).await?;
            Ok((value, id))
        }).await;
        let mut parsed = match result {
            Ok(Ok((value, id))) => response(value, &id, kind == "describe", executing),
            Ok(Err(k)) => Err(PluginError::new(k, outcome)),
            Err(_) => Err(PluginError::new(ErrorKind::Timeout, outcome)),
        };
        // Even structured errors end the session: no hidden restart/replay and
        // a timed-out SDK handler may still be running.
        if parsed.is_err() {
            let diagnostic = self.terminate().await;
            if kind == "describe" && matches!(&parsed, Err(error) if error.kind == ErrorKind::Unavailable) {
                parsed = Err(PluginError::launch(diagnostic.unwrap_or(LaunchFailure::StartupExit)));
            }
        }
        parsed
    }
    async fn operation(&mut self, op: Operation, deadline: Duration) -> Result<Value, PluginError> {
        if matches!(&op, Operation::Stop) {
            self.stopped = true;
            if let Some(p) = self.process.as_mut() {
                p.stdin.take();
                if !matches!(timeout(Duration::from_secs(1), p.child.wait()).await, Ok(Ok(_))) { p.kill().await; }
            }
            self.process = None;
            self.manifest = None;
            return Ok(Value::Null);
        }
        if self.stopped { return Err(PluginError::new(ErrorKind::Stopped, Outcome::NotStarted)); }
        if self.process.is_none() {
            let child = Command::new(&self.launch.program).args(&self.launch.args).current_dir(&self.launch.cwd)
                .env_remove("NODE_OPTIONS").env_remove("NODE_PATH")
                .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).spawn();
            let mut child = match child {
                Ok(c) => c,
                Err(_) => { self.stopped = true; return Err(PluginError::launch(LaunchFailure::RuntimeMissing)); }
            };
            let stdin = child.stdin.take().expect("piped stdin");
            let stdout = BufReader::with_capacity(8192, child.stdout.take().expect("piped stdout"));
            let stderr = Some(tokio::spawn(startup_diagnostic(child.stderr.take().expect("piped stderr"))));
            self.process = Some(Process { child, stdin: Some(stdin), stdout, stderr });
        }
        if self.manifest.is_none() {
            let value = self.exchange("describe", None, deadline).await?;
            match manifest(value) {
                Ok(m) => self.manifest = Some(m),
                Err(k) => { self.terminate().await; return Err(PluginError::new(k, Outcome::NotStarted)); }
            }
        }
        match op {
            Operation::Describe => Ok(serde_json::to_value(self.manifest.as_ref().unwrap()).expect("serializable manifest")),
            Operation::State => self.exchange("state", None, deadline).await,
            Operation::Execute(name, args) => {
                let m = self.manifest.as_ref().unwrap();
                let a = m.actions.iter().find(|a| a.id == name).ok_or_else(|| PluginError::new(ErrorKind::UnknownAction, Outcome::NotStarted))?;
                if !arguments(a, &args) { return Err(PluginError::new(ErrorKind::InvalidArguments, Outcome::NotStarted)); }
                self.exchange("execute", Some((&name, &args)), deadline).await
            }
            Operation::Stop => unreachable!(),
        }
    }
}

const MAX_PLUGINS: usize = 16;
struct RegistryEntry { state: Arc<PluginState>, gate: Arc<Mutex<()>>, transient: bool }
/// Independent session-local plugins. The map lock never spans plugin I/O.
#[derive(Default, Clone)]
pub struct PluginRegistry { entries: Arc<MapMutex<BTreeMap<String, Arc<RegistryEntry>>>> }
fn registry_error(code: &'static str, hint: &'static str) -> PluginError {
    let mut error = PluginError::new(ErrorKind::Unavailable, Outcome::NotStarted);
    error.code = Some(code); error.hint = hint; error
}
fn disconnected() -> PluginSnapshot { Session::default().snapshot() }
impl PluginRegistry {
    pub(crate) async fn manage<F, Fut, T>(&self, id: &str, create: bool, remove: bool, operation: F) -> Result<T, PluginError>
    where F: FnOnce(Arc<PluginState>) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<T, PluginError>> + Send,
        T: Send + 'static,
    {
        if !identifier(id) { return Err(PluginError::new(ErrorKind::InvalidArguments, Outcome::NotStarted)); }
        let (entry, guard) = loop {
            let entry = {
                let mut entries = self.entries.lock().expect("plugin registry lock");
                if let Some(entry) = entries.get(id) { entry.clone() }
                else {
                    if !create { return Err(registry_error("not_enabled", "Enable this trusted plugin explicitly from the catalog first.")); }
                    // Removals get a bounded extra budget even when all enabled slots are occupied.
                    if entries.len() >= MAX_PLUGINS * 2 || (!remove && entries.values().filter(|entry| !entry.transient).count() >= MAX_PLUGINS) {
                        return Err(registry_error("capacity", "Disable a plugin or wait for pending removals; at most 16 enabled or stopped sessions are retained."));
                    }
                    let entry = Arc::new(RegistryEntry { state: Arc::new(PluginState::default()), gate: Arc::new(Mutex::new(())), transient: remove });
                    entries.insert(id.to_owned(), entry.clone()); entry
                }
            };
            let guard = entry.gate.clone().lock_owned().await;
            if self.entries.lock().expect("plugin registry lock").get(id).is_some_and(|current| Arc::ptr_eq(current, &entry)) { break (entry, guard); }
        };
        let entries = self.entries.clone(); let id = id.to_owned();
        // An admitted lifecycle operation must finish even if its IPC caller leaves.
        tokio::spawn(async move {
            let _guard = guard;
            let result = operation(entry.state.clone()).await;
            let empty = entry.state.snapshot().await.status == ConnectionStatus::Disconnected;
            if (remove && result.is_ok()) || empty {
                let mut entries = entries.lock().expect("plugin registry lock");
                if entries.get(&id).is_some_and(|current| Arc::ptr_eq(current, &entry)) { entries.remove(&id); }
            }
            result
        }).await.unwrap_or_else(|_| Err(PluginError::new(ErrorKind::Unavailable, Outcome::Unknown)))
    }
    /// Trusted Rust-only helper; no manual launch IPC is registered.
    pub async fn connect(&self, id: &str, program: String, entrypoint: String) -> Result<PluginSnapshot, PluginError> {
        if !identifier(id) { return Err(PluginError::new(ErrorKind::InvalidArguments, Outcome::NotStarted)); }
        let expected_id = id.to_owned();
        self.manage(id, true, false, move |state| async move {
            let snapshot = state.connect(program, entrypoint).await?;
            if snapshot.manifest.as_ref().is_none_or(|m| m.id != expected_id) {
                state.disconnect().await;
                return Err(PluginError::new(ErrorKind::InvalidManifest, Outcome::NotStarted));
            }
            Ok(snapshot)
        }).await
    }
    pub async fn disconnect(&self, id: &str) -> Result<PluginSnapshot, PluginError> {
        let result = self.manage(id, false, true, |state| async move { Ok(state.disconnect().await) }).await;
        match result { Err(error) if error.code == Some("not_enabled") => Ok(disconnected()), other => other }
    }
    pub async fn snapshot(&self, id: &str) -> Result<PluginSnapshot, PluginError> {
        if !identifier(id) { return Err(PluginError::new(ErrorKind::InvalidArguments, Outcome::NotStarted)); }
        let entry = self.entries.lock().expect("plugin registry lock").get(id).cloned();
        Ok(if let Some(entry) = entry { entry.state.snapshot().await } else { disconnected() })
    }
    pub async fn snapshots(&self) -> BTreeMap<String, PluginSnapshot> {
        let entries = self.entries.lock().expect("plugin registry lock").clone();
        let mut snapshots = BTreeMap::new();
        for (id, entry) in entries { if !entry.transient { snapshots.insert(id, entry.state.snapshot().await); } }
        snapshots
    }
    pub async fn state(&self, id: &str) -> Result<PluginSnapshot, PluginError> {
        self.manage(id, false, false, |state| async move { state.state().await }).await
    }
    pub async fn execute(&self, id: String, action: String, args: Value) -> Result<PluginSnapshot, PluginError> {
        if !identifier(&id) { return Err(PluginError::new(ErrorKind::InvalidArguments, Outcome::NotStarted)); }
        let plugin_id = id.clone();
        self.manage(&id, false, false, move |state| async move { state.execute(plugin_id, action, args).await }).await
    }
}

/// One explicitly trusted, session-local connection shared by desktop and phone.
/// There is no persistence, automatic reconnect, or implicit state read.
#[derive(Default)]
pub struct PluginState { session: Arc<Mutex<Session>> }
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionStatus { #[default] Disconnected, Connected, Stopped }
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSnapshot {
    pub status: ConnectionStatus,
    pub manifest: Option<Manifest>,
    /// Untrusted plugin-authored data. Never put this in diagnostic logs.
    pub state: Option<Map<String, Value>>,
    pub last_error: Option<PluginError>,
}
#[derive(Default)]
struct Session {
    host: Option<PluginHost>,
    manifest: Option<Manifest>,
    state: Option<Map<String, Value>>,
    status: ConnectionStatus,
    last_error: Option<PluginError>,
}
enum SessionOperation { Connect(String, String, Option<Manifest>), Disconnect, State, Execute(String, String, Value) }
fn node_launch(program: String, entrypoint: String) -> Result<TrustedLaunch, PluginError> {
    let entrypoint = PathBuf::from(entrypoint);
    if !entrypoint.is_absolute() || entrypoint.file_name().is_none() {
        return Err(PluginError::new(ErrorKind::InvalidLaunch, Outcome::NotStarted));
    }
    let cwd = entrypoint.parent().ok_or_else(|| PluginError::new(ErrorKind::InvalidLaunch, Outcome::NotStarted))?.to_path_buf();
    let entrypoint = entrypoint.into_os_string().into_string().map_err(|_| PluginError::new(ErrorKind::InvalidLaunch, Outcome::NotStarted))?;
    TrustedLaunch::new(PathBuf::from(program), vec![entrypoint], cwd)
}
impl PluginState {
    /// Desktop trust boundary ONLY. The UI must explicitly confirm trust before
    /// invoking this. Program is a locally selected Node runtime; no shell or
    /// caller-supplied flags, and only an absolute entrypoint is passed to it.
    pub async fn connect(&self, program: String, entrypoint: String) -> Result<PluginSnapshot, PluginError> {
        self.run(SessionOperation::Connect(program, entrypoint, None)).await
    }
    pub(crate) async fn connect_manifest(&self, program: String, entrypoint: String, expected: Manifest) -> Result<PluginSnapshot, PluginError> {
        self.run(SessionOperation::Connect(program, entrypoint, Some(expected))).await
    }
    pub async fn disconnect(&self) -> PluginSnapshot {
        // Only a worker panic can fail disconnect; snapshot still contains no paths.
        let _ = self.run(SessionOperation::Disconnect).await;
        self.snapshot().await
    }
    pub async fn snapshot(&self) -> PluginSnapshot { self.session.lock().await.snapshot() }
    pub async fn state(&self) -> Result<PluginSnapshot, PluginError> { self.run(SessionOperation::State).await }
    pub async fn execute(&self, plugin_id: String, action_id: String, args: Value) -> Result<PluginSnapshot, PluginError> {
        self.run(SessionOperation::Execute(plugin_id, action_id, args)).await
    }
    async fn run(&self, op: SessionOperation) -> Result<PluginSnapshot, PluginError> {
        let mut session = self.session.clone().lock_owned().await;
        // Cancellation must not leave a failed host advertised as connected,
        // nor let a replacement connection overlap an admitted operation.
        tokio::spawn(async move { session.operation(op).await }).await
            .unwrap_or_else(|_| Err(PluginError::new(ErrorKind::Unavailable, Outcome::Unknown)))
    }
}
impl Session {
    fn snapshot(&self) -> PluginSnapshot {
        PluginSnapshot { status: self.status, manifest: self.manifest.clone(), state: self.state.clone(), last_error: self.last_error.clone() }
    }
    async fn close(&mut self) {
        if let Some(host) = self.host.take() { let _ = host.stop().await; }
        self.state = None;
    }
    async fn operation(&mut self, op: SessionOperation) -> Result<PluginSnapshot, PluginError> {
        match op {
            SessionOperation::Disconnect => {
                self.close().await;
                self.manifest = None;
                self.last_error = None;
                self.status = ConnectionStatus::Disconnected;
                return Ok(self.snapshot());
            }
            SessionOperation::Connect(program, entrypoint, expected) => {
                self.close().await;
                self.manifest = None;
                self.last_error = None;
                self.status = ConnectionStatus::Stopped;
                let result = async {
                    let host = PluginHost::new(node_launch(program, entrypoint)?);
                    let manifest = host.describe().await?;
                    if expected.as_ref().is_some_and(|expected| expected != &manifest) {
                        let _ = host.stop().await;
                        return Err(PluginError::new(ErrorKind::InvalidManifest, Outcome::NotStarted));
                    }
                    Ok::<_, PluginError>((host, manifest))
                }.await;
                match result {
                    Ok((host, manifest)) => {
                        self.manifest = Some(manifest);
                        self.host = Some(host);
                        self.status = ConnectionStatus::Connected;
                        return Ok(self.snapshot());
                    }
                    Err(error) => {
                        self.status = ConnectionStatus::Stopped;
                        self.last_error = Some(error.clone());
                        return Err(error);
                    }
                }
            }
            _ => (),
        }
        let Some(host) = self.host.as_ref() else {
            return Err(PluginError::new(ErrorKind::Unavailable, Outcome::NotStarted));
        };
        let result = match op {
            SessionOperation::State => host.state().await,
            SessionOperation::Execute(plugin_id, action_id, args) => {
                if !identifier(&plugin_id) || !identifier(&action_id)
                    || self.manifest.as_ref().map(|m| m.id.as_str()) != Some(plugin_id.as_str()) {
                    Err(PluginError::new(ErrorKind::UnknownAction, Outcome::NotStarted))
                } else { host.execute(&action_id, args).await }
            }
            _ => unreachable!(),
        };
        match result {
            Ok(state) => { self.state = Some(state); self.last_error = None; Ok(self.snapshot()) }
            Err(error) => {
                self.close().await;
                self.status = ConnectionStatus::Stopped;
                self.last_error = Some(error.clone());
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn sample() -> Value { json!({"id":"test","version":"0.0.1","protocolVersion":1,"actions":[{"id":"go","title":"Go","config":{"n":{"type":"integer","minimum":0,"maximum":100}}}]}) }
    #[test]
    fn strict_manifest_and_arguments() {
        let m = manifest(sample()).unwrap();
        for args in [json!({}), json!({"n":1.5}), json!({"n":101}), json!({"n":"1"}), json!({"n":1,"extra":0}), json!(null)] { assert!(!arguments(&m.actions[0], &args)); }
        assert!(arguments(&m.actions[0], &json!({"n":1.0})));
        for path in ["extra", "version", "protocolVersion", "actions"] {
            let mut v = sample(); v[path] = json!(false); assert!(manifest(v).is_err());
        }
        let mut v = sample(); v["actions"][0]["config"]["n"]["minimum"] = json!(-9007199254740992i64); assert!(manifest(v).is_err());
        let mut v = sample(); v["actions"][0]["title"] = json!("😀".repeat(41)); assert!(manifest(v).is_err());
        let mut v = sample(); v["actions"] = json!(vec![v["actions"][0].clone(); 33]); assert!(manifest(v).is_err());
        let mut v = sample(); v["actions"][0]["extra"] = json!(1); assert!(manifest(v).is_err());
        let mut v = sample(); v["actions"][0]["config"]["n"]["extra"] = json!(1); assert!(manifest(v).is_err());
    }
    #[test]
    fn manifest_bounds_match_sdk() {
        let mut v = sample();
        v["protocolVersion"] = json!(1.0);
        v["actions"][0]["title"] = json!("😀".repeat(40));
        assert!(manifest(v.clone()).is_ok());
        v["actions"][0]["title"] = json!("bad\ntext");
        assert!(manifest(v).is_err());
        let mut v = sample();
        v["actions"][0]["config"]["n"] = json!({"type":"integer","minimum":-9007199254740991i64,"maximum":9007199254740991i64});
        assert!(manifest(v.clone()).is_ok());
        v["actions"][0]["config"]["n"]["maximum"] = json!(-9007199254740992i64);
        assert!(manifest(v).is_err());
        let mut v = sample();
        let field = v["actions"][0]["config"]["n"].clone();
        let fields: Map<String, Value> = (0..8).map(|i| (format!("field{i}"), field.clone())).collect();
        v["actions"][0]["config"] = Value::Object(fields);
        assert!(manifest(v.clone()).is_ok());
        v["actions"][0]["config"]["extra"] = field;
        assert!(manifest(v).is_err());
        let mut v = sample();
        let actions: Vec<Value> = (0..32).map(|i| json!({"id":format!("action{i}"),"title":"Go","config":{}})).collect();
        v["actions"] = json!(actions);
        assert!(manifest(v.clone()).is_ok());
        v["actions"][1] = v["actions"][0].clone();
        assert!(manifest(v).is_err());
        let mut v = sample();
        let fields: Map<String, Value> = (0..8).map(|i| (format!("f{i}{}", "x".repeat(60)), json!({"type":"integer","minimum":-9007199254740991i64,"maximum":9007199254740991i64}))).collect();
        v["actions"] = json!((0..32).map(|i| json!({"id":format!("action{i}"),"title":"Go","config":fields})).collect::<Vec<_>>());
        assert!(serde_json::to_vec(&v).unwrap().len() > REQUEST_BYTES);
        assert!(manifest(v).is_err());
    }
    #[test]
    fn strict_responses_and_redacted_errors() {
        let good = json!({"protocolVersion":1,"id":"r1","type":"result","state":{}});
        assert!(response(good.clone(), "r1", false, true).is_ok());
        for v in [json!(null), json!([]), json!({"protocolVersion":1,"id":"r1","type":"result","state":[]}), json!({"protocolVersion":1,"id":"r1","type":"result","state":{},"extra":1})] { assert!(response(v,"r1",false,true).is_err()); }
        assert!(response(good, "r2", false, true).is_err());
        let e = response(json!({"protocolVersion":1,"id":"r1","type":"error","error":{"code":"/secret","message":"password","hint":"credential","outcome":"unknown"}}),"r1",false,true).unwrap_err();
        assert_eq!(e.outcome, Outcome::Unknown);
        assert_eq!(e.code, None);
        let denied = response(json!({"protocolVersion":1,"id":"r1","type":"error","error":{"code":"automation_denied","message":"/secret","hint":"credential","outcome":"unknown"}}),"r1",false,true).unwrap_err();
        assert_eq!(denied.code, Some("automation_denied"));
        assert!(denied.hint.contains("Privacy & Security > Automation"));
        assert_eq!(denied.outcome, Outcome::Unknown);
        assert!(!serde_json::to_string(&denied).unwrap().contains("credential"));
        let text = serde_json::to_string(&e).unwrap();
        assert!(!text.contains("secret") && !text.contains("password") && !text.contains("credential"));
    }
}
