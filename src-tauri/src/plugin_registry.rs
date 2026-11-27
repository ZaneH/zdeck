//! Website configuration is build-owned, never a URL supplied by renderer IPC or a link.
use serde::Serialize;
use tauri_plugin_opener::OpenerExt;
use url::Url;

const UNCONFIGURED: &str = "Registry website not configured for this build.";
const INVALID_WEBSITE: &str = "Registry website configuration is invalid. Rebuild with a valid HTTPS website URL.";

fn website_url(value: Option<&str>, development: bool) -> Result<Url, &'static str> {
    let value = value.filter(|s| !s.is_empty()).ok_or(UNCONFIGURED)?;
    if value.len() > 2048 || !value.is_ascii() || value.bytes().any(|b| b.is_ascii_control() || b.is_ascii_whitespace()) || value.contains('\\') {
        return Err(INVALID_WEBSITE);
    }
    let url = Url::parse(value).map_err(|_| INVALID_WEBSITE)?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some()
        || url.query().is_some() || url.fragment().is_some()
        || !(url.scheme() == "https" || (development && loopback && url.scheme() == "http"))
        || (!development && loopback) {
        return Err(INVALID_WEBSITE);
    }
    Ok(url)
}
fn configured_website() -> Result<Url, &'static str> {
    website_url(option_env!("ZDECK_REGISTRY_WEBSITE_URL"), cfg!(debug_assertions))
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebsiteStatus { available: bool, explanation: Option<&'static str> }

// Defense in depth: no remote window/origin can invoke the fixed website opener.
pub(crate) fn local_editor(label: &str, url: &Url) -> bool {
    label == "main" && (url.as_str() == "tauri://localhost/"
        || url.as_str() == "http://tauri.localhost/"
        || url.as_str() == "https://tauri.localhost/"
        || (cfg!(debug_assertions) && url.as_str() == "http://localhost:1420/"))
}
pub(crate) fn require_local(window: &tauri::WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|_| "The local desktop editor is unavailable.")?;
    // The editor's hash route is local UI state, not part of its origin.
    let mut base = url; base.set_fragment(None);
    if !local_editor(window.label(), &base) { return Err("Plugin installation is only available in the local desktop editor.".into()); }
    Ok(())
}
#[tauri::command]
pub fn plugin_registry_website_status(window: tauri::WebviewWindow) -> Result<WebsiteStatus, String> {
    require_local(&window)?;
    Ok(match configured_website() {
        Ok(_) => WebsiteStatus { available: true, explanation: None },
        Err(explanation) => WebsiteStatus { available: false, explanation: Some(explanation) },
    })
}
#[tauri::command]
pub fn plugin_registry_open_website(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    require_local(&window)?;
    let url = configured_website()?;
    app.opener().open_url(url.as_str(), None::<&str>)
        .map_err(|_| "Could not open the registry website. Check your default browser and try again.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn website_is_explicit_validated_and_preview_http_is_debug_only() {
        assert_eq!(website_url(None, false), Err(UNCONFIGURED));
        assert_eq!(website_url(Some(""), true), Err(UNCONFIGURED));
        assert!(website_url(Some("https://registry.example.test/plugins/"), false).is_ok());
        for input in ["http://registry.example.test", "https://user:password@example.test", "https://example.test/?redirect=evil", "https://example.test/#code", "file:///tmp/test", "javascript:alert(1)", "zdeck://plugins/install", "https://example.test\\evil", " https://example.test", "https://example.test/\n", "http://localhost:1430", "https://localhost"] {
            assert!(website_url(Some(input), false).is_err(), "{input}");
        }
        for input in ["http://localhost:1430", "http://127.0.0.1:1430", "http://[::1]:1430"] {
            assert!(website_url(Some(input), true).is_ok(), "{input}");
        }
        assert!(website_url(Some("http://localhost.evil.test:1430"), true).is_err());
        assert!(website_url(Some(&format!("https://example.test/{}", "a".repeat(2048))), true).is_err());
    }
    #[test]
    fn privileged_commands_are_local_only() {
        for url in ["tauri://localhost/", "http://tauri.localhost/", "https://tauri.localhost/"] {
            assert!(local_editor("main", &Url::parse(url).unwrap()));
            assert!(!local_editor("phone", &Url::parse(url).unwrap()));
        }
        for url in ["https://registry.example.test/", "https://tauri.localhost.evil.test/", "http://localhost:1430/", "tauri://localhost/remote", "tauri://localhost/?url=evil"] {
            assert!(!local_editor("main", &Url::parse(url).unwrap()));
        }
        let capabilities: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert!(capabilities.get("remote").is_none());
        assert_eq!(capabilities["permissions"], serde_json::json!(["core:event:allow-listen", "core:event:allow-unlisten"]));
    }
}
