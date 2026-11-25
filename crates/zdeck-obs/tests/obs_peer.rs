//! Integration tests against a small in-process fake OBS5 WebSocket peer.
//!
//! These exercise the real `obws` client over an owned ephemeral loopback port.
//! No live OBS Studio instance is involved and no password is ever printed.

use std::time::Duration;

use base64::engine::{general_purpose, Engine as _};
use zdeck_obs::{ObsError, ObsState, Timeouts};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::net::{TcpListener, TcpStream};
use tokio_websockets::{CloseCode, Message, ServerBuilder, WebSocketStream};

const PASSWORD: &str = "correct horse battery staple";
const SALT: &str = "test-salt";
const CHALLENGE: &str = "test-challenge";

#[derive(Clone)]
struct PeerOptions {
    /// Require this password. `None` accepts any Identify.
    password: Option<&'static str>,
    scenes: Vec<&'static str>,
    current: &'static str,
    /// Delay the GetVersion reply, used to hold the connect lock.
    version_delay: Duration,
    /// Accept the TCP socket but never complete the WebSocket upgrade.
    no_upgrade: bool,
    /// Receive the second GetSceneList but never answer it.
    hang_scene_list: bool,
    /// Close the socket when the second GetSceneList arrives.
    drop_on_scene_list: bool,
    /// Answer SetCurrentProgramScene with an OBS error.
    fail_set: bool,
}

impl Default for PeerOptions {
    fn default() -> Self {
        Self {
            password: None,
            scenes: vec!["Scene A", "Scene B"],
            current: "Scene A",
            version_delay: Duration::ZERO,
            no_upgrade: false,
            hang_scene_list: false,
            drop_on_scene_list: false,
            fail_set: false,
        }
    }
}

fn obs_auth(password: &str, salt: &str, challenge: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(password.as_bytes());
    hasher.update(salt.as_bytes());
    let secret = general_purpose::STANDARD.encode(hasher.finalize_reset());
    hasher.update(secret.as_bytes());
    hasher.update(challenge.as_bytes());
    general_purpose::STANDARD.encode(hasher.finalize())
}

fn test_state() -> ObsState {
    ObsState::with_timeouts(Timeouts {
        connect: Duration::from_millis(600),
        request: Duration::from_millis(400),
    })
}

/// Start a fake peer and return its loopback port.
async fn start_peer(options: PeerOptions) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    tokio::spawn(async move {
        let Ok((stream, _)) = listener.accept().await else {
            return;
        };

        if options.no_upgrade {
            // Hold the TCP socket without upgrading so the client times out.
            tokio::time::sleep(Duration::from_secs(5)).await;
            drop(stream);
            return;
        }

        let Ok((_request, ws)) = ServerBuilder::new().accept(stream).await else {
            return;
        };
        handle_peer(ws, options).await;
    });

    port
}

async fn send_response(
    ws: &mut WebSocketStream<TcpStream>,
    request_id: &str,
    ok: bool,
    data: Value,
) {
    let status = if ok {
        json!({ "result": true, "code": 100 })
    } else {
        json!({ "result": false, "code": 205, "comment": "peer error" })
    };
    let payload = json!({
        "op": 7,
        "d": {
            "requestType": "",
            "requestId": request_id,
            "requestStatus": status,
            "responseData": data,
        }
    });
    let _ = ws.send(Message::text(payload.to_string())).await;
}

async fn handle_peer(mut ws: WebSocketStream<TcpStream>, options: PeerOptions) {
    let hello = if options.password.is_some() {
        json!({
            "op": 0,
            "d": {
                "obsWebSocketVersion": "5.5.2",
                "rpcVersion": 1,
                "authentication": { "challenge": CHALLENGE, "salt": SALT },
            }
        })
    } else {
        json!({ "op": 0, "d": { "obsWebSocketVersion": "5.5.2", "rpcVersion": 1 } })
    };
    if ws.send(Message::text(hello.to_string())).await.is_err() {
        return;
    }

    let Some(Ok(identify)) = ws.next().await else {
        return;
    };
    let Some(text) = identify.as_text() else {
        return;
    };
    let identify: Value = serde_json::from_str(text).unwrap();
    assert_eq!(identify["op"], 1);

    if let Some(password) = options.password {
        let expected = obs_auth(password, SALT, CHALLENGE);
        let provided = identify["d"]["authentication"].as_str().unwrap_or_default();
        if provided != expected {
            let code = CloseCode::try_from(4009).unwrap();
            let _ = ws.send(Message::close(Some(code), "auth failed")).await;
            return;
        }
    }

    let identified = json!({ "op": 2, "d": { "negotiatedRpcVersion": 1 } });
    if ws
        .send(Message::text(identified.to_string()))
        .await
        .is_err()
    {
        return;
    }

    let mut current = options.current.to_string();
    let mut scene_list_seen = 0_u32;

    while let Some(message) = ws.next().await {
        let Ok(message) = message else {
            return;
        };
        let Some(text) = message.as_text() else {
            return;
        };
        let Ok(request) = serde_json::from_str::<Value>(text) else {
            continue;
        };
        if request["op"] != 6 {
            continue;
        }

        let request_type = request["d"]["requestType"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let request_id = request["d"]["requestId"]
            .as_str()
            .unwrap_or("0")
            .to_string();

        match request_type.as_str() {
            "GetVersion" => {
                if !options.version_delay.is_zero() {
                    tokio::time::sleep(options.version_delay).await;
                }
                let data = json!({
                    "obsStudioVersion": "30.2.0",
                    "obsWebSocketVersion": "5.5.2",
                    "rpcVersion": 1,
                    "availableRequests": [],
                    "supportedImageFormats": [],
                    "platform": "linux",
                    "platformDescription": "fake peer",
                });
                send_response(&mut ws, &request_id, true, data).await;
            }
            "GetSceneList" => {
                scene_list_seen += 1;
                if options.hang_scene_list && scene_list_seen > 1 {
                    continue;
                }
                if options.drop_on_scene_list && scene_list_seen > 1 {
                    return;
                }
                let scenes: Vec<Value> = options
                    .scenes
                    .iter()
                    .enumerate()
                    .map(|(index, name)| {
                        json!({
                            "sceneName": name,
                            "sceneUuid": format!("00000000-0000-0000-0000-{index:012}"),
                            "sceneIndex": index,
                        })
                    })
                    .collect();
                let data = json!({
                    "scenes": scenes,
                    "currentProgramSceneName": current,
                    "currentProgramSceneUuid": "00000000-0000-0000-0000-000000000000",
                    "currentPreviewSceneName": current,
                    "currentPreviewSceneUuid": "00000000-0000-0000-0000-000000000000",
                });
                send_response(&mut ws, &request_id, true, data).await;
            }
            "SetCurrentProgramScene" => {
                if options.fail_set {
                    send_response(&mut ws, &request_id, false, Value::Null).await;
                } else {
                    current = request["d"]["requestData"]["sceneName"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string();
                    send_response(&mut ws, &request_id, true, Value::Null).await;
                }
            }
            "GetCurrentProgramScene" => {
                // obs-websocket returns the generic scene id fields here.
                let data = json!({
                    "sceneName": current,
                    "sceneUuid": "00000000-0000-0000-0000-000000000000",
                });
                send_response(&mut ws, &request_id, true, data).await;
            }
            _ => send_response(&mut ws, &request_id, false, Value::Null).await,
        }
    }
}

async fn unused_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    port
}

#[tokio::test]
async fn connects_without_auth_and_lists_scenes() {
    let port = start_peer(PeerOptions::default()).await;
    let state = test_state();

    let snapshot = state.connect(port, None).await.unwrap();

    assert!(snapshot.connected);
    assert_eq!(snapshot.host, "127.0.0.1");
    assert_eq!(snapshot.scenes, vec!["Scene A", "Scene B"]);
    assert_eq!(snapshot.current_scene.as_deref(), Some("Scene A"));
}

#[tokio::test]
async fn connects_with_password_authentication() {
    let port = start_peer(PeerOptions {
        password: Some(PASSWORD),
        ..PeerOptions::default()
    })
    .await;
    let state = test_state();

    let snapshot = state
        .connect(port, Some(PASSWORD.to_string()))
        .await
        .unwrap();

    assert!(snapshot.connected);
    assert_eq!(snapshot.current_scene.as_deref(), Some("Scene A"));
}

#[tokio::test]
async fn rejects_a_wrong_password() {
    let port = start_peer(PeerOptions {
        password: Some(PASSWORD),
        ..PeerOptions::default()
    })
    .await;
    let state = test_state();

    let error = state
        .connect(port, Some("definitely-wrong".to_string()))
        .await
        .unwrap_err();

    assert!(
        matches!(error, ObsError::AuthRejected { .. }),
        "unexpected error: {error:?}"
    );
    assert!(!error.to_string().contains("definitely-wrong"));
}

#[tokio::test]
async fn reports_unavailable_when_nothing_is_listening() {
    let port = unused_port().await;
    // Windows can take longer than the fake-peer 600 ms deadline to refuse TCP.
    let state = ObsState::default();

    let error = state.connect(port, None).await.unwrap_err();

    assert!(
        matches!(error, ObsError::Unavailable { .. }),
        "unexpected error: {error:?}"
    );
}

#[tokio::test]
async fn times_out_when_the_websocket_upgrade_never_completes() {
    let port = start_peer(PeerOptions {
        no_upgrade: true,
        ..PeerOptions::default()
    })
    .await;
    let state = test_state();

    let error = state.connect(port, None).await.unwrap_err();

    assert!(
        matches!(error, ObsError::Timeout { .. }),
        "unexpected error: {error:?}"
    );
}

#[tokio::test]
async fn times_out_a_hung_scene_list_request() {
    let port = start_peer(PeerOptions {
        hang_scene_list: true,
        ..PeerOptions::default()
    })
    .await;
    let state = test_state();
    state.connect(port, None).await.unwrap();

    let error = state.snapshot().await.unwrap_err();

    assert!(
        matches!(error, ObsError::Timeout { .. }),
        "unexpected error: {error:?}"
    );
}

#[tokio::test]
async fn detects_a_dropped_connection_and_stops_reporting_it_as_live() {
    let port = start_peer(PeerOptions {
        drop_on_scene_list: true,
        ..PeerOptions::default()
    })
    .await;
    let state = test_state();
    state.connect(port, None).await.unwrap();

    let error = state.snapshot().await.unwrap_err();
    assert!(
        matches!(error, ObsError::Disconnected { .. }),
        "unexpected error: {error:?}"
    );

    // The stale session was cleared, so the next read is honestly disconnected.
    let snapshot = state.snapshot().await.unwrap();
    assert!(!snapshot.connected);
    assert!(snapshot.current_scene.is_none());
}

#[tokio::test]
async fn switches_scene_and_confirms_the_program_scene() {
    let port = start_peer(PeerOptions::default()).await;
    let state = test_state();
    state.connect(port, None).await.unwrap();

    let result = state.switch_scene("Scene B").await.unwrap();

    assert!(result.confirmed);
    assert_eq!(result.requested, "Scene B");
    assert_eq!(result.snapshot.current_scene.as_deref(), Some("Scene B"));
}

#[tokio::test]
async fn rejects_a_scene_that_obs_does_not_have() {
    let port = start_peer(PeerOptions::default()).await;
    let state = test_state();
    state.connect(port, None).await.unwrap();

    let error = state.switch_scene("Missing scene").await.unwrap_err();

    assert!(
        matches!(error, ObsError::SceneNotFound { .. }),
        "unexpected error: {error:?}"
    );
}

#[tokio::test]
async fn reports_a_failed_switch_instead_of_claiming_success() {
    let port = start_peer(PeerOptions {
        fail_set: true,
        ..PeerOptions::default()
    })
    .await;
    let state = test_state();
    state.connect(port, None).await.unwrap();

    let error = state.switch_scene("Scene B").await.unwrap_err();

    assert!(
        matches!(error, ObsError::RequestFailed { .. }),
        "unexpected error: {error:?}"
    );
}

#[tokio::test]
async fn switch_without_a_connection_is_not_connected() {
    let state = test_state();

    let error = state.switch_scene("Scene A").await.unwrap_err();

    assert!(
        matches!(error, ObsError::NotConnected { .. }),
        "unexpected error: {error:?}"
    );
}

#[tokio::test]
async fn a_newer_connect_replaces_a_slower_one() {
    let slow_port = start_peer(PeerOptions {
        scenes: vec!["Slow scene"],
        current: "Slow scene",
        version_delay: Duration::from_millis(250),
        ..PeerOptions::default()
    })
    .await;
    let fast_port = start_peer(PeerOptions {
        scenes: vec!["Fast scene"],
        current: "Fast scene",
        ..PeerOptions::default()
    })
    .await;
    let state = test_state();

    // The slow connect is polled first and holds the lock; the fast connect waits
    // and must be the connection that remains active.
    let (slow, fast) = tokio::join!(
        state.connect(slow_port, None),
        state.connect(fast_port, None)
    );
    assert!(slow.is_ok() && fast.is_ok());

    let snapshot = state.snapshot().await.unwrap();
    assert_eq!(snapshot.scenes, vec!["Fast scene"]);
    assert_eq!(snapshot.current_scene.as_deref(), Some("Fast scene"));
}

#[tokio::test]
async fn disconnect_clears_the_session() {
    let port = start_peer(PeerOptions::default()).await;
    let state = test_state();
    state.connect(port, None).await.unwrap();

    state.disconnect().await;

    let snapshot = state.snapshot().await.unwrap();
    assert!(!snapshot.connected);
    assert!(matches!(
        state.switch_scene("Scene A").await.unwrap_err(),
        ObsError::NotConnected { .. }
    ));
}
