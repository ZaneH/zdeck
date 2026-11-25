import { describe, expect, it } from "vitest";
import { createDefaultDeck } from "../src/lib/deck";
import {
  buildCommandPayload,
  parseCommandResult,
  parseInvitation,
  parseSnapshot,
  readPairFragment,
  RemotePhoneConnection,
  validateDeviceName,
} from "../src/lib/remotePhone";
import type {
  RemoteFetch,
  RemotePhoneDeps,
  RemoteResponse,
  RemoteWebSocket,
} from "../src/lib/remotePhone";
import type { Deck, PluginControl } from "../src/lib/types";

const ORIGIN = "https://host.ts.net";
const EVENTS_URL = "wss://host.ts.net/api/v1/events";
const TOKEN = "a".repeat(64);

function jsonResponse(status: number, body: unknown): RemoteResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function snapshotBody(revision: number, deck: Deck): Record<string, unknown> {
  return { type: "snapshot", protocolVersion: 1, revision, deck };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function createTestClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimer(fn: () => void, ms: number): number {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer(id: number): void {
      timers.delete(id);
    },
    async advance(ms: number): Promise<void> {
      now += ms;
      let ran = true;
      while (ran) {
        ran = false;
        for (const [id, timer] of [...timers]) {
          if (timer.at <= now) {
            timers.delete(id);
            timer.fn();
            ran = true;
          }
        }
        await flush();
      }
      await flush();
    },
  };
}

class FakeSocket implements RemoteWebSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  close(): void {
    this.closed = true;
  }

  emit(data: unknown): void {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }

  drop(): void {
    this.onclose?.();
  }
}

type Handler = (path: string, init: RequestInit) => RemoteResponse;

function createHarness(handler: Handler) {
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const fetchImpl: RemoteFetch = async (path, init) => {
    calls.push({ path, init });
    return handler(path, init);
  };
  const clock = createTestClock();
  const sockets: FakeSocket[] = [];
  let idCount = 0;
  const deps: RemotePhoneDeps = {
    origin: ORIGIN,
    eventsUrl: EVENTS_URL,
    fetch: fetchImpl,
    createWebSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isVisible: () => true,
    randomId: () => `cmd_${(idCount += 1)}`,
  };
  return { deps, sockets, clock, calls };
}

const sampleDeck = createDefaultDeck();

function makeStandardHarness(command?: Handler) {
  let statusCalls = 0;
  const harness = createHarness((path, init) => {
    if (path === "/api/v1/pair/status") {
      statusCalls += 1;
      if (statusCalls === 1) return jsonResponse(401, { error: "no cookie" });
      return jsonResponse(200, { requestId: "r1", status: "approved" });
    }
    if (path === "/api/v1/pair") return jsonResponse(200, { requestId: "r1", status: "pending" });
    if (path === "/api/v1/state") {
      return jsonResponse(200, { protocolVersion: 1, revision: 3, deck: sampleDeck });
    }
    if (path === "/api/v1/commands" && command) return command(path, init);
    return jsonResponse(404, { error: "nope" });
  });
  return harness;
}

async function driveToActive(command?: Handler): Promise<{
  connection: RemotePhoneConnection;
  sockets: FakeSocket[];
  clock: ReturnType<typeof createTestClock>;
  calls: Array<{ path: string; init: RequestInit }>;
}> {
  const harness = makeStandardHarness(command);
  const connection = new RemotePhoneConnection(harness.deps);
  connection.start();
  await flush();
  await connection.submitPairing(TOKEN, "My phone");
  await flush();
  await harness.clock.advance(2000);
  harness.sockets[0].emit(snapshotBody(3, sampleDeck));
  await flush();
  expect(connection.getSnapshot().phase).toBe("active");
  return { connection, ...harness };
}

describe("saved plugin phone buttons", () => {
  it("accepts v2 plugin snapshots but never legacy phone snapshots", () => {
    expect(parseSnapshot(snapshotBody(3, { ...sampleDeck, version: 1 } as unknown as Deck))).toBeNull();
  });

  it("sends only the saved control ID, rejects plugin slider values and arbitrary argument overrides", async () => {
    const { connection, sockets, calls } = await driveToActive((_, init) => jsonResponse(200, {
      id: JSON.parse(String(init.body)).id, state: "confirmed", message: "Command completed.",
    }));
    const control: PluginControl = { id: "spotify-volume", label: "Spotify volume", action: "plugin",
      pluginId: "spotify", pluginAction: "set-volume", pluginArgs: { volume: 50 } };
    const deck = structuredClone(sampleDeck);
    deck.pages[0].controls.push(control);
    sockets[0].emit(snapshotBody(4, deck));
    await flush();
    connection.commitVolume(control, 90);
    connection.commitVolume({ id: control.id, label: "Forged", action: "volume", volume: 90 }, 90);
    await flush();
    expect(calls.filter((call) => call.path === "/api/v1/commands")).toHaveLength(0);
    connection.pressControl({ ...control, pluginArgs: { volume: 99 } });
    await flush();
    const commands = calls.filter((call) => call.path === "/api/v1/commands");
    expect(commands).toHaveLength(1);
    expect(JSON.parse(String(commands[0].init.body))).toEqual({ id: expect.any(String), revision: 4, controlId: control.id });
    expect(() => buildCommandPayload("r1", 4, control.id, { volume: 99 } as unknown as number)).toThrow();
    connection.stop();
  });
});

describe("invitation parsing", () => {
  it("accepts the exact token and a same-origin HTTPS root pairing link", () => {
    expect(parseInvitation(TOKEN, ORIGIN)).toBe(TOKEN);
    expect(parseInvitation(`  ${TOKEN}  `, ORIGIN)).toBe(TOKEN);
    expect(parseInvitation(`https://host.ts.net/#/pair?invite=${TOKEN}`, ORIGIN)).toBe(TOKEN);
    expect(parseInvitation(`#/pair?invite=${TOKEN}`, ORIGIN)).toBe(TOKEN);
  });

  it("rejects foreign origins, credentials, query strings, paths, http, and malformed tokens", () => {
    expect(parseInvitation(`https://evil.ts.net/#/pair?invite=${TOKEN}`, ORIGIN)).toBeNull();
    expect(parseInvitation(`https://user:pass@host.ts.net/#/pair?invite=${TOKEN}`, ORIGIN)).toBeNull();
    expect(parseInvitation(`https://host.ts.net/?x=1#/pair?invite=${TOKEN}`, ORIGIN)).toBeNull();
    expect(parseInvitation(`https://host.ts.net/some/path#/pair?invite=${TOKEN}`, ORIGIN)).toBeNull();
    expect(parseInvitation(`http://host.ts.net/#/pair?invite=${TOKEN}`, ORIGIN)).toBeNull();
    expect(parseInvitation(`#/pair?invite=${TOKEN}&extra=1`, ORIGIN)).toBeNull();
    expect(parseInvitation(`#/pair?invite=${TOKEN.toUpperCase()}`, ORIGIN)).toBeNull();
    expect(parseInvitation("b".repeat(63), ORIGIN)).toBeNull();
    expect(parseInvitation("b".repeat(65), ORIGIN)).toBeNull();
    expect(parseInvitation("z".repeat(64), ORIGIN)).toBeNull();
    expect(parseInvitation("not a link", ORIGIN)).toBeNull();
  });

  it("marks only #/pair fragments for removal", () => {
    expect(readPairFragment(`#/pair?invite=${TOKEN}`, ORIGIN)).toEqual({
      invite: TOKEN,
      clear: true,
    });
    expect(readPairFragment("#/pair?invite=bad", ORIGIN)).toEqual({
      invite: null,
      clear: true,
    });
    expect(readPairFragment("#/phone", ORIGIN)).toEqual({ invite: null, clear: false });
    expect(readPairFragment("", ORIGIN)).toEqual({ invite: null, clear: false });
  });
});

describe("device name validation", () => {
  it("accepts blank-free names within 64 UTF-8 bytes", () => {
    expect(validateDeviceName("My phone")).toBeNull();
    expect(validateDeviceName("a".repeat(64))).toBeNull();
    expect(validateDeviceName("é".repeat(32))).toBeNull();
  });

  it("rejects blank, control characters, and names over 64 bytes", () => {
    expect(validateDeviceName("   ")).not.toBeNull();
    expect(validateDeviceName("bad\u0007name")).not.toBeNull();
    expect(validateDeviceName("Phone\n")).not.toBeNull();
    expect(validateDeviceName("a".repeat(65))).not.toBeNull();
    expect(validateDeviceName("é".repeat(33))).not.toBeNull();
  });
});

describe("protocol validation", () => {
  it("accepts only protocol v1 with a safe positive revision and a real deck", () => {
    expect(parseSnapshot(snapshotBody(3, sampleDeck))).toEqual({ revision: 3, deck: sampleDeck });
    expect(parseSnapshot({ protocolVersion: 1, revision: 3, deck: sampleDeck })?.revision).toBe(3);
    expect(parseSnapshot({ ...snapshotBody(3, sampleDeck), protocolVersion: 2 })).toBeNull();
    expect(parseSnapshot({ ...snapshotBody(3, sampleDeck), type: "other" })).toBeNull();
    expect(parseSnapshot({ ...snapshotBody(3, sampleDeck), revision: 0 })).toBeNull();
    expect(parseSnapshot({ ...snapshotBody(3, sampleDeck), revision: -1 })).toBeNull();
    expect(parseSnapshot({ ...snapshotBody(3, sampleDeck), revision: 1.5 })).toBeNull();
    expect(parseSnapshot({ ...snapshotBody(3, sampleDeck), revision: Number.MAX_SAFE_INTEGER + 1 })).toBeNull();
    expect(parseSnapshot(snapshotBody(3, { ...sampleDeck, pages: [] }))).toBeNull();
    expect(parseSnapshot("nope")).toBeNull();
  });

  it("validates typed command results and sanitizes their messages", () => {
    expect(parseCommandResult({ state: "confirmed", message: "Action confirmed." })).toEqual({
      state: "confirmed",
      message: "Action confirmed.",
    });
    expect(parseCommandResult({ state: "unknown" })?.message).toBeTruthy();
    expect(parseCommandResult({ state: "bogus", message: "x" })).toBeNull();
    expect(parseCommandResult({ state: "failed", message: "line\u0000one" })?.message).toBe("line one");
  });
});

describe("command payloads", () => {
  it("sends only id, revision, controlId, and a bounded volume value", () => {
    expect(buildCommandPayload("cmd_1", 12, "ctl_live")).toEqual({
      id: "cmd_1",
      revision: 12,
      controlId: "ctl_live",
    });
    const volume = buildCommandPayload("cmd_2", 12, "ctl_vol", 42.5);
    expect(volume).toEqual({ id: "cmd_2", revision: 12, controlId: "ctl_vol", value: 42.5 });
    for (const value of [150, -1, NaN, Infinity]) {
      expect(() => buildCommandPayload("cmd_3", 12, "ctl_vol", value)).toThrow();
    }
    for (const payload of [volume, buildCommandPayload("cmd_4", 1, "x")]) {
      expect(payload).not.toHaveProperty("action");
      expect(payload).not.toHaveProperty("scene");
      expect(payload).not.toHaveProperty("kind");
    }
  });
});

describe("connection lifecycle", () => {
  it("resumes quietly on 401 and pairs only on explicit submission", async () => {
    let statusCalls = 0;
    const { deps, calls } = createHarness((path) => {
      if (path === "/api/v1/pair/status") {
        statusCalls += 1;
        return jsonResponse(401, { error: "no cookie" });
      }
      if (path === "/api/v1/pair") return jsonResponse(200, { requestId: "r1", status: "pending" });
      return jsonResponse(404, { error: "nope" });
    });
    const connection = new RemotePhoneConnection(deps);
    connection.start();
    await flush();
    expect(statusCalls).toBe(1);
    expect(connection.getSnapshot().phase).toBe("unpaired");
    expect(connection.getSnapshot().pairingError).toBeNull();
    expect(calls.filter((call) => call.path === "/api/v1/pair").length).toBe(0);

    await connection.submitPairing(TOKEN, "My phone");
    await flush();
    expect(connection.getSnapshot().phase).toBe("pending");
    const pairCall = calls.find((call) => call.path === "/api/v1/pair");
    expect(pairCall?.init.credentials).toBe("same-origin");
    expect(pairCall?.init.cache).toBe("no-store");
    expect(pairCall?.init.body).toBe(JSON.stringify({ invitation: TOKEN, name: "My phone" }));
  });

  it("resumes a remembered approved cookie without an invitation or pairing POST", async () => {
    const harness = createHarness((path) => {
      if (path === "/api/v1/pair/status") return jsonResponse(200, { requestId: "remembered", status: "approved" });
      if (path === "/api/v1/state") return jsonResponse(200, { protocolVersion: 1, revision: 3, deck: sampleDeck });
      return jsonResponse(404, { error: "unexpected request" });
    });
    const connection = new RemotePhoneConnection(harness.deps);
    connection.start();
    await flush();
    expect(connection.getSnapshot().phase).toBe("connecting");
    await flush(); // Resume status is followed by a separate authenticated state read.
    expect(harness.sockets).toHaveLength(1);
    harness.sockets[0].emit(snapshotBody(3, sampleDeck));
    await flush();
    expect(connection.getSnapshot().phase).toBe("active");
    expect(harness.calls.some((call) => call.path === "/api/v1/pair")).toBe(false);
    expect(harness.calls.every((call) => call.init.credentials === "same-origin")).toBe(true);
    connection.stop();
  });

  it("captures an invite without sending any request until submission", async () => {
    const { deps, calls } = makeStandardHarness();
    const connection = new RemotePhoneConnection(deps);
    connection.adoptInvitation(TOKEN);
    await flush();
    expect(connection.getSnapshot().phase).toBe("unpaired");
    expect(connection.getSnapshot().invite).toBe(TOKEN);
    expect(calls.length).toBe(0);
  });

  it("polls to approval, authenticates, and only then enables actions on a valid snapshot", async () => {
    const harness = makeStandardHarness();
    const connection = new RemotePhoneConnection(harness.deps);
    connection.start();
    await flush();
    await connection.submitPairing(TOKEN, "My phone");
    await flush();
    expect(connection.getSnapshot().phase).toBe("pending");

    await harness.clock.advance(2000);
    expect(connection.getSnapshot().phase).toBe("connecting");
    expect(harness.sockets.length).toBe(1);
    expect(connection.getSnapshot().revision).toBe(3);
    expect(connection.getSnapshot().deck).toEqual(sampleDeck);
    expect(connection.getSnapshot().phase).not.toBe("active");

    harness.sockets[0].emit(snapshotBody(3, sampleDeck));
    await flush();
    expect(connection.getSnapshot().phase).toBe("active");
    expect(connection.getSnapshot().deck).toEqual(sampleDeck);
  });

  it("stops at denied and requires a fresh invitation", async () => {
    let statusCalls = 0;
    const { deps, clock } = createHarness((path) => {
      if (path === "/api/v1/pair/status") {
        statusCalls += 1;
        if (statusCalls === 1) return jsonResponse(401, { error: "no cookie" });
        return jsonResponse(200, { requestId: "r1", status: "denied" });
      }
      if (path === "/api/v1/pair") return jsonResponse(200, { requestId: "r1", status: "pending" });
      return jsonResponse(404, { error: "nope" });
    });
    const connection = new RemotePhoneConnection(deps);
    connection.start();
    await flush();
    await connection.submitPairing(TOKEN, "My phone");
    await flush();
    await clock.advance(2000);
    expect(connection.getSnapshot().phase).toBe("denied");
    expect(connection.getSnapshot().invite).toBeNull();
  });

  it("sends one exact command and never retries a lost reply", async () => {
    let commandCalls = 0;
    const { connection, calls } = await driveToActive(() => {
      commandCalls += 1;
      throw new Error("network lost");
    });
    const control = sampleDeck.pages[0].controls[0];
    connection.pressControl(control);
    await flush();
    expect(commandCalls).toBe(1);
    expect(connection.getSnapshot().result?.state).toBe("unknown");
    expect(connection.getSnapshot().resultKind).toBe("unknown");
    const posted = calls.filter((call) => call.path === "/api/v1/commands");
    expect(posted.length).toBe(1);
    expect(posted[0].init.body).toBe(
      JSON.stringify({ id: "cmd_1", revision: 3, controlId: control.id }),
    );
  });

  it("sends a volume target only through commitVolume", async () => {
    const { connection, calls } = await driveToActive((_path, init) => {
      return jsonResponse(200, { id: JSON.parse(String(init.body)).id, state: "confirmed", message: "Action confirmed." });
    });
    const volume = sampleDeck.pages[1].controls[0];
    expect(volume.action).toBe("volume");
    connection.pressControl(volume);
    await flush();
    expect(calls.filter((call) => call.path === "/api/v1/commands").length).toBe(0);

    connection.commitVolume(volume, 73);
    await flush();
    const posted = calls.filter((call) => call.path === "/api/v1/commands");
    expect(posted.length).toBe(1);
    expect(posted[0].init.body).toBe(
      JSON.stringify({ id: "cmd_1", revision: 3, controlId: volume.id, value: 73 }),
    );
    expect(connection.getSnapshot().result?.state).toBe("confirmed");
  });

  it("resyncs without mutation on a stale-revision conflict", async () => {
    const { connection, sockets, calls } = await driveToActive(() =>
      jsonResponse(409, { error: "stale" }),
    );
    connection.pressControl(sampleDeck.pages[0].controls[0]);
    await flush();
    expect(calls.filter((call) => call.path === "/api/v1/commands").length).toBe(1);
    expect(connection.getSnapshot().resultKind).toBe("info");
    expect(connection.getSnapshot().phase).toBe("connecting");
    await flush();
    expect(sockets.length).toBe(2);
  });

  it("disables actions while hidden and ignores stale socket callbacks", async () => {
    const { connection, sockets } = await driveToActive();
    connection.onHidden();
    expect(connection.getSnapshot().phase).toBe("disconnected");

    sockets[0].emit(snapshotBody(9, sampleDeck));
    expect(connection.getSnapshot().phase).toBe("disconnected");
    expect(connection.getSnapshot().revision).toBe(3);

    connection.onVisible();
    await flush();
    expect(connection.getSnapshot().phase).toBe("connecting");
    expect(sockets.length).toBe(2);
    sockets[1].emit(snapshotBody(4, sampleDeck));
    await flush();
    expect(connection.getSnapshot().phase).toBe("active");
    expect(connection.getSnapshot().revision).toBe(4);
  });

  it("ignores a stale revision and fails closed on an invalid snapshot", async () => {
    const { connection, sockets } = await driveToActive();
    sockets[0].emit(snapshotBody(2, sampleDeck));
    expect(connection.getSnapshot().revision).toBe(3);
    expect(connection.getSnapshot().phase).toBe("active");

    sockets[0].emit({ type: "snapshot", protocolVersion: 2, revision: 5, deck: sampleDeck });
    expect(connection.getSnapshot().phase).toBe("disconnected");
  });

  it("fails closed on an oversized socket message", async () => {
    const { connection, sockets } = await driveToActive();
    sockets[0].emit("x".repeat(512 * 1024 + 1));
    expect(connection.getSnapshot().phase).toBe("disconnected");
  });

  it("cancel ignores a late pairing body instead of reviving pending approval", async () => {
    const { deps, clock, calls } = makeStandardHarness();
    let finishBody!: (body: unknown) => void;
    const body = new Promise<unknown>((resolve) => { finishBody = resolve; });
    const fetch = deps.fetch;
    deps.fetch = async (path, init) => path === '/api/v1/pair'
      ? { ok: true, status: 200, json: () => body }
      : fetch(path, init);
    const connection = new RemotePhoneConnection(deps);
    connection.adoptInvitation(TOKEN);
    const pairing = connection.submitPairing(TOKEN, 'Phone');
    await flush();
    connection.cancelPairing();
    finishBody({ status: 'pending' });
    await pairing;
    await clock.advance(10000);
    expect(connection.getSnapshot().phase).toBe('unpaired');
    expect(connection.getSnapshot().invite).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("resumes a pairing check after backgrounding during the pairing POST", async () => {
    const { deps, calls } = makeStandardHarness();
    const fetch = deps.fetch;
    deps.fetch = async (path, init) => path === '/api/v1/pair'
      ? new Promise<RemoteResponse>(() => {}) : fetch(path, init);
    const connection = new RemotePhoneConnection(deps);
    connection.adoptInvitation(TOKEN);
    void connection.submitPairing(TOKEN, 'Phone');
    await flush();
    connection.onHidden();
    expect(connection.getSnapshot().phase).toBe('checking');
    connection.onVisible();
    await flush();
    expect(calls.filter(call => call.path === '/api/v1/pair/status')).toHaveLength(1);
    expect(connection.getSnapshot().phase).toBe('unpaired');
  });

  it("does not start network requests in a hidden page", async () => {
    const { deps, calls } = makeStandardHarness();
    let visible = false;
    deps.isVisible = () => visible;
    const connection = new RemotePhoneConnection(deps);
    connection.start();
    connection.onPageshow();
    await flush();
    expect(calls).toHaveLength(0);
    visible = true;
    connection.onVisible();
    await flush();
    expect(calls).toHaveLength(1);
  });

  it("marks an in-flight action unknown on hide and never replays it", async () => {
    const harness = makeStandardHarness();
    const fetch = harness.deps.fetch;
    let posts = 0;
    harness.deps.fetch = async (path, init) => {
      if (path === '/api/v1/commands') { posts += 1; return new Promise<RemoteResponse>(() => {}); }
      return fetch(path, init);
    };
    const connection = new RemotePhoneConnection(harness.deps);
    connection.start(); await flush();
    await connection.submitPairing(TOKEN, 'Phone');
    await harness.clock.advance(2000);
    harness.sockets[0].emit(snapshotBody(3, sampleDeck));
    connection.pressControl(sampleDeck.pages[0].controls[0]);
    await flush();
    connection.onHidden();
    expect(connection.getSnapshot().result?.state).toBe('unknown');
    connection.onVisible(); await flush();
    harness.sockets[1].emit(snapshotBody(3, sampleDeck));
    await harness.clock.advance(20000);
    expect(posts).toBe(1);
  });

  it("bounds stalled command bodies and reports unknown without retry", async () => {
    const { connection, clock, calls } = await driveToActive(() => ({
      ok: true, status: 200, json: () => new Promise<unknown>(() => {}),
    }));
    connection.pressControl(sampleDeck.pages[0].controls[0]);
    await flush();
    await clock.advance(12001);
    expect(connection.getSnapshot().result?.state).toBe('unknown');
    expect(connection.getSnapshot().busyControlId).toBeNull();
    expect(calls.filter(call => call.path === '/api/v1/commands')).toHaveLength(1);
  });

  it("bounds a socket that never sends its initial snapshot", async () => {
    const harness = makeStandardHarness();
    const connection = new RemotePhoneConnection(harness.deps);
    connection.start(); await flush();
    await connection.submitPairing(TOKEN, 'Phone');
    await harness.clock.advance(2000);
    expect(connection.getSnapshot().phase).toBe('connecting');
    await harness.clock.advance(12000);
    expect(connection.getSnapshot().phase).toBe('disconnected');
    expect(harness.sockets[0].closed).toBe(true);
    connection.pressControl(sampleDeck.pages[0].controls[0]);
    await flush();
    expect(harness.calls.filter(call => call.path === '/api/v1/commands')).toHaveLength(0);
  });

  it("does not leave an unfinished server result looking like a completed request", async () => {
    const { connection } = await driveToActive((_path, init) => jsonResponse(200, {
      id: JSON.parse(String(init.body)).id, state: 'pending', message: 'Still running',
    }));
    connection.pressControl(sampleDeck.pages[0].controls[0]);
    await flush();
    expect(connection.getSnapshot().result?.state).toBe('unknown');
    expect(connection.getSnapshot().result?.message).toContain('Check the desktop before retrying');
  });

  it("does not accept another command's confirmation", async () => {
    const { connection } = await driveToActive(() => jsonResponse(200, {
      id: 'unrelated', state: 'confirmed', message: 'Wrong result',
    }));
    connection.pressControl(sampleDeck.pages[0].controls[0]);
    await flush();
    expect(connection.getSnapshot().result?.state).toBe('unknown');
  });

  it("rejects non-finite volume targets before sending anything", async () => {
    const { connection, calls } = await driveToActive();
    for (const value of [NaN, Infinity, -1, 101]) connection.commitVolume(sampleDeck.pages[1].controls[0], value);
    await flush();
    expect(calls.filter(call => call.path === '/api/v1/commands')).toHaveLength(0);
  });

  it("stops reconnect loops on a terminal auth error", async () => {
    let statusCalls = 0;
    const { deps, clock, calls } = createHarness((path) => {
      if (path === "/api/v1/pair/status") {
        statusCalls += 1;
        if (statusCalls === 1) return jsonResponse(401, { error: "no cookie" });
        return jsonResponse(200, { requestId: "r1", status: "approved" });
      }
      if (path === "/api/v1/pair") return jsonResponse(200, { requestId: "r1", status: "pending" });
      if (path === "/api/v1/state") return jsonResponse(401, { error: "revoked" });
      return jsonResponse(404, { error: "nope" });
    });
    const connection = new RemotePhoneConnection(deps);
    connection.start();
    await flush();
    await connection.submitPairing(TOKEN, "My phone");
    await flush();
    await clock.advance(2000);
    expect(connection.getSnapshot().phase).toBe("revoked");
    const stateCalls = calls.filter((call) => call.path === "/api/v1/state").length;
    await clock.advance(60000);
    expect(calls.filter((call) => call.path === "/api/v1/state").length).toBe(stateCalls);
  });

  it("keeps a bounded newest-first activity log of completed outcomes", async () => {
    let sequence = 0;
    const { connection } = await driveToActive((_path, init) => jsonResponse(200, {
      id: JSON.parse(String(init.body)).id, state: "confirmed", message: `Outcome ${++sequence}`,
    }));
    const control = sampleDeck.pages[0].controls[0];
    for (let index = 0; index < 15; index += 1) {
      connection.pressControl(control);
      await flush();
    }
    const activity = connection.getSnapshot().activity;
    expect(activity).toHaveLength(10);
    expect(activity[0]).toMatchObject({ label: control.label, state: "confirmed", message: "Outcome 15" });
    expect(activity[9].message).toBe("Outcome 6");
    expect(new Set(activity.map((entry) => entry.id)).size).toBe(10);
    expect(connection.getSnapshot().warning).toBeNull();
  });

  it("quietly completes sent media keys, accepting only unknown state and never replaying", async () => {
    expect(parseCommandResult({ state: "confirmed", code: "media_key_sent" })).toBeNull();
    expect(parseCommandResult({ state: "unknown", code: "media_key_sent" })).toMatchObject({ state: "unknown", code: "media_key_sent" });
    let count = 0;
    const { connection } = await driveToActive((_path, init) => {
      count += 1;
      return jsonResponse(200, { id: JSON.parse(String(init.body)).id, state: "unknown", code: "media_key_sent" });
    });
    const control = sampleDeck.pages.flatMap(page => page.controls).find(control => control.action === "media-play-pause")!;
    connection.pressControl(control);
    await flush();
    expect(count).toBe(1);
    expect(connection.getSnapshot()).toMatchObject({ busyControlId: null, result: null, resultKind: "none", warning: null, activity: [] });
    connection.pressControl(control);
    await flush();
    expect(count).toBe(2);
  });

  it("still warns for plugin unknown outcomes", async () => {
    const { connection } = await driveToActive((_path, init) => jsonResponse(200, {
      id: JSON.parse(String(init.body)).id, state: "unknown", code: "plugin_outcome_unknown", message: "Inspect plugin state before retrying.",
    }));
    connection.pressControl(sampleDeck.pages[0].controls[0]);
    await flush();
    expect(connection.getSnapshot().resultKind).toBe("unknown");
    expect(connection.getSnapshot().warning).toBeTruthy();
    expect(connection.getSnapshot().activity[0].state).toBe("unknown");
  });

  it("retains a visible unknown warning and clears the log on a new session", async () => {
    let fail = true;
    const { connection } = await driveToActive((_path, init) => {
      if (fail) throw new Error("network lost");
      return jsonResponse(200, { id: JSON.parse(String(init.body)).id, state: "confirmed" });
    });
    const control = sampleDeck.pages[0].controls[0];
    connection.pressControl(control);
    await flush();
    expect(connection.getSnapshot().warning).toContain("Check the desktop before trying again");
    expect(connection.getSnapshot().activity[0]).toMatchObject({ label: control.label, state: "unknown" });
    fail = false;
    connection.pressControl(control);
    await flush();
    expect(connection.getSnapshot().activity.map((entry) => entry.state)).toEqual(["confirmed", "unknown"]);
    expect(connection.getSnapshot().warning).toContain(control.label);

    connection.start();
    expect(connection.getSnapshot().activity).toEqual([]);
    expect(connection.getSnapshot().warning).toBeNull();
  });

  it("does not revive a stopped instance from a stale response", async () => {
    const { deps, sockets } = makeStandardHarness();
    const connection = new RemotePhoneConnection(deps);
    connection.start();
    connection.stop();
    await flush();
    expect(sockets.length).toBe(0);
    expect(connection.getSnapshot().phase).toBe("checking");
  });
});
