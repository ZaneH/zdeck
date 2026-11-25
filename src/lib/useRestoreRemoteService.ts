import { useEffect, useState } from "react";
import { nativeAvailable } from "./native";
import { getStorage } from "./persistence";
import { loadDesiredService } from "./remotePreferences";
import { remoteStart, remoteStatus, toRemoteError } from "./nativeRemote";

// One attempt per application launch, including React StrictMode remounts. Never retry uncertain starts.
let restoration: Promise<string | null> | undefined;
export function restoreRemoteService(): Promise<string | null> {
  return restoration ??= (async () => {
    try {
      const desired = loadDesiredService(getStorage());
      if (desired && !(await remoteStatus()).running) await remoteStart(desired.origin, desired.mode);
      return null;
    } catch (cause) {
      return `Local service was not restored. ${toRemoteError(cause).message} Open Settings to review and start it.`;
    }
  })();
}

export function useRestoreRemoteService() {
  const [state, setState] = useState<{ pending: boolean; error: string | null }>({ pending: nativeAvailable(), error: null });
  useEffect(() => {
    if (!nativeAvailable()) return;
    let mounted = true;
    void restoreRemoteService().then((error) => { if (mounted) setState({ pending: false, error }); });
    return () => { mounted = false; };
  }, []);
  return { ...state, clearError: () => setState((current) => ({ ...current, error: null })) };
}
