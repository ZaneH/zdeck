pub mod deck;
#[cfg(target_os = "linux")]
mod linux_display;
#[cfg(feature = "native-smoke")]
mod native_smoke;
pub mod obs;
pub mod remote;
pub mod system;

use std::sync::Arc;

use deck::{Deck, DeckError, DeckStore, DECK_FILE_NAME};
use obs::{ObsError, ObsSnapshot, ObsState, SceneSwitchResult};
use remote::{
    AssetProvider, DeviceView, InvitationView, Limits, PublicAsset, RemoteAdmin, RemoteError,
    RemoteStatus, ServiceConfig, SystemClock, DEFAULT_PORT,
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
    assets: Arc<dyn AssetProvider>,
}

impl AppState {
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

#[tauri::command]
async fn remote_start(
    state: tauri::State<'_, AppState>,
    admin: tauri::State<'_, RemoteAdmin>,
    origin: String,
) -> Result<RemoteStatus, RemoteError> {
    let deck = state
        .store()
        .map_err(|_| RemoteError::Unavailable {
            message: "The native deck store is unavailable.".to_string(),
        })?
        .clone();
    let config = ServiceConfig {
        origin,
        port: DEFAULT_PORT,
        deck,
        obs: Arc::clone(&state.obs),
        system: Arc::clone(&state.system),
        assets: Arc::clone(&state.assets),
        clock: Arc::new(SystemClock),
        limits: Limits::default(),
    };
    admin.start(config).await
}

#[tauri::command]
async fn remote_stop(admin: tauri::State<'_, RemoteAdmin>) -> Result<RemoteStatus, RemoteError> {
    Ok(admin.stop().await)
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
        .manage(RemoteAdmin::default())
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
            app.manage(AppState {
                store,
                obs: Arc::new(ObsState::default()),
                system: Arc::new(SystemState::default()),
                assets,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            obs_connect,
            obs_disconnect,
            obs_snapshot,
            obs_switch_scene,
            system_output_snapshot,
            system_output_set_volume,
            system_microphone_snapshot,
            system_microphone_set_muted,
            system_media_snapshot,
            system_media_play_pause,
            native_deck_load,
            native_deck_save,
            remote_start,
            remote_stop,
            remote_status,
            remote_create_invitation,
            remote_list_devices,
            remote_approve_device,
            remote_deny_device,
            remote_revoke_device
        ])
        .run(tauri::generate_context!())
        .expect("error while running Deck");
}
