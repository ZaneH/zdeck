import { useCallback, useEffect, useRef, useState } from "react";
import { systemMediaPermissionRequest, systemMediaPermissionStatus, toSystemError } from "./native";
import type { MediaPermission } from "./native";

/** Mounted only for a selected native media control, never by phone action routing. */
export function useMediaPermission() {
  const [permission, setPermission] = useState<MediaPermission | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const requesting = useRef(false);

  const check = useCallback(async (request: boolean) => {
    if (requesting.current) return;
    const current = ++generation.current;
    requesting.current = request;
    setBusy(true);
    try {
      const next = await (request ? systemMediaPermissionRequest() : systemMediaPermissionStatus());
      if (current !== generation.current) return;
      setPermission(next);
      setError(null);
    } catch (cause) {
      if (current === generation.current) setError(toSystemError(cause).message);
    } finally {
      if (current === generation.current) {
        requesting.current = false;
        setBusy(false);
      }
    }
  }, []);

  useEffect(() => {
    const refresh = () => { void check(false); };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      ++generation.current;
      requesting.current = false;
      window.removeEventListener("focus", refresh);
    };
  }, [check]);

  return { permission, error, busy, refresh: () => check(false), openSettings: () => check(true) };
}
