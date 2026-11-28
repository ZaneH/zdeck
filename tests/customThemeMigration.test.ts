import { describe, expect, it } from "vitest";
import {
  createDefaultDeck,
  duplicateControl,
  isDeck,
  normalizeDeck,
  setCustomTheme,
  setTheme,
} from "../src/lib/deck";
import {
  addSection,
  duplicateSection,
  findSection,
  removeSection,
  sectionAppearance,
  setSectionCustomTheme,
  setSectionTheme,
} from "../src/lib/sections";
import { createDeckHistory, recordDeckChange, undoDeck } from "../src/lib/deckHistory";
import { loadDeck, saveDeck } from "../src/lib/persistence";
import { deriveTrash, restoreTrashEntry } from "../src/lib/trash";
import { validateCustomThemeReference } from "../src/lib/themePackage";

const PAGE = "page_stream";
const FIRST = "page_stream_section";
const REFERENCE = { id: "midnight-maze", version: "0.1.0", digest: "a".repeat(64) };

function storage(initial: string | null = null) {
  let stored = initial;
  return {
    getItem: () => stored,
    setItem: (_: string, value: string) => { stored = value; },
    written: () => stored,
  };
}

describe("deck v4 custom theme references", () => {
  it("round-trips deck and section references through JSON and local storage", () => {
    const deck = setSectionCustomTheme(
      setCustomTheme(createDefaultDeck(), REFERENCE, "glass"),
      FIRST,
      REFERENCE,
      "terminal",
    );
    expect(deck.theme).toBe("glass");
    expect(deck.customTheme).toEqual(REFERENCE);
    const section = findSection(deck, PAGE, FIRST)!;
    expect(section.theme).toBe("terminal");
    expect(section.customTheme).toEqual(REFERENCE);
    expect(isDeck(JSON.parse(JSON.stringify(deck)))).toBe(true);
    expect(normalizeDeck(JSON.parse(JSON.stringify(deck)))).toEqual(deck);
    expect(sectionAppearance(deck, section)).toEqual({
      theme: "terminal", accent: "#4cc9f0", customTheme: REFERENCE,
    });

    const store = storage();
    expect(saveDeck(store, deck)).toBe(true);
    expect(loadDeck(store).deck).toEqual(deck);
  });

  it("rejects null, extra and malformed references", () => {
    const deck = createDefaultDeck();
    const badDeck = structuredClone(deck) as unknown as Record<string, unknown>;
    for (const bad of [
      null,
      { id: "midnight-maze", version: "0.1.0" },
      { ...REFERENCE, extra: true },
      { ...REFERENCE, id: "Midnight" },
      { ...REFERENCE, version: "1.0" },
      { ...REFERENCE, digest: "A".repeat(64) },
      { ...REFERENCE, digest: "a".repeat(63) },
    ]) {
      badDeck.customTheme = bad;
      expect(isDeck(badDeck)).toBe(false);
    }
    expect(validateCustomThemeReference(REFERENCE)).toEqual(REFERENCE);
    expect(validateCustomThemeReference(null)).toBeNull();
  });

  it("requires an explicit section theme and keeps unknown built-in themes out", () => {
    const withSection = addSection(createDefaultDeck(), PAGE, FIRST, "Audio")!;
    const sectionId = withSection.section.id;
    const withoutBase = structuredClone(withSection.deck) as any;
    withoutBase.pages[0].sections[1].customTheme = REFERENCE;
    expect(isDeck(withoutBase)).toBe(false);

    const withBase = structuredClone(withoutBase);
    withBase.pages[0].sections[1].theme = "glass";
    expect(isDeck(withBase)).toBe(true);

    expect(setCustomTheme(withSection.deck, REFERENCE, "midnight" as never)).toBe(withSection.deck);
    expect(setSectionCustomTheme(withSection.deck, sectionId, REFERENCE, "midnight" as never))
      .toBe(withSection.deck);
    expect(setSectionCustomTheme(withSection.deck, sectionId, { ...REFERENCE, digest: "x" }, "glass"))
      .toBe(withSection.deck);
    expect(setSectionCustomTheme(withSection.deck, "missing", REFERENCE, "glass"))
      .toBe(withSection.deck);
  });

  it("clears a reference on explicit built-in or inherit choices", () => {
    const deck = setCustomTheme(createDefaultDeck(), REFERENCE, "dark");
    const cleared = setTheme(deck, "dark");
    expect(cleared).not.toHaveProperty("customTheme");
    expect(setTheme(cleared, "dark")).toBe(cleared);

    const withSection = addSection(deck, PAGE, FIRST, "Audio")!;
    const sectionId = withSection.section.id;
    const custom = setSectionCustomTheme(withSection.deck, sectionId, REFERENCE, "glass");
    expect(sectionAppearance(custom, findSection(custom, PAGE, sectionId)!).customTheme).toEqual(REFERENCE);

    const builtin = setSectionTheme(custom, PAGE, sectionId, "light");
    expect(findSection(builtin, PAGE, sectionId)).not.toHaveProperty("customTheme");
    expect(findSection(builtin, PAGE, sectionId)?.theme).toBe("light");
    expect(sectionAppearance(builtin, findSection(builtin, PAGE, sectionId)!)).not.toHaveProperty("customTheme");
    const sameBase = setSectionTheme(custom, PAGE, sectionId, "dark");
    expect(sectionAppearance(sameBase, findSection(sameBase, PAGE, sectionId)!)).not.toHaveProperty("customTheme");

    const inherited = setSectionTheme(custom, PAGE, sectionId, null);
    const inheritedSection = findSection(inherited, PAGE, sectionId)!;
    expect(inheritedSection).not.toHaveProperty("theme");
    expect(inheritedSection).not.toHaveProperty("customTheme");
    // The deck-level reference still applies to the now-inheriting section.
    expect(sectionAppearance(inherited, inheritedSection).customTheme).toEqual(REFERENCE);
  });

  it("promotes a legacy v3 deck without rewriting it and rejects smuggled references", () => {
    const v3 = { ...structuredClone(createDefaultDeck()), version: 3 };
    const source = JSON.stringify(v3);
    const migrated = normalizeDeck(v3);
    expect(migrated?.version).toBe(4);
    expect(isDeck(migrated)).toBe(true);
    expect(JSON.stringify(v3)).toBe(source);

    const store = storage(JSON.stringify({ envelopeVersion: 1, deck: v3, trash: [] }));
    const loaded = loadDeck(store);
    expect(loaded.status).toBe("loaded");
    expect(loaded.deck.version).toBe(4);
    expect(store.written()).toBe(JSON.stringify({ envelopeVersion: 1, deck: v3, trash: [] }));

    expect(normalizeDeck({ ...v3, customTheme: REFERENCE })).toBeNull();
    const sectionLevel = structuredClone(v3) as any;
    sectionLevel.pages[0].sections[0].theme = "glass";
    sectionLevel.pages[0].sections[0].customTheme = REFERENCE;
    expect(normalizeDeck(sectionLevel)).toBeNull();

    for (const version of [1, 2]) {
      expect(normalizeDeck({ ...v3, version, customTheme: REFERENCE })).toBeNull();
    }
  });

  it("keeps references through copy, undo and trash restore", () => {
    const added = addSection(createDefaultDeck(), PAGE, FIRST, "Audio")!;
    const sectionId = added.section.id;
    const deck = setSectionCustomTheme(
      setCustomTheme(added.deck, REFERENCE, "glass"),
      sectionId,
      REFERENCE,
      "terminal",
    );

    const copied = duplicateSection(deck, PAGE, sectionId)!;
    expect(copied.section.customTheme).toEqual(REFERENCE);
    expect(copied.section.theme).toBe("terminal");

    const withControl = duplicateControl(deck, PAGE, "ctl_mic")!;
    expect(withControl.deck.customTheme).toEqual(REFERENCE);
    expect(findSection(withControl.deck, PAGE, sectionId)?.customTheme).toEqual(REFERENCE);

    const history = recordDeckChange(createDeckHistory(), added.deck, deck);
    const undone = undoDeck(history, deck)!;
    expect(undone.deck.customTheme).toBeUndefined();
    expect(findSection(undone.deck, PAGE, sectionId)).not.toHaveProperty("customTheme");

    const removed = removeSection(deck, PAGE, sectionId);
    const trash = deriveTrash(deck, removed, [], 1234);
    expect(trash).toHaveLength(1);
    expect(trash[0].kind === "section" && trash[0].section.customTheme).toEqual(REFERENCE);
    const restored = restoreTrashEntry(removed, trash[0]);
    expect("deck" in restored).toBe(true);
    if (!("deck" in restored)) return;
    expect(isDeck(restored.deck)).toBe(true);
    expect(findSection(restored.deck, PAGE, sectionId)?.customTheme).toEqual(REFERENCE);
  });
});

