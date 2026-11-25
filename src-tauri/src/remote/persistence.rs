//! Versioned, bounded trust allowlist, separate from the user's deck.
use super::*;
use std::io::{Read, Write};
use std::path::PathBuf;

pub(super) const FILE_NAME: &str = "remote.v1.json";
const MAX_BYTES: u64 = 64 * 1024;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SavedState {
    pub version: u8,
    pub enabled: bool,
    pub origin: Option<String>,
    pub mode: ConnectionMode,
    pub approved: Vec<SavedDevice>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SavedDevice {
    pub hash: [u8; 32],
    pub request_id: String,
    pub name: String,
    pub created_at_ms: u64,
}

pub(super) struct TrustStore {
    path: Option<PathBuf>,
    pub state: Result<SavedState, RemoteError>,
}

pub(super) fn storage_error() -> RemoteError {
    RemoteError::Unavailable { message: "Phone settings could not be loaded or saved. Check app-data permissions and remote.v1.json (back it up before repairing or moving an invalid file), then restart zDeck. No approvals were saved by the failed operation.".into() }
}

impl Default for TrustStore {
    fn default() -> Self {
        Self { path: None, state: Ok(SavedState { version: 1, ..SavedState::default() }) }
    }
}

impl TrustStore {
    pub fn open(path: PathBuf) -> Self {
        let state = (|| {
            let file = match std::fs::File::open(&path) {
                Ok(file) => file,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(SavedState { version: 1, ..SavedState::default() }),
                Err(_) => return Err(storage_error()),
            };
            let mut bytes = Vec::new();
            file.take(MAX_BYTES + 1).read_to_end(&mut bytes).map_err(|_| storage_error())?;
            if bytes.len() as u64 > MAX_BYTES { return Err(storage_error()); }
            let state: SavedState = serde_json::from_slice(&bytes).map_err(|_| storage_error())?;
            Self::validate(&state)?;
            Ok(state)
        })();
        Self { path: Some(path), state }
    }

    fn validate(state: &SavedState) -> Result<(), RemoteError> {
        if state.version != 1 || state.approved.len() > Limits::default().max_approved
            || (state.origin.is_none() && (state.enabled || !state.approved.is_empty())) {
            return Err(storage_error());
        }
        if let Some(origin) = &state.origin {
            let url = validate_origin(origin, state.mode).map_err(|_| storage_error())?;
            if url.origin().ascii_serialization() != *origin { return Err(storage_error()); }
        }
        let mut hashes = std::collections::HashSet::new();
        let mut ids = std::collections::HashSet::new();
        for d in &state.approved {
            if d.request_id.len() != 32 || !d.request_id.bytes().all(|b| b.is_ascii_hexdigit())
                || d.name.is_empty() || d.name.len() > 64 || d.name.trim() != d.name || d.name.chars().any(char::is_control)
                || d.created_at_ms == 0 || d.created_at_ms.checked_add(SESSION_MS).is_none()
                || !hashes.insert(d.hash) || !ids.insert(&d.request_id) {
                return Err(storage_error());
            }
        }
        Ok(())
    }

    pub fn save(&mut self, state: SavedState) -> Result<(), RemoteError> {
        self.state.as_ref().map_err(Clone::clone)?;
        Self::validate(&state)?;
        if let Some(path) = &self.path {
            let bytes = serde_json::to_vec(&state).map_err(|_| storage_error())?;
            if bytes.len() as u64 > MAX_BYTES { return Err(storage_error()); }
            let parent = path.parent().ok_or_else(storage_error)?;
            std::fs::create_dir_all(parent).map_err(|_| storage_error())?;
            let temp = parent.join(format!(".remote.{}.{}.tmp", std::process::id(), random_hex(16).map_err(|_| storage_error())?));
            let mut created = false;
            let result = (|| -> std::io::Result<()> {
                let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
                created = true;
                file.write_all(&bytes)?;
                file.flush()?;
                file.sync_all()?;
                drop(file);
                std::fs::rename(&temp, path)?;
                // shortcut: like DeckStore, directory sync is best-effort; upgrade if power-loss durability is required.
                if let Ok(dir) = std::fs::File::open(parent) { let _ = dir.sync_all(); }
                Ok(())
            })();
            if result.is_err() && created { let _ = std::fs::remove_file(&temp); }
            result.map_err(|_| storage_error())?;
        }
        self.state = Ok(state);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trust_scope_and_records_are_bounded_and_validated() {
        let device = SavedDevice {
            hash: [7; 32], request_id: "a".repeat(32), name: "Phone".into(),
            created_at_ms: 1_700_000_000_000,
        };
        let valid = SavedState {
            version: 1, enabled: true, origin: Some("https://deck.tailnet.ts.net".into()),
            mode: ConnectionMode::Tailscale, approved: vec![device.clone()],
        };
        assert!(TrustStore::validate(&valid).is_ok());
        let mut bad = valid.clone(); bad.origin = None;
        assert!(TrustStore::validate(&bad).is_err());
        let mut bad = valid.clone(); bad.origin = Some("HTTPS://DECK.TAILNET.TS.NET:443/".into());
        assert!(TrustStore::validate(&bad).is_err());
        let mut bad = valid.clone(); bad.approved.push(device.clone());
        assert!(TrustStore::validate(&bad).is_err());
        let mut bad = valid.clone(); bad.approved = vec![device.clone(); 33];
        assert!(TrustStore::validate(&bad).is_err());
        for name in ["", " Phone", "Phone\n", &"x".repeat(65)] {
            let mut bad = valid.clone(); bad.approved[0].name = name.into();
            assert!(TrustStore::validate(&bad).is_err());
        }
        let mut bad = valid.clone(); bad.approved[0].created_at_ms = u64::MAX;
        assert!(TrustStore::validate(&bad).is_err());
        let mut bad = valid; bad.approved[0].request_id = "not-an-id".into();
        assert!(TrustStore::validate(&bad).is_err());
    }
}
