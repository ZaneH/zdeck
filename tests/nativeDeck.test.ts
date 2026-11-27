import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createDefaultDeck, isDeck, normalizeDeck, removeControl } from "../src/lib/deck";
import { DeckSync } from "../src/lib/deckSync";
import type { DeckBackend, DeckSyncStatus } from "../src/lib/deckSync";
import { nativeAvailable } from "../src/lib/native";
import {
  nativeDeckLoad,
  nativeDeckSave,
  parseDeckSnapshot,
  toDeckError,
} from "../src/lib/nativeDeck";
import type { DeckSnapshot } from "../src/lib/nativeDeck";
import { deriveTrash } from "../src/lib/trash";
import type { TrashEntry } from "../src/lib/trash";
import type { Deck } from "../src/lib/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const existingBackend = (save: DeckBackend["save"]): DeckBackend => ({
  load: async () => ({ revision: 0, deck: createDefaultDeck(), trash: [], exists: true }),
  save,
});

describe("native deck errors", () => {
  it("normalizes well-formed and unknown native errors", () => {
    expect(
      toDeckError({ kind: "conflict", message: "stale", currentRevision: 9 }),
    ).toEqual({ kind: "conflict", message: "stale", currentRevision: 9 });
    expect(toDeckError(new Error("boom"))).toEqual({
      kind: "io",
      message: expect.any(String),
    });
    expect(toDeckError({ kind: "not_a_kind", message: "x" }).kind).toBe("io");
  });

  it("refuses native deck access outside the desktop shell", async () => {
    expect(nativeAvailable()).toBe(false);
    await expect(nativeDeckLoad()).rejects.toMatchObject({
      kind: "unavailable",
    });
    await expect(nativeDeckSave(0, createDefaultDeck(), [])).rejects.toMatchObject({
      kind: "unavailable",
    });
  });
});

describe("native v3 snapshot boundary", () => {
  it("accepts only validated v3 decks from Rust, which owns native v1/v2 migration", () => {
    const snapshot = { revision: 3, exists: true, deck: createDefaultDeck(), trash: [] };
    expect(parseDeckSnapshot(snapshot)).toEqual(snapshot);
    const glass = { ...snapshot, deck: { ...createDefaultDeck(), theme: "glass" as const } };
    expect(parseDeckSnapshot(glass)).toEqual(glass);
    expect(() => parseDeckSnapshot({ ...snapshot, deck: { ...snapshot.deck, theme: "midnight" } })).toThrow();
    for (const bad of [null, { ...snapshot, revision: -1 }, { ...snapshot, exists: "true" },
      { ...snapshot, deck: { ...snapshot.deck, version: 1 } }, { ...snapshot, deck: { ...snapshot.deck, extra: true } }]) {
      expect(() => parseDeckSnapshot(bad)).toThrow();
    }
  });
});

describe("native deck save queue", () => {
  it("serializes saves and writes only the latest pending deck", async () => {
    const calls: { expectedRevision: number; deck: Deck; trash: unknown[] }[] = [];
    const gates: ReturnType<typeof deferred<DeckSnapshot>>[] = [];
    const backend = existingBackend((expectedRevision, deck, trash) => {
      calls.push({ expectedRevision, deck, trash });
      const gate = deferred<DeckSnapshot>();
      gates.push(gate);
      return gate.promise;
    });

    const statuses: DeckSyncStatus[] = [];
    const sync = new DeckSync(backend, (status) => statuses.push(status), 0);

    const first = createDefaultDeck();
    const second: Deck = { ...first, theme: "light" };
    const third: Deck = { ...first, accent: "#6ee7b7" };

    sync.update(first);
    sync.update(second);
    sync.update(third);
    expect(calls).toHaveLength(1);
    expect(statuses.at(-1)).toEqual({ phase: "saving" });

    gates[0].resolve({ revision: 1, deck: first, trash: [], exists: true });
    await tick();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ expectedRevision: 1, deck: third, trash: [] });

    gates[1].resolve({ revision: 2, deck: third, trash: [], exists: true });
    await tick();
    expect(calls).toHaveLength(2);
    expect(statuses.at(-1)).toEqual({ phase: "saved", revision: 2 });
    expect(sync.currentRevision).toBe(2);
  });

  it("initializes a missing native deck through a revision-0 save", async () => {
    const save = vi.fn(async (expectedRevision: number, deck: Deck, trash: TrashEntry[]) => ({
      revision: expectedRevision + 1,
      deck,
      trash,
      exists: true,
    }));
    const backend: DeckBackend = {
      load: async () => ({ revision: 0, deck: createDefaultDeck(), trash: [], exists: false }),
      save,
    };
    const statuses: DeckSyncStatus[] = [];
    const sync = new DeckSync(backend, (s) => statuses.push(s), 0);

    sync.update(createDefaultDeck());
    await tick();
    expect(save).toHaveBeenCalledWith(0, createDefaultDeck(), []);
    expect(sync.currentRevision).toBe(1);
    expect(statuses.at(-1)).toEqual({ phase: "saved", revision: 1 });
  });

  it("reports a conflict explicitly and stops saving until reload", async () => {
    const save = vi.fn(async () => {
      throw { kind: "conflict", message: "stale", currentRevision: 4 };
    });
    const statuses: DeckSyncStatus[] = [];
    const sync = new DeckSync(existingBackend(save), (s) => statuses.push(s), 3);

    sync.update(createDefaultDeck());
    await tick();
    expect(statuses.at(-1)).toMatchObject({ phase: "conflict" });
    expect(sync.conflictBlocked).toBe(true);

    sync.update({ ...createDefaultDeck(), theme: "light" });
    await tick();
    expect(save).toHaveBeenCalledTimes(1);
    expect(sync.currentRevision).toBe(3);
  });

  it("keeps the revision after a failed save and retries on the next edit", async () => {
    let attempts = 0;
    const save = vi.fn(async (expectedRevision: number, deck: Deck, trash: TrashEntry[]) => {
      attempts += 1;
      if (attempts === 1) throw { kind: "io", message: "disk full" };
      return { revision: expectedRevision + 1, deck, trash, exists: true };
    });
    const statuses: DeckSyncStatus[] = [];
    const sync = new DeckSync(existingBackend(save), (s) => statuses.push(s), 5);

    const trash = deriveTrash(createDefaultDeck(), removeControl(createDefaultDeck(), "page_stream", "ctl_mic"), [], 1234);
    sync.update(createDefaultDeck(), trash);
    await tick();
    expect(statuses.at(-1)).toMatchObject({ phase: "error" });
    expect(sync.currentRevision).toBe(5);

    const next: Deck = { ...createDefaultDeck(), theme: "light" };
    sync.update(next, trash);
    await tick();
    expect(save).toHaveBeenLastCalledWith(5, next, trash);
    expect(sync.currentRevision).toBe(6);
  });
});

describe("shared deck fixture", () => {
  it("is schema-valid in TypeScript and covers all four control kinds", () => {
    const raw = readFileSync(
      new URL("./fixtures/deck.sample.json", import.meta.url),
      "utf8",
    );
    const legacy = JSON.parse(raw) as unknown;
    expect(isDeck(legacy)).toBe(false);
    const deck = normalizeDeck(legacy);
    expect(isDeck(deck)).toBe(true);
    // Keep the shared Rust v1 fixture intact; both readers normalize it to v3.
    expect(createDefaultDeck()).toEqual(deck);

    const kinds = new Set(
      (deck as Deck).pages.flatMap((page) =>
        page.sections.flatMap((section) => section.controls.map((control) => control.action)),
      ),
    );
    expect(kinds).toEqual(
      new Set(["obs-scene", "mic-mute", "media-play-pause", "volume"]),
    );

    // Round-trips through JSON unchanged, so it can be re-parsed by any reader.
    expect(isDeck(JSON.parse(JSON.stringify(deck)))).toBe(true);
  });
});

describe("native trash boundary", () => {
  const trash = (() => {
    const deck = createDefaultDeck();
    return deriveTrash(deck, removeControl(deck, "page_stream", "ctl_mic"), [], 1234);
  })();

  it("accepts validated trash and rejects malformed or missing trash", () => {
    const snapshot = { revision: 3, exists: true, deck: createDefaultDeck(), trash };
    expect(parseDeckSnapshot(snapshot)).toEqual(snapshot);
    expect(parseDeckSnapshot({ ...snapshot, trash: [] })).toEqual({ ...snapshot, trash: [] });
    for (const bad of [
      { ...snapshot, trash: undefined },
      { ...snapshot, trash: [{ kind: "control" }] },
      { ...snapshot, trash: [...trash, ...trash] },
    ]) {
      expect(() => parseDeckSnapshot(bad)).toThrow();
    }
  });

  it("saves deck and trash through one CAS write", async () => {
    const save = vi.fn(async (expectedRevision: number, deck: Deck, savedTrash: TrashEntry[]) => ({
      revision: expectedRevision + 1, deck, trash: savedTrash, exists: true,
    }));
    const backend: DeckBackend = {
      load: async () => ({ revision: 0, deck: createDefaultDeck(), trash: [], exists: true }),
      save,
    };
    const sync = new DeckSync(backend, () => {}, 0);
    const deck = removeControl(createDefaultDeck(), "page_stream", "ctl_mic");
    sync.update(deck, trash);
    await tick();
    expect(save).toHaveBeenCalledWith(0, deck, trash);
  });
});
