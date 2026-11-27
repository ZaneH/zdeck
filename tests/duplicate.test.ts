import { describe, expect, it } from "vitest";
import {
  MAX_CONTROLS_PER_PAGE,
  addControl,
  createDefaultDeck,
  duplicateControl,
  findControl,
  isDeck,
  pageControls,
  updateControl,
} from "../src/lib/deck";
import {
  MAX_SECTION_NAME_BYTES,
  addSection,
  duplicateSection,
  setSectionAccent,
  setSectionTheme,
} from "../src/lib/sections";
import {
  createDeckHistory,
  recordDeckChange,
  redoDeck,
  undoDeck,
} from "../src/lib/deckHistory";
import { deriveTrash, isTrash } from "../src/lib/trash";
import type { Deck, PluginControl } from "../src/lib/types";

const PAGE = "page_stream";
const SECTION = "page_stream_section";

function addMany(deck: Deck, count: number): Deck {
  let current = deck;
  for (let index = 0; index < count; index += 1) {
    current = addControl(current, PAGE, "mic-mute", { label: `Mute ${index}` })!.deck;
  }
  return current;
}

function allControlIds(deck: Deck): string[] {
  return deck.pages.flatMap((page) => page.sections.flatMap((section) => section.controls.map((control) => control.id)));
}

function configuredPlugin(deck: Deck): { deck: Deck; control: PluginControl } {
  const added = addControl(deck, PAGE, "plugin", {
    label: "Monitor level", pluginId: "mixer", pluginAction: "level",
    pluginArgs: { amount: 50, enabled: true }, presentation: "slider",
  })!;
  const next = updateControl(added.deck, PAGE, added.control.id, {
    icon: { type: "builtin", name: "star" }, rowSpan: 2, columnSpan: 3,
  });
  return { deck: next, control: findControl(next, PAGE, added.control.id)! as PluginControl };
}

describe("control duplication", () => {
  it("inserts a deep copy immediately after the original and keeps its configuration", () => {
    const configured = configuredPlugin(createDefaultDeck());
    const result = duplicateControl(configured.deck, PAGE, configured.control.id)!;
    const section = result.deck.pages[0].sections[0];
    const originalIndex = section.controls.findIndex((control) => control.id === configured.control.id);
    const copy = section.controls[originalIndex + 1] as PluginControl;

    expect(section.controls[originalIndex - 1]?.id).toBe("ctl_play_pause");
    expect(section.controls[originalIndex + 2]).toBeUndefined();
    expect(copy).toBe(result.control);
    expect(copy).toMatchObject({
      label: "Monitor level copy", action: "plugin", pluginId: "mixer", pluginAction: "level",
      pluginArgs: { amount: 50, enabled: true }, presentation: "slider",
      icon: { type: "builtin", name: "star" }, rowSpan: 2, columnSpan: 3,
    });
    expect(copy.id).not.toBe(configured.control.id);
    expect(copy.pluginArgs).not.toBe(configured.control.pluginArgs);
    copy.pluginArgs.amount = 80;
    expect(configured.control.pluginArgs.amount).toBe(50);
    expect(section.controls[originalIndex]).toBe(configured.control);
    expect(isDeck(result.deck)).toBe(true);
    expect(allControlIds(result.deck).filter((id) => id === copy.id)).toHaveLength(1);
    expect(new Set(allControlIds(result.deck)).size).toBe(allControlIds(result.deck).length);
  });

  it("numbers repeated copies and keeps long labels intact", () => {
    const configured = configuredPlugin(createDefaultDeck());
    const first = duplicateControl(configured.deck, PAGE, configured.control.id)!;
    const second = duplicateControl(first.deck, PAGE, configured.control.id)!;
    expect(first.control.label).toBe("Monitor level copy");
    expect(second.control.label).toBe("Monitor level copy 2");

    const longLabel = "A deliberately long control label ".repeat(20).trim();
    const long = addControl(createDefaultDeck(), PAGE, "mic-mute", { label: longLabel })!;
    const copy = duplicateControl(long.deck, PAGE, long.control.id)!;
    expect(copy.control.label).toBe(`${longLabel} copy`);
    expect(isDeck(copy.deck)).toBe(true);
  });

  it("refuses a missing source or a full page without changing the deck", () => {
    const deck = createDefaultDeck();
    expect(duplicateControl(deck, "missing", "ctl_mic")).toBeNull();
    expect(duplicateControl(deck, PAGE, "missing")).toBeNull();

    const full = addMany(deck, MAX_CONTROLS_PER_PAGE - pageControls(deck.pages[0]).length);
    expect(pageControls(full.pages[0])).toHaveLength(MAX_CONTROLS_PER_PAGE);
    expect(duplicateControl(full, PAGE, "ctl_mic")).toBeNull();
    expect(isDeck(full)).toBe(true);
  });

  it("is one undo step and keeps trash derived from the copy, never the original", () => {
    const deck = createDefaultDeck();
    const result = duplicateControl(deck, PAGE, "ctl_mic")!;
    const history = recordDeckChange(createDeckHistory(), deck, result.deck);
    expect(history.past).toHaveLength(1);

    const undo = undoDeck(history, result.deck)!;
    expect(findControl(undo.deck, PAGE, result.control.id)).toBeUndefined();
    expect(findControl(undo.deck, PAGE, "ctl_mic")).toBeDefined();
    const trash = deriveTrash(result.deck, undo.deck, [], 1000);
    expect(isTrash(trash)).toBe(true);
    expect(trash).toEqual([expect.objectContaining({ kind: "control", id: result.control.id })]);
    expect(trash.some((entry) => entry.id === "ctl_mic")).toBe(false);

    const redo = redoDeck(undo.history, undo.deck)!;
    expect(redo.deck).toEqual(result.deck);
    expect(findControl(redo.deck, PAGE, result.control.id)).toBeDefined();
    expect(pageControls(redo.deck.pages[0]).filter((control) => control.id === result.control.id)).toHaveLength(1);
    expect(deriveTrash(undo.deck, redo.deck, trash, 2000)).toEqual([]);
  });
});

describe("section duplication", () => {
  function configuredSection(): ReturnType<typeof sectionFixture> {
    return sectionFixture();
  }

  function sectionFixture() {
    const added = addSection(createDefaultDeck(), PAGE, SECTION, "Audio")!;
    let deck = setSectionAccent(setSectionTheme(added.deck, PAGE, added.section.id, "light"), PAGE, added.section.id, "#6ee7b7");
    const plugin = addControl(deck, PAGE, "plugin", {
      label: "Monitor level", pluginId: "mixer", pluginAction: "level",
      pluginArgs: { amount: 50 }, presentation: "dial",
    }, added.section.id)!;
    deck = updateControl(plugin.deck, PAGE, plugin.control.id, {
      icon: { type: "builtin", name: "monitor" }, rowSpan: 2, columnSpan: 2,
    });
    return { deck, sectionId: added.section.id, controlId: plugin.control.id };
  }

  it("inserts a copy after the original with fresh IDs, order and appearance", () => {
    const fixture = configuredSection();
    const beforeIds = new Set(allControlIds(fixture.deck));
    const beforeSectionIds = new Set(fixture.deck.pages.flatMap((page) => page.sections.map((section) => section.id)));
    const original = fixture.deck.pages[0].sections[1];
    const result = duplicateSection(fixture.deck, PAGE, fixture.sectionId)!;
    const sections = result.deck.pages[0].sections;

    expect(sections.map((section) => section.id)).toEqual([SECTION, fixture.sectionId, result.section.id]);
    expect(result.section.name).toBe("Audio copy");
    expect(result.section.theme).toBe("light");
    expect(result.section.accent).toBe("#6ee7b7");
    expect(result.section.controls).toHaveLength(1);
    expect(result.section.controls[0]).not.toBe(original.controls[0]);
    const copy = result.section.controls[0] as PluginControl;
    expect(copy).toMatchObject({
      action: "plugin", pluginId: "mixer", pluginAction: "level", label: "Monitor level",
      pluginArgs: { amount: 50 }, presentation: "dial",
      icon: { type: "builtin", name: "monitor" }, rowSpan: 2, columnSpan: 2,
    });
    expect(copy.pluginArgs).not.toBe((original.controls[0] as PluginControl).pluginArgs);
    copy.pluginArgs.amount = 80;
    expect((original.controls[0] as PluginControl).pluginArgs.amount).toBe(50);
    expect(beforeIds.has(copy.id)).toBe(false);
    expect(beforeSectionIds.has(result.section.id)).toBe(false);
    expect(new Set(allControlIds(result.deck)).size).toBe(allControlIds(result.deck).length);
    const sectionIds = result.deck.pages.flatMap((page) => page.sections.map((section) => section.id));
    expect(new Set(sectionIds).size).toBe(sectionIds.length);
    expect(isDeck(result.deck)).toBe(true);
  });

  it("keeps a 128-byte section name valid by trimming the copy suffix", () => {
    const longName = "é".repeat(MAX_SECTION_NAME_BYTES / 2);
    const added = addSection(createDefaultDeck(), PAGE, SECTION, longName)!;
    const result = duplicateSection(added.deck, PAGE, added.section.id)!;
    expect(result.section.name).not.toBe(longName);
    expect(result.section.name.endsWith(" copy")).toBe(true);
    expect(new TextEncoder().encode(result.section.name).length).toBeLessThanOrEqual(MAX_SECTION_NAME_BYTES);
    expect(isDeck(result.deck)).toBe(true);
  });

  it("refuses a missing section or a copy that would exceed the page control limit", () => {
    const deck = createDefaultDeck();
    expect(duplicateSection(deck, "missing", SECTION)).toBeNull();
    expect(duplicateSection(deck, PAGE, "missing")).toBeNull();

    const filled = addMany(deck, MAX_CONTROLS_PER_PAGE - pageControls(deck.pages[0]).length - 1);
    const added = addSection(filled, PAGE, SECTION, "Audio")!;
    const withControl = addControl(added.deck, PAGE, "mic-mute", undefined, added.section.id)!.deck;
    expect(pageControls(withControl.pages[0])).toHaveLength(MAX_CONTROLS_PER_PAGE);
    expect(duplicateSection(withControl, PAGE, added.section.id)).toBeNull();
    expect(isDeck(withControl)).toBe(true);
  });

  it("is one undo step and trash tracks the copied section only", () => {
    const fixture = configuredSection();
    const result = duplicateSection(fixture.deck, PAGE, fixture.sectionId)!;
    const history = recordDeckChange(createDeckHistory(), fixture.deck, result.deck);
    expect(history.past).toHaveLength(1);

    const undo = undoDeck(history, result.deck)!;
    expect(undo.deck.pages[0].sections.map((section) => section.id)).toEqual([SECTION, fixture.sectionId]);
    const trash = deriveTrash(result.deck, undo.deck, [], 1000);
    expect(trash).toEqual([expect.objectContaining({ kind: "section", id: result.section.id })]);
    expect(trash.some((entry) => entry.id === fixture.sectionId)).toBe(false);

    const redo = redoDeck(undo.history, undo.deck)!;
    expect(redo.deck).toEqual(result.deck);
    expect(redo.deck.pages[0].sections.filter((section) => section.id === result.section.id)).toHaveLength(1);
    expect(new Set(allControlIds(redo.deck)).size).toBe(allControlIds(redo.deck).length);
    expect(deriveTrash(undo.deck, redo.deck, trash, 2000)).toEqual([]);
  });
});
