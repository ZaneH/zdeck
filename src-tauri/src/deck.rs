//! Versioned, validated local-file persistence for the deck document.
//!
//! The desktop shell owns the authoritative deck. This module is the only
//! writer of the on-disk document: a plain versioned JSON file under Tauri's
//! app data directory. The frontend never supplies a path.
//!
//! Guarantees:
//! * a document is validated against the same limits, IDs, and action fields as
//!   the TypeScript schema before it is accepted or written;
//! * reads are bounded by [`MAX_DECK_FILE_BYTES`] before the bytes are read;
//! * writes are serialized, go to a same-directory owned temporary file, are
//!   flushed and synced, then renamed over the destination;
//! * a failed write leaves the previous good bytes and the in-memory revision
//!   untouched;
//! * an existing corrupt or incompatible file is never overwritten
//!   automatically.

use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use tokio::sync::{watch, Mutex};

/// Deck schema version understood by both the frontend and this store.
pub const DECK_VERSION: u32 = 2;
pub const MAX_PAGES: usize = 12;
pub const MAX_CONTROLS_PER_PAGE: usize = 24;
/// Upper bound on the on-disk document; checked before the bytes are read.
pub const MAX_DECK_FILE_BYTES: u64 = 256 * 1024;
/// File name inside the app data directory. Relative, never frontend-supplied.
pub const DECK_FILE_NAME: &str = "deck.v1.json";

const MAX_ID_BYTES: usize = 128;
const MAX_NAME_BYTES: usize = 128;
const MAX_LABEL_BYTES: usize = 256;
const MAX_SCENE_BYTES: usize = 256;
/// Mirrors `ACCENTS` in `src/lib/types.ts`.
const ACCENTS: [&str; 5] = ["#4cc9f0", "#6ee7b7", "#f4b860", "#ff7a9c", "#a78bfa"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Dark,
    Light,
}

/// Mirrors the TypeScript `Control` union, tagged by `action`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "action", deny_unknown_fields)]
pub enum ControlAction {
    #[serde(rename = "obs-scene")]
    ObsScene { scene: String },
    #[serde(rename = "mic-mute")]
    MicMute,
    #[serde(rename = "media-play-pause")]
    MediaPlayPause,
    #[serde(rename = "volume")]
    Volume { volume: f64 },
    #[serde(rename = "plugin")]
    Plugin {
        #[serde(rename = "pluginId")]
        plugin_id: String,
        #[serde(rename = "pluginAction")]
        plugin_action: String,
        #[serde(rename = "pluginArgs")]
        plugin_args: serde_json::Map<String, serde_json::Value>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Control {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<crate::icons::ControlIcon>,
    #[serde(flatten)]
    pub action: ControlAction,
}

impl<'de> Deserialize<'de> for Control {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let mut fields = serde_json::Map::<String, serde_json::Value>::deserialize(d)?;
        let id = fields.remove("id").and_then(|v| v.as_str().map(str::to_owned))
            .ok_or_else(|| D::Error::custom("Control ID must be a string."))?;
        let label = fields.remove("label").and_then(|v| v.as_str().map(str::to_owned))
            .ok_or_else(|| D::Error::custom("Control label must be a string."))?;
        let icon = fields.remove("icon").map(serde_json::from_value::<crate::icons::ControlIcon>).transpose()
            .map_err(|_| D::Error::custom("Invalid control icon."))?;
        if icon.as_ref().is_some_and(|icon| !icon.valid()) { return Err(D::Error::custom("Invalid control icon.")); }
        // Serde ignores extra fields on internally tagged unit variants even
        // with deny_unknown_fields. Do not silently drop data during migration.
        if matches!(fields.get("action").and_then(serde_json::Value::as_str), Some("mic-mute" | "media-play-pause")) && fields.len() != 1 {
            return Err(D::Error::custom("Unknown control fields."));
        }
        let action = serde_json::from_value(serde_json::Value::Object(fields))
            .map_err(|_| D::Error::custom("Invalid control action fields."))?;
        Ok(Self { id, label, icon, action })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Page {
    pub id: String,
    pub name: String,
    pub controls: Vec<Control>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Deck {
    pub version: u32,
    pub pages: Vec<Page>,
    pub active_page_id: String,
    pub theme: Theme,
    pub accent: String,
}

/// The persisted document. No secrets or runtime action state belong here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeckDocument {
    pub revision: u64,
    pub deck: Deck,
}

/// The wire shape returned to the frontend, including whether the file existed.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckSnapshot {
    pub revision: u64,
    pub deck: Deck,
    pub exists: bool,
}

/// Sanitized, typed errors returned to the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DeckError {
    InvalidInput {
        message: String,
    },
    FileTooLarge {
        message: String,
    },
    InvalidFile {
        message: String,
    },
    UnsupportedVersion {
        message: String,
    },
    Io {
        message: String,
    },
    Conflict {
        message: String,
        #[serde(rename = "currentRevision")]
        current_revision: u64,
    },
    Unavailable {
        message: String,
    },
}

impl DeckError {
    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::InvalidInput {
            message: message.into(),
        }
    }

    pub fn file_too_large(message: impl Into<String>) -> Self {
        Self::FileTooLarge {
            message: message.into(),
        }
    }

    pub fn invalid_file(message: impl Into<String>) -> Self {
        Self::InvalidFile {
            message: message.into(),
        }
    }

    pub fn unsupported_version(message: impl Into<String>) -> Self {
        Self::UnsupportedVersion {
            message: message.into(),
        }
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::Io {
            message: message.into(),
        }
    }

    pub fn conflict(message: impl Into<String>, current_revision: u64) -> Self {
        Self::Conflict {
            message: message.into(),
            current_revision,
        }
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::Unavailable {
            message: message.into(),
        }
    }
}

impl Deck {
    /// Validate the same limits, IDs, and action fields as the TypeScript schema.
    pub fn validate(&self) -> Result<(), DeckError> {
        if self.version != DECK_VERSION {
            return Err(DeckError::unsupported_version(format!(
                "Deck version {} is not supported.",
                self.version
            )));
        }
        if self.pages.is_empty() || self.pages.len() > MAX_PAGES {
            return Err(DeckError::invalid_input(format!(
                "A deck needs 1 to {MAX_PAGES} pages."
            )));
        }
        if !ACCENTS.contains(&self.accent.as_str()) {
            return Err(DeckError::invalid_input("Unknown accent color."));
        }

        let mut page_ids: HashSet<&str> = HashSet::new();
        let mut control_ids: HashSet<&str> = HashSet::new();

        for page in &self.pages {
            if page.id.is_empty() || page.id.len() > MAX_ID_BYTES || !page_ids.insert(&page.id) {
                return Err(DeckError::invalid_input(
                    "Page IDs must be unique and bounded.",
                ));
            }
            if page.name.trim().is_empty() || page.name.len() > MAX_NAME_BYTES {
                return Err(DeckError::invalid_input(
                    "Page names must be non-empty and bounded.",
                ));
            }
            if page.controls.len() > MAX_CONTROLS_PER_PAGE {
                return Err(DeckError::invalid_input(format!(
                    "A page can hold at most {MAX_CONTROLS_PER_PAGE} controls."
                )));
            }
            for control in &page.controls {
                if control.id.is_empty()
                    || control.id.len() > MAX_ID_BYTES
                    || !control_ids.insert(&control.id)
                {
                    return Err(DeckError::invalid_input(
                        "Control IDs must be unique and bounded.",
                    ));
                }
                if control.label.trim().is_empty() || control.label.len() > MAX_LABEL_BYTES {
                    return Err(DeckError::invalid_input(
                        "Control labels must be non-empty and bounded.",
                    ));
                }
                if control.icon.as_ref().is_some_and(|icon| !icon.valid()) {
                    return Err(DeckError::invalid_input("Control icons require a known built-in icon or a bounded image data URL."));
                }
                match &control.action {
                    ControlAction::ObsScene { scene } => {
                        if scene.trim().is_empty() || scene.len() > MAX_SCENE_BYTES {
                            return Err(DeckError::invalid_input(
                                "OBS scene names must be non-empty and bounded.",
                            ));
                        }
                    }
                    ControlAction::Plugin { plugin_id, plugin_action, plugin_args } => {
                        if !crate::plugin::identifier(plugin_id) || !crate::plugin::identifier(plugin_action)
                            || plugin_args.len() > 8
                            || !plugin_args.iter().all(|(k, v)| crate::plugin::identifier(k) && crate::plugin::integer(v).is_some()) {
                            return Err(DeckError::invalid_input("Plugin controls require bounded IDs and at most eight safe integer arguments."));
                        }
                    }
                    ControlAction::MicMute | ControlAction::MediaPlayPause => {}
                    ControlAction::Volume { volume } => {
                        if !volume.is_finite() || *volume < 0.0 || *volume > 100.0 {
                            return Err(DeckError::invalid_input(
                                "Volume must be between 0 and 100.",
                            ));
                        }
                    }
                }
            }
        }

        if !page_ids.contains(self.active_page_id.as_str()) {
            return Err(DeckError::invalid_input("The active page must exist."));
        }
        Ok(())
    }
}

/// The built-in sample deck, mirroring `createDefaultDeck` in `src/lib/deck.ts`.
pub fn default_deck() -> Deck {
    fn obs(id: &str, label: &str, scene: &str) -> Control {
        Control {
            id: id.to_string(),
            label: label.to_string(),
            icon: None,
            action: ControlAction::ObsScene {
                scene: scene.to_string(),
            },
        }
    }
    fn plain(id: &str, label: &str, action: ControlAction) -> Control {
        Control {
            id: id.to_string(),
            label: label.to_string(),
            icon: None,
            action,
        }
    }

    Deck {
        version: DECK_VERSION,
        theme: Theme::Dark,
        accent: ACCENTS[0].to_string(),
        active_page_id: "page_stream".to_string(),
        pages: vec![
            Page {
                id: "page_stream".to_string(),
                name: "Stream".to_string(),
                controls: vec![
                    obs("ctl_starting_soon", "Starting soon", "Starting soon"),
                    obs("ctl_live", "Go live", "Live"),
                    plain("ctl_mic", "Mic mute", ControlAction::MicMute),
                    plain(
                        "ctl_play_pause",
                        "Play / pause",
                        ControlAction::MediaPlayPause,
                    ),
                ],
            },
            Page {
                id: "page_media".to_string(),
                name: "Media".to_string(),
                controls: vec![
                    plain(
                        "ctl_volume",
                        "Volume",
                        ControlAction::Volume { volume: 50.0 },
                    ),
                    plain(
                        "ctl_media_pause",
                        "Play / pause",
                        ControlAction::MediaPlayPause,
                    ),
                ],
            },
        ],
    }
}

struct StoreInner {
    /// `None` means the file did not exist at last load.
    current: Option<DeckDocument>,
    loaded: bool,
}

/// Authoritative in-memory deck backed by one atomically written JSON file.
///
/// The in-memory revision only advances after a durable successful write, so a
/// failed write cannot make the store advertise data that is not on disk.
pub struct DeckStore {
    path: PathBuf,
    inner: Mutex<StoreInner>,
    temp_counter: AtomicU64,
    /// Publishes the snapshot after a successful save. The service uses this
    /// to keep authenticated sockets current without reading the file again.
    saved: watch::Sender<Option<DeckSnapshot>>,
    #[cfg(test)]
    fail_next_write: std::sync::atomic::AtomicBool,
}

impl DeckStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            inner: Mutex::new(StoreInner {
                current: None,
                loaded: false,
            }),
            temp_counter: AtomicU64::new(0),
            saved: watch::channel(None).0,
            #[cfg(test)]
            fail_next_write: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Load the latest snapshot, reading the file at most once.
    pub async fn load(&self) -> Result<DeckSnapshot, DeckError> {
        let mut inner = self.inner.lock().await;
        self.load_locked(&mut inner)
    }

    /// Subscribe to successful-save snapshots. This is a wake-up hint only;
    /// readers still load the authoritative snapshot from the store.
    pub fn subscribe(&self) -> watch::Receiver<Option<DeckSnapshot>> {
        self.saved.subscribe()
    }

    /// Compare-and-swap save. Returns the new snapshot, or a typed conflict.
    pub async fn save(
        &self,
        expected_revision: u64,
        deck: Deck,
    ) -> Result<DeckSnapshot, DeckError> {
        deck.validate()?;

        let mut inner = self.inner.lock().await;
        self.load_locked(&mut inner)?;

        let current_revision = inner.current.as_ref().map(|d| d.revision).unwrap_or(0);
        if current_revision != expected_revision {
            return Err(DeckError::conflict(
                format!(
                    "The deck changed elsewhere (revision {current_revision}). Reload before saving."
                ),
                current_revision,
            ));
        }

        let revision = current_revision
            .checked_add(1)
            .ok_or_else(|| DeckError::invalid_input("Deck revision is exhausted."))?;
        let document = DeckDocument { revision, deck };
        let bytes = serde_json::to_vec(&document)
            .map_err(|_| DeckError::invalid_input("The deck could not be encoded."))?;
        if bytes.len() as u64 > MAX_DECK_FILE_BYTES {
            return Err(DeckError::file_too_large(
                "The deck document is too large to save safely.",
            ));
        }

        // Only publish the new revision after the bytes are durable.
        self.write_atomic(&bytes)?;
        inner.current = Some(document);
        inner.loaded = true;
        let snapshot = snapshot_of(&inner);
        let _ = self.saved.send(Some(snapshot.clone()));
        Ok(snapshot)
    }

    fn load_locked(&self, inner: &mut StoreInner) -> Result<DeckSnapshot, DeckError> {
        if !inner.loaded {
            inner.current = self.read_document()?;
            inner.loaded = true;
        }
        Ok(snapshot_of(inner))
    }

    fn read_document(&self) -> Result<Option<DeckDocument>, DeckError> {
        let file = match std::fs::File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(DeckError::io(format!(
                    "Could not open the deck file ({:?}).",
                    error.kind()
                )))
            }
        };

        let size = file
            .metadata()
            .map_err(|error| {
                DeckError::io(format!(
                    "Could not stat the deck file ({:?}).",
                    error.kind()
                ))
            })?
            .len();
        if size > MAX_DECK_FILE_BYTES {
            return Err(DeckError::file_too_large(format!(
                "The deck file is larger than {MAX_DECK_FILE_BYTES} bytes."
            )));
        }

        // Read with a hard cap in case the file grows between stat and read.
        let mut bytes = Vec::new();
        file.take(MAX_DECK_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| {
                DeckError::io(format!(
                    "Could not read the deck file ({:?}).",
                    error.kind()
                ))
            })?;
        if bytes.len() as u64 > MAX_DECK_FILE_BYTES {
            return Err(DeckError::file_too_large(format!(
                "The deck file is larger than {MAX_DECK_FILE_BYTES} bytes."
            )));
        }

        let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| DeckError::invalid_file("The deck file is not valid JSON."))?;
        if let Some(version) = value.pointer("/deck/version").and_then(serde_json::Value::as_u64) {
            if version != 1 && version != u64::from(DECK_VERSION) {
                return Err(DeckError::unsupported_version("The deck version is not supported."));
            }
        }
        let mut document: DeckDocument = serde_json::from_value(value).map_err(|_| {
            DeckError::invalid_file("The deck file is not a valid versioned deck document.")
        })?;
        if document.deck.version == 1 {
            if document.deck.pages.iter().flat_map(|p| &p.controls).any(|c| matches!(c.action, ControlAction::Plugin { .. })) {
                return Err(DeckError::invalid_file("Plugin controls require deck version 2."));
            }
            // Keep the legacy filename and bytes. Only a valid explicit save
            // writes version 2, using the existing revision/conflict checks.
            document.deck.version = DECK_VERSION;
        }
        document.deck.validate().map_err(|error| match error {
            DeckError::UnsupportedVersion { message } => DeckError::UnsupportedVersion { message },
            _ => DeckError::invalid_file("The deck file failed schema validation."),
        })?;
        Ok(Some(document))
    }

    fn write_atomic(&self, bytes: &[u8]) -> Result<(), DeckError> {
        #[cfg(test)]
        if self.fail_next_write.swap(false, Ordering::SeqCst) {
            return Err(DeckError::io("simulated write failure"));
        }

        let parent = self
            .path
            .parent()
            .ok_or_else(|| DeckError::io("The deck file has no parent directory."))?;
        std::fs::create_dir_all(parent).map_err(|error| {
            DeckError::io(format!(
                "Could not create the deck directory ({:?}).",
                error.kind()
            ))
        })?;

        let file_name = self
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| DeckError::io("The deck file name is invalid."))?;
        let temp = parent.join(format!(
            ".{file_name}.{}.{}.tmp",
            std::process::id(),
            self.temp_counter.fetch_add(1, Ordering::SeqCst)
        ));

        let mut created = false;
        let result = (|| -> std::io::Result<()> {
            // create_new refuses to follow a pre-existing symlink at the temp path.
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)?;
            created = true;
            file.write_all(bytes)?;
            file.flush()?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(&temp, &self.path)?;
            // Best-effort directory sync so the rename survives a crash.
            // shortcut: ignore dir-sync failure, upgrade if power-loss durability is required.
            if let Ok(dir) = std::fs::File::open(parent) {
                let _ = dir.sync_all();
            }
            Ok(())
        })();

        if result.is_err() && created {
            let _ = std::fs::remove_file(&temp);
        }
        result.map_err(|error| {
            DeckError::io(format!(
                "Could not write the deck file ({:?}).",
                error.kind()
            ))
        })
    }

    #[cfg(test)]
    fn fail_next_write(&self) {
        self.fail_next_write.store(true, Ordering::SeqCst);
    }
}

fn snapshot_of(inner: &StoreInner) -> DeckSnapshot {
    match &inner.current {
        Some(document) => DeckSnapshot {
            revision: document.revision,
            deck: document.deck.clone(),
            exists: true,
        },
        None => DeckSnapshot {
            revision: 0,
            deck: default_deck(),
            exists: false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    const FIXTURE: &str = include_str!("../../tests/fixtures/deck.sample.json");

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "deck-store-test-{}-{}",
                std::process::id(),
                TEMP_COUNTER.fetch_add(1, Ordering::SeqCst)
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn file(&self) -> PathBuf {
            self.0.join(DECK_FILE_NAME)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn fixture_deck() -> Deck {
        let mut deck: Deck = serde_json::from_str(FIXTURE).expect("fixture is a valid legacy Deck");
        deck.version = DECK_VERSION;
        deck
    }

    #[tokio::test]
    async fn fixture_round_trips_and_covers_all_control_kinds() {
        let deck = fixture_deck();
        deck.validate().unwrap();

        let kinds: HashSet<&str> = deck
            .pages
            .iter()
            .flat_map(|page| {
                page.controls.iter().map(|control| match &control.action {
                    ControlAction::ObsScene { .. } => "obs-scene",
                    ControlAction::MicMute => "mic-mute",
                    ControlAction::MediaPlayPause => "media-play-pause",
                    ControlAction::Volume { .. } => "volume",
                    ControlAction::Plugin { .. } => "plugin",
                })
            })
            .collect();
        let expected: HashSet<&str> = ["obs-scene", "mic-mute", "media-play-pause", "volume"]
            .into_iter()
            .collect();
        assert_eq!(kinds, expected);

        let document = DeckDocument { revision: 7, deck };
        let encoded = serde_json::to_vec(&document).unwrap();
        let decoded: DeckDocument = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded, document);
    }

    #[test]
    fn generic_plugin_controls_are_strict_and_bounded() {
        use serde_json::json;
        let control = json!({"id":"plugin_button","label":"Volume","action":"plugin","pluginId":"spotify","pluginAction":"set-volume","pluginArgs":{"volume":50}});
        let parsed: Control = serde_json::from_value(control.clone()).unwrap();
        let mut deck = fixture_deck();
        deck.pages[0].controls.push(parsed);
        deck.validate().unwrap();
        assert_eq!(serde_json::to_value(deck.pages[0].controls.last().unwrap()).unwrap(), control);
        for (field, value) in [("pluginId", json!("../node")), ("pluginAction", json!("Bad")), ("pluginArgs", json!({"volume":1.5})), ("pluginArgs", json!({"secret":"token"})), ("pluginArgs", json!({"n":9007199254740992i64}))] {
            let mut c = control.clone(); c[field] = value;
            let mut deck = fixture_deck();
            if let Ok(c) = serde_json::from_value(c) { deck.pages[0].controls.push(c); assert!(deck.validate().is_err()); }
        }
        let mut c = control.clone();
        c["pluginArgs"] = json!((0..9).map(|i| (format!("n{i}"), json!(1))).collect::<serde_json::Map<_,_>>());
        let mut deck = fixture_deck(); deck.pages[0].controls.push(serde_json::from_value(c).unwrap()); assert!(deck.validate().is_err());
        for value in [json!(null), json!([]), json!(1)] {
            let mut c = control.clone(); c["pluginArgs"] = value;
            assert!(serde_json::from_value::<Control>(c).is_err());
        }
        for action in [control, json!({"id":"mic","label":"Mic","action":"mic-mute"})] {
            let mut c = action; c["program"] = json!("/private/path");
            assert!(serde_json::from_value::<Control>(c).is_err(), "unknown launch metadata must not be silently discarded");
        }
    }

    #[tokio::test]
    async fn legacy_file_migrates_only_in_memory_until_explicit_save() {
        let dir = TempDir::new();
        let legacy: Deck = serde_json::from_str(FIXTURE).unwrap();
        assert_eq!(legacy.version, 1);
        let bytes = serde_json::to_vec(&DeckDocument { revision: 7, deck: legacy }).unwrap();
        std::fs::write(dir.file(), &bytes).unwrap();
        let store = DeckStore::new(dir.file());
        let snapshot = store.load().await.unwrap();
        assert_eq!(snapshot.deck.version, DECK_VERSION);
        assert_eq!(snapshot.revision, 7);
        assert_eq!(std::fs::read(dir.file()).unwrap(), bytes);
        let mut invalid = snapshot.deck.clone(); invalid.pages.clear();
        assert!(store.save(7, invalid).await.is_err());
        assert_eq!(std::fs::read(dir.file()).unwrap(), bytes);
        assert!(store.save(6, snapshot.deck.clone()).await.is_err());
        assert_eq!(std::fs::read(dir.file()).unwrap(), bytes);
        store.save(7, snapshot.deck).await.unwrap();
        let saved: DeckDocument = serde_json::from_slice(&std::fs::read(dir.file()).unwrap()).unwrap();
        assert_eq!(saved.deck.version, 2); assert_eq!(saved.revision, 8);
    }

    #[tokio::test]
    async fn unknown_legacy_fields_and_plugin_actions_are_not_clobbered() {
        use serde_json::json;
        let base = json!({"revision":3,"deck":serde_json::from_str::<serde_json::Value>(FIXTURE).unwrap()});
        for pointer in ["/extra", "/deck/extra", "/deck/pages/0/extra", "/deck/pages/0/controls/0/extra"] {
            let dir = TempDir::new();
            let mut v = base.clone();
            let (parent,key) = pointer.rsplit_once('/').unwrap();
            v.pointer_mut(parent).unwrap().as_object_mut().unwrap().insert(key.into(), json!(true));
            let bytes = serde_json::to_vec(&v).unwrap();
            std::fs::write(dir.file(), &bytes).unwrap();
            let store = DeckStore::new(dir.file());
            assert!(matches!(store.load().await, Err(DeckError::InvalidFile { .. })));
            assert!(store.save(0, fixture_deck()).await.is_err());
            assert_eq!(std::fs::read(dir.file()).unwrap(), bytes);
        }
        let dir = TempDir::new();
        let mut v = base;
        v["deck"]["pages"][0]["controls"][0] = json!({"id":"p","label":"P","action":"plugin","pluginId":"fake","pluginAction":"go","pluginArgs":{}});
        let bytes = serde_json::to_vec(&v).unwrap(); std::fs::write(dir.file(), &bytes).unwrap();
        let store = DeckStore::new(dir.file()); assert!(store.load().await.is_err());
        assert!(store.save(0, fixture_deck()).await.is_err()); assert_eq!(std::fs::read(dir.file()).unwrap(),bytes);
    }

    #[tokio::test]
    async fn temp_name_collision_does_not_delete_an_unowned_file() {
        let dir = TempDir::new();
        let temp = dir
            .0
            .join(format!(".{DECK_FILE_NAME}.{}.0.tmp", std::process::id()));
        std::fs::write(&temp, b"existing data").unwrap();
        let store = DeckStore::new(dir.file());
        assert!(store.save(0, fixture_deck()).await.is_err());
        assert_eq!(std::fs::read(&temp).unwrap(), b"existing data");
        assert!(!store.load().await.unwrap().exists);
    }

    #[tokio::test]
    async fn default_deck_is_valid_and_matches_the_shared_fixture() {
        let default = default_deck();
        default.validate().unwrap();
        assert_eq!(default, fixture_deck());
    }

    #[tokio::test]
    async fn custom_icons_round_trip_without_plugin_access() {
        use serde_json::json;
        let dir = TempDir::new();
        let store = DeckStore::new(dir.file());
        let mut deck = default_deck();
        deck.pages[0].controls[0].icon = Some(crate::icons::ControlIcon::Image { src: "data:image/svg+xml;base64,PHN2Zy8+".into() });
        deck.pages[0].controls[1].icon = Some(crate::icons::ControlIcon::Builtin { name: "music".into() });
        let saved = store.save(0, deck.clone()).await.unwrap();
        assert_eq!(saved.deck, deck);
        assert_eq!(DeckStore::new(dir.file()).load().await.unwrap().deck, deck);
        let encoded = serde_json::to_value(&deck).unwrap();
        assert_eq!(encoded["pages"][0]["controls"][0]["icon"]["src"], "data:image/svg+xml;base64,PHN2Zy8+");
        for icon in [json!(null), json!({"type":"builtin","name":"unknown"}),
            json!({"type":"image","src":"https://example.com/icon.svg"}),
            json!({"type":"image","src":"data:image/png;base64,AAAA","extra":true})] {
            let mut bad = encoded.clone(); bad["pages"][0]["controls"][0]["icon"] = icon;
            assert!(serde_json::from_value::<Deck>(bad).is_err());
        }
        deck.pages[0].controls[0].icon = Some(crate::icons::ControlIcon::Image { src: "file:///private".into() });
        assert!(store.save(saved.revision, deck).await.is_err());
        assert_eq!(store.load().await.unwrap().revision, saved.revision);
    }

    #[tokio::test]
    async fn rejects_invalid_decks() {
        let mut duplicate = fixture_deck();
        duplicate.pages[1].id = duplicate.pages[0].id.clone();
        assert!(matches!(
            duplicate.validate(),
            Err(DeckError::InvalidInput { .. })
        ));

        let mut missing_active = fixture_deck();
        missing_active.active_page_id = "missing".to_string();
        assert!(missing_active.validate().is_err());

        let mut bad_volume = fixture_deck();
        if let Some(control) = bad_volume.pages[1].controls.first_mut() {
            control.action = ControlAction::Volume { volume: 101.0 };
        }
        assert!(bad_volume.validate().is_err());

        let mut bad_version = fixture_deck();
        bad_version.version = DECK_VERSION + 1;
        assert!(matches!(
            bad_version.validate(),
            Err(DeckError::UnsupportedVersion { .. })
        ));

        let mut long_label = fixture_deck();
        long_label.pages[0].controls[0].label = "x".repeat(MAX_LABEL_BYTES + 1);
        assert!(long_label.validate().is_err());
    }

    #[tokio::test]
    async fn missing_file_loads_uninitialized_default_without_creating_one() {
        let dir = TempDir::new();
        let store = DeckStore::new(dir.file());
        let snapshot = store.load().await.unwrap();
        assert!(!snapshot.exists);
        assert_eq!(snapshot.revision, 0);
        assert_eq!(snapshot.deck, default_deck());
        assert!(!dir.file().exists());
    }

    #[tokio::test]
    async fn first_save_creates_the_file_and_a_restart_loads_it() {
        let dir = TempDir::new();
        let store = DeckStore::new(dir.file());
        let saved = store.save(0, fixture_deck()).await.unwrap();
        assert!(saved.exists);
        assert_eq!(saved.revision, 1);
        assert!(dir.file().exists());

        let restarted = DeckStore::new(dir.file());
        let loaded = restarted.load().await.unwrap();
        assert!(loaded.exists);
        assert_eq!(loaded.revision, 1);
        assert_eq!(loaded.deck, fixture_deck());
    }

    #[tokio::test]
    async fn revision_increments_and_a_stale_save_conflicts() {
        let dir = TempDir::new();
        let store = DeckStore::new(dir.file());
        assert_eq!(store.save(0, fixture_deck()).await.unwrap().revision, 1);

        let mut changed = fixture_deck();
        changed.theme = Theme::Light;
        let conflict = store.save(0, changed).await.unwrap_err();
        match conflict {
            DeckError::Conflict {
                current_revision, ..
            } => assert_eq!(current_revision, 1),
            other => panic!("expected a conflict, got {other:?}"),
        }
        assert_eq!(store.load().await.unwrap().revision, 1);

        assert_eq!(store.save(1, fixture_deck()).await.unwrap().revision, 2);
    }

    #[tokio::test]
    async fn malformed_and_unknown_version_files_are_left_untouched() {
        let dir = TempDir::new();

        let malformed = dir.file();
        std::fs::write(&malformed, b"{not json").unwrap();
        let store = DeckStore::new(malformed.clone());
        assert!(matches!(
            store.load().await.unwrap_err(),
            DeckError::InvalidFile { .. }
        ));
        assert!(store.save(0, fixture_deck()).await.is_err());
        assert_eq!(std::fs::read(&malformed).unwrap(), b"{not json");

        let unknown = dir.file();
        let mut document = DeckDocument {
            revision: 4,
            deck: fixture_deck(),
        };
        document.deck.version = DECK_VERSION + 1;
        std::fs::write(&unknown, serde_json::to_vec(&document).unwrap()).unwrap();
        let store = DeckStore::new(unknown.clone());
        assert!(matches!(
            store.load().await.unwrap_err(),
            DeckError::UnsupportedVersion { .. }
        ));
        assert!(store.save(0, fixture_deck()).await.is_err());
        assert_eq!(
            serde_json::from_slice::<DeckDocument>(&std::fs::read(&unknown).unwrap())
                .unwrap()
                .revision,
            4
        );
    }

    #[tokio::test]
    async fn oversize_file_is_rejected_before_reading_and_left_untouched() {
        let dir = TempDir::new();
        let file = dir.file();
        let oversize = vec![b' '; MAX_DECK_FILE_BYTES as usize + 1];
        std::fs::write(&file, &oversize).unwrap();

        let store = DeckStore::new(file.clone());
        assert!(matches!(
            store.load().await.unwrap_err(),
            DeckError::FileTooLarge { .. }
        ));
        assert_eq!(std::fs::read(&file).unwrap().len(), oversize.len());
    }

    #[tokio::test]
    async fn a_disk_error_preserves_prior_bytes_and_in_memory_revision() {
        let dir = TempDir::new();
        let store = DeckStore::new(dir.file());
        store.save(0, fixture_deck()).await.unwrap();
        let before = std::fs::read(dir.file()).unwrap();

        let mut changed = fixture_deck();
        changed.theme = Theme::Light;
        store.fail_next_write();
        assert!(matches!(
            store.save(1, changed).await.unwrap_err(),
            DeckError::Io { .. }
        ));
        assert_eq!(std::fs::read(dir.file()).unwrap(), before);
        assert_eq!(store.load().await.unwrap().revision, 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn concurrent_saves_serialize_through_the_cas() {
        let dir = TempDir::new();
        let store = Arc::new(DeckStore::new(dir.file()));

        let mut tasks = tokio::task::JoinSet::new();
        for index in 0..8 {
            let store = Arc::clone(&store);
            tasks.spawn(async move {
                let mut deck = fixture_deck();
                deck.accent = ACCENTS[index % ACCENTS.len()].to_string();
                store.save(0, deck).await
            });
        }

        let mut successes = 0;
        let mut conflicts = 0;
        while let Some(result) = tasks.join_next().await {
            match result.unwrap() {
                Ok(snapshot) => {
                    successes += 1;
                    assert_eq!(snapshot.revision, 1);
                }
                Err(DeckError::Conflict { .. }) => conflicts += 1,
                Err(other) => panic!("unexpected error: {other:?}"),
            }
        }
        assert_eq!(successes, 1);
        assert_eq!(conflicts, 7);
        assert_eq!(store.load().await.unwrap().revision, 1);
    }
}
