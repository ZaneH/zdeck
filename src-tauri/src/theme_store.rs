//! Native persistent catalog for validated external theme packages.
//!
//! The host owns the catalog file under its app-data directory. The renderer
//! never supplies a path. Raw package bytes are retained as an exact UTF-8
//! string and validated with the shared package parser on every read/import.
//! Digests are SHA-256 of those exact bytes; a reference is derived, never
//! stored separately.
//!
//! Guarantees:
//! * a missing catalog is empty; a corrupt, oversized or invalid catalog fails
//!   visibly and its bytes are preserved untouched;
//! * reads are bounded before the bytes are read, and only regular files are
//!   accepted (symlinks are rejected);
//! * writes are serialized, go to a same-directory owned temporary file, are
//!   flushed and synced, then renamed over the destination;
//! * a failed write leaves the previous catalog bytes intact;
//! * installing an exact duplicate is idempotent and does not rewrite the file;
//!   a different digest for the same id and version is a visible conflict.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::{watch, Mutex};
use zdeck_schema::theme_package::{
    parse_theme_package, CustomThemeReference, ThemePackage, MAX_THEME_PACKAGE_BYTES,
};

/// File name inside the host app-data directory. Relative, never renderer-supplied.
pub const THEME_CATALOG_FILE_NAME: &str = "themes.v1.json";
/// Maximum installed packages. Individually each is bounded by the package format.
pub const MAX_INSTALLED_THEMES: usize = 16;
/// Whole-catalog byte budget, checked before reading and before writing.
/// shortcut: JSON overhead (keys, escaping, commas) shares this budget with the
/// 16 KiB package ceiling, so 16 maximal packages cannot all fit. Upgrade if the
/// package budget ever needs to be fully usable at the entry limit.
pub const MAX_THEME_CATALOG_BYTES: u64 = 256 * 1024;

/// One installed package plus its exact source and derived reference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledTheme {
    pub package: ThemePackage,
    pub reference: CustomThemeReference,
    /// Exact original package bytes, decoded as UTF-8.
    pub source: String,
}

/// Sanitized, typed errors for the future IPC layer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ThemeStoreError {
    InvalidPackage { message: String },
    LimitReached { message: String },
    InvalidCatalog { message: String },
    Conflict { message: String },
    InUse { message: String },
    NotFound { message: String },
    Forbidden { message: String },
    Unavailable { message: String },
    Io { message: String },
}

impl ThemeStoreError {
    pub(crate) fn invalid_package(message: impl Into<String>) -> Self {
        Self::InvalidPackage { message: message.into() }
    }
    pub(crate) fn limit(message: impl Into<String>) -> Self {
        Self::LimitReached { message: message.into() }
    }
    pub(crate) fn invalid_catalog(message: impl Into<String>) -> Self {
        Self::InvalidCatalog { message: message.into() }
    }
    pub(crate) fn conflict(message: impl Into<String>) -> Self {
        Self::Conflict { message: message.into() }
    }
    pub(crate) fn in_use(message: impl Into<String>) -> Self {
        Self::InUse { message: message.into() }
    }
    pub(crate) fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound { message: message.into() }
    }
    pub(crate) fn io(message: impl Into<String>) -> Self {
        Self::Io { message: message.into() }
    }
    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::Forbidden { message: message.into() }
    }
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::Unavailable { message: message.into() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Catalog {
    schema: u32,
    themes: Vec<StoredTheme>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredTheme {
    /// Exact package bytes as UTF-8. Parsed and validated on every load.
    source: String,
}

impl Catalog {
    fn empty() -> Self {
        Self { schema: 1, themes: Vec::new() }
    }
}

/// Authoritative theme catalog backed by one atomically written JSON file.
///
/// Construction performs no I/O, so a settings problem never blocks launch.
pub struct ThemeStore {
    path: PathBuf,
    /// Serializes every catalog read-modify-write.
    lock: Mutex<()>,
    temp_counter: AtomicU64,
    /// Wakes the phone service after a successful catalog write. No I/O here.
    changed: watch::Sender<()>,
    #[cfg(test)]
    fail_next_write: std::sync::atomic::AtomicBool,
}

impl ThemeStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            lock: Mutex::new(()),
            temp_counter: AtomicU64::new(0),
            changed: watch::channel(()).0,
            #[cfg(test)]
            fail_next_write: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Subscribe to successful catalog changes. This is a wake-up hint only;
    /// readers still load the authoritative catalog from the store.
    pub fn subscribe(&self) -> watch::Receiver<()> {
        self.changed.subscribe()
    }

    /// Read and validate the persisted catalog, preserving its order.
    pub async fn list(&self) -> Result<Vec<InstalledTheme>, ThemeStoreError> {
        let _guard = self.lock.lock().await;
        self.load_catalog()?.themes.iter().map(installed).collect()
    }

    /// Validate and append a package. Exact duplicates succeed without writing.
    pub async fn install(&self, bytes: &[u8]) -> Result<InstalledTheme, ThemeStoreError> {
        let package = parse_theme_package(bytes).ok_or_else(|| {
            ThemeStoreError::invalid_package(
                "This file is not a valid theme package. Use a bounded schema 1 zdeck-theme JSON file.",
            )
        })?;
        // parse_theme_package already required valid UTF-8.
        let source = std::str::from_utf8(bytes)
            .map_err(|_| ThemeStoreError::invalid_package("The theme package must be UTF-8 text."))?
            .to_owned();
        let digest = digest(bytes);
        let reference = CustomThemeReference {
            id: package.id.clone(),
            version: package.version.clone(),
            digest,
        };
        let incoming = InstalledTheme { package, reference, source: source.clone() };

        let _guard = self.lock.lock().await;
        let mut catalog = self.load_catalog()?;
        if let Some(existing) = catalog
            .themes
            .iter()
            .find(|entry| {
                let parsed = parse_theme_package(entry.source.as_bytes());
                parsed.is_some_and(|p| p.id == incoming.package.id && p.version == incoming.package.version)
            })
        {
            let existing = installed(existing)?;
            if existing.reference.digest == incoming.reference.digest {
                return Ok(existing);
            }
            return Err(ThemeStoreError::conflict(
                "A different package is already installed with this id and version. Increment the package version.",
            ));
        }
        if catalog.themes.len() >= MAX_INSTALLED_THEMES {
            return Err(ThemeStoreError::limit(format!(
                "At most {MAX_INSTALLED_THEMES} theme packages can be installed. Remove one first."
            )));
        }
        catalog.themes.push(StoredTheme { source });
        let encoded = serde_json::to_vec(&catalog).map_err(|_| {
            ThemeStoreError::invalid_catalog("The theme catalog could not be encoded.")
        })?;
        if encoded.len() as u64 > MAX_THEME_CATALOG_BYTES {
            return Err(ThemeStoreError::limit(format!(
                "The theme catalog would exceed {MAX_THEME_CATALOG_BYTES} bytes. Remove a package first."
            )));
        }
        self.write_atomic(&encoded)?;
        let _ = self.changed.send(());
        Ok(incoming)
    }

    /// Remove an exact installed reference. In-use references (including trash)
    /// are refused; the caller supplies only trusted references.
    pub async fn remove(
        &self,
        reference: &CustomThemeReference,
        in_use: &[CustomThemeReference],
    ) -> Result<(), ThemeStoreError> {
        if !reference.valid() {
            return Err(ThemeStoreError::invalid_package(
                "The theme reference is invalid.",
            ));
        }
        let _guard = self.lock.lock().await;
        let mut catalog = self.load_catalog()?;
        let index = catalog
            .themes
            .iter()
            .position(|entry| {
                parse_theme_package(entry.source.as_bytes())
                    .is_some_and(|p| p.id == reference.id && p.version == reference.version)
            })
            .ok_or_else(|| ThemeStoreError::not_found("That theme version is not installed."))?;
        let installed = installed(&catalog.themes[index])?;
        if installed.reference.digest != reference.digest {
            return Err(ThemeStoreError::conflict(
                "The installed theme changed since this reference was made. Reload before removing it.",
            ));
        }
        if in_use.iter().any(|used| used.id == reference.id && used.version == reference.version) {
            return Err(ThemeStoreError::in_use(
                "This theme version is still used by a deck or Trash. Replace those references first.",
            ));
        }
        catalog.themes.remove(index);
        let encoded = serde_json::to_vec(&catalog).map_err(|_| {
            ThemeStoreError::invalid_catalog("The theme catalog could not be encoded.")
        })?;
        self.write_atomic(&encoded)?;
        let _ = self.changed.send(());
        Ok(())
    }

    fn load_catalog(&self) -> Result<Catalog, ThemeStoreError> {
        match std::fs::symlink_metadata(&self.path) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err(ThemeStoreError::invalid_catalog(
                    "The theme catalog must be a regular local file, not a symlink.",
                ))
            }
            Ok(meta) if !meta.is_file() => {
                return Err(ThemeStoreError::invalid_catalog(
                    "The theme catalog path is not a regular file.",
                ))
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Catalog::empty())
            }
            Err(error) => {
                return Err(ThemeStoreError::io(format!(
                    "Could not inspect the theme catalog ({:?}).",
                    error.kind()
                )))
            }
        }

        let file = std::fs::File::open(&self.path).map_err(|error| {
            ThemeStoreError::io(format!(
                "Could not open the theme catalog ({:?}).",
                error.kind()
            ))
        })?;
        let size = file
            .metadata()
            .map_err(|error| {
                ThemeStoreError::io(format!(
                    "Could not stat the theme catalog ({:?}).",
                    error.kind()
                ))
            })?
            .len();
        if size > MAX_THEME_CATALOG_BYTES {
            return Err(ThemeStoreError::invalid_catalog(format!(
                "The theme catalog is larger than {MAX_THEME_CATALOG_BYTES} bytes."
            )));
        }
        let mut bytes = Vec::new();
        file.take(MAX_THEME_CATALOG_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| {
                ThemeStoreError::io(format!(
                    "Could not read the theme catalog ({:?}).",
                    error.kind()
                ))
            })?;
        if bytes.len() as u64 > MAX_THEME_CATALOG_BYTES {
            return Err(ThemeStoreError::invalid_catalog(format!(
                "The theme catalog is larger than {MAX_THEME_CATALOG_BYTES} bytes."
            )));
        }
        decode_catalog(&bytes)
    }

    fn write_atomic(&self, bytes: &[u8]) -> Result<(), ThemeStoreError> {
        #[cfg(test)]
        if self.fail_next_write.swap(false, Ordering::SeqCst) {
            return Err(ThemeStoreError::io("simulated write failure"));
        }

        let parent = self.path.parent().ok_or_else(|| {
            ThemeStoreError::io("The theme catalog file has no parent directory.")
        })?;
        std::fs::create_dir_all(parent).map_err(|error| {
            ThemeStoreError::io(format!(
                "Could not create the theme catalog directory ({:?}).",
                error.kind()
            ))
        })?;
        let file_name = self
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| ThemeStoreError::io("The theme catalog file name is invalid."))?;
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
            ThemeStoreError::io(format!(
                "Could not write the theme catalog ({:?}).",
                error.kind()
            ))
        })
    }

    #[cfg(test)]
    fn fail_next_write(&self) {
        self.fail_next_write.store(true, Ordering::SeqCst);
    }
}

fn digest(bytes: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(bytes);
    hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

fn installed(entry: &StoredTheme) -> Result<InstalledTheme, ThemeStoreError> {
    let package = parse_theme_package(entry.source.as_bytes()).ok_or_else(|| {
        ThemeStoreError::invalid_catalog(
            "The theme catalog contains an invalid package. Repair or remove the catalog file.",
        )
    })?;
    let reference = CustomThemeReference {
        id: package.id.clone(),
        version: package.version.clone(),
        digest: digest(entry.source.as_bytes()),
    };
    Ok(InstalledTheme { package, reference, source: entry.source.clone() })
}

fn decode_catalog(bytes: &[u8]) -> Result<Catalog, ThemeStoreError> {
    let catalog: Catalog = serde_json::from_slice(bytes).map_err(|_| {
        ThemeStoreError::invalid_catalog(
            "The theme catalog is not a valid schema 1 catalog document.",
        )
    })?;
    if catalog.schema != 1 {
        return Err(ThemeStoreError::invalid_catalog(
            "The theme catalog uses an unsupported schema version.",
        ));
    }
    if catalog.themes.len() > MAX_INSTALLED_THEMES {
        return Err(ThemeStoreError::invalid_catalog(format!(
            "The theme catalog holds more than {MAX_INSTALLED_THEMES} packages."
        )));
    }
    let mut seen: HashMap<(String, String), String> = HashMap::new();
    for entry in &catalog.themes {
        if entry.source.len() > MAX_THEME_PACKAGE_BYTES {
            return Err(ThemeStoreError::invalid_catalog(
                "The theme catalog contains an oversized package.",
            ));
        }
        let installed = installed(entry)?;
        let key = (installed.package.id.clone(), installed.package.version.clone());
        if seen.insert(key, installed.reference.digest).is_some() {
            return Err(ThemeStoreError::invalid_catalog(
                "The theme catalog contains a duplicate package id and version.",
            ));
        }
    }
    Ok(catalog)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const FIXTURE: &[u8] = include_bytes!("../../tests/fixtures/theme-packages/midnight-maze.json");

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "theme-store-test-{}-{}",
                std::process::id(),
                TEMP_COUNTER.fetch_add(1, Ordering::SeqCst)
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn file(&self) -> PathBuf {
            self.0.join(THEME_CATALOG_FILE_NAME)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn package(id: &str, version: &str) -> Vec<u8> {
        let mut value: serde_json::Value = serde_json::from_slice(FIXTURE).unwrap();
        value["id"] = json!(id);
        value["version"] = json!(version);
        serde_json::to_vec(&value).unwrap()
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        let mut hash = Sha256::new();
        hash.update(bytes);
        hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn catalog_with(sources: &[&str]) -> Vec<u8> {
        let themes: Vec<_> = sources.iter().map(|source| json!({ "source": source })).collect();
        serde_json::to_vec(&json!({ "schema": 1, "themes": themes })).unwrap()
    }

    #[tokio::test]
    async fn restart_round_trip_keeps_exact_source_and_digest() {
        let dir = TempDir::new();
        let store = ThemeStore::new(dir.file());
        let installed = store.install(FIXTURE).await.unwrap();
        assert_eq!(installed.package.id, "midnight-maze");
        assert_eq!(installed.source.as_bytes(), FIXTURE);
        assert_eq!(installed.reference.digest, sha256_hex(FIXTURE));

        let restarted = ThemeStore::new(dir.file());
        let list = restarted.list().await.unwrap();
        assert_eq!(list, vec![installed.clone()]);

        let raw: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.file()).unwrap()).unwrap();
        assert_eq!(raw["themes"][0]["source"].as_str().unwrap().as_bytes(), FIXTURE);
    }

    #[tokio::test]
    async fn exact_duplicate_install_is_idempotent_without_rewrite() {
        let dir = TempDir::new();
        let store = ThemeStore::new(dir.file());
        store.install(FIXTURE).await.unwrap();
        let before = std::fs::read(dir.file()).unwrap();
        let again = store.install(FIXTURE).await.unwrap();
        assert_eq!(std::fs::read(dir.file()).unwrap(), before);
        assert_eq!(store.list().await.unwrap(), vec![again]);
    }

    #[tokio::test]
    async fn same_id_and_version_with_a_different_digest_is_a_visible_conflict() {
        let dir = TempDir::new();
        let store = ThemeStore::new(dir.file());
        store.install(&package("maze-one", "1.0.0")).await.unwrap();
        let before = std::fs::read(dir.file()).unwrap();
        let mut changed: serde_json::Value = serde_json::from_slice(&package("maze-one", "1.0.0")).unwrap();
        changed["name"] = json!("Changed Name");
        let changed = serde_json::to_vec(&changed).unwrap();
        assert!(matches!(
            store.install(&changed).await,
            Err(ThemeStoreError::Conflict { .. })
        ));
        assert_eq!(std::fs::read(dir.file()).unwrap(), before);
        assert_eq!(store.list().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn multiple_versions_of_one_id_coexist() {
        let dir = TempDir::new();
        let store = ThemeStore::new(dir.file());
        store.install(&package("maze", "1.0.0")).await.unwrap();
        store.install(&package("maze", "1.0.1")).await.unwrap();
        let versions: Vec<_> = ThemeStore::new(dir.file())
            .list()
            .await
            .unwrap()
            .into_iter()
            .map(|theme| theme.package.version)
            .collect();
        assert_eq!(versions, ["1.0.0", "1.0.1"]);
    }

    #[tokio::test]
    async fn rejects_invalid_and_oversized_packages_without_writing() {
        let dir = TempDir::new();
        let store = ThemeStore::new(dir.file());
        let mut oversized = FIXTURE.to_vec();
        oversized.resize(MAX_THEME_PACKAGE_BYTES + 1, b' ');
        let mut wrong_id: serde_json::Value = serde_json::from_slice(FIXTURE).unwrap();
        wrong_id["id"] = json!("Bad Id");
        let wrong_id = serde_json::to_vec(&wrong_id).unwrap();
        for bytes in [
            b"not json".as_slice(),
            b"{}".as_slice(),
            oversized.as_slice(),
            wrong_id.as_slice(),
        ] {
            assert!(matches!(
                store.install(bytes).await,
                Err(ThemeStoreError::InvalidPackage { .. })
            ));
        }
        assert!(store.list().await.unwrap().is_empty());
        assert!(!dir.file().exists());
    }

    #[tokio::test]
    async fn entry_limit_counts_installed_packages() {
        let dir = TempDir::new();
        let store = ThemeStore::new(dir.file());
        for index in 0..MAX_INSTALLED_THEMES {
            store
                .install(&package(&format!("maze-{index}"), "1.0.0"))
                .await
                .unwrap();
        }
        let before = std::fs::read(dir.file()).unwrap();
        assert!(matches!(
            store.install(&package("one-too-many", "1.0.0")).await,
            Err(ThemeStoreError::LimitReached { .. })
        ));
        assert_eq!(std::fs::read(dir.file()).unwrap(), before);
        assert_eq!(store.list().await.unwrap().len(), MAX_INSTALLED_THEMES);
    }

    #[tokio::test]
    async fn whole_catalog_byte_limit_rejects_without_corrupting() {
        let dir = TempDir::new();
        let store = ThemeStore::new(dir.file());
        let mut installed = 0;
        let error = loop {
            let mut bytes = package(&format!("maze-{installed}"), "1.0.0");
            bytes.resize(MAX_THEME_PACKAGE_BYTES, b' ');
            match store.install(&bytes).await {
                Ok(_) => installed += 1,
                Err(error) => break error,
            }
        };
        assert!(matches!(error, ThemeStoreError::LimitReached { .. }));
        // JSON overhead means 16 maximal sources cannot all fit under the catalog budget.
        assert_eq!(installed, MAX_INSTALLED_THEMES - 1);
        assert_eq!(store.list().await.unwrap().len(), installed);
        assert!(std::fs::metadata(dir.file()).unwrap().len() <= MAX_THEME_CATALOG_BYTES);
    }

    #[tokio::test]
    async fn oversized_catalog_is_rejected_and_preserved() {
        let dir = TempDir::new();
        let bytes = vec![b' '; MAX_THEME_CATALOG_BYTES as usize + 1];
        std::fs::write(dir.file(), &bytes).unwrap();
        let store = ThemeStore::new(dir.file());
        assert!(matches!(
            store.list().await,
            Err(ThemeStoreError::InvalidCatalog { .. })
        ));
        assert!(matches!(
            store.install(FIXTURE).await,
            Err(ThemeStoreError::InvalidCatalog { .. })
        ));
        assert_eq!(std::fs::read(dir.file()).unwrap(), bytes);
    }

    #[tokio::test]
    async fn malformed_catalog_is_preserved_and_never_treated_as_empty() {
        let dir = TempDir::new();
        let bytes = b"{ this is not a catalog".to_vec();
        std::fs::write(dir.file(), &bytes).unwrap();
        let store = ThemeStore::new(dir.file());
        assert!(matches!(
            store.list().await,
            Err(ThemeStoreError::InvalidCatalog { .. })
        ));
        assert!(matches!(
            store.install(FIXTURE).await,
            Err(ThemeStoreError::InvalidCatalog { .. })
        ));
        assert_eq!(std::fs::read(dir.file()).unwrap(), bytes);
    }

    #[tokio::test]
    async fn invalid_catalog_entries_unknown_fields_and_schema_fail_visibly() {
        for bytes in [catalog_with(&["{}"])] {
            let dir = TempDir::new();
            std::fs::write(dir.file(), &bytes).unwrap();
            assert!(matches!(
                ThemeStore::new(dir.file()).list().await,
                Err(ThemeStoreError::InvalidCatalog { .. })
            ));
            assert_eq!(std::fs::read(dir.file()).unwrap(), bytes);
        }

        for bytes in [
            serde_json::to_vec(&json!({ "schema": 2, "themes": [] })).unwrap(),
            serde_json::to_vec(&json!({ "schema": 1, "themes": [], "extra": true })).unwrap(),
            serde_json::to_vec(&json!({ "schema": 1, "themes": [{ "source": std::str::from_utf8(FIXTURE).unwrap(), "digest": "a".repeat(64) }] })).unwrap(),
            catalog_with(&["not json"]),
        ] {
            let dir = TempDir::new();
            std::fs::write(dir.file(), &bytes).unwrap();
            assert!(matches!(
                ThemeStore::new(dir.file()).list().await,
                Err(ThemeStoreError::InvalidCatalog { .. })
            ));
            assert_eq!(std::fs::read(dir.file()).unwrap(), bytes);
        }

        let duplicate = catalog_with(&[
            std::str::from_utf8(FIXTURE).unwrap(),
            std::str::from_utf8(FIXTURE).unwrap(),
        ]);
        let dir = TempDir::new();
        std::fs::write(dir.file(), &duplicate).unwrap();
        assert!(matches!(
            ThemeStore::new(dir.file()).list().await,
            Err(ThemeStoreError::InvalidCatalog { .. })
        ));
        assert_eq!(std::fs::read(dir.file()).unwrap(), duplicate);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinked_catalog_is_rejected_without_following_or_rewriting_it() {
        use std::os::unix::fs::symlink;
        let dir = TempDir::new();
        let target = dir.0.join("target.json");
        std::fs::write(&target, b"{}").unwrap();
        symlink(&target, dir.file()).unwrap();
        let store = ThemeStore::new(dir.file());
        assert!(matches!(
            store.list().await,
            Err(ThemeStoreError::InvalidCatalog { .. })
        ));
        assert!(store.install(FIXTURE).await.is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"{}");
        assert!(std::fs::symlink_metadata(dir.file()).unwrap().file_type().is_symlink());
    }

    #[tokio::test]
    async fn directory_at_the_catalog_path_is_rejected() {
        let dir = TempDir::new();
        std::fs::create_dir(dir.file()).unwrap();
        let store = ThemeStore::new(dir.file());
        assert!(matches!(
            store.list().await,
            Err(ThemeStoreError::InvalidCatalog { .. })
        ));
        assert!(store.install(FIXTURE).await.is_err());
        assert!(dir.file().is_dir());
    }

    #[tokio::test]
    async fn removal_is_refused_while_a_trusted_reference_is_in_use() {
        let dir = TempDir::new();
        let store = ThemeStore::new(dir.file());
        let installed = store.install(FIXTURE).await.unwrap();
        let before = std::fs::read(dir.file()).unwrap();
        assert!(matches!(
            store.remove(&installed.reference, std::slice::from_ref(&installed.reference)).await,
            Err(ThemeStoreError::InUse { .. })
        ));
        assert_eq!(std::fs::read(dir.file()).unwrap(), before);
        assert_eq!(store.list().await.unwrap().len(), 1);

        let mut stale = installed.reference.clone();
        stale.digest = "0".repeat(64);
        assert!(matches!(
            store.remove(&stale, &[]).await,
            Err(ThemeStoreError::Conflict { .. })
        ));
        assert_eq!(store.list().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn successful_removal_persists_across_restart() {
        let dir = TempDir::new();
        let store = ThemeStore::new(dir.file());
        let installed = store.install(FIXTURE).await.unwrap();
        store.remove(&installed.reference, &[]).await.unwrap();
        assert!(store.list().await.unwrap().is_empty());
        assert!(ThemeStore::new(dir.file()).list().await.unwrap().is_empty());
        assert!(matches!(
            store.remove(&installed.reference, &[]).await,
            Err(ThemeStoreError::NotFound { .. })
        ));
    }

    #[tokio::test]
    async fn failed_write_leaves_the_previous_catalog_untouched() {
        let dir = TempDir::new();
        let store = ThemeStore::new(dir.file());
        store.install(&package("maze", "1.0.0")).await.unwrap();
        let before = std::fs::read(dir.file()).unwrap();
        store.fail_next_write();
        assert!(matches!(
            store.install(&package("maze", "1.0.1")).await,
            Err(ThemeStoreError::Io { .. })
        ));
        assert_eq!(std::fs::read(dir.file()).unwrap(), before);
        assert_eq!(store.list().await.unwrap().len(), 1);

        store.install(&package("maze", "1.0.1")).await.unwrap();
        assert_eq!(store.list().await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn missing_catalog_lists_empty_without_creating_a_file() {
        let dir = TempDir::new();
        let store = ThemeStore::new(dir.file());
        assert!(store.list().await.unwrap().is_empty());
        assert!(!dir.file().exists());
    }
}
