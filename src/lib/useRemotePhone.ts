import { useEffect, useRef, useSyncExternalStore } from "react";
import { browserDeps, consumeInvitationFragment, RemotePhoneConnection } from "./remotePhone";
import type { RemotePhoneSnapshot } from "./remotePhone";
import type { Control } from "./types";

export interface RemotePhoneController extends RemotePhoneSnapshot {
  submitPairing: (invite: string, name: string) => void;
  cancelPairing: () => void;
  press: (control: Control) => void;
  commitVolume: (control: Control, value: number) => void;
  setPage: (pageId: string) => void;
}

/**
 * React binding for the authenticated phone connection. All lifecycle and
 * epoch logic lives in `RemotePhoneConnection`; this only wires browser events.
 */
export function useRemotePhone(initialInvite: string | null): RemotePhoneController {
  const connectionRef = useRef<RemotePhoneConnection | null>(null);
  if (connectionRef.current === null) {
    connectionRef.current = new RemotePhoneConnection(browserDeps());
  }
  const connection = connectionRef.current;
  const snapshot = useSyncExternalStore(
    connection.subscribe,
    connection.getSnapshot,
    connection.getSnapshot,
  );
  // Fetches and pairing must never start before HTTPS is confirmed.
  const secure = typeof window !== "undefined" && window.location.protocol === "https:";

  useEffect(() => {
    if (!secure) return;
    if (initialInvite) connection.adoptInvitation(initialInvite);
    else connection.start();

    const onVisibility = () => {
      if (document.visibilityState === "hidden") connection.onHidden();
      else connection.onVisible();
    };
    const onPageHide = () => connection.onHidden();
    const onPageShow = () => connection.onPageshow();
    const onOnline = () => connection.onOnline();
    const onHashChange = () => {
      const invite = consumeInvitationFragment();
      if (invite) connection.adoptInvitation(invite);
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", onOnline);
    window.addEventListener("hashchange", onHashChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("hashchange", onHashChange);
      connection.stop();
    };
  }, [connection, initialInvite, secure]);

  return {
    ...snapshot,
    submitPairing: (invite, name) => void connection.submitPairing(invite, name),
    cancelPairing: () => connection.cancelPairing(),
    press: (control) => connection.pressControl(control),
    commitVolume: (control, value) => connection.commitVolume(control, value),
    setPage: (pageId) => connection.setPage(pageId),
  };
}
