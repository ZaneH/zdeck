import { describe, expect, it } from "vitest";
import { addControl, createDefaultDeck, findControl, removeControl, updateControl } from "../src/lib/deck";
import {
  LOCAL_DOCUMENT_VERSION,
  loadDeck,
  loadSidebar,
  saveSidebar,
  saveDeck,
  STORAGE_KEY,
  setupDismissed,
  dismissSetup,
} from "../src/lib/persistence";
import { addSection, moveSection, renameSection, setSectionAccent, setSectionTheme } from "../src/lib/sections";
import { ACCENTS } from "../src/lib/types";
import { deriveTrash } from "../src/lib/trash";
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

  it("remembers section order, controls and appearance overrides across reloads", () => {
    const storage = new MemoryStorage();
    const original = createDefaultDeck();
    const pageId = original.pages[0].id;
    const added = addSection(original, pageId)!;
    let deck = renameSection(added.deck, pageId, added.section.id, "Audio");
    deck = setSectionTheme(deck, pageId, added.section.id, "light");
    deck = setSectionAccent(deck, pageId, added.section.id, ACCENTS[1].value);
    const withControl = addControl(deck, pageId, "mic-mute", undefined, added.section.id)!;
    deck = moveSection(withControl.deck, pageId, added.section.id, -1);
    expect(saveDeck(storage, deck)).toBe(true);
    const restored = loadDeck(storage);
    expect(restored.status).toBe("loaded");
    expect(restored.deck).toEqual(deck);
    expect(restored.deck.pages[0].sections[0]).toMatchObject({
      id: added.section.id, name: "Audio", theme: "light", accent: ACCENTS[1].value,
      controls: [withControl.control],
    });
    expect(restored.deck.pages[0].sections[1].controls).toEqual(original.pages[0].sections[0].controls);

    deck = setSectionTheme(restored.deck, pageId, added.section.id, null);
    deck = setSectionAccent(deck, pageId, added.section.id, null);
    expect(saveDeck(storage, deck)).toBe(true);
    const inherited = loadDeck(storage).deck.pages[0].sections[0];
    expect(inherited).not.toHaveProperty("theme");
    expect(inherited).not.toHaveProperty("accent");
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

  it("rejects legacy versions that already carry canonical sections or unknown page fields", () => {
    const storage = new MemoryStorage();
    const deck = createDefaultDeck();
    for (const version of [1, 2]) {
      storage.setItem(STORAGE_KEY, JSON.stringify({ ...deck, version }));
      expect(loadDeck(storage).status).toBe("invalid");
      storage.setItem(STORAGE_KEY, JSON.stringify({
        ...deck,
        version,
        pages: [{ ...deck.pages[0], controls: deck.pages[0].sections[0].controls }],
      }));
      expect(loadDeck(storage).status).toBe("invalid");
    }
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
      pages: { sections: { controls: { volume: number }[] }[] }[];
    };
    badVolume.pages[1].sections[0].controls[0].volume = 120;
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
    invalid.pages[0].sections[0].controls[0].label = "   ";
    expect(saveDeck(storage, invalid)).toBe(false);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe("local deck envelope and trash", () => {
  const entry = (() => {
    const deck = createDefaultDeck();
    const next = removeControl(deck, "page_stream", "ctl_mic");
    return { deck: next, trash: deriveTrash(deck, next, [], 1234) };
  })();

  it("migrates an existing bare deck to an empty trash without rewriting it", () => {
    const storage = new MemoryStorage();
    const deck = createDefaultDeck();
    storage.setItem(STORAGE_KEY, JSON.stringify(deck));
    const loaded = loadDeck(storage);
    expect(loaded).toEqual({ deck, status: "loaded", trash: [] });
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!)).toEqual(deck);
  });

  it("round-trips deck and trash in one atomic envelope", () => {
    const storage = new MemoryStorage();
    expect(saveDeck(storage, entry.deck, entry.trash)).toBe(true);
    const raw = JSON.parse(storage.getItem(STORAGE_KEY)!);
    expect(raw).toMatchObject({ envelopeVersion: LOCAL_DOCUMENT_VERSION, trash: entry.trash });
    expect(raw.deck).toEqual(entry.deck);
    expect(loadDeck(storage)).toEqual({ deck: entry.deck, trash: entry.trash, status: "loaded" });
  });

  it("treats malformed trash or an unknown envelope as invalid and preserves the raw data", () => {
    for (const raw of [
      JSON.stringify({ envelopeVersion: 1, deck: createDefaultDeck(), trash: [{ kind: "control" }] }),
      JSON.stringify({ envelopeVersion: 2, deck: createDefaultDeck(), trash: [] }),
      JSON.stringify({ envelopeVersion: 1, deck: createDefaultDeck(), trash: entry.trash, extra: true }),
    ]) {
      const storage = new MemoryStorage();
      storage.setItem(STORAGE_KEY, raw);
      expect(loadDeck(storage).status).toBe("invalid");
      expect(storage.getItem(STORAGE_KEY)).toBe(raw);
    }
  });

  it("refuses to save invalid trash instead of silently dropping it", () => {
    const storage = new MemoryStorage();
    saveDeck(storage, createDefaultDeck());
    const before = storage.getItem(STORAGE_KEY);
    expect(saveDeck(storage, createDefaultDeck(), [{ ...entry.trash[0], id: "mismatch" }])).toBe(false);
    expect(storage.getItem(STORAGE_KEY)).toBe(before);
  });
});
