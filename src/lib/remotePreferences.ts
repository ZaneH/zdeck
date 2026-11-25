import type { StorageLike } from "./types";

export type RemoteMode = "tailscale" | "local_https";
export const REMOTE_ORIGIN_KEY = "deck.remote.origin.v1"; // Retain the legacy tailnet preference.
export const LOCAL_REMOTE_ORIGIN_KEY = "deck.remote.local-origin.v1";
export const REMOTE_MODE_KEY = "deck.remote.mode.v1";
export const isRemoteMode = (value: unknown): value is RemoteMode => value === "tailscale" || value === "local_https";

/** Mirrors remote.rs validate_origin, including rejecting URL parser repairs before parsing. */
export function normalizeRemoteOrigin(value: unknown, mode: RemoteMode = "tailscale"): string | null {
  if (!isRemoteMode(mode) || typeof value !== "string" || value.length > 2048 || /[^\x00-\x7f]/.test(value) || !/^https:\/\//i.test(value)) return null;
  const authority = value.slice(8).replace(/\/$/, "");
  if (!authority || /[^a-z0-9.\-[\]:]/i.test(authority)) return null;
  let host: string, port: string | undefined;
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end < 0) return null;
    host = authority.slice(0, end + 1);
    const suffix = authority.slice(end + 1);
    if (suffix && !suffix.startsWith(":")) return null;
    port = suffix ? suffix.slice(1) : undefined;
  } else {
    const parts = authority.split(":");
    if (parts.length > 2) return null;
    [host, port] = parts;
  }
  if (port !== undefined && (!/^[1-9][0-9]*$/.test(port) || Number(port) > 65535)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash
      || (mode === "tailscale" && url.port !== "")) return null;
    const hostname = url.hostname;
    let allowed = false;
    if (hostname.startsWith("[")) {
      const first = parseInt(hostname.slice(1).split(":")[0], 16);
      allowed = mode === "local_https" && ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80);
    } else if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
      const [a, b] = hostname.split(".").map(Number);
      allowed = mode === "local_https" && host === hostname && (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168));
    } else {
      allowed = hostname.length <= 253 && host.toLowerCase() === hostname
        && hostname.split(".").every((label) => label !== "localhost" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
        && (mode === "tailscale" ? hostname.endsWith(".ts.net") : [".local", ".lan", ".home.arpa"].some((suffix) => hostname.endsWith(suffix)));
    }
    return allowed ? url.origin : null;
  } catch { return null; }
}

export function loadRemoteOrigin(storage: StorageLike | null, mode: RemoteMode = "tailscale"): string {
  try { return normalizeRemoteOrigin(storage?.getItem(mode === "tailscale" ? REMOTE_ORIGIN_KEY : LOCAL_REMOTE_ORIGIN_KEY), mode) ?? ""; }
  catch { return ""; }
}
export function loadRemoteMode(storage: StorageLike | null): RemoteMode {
  try { const mode = storage?.getItem(REMOTE_MODE_KEY); return isRemoteMode(mode) ? mode : "tailscale"; }
  catch { return "tailscale"; }
}
/** Call only for an explicit tab choice or a successful explicit start, never a status poll. */
export function rememberRemoteMode(storage: StorageLike | null, mode: RemoteMode): boolean {
  if (!storage || !isRemoteMode(mode)) return false;
  try { storage.setItem(REMOTE_MODE_KEY, mode); return true; } catch { return false; }
}
/** Never stores drafts, pairing URLs, credentials, tokens, or failed-start addresses. */
export function rememberRemoteOrigin(storage: StorageLike | null, origin: string, started: boolean, mode: RemoteMode = "tailscale"): boolean {
  const normalized = normalizeRemoteOrigin(origin, mode);
  if (started !== true || !storage || !normalized) return false;
  try { storage.setItem(mode === "tailscale" ? REMOTE_ORIGIN_KEY : LOCAL_REMOTE_ORIGIN_KEY, normalized); return true; }
  catch { return false; }
}
