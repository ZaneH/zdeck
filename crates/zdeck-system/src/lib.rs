//! Typed system audio and media adapter for the native desktop shell.
//!
//! Linux uses fixed wpctl/playerctl arguments (including on KDE Wayland).
//! macOS and Windows use a fixed native ABI, never Linux commands or a shell.
//! Both desktop and phone share validation, sanitized errors and readback.
//! Native media keys have no playback acknowledgement: sending one returns an
//! unknown outcome, never a fabricated confirmed state.

use std::future::Future;
use std::pin::Pin;
#[cfg(target_os = "linux")]
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod native;
pub mod media_permission;

/// PipeWire/WirePlumber identifiers for the default devices.
pub const DEFAULT_SINK: &str = "@DEFAULT_AUDIO_SINK@";
pub const DEFAULT_SOURCE: &str = "@DEFAULT_AUDIO_SOURCE@";

const WPCTL: &str = "wpctl";
const PLAYERCTL: &str = "playerctl";

/// Sanitized, typed errors returned to the frontend.
///
/// Every variant carries a message this module authored. Tool stderr and
/// process paths are never included.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SystemError {
    InvalidInput { message: String },
    Timeout { message: String },
    OutcomeUnknown { message: String },
    MediaKeySent { message: String },
    ToolMissing { message: String },
    NoDevice { message: String },
    NoPlayer { message: String },
    CommandFailed { message: String },
    UnexpectedOutput { message: String },
    Unsupported { message: String },
}

impl SystemError {
    fn invalid_input(message: impl Into<String>) -> Self {
        Self::InvalidInput {
            message: message.into(),
        }
    }

    fn timeout(message: impl Into<String>) -> Self {
        Self::Timeout {
            message: message.into(),
        }
    }

    fn outcome_unknown() -> Self {
        Self::OutcomeUnknown {
            message: "Action sent, but its resulting state could not be confirmed. Check before retrying.".to_string(),
        }
    }

    #[cfg(target_os = "linux")]
    fn tool_missing(message: impl Into<String>) -> Self {
        Self::ToolMissing {
            message: message.into(),
        }
    }

    fn no_device(message: impl Into<String>) -> Self {
        Self::NoDevice {
            message: message.into(),
        }
    }

    fn no_player(message: impl Into<String>) -> Self {
        Self::NoPlayer {
            message: message.into(),
        }
    }

    fn command_failed(message: impl Into<String>) -> Self {
        Self::CommandFailed {
            message: message.into(),
        }
    }

    fn unexpected_output(message: impl Into<String>) -> Self {
        Self::UnexpectedOutput {
            message: message.into(),
        }
    }

    // The Linux process runner is not the backend on other platforms.
    #[allow(dead_code)]
    fn unsupported(message: impl Into<String>) -> Self {
        Self::Unsupported {
            message: message.into(),
        }
    }

    fn message(&self) -> &str {
        match self {
            Self::InvalidInput { message }
            | Self::Timeout { message }
            | Self::OutcomeUnknown { message }
            | Self::MediaKeySent { message }
            | Self::ToolMissing { message }
            | Self::NoDevice { message }
            | Self::NoPlayer { message }
            | Self::CommandFailed { message }
            | Self::UnexpectedOutput { message }
            | Self::Unsupported { message } => message,
        }
    }
}

impl std::fmt::Display for SystemError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message())
    }
}

impl std::error::Error for SystemError {}

/// A fixed program and argument list. The program is a compile-time constant so
/// no caller can substitute an executable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandSpec {
    pub program: &'static str,
    pub args: Vec<String>,
}

impl CommandSpec {
    fn new(program: &'static str, args: &[&str]) -> Self {
        Self {
            program,
            args: args.iter().map(|arg| (*arg).to_string()).collect(),
        }
    }
}

/// The observable result of running a command. Stderr is discarded at the
/// process boundary and never parsed into user-facing text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunOutput {
    pub success: bool,
    pub stdout: String,
}

/// Bound timeout for one command.
#[derive(Debug, Clone, Copy)]
pub struct Timeouts {
    pub command: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            command: Duration::from_secs(4),
        }
    }
}

/// Injectable process runner.
///
/// The production implementation shells out with Tokio; tests inject an owned
/// fake. The trait is internal plumbing, not exposed through any Tauri command.
pub trait CommandRunner: Send + Sync + 'static {
    fn run<'a>(
        &'a self,
        spec: &'a CommandSpec,
    ) -> Pin<Box<dyn Future<Output = Result<RunOutput, SystemError>> + Send + 'a>>;
}

/// Real runner: Tokio process, fixed binary and arguments, no shell.
#[derive(Debug, Default, Clone, Copy)]
pub struct ProcessRunner;

impl CommandRunner for ProcessRunner {
    fn run<'a>(
        &'a self,
        spec: &'a CommandSpec,
    ) -> Pin<Box<dyn Future<Output = Result<RunOutput, SystemError>> + Send + 'a>> {
        Box::pin(async move {
            #[cfg(not(target_os = "linux"))]
            {
                let _ = spec;
                Err(SystemError::unsupported(
                    "The process backend is only used on Linux; this platform requires native system controls.",
                ))
            }

            #[cfg(target_os = "linux")]
            {
                let mut command = tokio::process::Command::new(spec.program);
                command
                    .args(&spec.args)
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null())
                    // A cancelled command (timeout) is killed and reaped by Tokio.
                    .kill_on_drop(true);

                let child = command.spawn().map_err(|error| {
                    if error.kind() == std::io::ErrorKind::NotFound {
                        SystemError::tool_missing(missing_tool_message(spec.program))
                    } else {
                        SystemError::command_failed("Could not start the system tool.")
                    }
                })?;

                match child.wait_with_output().await {
                    Ok(output) => Ok(RunOutput {
                        success: output.status.success(),
                        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                    }),
                    Err(_) => Err(SystemError::command_failed(
                        "The system tool failed to run.",
                    )),
                }
            }
        })
    }
}

#[cfg(target_os = "linux")]
fn missing_tool_message(program: &str) -> String {
    match program {
        WPCTL => "The wpctl audio tool (WirePlumber) is not installed.".to_string(),
        PLAYERCTL => "The playerctl media tool is not installed.".to_string(),
        _ => "A required system tool is not installed.".to_string(),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputSnapshot {
    /// Observed volume as a percentage. Never clamped: an OS boost above 100%
    /// is reported as-is rather than silently lowered.
    pub volume_percent: f64,
    pub muted: bool,
    pub observed_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrophoneSnapshot {
    pub muted: bool,
    pub observed_at_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaStatus {
    Playing,
    Paused,
    Stopped,
    /// Public media-key APIs do not expose a global playback snapshot.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSnapshot {
    pub status: MediaStatus,
    pub observed_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeApplyResult {
    pub requested: u32,
    /// True only when a fresh read reported the requested level.
    pub confirmed: bool,
    pub snapshot: OutputSnapshot,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MicrophoneApplyResult {
    pub requested: bool,
    /// True only when a fresh read reported the requested mute state.
    pub confirmed: bool,
    pub snapshot: MicrophoneSnapshot,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaApplyResult {
    /// The state a play/pause was expected to reach.
    pub requested: MediaStatus,
    /// True only when a fresh read reported that expected state.
    pub confirmed: bool,
    pub snapshot: MediaSnapshot,
}

/// Shared native system adapter. Reads are independent, so a missing media
/// player or audio tool cannot disable the other families.
pub struct SystemState {
    runner: Arc<dyn CommandRunner>,
    timeouts: Timeouts,
    // Injected runners keep exercising the Linux process protocol on every OS.
    native: bool,
}

impl Default for SystemState {
    fn default() -> Self {
        Self {
            runner: Arc::new(ProcessRunner),
            timeouts: Timeouts::default(),
            native: cfg!(any(target_os = "macos", target_os = "windows")),
        }
    }
}

impl SystemState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_runner(runner: Arc<dyn CommandRunner>) -> Self {
        Self {
            runner,
            timeouts: Timeouts::default(),
            native: false,
        }
    }

    pub fn with_runner_and_timeouts(runner: Arc<dyn CommandRunner>, timeouts: Timeouts) -> Self {
        Self {
            runner,
            timeouts,
            native: false,
        }
    }

    /// Run one fixed command under the configured timeout. A timed-out child is
    /// cancelled; `ProcessRunner` kills and reaps it on drop.
    async fn exec(&self, spec: CommandSpec) -> Result<RunOutput, SystemError> {
        let future = self.runner.run(&spec);
        match tokio::time::timeout(self.timeouts.command, future).await {
            Ok(result) => result,
            Err(_) => Err(SystemError::timeout(
                "The system tool did not respond in time.",
            )),
        }
    }

    pub async fn output_snapshot(&self) -> Result<OutputSnapshot, SystemError> {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if self.native {
            let (volume_percent, muted) =
                native::run(native::Operation::ReadOutput, 0, self.timeouts.command).await?;
            return Ok(OutputSnapshot {
                volume_percent,
                muted,
                observed_at_ms: now_ms(),
            });
        }
        let output = self
            .exec(CommandSpec::new(WPCTL, &["get-volume", DEFAULT_SINK]))
            .await?;
        if !output.success {
            return Err(SystemError::no_device(
                "No default audio output device is available.",
            ));
        }
        let (volume_percent, muted) = parse_wpctl_volume(&output.stdout)?;
        Ok(OutputSnapshot {
            volume_percent,
            muted,
            observed_at_ms: now_ms(),
        })
    }

    /// Set the default output volume and confirm it with a fresh read.
    ///
    /// The level is validated to a finite value in `0..=100`; no overdrive is
    /// requested even though `wpctl` accepts levels above 100%.
    pub async fn set_output_volume(&self, volume: f64) -> Result<VolumeApplyResult, SystemError> {
        if !volume.is_finite() {
            return Err(SystemError::invalid_input("Volume must be a number."));
        }
        if !(0.0..=100.0).contains(&volume) {
            return Err(SystemError::invalid_input(
                "Volume must be between 0 and 100.",
            ));
        }
        let requested = volume.round() as u32;
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if self.native {
            let (volume_percent, muted) = native::run(
                native::Operation::SetOutput,
                requested as i32,
                self.timeouts.command,
            ).await?;
            return Ok(VolumeApplyResult {
                requested,
                confirmed: (volume_percent - f64::from(requested)).abs() < 0.5,
                snapshot: OutputSnapshot {
                    volume_percent,
                    muted,
                    observed_at_ms: now_ms(),
                },
            });
        }
        let percent = format!("{requested}%");
        let output = self
            .exec(CommandSpec::new(
                WPCTL,
                &["set-volume", DEFAULT_SINK, percent.as_str()],
            ))
            .await?;
        if !output.success {
            return Err(SystemError::no_device(
                "No default audio output device is available.",
            ));
        }

        let snapshot = self
            .output_snapshot()
            .await
            .map_err(|_| SystemError::outcome_unknown())?;
        let confirmed = (snapshot.volume_percent - f64::from(requested)).abs() < 0.5;
        Ok(VolumeApplyResult {
            requested,
            confirmed,
            snapshot,
        })
    }

    pub async fn microphone_snapshot(&self) -> Result<MicrophoneSnapshot, SystemError> {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if self.native {
            let (_, muted) =
                native::run(native::Operation::ReadMic, 0, self.timeouts.command).await?;
            return Ok(MicrophoneSnapshot {
                muted,
                observed_at_ms: now_ms(),
            });
        }
        let output = self
            .exec(CommandSpec::new(WPCTL, &["get-volume", DEFAULT_SOURCE]))
            .await?;
        if !output.success {
            return Err(SystemError::no_device(
                "No default audio input device is available.",
            ));
        }
        let (_, muted) = parse_wpctl_volume(&output.stdout)?;
        Ok(MicrophoneSnapshot {
            muted,
            observed_at_ms: now_ms(),
        })
    }

    /// Set the default input mute state explicitly and confirm it with a fresh
    /// read. The boolean target avoids a blind toggle on an unknown state.
    pub async fn set_microphone_muted(
        &self,
        muted: bool,
    ) -> Result<MicrophoneApplyResult, SystemError> {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if self.native {
            let (_, observed) = native::run(
                native::Operation::SetMic,
                i32::from(muted),
                self.timeouts.command,
            ).await?;
            return Ok(MicrophoneApplyResult {
                requested: muted,
                confirmed: observed == muted,
                snapshot: MicrophoneSnapshot {
                    muted: observed,
                    observed_at_ms: now_ms(),
                },
            });
        }
        let flag = if muted { "1" } else { "0" };
        let output = self
            .exec(CommandSpec::new(WPCTL, &["set-mute", DEFAULT_SOURCE, flag]))
            .await?;
        if !output.success {
            return Err(SystemError::no_device(
                "No default audio input device is available.",
            ));
        }

        let snapshot = self
            .microphone_snapshot()
            .await
            .map_err(|_| SystemError::outcome_unknown())?;
        let confirmed = snapshot.muted == muted;
        Ok(MicrophoneApplyResult {
            requested: muted,
            confirmed,
            snapshot,
        })
    }

    pub async fn media_snapshot(&self) -> Result<MediaSnapshot, SystemError> {
        if self.native {
            return Ok(MediaSnapshot {
                status: MediaStatus::Unknown,
                observed_at_ms: now_ms(),
            });
        }
        let output = self.exec(CommandSpec::new(PLAYERCTL, &["status"])).await?;
        if !output.success {
            return Err(SystemError::no_player("No media player is available."));
        }
        let status = parse_media_status(&output.stdout)?;
        Ok(MediaSnapshot {
            status,
            observed_at_ms: now_ms(),
        })
    }

    /// Linux reads MPRIS state before/after. Native media keys cannot confirm
    /// playback, so a fully sent key returns MediaKeySent and is never replayed.
    pub async fn media_play_pause(&self) -> Result<MediaApplyResult, SystemError> {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if self.native {
            native::run(native::Operation::PlayPause, 0, self.timeouts.command).await?;
            return Err(SystemError::outcome_unknown());
        }
        let before = self.media_snapshot().await?;
        let requested = match before.status {
            MediaStatus::Playing => MediaStatus::Paused,
            MediaStatus::Paused | MediaStatus::Stopped => MediaStatus::Playing,
            MediaStatus::Unknown => {
                return Err(SystemError::unexpected_output("Media state is unavailable."));
            }
        };

        let output = self
            .exec(CommandSpec::new(PLAYERCTL, &["play-pause"]))
            .await?;
        if !output.success {
            return Err(SystemError::no_player("No media player is available."));
        }

        let snapshot = self
            .media_snapshot()
            .await
            .map_err(|_| SystemError::outcome_unknown())?;
        let confirmed = snapshot.status == requested;
        Ok(MediaApplyResult {
            requested,
            confirmed,
            snapshot,
        })
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Parse `wpctl get-volume` output such as `Volume: 0.50` or
/// `Volume: 0.25 [MUTED]`. Returns the percentage (unclamped) and mute flag.
fn parse_wpctl_volume(stdout: &str) -> Result<(f64, bool), SystemError> {
    let line = stdout
        .lines()
        .find(|line| line.trim_start().starts_with("Volume:"))
        .ok_or_else(|| {
            SystemError::unexpected_output("Could not read the audio volume from wpctl.")
        })?;
    let rest = line.trim_start().trim_start_matches("Volume:").trim_start();
    let raw = rest
        .split_whitespace()
        .next()
        .ok_or_else(|| SystemError::unexpected_output("Could not read the audio volume."))?;
    let volume = raw.parse::<f64>().map_err(|_| {
        SystemError::unexpected_output("Could not read the audio volume from wpctl.")
    })?;
    if !volume.is_finite() || volume < 0.0 {
        return Err(SystemError::unexpected_output(
            "wpctl reported an unexpected audio volume.",
        ));
    }
    Ok((volume * 100.0, rest.contains("[MUTED]")))
}

fn parse_media_status(stdout: &str) -> Result<MediaStatus, SystemError> {
    match stdout.trim() {
        "Playing" => Ok(MediaStatus::Playing),
        "Paused" => Ok(MediaStatus::Paused),
        "Stopped" => Ok(MediaStatus::Stopped),
        _ => Err(SystemError::unexpected_output(
            "Could not understand the media player status.",
        )),
    }
}
