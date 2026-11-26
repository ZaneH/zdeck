import { invoke } from "@tauri-apps/api/core";
import { nativeAvailable } from "./native";

export interface DesktopCommand { commandId: string; revision: number; controlId: string; value?: number }
export type DesktopResultState = "pending" | "confirmed" | "not_applied" | "failed" | "unknown";
export interface DesktopResult { id: string; state: DesktopResultState; message: string; code?: string }
const ERRORS = {
  invalid_request: "Invalid saved-control request. Save a valid control before running it.",
  deck_unavailable: "Save a valid native deck before running controls.",
  stale_revision: "The saved deck changed. Reload the desktop deck before running controls.",
  control_not_found: "The control is not in the saved deck. Reload the desktop deck.",
  command_conflict: "This command ID conflicts with an earlier request. Nothing was retried.",
  busy: "The desktop is busy. Check current actions before trying another press.",
  capacity: "The desktop command registry is full. Restart the app before running more controls.",
};
export interface DesktopActionError { code: string; message: string; outcome: "not_started" | "unknown" }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).length <= 128 && !/\p{Cc}/u.test(value);
export function toDesktopActionError(value: unknown): DesktopActionError {
  if (record(value) && typeof value.code === "string" && Object.hasOwn(ERRORS, value.code)) {
    return { code: value.code, message: ERRORS[value.code as keyof typeof ERRORS], outcome: "not_started" };
  }
  return { code: "unknown", message: "No usable reply from the desktop. The action may already have happened. Inspect the application before manually trying again.", outcome: "unknown" };
}
const MESSAGES: Record<DesktopResultState, string> = {
  pending: "Action accepted and still pending. Check this result explicitly; do not press again.",
  confirmed: "Action confirmed on this computer.", not_applied: "The requested state was not confirmed. Inspect the application before another press.",
  failed: "The action failed. Check the application's connection and saved control configuration.",
  unknown: "Outcome unknown. The action may already have happened. Inspect the application before manually trying again.",
};
const CODES: Record<string, string> = {
  media_key_sent: "Media key sent. Playback state is unavailable.",
  platform_unsupported: "This system control backend is unavailable. Use the desktop app on macOS, Windows, or Linux and check its system-control setup.",
  plugin_unavailable: "Enable the trusted plugin in desktop Settings first.",
  plugin_setup_required: "Check the plugin connection and saved action configuration in Settings.",
  plugin_outcome_unknown: "Plugin action may have executed. Inspect its state before manually trying again.",
};
export function parseDesktopResult(value: unknown, expectedId: string): DesktopResult | null {
  if (!record(value) || value.id !== expectedId || !id(value.id) || typeof value.state !== "string" || !Object.hasOwn(MESSAGES, value.state)
    || typeof value.message !== "string" || !value.message.trim() || value.message.length > 512 || /\p{Cc}/u.test(value.message)
    || Object.keys(value).some((key) => !["id", "state", "message", "code", "observed"].includes(key))
    || (Object.hasOwn(value, "code") && (typeof value.code !== "string" || !Object.hasOwn(CODES, value.code)))
    || (Object.hasOwn(value, "observed") && !record(value.observed))
    || ((value.code === "plugin_outcome_unknown" || value.code === "media_key_sent") && value.state !== "unknown")
    || ((value.code === "plugin_unavailable" || value.code === "plugin_setup_required" || value.code === "platform_unsupported") && value.state !== "failed")) return null;
  try { if (new TextEncoder().encode(JSON.stringify(value)).length > 131072) return null; }
  catch { return null; }
  const state = value.state as DesktopResultState;
  const code = value.code as string | undefined;
  // Observed state and raw diagnostic strings never enter the UI or support logs.
  return { id: value.id, state, message: code === "media_key_sent" ? CODES[code] : code ? `${MESSAGES[state]} ${CODES[code]}` : MESSAGES[state], ...(code ? { code } : {}) };
}
export function validDesktopCommand(value: DesktopCommand): boolean {
  return record(value) && ["commandId", "revision", "controlId"].every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => ["commandId", "revision", "controlId", "value"].includes(key))
    && id(value.commandId) && id(value.controlId) && Number.isSafeInteger(value.revision) && value.revision >= 0
    && (!Object.hasOwn(value, "value") || (typeof value.value === "number" && Number.isFinite(value.value) && Math.abs(value.value) <= Number.MAX_SAFE_INTEGER));
}
export async function desktopRunControl(command: DesktopCommand): Promise<DesktopResult> {
  if (!nativeAvailable()) throw { code: "unavailable", message: "Live controls require the desktop app.", outcome: "not_started" } satisfies DesktopActionError;
  if (!validDesktopCommand(command)) throw toDesktopActionError({ code: "invalid_request" });
  let value: unknown;
  try { value = await invoke<unknown>("desktop_run_control", { ...command }); }
  catch (error) { throw toDesktopActionError(error); }
  const result = parseDesktopResult(value, command.commandId);
  if (!result) throw toDesktopActionError(null);
  return result;
}
