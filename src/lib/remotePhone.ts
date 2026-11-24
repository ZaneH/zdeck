import { newId } from "./actions";
import { activePage, findPage, isDeck, isRecord } from "./deck";
import type { Control, Deck } from "./types";

/**
 * Authenticated phone client for the private desktop service.
 *
 * The browser never sees the device token: cookies are HttpOnly and every
 * request uses `credentials: "same-origin"` plus `cache: "no-store"`. The
 * connection keeps no deck of its own; it only mirrors authenticated snapshots
 * and never falls back to a sample/browser-local deck.
 */

export const REMOTE_PROTOCOL_VERSION = 1;
export const MAX_SNAPSHOT_CHARS = 512 * 1024;
export const POLL_INTERVAL_MS = 2000;
const MAX_INPUT_CHARS = 4096;
const MAX_NAME_BYTES = 64;
const MAX_MESSAGE_CHARS = 300;
/** Bounded reconnect backoff; never faster than one second. */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

export type RemotePhase =
  | "checking"
  | "unpaired"
  | "requesting"
  | "pending"
  | "connecting"
  | "active"
  | "disconnected"
  | "denied"
  | "expired"
  | "revoked";

export const COMMAND_STATES = [
  "pending",
  "confirmed",
  "not_applied",
  "failed",
  "unknown",
] as const;
export type CommandState = (typeof COMMAND_STATES)[number];

export interface CommandResultView {
  state: CommandState;
  message: string;
}

export interface RemotePhoneSnapshot {
  phase: RemotePhase;
  deck: Deck | null;
  revision: number | null;
  pageId: string | null;
  invite: string | null;
  pairingError: string | null;
  statusText: string;
  busyControlId: string | null;
  result: CommandResultView | null;
  /** "info" marks a non-mutating resync prompt; otherwise mirrors `result.state`. */
  resultKind: "none" | "info" | CommandState;
}

export interface RemoteResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

export type RemoteFetch = (path: string, init: RequestInit) => Promise<RemoteResponse>;

export interface RemoteWebSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  close: () => void;
}

export interface RemotePhoneDeps {
  origin: string;
  eventsUrl: string;
  fetch: RemoteFetch;
  createWebSocket: (url: string) => RemoteWebSocket;
  setTimer: (callback: () => void, ms: number) => number;
  clearTimer: (id: number) => void;
  isVisible: () => boolean;
  randomId: () => string;
}

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export function isInvitationToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

/** Extract `invite` from an exact `#/pair?invite=<token>` fragment. */
function inviteFromPairHash(hash: string): string | null {
  let raw = hash;
  if (raw.startsWith("#")) raw = raw.slice(1);
  const query = raw.indexOf("?");
  if (query < 0 || raw.slice(0, query) !== "/pair") return null;
  const params = new URLSearchParams(raw.slice(query + 1));
  let found: string | null = null;
  for (const [key, value] of params) {
    if (key !== "invite" || found !== null) return null;
    if (!isInvitationToken(value)) return null;
    found = value;
  }
  return found;
}

/**
 * Accept only the exact 64 lowercase hex invitation or a same-origin HTTPS
 * root pairing link. Anything else (foreign origin, credentials, query string,
 * extra or malformed params, http) is rejected.
 */
export function parseInvitation(raw: string, origin: string): string | null {
  const input = raw.trim();
  if (!input || input.length > MAX_INPUT_CHARS) return null;
  if (isInvitationToken(input)) return input;
  if (input.startsWith("#")) return inviteFromPairHash(input);

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.origin !== origin) return null;
  if (url.username || url.password) return null;
  if (url.search) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return inviteFromPairHash(url.hash);
}

/**
 * Pure half of fragment consumption: reports whether a `#/pair` fragment is
 * present (so the caller must strip it) and the invite it carried, if valid.
 */
export function readPairFragment(
  hash: string,
  origin: string,
): { invite: string | null; clear: boolean } {
  if (!hash.startsWith("#/pair")) return { invite: null, clear: false };
  return { invite: parseInvitation(hash, origin), clear: true };
}

/**
 * Synchronously capture the invitation fragment and remove it from history.
 * Called once in `main.tsx` before React renders and again on a later
 * `hashchange`. Must never persist or log the token.
 */
export function consumeInvitationFragment(): string | null {
  if (typeof window === "undefined") return null;
  const { invite, clear } = readPairFragment(
    window.location.hash,
    window.location.origin,
  );
  if (!clear) return null;
  try {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  } catch {
    // Do not consume a secret that could not be removed from visible history.
    return null;
  }
  return invite;
}

/** Returns a user-facing error, or null when the name is acceptable. */
export function validateDeviceName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a device name.";
  if (/[\p{Cc}\p{Cf}]/u.test(name)) {
    return "Device names cannot contain control characters.";
  }
  if (new TextEncoder().encode(trimmed).length > MAX_NAME_BYTES) {
    return "Use a shorter device name.";
  }
  return null;
}

export interface RemoteSnapshot {
  revision: number;
  deck: Deck;
}

/** Protocol/shape check. Fails closed on anything but a valid desktop deck. */
export function parseSnapshot(payload: unknown): RemoteSnapshot | null {
  if (!isRecord(payload)) return null;
  if (payload.protocolVersion !== REMOTE_PROTOCOL_VERSION) return null;
  if (payload.type !== undefined && payload.type !== "snapshot") return null;
  const revision = payload.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision <= 0) {
    return null;
  }
  if (!isDeck(payload.deck)) return null;
  return { revision, deck: payload.deck };
}

export function sanitizeMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_MESSAGE_CHARS
    ? `${cleaned.slice(0, MAX_MESSAGE_CHARS - 1)}…`
    : cleaned;
}

function defaultMessage(state: CommandState): string {
  switch (state) {
    case "pending":
      return "The desktop is working on this action.";
    case "confirmed":
      return "The desktop confirmed the action.";
    case "not_applied":
      return "The desktop did not apply the action.";
    case "failed":
      return "The action failed.";
    case "unknown":
      return "Check the desktop before retrying.";
  }
}

/** Validate the typed command result. `observed` is intentionally not rendered. */
export function parseCommandResult(payload: unknown, expectedId?: string): CommandResultView | null {
  if (!isRecord(payload) || (expectedId !== undefined && payload.id !== expectedId)) return null;
  if (typeof payload.state !== "string") return null;
  if (!(COMMAND_STATES as readonly string[]).includes(payload.state)) return null;
  const state = payload.state as CommandState;
  return { state, message: sanitizeMessage(payload.message) ?? defaultMessage(state) };
}

/**
 * Build the exact command payload. Only volume carries a `value`; action kinds,
 * scenes, and executables are never sent from the phone.
 */
export function buildCommandPayload(
  id: string,
  revision: number,
  controlId: string,
  value?: number,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { id, revision, controlId };
  if (value !== undefined) {
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error("Invalid volume target.");
    payload.value = value;
  }
  return payload;
}

async function safeJson(response: RemoteResponse): Promise<Record<string, unknown> | null> {
  try {
    const body = await response.json();
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

function initialSnapshot(): RemotePhoneSnapshot {
  return {
    phase: "checking",
    deck: null,
    revision: null,
    pageId: null,
    invite: null,
    pairingError: null,
    statusText: "Checking this device…",
    busyControlId: null,
    result: null,
    resultKind: "none",
  };
}

export class RemotePhoneConnection {
  private readonly deps: RemotePhoneDeps;
  private readonly listeners = new Set<() => void>();
  private snap: RemotePhoneSnapshot = initialSnapshot();
  private epoch = 0;
  private stopped = true;
  private foreground = true;
  private ws: RemoteWebSocket | null = null;
  private socketTimer: number | null = null;
  private pollTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private statusInFlight = false;
  private pairInFlight = false;
  private commandInFlight = false;
  private reconnectAttempt = 0;
  private lastRevision = 0;
  private approved = false;
  private readonly requests = new Set<AbortController>();

  constructor(deps: RemotePhoneDeps) {
    this.deps = deps;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): RemotePhoneSnapshot => this.snap;

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private update(patch: Partial<RemotePhoneSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    this.emit();
  }

  private isStale(epoch: number): boolean {
    return this.stopped || !this.foreground || epoch !== this.epoch;
  }

  private nextEpoch(): void {
    this.epoch += 1;
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
    this.pairInFlight = false;
    this.statusInFlight = false;
    this.commandInFlight = false;
    if (this.snap.busyControlId !== null) {
      this.update({ busyControlId: null, resultKind: "unknown", result: {
        state: "unknown", message: "The connection changed during this action. Check the desktop before retrying.",
      } });
    }
  }

  private async request(path: string, init: RequestInit = {}): Promise<RemoteResponse> {
    const controller = new AbortController();
    this.requests.add(controller);
    let onAbort = () => {};
    const aborted = new Promise<RemoteResponse>((_, reject) => {
      onAbort = () => reject(new Error("Request ended."));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const timer = this.deps.setTimer(() => controller.abort(), 12000);
    try {
      const response = await Promise.race([aborted, this.deps.fetch(path, {
        ...init, credentials: "same-origin", cache: "no-store", signal: controller.signal,
      })]);
      const body = await Promise.race([aborted, response.json().catch(() => null)]);
      return { ok: response.ok, status: response.status, json: async () => body };
    } finally {
      this.deps.clearTimer(timer);
      controller.signal.removeEventListener("abort", onAbort);
      this.requests.delete(controller);
    }
  }

  /** Initial entry and explicit retry. Never mutates the server deck. */
  start(): void {
    this.stopped = false;
    this.foreground = this.deps.isVisible();
    this.closeSocket();
    this.clearPoll();
    this.clearReconnect();
    this.nextEpoch();
    const epoch = this.epoch;
    this.approved = false;
    this.reconnectAttempt = 0;
    if (this.snap.invite) {
      this.update({
        phase: "unpaired",
        pairingError: null,
        statusText: "",
      });
      return;
    }
    this.update({ phase: "checking", pairingError: null, statusText: "Checking this device…" });
    if (this.foreground) void this.resume(epoch);
  }

  /** A new pairing hash arrived while mounted: re-arm and invalidate old work. */
  adoptInvitation(invite: string): void {
    this.stopped = false;
    this.foreground = this.deps.isVisible();
    this.nextEpoch();
    this.approved = false;
    this.closeSocket();
    this.clearPoll();
    this.clearReconnect();
    this.reconnectAttempt = 0;
    this.update({
      phase: "unpaired",
      invite,
      pairingError: null,
      statusText: "",
      result: null,
      resultKind: "none",
    });
  }

  private async resume(epoch: number): Promise<void> {
    let response: RemoteResponse;
    try {
      response = await this.request("/api/v1/pair/status", { method: "GET" });
    } catch {
      if (this.isStale(epoch)) return;
      this.update({
        phase: "disconnected",
        statusText: "Could not reach the desktop. Reconnecting…",
      });
      this.scheduleReconnect(epoch);
      return;
    }
    if (this.isStale(epoch)) return;
    if (response.status === 401) {
      // No usable cookie: show the quiet pairing form, not an auth error.
      this.update({ phase: "unpaired", pairingError: null, statusText: "" });
      return;
    }
    if (!response.ok) {
      this.lostConnection(epoch);
      return;
    }
    const body = await safeJson(response);
    const status = body && typeof body.status === "string" ? body.status : null;
    if (this.isStale(epoch)) return;
    if (status === "approved") {
      this.beginConnect();
      return;
    }
    if (status === "pending") {
      this.update({ phase: "pending", statusText: "Waiting for desktop approval…" });
      this.schedulePoll();
      return;
    }
    if (status === "denied" || status === "expired" || status === "revoked") {
      this.update({ phase: status, invite: null });
      return;
    }
    this.update({ phase: "unpaired", statusText: "" });
  }

  /** One explicit POST /api/v1/pair. Never automatic, never retried. */
  async submitPairing(rawInvite: string, name: string): Promise<void> {
    if (this.stopped || !this.foreground || this.pairInFlight) return;
    const invite = parseInvitation(rawInvite, this.deps.origin);
    if (!invite) {
      this.update({ pairingError: "That pairing link is not valid. Create a fresh link." });
      return;
    }
    const nameError = validateDeviceName(name);
    if (nameError) {
      this.update({ pairingError: nameError });
      return;
    }
    const epoch = this.epoch;
    this.pairInFlight = true;
    this.update({
      phase: "requesting",
      invite: null,
      pairingError: null,
      statusText: "Requesting approval…",
    });
    let response: RemoteResponse;
    try {
      response = await this.request("/api/v1/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invitation: invite, name: name.trim() }),
      });
    } catch {
      if (this.isStale(epoch)) return;
      this.pairInFlight = false;
      this.update({
        phase: "unpaired",
        pairingError: "Could not reach the desktop. Try again with a fresh link.",
      });
      return;
    }
    if (this.isStale(epoch)) return;
    this.pairInFlight = false;
    if (response.ok) {
      const body = await safeJson(response);
      if (this.isStale(epoch)) return;
      if (body && body.status === "pending") {
        this.update({
          phase: "pending",
          invite: null,
          pairingError: null,
          statusText: "Waiting for desktop approval…",
        });
        this.schedulePoll();
        return;
      }
    }
    if (response.status === 400 || response.status === 403) {
      this.update({
        phase: "unpaired",
        pairingError: "The invitation is invalid or expired. Create a fresh link in desktop Settings.",
      });
      return;
    }
    if (response.status === 429) {
      this.update({
        phase: "unpaired",
        pairingError: "Too many pairing attempts. Wait a moment, then create a fresh link.",
      });
      return;
    }
    this.update({
      phase: "unpaired",
      pairingError: "Pairing did not start. Try again with a fresh link.",
    });
  }

  /** Stop polling and drop the local invite. Server denial is not promised. */
  cancelPairing(): void {
    this.nextEpoch();
    this.approved = false;
    this.clearPoll();
    this.clearReconnect();
    this.closeSocket();
    this.update({
      phase: "unpaired",
      invite: null,
      pairingError: null,
      statusText: "Pairing cancelled. A fresh link is required to try again.",
    });
  }

  private clearPoll(): void {
    if (this.pollTimer !== null) {
      this.deps.clearTimer(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private schedulePoll(): void {
    this.clearPoll();
    const epoch = this.epoch;
    this.pollTimer = this.deps.setTimer(() => {
      this.pollTimer = null;
      void this.pollStatus(epoch);
    }, POLL_INTERVAL_MS);
  }

  private async pollStatus(epoch: number): Promise<void> {
    if (this.isStale(epoch) || this.snap.phase !== "pending") return;
    if (this.statusInFlight || !this.foreground) return;
    this.statusInFlight = true;
    let response: RemoteResponse | null = null;
    try {
      response = await this.request("/api/v1/pair/status", { method: "GET" });
    } catch {
      response = null;
    }
    if (this.isStale(epoch) || this.snap.phase !== "pending") return;
    this.statusInFlight = false;
    if (response === null) {
      this.schedulePoll();
      return;
    }
    if (response.status === 401) {
      this.update({
        phase: "expired",
        statusText: "This approval is no longer valid. Create a fresh link in desktop Settings.",
      });
      return;
    }
    if (!response.ok) {
      this.schedulePoll();
      return;
    }
    const body = await safeJson(response);
    const status = body && typeof body.status === "string" ? body.status : null;
    if (this.isStale(epoch)) return;
    if (status === "approved") {
      this.beginConnect();
      return;
    }
    if (status === "denied" || status === "expired" || status === "revoked") {
      this.update({ phase: status });
      return;
    }
    this.schedulePoll();
  }

  private beginConnect(): void {
    this.clearPoll();
    this.closeSocket();
    this.clearReconnect();
    this.nextEpoch();
    this.approved = true;
    const epoch = this.epoch;
    this.reconnectAttempt = 0;
    this.lastRevision = 0;
    this.update({ phase: "connecting", statusText: "Connecting to the desktop…", pairingError: null });
    void this.authenticate(epoch);
  }

  private async authenticate(epoch: number): Promise<void> {
    let response: RemoteResponse;
    try {
      response = await this.request("/api/v1/state", { method: "GET" });
    } catch {
      if (!this.isStale(epoch)) this.lostConnection(epoch);
      return;
    }
    if (this.isStale(epoch)) return;
    if (response.status === 401 || response.status === 403) {
      this.terminal("revoked");
      return;
    }
    if (!response.ok) {
      this.lostConnection(epoch);
      return;
    }
    const body = await safeJson(response);
    if (this.isStale(epoch)) return;
    const snapshot = parseSnapshot(body);
    if (!snapshot) {
      this.failClosed(epoch, "The desktop deck could not be read. Reload to try again.");
      return;
    }
    this.lastRevision = snapshot.revision;
    this.update({
      deck: snapshot.deck,
      revision: snapshot.revision,
      pageId: this.choosePage(snapshot.deck),
      phase: "connecting",
      statusText: "Waiting for a live update…",
    });
    this.openSocket(epoch);
  }

  private choosePage(deck: Deck): string {
    if (this.snap.pageId && findPage(deck, this.snap.pageId)) return this.snap.pageId;
    return activePage(deck).id;
  }

  private openSocket(epoch: number): void {
    if (this.isStale(epoch)) return;
    this.closeSocket();
    let ws: RemoteWebSocket;
    try {
      ws = this.deps.createWebSocket(this.deps.eventsUrl);
    } catch {
      this.lostConnection(epoch);
      return;
    }
    this.ws = ws;
    this.socketTimer = this.deps.setTimer(() => {
      if (!this.isStale(epoch) && this.ws === ws) this.lostConnection(epoch);
    }, 12000);
    ws.onmessage = (event) => {
      if (this.isStale(epoch) || this.ws !== ws) return;
      if (this.socketTimer !== null) this.deps.clearTimer(this.socketTimer);
      this.socketTimer = null;
      this.handleMessage(event.data, epoch);
    };
    ws.onerror = () => {
      // `onclose` handles reconnect; nothing to do here.
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.isStale(epoch)) return;
      this.lostConnection(epoch);
    };
  }

  private handleMessage(data: unknown, epoch: number): void {
    // Actions stay disabled until a fresh, valid socket snapshot arrives.
    if (typeof data !== "string" || data.length > MAX_SNAPSHOT_CHARS) {
      this.failClosed(epoch, "The desktop sent an unusable update.");
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      this.failClosed(epoch, "The desktop sent an unusable update.");
      return;
    }
    const snapshot = isRecord(payload) && payload.type === "snapshot" ? parseSnapshot(payload) : null;
    if (!snapshot) {
      this.failClosed(epoch, "The desktop sent an unusable update.");
      return;
    }
    if (snapshot.revision < this.lastRevision) return; // stale, ignore
    this.lastRevision = snapshot.revision;
    this.reconnectAttempt = 0;
    this.update({
      deck: snapshot.deck,
      revision: snapshot.revision,
      pageId: this.choosePage(snapshot.deck),
      phase: "active",
      statusText: "Connected.",
    });
  }

  private closeSocket(): void {
    if (this.socketTimer !== null) this.deps.clearTimer(this.socketTimer);
    this.socketTimer = null;
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      // Closing an already-closed socket is harmless.
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      this.deps.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private lostConnection(epoch: number): void {
    if (this.isStale(epoch)) return;
    this.closeSocket();
    this.nextEpoch();
    this.update({
      phase: this.snap.deck ? "disconnected" : "connecting",
      statusText: "Disconnected. Reconnecting…",
      busyControlId: null,
    });
    this.scheduleReconnect(this.epoch);
  }

  private failClosed(epoch: number, message: string): void {
    if (this.isStale(epoch)) return;
    this.closeSocket();
    this.nextEpoch();
    this.update({ phase: "disconnected", statusText: message, busyControlId: null });
    this.scheduleReconnect(this.epoch);
  }

  private scheduleReconnect(epoch: number): void {
    if (this.isStale(epoch) || !this.foreground) return;
    this.clearReconnect();
    const delay = BACKOFF_MS[Math.min(this.reconnectAttempt, BACKOFF_MS.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.deps.setTimer(() => {
      this.reconnectTimer = null;
      if (this.isStale(epoch) || !this.foreground) return;
      // Fresh authentication and snapshot only; no replay of commands.
      if (this.approved) void this.authenticate(epoch);
      else void this.resume(epoch);
    }, delay);
  }

  /** Non-mutating resync after a stale-revision conflict. */
  private resync(): void {
    if (this.stopped || !this.foreground) return;
    this.nextEpoch();
    const epoch = this.epoch;
    this.closeSocket();
    this.clearReconnect();
    this.reconnectAttempt = 0;
    this.lastRevision = 0;
    this.update({ phase: "connecting", statusText: "Refreshing the saved deck…" });
    void this.authenticate(epoch);
  }

  private terminal(phase: "denied" | "expired" | "revoked"): void {
    this.nextEpoch();
    this.approved = false;
    this.closeSocket();
    this.clearPoll();
    this.clearReconnect();
    this.commandInFlight = false;
    this.pairInFlight = false;
    this.statusInFlight = false;
    this.update({
      phase,
      invite: null,
      busyControlId: null,
      statusText: "",
    });
  }

  private async sendCommand(controlId: string, value?: number): Promise<void> {
    if (this.stopped || this.snap.phase !== "active" || this.snap.revision === null) return;
    if (this.commandInFlight) return;
    const epoch = this.epoch;
    const revision = this.snap.revision;
    const id = this.deps.randomId();
    this.commandInFlight = true;
    this.update({
      busyControlId: controlId,
      result: { state: "pending", message: "Sending to the desktop…" },
      resultKind: "pending",
    });
    let response: RemoteResponse;
    try {
      response = await this.request("/api/v1/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildCommandPayload(id, revision, controlId, value)),
      });
    } catch {
      if (this.isStale(epoch)) return;
      this.commandInFlight = false;
      this.update({
        busyControlId: null,
        result: {
          state: "unknown",
          message: "No reply from the desktop. Check the desktop before retrying.",
        },
        resultKind: "unknown",
      });
      return;
    }
    if (this.isStale(epoch)) return;
    this.commandInFlight = false;
    if (response.status === 401 || response.status === 403) {
      this.terminal("revoked");
      return;
    }
    if (response.status === 409) {
      this.update({
        busyControlId: null,
        result: {
          state: "unknown",
          message: "The saved deck changed. Check the current page, then press again.",
        },
        resultKind: "info",
      });
      this.resync();
      return;
    }
    if (response.status >= 500) {
      this.update({
        busyControlId: null,
        result: {
          state: "unknown",
          message: "The desktop gave no usable result. Check the desktop before retrying.",
        },
        resultKind: "unknown",
      });
      return;
    }
    if (!response.ok) {
      const body = await safeJson(response);
      if (this.isStale(epoch)) return;
      const message =
        sanitizeMessage(body?.error) ?? "The desktop declined the action.";
      this.update({
        busyControlId: null,
        result: { state: "not_applied", message },
        resultKind: "not_applied",
      });
      return;
    }
    const body = await safeJson(response);
    if (this.isStale(epoch)) return;
    const parsed = parseCommandResult(body, id);
    if (!parsed) {
      this.update({
        busyControlId: null,
        result: {
          state: "unknown",
          message: "The desktop reply was unreadable. Check the desktop before retrying.",
        },
        resultKind: "unknown",
      });
      return;
    }
    if (parsed.state === "pending") {
      this.update({ busyControlId: null, resultKind: "unknown", result: {
        state: "unknown", message: "The desktop is still processing this action. Check the desktop before retrying.",
      } });
      return;
    }
    this.update({ busyControlId: null, result: parsed, resultKind: parsed.state });
  }

  /** A tapped control. Volume never sends through this path. */
  pressControl(control: Control): void {
    if (control.action === "volume") return;
    void this.sendCommand(control.id);
  }

  /** Deliberate slider release / key-up. Value is the target, not a reading. */
  commitVolume(control: Control, value: number): void {
    if (control.action !== "volume" || !Number.isFinite(value) || value < 0 || value > 100) return;
    void this.sendCommand(control.id, value);
  }

  /** Local page selection only. */
  setPage(pageId: string): void {
    if (!this.snap.deck || !findPage(this.snap.deck, pageId)) return;
    this.update({ pageId });
  }

  onHidden(): void {
    if (this.stopped || !this.foreground) return;
    this.foreground = false;
    this.nextEpoch();
    this.closeSocket();
    this.clearPoll();
    this.clearReconnect();
    this.commandInFlight = false;
    this.statusInFlight = false;
    if (
      this.snap.phase === "active" ||
      this.snap.phase === "connecting" ||
      this.snap.phase === "disconnected" ||
      this.snap.phase === "requesting"
    ) {
      this.update({
        phase: this.snap.phase === "requesting" ? "checking" : "disconnected",
        statusText: "Paused while this app is in the background.",
        busyControlId: null,
      });
    }
  }

  onVisible(): void {
    if (this.stopped || this.foreground || !this.deps.isVisible()) return;
    this.foreground = true;
    this.nextEpoch();
    const epoch = this.epoch;
    this.reconnectAttempt = 0;
    if (this.snap.phase === "pending") {
      this.update({ statusText: "Waiting for desktop approval…" });
      this.schedulePoll();
      return;
    }
    if (this.snap.phase === "checking") {
      void this.resume(epoch);
      return;
    }
    if (
      this.snap.phase === "active" ||
      this.snap.phase === "connecting" ||
      this.snap.phase === "disconnected"
    ) {
      this.update({ phase: "connecting", statusText: "Reconnecting…" });
      if (this.approved) void this.authenticate(epoch);
      else void this.resume(epoch);
    }
  }

  onPageshow(): void {
    this.onVisible();
  }

  onOnline(): void {
    if (this.stopped || !this.foreground) return;
    const phase = this.snap.phase;
    if (phase === "pending") {
      this.schedulePoll();
      return;
    }
    if (phase === "disconnected" || phase === "connecting") {
      this.clearReconnect();
      this.nextEpoch();
      const epoch = this.epoch;
      this.reconnectAttempt = 0;
      this.update({ phase: "connecting", statusText: "Reconnecting…" });
      if (this.approved) void this.authenticate(epoch);
      else void this.resume(epoch);
    }
  }

  /** Stop everything. Any in-flight callback is ignored via the epoch check. */
  stop(): void {
    this.stopped = true;
    this.foreground = true;
    this.nextEpoch();
    this.closeSocket();
    this.clearPoll();
    this.clearReconnect();
    this.commandInFlight = false;
    this.pairInFlight = false;
    this.statusInFlight = false;
    this.reconnectAttempt = 0;
  }
}

/** Production dependencies. Only used inside the browser surface. */
export function browserDeps(): RemotePhoneDeps {
  const secure = window.location.protocol === "https:";
  const wsProtocol = secure ? "wss:" : "ws:";
  return {
    origin: window.location.origin,
    eventsUrl: `${wsProtocol}//${window.location.host}/api/v1/events`,
    fetch: (path, init) => window.fetch(path, init),
    createWebSocket: (url) => new WebSocket(url) as unknown as RemoteWebSocket,
    setTimer: (callback, ms) => window.setTimeout(callback, ms),
    clearTimer: (id) => window.clearTimeout(id),
    isVisible: () => document.visibilityState === "visible",
    randomId: () => newId("cmd"),
  };
}
