//! Deck model, validation and pure stored-document migration.
use std::collections::HashSet;
use serde::{Deserialize, Serialize};

/// Deck schema version understood by both the frontend and this store.
pub const DECK_VERSION: u32 = 2;
pub const MAX_PAGES: usize = 12;
pub const MAX_CONTROLS_PER_PAGE: usize = 24;
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
        if matches!(fields.get("action").and_then(serde_json::Value::as_str), Some("mic-mute" | "media-play-pause")) && fields.len() != 1 {
            return Err(D::Error::custom("Unknown control fields."));
        }
        let action = serde_json::from_value(serde_json::Value::Object(fields))
            .map_err(|_| D::Error::custom("Invalid control action fields."))?;
        Ok(Self { id, label, row_span, column_span, icon, action })
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
                if control.row_span.is_some_and(|n| !(1..=24).contains(&n)) || control.column_span.is_some_and(|n| !(1..=4).contains(&n)) {
                    return Err(DeckError::invalid_input("Control spans are out of range."));
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
            row_span: None, column_span: None, icon: None,
            action: ControlAction::ObsScene {
                scene: scene.to_string(),
            },
        }
    }
    fn plain(id: &str, label: &str, action: ControlAction) -> Control {
        Control {
            id: id.to_string(),
            label: label.to_string(),
            row_span: None, column_span: None, icon: None,
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

/// Decode and validate a stored document, promoting valid v1 decks in memory.
/// This does not rewrite bytes or advance the stored revision.
pub fn decode_document(bytes: &[u8]) -> Result<DeckDocument, DeckError> {
    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|_| DeckError::invalid_file("The deck file is not valid JSON."))?;
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
        // Promotion is in-memory only; the store still owns explicit saves.
        document.deck.version = DECK_VERSION;
    }
    document.deck.validate().map_err(|error| match error {
        DeckError::UnsupportedVersion { message } => DeckError::UnsupportedVersion { message },
        _ => DeckError::invalid_file("The deck file failed schema validation."),
    })?;
    Ok(document)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../../tests/fixtures/deck.sample.json");

    fn fixture_deck() -> Deck {
        let mut deck: Deck = serde_json::from_str(FIXTURE).expect("fixture is a valid legacy Deck");
        deck.version = DECK_VERSION;
        deck
    }

    fn stored_fixture() -> serde_json::Value {
        serde_json::json!({"revision": 7, "deck": serde_json::from_str::<serde_json::Value>(FIXTURE).unwrap()})
    }

    #[test]
    fn legacy_document_promotes_without_changing_revision_or_source() {
        let value = stored_fixture();
        let bytes = serde_json::to_vec(&value).unwrap();
        let document = decode_document(&bytes).unwrap();
        assert_eq!(document, DeckDocument { revision: 7, deck: fixture_deck() });
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
        for version in [0, 3, u64::MAX] {
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

}
