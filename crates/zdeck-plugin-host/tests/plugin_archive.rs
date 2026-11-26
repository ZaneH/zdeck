//! Cross-platform isolated local archive tests. Never reads the user's config or runs a plugin.
use std::{fs, io::{Cursor, Write}, path::{Path, PathBuf}};
use serde_json::json;
use tempfile::TempDir;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};
use zdeck_plugin_host::{plugin::PluginRegistry, plugin_install::{NodeStatus, PluginInstall}};

fn manifest() -> Vec<u8> { serde_json::to_vec(&json!({"id":"fixture", "version":"1.2.3", "protocolVersion":1,
    "actions":[{"id":"test","title":"Test","config":{}}]})).unwrap() }
fn entries() -> Vec<(String, Vec<u8>)> { vec![("manifest.json".into(), manifest()), ("main.js".into(), b"throw new Error('NEVER RUN THIS');".to_vec())] }
fn zip_entries(entries: &[(String, Vec<u8>)], method: CompressionMethod) -> Vec<u8> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        zip.start_file(name, SimpleFileOptions::default().compression_method(method)).unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}
fn write_zip(root: &Path, bytes: &[u8]) -> PathBuf { let path = root.join("package.zdx"); fs::write(&path, bytes).unwrap(); path }
fn install(root: &Path) -> PluginInstall { PluginInstall::new(root.join("config/plugins"), vec![]).unwrap() }
async fn refused(bytes: &[u8]) {
    let temp = TempDir::new().unwrap(); let installer = install(temp.path());
    assert!(installer.inspect_archive(write_zip(temp.path(), bytes)).await.is_err());
    assert!(!temp.path().join("config/plugins").exists());
}
fn central(bytes: &[u8]) -> usize { bytes.windows(4).position(|w| w == b"PK\x01\x02").unwrap() }

#[tokio::test]
async fn round_trip_installs_disabled_and_untrusted_then_refuses_collision_and_preserves_files() {
    let temp = TempDir::new().unwrap(); let installer = install(temp.path()); let registry = PluginRegistry::default();
    let path = write_zip(temp.path(), &zip_entries(&entries(), CompressionMethod::Stored));
    let prepared = installer.inspect_archive(path.clone()).await.unwrap();
    let review = prepared.review().clone();
    assert_eq!(review.id, "fixture"); assert_eq!(review.version, "1.2.3");
    assert_eq!(review.runtime_status, NodeStatus::NotFound); assert!(!review.collision);
    assert_eq!(review.files, 2); assert_eq!(review.identity.len(), 64);
    // Review is a snapshot. Mutating the original archive must not change installed bytes.
    fs::write(&path, b"not zip anymore").unwrap();
    installer.install_archive(&registry, prepared, &review.review_id).await.unwrap();
    let catalog = installer.catalog().await.unwrap();
    assert_eq!(catalog.plugins.len(), 1); assert!(!catalog.plugins[0].trusted);
    assert_eq!(catalog.plugins[0].identity.as_ref(), Some(&review.identity));
    assert!(registry.snapshots().await.values().all(|s| s.status != zdeck_plugin_host::plugin::ConnectionStatus::Connected));
    let preferences = fs::read_to_string(temp.path().join("config/plugin-trust.v1.json")).unwrap();
    assert_eq!(serde_json::from_str::<serde_json::Value>(&preferences).unwrap()["enabled"], json!({}));
    let before = fs::read(temp.path().join("config/plugins/fixture/main.js")).unwrap();
    let next = installer.inspect_archive(write_zip(temp.path(), &zip_entries(&entries(), CompressionMethod::Stored))).await.unwrap();
    assert!(next.review().collision); let id = next.review().review_id.clone();
    assert!(installer.install_archive(&registry, next, &id).await.unwrap_err().hint.contains("already installed"));
    assert_eq!(fs::read(temp.path().join("config/plugins/fixture/main.js")).unwrap(), before);
    // Restart/discovery never restores installed archive intent.
    let restarted = install(temp.path()); let registry = PluginRegistry::default();
    restarted.restore(&registry).await.unwrap(); assert!(registry.snapshots().await.is_empty());
    assert!(!restarted.catalog().await.unwrap().plugins[0].trusted);
}

#[tokio::test]
async fn accepts_bounded_deflate_and_explicit_directories() {
    let temp = TempDir::new().unwrap(); let installer = install(temp.path());
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    zip.add_directory("assets/", options).unwrap();
    let mut files = entries(); files.push(("assets/readme.txt".into(), b"A small prebuilt fixture, never evaluated.".to_vec()));
    for (name, bytes) in files { zip.start_file(name, options).unwrap(); zip.write_all(&bytes).unwrap(); }
    let path = write_zip(temp.path(), &zip.finish().unwrap().into_inner());
    let prepared = installer.inspect_archive(path).await.unwrap(); let id = prepared.review().review_id.clone();
    assert_eq!(prepared.review().files, 3);
    installer.install_archive(&PluginRegistry::default(), prepared, &id).await.unwrap();
    assert_eq!(fs::read(temp.path().join("config/plugins/fixture/assets/readme.txt")).unwrap(), b"A small prebuilt fixture, never evaluated.");
}

#[tokio::test]
async fn cancel_and_stale_authorization_leave_no_installed_files() {
    let temp = TempDir::new().unwrap(); let installer = install(temp.path());
    let path = write_zip(temp.path(), &zip_entries(&entries(), CompressionMethod::Stored));
    let prepared = installer.inspect_archive(path.clone()).await.unwrap();
    drop(prepared); assert!(!temp.path().join("config").exists());
    let prepared = installer.inspect_archive(path).await.unwrap();
    assert!(installer.install_archive(&PluginRegistry::default(), prepared, "not-the-reviewed-token").await.is_err());
    assert!(!temp.path().join("config").exists());
}

#[tokio::test]
async fn refuses_traversal_and_cross_platform_ambiguous_names() {
    for name in ["../outside", "/absolute", "C:/drive", "C:drive", "//unc/share", "a\\escape", "a/../escape", "a//b", "a/./b", "CON", "nul.txt", "COM1.log", "lpt9", "name.", "name ", "a:b", "café", "a\0b", "a\nb", "a/<bad>"] {
        let mut files = entries(); files.push((name.into(), vec![1]));
        refused(&zip_entries(&files, CompressionMethod::Stored)).await;
    }
    for pair in [["Case/file", "case/other"], ["main.js", "MAIN.JS"], ["folder", "folder/file"], ["a/file", "a/File"]] {
        let mut files = entries(); for name in pair { files.push((name.into(), vec![1])); }
        // Duplicate main.js itself is prevented by the writer, so construct from scratch.
        if pair[0] == "main.js" { files.remove(1); }
        refused(&zip_entries(&files, CompressionMethod::Stored)).await;
    }
    for name in ["a".repeat(65), "a/".repeat(17) + "file", "abcd/".repeat(41) + "file"] {
        let mut files = entries(); files.push((name, vec![1])); refused(&zip_entries(&files, CompressionMethod::Stored)).await;
    }
}

#[tokio::test]
async fn rejects_symlinks_special_types_hardlink_extras_and_duplicate_headers() {
    for mode in [0o120777u32, 0o010644, 0o020644, 0o060644, 0o140644] {
        let mut bytes = zip_entries(&entries(), CompressionMethod::Stored); let c = central(&bytes);
        bytes[c + 5] = 3; bytes[c + 38..c + 42].copy_from_slice(&(mode << 16).to_le_bytes());
        refused(&bytes).await;
    }
    // All local/central extra fields (including Unix hardlink/alternate-path extensions) refused.
    let mut bytes = zip_entries(&entries(), CompressionMethod::Stored); let c = central(&bytes);
    bytes[c + 30..c + 32].copy_from_slice(&4u16.to_le_bytes()); refused(&bytes).await;
    let mut bytes = zip_entries(&entries(), CompressionMethod::Stored); bytes[28..30].copy_from_slice(&4u16.to_le_bytes()); refused(&bytes).await;
    // Equal-length names allow byte-patching duplicates without changing ZIP offsets.
    let files = vec![("same1".into(), vec![1]), ("same2".into(), vec![2])];
    let mut bytes = zip_entries(&files, CompressionMethod::Stored);
    let positions: Vec<_> = bytes.windows(5).enumerate().filter(|(_, b)| *b == b"same2").map(|(i, _)| i).collect();
    for p in positions { bytes[p..p + 5].copy_from_slice(b"same1"); }
    refused(&bytes).await;
}

#[tokio::test]
async fn rejects_bombs_oversize_encryption_corruption_and_header_cloaking() {
    let mut files = entries(); files.push(("bomb".into(), vec![0; 1024 * 1024]));
    refused(&zip_entries(&files, CompressionMethod::Deflated)).await;
    let mut files = entries(); files.push(("too-big".into(), vec![42; 8 * 1024 * 1024 + 1]));
    refused(&zip_entries(&files, CompressionMethod::Stored)).await;
    let temp = TempDir::new().unwrap(); let installer = install(temp.path());
    let path = temp.path().join("oversize.zdx"); fs::File::create(&path).unwrap().set_len(16 * 1024 * 1024 + 1).unwrap();
    assert!(installer.inspect_archive(path).await.is_err());
    let original = zip_entries(&entries(), CompressionMethod::Stored);
    let mut encrypted = original.clone(); let c = central(&encrypted); encrypted[6] |= 1; encrypted[c + 8] |= 1; refused(&encrypted).await;
    let mut crc = original.clone(); crc[30 + "manifest.json".len()] ^= 1; refused(&crc).await;
    let mut cloak = original.clone(); cloak[30] = b'x'; refused(&cloak).await;
    let mut short = original.clone(); short.truncate(short.len() - 8); refused(&short).await;
    let mut compression = original.clone(); let c = central(&compression);
    compression[8..10].copy_from_slice(&99u16.to_le_bytes()); compression[c + 10..c + 12].copy_from_slice(&99u16.to_le_bytes()); refused(&compression).await;
    let mut count = original.clone(); let e = count.len() - 22; count[e + 8..e + 12].copy_from_slice(&[255; 4]); refused(&count).await;
}

#[tokio::test]
async fn rejects_entry_count_and_allocation_abuse_before_extraction() {
    let files: Vec<_> = (0..4097).map(|i| (format!("file-{i}"), vec![])).collect();
    refused(&zip_entries(&files, CompressionMethod::Stored)).await;
    let original = zip_entries(&entries(), CompressionMethod::Stored);
    let mut size = original.clone(); let c = central(&size);
    size[22..26].copy_from_slice(&u32::MAX.to_le_bytes());
    size[c + 24..c + 28].copy_from_slice(&u32::MAX.to_le_bytes()); refused(&size).await;
    let mut eocd = original.clone(); let end = eocd.len() - 22;
    eocd[end + 16..end + 20].copy_from_slice(&u32::MAX.to_le_bytes()); refused(&eocd).await;
    let mut overlap = original.clone();
    let second = central(&overlap) + 46 + "manifest.json".len();
    overlap[second + 42..second + 46].copy_from_slice(&0u32.to_le_bytes()); refused(&overlap).await;
}

#[tokio::test]
async fn strict_root_layout_manifest_and_fixed_entrypoint() {
    for files in [
        entries().into_iter().map(|(n, b)| (format!("nested/{n}"), b)).collect::<Vec<_>>(),
        vec![("manifest.json".into(), manifest())],
        vec![("manifest.json".into(), manifest()), ("other.js".into(), vec![1])],
        vec![("manifest.json".into(), manifest()), ("main.js".into(), vec![1]), ("main.py".into(), vec![1])],
        vec![("manifest.json".into(), b"{}".to_vec()), ("main.js".into(), vec![1])],
        vec![("MANIFEST.JSON".into(), manifest()), ("main.js".into(), vec![1])],
        vec![("manifest.json".into(), manifest()), ("MAIN.JS".into(), vec![1])],
        vec![("manifest.json".into(), manifest()), ("main.js".into(), vec![1]), ("PACKAGE.JSON".into(), b"{}".to_vec())],
        vec![("manifest.json".into(), manifest()), ("main.js".into(), vec![1]), ("NODE_MODULES/other/index.js".into(), vec![1])],
    ] { refused(&zip_entries(&files, CompressionMethod::Stored)).await; }
    for key in ["protocolVersion", "exec"] {
        let mut m: serde_json::Value = serde_json::from_slice(&manifest()).unwrap(); m[key] = json!(99);
        refused(&zip_entries(&[("manifest.json".into(), serde_json::to_vec(&m).unwrap()), ("main.js".into(), vec![1])], CompressionMethod::Stored)).await;
    }
}

#[tokio::test]
async fn collision_created_after_review_and_simultaneous_install_never_overwrite() {
    let temp = TempDir::new().unwrap(); let installer = install(temp.path()); let registry = PluginRegistry::default();
    let path = write_zip(temp.path(), &zip_entries(&entries(), CompressionMethod::Stored));
    let first = installer.inspect_archive(path.clone()).await.unwrap(); let a = first.review().review_id.clone();
    let second = installer.inspect_archive(path.clone()).await.unwrap(); let b = second.review().review_id.clone();
    let (one, two) = tokio::join!(installer.install_archive(&registry, first, &a), installer.install_archive(&registry, second, &b));
    assert_ne!(one.is_ok(), two.is_ok());
    installer.uninstall(&registry, "fixture").await.unwrap();
    let prepared = installer.inspect_archive(path).await.unwrap(); let id = prepared.review().review_id.clone();
    let existing = temp.path().join("config/plugins/FIXTURE"); fs::create_dir(&existing).unwrap();
    fs::write(existing.join("keep"), "user file").unwrap();
    assert!(installer.install_archive(&registry, prepared, &id).await.is_err());
    assert_eq!(fs::read_to_string(existing.join("keep")).unwrap(), "user file");
}

#[tokio::test]
async fn reinstall_identical_bytes_clears_stale_trust_and_enabled_intent() {
    let temp = TempDir::new().unwrap(); let installer = install(temp.path()); let registry = PluginRegistry::default();
    let path = write_zip(temp.path(), &zip_entries(&entries(), CompressionMethod::Stored));
    let prepared = installer.inspect_archive(path.clone()).await.unwrap(); let r = prepared.review().clone();
    installer.install_archive(&registry, prepared, &r.review_id).await.unwrap();
    installer.trust("fixture", &r.identity).await.unwrap();
    // Simulate stale records left by manual external removal, without ever enabling a process.
    let prefs = temp.path().join("config/plugin-trust.v1.json");
    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&prefs).unwrap()).unwrap();
    value["enabled"] = json!({"fixture": r.identity}); fs::write(&prefs, serde_json::to_vec(&value).unwrap()).unwrap();
    fs::remove_dir_all(temp.path().join("config/plugins/fixture")).unwrap();
    let prepared = installer.inspect_archive(path).await.unwrap(); let token = prepared.review().review_id.clone();
    installer.install_archive(&registry, prepared, &token).await.unwrap();
    let value: serde_json::Value = serde_json::from_slice(&fs::read(&prefs).unwrap()).unwrap();
    assert_eq!(value["enabled"], json!({})); assert!(!installer.catalog().await.unwrap().plugins[0].trusted);
    let registry = PluginRegistry::default(); install(temp.path()).restore(&registry).await.unwrap(); assert!(registry.snapshots().await.is_empty());
}

#[tokio::test]
#[ignore = "Set ZDECK_ZDX_ARTIFACT to verify a generated archive in a fresh isolated root"]
async fn generated_artifact_installs_in_isolation_without_execution() {
    let artifact = std::env::var_os("ZDECK_ZDX_ARTIFACT").expect("artifact path");
    let temp = TempDir::new().unwrap(); let installer = install(temp.path());
    let prepared = installer.inspect_archive(PathBuf::from(artifact)).await.unwrap(); let review = prepared.review().clone();
    installer.install_archive(&PluginRegistry::default(), prepared, &review.review_id).await.unwrap();
    let catalog = installer.catalog().await.unwrap(); assert_eq!(catalog.plugins.len(), 1);
    assert!(!catalog.plugins[0].trusted); assert_eq!(catalog.plugins[0].identity.as_ref(), Some(&review.identity));
    println!("isolated artifact: {} {} · {} files · {} bytes", review.id, review.version, review.files, review.bytes);
}
