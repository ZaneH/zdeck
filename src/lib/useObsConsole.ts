import { useCallback, useMemo, useState } from "react";
import {
  nativeAvailable,
  obsConnect,
  obsDisconnect,
  obsSnapshot,
  obsSwitchScene,
  sceneSwitchFailureState,
  toObsError,
} from "./native";
import type { ObsSnapshot } from "./native";

export type ObsStatus = "disconnected" | "connecting" | "connected";

/** Honest outcome of a scene switch request. */
export type SwitchState = "confirmed" | "not_applied" | "failed" | "unknown";

export interface SceneSwitchFeedback {
  scene: string;
  state: SwitchState;
}

export interface ObsConsole {
  native: boolean;
  status: ObsStatus;
  snapshot: ObsSnapshot | null;
  currentScene: string | null;
  scenes: string[];
  error: string | null;
  pendingScene: string | null;
  lastSwitch: SceneSwitchFeedback | null;
  connect: (port: number, password: string) => Promise<boolean>;
  disconnect: () => Promise<void>;
  refresh: () => Promise<void>;
  runScene: (scene: string) => Promise<void>;
}

/**
 * Native OBS connection state shared by Settings and the Inspector.
 *
 * A request that proves the connection is gone clears the snapshot instead of
 * leaving stale scene data on screen, and a timed-out switch is reported as
 * `unknown` rather than retried or shown as a success.
 */
export function useObsConsole(): ObsConsole {
  const native = useMemo(nativeAvailable, []);
  const [status, setStatus] = useState<ObsStatus>("disconnected");
  const [snapshot, setSnapshot] = useState<ObsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingScene, setPendingScene] = useState<string | null>(null);
  const [lastSwitch, setLastSwitch] = useState<SceneSwitchFeedback | null>(null);

  const dropConnection = useCallback(() => {
    setSnapshot(null);
    setStatus("disconnected");
    setPendingScene(null);
  }, []);

  const connect = useCallback(
    async (port: number, password: string) => {
      if (!native) return false;
      setStatus("connecting");
      setError(null);
      setLastSwitch(null);
      try {
        const next = await obsConnect(port, password);
        setSnapshot(next);
        setStatus("connected");
        return true;
      } catch (cause) {
        dropConnection();
        setError(toObsError(cause).message);
        return false;
      }
    },
    [dropConnection, native],
  );

  const disconnect = useCallback(async () => {
    if (!native) return;
    try {
      await obsDisconnect();
    } catch {
      // The native side already drops credentials; local state is cleared below.
    }
    dropConnection();
    setError(null);
    setLastSwitch(null);
  }, [dropConnection, native]);

  const refresh = useCallback(async () => {
    if (!native) return;
    try {
      const next = await obsSnapshot();
      setSnapshot(next);
      setStatus(next.connected ? "connected" : "disconnected");
      setError(null);
    } catch (cause) {
      const obsError = toObsError(cause);
      if (obsError.kind === "not_connected" || obsError.kind === "disconnected") {
        dropConnection();
      }
      setError(obsError.message);
    }
  }, [dropConnection, native]);

  const runScene = useCallback(
    async (scene: string) => {
      if (!native) return;
      setPendingScene(scene);
      setLastSwitch(null);
      setError(null);
      try {
        const result = await obsSwitchScene(scene);
        setSnapshot(result.snapshot);
        setStatus("connected");
        setLastSwitch({
          scene,
          state: result.confirmed ? "confirmed" : "not_applied",
        });
        if (!result.confirmed) {
          setError("OBS reported a different program scene than requested.");
        }
      } catch (cause) {
        const obsError = toObsError(cause);
        if (obsError.kind === "not_connected" || obsError.kind === "disconnected") {
          dropConnection();
        }
        setLastSwitch({
          scene,
          state: sceneSwitchFailureState(obsError),
        });
        setError(obsError.message);
      } finally {
        setPendingScene(null);
      }
    },
    [dropConnection, native],
  );

  return {
    native,
    status,
    snapshot,
    currentScene: snapshot?.currentScene ?? null,
    scenes: snapshot?.scenes ?? [],
    error,
    pendingScene,
    lastSwitch,
    connect,
    disconnect,
    refresh,
    runScene,
  };
}
