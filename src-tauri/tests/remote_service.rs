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
    ConnectionMode, RunningService, ServiceConfig, COOKIE_NAME, DEFAULT_PORT,
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

fn default_actions() -> Arc<deck_lib::actions::ActionDispatcher> {
    Arc::new(deck_lib::actions::ActionDispatcher::new(
        default_obs(), default_system(Arc::new(FakeRunner::new(vec![]))),
        Arc::new(deck_lib::plugin::PluginRegistry::default()),
    ))
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
    deck: Arc<DeckStore>,
    plugin: Arc<deck_lib::plugin::PluginRegistry>,
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
    let plugin = Arc::new(deck_lib::plugin::PluginRegistry::default());
    let config = ServiceConfig {
        origin: ORIGIN.to_string(),
        mode: ConnectionMode::default(),
        port: 0,
        deck: store.clone(),
        actions: Arc::new(deck_lib::actions::ActionDispatcher::new(obs.clone(), system.clone(), plugin.clone())),
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
        deck: store,
        plugin,
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
            origin: origin.to_string(), mode: ConnectionMode::default(), port: 0, deck: store,
            actions: default_actions(), assets: default_assets(),
            clock: default_clock(), limits: Limits::default(),
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
        origin: "https://deck.tailnet.ts.net:443".to_string(), mode: ConnectionMode::default(), port: 0, deck: store,
        actions: default_actions(), assets: default_assets(),
        clock: default_clock(), limits: Limits::default(),
    };
    let service = start(config).await.expect(":443 origin is valid");
    assert_eq!(
        service.status().await.origin.as_deref(),
        Some("https://deck.tailnet.ts.net")
    );
    service.stop().await;
}

fn transport_config(origin: &str, mode: ConnectionMode, deck: Arc<DeckStore>) -> ServiceConfig {
    ServiceConfig {
        origin: origin.into(), mode, port: 0, deck, actions: default_actions(),
        assets: default_assets(), clock: default_clock(), limits: Limits::default(),
    }
}

#[tokio::test]
async fn connection_mode_defaults_and_local_origin_canonicalization() {
    assert_eq!(ConnectionMode::default(), ConnectionMode::Tailscale);
    assert_eq!(serde_json::to_value(ConnectionMode::LocalHttps).unwrap(), "local_https");
    assert!(serde_json::from_str::<ConnectionMode>("\"http\"").is_err());
    let dir = TempDir::new("local-origins");
    let deck = Arc::new(DeckStore::new(dir.path.join(DECK_FILE_NAME)));
    save_default_deck(&deck).await;
    let mut default = ServiceConfig::new(ORIGIN,deck.clone(),default_obs(),default_system(Arc::new(FakeRunner::new(vec![]))),Arc::new(deck_lib::plugin::PluginRegistry::default()),default_assets());
    assert_eq!(default.mode,ConnectionMode::Tailscale); default.port=0;
    let service=start(default).await.unwrap();
    assert_eq!(service.status().await.mode,Some(ConnectionMode::Tailscale));service.stop().await;
    for (input,canonical) in [
        ("https://deck.local","https://deck.local"),
        ("HTTPS://Deck.LAN:8443/","https://deck.lan:8443"),
        ("https://room.deck.home.arpa:443","https://room.deck.home.arpa"),
        ("https://10.0.0.1:1","https://10.0.0.1:1"),
        ("https://172.16.0.1:8443","https://172.16.0.1:8443"),
        ("https://172.31.255.255:65535","https://172.31.255.255:65535"),
        ("https://192.168.0.1:443","https://192.168.0.1"),
        ("https://[fc00::1]:8443","https://[fc00::1]:8443"),
        ("https://[FD00:0:0:0:0:0:0:1]:8443","https://[fd00::1]:8443"),
        ("https://[fe80::1]:8443","https://[fe80::1]:8443"),
        ("https://[febf::1]","https://[febf::1]"),
    ] {
        let service=start(transport_config(input,ConnectionMode::LocalHttps,deck.clone())).await.unwrap();
        let status=service.status().await;
        assert_eq!(status.mode,Some(ConnectionMode::LocalHttps));
        assert_eq!(status.origin.as_deref(),Some(canonical));
        let invitation=service.create_invitation().await.unwrap();
        assert!(invitation.url.starts_with(&format!("{canonical}/#/pair?invite=")));
        let host=canonical.strip_prefix("https://").unwrap();
        let index=http_request(service.port(),"GET","/",host,None,None,None).await;
        assert_eq!(index.status,200,"{input}");
        assert!(index.header("content-security-policy").unwrap().contains(&canonical.replacen("https://","wss://",1)));
        if !host.contains(':') || host.ends_with(']') {
            let explicit=http_request(service.port(),"GET","/",&format!("{host}:443"),None,None,None).await;
            assert_eq!(explicit.status,200,"default port equivalent {input}");
        }
        service.stop().await;
    }
}

#[tokio::test]
async fn local_https_rejects_public_loopback_and_ambiguous_url_syntax() {
    let dir=TempDir::new("local-invalid");
    let deck=Arc::new(DeckStore::new(dir.path.join(DECK_FILE_NAME)));
    let invalid=[
        "http://deck.local", "https://example.com", "https://deck.ts.net", "https://localhost", "https://localhost.local",
        "https://127.0.0.1", "https://127.1.2.3", "https://0.0.0.0", "https://8.8.8.8", "https://224.0.0.1",
        "https://169.254.1.1", "https://100.64.0.1", "https://172.15.0.1", "https://172.32.0.1", "https://192.169.0.1",
        "https://[::]", "https://[::1]", "https://[::ffff:192.168.1.1]", "https://[2001:db8::1]", "https://[ff02::1]", "https://[fec0::1]",
        "https://[fe80::1%25en0]", "https://10.1", "https://0x0a000001", "https://167772161", "https://010.0.0.1", "https://10.0.0.01",
        "https://deck.local.", "https://deck.local:0", "https://deck.local:65536", "https://deck.local:", "https://deck.local:08443",
        "https://user@deck.local", "https://user:password@deck.local", "https://@deck.local", "https://deck.local/path", "https://deck.local/.",
        "https://deck.local/..", "https://deck.local//", "https://deck.local?", "https://deck.local#", "https://deck.local\\evil",
        " https://deck.local", "https://deck.local ", "https://deck.\tlocal", "https://deck.\nlocal", "https://deck%2elocal", "https:///deck.local",
        "https://déck.local", "https://*.local", "https://-deck.local", "https://deck-.local", "https://deck_name.local", "https://deck..local",
        "https://.local", "https://local", "https://home.arpa", "https://deck.local.example.com", "https://[fd00::1]:443:8443",
    ];
    for input in invalid.iter().map(|s|s.to_string()).chain([
        format!("https://{}.local","x".repeat(64)),
        format!("https://{}.{}.{}.{}.local","x".repeat(63),"x".repeat(63),"x".repeat(63),"x".repeat(63)),
        format!("https://{}.local","x".repeat(2048)),
    ]) {
        let error=start(transport_config(&input,ConnectionMode::LocalHttps,deck.clone())).await.err().expect("must reject unsafe origin");
        assert!(matches!(error,RemoteError::InvalidOrigin {..}),"{input}");
        let safe=serde_json::to_string(&error).unwrap();assert!(!safe.contains("password"));
    }
    for input in ["https://deck.local", "https://192.168.1.2:8443", "https://[fd00::1]", "https://deck.ts.net:8443", "https://deck.ts.net/.", "https://deck.ts.net.", "https://@deck.ts.net"] {
        assert!(matches!(start(transport_config(input,ConnectionMode::Tailscale,deck.clone())).await.err(),Some(RemoteError::InvalidOrigin {..})),"{input}");
    }
}

#[tokio::test]
async fn local_proxy_pairing_actions_and_websocket_require_exact_authority_and_auth() {
    for origin in ["https://deck.local:8443", "https://192.168.1.2:8443", "https://[fd00::123]:8443"] {
        let dir=TempDir::new("local-proxy");let deck=Arc::new(DeckStore::new(dir.path.join(DECK_FILE_NAME)));
        save_default_deck(&deck).await;
        let runner=Arc::new(FakeRunner::new(vec![ok(""),ok("Volume: 0.50")]));
        let mut config=transport_config(origin,ConnectionMode::LocalHttps,deck);
        config.actions=Arc::new(deck_lib::actions::ActionDispatcher::new(default_obs(),default_system(runner.clone()),Arc::new(deck_lib::plugin::PluginRegistry::default())));
        let service=start(config).await.unwrap();let port=service.port();
        let host=origin.strip_prefix("https://").unwrap();let bare=host.strip_suffix(":8443").unwrap();
        let command=json!({"id":"local-action","revision":1,"controlId":"ctl_volume"}).to_string();
        let unauth=http_request(port,"POST","/api/v1/commands",host,Some(origin),None,Some(&command)).await;
        assert_eq!(unauth.status,401);assert!(runner.calls().is_empty());
        assert!(ws_connect(port,host,origin,None).await.is_err());
        for wrong_host in [bare.to_string(),format!("{bare}:443"),format!("{bare}:9443")] {
            let response=http_request_raw(port,"GET","/api/v1/state",&wrong_host,None,None,None,&[("x-forwarded-host",host),("forwarded",&format!("host={host};proto=https"))]).await;
            assert_eq!(response.status,400,"wrong Host {wrong_host}");
        }
        let invitation=service.create_invitation().await.unwrap();
        assert_eq!(invitation.url,format!("{origin}/#/pair?invite={}",invitation.invitation));
        let pair=json!({"invitation":invitation.invitation,"name":"Local phone"}).to_string();
        let paired=http_request(port,"POST","/api/v1/pair",host,Some(origin),None,Some(&pair)).await;
        assert_eq!(paired.status,200);
        let cookie=paired.header("set-cookie").unwrap();
        for flag in ["Secure","HttpOnly","SameSite=Strict","Path=/"] {assert!(cookie.contains(flag));}assert!(!cookie.contains("Domain="));
        let token=paired.cookie_token().unwrap();let id=paired.json()["requestId"].as_str().unwrap().to_string();
        let pending=http_request(port,"POST","/api/v1/commands",host,Some(origin),Some(&token),Some(&command)).await;
        assert_eq!(pending.status,403);assert!(runner.calls().is_empty());
        service.approve_device(&id).await.unwrap();
        for wrong_origin in [format!("https://{bare}"),format!("https://{bare}:9443"),format!("http://{host}"),format!("{origin}/")] {
            let wrong=http_request_raw(port,"POST","/api/v1/commands",host,Some(&wrong_origin),Some(&token),Some(&command),&[("x-forwarded-proto","https"),("x-forwarded-host",host)]).await;
            assert_eq!(wrong.status,403);assert!(ws_connect(port,host,&wrong_origin,Some(&token)).await.is_err());
        }
        let internal=http_request(port,"GET","/api/v1/state",&format!("127.0.0.1:{port}"),None,Some(&token),None).await;
        assert_eq!(internal.status,200,"intentional loopback proxy Host remains allowed");
        let mut ws=ws_connect(port,host,origin,Some(&token)).await.unwrap();
        assert_eq!(read_json(&mut ws).await["type"],"snapshot");
        let result=http_request(port,"POST","/api/v1/commands",host,Some(origin),Some(&token),Some(&command)).await;
        assert_eq!(result.status,200);assert_eq!(result.json()["state"],"confirmed");
        let repeated=http_request(port,"POST","/api/v1/commands",host,Some(origin),Some(&token),Some(&command)).await;
        assert_eq!(repeated.json(),result.json());assert_eq!(runner.calls().len(),2);
        close_websocket(&mut ws).await;service.stop().await;
    }
}

#[tokio::test]
async fn mode_switch_requires_stop_and_clears_device_credentials() {
    let admin=RemoteAdmin::default();assert!(admin.status().await.mode.is_none());
    let dir=TempDir::new("mode-switch");let deck=Arc::new(DeckStore::new(dir.path.join(DECK_FILE_NAME)));
    save_default_deck(&deck).await;
    let status=admin.start(transport_config(ORIGIN,ConnectionMode::Tailscale,deck.clone())).await.unwrap();
    assert_eq!(status.mode,Some(ConnectionMode::Tailscale));
    let invitation=admin.create_invitation().await.unwrap();
    let pair=json!({"invitation":invitation.invitation,"name":"Old phone"}).to_string();
    let paired=http_request(status.port.unwrap(),"POST","/api/v1/pair",PUBLIC_HOST,Some(ORIGIN),None,Some(&pair)).await;
    assert_eq!(paired.status,200);let token=paired.cookie_token().unwrap();
    admin.approve_device(paired.json()["requestId"].as_str().unwrap()).await.unwrap();
    assert!(matches!(admin.start(transport_config("https://deck.local:8443",ConnectionMode::LocalHttps,deck.clone())).await,Err(RemoteError::AlreadyRunning {..})));
    let unchanged=admin.status().await;assert_eq!(unchanged.mode,Some(ConnectionMode::Tailscale));assert_eq!(unchanged.origin.as_deref(),Some(ORIGIN));
    assert_eq!(unchanged.approved_devices,1);
    let stopped=admin.stop().await;assert!(!stopped.running);assert!(stopped.mode.is_none());assert!(stopped.origin.is_none());
    let status=admin.start(transport_config("https://deck.local:8443",ConnectionMode::LocalHttps,deck)).await.unwrap();
    assert_eq!(status.mode,Some(ConnectionMode::LocalHttps));assert_eq!(status.approved_devices,0);assert!(admin.list_devices().await.unwrap().is_empty());
    let stale=http_request(status.port.unwrap(),"GET","/api/v1/state","deck.local:8443",None,Some(&token),None).await;
    assert_eq!(stale.status,401);admin.stop().await;
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
        origin: ORIGIN.to_string(), mode: ConnectionMode::default(), port: 0, deck: store.clone(),
        actions: default_actions(), assets: default_assets(),
        clock: default_clock(), limits: Limits::default(),
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
    assert_eq!(initial["deck"]["version"], 2);

    let mut deck = default_deck();
    deck.pages[0].name = "Changed".to_string();
    deck.pages[0].controls[0].icon = Some(deck_lib::icons::ControlIcon::Image { src: "data:image/svg+xml;base64,PHN2Zy8+".into() });
    let saved = store.save(1, deck).await.expect("save");
    assert_eq!(saved.revision, 2);

    let update = read_json(&mut websocket).await;
    assert_eq!(update["type"], "snapshot");
    assert_eq!(update["revision"], 2);
    assert_eq!(update["deck"]["pages"][0]["name"], "Changed");
    assert_eq!(update["deck"]["pages"][0]["controls"][0]["icon"], json!({"type":"image","src":"data:image/svg+xml;base64,PHN2Zy8+"}));

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

async fn plugin_deck(env: &TestEnv) {
    let mut deck = default_deck();
    deck.pages[0].controls.push(deck_lib::deck::Control {
        id: "ctl_plugin".into(), label: "Plugin volume".into(), row_span: None, column_span: None, icon: None,
        action: deck_lib::deck::ControlAction::Plugin {
            plugin_id: "fake".into(), plugin_action: "set-volume".into(),
            plugin_args: json!({"volume":50}).as_object().unwrap().clone(),
        },
    });
    assert_eq!(env.deck.save(1,deck).await.unwrap().deck.version,2);
}

#[tokio::test]
async fn disconnected_plugin_and_phone_payload_injection_are_rejected() {
    let env = default_env().await;
    plugin_deck(&env).await;
    let (_,token) = approved_device(&env,"Plugin").await;
    let command = json!({"id":"plugin_1","revision":2,"controlId":"ctl_plugin"});
    for (field,value) in [("value",json!(80)),("value",json!(null)),("args",json!({"volume":99})),("action",json!("go")),("program",json!("/bin/sh")),("entrypoint",json!("/private/evil.js"))] {
        let mut injected = command.clone(); injected[field] = value;
        let response = http_request(env.port,"POST","/api/v1/commands",PUBLIC_HOST,Some(ORIGIN),Some(&token),Some(&injected.to_string())).await;
        assert_eq!(response.status,400,"{field}: {}",response.text());
    }
    let response = http_request(env.port,"POST","/api/v1/commands",PUBLIC_HOST,Some(ORIGIN),Some(&token),Some(&command.to_string())).await;
    assert_eq!(response.status,200);
    assert_eq!(response.json()["state"],"failed");
    assert_eq!(response.json()["code"],"plugin_unavailable");
    assert_eq!(env.plugin.snapshot("fake").await.unwrap().status,deck_lib::plugin::ConnectionStatus::Disconnected);
    env.service.stop().await;
}

#[tokio::test]
async fn phone_saved_plugin_ids_route_independently_and_disabling_one_keeps_the_other_live() {
    let env=default_env().await;
    let node=std::process::Command::new("node").args(["-p","process.execPath"]).output().expect("Node required for isolated multi-plugin test");assert!(node.status.success());
    let node=String::from_utf8(node.stdout).unwrap().trim().to_owned();
    let mut deck=env.deck.load().await.unwrap().deck;
    for (id,volume) in [("alpha",17),("beta",83)] {
        let entry=env._dir.path.join(format!("{id}.cjs"));
        let source=format!("const pluginId={};\n",json!(id))+r#"
let count=0;require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line),base={protocolVersion:1,id:r.id,type:'result'};
 if(r.type==='describe'){process.stdout.write(JSON.stringify({...base,manifest:{id:pluginId,version:'0.1.0',protocolVersion:1,actions:[{id:'set-volume',title:'Volume',config:{volume:{type:'integer',minimum:0,maximum:100}}}]}})+'\n');return;}
 if(r.type==='execute')count++;
 process.stdout.write(JSON.stringify({...base,state:{pluginId,count,volume:r.args?.volume??0}})+'\n');
});
"#;
        std::fs::write(&entry,source).unwrap();env.plugin.connect(id,node.clone(),entry.to_str().unwrap().into()).await.unwrap();
        deck.pages[0].controls.push(deck_lib::deck::Control {id:format!("ctl_{id}"),label:id.into(),row_span:None,column_span:None,icon:None,action:deck_lib::deck::ControlAction::Plugin {plugin_id:id.into(),plugin_action:"set-volume".into(),plugin_args:json!({"volume":volume}).as_object().unwrap().clone()}});
    }
    env.deck.save(1,deck).await.unwrap();let (_,token)=approved_device(&env,"Multi plugin").await;
    for (id,volume) in [("alpha",17),("beta",83)] {
        let command=json!({"id":format!("run_{id}"),"revision":2,"controlId":format!("ctl_{id}")}).to_string();
        let response=http_request(env.port,"POST","/api/v1/commands",PUBLIC_HOST,Some(ORIGIN),Some(&token),Some(&command)).await;
        assert_eq!(response.status,200);let result=response.json();assert_eq!(result["state"],"confirmed");assert_eq!(result["observed"]["pluginId"],id);assert_eq!(result["observed"]["volume"],volume);assert_eq!(result["observed"]["count"],1);
    }
    env.plugin.disconnect("alpha").await.unwrap();assert_eq!(env.plugin.snapshots().await.len(),1);
    for id in ["alpha","beta"] {
        let command=json!({"id":format!("after_{id}"),"revision":2,"controlId":format!("ctl_{id}")}).to_string();
        let response=http_request(env.port,"POST","/api/v1/commands",PUBLIC_HOST,Some(ORIGIN),Some(&token),Some(&command)).await;
        let result=response.json();if id=="alpha" {assert_eq!(result["code"],"plugin_unavailable");}else{assert_eq!(result["state"],"confirmed");assert_eq!(result["observed"]["count"],2);assert_eq!(result["observed"]["pluginId"],"beta");}
    }
    env.plugin.disconnect("beta").await.unwrap();env.service.stop().await;
}

#[tokio::test]
async fn remote_plugin_uses_shared_connection_saved_args_and_never_replays() {
    for crash in [false,true] {
        let env = default_env().await;
        plugin_deck(&env).await;
        let entrypoint = env._dir.path.join("fake-plugin.cjs");
        let log = env._dir.path.join("plugin.log");
        let source = format!("const log={}; const crash={};\n",json!(log.to_str().unwrap()),crash) + r#"
const fs=require('node:fs'); const rl=require('node:readline').createInterface({input:process.stdin});
let count=0;
rl.on('line',line=>{
 const r=JSON.parse(line); fs.appendFileSync(log,JSON.stringify(r)+'\n');
 const base={protocolVersion:1,id:r.id,type:'result'};
 if(r.type==='describe') {
  process.stdout.write(JSON.stringify({...base,manifest:{id:'fake',version:'0.0.1',protocolVersion:1,actions:[{id:'set-volume',title:'Volume',config:{volume:{type:'integer',minimum:0,maximum:100}}}]}})+'\n');return;
 }
 if(r.type==='execute') {count++;if(crash)process.exit(7);}
 process.stdout.write(JSON.stringify({...base,state:{count,volume:r.args?.volume??0}})+'\n');
});
"#;
        std::fs::write(&entrypoint,source).unwrap();
        let node = std::process::Command::new("node").args(["-p","process.execPath"]).output().expect("Node required for remote fake-plugin test; not skipped");
        assert!(node.status.success());
        let snapshot = env.plugin.connect("fake",String::from_utf8(node.stdout).unwrap().trim().into(),entrypoint.to_str().unwrap().into()).await.unwrap();
        assert!(snapshot.state.is_none());
        assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(),1,"connect must describe only");
        let (_,token) = approved_device(&env,"Plugin").await;
        let command = json!({"id":"plugin_execute","revision":2,"controlId":"ctl_plugin"}).to_string();
        let first = http_request(env.port,"POST","/api/v1/commands",PUBLIC_HOST,Some(ORIGIN),Some(&token),Some(&command)).await;
        assert_eq!(first.status,200);
        let result = first.json();
        if crash {
            assert_eq!(result["state"],"unknown"); assert_eq!(result["code"],"plugin_outcome_unknown");
            assert_eq!(env.plugin.snapshot("fake").await.unwrap().status,deck_lib::plugin::ConnectionStatus::Stopped);
        } else {
            assert_eq!(result["state"],"confirmed"); assert_eq!(result["observed"]["volume"],50);
            assert_eq!(env.plugin.snapshot("fake").await.unwrap().state.unwrap()["count"],1,"desktop sees remote result");
        }
        let repeated = http_request(env.port,"POST","/api/v1/commands",PUBLIC_HOST,Some(ORIGIN),Some(&token),Some(&command)).await;
        assert_eq!(repeated.json(),result);
        let requests: Vec<Value> = std::fs::read_to_string(&log).unwrap().lines().map(|l|serde_json::from_str(l).unwrap()).collect();
        assert_eq!(requests.len(),2); assert_eq!(requests[1]["args"],json!({"volume":50}));
        assert_eq!(requests[1]["action"],"set-volume");
        if crash {
            let fresh = json!({"id":"plugin_fresh","revision":2,"controlId":"ctl_plugin"}).to_string();
            let r = http_request(env.port,"POST","/api/v1/commands",PUBLIC_HOST,Some(ORIGIN),Some(&token),Some(&fresh)).await;
            assert_eq!(r.json()["code"],"plugin_unavailable");
            assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(),2);
        } else {
            let mut deck = env.deck.load().await.unwrap().deck;
            let control = deck.pages[0].controls.last_mut().unwrap();
            if let deck_lib::deck::ControlAction::Plugin { plugin_action, .. } = &mut control.action { *plugin_action = "unknown".into(); }
            env.deck.save(2,deck).await.unwrap();
            let setup = json!({"id":"plugin_setup","revision":3,"controlId":"ctl_plugin"}).to_string();
            let r = http_request(env.port,"POST","/api/v1/commands",PUBLIC_HOST,Some(ORIGIN),Some(&token),Some(&setup)).await;
            assert_eq!(r.json()["state"],"failed"); assert_eq!(r.json()["code"],"plugin_setup_required");
            assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(),2,"unknown action must not reach process");
        }
        env.plugin.disconnect("fake").await.unwrap();
        env.service.stop().await;
    }
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
        origin: ORIGIN.to_string(), mode: ConnectionMode::default(), port: 0, deck: store.clone(),
        actions: default_actions(), assets: default_assets(),
        clock: default_clock(), limits: Limits::default(),
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
        origin: ORIGIN.to_string(), mode: ConnectionMode::default(), port, deck: store,
        actions: default_actions(), assets: default_assets(),
        clock: default_clock(), limits: Limits::default(),
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
        origin: ORIGIN.to_string(), mode: ConnectionMode::default(), port: 0, deck: store,
        actions: default_actions(), assets: default_assets(),
        clock: default_clock(), limits: Limits::default(),
    };
    let status = admin.start(config).await.expect("admin start");
    assert!(status.running);
    assert!(status.origin.is_some());

    let dir = TempDir::new("admin-again");
    let store = Arc::new(DeckStore::new(dir.path.join(DECK_FILE_NAME)));
    save_default_deck(&store).await;
    let config = ServiceConfig {
        origin: ORIGIN.to_string(), mode: ConnectionMode::default(), port: 0, deck: store,
        actions: default_actions(), assets: default_assets(),
        clock: default_clock(), limits: Limits::default(),
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
        origin: ORIGIN.to_string(), mode: ConnectionMode::default(), port, deck: store,
        actions: default_actions(), assets: default_assets(),
        clock: default_clock(), limits: Limits::default(),
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
        origin: ORIGIN.to_string(), mode: ConnectionMode::default(), port: 0, deck: store,
        actions: default_actions(), assets: default_assets(),
        clock: default_clock(), limits: Limits::default(),
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
        origin: ORIGIN.to_string(), mode: ConnectionMode::default(), port: 0, deck: store,
        actions: default_actions(), assets: default_assets(),
        clock: default_clock(), limits: Limits::default(),
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
            mode: ConnectionMode::default(),
            port: 0,
            deck: store.clone(),
            actions: Arc::new(deck_lib::actions::ActionDispatcher::new(default_obs(), default_system(runner.clone()), Arc::new(deck_lib::plugin::PluginRegistry::default()))),
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
