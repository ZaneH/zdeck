//! Generic per-plugin settings in the OS credential store. One credential per plugin is
//! replaced atomically, stays within the Windows 2560-byte blob limit, and has no plaintext
//! fallback. Stored secrets are never returned to IPC, logged or placed in launch arguments.
use std::collections::BTreeMap;

use keyring::{Entry, Error};
use serde::{Deserialize, Serialize};

use crate::plugin::{ErrorKind, Manifest, Outcome, PluginError, SettingsField};
use crate::plugin_install::{settings_within_limit, PluginInstall, MAX_SETTINGS_BYTES, MAX_SETTING_VALUE_BYTES};

const SERVICE: &str = "com.zdeck.plugins";

fn error(kind: ErrorKind, code: &'static str, message: &'static str, hint: &'static str) -> PluginError {
    PluginError { kind, code: Some(code), outcome: Outcome::NotStarted, message, hint }
}

fn storage_error() -> PluginError {
    error(ErrorKind::Unavailable, "settings_unavailable",
        "Saved plugin settings are unavailable in secure storage.",
        "Check OS secure storage access and try again. The plugin was not enabled, changed or run.")
}

fn invalid_error() -> PluginError {
    error(ErrorKind::InvalidArguments, "settings_invalid",
        "Plugin settings do not match this plugin's declared fields.",
        "Use only the fields this trusted package declares, keep values within the size limit, and leave a saved secret unchanged by omitting it.")
}

fn settings_required() -> PluginError {
    error(ErrorKind::Unavailable, "settings_required",
        "This plugin needs its settings configured before it can be enabled.",
        "Save every declared setting for this trusted package on the desktop, then enable it again.")
}

fn entry(plugin_id: &str) -> Result<Entry, PluginError> {
    Entry::new(SERVICE, &format!("settings-v1-{plugin_id}")).map_err(|_| storage_error())
}

fn declared(manifest: &Manifest) -> Result<&BTreeMap<String, SettingsField>, PluginError> {
    manifest.settings.as_ref().ok_or_else(invalid_error)
}

/// Typed credential envelope. Text and secrets are kept apart so a schema change (a key
/// declared secret in one package and text in another) can never reinterpret the other's
/// value. Strict parsing makes a legacy untyped blob fail closed instead of migrating.
#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Stored {
    text: BTreeMap<String, String>,
    secrets: BTreeMap<String, String>,
}
impl Stored {
    fn empty(&self) -> bool { self.text.is_empty() && self.secrets.is_empty() }
}

/// A missing entry is simply unconfigured. Corrupt or oversized data is refused, never
/// interpreted as plaintext or silently replaced.
fn read(entry: &Entry) -> Result<Stored, PluginError> {
    let record = match entry.get_password() {
        Ok(record) => record,
        Err(Error::NoEntry) => return Ok(Stored::default()),
        Err(_) => return Err(storage_error()),
    };
    if record.encode_utf16().count() * 2 > MAX_SETTINGS_BYTES { return Err(invalid_error()); }
    let stored: Stored = serde_json::from_str(&record).map_err(|_| invalid_error())?;
    if stored.text.iter().chain(stored.secrets.iter()).any(|(key, value)| {
        !zdeck_schema::plugin::identifier(key) || value.len() > MAX_SETTING_VALUE_BYTES
    }) || stored.text.keys().any(|key| stored.secrets.contains_key(key)) {
        return Err(invalid_error());
    }
    Ok(stored)
}

fn write(entry: &Entry, stored: &Stored) -> Result<(), PluginError> {
    if stored.empty() { return forget_entry(entry); }
    let record = serde_json::to_string(stored).map_err(|_| storage_error())?;
    if record.encode_utf16().count() * 2 > MAX_SETTINGS_BYTES { return Err(invalid_error()); }
    entry.set_password(&record).map_err(|_| storage_error())
}

fn forget_entry(entry: &Entry) -> Result<(), PluginError> {
    match entry.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(_) => Err(storage_error()),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSettingsView {
    pub values: BTreeMap<String, String>,
    pub secret_configured: BTreeMap<String, bool>,
}

fn load_view(entry: &Entry, manifest: &Manifest) -> Result<PluginSettingsView, PluginError> {
    let settings = declared(manifest)?;
    let stored = read(entry)?;
    let mut values = BTreeMap::new();
    let mut secret_configured = BTreeMap::new();
    for (key, field) in settings {
        match field {
            // Each map is read by declared type only: a stored secret is never text.
            SettingsField::Text { .. } => {
                values.insert(key.clone(), stored.text.get(key).cloned().unwrap_or_default());
            }
            SettingsField::Secret { .. } => {
                secret_configured.insert(key.clone(), stored.secrets.get(key).is_some_and(|value| !value.is_empty()));
            }
        }
    }
    Ok(PluginSettingsView { values, secret_configured })
}

/// Values for the plugin's configure request. Every declared setting must be stored;
/// text may be empty, but a missing or blank secret keeps the plugin unconfigured.
fn load_configured(entry: &Entry, manifest: &Manifest) -> Result<BTreeMap<String, String>, PluginError> {
    let settings = declared(manifest)?;
    let stored = read(entry)?;
    let mut values = BTreeMap::new();
    for (key, field) in settings {
        let value = match field {
            SettingsField::Text { .. } => stored.text.get(key),
            SettingsField::Secret { .. } => stored.secrets.get(key).filter(|value| !value.is_empty()),
        }.ok_or_else(settings_required)?;
        if value.len() > MAX_SETTING_VALUE_BYTES { return Err(settings_required()); }
        values.insert(key.clone(), value.clone());
    }
    if !settings_within_limit(&values) { return Err(settings_required()); }
    Ok(values)
}

/// Text values are complete; secrets are replacements only, so an omitted secret keeps
/// the stored value. Blank secret replacements are rejected.
fn save(entry: &Entry, manifest: &Manifest, values: &BTreeMap<String, String>, secrets: &BTreeMap<String, String>) -> Result<(), PluginError> {
    let settings = declared(manifest)?;
    let text_keys: Vec<_> = settings.iter().filter(|(_, field)| matches!(field, SettingsField::Text { .. })).map(|(key, _)| key).collect();
    let secret_keys: Vec<_> = settings.iter().filter(|(_, field)| matches!(field, SettingsField::Secret { .. })).map(|(key, _)| key).collect();
    if values.len() != text_keys.len() || !values.keys().all(|key| text_keys.contains(&key))
        || values.values().any(|value| value.len() > MAX_SETTING_VALUE_BYTES) {
        return Err(invalid_error());
    }
    if secrets.keys().any(|key| !secret_keys.contains(&key))
        || secrets.values().any(|value| value.is_empty() || value.len() > MAX_SETTING_VALUE_BYTES) {
        return Err(invalid_error());
    }
    let stored = read(entry)?;
    // Rebuild from the current declaration only: stale keys are dropped, and an omitted
    // secret keeps only a previously stored secret of the same key.
    let mut next = Stored::default();
    for key in text_keys { next.text.insert(key.clone(), values[key].clone()); }
    for key in secret_keys {
        let value = match secrets.get(key) {
            Some(value) => Some(value.clone()),
            None => stored.secrets.get(key).filter(|value| !value.is_empty()).cloned(),
        };
        if let Some(value) = value { next.secrets.insert(key.clone(), value); }
    }
    write(entry, &next)
}

fn forget(entry: &Entry, manifest: &Manifest, key: &str) -> Result<(), PluginError> {
    let settings = declared(manifest)?;
    if !matches!(settings.get(key), Some(SettingsField::Secret { .. })) { return Err(invalid_error()); }
    // A corrupt blob is removed rather than trapping the user; no secret is returned.
    let mut stored = match read(entry) {
        Ok(stored) => stored,
        Err(error) if error.code == Some("settings_invalid") => { forget_entry(entry)?; Stored::default() }
        Err(error) => return Err(error),
    };
    if stored.secrets.remove(key).is_none() { return Ok(()); }
    write(entry, &stored)
}

fn configured_for_launch(plugin_id: &str, manifest: &Manifest) -> Result<BTreeMap<String, String>, PluginError> {
    if manifest.settings.is_none() { return Ok(BTreeMap::new()); }
    load_configured(&entry(plugin_id)?, manifest)
}

/// Native credential loader attached to local plugin installation. It runs only after
/// exact package trust validation and only for manifests that declare settings.
pub fn load_settings(plugin_id: &str, manifest: &Manifest) -> Result<BTreeMap<String, String>, PluginError> {
    configured_for_launch(plugin_id, manifest)
}

async fn trusted_manifest(install: &PluginInstall, plugin_id: &str) -> Result<Manifest, PluginError> {
    install.trusted_manifest(plugin_id).await
}

#[tauri::command]
pub async fn plugin_settings_load(app: tauri::AppHandle, plugin_id: String) -> Result<PluginSettingsView, PluginError> {
    let manifest = trusted_manifest(&crate::local_plugin_install(&app)?, &plugin_id).await?;
    let id = plugin_id.clone();
    tauri::async_runtime::spawn_blocking(move || load_view(&entry(&id)?, &manifest))
        .await.map_err(|_| storage_error())?
}

#[tauri::command]
pub async fn plugin_settings_save(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    plugin_id: String,
    values: BTreeMap<String, String>,
    secrets: BTreeMap<String, String>,
) -> Result<(), PluginError> {
    let install = crate::local_plugin_install(&app)?;
    let id = plugin_id.clone();
    // Trust revalidation and the credential write run inside the plugin gate, so a
    // concurrent enable either completes first (then this is refused) or waits for it.
    state.plugin.with_disabled_settings(&plugin_id, move || async move {
        let manifest = trusted_manifest(&install, &id).await?;
        tauri::async_runtime::spawn_blocking(move || save(&entry(&id)?, &manifest, &values, &secrets))
            .await.map_err(|_| storage_error())?
    }).await
}

#[tauri::command]
pub async fn plugin_settings_forget(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    plugin_id: String,
    key: String,
) -> Result<(), PluginError> {
    let install = crate::local_plugin_install(&app)?;
    let id = plugin_id.clone();
    state.plugin.with_disabled_settings(&plugin_id, move || async move {
        let manifest = trusted_manifest(&install, &id).await?;
        tauri::async_runtime::spawn_blocking(move || forget(&entry(&id)?, &manifest, &key))
            .await.map_err(|_| storage_error())?
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin::{Action, Manifest};

    fn manifest(settings: BTreeMap<String, SettingsField>) -> Manifest {
        Manifest {
            id: "fake".into(), version: "0.1.0".into(), protocol_version: 1,
            actions: vec![Action { id: "play".into(), title: "Play".into(), config: BTreeMap::new() }],
            icons: None, icon: None, settings: Some(settings), values: None,
        }
    }
    fn settings() -> Manifest {
        manifest(BTreeMap::from([
            ("user".to_owned(), SettingsField::Text { label: "User".into() }),
            ("token".to_owned(), SettingsField::Secret { label: "Token".into() }),
        ]))
    }
    fn mock() -> Entry {
        Entry::new_with_credential(Box::new(keyring::mock::MockCredential::default()))
    }
    fn map(entries: &[(&str, &str)]) -> BTreeMap<String, String> {
        entries.iter().map(|(key, value)| ((*key).to_owned(), (*value).to_owned())).collect()
    }

    #[test]
    fn round_trip_keeps_secrets_out_of_the_ui_view() {
        let entry = mock();
        let manifest = settings();
        let empty = load_view(&entry, &manifest).unwrap();
        assert_eq!(empty.values, map(&[("user", "")]));
        assert_eq!(empty.secret_configured, BTreeMap::from([("token".to_owned(), false)]));

        save(&entry, &manifest, &map(&[("user", "alice")]), &map(&[("token", "top-secret")])).unwrap();
        let view = load_view(&entry, &manifest).unwrap();
        assert_eq!(view.values, map(&[("user", "alice")]));
        assert!(view.secret_configured["token"]);
        assert!(!serde_json::to_string(&view).unwrap().contains("top-secret"));
        assert_eq!(load_configured(&entry, &manifest).unwrap(), map(&[("user", "alice"), ("token", "top-secret")]));

        // Omitted secrets are unchanged; only the text value is replaced.
        save(&entry, &manifest, &map(&[("user", "bob")]), &BTreeMap::new()).unwrap();
        assert_eq!(load_configured(&entry, &manifest).unwrap(), map(&[("user", "bob"), ("token", "top-secret")]));

        forget(&entry, &manifest, "token").unwrap();
        assert!(!load_view(&entry, &manifest).unwrap().secret_configured["token"]);
        assert_eq!(load_configured(&entry, &manifest).unwrap_err().code, Some("settings_required"));
        forget(&entry, &manifest, "token").unwrap();
    }

    #[test]
    fn rejects_blank_or_unknown_values_without_writing() {
        let entry = mock();
        let manifest = settings();
        save(&entry, &manifest, &map(&[("user", "alice")]), &map(&[("token", "saved")])).unwrap();
        for (values, secrets) in [
            (map(&[("user", "alice")]), map(&[("token", "")])),
            (map(&[("user", "alice")]), map(&[("other", "x")])),
            (map(&[("user", "alice"), ("other", "x")]), BTreeMap::new()),
            (map(&[("other", "alice")]), BTreeMap::new()),
            (map(&[("user", "alice")]), map(&[("token", "x".repeat(MAX_SETTING_VALUE_BYTES + 1).as_str())])),
        ] {
            assert_eq!(save(&entry, &manifest, &values, &secrets).unwrap_err().code, Some("settings_invalid"));
        }
        assert_eq!(load_configured(&entry, &manifest).unwrap()["token"], "saved");
        assert_eq!(forget(&entry, &manifest, "user").unwrap_err().code, Some("settings_invalid"));
        assert!(load_view(&entry, &manifest).unwrap().secret_configured["token"]);
    }

    #[test]
    fn combined_budget_is_enforced_before_storage() {
        let entry = mock();
        let manifest = manifest(BTreeMap::from([
            ("one".to_owned(), SettingsField::Text { label: "One".into() }),
            ("two".to_owned(), SettingsField::Text { label: "Two".into() }),
        ]));
        let values = map(&[("one", "x".repeat(1200).as_str()), ("two", "y".repeat(1200).as_str())]);
        assert_eq!(save(&entry, &manifest, &values, &BTreeMap::new()).unwrap_err().code, Some("settings_invalid"));
        assert!(read(&entry).unwrap().empty());
    }

    #[test]
    fn schema_type_changes_never_reinterpret_the_other_value() {
        let entry = mock();
        let text_token = manifest(BTreeMap::from([("token".to_owned(), SettingsField::Text { label: "Token".into() })]));
        let secret_token = manifest(BTreeMap::from([("token".to_owned(), SettingsField::Secret { label: "Token".into() })]));

        // secret -> text: a stored credential is never shown, launched or replaced as text.
        save(&entry, &secret_token, &BTreeMap::new(), &map(&[("token", "old-secret")])).unwrap();
        let view = load_view(&entry, &text_token).unwrap();
        assert_eq!(view.values, map(&[("token", "")]));
        assert_eq!(view.secret_configured, BTreeMap::new());
        assert!(!serde_json::to_string(&view).unwrap().contains("old-secret"));
        assert_eq!(load_configured(&entry, &text_token).unwrap_err().code, Some("settings_required"));
        // Saving under the new schema drops the stale secret instead of keeping it hidden.
        save(&entry, &text_token, &map(&[("token", "alice")]), &BTreeMap::new()).unwrap();
        assert!(!entry.get_password().unwrap().contains("old-secret"));

        // text -> secret: a stored text value is never reinterpreted as a credential.
        assert!(!load_view(&entry, &secret_token).unwrap().secret_configured["token"]);
        assert_eq!(load_configured(&entry, &secret_token).unwrap_err().code, Some("settings_required"));
        save(&entry, &secret_token, &BTreeMap::new(), &map(&[("token", "new-secret")])).unwrap();
        let record = entry.get_password().unwrap();
        assert!(!record.contains("alice") && record.contains("new-secret"));
        assert_eq!(load_configured(&entry, &secret_token).unwrap(), map(&[("token", "new-secret")]));
    }

    #[test]
    fn credential_envelope_stays_within_its_byte_budget() {
        let entry = mock();
        let manifest = settings();
        save(&entry, &manifest, &map(&[("user", "u".repeat(100).as_str())]), &map(&[("token", "s".repeat(1000).as_str())])).unwrap();
        let record = entry.get_password().unwrap();
        assert!(record.encode_utf16().count() * 2 <= MAX_SETTINGS_BYTES);
        assert!(record.starts_with(r#"{"text":{"user":"#) && record.contains(r#""secrets":{"token":"#));
        assert_eq!(load_configured(&entry, &manifest).unwrap()["token"], "s".repeat(1000));
        // Envelope overhead counts against the same UTF-16 byte budget as before.
        let values = map(&[("user", "u".repeat(700).as_str())]);
        let secrets = map(&[("token", "s".repeat(1200).as_str())]);
        assert_eq!(save(&entry, &manifest, &values, &secrets).unwrap_err().code, Some("settings_invalid"));
        assert_eq!(load_configured(&entry, &manifest).unwrap()["token"], "s".repeat(1000), "a refused save keeps the previous credential");
    }

    #[test]
    fn legacy_untyped_records_fail_closed_without_migration() {
        let entry = mock();
        let manifest = settings();
        entry.set_password(r#"{"user":"alice","token":"old-secret"}"#).unwrap();
        assert_eq!(load_view(&entry, &manifest).unwrap_err().code, Some("settings_invalid"));
        assert_eq!(load_configured(&entry, &manifest).unwrap_err().code, Some("settings_invalid"));
        assert_eq!(save(&entry, &manifest, &map(&[("user", "alice")]), &BTreeMap::new()).unwrap_err().code, Some("settings_invalid"));
        // Forgetting a declared secret still clears the unusable record safely.
        forget(&entry, &manifest, "token").unwrap();
        assert_eq!(load_view(&entry, &manifest).unwrap().values["user"], "");
    }

    #[test]
    fn corrupt_and_oversized_records_fail_closed_and_are_recoverable() {
        let entry = mock();
        let manifest = settings();
        for record in ["not json".to_string(), r#"{"user":1}"#.into(), format!(r#"{{"user":"{}"}}"#, "x".repeat(3000)),
            r#"{"text":{"user":"alice"}}"#.into(),
            r#"{"text":{"user":"alice"},"secrets":{"user":"s"}}"#.into(),
            r#"{"text":{},"secrets":{},"extra":{}}"#.into(),
            r#"{"text":{"../user":"alice"},"secrets":{}}"#.into(),
            format!(r#"{{"text":{{"user":"{}"}},"secrets":{{}}}}"#, "x".repeat(MAX_SETTING_VALUE_BYTES + 1))] {
            entry.set_password(&record).unwrap();
            assert_eq!(load_view(&entry, &manifest).unwrap_err().code, Some("settings_invalid"));
            assert_eq!(load_configured(&entry, &manifest).unwrap_err().code, Some("settings_invalid"));
            assert_eq!(save(&entry, &manifest, &map(&[("user", "alice")]), &BTreeMap::new()).unwrap_err().code, Some("settings_invalid"));
        }
        entry.set_password("not json").unwrap();
        forget(&entry, &manifest, "token").unwrap();
        assert!(load_view(&entry, &manifest).unwrap().values["user"].is_empty());
    }

    #[test]
    fn storage_errors_are_fixed_and_never_expose_values() {
        let entry = mock();
        let manifest = settings();
        let credential = entry.get_credential().downcast_ref::<keyring::mock::MockCredential>().unwrap();
        for error in [Error::Invalid("secret".into(), "secret".into())] {
            credential.set_error(error);
            assert_eq!(load_view(&entry, &manifest).unwrap_err().code, Some("settings_unavailable"));
            credential.set_error(Error::Invalid("secret".into(), "secret".into()));
            assert_eq!(load_configured(&entry, &manifest).unwrap_err().code, Some("settings_unavailable"));
            credential.set_error(Error::Invalid("secret".into(), "secret".into()));
            assert_eq!(save(&entry, &manifest, &map(&[("user", "alice")]), &BTreeMap::new()).unwrap_err().code, Some("settings_unavailable"));
            credential.set_error(Error::Invalid("secret".into(), "secret".into()));
            assert_eq!(forget(&entry, &manifest, "token").unwrap_err().code, Some("settings_unavailable"));
        }
    }

    #[test]
    fn empty_declaration_is_an_empty_view_and_clears_storage() {
        let entry = mock();
        let manifest = manifest(BTreeMap::new());
        assert_eq!(load_view(&entry, &manifest).unwrap().values, BTreeMap::new());
        save(&entry, &manifest, &BTreeMap::new(), &BTreeMap::new()).unwrap();
        assert_eq!(load_configured(&entry, &manifest).unwrap(), BTreeMap::new());
        assert_eq!(forget(&entry, &manifest, "user").unwrap_err().code, Some("settings_invalid"));
    }

    #[test]
    fn undeclared_settings_are_refused() {
        let entry = mock();
        let legacy = Manifest { settings: None, ..settings() };
        assert_eq!(load_view(&entry, &legacy).unwrap_err().code, Some("settings_invalid"));
        assert_eq!(save(&entry, &legacy, &BTreeMap::new(), &BTreeMap::new()).unwrap_err().code, Some("settings_invalid"));
        assert_eq!(load_configured(&entry, &legacy).unwrap_err().code, Some("settings_invalid"));
    }
}
