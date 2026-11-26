import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { nativeAvailable } from "./native";
import { pluginIdentifier } from "./plugin";

export interface ArchiveReview {
  reviewId: string; id: string; version: string; protocolVersion: number; runtime: "node" | "python";
  identity: string; archiveSha256: string; files: number; bytes: number; collision: boolean;
  runtimeStatus: "detected" | "not_found" | "unsupported"; runtimeVersion: string | null;
}
export interface ArchiveView { busy: boolean; review: ArchiveReview | null; error: string | null; installedEpoch: number }
export const EMPTY_ARCHIVE: ArchiveView = { busy: false, review: null, error: null, installedEpoch: 0 };
const token = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const version = (value: unknown) => typeof value === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value);
const bounded = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
export function parseArchiveView(value: unknown): ArchiveView | null {
  if (!record(value) || !exact(value, ["busy", "review", "error", "installedEpoch"]) || typeof value.busy !== "boolean"
    || !(value.error === null || bounded(value.error, 1000)) || !Number.isSafeInteger(value.installedEpoch) || (value.installedEpoch as number) < 0) return null;
  if (value.review !== null) {
    const r = value.review;
    if (!record(r) || !exact(r, ["reviewId", "id", "version", "protocolVersion", "runtime", "identity", "archiveSha256", "files", "bytes", "collision", "runtimeStatus", "runtimeVersion"])
      || !token(r.reviewId) || !pluginIdentifier(r.id) || !version(r.version) || r.protocolVersion !== 1 || !["node", "python"].includes(r.runtime as string)
      || !digest(r.identity) || !digest(r.archiveSha256) || !Number.isInteger(r.files) || (r.files as number) < 1 || (r.files as number) > 4096
      || !Number.isSafeInteger(r.bytes) || (r.bytes as number) < 1 || (r.bytes as number) > 64 * 1024 * 1024 || typeof r.collision !== "boolean"
      || !["detected", "not_found", "unsupported"].includes(r.runtimeStatus as string)
      || !(r.runtimeVersion === null || bounded(r.runtimeVersion, 128))) return null;
  }
  return value as unknown as ArchiveView;
}
async function call(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  if (!nativeAvailable()) throw new Error("Local archive installation is available only in the desktop app. This browser is preview-only.");
  return invoke<unknown>(command, args);
}
export async function archiveView(): Promise<ArchiveView> {
  const view = parseArchiveView(await call("plugin_archive_view"));
  if (!view) throw new Error("The native archive review is unavailable. Close this review and select the archive again.");
  return view;
}
async function command(name: string, args: Record<string, unknown> = {}): Promise<void> {
  if (await call(name, args) !== null) throw new Error("The native archive command returned an invalid response. Check the installed catalog before trying again.");
}
export function archivePick(): Promise<void> { return command("plugin_archive_pick"); }
export function archiveCancel(reviewId: string | null): Promise<void> {
  if (reviewId !== null && !token(reviewId)) return Promise.reject(new Error("This review is no longer current."));
  return command("plugin_archive_cancel", { reviewId });
}
export function archiveInstall(reviewId: string): Promise<void> {
  if (!token(reviewId)) return Promise.reject(new Error("This review is no longer current."));
  return command("plugin_archive_install", { reviewId });
}
export function archiveListen(onChange: () => void): Promise<() => void> {
  if (!nativeAvailable()) return Promise.resolve(() => {});
  return listen("plugin-archive-changed", onChange);
}
export function archiveError(error: unknown): string {
  // Native errors here are host-owned fixed guidance, never plugin stderr or exception data.
  return bounded(error, 1000) ? error : error instanceof Error && bounded(error.message, 1000) ? error.message : "Archive review failed. Select the local .zdx file again; nothing will be enabled automatically.";
}
