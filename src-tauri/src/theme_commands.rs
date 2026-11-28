//! Native IPC for external theme packages. The host owns the catalog path; the
//! renderer never supplies a path or URL and package text is never executed.

use std::io::Read;
use std::path::Path;
use std::sync::Arc;

use tauri_plugin_dialog::DialogExt;
use zdeck_schema::theme_package::{
    parse_theme_package, CustomThemeReference, MAX_THEME_PACKAGE_BYTES,
};

use crate::deck::{DeckSnapshot, TrashEntry};
use crate::theme_store::{InstalledTheme, ThemeStore, ThemeStoreError};

fn require_local(window: &tauri::WebviewWindow) -> Result<(), ThemeStoreError> {
    let url = window
        .url()
        .map_err(|_| ThemeStoreError::forbidden("The local desktop editor is unavailable."))?;
    if crate::plugin_registry::local_editor(window.label(), &url) {
        Ok(())
    } else {
        Err(ThemeStoreError::forbidden(
            "Theme installation is only available in the local desktop editor.",
        ))
    }
}

fn themes(state: &crate::AppState) -> Result<&Arc<ThemeStore>, ThemeStoreError> {
    state
        .themes
        .as_ref()
        .ok_or_else(|| ThemeStoreError::unavailable("The theme catalog is unavailable on this desktop."))
}

/// Read one bounded regular file. Symlinks are refused before any bytes are read.
fn read_package(path: &Path) -> Result<String, ThemeStoreError> {
    let meta = std::fs::symlink_metadata(path).map_err(|error| {
        ThemeStoreError::io(format!("Could not inspect the theme file ({:?}).", error.kind()))
    })?;
    if meta.file_type().is_symlink() {
        return Err(ThemeStoreError::invalid_package(
            "Choose a regular local theme file, not a symbolic link.",
        ));
    }
    if !meta.is_file() {
        return Err(ThemeStoreError::invalid_package(
            "Choose a regular local theme file.",
        ));
    }
    if meta.len() > MAX_THEME_PACKAGE_BYTES as u64 {
        return Err(ThemeStoreError::invalid_package(format!(
            "The theme file is larger than {MAX_THEME_PACKAGE_BYTES} bytes."
        )));
    }
    let file = std::fs::File::open(path).map_err(|error| {
        ThemeStoreError::io(format!("Could not open the theme file ({:?}).", error.kind()))
    })?;
    let mut bytes = Vec::new();
    file.take(MAX_THEME_PACKAGE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            ThemeStoreError::io(format!("Could not read the theme file ({:?}).", error.kind()))
        })?;
    if bytes.len() > MAX_THEME_PACKAGE_BYTES {
        return Err(ThemeStoreError::invalid_package(format!(
            "The theme file is larger than {MAX_THEME_PACKAGE_BYTES} bytes."
        )));
    }
    parse_theme_package(&bytes).ok_or_else(|| {
        ThemeStoreError::invalid_package(
            "This file is not a valid theme package. Use a bounded schema 1 zdeck-theme JSON file.",
        )
    })?;
    // parse_theme_package already required valid UTF-8; keep the exact original text.
    Ok(std::str::from_utf8(&bytes)
        .map_err(|_| ThemeStoreError::invalid_package("The theme package must be UTF-8 text."))?
        .to_owned())
}

fn push_reference(references: &mut Vec<CustomThemeReference>, reference: &Option<CustomThemeReference>) {
    if let Some(reference) = reference {
        references.push(reference.clone());
    }
}

/// Every custom theme reference in the authoritative saved document, including Trash.
/// The renderer never supplies this in-use list.
pub(crate) fn referenced_themes(snapshot: &DeckSnapshot) -> Vec<CustomThemeReference> {
    let mut references = Vec::new();
    push_reference(&mut references, &snapshot.deck.custom_theme);
    for page in &snapshot.deck.pages {
        for section in &page.sections {
            push_reference(&mut references, &section.custom_theme);
        }
    }
    for entry in &snapshot.trash {
        if let TrashEntry::Section { section, .. } = entry {
            push_reference(&mut references, &section.custom_theme);
        }
    }
    references
}

#[tauri::command]
pub async fn theme_list(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<InstalledTheme>, ThemeStoreError> {
    require_local(&window)?;
    themes(&state)?.list().await
}

/// Native picker; returns the exact validated source text, or `None` when cancelled.
#[tauri::command]
pub async fn theme_pick(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Option<String>, ThemeStoreError> {
    require_local(&window)?;
    let (send, receive) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .set_title("Choose a local zDeck theme package")
        .add_filter("zDeck theme package", &["json"])
        .pick_file(move |selected| {
            let result = match selected.map(|path| path.into_path()).transpose() {
                Ok(Some(path)) => read_package(&path).map(Some),
                Ok(None) => Ok(None),
                Err(_) => Err(ThemeStoreError::invalid_package(
                    "Choose a local filesystem theme file, not a virtual URL.",
                )),
            };
            let _ = send.send(result);
        });
    receive
        .await
        .map_err(|_| ThemeStoreError::unavailable("The native theme picker did not complete."))?
}

/// Validates the exact source again before an explicit install. No code is executed.
#[tauri::command]
pub async fn theme_install(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
    source: String,
) -> Result<InstalledTheme, ThemeStoreError> {
    require_local(&window)?;
    themes(&state)?.install(source.as_bytes()).await
}

#[tauri::command]
pub async fn theme_remove(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
    reference: CustomThemeReference,
) -> Result<(), ThemeStoreError> {
    require_local(&window)?;
    let store = themes(&state)?;
    let snapshot = state
        .store()
        .map_err(|_| ThemeStoreError::unavailable("The saved deck is unavailable, so the theme was not removed."))?
        .load()
        .await
        .map_err(|_| ThemeStoreError::unavailable("The saved deck could not be read, so the theme was not removed."))?;
    store.remove(&reference, &referenced_themes(&snapshot)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use zdeck_schema::deck::{default_deck, DeckSnapshot};

    const FIXTURE: &[u8] = include_bytes!("../../tests/fixtures/theme-packages/midnight-maze.json");

    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "theme-commands-test-{}-{}",
                std::process::id(),
                TEMP_COUNTER.fetch_add(1, Ordering::SeqCst)
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn reference(id: &str, version: &str) -> CustomThemeReference {
        CustomThemeReference { id: id.into(), version: version.into(), digest: "a".repeat(64) }
    }

    #[test]
    fn picker_reads_exact_source_and_rejects_symlinks_oversized_and_invalid_files() {
        let dir = TempDir::new();
        let path = dir.0.join("theme.json");
        std::fs::write(&path, FIXTURE).unwrap();
        assert_eq!(read_package(&path).unwrap().as_bytes(), FIXTURE);

        let oversized = dir.0.join("oversized.json");
        std::fs::write(&oversized, vec![b' '; MAX_THEME_PACKAGE_BYTES + 1]).unwrap();
        assert!(matches!(
            read_package(&oversized),
            Err(ThemeStoreError::InvalidPackage { .. })
        ));

        let invalid = dir.0.join("invalid.json");
        std::fs::write(&invalid, b"{}").unwrap();
        assert!(matches!(
            read_package(&invalid),
            Err(ThemeStoreError::InvalidPackage { .. })
        ));

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let link = dir.0.join("link.json");
            symlink(&path, &link).unwrap();
            assert!(matches!(
                read_package(&link),
                Err(ThemeStoreError::InvalidPackage { .. })
            ));
        }
    }

    #[test]
    fn removal_input_comes_from_deck_sections_and_trash_only() {
        let mut deck = default_deck();
        deck.custom_theme = Some(reference("deck-level", "1.0.0"));
        deck.pages[0].sections[0].custom_theme = Some(reference("section-level", "1.0.0"));
        let mut trashed = deck.pages[0].sections[0].clone();
        trashed.custom_theme = Some(reference("trash-level", "1.0.0"));
        let snapshot = DeckSnapshot {
            revision: 1,
            deck,
            trash: vec![TrashEntry::Section {
                id: trashed.id.clone(),
                deleted_at: 1,
                section: trashed,
                location: zdeck_schema::deck::TrashLocation {
                    page_id: "page_stream".into(),
                    page_name: "Stream".into(),
                    section_id: None,
                    section_name: None,
                    index: 0,
                },
            }],
            exists: true,
        };
        let references = referenced_themes(&snapshot);
        let ids: Vec<_> = references.iter().map(|reference| reference.id.as_str()).collect();
        assert_eq!(ids, ["deck-level", "section-level", "trash-level"]);
    }
}
