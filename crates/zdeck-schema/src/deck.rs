//! Deck model, validation and pure stored-document migration.
use std::collections::HashSet;
use serde::{Deserialize, Serialize};

/// Deck schema version understood by both the frontend and this store.
pub const DECK_VERSION: u32 = 3;
pub const MAX_PAGES: usize = 12;
pub const MAX_CONTROLS_PER_PAGE: usize = 24;
/// Newest deleted controls and sections kept for restore, outside the deck.
pub const MAX_TRASH_ITEMS: usize = 10;
/// Separate trash budget so trash growth cannot make a valid deck unsavable.
pub const MAX_TRASH_BYTES: usize = 256 * 1024;
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
    Glass,
    Terminal,
}

fn presentation_valid(action: &str, p: &str) -> bool {
    p == "button" || (action == "volume" && matches!(p, "slider" | "dial"))
        || (action == "plugin" && matches!(p, "slider" | "dial" | "toggle-switch" | "toggle-button" | "value"))
}

/// A present optional field must deserialize as its value, so `null` is rejected.
fn non_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// Mirrors the TypeScript `Control` union, tagged by `action`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "action", deny_unknown_fields)]
pub enum ControlAction {
    #[serde(rename = "obs-scene")]
    ObsScene {
        scene: String,
        #[serde(rename = "autoLabel", default, skip_serializing_if = "std::ops::Not::not")]
        auto_label: bool,
    },
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
    pub presentation: Option<String>,
    #[serde(rename = "rowSpan", skip_serializing_if = "Option::is_none")]
    pub row_span: Option<u32>,
    #[serde(rename = "columnSpan", skip_serializing_if = "Option::is_none")]
    pub column_span: Option<u32>,
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
        let row_span = fields.remove("rowSpan").map(serde_json::from_value::<u32>).transpose()
            .map_err(|_| D::Error::custom("Invalid row span."))?;
        let column_span = fields.remove("columnSpan").map(serde_json::from_value::<u32>).transpose()
            .map_err(|_| D::Error::custom("Invalid column span."))?;
        if row_span.is_some_and(|n| !(1..=24).contains(&n)) || column_span.is_some_and(|n| !(1..=4).contains(&n)) {
            return Err(D::Error::custom("Control spans are out of range."));
        }
        let icon = fields.remove("icon").map(serde_json::from_value::<crate::icons::ControlIcon>).transpose()
            .map_err(|_| D::Error::custom("Invalid control icon."))?;
        if icon.as_ref().is_some_and(|icon| !icon.valid()) { return Err(D::Error::custom("Invalid control icon.")); }
        // Serde ignores extra fields on internally tagged unit variants even
        // with deny_unknown_fields. Do not silently drop data during migration.
        if matches!(fields.get("action").and_then(serde_json::Value::as_str), Some("mic-mute" | "media-play-pause")) && fields.len() != 1 + usize::from(fields.contains_key("presentation")) {
            return Err(D::Error::custom("Unknown control fields."));
        }
        let presentation = fields.remove("presentation").map(serde_json::from_value::<String>).transpose()
            .map_err(|_| D::Error::custom("Invalid control presentation."))?;
        if presentation.as_deref().is_some_and(|p| !presentation_valid(fields.get("action").and_then(serde_json::Value::as_str).unwrap_or(""), p)) {
            return Err(D::Error::custom("Incompatible control presentation."));
        }
        let action = serde_json::from_value(serde_json::Value::Object(fields))
            .map_err(|_| D::Error::custom("Invalid control action fields."))?;
        Ok(Self { id, label, presentation, row_span, column_span, icon, action })
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Section {
    pub id: String,
    pub name: String,
    pub controls: Vec<Control>,
    #[serde(default, deserialize_with = "non_null", skip_serializing_if = "Option::is_none")]
    pub theme: Option<Theme>,
    #[serde(default, deserialize_with = "non_null", skip_serializing_if = "Option::is_none")]
    pub accent: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Page {
    pub id: String,
    pub name: String,
    pub sections: Vec<Section>,
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

/// Where a deleted control or section came from, for restore clamping.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrashLocation {
    pub page_id: String,
    pub page_name: String,
    #[serde(default, deserialize_with = "non_null", skip_serializing_if = "Option::is_none")]
    pub section_id: Option<String>,
    #[serde(default, deserialize_with = "non_null", skip_serializing_if = "Option::is_none")]
    pub section_name: Option<String>,
    pub index: u32,
}

/// A recoverable deletion. Trash lives in the local document, never in a deck.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum TrashEntry {
    Control {
        id: String,
        #[serde(rename = "deletedAt")]
        deleted_at: u64,
        control: Control,
        location: TrashLocation,
    },
    Section {
        id: String,
        #[serde(rename = "deletedAt")]
        deleted_at: u64,
        section: Section,
        location: TrashLocation,
    },
}

fn validate_location(location: &TrashLocation, control: bool) -> Result<(), DeckError> {
    if location.page_id.is_empty() || location.page_id.len() > MAX_ID_BYTES
        || location.page_name.trim().is_empty() || location.page_name.len() > MAX_NAME_BYTES
    {
        return Err(DeckError::invalid_input("Trash locations must reference a bounded page."));
    }
    let section_fields_valid = match (&location.section_id, &location.section_name) {
        (Some(id), Some(name)) => {
            control && !id.is_empty() && id.len() <= MAX_ID_BYTES
                && !name.trim().is_empty() && name.len() <= MAX_NAME_BYTES
        }
        (None, None) => !control,
        _ => false,
    };
    if !section_fields_valid {
        return Err(DeckError::invalid_input("Trash locations must match their entry kind."));
    }
    Ok(())
}

fn valid_control_payload(control: &Control) -> bool {
    Deck {
        version: DECK_VERSION,
        pages: vec![Page {
            id: "__trash_page".into(),
            name: "Trash".into(),
            sections: vec![Section {
                id: "__trash_section".into(),
                name: "Trash".into(),
                controls: vec![control.clone()],
                theme: None,
                accent: None,
            }],
        }],
        active_page_id: "__trash_page".into(),
        theme: Theme::Dark,
        accent: ACCENTS[0].to_string(),
    }
    .validate()
    .is_ok()
}

fn valid_section_payload(section: &Section) -> bool {
    Deck {
        version: DECK_VERSION,
        pages: vec![Page {
            id: "__trash_page".into(),
            name: "Trash".into(),
            sections: vec![section.clone()],
        }],
        active_page_id: "__trash_page".into(),
        theme: Theme::Dark,
        accent: ACCENTS[0].to_string(),
    }
    .validate()
    .is_ok()
}

impl TrashEntry {
    fn validate(&self) -> Result<(), DeckError> {
        let (id, deleted_at) = match self {
            Self::Control { id, deleted_at, .. } | Self::Section { id, deleted_at, .. } => (id, deleted_at),
        };
        if id.is_empty() || id.len() > MAX_ID_BYTES {
            return Err(DeckError::invalid_input("Trash IDs must be non-empty and bounded."));
        }
        if *deleted_at == 0 {
            return Err(DeckError::invalid_input("Trash entries need a deletion time."));
        }
        match self {
            Self::Control { id, control, location, .. } => {
                validate_location(location, true)?;
                if control.id != *id || !valid_control_payload(control) {
                    return Err(DeckError::invalid_input("Deleted controls must be valid and match their ID."));
                }
            }
            Self::Section { id, section, location, .. } => {
                validate_location(location, false)?;
                if section.id != *id || !valid_section_payload(section) {
                    return Err(DeckError::invalid_input("Deleted sections must be valid and match their ID."));
                }
            }
        }
        Ok(())
    }
}

/// Validate the bounded trash beside an unchanged per-deck schema.
pub fn validate_trash(trash: &[TrashEntry]) -> Result<(), DeckError> {
    if trash.len() > MAX_TRASH_ITEMS {
        return Err(DeckError::invalid_input(format!(
            "Trash holds at most {MAX_TRASH_ITEMS} items."
        )));
    }
    if serde_json::to_vec(trash).map(|bytes| bytes.len() > MAX_TRASH_BYTES).unwrap_or(true) {
        return Err(DeckError::invalid_input(format!(
            "Trash is larger than {MAX_TRASH_BYTES} bytes."
        )));
    }
    let mut control_ids = HashSet::new();
    let mut section_ids = HashSet::new();
    for entry in trash {
        entry.validate()?;
        let unique = match entry {
            TrashEntry::Control { id, .. } => control_ids.insert(id),
            TrashEntry::Section { id, .. } => section_ids.insert(id),
        };
        if !unique {
            return Err(DeckError::invalid_input("Trash IDs must be unique per kind."));
        }
    }
    Ok(())
}

/// The persisted document. No secrets or runtime action state belong here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeckDocument {
    pub revision: u64,
    pub deck: Deck,
    /// Absent in older files; empty trash is omitted so old readers keep working.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub trash: Vec<TrashEntry>,
}

/// The wire shape returned to the frontend, including whether the file existed.
/// Phone snapshots serialize only `deck`, so trash never leaves the desktop.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckSnapshot {
    pub revision: u64,
    pub deck: Deck,
    pub trash: Vec<TrashEntry>,
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
        let mut section_ids: HashSet<&str> = HashSet::new();
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
            if page.sections.is_empty() {
                return Err(DeckError::invalid_input("A page needs at least one section."));
            }
            if page.sections.iter().map(|section| section.controls.len()).sum::<usize>() > MAX_CONTROLS_PER_PAGE {
                return Err(DeckError::invalid_input(format!(
                    "A page can hold at most {MAX_CONTROLS_PER_PAGE} controls."
                )));
            }
            for section in &page.sections {
                if section.id.is_empty() || section.id.len() > MAX_ID_BYTES || !section_ids.insert(&section.id) {
                    return Err(DeckError::invalid_input(
                        "Section IDs must be non-empty and unique.",
                    ));
                }
                if section.name.trim().is_empty() || section.name.len() > MAX_NAME_BYTES {
                    return Err(DeckError::invalid_input(
                        "Section names must be non-empty and bounded.",
                    ));
                }
                if section.accent.as_deref().is_some_and(|accent| !ACCENTS.contains(&accent)) {
                    return Err(DeckError::invalid_input("Unknown section accent color."));
                }
                for control in &section.controls {
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
                if control.row_span.is_some_and(|n| !(1..=24).contains(&n)) || control.column_span.is_some_and(|n| !(1..=4).contains(&n)) {
                    return Err(DeckError::invalid_input("Control spans are out of range."));
                }
                let action_name = match control.action { ControlAction::Volume { .. } => "volume", ControlAction::Plugin { .. } => "plugin", _ => "button" };
                if control.presentation.as_deref().is_some_and(|p| !presentation_valid(action_name, p)) {
                    return Err(DeckError::invalid_input("Incompatible control presentation."));
                }
                if control.icon.as_ref().is_some_and(|icon| !icon.valid()) {
                    return Err(DeckError::invalid_input("Control icons require a known built-in icon or a bounded image data URL."));
                }
                match &control.action {
                    ControlAction::ObsScene { scene, auto_label } => {
                        if *auto_label && control.label != *scene {
                            return Err(DeckError::invalid_input("Automatic OBS labels must match the scene name."));
                        }
                        if scene.trim().is_empty() || scene.len() > MAX_SCENE_BYTES {
                            return Err(DeckError::invalid_input(
                                "OBS scene names must be non-empty and bounded.",
                            ));
                        }
                    }
                    ControlAction::Plugin { plugin_id, plugin_action, plugin_args } => {
                        if !crate::plugin::identifier(plugin_id) || !crate::plugin::identifier(plugin_action)
                            || plugin_args.len() > 8
                            || !plugin_args.iter().all(|(k, v)| crate::plugin::identifier(k) && (crate::plugin::integer(v).is_some() || v.is_boolean())) {
                            return Err(DeckError::invalid_input("Plugin controls require bounded IDs and at most eight safe integer or boolean arguments."));
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
            row_span: None, column_span: None, icon: None, presentation: None,
            action: ControlAction::ObsScene {
                scene: scene.to_string(),
                auto_label: false,
            },
        }
    }
    fn plain(id: &str, label: &str, action: ControlAction) -> Control {
        Control {
            id: id.to_string(),
            label: label.to_string(),
            row_span: None, column_span: None, icon: None, presentation: None,
            action,
        }
    }

    fn section(id: &str, name: &str, controls: Vec<Control>) -> Section {
        Section { id: id.to_string(), name: name.to_string(), controls, theme: None, accent: None }
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
                sections: vec![section("page_stream_section", "Stream", vec![
                    obs("ctl_starting_soon", "Starting soon", "Starting soon"),
                    obs("ctl_live", "Go live", "Live"),
                    plain("ctl_mic", "Mic mute", ControlAction::MicMute),
                    plain(
                        "ctl_play_pause",
                        "Play / pause",
                        ControlAction::MediaPlayPause,
                    ),
                ])],
            },
            Page {
                id: "page_media".to_string(),
                name: "Media".to_string(),
                sections: vec![section("page_media_section", "Media", vec![
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
                ])],
            },
        ],
    }
}

fn promoted_section_id(page_id: &str, index: usize, used: &mut HashSet<String>) -> String {
    let candidate = format!("{page_id}_section");
    if candidate.len() <= MAX_ID_BYTES && !used.contains(&candidate) {
        used.insert(candidate.clone());
        return candidate;
    }
    let mut fallback_index = index;
    while used.contains(&format!("section_{fallback_index}")) {
        fallback_index += 1;
    }
    let fallback = format!("section_{fallback_index}");
    used.insert(fallback.clone());
    fallback
}

fn promote_legacy_pages(value: &mut serde_json::Value) -> Result<(), DeckError> {
    let invalid = || DeckError::invalid_file("The deck file is not a valid versioned deck document.");
    let deck = value
        .get_mut("deck")
        .and_then(serde_json::Value::as_object_mut)
        .ok_or_else(invalid)?;
    let pages = deck
        .get_mut("pages")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or_else(invalid)?;
    let mut used = HashSet::new();
    for (index, page) in pages.iter_mut().enumerate() {
        let page = page.as_object_mut().ok_or_else(invalid)?;
        // Only the original flat page shape is legacy data; a mixed v3 page is rejected.
        if page.len() != 3
            || !["id", "name", "controls"]
                .iter()
                .all(|key| page.contains_key(*key))
        {
            return Err(invalid());
        }
        let id = page
            .get("id")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(invalid)?
            .to_string();
        let name = page
            .get("name")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(invalid)?
            .to_string();
        let Some(controls) = page.remove("controls").filter(serde_json::Value::is_array) else {
            return Err(invalid());
        };
        let section_id = promoted_section_id(&id, index, &mut used);
        page.insert(
            "sections".into(),
            serde_json::json!([{ "id": section_id, "name": name, "controls": controls }]),
        );
    }
    deck.insert("version".into(), DECK_VERSION.into());
    Ok(())
}

/// Decode and validate a stored document, promoting valid v1/v2 decks in memory.
/// This does not rewrite bytes or advance the stored revision.
pub fn decode_document(bytes: &[u8]) -> Result<DeckDocument, DeckError> {
    let mut value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|_| DeckError::invalid_file("The deck file is not valid JSON."))?;
    let version = value.pointer("/deck/version").and_then(serde_json::Value::as_u64);
    if let Some(version) = version {
        if version != 1 && version != 2 && version != u64::from(DECK_VERSION) {
            return Err(DeckError::unsupported_version("The deck version is not supported."));
        }
    }
    let legacy = matches!(version, Some(1 | 2));
    if legacy {
        // Promotion is in-memory only; the store still owns explicit saves.
        promote_legacy_pages(&mut value)?;
    }
    let document: DeckDocument = serde_json::from_value(value).map_err(|_| {
        DeckError::invalid_file("The deck file is not a valid versioned deck document.")
    })?;
    if version == Some(1)
        && document.deck.pages.iter().flat_map(|p| &p.sections).flat_map(|s| &s.controls)
            .any(|c| matches!(c.action, ControlAction::Plugin { .. }))
    {
        return Err(DeckError::invalid_file("Plugin controls require deck version 2."));
    }
    document.deck.validate().map_err(|error| match error {
        DeckError::UnsupportedVersion { message } => DeckError::UnsupportedVersion { message },
        _ => DeckError::invalid_file("The deck file failed schema validation."),
    })?;
    validate_trash(&document.trash)
        .map_err(|_| DeckError::invalid_file("The deck file has invalid trash."))?;
    Ok(document)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../../tests/fixtures/deck.sample.json");

    #[test]
    fn automatic_obs_labels_round_trip_and_validate_strictly() {
        use serde_json::json;
        let mut deck = serde_json::to_value(default_deck()).unwrap();
        deck["pages"][0]["sections"][0]["controls"][0] = json!({
            "id":"camera", "label":"Camera", "action":"obs-scene", "scene":"Camera", "autoLabel":true
        });
        let document = json!({"revision":7, "deck":deck});
        let restored = decode_document(&serde_json::to_vec(&document).unwrap()).unwrap();
        assert_eq!(serde_json::to_value(restored).unwrap(), document);
        for invalid in [json!(null), json!("true"), json!(1)] {
            let mut value = document.clone();
            value["deck"]["pages"][0]["sections"][0]["controls"][0]["autoLabel"] = invalid;
            assert!(decode_document(&serde_json::to_vec(&value).unwrap()).is_err());
        }
        let mut mismatch = document.clone();
        mismatch["deck"]["pages"][0]["sections"][0]["controls"][0]["label"] = json!("Custom");
        assert!(decode_document(&serde_json::to_vec(&mismatch).unwrap()).is_err());
        let mut wrong_action = document;
        wrong_action["deck"]["pages"][0]["sections"][0]["controls"][0] = json!({"id":"mic", "label":"Mic", "action":"mic-mute", "autoLabel":true});
        assert!(decode_document(&serde_json::to_vec(&wrong_action).unwrap()).is_err());
    }

    #[test]
    fn optional_presentations_and_boolean_args_round_trip_strictly() {
        use serde_json::json;
        let original = serde_json::to_value(default_deck()).unwrap();
        assert_eq!(serde_json::to_value(serde_json::from_value::<Deck>(original.clone()).unwrap()).unwrap(), original);
        for presentation in ["button", "slider", "dial", "toggle-switch", "toggle-button", "value"] {
            let mut value = original.clone();
            value["pages"][0]["sections"][0]["controls"][0] = json!({"id":"power","label":"Power","action":"plugin","pluginId":"power","pluginAction":"set","pluginArgs":{"enabled":true},"presentation":presentation});
            let deck: Deck = serde_json::from_value(value.clone()).unwrap(); deck.validate().unwrap();
            assert_eq!(serde_json::to_value(deck).unwrap(), value);
        }
        for presentation in [json!(null), json!("knob"), json!("slider"), json!("toggle-switch"), json!("value")] {
            let mut value = original.clone(); value["pages"][0]["sections"][0]["controls"][0]["presentation"] = presentation;
            assert!(serde_json::from_value::<Deck>(value).is_err());
        }
    }

    #[test]
    fn opt_in_themes_round_trip_globally_and_per_section_and_unknown_is_rejected() {
        use serde_json::json;
        for theme in ["glass", "terminal"] {
            let mut value = serde_json::to_value(default_deck()).unwrap();
            value["theme"] = json!(theme);
            value["pages"][0]["sections"][0]["theme"] = json!(theme);
            let deck: Deck = serde_json::from_value(value.clone()).unwrap();
            deck.validate().unwrap();
            assert_eq!(serde_json::to_value(deck).unwrap(), value);
            value["theme"] = json!("midnight");
            assert!(serde_json::from_value::<Deck>(value).is_err());
        }
    }

    fn fixture_deck() -> Deck {
        decode_document(&serde_json::to_vec(&stored_fixture()).unwrap())
            .expect("fixture is a valid legacy document").deck
    }

    fn stored_fixture() -> serde_json::Value {
        serde_json::json!({"revision": 7, "deck": serde_json::from_str::<serde_json::Value>(FIXTURE).unwrap()})
    }

    #[test]
    fn legacy_document_promotes_without_changing_revision_or_source() {
        let value = stored_fixture();
        let bytes = serde_json::to_vec(&value).unwrap();
        let document = decode_document(&bytes).unwrap();
        assert_eq!(document, DeckDocument { revision: 7, deck: fixture_deck(), trash: vec![] });
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(), value);
        let current = serde_json::to_vec(&document).unwrap();
        assert_eq!(decode_document(&current).unwrap(), document);
    }

    #[test]
    fn legacy_document_rejects_plugin_controls() {
        let mut value = stored_fixture();
        value["deck"]["pages"][0]["controls"][0] = serde_json::json!({
            "id":"p", "label":"P", "action":"plugin", "pluginId":"test",
            "pluginAction":"go", "pluginArgs":{}
        });
        assert_eq!(decode_document(&serde_json::to_vec(&value).unwrap()),
            Err(DeckError::invalid_file("Plugin controls require deck version 2.")));
    }

    #[test]
    fn stored_document_rejects_unsupported_versions() {
        for version in [0, 4, u64::MAX] {
            let mut value = stored_fixture();
            value["deck"]["version"] = version.into();
            assert_eq!(decode_document(&serde_json::to_vec(&value).unwrap()),
                Err(DeckError::unsupported_version("The deck version is not supported.")));
        }
    }

    #[test]
    fn stored_document_rejects_invalid_data_with_original_errors() {
        assert_eq!(decode_document(b"{not json"),
            Err(DeckError::invalid_file("The deck file is not valid JSON.")));
        assert_eq!(decode_document(b"{}"),
            Err(DeckError::invalid_file("The deck file is not a valid versioned deck document.")));
        let mut value = stored_fixture();
        value["deck"]["pages"] = serde_json::json!([]);
        assert_eq!(decode_document(&serde_json::to_vec(&value).unwrap()),
            Err(DeckError::invalid_file("The deck file failed schema validation.")));
        for pointer in ["/extra", "/deck/extra", "/deck/pages/0/extra", "/deck/pages/0/controls/0/extra"] {
            let mut value = stored_fixture();
            let (parent, key) = pointer.rsplit_once('/').unwrap();
            value.pointer_mut(parent).unwrap().as_object_mut().unwrap().insert(key.into(), true.into());
            assert_eq!(decode_document(&serde_json::to_vec(&value).unwrap()),
                Err(DeckError::invalid_file("The deck file is not a valid versioned deck document.")));
        }
    }

    #[test]
    fn fixture_round_trips_and_covers_all_control_kinds() {
        let deck = fixture_deck();
        deck.validate().unwrap();

        let kinds: HashSet<&str> = deck
            .pages
            .iter()
            .flat_map(|page| &page.sections)
            .flat_map(|section| {
                section.controls.iter().map(|control| match &control.action {
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

        let document = DeckDocument { revision: 7, deck, trash: vec![] };
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
        deck.pages[0].sections[0].controls.push(parsed);
        deck.validate().unwrap();
        assert_eq!(serde_json::to_value(deck.pages[0].sections[0].controls.last().unwrap()).unwrap(), control);
        for (field, value) in [("pluginId", json!("../node")), ("pluginAction", json!("Bad")), ("pluginArgs", json!({"volume":1.5})), ("pluginArgs", json!({"secret":"token"})), ("pluginArgs", json!({"n":9007199254740992i64}))] {
            let mut c = control.clone(); c[field] = value;
            let mut deck = fixture_deck();
            if let Ok(c) = serde_json::from_value(c) { deck.pages[0].sections[0].controls.push(c); assert!(deck.validate().is_err()); }
        }
        let mut c = control.clone();
        c["pluginArgs"] = json!((0..9).map(|i| (format!("n{i}"), json!(1))).collect::<serde_json::Map<_,_>>());
        let mut deck = fixture_deck(); deck.pages[0].sections[0].controls.push(serde_json::from_value(c).unwrap()); assert!(deck.validate().is_err());
        for value in [json!(null), json!([]), json!(1)] {
            let mut c = control.clone(); c["pluginArgs"] = value;
            assert!(serde_json::from_value::<Control>(c).is_err());
        }
        for action in [control, json!({"id":"mic","label":"Mic","action":"mic-mute"})] {
            let mut c = action; c["program"] = json!("/private/path");
            assert!(serde_json::from_value::<Control>(c).is_err(), "unknown launch metadata must not be silently discarded");
        }
    }

    #[test]
    fn default_deck_is_valid_and_matches_the_shared_fixture() {
        let default = default_deck();
        default.validate().unwrap();
        assert_eq!(default, fixture_deck());
    }

    #[test]
    fn rejects_invalid_decks() {
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
        if let Some(control) = bad_volume.pages[1].sections[0].controls.first_mut() {
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
        long_label.pages[0].sections[0].controls[0].label = "x".repeat(MAX_LABEL_BYTES + 1);
        assert!(long_label.validate().is_err());
    }

    #[test]
    fn sections_are_required_unique_and_bounded() {
        let mut missing = fixture_deck();
        missing.pages[0].sections.clear();
        assert!(missing.validate().is_err());

        let mut duplicate = fixture_deck();
        let first_section = duplicate.pages[0].sections[0].clone();
        duplicate.pages[0].sections.push(first_section);
        assert!(duplicate.validate().is_err());

        let mut blank = fixture_deck();
        blank.pages[0].sections[0].name = "  ".into();
        assert!(blank.validate().is_err());

        let mut accent = fixture_deck();
        accent.pages[0].sections[0].accent = Some("#000000".into());
        assert!(accent.validate().is_err());

        let mut too_many = fixture_deck();
        let section = &mut too_many.pages[0].sections[0];
        let control = section.controls[0].clone();
        section.controls.extend(std::iter::repeat_n(control, MAX_CONTROLS_PER_PAGE));
        assert!(too_many.validate().is_err());
    }

    #[test]
    fn legacy_versions_reject_pages_with_canonical_sections_or_unknown_fields() {
        let canonical = serde_json::to_value(default_deck()).unwrap();
        for version in [1, 2] {
            let mut value = serde_json::json!({"revision": 1, "deck": canonical.clone()});
            value["deck"]["version"] = version.into();
            assert!(decode_document(&serde_json::to_vec(&value).unwrap()).is_err());

            let mut extra = stored_fixture();
            extra["deck"]["version"] = version.into();
            extra["deck"]["pages"][0]["extra"] = true.into();
            assert!(decode_document(&serde_json::to_vec(&extra).unwrap()).is_err());

            let mut missing = stored_fixture();
            missing["deck"]["version"] = version.into();
            missing["deck"]["pages"][0]
                .as_object_mut()
                .unwrap()
                .remove("controls");
            assert!(decode_document(&serde_json::to_vec(&missing).unwrap()).is_err());
        }
    }

    #[test]
    fn legacy_migration_bounds_long_page_ids_with_deterministic_section_ids() {
        let page_id = "p".repeat(MAX_ID_BYTES);
        let second_id = "q".repeat(MAX_ID_BYTES);
        let value = serde_json::json!({
            "revision": 1,
            "deck": {
                "version": 2,
                "theme": "dark",
                "accent": ACCENTS[0],
                "activePageId": page_id,
                "pages": [
                    {"id": page_id, "name": "Long", "controls": []},
                    {"id": second_id, "name": "Also long", "controls": []}
                ]
            }
        });
        let document = decode_document(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(document.deck.pages[0].sections[0].id, "section_0");
        assert_eq!(document.deck.pages[1].sections[0].id, "section_1");
        assert!(document.deck.pages.iter().all(|page| page.sections[0].id.len() <= MAX_ID_BYTES));
    }

    #[test]
    fn canonical_sections_reject_null_overrides_and_overlong_section_fields() {
        let mut value = serde_json::to_value(default_deck()).unwrap();
        value["pages"][0]["sections"][0]["theme"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<Deck>(value.clone()).is_err());
        value["pages"][0]["sections"][0]["theme"] = serde_json::json!("light");
        value["pages"][0]["sections"][0]["accent"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<Deck>(value).is_err());

        let mut deck = fixture_deck();
        deck.pages[0].sections[0].id = "x".repeat(MAX_ID_BYTES + 1);
        assert!(deck.validate().is_err());
        deck.pages[0].sections[0].id = "x".repeat(MAX_ID_BYTES);
        deck.pages[0].sections[0].name = "é".repeat(MAX_NAME_BYTES / 2 + 1);
        assert!(deck.validate().is_err());
    }

    fn control_trash_entry() -> TrashEntry {
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

    fn section_trash_entry() -> TrashEntry {
        let deck = default_deck();
        let section = deck.pages[0].sections[0].clone();
        TrashEntry::Section {
            id: section.id.clone(),
            deleted_at: 2,
            section,
            location: TrashLocation {
                page_id: "page_stream".into(),
                page_name: "Stream".into(),
                section_id: None,
                section_name: None,
                index: 0,
            },
        }
    }

    #[test]
    fn trash_round_trips_beside_the_deck_and_old_documents_stay_empty() {
        let document = DeckDocument {
            revision: 7,
            deck: default_deck(),
            trash: vec![control_trash_entry(), section_trash_entry()],
        };
        let bytes = serde_json::to_vec(&document).unwrap();
        assert_eq!(decode_document(&bytes).unwrap(), document);

        let old = serde_json::json!({"revision": 7, "deck": serde_json::to_value(default_deck()).unwrap()});
        assert!(decode_document(&serde_json::to_vec(&old).unwrap()).unwrap().trash.is_empty());
        let empty = DeckDocument { revision: 7, deck: default_deck(), trash: vec![] };
        let encoded: serde_json::Value = serde_json::from_slice(&serde_json::to_vec(&empty).unwrap()).unwrap();
        assert!(encoded.get("trash").is_none());

        let encoded = serde_json::to_value(&document).unwrap();
        assert_eq!(encoded["trash"][0]["deletedAt"], 1);
        assert_eq!(encoded["trash"][1]["location"].get("sectionId"), None);
    }

    #[test]
    fn trash_is_bounded_and_strictly_validated() {
        let control = control_trash_entry();
        let section = section_trash_entry();
        validate_trash(&[control.clone(), section.clone()]).unwrap();
        assert!(validate_trash(&vec![control.clone(); MAX_TRASH_ITEMS + 1]).is_err());

        let mut mismatched = control.clone();
        if let TrashEntry::Control { id, .. } = &mut mismatched { *id = "other".into(); }
        assert!(validate_trash(&[mismatched]).is_err());

        let mut bad_section_location = section.clone();
        if let TrashEntry::Section { location, .. } = &mut bad_section_location {
            location.section_id = Some("page_stream_section".into());
        }
        assert!(validate_trash(&[bad_section_location]).is_err());

        let mut missing_section_name = control.clone();
        if let TrashEntry::Control { location, .. } = &mut missing_section_name {
            location.section_name = None;
        }
        assert!(validate_trash(&[missing_section_name]).is_err());

        let mut bad_control_payload = control.clone();
        if let TrashEntry::Control { control: payload, .. } = &mut bad_control_payload {
            payload.label = " ".into();
        }
        assert!(validate_trash(&[bad_control_payload]).is_err());

        let mut zero_time = control;
        if let TrashEntry::Control { deleted_at, .. } = &mut zero_time { *deleted_at = 0; }
        assert!(validate_trash(&[zero_time]).is_err());

        let duplicate = section.clone();
        assert!(validate_trash(&[section, duplicate]).is_err());
    }

    #[test]
    fn legacy_v2_documents_migrate_to_sections_without_renumbering_controls() {
        let mut value = stored_fixture();
        value["deck"]["version"] = 2.into();
        let document = decode_document(&serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(document.deck.version, DECK_VERSION);
        assert_eq!(document.deck.pages[0].sections.len(), 1);
        assert_eq!(document.deck.pages[0].sections[0].id, "page_stream_section");
        assert_eq!(document.deck.pages[0].sections[0].controls[0].id, "ctl_starting_soon");
        assert_eq!(document.deck.pages[0].sections[0].controls.len(), 4);
    }
}
