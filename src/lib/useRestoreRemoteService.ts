import { useEffect, useState } from "react";
import { nativeAvailable } from "./native";
import { remoteStatus, toRemoteError } from "./nativeRemote";

// Native setup owns restoration. Read its result once, including React StrictMode remounts.
let restoration: Promise<string | null> | undefined;
export function restoreRemoteService(): Promise<string | null> {
  return restoration ??= (async () => {
    try {
      const status = await remoteStatus();
      return status.error ? `${status.error} Open Settings to review the local service.` : null;
    } catch (cause) {
      return `Could not check the local service. ${toRemoteError(cause).message} Open Settings to review it.`;
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
