//! Adapter tests for the system audio/media actions.
//!
//! These use an owned fake runner, so no real `wpctl`/`playerctl` process is
//! started and no live machine state (volume, mute, playback) is touched. One
//! test exercises the real `ProcessRunner` only to prove timeout cancellation.

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use deck_lib::system::{
    CommandRunner, CommandSpec, MediaStatus, RunOutput, SystemError, SystemState, Timeouts,
    DEFAULT_SINK, DEFAULT_SOURCE,
};

/// Owned fake runner: returns queued responses in order and records every call.
struct FakeRunner {
    queue: Mutex<VecDeque<Result<RunOutput, SystemError>>>,
    calls: Mutex<Vec<CommandSpec>>,
    delay: Duration,
}

impl FakeRunner {
    fn new(responses: Vec<Result<RunOutput, SystemError>>) -> Self {
        Self {
            queue: Mutex::new(responses.into()),
            calls: Mutex::new(Vec::new()),
            delay: Duration::ZERO,
        }
    }

    fn slow(delay: Duration) -> Self {
        Self {
            queue: Mutex::new(VecDeque::new()),
            calls: Mutex::new(Vec::new()),
            delay,
        }
    }

    fn calls(&self) -> Vec<CommandSpec> {
        self.calls.lock().unwrap().clone()
    }
}

impl CommandRunner for FakeRunner {
    fn run<'a>(
        &'a self,
        spec: &'a CommandSpec,
    ) -> Pin<Box<dyn Future<Output = Result<RunOutput, SystemError>> + Send + 'a>> {
        let spec = spec.clone();
        Box::pin(async move {
            self.calls.lock().unwrap().push(spec);
            if !self.delay.is_zero() {
                tokio::time::sleep(self.delay).await;
            }
            self.queue
                .lock()
                .unwrap()
                .pop_front()
                .expect("fake runner ran out of responses")
        })
    }
}

fn ok(stdout: &str) -> Result<RunOutput, SystemError> {
    Ok(RunOutput {
        success: true,
        stdout: stdout.to_string(),
    })
}

fn nonzero() -> Result<RunOutput, SystemError> {
    Ok(RunOutput {
        success: false,
        stdout: String::new(),
    })
}

fn test_state(fake: Arc<FakeRunner>) -> SystemState {
    SystemState::with_runner_and_timeouts(
        fake,
        Timeouts {
            command: Duration::from_millis(500),
        },
    )
}

#[tokio::test]
async fn failed_readback_after_an_applied_action_is_unknown_and_not_retried() {
    let fake = Arc::new(FakeRunner::new(vec![ok(""), nonzero()]));
    let state = test_state(fake.clone());
    assert!(matches!(
        state.set_output_volume(50.0).await,
        Err(SystemError::OutcomeUnknown { .. })
    ));
    assert_eq!(fake.calls().len(), 2);

    let fake = Arc::new(FakeRunner::new(vec![ok(""), ok("malformed")]));
    let state = test_state(fake.clone());
    assert!(matches!(
        state.set_microphone_muted(true).await,
        Err(SystemError::OutcomeUnknown { .. })
    ));
    assert_eq!(fake.calls().len(), 2);

    let fake = Arc::new(FakeRunner::new(vec![ok("Playing"), ok(""), nonzero()]));
    let state = test_state(fake.clone());
    assert!(matches!(
        state.media_play_pause().await,
        Err(SystemError::OutcomeUnknown { .. })
    ));
    assert_eq!(fake.calls().len(), 3);
}

#[tokio::test]
async fn reads_unmuted_output_volume() {
    let fake = Arc::new(FakeRunner::new(vec![ok("Volume: 0.50\n")]));
    let state = test_state(fake.clone());

    let snapshot = state.output_snapshot().await.unwrap();

    assert_eq!(snapshot.volume_percent, 50.0);
    assert!(!snapshot.muted);
    assert_eq!(
        fake.calls(),
        vec![CommandSpec {
            program: "wpctl",
            args: vec!["get-volume".into(), DEFAULT_SINK.into()],
        }]
    );
}

#[tokio::test]
async fn reads_muted_microphone_state() {
    let fake = Arc::new(FakeRunner::new(vec![ok("Volume: 0.25 [MUTED]\n")]));
    let state = test_state(fake.clone());

    let snapshot = state.microphone_snapshot().await.unwrap();

    assert!(snapshot.muted);
    assert_eq!(fake.calls()[0].args, vec!["get-volume", DEFAULT_SOURCE]);
}

#[tokio::test]
async fn reports_boosted_volume_without_clamping_it() {
    let fake = Arc::new(FakeRunner::new(vec![ok("Volume: 1.50\n")]));
    let state = test_state(fake);

    let snapshot = state.output_snapshot().await.unwrap();

    assert_eq!(snapshot.volume_percent, 150.0);
}

#[tokio::test]
async fn sets_volume_and_confirms_the_readback() {
    let fake = Arc::new(FakeRunner::new(vec![ok(""), ok("Volume: 0.50\n")]));
    let state = test_state(fake.clone());

    let result = state.set_output_volume(50.0).await.unwrap();

    assert!(result.confirmed);
    assert_eq!(result.requested, 50);
    assert_eq!(result.snapshot.volume_percent, 50.0);
    let calls = fake.calls();
    assert_eq!(
        calls[0].args,
        vec!["set-volume".to_string(), DEFAULT_SINK.into(), "50%".into()]
    );
    assert_eq!(calls[1].args, vec!["get-volume", DEFAULT_SINK]);
}

#[tokio::test]
async fn reports_not_applied_when_the_readback_differs() {
    let fake = Arc::new(FakeRunner::new(vec![ok(""), ok("Volume: 0.20\n")]));
    let state = test_state(fake);

    let result = state.set_output_volume(80.0).await.unwrap();

    assert!(!result.confirmed);
    assert_eq!(result.snapshot.volume_percent, 20.0);
}

#[tokio::test]
async fn rejects_non_finite_and_out_of_range_volume_without_running_anything() {
    let fake = Arc::new(FakeRunner::new(vec![]));
    let state = test_state(fake.clone());

    for bad in [f64::NAN, f64::INFINITY, -1.0, 100.5] {
        let error = state.set_output_volume(bad).await.unwrap_err();
        assert!(
            matches!(error, SystemError::InvalidInput { .. }),
            "volume {bad} should be rejected, got {error:?}"
        );
    }
    assert!(fake.calls().is_empty());
}

#[tokio::test]
async fn nonzero_wpctl_exit_is_an_unavailable_device() {
    let fake = Arc::new(FakeRunner::new(vec![nonzero()]));
    let state = test_state(fake);

    let error = state.output_snapshot().await.unwrap_err();

    assert!(matches!(error, SystemError::NoDevice { .. }));
    assert!(!error.to_string().contains("wpctl"));
}

#[tokio::test]
async fn unexpected_wpctl_output_is_reported_cleanly() {
    let fake = Arc::new(FakeRunner::new(vec![ok("not a volume line\n")]));
    let state = test_state(fake);

    let error = state.microphone_snapshot().await.unwrap_err();

    assert!(matches!(error, SystemError::UnexpectedOutput { .. }));
}

#[tokio::test]
async fn a_command_timeout_is_reported_and_never_retried() {
    let fake = Arc::new(FakeRunner::slow(Duration::from_millis(300)));
    let state = SystemState::with_runner_and_timeouts(
        fake.clone(),
        Timeouts {
            command: Duration::from_millis(20),
        },
    );

    let error = state.output_snapshot().await.unwrap_err();

    assert!(matches!(error, SystemError::Timeout { .. }));
    assert_eq!(
        fake.calls().len(),
        1,
        "a timeout must not be retried blindly"
    );
}

#[tokio::test]
async fn missing_tool_is_reported_as_tool_missing() {
    let fake = Arc::new(FakeRunner::new(vec![Err(SystemError::ToolMissing {
        message: "The wpctl audio tool is not installed.".into(),
    })]));
    let state = test_state(fake);

    let error = state.output_snapshot().await.unwrap_err();

    assert!(matches!(error, SystemError::ToolMissing { .. }));
}

#[tokio::test]
async fn a_real_missing_executable_is_tool_missing() {
    use deck_lib::system::ProcessRunner;

    // The real runner maps spawn NotFound to a sanitized ToolMissing error.
    // Program names are compile-time constants in production; this name is only
    // used here and never reaches an exposed command.
    let spec = CommandSpec {
        program: "deck-definitely-not-a-real-tool",
        args: vec![],
    };
    let error = ProcessRunner.run(&spec).await.unwrap_err();

    assert!(matches!(error, SystemError::ToolMissing { .. }));
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_real_command_is_cancelled_on_timeout() {
    use std::time::Instant;

    use deck_lib::system::ProcessRunner;

    let runner = ProcessRunner;
    // `sleep` is only used to hold the child open; no machine state is touched.
    let spec = CommandSpec {
        program: "sleep",
        args: vec!["5".into()],
    };

    let started = Instant::now();
    // Mirrors `SystemState`'s timeout: dropping the runner future drops the
    // child, which `kill_on_drop` kills and Tokio reaps.
    let outcome = tokio::time::timeout(Duration::from_millis(50), runner.run(&spec)).await;

    assert!(outcome.is_err(), "the command should not finish on its own");
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[tokio::test]
async fn missing_player_is_reported_without_requesting_play_pause() {
    let fake = Arc::new(FakeRunner::new(vec![nonzero()]));
    let state = test_state(fake.clone());

    let error = state.media_play_pause().await.unwrap_err();

    assert!(matches!(error, SystemError::NoPlayer { .. }));
    assert_eq!(
        fake.calls().len(),
        1,
        "play-pause must not run without a player"
    );
    assert_eq!(fake.calls()[0].args, vec!["status"]);
}

#[tokio::test]
async fn parses_all_media_statuses() {
    let fake = Arc::new(FakeRunner::new(vec![
        ok("Playing\n"),
        ok("Paused\n"),
        ok("Stopped\n"),
    ]));
    let state = test_state(fake);

    assert_eq!(
        state.media_snapshot().await.unwrap().status,
        MediaStatus::Playing
    );
    assert_eq!(
        state.media_snapshot().await.unwrap().status,
        MediaStatus::Paused
    );
    assert_eq!(
        state.media_snapshot().await.unwrap().status,
        MediaStatus::Stopped
    );
}

#[tokio::test]
async fn unexpected_media_status_is_reported_cleanly() {
    let fake = Arc::new(FakeRunner::new(vec![ok("Buffering\n")]));
    let state = test_state(fake);

    let error = state.media_snapshot().await.unwrap_err();

    assert!(matches!(error, SystemError::UnexpectedOutput { .. }));
}

#[tokio::test]
async fn play_pause_confirms_the_expected_transition() {
    let fake = Arc::new(FakeRunner::new(vec![
        ok("Playing\n"),
        ok(""),
        ok("Paused\n"),
    ]));
    let state = test_state(fake.clone());

    let result = state.media_play_pause().await.unwrap();

    assert_eq!(result.requested, MediaStatus::Paused);
    assert!(result.confirmed);
    let calls = fake.calls();
    assert_eq!(calls[0].args, vec!["status"]);
    assert_eq!(calls[1].args, vec!["play-pause"]);
    assert_eq!(calls[2].args, vec!["status"]);
}

#[tokio::test]
async fn play_pause_reports_not_applied_when_the_state_does_not_change() {
    let fake = Arc::new(FakeRunner::new(vec![
        ok("Paused\n"),
        ok(""),
        ok("Paused\n"),
    ]));
    let state = test_state(fake);

    let result = state.media_play_pause().await.unwrap();

    assert_eq!(result.requested, MediaStatus::Playing);
    assert!(!result.confirmed);
}

#[tokio::test]
async fn muting_uses_an_explicit_target_and_confirms_it() {
    let fake = Arc::new(FakeRunner::new(vec![ok(""), ok("Volume: 0.00 [MUTED]\n")]));
    let state = test_state(fake.clone());

    let result = state.set_microphone_muted(true).await.unwrap();

    assert!(result.requested);
    assert!(result.confirmed);
    assert_eq!(
        fake.calls()[0].args,
        vec!["set-mute".to_string(), DEFAULT_SOURCE.into(), "1".into()]
    );
}

#[tokio::test]
async fn unmuting_reports_not_applied_when_the_readback_still_shows_muted() {
    let fake = Arc::new(FakeRunner::new(vec![ok(""), ok("Volume: 0.00 [MUTED]\n")]));
    let state = test_state(fake);

    let result = state.set_microphone_muted(false).await.unwrap();

    assert!(!result.requested);
    assert!(!result.confirmed);
}
