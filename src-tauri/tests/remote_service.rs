//! Loopback HTTP/WebSocket tests for the private phone service.
//!
//! Every request goes over a real TCP socket to a temporary service instance.
//! The HTTPS proxy is not involved: tests set the public `Host`/`Origin`
//! headers manually to model what Tailscale Serve would forward. No live OBS,
//! audio, media, or phone device is touched.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use deck_lib::deck::{default_deck, DeckStore, DECK_FILE_NAME};
use deck_lib::obs::{ObsState, Timeouts as ObsTimeouts};
use deck_lib::remote::{
    start, AssetProvider, Clock, DeviceStatus, Limits, PublicAsset, RemoteAdmin, RemoteError,
    RunningService, ServiceConfig, COOKIE_NAME, DEFAULT_PORT,
};
use deck_lib::system::{
    CommandRunner, CommandSpec, MediaStatus, RunOutput, SystemError, SystemState,
    Timeouts as SystemTimeouts,
};
use futures_util::{SinkExt, StreamExt};
use http::header;
use http::HeaderValue;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_websockets::{ClientBuilder, Message, ServerBuilder, WebSocketStream};

const ORIGIN: &str = "https://deck.tailnet.ts.net";
const PUBLIC_HOST: &str = "deck.tailnet.ts.net";

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(label: &str) -> Self {
        let unique = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "deck-remote-{label}-{}-{unique}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("create temp dir");
        Self { path }
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

struct TestClock {
    base: Instant,
    base_ms: u64,
    offset_ms: AtomicU64,
}

impl TestClock {
    fn new() -> Self {
        Self {
            base: Instant::now(),
            base_ms: 1_700_000_000_000,
            offset_ms: AtomicU64::new(0),
        }
    }

    fn advance(&self, millis: u64) {
        self.offset_ms.fetch_add(millis, Ordering::SeqCst);
    }
}

impl Clock for TestClock {
    fn now(&self) -> Instant {
        self.base + Duration::from_millis(self.offset_ms.load(Ordering::SeqCst))
    }

    fn now_ms(&self) -> u64 {
        self.base_ms + self.offset_ms.load(Ordering::SeqCst)
    }
}

struct FakeAssets {
    map: HashMap<String, PublicAsset>,
}

impl FakeAssets {
    fn new() -> Self {
        let mut map = HashMap::new();
        map.insert(
            "index.html".to_string(),
            PublicAsset {
                bytes: b"<!doctype html><html data-zdeck-local><head><title>zDeck</title></head><body></body></html>".to_vec(),
                mime: "text/html".to_string(),
            },
        );
        map.insert(
            "manifest.webmanifest".to_string(),
            PublicAsset {
                bytes: b"{}".to_vec(),
                mime: "application/manifest+json".to_string(),
            },
        );
        map.insert(
            "sw.js".to_string(),
            PublicAsset {
                bytes: b"self.addEventListener('install',()=>{});".to_vec(),
                mime: "text/javascript".to_string(),
            },
        );
        map.insert(
            "assets/app.js".to_string(),
            PublicAsset {
                bytes: b"console.log('deck');".to_vec(),
                mime: "text/javascript".to_string(),
            },
        );
        map.insert(
            "icons/icon.png".to_string(),
            PublicAsset {
                bytes: vec![0x89, b'P', b'N', b'G'],
                mime: "image/png".to_string(),
            },
        );
        Self { map }
    }
}

impl AssetProvider for FakeAssets {
    fn get(&self, path: &str) -> Option<PublicAsset> {
        self.map.get(path).cloned()
    }
}

struct FakeRunner {
    queue: Mutex<Vec<Result<RunOutput, SystemError>>>,
    calls: Mutex<Vec<CommandSpec>>,
    delay_ms: AtomicU64,
    fail_readback: AtomicBool,
}

impl FakeRunner {
    fn new(responses: Vec<Result<RunOutput, SystemError>>) -> Self {
        Self {
            queue: Mutex::new(responses),
            calls: Mutex::new(Vec::new()),
            delay_ms: AtomicU64::new(0),
            fail_readback: AtomicBool::new(false),
        }
    }

    fn calls(&self) -> Vec<CommandSpec> {
        self.calls.lock().unwrap().clone()
    }
}

impl CommandRunner for FakeRunner {
    fn run<'a>(
        &'a self,
        spec: &'a CommandSpec,
    ) -> Pin<Box<dyn Future<Output = Result<RunOutput, SystemError>> + Send + 'a>> {
        let spec = spec.clone();
        Box::pin(async move {
            self.calls.lock().unwrap().push(spec.clone());
            let delay_ms = self.delay_ms.load(Ordering::SeqCst);
            if delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            }
            if self.fail_readback.load(Ordering::SeqCst)
                && spec.program == "wpctl"
                && spec.args.first().map(String::as_str) == Some("get-volume")
            {
                return Err(SystemError::Timeout {
                    message: "fake readback timeout".to_string(),
                });
            }
            let mut queue = self.queue.lock().unwrap();
            if queue.is_empty() {
                panic!("fake runner ran out of responses for {spec:?}");
            }
            queue.remove(0)
        })
    }
}

fn ok(stdout: &str) -> Result<RunOutput, SystemError> {
    Ok(RunOutput {
        success: true,
        stdout: stdout.to_string(),
    })
}

fn default_obs() -> Arc<ObsState> {
    Arc::new(ObsState::with_timeouts(ObsTimeouts {
        connect: Duration::from_secs(2),
        request: Duration::from_secs(2),
    }))
}

fn default_assets() -> Arc<dyn AssetProvider> {
    Arc::new(FakeAssets::new())
}

fn default_clock() -> Arc<TestClock> {
    Arc::new(TestClock::new())
}

fn default_system(runner: Arc<FakeRunner>) -> Arc<SystemState> {
    Arc::new(SystemState::with_runner_and_timeouts(
        runner,
        SystemTimeouts {
            command: Duration::from_secs(2),
        },
    ))
}

struct TestEnv {
    service: RunningService,
    port: u16,
    _dir: TempDir,
    system: Arc<SystemState>,
}

async fn save_default_deck(store: &DeckStore) {
    store.save(0, default_deck()).await.expect("save deck");
}

async fn env_with(
    limits: Limits,
    obs: Arc<ObsState>,
    assets: Arc<dyn AssetProvider>,
    clock: Arc<TestClock>,
    runner: Arc<FakeRunner>,
) -> TestEnv {
    let dir = TempDir::new("service");
    let store = Arc::new(DeckStore::new(dir.path.join(DECK_FILE_NAME)));
    save_default_deck(&store).await;
    let system = default_system(runner);
    let config = ServiceConfig {
        origin: ORIGIN.to_string(),
        port: 0,
        deck: store,
        obs: obs.clone(),
        system: system.clone(),
        assets,
        clock: clock.clone(),
        limits,
    };
    let service = start(config).await.expect("start service");
    let port = service.port();
    TestEnv {
        service,
        port,
        _dir: dir,
        system,
    }
}

async fn default_env() -> TestEnv {
    env_with(
        Limits::default(),
        default_obs(),
        default_assets(),
        default_clock(),
        Arc::new(FakeRunner::new(vec![])),
    )
    .await
}

async fn pair_device(env: &TestEnv, name: &str) -> (String, String) {
    let invitation = env.service.create_invitation().await.expect("invitation");
    let body = json!({
        "invitation": invitation.invitation,
        "name": name,
    })
    .to_string();
    let response = http_request(
        env.port,
        "POST",
        "/api/v1/pair",
        PUBLIC_HOST,
        Some(ORIGIN),
        None,
        Some(&body),
    )
    .await;
    assert_eq!(response.status, 200, "pair failed: {}", response.text());
    let request_id = response.json()["requestId"]
        .as_str()
        .expect("requestId")
        .to_string();
    let token = response.cookie_token().expect("device cookie");
    (request_id, token)
}

async fn approved_device(env: &TestEnv, name: &str) -> (String, String) {
    let (request_id, token) = pair_device(env, name).await;
    env.service
        .approve_device(&request_id)
        .await
        .expect("approve device");
    (request_id, token)
}

struct HttpResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl HttpResponse {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).to_string()
    }

    fn json(&self) -> Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|_| panic!("response is not JSON: {}", self.text()))
    }

    fn cookie_token(&self) -> Option<String> {
        let set_cookie = self.header("set-cookie")?;
        let first = set_cookie.split(';').next()?;
        let (name, value) = first.split_once('=')?;
        if name == COOKIE_NAME {
            Some(value.to_string())
        } else {
            None
        }
    }
}

async fn http_request(
    port: u16,
    method: &str,
    path: &str,
    host: &str,
    origin: Option<&str>,
    cookie: Option<&str>,
    body: Option<&str>,
) -> HttpResponse {
    http_request_raw(port, method, path, host, origin, cookie, body, &[]).await
}

async fn http_request_raw(
    port: u16,
    method: &str,
    path: &str,
    host: &str,
    origin: Option<&str>,
    cookie: Option<&str>,
    body: Option<&str>,
    extra_headers: &[(&str, &str)],
) -> HttpResponse {
    let mut request = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n");
    if let Some(origin) = origin {
        request.push_str(&format!("Origin: {origin}\r\n"));
    }
    if let Some(cookie) = cookie {
        request.push_str(&format!("Cookie: {COOKIE_NAME}={cookie}\r\n"));
    }
    for (name, value) in extra_headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    if let Some(body) = body {
        request.push_str("Content-Type: application/json\r\n");
        request.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    request.push_str("\r\n");
    if let Some(body) = body {
        request.push_str(body);
    }

    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect to service");
    let _ = stream.write_all(request.as_bytes()).await;
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut response))
        .await
        .expect("response timeout")
        .expect("read response");
    parse_http_response(&response)
}

fn parse_http_response(response: &[u8]) -> HttpResponse {
    let split = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .expect("response headers");
    let head = std::str::from_utf8(&response[..split]).expect("response head");
    let mut lines = head.split("\r\n");
    let status_line = lines.next().expect("status line");
    let status = status_line
        .split_whitespace()
        .nth(1)
        .expect("status code")
        .parse()
        .expect("status number");
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| {
            line.split_once(": ")
                .map(|(name, value)| (name.to_ascii_lowercase(), value.to_string()))
        })
        .collect();
    let mut body = response[split + 4..].to_vec();
    if headers.iter().any(|(name, value)| {
        name == "transfer-encoding" && value.to_ascii_lowercase().contains("chunked")
    }) {
        body = decode_chunked(&body);
    }
    HttpResponse {
        status,
        headers,
        body,
    }
}

fn decode_chunked(mut data: &[u8]) -> Vec<u8> {
    let mut output = Vec::new();
    loop {
        let Some(line_end) = data.windows(2).position(|window| window == b"\r\n") else {
            break;
        };
        let size_text = std::str::from_utf8(&data[..line_end])
            .expect("chunk size")
            .split(';')
            .next()
            .expect("chunk size text");
        let size = usize::from_str_radix(size_text.trim(), 16).expect("chunk size number");
        data = &data[line_end + 2..];
        if size == 0 {
            break;
        }
        output.extend_from_slice(&data[..size]);
        data = &data[size + 2..];
    }
    output
}

async fn ws_connect(
    port: u16,
    host: &str,
    origin: &str,
    cookie: Option<&str>,
) -> Result<WebSocketStream<TcpStream>, tokio_websockets::Error> {
    let stream = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect websocket");
    let uri = format!("ws://{host}/api/v1/events");
    let mut builder = ClientBuilder::new().uri(&uri).expect("ws uri");
    if !origin.is_empty() {
        builder = builder
            .add_header(header::ORIGIN, HeaderValue::from_str(origin).unwrap())
            .expect("origin header");
    }
    if let Some(cookie) = cookie {
        builder = builder
            .add_header(
                header::COOKIE,
                HeaderValue::from_str(&format!("{COOKIE_NAME}={cookie}")).unwrap(),
            )
            .expect("cookie header");
    }
    builder
        .connect_on(stream)
        .await
        .map(|(websocket, _)| websocket)
}

async fn read_message(websocket: &mut WebSocketStream<TcpStream>) -> Message {
    tokio::time::timeout(Duration::from_secs(2), websocket.next())
        .await
        .expect("websocket timeout")
        .expect("websocket closed")
        .expect("websocket error")
}

async fn read_json(websocket: &mut WebSocketStream<TcpStream>) -> Value {
    let message = read_message(websocket).await;
    let text = message.as_text().expect("text websocket message");
    serde_json::from_str(text).expect("json websocket message")
}

async fn read_until_close(websocket: &mut WebSocketStream<TcpStream>) -> bool {
    for _ in 0..10 {
        match tokio::time::timeout(Duration::from_secs(2), websocket.next()).await {
            Ok(Some(Ok(message))) if message.is_close() => return true,
            Ok(Some(Ok(_))) => continue,
            Ok(Some(Err(_))) | Ok(None) => return true,
            Err(_) => return false,
        }
    }
    false
}

async fn close_websocket(websocket: &mut WebSocketStream<TcpStream>) {
    let _ = websocket.send(Message::close(None, "")).await;
}

#[tokio::test]
async fn origin_validation_rejects_unsafe_origins() {
    assert_eq!(DEFAULT_PORT, 45829);
    let unsafe_origins = [
        "http://deck.tailnet.ts.net",
        "https://deck.tailnet.ts.net/path",
        "https://deck.tailnet.ts.net?query=1",
        "https://user@deck.tailnet.ts.net",
        "https://deck.tailnet.ts.net:8443",
        "https://deck.tailnet.ts.net/#fragment",
        "https://example.com",
        "https://.ts.net",
    ];
    for origin in unsafe_origins {
        let dir = TempDir::new("origin");
        let store = Arc::new(DeckStore::new(dir.path.join(DECK_FILE_NAME)));
        save_default_deck(&store).await;
        let config = ServiceConfig {
            origin: origin.to_string(),
            port: 0,
            deck: store,
            obs: default_obs(),
            system: default_system(Arc::new(FakeRunner::new(vec![]))),
            assets: default_assets(),
            clock: default_clock(),
            limits: Limits::default(),
        };
        let error = start(config).await.err().expect("origin must be rejected");
        assert!(
            matches!(error, RemoteError::InvalidOrigin { .. }),
            "{origin}: {error:?}"
        );
    }

    // An explicit default HTTPS port is accepted and normalized.
    let dir = TempDir::new("origin-443");
    let store = Arc::new(DeckStore::new(dir.path.join(DECK_FILE_NAME)));
    save_default_deck(&store).await;
    let config = ServiceConfig {
        origin: "https://deck.tailnet.ts.net:443".to_string(),
        port: 0,
        deck: store,
        obs: default_obs(),
        system: default_system(Arc::new(FakeRunner::new(vec![]))),
        assets: default_assets(),
        clock: default_clock(),
        limits: Limits::default(),
    };
    let service = start(config).await.expect(":443 origin is valid");
    assert_eq!(
        service.status().await.origin.as_deref(),
        Some("https://deck.tailnet.ts.net")
    );
    service.stop().await;
}

#[tokio::test]
async fn pairing_sets_a_secure_http_only_cookie_and_consumes_the_invitation() {
    let env = default_env().await;
    let invitation = env.service.create_invitation().await.expect("invitation");
    assert!(invitation.invitation.len() == 64);
    assert!(invitation
        .url
        .starts_with(&format!("{ORIGIN}/#/pair?invite=")));
    assert!(invitation.url.ends_with(&invitation.invitation));

    let body = json!({
        "invitation": invitation.invitation,
        "name": "Test Phone",
    })
    .to_string();
    let response = http_request(
        env.port,
        "POST",
        "/api/v1/pair",
        PUBLIC_HOST,
        Some(ORIGIN),
        None,
        Some(&body),
    )
    .await;
    assert_eq!(response.status, 200, "{}", response.text());
    assert_eq!(response.header("cache-control"), Some("no-store"));
    let set_cookie = response.header("set-cookie").expect("set-cookie");
    assert!(set_cookie.starts_with("__Host-deck-device="));
    assert!(set_cookie.contains("Secure"));
    assert!(set_cookie.contains("HttpOnly"));
    assert!(set_cookie.contains("SameSite=Strict"));
    assert!(set_cookie.contains("Path=/"));
    assert!(!set_cookie.contains("Domain="));
    let token = response.cookie_token().expect("cookie token");
    assert_eq!(token.len(), 64);
    let request_id = response.json()["requestId"].as_str().unwrap().to_string();
    assert!(!response.text().contains(&token));

    // The invitation is consumed once.
    let reused = http_request(
        env.port,
        "POST",
        "/api/v1/pair",
        PUBLIC_HOST,
        Some(ORIGIN),
        None,
        Some(&body),
    )
    .await;
    assert_eq!(reused.status, 403);
    assert_eq!(reused.header("cache-control"), Some("no-store"));

    // The provisional cookie can read only its own status.
    let status = http_request(
        env.port,
        "GET",
        "/api/v1/pair/status",
        PUBLIC_HOST,
        None,
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status.status, 200);
    assert_eq!(status.json()["requestId"], request_id);
    assert_eq!(status.json()["status"], "pending");

    let deck = http_request(
        env.port,
        "GET",
        "/api/v1/state",
        PUBLIC_HOST,
        None,
        Some(&token),
        None,
    )
    .await;
    assert_eq!(deck.status, 403);
    assert_eq!(deck.header("cache-control"), Some("no-store"));

    let command = json!({
        "id": "pending_cmd",
        "revision": 1,
        "controlId": "ctl_mic",
    })
    .to_string();
    let denied = http_request(
        env.port,
        "POST",
        "/api/v1/commands",
        PUBLIC_HOST,
        Some(ORIGIN),
        Some(&token),
        Some(&command),
    )
    .await;
    assert_eq!(denied.status, 403);
    assert_eq!(denied.header("cache-control"), Some("no-store"));

    let host = format!("127.0.0.1:{}", env.port);
    assert!(ws_connect(env.port, &host, ORIGIN, Some(&token))
        .await
        .is_err());

    env.service.stop().await;
}

#[tokio::test]
async fn wrong_host_origin_and_missing_cookie_are_rejected() {
    let env = default_env().await;
    let (_request_id, token) = approved_device(&env, "Phone").await;

    let wrong_origin = http_request(
        env.port,
        "POST",
        "/api/v1/commands",
        PUBLIC_HOST,
        Some("https://evil.example"),
        Some(&token),
        Some(r#"{"id":"cmd","revision":1,"controlId":"ctl_mic"}"#),
    )
    .await;
    assert_eq!(wrong_origin.status, 403);

    let missing_origin = http_request(
        env.port,
        "POST",
        "/api/v1/commands",
        PUBLIC_HOST,
        None,
        Some(&token),
        Some(r#"{"id":"cmd","revision":1,"controlId":"ctl_mic"}"#),
    )
    .await;
    assert_eq!(missing_origin.status, 403);

    let wrong_host = http_request(
        env.port,
        "GET",
        "/api/v1/state",
        "evil.example",
        None,
        Some(&token),
        None,
    )
    .await;
    assert_eq!(wrong_host.status, 400);
    assert_eq!(wrong_host.header("cache-control"), Some("no-store"));

    let missing_cookie = http_request(
        env.port,
        "GET",
        "/api/v1/state",
        PUBLIC_HOST,
        None,
        None,
        None,
    )
    .await;
    assert_eq!(missing_cookie.status, 401);
    assert_eq!(missing_cookie.header("cache-control"), Some("no-store"));

    let bad_cookie = http_request(
        env.port,
        "GET",
        "/api/v1/state",
        PUBLIC_HOST,
        None,
        Some("not-a-token"),
        None,
    )
    .await;
    assert_eq!(bad_cookie.status, 401);

    // Exact loopback upstream authority is accepted for GETs.
    let loopback = format!("127.0.0.1:{}", env.port);
    let ok = http_request(
        env.port,
        "GET",
        "/api/v1/state",
        &loopback,
        None,
        Some(&token),
        None,
    )
    .await;
    assert_eq!(ok.status, 200);

    // Forwarded headers cannot select a different host.
    let forwarded = http_request_raw(
        env.port,
        "GET",
        "/api/v1/state",
        "evil.example",
        None,
        Some(&token),
        None,
        &[("x-forwarded-host", PUBLIC_HOST)],
    )
    .await;
    assert_eq!(forwarded.status, 400);
    assert_eq!(forwarded.header("cache-control"), Some("no-store"));

    env.service.stop().await;
}

#[tokio::test]
async fn invitation_expiry_and_single_active_invitation() {
    let clock = default_clock();
    let mut limits = Limits::default();
    limits.invitation_ttl = Duration::from_millis(50);
    let env = env_with(
        limits,
        default_obs(),
        default_assets(),
        clock.clone(),
        Arc::new(FakeRunner::new(vec![])),
    )
    .await;

    let invitation = env.service.create_invitation().await.expect("invitation");
    let second = env.service.create_invitation().await;
    assert!(matches!(second, Err(RemoteError::Conflict { .. })));

    clock.advance(100);
    let body = json!({
        "invitation": invitation.invitation,
        "name": "Expired",
    })
    .to_string();
    let response = http_request(
        env.port,
        "POST",
        "/api/v1/pair",
        PUBLIC_HOST,
        Some(ORIGIN),
        None,
        Some(&body),
    )
    .await;
    assert_eq!(response.status, 403);

    // A fresh invitation works after the old one expires.
    let fresh = env
        .service
        .create_invitation()
        .await
        .expect("fresh invitation");
    let body = json!({
        "invitation": fresh.invitation,
        "name": "Fresh",
    })
    .to_string();
    let response = http_request(
        env.port,
        "POST",
        "/api/v1/pair",
        PUBLIC_HOST,
        Some(ORIGIN),
        None,
        Some(&body),
    )
    .await;
    assert_eq!(response.status, 200);

    env.service.stop().await;
}

#[tokio::test]
async fn pairing_rate_and_registry_limits_are_bounded() {
    let mut limits = Limits::default();
    limits.max_pair_attempts = 2;
    let env = env_with(
        limits,
        default_obs(),
        default_assets(),
        default_clock(),
        Arc::new(FakeRunner::new(vec![])),
    )
    .await;

    let bad = json!({
        "invitation": "0".repeat(64),
        "name": "Bad",
    })
    .to_string();
    for attempt in 0..2 {
        let response = http_request(
            env.port,
            "POST",
            "/api/v1/pair",
            PUBLIC_HOST,
            Some(ORIGIN),
            None,
            Some(&bad),
        )
        .await;
        assert_eq!(response.status, 403, "attempt {attempt}");
    }
    let rate_limited = http_request(
        env.port,
        "POST",
        "/api/v1/pair",
        PUBLIC_HOST,
        Some(ORIGIN),
        None,
        Some(&bad),
    )
    .await;
    assert_eq!(rate_limited.status, 429);

    env.service.stop().await;

    let mut limits = Limits::default();
    limits.max_pending = 1;
    let env = env_with(
        limits,
        default_obs(),
        default_assets(),
        default_clock(),
        Arc::new(FakeRunner::new(vec![])),
    )
    .await;
    let _first = pair_device(&env, "First").await;
    let invitation = env.service.create_invitation().await.expect("invitation");
    let body = json!({
        "invitation": invitation.invitation,
        "name": "Second",
    })
    .to_string();
    let full = http_request(
        env.port,
        "POST",
        "/api/v1/pair",
        PUBLIC_HOST,
        Some(ORIGIN),
        None,
        Some(&body),
    )
    .await;
    assert_eq!(full.status, 429);

    env.service.stop().await;
}

#[tokio::test]
async fn deny_and_revoke_invalidate_credentials_and_close_sockets() {
    let env = default_env().await;

    let (request_id, token) = pair_device(&env, "Denied").await;
    let denied = env.service.deny_device(&request_id).await.expect("deny");
    assert_eq!(denied.status, DeviceStatus::Denied);
    let deck = http_request(
        env.port,
        "GET",
        "/api/v1/state",
        PUBLIC_HOST,
        None,
        Some(&token),
        None,
    )
    .await;
    assert_eq!(deck.status, 403);
    let status = http_request(
        env.port,
        "GET",
        "/api/v1/pair/status",
        PUBLIC_HOST,
        None,
        Some(&token),
        None,
    )
    .await;
    assert_eq!(status.status, 200);
    assert_eq!(status.json()["status"], "denied");

    let (request_id, token) = approved_device(&env, "Revoked").await;
    let host = format!("127.0.0.1:{}", env.port);
    let mut websocket = ws_connect(env.port, &host, ORIGIN, Some(&token))
        .await
        .expect("websocket");
    let _initial = read_json(&mut websocket).await;
    let revoked = env
        .service
        .revoke_device(&request_id)
        .await
        .expect("revoke");
    assert_eq!(revoked.status, DeviceStatus::Revoked);
    assert!(read_until_close(&mut websocket).await);

    let deck = http_request(
        env.port,
        "GET",
        "/api/v1/state",
        PUBLIC_HOST,
        None,
        Some(&token),
        None,
    )
    .await;
    assert_eq!(deck.status, 401);

    env.service.stop().await;
}

#[tokio::test]
async fn deck_store_changes_are_published_over_the_socket() {
    let dir = TempDir::new("deck-sync");
    let store = Arc::new(DeckStore::new(dir.path.join(DECK_FILE_NAME)));
    save_default_deck(&store).await;
    let config = ServiceConfig {
        origin: ORIGIN.to_string(),
        port: 0,
        deck: store.clone(),
        obs: default_obs(),
        system: default_system(Arc::new(FakeRunner::new(vec![]))),
        assets: default_assets(),
        clock: default_clock(),
        limits: Limits::default(),
    };
    let service = start(config).await.expect("start service");
    let port = service.port();
    let token = {
        let invitation = service.create_invitation().await.expect("invitation");
        let body = json!({
            "invitation": invitation.invitation,
            "name": "Sync",
        })
        .to_string();
        let response = http_request(
            port,
            "POST",
            "/api/v1/pair",
            PUBLIC_HOST,
            Some(ORIGIN),
            None,
            Some(&body),
        )
        .await;
        assert_eq!(response.status, 200);
        let request_id = response.json()["requestId"].as_str().unwrap().to_string();
        service.approve_device(&request_id).await.expect("approve");
        response.cookie_token().expect("cookie")
    };

    let host = format!("127.0.0.1:{port}");
    let mut websocket = ws_connect(port, &host, ORIGIN, Some(&token))
        .await
        .expect("websocket");
    let initial = read_json(&mut websocket).await;
    assert_eq!(initial["revision"], 1);

    let mut deck = default_deck();
    deck.pages[0].name = "Changed".to_string();
    let saved = store.save(1, deck).await.expect("save");
    assert_eq!(saved.revision, 2);

    let update = read_json(&mut websocket).await;
    assert_eq!(update["type"], "snapshot");
    assert_eq!(update["revision"], 2);
    assert_eq!(update["deck"]["pages"][0]["name"], "Changed");

    close_websocket(&mut websocket).await;
    service.stop().await;
}

#[tokio::test]
async fn commands_are_strict_and_reject_bad_input() {
    let env = default_env().await;
    let (_request_id, token) = approved_device(&env, "Commands").await;

    let unknown_field = json!({
        "id": "cmd_1",
        "revision": 1,
        "controlId": "ctl_mic",
        "extra": true,
    })
    .to_string();
    let response = http_request(
        env.port,
        "POST",
        "/api/v1/commands",
        PUBLIC_HOST,
        Some(ORIGIN),
        Some(&token),
        Some(&unknown_field),
    )
    .await;
    assert_eq!(response.status, 400);

    let stale = json!({
        "id": "cmd_1",
        "revision": 0,
        "controlId": "ctl_mic",
    })
    .to_string();
    let response = http_request(
        env.port,
        "POST",
        "/api/v1/commands",
        PUBLIC_HOST,
        Some(ORIGIN),
        Some(&token),
        Some(&stale),
    )
    .await;
    assert_eq!(response.status, 409);

    let missing_control = json!({
        "id": "cmd_1",
        "revision": 1,
        "controlId": "ctl_missing",
    })
    .to_string();
    let response = http_request(
        env.port,
        "POST",
        "/api/v1/commands",
        PUBLIC_HOST,
        Some(ORIGIN),
        Some(&token),
        Some(&missing_control),
    )
    .await;
    assert_eq!(response.status, 400);

    let value_on_mic = json!({
        "id": "cmd_1",
        "revision": 1,
        "controlId": "ctl_mic",
        "value": 50.0,
    })
    .to_string();
    let response = http_request(
        env.port,
        "POST",
        "/api/v1/commands",
        PUBLIC_HOST,
        Some(ORIGIN),
        Some(&token),
        Some(&value_on_mic),
    )
    .await;
    assert_eq!(response.status, 400);

    let invalid_volume = json!({
        "id": "cmd_1",
        "revision": 1,
        "controlId": "ctl_volume",
        "value": 101.0,
    })
    .to_string();
    let response = http_request(
        env.port,
        "POST",
        "/api/v1/commands",
        PUBLIC_HOST,
        Some(ORIGIN),
        Some(&token),
        Some(&invalid_volume),
    )
    .await;
    assert_eq!(response.status, 400);

    let oversized_id = json!({
        "id": "x".repeat(129),
        "revision": 1,
        "controlId": "ctl_mic",
    })
    .to_string();
    let response = http_request(
        env.port,
        "POST",
        "/api/v1/commands",
        PUBLIC_HOST,
        Some(ORIGIN),
        Some(&token),
        Some(&oversized_id),
    )
    .await;
    assert_eq!(response.status, 400);

    env.service.stop().await;
}

#[tokio::test]
async fn duplicate_commands_run_once_and_conflicts_are_rejected() {
    let mut limits = Limits::default();
    limits.max_inflight_commands = 4;
    let runner = Arc::new(FakeRunner::new(vec![
        ok(""),
        ok("Volume: 0.40"),
        ok(""),
        ok("Volume: 0.40"),
    ]));
    let env = env_with(
        limits,
        default_obs(),
        default_assets(),
        default_clock(),
        runner.clone(),
    )
    .await;
    let (_request_id, token) = approved_device(&env, "Dedup").await;

    let command = json!({
        "id": "cmd_dedup",
        "revision": 1,
        "controlId": "ctl_volume",
        "value": 40.0,
    })
    .to_string();
    let first = http_request(
        env.port,
        "POST",
        "/api/v1/commands",
        PUBLIC_HOST,
        Some(ORIGIN),
        Some(&token),
        Some(&command),
    )
    .await;
    assert_eq!(first.status, 200, "{}", first.text());
    assert_eq!(first.json()["state"], "confirmed");
    let calls_after_first = runner.calls().len();
    assert_eq!(calls_after_first, 2);

    let duplicate = http_request(
        env.port,
        "POST",
        "/api/v1/commands",
        PUBLIC_HOST,
        Some(ORIGIN),
        Some(&token),
        Some(&command),
    )
    .await;
    assert_eq!(duplicate.status, 200);
    assert_eq!(duplicate.json()["state"], "confirmed");
    assert_eq!(runner.calls().len(), calls_after_first);

    let conflict = json!({
        "id": "cmd_dedup",
        "revision": 1,
        "controlId": "ctl_volume",
        "value": 60.0,
    })
    .to_string();
    let conflict = http_request(
        env.port,
        "POST",
        "/api/v1/commands",
        PUBLIC_HOST,
        Some(ORIGIN),
        Some(&token),
        Some(&conflict),
    )
    .await;
    assert_eq!(conflict.status, 409);
    assert_eq!(runner.calls().len(), calls_after_first);

    let result = http_request(
        env.port,
        "GET",
        "/api/v1/commands/cmd_dedup",
        PUBLIC_HOST,
        None,
        Some(&token),
        None,
    )
    .await;
    assert_eq!(result.status, 200);
    assert_eq!(result.json()["id"], "cmd_dedup");

    env.service.stop().await;
}

#[tokio::test]
async fn concurrent_duplicates_do_not_repeat_the_side_effect() {
    let mut limits = Limits::default();
    limits.max_inflight_commands = 4;
    let runner = Arc::new(FakeRunner::new(vec![ok(""), ok("Volume: 0.40")]));
    let env = env_with(
        limits,
        default_obs(),
        default_assets(),
        default_clock(),
        runner.clone(),
    )
    .await;
    let (_request_id, token) = approved_device(&env, "Concurrent").await;
    let command = json!({
        "id": "cmd_concurrent",
        "revision": 1,
        "controlId": "ctl_volume",
        "value": 40.0,
    })
    .to_string();

    let first = http_request(
        env.port,
        "POST",
        "/api/v1/commands",
        PUBLIC_HOST,
        Some(ORIGIN),
        Some(&token),
        Some(&command),
    );
    let second = http_request(
        env.port,
        "POST",
        "/api/v1/commands",
        PUBLIC_HOST,
        Some(ORIGIN),
        Some(&token),
        Some(&command),
    );
    let (first, second) = tokio::join!(first, second);
    assert_eq!(first.status, 200, "{}", first.text());
    assert_eq!(second.status, 200, "{}", second.text());
    assert!(first.json()["state"] == "confirmed" || first.json()["state"] == "pending");
    assert!(second.json()["state"] == "confirmed" || second.json()["state"] == "pending");
    assert_eq!(runner.calls().len(), 2);

    env.service.stop().await;
}

#[tokio::test]
async fn same_id_with_different_input_conflicts_and_revision_change_does_not() {
    let mut limits = Limits::default();
    limits.max_inflight_commands = 4;
    let runner = Arc::new(FakeRunner::new(vec![ok(""), ok("Volume: 0.40")]));
    let env = env_with(
        limits,
        default_obs(),
        default_assets(),
        default_clock(),
        runner.clone(),
    )
    .await;
    let (_request_id, token) = approved_device(&env, "Revision").await;

    let command = json!({
        "id": "cmd_revision",
        "revision": 1,
        "controlId": "ctl_volume",
        "value": 40.0,
    })
    .to_string();
    let first = http_request(
        env.port,
        "POST",
        "/api/v1/commands",
        PUBLIC_HOST,
        Some(ORIGIN),
        Some(&token),
        Some(&command),
    )
    .await;
    assert_eq!(first.status, 200, "{}", first.text());
    assert_eq!(first.json()["state"], "confirmed");
    assert_eq!(runner.calls().len(), 2);

    let changed = json!({
        "id": "cmd_revision",
        "revision": 1,
        "controlId": "ctl_volume",
        "value": 60.0,
    })
    .to_string();
    let conflict = http_request(
        env.port,
        "POST",
        "/api/v1/commands",
        PUBLIC_HOST,
        Some(ORIGIN),
        Some(&token),
        Some(&changed),
    )
    .await;
    assert_eq!(conflict.status, 409);
    assert_eq!(runner.calls().len(), 2);

    // A later revision with the same input is still the same reserved command.
    let later = json!({
        "id": "cmd_revision",
        "revision": 2,
        "controlId": "ctl_volume",
        "value": 40.0,
    })
    .to_string();
    let cached = http_request(
        env.port,
        "POST",
        "/api/v1/commands",
        PUBLIC_HOST,
        Some(ORIGIN),
        Some(&token),
        Some(&later),
    )
    .await;
    assert_eq!(cached.status, 200);
    assert_eq!(cached.json()["state"], "confirmed");
    assert_eq!(runner.calls().len(), 2);

    env.service.stop().await;
}

#[tokio::test]
async fn command_rate_and_inflight_limits_reject_before_side_effects() {
    let mut limits = Limits::default();
    limits.command_rate = 1;
    let runner = Arc::new(FakeRunner::new(vec![ok(""), ok("Volume: 0.40")]));
    let env = env_with(
        limits,
        default_obs(),
        default_assets(),
        default_clock(),
        runner.clone(),
    )
    .await;
    let (_request_id, token) = approved_device(&env, "Rate").await;
    let first = json!({
        "id": "cmd_rate_1",
        "revision": 1,
        "controlId": "ctl_volume",
        "value": 40.0,
    })
    .to_string();
    let response = http_request(
        env.port,
        "POST",
        "/api/v1/commands",
        PUBLIC_HOST,
        Some(ORIGIN),
        Some(&token),
        Some(&first),
    )
    .await;
    assert_eq!(response.status, 200, "{}", response.text());
    assert_eq!(runner.calls().len(), 2);

    let second = json!({
        "id": "cmd_rate_2",
        "revision": 1,
        "controlId": "ctl_volume",
        "value": 50.0,
    })
    .to_string();
    let limited = http_request(
        env.port,
        "POST",
        "/api/v1/commands",
        PUBLIC_HOST,
        Some(ORIGIN),
        Some(&token),
        Some(&second),
    )
    .await;
    assert_eq!(limited.status, 429);
    assert_eq!(runner.calls().len(), 2);

    env.service.stop().await;

    let mut limits = Limits::default();
    limits.max_inflight_commands = 1;
    let runner = Arc::new(FakeRunner::new(vec![ok(""), ok("Volume: 0.40")]));
    runner.delay_ms.store(200, Ordering::SeqCst);
    let env = env_with(
        limits,
        default_obs(),
        default_assets(),
        default_clock(),
        runner.clone(),
    )
    .await;
    let (_request_id, token) = approved_device(&env, "Inflight").await;
    let first = json!({
        "id": "cmd_inflight_1",
        "revision": 1,
        "controlId": "ctl_volume",
        "value": 40.0,
    })
    .to_string();
    let second = json!({
        "id": "cmd_inflight_2",
        "revision": 1,
        "controlId": "ctl_volume",
        "value": 50.0,
    })
    .to_string();
    let first = http_request(
        env.port,
        "POST",
        "/api/v1/commands",
        PUBLIC_HOST,
        Some(ORIGIN),
        Some(&token),
        Some(&first),
    );
    let second = http_request(
        env.port,
        "POST",
        "/api/v1/commands",
        PUBLIC_HOST,
        Some(ORIGIN),
        Some(&token),
        Some(&second),
    );
    let (first, second) = tokio::join!(first, second);
    assert_eq!(first.status, 200, "{}", first.text());
    assert_eq!(second.status, 429);
    assert_eq!(runner.calls().len(), 2);

    env.service.stop().await;
}

#[tokio::test]
async fn action_outcomes_are_typed_and_not_retried() {
    let mut limits = Limits::default();
    limits.max_inflight_commands = 4;
    let runner = Arc::new(FakeRunner::new(vec![ok(""), ok("Volume: 0.50")]));
    let env = env_with(
        limits,
        default_obs(),
        default_assets(),
        default_clock(),
        runner.clone(),
    )
    .await;
    let (_request_id, token) = approved_device(&env, "Outcomes").await;

    let command = json!({
        "id": "cmd_outcome",
        "revision": 1,
        "controlId": "ctl_volume",
        "value": 40.0,
    })
    .to_string();
    let response = http_request(
        env.port,
        "POST",
        "/api/v1/commands",
        PUBLIC_HOST,
        Some(ORIGIN),
        Some(&token),
        Some(&command),
    )
    .await;
    assert_eq!(response.status, 200, "{}", response.text());
    assert_eq!(response.json()["state"], "not_applied");
    assert_eq!(runner.calls().len(), 2);

    env.service.stop().await;
}

#[tokio::test]
async fn failed_readback_is_unknown_and_not_retried() {
    let runner = Arc::new(FakeRunner::new(vec![ok("")]));
    runner.fail_readback.store(true, Ordering::SeqCst);
    let env = env_with(
        Limits::default(),
        default_obs(),
        default_assets(),
        default_clock(),
        runner.clone(),
    )
    .await;
    let (_request_id, token) = approved_device(&env, "Unknown").await;

    let command = json!({
        "id": "cmd_unknown",
        "revision": 1,
        "controlId": "ctl_volume",
        "value": 40.0,
    })
    .to_string();
    let response = http_request(
        env.port,
        "POST",
        "/api/v1/commands",
        PUBLIC_HOST,
        Some(ORIGIN),
        Some(&token),
        Some(&command),
    )
    .await;
    assert_eq!(response.status, 200, "{}", response.text());
    assert_eq!(response.json()["state"], "unknown");
    assert_eq!(runner.calls().len(), 2);

    let duplicate = http_request(
        env.port,
        "POST",
        "/api/v1/commands",
        PUBLIC_HOST,
        Some(ORIGIN),
        Some(&token),
        Some(&command),
    )
    .await;
    assert_eq!(duplicate.status, 200);
    assert_eq!(duplicate.json()["state"], "unknown");
    assert_eq!(runner.calls().len(), 2);

    env.service.stop().await;
}

#[tokio::test]
async fn command_results_are_owned_by_the_device() {
    let env = env_with(
        Limits::default(),
        default_obs(),
        default_assets(),
        default_clock(),
        Arc::new(FakeRunner::new(vec![ok(""), ok("Volume: 0.40")])),
    )
    .await;
    let (_request_id, token) = approved_device(&env, "Owner").await;
    let (_other_request_id, other_token) = approved_device(&env, "Other").await;

    let command = json!({
        "id": "cmd_owner",
        "revision": 1,
        "controlId": "ctl_volume",
        "value": 40.0,
    })
    .to_string();
    let response = http_request(
        env.port,
        "POST",
        "/api/v1/commands",
        PUBLIC_HOST,
        Some(ORIGIN),
        Some(&token),
        Some(&command),
    )
    .await;
    assert_eq!(response.status, 200, "{}", response.text());

    let owner = http_request(
        env.port,
        "GET",
        "/api/v1/commands/cmd_owner",
        PUBLIC_HOST,
        None,
        Some(&token),
        None,
    )
    .await;
    assert_eq!(owner.status, 200);

    let other = http_request(
        env.port,
        "GET",
        "/api/v1/commands/cmd_owner",
        PUBLIC_HOST,
        None,
        Some(&other_token),
        None,
    )
    .await;
    assert_eq!(other.status, 404);

    env.service.stop().await;
}

#[tokio::test]
async fn websocket_requires_origin_and_cookie_and_ignores_messages() {
    let env = default_env().await;
    let (_request_id, token) = approved_device(&env, "Socket").await;
    let host = format!("127.0.0.1:{}", env.port);

    let wrong_origin = ws_connect(env.port, &host, "https://evil.example", Some(&token)).await;
    assert!(wrong_origin.is_err());

    let missing_origin = ws_connect(env.port, &host, "", Some(&token)).await;
    assert!(missing_origin.is_err());

    let missing_cookie = ws_connect(env.port, &host, ORIGIN, None).await;
    assert!(missing_cookie.is_err());

    let mut websocket = ws_connect(env.port, &host, ORIGIN, Some(&token))
        .await
        .expect("websocket");
    let _initial = read_json(&mut websocket).await;
    websocket
        .send(Message::text("not a protocol message"))
        .await
        .expect("send text");
    websocket
        .send(Message::ping(b"ping".to_vec()))
        .await
        .expect("send ping");
    let pong = read_message(&mut websocket).await;
    assert!(pong.is_pong());
    close_websocket(&mut websocket).await;

    env.service.stop().await;
}

#[tokio::test]
async fn missing_phone_surface_marker_does_not_serve_the_editor() {
    let mut assets = FakeAssets::new();
    assets.map.get_mut("index.html").unwrap().bytes =
        b"<!doctype html><title>old editor</title>".to_vec();
    let env = env_with(
        Limits::default(),
        default_obs(),
        Arc::new(assets),
        default_clock(),
        Arc::new(FakeRunner::new(vec![])),
    )
    .await;
    let index = http_request(env.port, "GET", "/", PUBLIC_HOST, None, None, None).await;
    assert_eq!(index.status, 503);
    assert_eq!(index.header("cache-control"), Some("no-store"));
    assert!(!index.text().contains("old editor"));
    env.service.stop().await;
}

#[tokio::test]
async fn static_assets_are_allowlisted_and_headers_are_safe() {
    let env = default_env().await;
    let index = http_request(env.port, "GET", "/", PUBLIC_HOST, None, None, None).await;
    assert_eq!(index.status, 200);
    assert_eq!(index.header("content-type"), Some("text/html"));
    assert_eq!(index.header("cache-control"), Some("no-cache"));
    assert!(index.text().contains("data-zdeck-remote"));
    assert!(!index.text().contains("data-zdeck-local"));
    let policy = index.header("content-security-policy").unwrap();
    assert!(policy.contains(&ORIGIN.replacen("https://", "wss://", 1)));
    assert!(!policy.contains("ipc:"));
    assert!(index
        .header("content-security-policy")
        .expect("csp")
        .contains("frame-ancestors 'none'"));

    let asset = http_request(
        env.port,
        "GET",
        "/assets/app.js",
        PUBLIC_HOST,
        None,
        None,
        None,
    )
    .await;
    assert_eq!(asset.status, 200);
    assert_eq!(
        asset.header("cache-control"),
        Some("public, max-age=31536000, immutable")
    );

    let traversal = http_request(
        env.port,
        "GET",
        "/assets/../secret",
        PUBLIC_HOST,
        None,
        None,
        None,
    )
    .await;
    assert_eq!(traversal.status, 404);

    let unknown_api = http_request(
        env.port,
        "GET",
        "/api/v1/unknown",
        PUBLIC_HOST,
        None,
        None,
        None,
    )
    .await;
    assert_eq!(unknown_api.status, 404);
    assert_eq!(unknown_api.header("cache-control"), Some("no-store"));

    let no_cors = http_request(
        env.port,
        "GET",
        "/api/v1/state",
        PUBLIC_HOST,
        None,
        None,
        None,
    )
    .await;
    assert!(no_cors.header("access-control-allow-origin").is_none());

    env.service.stop().await;
}

#[tokio::test]
async fn oversized_body_is_rejected_before_side_effects() {
    let mut limits = Limits::default();
    limits.max_body_bytes = 1024;
    let env = env_with(
        limits,
        default_obs(),
        default_assets(),
        default_clock(),
        Arc::new(FakeRunner::new(vec![])),
    )
    .await;
    let big = "x".repeat(4096);
    let body = json!({
        "invitation": big,
        "name": "Too large",
    })
    .to_string();
    let response = http_request(
        env.port,
        "POST",
        "/api/v1/pair",
        PUBLIC_HOST,
        Some(ORIGIN),
        None,
        Some(&body),
    )
    .await;
    assert_eq!(response.status, 413);
    assert_eq!(response.header("cache-control"), Some("no-store"));

    env.service.stop().await;
}

#[tokio::test]
async fn stop_clears_credentials_and_allows_port_reuse() {
    let dir = TempDir::new("restart");
    let store = Arc::new(DeckStore::new(dir.path.join(DECK_FILE_NAME)));
    save_default_deck(&store).await;
    let config = ServiceConfig {
        origin: ORIGIN.to_string(),
        port: 0,
        deck: store.clone(),
        obs: default_obs(),
        system: default_system(Arc::new(FakeRunner::new(vec![]))),
        assets: default_assets(),
        clock: default_clock(),
        limits: Limits::default(),
    };
    let service = start(config).await.expect("start");
    let port = service.port();
    let token = {
        let invitation = service.create_invitation().await.expect("invitation");
        let body = json!({
            "invitation": invitation.invitation,
            "name": "Restart",
        })
        .to_string();
        let response = http_request(
            port,
            "POST",
            "/api/v1/pair",
            PUBLIC_HOST,
            Some(ORIGIN),
            None,
            Some(&body),
        )
        .await;
        assert_eq!(response.status, 200);
        let request_id = response.json()["requestId"].as_str().unwrap().to_string();
        service.approve_device(&request_id).await.expect("approve");
        response.cookie_token().expect("cookie")
    };
    let host = format!("127.0.0.1:{port}");
    let mut websocket = ws_connect(port, &host, ORIGIN, Some(&token))
        .await
        .expect("websocket");
    let _initial = read_json(&mut websocket).await;
    service.stop().await;
    assert!(read_until_close(&mut websocket).await);

    // The listener is gone, so the old credential cannot be used at all.
    assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());

    let config = ServiceConfig {
        origin: ORIGIN.to_string(),
        port,
        deck: store,
        obs: default_obs(),
        system: default_system(Arc::new(FakeRunner::new(vec![]))),
        assets: default_assets(),
        clock: default_clock(),
        limits: Limits::default(),
    };
    let restarted = start(config).await.expect("restart on the same port");
    assert_eq!(restarted.port(), port);
    let stale = http_request(
        port,
        "GET",
        "/api/v1/state",
        PUBLIC_HOST,
        None,
        Some(&token),
        None,
    )
    .await;
    assert_eq!(stale.status, 401);
    restarted.stop().await;
}

#[tokio::test]
async fn admin_operations_are_native_only() {
    let admin = RemoteAdmin::default();
    assert!(!admin.status().await.running);
    assert!(admin.create_invitation().await.is_err());
    assert!(admin.list_devices().await.is_err());
    assert!(admin.approve_device("missing").await.is_err());
    assert!(admin.deny_device("missing").await.is_err());
    assert!(admin.revoke_device("missing").await.is_err());

    let dir = TempDir::new("admin");
    let store = Arc::new(DeckStore::new(dir.path.join(DECK_FILE_NAME)));
    save_default_deck(&store).await;
    let config = ServiceConfig {
        origin: ORIGIN.to_string(),
        port: 0,
        deck: store,
        obs: default_obs(),
        system: default_system(Arc::new(FakeRunner::new(vec![]))),
        assets: default_assets(),
        clock: default_clock(),
        limits: Limits::default(),
    };
    let status = admin.start(config).await.expect("admin start");
    assert!(status.running);
    assert!(status.origin.is_some());

    let dir = TempDir::new("admin-again");
    let store = Arc::new(DeckStore::new(dir.path.join(DECK_FILE_NAME)));
    save_default_deck(&store).await;
    let config = ServiceConfig {
        origin: ORIGIN.to_string(),
        port: 0,
        deck: store,
        obs: default_obs(),
        system: default_system(Arc::new(FakeRunner::new(vec![]))),
        assets: default_assets(),
        clock: default_clock(),
        limits: Limits::default(),
    };
    assert!(matches!(
        admin.start(config).await,
        Err(RemoteError::AlreadyRunning { .. })
    ));

    let invitation = admin.create_invitation().await.expect("invitation");
    assert!(!invitation.invitation.is_empty());
    let devices = admin.list_devices().await.expect("list");
    assert!(devices.is_empty());
    admin.stop().await;
    assert!(!admin.status().await.running);
}

#[tokio::test]
async fn bind_failure_is_reported_without_panicking() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
    let port = listener.local_addr().unwrap().port();
    let dir = TempDir::new("bind");
    let store = Arc::new(DeckStore::new(dir.path.join(DECK_FILE_NAME)));
    save_default_deck(&store).await;
    let config = ServiceConfig {
        origin: ORIGIN.to_string(),
        port,
        deck: store,
        obs: default_obs(),
        system: default_system(Arc::new(FakeRunner::new(vec![]))),
        assets: default_assets(),
        clock: default_clock(),
        limits: Limits::default(),
    };
    let error = start(config).await.err().expect("bind must fail");
    assert!(matches!(error, RemoteError::Bind { .. }));
    drop(listener);
}

#[tokio::test]
async fn system_actions_use_the_shared_fake_runner() {
    let mut limits = Limits::default();
    limits.max_inflight_commands = 4;
    let runner = Arc::new(FakeRunner::new(vec![
        ok("Volume: 0.50"),
        ok(""),
        ok("Volume: 0.50 [MUTED]"),
        ok("Volume: 0.50 [MUTED]"),
        ok("Paused"),
        ok(""),
        ok("Playing"),
        ok("Playing"),
    ]));
    let env = env_with(
        limits,
        default_obs(),
        default_assets(),
        default_clock(),
        runner.clone(),
    )
    .await;
    let (_request_id, token) = approved_device(&env, "System").await;

    let mic = json!({
        "id": "cmd_mic",
        "revision": 1,
        "controlId": "ctl_mic",
    })
    .to_string();
    let response = http_request(
        env.port,
        "POST",
        "/api/v1/commands",
        PUBLIC_HOST,
        Some(ORIGIN),
        Some(&token),
        Some(&mic),
    )
    .await;
    assert_eq!(response.status, 200, "{}", response.text());
    assert_eq!(response.json()["state"], "confirmed");
    let mic_snapshot = env.system.microphone_snapshot().await.expect("mic");
    assert!(mic_snapshot.muted);

    let media = json!({
        "id": "cmd_media",
        "revision": 1,
        "controlId": "ctl_play_pause",
    })
    .to_string();
    let response = http_request(
        env.port,
        "POST",
        "/api/v1/commands",
        PUBLIC_HOST,
        Some(ORIGIN),
        Some(&token),
        Some(&media),
    )
    .await;
    assert_eq!(response.status, 200, "{}", response.text());
    assert_eq!(response.json()["state"], "confirmed");
    let media_snapshot = env.system.media_snapshot().await.expect("media");
    assert_eq!(media_snapshot.status, MediaStatus::Playing);

    env.service.stop().await;
}

#[tokio::test]
async fn obs_actions_use_the_shared_connection() {
    let fake = start_fake_obs().await;
    let obs = Arc::new(ObsState::with_timeouts(ObsTimeouts {
        connect: Duration::from_secs(2),
        request: Duration::from_secs(2),
    }));
    obs.connect(fake.port, None).await.expect("connect obs");
    let env = env_with(
        Limits::default(),
        obs.clone(),
        default_assets(),
        default_clock(),
        Arc::new(FakeRunner::new(vec![])),
    )
    .await;
    let (_request_id, token) = approved_device(&env, "OBS").await;

    let native = obs.switch_scene("Starting soon").await.expect("native");
    assert!(native.confirmed);

    let command = json!({
        "id": "cmd_obs",
        "revision": 1,
        "controlId": "ctl_live",
    })
    .to_string();
    let response = http_request(
        env.port,
        "POST",
        "/api/v1/commands",
        PUBLIC_HOST,
        Some(ORIGIN),
        Some(&token),
        Some(&command),
    )
    .await;
    assert_eq!(response.status, 200, "{}", response.text());
    assert_eq!(response.json()["state"], "confirmed");
    assert_eq!(*fake.current.lock().unwrap(), "Live");

    let snapshot = obs.snapshot().await.expect("snapshot");
    assert_eq!(snapshot.current_scene.as_deref(), Some("Live"));

    env.service.stop().await;
    obs.disconnect().await;
}

#[tokio::test]
async fn uninitialized_and_corrupt_deck_store_are_reported() {
    let dir = TempDir::new("empty");
    let store = Arc::new(DeckStore::new(dir.path.join(DECK_FILE_NAME)));
    let config = ServiceConfig {
        origin: ORIGIN.to_string(),
        port: 0,
        deck: store,
        obs: default_obs(),
        system: default_system(Arc::new(FakeRunner::new(vec![]))),
        assets: default_assets(),
        clock: default_clock(),
        limits: Limits::default(),
    };
    let service = start(config).await.expect("start");
    let port = service.port();
    let token = {
        let invitation = service.create_invitation().await.expect("invitation");
        let body = json!({
            "invitation": invitation.invitation,
            "name": "Empty",
        })
        .to_string();
        let response = http_request(
            port,
            "POST",
            "/api/v1/pair",
            PUBLIC_HOST,
            Some(ORIGIN),
            None,
            Some(&body),
        )
        .await;
        assert_eq!(response.status, 200);
        let request_id = response.json()["requestId"].as_str().unwrap().to_string();
        service.approve_device(&request_id).await.expect("approve");
        response.cookie_token().expect("cookie")
    };
    let response = http_request(
        port,
        "GET",
        "/api/v1/state",
        PUBLIC_HOST,
        None,
        Some(&token),
        None,
    )
    .await;
    assert_eq!(response.status, 503);
    service.stop().await;

    let dir = TempDir::new("corrupt");
    let path = dir.path.join(DECK_FILE_NAME);
    std::fs::write(&path, b"{not json").expect("write corrupt");
    let store = Arc::new(DeckStore::new(path));
    let config = ServiceConfig {
        origin: ORIGIN.to_string(),
        port: 0,
        deck: store,
        obs: default_obs(),
        system: default_system(Arc::new(FakeRunner::new(vec![]))),
        assets: default_assets(),
        clock: default_clock(),
        limits: Limits::default(),
    };
    let service = start(config).await.expect("start");
    let port = service.port();
    let token = {
        let invitation = service.create_invitation().await.expect("invitation");
        let body = json!({
            "invitation": invitation.invitation,
            "name": "Corrupt",
        })
        .to_string();
        let response = http_request(
            port,
            "POST",
            "/api/v1/pair",
            PUBLIC_HOST,
            Some(ORIGIN),
            None,
            Some(&body),
        )
        .await;
        assert_eq!(response.status, 200);
        let request_id = response.json()["requestId"].as_str().unwrap().to_string();
        service.approve_device(&request_id).await.expect("approve");
        response.cookie_token().expect("cookie")
    };
    let response = http_request(
        port,
        "GET",
        "/api/v1/state",
        PUBLIC_HOST,
        None,
        Some(&token),
        None,
    )
    .await;
    assert_eq!(response.status, 500);
    service.stop().await;
}

struct FakeObs {
    port: u16,
    current: Arc<Mutex<String>>,
}

async fn start_fake_obs() -> FakeObs {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("obs listener");
    let port = listener.local_addr().unwrap().port();
    let current = Arc::new(Mutex::new("Starting soon".to_string()));
    let current_task = current.clone();
    tokio::spawn(async move {
        let Ok((stream, _)) = listener.accept().await else {
            return;
        };
        let Ok((_request, mut websocket)) = ServerBuilder::new().accept(stream).await else {
            return;
        };
        let hello = json!({
            "op": 0,
            "d": {
                "obsWebSocketVersion": "5.5.2",
                "rpcVersion": 1,
            }
        });
        if websocket
            .send(Message::text(hello.to_string()))
            .await
            .is_err()
        {
            return;
        }
        let Some(Ok(identify)) = websocket.next().await else {
            return;
        };
        let Some(text) = identify.as_text() else {
            return;
        };
        let identify: Value = serde_json::from_str(text).unwrap();
        if identify["op"] != 1 {
            return;
        }
        let identified = json!({ "op": 2, "d": { "negotiatedRpcVersion": 1 } });
        if websocket
            .send(Message::text(identified.to_string()))
            .await
            .is_err()
        {
            return;
        }
        while let Some(message) = websocket.next().await {
            let Ok(message) = message else {
                return;
            };
            let Some(text) = message.as_text() else {
                continue;
            };
            let Ok(request) = serde_json::from_str::<Value>(text) else {
                continue;
            };
            if request["op"] != 6 {
                continue;
            }
            let request_type = request["d"]["requestType"].as_str().unwrap_or_default();
            let request_id = request["d"]["requestId"].as_str().unwrap_or("0");
            let (ok, data) = match request_type {
                "GetVersion" => (
                    true,
                    json!({
                        "obsStudioVersion": "30.2.0",
                        "obsWebSocketVersion": "5.5.2",
                        "rpcVersion": 1,
                        "availableRequests": [],
                        "supportedImageFormats": [],
                        "platform": "linux",
                        "platformDescription": "fake peer",
                    }),
                ),
                "GetSceneList" => {
                    let current = current_task.lock().unwrap().clone();
                    (
                        true,
                        json!({
                            "scenes": [
                                { "sceneName": "Starting soon", "sceneUuid": "00000000-0000-0000-0000-000000000000", "sceneIndex": 0 },
                                { "sceneName": "Live", "sceneUuid": "00000000-0000-0000-0000-000000000001", "sceneIndex": 1 },
                            ],
                            "currentProgramSceneName": current,
                            "currentProgramSceneUuid": "00000000-0000-0000-0000-000000000000",
                            "currentPreviewSceneName": "Starting soon",
                            "currentPreviewSceneUuid": "00000000-0000-0000-0000-000000000000",
                        }),
                    )
                }
                "SetCurrentProgramScene" => {
                    let scene = request["d"]["requestData"]["sceneName"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string();
                    *current_task.lock().unwrap() = scene;
                    (true, Value::Null)
                }
                "GetCurrentProgramScene" => {
                    let current = current_task.lock().unwrap().clone();
                    (
                        true,
                        json!({ "sceneName": current, "sceneUuid": "00000000-0000-0000-0000-000000000000" }),
                    )
                }
                _ => (false, Value::Null),
            };
            let status = if ok {
                json!({ "result": true, "code": 100 })
            } else {
                json!({ "result": false, "code": 205, "comment": "peer error" })
            };
            let response = json!({
                "op": 7,
                "d": {
                    "requestType": "",
                    "requestId": request_id,
                    "requestStatus": status,
                    "responseData": data,
                }
            });
            if websocket
                .send(Message::text(response.to_string()))
                .await
                .is_err()
            {
                return;
            }
        }
    });
    FakeObs { port, current }
}

// ---------------------------------------------------------------------------
// Browser smoke fixture
//
// Opt-in and ignored by default. `npm run smoke:remote` builds the frontend and
// then runs this single test under `nix develop`, which supplies node, openssl,
// Chrome, and a disposable loopback HTTPS proxy driven by scripts/remote-smoke.mjs.
// The test never touches a real tailnet, OBS, audio, or a phone device: every
// action goes through the existing fake runners and a temporary deck store.
// ---------------------------------------------------------------------------

#[cfg(unix)]
mod browser_smoke {
    use super::*;
    use serde::Deserialize;
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, BufReader};

    /// Real build assets; production routing still owns the path allowlist.
    struct DiskAssets {
        root: PathBuf,
    }
    impl AssetProvider for DiskAssets {
        fn get(&self, path: &str) -> Option<PublicAsset> {
            let full = self.root.join(path);
            let mime = match full.extension().and_then(|extension| extension.to_str()) {
                Some("html") => "text/html",
                Some("js") => "text/javascript",
                Some("css") => "text/css",
                Some("png") => "image/png",
                Some("svg") => "image/svg+xml",
                Some("webmanifest") => "application/manifest+json",
                Some("ttf") => "font/ttf",
                _ => "application/octet-stream",
            };
            Some(PublicAsset {
                bytes: std::fs::read(full).ok()?,
                mime: mime.to_string(),
            })
        }
    }

    #[derive(Deserialize)]
    struct RpcRequest {
        id: u64,
        method: String,
        #[serde(default)]
        params: Value,
    }

    /// Kills the Node smoke process and its process group if the test unwinds early.
    struct SmokeChildGuard {
        pid: u32,
        child: Option<tokio::process::Child>,
    }

    impl Drop for SmokeChildGuard {
        fn drop(&mut self) {
            if let Some(mut child) = self.child.take() {
                let _ = child.start_kill();
                // The Node child leads its own process group; this reaps a stuck Chrome too.
                let _ = std::process::Command::new("kill")
                    .args(["-KILL", "--", &format!("-{}", self.pid)])
                    .status();
            }
        }
    }

    async fn browser_rpc(
        service: &RunningService,
        store: &DeckStore,
        runner: &FakeRunner,
        request: &RpcRequest,
    ) -> Value {
        let outcome: Result<Value, String> = match request.method.as_str() {
            "create_invitation" => service
                .create_invitation()
                .await
                .map(|view| serde_json::to_value(view).unwrap())
                .map_err(|error| format!("{error:?}")),
            "list_devices" => service
                .list_devices()
                .await
                .map(|devices| serde_json::to_value(devices).unwrap())
                .map_err(|error| format!("{error:?}")),
            "approve_device" => {
                let request_id = request
                    .params
                    .get("requestId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "requestId is required".to_string());
                match request_id {
                    Ok(request_id) => service
                        .approve_device(request_id)
                        .await
                        .map(|view| serde_json::to_value(view).unwrap())
                        .map_err(|error| format!("{error:?}")),
                    Err(error) => Err(error),
                }
            }
            "deny_device" => {
                let request_id = request
                    .params
                    .get("requestId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "requestId is required".to_string());
                match request_id {
                    Ok(request_id) => service
                        .deny_device(request_id)
                        .await
                        .map(|view| serde_json::to_value(view).unwrap())
                        .map_err(|error| format!("{error:?}")),
                    Err(error) => Err(error),
                }
            }
            "revoke_device" => {
                let request_id = request
                    .params
                    .get("requestId")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "requestId is required".to_string());
                match request_id {
                    Ok(request_id) => service
                        .revoke_device(request_id)
                        .await
                        .map(|view| serde_json::to_value(view).unwrap())
                        .map_err(|error| format!("{error:?}")),
                    Err(error) => Err(error),
                }
            }
            "status" => {
                let status = service.status().await;
                Ok(serde_json::to_value(status).unwrap())
            }
            "counts" => {
                let status = service.status().await;
                Ok(json!({
                    "pending": status.pending_devices,
                    "approved": status.approved_devices,
                    "connectedSockets": status.connected_sockets,
                }))
            }
            "save_deck" => {
                let page_id = request
                    .params
                    .get("pageId")
                    .and_then(Value::as_str)
                    .unwrap_or("page_stream")
                    .to_string();
                let name = request
                    .params
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("Updated")
                    .to_string();
                match store.load().await {
                    Ok(snapshot) => {
                        let mut deck = snapshot.deck;
                        if let Some(page) = deck.pages.iter_mut().find(|page| page.id == page_id) {
                            page.name = name;
                        }
                        store
                            .save(snapshot.revision, deck)
                            .await
                            .map(|saved| json!({ "revision": saved.revision }))
                            .map_err(|error| format!("{error:?}"))
                    }
                    Err(error) => Err(format!("{error:?}")),
                }
            }
            "runner_push" => match request.params.get("outputs").and_then(Value::as_array) {
                Some(outputs) => {
                    let mut queue = runner.queue.lock().unwrap();
                    for output in outputs {
                        if let Some(text) = output.as_str() {
                            queue.push(ok(text));
                        }
                    }
                    Ok(json!(true))
                }
                None => Err("outputs is required".to_string()),
            },
            "runner_calls" => Ok(json!({ "calls": runner.calls().len() })),
            "stop" => {
                service.stop().await;
                Ok(json!(true))
            }
            other => Err(format!("unknown RPC method: {other}")),
        };

        match outcome {
            Ok(result) => json!({ "id": request.id, "ok": true, "result": result }),
            Err(error) => json!({ "id": request.id, "ok": false, "error": error }),
        }
    }

    #[tokio::test]
    #[ignore = "launches real Chrome via Node against built dist; run `npm run smoke:remote`"]
    async fn remote_browser_smoke() {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let dist = manifest_dir.join("../dist");
        assert!(
            dist.join("index.html").is_file(),
            "built frontend missing; run `npm run build` first ({})",
            dist.display()
        );
        let script = manifest_dir.join("../scripts/remote-smoke.mjs");
        assert!(script.is_file(), "missing {}", script.display());

        let dir = TempDir::new("browser");
        let store = Arc::new(DeckStore::new(dir.path.join(DECK_FILE_NAME)));
        let mut deck = default_deck();
        deck.pages[0].controls[3].label = "Fixture playback".to_string();
        store.save(0, deck).await.expect("save fixture deck");
        let runner = Arc::new(FakeRunner::new(vec![]));
        let config = ServiceConfig {
            origin: ORIGIN.to_string(),
            port: 0,
            deck: store.clone(),
            obs: default_obs(),
            system: default_system(runner.clone()),
            assets: Arc::new(DiskAssets { root: dist }),
            clock: default_clock(),
            limits: Limits::default(),
        };
        let service = start(config).await.expect("start browser smoke service");
        let port = service.port();

        let mut std_cmd = std::process::Command::new("node");
        std_cmd
            .arg(&script)
            .arg("--origin")
            .arg(ORIGIN)
            .arg("--backend-port")
            .arg(port.to_string())
            .arg("--temp-dir")
            .arg(&dir.path)
            .env(
                "CHROME_BIN",
                std::env::var("CHROME_BIN").unwrap_or_else(|_| "google-chrome".to_string()),
            );
        std_cmd.process_group(0);
        let mut cmd = tokio::process::Command::from(std_cmd);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        let mut child = cmd.spawn().expect("spawn node smoke");
        let pid = child.id().expect("node smoke pid");
        let mut stdin = child.stdin.take().expect("node stdin");
        let stdout = BufReader::new(child.stdout.take().expect("node stdout"));
        let mut guard = SmokeChildGuard {
            pid,
            child: Some(child),
        };

        let status = tokio::time::timeout(Duration::from_secs(120), async {
            let mut lines = stdout.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let request: RpcRequest = match serde_json::from_str(trimmed) {
                    Ok(request) => request,
                    Err(_) => continue,
                };
                let response = browser_rpc(&service, &store, &runner, &request).await;
                let mut payload = serde_json::to_string(&response).expect("serialize RPC response");
                payload.push('\n');
                if stdin.write_all(payload.as_bytes()).await.is_err() {
                    break;
                }
                let _ = stdin.flush().await;
            }
            drop(stdin);

            guard
                .child
                .as_mut()
                .expect("node child")
                .wait()
                .await
                .expect("wait for node smoke")
        })
        .await
        .expect("remote browser smoke exceeded 120 seconds");
        guard.child = None;
        service.stop().await;
        assert!(status.success(), "remote browser smoke reported failures");
    }
}
