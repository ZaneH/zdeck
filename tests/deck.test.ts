import { describe, expect, it } from "vitest";
import { clampVolume } from "../src/lib/actions";
import {
  addControl,
  addPage,
  createDefaultDeck,
  findControl,
  isDeck,
  MAX_PAGES,
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
    expect(result?.deck.pages[0].controls).toHaveLength(5);
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
    expect(moved.pages[0].controls.map((control) => control.id)).toEqual([
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
    badVolume.pages[1].controls[0] = {
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
    badVersion.version = 3;
    expect(isDeck(badVersion)).toBe(false);

    const badTheme = JSON.parse(JSON.stringify(createDefaultDeck())) as {
      theme: string;
    };
    badTheme.theme = "midnight";
    expect(isDeck(badTheme)).toBe(false);
  });
});
