import { describe, expect, it } from "vitest";
import { createDefaultDeck, isDeck, pageControls } from "../src/lib/deck";
import {
  MAX_SECTION_NAME_BYTES,
  addSection,
  findSection,
  moveSection,
  pageArrowDelta,
  removeSection,
  renameSection,
  sectionAppearance,
  sectionNameError,
  sectionStyle,
  setSectionAccent,
  setSectionTheme,
} from "../src/lib/sections";
import type { Section } from "../src/lib/types";

const PAGE = "page_stream";
const FIRST = "page_stream_section";

function withSection(name = "Second"): { deck: ReturnType<typeof createDefaultDeck>; section: Section } {
  const deck = createDefaultDeck();
  const section: Section = { id: "page_stream_second", name, controls: [] };
  deck.pages[0].sections.push(section);
  return { deck, section };
}

function arrow(
  key: string,
  target: unknown = { closest: () => null },
  overrides: Partial<Record<"altKey" | "ctrlKey" | "metaKey" | "shiftKey" | "defaultPrevented", boolean>> = {},
) {
  return {
    key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, defaultPrevented: false,
    target: target as EventTarget,
    ...overrides,
  };
}

describe("section creation", () => {
  it("appends a section and inserts after the chosen one", () => {
    const base = withSection();
    const appended = addSection(base.deck, PAGE)!;
    expect(base.deck.pages[0].sections.map((section) => section.id)).toEqual([FIRST, "page_stream_second"]);
    expect(appended.deck.pages[0].sections.map((section) => section.name)).toEqual(["Stream", "Second", "Section 3"]);
    expect(appended.section.controls).toEqual([]);
    expect(isDeck(appended.deck)).toBe(true);

    const inserted = addSection(base.deck, PAGE, FIRST, "  Intro  ")!;
    expect(inserted.section.name).toBe("Intro");
    expect(inserted.deck.pages[0].sections.map((section) => section.name)).toEqual(["Stream", "Intro", "Second"]);
  });

  it("rejects a missing page or insertion target and an invalid name", () => {
    const { deck } = withSection();
    expect(addSection(deck, "missing")).toBeNull();
    expect(addSection(deck, PAGE, "missing")).toBeNull();
    expect(addSection(deck, PAGE, FIRST, "   ")?.section.name).toBe("Section 3");
    expect(addSection(deck, PAGE, FIRST, "é".repeat(MAX_SECTION_NAME_BYTES))).toBeNull();
  });

  it("leaves the original deck and its sibling pages untouched", () => {
    const { deck } = withSection();
    const before = structuredClone(deck);
    const result = addSection(deck, PAGE, null, "Third")!;
    expect(deck).toEqual(before);
    expect(result.deck.pages[1]).toBe(deck.pages[1]);
    expect(result.deck.pages[0].sections[0]).toBe(deck.pages[0].sections[0]);
  });
});

describe("section editing", () => {
  it("renames, trims and rejects blank or oversized names without changes", () => {
    const { deck } = withSection();
    const renamed = renameSection(deck, PAGE, "page_stream_second", "  Intermission  ");
    expect(renamed.pages[0].sections[1].name).toBe("Intermission");
    expect(deck.pages[0].sections[1].name).toBe("Second");
    expect(isDeck(renamed)).toBe(true);

    expect(renameSection(deck, PAGE, "page_stream_second", "  ")).toBe(deck);
    expect(renameSection(deck, PAGE, "missing", "Name")).toBe(deck);
    expect(renameSection(deck, PAGE, "page_stream_second", "é".repeat(65))).toBe(deck);
    expect(renameSection(deck, PAGE, "page_stream_second", "é".repeat(64)).pages[0].sections[1].name)
      .toBe("é".repeat(64));
  });

  it("accepts names at the byte boundary and explains the limit", () => {
    expect(sectionNameError("a".repeat(MAX_SECTION_NAME_BYTES))).toBeNull();
    expect(sectionNameError("a".repeat(MAX_SECTION_NAME_BYTES + 1))).toContain(String(MAX_SECTION_NAME_BYTES));
    expect(sectionNameError("   ")).toBeTruthy();
  });

  it("reorders sections with their controls and appearance", () => {
    const { deck, section } = withSection();
    section.theme = "light";
    section.accent = "#6ee7b7";
    section.controls = [{ id: "ctl_extra", label: "Extra", action: "mic-mute" }];
    const moved = moveSection(deck, PAGE, "page_stream_second", -1);

    expect(moved.pages[0].sections.map((item) => item.id)).toEqual(["page_stream_second", FIRST]);
    const movedSection = moved.pages[0].sections[0];
    expect(movedSection.theme).toBe("light");
    expect(movedSection.accent).toBe("#6ee7b7");
    expect(movedSection.controls.map((control) => control.id)).toEqual(["ctl_extra"]);
    expect(pageControls(moved.pages[0]).map((control) => control.id)).toContain("ctl_extra");
    expect(isDeck(moved)).toBe(true);
  });

  it("keeps moves inside the page boundaries", () => {
    const { deck } = withSection();
    expect(moveSection(deck, PAGE, FIRST, -1)).toBe(deck);
    expect(moveSection(deck, PAGE, "page_stream_second", 1)).toBe(deck);
    expect(moveSection(deck, PAGE, "page_stream_second", 0)).toBe(deck);
    expect(moveSection(deck, PAGE, "missing", 1)).toBe(deck);
    expect(moveSection(deck, "missing", FIRST, 1)).toBe(deck);
    for (const delta of [NaN, Infinity, -Infinity, 0.5, Number.MAX_VALUE]) {
      expect(moveSection(deck, PAGE, FIRST, delta)).toBe(deck);
    }
    expect(isDeck(deck)).toBe(true);
  });

  it("removes a populated section but never the last one", () => {
    const { deck, section } = withSection();
    section.controls = [
      { id: "ctl_one", label: "One", action: "mic-mute" },
      { id: "ctl_two", label: "Two", action: "media-play-pause" },
    ];
    const removed = removeSection(deck, PAGE, "page_stream_second");
    expect(removed.pages[0].sections.map((item) => item.id)).toEqual([FIRST]);
    expect(pageControls(removed.pages[0]).some((control) => control.id === "ctl_one")).toBe(false);
    expect(deck.pages[0].sections).toHaveLength(2);
    expect(isDeck(removed)).toBe(true);

    const single = createDefaultDeck();
    expect(removeSection(single, PAGE, FIRST)).toBe(single);
    expect(removeSection(single, PAGE, "missing")).toBe(single);
    expect(removeSection(single, "missing", FIRST)).toBe(single);
  });

  it("locates sections and reports missing ones", () => {
    const { deck } = withSection();
    expect(findSection(deck, PAGE, FIRST)?.name).toBe("Stream");
    expect(findSection(deck, PAGE, "missing")).toBeUndefined();
    expect(findSection(deck, "missing", FIRST)).toBeUndefined();
  });
});

describe("section appearance", () => {
  it("inherits the deck until overridden and resets to inheritance", () => {
    const { deck, section } = withSection();
    expect(sectionAppearance(deck, section)).toEqual({ theme: "dark", accent: "#4cc9f0" });
    expect(sectionStyle(section)).toBeUndefined();

    const themed = setSectionTheme(deck, PAGE, section.id, "light");
    const accented = setSectionAccent(themed, PAGE, section.id, "#ff7a9c");
    const changed = findSection(accented, PAGE, section.id)!;
    expect(sectionAppearance(accented, changed)).toEqual({ theme: "light", accent: "#ff7a9c" });
    expect(sectionStyle(changed)).toEqual({ "--accent": "#ff7a9c" });
    expect(accented.theme).toBe("dark");
    expect(isDeck(accented)).toBe(true);

    const resetTheme = setSectionTheme(accented, PAGE, section.id, null);
    const resetAccent = setSectionAccent(resetTheme, PAGE, section.id, null);
    const reset = findSection(resetAccent, PAGE, section.id)!;
    expect("theme" in reset).toBe(false);
    expect("accent" in reset).toBe(false);
    expect(sectionAppearance(resetAccent, reset)).toEqual({ theme: "dark", accent: "#4cc9f0" });
    expect(sectionStyle(reset)).toBeUndefined();
  });

  it("follows later deck changes only while inherited", () => {
    const { deck, section } = withSection();
    const overridden = setSectionTheme(deck, PAGE, section.id, "light");
    const lightDeck = { ...deck, theme: "light" as const, accent: "#6ee7b7" as const };
    expect(sectionAppearance(lightDeck, findSection(overridden, PAGE, section.id)!))
      .toEqual({ theme: "light", accent: "#6ee7b7" });
    const darkDeck = { ...lightDeck, theme: "dark" as const };
    expect(sectionAppearance(darkDeck, findSection(overridden, PAGE, section.id)!))
      .toEqual({ theme: "light", accent: "#6ee7b7" });
    const inherited = findSection(lightDeck, PAGE, FIRST)!;
    expect(sectionAppearance(darkDeck, inherited)).toEqual({ theme: "dark", accent: "#6ee7b7" });
  });

  it("ignores invalid values and no-op resets", () => {
    const { deck } = withSection();
    expect(setSectionTheme(deck, PAGE, FIRST, "midnight" as never)).toBe(deck);
    expect(setSectionAccent(deck, PAGE, FIRST, "#000000" as never)).toBe(deck);
    expect(setSectionTheme(deck, PAGE, FIRST, null)).toBe(deck);
    expect(setSectionAccent(deck, PAGE, FIRST, null)).toBe(deck);
    expect(setSectionTheme(deck, PAGE, "missing", "light")).toBe(deck);
    expect(setSectionAccent(deck, PAGE, "missing", "#6ee7b7")).toBe(deck);
    expect(setSectionTheme(deck, "missing", FIRST, "light")).toBe(deck);

    const themed = setSectionTheme(deck, PAGE, FIRST, "light");
    expect(setSectionTheme(themed, PAGE, FIRST, "light")).toBe(themed);
  });

  it("does not mutate the source deck when overriding", () => {
    const { deck } = withSection();
    const before = structuredClone(deck);
    setSectionAccent(setSectionTheme(deck, PAGE, FIRST, "light"), PAGE, FIRST, "#a78bfa");
    expect(deck).toEqual(before);
  });
});

describe("desktop page arrow guard", () => {
  it("navigates only with plain left/right on neutral content", () => {
    expect(pageArrowDelta(arrow("ArrowLeft"))).toBe(-1);
    expect(pageArrowDelta(arrow("ArrowRight"))).toBe(1);
    expect(pageArrowDelta(arrow("ArrowUp"))).toBe(0);
    expect(pageArrowDelta(arrow("ArrowLeft", { closest: () => ({}) }))).toBe(0);
    expect(pageArrowDelta(arrow("ArrowLeft", null))).toBe(0);
    expect(pageArrowDelta(arrow("ArrowLeft", {}))).toBe(0);
  });

  it("leaves modified, handled and control-owned arrows alone", () => {
    for (const key of ["altKey", "ctrlKey", "metaKey", "shiftKey", "defaultPrevented"] as const) {
      expect(pageArrowDelta(arrow("ArrowLeft", undefined, { [key]: true }))).toBe(0);
    }
    expect(pageArrowDelta(arrow("ArrowLeft", { closest: () => ({}) }, { shiftKey: true }))).toBe(0);
  });
});
