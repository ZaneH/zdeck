//! Native lifecycle only; phone clients cannot invoke tray or window operations.
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};
use tauri::{menu::{Menu, MenuItem, PredefinedMenuItem, Submenu}, tray::{TrayIconBuilder, TrayIconEvent}, Manager};
use crate::{AppState, remote::{RemoteAdmin, RemoteError}};

#[derive(Default)]
pub struct TrayState {
    service_item: Mutex<Option<MenuItem<tauri::Wry>>>,
    notice: Mutex<Option<String>>,
    limitation: Mutex<Option<String>>,
    preference_path: Mutex<Option<std::path::PathBuf>>,
    available: AtomicBool,
    running: AtomicBool,
    pub operation: tokio::sync::Mutex<()>,
    pub quitting: AtomicBool,
    pub exit_ready: AtomicBool,
}

#[tauri::command]
pub fn desktop_tray_notice(state: tauri::State<'_, TrayState>) -> Option<String> {
    state.notice.lock().unwrap().clone().or_else(|| state.limitation.lock().unwrap().clone())
}

#[tauri::command]
pub fn desktop_quit(app: tauri::AppHandle) { quit(&app); }

#[derive(Default, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DesktopPreferences { close_to_tray: bool }

fn read_preference(path: &std::path::Path) -> Result<bool, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<DesktopPreferences>(&bytes)
            .map(|value| value.close_to_tray)
            .map_err(|_| "Could not read desktop preferences. Closing will quit zDeck until the preference is saved successfully.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("Could not read desktop preferences; closing will quit zDeck. {error}")),
    }
}

fn write_preference(path: &std::path::Path, enabled: bool) -> Result<(), String> {
    use std::io::Write;
    let parent = path.parent().ok_or("Desktop preferences directory is unavailable.")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp = parent.join(format!(".desktop-preferences.{}.tmp", std::process::id()));
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp)
        .map_err(|error| format!("Could not save desktop preferences: {error}"))?;
    let result = (|| -> std::io::Result<()> {
        file.write_all(if enabled { b"{\"close_to_tray\":true}" } else { b"{\"close_to_tray\":false}" })?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temp, path)?;
        // shortcut: directory sync is best-effort, as in the deck and remote stores.
        if let Ok(dir) = std::fs::File::open(parent) { let _ = dir.sync_all(); }
        Ok(())
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temp); }
    result.map_err(|error| format!("Could not save desktop preferences: {error}"))
}

#[tauri::command]
pub fn desktop_close_to_tray(state: tauri::State<'_, TrayState>) -> Result<bool, String> {
    let path = state.preference_path.lock().unwrap();
    read_preference(path.as_deref().ok_or("Desktop preferences directory is unavailable; closing will quit zDeck.")?)
}

#[tauri::command]
pub fn desktop_set_close_to_tray(state: tauri::State<'_, TrayState>, enabled: bool) -> Result<bool, String> {
    let path = state.preference_path.lock().unwrap();
    let path = path.as_deref().ok_or("Desktop preferences directory is unavailable.")?;
    write_preference(path, enabled)?;
    read_preference(path)
}

pub fn busy_error() -> RemoteError {
    RemoteError::Conflict { message: "A local service change or application shutdown is already in progress. Check its state before trying again.".into() }
}

fn report(app: &tauri::AppHandle, message: impl Into<String>) {
    *app.state::<TrayState>().notice.lock().unwrap() = Some(message.into());
}

pub fn clear_error(app: &tauri::AppHandle) {
    *app.state::<TrayState>().notice.lock().unwrap() = None;
}

pub fn open(app: &tauri::AppHandle, settings: bool) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    app.set_dock_visibility(true)?;
    if let Some(window) = app.get_webview_window("main") {
        window.show()?;
        window.unminimize()?;
        window.set_focus()?;
        if settings {
            window.eval("window.location.hash = '#/settings/phone'")?;
        }
    }
    Ok(())
}

pub async fn refresh(app: &tauri::AppHandle) {
    let running = app.state::<RemoteAdmin>().status().await.running;
    let state = app.state::<TrayState>();
    state.running.store(running, Ordering::SeqCst);
    let item = state.service_item.lock().unwrap().clone();
    if let Some(item) = item {
        if item.set_text(if running { "Stop local service" } else { "Start local service" }).is_err() {
            report(app, "The tray service menu could not be updated. Use Settings to check the local service.");
        }
    }
}

fn request_service(app: &tauri::AppHandle) {
    let app = app.clone();
    let desired = !app.state::<TrayState>().running.load(Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        let state = app.state::<TrayState>();
        let Ok(_operation) = state.operation.try_lock() else { return };
        if state.quitting.load(Ordering::SeqCst) { return; }
        let item = state.service_item.lock().unwrap().clone();
        if let Some(item) = &item { let _ = item.set_enabled(false); }
        let admin = app.state::<RemoteAdmin>();
        let result = if admin.status().await.running == desired {
            Err(busy_error())
        } else if desired {
            match app.state::<AppState>().service_config(String::new(), Default::default()) {
                Ok(config) => admin.start_saved(config).await,
                Err(error) => Err(error),
            }
        } else {
            Ok(admin.stop().await)
        };
        let error = match result {
            Ok(status) => status.error,
            Err(error) => Some(match error {
                RemoteError::NotRunning { message } | RemoteError::AlreadyRunning { message }
                | RemoteError::InvalidOrigin { message } | RemoteError::Bind { message }
                | RemoteError::Conflict { message } | RemoteError::NotFound { message }
                | RemoteError::Unavailable { message } | RemoteError::Internal { message } => message,
            }),
        };
        if let Some(error) = error {
            report(&app, error);
            if let Err(error) = open(&app, true) { report(&app, format!("Could not restore Settings: {error}")); }
        } else {
            clear_error(&app);
        }
        refresh(&app).await;
        if let Some(item) = item { let _ = item.set_enabled(true); }
    });
}

pub fn quit(app: &tauri::AppHandle) {
    if app.state::<TrayState>().quitting.swap(true, Ordering::SeqCst) { return; }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<TrayState>();
        let _operation = state.operation.lock().await;
        app.state::<RemoteAdmin>().shutdown().await;
        let native = app.state::<AppState>();
        native.obs.disconnect().await;
        for id in native.plugin.snapshots().await.keys() {
            let _ = native.plugin.disconnect(id).await;
        }
        state.exit_ready.store(true, Ordering::SeqCst);
        app.exit(0);
    });
}

// A created AppIndicator does not prove that a Linux panel is displaying it.
#[cfg(target_os = "linux")]
fn host_available() -> bool {
    use gtk::gio::{self, prelude::*};
    gio::DBusProxy::for_bus_sync(
        gio::BusType::Session, gio::DBusProxyFlags::DO_NOT_AUTO_START,
        None, "org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher",
        "org.kde.StatusNotifierWatcher", gio::Cancellable::NONE,
    ).ok().and_then(|proxy| proxy.cached_property("IsStatusNotifierHostRegistered"))
        .and_then(|value| value.get::<bool>()).unwrap_or(false)
}

#[cfg(not(target_os = "linux"))]
fn host_available() -> bool { true }

fn may_hide(icon_created: bool, host: bool) -> bool { icon_created && host }

pub fn close(window: &tauri::Window, api: &tauri::CloseRequestApi) {
    api.prevent_close();
    let app = window.app_handle();
    let enabled = desktop_close_to_tray(app.state::<TrayState>()).unwrap_or_else(|error| {
        report(app, error);
        false
    });
    if !enabled {
        quit(app);
        return;
    }
    if !may_hide(app.state::<TrayState>().available.load(Ordering::SeqCst), host_available()) {
        *app.state::<TrayState>().limitation.lock().unwrap() = Some("No usable tray host could be confirmed. zDeck will keep its window accessible. Use Quit zDeck in the application menu to exit.".into());
        let _ = open(app, false);
        return;
    }
    *app.state::<TrayState>().limitation.lock().unwrap() = None;
    if let Err(error) = window.hide() {
        report(app, format!("Could not hide the window: {error}"));
        return;
    }
    #[cfg(target_os = "macos")]
    if let Err(error) = app.set_dock_visibility(false) {
        let _ = open(app, false);
        report(app, format!("Could not hide the Dock icon: {error}"));
    }
}

#[cfg(target_os = "macos")]
fn macos_tray_icon() -> tauri::image::Image<'static> {
    tauri::include_image!("icons/tray-template.png")
}

pub fn setup(app: &tauri::AppHandle) {
    app.manage(TrayState::default());
    *app.state::<TrayState>().preference_path.lock().unwrap() = app.path().app_data_dir().ok()
        .map(|directory| directory.join("desktop-preferences.json"));
    if let Err(error) = desktop_close_to_tray(app.state::<TrayState>()) { report(app, error); }
    let result = (|| -> tauri::Result<()> {
        let open_item = MenuItem::with_id(app, "tray-open", "Open zDeck", true, None::<&str>)?;
        let service = MenuItem::with_id(app, "tray-service", "Start local service", true, None::<&str>)?;
        let settings = MenuItem::with_id(app, "tray-settings", "Settings", true, None::<&str>)?;
        let quit_item = MenuItem::with_id(app, "tray-quit", "Quit zDeck", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[
            &open_item, &PredefinedMenuItem::separator(app)?, &service,
            &PredefinedMenuItem::separator(app)?, &settings,
            &PredefinedMenuItem::separator(app)?, &quit_item,
        ])?;
        // Also provides an explicit Quit when no tray host exists.
        let application_menu = Submenu::new(app, "zDeck", true)?;
        #[cfg(target_os = "macos")]
        {
            settings.set_accelerator(Some("Cmd+,"))?;
            // Keep Quit on our graceful shutdown path, not AppKit's terminate action.
            quit_item.set_accelerator(Some("Cmd+Q"))?;
            application_menu.append_items(&[
                &settings, &PredefinedMenuItem::separator(app)?,
                &open_item, &service, &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::hide(app, Some("Hide zDeck"))?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &PredefinedMenuItem::separator(app)?, &quit_item,
            ])?;
            let edit_menu = Submenu::with_items(app, "Edit", true, &[
                &PredefinedMenuItem::cut(app, None)?,
                &PredefinedMenuItem::copy(app, None)?,
                &PredefinedMenuItem::paste(app, None)?,
            ])?;
            let window_menu = Submenu::with_items(app, "Window", true, &[
                &PredefinedMenuItem::minimize(app, None)?,
                &PredefinedMenuItem::close_window(app, None)?,
            ])?;
            app.set_menu(Menu::with_items(app, &[&application_menu, &edit_menu, &window_menu])?)?;
        }
        #[cfg(not(target_os = "macos"))]
        {
            for item in menu.items()? { application_menu.append(&item)?; }
            app.set_menu(Menu::with_items(app, &[&application_menu])?)?;
        }
        app.on_menu_event(|app, event| match event.id().as_ref() {
            "tray-open" | "tray-settings" => {
                if let Err(error) = open(app, event.id().as_ref() == "tray-settings") {
                    report(app, format!("Could not restore the window: {error}"));
                }
            }
            "tray-service" => request_service(app),
            "tray-quit" => quit(app),
            _ => {}
        });
        *app.state::<TrayState>().service_item.lock().unwrap() = Some(service);
        #[cfg(target_os = "macos")]
        let icon = macos_tray_icon();
        #[cfg(not(target_os = "macos"))]
        let icon = app.default_window_icon().cloned().ok_or_else(|| tauri::Error::AssetNotFound("tray icon".into()))?;
        TrayIconBuilder::with_id("zdeck")
            .icon(icon)
            // macOS uses the alpha mask and adapts the ink to light/dark menu bars.
            .icon_as_template(cfg!(target_os = "macos"))
            .tooltip("zDeck").menu(&menu)
            .show_menu_on_left_click(cfg!(target_os = "macos"))
            .on_tray_icon_event(|tray, event| {
                if matches!(event, TrayIconEvent::DoubleClick { button: tauri::tray::MouseButton::Left, .. }) {
                    if let Err(error) = open(tray.app_handle(), false) {
                        report(tray.app_handle(), format!("Could not restore the window: {error}"));
                    }
                }
            }).build(app)?;
        app.state::<TrayState>().available.store(true, Ordering::SeqCst);
        Ok(())
    })();
    if let Err(error) = result {
        *app.state::<TrayState>().limitation.lock().unwrap() = Some(format!("Tray unavailable; when close-to-tray is enabled, closing will keep this window accessible. {error}"));
    }
    if app.state::<TrayState>().available.load(Ordering::SeqCst) && !host_available() {
        *app.state::<TrayState>().limitation.lock().unwrap() = Some("No usable tray host could be confirmed. With close-to-tray enabled, closing will keep the window accessible; use Quit zDeck to exit. Linux needs a StatusNotifier/AppIndicator panel host (some desktops require an extension).".into());
    }
    tauri::async_runtime::block_on(refresh(app));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "macos")]
    #[test]
    fn template_icon_has_monochrome_ink_and_transparent_padding() {
        let icon = macos_tray_icon();
        assert_eq!((icon.width(), icon.height()), (44, 44));
        assert_eq!(icon.rgba().len(), 44 * 44 * 4);
        assert!(icon.rgba().chunks_exact(4).any(|pixel| pixel[3] > 0));
        assert!(icon.rgba().chunks_exact(4).all(|pixel| pixel[..3] == [0, 0, 0]));
        assert_eq!(icon.rgba()[3], 0);
    }
    #[test]
    fn preference_is_opt_in_persisted_and_failed_saves_do_not_change_it() {
        let directory = std::env::temp_dir().join(format!("zdeck-desktop-preferences-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let path = directory.join("desktop-preferences.json");
        assert!(!read_preference(&path).unwrap());
        write_preference(&path, true).unwrap();
        assert!(read_preference(&path).unwrap());
        let temp = directory.join(format!(".desktop-preferences.{}.tmp", std::process::id()));
        std::fs::write(&temp, b"occupied").unwrap();
        assert!(write_preference(&path, false).is_err());
        assert!(read_preference(&path).unwrap());
        std::fs::remove_file(temp).unwrap();
        write_preference(&path, false).unwrap();
        assert!(!read_preference(&path).unwrap());
        std::fs::write(&path, b"invalid").unwrap();
        assert!(read_preference(&path).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn hiding_requires_both_an_icon_and_a_confirmed_host() {
        assert!(may_hide(true, true));
        assert!(!may_hide(false, true));
        assert!(!may_hide(true, false));
        assert!(!may_hide(false, false));
    }
    #[tokio::test]
    async fn service_requests_exclude_duplicates_and_shutdown_is_latched() {
        let state = TrayState::default();
        let operation = state.operation.try_lock().unwrap();
        assert!(state.operation.try_lock().is_err());
        drop(operation);
        assert!(state.operation.try_lock().is_ok());
        assert!(!state.quitting.swap(true, Ordering::SeqCst));
        assert!(state.quitting.swap(true, Ordering::SeqCst));
    }
}
