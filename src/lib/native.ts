import { invoke, isTauri } from "@tauri-apps/api/core";

/** Typed, sanitized errors returned by the native OBS commands. */
export const OBS_ERROR_KINDS = [
  "invalid_input",
  "timeout",
  "unavailable",
  "auth_rejected",
  "not_connected",
  "scene_not_found",
  "request_failed",
  "disconnected",
] as const;

export type ObsErrorKind = (typeof OBS_ERROR_KINDS)[number];

export interface ObsError {
  kind: ObsErrorKind;
  message: string;
}

export interface ObsSnapshot {
  connected: boolean;
  host: string;
  port: number;
  scenes: string[];
  /** Program scene read back from OBS; null while disconnected. */
  currentScene: string | null;
  /** Milliseconds since the epoch when OBS was last queried. */
  observedAtMs: number;
}

export interface SceneSwitchResult {
  requested: string;
  confirmed: boolean;
  snapshot: ObsSnapshot;
}

const FALLBACK_MESSAGES: Record<ObsErrorKind, string> = {
  invalid_input: "That OBS setting is not valid.",
  timeout: "OBS did not respond in time.",
  unavailable: "OBS is not reachable on this machine.",
  auth_rejected: "OBS rejected the password.",
  not_connected: "Not connected to OBS.",
  scene_not_found: "OBS does not have that scene.",
  request_failed: "The OBS request failed.",
  disconnected: "The OBS connection was interrupted.",
};

/** True only inside the bundled Tauri desktop shell, never in a browser. */
export function nativeAvailable(): boolean {
  return typeof window !== "undefined" && isTauri();
}

/**
 * Normalize anything thrown by `invoke` into a typed, sanitized error.
 *
 * Only a well-formed `{ kind, message }` from our Rust commands is trusted;
 * anything else becomes a generic failure so raw server or socket text is never
 * shown.
 */
export function toObsError(value: unknown): ObsError {
  if (value && typeof value === "object") {
    const candidate = value as { kind?: unknown; message?: unknown };
    if (
      typeof candidate.kind === "string" &&
      (OBS_ERROR_KINDS as readonly string[]).includes(candidate.kind)
    ) {
      const kind = candidate.kind as ObsErrorKind;
      const message =
        typeof candidate.message === "string" && candidate.message.trim()
          ? candidate.message
          : FALLBACK_MESSAGES[kind];
      return { kind, message };
    }
  }
  return { kind: "request_failed", message: FALLBACK_MESSAGES.request_failed };
}

export function sceneSwitchFailureState(error: ObsError): "unknown" | "failed" {
  // The scene may have changed before the connection or acknowledgement was lost.
  return error.kind === "timeout" || error.kind === "disconnected" ? "unknown" : "failed";
}

function requireNative(): void {
  if (!nativeAvailable()) {
    throw {
      kind: "unavailable",
      message: "OBS control is only available in the desktop app.",
    } satisfies ObsError;
  }
}

async function invokeObs<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  requireNative();
  return invoke<T>(command, args);
}

export function obsConnect(port: number, password: string): Promise<ObsSnapshot> {
  return invokeObs<ObsSnapshot>("obs_connect", {
    port,
    password: password.length > 0 ? password : null,
  });
}

export interface ObsPreferences {
  port: number;
  password: string;
}

export function obsLoadPreferences(): Promise<ObsPreferences | null> {
  return invokeObs<ObsPreferences | null>("obs_load_preferences");
}

export function obsSavePreferences(port: number, password: string): Promise<void> {
  return invokeObs<void>("obs_save_preferences", { port, password });
}

export function obsForgetPreferences(): Promise<void> {
  return invokeObs<void>("obs_forget_preferences");
}

export function obsDisconnect(): Promise<void> {
  return invokeObs<void>("obs_disconnect");
}

export function obsSnapshot(): Promise<ObsSnapshot> {
  return invokeObs<ObsSnapshot>("obs_snapshot");
}

export function obsSwitchScene(scene: string): Promise<SceneSwitchResult> {
  return invokeObs<SceneSwitchResult>("obs_switch_scene", { scene });
}

/** Typed, sanitized errors returned by the native system audio/media commands. */
export const SYSTEM_ERROR_KINDS = [
  "invalid_input",
  "timeout",
  "outcome_unknown",
  "media_key_sent",
  "tool_missing",
  "no_device",
  "no_player",
  "command_failed",
  "unexpected_output",
  "unsupported",
] as const;

export type SystemErrorKind = (typeof SYSTEM_ERROR_KINDS)[number];

export interface SystemError {
  kind: SystemErrorKind;
  message: string;
}

export interface OutputSnapshot {
  /** Observed output volume percentage. Reported as-is, so an OS boost above 100 is visible. */
  volumePercent: number;
  muted: boolean;
  observedAtMs: number;
}

export interface MicrophoneSnapshot {
  muted: boolean;
  observedAtMs: number;
}

/** Native system media keys cannot provide a global playback snapshot. */
export type MediaStatus = "playing" | "paused" | "stopped" | "unknown";

export interface MediaSnapshot {
  status: MediaStatus;
  observedAtMs: number;
}

export interface VolumeApplyResult {
  requested: number;
  confirmed: boolean;
  snapshot: OutputSnapshot;
}

export interface MicrophoneApplyResult {
  requested: boolean;
  confirmed: boolean;
  snapshot: MicrophoneSnapshot;
}

export interface MediaPermission {
  platform: "macos" | "windows" | "linux" | "unsupported";
  status: "granted" | "required" | "not_required" | "unsupported";
}

/** Observational only. Never requests permission or opens settings. */
export function systemMediaPermissionStatus(): Promise<MediaPermission> {
  return invokeSystem<MediaPermission>("system_media_permission_status");
}

/** Explicit local setup button only; never call from media action routing. */
export function systemMediaPermissionRequest(): Promise<MediaPermission> {
  return invokeSystem<MediaPermission>("system_media_permission_request");
}

export interface MediaApplyResult {
  requested: MediaStatus;
  confirmed: boolean;
  snapshot: MediaSnapshot;
}

const SYSTEM_FALLBACK_MESSAGES: Record<SystemErrorKind, string> = {
  invalid_input: "That value is not valid.",
  timeout: "The system tool did not respond in time.",
  outcome_unknown: "Action sent, but its resulting state could not be confirmed. Check before retrying.",
  media_key_sent: "Media key sent. Playback state is unavailable.",
  tool_missing: "A required system tool is not installed.",
  no_device: "The default audio device is not available.",
  no_player: "No media player is available.",
  command_failed: "The system command failed.",
  unexpected_output: "The system tool returned unexpected output.",
  unsupported: "System media and volume controls are not supported on this platform.",
};

/** Normalize anything thrown by `invoke` into a typed, sanitized system error. */
export function toSystemError(value: unknown): SystemError {
  if (value && typeof value === "object") {
    const candidate = value as { kind?: unknown; message?: unknown };
    if (
      typeof candidate.kind === "string" &&
      (SYSTEM_ERROR_KINDS as readonly string[]).includes(candidate.kind)
    ) {
      const kind = candidate.kind as SystemErrorKind;
      const message =
        typeof candidate.message === "string" && candidate.message.trim()
          ? candidate.message
          : SYSTEM_FALLBACK_MESSAGES[kind];
      return { kind, message };
    }
  }
  return { kind: "command_failed", message: SYSTEM_FALLBACK_MESSAGES.command_failed };
}

/** A command may have taken effect before its acknowledgement or readback failed. */
export function systemFailureState(error: SystemError): "unknown" | "failed" {
  return error.kind === "timeout" || error.kind === "outcome_unknown" || error.kind === "media_key_sent" ? "unknown" : "failed";
}

function requireNativeSystem(): void {
  if (!nativeAvailable()) {
    throw {
      kind: "unsupported",
      message: "System media and volume controls are only available in the desktop app.",
    } satisfies SystemError;
  }
}

async function invokeSystem<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  requireNativeSystem();
  return invoke<T>(command, args);
}

export function systemOutputSnapshot(): Promise<OutputSnapshot> {
  return invokeSystem<OutputSnapshot>("system_output_snapshot");
}

export function systemSetOutputVolume(volume: number): Promise<VolumeApplyResult> {
  return invokeSystem<VolumeApplyResult>("system_output_set_volume", { volume });
}

export function systemMicrophoneSnapshot(): Promise<MicrophoneSnapshot> {
  return invokeSystem<MicrophoneSnapshot>("system_microphone_snapshot");
}

export function systemSetMicrophoneMuted(muted: boolean): Promise<MicrophoneApplyResult> {
  return invokeSystem<MicrophoneApplyResult>("system_microphone_set_muted", { muted });
}

export function systemMediaSnapshot(): Promise<MediaSnapshot> {
  return invokeSystem<MediaSnapshot>("system_media_snapshot");
}

export function systemMediaPlayPause(): Promise<MediaApplyResult> {
  return invokeSystem<MediaApplyResult>("system_media_play_pause");
}
