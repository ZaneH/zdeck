import { describe, expect, it } from "vitest";
import {
  MAX_CONTROLS_PER_PAGE,
  addControl,
  addPage,
  createDefaultDeck,
  findControl,
  isDeck,
  findPage,
  pageControls,
  removeControl,
  removePage,
} from "../src/lib/deck";
import { addSection, removeSection, setSectionTheme } from "../src/lib/sections";
import type { Control, Deck } from "../src/lib/types";
import {
  MAX_TRASH_ITEMS,
  deriveTrash,
  isTrash,
  isTrashEntry,
  restoreTrashEntry,
} from "../src/lib/trash";
import type { TrashEntry } from "../src/lib/trash";

const PAGE = "page_stream";
const SECTION = "page_stream_section";

function removeAt(deck: Deck, controlId: string, trash: TrashEntry[] = []) {
  const next = removeControl(deck, PAGE, controlId);
  return { deck: next, trash: deriveTrash(deck, next, trash, 1000) };
}

function addMany(deck: Deck, count: number): { deck: Deck; controls: Control[] } {
  const controls: Control[] = [];
  let current = deck;
  for (let index = 0; index < count; index += 1) {
    const result = addControl(current, PAGE, "mic-mute", { label: `Mute ${index}` })!;
    current = result.deck;
    controls.push(result.control);
  }
  return { deck: current, controls };
}

describe("trash derivation", () => {
  it("records one deleted control with its original page, section and index", () => {
    const deck = createDefaultDeck();
    const removed = removeAt(deck, "ctl_mic");
    expect(removed.trash).toHaveLength(1);
    expect(removed.trash[0]).toMatchObject({
      kind: "control", id: "ctl_mic", deletedAt: 1000,
      control: findControl(deck, PAGE, "ctl_mic"),
      location: {
        pageId: PAGE, pageName: "Stream", sectionId: SECTION, sectionName: "Stream", index: 2,
      },
    });
    expect(isTrash(removed.trash)).toBe(true);
  });

  it("bundles a removed section once and does not flood its controls", () => {
    const withSection = addSection(createDefaultDeck(), PAGE, SECTION, "Audio")!;
    const added = addControl(withSection.deck, PAGE, "mic-mute", undefined, withSection.section.id)!;
    const next = removeSection(added.deck, PAGE, withSection.section.id);
    const trash = deriveTrash(added.deck, next, [], 2000);
    expect(trash).toHaveLength(1);
    expect(trash[0]).toMatchObject({
      kind: "section", id: withSection.section.id, section: { name: "Audio" },
      location: { pageId: PAGE, pageName: "Stream", index: 1 },
    });
    expect(trash[0].kind === "section" && trash[0].section.controls).toHaveLength(1);
    expect(trash.some((entry) => entry.kind === "control")).toBe(false);
  });

  it("never trashes a removed page or its children", () => {
    const withPage = addPage(createDefaultDeck())!;
    const next = removePage(withPage.deck, withPage.page.id);
    expect(deriveTrash(withPage.deck, next, [], 3000)).toEqual([]);
  });

  it("does not trash a control moved across sections or pages", () => {
    const deck = createDefaultDeck();
    const [stream, media] = deck.pages;
    const control = findControl(deck, PAGE, "ctl_mic")!;
    const moved: Deck = {
      ...deck,
      pages: [
        { ...stream, sections: stream.sections.map((section) => section.id === SECTION
          ? { ...section, controls: section.controls.filter((item) => item.id !== control.id) }
          : section) },
        { ...media, sections: media.sections.map((section) => section.id === media.sections[0].id
          ? { ...section, controls: [...section.controls, control] }
          : section) },
      ],
    };
    const trash = deriveTrash(deck, moved, [], 3500);
    expect(trash).toEqual([]);
    expect(trash.some((entry) => entry.id === control.id)).toBe(false);
    // Undo of the move is equally a live item, never a fresh deletion.
    expect(deriveTrash(moved, deck, trash, 3600)).toEqual([]);
  });

  it("does not trash a section moved to another page", () => {
    const deck = createDefaultDeck();
    const [stream, media] = deck.pages;
    const section = stream.sections[0];
    const moved: Deck = {
      ...deck,
      pages: [
        { ...stream, sections: stream.sections.filter((item) => item.id !== section.id) },
        { ...media, sections: [...media.sections, section] },
      ],
    };
    const trash = deriveTrash(deck, moved, [], 3700);
    expect(trash).toEqual([]);
    expect(deriveTrash(moved, deck, trash, 3800)).toEqual([]);
  });

  it("caps at ten newest entries and dedupes repeated IDs", () => {
    const deck = createDefaultDeck();
    const many = addMany(deck, 12);
    let current = many.deck;
    let trash: TrashEntry[] = [];
    for (const control of many.controls) {
      const next = removeControl(current, PAGE, control.id);
      trash = deriveTrash(current, next, trash, 4000);
      current = next;
    }
    expect(trash).toHaveLength(MAX_TRASH_ITEMS);
    expect(new Set(trash.map((entry) => `${entry.kind}:${entry.id}`)).size).toBe(trash.length);
    // The newest ten survive; the first two deletions fell off.
    expect(trash.map((entry) => entry.id)).toEqual(many.controls.slice(2).map((control) => control.id).reverse());

    const again = deriveTrash(many.deck, current, trash, 4000);
    expect(again.filter((entry) => entry.kind === "control")).toHaveLength(MAX_TRASH_ITEMS);
  });

  it("keeps the trash unchanged when an edit removes nothing", () => {
    const deck = createDefaultDeck();
    const removed = removeAt(deck, "ctl_mic");
    const renamed = { ...removed.deck, pages: [{ ...removed.deck.pages[0], name: "Renamed" }, removed.deck.pages[1]] };
    const trash = deriveTrash(removed.deck, renamed, removed.trash, 5000);
    expect(trash).toEqual(removed.trash);
    expect(trash[0].location.pageName).toBe("Stream");
  });
});

describe("trash coordination with undo and redo", () => {
  it("drops an entry when undo brings the control back and adds it once on redo", () => {
    const deck = createDefaultDeck();
    const deleted = removeAt(deck, "ctl_mic");
    expect(deleted.trash).toHaveLength(1);

    const undone = deriveTrash(deleted.deck, deck, deleted.trash, 6000);
    expect(undone).toEqual([]);

    const redone = deriveTrash(deck, deleted.deck, undone, 7000);
    expect(redone).toHaveLength(1);
    expect(redone[0].id).toBe("ctl_mic");
  });

  it("removes the entry after a restore and returns it when the restore is undone", () => {
    const deck = createDefaultDeck();
    const deleted = removeAt(deck, "ctl_mic");
    const restored = restoreTrashEntry(deleted.deck, deleted.trash[0]);
    expect("deck" in restored).toBe(true);
    if (!("deck" in restored)) return;

    const afterRestore = deriveTrash(deleted.deck, restored.deck, deleted.trash, 8000);
    expect(afterRestore).toEqual([]);
    const undidRestore = deriveTrash(restored.deck, deleted.deck, afterRestore, 9000);
    expect(undidRestore.map((entry) => entry.id)).toEqual(["ctl_mic"]);
  });

  it("does not duplicate an entry when the same removal is derived twice", () => {
    const deck = createDefaultDeck();
    const deleted = removeAt(deck, "ctl_mic");
    const again = deriveTrash(deck, deleted.deck, deleted.trash, 9500);
    expect(again).toHaveLength(1);
  });
});

describe("trash restore", () => {
  it("restores a control to its original section and clamped index", () => {
    const withSection = addSection(createDefaultDeck(), PAGE, SECTION, "Second")!;
    const first = addControl(withSection.deck, PAGE, "mic-mute", undefined, withSection.section.id)!;
    const second = addControl(first.deck, PAGE, "mic-mute", undefined, withSection.section.id)!;
    const deleted = removeAt(second.deck, first.control.id);
    const entry = deleted.trash[0];

    const restored = restoreTrashEntry(deleted.deck, entry);
    expect("deck" in restored).toBe(true);
    if (!("deck" in restored)) return;
    const section = restored.deck.pages[0].sections.find((item) => item.id === withSection.section.id)!;
    expect(section.controls.map((control) => control.id)).toEqual([first.control.id, second.control.id]);
    expect(isDeck(restored.deck)).toBe(true);

    const stale = { ...entry, location: { ...entry.location, index: 99 } };
    const appended = restoreTrashEntry(deleted.deck, stale);
    expect("deck" in appended && appended.deck.pages[0].sections[1].controls.at(-1)?.id).toBe(first.control.id);
  });

  it("restores to the active page and first section when the origin is gone", () => {
    const withPage = addPage(createDefaultDeck())!;
    const added = addControl(withPage.deck, withPage.page.id, "mic-mute")!;
    const deleted = removeAtPage(added.deck, withPage.page.id, added.control.id);
    const pageGone = { ...deleted.deck, pages: deleted.deck.pages.filter((page) => page.id !== withPage.page.id),
      activePageId: deleted.deck.pages[0].id };

    const restored = restoreTrashEntry(pageGone, deleted.trash[0]);
    expect("deck" in restored).toBe(true);
    if (!("deck" in restored)) return;
    const page = findPage(restored.deck, pageGone.activePageId)!;
    expect(page.sections[0].controls.some((control) => control.id === added.control.id)).toBe(true);
  });

  it("round-trips a Glass section through trash and restore", () => {
    const withSection = addSection(createDefaultDeck(), PAGE, SECTION, "Audio")!;
    const glassDeck = setSectionTheme(withSection.deck, PAGE, withSection.section.id, "glass");
    const deleted = removeSection(glassDeck, PAGE, withSection.section.id);
    const trash = deriveTrash(glassDeck, deleted, [], 1050);
    expect(isTrash(trash)).toBe(true);
    expect(trash[0].kind === "section" && trash[0].section.theme).toBe("glass");
    const restored = restoreTrashEntry(deleted, trash[0]);
    expect("deck" in restored && restored.deck.pages[0].sections[1].theme).toBe("glass");
  });

  it("restores a section at its index or appends when the index is stale", () => {
    const withSection = addSection(createDefaultDeck(), PAGE, SECTION, "Audio")!;
    const deleted = removeSection(withSection.deck, PAGE, withSection.section.id);
    const entry = deriveTrash(withSection.deck, deleted, [], 1100)[0];
    const restored = restoreTrashEntry(deleted, entry);
    expect("deck" in restored && restored.deck.pages[0].sections.map((section) => section.name))
      .toEqual(["Stream", "Audio"]);

    const stale = { ...entry, location: { ...entry.location, index: 99 } };
    const appended = restoreTrashEntry(deleted, stale);
    expect("deck" in appended && appended.deck.pages[0].sections.map((section) => section.name))
      .toEqual(["Stream", "Audio"]);
  });

  it("refuses a full page and keeps the entry", () => {
    const deck = createDefaultDeck();
    const fillers = addMany(deck, MAX_CONTROLS_PER_PAGE - pageControls(deck.pages[0]).length);
    expect(pageControls(fillers.deck.pages[0])).toHaveLength(MAX_CONTROLS_PER_PAGE);
    const removed = removeAt(fillers.deck, fillers.controls[0].id);
    const refill = addControl(removed.deck, PAGE, "mic-mute", { label: "Refill" })!;
    expect(pageControls(refill.deck.pages[0])).toHaveLength(MAX_CONTROLS_PER_PAGE);

    const refused = restoreTrashEntry(refill.deck, removed.trash[0]);
    expect("error" in refused && refused.error).toContain("Remove one");
  });

  it("refuses an ID collision without dropping the payload", () => {
    const deck = createDefaultDeck();
    const deleted = removeAt(deck, "ctl_mic");
    const entry = deleted.trash[0];
    if (entry.kind !== "control") throw new Error("expected a control entry");
    const colliding: Deck = {
      ...deleted.deck,
      pages: deleted.deck.pages.map((page) => page.id === PAGE ? {
        ...page,
        sections: page.sections.map((section) => ({
          ...section,
          controls: [...section.controls, { ...entry.control, label: "Different" }],
        })),
      } : page),
    };
    const refused = restoreTrashEntry(colliding, entry);
    expect("error" in refused && refused.error).toContain("already exists");
    expect(entry.control.id).toBe("ctl_mic");
  });
});

function removeAtPage(deck: Deck, pageId: string, controlId: string): { deck: Deck; trash: TrashEntry[] } {
  const next = removeControl(deck, pageId, controlId);
  return { deck: next, trash: deriveTrash(deck, next, [], 1000) };
}

describe("trash validation", () => {
  const deck = createDefaultDeck();
  const entry = removeAt(deck, "ctl_mic").trash[0];
  if (entry.kind !== "control") throw new Error("expected a control entry");

  it("accepts a derived entry and rejects duplicates or bad payloads", () => {
    expect(isTrashEntry(entry)).toBe(true);
    expect(isTrash([entry])).toBe(true);
    expect(isTrash([entry, entry])).toBe(false);
    expect(isTrashEntry({ ...entry, deletedAt: -1 })).toBe(false);
    expect(isTrashEntry({ ...entry, id: "different" })).toBe(false);
    expect(isTrashEntry({ ...entry, extra: true })).toBe(false);
    expect(isTrashEntry({ ...entry, control: { ...entry.control, label: "" } })).toBe(false);
    expect(isTrash(Array.from({ length: MAX_TRASH_ITEMS + 1 }, (_, index) => ({ ...entry, id: `id_${index}` })))).toBe(false);
  });
});

describe("section restore boundaries", () => {
  it("refuses a section whose control IDs already exist in the deck", () => {
    const withSection = addSection(createDefaultDeck(), PAGE, SECTION, "Audio")!;
    const added = addControl(withSection.deck, PAGE, "mic-mute", undefined, withSection.section.id)!;
    const withoutSection = removeSection(added.deck, PAGE, withSection.section.id);
    const entry = deriveTrash(added.deck, withoutSection, [], 1200)[0];
    const reinserted: Deck = {
      ...withoutSection,
      pages: withoutSection.pages.map((page) => page.id === PAGE ? {
        ...page,
        sections: page.sections.map((section) => ({
          ...section,
          controls: [...section.controls, added.control],
        })),
      } : page),
    };
    const refused = restoreTrashEntry(reinserted, entry);
    expect("error" in refused && refused.error).toContain("already exists");
  });

  it("refuses a section that would exceed the page control limit", () => {
    const deck = createDefaultDeck();
    const withSection = addSection(deck, PAGE, SECTION, "Audio")!;
    let full = withSection.deck;
    const room = MAX_CONTROLS_PER_PAGE - pageControls(full.pages[0]).length;
    for (let index = 0; index < room; index += 1) {
      full = addControl(full, PAGE, "mic-mute", { label: `Mute ${index}` }, SECTION)!.deck;
    }
    const withFullSection = addSection(full, PAGE, SECTION, "Full")!;
    // Give the new section one control by moving a page control into it manually.
    const control = pageControls(withFullSection.deck.pages[0])[0];
    const moved: Deck = {
      ...withFullSection.deck,
      pages: withFullSection.deck.pages.map((page) => page.id === PAGE ? {
        ...page,
        sections: page.sections.map((section) => section.id === withFullSection.section.id
          ? { ...section, controls: [control] }
          : { ...section, controls: section.controls.filter((item) => item.id !== control.id) }),
      } : page),
    };
    const removed = removeSection(moved, PAGE, withFullSection.section.id);
    const entry = deriveTrash(moved, removed, [], 1300)[0];
    // Refill the freed slot so the page is full again.
    const refilled = addControl(removed, PAGE, "mic-mute", { label: "Refill" })!;
    const refused = restoreTrashEntry(refilled.deck, entry);
    expect("error" in refused && refused.error).toContain("Remove one");
  });
});
