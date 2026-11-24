//! Private loopback HTTP/WebSocket service for the phone PWA.
//!
//! The service is explicitly started from the native desktop shell. It binds
//! only loopback, serves the bundled PWA and a narrow read-only API from the
//! configured public origin, and executes only saved deck actions. It has no
//! HTTP admin routes: invitations and device approval happen through Tauri
//! commands only.
//!
//! Session credentials are in-memory only. Stopping the service clears the
//! registry, so every device must pair again after a restart.

use std::collections::{HashMap, VecDeque};
use std::fmt::Write as _;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::to_bytes;
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use futures_util::{Sink, SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha1_smol::Sha1;
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, Mutex, OwnedSemaphorePermit, Semaphore};
use tokio_websockets::{CloseCode, Limits as WsLimits, Message, ServerBuilder};
use url::Url;

use crate::deck::{ControlAction, DeckSnapshot, DeckStore};
use crate::obs::ObsState;
use crate::system::SystemState;
use crate::plugin::PluginState;
use crate::actions::{command_value, find_control, interrupted_result, validate_action_value, validate_command_fields, ActionDispatcher};
pub use crate::actions::{CommandResult, CommandState};

/// Default loopback port. The listener is never exposed on a LAN interface.
pub const DEFAULT_PORT: u16 = 45829;
/// HttpOnly device cookie. The `__Host-` prefix requires Secure, Path=/, and no Domain.
pub const COOKIE_NAME: &str = "__Host-deck-device";
const PROTOCOL_VERSION: u8 = 1;
const WEBSOCKET_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const PUBLIC_CSP: &str = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

/// Bounded service limits. Tests may lower these; production uses `Default`.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_body_bytes: usize,
    pub max_pair_attempts: usize,
    pub pair_window: Duration,
    pub invitation_ttl: Duration,
    pub pending_ttl: Duration,
    pub max_pending: usize,
    pub max_devices: usize,
    pub max_approved: usize,
    pub command_cache: usize,
    pub command_ttl: Duration,
    pub command_rate: usize,
    pub command_window: Duration,
    pub max_inflight_commands: usize,
    pub max_sockets: usize,
    pub max_socket_payload: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_body_bytes: 16 * 1024,
            max_pair_attempts: 12,
            pair_window: Duration::from_secs(60),
            invitation_ttl: Duration::from_secs(120),
            pending_ttl: Duration::from_secs(10 * 60),
            max_pending: 16,
            max_devices: 64,
            max_approved: 32,
            command_cache: 256,
            command_ttl: Duration::from_secs(5 * 60),
            command_rate: 12,
            command_window: Duration::from_secs(10),
            max_inflight_commands: 4,
            max_sockets: 32,
            max_socket_payload: 512 * 1024,
        }
    }
}

/// Injectable clock so tests can exercise expiry without sleeping for minutes.
pub trait Clock: Send + Sync + 'static {
    fn now(&self) -> Instant;
    fn now_ms(&self) -> u64;
}

/// Production clock.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }

    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0)
    }
}

/// A public static asset returned by the injected provider.
#[derive(Debug, Clone)]
pub struct PublicAsset {
    pub bytes: Vec<u8>,
    pub mime: String,
}

/// Narrow asset resolver. The Tauri app supplies its bundled resolver; tests
/// supply a tiny in-memory map. Only the exact public paths below are served.
pub trait AssetProvider: Send + Sync + 'static {
    fn get(&self, path: &str) -> Option<PublicAsset>;
}

/// External HTTPS reverse-proxy configuration, NOT a listener/TLS setting.
/// Both modes always bind only IPv4 loopback; local_https requires a separately
/// configured LAN proxy with a certificate trusted by the phone.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionMode { #[default] Tailscale, LocalHttps }

/// Configuration for one service instance. It is assembled by the native admin
/// command from the same shared adapter instances the desktop UI uses.
pub struct ServiceConfig {
    pub origin: String,
    pub mode: ConnectionMode,
    pub port: u16,
    pub deck: Arc<DeckStore>,
    pub actions: Arc<ActionDispatcher>,
    pub assets: Arc<dyn AssetProvider>,
    pub clock: Arc<dyn Clock>,
    pub limits: Limits,
}

impl ServiceConfig {
    pub fn new(
        origin: impl Into<String>,
        deck: Arc<DeckStore>,
        obs: Arc<ObsState>,
        system: Arc<SystemState>,
        plugin: Arc<PluginState>,
        assets: Arc<dyn AssetProvider>,
    ) -> Self {
        Self {
            origin: origin.into(),
            mode: ConnectionMode::default(),
            port: DEFAULT_PORT,
            deck,
            actions: Arc::new(ActionDispatcher::new(obs, system, plugin)),
            assets,
            clock: Arc::new(SystemClock),
            limits: Limits::default(),
        }
    }
}

/// Sanitized admin error returned to the native shell.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RemoteError {
    NotRunning { message: String },
    AlreadyRunning { message: String },
    InvalidOrigin { message: String },
    Bind { message: String },
    Conflict { message: String },
    NotFound { message: String },
    Unavailable { message: String },
    Internal { message: String },
}

impl RemoteError {
    fn not_running() -> Self {
        Self::NotRunning {
            message: "The private phone service is not running.".to_string(),
        }
    }

    fn already_running() -> Self {
        Self::AlreadyRunning {
            message: "The private phone service is already running.".to_string(),
        }
    }

    fn invalid_origin(mode: ConnectionMode) -> Self {
        Self::InvalidOrigin {
            message: match mode {
                ConnectionMode::Tailscale => "Use a valid HTTPS .ts.net origin on port 443, without credentials, path, query or fragment.",
                ConnectionMode::LocalHttps => "Use an HTTPS origin for a private IPv4, local IPv6, or .local/.lan/.home.arpa hostname, with port 1–65535 and no credentials, path, query or fragment. Configure a trusted-certificate LAN reverse proxy separately.",
            }.to_string(),
        }
    }

    fn bind() -> Self {
        Self::Bind {
            message: "Could not bind the private phone service to 127.0.0.1. Check whether the port is already in use.".to_string(),
        }
    }

    fn internal() -> Self {
        Self::Internal {
            message: "The private phone service could not complete that operation.".to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceStatus {
    Pending,
    Approved,
    Denied,
    Revoked,
    Expired,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub request_id: String,
    pub name: String,
    pub status: DeviceStatus,
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitationView {
    pub invitation: String,
    pub url: String,
    pub expires_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    pub running: bool,
    pub mode: Option<ConnectionMode>,
    pub origin: Option<String>,
    pub port: Option<u16>,
    pub pending_devices: usize,
    pub approved_devices: usize,
    pub connected_sockets: usize,
}

impl RemoteStatus {
    fn stopped() -> Self {
        Self {
            running: false,
            mode: None,
            origin: None,
            port: None,
            pending_devices: 0,
            approved_devices: 0,
            connected_sockets: 0,
        }
    }
}

#[derive(Debug, Clone)]
struct DeviceRecord {
    request_id: String,
    name: String,
    status: DeviceStatus,
    created_at: Instant,
    created_at_ms: u64,
    terminal_at: Option<Instant>,
    command_times: VecDeque<Instant>,
}

#[derive(Debug, Clone)]
struct InvitationRecord {
    hash: [u8; 32],
    expires_at: Instant,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CommandKey {
    device_id: String,
    command_id: String,
}

#[derive(Debug, Clone)]
struct CommandRecord {
    fingerprint: String,
    result: CommandResult,
    completed_at: Option<Instant>,
}

#[derive(Debug, Default)]
struct Registry {
    devices: HashMap<[u8; 32], DeviceRecord>,
    invitation: Option<InvitationRecord>,
    pair_attempts: VecDeque<Instant>,
    commands: HashMap<CommandKey, CommandRecord>,
}

impl Registry {
    fn prune(&mut self, now: Instant, limits: &Limits) {
        self.pair_attempts
            .retain(|attempt| now.duration_since(*attempt) <= limits.pair_window);

        if let Some(invitation) = &self.invitation {
            if now >= invitation.expires_at {
                self.invitation = None;
            }
        }

        for device in self.devices.values_mut() {
            if device.status == DeviceStatus::Pending
                && now.duration_since(device.created_at) > limits.pending_ttl
            {
                device.status = DeviceStatus::Expired;
                device.terminal_at = Some(now);
            }
        }

        let mut expired = Vec::new();
        for (hash, device) in &self.devices {
            if let Some(terminal_at) = device.terminal_at {
                if now.duration_since(terminal_at) > limits.pending_ttl {
                    expired.push(*hash);
                }
            }
        }
        for hash in expired {
            self.devices.remove(&hash);
        }

        self.commands.retain(|_, record| {
            record
                .completed_at
                .map(|completed| now.duration_since(completed) <= limits.command_ttl)
                .unwrap_or(true)
        });
    }

    fn count_status(&self, status: DeviceStatus) -> usize {
        self.devices
            .values()
            .filter(|device| device.status == status)
            .count()
    }

    fn find_by_request_id(&self, request_id: &str) -> Option<[u8; 32]> {
        self.devices
            .iter()
            .find(|(_, device)| device.request_id == request_id)
            .map(|(hash, _)| *hash)
    }

    fn view(device: &DeviceRecord) -> DeviceView {
        DeviceView {
            request_id: device.request_id.clone(),
            name: device.name.clone(),
            status: device.status,
            created_at_ms: device.created_at_ms,
        }
    }
}

struct AuthDevice {
    hash: [u8; 32],
    record: DeviceRecord,
}

struct Inner {
    origin: String,
    mode: ConnectionMode,
    allowed_hosts: Vec<String>,
    port: u16,
    deck: Arc<DeckStore>,
    actions: Arc<ActionDispatcher>,
    assets: Arc<dyn AssetProvider>,
    clock: Arc<dyn Clock>,
    limits: Limits,
    registry: Mutex<Registry>,
    shutdown: broadcast::Sender<()>,
    revoke: broadcast::Sender<String>,
    command_slots: Arc<Semaphore>,
    socket_slots: Arc<Semaphore>,
    connected_sockets: AtomicUsize,
    stopped: AtomicBool,
}

impl Inner {
    async fn authenticate(&self, headers: &HeaderMap) -> Result<AuthDevice, ApiError> {
        let token = cookie_token(headers)
            .ok_or_else(|| ApiError::unauthorized("A valid device cookie is required."))?;
        let hash = hash_token(&token);
        let now = self.clock.now();
        let mut registry = self.registry.lock().await;
        registry.prune(now, &self.limits);
        match registry.devices.get(&hash) {
            Some(device) if device.status == DeviceStatus::Approved => Ok(AuthDevice {
                hash,
                record: device.clone(),
            }),
            Some(device) if device.status == DeviceStatus::Pending => Err(ApiError::forbidden(
                "This device is waiting for desktop approval.",
            )),
            Some(device)
                if matches!(device.status, DeviceStatus::Denied | DeviceStatus::Expired) =>
            {
                Err(ApiError::forbidden("This device request was not approved."))
            }
            Some(_) => Err(ApiError::unauthorized(
                "This device credential is no longer valid.",
            )),
            None => Err(ApiError::unauthorized(
                "This device credential is no longer valid.",
            )),
        }
    }

    async fn is_approved(&self, hash: &[u8; 32]) -> bool {
        let now = self.clock.now();
        let mut registry = self.registry.lock().await;
        registry.prune(now, &self.limits);
        registry
            .devices
            .get(hash)
            .map(|device| device.status == DeviceStatus::Approved)
            .unwrap_or(false)
    }

    fn check_host(&self, headers: &HeaderMap) -> Result<(), ApiError> {
        let host = single_header(headers, header::HOST)
            .ok_or_else(|| ApiError::bad_request("A single valid Host header is required."))?;
        if self
            .allowed_hosts
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(host))
        {
            Ok(())
        } else {
            Err(ApiError::bad_request("The Host header is not allowed."))
        }
    }

    fn check_origin(&self, headers: &HeaderMap) -> Result<(), ApiError> {
        let origin = single_header(headers, header::ORIGIN)
            .ok_or_else(|| ApiError::forbidden("A matching Origin header is required."))?;
        if origin == self.origin {
            Ok(())
        } else {
            Err(ApiError::forbidden("The Origin header is not allowed."))
        }
    }
}

/// A running service. Dropping it without `stop` detaches the server task.
pub struct RunningService {
    inner: Arc<Inner>,
    handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl RunningService {
    pub fn port(&self) -> u16 {
        self.inner.port
    }

    pub async fn status(&self) -> RemoteStatus {
        let now = self.inner.clock.now();
        let mut registry = self.inner.registry.lock().await;
        registry.prune(now, &self.inner.limits);
        RemoteStatus {
            running: true,
            mode: Some(self.inner.mode),
            origin: Some(self.inner.origin.clone()),
            port: Some(self.inner.port),
            pending_devices: registry.count_status(DeviceStatus::Pending),
            approved_devices: registry.count_status(DeviceStatus::Approved),
            connected_sockets: self.inner.connected_sockets.load(Ordering::Relaxed),
        }
    }

    pub async fn create_invitation(&self) -> Result<InvitationView, RemoteError> {
        let now = self.inner.clock.now();
        let mut registry = self.inner.registry.lock().await;
        registry.prune(now, &self.inner.limits);
        if let Some(invitation) = &registry.invitation {
            if now < invitation.expires_at {
                return Err(RemoteError::Conflict {
                    message: "An invitation is already active.".to_string(),
                });
            }
        }
        let invitation = random_hex(32).map_err(|_| RemoteError::internal())?;
        let expires_at = now + self.inner.limits.invitation_ttl;
        let expires_at_ms =
            self.inner.clock.now_ms() + self.inner.limits.invitation_ttl.as_millis() as u64;
        registry.invitation = Some(InvitationRecord {
            hash: hash_token(&invitation),
            expires_at,
        });
        Ok(InvitationView {
            url: format!("{}/#/pair?invite={invitation}", self.inner.origin),
            invitation,
            expires_at_ms,
        })
    }

    pub async fn list_devices(&self) -> Result<Vec<DeviceView>, RemoteError> {
        let now = self.inner.clock.now();
        let mut registry = self.inner.registry.lock().await;
        registry.prune(now, &self.inner.limits);
        let mut devices: Vec<_> = registry
            .devices
            .values()
            .filter(|device| {
                matches!(
                    device.status,
                    DeviceStatus::Pending | DeviceStatus::Approved
                )
            })
            .map(Registry::view)
            .collect();
        devices.sort_by_key(|device| device.created_at_ms);
        Ok(devices)
    }

    pub async fn approve_device(&self, request_id: &str) -> Result<DeviceView, RemoteError> {
        let now = self.inner.clock.now();
        let mut registry = self.inner.registry.lock().await;
        registry.prune(now, &self.inner.limits);
        let hash =
            registry
                .find_by_request_id(request_id)
                .ok_or_else(|| RemoteError::NotFound {
                    message: "The device request was not found.".to_string(),
                })?;
        if registry.count_status(DeviceStatus::Approved) >= self.inner.limits.max_approved {
            return Err(RemoteError::Conflict {
                message: "The approved device limit is reached.".to_string(),
            });
        }
        let device = registry
            .devices
            .get_mut(&hash)
            .ok_or_else(|| RemoteError::NotFound {
                message: "The device request was not found.".to_string(),
            })?;
        if device.status != DeviceStatus::Pending {
            return Err(RemoteError::Conflict {
                message: "The device request is not pending.".to_string(),
            });
        }
        device.status = DeviceStatus::Approved;
        device.terminal_at = None;
        Ok(Registry::view(device))
    }

    pub async fn deny_device(&self, request_id: &str) -> Result<DeviceView, RemoteError> {
        let now = self.inner.clock.now();
        let mut registry = self.inner.registry.lock().await;
        registry.prune(now, &self.inner.limits);
        let hash =
            registry
                .find_by_request_id(request_id)
                .ok_or_else(|| RemoteError::NotFound {
                    message: "The device request was not found.".to_string(),
                })?;
        let device = registry
            .devices
            .get_mut(&hash)
            .ok_or_else(|| RemoteError::NotFound {
                message: "The device request was not found.".to_string(),
            })?;
        if device.status != DeviceStatus::Pending {
            return Err(RemoteError::Conflict {
                message: "The device request is not pending.".to_string(),
            });
        }
        device.status = DeviceStatus::Denied;
        device.terminal_at = Some(now);
        Ok(Registry::view(device))
    }

    pub async fn revoke_device(&self, request_id: &str) -> Result<DeviceView, RemoteError> {
        let now = self.inner.clock.now();
        let mut registry = self.inner.registry.lock().await;
        registry.prune(now, &self.inner.limits);
        let hash =
            registry
                .find_by_request_id(request_id)
                .ok_or_else(|| RemoteError::NotFound {
                    message: "The device was not found.".to_string(),
                })?;
        let device = registry
            .devices
            .get_mut(&hash)
            .ok_or_else(|| RemoteError::NotFound {
                message: "The device was not found.".to_string(),
            })?;
        if device.status != DeviceStatus::Approved {
            return Err(RemoteError::Conflict {
                message: "The device is not approved.".to_string(),
            });
        }
        device.status = DeviceStatus::Revoked;
        device.terminal_at = Some(now);
        let request_id = device.request_id.clone();
        let view = Registry::view(device);
        drop(registry);
        let _ = self.inner.revoke.send(request_id);
        Ok(view)
    }

    pub async fn stop(&self) {
        self.inner.stopped.store(true, Ordering::SeqCst);
        let _ = self.inner.shutdown.send(());
        {
            let mut registry = self.inner.registry.lock().await;
            *registry = Registry::default();
        }
        let mut handle = self.handle.lock().await;
        if let Some(mut handle) = handle.take() {
            if tokio::time::timeout(Duration::from_secs(3), &mut handle)
                .await
                .is_err()
            {
                handle.abort();
            }
        }
        // Give upgraded sockets a moment to observe the shutdown broadcast and
        // close. The registry is already cleared, so this is only connection cleanup.
        let deadline = Instant::now() + Duration::from_secs(2);
        while self.inner.connected_sockets.load(Ordering::Relaxed) > 0 && Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

/// Native-owned admin handle. It is not exposed over HTTP.
#[derive(Default)]
pub struct RemoteAdmin {
    running: Mutex<Option<RunningService>>,
}

impl RemoteAdmin {
    pub async fn start(&self, config: ServiceConfig) -> Result<RemoteStatus, RemoteError> {
        let mut running = self.running.lock().await;
        if running.is_some() {
            return Err(RemoteError::already_running());
        }
        let service = start(config).await?;
        let status = service.status().await;
        *running = Some(service);
        Ok(status)
    }

    pub async fn stop(&self) -> RemoteStatus {
        let mut running = self.running.lock().await;
        if let Some(service) = running.take() {
            service.stop().await;
        }
        RemoteStatus::stopped()
    }

    pub async fn status(&self) -> RemoteStatus {
        let running = self.running.lock().await;
        match running.as_ref() {
            Some(service) => service.status().await,
            None => RemoteStatus::stopped(),
        }
    }

    pub async fn create_invitation(&self) -> Result<InvitationView, RemoteError> {
        let running = self.running.lock().await;
        running
            .as_ref()
            .ok_or_else(RemoteError::not_running)?
            .create_invitation()
            .await
    }

    pub async fn list_devices(&self) -> Result<Vec<DeviceView>, RemoteError> {
        let running = self.running.lock().await;
        running
            .as_ref()
            .ok_or_else(RemoteError::not_running)?
            .list_devices()
            .await
    }

    pub async fn approve_device(&self, request_id: &str) -> Result<DeviceView, RemoteError> {
        let running = self.running.lock().await;
        running
            .as_ref()
            .ok_or_else(RemoteError::not_running)?
            .approve_device(request_id)
            .await
    }

    pub async fn deny_device(&self, request_id: &str) -> Result<DeviceView, RemoteError> {
        let running = self.running.lock().await;
        running
            .as_ref()
            .ok_or_else(RemoteError::not_running)?
            .deny_device(request_id)
            .await
    }

    pub async fn revoke_device(&self, request_id: &str) -> Result<DeviceView, RemoteError> {
        let running = self.running.lock().await;
        running
            .as_ref()
            .ok_or_else(RemoteError::not_running)?
            .revoke_device(request_id)
            .await
    }
}

/// Start the listener. The caller owns the returned service and must stop it.
pub async fn start(config: ServiceConfig) -> Result<RunningService, RemoteError> {
    let origin_url = validate_origin(&config.origin, config.mode)?;
    // URL's origin serializer preserves non-default ports and IPv6 brackets,
    // lowercases DNS, and removes only the equivalent default HTTPS port.
    let origin = origin_url.origin().ascii_serialization();
    let listener = bind_loopback(config.port).await?;
    let port = listener
        .local_addr()
        .map_err(|_| RemoteError::bind())?
        .port();
    let allowed_hosts = allowed_hosts(&origin_url, port);
    let (shutdown, _) = broadcast::channel(8);
    let (revoke, _) = broadcast::channel(64);
    let inner = Arc::new(Inner {
        origin,
        mode: config.mode,
        allowed_hosts,
        port,
        deck: config.deck,
        actions: config.actions,
        assets: config.assets,
        clock: config.clock,
        limits: config.limits,
        registry: Mutex::new(Registry::default()),
        shutdown,
        revoke,
        command_slots: Arc::new(Semaphore::new(config.limits.max_inflight_commands)),
        socket_slots: Arc::new(Semaphore::new(config.limits.max_sockets)),
        connected_sockets: AtomicUsize::new(0),
        stopped: AtomicBool::new(false),
    });

    let router = router(Arc::clone(&inner));
    let shutdown = inner.shutdown.clone();
    let handle = tokio::spawn(async move {
        let mut shutdown = shutdown.subscribe();
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = shutdown.recv().await;
            })
            .await;
    });

    Ok(RunningService {
        inner,
        handle: Mutex::new(Some(handle)),
    })
}

async fn bind_loopback(port: u16) -> Result<TcpListener, RemoteError> {
    TcpListener::bind(("127.0.0.1", port)).await.map_err(|_| RemoteError::bind())
}

#[cfg(test)]
mod transport_tests {
    #[tokio::test]
    async fn listener_is_ipv4_loopback_not_a_lan_or_wildcard_bind() {
        let listener = super::bind_loopback(0).await.unwrap();
        let address = listener.local_addr().unwrap();
        assert_eq!(address.ip(), std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST));
        assert_ne!(address.port(), 0);
    }
}

fn validate_origin(value: &str, mode: ConnectionMode) -> Result<Url, RemoteError> {
    let bad = || RemoteError::invalid_origin(mode);
    // Reject URL parser repairs/aliases before parsing: whitespace, escapes,
    // userinfo, backslashes, Unicode/IDNA input, normalized paths and empty ports.
    if value.len() > 2048 || !value.is_ascii()
        || !value.get(..8).is_some_and(|s| s.eq_ignore_ascii_case("https://")) {
        return Err(bad());
    }
    let rest = &value[8..];
    let authority = rest.strip_suffix('/').unwrap_or(rest);
    if authority.is_empty() || !authority.bytes().all(|b| b.is_ascii_alphanumeric() || b"-.[]:".contains(&b)) {
        return Err(bad());
    }
    let (raw_host, raw_port) = if authority.starts_with('[') {
        let end = authority.find(']').ok_or_else(bad)?;
        let suffix = &authority[end + 1..];
        (&authority[..=end], if suffix.is_empty() { None } else { Some(suffix.strip_prefix(':').ok_or_else(bad)?) })
    } else {
        let mut parts = authority.split(':');
        let host = parts.next().ok_or_else(bad)?;
        let port = parts.next();
        if parts.next().is_some() { return Err(bad()); }
        (host, port)
    };
    if let Some(port) = raw_port {
        if port.is_empty() || (port.len() > 1 && port.starts_with('0'))
            || !port.bytes().all(|b| b.is_ascii_digit())
            || !port.parse::<u16>().is_ok_and(|p| p != 0) { return Err(bad()); }
    }
    let url = Url::parse(value).map_err(|_| bad())?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some()
        || url.path() != "/" || url.query().is_some() || url.fragment().is_some()
        || (mode == ConnectionMode::Tailscale && url.port().is_some()) {
        return Err(bad());
    }
    let allowed = match url.host() {
        Some(url::Host::Ipv4(ip)) => mode == ConnectionMode::LocalHttps && ip.is_private()
            && raw_host == ip.to_string(), // No octal, shorthand, hex or integer IPv4 aliases.
        Some(url::Host::Ipv6(ip)) => mode == ConnectionMode::LocalHttps
            && ((ip.segments()[0] & 0xfe00) == 0xfc00 || (ip.segments()[0] & 0xffc0) == 0xfe80),
        Some(url::Host::Domain(host)) => {
            let valid_dns = host.len() <= 253 && raw_host.eq_ignore_ascii_case(host)
                && host.split('.').all(|label| !label.is_empty() && label.len() <= 63
                    && label.as_bytes()[0].is_ascii_alphanumeric()
                    && label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
                    && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                    && label != "localhost");
            valid_dns && match mode {
                ConnectionMode::Tailscale => host.ends_with(".ts.net"),
                ConnectionMode::LocalHttps => [".local", ".lan", ".home.arpa"].iter().any(|suffix| host.ends_with(suffix)),
            }
        }
        None => false,
    };
    if !allowed { return Err(bad()); }
    Ok(url)
}

fn allowed_hosts(url: &Url, port: u16) -> Vec<String> {
    let origin = url.origin().ascii_serialization();
    let authority = origin.strip_prefix("https://").expect("validated HTTPS origin");
    let mut hosts = vec![authority.to_string(), format!("127.0.0.1:{port}")];
    if url.port().is_none() { hosts.push(format!("{authority}:443")); }
    hosts
}

fn router(inner: Arc<Inner>) -> Router {
    let body_limit = inner.limits.max_body_bytes;
    Router::new()
        .route("/api/v1/pair", post(pair))
        .route("/api/v1/pair/status", get(pair_status))
        .route("/api/v1/state", get(state))
        .route("/api/v1/events", get(events))
        .route("/api/v1/commands", post(command))
        .route("/api/v1/commands/{id}", get(command_result))
        .fallback(fallback)
        .layer(DefaultBodyLimit::max(body_limit))
        .layer(middleware::from_fn_with_state(inner.clone(), guard))
        .with_state(inner)
}

async fn guard(State(inner): State<Arc<Inner>>, request: Request, next: Next) -> Response {
    let api = request.uri().path().starts_with("/api/");
    let decorate = |mut response: Response| {
        response.headers_mut().insert(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        );
        response.headers_mut().insert(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        );
        if api {
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        }
        response
    };
    if api && inner.stopped.load(Ordering::SeqCst) {
        return decorate(
            ApiError::unavailable("The private phone service is stopping.").into_response(),
        );
    }
    if let Err(error) = inner.check_host(request.headers()) {
        return decorate(error.into_response());
    }
    decorate(next.run(request).await)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PairRequest {
    invitation: String,
    name: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommandRequest {
    id: String,
    revision: u64,
    control_id: String,
    #[serde(default, deserialize_with = "command_value")]
    value: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandFingerprint<'a> {
    id: &'a str,
    control_id: &'a str,
    value: Option<f64>,
}

async fn pair(
    State(inner): State<Arc<Inner>>,
    headers: HeaderMap,
    request: Request,
) -> Result<Response, ApiError> {
    inner.check_origin(&headers)?;
    let request: PairRequest = read_json(inner.as_ref(), request).await?;
    validate_pair_request(&request)?;
    let now = inner.clock.now();
    let mut registry = inner.registry.lock().await;
    registry.prune(now, &inner.limits);
    if registry.pair_attempts.len() >= inner.limits.max_pair_attempts {
        return Err(ApiError::too_many_requests(
            "Too many pairing attempts. Try again later.",
        ));
    }
    registry.pair_attempts.push_back(now);
    if registry.count_status(DeviceStatus::Pending) >= inner.limits.max_pending
        || registry.devices.len() >= inner.limits.max_devices
    {
        return Err(ApiError::too_many_requests(
            "The device registry is full. Try again later.",
        ));
    }
    let invitation = registry
        .invitation
        .as_ref()
        .ok_or_else(|| ApiError::forbidden("The invitation is invalid or expired."))?;
    if now >= invitation.expires_at || invitation.hash != hash_token(&request.invitation) {
        return Err(ApiError::forbidden("The invitation is invalid or expired."));
    }
    registry.invitation = None;

    let token = random_hex(32).map_err(|_| ApiError::internal())?;
    let request_id = random_hex(16).map_err(|_| ApiError::internal())?;
    let device = DeviceRecord {
        request_id: request_id.clone(),
        name: request.name.trim().to_string(),
        status: DeviceStatus::Pending,
        created_at: now,
        created_at_ms: inner.clock.now_ms(),
        terminal_at: None,
        command_times: VecDeque::new(),
    };
    registry.devices.insert(hash_token(&token), device);
    drop(registry);

    let mut response = json_response(
        StatusCode::OK,
        &json!({ "requestId": request_id, "status": "pending" }),
    );
    let cookie = format!("{COOKIE_NAME}={token}; Secure; HttpOnly; SameSite=Strict; Path=/");
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&cookie).map_err(|_| ApiError::internal())?,
    );
    Ok(response)
}

async fn pair_status(
    State(inner): State<Arc<Inner>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let token = cookie_token(&headers)
        .ok_or_else(|| ApiError::unauthorized("A valid device cookie is required."))?;
    let hash = hash_token(&token);
    let now = inner.clock.now();
    let mut registry = inner.registry.lock().await;
    registry.prune(now, &inner.limits);
    let device = registry
        .devices
        .get(&hash)
        .ok_or_else(|| ApiError::unauthorized("This device credential is no longer valid."))?;
    Ok(json_response(
        StatusCode::OK,
        &json!({ "requestId": device.request_id, "status": device.status }),
    ))
}

async fn state(State(inner): State<Arc<Inner>>, headers: HeaderMap) -> Result<Response, ApiError> {
    inner.authenticate(&headers).await?;
    let snapshot = load_saved_deck(inner.as_ref()).await?;
    Ok(json_response(
        StatusCode::OK,
        &json!({
            "protocolVersion": PROTOCOL_VERSION,
            "revision": snapshot.revision,
            "deck": snapshot.deck,
        }),
    ))
}

async fn events(
    State(inner): State<Arc<Inner>>,
    mut request: Request,
) -> Result<Response, ApiError> {
    inner.check_origin(request.headers())?;
    let auth = inner.authenticate(request.headers()).await?;
    let key = validate_upgrade(request.headers())?;
    let permit = inner
        .socket_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::too_many_requests("Too many live connections."))?;
    let accept = websocket_accept(&key);
    let on_upgrade = hyper::upgrade::on(&mut request);
    let device_id = auth.record.request_id.clone();
    let task_inner = Arc::clone(&inner);
    tokio::spawn(async move {
        inner.connected_sockets.fetch_add(1, Ordering::Relaxed);
        let lease = SocketLease {
            inner: Arc::clone(&task_inner),
            _permit: permit,
        };
        let _ = run_socket(task_inner, auth.hash, device_id, on_upgrade).await;
        drop(lease);
    });

    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
    response
        .headers_mut()
        .insert(header::CONNECTION, HeaderValue::from_static("Upgrade"));
    response
        .headers_mut()
        .insert(header::UPGRADE, HeaderValue::from_static("websocket"));
    response.headers_mut().insert(
        header::SEC_WEBSOCKET_ACCEPT,
        HeaderValue::from_str(&accept).map_err(|_| ApiError::internal())?,
    );
    Ok(response)
}

struct SocketLease {
    inner: Arc<Inner>,
    _permit: OwnedSemaphorePermit,
}

impl Drop for SocketLease {
    fn drop(&mut self) {
        self.inner.connected_sockets.fetch_sub(1, Ordering::Relaxed);
    }
}

async fn run_socket(
    inner: Arc<Inner>,
    hash: [u8; 32],
    device_id: String,
    on_upgrade: hyper::upgrade::OnUpgrade,
) -> Result<(), ()> {
    let upgraded = hyper_util::rt::TokioIo::new(on_upgrade.await.map_err(|_| ())?);
    let socket = ServerBuilder::new()
        .limits(WsLimits::default().max_payload_len(Some(inner.limits.max_socket_payload)))
        .serve(upgraded);
    let (mut sink, mut stream) = socket.split();
    let mut shutdown = inner.shutdown.subscribe();
    let mut revoke = inner.revoke.subscribe();
    let mut saved = inner.deck.subscribe();
    // A stop may have happened before this socket subscribed to the broadcast.
    if inner.stopped.load(Ordering::SeqCst) {
        let _ = sink
            .send(Message::close(
                Some(CloseCode::GOING_AWAY),
                "Service stopped",
            ))
            .await;
        return Ok(());
    }

    let initial = match load_saved_deck(inner.as_ref()).await {
        Ok(snapshot) => snapshot,
        Err(_) => {
            let _ = sink
                .send(Message::close(
                    Some(CloseCode::INTERNAL_SERVER_ERROR),
                    "Deck unavailable",
                ))
                .await;
            return Ok(());
        }
    };
    if !inner.is_approved(&hash).await {
        let _ = sink
            .send(Message::close(
                Some(CloseCode::POLICY_VIOLATION),
                "Device is not approved",
            ))
            .await;
        return Ok(());
    }
    if send_snapshot(&mut sink, &initial).await.is_err() {
        return Ok(());
    }

    loop {
        tokio::select! {
            _ = shutdown.recv() => {
                let _ = sink.send(Message::close(Some(CloseCode::GOING_AWAY), "Service stopped")).await;
                break;
            }
            event = revoke.recv() => {
                match event {
                    Ok(request_id) if request_id == device_id => {
                        let _ = sink.send(Message::close(Some(CloseCode::POLICY_VIOLATION), "Device revoked")).await;
                        break;
                    }
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let _ = sink.send(Message::close(Some(CloseCode::POLICY_VIOLATION), "Connection invalidated")).await;
                        break;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            changed = saved.changed() => {
                if changed.is_err() {
                    break;
                }
                if !inner.is_approved(&hash).await {
                    let _ = sink.send(Message::close(Some(CloseCode::POLICY_VIOLATION), "Device revoked")).await;
                    break;
                }
                match load_saved_deck(inner.as_ref()).await {
                    Ok(snapshot) => {
                        if send_snapshot(&mut sink, &snapshot).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => {
                        let _ = sink.send(Message::close(Some(CloseCode::INTERNAL_SERVER_ERROR), "Deck unavailable")).await;
                        break;
                    }
                }
            }
            message = stream.next() => {
                match message {
                    Some(Ok(message)) if message.is_close() => break,
                    Some(Ok(message)) if message.is_ping() => {
                        let payload = message.into_payload();
                        if sink.send(Message::pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) | None => break,
                }
            }
        }
    }
    let _ = sink
        .send(Message::close(Some(CloseCode::NORMAL_CLOSURE), ""))
        .await;
    Ok(())
}

async fn send_snapshot<S>(sink: &mut S, snapshot: &crate::deck::DeckSnapshot) -> Result<(), ()>
where
    S: Sink<Message, Error = tokio_websockets::Error> + Unpin,
{
    let payload = json!({
        "type": "snapshot",
        "protocolVersion": PROTOCOL_VERSION,
        "revision": snapshot.revision,
        "deck": snapshot.deck,
    });
    let text = serde_json::to_string(&payload).map_err(|_| ())?;
    sink.send(Message::text(text)).await.map_err(|_| ())
}

async fn command(
    State(inner): State<Arc<Inner>>,
    headers: HeaderMap,
    request: Request,
) -> Result<Response, ApiError> {
    inner.check_origin(&headers)?;
    let auth = inner.authenticate(&headers).await?;
    let request: CommandRequest = read_json(inner.as_ref(), request).await?;
    validate_command_request(&request)?;
    // Revision is intentionally excluded: a retry with a newer revision still
    // refers to the same reserved command and must not run the effect again.
    let fingerprint = serde_json::to_string(&CommandFingerprint {
        id: &request.id,
        control_id: &request.control_id,
        value: request.value,
    })
    .map_err(|_| ApiError::internal())?;
    let key = CommandKey {
        device_id: auth.record.request_id.clone(),
        command_id: request.id.clone(),
    };

    if let Some(existing) = existing_command(&inner, &key, &fingerprint).await? {
        return Ok(json_response(StatusCode::OK, &existing));
    }

    let permit = inner
        .command_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::too_many_requests("Too many actions are in flight."))?;
    let snapshot = load_saved_deck(inner.as_ref()).await?;
    if snapshot.revision != request.revision {
        return Err(ApiError::conflict(
            "The saved deck changed. Load a fresh snapshot before sending actions.",
        ));
    }
    let control = find_control(&snapshot.deck, &request.control_id)
        .ok_or_else(|| ApiError::bad_request("The control is not in the saved deck."))?;
    validate_action_value(control, request.value).map_err(|error| ApiError::bad_request(error.message))?;

    {
        let now = inner.clock.now();
        let mut registry = inner.registry.lock().await;
        registry.prune(now, &inner.limits);
        if let Some(existing) = registry.commands.get(&key) {
            if existing.fingerprint != fingerprint {
                return Err(ApiError::conflict(
                    "This command ID was already used with different input.",
                ));
            }
            return Ok(json_response(StatusCode::OK, &existing.result));
        }
        if registry.commands.len() >= inner.limits.command_cache {
            return Err(ApiError::too_many_requests(
                "The action result cache is full. Try again later.",
            ));
        }
        let Some(device) = registry.devices.get_mut(&auth.hash) else {
            return Err(ApiError::unauthorized(
                "This device credential is no longer valid.",
            ));
        };
        if device.status != DeviceStatus::Approved {
            return Err(ApiError::unauthorized(
                "This device credential is no longer valid.",
            ));
        }
        device
            .command_times
            .retain(|attempt| now.duration_since(*attempt) <= inner.limits.command_window);
        if device.command_times.len() >= inner.limits.command_rate {
            return Err(ApiError::too_many_requests(
                "Too many actions. Wait a moment and try again.",
            ));
        }
        device.command_times.push_back(now);
        registry.commands.insert(
            key.clone(),
            CommandRecord {
                fingerprint,
                result: CommandResult {
                    id: request.id.clone(),
                    state: CommandState::Pending,
                    code: None,
                    message: "Action accepted.".to_string(),
                    observed: None,
                },
                completed_at: None,
            },
        );
    }

    let mut guard = CommandGuard::new(Arc::clone(&inner), key.clone(), matches!(&control.action, ControlAction::Plugin { .. }));
    let result = inner.actions.execute(&request.id, control, request.value).await
        .map_err(|error| ApiError::bad_request(error.message))?;
    {
        let now = inner.clock.now();
        let mut registry = inner.registry.lock().await;
        registry.prune(now, &inner.limits);
        if let Some(record) = registry.commands.get_mut(&key) {
            record.result = result.clone();
            record.completed_at = Some(now);
        }
    }
    guard.complete();
    drop(permit);
    Ok(json_response(StatusCode::OK, &result))
}

/// Marks a reserved command as unknown if the request future is dropped before
/// the result is recorded. That covers a client disconnect after a possible
/// mutation without claiming the action failed.
struct CommandGuard {
    inner: Arc<Inner>,
    key: CommandKey,
    completed: bool,
    plugin: bool,
}

impl CommandGuard {
    fn new(inner: Arc<Inner>, key: CommandKey, plugin: bool) -> Self {
        Self {
            inner,
            key,
            completed: false,
            plugin,
        }
    }

    fn complete(&mut self) {
        self.completed = true;
    }
}

impl Drop for CommandGuard {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        let inner = Arc::clone(&self.inner);
        let key = self.key.clone();
        let plugin = self.plugin;
        tokio::spawn(async move {
            let now = inner.clock.now();
            let mut registry = inner.registry.lock().await;
            registry.prune(now, &inner.limits);
            if let Some(record) = registry.commands.get_mut(&key) {
                if record.completed_at.is_none() {
                    record.result = interrupted_result(&record.result.id, plugin);
                    record.completed_at = Some(now);
                }
            }
        });
    }
}

async fn existing_command(
    inner: &Inner,
    key: &CommandKey,
    fingerprint: &str,
) -> Result<Option<CommandResult>, ApiError> {
    let now = inner.clock.now();
    let mut registry = inner.registry.lock().await;
    registry.prune(now, &inner.limits);
    if let Some(existing) = registry.commands.get(key) {
        if existing.fingerprint != fingerprint {
            return Err(ApiError::conflict(
                "This command ID was already used with different input.",
            ));
        }
        return Ok(Some(existing.result.clone()));
    }
    Ok(None)
}

async fn command_result(
    State(inner): State<Arc<Inner>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let auth = inner.authenticate(&headers).await?;
    validate_id(&id, "command")?;
    let key = CommandKey {
        device_id: auth.record.request_id,
        command_id: id,
    };
    let now = inner.clock.now();
    let mut registry = inner.registry.lock().await;
    registry.prune(now, &inner.limits);
    let result = registry
        .commands
        .get(&key)
        .map(|record| record.result.clone())
        .ok_or_else(|| ApiError::not_found("The command result is unavailable."))?;
    Ok(json_response(StatusCode::OK, &result))
}

fn validate_pair_request(request: &PairRequest) -> Result<(), ApiError> {
    if request.invitation.len() != 64
        || !request
            .invitation
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(ApiError::bad_request("The invitation is malformed."));
    }
    let name = request.name.trim();
    if name.is_empty() || name.len() > 64 || name.chars().any(char::is_control) {
        return Err(ApiError::bad_request(
            "The device name must be 1 to 64 printable characters.",
        ));
    }
    Ok(())
}

fn validate_command_request(request: &CommandRequest) -> Result<(), ApiError> {
    validate_command_fields(&request.id, &request.control_id, request.value)
        .map_err(|error| ApiError::bad_request(error.message))
}

fn validate_id(value: &str, label: &str) -> Result<(), ApiError> {
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err(ApiError::bad_request(format!("The {label} ID is invalid.")));
    }
    Ok(())
}

fn validate_upgrade(headers: &HeaderMap) -> Result<String, ApiError> {
    let upgrade = single_header(headers, header::UPGRADE)
        .ok_or_else(|| ApiError::bad_request("A WebSocket upgrade is required."))?;
    if !upgrade.eq_ignore_ascii_case("websocket") {
        return Err(ApiError::bad_request("A WebSocket upgrade is required."));
    }
    let connection = single_header(headers, header::CONNECTION)
        .ok_or_else(|| ApiError::bad_request("A WebSocket upgrade is required."))?;
    if !connection
        .split(',')
        .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
    {
        return Err(ApiError::bad_request("A WebSocket upgrade is required."));
    }
    let version = single_header(headers, header::SEC_WEBSOCKET_VERSION)
        .ok_or_else(|| ApiError::bad_request("WebSocket version 13 is required."))?;
    if version != "13" {
        return Err(ApiError::bad_request("WebSocket version 13 is required."));
    }
    let key = single_header(headers, header::SEC_WEBSOCKET_KEY)
        .ok_or_else(|| ApiError::bad_request("A WebSocket key is required."))?;
    if BASE64
        .decode(key)
        .map(|key| key.len() != 16)
        .unwrap_or(true)
    {
        return Err(ApiError::bad_request("The WebSocket key is invalid."));
    }
    Ok(key.to_string())
}

fn websocket_accept(key: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(key.as_bytes());
    hasher.update(WEBSOCKET_GUID.as_bytes());
    BASE64.encode(hasher.digest().bytes())
}

fn cookie_token(headers: &HeaderMap) -> Option<String> {
    let cookie = single_header(headers, header::COOKIE)?;
    let mut found = None;
    for part in cookie.split(';') {
        let mut pair = part.trim().splitn(2, '=');
        let name = pair.next()?.trim();
        let value = pair.next()?.trim();
        if name == COOKIE_NAME {
            if found.is_some() {
                return None;
            }
            if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return None;
            }
            found = Some(value.to_string());
        }
    }
    found
}

fn single_header<'a>(headers: &'a HeaderMap, name: header::HeaderName) -> Option<&'a str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?;
    if values.next().is_some() {
        return None;
    }
    value.to_str().ok()
}

fn hash_token(token: &str) -> [u8; 32] {
    let digest = Sha256::digest(token.as_bytes());
    let mut hash = [0_u8; 32];
    hash.copy_from_slice(&digest);
    hash
}

fn random_hex(bytes: usize) -> Result<String, ()> {
    let mut buffer = vec![0_u8; bytes];
    getrandom::fill(&mut buffer).map_err(|_| ())?;
    let mut output = String::with_capacity(bytes * 2);
    for byte in buffer {
        write!(&mut output, "{byte:02x}").map_err(|_| ())?;
    }
    Ok(output)
}

fn json_response<T: Serialize>(status: StatusCode, value: &T) -> Response {
    let body = serde_json::to_vec(value)
        .unwrap_or_else(|_| b"{\"error\":\"The response could not be encoded.\"}".to_vec());
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn text_response(status: StatusCode, message: &'static str) -> Response {
    let mut response = Response::new(Body::from(message));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response
}

struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, message)
    }

    fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, message)
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, message)
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, message)
    }

    fn too_many_requests(message: impl Into<String>) -> Self {
        Self::new(StatusCode::TOO_MANY_REQUESTS, message)
    }

    fn payload_too_large() -> Self {
        Self::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "The request body is too large.",
        )
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, message)
    }

    fn internal() -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "The private service could not complete the request.",
        )
    }
}

async fn read_json<T: serde::de::DeserializeOwned>(
    inner: &Inner,
    request: Request,
) -> Result<T, ApiError> {
    let bytes = to_bytes(request.into_body(), inner.limits.max_body_bytes)
        .await
        .map_err(|_| ApiError::payload_too_large())?;
    serde_json::from_slice(&bytes).map_err(|_| ApiError::bad_request("The JSON body is invalid."))
}

async fn load_saved_deck(inner: &Inner) -> Result<DeckSnapshot, ApiError> {
    let snapshot = inner.deck.load().await.map_err(|_| ApiError::internal())?;
    if !snapshot.exists {
        return Err(ApiError::unavailable(
            "The desktop deck has not been saved yet.",
        ));
    }
    Ok(snapshot)
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        json_response(self.status, &json!({ "error": self.message }))
    }
}

async fn fallback(State(inner): State<Arc<Inner>>, uri: Uri) -> Response {
    if uri.path().starts_with("/api/") {
        return ApiError::not_found("Unknown API route.").into_response();
    }
    let Some(path) = public_asset_path(uri.path()) else {
        return text_response(StatusCode::NOT_FOUND, "Not found.");
    };
    let Some(mut asset) = inner.assets.get(&path) else {
        return text_response(StatusCode::NOT_FOUND, "Not found.");
    };
    if path == "index.html" {
        let Ok(html) = String::from_utf8(asset.bytes) else {
            return ApiError::unavailable("The phone app is unavailable in this build.")
                .into_response();
        };
        if !html.contains("data-zdeck-local") {
            return ApiError::unavailable("The phone app is unavailable in this build.")
                .into_response();
        }
        // UI routing only: API authentication still requires an approved device cookie.
        asset.bytes = html
            .replacen("data-zdeck-local", "data-zdeck-remote", 1)
            .into_bytes();
    }
    let mut response = Response::new(Body::from(asset.bytes));
    let mime = HeaderValue::from_str(&asset.mime)
        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream"));
    response.headers_mut().insert(header::CONTENT_TYPE, mime);
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(
            if path.starts_with("assets/") || path.starts_with("icons/") {
                "public, max-age=31536000, immutable"
            } else {
                "no-cache"
            },
        ),
    );
    // Safari may not map connect-src 'self' to the matching WebSocket scheme.
    let socket_origin = inner.origin.replacen("https://", "wss://", 1);
    let policy = PUBLIC_CSP.replace(
        "connect-src 'self';",
        &format!("connect-src 'self' {socket_origin};"),
    );
    let Ok(policy) = HeaderValue::from_str(&policy) else {
        return ApiError::internal().into_response();
    };
    response
        .headers_mut()
        .insert(header::CONTENT_SECURITY_POLICY, policy);
    response
}

fn public_asset_path(path: &str) -> Option<String> {
    if path == "/" || path == "/index.html" {
        return Some("index.html".to_string());
    }
    if path == "/manifest.webmanifest" {
        return Some("manifest.webmanifest".to_string());
    }
    if path == "/sw.js" {
        return Some("sw.js".to_string());
    }
    for prefix in ["/icons/", "/assets/"] {
        if let Some(name) = path.strip_prefix(prefix) {
            if safe_asset_name(name) {
                return Some(format!("{}{name}", prefix.trim_start_matches('/')));
            }
            return None;
        }
    }
    None
}

fn safe_asset_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && !name.contains("..")
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}
