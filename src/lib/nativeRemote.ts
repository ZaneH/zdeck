import { invoke } from "@tauri-apps/api/core";
import { nativeAvailable } from "./native";

/** Typed, sanitized errors returned by the native phone-service admin commands. */
export const REMOTE_ERROR_KINDS = [
  "not_running",
  "already_running",
  "invalid_origin",
  "bind",
  "conflict",
  "not_found",
  "unavailable",
  "internal",
] as const;

export type RemoteErrorKind = (typeof REMOTE_ERROR_KINDS)[number];

export interface RemoteError {
  kind: RemoteErrorKind;
  message: string;
}

export type RemoteDeviceStatus =
  | "pending"
  | "approved"
  | "denied"
  | "revoked"
  | "expired";

export interface RemoteStatus {
  running: boolean;
  origin: string | null;
  port: number | null;
  pendingDevices: number;
  approvedDevices: number;
  connectedSockets: number;
}

export interface RemoteInvitation {
  /** Raw one-time token. Keep it in memory only; never persist or log it. */
  invitation: string;
  /** Full pairing URL shown to the user. */
  url: string;
  expiresAtMs: number;
}

export interface RemoteDevice {
  requestId: string;
  name: string;
  status: RemoteDeviceStatus;
  createdAtMs: number;
}

const FALLBACK_MESSAGES: Record<RemoteErrorKind, string> = {
  not_running: "The phone connection service is not running.",
  already_running: "The phone connection service is already running.",
  invalid_origin: "That origin is not a valid HTTPS tailnet address.",
  bind: "The phone connection service could not bind to 127.0.0.1:45829.",
  conflict: "That request conflicts with the current state.",
  not_found: "That device request was not found.",
  unavailable: "The phone connection service is only available in the desktop app.",
  internal: "The phone connection service could not complete that operation.",
};

/** Normalize anything thrown by `invoke` into a typed, sanitized error. */
export function toRemoteError(value: unknown): RemoteError {
  if (value && typeof value === "object") {
    const candidate = value as { kind?: unknown; message?: unknown };
    if (
      typeof candidate.kind === "string" &&
      (REMOTE_ERROR_KINDS as readonly string[]).includes(candidate.kind)
    ) {
      const kind = candidate.kind as RemoteErrorKind;
      const message =
        typeof candidate.message === "string" && candidate.message.trim()
          ? candidate.message
          : FALLBACK_MESSAGES[kind];
      return { kind, message };
    }
  }
  return { kind: "internal", message: FALLBACK_MESSAGES.internal };
}

/** True once the server-provided invitation expiry has passed. */
export function invitationExpired(
  expiresAtMs: number,
  nowMs: number = Date.now(),
): boolean {
  return nowMs >= expiresAtMs;
}

function requireNative(): void {
  if (!nativeAvailable()) {
    throw {
      kind: "unavailable",
      message: FALLBACK_MESSAGES.unavailable,
    } satisfies RemoteError;
  }
}

async function invokeRemote<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  requireNative();
  return invoke<T>(command, args);
}

export function remoteStart(origin: string): Promise<RemoteStatus> {
  return invokeRemote<RemoteStatus>("remote_start", { origin });
}

export function remoteStop(): Promise<RemoteStatus> {
  return invokeRemote<RemoteStatus>("remote_stop");
}

export function remoteStatus(): Promise<RemoteStatus> {
  return invokeRemote<RemoteStatus>("remote_status");
}

export function remoteCreateInvitation(): Promise<RemoteInvitation> {
  return invokeRemote<RemoteInvitation>("remote_create_invitation");
}

export function remoteListDevices(): Promise<RemoteDevice[]> {
  return invokeRemote<RemoteDevice[]>("remote_list_devices");
}

export function remoteApproveDevice(requestId: string): Promise<RemoteDevice> {
  return invokeRemote<RemoteDevice>("remote_approve_device", { requestId });
}

export function remoteDenyDevice(requestId: string): Promise<RemoteDevice> {
  return invokeRemote<RemoteDevice>("remote_deny_device", { requestId });
}

export function remoteRevokeDevice(requestId: string): Promise<RemoteDevice> {
  return invokeRemote<RemoteDevice>("remote_revoke_device", { requestId });
}
