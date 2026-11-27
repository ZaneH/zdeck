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

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use tokio::sync::{watch, Mutex};

pub use zdeck_schema::deck::*;

/// Upper bound on the deck portion; checked before the bytes are read.
pub const MAX_DECK_FILE_BYTES: u64 = 256 * 1024;
/// Separate trash budget so trash growth cannot make a previously valid deck unsavable.
pub const MAX_TRASH_FILE_BYTES: u64 = MAX_TRASH_BYTES as u64;
/// Combined document budget, including minimal envelope and separator overhead.
pub const MAX_DOCUMENT_FILE_BYTES: u64 = MAX_DECK_FILE_BYTES + MAX_TRASH_FILE_BYTES + 4096;
/// File name inside the app data directory. Relative, never frontend-supplied.
pub const DECK_FILE_NAME: &str = "deck.v1.json";

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
        trash: Vec<TrashEntry>,
    ) -> Result<DeckSnapshot, DeckError> {
        deck.validate()?;
        validate_trash(&trash)?;

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
        // Bound the deck itself separately so Trash growth can never make a
        // previously valid deck unsavable.
        let deck_bytes = serde_json::to_vec(&deck)
            .map_err(|_| DeckError::invalid_input("The deck could not be encoded."))?;
        if deck_bytes.len() as u64 > MAX_DECK_FILE_BYTES {
            return Err(DeckError::file_too_large(
                "The deck is too large to save safely.",
            ));
        }
        let document = DeckDocument { revision, deck, trash };
        let bytes = serde_json::to_vec(&document)
            .map_err(|_| DeckError::invalid_input("The deck could not be encoded."))?;
        if bytes.len() as u64 > MAX_DOCUMENT_FILE_BYTES {
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
        if size > MAX_DOCUMENT_FILE_BYTES {
            return Err(DeckError::file_too_large(format!(
                "The deck file is larger than {MAX_DOCUMENT_FILE_BYTES} bytes."
            )));
        }

        // Read with a hard cap in case the file grows between stat and read.
        let mut bytes = Vec::new();
        file.take(MAX_DOCUMENT_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| {
                DeckError::io(format!(
                    "Could not read the deck file ({:?}).",
                    error.kind()
                ))
            })?;
        if bytes.len() as u64 > MAX_DOCUMENT_FILE_BYTES {
            return Err(DeckError::file_too_large(format!(
                "The deck file is larger than {MAX_DOCUMENT_FILE_BYTES} bytes."
            )));
        }

        let document = decode_document(&bytes)?;
        let deck_size = serde_json::to_vec(&document.deck)
            .map_err(|_| DeckError::invalid_file("The deck could not be decoded."))?
            .len() as u64;
        if deck_size > MAX_DECK_FILE_BYTES {
            return Err(DeckError::file_too_large(
                "The deck is larger than the per-deck bound.",
            ));
        }
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
            trash: document.trash.clone(),
            exists: true,
        },
        None => DeckSnapshot {
            revision: 0,
            deck: default_deck(),
            trash: Vec::new(),
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
        let legacy = serde_json::from_str::<serde_json::Value>(FIXTURE).unwrap();
        let document = serde_json::json!({"revision": 7, "deck": legacy});
        decode_document(&serde_json::to_vec(&document).unwrap()).unwrap().deck
    }

    #[tokio::test]
    async fn control_spans_are_optional_bounded_and_persisted() {
        use serde_json::json;
        let mut deck = fixture_deck();
        assert_eq!(deck.pages[0].sections[0].controls[0].row_span.unwrap_or(1), 1);
        assert_eq!(deck.pages[0].sections[0].controls[0].column_span.unwrap_or(1), 1);
        for (field, invalid) in [("rowSpan", vec![json!(0), json!(-1), json!(1.5), json!(25), json!("2"), json!(null)]),
                                 ("columnSpan", vec![json!(0), json!(-1), json!(1.5), json!(5), json!("2"), json!(null)])] {
            for value in invalid {
                let mut control = json!({"id":"mic","label":"Mic","action":"mic-mute"});
                control[field] = value;
                assert!(serde_json::from_value::<Control>(control).is_err());
            }
        }
        deck.pages[0].sections[0].controls[0].row_span = Some(24);
        deck.pages[0].sections[0].controls[0].column_span = Some(4);
        deck.validate().unwrap();
        let dir = TempDir::new();
        let store = DeckStore::new(dir.0.join(DECK_FILE_NAME));
        let initial = store.load().await.unwrap();
        store.save(initial.revision, deck.clone(), vec![]).await.unwrap();
        assert_eq!(DeckStore::new(dir.0.join(DECK_FILE_NAME)).load().await.unwrap().deck, deck);
        deck.pages[0].sections[0].controls[0].column_span = Some(5);
        assert!(deck.validate().is_err());
    }

    #[tokio::test]
    async fn legacy_file_migrates_only_in_memory_until_explicit_save() {
        let dir = TempDir::new();
        let legacy = serde_json::from_str::<serde_json::Value>(FIXTURE).unwrap();
        assert_eq!(legacy["version"], 1);
        let bytes = serde_json::to_vec(&serde_json::json!({"revision": 7, "deck": legacy})).unwrap();
        std::fs::write(dir.file(), &bytes).unwrap();
        let store = DeckStore::new(dir.file());
        let snapshot = store.load().await.unwrap();
        assert_eq!(snapshot.deck.version, DECK_VERSION);
        assert_eq!(snapshot.revision, 7);
        assert_eq!(std::fs::read(dir.file()).unwrap(), bytes);
        let mut invalid = snapshot.deck.clone(); invalid.pages.clear();
        assert!(store.save(7, invalid, vec![]).await.is_err());
        assert_eq!(std::fs::read(dir.file()).unwrap(), bytes);
        assert!(store.save(6, snapshot.deck.clone(), vec![]).await.is_err());
        assert_eq!(std::fs::read(dir.file()).unwrap(), bytes);
        store.save(7, snapshot.deck, vec![]).await.unwrap();
        let saved: DeckDocument = serde_json::from_slice(&std::fs::read(dir.file()).unwrap()).unwrap();
        assert_eq!(saved.deck.version, DECK_VERSION); assert_eq!(saved.revision, 8);
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
            assert!(store.save(0, fixture_deck(), vec![]).await.is_err());
            assert_eq!(std::fs::read(dir.file()).unwrap(), bytes);
        }
        let dir = TempDir::new();
        let mut v = base;
        v["deck"]["pages"][0]["controls"][0] = json!({"id":"p","label":"P","action":"plugin","pluginId":"fake","pluginAction":"go","pluginArgs":{}});
        let bytes = serde_json::to_vec(&v).unwrap(); std::fs::write(dir.file(), &bytes).unwrap();
        let store = DeckStore::new(dir.file()); assert!(store.load().await.is_err());
        assert!(store.save(0, fixture_deck(), vec![]).await.is_err()); assert_eq!(std::fs::read(dir.file()).unwrap(),bytes);
    }

    #[tokio::test]
    async fn temp_name_collision_does_not_delete_an_unowned_file() {
        let dir = TempDir::new();
        let temp = dir
            .0
            .join(format!(".{DECK_FILE_NAME}.{}.0.tmp", std::process::id()));
        std::fs::write(&temp, b"existing data").unwrap();
        let store = DeckStore::new(dir.file());
        assert!(store.save(0, fixture_deck(), vec![]).await.is_err());
        assert_eq!(std::fs::read(&temp).unwrap(), b"existing data");
        assert!(!store.load().await.unwrap().exists);
    }

    #[tokio::test]
    async fn glass_theme_round_trips_through_a_restart() {
        let dir = TempDir::new();
        let store = DeckStore::new(dir.file());
        let mut deck = default_deck();
        deck.theme = Theme::Glass;
        deck.pages[0].sections[0].theme = Some(Theme::Glass);
        let saved = store.save(0, deck.clone(), vec![]).await.unwrap();
        assert_eq!(saved.deck, deck);
        assert_eq!(DeckStore::new(dir.file()).load().await.unwrap().deck, deck);
    }

    #[tokio::test]
    async fn custom_icons_round_trip_without_plugin_access() {
        use serde_json::json;
        let dir = TempDir::new();
        let store = DeckStore::new(dir.file());
        let mut deck = default_deck();
        deck.pages[0].sections[0].controls[0].icon = Some(crate::icons::ControlIcon::Image { src: "data:image/svg+xml;base64,PHN2Zy8+".into() });
        deck.pages[0].sections[0].controls[1].icon = Some(crate::icons::ControlIcon::Builtin { name: "music".into() });
        let saved = store.save(0, deck.clone(), vec![]).await.unwrap();
        assert_eq!(saved.deck, deck);
        assert_eq!(DeckStore::new(dir.file()).load().await.unwrap().deck, deck);
        let encoded = serde_json::to_value(&deck).unwrap();
        assert_eq!(encoded["pages"][0]["sections"][0]["controls"][0]["icon"]["src"], "data:image/svg+xml;base64,PHN2Zy8+");
        for icon in [json!(null), json!({"type":"builtin","name":"unknown"}),
            json!({"type":"image","src":"https://example.com/icon.svg"}),
            json!({"type":"image","src":"data:image/png;base64,AAAA","extra":true})] {
            let mut bad = encoded.clone(); bad["pages"][0]["sections"][0]["controls"][0]["icon"] = icon;
            assert!(serde_json::from_value::<Deck>(bad).is_err());
        }
        deck.pages[0].sections[0].controls[0].icon = Some(crate::icons::ControlIcon::Image { src: "file:///private".into() });
        assert!(store.save(saved.revision, deck, vec![]).await.is_err());
        assert_eq!(store.load().await.unwrap().revision, saved.revision);
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
        let saved = store.save(0, fixture_deck(), vec![]).await.unwrap();
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
        assert_eq!(store.save(0, fixture_deck(), vec![]).await.unwrap().revision, 1);

        let mut changed = fixture_deck();
        changed.theme = Theme::Light;
        let conflict = store.save(0, changed, vec![]).await.unwrap_err();
        match conflict {
            DeckError::Conflict {
                current_revision, ..
            } => assert_eq!(current_revision, 1),
            other => panic!("expected a conflict, got {other:?}"),
        }
        assert_eq!(store.load().await.unwrap().revision, 1);

        assert_eq!(store.save(1, fixture_deck(), vec![]).await.unwrap().revision, 2);
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
        assert!(store.save(0, fixture_deck(), vec![]).await.is_err());
        assert_eq!(std::fs::read(&malformed).unwrap(), b"{not json");

        let unknown = dir.file();
        let mut document = DeckDocument {
            revision: 4,
            deck: fixture_deck(),
            trash: vec![],
        };
        document.deck.version = DECK_VERSION + 1;
        std::fs::write(&unknown, serde_json::to_vec(&document).unwrap()).unwrap();
        let store = DeckStore::new(unknown.clone());
        assert!(matches!(
            store.load().await.unwrap_err(),
            DeckError::UnsupportedVersion { .. }
        ));
        assert!(store.save(0, fixture_deck(), vec![]).await.is_err());
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
        let oversize = vec![b' '; MAX_DOCUMENT_FILE_BYTES as usize + 1];
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
        store.save(0, fixture_deck(), vec![]).await.unwrap();
        let before = std::fs::read(dir.file()).unwrap();

        let mut changed = fixture_deck();
        changed.theme = Theme::Light;
        store.fail_next_write();
        assert!(matches!(
            store.save(1, changed, vec![]).await.unwrap_err(),
            DeckError::Io { .. }
        ));
        assert_eq!(std::fs::read(dir.file()).unwrap(), before);
        assert_eq!(store.load().await.unwrap().revision, 1);
    }

    fn trash_entry() -> TrashEntry {
        let deck = default_deck();
        let control = deck.pages[0].sections[0].controls[0].clone();
        TrashEntry::Control {
            id: control.id.clone(),
            deleted_at: 1,
            control,
            location: TrashLocation {
                page_id: "page_stream".into(),
                page_name: "Stream".into(),
                section_id: Some("page_stream_section".into()),
                section_name: Some("Stream".into()),
                index: 0,
            },
        }
    }

    #[tokio::test]
    async fn trash_round_trips_in_the_same_atomic_document() {
        let dir = TempDir::new();
        let store = DeckStore::new(dir.file());
        let entry = trash_entry();
        let saved = store.save(0, default_deck(), vec![entry.clone()]).await.unwrap();
        assert_eq!(saved.trash, vec![entry.clone()]);
        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.file()).unwrap()).unwrap();
        assert_eq!(raw["trash"][0]["id"], "ctl_starting_soon");
        assert_eq!(raw["revision"], 1);

        let restarted = DeckStore::new(dir.file());
        let loaded = restarted.load().await.unwrap();
        assert_eq!(loaded.trash, vec![entry]);
        assert_eq!(loaded.revision, saved.revision);
        assert_eq!(loaded.deck, default_deck());
    }

    #[tokio::test]
    async fn invalid_trash_is_rejected_without_overwriting_the_document() {
        let dir = TempDir::new();
        let store = DeckStore::new(dir.file());
        store.save(0, default_deck(), vec![]).await.unwrap();
        let before = std::fs::read(dir.file()).unwrap();
        let mut entry = trash_entry();
        if let TrashEntry::Control { id, .. } = &mut entry {
            *id = "other".into();
        }
        assert!(matches!(
            store.save(1, default_deck(), vec![entry]).await,
            Err(DeckError::InvalidInput { .. })
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
                deck.theme = if index % 2 == 0 { Theme::Dark } else { Theme::Light };
                store.save(0, deck, vec![]).await
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
