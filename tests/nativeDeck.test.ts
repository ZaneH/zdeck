import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createDefaultDeck, isDeck } from "../src/lib/deck";
import { DeckSync } from "../src/lib/deckSync";
import type { DeckBackend, DeckSyncStatus } from "../src/lib/deckSync";
import { nativeAvailable } from "../src/lib/native";
import {
  nativeDeckLoad,
  nativeDeckSave,
  toDeckError,
} from "../src/lib/nativeDeck";
import type { DeckSnapshot } from "../src/lib/nativeDeck";
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
  load: async () => ({ revision: 0, deck: createDefaultDeck(), exists: true }),
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
    await expect(nativeDeckSave(0, createDefaultDeck())).rejects.toMatchObject({
      kind: "unavailable",
    });
  });
});

describe("native deck save queue", () => {
  it("serializes saves and writes only the latest pending deck", async () => {
    const calls: { expectedRevision: number; deck: Deck }[] = [];
    const gates: ReturnType<typeof deferred<DeckSnapshot>>[] = [];
    const backend = existingBackend((expectedRevision, deck) => {
      calls.push({ expectedRevision, deck });
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

    gates[0].resolve({ revision: 1, deck: first, exists: true });
    await tick();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ expectedRevision: 1, deck: third });

    gates[1].resolve({ revision: 2, deck: third, exists: true });
    await tick();
    expect(calls).toHaveLength(2);
    expect(statuses.at(-1)).toEqual({ phase: "saved", revision: 2 });
    expect(sync.currentRevision).toBe(2);
  });

  it("initializes a missing native deck through a revision-0 save", async () => {
    const save = vi.fn(async (expectedRevision: number, deck: Deck) => ({
      revision: expectedRevision + 1,
      deck,
      exists: true,
    }));
    const backend: DeckBackend = {
      load: async () => ({ revision: 0, deck: createDefaultDeck(), exists: false }),
      save,
    };
    const statuses: DeckSyncStatus[] = [];
    const sync = new DeckSync(backend, (s) => statuses.push(s), 0);

    sync.update(createDefaultDeck());
    await tick();
    expect(save).toHaveBeenCalledWith(0, createDefaultDeck());
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
    const save = vi.fn(async (expectedRevision: number, deck: Deck) => {
      attempts += 1;
      if (attempts === 1) throw { kind: "io", message: "disk full" };
      return { revision: expectedRevision + 1, deck, exists: true };
    });
    const statuses: DeckSyncStatus[] = [];
    const sync = new DeckSync(existingBackend(save), (s) => statuses.push(s), 5);

    sync.update(createDefaultDeck());
    await tick();
    expect(statuses.at(-1)).toMatchObject({ phase: "error" });
    expect(sync.currentRevision).toBe(5);

    const next: Deck = { ...createDefaultDeck(), theme: "light" };
    sync.update(next);
    await tick();
    expect(save).toHaveBeenLastCalledWith(5, next);
    expect(sync.currentRevision).toBe(6);
  });
});

describe("shared deck fixture", () => {
  it("is schema-valid in TypeScript and covers all four control kinds", () => {
    const raw = readFileSync(
      new URL("./fixtures/deck.sample.json", import.meta.url),
      "utf8",
    );
    const deck = JSON.parse(raw) as unknown;
    expect(isDeck(deck)).toBe(true);
    // The browser sample deck and the Rust `default_deck` must stay identical.
    expect(createDefaultDeck()).toEqual(deck);

    const kinds = new Set(
      (deck as Deck).pages.flatMap((page) =>
        page.controls.map((control) => control.action),
      ),
    );
    expect(kinds).toEqual(
      new Set(["obs-scene", "mic-mute", "media-play-pause", "volume"]),
    );

    // Round-trips through JSON unchanged, so it can be re-parsed by any reader.
    expect(isDeck(JSON.parse(JSON.stringify(deck)))).toBe(true);
  });
});
