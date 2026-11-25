//! Portable, self-contained images. Render SVG only through an image element, never as markup.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
pub enum ControlIcon {
    Builtin { name: String },
    Image { src: String },
}
impl ControlIcon {
    pub fn valid(&self) -> bool {
        match self {
            Self::Builtin { name } => ["obs-scene", "mic-mute", "media-play-pause", "volume", "plugin",
                "pause", "skip-back", "skip-forward", "music", "headphones", "camera", "monitor", "power",
                "lightbulb", "heart", "star"].contains(&name.as_str()),
            Self::Image { src } => icon_source(src),
        }
    }
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginIcon {
    pub id: String,
    pub title: String,
    pub category: String,
    pub src: String,
}
impl PluginIcon {
    pub fn valid(&self) -> bool {
        crate::plugin::identifier(&self.id) && icon_text(&self.title) && icon_text(&self.category) && icon_source(&self.src)
    }
}
fn icon_text(s: &str) -> bool {
    !s.trim().is_empty() && s.encode_utf16().count() <= 80 && !s.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
}
fn icon_source(s: &str) -> bool {
    if s.len() > 8192 { return false; }
    let Some((mime, data)) = s.split_once(";base64,") else { return false; };
    if !["data:image/png", "data:image/jpeg", "data:image/webp", "data:image/gif", "data:image/svg+xml"].contains(&mime)
        || data.is_empty() || data.len() % 4 != 0 { return false; }
    let body = data.trim_end_matches('=');
    data.len() - body.len() <= 2 && body.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sources_are_bounded_local_image_data_only() {
        for mime in ["png", "jpeg", "gif", "webp", "svg+xml"] {
            assert!(icon_source(&format!("data:image/{mime};base64,PHN2Zy8+")));
        }
        for src in ["https://example.com/icon.svg", "file:///secret", "data:text/html;base64,PHN2Zy8+",
            "data:image/svg+xml,<svg/>", "data:image/png;base64,", "data:image/png;base64,abc",
            "data:image/png;base64,====", "data:image/png;base64,a===", "data:image/png;base64,aa=a"] {
            assert!(!icon_source(src), "{src}");
        }
        assert!(!icon_source(&format!("data:image/png;base64,{}", "A".repeat(8192))));
        assert!(ControlIcon::Builtin { name: "music".into() }.valid());
        assert!(!ControlIcon::Builtin { name: "unknown".into() }.valid());
    }
}
