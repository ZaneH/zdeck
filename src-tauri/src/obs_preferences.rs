use keyring::{Entry, Error};
use serde::{Deserialize, Serialize};

const STORAGE_ERROR: &str = "Could not access the saved OBS connection in secure storage.";
const INVALID_ERROR: &str = "The saved OBS connection is invalid. Forget it and save a new connection.";
// JSON can escape each password byte into at most six bytes.
const MAX_RECORD_BYTES: usize = 4096 * 6 + 64;

#[derive(Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ObsPreferences {
    port: u16,
    password: String,
}

impl ObsPreferences {
    fn validate(&self) -> Result<(), String> {
        if self.port == 0 || self.password.len() > 4096 {
            return Err("Use an OBS port from 1 to 65535 and a password of at most 4096 bytes.".into());
        }
        Ok(())
    }
}

fn entry() -> Result<Entry, String> {
    Entry::new("com.zdeck.obs", "connection-v1").map_err(|_| STORAGE_ERROR.into())
}

fn load(entry: &Entry) -> Result<Option<ObsPreferences>, String> {
    let record = match entry.get_password() {
        Ok(record) => record,
        Err(Error::NoEntry) => return Ok(None),
        Err(_) => return Err(STORAGE_ERROR.into()),
    };
    if record.len() > MAX_RECORD_BYTES {
        return Err(INVALID_ERROR.into());
    }
    let preferences: ObsPreferences = serde_json::from_str(&record).map_err(|_| INVALID_ERROR.to_string())?;
    preferences.validate().map_err(|_| INVALID_ERROR.to_string())?;
    Ok(Some(preferences))
}

fn save(entry: &Entry, preferences: ObsPreferences) -> Result<(), String> {
    preferences.validate()?;
    let record = serde_json::to_string(&preferences).map_err(|_| STORAGE_ERROR.to_string())?;
    entry.set_password(&record).map_err(|_| STORAGE_ERROR.into())
}

fn forget(entry: &Entry) -> Result<(), String> {
    match entry.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(_) => Err(STORAGE_ERROR.into()),
    }
}

#[tauri::command]
pub async fn obs_load_preferences() -> Result<Option<ObsPreferences>, String> {
    tauri::async_runtime::spawn_blocking(|| load(&entry()?))
        .await.map_err(|_| STORAGE_ERROR.to_string())?
}

#[tauri::command]
pub async fn obs_save_preferences(port: u16, password: String) -> Result<(), String> {
    let preferences = ObsPreferences { port, password };
    preferences.validate()?;
    tauri::async_runtime::spawn_blocking(move || save(&entry()?, preferences))
        .await.map_err(|_| STORAGE_ERROR.to_string())?
}

#[tauri::command]
pub async fn obs_forget_preferences() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| forget(&entry()?))
        .await.map_err(|_| STORAGE_ERROR.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mock() -> Entry {
        Entry::new_with_credential(Box::new(keyring::mock::MockCredential::default()))
    }

    #[test]
    fn round_trip_and_forget() {
        let entry = mock();
        assert!(load(&entry).unwrap().is_none());
        save(&entry, ObsPreferences { port: 4455, password: "test password".into() }).unwrap();
        let loaded = load(&entry).unwrap().unwrap();
        assert_eq!(loaded.port, 4455);
        assert_eq!(loaded.password, "test password");
        forget(&entry).unwrap();
        forget(&entry).unwrap();
        assert!(load(&entry).unwrap().is_none());
    }

    #[test]
    fn validates_bounds_and_corrupt_records() {
        let entry = mock();
        for (port, password) in [(0, String::new()), (1, "é".repeat(2049))] {
            assert!(save(&entry, ObsPreferences { port, password }).is_err());
        }
        save(&entry, ObsPreferences { port: 65535, password: "é".repeat(2048) }).unwrap();
        for record in ["not json".to_string(), "{\"port\":0,\"password\":\"\"}".into(), "x".repeat(MAX_RECORD_BYTES + 1)] {
            entry.set_password(&record).unwrap();
            assert!(load(&entry).is_err());
        }
    }

    #[test]
    fn storage_errors_are_sanitized_not_missing() {
        let entry = mock();
        let credential = entry.get_credential().downcast_ref::<keyring::mock::MockCredential>().unwrap();
        credential.set_error(Error::Invalid("secret".into(), "secret".into()));
        assert_eq!(load(&entry).err().unwrap(), STORAGE_ERROR);
        credential.set_error(Error::Invalid("secret".into(), "secret".into()));
        assert_eq!(forget(&entry).unwrap_err(), STORAGE_ERROR);
        credential.set_error(Error::Invalid("secret".into(), "secret".into()));
        assert_eq!(save(&entry, ObsPreferences { port: 4455, password: "secret".into() }).unwrap_err(), STORAGE_ERROR);
    }
}
