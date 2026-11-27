//! Archive paths never cross renderer IPC. Only the native picker and native drop handler
//! call select_paths. Renderer commands operate on one opaque, reviewed temporary package.
use std::{path::PathBuf, sync::Mutex};
use serde::Serialize;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use crate::plugin_install::{ArchiveReview, PreparedArchive};
use zdeck_plugin_host::registry_release::{Release, VerifiedRelease};
use crate::plugin_registry::{InstallRequest, Received};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RegistryReview { review_id: String, id: String, version: String, key_id: Option<String>, release: Option<Release> }
fn request_review(request: InstallRequest) -> RegistryReview {
    let mut nonce = [0u8; 16];
    // A failed OS RNG must not create reusable authorization tokens.
    let review_id = if getrandom::fill(&mut nonce).is_ok() { nonce.iter().map(|b| format!("{b:02x}")).collect() } else { String::new() };
    RegistryReview { review_id, id: request.id, version: request.version, key_id: None, release: None }
}

const CHANGED: &str = "plugin-archive-changed";
const BUSY: &str = "Finish or cancel the current archive review before selecting another package.";
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveView {
    busy: bool,
    review: Option<ArchiveReview>,
    error: Option<String>,
    installed_epoch: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    registry: Option<RegistryReview>,
}
#[derive(Default)]
struct Inbox {
    view: ArchiveView, prepared: Option<PreparedArchive>,
    requests: crate::plugin_registry::InstallRequests, pending_notice: Option<&'static str>,
    pending_request: Option<InstallRequest>, verified: Option<VerifiedRelease>, remote_task: Option<tauri::async_runtime::JoinHandle<()>>,
}
#[derive(Default)]
pub struct ArchiveInbox(Mutex<Inbox>);
impl Inbox {
    fn flush_notice(&mut self) {
        if !self.view.busy && self.view.review.is_none() && self.view.registry.is_none() && self.view.error.is_none() {
            self.view.error = self.pending_notice.take().map(str::to_owned);
            if self.view.error.is_none() {
                if let Some(request) = self.pending_request.take() {
                    let review = request_review(request);
                    if review.review_id.is_empty() { self.view.error = Some("Could not create a secure release review. Restart zDeck.".into()); }
                    else { self.view.registry = Some(review); }
                }
            }
        }
    }
    fn notice(&mut self, notice: &'static str) {
        self.pending_notice = Some(notice);
        self.flush_notice();
    }
    fn request_link(&mut self, link: &str, resolver_available: bool) -> bool {
        let Some(received) = self.requests.receive(link) else { return false; };
        match received {
            Received::Notice(notice) => self.notice(notice),
            Received::Release(request) => {
                if !resolver_available { self.notice(crate::plugin_registry::RESOLUTION_UNAVAILABLE); }
                else { self.queue_request(request); }
            }
        }
        true
    }
    fn queue_request(&mut self, request: InstallRequest) {
        // Keep the first waiting request. Never replace local work or an active remote review.
        if self.pending_request.is_none() { self.pending_request = Some(request); }
        self.flush_notice();
    }
    fn begin(&mut self) -> Result<(), String> {
        if self.view.busy || self.prepared.is_some() || self.view.registry.is_some() { return Err(BUSY.into()); }
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
        if self.view.busy && (self.view.registry.is_none() || self.prepared.is_none() && self.view.review.is_some()) { return Err(BUSY.into()); }
        let current = self.view.review.as_ref().map(|r| &r.review_id).or_else(|| self.view.registry.as_ref().map(|r| &r.review_id));
        if current != review_id { return Err("This review is no longer current.".into()); }
        if let Some(task) = self.remote_task.take() { task.abort(); }
        self.view.busy = false; self.verified = None; self.view.registry = None;
        self.prepared = None; self.view.review = None; self.view.error = None;
        self.flush_notice();
        Ok(())
    }
    fn begin_remote(&mut self, token: &str) -> Result<(InstallRequest, Option<VerifiedRelease>), String> {
        let r = self.view.registry.as_ref().ok_or("No registry request is current.")?;
        if r.review_id != token || self.view.busy || self.view.review.is_some() { return Err("This registry request is no longer current or is busy.".into()); }
        let request = InstallRequest { id: r.id.clone(), version: r.version.clone() };
        self.view.busy = true; self.view.error = None;
        Ok((request, self.verified.clone()))
    }
    fn finish_remote(&mut self, token: &str, result: Result<RemoteResult, String>) {
        if !self.view.busy || self.view.registry.as_ref().is_none_or(|r| r.review_id != token) { return; }
        self.remote_task = None; self.view.busy = false;
        match result {
            Ok(RemoteResult::Metadata(verified)) => {
                let r = self.view.registry.as_mut().unwrap();
                r.key_id = Some(verified.key_id().into()); r.release = Some(verified.release().clone());
                self.verified = Some(verified);
            }
            Ok(RemoteResult::Archive(prepared)) => {
                self.view.registry.as_mut().unwrap().review_id = prepared.review().review_id.clone();
                self.view.review = Some(prepared.review().clone()); self.prepared = Some(prepared);
            }
            Err(error) => self.view.error = Some(error),
        }
    }
    fn take(&mut self, review_id: &str) -> Result<PreparedArchive, String> {
        if self.view.busy { return Err(BUSY.into()); }
        if self.view.review.as_ref().map(|r| r.review_id.as_str()) != Some(review_id) { return Err("This review is no longer current. Select the archive again.".into()); }
        let prepared = self.prepared.take().ok_or("Select an archive to review first.")?;
        self.view.busy = true;
        Ok(prepared)
    }
}
enum RemoteResult { Metadata(VerifiedRelease), Archive(PreparedArchive) }
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

// Native links supply only identity. Lookup and download each need a current native review token.
pub fn request_link(app: &tauri::AppHandle, link: &str) {
    let state = app.state::<ArchiveInbox>();
    let handled = state.0.lock().unwrap_or_else(|p| p.into_inner()).request_link(link, crate::plugin_registry::configured_resolver().is_ok());
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
/// Only an opaque native intent token crosses IPC; no URL, path or release JSON is accepted.
#[tauri::command]
pub fn plugin_archive_resolve(app: tauri::AppHandle, window: tauri::WebviewWindow, review_id: String) -> Result<(), String> {
    crate::plugin_registry::require_local(&window)?;
    let state = app.state::<ArchiveInbox>();
    let mut inbox = state.0.lock().unwrap_or_else(|p| p.into_inner());
    let (request, verified) = inbox.begin_remote(&review_id)?;
    let handle = app.clone();
    inbox.remote_task = Some(tauri::async_runtime::spawn(async move {
        let result = if let Some(verified) = verified {
            match crate::local_plugin_install(&handle) {
                Ok(install) => verified.download(&install).await.map(RemoteResult::Archive),
                Err(_) => Err("The local plugin directory is unavailable. No package was installed.".into()),
            }
        } else {
            match crate::plugin_registry::configured_resolver() {
                Ok(resolver) => resolver.lookup(&request.id, &request.version).await.map(RemoteResult::Metadata).map_err(str::to_owned),
                Err(error) => Err(error.into()),
            }
        };
        handle.state::<ArchiveInbox>().0.lock().unwrap_or_else(|p| p.into_inner()).finish_remote(&review_id, result);
        changed(&handle);
    }));
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
        inbox.view.busy = false; inbox.view.review = None; inbox.view.registry = None; inbox.verified = None;
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
        assert!(inbox.request_link(link, false));
        assert_eq!(inbox.view.error.as_deref(), Some(crate::plugin_registry::RESOLUTION_UNAVAILABLE));
        assert!(inbox.view.review.is_none() && inbox.prepared.is_none() && !inbox.view.busy);
        assert!(inbox.take("forged-review").is_err());
        inbox.cancel(None).unwrap();
        assert!(!inbox.request_link(link, false));
        assert!(inbox.view.error.is_none());
        // Startup and running callbacks canonicalize percent encodings into the same identity.
        assert!(!inbox.request_link("zdeck://plugins/install?version=1.2.3&id=%66ixture", false));
        assert_eq!(inbox.view.installed_epoch, 0);
    }
    #[test]
    fn configured_link_only_creates_identity_intent_never_archive_authorization() {
        let mut inbox = Inbox::default();
        let link = "zdeck://plugins/install?id=fixture&version=1.2.3";
        assert!(inbox.request_link(link, true));
        let review = inbox.view.registry.as_ref().unwrap().clone();
        assert_eq!(review.id, "fixture");
        assert!(review.release.is_none() && review.key_id.is_none());
        assert!(inbox.view.error.is_none() && inbox.view.review.is_none() && inbox.prepared.is_none());
        assert!(inbox.take(&review.review_id).is_err());
        inbox.cancel(Some(&review.review_id)).unwrap();
        assert!(!inbox.request_link(link, true));
        assert!(inbox.view.registry.is_none());
    }
    #[test]
    fn link_notice_waits_for_local_picker_review_and_errors_without_replacing_authorization() {
        let mut inbox = Inbox::default();
        inbox.begin().unwrap();
        assert!(inbox.request_link("zdeck://plugins/install?id=fixture&version=1.2.3", false));
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
        assert!(!inbox.request_link("zdeck://plugins/install?id=fixture&version=1.2.3", false));
        assert_eq!(inbox.view.review.as_ref().unwrap().review_id, review.review_id);
        assert!(inbox.cancel(Some(&"forged".into())).is_err());
        inbox.cancel(Some(&review.review_id)).unwrap();
        assert_eq!(inbox.view.error.as_deref(), Some(crate::plugin_registry::RESOLUTION_UNAVAILABLE));
        inbox.cancel(None).unwrap();
        assert!(inbox.view.error.is_none());
        inbox.begin().unwrap();
        inbox.request_link("zdeck://plugins/install?id=another&version=1.2.3", false);
        inbox.finish(Err("Fixture archive failed.".into()));
        assert_eq!(inbox.view.error.as_deref(), Some("Fixture archive failed."));
        inbox.cancel(None).unwrap();
        assert_eq!(inbox.view.error.as_deref(), Some(crate::plugin_registry::RESOLUTION_UNAVAILABLE));
    }
    #[test]
    fn remote_intents_wait_for_local_work_and_stale_cancel_or_completion_cannot_replace_current_review() {
        let mut inbox = Inbox::default();
        let request = |id: &str| InstallRequest { id: id.into(), version: "1.2.3".into() };
        inbox.begin().unwrap(); inbox.queue_request(request("first")); inbox.queue_request(request("ignored-overflow"));
        assert!(inbox.view.registry.is_none());
        inbox.finish(Err("local error stays visible".into())); assert!(inbox.view.registry.is_none());
        inbox.cancel(None).unwrap();
        let first = inbox.view.registry.as_ref().unwrap().clone(); assert_eq!(first.id, "first");
        assert!(inbox.take(&first.review_id).is_err()); assert!(inbox.begin_remote("forged").is_err());
        assert!(inbox.begin().is_err());
        inbox.queue_request(request("second"));
        assert!(inbox.begin_remote(&first.review_id).unwrap().1.is_none());
        assert!(inbox.begin_remote(&first.review_id).is_err());
        inbox.cancel(Some(&first.review_id)).unwrap();
        let second = inbox.view.registry.as_ref().unwrap().clone(); assert_eq!(second.id, "second"); assert_ne!(first.review_id,second.review_id);
        assert!(inbox.cancel(Some(&first.review_id)).is_err());
        inbox.finish_remote(&first.review_id, Err("stale network failure".into()));
        assert!(inbox.view.error.is_none()); assert_eq!(inbox.view.registry.as_ref().unwrap().review_id,second.review_id);
        inbox.cancel(Some(&second.review_id)).unwrap(); assert!(inbox.view.registry.is_none());
    }
    #[tokio::test]
    async fn cancel_aborts_in_flight_remote_transport_instead_of_leaving_a_background_download() {
        struct Signal(Option<tokio::sync::oneshot::Sender<()>>);
        impl Drop for Signal { fn drop(&mut self) { if let Some(tx) = self.0.take() { let _ = tx.send(()); } } }
        let mut inbox = Inbox::default(); inbox.queue_request(InstallRequest { id:"fixture".into(),version:"1.2.3".into() });
        let token = inbox.view.registry.as_ref().unwrap().review_id.clone(); inbox.begin_remote(&token).unwrap();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel(); let (dropped_tx,dropped_rx) = tokio::sync::oneshot::channel();
        inbox.remote_task = Some(tauri::async_runtime::spawn(async move {
            let _signal = Signal(Some(dropped_tx)); let _ = started_tx.send(());
            std::future::pending::<()>().await;
        }));
        started_rx.await.unwrap(); inbox.cancel(Some(&token)).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1),dropped_rx).await.unwrap().unwrap();
        assert!(!inbox.view.busy && inbox.remote_task.is_none() && inbox.view.registry.is_none());
    }
    #[test]
    fn authenticated_metadata_still_cannot_install_and_download_cancellation_clears_authorization() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!("../../crates/zdeck-plugin-host/tests/fixtures/ed25519-public-fixture.json")).unwrap();
        let keys = fixture["trust"]["keys"].to_string();
        let resolver = zdeck_plugin_host::registry_release::Resolver::configured(fixture["trust"]["endpoint"].as_str(),Some(&keys)).unwrap();
        let verified = resolver.verify(&serde_json::to_vec(&fixture["envelope"]).unwrap(),"fixture","1.2.3",std::env::consts::OS).unwrap();
        let mut inbox = Inbox::default(); inbox.queue_request(InstallRequest { id:"fixture".into(),version:"1.2.3".into() });
        let token = inbox.view.registry.as_ref().unwrap().review_id.clone();
        inbox.begin_remote(&token).unwrap(); inbox.finish_remote(&token,Ok(RemoteResult::Metadata(verified)));
        assert_eq!(inbox.view.registry.as_ref().unwrap().key_id.as_deref(),Some("fixture-only"));
        assert!(inbox.take(&token).is_err()); assert!(inbox.prepared.is_none());
        assert!(inbox.begin_remote(&token).unwrap().1.is_some());
        inbox.cancel(Some(&token)).unwrap(); inbox.finish_remote(&token,Err("stale download".into()));
        assert!(inbox.verified.is_none() && inbox.view.registry.is_none() && inbox.view.error.is_none() && !inbox.view.busy);
        assert_eq!(inbox.view.installed_epoch,0);
    }
    #[test]
    fn native_selection_has_no_path_or_target_ipc_and_both_sources_share_validation() {
        let source = include_str!("plugin_archive.rs").split("#[cfg(test)]").next().unwrap();
        assert!(source.contains("spawn(select_paths(app.clone(), paths))"));
        assert!(source.contains("spawn(select_paths(handle, paths))"));
        for command in ["plugin_archive_pick", "plugin_archive_install", "plugin_archive_cancel", "plugin_archive_view", "plugin_archive_resolve"] {
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
