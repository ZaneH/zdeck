//! Data-only theme package format foundation. Nothing here installs or applies a theme.
use crate::deck::Theme;
use crate::plugin::identifier;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Exact UTF-8 byte budget for one theme package, including whitespace.
pub const MAX_THEME_PACKAGE_BYTES: usize = 16 * 1024;

pub const THEME_COLOR_KEYS: [&str; 15] = [
    "bg", "bgSoft", "surface", "surface2", "surface3", "border", "borderStrong",
    "text", "textMuted", "textFaint", "danger", "warning", "maze", "pellet", "tileSurface",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMotif {
    None,
    Maze,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemeColors {
    pub bg: String,
    pub bg_soft: String,
    pub surface: String,
    pub surface2: String,
    pub surface3: String,
    pub border: String,
    pub border_strong: String,
    pub text: String,
    pub text_muted: String,
    pub text_faint: String,
    pub danger: String,
    pub warning: String,
    pub maze: String,
    pub pellet: String,
    pub tile_surface: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThemePackageAppearance {
    pub base: Theme,
    pub motif: ThemeMotif,
    pub colors: ThemeColors,
    #[serde(deserialize_with = "json_integer")]
    pub tile_radius: u32,
    #[serde(deserialize_with = "json_integer")]
    pub section_radius: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ThemePackage {
    #[serde(deserialize_with = "json_integer")]
    pub schema: u32,
    pub kind: String,
    pub id: String,
    pub version: String,
    pub name: String,
    pub author: String,
    pub license: String,
    /// Plain metadata text. Never fetch, execute or render it as a link.
    pub source: String,
    pub appearance: ThemePackageAppearance,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CustomThemeReference {
    pub id: String,
    pub version: String,
    pub digest: String,
}

/// Matches JavaScript JSON numbers: integral-valued forms such as `8.0` are integers.
fn json_integer<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    let number = value
        .as_f64()
        .filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= 0.0 && *n <= u32::MAX as f64)
        .ok_or_else(|| serde::de::Error::custom("expected an integer"))?;
    Ok(number as u32)
}

fn metadata(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.trim() == s
        && !s.starts_with('\u{feff}')
        && !s.ends_with('\u{feff}')
        && s.len() <= max
        && !s.chars().any(char::is_control)
}

fn version_string(s: &str) -> bool {
    let mut parts = s.split('.');
    (0..3).all(|_| parts.next().is_some_and(|part| {
        (1..=4).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_digit())
    })) && parts.next().is_none()
}

fn hex_color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn radius(value: u32) -> bool {
    value <= 32
}

fn digest(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl ThemeColors {
    fn valid(&self) -> bool {
        [
            &self.bg, &self.bg_soft, &self.surface, &self.surface2, &self.surface3,
            &self.border, &self.border_strong, &self.text, &self.text_muted,
            &self.text_faint, &self.danger, &self.warning, &self.maze, &self.pellet,
            &self.tile_surface,
        ].iter().all(|color| hex_color(color))
    }
}

impl ThemePackage {
    pub fn valid(&self) -> bool {
        self.schema == 1
            && self.kind == "zdeck-theme"
            && identifier(&self.id)
            && version_string(&self.version)
            && metadata(&self.name, 80)
            && metadata(&self.author, 160)
            && metadata(&self.license, 80)
            && metadata(&self.source, 512)
            && self.appearance.colors.valid()
            && radius(self.appearance.tile_radius)
            && radius(self.appearance.section_radius)
    }
}

impl CustomThemeReference {
    pub fn valid(&self) -> bool {
        identifier(&self.id) && version_string(&self.version) && digest(&self.digest)
    }
}

/// Parses bounded raw package bytes. Rejects BOM, invalid UTF-8 and malformed JSON.
pub fn parse_theme_package(bytes: &[u8]) -> Option<ThemePackage> {
    if bytes.len() > MAX_THEME_PACKAGE_BYTES || bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return None;
    }
    let text = std::str::from_utf8(bytes).ok()?;
    let package: ThemePackage = serde_json::from_str(text).ok()?;
    package.valid().then_some(package)
}

pub fn parse_custom_theme_reference(value: &Value) -> Option<CustomThemeReference> {
    let reference: CustomThemeReference = serde_json::from_value(value.clone()).ok()?;
    reference.valid().then_some(reference)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const VALID: &[u8] = include_bytes!("../../../tests/fixtures/theme-packages/midnight-maze.json");

    fn valid_value() -> Value {
        serde_json::from_slice(VALID).unwrap()
    }

    fn parse(value: &Value) -> Option<ThemePackage> {
        parse_theme_package(&serde_json::to_vec(value).unwrap())
    }

    fn assert_invalid(value: &Value) {
        assert!(parse(value).is_none(), "accepted {value}");
    }

    fn with_name(name: &str) -> Value {
        let mut value = valid_value();
        value["name"] = json!(name);
        value
    }

    #[test]
    fn parses_the_shared_sample_bytes() {
        let package = parse_theme_package(VALID).expect("shared sample must parse");
        assert_eq!(package.id, "midnight-maze");
        assert_eq!(package.appearance.colors.maze, "#3158ff");
        assert_eq!(package.appearance.colors.tile_surface, "#101a38");
        assert_eq!(package.appearance.tile_radius, 8);
        assert_eq!(package.appearance.section_radius, 12);
    }

    #[test]
    fn enforces_raw_byte_budget_bom_utf8_and_json() {
        let mut capped = VALID.to_vec();
        capped.resize(MAX_THEME_PACKAGE_BYTES, b' ');
        assert!(parse_theme_package(&capped).is_some());
        capped.push(b' ');
        assert!(parse_theme_package(&capped).is_none());

        let mut bom = vec![0xef, 0xbb, 0xbf];
        bom.extend_from_slice(VALID);
        assert!(parse_theme_package(&bom).is_none());
        assert!(parse_theme_package(&[0x7b, 0xff, 0x7d]).is_none());
        assert!(parse_theme_package(b"{}").is_none());
        assert!(parse_theme_package(b"not json").is_none());
    }

    #[test]
    fn rejects_extra_fields_wrong_types_and_unknown_enums() {
        let mut value = valid_value();
        value["digest"] = json!("a".repeat(64));
        assert_invalid(&value);
        let mut value = valid_value();
        value["appearance"]["css"] = json!("body{display:none}");
        assert_invalid(&value);
        let mut value = valid_value();
        value["appearance"]["colors"]["background"] = json!("#000000");
        assert_invalid(&value);
        let mut value = valid_value();
        value["schema"] = json!("1");
        assert_invalid(&value);
        let mut value = valid_value();
        value["appearance"] = Value::Null;
        assert_invalid(&value);
        let mut value = valid_value();
        value["appearance"]["base"] = json!("midnight");
        assert_invalid(&value);
        let mut value = valid_value();
        value["appearance"]["motif"] = json!("grid");
        assert_invalid(&value);
        let mut value = valid_value();
        value["appearance"]["colors"]["bg"] = json!("red");
        assert_invalid(&value);
        let mut value = valid_value();
        value["appearance"]["colors"]["bg"] = json!("#FFFFFF");
        assert_invalid(&value);
        let mut value = valid_value();
        value["appearance"]["colors"]["bg"] = json!("url(https://example.com/a.png)");
        assert_invalid(&value);
    }

    #[test]
    fn validates_integer_radii_and_versions() {
        for bad in [json!(-1), json!(33), json!(1.5), json!("8"), json!(null), json!(4294967296u64)] {
            let mut value = valid_value();
            value["appearance"]["tileRadius"] = bad;
            assert_invalid(&value);
        }
        for good in [json!(0), json!(32), json!(8.0)] {
            let mut value = valid_value();
            value["appearance"]["tileRadius"] = good.clone();
            value["appearance"]["sectionRadius"] = good;
            assert!(parse(&value).is_some());
        }
        let text = std::str::from_utf8(VALID).unwrap();
        assert!(parse_theme_package(text.replacen("\"schema\": 1", "\"schema\": 1.0", 1).as_bytes()).is_some());
        for bad in [json!("1.2"), json!("1.2.3.4"), json!("00001.1.1"), json!("1.2.x"), json!(1)] {
            let mut value = valid_value();
            value["version"] = bad;
            assert_invalid(&value);
        }
        for bad in [json!(""), json!("0maze"), json!("Maze"), json!("a".repeat(65)), json!("../maze")] {
            let mut value = valid_value();
            value["id"] = bad;
            assert_invalid(&value);
        }
    }

    #[test]
    fn counts_metadata_utf8_bytes_and_rejects_controls_and_padding() {
        assert!(parse(&with_name(&"é".repeat(40))).is_some()); // 80 UTF-8 bytes
        assert!(parse(&with_name(&"a".repeat(80))).is_some());
        assert!(parse(&with_name(&"é".repeat(41))).is_none()); // 82 UTF-8 bytes
        assert!(parse(&with_name(&"a".repeat(81))).is_none());
        assert!(parse(&with_name("tab\t")).is_none());
        assert!(parse(&with_name(" padded")).is_none());
        assert!(parse(&with_name("trailing ")).is_none());
        assert!(parse(&with_name("\u{feff}maze")).is_none());
        assert!(parse(&with_name("maze\u{feff}")).is_none());
        let mut value = valid_value();
        value["source"] = json!("é".repeat(256)); // 512 UTF-8 bytes
        assert!(parse(&value).is_some());
        value["source"] = json!("é".repeat(257));
        assert_invalid(&value);
    }

    #[test]
    fn validates_custom_references_strictly() {
        let digest = "0123456789abcdef".repeat(4);
        let reference = json!({ "id": "midnight-maze", "version": "0.1.0", "digest": digest });
        let parsed = parse_custom_theme_reference(&reference).expect("valid reference");
        assert_eq!(parsed.id, "midnight-maze");
        for bad in [
            json!({ "id": "midnight-maze", "version": "0.1.0" }),
            json!({ "id": "midnight-maze", "version": "0.1.0", "digest": digest, "extra": true }),
            json!({ "id": "midnight-maze", "version": "0.1.0", "digest": digest.to_uppercase() }),
            json!({ "id": "../maze", "version": "0.1.0", "digest": digest }),
            json!({ "id": "midnight-maze", "version": "1.0", "digest": digest }),
            json!({ "id": "midnight-maze", "version": "0.1.0", "digest": digest[..63] }),
        ] {
            assert!(parse_custom_theme_reference(&bad).is_none(), "accepted {bad}");
        }
    }
}
