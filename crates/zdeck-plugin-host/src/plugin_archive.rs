//! Local ZIP inspection only: no package code, hooks, dependency managers or describe calls.
use super::*;
use std::io::Cursor;
use tempfile::TempDir;
use zip::{read::{ArchiveOffset, Config}, CompressionMethod, ZipArchive};

const ARCHIVE_BYTES: u64 = 16 * 1024 * 1024;
const FILE_BYTES: u64 = 8 * 1024 * 1024;
const ENTRIES: usize = 4096;
const PATH_BYTES: usize = 200;
const DEPTH: usize = 16;
const RATIO: u64 = 200;
const INVALID: &str = "This is not a supported .zdx ZIP. Use the documented root layout with a complete prebuilt plugin, ordinary files, and no ZIP extras or links.";
const COLLISION: &str = "This plugin ID is already installed. Disable and explicitly uninstall the existing package first, then select this archive again. Saved controls and credentials are preserved.";
const IO_ERROR: &str = "The local archive or staging directory could not be read or written. Check local permissions and select the archive again.";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveReview {
    pub review_id: String,
    pub id: String,
    pub version: String,
    pub protocol_version: u8,
    pub runtime: PluginRuntime,
    pub identity: String,
    pub archive_sha256: String,
    pub files: usize,
    pub bytes: u64,
    pub collision: bool,
    pub runtime_status: NodeStatus,
    pub runtime_version: Option<String>,
}

/// Owns only private temporary files. The selected user archive is never modified or reopened.
pub struct PreparedArchive { temporary: TempDir, review: ArchiveReview }
impl PreparedArchive {
    pub fn review(&self) -> &ArchiveReview { &self.review }
}

fn invalid() -> PluginError { failure(INVALID) }
fn io_error() -> PluginError { failure(IO_ERROR) }
fn hex(bytes: impl AsRef<[u8]>) -> String { bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect() }

/// A deliberately portable ASCII subset avoids Unicode normalization, Windows device names,
/// ADS, case aliases and trailing-dot/space ambiguities on all three supported filesystems.
fn portable_path(name: &str, directory: bool) -> Result<&str, PluginError> {
    let path = if directory { name.strip_suffix('/').ok_or_else(invalid)? } else { name };
    if path.is_empty() || path.len() > PATH_BYTES || path.split('/').count() > DEPTH { return Err(invalid()); }
    for part in path.split('/') {
        if part.is_empty() || part.len() > 64 || part == "." || part == ".." || part.ends_with('.')
            || !part.bytes().all(|b| b.is_ascii_alphanumeric() || b"._@+-".contains(&b)) { return Err(invalid()); }
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
            || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && b"123456789".contains(&stem.as_bytes()[3])) { return Err(invalid()); }
    }
    Ok(path)
}

fn u16_at(bytes: &[u8], offset: u64) -> Result<u16, PluginError> {
    let offset = usize::try_from(offset).map_err(|_| invalid())?;
    let slice = bytes.get(offset..offset.checked_add(2).ok_or_else(invalid)?).ok_or_else(invalid)?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

// This slice supports only ordinary, comment-free ZIP32. Bound and walk the central directory
// before the library allocates its index; do not trust a forged EOCD count or a ZIP64 extension.
fn bounded_zip(bytes: &[u8]) -> Result<ZipArchive<Cursor<&[u8]>>, PluginError> {
    let end = bytes.len().checked_sub(22).ok_or_else(invalid)?;
    if bytes.get(end..end + 4) != Some(b"PK\x05\x06") || bytes[end + 4..end + 8] != [0; 4]
        || u16_at(bytes, (end + 20) as u64)? != 0 { return Err(invalid()); }
    let count = u16_at(bytes, (end + 10) as u64)? as usize;
    if count == 0 || count > ENTRIES || u16_at(bytes, (end + 8) as u64)? as usize != count { return Err(invalid()); }
    let size = u32::from_le_bytes(bytes[end + 12..end + 16].try_into().unwrap()) as usize;
    let start = u32::from_le_bytes(bytes[end + 16..end + 20].try_into().unwrap()) as usize;
    if start.checked_add(size) != Some(end) { return Err(invalid()); }
    let mut cursor = start;
    for _ in 0..count {
        if bytes.get(cursor..cursor.checked_add(46).ok_or_else(invalid)?).is_none()
            || bytes.get(cursor..cursor + 4) != Some(b"PK\x01\x02") { return Err(invalid()); }
        let name = u16_at(bytes, (cursor + 28) as u64)? as usize;
        let extra = u16_at(bytes, (cursor + 30) as u64)?;
        let comment = u16_at(bytes, (cursor + 32) as u64)?;
        if name > PATH_BYTES + 1 || extra != 0 || comment != 0 || u16_at(bytes, (cursor + 34) as u64)? != 0 { return Err(invalid()); }
        cursor = cursor.checked_add(46 + name).ok_or_else(invalid)?;
        if cursor > end { return Err(invalid()); }
    }
    if cursor != end { return Err(invalid()); }
    let archive = ZipArchive::with_config(Config { archive_offset: ArchiveOffset::Known(0) }, Cursor::new(bytes)).map_err(|_| invalid())?;
    if archive.len() != count { return Err(invalid()); }
    Ok(archive)
}

fn prepare(path: &Path) -> Result<PreparedArchive, PluginError> {
    if !path.is_absolute() || !path.extension().is_some_and(|s| s.eq_ignore_ascii_case("zdx")) { return Err(invalid()); }
    let meta = fs::symlink_metadata(path).map_err(|_| io_error())?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > ARCHIVE_BYTES { return Err(invalid()); }
    // Snapshot a bounded regular file before parsing; changes to the user's archive after review
    // cannot swap the package that Install publishes.
    let mut input = fs::File::open(path).map_err(|_| io_error())?;
    if !input.metadata().map_err(|_| io_error())?.is_file() { return Err(invalid()); }
    let mut bytes = Vec::new();
    (&mut input).take(ARCHIVE_BYTES + 1).read_to_end(&mut bytes).map_err(|_| io_error())?;
    if bytes.len() as u64 > ARCHIVE_BYTES { return Err(invalid()); }
    let digest = hex(Sha256::digest(&bytes));
    let mut zip = bounded_zip(&bytes)?;
    // This also rejects exact duplicate names, overlapping entries, hidden local headers and
    // disagreement between local headers and the central directory (ZIP cloaking).
    zip.validate_header_consistency().map_err(|_| invalid())?;
    let mut seen = HashSet::new();
    let mut paths: BTreeMap<String, (String, bool)> = BTreeMap::new();
    let mut total = 0u64;
    let mut files = 0usize;
    for index in 0..zip.len() {
        let entry = zip.by_index(index).map_err(|_| invalid())?;
        let name = std::str::from_utf8(entry.name_raw()).map_err(|_| invalid())?;
        if entry.name().map_err(|_| invalid())?.as_ref() != name { return Err(invalid()); }
        let directory = entry.is_dir();
        let path = portable_path(name, directory)?;
        if !seen.insert(path.to_ascii_lowercase()) { return Err(invalid()); }
        let mode = entry.unix_mode().unwrap_or(0) & 0o170000;
        if entry.encrypted() || ![CompressionMethod::Stored, CompressionMethod::Deflated].contains(&entry.compression())
            || (mode != 0 && mode != if directory { 0o040000 } else { 0o100000 })
            || entry.is_symlink() || entry.size() > FILE_BYTES
            || entry.size() > entry.compressed_size().saturating_mul(RATIO)
            || (directory && entry.size() != 0)
            // No extra fields means no hard-link extensions, alternate names, reparse data or
            // vendor-specific extraction behavior. We never restore archive permissions either.
            || u16_at(&bytes, entry.header_start().checked_add(28).ok_or_else(invalid)?)? != 0
            || u16_at(&bytes, entry.central_header_start().checked_add(30).ok_or_else(invalid)?)? != 0 { return Err(invalid()); }
        total = total.checked_add(entry.size()).ok_or_else(invalid)?;
        if total > MAX_FINGERPRINT_BYTES { return Err(invalid()); }
        if !directory { files += 1; }
        let parts: Vec<_> = path.split('/').collect();
        for index in 1..=parts.len() {
            let prefix = parts[..index].join("/");
            let is_dir = index < parts.len() || directory;
            let key = prefix.to_ascii_lowercase();
            if let Some((prior, prior_dir)) = paths.get(&key) {
                if prior != &prefix || *prior_dir != is_dir { return Err(invalid()); }
            } else { paths.insert(key, (prefix, is_dir)); }
        }
    }
    // Loader-reserved names must have their exact portable spelling even when the current
    // filesystem would resolve a differently-cased name. Never accept only on macOS/Windows.
    for name in ["manifest.json", "main.js", "main.py", "package.json", "node_modules", "node_modules/@zdeck", "node_modules/@zdeck/plugin-sdk",
        "node_modules/@zdeck/plugin-sdk/package.json", "node_modules/@zdeck/plugin-sdk/index.js",
        "zdeck_plugin_sdk", "zdeck_plugin_sdk/__init__.py", "zdeck_plugin_sdk/types.py"] {
        if paths.get(name).is_some_and(|(original, _)| original != name) { return Err(invalid()); }
    }
    let temporary = tempfile::Builder::new().prefix("zdeck-zdx-").tempdir().map_err(|_| io_error())?;
    let payload = temporary.path().join(".unpacked");
    fs::create_dir(&payload).map_err(|_| io_error())?;
    let mut actual = 0u64;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|_| invalid())?;
        let directory = entry.is_dir();
        let decoded = entry.name().map_err(|_| invalid())?;
        let relative = portable_path(&decoded, directory)?;
        let target = payload.join(relative);
        if directory { fs::create_dir_all(&target).map_err(|_| io_error())?; continue; }
        fs::create_dir_all(target.parent().ok_or_else(invalid)?).map_err(|_| io_error())?;
        let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&target).map_err(|_| io_error())?;
        let expected = entry.size();
        // Read through EOF/CRC, but never allow a lying size header to expand unboundedly.
        let written = std::io::copy(&mut (&mut entry).take(expected + 1), &mut output).map_err(|_| invalid())?;
        if written != expected { return Err(invalid()); }
        actual = actual.checked_add(written).ok_or_else(invalid)?;
        if actual > MAX_FINGERPRINT_BYTES { return Err(invalid()); }
    }
    let manifest_path = payload.join("manifest.json");
    let size = fs::metadata(&manifest_path).map_err(|_| invalid())?.len();
    if size > MANIFEST_BYTES { return Err(invalid()); }
    let value = serde_json::from_slice(&fs::read(manifest_path).map_err(|_| invalid())?).map_err(|_| invalid())?;
    let manifest = manifest(value).map_err(|_| invalid())?;
    let folder = temporary.path().join(&manifest.id);
    fs::rename(&payload, &folder).map_err(|_| io_error())?;
    let root = fs::canonicalize(temporary.path()).map_err(|_| io_error())?;
    let (row, ready) = inspect_folder(&root, &folder, &manifest.id);
    let ready = ready.ok_or_else(|| failure(row.message.unwrap_or(INVALID)))?;
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).map_err(|_| io_error())?;
    let review = ArchiveReview { review_id: hex(nonce), id: manifest.id, version: manifest.version,
        protocol_version: manifest.protocol_version, runtime: ready.runtime, identity: ready.fingerprint,
        archive_sha256: digest, files, bytes: actual, collision: false,
        runtime_status: NodeStatus::NotFound, runtime_version: None };
    Ok(PreparedArchive { temporary, review })
}

impl PluginInstall {
    /// Path comes exclusively from native picker/drop APIs (or isolated tests), never renderer IPC.
    pub async fn inspect_archive(&self, path: PathBuf) -> Result<PreparedArchive, PluginError> {
        let mut prepared = tokio::task::spawn_blocking(move || prepare(&path)).await.map_err(|_| io_error())??;
        let runtime = match prepared.review.runtime {
            PluginRuntime::Node => detect_node(&self.candidates).await,
            PluginRuntime::Python => detect_python(&self.python_candidates).await,
        };
        prepared.review.runtime_status = runtime.status;
        prepared.review.runtime_version = runtime.version;
        prepared.review.collision = self.archive_collision(&prepared.review.id)?;
        Ok(prepared)
    }
    fn archive_collision(&self, id: &str) -> Result<bool, PluginError> {
        let Some(root) = self.root()? else { return Ok(false); };
        // IDs are lowercase, but reject case aliases even on a case-sensitive machine.
        for entry in fs::read_dir(root).map_err(|_| io_error())? {
            if entry.map_err(|_| io_error())?.file_name().to_string_lossy().eq_ignore_ascii_case(id) { return Ok(true); }
        }
        Ok(false)
    }
    pub async fn install_archive(&self, registry: &PluginRegistry, prepared: PreparedArchive, review_id: &str) -> Result<(), PluginError> {
        if prepared.review.review_id != review_id { return Err(stale_identity_error()); }
        let _guard = PREFERENCES.lock().await;
        let install = self.clone();
        let id = prepared.review.id.clone();
        registry.manage(&id, true, false, move |state| async move {
            if state.snapshot().await.status == crate::plugin::ConnectionStatus::Connected { return Err(failure(COLLISION)); }
            tokio::task::spawn_blocking(move || install.publish_archive(prepared)).await.map_err(|_| io_error())?
        }).await
    }
    fn publish_archive(&self, prepared: PreparedArchive) -> Result<(), PluginError> {
        let review = &prepared.review;
        if self.archive_collision(&review.id)? { return Err(failure(COLLISION)); }
        let root = fs::canonicalize(prepared.temporary.path()).map_err(|_| io_error())?;
        let folder = root.join(&review.id);
        let (_, ready) = inspect_folder(&root, &folder, &review.id);
        if !ready.is_some_and(|r| r.fingerprint == review.identity) { return Err(stale_identity_error()); }
        if self.root()?.is_none() { fs::create_dir_all(&self.directory).map_err(|_| io_error())?; }
        let destination_root = self.root()?.ok_or_else(io_error)?;
        // Same-filesystem staging allows an atomic, no-replace directory publication on every OS.
        let staging = tempfile::Builder::new().prefix(".zdeck-zdx-").tempdir_in(destination_root.parent().ok_or_else(io_error)?).map_err(|_| io_error())?;
        let staged = staging.path().join(&review.id);
        copy_tree(&folder, &staged)?;
        let staged_root = fs::canonicalize(staging.path()).map_err(|_| io_error())?;
        let (_, ready) = inspect_folder(&staged_root, &staged, &review.id);
        if !ready.is_some_and(|r| r.fingerprint == review.identity) { return Err(stale_identity_error()); }
        // A manually removed folder can leave saved intent. Installing even identical bytes must
        // remain OFF and untrusted after restart. Never touch deck controls or secure settings.
        let mut trust = self.load_trust(); let mut enabled = self.load_records("enabled");
        trust.remove(&review.id); enabled.remove(&review.id);
        self.write_preferences(&trust, &enabled)?;
        if self.archive_collision(&review.id)? { return Err(failure(COLLISION)); }
        rename_no_replace(&staged, &destination_root.join(&review.id)).map_err(|_| failure("The package could not be published without replacing existing files. Nothing was overwritten; refresh the catalog before trying again."))?;
        Ok(())
    }
}

fn copy_tree(source: &Path, target: &Path) -> Result<(), PluginError> {
    fs::create_dir(target).map_err(|_| io_error())?;
    for entry in fs::read_dir(source).map_err(|_| io_error())? {
        let entry = entry.map_err(|_| io_error())?;
        let meta = fs::symlink_metadata(entry.path()).map_err(|_| io_error())?;
        let output = target.join(entry.file_name());
        if meta.is_dir() && !meta.file_type().is_symlink() { copy_tree(&entry.path(), &output)?; }
        else if meta.is_file() && !meta.file_type().is_symlink() {
            let mut input = fs::File::open(entry.path()).map_err(|_| io_error())?;
            let mut file = fs::OpenOptions::new().write(true).create_new(true).open(output).map_err(|_| io_error())?;
            let count = std::io::copy(&mut (&mut input).take(FILE_BYTES + 1), &mut file).map_err(|_| io_error())?;
            if count > FILE_BYTES { return Err(invalid()); }
        } else { return Err(invalid()); }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn publication_refuses_even_an_empty_existing_directory() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source"); let target = temp.path().join("target");
        fs::create_dir(&source).unwrap(); fs::write(source.join("payload"), "package").unwrap();
        fs::create_dir(&target).unwrap();
        assert!(rename_no_replace(&source, &target).is_err());
        assert!(source.join("payload").exists()); assert!(!target.join("payload").exists());
        fs::remove_dir(&target).unwrap(); fs::write(&target, "user file").unwrap();
        assert!(rename_no_replace(&source, &target).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "user file");
        fs::remove_file(&target).unwrap(); rename_no_replace(&source, &target).unwrap();
        assert_eq!(fs::read_to_string(target.join("payload")).unwrap(), "package");
    }
    #[test]
    fn canceled_review_removes_only_owned_temporary_files() {
        let selected = tempfile::tempdir().unwrap();
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(br#"{"id":"fixture","version":"1.0.0","protocolVersion":1,"actions":[{"id":"test","title":"Test","config":{}}]}"#).unwrap();
        zip.start_file("main.js", options).unwrap(); zip.write_all(b"never run this").unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        let original = selected.path().join("user.zdx"); fs::write(&original, &bytes).unwrap();
        let prepared = prepare(&original).unwrap(); let path = prepared.temporary.path().to_path_buf();
        assert!(path.join("fixture/main.js").exists());
        drop(prepared); assert!(!path.exists()); assert_eq!(fs::read(original).unwrap(), bytes);
    }
}

fn rename_no_replace(source: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(unix)] {
        use std::os::unix::ffi::OsStrExt;
        let source = std::ffi::CString::new(source.as_os_str().as_bytes())?;
        let target = std::ffi::CString::new(target.as_os_str().as_bytes())?;
        #[cfg(target_os = "macos")]
        let result = unsafe { libc::renamex_np(source.as_ptr(), target.as_ptr(), libc::RENAME_EXCL) };
        #[cfg(target_os = "linux")]
        let result = unsafe { libc::renameat2(libc::AT_FDCWD, source.as_ptr(), libc::AT_FDCWD, target.as_ptr(), libc::RENAME_NOREPLACE) };
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        return Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "Atomic no-replace installation is unsupported on this OS."));
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        if result != 0 { return Err(std::io::Error::last_os_error()); }
        Ok(())
    }
    #[cfg(windows)] {
        use std::os::windows::ffi::OsStrExt;
        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        // Unlike std::fs::rename, explicitly omit MOVEFILE_REPLACE_EXISTING.
        if unsafe { windows_sys::Win32::Storage::FileSystem::MoveFileExW(source.as_ptr(), target.as_ptr(), 0) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
}
