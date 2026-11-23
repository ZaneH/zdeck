//! Typed OBS Studio WebSocket adapter for the native desktop shell.
//!
//! This module is the only place that talks to OBS. It is intentionally narrow:
//! connections are limited to loopback so the UI can never point the desktop app
//! at an arbitrary remote host, scene names and ports are bounded, and passwords
//! live in memory for the life of a connection only. Nothing here is logged and
//! server error bodies are never forwarded to the frontend.
//!
//! The adapter is reusable by the future remote action engine: connect,
//! disconnect, read a typed snapshot, and switch the program scene.

use std::future::Future;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use obws::client::{ConnectConfig, HandshakeError};
use obws::error::Error as ObwsError;
use obws::requests::EventSubscription;
use serde::Serialize;
use tokio::sync::Mutex;

/// Default port used by the OBS Studio WebSocket server.
pub const DEFAULT_PORT: u16 = 4455;

const MAX_PASSWORD_LEN: usize = 512;
const MAX_SCENE_NAME_LEN: usize = 128;
/// Only loopback hosts are attempted. IPv6 literals need brackets in a URI.
const LOOPBACK_HOSTS: [&str; 2] = ["127.0.0.1", "[::1]"];

/// Connect and per-request timeouts.
#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
    pub connect: Duration,
    pub request: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            connect: Duration::from_secs(6),
            request: Duration::from_secs(5),
        }
    }
}

/// Sanitized, typed errors returned to the frontend.
///
/// Every variant carries a message this module authored. Raw OBS response
/// bodies, socket errors, and passwords are never included.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ObsError {
    InvalidInput { message: String },
    Timeout { message: String },
    Unavailable { message: String },
    AuthRejected { message: String },
    NotConnected { message: String },
    SceneNotFound { message: String },
    RequestFailed { message: String },
    Disconnected { message: String },
}

impl ObsError {
    fn invalid_input(message: impl Into<String>) -> Self {
        Self::InvalidInput {
            message: message.into(),
        }
    }

    fn timeout(message: impl Into<String>) -> Self {
        Self::Timeout {
            message: message.into(),
        }
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self::Unavailable {
            message: message.into(),
        }
    }

    fn auth_rejected(message: impl Into<String>) -> Self {
        Self::AuthRejected {
            message: message.into(),
        }
    }

    fn not_connected(message: impl Into<String>) -> Self {
        Self::NotConnected {
            message: message.into(),
        }
    }

    fn scene_not_found(message: impl Into<String>) -> Self {
        Self::SceneNotFound {
            message: message.into(),
        }
    }

    fn request_failed(message: impl Into<String>) -> Self {
        Self::RequestFailed {
            message: message.into(),
        }
    }

    fn disconnected(message: impl Into<String>) -> Self {
        Self::Disconnected {
            message: message.into(),
        }
    }

    /// Whether the connection should be discarded because it is no longer usable.
    fn is_disconnect(&self) -> bool {
        matches!(self, Self::Disconnected { .. } | Self::NotConnected { .. })
    }

    fn message(&self) -> &str {
        match self {
            Self::InvalidInput { message }
            | Self::Timeout { message }
            | Self::Unavailable { message }
            | Self::AuthRejected { message }
            | Self::NotConnected { message }
            | Self::SceneNotFound { message }
            | Self::RequestFailed { message }
            | Self::Disconnected { message } => message,
        }
    }
}

impl std::fmt::Display for ObsError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message())
    }
}

impl std::error::Error for ObsError {}

/// A typed view of the OBS scene state at one point in time.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsSnapshot {
    pub connected: bool,
    pub host: String,
    pub port: u16,
    pub scenes: Vec<String>,
    /// The program scene read back from OBS. `None` while disconnected.
    pub current_scene: Option<String>,
    /// Milliseconds since the Unix epoch when OBS was last queried.
    pub observed_at_ms: u64,
}

/// Result of a requested program-scene switch.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SceneSwitchResult {
    pub requested: String,
    /// True only when a fresh OBS query reported the requested scene as program.
    pub confirmed: bool,
    pub snapshot: ObsSnapshot,
}

struct ActiveConnection {
    host: String,
    port: u16,
    client: obws::Client,
}

#[derive(Default)]
struct ObsInner {
    active: Option<ActiveConnection>,
}

/// Shared native OBS lifecycle state.
///
/// All lifecycle and request operations take the same async lock, so a slow
/// connect can never finish after a newer connect or disconnect and overwrite
/// it: the newest operation always runs last.
pub struct ObsState {
    inner: Mutex<ObsInner>,
    timeouts: Timeouts,
}

impl Default for ObsState {
    fn default() -> Self {
        Self::new()
    }
}

impl ObsState {
    pub fn new() -> Self {
        Self::with_timeouts(Timeouts::default())
    }

    pub fn with_timeouts(timeouts: Timeouts) -> Self {
        Self {
            inner: Mutex::new(ObsInner::default()),
            timeouts,
        }
    }

    /// Connect to OBS on loopback and return a freshly queried snapshot.
    pub async fn connect(
        &self,
        port: u16,
        password: Option<String>,
    ) -> Result<ObsSnapshot, ObsError> {
        validate_port(port)?;
        if let Some(password) = &password {
            if password.chars().count() > MAX_PASSWORD_LEN {
                return Err(ObsError::invalid_input("OBS password is too long."));
            }
        }

        let mut inner = self.inner.lock().await;

        // Drop any existing session first so the newest connection always wins.
        if let Some(mut previous) = inner.active.take() {
            previous.client.disconnect().await;
        }

        let (client, host) = connect_loopback(&self.timeouts, port, password.as_deref()).await?;
        let snapshot = read_snapshot(&client, &host, port, self.timeouts.request).await?;
        inner.active = Some(ActiveConnection { host, port, client });
        Ok(snapshot)
    }

    /// Close the current session, if any. Credentials are dropped with it.
    pub async fn disconnect(&self) {
        let mut inner = self.inner.lock().await;
        if let Some(mut active) = inner.active.take() {
            active.client.disconnect().await;
        }
    }

    /// Query OBS for a fresh snapshot, or report a disconnected snapshot.
    ///
    /// A request that shows the connection has been lost clears the session so
    /// stale scene data is never reported as live.
    pub async fn snapshot(&self) -> Result<ObsSnapshot, ObsError> {
        let mut inner = self.inner.lock().await;
        let Some(active) = inner.active.as_ref() else {
            return Ok(disconnected_snapshot());
        };

        let result = read_snapshot(
            &active.client,
            &active.host,
            active.port,
            self.timeouts.request,
        )
        .await;

        if let Err(error) = &result {
            if error.is_disconnect() {
                inner.active = None;
            }
        }
        result
    }

    /// Switch the program scene and verify it against a fresh OBS query.
    pub async fn switch_scene(&self, scene: &str) -> Result<SceneSwitchResult, ObsError> {
        validate_scene_name(scene)?;

        let mut inner = self.inner.lock().await;
        let Some(active) = inner.active.as_ref() else {
            return Err(ObsError::not_connected("Not connected to OBS."));
        };

        let result = do_switch_scene(
            &active.client,
            &active.host,
            active.port,
            self.timeouts.request,
            scene,
        )
        .await;

        if let Err(error) = &result {
            if error.is_disconnect() {
                inner.active = None;
            }
        }
        result
    }
}

fn validate_port(port: u16) -> Result<(), ObsError> {
    if port == 0 {
        return Err(ObsError::invalid_input("Port must be between 1 and 65535."));
    }
    Ok(())
}

fn validate_scene_name(scene: &str) -> Result<(), ObsError> {
    if scene.trim().is_empty() {
        return Err(ObsError::invalid_input("Scene name cannot be empty."));
    }
    if scene.chars().count() > MAX_SCENE_NAME_LEN {
        return Err(ObsError::invalid_input("Scene name is too long."));
    }
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn disconnected_snapshot() -> ObsSnapshot {
    ObsSnapshot {
        connected: false,
        host: "127.0.0.1".to_string(),
        port: DEFAULT_PORT,
        scenes: Vec::new(),
        current_scene: None,
        observed_at_ms: now_ms(),
    }
}

async fn connect_loopback(
    timeouts: &Timeouts,
    port: u16,
    password: Option<&str>,
) -> Result<(obws::Client, String), ObsError> {
    let mut last_error = ObsError::unavailable("OBS is not reachable on loopback.");

    for host in LOOPBACK_HOSTS {
        let config = ConnectConfig {
            host,
            port,
            password,
            event_subscriptions: Some(EventSubscription::NONE),
            broadcast_capacity: obws::client::DEFAULT_BROADCAST_CAPACITY,
            connect_timeout: timeouts.connect,
            dangerous: None,
        };

        // The extra second lets obws raise its own timeout before this outer one.
        let attempt = tokio::time::timeout(
            timeouts.connect + Duration::from_secs(1),
            obws::Client::connect_with_config(config),
        )
        .await;

        match attempt {
            Ok(Ok(client)) => return Ok((client, host.to_string())),
            Ok(Err(error)) => {
                let error = map_connect_error(error);
                if error_priority(&error) > error_priority(&last_error) {
                    last_error = error;
                }
            }
            Err(_) => {
                if error_priority(&last_error) < 3 {
                    last_error = ObsError::timeout("Timed out connecting to OBS.");
                }
            }
        }

        // A rejected password will be rejected on every loopback host.
        if matches!(last_error, ObsError::AuthRejected { .. }) {
            break;
        }
    }

    Err(last_error)
}

/// Keep the most actionable error when both loopback hosts are tried.
fn error_priority(error: &ObsError) -> u8 {
    match error {
        ObsError::AuthRejected { .. } => 4,
        ObsError::Timeout { .. } => 3,
        ObsError::Unavailable { .. } => 2,
        _ => 1,
    }
}

async fn request<T>(
    timeout: Duration,
    future: impl Future<Output = Result<T, ObwsError>>,
) -> Result<T, ObsError> {
    match tokio::time::timeout(timeout, future).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(map_request_error(error)),
        Err(_) => Err(ObsError::timeout("OBS did not respond in time.")),
    }
}

async fn read_snapshot(
    client: &obws::Client,
    host: &str,
    port: u16,
    timeout: Duration,
) -> Result<ObsSnapshot, ObsError> {
    let scenes = request(timeout, client.scenes().list()).await?;
    let current = request(timeout, client.scenes().current_program_scene()).await?;

    Ok(ObsSnapshot {
        connected: true,
        host: host.to_string(),
        port,
        scenes: scenes
            .scenes
            .iter()
            .map(|scene| scene.id.name.clone())
            .collect(),
        current_scene: Some(current.id.name),
        observed_at_ms: now_ms(),
    })
}

async fn do_switch_scene(
    client: &obws::Client,
    host: &str,
    port: u16,
    timeout: Duration,
    scene: &str,
) -> Result<SceneSwitchResult, ObsError> {
    let scenes = request(timeout, client.scenes().list()).await?;
    let available: Vec<String> = scenes
        .scenes
        .iter()
        .map(|entry| entry.id.name.clone())
        .collect();

    // Validate against the current scene list rather than trusting a server error body.
    if !available.iter().any(|name| name == scene) {
        return Err(ObsError::scene_not_found(format!(
            "OBS has no scene named \"{scene}\"."
        )));
    }

    request(timeout, client.scenes().set_current_program_scene(scene)).await?;
    let current = request(timeout, client.scenes().current_program_scene()).await?;
    let current_scene = Some(current.id.name);
    let confirmed = current_scene.as_deref() == Some(scene);

    Ok(SceneSwitchResult {
        requested: scene.to_string(),
        confirmed,
        snapshot: ObsSnapshot {
            connected: true,
            host: host.to_string(),
            port,
            scenes: available,
            current_scene,
            observed_at_ms: now_ms(),
        },
    })
}

fn map_connect_error(error: ObwsError) -> ObsError {
    match error {
        ObwsError::Timeout => ObsError::timeout("Timed out connecting to OBS."),
        ObwsError::Connect(_) => ObsError::unavailable("OBS is not reachable on this port."),
        ObwsError::Handshake(handshake) => match handshake {
            HandshakeError::ConnectionClosed(Some(details)) if u16::from(details.code) == 4009 => {
                ObsError::auth_rejected("OBS rejected the password.")
            }
            HandshakeError::NoHello => {
                ObsError::timeout("OBS did not complete the WebSocket handshake.")
            }
            _ => ObsError::unavailable("OBS did not accept the connection."),
        },
        ObwsError::ObsStudioVersion(..)
        | ObwsError::ObsWebsocketVersion(..)
        | ObwsError::RpcVersion { .. } => ObsError::unavailable(
            "The installed OBS Studio or obs-websocket version is not supported.",
        ),
        _ => ObsError::request_failed("OBS connection failed."),
    }
}

fn map_request_error(error: ObwsError) -> ObsError {
    match error {
        ObwsError::Timeout => ObsError::timeout("OBS did not respond in time."),
        ObwsError::Api { .. } => ObsError::request_failed("OBS rejected the request."),
        ObwsError::Send(_) | ObwsError::ReceiveMessage(_) | ObwsError::Disconnected => {
            ObsError::disconnected("The OBS connection was interrupted.")
        }
        _ => ObsError::request_failed("OBS request failed."),
    }
}
