import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  nativeAvailable,
  systemFailureState,
  systemMediaPlayPause,
  systemMediaSnapshot,
  systemMicrophoneSnapshot,
  systemSetMicrophoneMuted,
  systemOutputSnapshot,
  systemSetOutputVolume,
  toSystemError,
} from "./native";
import type { MediaSnapshot, MicrophoneSnapshot, OutputSnapshot } from "./native";

export type ApplyState = "confirmed" | "not_applied" | "failed" | "unknown";

export interface ApplyFeedback {
  state: ApplyState;
  message: string;
}

export interface SystemConsole {
  native: boolean;

  output: OutputSnapshot | null;
  outputTarget: number;
  outputPending: boolean;
  outputRefreshing: boolean;
  outputError: string | null;
  outputFeedback: ApplyFeedback | null;
  setOutputTarget: (value: number) => void;
  refreshOutput: () => Promise<void>;
  applyOutput: () => Promise<void>;

  microphone: MicrophoneSnapshot | null;
  microphonePending: boolean;
  microphoneRefreshing: boolean;
  microphoneError: string | null;
  microphoneFeedback: ApplyFeedback | null;
  refreshMicrophone: () => Promise<void>;
  toggleMicrophone: () => Promise<void>;

  media: MediaSnapshot | null;
  mediaPending: boolean;
  mediaRefreshing: boolean;
  mediaError: string | null;
  mediaFeedback: ApplyFeedback | null;
  refreshMedia: () => Promise<void>;
  runMedia: () => Promise<void>;
}

const TARGET_MIN = 0;
const TARGET_MAX = 100;

export function clampTarget(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.min(TARGET_MAX, Math.max(TARGET_MIN, Math.round(value)));
}

/** Show the observed value honestly: a boost above 100 is not silently lowered. */
export function formatPercent(value: number): string {
  return Number.isFinite(value) ? `${Math.round(value)}%` : "unknown";
}

/**
 * Native system controls shared by the Inspector.
 *
 * Each family reads and applies independently, so a missing media player or a
 * missing tool cannot disable working audio controls. A failed refresh clears
 * the observed value instead of leaving a stale one advertised as live, and an
 * uncertain result is never retried blindly.
 */
export function useSystemConsole(): SystemConsole {
  const native = useMemo(nativeAvailable, []);

  const [output, setOutput] = useState<OutputSnapshot | null>(null);
  const [outputTarget, setOutputTargetState] = useState(50);
  const [outputPending, setOutputPending] = useState(false);
  const [outputRefreshing, setOutputRefreshing] = useState(false);
  const [outputError, setOutputError] = useState<string | null>(null);
  const [outputFeedback, setOutputFeedback] = useState<ApplyFeedback | null>(null);
  const targetTouched = useRef(false);

  const [microphone, setMicrophone] = useState<MicrophoneSnapshot | null>(null);
  const [microphonePending, setMicrophonePending] = useState(false);
  const [microphoneRefreshing, setMicrophoneRefreshing] = useState(false);
  const [microphoneError, setMicrophoneError] = useState<string | null>(null);
  const [microphoneFeedback, setMicrophoneFeedback] = useState<ApplyFeedback | null>(null);

  const [media, setMedia] = useState<MediaSnapshot | null>(null);
  const [mediaPending, setMediaPending] = useState(false);
  const [mediaRefreshing, setMediaRefreshing] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [mediaFeedback, setMediaFeedback] = useState<ApplyFeedback | null>(null);

  const setOutputTarget = useCallback((value: number) => {
    targetTouched.current = true;
    setOutputTargetState(clampTarget(value));
  }, []);

  const refreshOutput = useCallback(async () => {
    if (!native) return;
    setOutputRefreshing(true);
    try {
      const next = await systemOutputSnapshot();
      setOutput(next);
      setOutputError(null);
      if (!targetTouched.current) {
        setOutputTargetState(clampTarget(Math.min(next.volumePercent, TARGET_MAX)));
      }
    } catch (cause) {
      setOutput(null);
      setOutputError(toSystemError(cause).message);
    } finally {
      setOutputRefreshing(false);
    }
  }, [native]);

  const applyOutput = useCallback(async () => {
    if (!native) return;
    setOutputPending(true);
    setOutputFeedback(null);
    setOutputError(null);
    try {
      const result = await systemSetOutputVolume(outputTarget);
      setOutput(result.snapshot);
      targetTouched.current = false;
      setOutputTargetState(clampTarget(Math.min(result.snapshot.volumePercent, TARGET_MAX)));
      setOutputFeedback({
        state: result.confirmed ? "confirmed" : "not_applied",
        message: result.confirmed
          ? `Output is at ${formatPercent(result.snapshot.volumePercent)}.`
          : `Not applied: output reports ${formatPercent(result.snapshot.volumePercent)}.`,
      });
    } catch (cause) {
      const error = toSystemError(cause);
      setOutput(null);
      setOutputFeedback({ state: systemFailureState(error), message: error.message });
    } finally {
      setOutputPending(false);
    }
  }, [native, outputTarget]);

  const refreshMicrophone = useCallback(async () => {
    if (!native) return;
    setMicrophoneRefreshing(true);
    try {
      const next = await systemMicrophoneSnapshot();
      setMicrophone(next);
      setMicrophoneError(null);
    } catch (cause) {
      setMicrophone(null);
      setMicrophoneError(toSystemError(cause).message);
    } finally {
      setMicrophoneRefreshing(false);
    }
  }, [native]);

  const toggleMicrophone = useCallback(async () => {
    if (!native || microphone === null) return;
    const requested = !microphone.muted;
    setMicrophonePending(true);
    setMicrophoneFeedback(null);
    setMicrophoneError(null);
    try {
      const result = await systemSetMicrophoneMuted(requested);
      setMicrophone(result.snapshot);
      setMicrophoneFeedback({
        state: result.confirmed ? "confirmed" : "not_applied",
        message: result.confirmed
          ? `Default input is ${result.snapshot.muted ? "muted" : "live"}.`
          : `Not applied: default input is still ${result.snapshot.muted ? "muted" : "live"}.`,
      });
    } catch (cause) {
      const error = toSystemError(cause);
      setMicrophone(null);
      setMicrophoneFeedback({ state: systemFailureState(error), message: error.message });
    } finally {
      setMicrophonePending(false);
    }
  }, [native, microphone]);

  const refreshMedia = useCallback(async () => {
    if (!native) return;
    setMediaRefreshing(true);
    try {
      const next = await systemMediaSnapshot();
      setMedia(next);
      setMediaError(null);
    } catch (cause) {
      setMedia(null);
      setMediaError(toSystemError(cause).message);
    } finally {
      setMediaRefreshing(false);
    }
  }, [native]);

  const runMedia = useCallback(async () => {
    if (!native || media === null) return;
    setMediaPending(true);
    setMediaFeedback(null);
    setMediaError(null);
    try {
      const result = await systemMediaPlayPause();
      setMedia(result.snapshot);
      setMediaFeedback({
        state: result.confirmed ? "confirmed" : "not_applied",
        message: result.confirmed
          ? `Player is now ${result.snapshot.status}.`
          : `Not applied: player reports ${result.snapshot.status}.`,
      });
    } catch (cause) {
      const error = toSystemError(cause);
      // A fully dispatched key has no readback; keep the control ready for a new gesture.
      if (error.kind !== "media_key_sent") {
        setMedia(null);
        setMediaFeedback({ state: systemFailureState(error), message: error.message });
      }
    } finally {
      setMediaPending(false);
    }
  }, [native, media]);

  useEffect(() => {
    if (!native) return;
    void refreshOutput();
    void refreshMicrophone();
    void refreshMedia();
  }, [native, refreshOutput, refreshMicrophone, refreshMedia]);

  return {
    native,
    output,
    outputTarget,
    outputPending,
    outputRefreshing,
    outputError,
    outputFeedback,
    setOutputTarget,
    refreshOutput,
    applyOutput,
    microphone,
    microphonePending,
    microphoneRefreshing,
    microphoneError,
    microphoneFeedback,
    refreshMicrophone,
    toggleMicrophone,
    media,
    mediaPending,
    mediaRefreshing,
    mediaError,
    mediaFeedback,
    refreshMedia,
    runMedia,
  };
}
