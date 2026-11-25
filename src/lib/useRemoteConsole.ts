import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nativeAvailable } from "./native";
import {
  invitationExpired,
  remoteApproveDevice,
  remoteCreateInvitation,
  remoteDenyDevice,
  remoteListDevices,
  remoteRevokeDevice,
  remoteStart,
  remoteStatus,
  remoteStop,
  toRemoteError,
} from "./nativeRemote";
import type {
  RemoteDevice,
  RemoteMode,
  RemoteInvitation,
  RemoteStatus,
} from "./nativeRemote";

const POLL_INTERVAL_MS = 2000;

export interface RemoteConsole {
  native: boolean;
  /** Latest status, or null before the first check completes. */
  status: RemoteStatus | null;
  running: boolean;
  mode: RemoteMode | null;
  origin: string | null;
  port: number | null;
  pending: RemoteDevice[];
  approved: RemoteDevice[];
  invitation: RemoteInvitation | null;
  error: string | null;
  /** True while an explicit admin mutation is in flight. */
  busy: boolean;
  start: (origin: string, mode?: RemoteMode) => Promise<boolean>;
  stop: () => Promise<void>;
  createInvitation: () => Promise<void>;
  approve: (requestId: string) => Promise<void>;
  deny: (requestId: string) => Promise<void>;
  revoke: (requestId: string) => Promise<void>;
}

/**
 * Native phone-service admin state.
 *
 * Polls running status and the authoritative device list while mounted. A
 * generation counter invalidates any in-flight reply once the user starts,
 * stops, or mutates: stale polls can never restore state that a newer explicit
 * action (or a stop) already replaced. Mutations are never retried.
 */
export function useRemoteConsole(): RemoteConsole {
  const native = useMemo(nativeAvailable, []);
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [devices, setDevices] = useState<RemoteDevice[]>([]);
  const [invitation, setInvitation] = useState<RemoteInvitation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const mountedRef = useRef(true);
  const epochRef = useRef(0);
  const pollInFlightRef = useRef(false);
  const mutationInFlightRef = useRef(false);

  const bumpEpoch = useCallback(() => {
    epochRef.current += 1;
    return epochRef.current;
  }, []);

  const poll = useCallback(async () => {
    if (!native || pollInFlightRef.current || mutationInFlightRef.current) return;
    const epoch = epochRef.current;
    pollInFlightRef.current = true;
    try {
      const next = await remoteStatus();
      if (!mountedRef.current || epoch !== epochRef.current) return;
      setStatus(next);
      if (next.running) {
        const list = await remoteListDevices();
        if (!mountedRef.current || epoch !== epochRef.current) return;
        setDevices(list);
      } else {
        setDevices([]);
        setInvitation(null);
      }
    } catch (cause) {
      if (!mountedRef.current || epoch !== epochRef.current) return;
      setError(toRemoteError(cause).message);
    } finally {
      pollInFlightRef.current = false;
    }
  }, [native]);

  useEffect(() => {
    if (!native) return;
    mountedRef.current = true;
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
      // Invalidate any reply still in flight after unmount.
      epochRef.current += 1;
    };
  }, [native, poll]);

  // Drop the raw pairing link as soon as its server-provided expiry passes.
  useEffect(() => {
    if (!invitation) return;
    if (invitationExpired(invitation.expiresAtMs)) {
      setInvitation(null);
      return;
    }
    const timer = window.setTimeout(
      () => setInvitation(null),
      invitation.expiresAtMs - Date.now(),
    );
    return () => window.clearTimeout(timer);
  }, [invitation]);

  const start = useCallback(
    async (origin: string, mode: RemoteMode = "tailscale") => {
      if (!native || mutationInFlightRef.current) return false;
      mutationInFlightRef.current = true;
      const epoch = bumpEpoch();
      setBusy(true);
      setError(null);
      setInvitation(null);
      try {
        const next = await remoteStart(origin, mode);
        if (!mountedRef.current || epoch !== epochRef.current) return false;
        setStatus(next);
        setDevices([]);
        return true;
      } catch (cause) {
        if (!mountedRef.current || epoch !== epochRef.current) return false;
        setError(toRemoteError(cause).message);
        return false;
      } finally {
        mutationInFlightRef.current = false;
        if (mountedRef.current && epoch === epochRef.current) setBusy(false);
      }
    },
    [bumpEpoch, native],
  );

  const stop = useCallback(async () => {
    if (!native || mutationInFlightRef.current) return;
    mutationInFlightRef.current = true;
    const epoch = bumpEpoch();
    setBusy(true);
    setError(null);
    // Clear session state immediately so an in-flight poll cannot restore it.
    setInvitation(null);
    setDevices([]);
    setStatus(null);
    try {
      const next = await remoteStop();
      if (!mountedRef.current || epoch !== epochRef.current) return;
      setStatus(next);
    } catch (cause) {
      if (!mountedRef.current || epoch !== epochRef.current) return;
      setError(toRemoteError(cause).message);
    } finally {
      mutationInFlightRef.current = false;
      if (mountedRef.current && epoch === epochRef.current) setBusy(false);
    }
  }, [bumpEpoch, native]);

  const createInvitation = useCallback(async () => {
    if (!native || mutationInFlightRef.current) return;
    mutationInFlightRef.current = true;
    const epoch = bumpEpoch();
    setBusy(true);
    setError(null);
    // Replace any existing link before requesting a new one.
    setInvitation(null);
    try {
      const next = await remoteCreateInvitation();
      if (!mountedRef.current || epoch !== epochRef.current) return;
      setInvitation(next);
    } catch (cause) {
      if (!mountedRef.current || epoch !== epochRef.current) return;
      setError(toRemoteError(cause).message);
    } finally {
      mutationInFlightRef.current = false;
      if (mountedRef.current && epoch === epochRef.current) setBusy(false);
    }
  }, [bumpEpoch, native]);

  const mutateDevice = useCallback(
    async (
      action: (requestId: string) => Promise<RemoteDevice>,
      requestId: string,
    ) => {
      if (!native || mutationInFlightRef.current) return;
      mutationInFlightRef.current = true;
      const epoch = bumpEpoch();
      setBusy(true);
      setError(null);
      try {
        await action(requestId);
        if (!mountedRef.current || epoch !== epochRef.current) return;
        const list = await remoteListDevices();
        if (!mountedRef.current || epoch !== epochRef.current) return;
        setDevices(list);
      } catch (cause) {
        if (!mountedRef.current || epoch !== epochRef.current) return;
        setError(toRemoteError(cause).message);
      } finally {
        mutationInFlightRef.current = false;
        if (mountedRef.current && epoch === epochRef.current) setBusy(false);
      }
    },
    [bumpEpoch, native],
  );

  const approve = useCallback(
    (requestId: string) => mutateDevice(remoteApproveDevice, requestId),
    [mutateDevice],
  );
  const deny = useCallback(
    (requestId: string) => mutateDevice(remoteDenyDevice, requestId),
    [mutateDevice],
  );
  const revoke = useCallback(
    (requestId: string) => mutateDevice(remoteRevokeDevice, requestId),
    [mutateDevice],
  );

  return {
    native,
    status,
    running: status?.running ?? false,
    mode: status?.mode ?? null,
    origin: status?.origin ?? null,
    port: status?.port ?? null,
    pending: devices.filter((device) => device.status === "pending"),
    approved: devices.filter((device) => device.status === "approved"),
    invitation,
    error,
    busy,
    start,
    stop,
    createInvitation,
    approve,
    deny,
    revoke,
  };
}
