//! Website configuration is build-owned, never a URL supplied by renderer IPC or a link.
use std::collections::HashSet;
use serde::Serialize;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;
use url::Url;

// Independently shipped public trust root; never discovered from the registry server.
const DEFAULT_REGISTRY_URL: &str = "https://zreg.zaaane.com/";
const DEFAULT_PUBLIC_KEYS: &str = include_str!("../registry-public-keys.json");

fn resolver_configuration<'a>(endpoint: Option<&'a str>, keys: Option<&'a str>) -> (Option<&'a str>, Option<&'a str>) {
    // A partial custom override must not silently borrow the official endpoint or keys.
    if endpoint.is_none() && keys.is_none() { (Some(DEFAULT_REGISTRY_URL), Some(DEFAULT_PUBLIC_KEYS)) }
    else { (endpoint, keys) }
}

const UNCONFIGURED: &str = "Registry website not configured for this build.";
const INVALID_WEBSITE: &str = "Registry website configuration is invalid. Rebuild with a valid HTTPS website URL.";

fn website_url(value: Option<&str>, development: bool) -> Result<Url, &'static str> {
    let value = value.filter(|s| !s.is_empty()).ok_or(UNCONFIGURED)?;
    if value.len() > 2048 || !value.is_ascii() || value.bytes().any(|b| b.is_ascii_control() || b.is_ascii_whitespace()) || value.contains('\\') {
        return Err(INVALID_WEBSITE);
    }
    let url = Url::parse(value).map_err(|_| INVALID_WEBSITE)?;
    let preview_host = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    let loopback = match url.host() {
        Some(url::Host::Domain(host)) => { let host = host.trim_end_matches('.'); host == "localhost" || host.ends_with(".localhost") },
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback() || ip.to_ipv4_mapped().is_some_and(|ip| ip.is_loopback()),
        None => false,
    };
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some()
        || url.query().is_some() || url.fragment().is_some() || url.port() == Some(0)
        || !(url.scheme() == "https" || (development && preview_host && url.scheme() == "http"))
        || (!development && loopback) {
        return Err(INVALID_WEBSITE);
    }
    Ok(url)
}
fn configured_website() -> Result<Url, &'static str> {
    website_url(option_env!("ZDECK_REGISTRY_WEBSITE_URL").or(Some(DEFAULT_REGISTRY_URL)), cfg!(debug_assertions))
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebsiteStatus { available: bool, explanation: Option<&'static str> }

// Defense in depth: no remote window/origin can invoke the fixed website opener.
pub(crate) fn local_editor(label: &str, url: &Url) -> bool {
    let mut url = url.clone();
    url.set_fragment(None);
    // WebKit reports the bundled custom-scheme root without a trailing slash on macOS.
    if url.scheme() == "tauri" && url.path().is_empty() { url.set_path("/"); }
    label == "main" && (url.as_str() == "tauri://localhost/"
        || url.as_str() == "http://tauri.localhost/"
        || url.as_str() == "https://tauri.localhost/"
        || (cfg!(debug_assertions) && url.as_str() == "http://localhost:1420/"))
}
pub(crate) fn require_local(window: &tauri::WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|_| "The local desktop editor is unavailable.")?;
    if !local_editor(window.label(), &url) { return Err("Plugin installation is only available in the local desktop editor.".into()); }
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

pub(crate) const RESOLUTION_UNAVAILABLE: &str = zdeck_plugin_host::registry_release::UNAVAILABLE;
pub(crate) fn configured_resolver() -> Result<zdeck_plugin_host::registry_release::Resolver, &'static str> {
    let (endpoint, keys) = resolver_configuration(option_env!("ZDECK_REGISTRY_RELEASE_URL"), option_env!("ZDECK_REGISTRY_PUBLIC_KEYS"));
    zdeck_plugin_host::registry_release::Resolver::configured(endpoint, keys)
}
const INVALID_REQUEST: &str = "This plugin install link is invalid. Use a link containing only a plugin ID and exact version. Nothing was downloaded or installed.";
const REQUEST_LIMIT: &str = "Too many different plugin install links in this session. Close and reopen zDeck before reviewing more links. Nothing was downloaded or installed.";

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct InstallRequest { pub id: String, pub version: String }
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Received { Release(InstallRequest), Notice(&'static str) }
fn parse_request(value: &str) -> Option<InstallRequest> {
    if value.len() > 512 || !value.is_ascii() || value.bytes().any(|b| b.is_ascii_whitespace() || b.is_ascii_control()) { return None; }
    let query = value.strip_prefix("zdeck://plugins/install?")?;
    if query.contains('#') || query.split('&').count() != 2 { return None; }
    // Decode values only; encoded/duplicate/unknown field names are not part of this contract.
    if query.split('&').any(|part| !matches!(part.split_once('=').map(|p| p.0), Some("id" | "version"))) { return None; }
    let mut id = None;
    let mut version = None;
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        match key.as_ref() {
            "id" if id.is_none() => id = Some(value.into_owned()),
            "version" if version.is_none() => version = Some(value.into_owned()),
            _ => return None,
        }
    }
    let id = id?;
    let version = version?;
    if id.is_empty() || id.len() > 64 || !id.as_bytes()[0].is_ascii_lowercase()
        || !id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') { return None; }
    let parts: Vec<_> = version.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|part| part.is_empty() || part.len() > 4 || !part.bytes().all(|b| b.is_ascii_digit())) { return None; }
    Some(InstallRequest { id, version })
}

#[derive(Default)]
pub(crate) struct InstallRequests { seen: HashSet<InstallRequest>, invalid_seen: bool, limit_seen: bool }
impl InstallRequests {
    pub(crate) fn receive(&mut self, link: &str) -> Option<Received> {
        let request = match parse_request(link) {
            Some(request) => request,
            None => { return if std::mem::replace(&mut self.invalid_seen, true) { None } else { Some(Received::Notice(INVALID_REQUEST)) }; }
        };
        if self.seen.contains(&request) { return None; }
        // Do not evict active/pending links: an evicted link could re-prompt repeatedly.
        if self.seen.len() == 128 { return if std::mem::replace(&mut self.limit_seen, true) { None } else { Some(Received::Notice(REQUEST_LIMIT)) }; }
        self.seen.insert(request.clone());
        Some(Received::Release(request))
    }
    // A terminal review or notice may forget its identity so the same link can prompt again.
    pub(crate) fn release(&mut self, request: &InstallRequest) { self.seen.remove(request); }
    // An already-seen exact identity is still worth raising the window, without a second prompt.
    pub(crate) fn awaiting(&self, link: &str) -> bool { parse_request(link).is_some_and(|request| self.seen.contains(&request)) }
}

pub fn setup_links(app: &tauri::AppHandle) {
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls().iter().take(16) { crate::plugin_archive::request_link(&handle, url.as_str()); }
    });
    // Subscribe first, then read startup state; native deduplication covers overlapping delivery.
    match app.deep_link().get_current() {
        Ok(Some(urls)) => { for url in urls.iter().take(16) { crate::plugin_archive::request_link(app, url.as_str()); } }
        Ok(None) => (),
        Err(_) => crate::plugin_archive::request_notice(app, "Native plugin links are unavailable. Use Install from… → Local .zdx. Nothing was downloaded or installed."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shipped_public_defaults_and_custom_pairs_are_validated_without_key_discovery() {
        use zdeck_plugin_host::registry_release::Resolver;
        let (endpoint, keys) = resolver_configuration(None, None);
        assert_eq!(endpoint, Some("https://zreg.zaaane.com/"));
        assert!(Resolver::configured(endpoint, keys).is_ok());
        assert!(website_url(endpoint, false).is_ok());
        for (endpoint, keys) in [(Some("https://custom.example.test/"), None), (None, Some(DEFAULT_PUBLIC_KEYS)), (Some(""), Some(""))] {
            let (endpoint, keys) = resolver_configuration(endpoint, keys);
            assert!(Resolver::configured(endpoint, keys).is_err());
        }
        let (endpoint, keys) = resolver_configuration(Some("https://custom.example.test/"), Some(DEFAULT_PUBLIC_KEYS));
        assert_eq!(endpoint, Some("https://custom.example.test/"));
        assert!(Resolver::configured(endpoint, keys).is_ok());
        let build = include_str!("../build.rs");
        for variable in ["ZDECK_REGISTRY_RELEASE_URL", "ZDECK_REGISTRY_PUBLIC_KEYS", "ZDECK_REGISTRY_WEBSITE_URL"] {
            assert!(build.contains(&format!("cargo:rerun-if-env-changed={variable}")));
        }
    }
    #[test]
    fn website_is_explicit_validated_and_preview_http_is_debug_only() {
        assert_eq!(website_url(None, false), Err(UNCONFIGURED));
        assert_eq!(website_url(Some(""), true), Err(UNCONFIGURED));
        assert!(website_url(Some("https://registry.example.test/plugins/"), false).is_ok());
        for input in ["http://registry.example.test", "https://user:password@example.test", "https://example.test/?redirect=evil", "https://example.test/#code", "file:///tmp/test", "javascript:alert(1)", "zdeck://plugins/install", "https://example.test\\evil", " https://example.test", "https://example.test/\n", "http://localhost:1430", "https://localhost", "https://localhost.", "https://registry.localhost", "https://127.0.0.2", "https://[::ffff:127.0.0.1]", "https://example.test:0"] {
            assert!(website_url(Some(input), false).is_err(), "{input}");
        }
        for input in ["http://localhost:1430", "http://127.0.0.1:1430", "http://[::1]:1430"] {
            assert!(website_url(Some(input), true).is_ok(), "{input}");
        }
        assert!(website_url(Some("http://localhost.evil.test:1430"), true).is_err());
        assert!(website_url(Some(&format!("https://example.test/{}", "a".repeat(2048))), true).is_err());
    }
    #[test]
    fn exact_install_request_rejects_unknown_duplicate_and_executable_fields() {
        let expected = InstallRequest { id: "home-assistant".into(), version: "0.2.0".into() };
        assert_eq!(parse_request("zdeck://plugins/install?id=home-assistant&version=0.2.0"), Some(expected));
        assert_eq!(parse_request("zdeck://plugins/install?version=1%2E2%2E3&id=%66ixture"), Some(InstallRequest { id: "fixture".into(), version: "1.2.3".into() }));
        for input in [
            "https://plugins/install?id=fixture&version=1.2.3", "zdeck://plugins/install",
            "zdeck://plugins/install/?id=fixture&version=1.2.3", "zdeck://plugins/../install?id=fixture&version=1.2.3",
            "zdeck://user@plugins/install?id=fixture&version=1.2.3", "zdeck://plugins:80/install?id=fixture&version=1.2.3",
            "zdeck://plugins/install?id=fixture&version=1.2.3#fragment", "zdeck://plugins/install?id=fixture&version=1.2.3#",
            "zdeck://plugins/install?id=fixture&version=latest", "zdeck://plugins/install?id=fixture&version=1.2.3-pre",
            "zdeck://plugins/install?id=fixture&version=10000.2.3", "zdeck://plugins/install?id=fixture&version=1.2",
            "zdeck://plugins/install?id=fixture&version=1..3", "zdeck://plugins/install?id=fixture&version=1.2.3&url=https://evil.test/a.zdx",
            "zdeck://plugins/install?id=fixture&id=other", "zdeck://plugins/install?version=1.2.3&version=1.2.3",
            "zdeck://plugins/install?id=fixture&version=1.2.3&version=1.2.3", "zdeck://plugins/install?%69d=fixture&version=1.2.3",
            "zdeck://plugins/install?id=../fixture&version=1.2.3", "zdeck://plugins/install?id=%2fbin%2fsh&version=1.2.3",
            "zdeck://plugins/install?id=fixture%00&version=1.2.3", "zdeck://plugins/install?id=Fixture&version=1.2.3",
            "zdeck://plugins/install?id=fixture&exec=main.py", "zdeck://plugins/install?id=fixture&path=/tmp/test.zdx",
            "zdeck://plugins/install?id=fixture&version=1.2.3%", "zdeck://plugins/install?id=fixture&version=%ff",
            "zdeck://plugins/install?id=fixture&version=1.2.3\n", "zdeck://plugins/install?id=fixture&version=1.2.3&",
            "zdeck://plugins/install?id=&version=1.2.3", "zdeck://plugins/install?id=☃&version=1.2.3",
        ] { assert!(parse_request(input).is_none(), "{input}"); }
        for input in [format!("zdeck://plugins/install?id={}&version=1.2.3", "a".repeat(65)), format!("zdeck://plugins/install?id=fixture&version={}", "1".repeat(512))] {
            assert!(parse_request(&input).is_none());
        }
    }
    #[test]
    fn resolver_fails_closed_and_session_dedup_is_bounded_without_eviction() {
        let mut requests = InstallRequests::default();
        let link = "zdeck://plugins/install?id=fixture&version=1.2.3";
        assert!(matches!(requests.receive(link), Some(Received::Release(_))));
        assert_eq!(requests.receive(link), None);
        assert_eq!(requests.receive("zdeck://plugins/install?version=1.2.3&id=%66ixture"), None);
        assert_eq!(requests.receive("invalid"), Some(Received::Notice(INVALID_REQUEST)));
        assert_eq!(requests.receive("another-invalid"), None);
        for index in 0..127 { assert!(matches!(requests.receive(&format!("zdeck://plugins/install?id=fixture-{index}&version=1.2.3")), Some(Received::Release(_)))); }
        assert_eq!(requests.receive("zdeck://plugins/install?id=overflow&version=1.2.3"), Some(Received::Notice(REQUEST_LIMIT)));
        assert_eq!(requests.receive("zdeck://plugins/install?id=another&version=1.2.3"), None);
        assert_eq!(requests.receive(link), None);
        assert_eq!(requests.seen.len(), 128);
    }
    #[test]
    fn lifecycle_registers_only_native_scheme_and_does_not_grant_remote_privileges() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["plugins"]["deep-link"]["desktop"]["schemes"], serde_json::json!(["zdeck"]));
        let source = include_str!("lib.rs");
        assert!(source.find(".plugin(tauri_plugin_single_instance").unwrap() < source.find(".plugin(tauri_plugin_deep_link").unwrap());
        assert!(source.contains("plugin_registry::setup_links(app.handle())"));
        let registry = include_str!("plugin_registry.rs").split("#[cfg(test)]").next().unwrap();
        assert!(registry.contains("on_open_url")); assert!(registry.contains("get_current()"));
        assert!(!registry.contains("register_all()"));
        assert!(!registry.contains("reqwest") && !registry.contains("inspect_archive") && !registry.contains("install_archive"));
    }
    #[test]
    fn privileged_commands_are_local_only() {
        for url in ["tauri://localhost", "tauri://localhost/", "http://tauri.localhost/", "https://tauri.localhost/"] {
            assert!(local_editor("main", &Url::parse(url).unwrap()));
            assert!(!local_editor("phone", &Url::parse(url).unwrap()));
        }
        for url in ["https://registry.example.test/", "https://tauri.localhost.evil.test/", "http://localhost:1430/", "tauri://localhost/remote", "tauri://localhost/?url=evil", "tauri://localhost?url=evil", "tauri://user@localhost", "tauri://localhost:443"] {
            assert!(!local_editor("main", &Url::parse(url).unwrap()));
        }
        let capabilities: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert!(capabilities.get("remote").is_none());
        assert_eq!(capabilities["permissions"], serde_json::json!(["core:event:allow-listen", "core:event:allow-unlisten"]));
    }
}
