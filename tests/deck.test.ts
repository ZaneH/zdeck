import { describe, expect, it } from "vitest";
import { clampVolume, createControl } from "../src/lib/actions";
import {
  addControl,
  addPage,
  createDefaultDeck,
  findControl,
  isDeck,
  MAX_CONTROLS_PER_PAGE,
  MAX_PAGES,
  normalizeDeck,
  pageControls,
  moveControl,
  movePage,
  removeControl,
  removePage,
  renamePage,
  setActivePage,
  updateControl,
} from "../src/lib/deck";

describe("deck editing", () => {
  it("creates a valid sample deck", () => {
    expect(isDeck(createDefaultDeck())).toBe(true);
  });

  it("adds a control and reports the new control", () => {
    const deck = createDefaultDeck();
    const result = addControl(deck, "page_stream", "mic-mute");
    expect(result).not.toBeNull();
    expect(result?.control.label).toBe("Mic mute");
    expect(result?.deck.pages[0].sections[0].controls).toHaveLength(5);
  });

  it("does not add a control to a missing page", () => {
    const deck = createDefaultDeck();
    expect(addControl(deck, "missing", "mic-mute")).toBeNull();
  });

  it("caps pages at the configured maximum", () => {
    let deck = createDefaultDeck();
    for (let index = deck.pages.length; index < MAX_PAGES; index += 1) {
      const result = addPage(deck);
      expect(result).not.toBeNull();
      deck = result!.deck;
    }
    expect(deck.pages).toHaveLength(MAX_PAGES);
    expect(addPage(deck)).toBeNull();
  });

  it("renames a page and trims whitespace", () => {
    const deck = createDefaultDeck();
    const renamed = renamePage(deck, "page_stream", "  Main  ");
    expect(renamed.pages[0].name).toBe("Main");
  });

  it("ignores an empty page rename", () => {
    const deck = createDefaultDeck();
    expect(renamePage(deck, "page_stream", "   ")).toBe(deck);
  });

  it("removes the active page and selects the next page", () => {
    const deck = createDefaultDeck();
    const next = removePage(deck, "page_stream");
    expect(next.pages).toHaveLength(1);
    expect(next.activePageId).toBe("page_media");
  });

  it("does not remove the last page", () => {
    const deck = createDefaultDeck();
    const next = removePage(deck, "page_media");
    expect(removePage(next, "page_stream")).toBe(next);
  });

  it("keeps the active page when removing another page", () => {
    const deck = createDefaultDeck();
    const next = removePage(deck, "page_media");
    expect(next.activePageId).toBe("page_stream");
  });

  it("moves pages within bounds and ignores edge moves", () => {
    const deck = createDefaultDeck();
    expect(movePage(deck, "page_stream", -1)).toBe(deck);
    expect(movePage(deck, "page_media", 1)).toBe(deck);
    expect(movePage(deck, "missing", 1)).toBe(deck);

    const moved = movePage(deck, "page_media", -1);
    expect(moved.pages.map((page) => page.id)).toEqual(["page_media", "page_stream"]);
  });

  it("selects only an existing page", () => {
    const deck = createDefaultDeck();
    expect(setActivePage(deck, "missing")).toBe(deck);
    expect(setActivePage(deck, "page_media").activePageId).toBe("page_media");
  });

  it("updates a control, clamps volume, and rejects missing targets", () => {
    const deck = createDefaultDeck();
    const updated = updateControl(deck, "page_media", "ctl_volume", { volume: 140 });
    expect(findControl(updated, "page_media", "ctl_volume")).toMatchObject({
      action: "volume",
      volume: 100,
    });

    expect(updateControl(deck, "page_media", "missing", { label: "Nope" })).toBe(deck);
    expect(updateControl(deck, "missing", "ctl_volume", { label: "Nope" })).toBe(deck);
  });

  it("falls back to the current label when a label is blank", () => {
    const deck = createDefaultDeck();
    const updated = updateControl(deck, "page_stream", "ctl_mic", { label: "   " });
    expect(findControl(updated, "page_stream", "ctl_mic")?.label).toBe("Mic mute");
  });

  it("removes a control and ignores missing controls", () => {
    const deck = createDefaultDeck();
    const removed = removeControl(deck, "page_stream", "ctl_mic");
    expect(findControl(removed, "page_stream", "ctl_mic")).toBeUndefined();
    expect(removeControl(deck, "page_stream", "missing")).toBe(deck);
  });

  it("moves controls within bounds and ignores edge moves", () => {
    const deck = createDefaultDeck();
    expect(moveControl(deck, "page_stream", "ctl_starting_soon", -1)).toBe(deck);
    expect(moveControl(deck, "page_stream", "ctl_play_pause", 1)).toBe(deck);
    expect(moveControl(deck, "page_stream", "missing", 1)).toBe(deck);
    expect(moveControl(deck, "missing", "ctl_mic", 1)).toBe(deck);

    const moved = moveControl(deck, "page_stream", "ctl_mic", -1);
    expect(moved.pages[0].sections[0].controls.map((control) => control.id)).toEqual([
      "ctl_starting_soon",
      "ctl_mic",
      "ctl_live",
      "ctl_play_pause",
    ]);
  });

  it("returns undefined for a missing selection", () => {
    const deck = createDefaultDeck();
    expect(findControl(deck, "page_stream", "missing")).toBeUndefined();
    expect(findControl(deck, "missing", "ctl_mic")).toBeUndefined();
  });

  it("validates volume ranges and non-finite input", () => {
    expect(clampVolume(-5)).toBe(0);
    expect(clampVolume(140)).toBe(100);
    expect(clampVolume(49.6)).toBe(50);
    expect(clampVolume(Number.NaN)).toBe(50);
  });
});

describe("OBS scene labels", () => {
  function added(label?: string) {
    return addControl(createDefaultDeck(), "page_stream", "obs-scene", { scene: "Camera", label })!;
  }

  it("uses the assigned scene unless a custom label was explicitly supplied", () => {
    expect(added().control).toMatchObject({ scene: "Camera", label: "Camera", autoLabel: true });
    expect(added("   ").control).toMatchObject({ label: "Camera", autoLabel: true });
    expect(added("  Show camera  ").control).toMatchObject({ label: "Show camera" });
    expect(added("Camera").control).not.toHaveProperty("autoLabel");
  });

  it("tracks scene edits, preserves explicit labels (even equal ones), and resets when cleared", () => {
    const { deck: initial, control } = added();
    let deck = updateControl(initial, "page_stream", control.id, { scene: "  Gameplay  " });
    expect(findControl(deck, "page_stream", control.id)).toMatchObject({ label: "Gameplay", autoLabel: true });
    deck = updateControl(deck, "page_stream", control.id, { label: "Gameplay" });
    deck = updateControl(deck, "page_stream", control.id, { scene: "Break" });
    expect(findControl(deck, "page_stream", control.id)).toMatchObject({ label: "Gameplay", scene: "Break" });
    deck = updateControl(deck, "page_stream", control.id, { label: "  " });
    expect(findControl(deck, "page_stream", control.id)).toMatchObject({ label: "Break", autoLabel: true });
    deck = updateControl(deck, "page_stream", control.id, { scene: "Camera", label: "  My camera  " });
    expect(findControl(deck, "page_stream", control.id)).toMatchObject({ label: "My camera", scene: "Camera" });
  });

  it("preserves legacy titles and resets automatic labeling when changing actions", () => {
    let deck = updateControl(createDefaultDeck(), "page_stream", "ctl_live", { scene: "Camera" });
    expect(findControl(deck, "page_stream", "ctl_live")?.label).toBe("Go live");
    deck = updateControl(deck, "page_stream", "ctl_live", { action: "mic-mute" });
    expect(findControl(deck, "page_stream", "ctl_live")).not.toHaveProperty("autoLabel");
    deck = updateControl(deck, "page_stream", "ctl_live", { action: "obs-scene", scene: "Break" });
    expect(findControl(deck, "page_stream", "ctl_live")).toMatchObject({ label: "Break", autoLabel: true });
  });

  it("preserves setup controls when recreating them for insertion", () => {
    const automatic = createControl("obs-scene", { scene: "Camera" });
    expect(createControl("obs-scene", automatic)).toMatchObject({ label: "Camera", autoLabel: true });
    expect(createControl("obs-scene", { scene: "Camera", label: "Camera", autoLabel: false })).not.toHaveProperty("autoLabel");
  });

  it("strictly validates automatic-label metadata", () => {
    const { deck } = added();
    expect(isDeck(deck)).toBe(true);
    const control = deck.pages[0].sections[0].controls.at(-1)!;
    for (const autoLabel of [null, "true", 1]) {
      expect(isDeck({ ...deck, pages: [{ ...deck.pages[0], controls: [{ ...control, autoLabel }] }] })).toBe(false);
    }
    control.label = "Wrong label";
    expect(isDeck(deck)).toBe(false);
    expect(isDeck({ ...deck, pages: [{ ...deck.pages[0], controls: [{ id: "mic", label: "Mic", action: "mic-mute", autoLabel: true }] }] })).toBe(false);
  });
});

describe("deck validation", () => {
  it("rejects empty pages and a missing active page", () => {
    const noPages = createDefaultDeck();
    noPages.pages = [];
    expect(isDeck(noPages)).toBe(false);

    const missingActive = createDefaultDeck();
    missingActive.activePageId = "missing";
    expect(isDeck(missingActive)).toBe(false);
  });

  it("rejects duplicate ids and invalid volume", () => {
    const duplicate = createDefaultDeck();
    duplicate.pages[1].id = duplicate.pages[0].id;
    expect(isDeck(duplicate)).toBe(false);

    const badVolume = createDefaultDeck();
    badVolume.pages[1].sections[0].controls[0] = {
      id: "ctl_volume",
      label: "Volume",
      action: "volume",
      volume: 101,
    };
    expect(isDeck(badVolume)).toBe(false);
  });

  it("rejects unknown versions and themes", () => {
    const badVersion = JSON.parse(JSON.stringify(createDefaultDeck())) as {
      version: number;
    };
    badVersion.version = 5;
    expect(isDeck(badVersion)).toBe(false);

    const badTheme = JSON.parse(JSON.stringify(createDefaultDeck())) as {
      theme: string;
    };
    badTheme.theme = "midnight";
    expect(isDeck(badTheme)).toBe(false);
  });
});

describe("page sections", () => {
  function withSecondSection() {
    const deck = createDefaultDeck();
    deck.pages[0].sections.push({ id: "page_stream_second", name: "Second", controls: [] });
    return deck;
  }

  it("adds controls to the first section by default or an explicit section target", () => {
    const deck = withSecondSection();
    const first = addControl(deck, "page_stream", "mic-mute")!;
    expect(first.deck.pages[0].sections[0].controls.at(-1)?.id).toBe(first.control.id);
    const second = addControl(deck, "page_stream", "mic-mute", undefined, "page_stream_second")!;
    expect(second.deck.pages[0].sections[1].controls.at(-1)?.id).toBe(second.control.id);
    expect(addControl(deck, "page_stream", "mic-mute", undefined, "missing")).toBeNull();
  });

  it("keeps the page-wide control limit across sections", () => {
    const deck = withSecondSection();
    deck.pages[0].sections[1].controls = Array.from({ length: MAX_CONTROLS_PER_PAGE - pageControls(deck.pages[0]).length }, (_, index) => ({
      id: `extra_${index}`,
      label: `Extra ${index}`,
      action: "mic-mute" as const,
    }));
    expect(isDeck(deck)).toBe(true);
    expect(addControl(deck, "page_stream", "mic-mute")).toBeNull();
  });

  it("locates a control's containing section for edits, moves and removal", () => {
    const deck = withSecondSection();
    const first = addControl(deck, "page_stream", "mic-mute", undefined, "page_stream_second")!;
    const second = addControl(first.deck, "page_stream", "mic-mute", undefined, "page_stream_second")!;
    let next = updateControl(second.deck, "page_stream", first.control.id, { label: "Second mic" });
    expect(next.pages[0].sections[1].controls[0].label).toBe("Second mic");
    next = moveControl(next, "page_stream", first.control.id, 1);
    expect(next.pages[0].sections[1].controls.map((control) => control.id)).toEqual([second.control.id, first.control.id]);
    next = removeControl(next, "page_stream", first.control.id);
    expect(next.pages[0].sections[1].controls.map((control) => control.id)).toEqual([second.control.id]);
  });

  it("requires sections with unique ids, non-empty names and valid overrides", () => {
    const emptySections = createDefaultDeck();
    emptySections.pages[0].sections = [];
    expect(isDeck(emptySections)).toBe(false);

    const duplicateSection = withSecondSection();
    duplicateSection.pages[0].sections[1].id = duplicateSection.pages[0].sections[0].id;
    expect(isDeck(duplicateSection)).toBe(false);

    const blankSection = withSecondSection();
    blankSection.pages[0].sections[1].name = "  ";
    expect(isDeck(blankSection)).toBe(false);

    const unknownSection = withSecondSection();
    Object.assign(unknownSection.pages[0].sections[1], { extra: true });
    expect(isDeck(unknownSection)).toBe(false);

    const overrides = withSecondSection();
    overrides.pages[0].sections[1].theme = "light";
    overrides.pages[0].sections[1].accent = "#6ee7b7";
    expect(isDeck(overrides)).toBe(true);
    overrides.pages[0].sections[1].theme = "glass";
    expect(isDeck(overrides)).toBe(true);
    overrides.pages[0].sections[1].theme = "terminal";
    expect(isDeck(overrides)).toBe(true);
    overrides.pages[0].sections[1].theme = "macintosh";
    expect(isDeck(overrides)).toBe(true);
    overrides.pages[0].sections[1].theme = "midnight" as never;
    expect(isDeck(overrides)).toBe(false);
    overrides.pages[0].sections[1].theme = "light";
    overrides.pages[0].sections[1].accent = "#000000" as never;
    expect(isDeck(overrides)).toBe(false);
  });

  it("accepts built-in themes globally and rejects an unknown deck theme", () => {
    const deck = createDefaultDeck();
    expect(isDeck({ ...deck, theme: "glass" })).toBe(true);
    expect(isDeck({ ...deck, theme: "terminal" })).toBe(true);
    expect(isDeck({ ...deck, theme: "macintosh" })).toBe(true);
    expect(isDeck({ ...deck, theme: "midnight" as never })).toBe(false);
  });

  it("migrates v1 and v2 decks to one deterministic section per page", () => {
    const deck = createDefaultDeck();
    for (const version of [1, 2]) {
      const legacy = {
        ...deck,
        version,
        pages: deck.pages.map((page) => ({
          id: page.id,
          name: page.name,
          controls: page.sections[0].controls,
        })),
      };
      const migrated = normalizeDeck(legacy);
      expect(migrated?.version).toBe(4);
      expect(migrated?.pages).toEqual(deck.pages);
    }
  });

  it("rejects legacy versions whose pages already have canonical sections or unknown fields", () => {
    const deck = createDefaultDeck();
    for (const version of [1, 2]) {
      expect(normalizeDeck({ ...deck, version })).toBeNull();
      const mixed = {
        ...deck,
        version,
        pages: deck.pages.map((page, index) => index === 0
          ? { id: page.id, name: page.name, controls: page.sections[0].controls, sections: page.sections }
          : { id: page.id, name: page.name, controls: page.sections[0].controls }),
      };
      expect(normalizeDeck(mixed)).toBeNull();
      const unknown = {
        ...deck,
        version,
        pages: [{ id: "p", name: "P", controls: [], extra: true }],
      };
      expect(normalizeDeck(unknown)).toBeNull();
    }
  });

  it("bounds section ids and names to 128 UTF-8 bytes", () => {
    const longId = withSecondSection();
    longId.pages[0].sections[1].id = "é".repeat(65);
    expect(isDeck(longId)).toBe(false);

    const longName = withSecondSection();
    longName.pages[0].sections[1].name = "é".repeat(65);
    expect(isDeck(longName)).toBe(false);

    const atLimit = withSecondSection();
    atLimit.pages[0].sections[1].id = "é".repeat(64);
    atLimit.pages[0].sections[1].name = "é".repeat(64);
    expect(isDeck(atLimit)).toBe(true);
  });

  it("keeps migrated section ids bounded and deterministic for long page ids", () => {
    const pageId = "p".repeat(128);
    const legacy = {
      version: 2,
      theme: "dark",
      accent: "#4cc9f0",
      activePageId: pageId,
      pages: [{ id: pageId, name: "Long", controls: [] }],
    };
    const migrated = normalizeDeck(legacy);
    expect(migrated?.pages[0].sections[0].id).toBe("section_0");
    expect(new TextEncoder().encode(migrated!.pages[0].sections[0].id).length).toBeLessThanOrEqual(128);

    const secondId = "q".repeat(128);
    const two = normalizeDeck({
      ...legacy,
      pages: [
        { id: pageId, name: "Long", controls: [] },
        { id: secondId, name: "Also long", controls: [] },
      ],
    });
    expect(two?.pages.map((page) => page.sections[0].id)).toEqual(["section_0", "section_1"]);
  });
});
