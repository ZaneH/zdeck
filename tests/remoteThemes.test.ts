import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createDefaultDeck, setCustomTheme } from "../src/lib/deck";
import { parseExternalThemes, parseSnapshot, RemotePhoneConnection } from "../src/lib/remotePhone";
import type { RemoteFetch, RemotePhoneDeps, RemoteResponse, RemoteWebSocket } from "../src/lib/remotePhone";
import { parseThemePackageBytes } from "../src/lib/themePackage";
import type { CustomThemeReference, ThemePackage } from "../src/lib/themePackage";
import type { Deck } from "../src/lib/types";
import type { InstalledTheme } from "../src/lib/customThemes";

const source = readFileSync(new URL("./fixtures/theme-packages/midnight-maze.json", import.meta.url), "utf8");
const pkg = parseThemePackageBytes(new TextEncoder().encode(source)) as ThemePackage;
const reference: CustomThemeReference = { id: pkg.id, version: pkg.version, digest: "a".repeat(64) };
// Matches the native wire format; the client derives the validated package from source.
const externalTheme = { reference, source };
const installedTheme: InstalledTheme = { package: pkg, ...externalTheme };
const ORIGIN = "https://host.ts.net";
const EVENTS_URL = "wss://host.ts.net/api/v1/events";

function snapshotBody(revision: number, deck: Deck, extra: Record<string, unknown> = {}) {
  return { type: "snapshot", protocolVersion: 1, revision, deck, ...extra };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function jsonResponse(status: number, body: unknown): RemoteResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

class FakeSocket implements RemoteWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close(): void {}
  emit(data: unknown): void { this.onmessage?.({ data: JSON.stringify(data) }); }
}

function harness(handler: (path: string) => RemoteResponse | Promise<RemoteResponse>) {
  const sockets: FakeSocket[] = [];
  let timers = 1;
  const deps: RemotePhoneDeps = {
    origin: ORIGIN, eventsUrl: EVENTS_URL,
    fetch: (async (path: string) => handler(path)) as RemoteFetch,
    createWebSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    setTimer: () => timers++, clearTimer: () => {},
    isVisible: () => true, randomId: () => "cmd_1",
  };
  return { deps, sockets };
}

describe("authenticated external theme payload", () => {
  it("strictly parses the native source/reference wire format", () => {
    expect(parseExternalThemes([externalTheme])).toEqual([installedTheme]);
    expect(parseExternalThemes([])).toEqual([]);
    expect(parseExternalThemes([{ ...externalTheme, source: "not json" }])).toBeNull();
    expect(parseExternalThemes([{ ...externalTheme, reference: { ...reference, digest: "A".repeat(64) } }])).toBeNull();
    expect(parseExternalThemes([{ ...externalTheme, reference: { ...reference, version: "9.9.9" } }])).toBeNull();
    expect(parseExternalThemes([{ ...externalTheme, package: { ...pkg, version: "9.9.9" } }])).toBeNull();
    expect(parseExternalThemes([{ ...externalTheme, extra: true }])).toBeNull();
    expect(parseExternalThemes(Array.from({ length: 17 }, (_, index) => ({
      ...externalTheme, reference: { ...reference, digest: index.toString(16).padStart(64, "0") },
    })))).toBeNull();
  });

  it("enforces the serialized externalThemes byte budget", () => {
    const padded = source + " ".repeat(15 * 1024);
    const entries = Array.from({ length: 9 }, (_, index) => ({
      source: padded, reference: { ...reference, digest: index.toString(16).padStart(64, "0") },
    }));
    expect(parseExternalThemes(entries)).toBeNull();
  });

  it("rejects malformed payloads fail-closed and keeps references with a visible warning", () => {
    const deck = setCustomTheme(createDefaultDeck(), reference, "dark");
    const parsed = parseSnapshot(snapshotBody(3, deck, { externalThemes: [externalTheme] }));
    expect(parsed?.externalThemes).toEqual([installedTheme]);
    expect(parsed?.deck.customTheme).toEqual(reference);
    expect(parseSnapshot(snapshotBody(3, deck, { externalThemes: [{ ...externalTheme, source: "{}" }] }))).toBeNull();
    expect(parseSnapshot(snapshotBody(3, deck, { externalThemes: [externalTheme], themeError: "" }))).toBeNull();
    const absent = parseSnapshot(snapshotBody(3, deck));
    expect(absent?.deck.customTheme).toEqual(reference);
    expect(absent?.externalThemes).toBeUndefined();
  });
});

describe("remote state propagation", () => {
  it("carries exact definitions through reconnect and warns only when absent", async () => {
    const deck = setCustomTheme(createDefaultDeck(), reference, "dark");
    const seen = harness((path) => {
      if (path === "/api/v1/pair/status") return jsonResponse(200, { requestId: "r1", status: "approved" });
      if (path === "/api/v1/state") return jsonResponse(200, snapshotBody(3, deck, { externalThemes: [externalTheme] }));
      return jsonResponse(404, {});
    });
    const connection = new RemotePhoneConnection(seen.deps);
    connection.start();
    for (let index = 0; index < 4; index += 1) await flush();
    expect(seen.sockets).toHaveLength(1);
    expect(connection.getSnapshot().externalThemes).toEqual([installedTheme]);
    expect(connection.getSnapshot().themeError).toBeNull();
    expect(connection.getSnapshot().deck?.customTheme).toEqual(reference);

    seen.sockets[0].emit(snapshotBody(4, deck));
    for (let index = 0; index < 4; index += 1) await flush();
    expect(connection.getSnapshot().deck?.customTheme).toEqual(reference);
    expect(connection.getSnapshot().externalThemes).toEqual([]);
    expect(connection.getSnapshot().themeError).toContain("midnight-maze 0.1.0");

    seen.sockets[0].emit(snapshotBody(5, deck, { externalThemes: [externalTheme] }));
    for (let index = 0; index < 4; index += 1) await flush();
    expect(connection.getSnapshot().externalThemes).toEqual([installedTheme]);
    expect(connection.getSnapshot().themeError).toBeNull();
  });
});
