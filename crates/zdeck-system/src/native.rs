//! Fixed native ABI shared by CoreAudio/AppKit and Windows Core Audio/SendInput.
//! Blocking OS calls stay off Tokio threads. A deadline never retries a request;
//! a timed-out worker retains the gate until it exits, preventing overlapping writes.
//! Normal concurrent Inspector refreshes wait for the gate within the same deadline.
use super::*;
use std::sync::OnceLock;
use tokio::sync::Semaphore;

#[repr(i32)]
#[derive(Clone, Copy)]
pub(super) enum Operation {
    ReadOutput = 0,
    SetOutput = 1,
    ReadMic = 2,
    SetMic = 3,
    PlayPause = 4,
}

#[repr(C)]
#[derive(Debug, Clone, Copy)]
struct NativeResult {
    code: i32,
    volume: f64,
    muted: i32,
}
extern "C" {
    fn zdeck_system_control(operation: i32, value: i32) -> NativeResult;
}

fn decode(operation: Operation, result: NativeResult) -> Result<(f64, bool), SystemError> {
    match result.code {
        0 if result.volume.is_finite() && (0.0..=100.0).contains(&result.volume)
            && matches!(result.muted, 0 | 1) => Ok((result.volume, result.muted == 1)),
        0 if matches!(operation, Operation::SetOutput | Operation::SetMic) => Err(SystemError::outcome_unknown()),
        0 => Err(SystemError::unexpected_output("The audio device reported invalid state.")),
        1 => Err(SystemError::no_device("No default audio device is available.")),
        2 => Err(SystemError::command_failed("The default audio device does not provide the required volume or mute controls.")),
        3 => Err(SystemError::command_failed(if cfg!(target_os = "macos") {
            "Allow zDeck in System Settings → Privacy & Security → Accessibility to send system media keys."
        } else {
            "Windows could not send the media key. Check desktop-session permissions and elevated applications."
        })),
        5 => Err(SystemError::outcome_unknown()),
        6 => Err(SystemError::command_failed("No safe saved microphone level is available for this device. Restore its input volume in system sound settings.")),
        7 => Err(SystemError::command_failed("Could not lock or save microphone restore levels. Check local storage and other zDeck instances; no new mute was applied.")),
        8 => Err(SystemError::invalid_input("Invalid system control request.")),
        9 if matches!(operation, Operation::PlayPause) => Err(SystemError::MediaKeySent {
            message: "Media key sent. Playback state is unavailable.".into(),
        }),
        _ => Err(SystemError::command_failed("The native system control request failed.")),
    }
}

async fn bounded<F>(gate: Arc<Semaphore>, deadline: Duration, work: F) -> Result<(f64, bool), SystemError>
where F: FnOnce() -> Result<(f64, bool), SystemError> + Send + 'static {
    let expires = std::time::Instant::now() + deadline;
    let permit = tokio::time::timeout(deadline, gate.acquire_owned()).await
        .map_err(|_| SystemError::command_failed("A previous system request is still running. No new request was sent; check state before trying again."))?
        .map_err(|_| SystemError::command_failed("System controls are unavailable."))?;
    let worker = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        if std::time::Instant::now() >= expires {
            return Err(SystemError::timeout("The system request expired before it could start."));
        }
        work()
    });
    let remaining = expires.saturating_duration_since(std::time::Instant::now());
    match tokio::time::timeout(remaining, worker).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(SystemError::outcome_unknown()),
        Err(_) => Err(SystemError::timeout("The native system request timed out. Its outcome is unknown; check before retrying.")),
    }
}

pub(super) async fn run(operation: Operation, value: i32, deadline: Duration) -> Result<(f64, bool), SystemError> {
    static GATE: OnceLock<Arc<Semaphore>> = OnceLock::new();
    let gate = GATE.get_or_init(|| Arc::new(Semaphore::new(1))).clone();
    bounded(gate, deadline, move || {
        // SAFETY: fixed integer operation/target; C ABI returns an owned POD value.
        decode(operation, unsafe { zdeck_system_control(operation as i32, value) })
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_results_are_typed_and_sanitized() {
        let result = |code, volume, muted| decode(Operation::ReadOutput, NativeResult { code, volume, muted });
        assert_eq!(result(0, 25.0, 1).unwrap(), (25.0, true));
        for (volume, muted) in [(f64::NAN, 0), (101.0, 0), (50.0, 2)] {
            assert!(matches!(result(0, volume, muted), Err(SystemError::UnexpectedOutput { .. })));
        }
        assert!(matches!(result(1, 0.0, 0), Err(SystemError::NoDevice { .. })));
        for code in [2, 3, 4, 6, 7, -999] {
            assert!(matches!(result(code, 0.0, 0), Err(SystemError::CommandFailed { .. })));
        }
        assert!(matches!(result(5, 0.0, 0), Err(SystemError::OutcomeUnknown { .. })));
        assert!(matches!(result(8, 0.0, 0), Err(SystemError::InvalidInput { .. })));
        assert!(matches!(decode(Operation::PlayPause, NativeResult { code: 9, volume: 0.0, muted: 0 }), Err(SystemError::MediaKeySent { .. })));
        assert!(matches!(result(9, 0.0, 0), Err(SystemError::CommandFailed { .. })));
        for operation in [Operation::SetOutput, Operation::SetMic] {
            assert!(matches!(decode(operation, NativeResult { code: 0, volume: f64::NAN, muted: 0 }), Err(SystemError::OutcomeUnknown { .. })));
        }
    }

    #[tokio::test]
    async fn timeout_retains_gate_until_native_worker_finishes() {
        let gate = Arc::new(Semaphore::new(1));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let worker_gate = gate.clone();
        let task = tokio::spawn(async move {
            bounded(worker_gate, Duration::from_millis(100), move || {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok((0.0, false))
            }).await
        });
        started_rx.await.unwrap();
        assert!(matches!(task.await.unwrap(), Err(SystemError::Timeout { .. })));
        assert!(matches!(bounded(gate.clone(), Duration::from_millis(20), || panic!("must not overlap")).await, Err(SystemError::CommandFailed { .. })));
        release_tx.send(()).unwrap();
        let permit = tokio::time::timeout(Duration::from_secs(2), gate.acquire()).await.unwrap().unwrap();
        drop(permit);
        assert!(bounded(gate, Duration::from_secs(1), || Ok((50.0, false))).await.is_ok());
    }

    #[tokio::test]
    async fn concurrent_inspector_refreshes_serialize_instead_of_failing_busy() {
        let gate = Arc::new(Semaphore::new(1));
        let (output, microphone) = tokio::join!(
            bounded(gate.clone(), Duration::from_secs(1), || {
                std::thread::sleep(Duration::from_millis(10));
                Ok((50.0, false))
            }),
            bounded(gate, Duration::from_secs(1), || Ok((0.0, true)))
        );
        assert_eq!(output.unwrap(), (50.0, false));
        assert_eq!(microphone.unwrap(), (0.0, true));
    }

    #[test]
    fn expired_queued_work_never_accesses_os_controls() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time().max_blocking_threads(1).build().unwrap();
        runtime.block_on(async {
            let (started_tx, started_rx) = tokio::sync::oneshot::channel();
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let holder = tokio::task::spawn_blocking(move || {
                started_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            });
            started_rx.await.unwrap();
            let gate = Arc::new(Semaphore::new(1));
            let called = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let worker_called = called.clone();
            assert!(matches!(bounded(gate.clone(), Duration::from_millis(20), move || {
                worker_called.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok((0.0, false))
            }).await, Err(SystemError::Timeout { .. })));
            release_tx.send(()).unwrap();
            holder.await.unwrap();
            let permit = tokio::time::timeout(Duration::from_secs(2), gate.acquire()).await.unwrap().unwrap();
            assert!(!called.load(std::sync::atomic::Ordering::SeqCst));
            drop(permit);
        });
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn microphone_restore_records_preserve_channels_and_reject_corruption() {
        extern "C" { fn zdeck_system_macos_self_test() -> i32; }
        // SAFETY: helper runs pure Foundation checks; no audio, events or preferences changes.
        assert_eq!(unsafe { zdeck_system_macos_self_test() }, 1);
    }

    #[test]
    fn native_boundary_rejects_invalid_targets_without_os_access() {
        for (operation, value) in [(-1, 0), (1, -1), (1, 101), (3, 2), (99, 0)] {
            // SAFETY: the native entry validates before accessing OS services.
            assert!(matches!(decode(Operation::ReadOutput, unsafe { zdeck_system_control(operation, value) }), Err(SystemError::InvalidInput { .. })));
        }
    }
}
