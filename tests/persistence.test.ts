import { describe, expect, it } from "vitest";
import { addControl, createDefaultDeck, findControl, updateControl } from "../src/lib/deck";
import {
  loadDeck,
  loadSidebar,
  saveSidebar,
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

describe("sidebar preference", () => {
  it("defaults expanded and round-trips both explicit choices independently of the deck", () => {
    const storage = new MemoryStorage();
    expect(loadSidebar(storage)).toEqual({ collapsed: false, error: null });
    for (const collapsed of [true, false]) {
      expect(saveSidebar(storage, collapsed)).toBe(true);
      expect(loadSidebar(storage)).toEqual({ collapsed, error: null });
    }
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("launches expanded with a visible error for absent, blocked or invalid storage", () => {
    for (const storage of [null, throwingStorage, { getItem: () => "invalid", setItem() {} }]) {
      expect(loadSidebar(storage)).toEqual({ collapsed: false, error: expect.any(String) });
    }
    expect(saveSidebar(null, true)).toBe(false);
    expect(saveSidebar(throwingStorage, false)).toBe(false);
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

  it("remembers automatic and explicit OBS labels across reloads", () => {
    const storage = new MemoryStorage();
    const { deck, control } = addControl(createDefaultDeck(), "page_stream", "obs-scene", { scene: "Camera" })!;
    expect(saveDeck(storage, deck)).toBe(true);
    let restored = loadDeck(storage);
    expect(restored.status).toBe("loaded");
    let edited = updateControl(restored.deck, "page_stream", control.id, { scene: "Gameplay" });
    expect(findControl(edited, "page_stream", control.id)?.label).toBe("Gameplay");
    edited = updateControl(edited, "page_stream", control.id, { label: "Gameplay" });
    expect(saveDeck(storage, edited)).toBe(true);
    restored = loadDeck(storage);
    edited = updateControl(restored.deck, "page_stream", control.id, { scene: "Break" });
    expect(findControl(edited, "page_stream", control.id)?.label).toBe("Gameplay");
    edited = updateControl(edited, "page_stream", control.id, { label: "" });
    expect(saveDeck(storage, edited)).toBe(true);
    expect(findControl(loadDeck(storage).deck, "page_stream", control.id)).toMatchObject({ label: "Break", autoLabel: true });
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
