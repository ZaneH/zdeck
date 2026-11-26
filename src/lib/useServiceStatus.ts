import { useEffect, useState } from "react";
import { remoteStatus } from "./nativeRemote";
import type { RemoteStatus } from "./nativeRemote";

/** Read-only service observation; never fetch pairing tokens or device identities. */
export function useServiceStatus(native: boolean) {
  const [state, setState] = useState<{ status: RemoteStatus | null; failed: boolean }>({ status: null, failed: false });
  useEffect(() => {
    if (!native) return;
    let active = true;
    let inflight = false;
    const refresh = async () => {
      if (inflight || document.hidden) return;
      inflight = true;
      try {
        const status = await remoteStatus();
        if (active) setState({ status, failed: false });
      } catch {
        // Do not leave a stale green indicator after a failed observation.
        if (active) setState({ status: null, failed: true });
      } finally { inflight = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [native]);
  return state;
}
