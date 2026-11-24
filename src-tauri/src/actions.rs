//! Saved-control execution shared by native user gestures and authenticated
//! phone requests. No transport can supply an action, executable, or plugin args.

use std::{collections::HashMap, sync::Arc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{Mutex, Semaphore};
use crate::deck::{Control, ControlAction, Deck, DeckStore};
use crate::obs::{ObsError, ObsState};
use crate::plugin::{ErrorKind as PluginErrorKind, Outcome as PluginOutcome, PluginError, PluginRegistry};
use crate::system::{SystemError, SystemState};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub id: String,
    pub state: CommandState,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<&'static str>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandState { Pending, Confirmed, NotApplied, Failed, Unknown }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionErrorCode {
    InvalidRequest, DeckUnavailable, StaleRevision, ControlNotFound,
    CommandConflict, Busy, Capacity,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ActionError { pub code: ActionErrorCode, pub message: &'static str }
impl ActionError {
    pub(crate) fn new(code: ActionErrorCode) -> Self {
        let message = match code {
            ActionErrorCode::InvalidRequest => "Invalid saved-control request.",
            ActionErrorCode::DeckUnavailable => "Save a valid native deck before running controls.",
            ActionErrorCode::StaleRevision => "The saved deck changed. Load a fresh snapshot before sending actions.",
            ActionErrorCode::ControlNotFound => "The control is not in the saved deck.",
            ActionErrorCode::CommandConflict => "This command ID was already used with different input.",
            ActionErrorCode::Busy => "Too many actions are in flight.",
            ActionErrorCode::Capacity => "The desktop command registry is full. Restart the app before running more controls.",
        };
        Self { code, message }
    }
    fn invalid(message: &'static str) -> Self { Self { code: ActionErrorCode::InvalidRequest, message } }
}
impl std::fmt::Display for ActionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(self.message) }
}
impl std::error::Error for ActionError {}

/// Missing is allowed; explicit null, strings and non-numbers are not.
pub(crate) fn command_value<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    f64::deserialize(d).map(Some)
}

pub(crate) fn validate_command_fields(id: &str, control_id: &str, value: Option<f64>) -> Result<(), ActionError> {
    fn valid_id(s: &str) -> bool { !s.is_empty() && s.len() <= 128 && !s.chars().any(char::is_control) }
    if !valid_id(id) { return Err(ActionError::invalid("The command ID is invalid.")); }
    if !valid_id(control_id) { return Err(ActionError::invalid("The control ID is invalid.")); }
    if value.is_some_and(|v| !v.is_finite() || !(0.0..=100.0).contains(&v)) {
        return Err(ActionError::invalid("Volume must be a finite number between 0 and 100."));
    }
    Ok(())
}
pub(crate) fn find_control<'a>(deck: &'a Deck, id: &str) -> Option<&'a Control> {
    deck.pages.iter().flat_map(|page| &page.controls).find(|control| control.id == id)
}
pub(crate) fn validate_action_value(control: &Control, value: Option<f64>) -> Result<(), ActionError> {
    match control.action {
        ControlAction::Volume { .. } => {
            if value.is_some_and(|v| !v.is_finite() || !(0.0..=100.0).contains(&v)) {
                return Err(ActionError::invalid("Volume must be a finite number between 0 and 100."));
            }
        }
        _ if value.is_some() => return Err(ActionError::invalid("Only a volume control accepts a value.")),
        _ => (),
    }
    Ok(())
}

/// The SAME dispatcher is held by AppState and the phone service, serializing
/// read/modify/read sequences across both transports. Adapters own deadlines;
/// no outer timeout drops a possibly executing plugin or repeats an action.
pub struct ActionDispatcher {
    obs: Arc<ObsState>,
    system: Arc<SystemState>,
    plugin: Arc<PluginRegistry>,
    effect: Mutex<()>,
}
impl ActionDispatcher {
    pub fn new(obs: Arc<ObsState>, system: Arc<SystemState>, plugin: Arc<PluginRegistry>) -> Self {
        Self { obs, system, plugin, effect: Mutex::new(()) }
    }
    /// Rust-only dispatcher. Transports must resolve the control from DeckStore
    /// and bound admission before calling; this is not a frontend action API.
    pub async fn execute(&self, id: &str, control: &Control, value: Option<f64>) -> Result<CommandResult, ActionError> {
        validate_command_fields(id, &control.id, value)?;
        validate_action_value(control, value)?;
        let _effect = self.effect.lock().await;
        let result = match &control.action {
            ControlAction::ObsScene { scene } => match self.obs.switch_scene(scene).await {
                Ok(outcome) => CommandResult {
                    id: id.to_string(),
                    state: if outcome.confirmed { CommandState::Confirmed } else { CommandState::NotApplied },
                    message: if outcome.confirmed { "Action confirmed." } else { "OBS did not report the requested scene." }.to_string(),
                    code: None,
                    observed: serde_json::to_value(&outcome).ok(),
                },
                Err(error) => obs_error_result(id, error),
            },
            ControlAction::MicMute => match self.system.microphone_snapshot().await {
                Ok(before) => match self.system.set_microphone_muted(!before.muted).await {
                    Ok(outcome) => CommandResult {
                        id: id.to_string(),
                        state: if outcome.confirmed { CommandState::Confirmed } else { CommandState::NotApplied },
                        message: if outcome.confirmed { "Action confirmed." } else { "The microphone did not report the requested mute state." }.to_string(),
                        code: None,
                        observed: serde_json::to_value(&outcome).ok(),
                    },
                    Err(error) => system_error_result(id, error),
                },
                Err(error) => failed_result(id, error.to_string()),
            },
            ControlAction::MediaPlayPause => match self.system.media_play_pause().await {
                Ok(outcome) => CommandResult {
                    id: id.to_string(),
                    state: if outcome.confirmed { CommandState::Confirmed } else { CommandState::NotApplied },
                    message: if outcome.confirmed { "Action confirmed." } else { "The media player did not report the expected state." }.to_string(),
                    code: None,
                    observed: serde_json::to_value(&outcome).ok(),
                },
                Err(error) => system_error_result(id, error),
            },
            ControlAction::Plugin { plugin_id, plugin_action, plugin_args } => {
                match self.plugin.execute(plugin_id.clone(), plugin_action.clone(), Value::Object(plugin_args.clone())).await {
                    Ok(snapshot) => CommandResult {
                        id: id.to_string(), state: CommandState::Confirmed,
                        message: "Plugin action completed and state was read.".to_string(),
                        observed: snapshot.state.map(Value::Object), code: None,
                    },
                    Err(error) => plugin_error_result(id, error),
                }
            }
            ControlAction::Volume { volume } => {
                match self.system.set_output_volume(value.unwrap_or(*volume)).await {
                    Ok(outcome) => CommandResult {
                        id: id.to_string(),
                        state: if outcome.confirmed { CommandState::Confirmed } else { CommandState::NotApplied },
                        message: if outcome.confirmed { "Action confirmed." } else { "The output volume did not report the requested level." }.to_string(),
                        code: None,
                        observed: serde_json::to_value(&outcome).ok(),
                    },
                    Err(error) => system_error_result(id, error),
                }
            }
        };
        Ok(result)
    }
}
fn failed_result(id: &str, message: String) -> CommandResult {
    CommandResult { id: id.to_string(), state: CommandState::Failed, code: None, message, observed: None }
}
fn plugin_error_result(id: &str, error: PluginError) -> CommandResult {
    let (state, code, message) = if error.outcome == PluginOutcome::Unknown {
        (CommandState::Unknown, "plugin_outcome_unknown", "Plugin action may have executed. Inspect state before manually retrying.")
    } else if matches!(error.kind, PluginErrorKind::Unavailable | PluginErrorKind::Stopped) {
        (CommandState::Failed, "plugin_unavailable", "Connect the trusted plugin in the desktop app first.")
    } else {
        (CommandState::Failed, "plugin_setup_required", "Check the plugin connection and saved action configuration in the desktop app.")
    };
    CommandResult { id: id.to_string(), state, code: Some(code), message: message.to_string(), observed: None }
}
fn obs_error_result(id: &str, error: ObsError) -> CommandResult {
    let state = match error {
        ObsError::Timeout { .. } | ObsError::Disconnected { .. } | ObsError::RequestFailed { .. } => CommandState::Unknown,
        _ => CommandState::Failed,
    };
    CommandResult { id: id.to_string(), state, message: error.to_string(), code: None, observed: None }
}
fn system_error_result(id: &str, error: SystemError) -> CommandResult {
    let code = matches!(&error, SystemError::Unsupported { .. }).then_some("platform_unsupported");
    let state = match error {
        SystemError::Timeout { .. } | SystemError::OutcomeUnknown { .. } => CommandState::Unknown,
        _ => CommandState::Failed,
    };
    CommandResult { id: id.to_string(), state, message: error.to_string(), code, observed: None }
}
#[cfg(test)]
mod platform_tests {
    use super::*;
    #[test]
    fn unsupported_system_actions_keep_a_machine_readable_reason() {
        let result = system_error_result("test", SystemError::Unsupported { message: "Linux only".into() });
        assert_eq!(result.state, CommandState::Failed);
        assert_eq!(result.code, Some("platform_unsupported"));
    }
}
pub(crate) fn interrupted_result(id: &str, plugin: bool) -> CommandResult {
    CommandResult {
        id: id.to_string(), state: CommandState::Unknown,
        code: plugin.then_some("plugin_outcome_unknown"),
        message: "The action was interrupted before its result was recorded.".to_string(), observed: None,
    }
}
fn pending_result(id: &str) -> CommandResult {
    CommandResult { id: id.to_string(), state: CommandState::Pending, code: None, message: "Action accepted.".to_string(), observed: None }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopCommand {
    pub command_id: String,
    pub revision: u64,
    pub control_id: String,
    #[serde(default, deserialize_with = "command_value")]
    pub value: Option<f64>,
}
#[derive(Clone)]
struct DesktopRecord { control_id: String, value: Option<f64>, result: CommandResult }
type Records = Arc<Mutex<HashMap<String, DesktopRecord>>>;

/// Native-only admission/dedup. This deliberately has no device/auth registry.
/// IDs are never evicted/reused during the session: a full registry fails closed
/// instead of allowing an old uncertain action to execute again.
pub struct DesktopActions {
    dispatcher: Arc<ActionDispatcher>,
    records: Records,
    slots: Arc<Semaphore>,
}
impl DesktopActions {
    pub const CAPACITY: usize = 4096;
    pub const MAX_INFLIGHT: usize = 4;
    pub fn new(dispatcher: Arc<ActionDispatcher>) -> Self {
        Self { dispatcher, records: Arc::new(Mutex::new(HashMap::new())), slots: Arc::new(Semaphore::new(Self::MAX_INFLIGHT)) }
    }
    pub async fn run(&self, store: &DeckStore, command: DesktopCommand) -> Result<CommandResult, ActionError> {
        validate_command_fields(&command.command_id, &command.control_id, command.value)?;
        if let Some(result) = self.existing(&command).await? { return Ok(result); }
        let permit = self.slots.clone().try_acquire_owned().map_err(|_| ActionError::new(ActionErrorCode::Busy))?;
        let snapshot = store.load().await.map_err(|_| ActionError::new(ActionErrorCode::DeckUnavailable))?;
        if !snapshot.exists { return Err(ActionError::new(ActionErrorCode::DeckUnavailable)); }
        if snapshot.revision != command.revision { return Err(ActionError::new(ActionErrorCode::StaleRevision)); }
        let control = find_control(&snapshot.deck, &command.control_id).ok_or_else(|| ActionError::new(ActionErrorCode::ControlNotFound))?.clone();
        validate_action_value(&control, command.value)?;
        let plugin = matches!(&control.action, ControlAction::Plugin { .. });
        let mut records = self.records.lock().await;
        if let Some(record) = records.get(&command.command_id) { return Self::matching(record, &command); }
        if records.len() >= Self::CAPACITY { return Err(ActionError::new(ActionErrorCode::Capacity)); }
        records.insert(command.command_id.clone(), DesktopRecord {
            control_id: command.control_id.clone(), value: command.value, result: pending_result(&command.command_id),
        });
        drop(records);
        // No await between reservation and spawn: caller cancellation cannot
        // abandon an admitted ID, mutation, permit or eventual result update.
        let dispatcher = self.dispatcher.clone();
        let records = self.records.clone();
        let id = command.command_id.clone();
        let worker = tokio::spawn(async move {
            let mut guard = DesktopGuard { records: records.clone(), id: command.command_id.clone(), plugin, complete: false };
            let _permit = permit;
            let result = dispatcher.execute(&command.command_id, &control, command.value).await;
            if let Some(record) = records.lock().await.get_mut(&command.command_id) {
                record.result = result.clone().unwrap_or_else(|_| interrupted_result(&command.command_id, plugin));
            }
            guard.complete = true;
            result
        });
        worker.await.unwrap_or_else(|_| Ok(interrupted_result(&id, plugin)))
    }
    fn matching(record: &DesktopRecord, command: &DesktopCommand) -> Result<CommandResult, ActionError> {
        // Revision is excluded, just as on the phone: a duplicate can retrieve
        // its result after a save, but can never run again against new bindings.
        if record.control_id != command.control_id || record.value != command.value {
            return Err(ActionError::new(ActionErrorCode::CommandConflict));
        }
        Ok(record.result.clone())
    }
    async fn existing(&self, command: &DesktopCommand) -> Result<Option<CommandResult>, ActionError> {
        self.records.lock().await.get(&command.command_id).map(|r| Self::matching(r, command)).transpose()
    }
}
struct DesktopGuard { records: Records, id: String, plugin: bool, complete: bool }
impl Drop for DesktopGuard {
    fn drop(&mut self) {
        if self.complete { return; }
        let records = self.records.clone();
        let id = self.id.clone();
        let plugin = self.plugin;
        tokio::spawn(async move {
            if let Some(record) = records.lock().await.get_mut(&id) {
                if record.result.state == CommandState::Pending { record.result = interrupted_result(&id, plugin); }
            }
        });
    }
}
