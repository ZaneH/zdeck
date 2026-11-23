import { describe, expect, it } from "vitest";
import { createDefaultDeck } from "../src/lib/deck";
import {
  loadDeck,
  saveDeck,
  STORAGE_KEY,
  setupDismissed,
  dismissSetup,
} from "../src/lib/persistence";
import type { StorageLike } from "../src/lib/types";

class MemoryStorage implements StorageLike {
  private readonly data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

const throwingStorage: StorageLike = {
  getItem() {
    throw new Error("storage unavailable");
  },
  setItem() {
    throw new Error("storage unavailable");
  },
};

describe("setup dismissal", () => {
  it("remembers dismissal separately without creating or changing a deck", () => {
    const storage = new MemoryStorage();
    expect(setupDismissed(storage)).toBe(false);
    dismissSetup(storage);
    expect(setupDismissed(storage)).toBe(true);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
    const deck = createDefaultDeck();
    saveDeck(storage, deck);
    dismissSetup(storage);
    expect(loadDeck(storage).deck).toEqual(deck);
  });

  it("remains safe with absent or blocked storage", () => {
    expect(setupDismissed(null)).toBe(false);
    expect(setupDismissed(throwingStorage)).toBe(false);
    expect(() => dismissSetup(null)).not.toThrow();
    expect(() => dismissSetup(throwingStorage)).not.toThrow();
  });
});

describe("deck persistence", () => {
  it("loads the sample deck when storage is empty", () => {
    const result = loadDeck(new MemoryStorage());
    expect(result.status).toBe("empty");
    expect(result.deck.pages.length).toBeGreaterThan(0);
  });

  it("round-trips a valid deck", () => {
    const storage = new MemoryStorage();
    const deck = createDefaultDeck();
    expect(saveDeck(storage, deck)).toBe(true);

    const result = loadDeck(storage);
    expect(result.status).toBe("loaded");
    expect(result.deck).toEqual(deck);
  });

  it("rejects malformed JSON and old versions", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, "");
    expect(loadDeck(storage).status).toBe("invalid");

    storage.setItem(STORAGE_KEY, "{not json");
    expect(loadDeck(storage).status).toBe("invalid");

    const oldVersion = JSON.parse(JSON.stringify(createDefaultDeck())) as {
      version: number;
    };
    oldVersion.version = 0;
    storage.setItem(STORAGE_KEY, JSON.stringify(oldVersion));
    expect(loadDeck(storage).status).toBe("invalid");
  });

  it("rejects invalid stored ranges and missing active pages", () => {
    const storage = new MemoryStorage();
    const badVolume = JSON.parse(JSON.stringify(createDefaultDeck())) as {
      pages: { controls: { volume: number }[] }[];
    };
    badVolume.pages[1].controls[0].volume = 120;
    storage.setItem(STORAGE_KEY, JSON.stringify(badVolume));
    expect(loadDeck(storage).status).toBe("invalid");

    const badActive = JSON.parse(JSON.stringify(createDefaultDeck())) as {
      activePageId: string;
    };
    badActive.activePageId = "missing";
    storage.setItem(STORAGE_KEY, JSON.stringify(badActive));
    expect(loadDeck(storage).status).toBe("invalid");
  });

  it("reports unavailable storage without throwing", () => {
    expect(loadDeck(null).status).toBe("unavailable");
    expect(loadDeck(throwingStorage).status).toBe("unavailable");
    expect(saveDeck(null, createDefaultDeck())).toBe(false);
    expect(saveDeck(throwingStorage, createDefaultDeck())).toBe(false);
  });

  it("does not write an invalid deck", () => {
    const storage = new MemoryStorage();
    const invalid = createDefaultDeck();
    invalid.pages[0].controls[0].label = "   ";
    expect(saveDeck(storage, invalid)).toBe(false);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });
});
