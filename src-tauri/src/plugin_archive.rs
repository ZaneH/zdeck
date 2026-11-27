//! Archive paths never cross renderer IPC. Only the native picker and native drop handler
//! call select_paths. Renderer commands operate on one opaque, reviewed temporary package.
use std::{path::PathBuf, sync::Mutex};
use serde::Serialize;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use crate::plugin_install::{ArchiveReview, PreparedArchive};

const CHANGED: &str = "plugin-archive-changed";
const BUSY: &str = "Finish or cancel the current archive review before selecting another package.";
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveView {
    busy: bool,
    review: Option<ArchiveReview>,
    error: Option<String>,
    installed_epoch: u64,
}
#[derive(Default)]
struct Inbox {
    view: ArchiveView, prepared: Option<PreparedArchive>,
    requests: crate::plugin_registry::InstallRequests, pending_notice: Option<&'static str>,
}
#[derive(Default)]
pub struct ArchiveInbox(Mutex<Inbox>);
impl Inbox {
    fn flush_notice(&mut self) {
        if !self.view.busy && self.view.review.is_none() && self.view.error.is_none() {
            self.view.error = self.pending_notice.take().map(str::to_owned);
        }
    }
    fn notice(&mut self, notice: &'static str) {
        self.pending_notice = Some(notice);
        self.flush_notice();
    }
    fn request_link(&mut self, link: &str) -> bool {
        let Some(notice) = self.requests.receive(link) else { return false; };
        self.notice(notice);
        true
    }
    fn begin(&mut self) -> Result<(), String> {
        if self.view.busy || self.prepared.is_some() { return Err(BUSY.into()); }
        self.view.busy = true; self.view.error = None; self.view.review = None;
        Ok(())
    }
    fn finish(&mut self, result: Result<Option<PreparedArchive>, String>) {
        self.view.busy = false;
        match result {
            Ok(prepared) => { self.view.review = prepared.as_ref().map(|p| p.review().clone()); self.prepared = prepared; }
            Err(error) => { self.view.error = Some(error); self.prepared = None; self.view.review = None; }
        }
        self.flush_notice();
    }
    fn cancel(&mut self, review_id: Option<&String>) -> Result<(), String> {
        if self.view.busy { return Err(BUSY.into()); }
        if self.view.review.as_ref().map(|r| &r.review_id) != review_id { return Err("This review is no longer current.".into()); }
        self.prepared = None; self.view.review = None; self.view.error = None;
        self.flush_notice();
        Ok(())
    }
    fn take(&mut self, review_id: &str) -> Result<PreparedArchive, String> {
        if self.view.busy { return Err(BUSY.into()); }
        if self.view.review.as_ref().map(|r| r.review_id.as_str()) != Some(review_id) { return Err("This review is no longer current. Select the archive again.".into()); }
        let prepared = self.prepared.take().ok_or("Select an archive to review first.")?;
        self.view.busy = true;
        Ok(prepared)
    }
}
fn one_path(mut paths: Vec<PathBuf>) -> Result<Option<PathBuf>, String> {
    if paths.len() > 1 { return Err("Select exactly one local .zdx archive at a time.".into()); }
    Ok(paths.pop())
}

fn changed(app: &tauri::AppHandle) { let _ = app.emit_to("main", CHANGED, ()); }
fn begin(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<ArchiveInbox>();
    let mut inbox = state.0.lock().unwrap_or_else(|p| p.into_inner());
    inbox.begin()?;
    drop(inbox); changed(app); Ok(())
}
fn finish(app: &tauri::AppHandle, result: Result<Option<PreparedArchive>, String>) {
    let state = app.state::<ArchiveInbox>();
    let mut inbox = state.0.lock().unwrap_or_else(|p| p.into_inner());
    inbox.finish(result);
    drop(inbox); changed(app);
}
async fn select_paths(app: tauri::AppHandle, paths: Vec<PathBuf>) {
    let path = match one_path(paths) {
        Ok(Some(path)) => path,
        Ok(None) => { finish(&app, Ok(None)); return; }
        Err(error) => { finish(&app, Err(error)); return; }
    };
    let result = match crate::local_plugin_install(&app) {
        Ok(install) => install.inspect_archive(path).await.map(Some).map_err(|e| e.hint.to_owned()),
        Err(_) => Err("The local plugin directory is unavailable. No package was installed.".into()),
    };
    finish(&app, result);
}

pub fn drop_paths(app: &tauri::AppHandle, paths: Vec<PathBuf>) {
    if let Err(error) = begin(app) {
        let state = app.state::<ArchiveInbox>();
        state.0.lock().unwrap_or_else(|p| p.into_inner()).view.error = Some(error);
        changed(app); return;
    }
    tauri::async_runtime::spawn(select_paths(app.clone(), paths));
}

// Native links can only leave a bounded notice; they never supply an archive or review token.
pub fn request_link(app: &tauri::AppHandle, link: &str) {
    let state = app.state::<ArchiveInbox>();
    let handled = state.0.lock().unwrap_or_else(|p| p.into_inner()).request_link(link);
    if handled { changed(app); let _ = crate::tray::open(app, false); }
}
pub fn request_notice(app: &tauri::AppHandle, notice: &'static str) {
    app.state::<ArchiveInbox>().0.lock().unwrap_or_else(|p| p.into_inner()).notice(notice);
    changed(app);
}

#[tauri::command]
pub fn plugin_archive_view(window: tauri::WebviewWindow, state: tauri::State<'_, ArchiveInbox>) -> Result<ArchiveView, String> {
    crate::plugin_registry::require_local(&window)?;
    Ok(state.0.lock().unwrap_or_else(|p| p.into_inner()).view.clone())
}
#[tauri::command]
pub fn plugin_archive_pick(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    crate::plugin_registry::require_local(&window)?;
    begin(&app)?;
    let handle = app.clone();
    // Native APIs implement the picker on macOS, Windows and Linux; no JS dialog or fs permission.
    app.dialog().file().set_parent(&window).set_title("Review a local zDeck plugin archive")
        .add_filter("zDeck plugin archive", &["zdx"]).pick_file(move |selected| {
            let paths = match selected.map(|p| p.into_path()).transpose() {
                Ok(path) => path.into_iter().collect(),
                Err(_) => { finish(&handle, Err("Choose a local filesystem .zdx file, not a virtual URL.".into())); return; }
            };
            tauri::async_runtime::spawn(select_paths(handle, paths));
        });
    Ok(())
}
#[tauri::command]
pub fn plugin_archive_cancel(app: tauri::AppHandle, window: tauri::WebviewWindow, review_id: Option<String>) -> Result<(), String> {
    crate::plugin_registry::require_local(&window)?;
    let state = app.state::<ArchiveInbox>();
    let mut inbox = state.0.lock().unwrap_or_else(|p| p.into_inner());
    inbox.cancel(review_id.as_ref())?;
    drop(inbox); changed(&app); Ok(())
}
#[tauri::command]
pub async fn plugin_archive_install(app: tauri::AppHandle, window: tauri::WebviewWindow, review_id: String) -> Result<(), String> {
    crate::plugin_registry::require_local(&window)?;
    let prepared = {
        let state = app.state::<ArchiveInbox>();
        let mut inbox = state.0.lock().unwrap_or_else(|p| p.into_inner());
        inbox.take(&review_id)?
    };
    changed(&app);
    let result = match crate::local_plugin_install(&app) {
        Ok(install) => {
            let registry = app.state::<crate::AppState>().plugin.clone();
            install.install_archive(&registry, prepared, &review_id).await.map_err(|e| e.hint.to_owned())
        }
        Err(_) => Err("The local plugin directory is unavailable. No package was installed.".into()),
    };
    {
        let state = app.state::<ArchiveInbox>();
        let mut inbox = state.0.lock().unwrap_or_else(|p| p.into_inner());
        inbox.view.busy = false; inbox.view.review = None;
        match result {
            Ok(()) => { inbox.view.error = None; inbox.view.installed_epoch += 1; }
            Err(error) => { inbox.view.error = Some(error); }
        }
        inbox.flush_notice();
    }
    changed(&app); Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selection_and_inbox_fakes_keep_one_review_and_do_not_authorize_arbitrary_tokens() {
        let path = PathBuf::from("/fixture/package.zdx");
        assert_eq!(one_path(vec![path.clone()]).unwrap(), Some(path.clone()));
        assert!(one_path(vec![path.clone(), path]).is_err());
        assert_eq!(one_path(vec![]).unwrap(), None);
        let mut inbox = Inbox::default();
        inbox.begin().unwrap(); assert!(inbox.view.busy);
        assert!(inbox.begin().is_err()); assert!(inbox.cancel(None).is_err());
        assert!(inbox.take("forged").is_err());
        inbox.finish(Err("Fixture invalid ZIP".into()));
        assert!(!inbox.view.busy); assert!(inbox.prepared.is_none());
        assert_eq!(inbox.view.error.as_deref(), Some("Fixture invalid ZIP"));
        assert!(inbox.cancel(Some(&"forged".into())).is_err());
        inbox.cancel(None).unwrap(); assert!(inbox.view.error.is_none());
        inbox.begin().unwrap(); inbox.finish(Ok(None));
        assert!(!inbox.view.busy && inbox.view.review.is_none());
        assert!(inbox.take("forged").is_err());
        inbox.begin().unwrap(); inbox.finish(Ok(None));
    }
    #[test]
    fn links_never_authorize_install_and_cancellation_suppresses_duplicate_notifications() {
        let mut inbox = Inbox::default();
        let link = "zdeck://plugins/install?id=fixture&version=1.2.3";
        assert!(inbox.request_link(link));
        assert_eq!(inbox.view.error.as_deref(), Some(crate::plugin_registry::RESOLUTION_UNAVAILABLE));
        assert!(inbox.view.review.is_none() && inbox.prepared.is_none() && !inbox.view.busy);
        assert!(inbox.take("forged-review").is_err());
        inbox.cancel(None).unwrap();
        assert!(!inbox.request_link(link));
        assert!(inbox.view.error.is_none());
        // Startup and running callbacks canonicalize percent encodings into the same identity.
        assert!(!inbox.request_link("zdeck://plugins/install?version=1.2.3&id=%66ixture"));
        assert_eq!(inbox.view.installed_epoch, 0);
    }
    #[test]
    fn link_notice_waits_for_local_picker_review_and_errors_without_replacing_authorization() {
        let mut inbox = Inbox::default();
        inbox.begin().unwrap();
        assert!(inbox.request_link("zdeck://plugins/install?id=fixture&version=1.2.3"));
        assert!(inbox.view.error.is_none() && inbox.view.busy);
        assert!(inbox.cancel(None).is_err());
        // A synthetic collision review stands in for the host's private prepared fixture.
        let review = ArchiveReview { review_id: "a".repeat(32), id: "local-fixture".into(), version: "1.0.0".into(), protocol_version: 1,
            runtime: crate::plugin_install::PluginRuntime::Node, runtime_status: crate::plugin_install::NodeStatus::Detected, runtime_version: Some("22.18.0".into()),
            archive_sha256: "b".repeat(64), identity: "c".repeat(64), files: 2, bytes: 100, collision: true };
        inbox.view.busy = false; inbox.view.review = Some(review.clone());
        inbox.flush_notice();
        assert!(inbox.view.error.is_none());
        assert!(inbox.view.review.as_ref().unwrap().collision);
        assert!(!inbox.request_link("zdeck://plugins/install?id=fixture&version=1.2.3"));
        assert_eq!(inbox.view.review.as_ref().unwrap().review_id, review.review_id);
        assert!(inbox.cancel(Some(&"forged".into())).is_err());
        inbox.cancel(Some(&review.review_id)).unwrap();
        assert_eq!(inbox.view.error.as_deref(), Some(crate::plugin_registry::RESOLUTION_UNAVAILABLE));
        inbox.cancel(None).unwrap();
        assert!(inbox.view.error.is_none());
        inbox.begin().unwrap();
        inbox.request_link("zdeck://plugins/install?id=another&version=1.2.3");
        inbox.finish(Err("Fixture archive failed.".into()));
        assert_eq!(inbox.view.error.as_deref(), Some("Fixture archive failed."));
        inbox.cancel(None).unwrap();
        assert_eq!(inbox.view.error.as_deref(), Some(crate::plugin_registry::RESOLUTION_UNAVAILABLE));
    }
    #[test]
    fn native_selection_has_no_path_or_target_ipc_and_both_sources_share_validation() {
        let source = include_str!("plugin_archive.rs").split("#[cfg(test)]").next().unwrap();
        assert!(source.contains("spawn(select_paths(app.clone(), paths))"));
        assert!(source.contains("spawn(select_paths(handle, paths))"));
        for command in ["plugin_archive_pick", "plugin_archive_install", "plugin_archive_cancel", "plugin_archive_view"] {
            let declaration = source.split(&format!("fn {command}(")).nth(1).unwrap().split(')').next().unwrap();
            assert!(!declaration.contains("Path") && !declaration.contains("target") && !declaration.contains("paths"));
            let body = source.split(&format!("fn {command}(")).nth(1).unwrap();
            assert!(body.contains("crate::plugin_registry::require_local(&window)?"));
        }
        let capabilities: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert_eq!(capabilities["permissions"], serde_json::json!(["core:event:allow-listen", "core:event:allow-unlisten"]));
        let app = include_str!("lib.rs");
        assert!(app.contains("tauri::WebviewEvent::DragDrop(tauri::DragDropEvent::Drop"));
        assert!(app.contains(".plugin(tauri_plugin_dialog::init())"));
    }
}
