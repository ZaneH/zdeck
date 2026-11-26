pub mod actions;
pub mod deck;
pub mod icons;
#[cfg(target_os = "linux")]
mod linux_display;
#[cfg(feature = "native-smoke")]
mod native_smoke;
pub use zdeck_obs as obs;
mod obs_preferences;
pub use zdeck_plugin_host::{plugin, plugin_install};
pub mod remote;
pub use zdeck_system as system;
mod tray;

use std::sync::Arc;
use actions::{ActionDispatcher, ActionError, ActionErrorCode, CommandResult, DesktopActions, DesktopCommand};

use plugin::{PluginError, PluginSnapshot, PluginRegistry};
use deck::{Deck, DeckError, DeckStore, DECK_FILE_NAME};
use obs::{ObsError, ObsSnapshot, ObsState, SceneSwitchResult};
use remote::{
    AssetProvider, DeviceView, InvitationView, Limits, PublicAsset, RemoteAdmin, RemoteError,
    ConnectionMode, RemoteStatus, ServiceConfig, SystemClock, DEFAULT_PORT,
};
use system::{
    MediaApplyResult, MicrophoneApplyResult, MicrophoneSnapshot, OutputSnapshot, SystemError,
    SystemState, VolumeApplyResult,
};

/// Narrow adapter from Tauri's bundled asset resolver to the public service.
/// It serves only the paths the service's exact allowlist asks for.
struct TauriAssets {
    resolver: tauri::AssetResolver<tauri::Wry>,
}

// In dev the resolver reads exact files; bundled mode also has an index fallback.
fn allows_exact_asset(path: &str, keys: impl Iterator<Item = impl AsRef<str>>) -> bool {
    let mut keys = keys.peekable();
    keys.peek().is_none() || keys.any(|key| key.as_ref().trim_start_matches('/') == path)
}

impl AssetProvider for TauriAssets {
    fn get(&self, path: &str) -> Option<PublicAsset> {
        if !allows_exact_asset(path, self.resolver.iter().map(|(key, _)| key)) {
            return None;
        }
        let asset = self.resolver.get(path.to_string())?;
        Some(PublicAsset {
            bytes: asset.bytes,
            mime: asset.mime_type,
        })
    }
}

#[cfg(test)]
mod asset_tests {
    use super::allows_exact_asset;

    #[test]
    fn missing_bundled_assets_cannot_fall_back_to_the_editor() {
        let keys = ["/index.html", "/assets/app.js"];
        assert!(allows_exact_asset("index.html", keys.iter()));
        assert!(allows_exact_asset("assets/app.js", keys.iter()));
        assert!(!allows_exact_asset("assets/missing.html", keys.iter()));
        assert!(!allows_exact_asset("icons/missing.png", keys.iter()));
        assert!(allows_exact_asset("index.html", std::iter::empty::<&str>()));
    }
}

/// Shared native state. The phone service and the native commands hold the
/// same `Arc`s, so OBS/system sessions and the authoritative deck are shared.
pub struct AppState {
    store: Result<Arc<DeckStore>, DeckError>,
    obs: Arc<ObsState>,
    system: Arc<SystemState>,
    plugin: Arc<PluginRegistry>,
    actions: Arc<ActionDispatcher>,
    desktop: DesktopActions,
    assets: Arc<dyn AssetProvider>,
}

impl AppState {
    fn service_config(&self, origin: String, mode: ConnectionMode) -> Result<ServiceConfig, RemoteError> {
        Ok(ServiceConfig {
            origin, mode, port: DEFAULT_PORT,
            deck: self.store().map_err(|_| RemoteError::Unavailable {
                message: "The native deck store is unavailable.".into(),
            })?.clone(),
            actions: self.actions.clone(), assets: self.assets.clone(),
            clock: Arc::new(SystemClock), limits: Limits::default(),
        })
    }

    fn store(&self) -> Result<&Arc<DeckStore>, DeckError> {
        self.store.as_ref().map_err(Clone::clone)
    }
}

#[tauri::command]
async fn obs_connect(
    state: tauri::State<'_, AppState>,
    port: Option<u16>,
    password: Option<String>,
) -> Result<ObsSnapshot, ObsError> {
    let port = port.unwrap_or(obs::DEFAULT_PORT);
    state.obs.connect(port, password).await
}

#[tauri::command]
async fn obs_disconnect(state: tauri::State<'_, AppState>) -> Result<(), ObsError> {
    state.obs.disconnect().await;
    Ok(())
}

#[tauri::command]
async fn obs_snapshot(state: tauri::State<'_, AppState>) -> Result<ObsSnapshot, ObsError> {
    state.obs.snapshot().await
}

#[tauri::command]
async fn obs_switch_scene(
    state: tauri::State<'_, AppState>,
    scene: String,
) -> Result<SceneSwitchResult, ObsError> {
    state.obs.switch_scene(&scene).await
}

#[tauri::command]
async fn system_output_snapshot(
    state: tauri::State<'_, AppState>,
) -> Result<OutputSnapshot, SystemError> {
    state.system.output_snapshot().await
}

#[tauri::command]
async fn system_output_set_volume(
    state: tauri::State<'_, AppState>,
    volume: f64,
) -> Result<VolumeApplyResult, SystemError> {
    state.system.set_output_volume(volume).await
}

#[tauri::command]
async fn system_microphone_snapshot(
    state: tauri::State<'_, AppState>,
) -> Result<MicrophoneSnapshot, SystemError> {
    state.system.microphone_snapshot().await
}

#[tauri::command]
async fn system_microphone_set_muted(
    state: tauri::State<'_, AppState>,
    muted: bool,
) -> Result<MicrophoneApplyResult, SystemError> {
    state.system.set_microphone_muted(muted).await
}

#[tauri::command]
async fn system_media_snapshot(
    state: tauri::State<'_, AppState>,
) -> Result<system::MediaSnapshot, SystemError> {
    state.system.media_snapshot().await
}

#[tauri::command]
fn system_media_permission_status() -> system::media_permission::MediaPermission {
    system::media_permission::status()
}

fn local_media_setup_window(label: &str, url: &tauri::Url) -> bool {
    let local = matches!((url.scheme(), url.host_str()),
        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost")))
        || (cfg!(debug_assertions) && url.scheme() == "http"
            && url.host_str() == Some("localhost") && url.port() == Some(1420));
    label == "main" && local
}

#[cfg(test)]
mod media_setup_tests {
    use super::*;
    #[test]
    fn setup_rejects_remote_windows_and_origins() {
        for url in ["tauri://localhost/", "http://tauri.localhost/", "https://tauri.localhost/"] {
            let url = tauri::Url::parse(url).unwrap();
            assert!(local_media_setup_window("main", &url));
            assert!(!local_media_setup_window("phone", &url));
        }
        for url in ["https://example.com/", "http://127.0.0.1:1420/", "http://localhost:9876/", "file:///tmp/editor.html"] {
            assert!(!local_media_setup_window("main", &tauri::Url::parse(url).unwrap()));
        }
    }
}

#[tauri::command]
async fn system_media_permission_request(
    window: tauri::WebviewWindow,
) -> Result<system::media_permission::MediaPermission, SystemError> {
    // No remote ControlAction exposes setup. Also restrict IPC to the local editor.
    let url = window.url().map_err(|_| SystemError::CommandFailed {
        message: "Media setup is only available in the local desktop editor.".into(),
    })?;
    if !local_media_setup_window(window.label(), &url) {
        return Err(SystemError::CommandFailed {
            message: "Media setup is only available in the local desktop editor.".into(),
        });
    }
    let (send, receive) = tokio::sync::oneshot::channel();
    window.run_on_main_thread(move || {
        let _ = send.send(system::media_permission::request());
    }).map_err(|_| SystemError::CommandFailed {
        message: "Could not start media permission setup.".into(),
    })?;
    receive.await.map_err(|_| SystemError::CommandFailed {
        message: "Media permission setup did not complete. Check System Settings before trying again.".into(),
    })?
}

#[tauri::command]
async fn system_media_play_pause(
    state: tauri::State<'_, AppState>,
) -> Result<MediaApplyResult, SystemError> {
    state.system.media_play_pause().await
}

#[tauri::command]
async fn native_deck_load(
    state: tauri::State<'_, AppState>,
) -> Result<deck::DeckSnapshot, DeckError> {
    state.store()?.load().await
}

#[tauri::command]
async fn native_deck_save(
    state: tauri::State<'_, AppState>,
    expected_revision: u64,
    deck: Deck,
) -> Result<deck::DeckSnapshot, DeckError> {
    state.store()?.save(expected_revision, deck).await
}

/// Explicit native user gesture only; no phone service or direct action payload.
/// Read the full JSON body so omitted value and explicit null stay distinct.
#[tauri::command]
async fn desktop_run_control(
    state: tauri::State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> Result<CommandResult, ActionError> {
    let command: DesktopCommand = match request.body() {
        tauri::ipc::InvokeBody::Json(value) => serde_json::from_value(value.clone())
            .map_err(|_| ActionError::new(ActionErrorCode::InvalidRequest))?,
        _ => return Err(ActionError::new(ActionErrorCode::InvalidRequest)),
    };
    let store = state.store().map_err(|_| ActionError::new(ActionErrorCode::DeckUnavailable))?;
    state.desktop.run(store, command).await
}

fn local_plugin_install(app: &tauri::AppHandle) -> Result<plugin_install::PluginInstall, PluginError> {
    use tauri::Manager;
    let home = app.path().home_dir().map_err(|_| PluginError {
        kind: plugin::ErrorKind::Unavailable,
        code: None,
        outcome: plugin::Outcome::NotStarted,
        message: "Plugin process unavailable.",
        hint: "Check trusted local configuration and the plugin contract before trying again.",
    })?;
    plugin_install::PluginInstall::for_home(home)
}

/// Discovery never runs plugin code; runtime detection executes only bounded --version probes.
#[tauri::command]
async fn plugin_catalog(app: tauri::AppHandle) -> Result<plugin_install::PluginCatalog, PluginError> {
    local_plugin_install(&app)?.catalog().await
}

/// Native desktop trust boundary only. UI must acknowledge local code trust before enabling.
#[tauri::command]
async fn plugin_enable(app: tauri::AppHandle, state: tauri::State<'_, AppState>, plugin_id: String) -> Result<PluginSnapshot, PluginError> {
    local_plugin_install(&app)?.enable(&state.plugin, &plugin_id).await
}

/// Creates/opens only the fixed app plugin directory, never a caller-supplied path.
#[tauri::command]
async fn plugin_open_directory(app: tauri::AppHandle) -> Result<(), PluginError> {
    local_plugin_install(&app)?.open_directory().await
}

#[tauri::command]
async fn plugin_disconnect(
    state: tauri::State<'_, AppState>, plugin_id: String,
) -> Result<PluginSnapshot, PluginError> {
    state.plugin.disconnect(&plugin_id).await
}

#[tauri::command]
async fn plugin_snapshot(state: tauri::State<'_, AppState>, plugin_id: String) -> Result<PluginSnapshot, PluginError> {
    state.plugin.snapshot(&plugin_id).await
}

#[tauri::command]
async fn plugin_snapshots(state: tauri::State<'_, AppState>) -> Result<std::collections::BTreeMap<String, PluginSnapshot>, PluginError> {
    Ok(state.plugin.snapshots().await)
}

#[tauri::command]
async fn plugin_diagnostics(app: tauri::AppHandle, plugin_id: String) -> Result<plugin_install::PluginDiagnostics, PluginError> {
    local_plugin_install(&app)?.diagnostics(&plugin_id).await
}

#[tauri::command]
async fn plugin_uninstall(app: tauri::AppHandle, state: tauri::State<'_, AppState>, plugin_id: String) -> Result<(), PluginError> {
    local_plugin_install(&app)?.uninstall(&state.plugin, &plugin_id).await
}

#[tauri::command]
async fn plugin_state(state: tauri::State<'_, AppState>, plugin_id: String) -> Result<PluginSnapshot, PluginError> {
    state.plugin.state(&plugin_id).await
}

#[tauri::command]
async fn plugin_execute(
    state: tauri::State<'_, AppState>,
    plugin_id: String,
    action_id: String,
    args: serde_json::Value,
) -> Result<PluginSnapshot, PluginError> {
    state.plugin.execute(plugin_id, action_id, args).await
}

#[tauri::command]
async fn remote_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    tray: tauri::State<'_, tray::TrayState>,
    admin: tauri::State<'_, RemoteAdmin>,
    origin: String,
    mode: Option<ConnectionMode>,
) -> Result<RemoteStatus, RemoteError> {
    let _operation = tray.operation.try_lock().map_err(|_| tray::busy_error())?;
    if tray.quitting.load(std::sync::atomic::Ordering::SeqCst) { return Err(tray::busy_error()); }
    let result = admin.start(state.service_config(origin, mode.unwrap_or_default())?).await;
    if result.is_ok() { tray::clear_error(&app); }
    tray::refresh(&app).await;
    result
}

#[tauri::command]
async fn remote_stop(app: tauri::AppHandle, tray: tauri::State<'_, tray::TrayState>, admin: tauri::State<'_, RemoteAdmin>) -> Result<RemoteStatus, RemoteError> {
    let _operation = tray.operation.try_lock().map_err(|_| tray::busy_error())?;
    if tray.quitting.load(std::sync::atomic::Ordering::SeqCst) { return Err(tray::busy_error()); }
    let status = admin.stop().await;
    if status.error.is_none() { tray::clear_error(&app); }
    tray::refresh(&app).await;
    Ok(status)
}

#[tauri::command]
async fn remote_status(admin: tauri::State<'_, RemoteAdmin>) -> Result<RemoteStatus, RemoteError> {
    Ok(admin.status().await)
}

#[tauri::command]
async fn remote_create_invitation(
    admin: tauri::State<'_, RemoteAdmin>,
) -> Result<InvitationView, RemoteError> {
    admin.create_invitation().await
}

#[tauri::command]
async fn remote_list_devices(
    admin: tauri::State<'_, RemoteAdmin>,
) -> Result<Vec<DeviceView>, RemoteError> {
    admin.list_devices().await
}

#[tauri::command]
async fn remote_approve_device(
    admin: tauri::State<'_, RemoteAdmin>,
    request_id: String,
) -> Result<DeviceView, RemoteError> {
    admin.approve_device(&request_id).await
}

#[tauri::command]
async fn remote_deny_device(
    admin: tauri::State<'_, RemoteAdmin>,
    request_id: String,
) -> Result<DeviceView, RemoteError> {
    admin.deny_device(&request_id).await
}

#[tauri::command]
async fn remote_revoke_device(
    admin: tauri::State<'_, RemoteAdmin>,
    request_id: String,
) -> Result<DeviceView, RemoteError> {
    admin.revoke_device(&request_id).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    linux_display::initialize();
    tauri::Builder::default()
        .on_page_load(|webview, payload| {
            #[cfg(feature = "native-smoke")]
            if payload.event() == tauri::webview::PageLoadEvent::Finished
                && std::env::var("ZDECK_NATIVE_SMOKE").as_deref() == Ok("1")
            {
                native_smoke::check_layout(webview.clone());
            }
            let _ = (webview, payload);
        })
        .setup(|app| {
            use tauri::Manager;
            let store = match app.path().app_data_dir() {
                Ok(directory) => Ok(Arc::new(DeckStore::new(directory.join(DECK_FILE_NAME)))),
                Err(error) => Err(DeckError::unavailable(format!(
                    "Could not resolve the app data directory: {error}."
                ))),
            };
            let assets: Arc<dyn AssetProvider> = Arc::new(TauriAssets {
                resolver: app.asset_resolver(),
            });
            let obs = Arc::new(ObsState::default());
            let system = Arc::new(SystemState::default());
            let plugin = Arc::new(PluginRegistry::default());
            let actions = Arc::new(ActionDispatcher::new(obs.clone(), system.clone(), plugin.clone()));
            let desktop = DesktopActions::new(actions.clone());
            let admin = RemoteAdmin::persistent(app.path().app_data_dir().ok());
            if let Ok(deck) = &store {
                let config = ServiceConfig {
                    origin: String::new(), mode: ConnectionMode::default(), port: DEFAULT_PORT,
                    deck: deck.clone(), actions: actions.clone(), assets: assets.clone(),
                    clock: Arc::new(SystemClock), limits: Limits::default(),
                };
                tauri::async_runtime::block_on(admin.restore(config));
            }
            app.manage(admin);
            app.manage(AppState { store, obs, system, plugin, actions, desktop, assets });
            tray::setup(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    tray::close(window, api);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            tray::desktop_tray_notice,
            tray::desktop_close_to_tray,
            tray::desktop_set_close_to_tray,
            tray::desktop_quit,
            obs_connect,
            obs_preferences::obs_load_preferences,
            obs_preferences::obs_save_preferences,
            obs_preferences::obs_forget_preferences,
            obs_disconnect,
            obs_snapshot,
            obs_switch_scene,
            system_output_snapshot,
            system_output_set_volume,
            system_microphone_snapshot,
            system_microphone_set_muted,
            system_media_snapshot,
            system_media_play_pause,
            system_media_permission_status,
            system_media_permission_request,
            native_deck_load,
            native_deck_save,
            desktop_run_control,
            plugin_catalog,
            plugin_enable,
            plugin_open_directory,
            plugin_disconnect,
            plugin_snapshot,
            plugin_snapshots,
            plugin_diagnostics,
            plugin_uninstall,
            plugin_state,
            plugin_execute,
            remote_start,
            remote_stop,
            remote_status,
            remote_create_invitation,
            remote_list_devices,
            remote_approve_device,
            remote_deny_device,
            remote_revoke_device
        ])
        .build(tauri::generate_context!())
        .expect("error while building Deck")
        .run(|app, event| {
            use tauri::Manager;
            match event {
                tauri::RunEvent::ExitRequested { api, .. } => {
                    if !app.state::<tray::TrayState>().exit_ready.load(std::sync::atomic::Ordering::SeqCst) {
                        api.prevent_exit();
                        tray::quit(app);
                    }
                }
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => { let _ = tray::open(app, false); }
                _ => {}
            }
        });
}
