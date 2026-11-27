import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { nativeAvailable } from "./native";
import { pluginIdentifier } from "./plugin";

export interface ArchiveReview {
  reviewId: string; id: string; version: string; protocolVersion: number; runtime: "node" | "python";
  identity: string; archiveSha256: string; files: number; bytes: number; collision: boolean;
  runtimeStatus: "detected" | "not_found" | "unsupported"; runtimeVersion: string | null;
}
export interface RegistryRelease {
  schema: 1; id: string; version: string;
  artifact: { url: string; sha256: string; bytes: number };
  compatibility: { protocol: 1; runtime: "node" | "python"; minimum: string; platforms: string[] };
  source: { repo: string; commit: string; license: string };
}
export interface RegistryReview { reviewId: string; id: string; version: string; keyId: string | null; release: RegistryRelease | null }
export interface ArchiveView { busy: boolean; review: ArchiveReview | null; error: string | null; installedEpoch: number; registry?: RegistryReview }
export const EMPTY_ARCHIVE: ArchiveView = { busy: false, review: null, error: null, installedEpoch: 0 };
const token = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const version = (value: unknown) => typeof value === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value);
const bounded = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const https = (value: unknown): boolean => {
  if (!bounded(value, 2048) || !URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === "https:" && !!url.hostname && !url.username && !url.password && !url.hash && !url.search;
};
function validRegistry(value: unknown): value is RegistryReview {
  if (!record(value) || !exact(value, ["reviewId", "id", "version", "keyId", "release"]) || !token(value.reviewId) || !pluginIdentifier(value.id) || !version(value.version)) return false;
  if (value.release === null) return value.keyId === null;
  const r = value.release;
  if (!bounded(value.keyId, 64) || !/^[a-z0-9-]+$/.test(value.keyId) || !record(r) || !exact(r, ["schema", "id", "version", "artifact", "compatibility", "source"]) || r.schema !== 1 || r.id !== value.id || r.version !== value.version) return false;
  const a = r.artifact, c = r.compatibility, s = r.source;
  return record(a) && exact(a, ["url", "sha256", "bytes"]) && https(a.url) && digest(a.sha256) && Number.isSafeInteger(a.bytes) && (a.bytes as number) > 0 && (a.bytes as number) <= 16 * 1024 * 1024
    && record(c) && exact(c, ["protocol", "runtime", "minimum", "platforms"]) && c.protocol === 1 && ["node", "python"].includes(c.runtime as string) && c.minimum === (c.runtime === "node" ? "22.18.0" : "3.10.0")
    && Array.isArray(c.platforms) && c.platforms.length > 0 && c.platforms.length <= 3 && c.platforms.every((p) => ["macos", "windows", "linux"].includes(p)) && new Set(c.platforms).size === c.platforms.length
    && record(s) && exact(s, ["repo", "commit", "license"]) && https(s.repo) && bounded(s.commit, 40) && /^[a-f0-9]{40}$/.test(s.commit) && bounded(s.license, 40);
}
export function parseArchiveView(value: unknown): ArchiveView | null {
  if (!record(value) || !exact(value, ["busy", "review", "error", "installedEpoch", ...(Object.hasOwn(value, "registry") ? ["registry"] : [])]) || typeof value.busy !== "boolean"
    || !(value.error === null || bounded(value.error, 1000)) || !Number.isSafeInteger(value.installedEpoch) || (value.installedEpoch as number) < 0) return null;
  if (Object.hasOwn(value, "registry") && !validRegistry(value.registry)) return null;
  if (value.review !== null) {
    const r = value.review;
    if (!record(r) || !exact(r, ["reviewId", "id", "version", "protocolVersion", "runtime", "identity", "archiveSha256", "files", "bytes", "collision", "runtimeStatus", "runtimeVersion"])
      || !token(r.reviewId) || !pluginIdentifier(r.id) || !version(r.version) || r.protocolVersion !== 1 || !["node", "python"].includes(r.runtime as string)
      || !digest(r.identity) || !digest(r.archiveSha256) || !Number.isInteger(r.files) || (r.files as number) < 1 || (r.files as number) > 4096
      || !Number.isSafeInteger(r.bytes) || (r.bytes as number) < 1 || (r.bytes as number) > 64 * 1024 * 1024 || typeof r.collision !== "boolean"
      || !["detected", "not_found", "unsupported"].includes(r.runtimeStatus as string)
      || !(r.runtimeVersion === null || bounded(r.runtimeVersion, 128))) return null;
  }
  if (value.review !== null && value.registry !== undefined) {
    const r = value.review as ArchiveReview, g = value.registry as RegistryReview;
    if (!g.release || g.reviewId !== r.reviewId || g.id !== r.id || g.version !== r.version || g.release.artifact.sha256 !== r.archiveSha256 || g.release.compatibility.runtime !== r.runtime || g.release.compatibility.protocol !== r.protocolVersion) return null;
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
export function archiveResolve(reviewId: string): Promise<void> {
  if (!token(reviewId)) return Promise.reject(new Error("This registry request is no longer current."));
  return command("plugin_archive_resolve", { reviewId });
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
