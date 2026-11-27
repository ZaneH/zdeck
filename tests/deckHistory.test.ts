import { describe, expect, it } from "vitest";
import {
  addControl,
  addPage,
  createDefaultDeck,
  findControl,
  moveControl,
  movePage,
  removeControl,
  removePage,
  renamePage,
  setTheme,
  updateControl,
} from "../src/lib/deck";
import {
  addSection,
  moveSection,
  removeSection,
  renameSection,
  setSectionTheme,
} from "../src/lib/sections";
import {
  DECK_HISTORY_LIMIT,
  canRedo,
  canUndo,
  createDeckHistory,
  deckHistoryShortcut,
  recordDeckChange,
  redoDeck,
  sameDeck,
  undoDeck,
} from "../src/lib/deckHistory";
import { loadDeck, saveDeck } from "../src/lib/persistence";
import type { StorageLike } from "../src/lib/types";

class MemoryStorage implements StorageLike {
  private readonly data = new Map<string, string>();
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
}

function shortcut(
  key: string,
  overrides: Partial<{
    altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; target: EventTarget | null;
  }> = {},
) {
  return {
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    target: { closest: () => null } as unknown as EventTarget,
    ...overrides,
  };
}

function editingTarget(tag: string): EventTarget {
  return {
    closest: (selector: string) =>
      selector.split(",").some((part) => part.trim().includes(tag)) ? {} : null,
  } as unknown as EventTarget;
}

describe("deck history", () => {
  it("undoes and redoes control add, edit, reorder and delete as one action each", () => {
    const initial = createDefaultDeck();
    const added = addControl(initial, "page_stream", "mic-mute")!;
    let history = recordDeckChange(createDeckHistory(), initial, added.deck);

    const edited = updateControl(added.deck, "page_stream", added.control.id, { label: "Mute" });
    history = recordDeckChange(history, added.deck, edited);

    const moved = moveControl(edited, "page_stream", added.control.id, -1);
    history = recordDeckChange(history, edited, moved);

    const removed = removeControl(moved, "page_stream", added.control.id);
    history = recordDeckChange(history, moved, removed);

    expect(history.past).toHaveLength(4);
    expect(canUndo(history)).toBe(true);
    expect(canRedo(history)).toBe(false);

    let step = undoDeck(history, removed)!;
    expect(findControl(step.deck, "page_stream", added.control.id)).toMatchObject({ label: "Mute" });
    expect(step.deck.pages[0].sections[0].controls.map((control) => control.id))
      .toEqual(moved.pages[0].sections[0].controls.map((control) => control.id));

    step = undoDeck(step.history, step.deck)!;
    expect(step.deck.pages[0].sections[0].controls.map((control) => control.id))
      .toEqual(edited.pages[0].sections[0].controls.map((control) => control.id));
    expect(findControl(step.deck, "page_stream", added.control.id)?.label).toBe("Mute");

    step = undoDeck(step.history, step.deck)!;
    expect(findControl(step.deck, "page_stream", added.control.id)?.label).toBe(added.control.label);
    expect(step.deck).toEqual(added.deck);

    step = undoDeck(step.history, step.deck)!;
    expect(step.deck).toEqual(initial);
    expect(canUndo(step.history)).toBe(false);
    expect(canRedo(step.history)).toBe(true);

    const redone = redoDeck(step.history, step.deck)!;
    expect(redone.deck).toEqual(added.deck);
  });

  it("undoes page and section configuration changes", () => {
    const initial = createDefaultDeck();
    const addedPage = addPage(initial)!;
    let history = recordDeckChange(createDeckHistory(), initial, addedPage.deck);
    let deck = addedPage.deck;

    const renamedPage = renamePage(deck, addedPage.page.id, "Intermission");
    history = recordDeckChange(history, deck, renamedPage);
    deck = renamedPage;

    const movedPage = movePage(deck, addedPage.page.id, -1);
    history = recordDeckChange(history, deck, movedPage);
    deck = movedPage;

    const addedSection = addSection(deck, addedPage.page.id)!;
    history = recordDeckChange(history, deck, addedSection.deck);
    deck = addedSection.deck;

    const renamedSection = renameSection(deck, addedPage.page.id, addedSection.section.id, "Notes");
    history = recordDeckChange(history, deck, renamedSection);
    deck = renamedSection;

    const movedSection = moveSection(deck, addedPage.page.id, addedSection.section.id, -1);
    history = recordDeckChange(history, deck, movedSection);
    deck = movedSection;

    const themedSection = setSectionTheme(deck, addedPage.page.id, addedSection.section.id, "light");
    history = recordDeckChange(history, deck, themedSection);
    deck = themedSection;

    const removedSection = removeSection(deck, addedPage.page.id, addedSection.section.id);
    history = recordDeckChange(history, deck, removedSection);
    deck = removedSection;

    const removedPage = removePage(deck, addedPage.page.id);
    history = recordDeckChange(history, deck, removedPage);
    deck = removedPage;

    expect(deck.pages).toEqual(initial.pages);
    expect(deck.activePageId).toBe("page_media");
    expect(history.past).toHaveLength(9);

    let step = undoDeck(history, deck)!;
    expect(step.deck.pages.some((page) => page.id === addedPage.page.id)).toBe(true);
    step = undoDeck(step.history, step.deck)!;
    expect(step.deck.pages.find((page) => page.id === addedPage.page.id)?.sections
      .find((section) => section.id === addedSection.section.id)?.theme).toBe("light");
    step = undoDeck(step.history, step.deck)!;
    expect(step.deck.pages.find((page) => page.id === addedPage.page.id)?.sections[0].id)
      .toBe(addedSection.section.id);
    step = undoDeck(step.history, step.deck)!;
    expect(step.deck.pages.find((page) => page.id === addedPage.page.id)?.sections
      .find((section) => section.id === addedSection.section.id)?.name).toBe("Notes");
    step = undoDeck(step.history, step.deck)!;
    expect(step.deck.pages.find((page) => page.id === addedPage.page.id)?.sections).toHaveLength(2);
    step = undoDeck(step.history, step.deck)!;
    expect(step.deck.pages.find((page) => page.id === addedPage.page.id)?.sections).toHaveLength(1);
    step = undoDeck(step.history, step.deck)!;
    expect(step.deck.pages.find((page) => page.id === addedPage.page.id)?.name).toBe("Intermission");
    step = undoDeck(step.history, step.deck)!;
    expect(step.deck.pages[2].id).toBe(addedPage.page.id);
    step = undoDeck(step.history, step.deck)!;
    expect(step.deck).toEqual(initial);
  });

  it("keeps redo on no-op edits and clears it on a new real edit", () => {
    const initial = createDefaultDeck();
    const added = addControl(initial, "page_stream", "mic-mute")!;
    const history = recordDeckChange(createDeckHistory(), initial, added.deck);
    const undone = undoDeck(history, added.deck)!;
    expect(canRedo(undone.history)).toBe(true);

    const noChange = updateControl(undone.deck, "page_stream", "ctl_starting_soon", {
      label: findControl(undone.deck, "page_stream", "ctl_starting_soon")!.label,
    });
    expect(sameDeck(undone.deck, noChange)).toBe(true);
    expect(recordDeckChange(undone.history, undone.deck, noChange)).toBe(undone.history);
    expect(canRedo(undone.history)).toBe(true);

    const edited = updateControl(undone.deck, "page_stream", "ctl_starting_soon", { label: "Start" });
    const branched = recordDeckChange(undone.history, undone.deck, edited);
    expect(canRedo(branched)).toBe(false);
  });

  it("caps session history and keeps every undo step reachable", () => {
    let deck = createDefaultDeck();
    let history = createDeckHistory();
    for (let index = 0; index < DECK_HISTORY_LIMIT + 10; index += 1) {
      const next = renamePage(deck, "page_stream", `Name ${index}`);
      history = recordDeckChange(history, deck, next);
      deck = next;
    }

    expect(history.past).toHaveLength(DECK_HISTORY_LIMIT);
    expect(history.past[0].pages[0].name).toBe("Name 9");
    expect(deck.pages[0].name).toBe("Name 59");

    for (let index = 0; index < DECK_HISTORY_LIMIT; index += 1) {
      const step = undoDeck(history, deck)!;
      history = step.history;
      deck = step.deck;
    }
    expect(deck.pages[0].name).toBe("Name 9");
    expect(undoDeck(history, deck)).toBeNull();
  });

  it("saves and reloads an undone deck through the existing persistence path", () => {
    const storage = new MemoryStorage();
    const initial = createDefaultDeck();
    const added = addControl(initial, "page_stream", "mic-mute")!;
    const history = recordDeckChange(createDeckHistory(), initial, added.deck);
    const undone = undoDeck(history, added.deck)!;

    expect(saveDeck(storage, undone.deck)).toBe(true);
    expect(loadDeck(storage)).toEqual({ deck: undone.deck, trash: [], status: "loaded" });
  });

  it("resets empty so an authoritative reload cannot be undone", () => {
    const stale = createDeckHistory();
    const initial = createDefaultDeck();
    const next = setTheme(initial, "light");
    const withHistory = recordDeckChange(stale, initial, next);
    expect(canUndo(withHistory)).toBe(true);

    const reset = createDeckHistory();
    expect(canUndo(reset)).toBe(false);
    expect(canRedo(reset)).toBe(false);
    expect(undoDeck(reset, next)).toBeNull();
  });
});

describe("deck history shortcuts", () => {
  it("maps standard undo and redo shortcuts", () => {
    expect(deckHistoryShortcut(shortcut("z", { metaKey: true }))).toBe("undo");
    expect(deckHistoryShortcut(shortcut("z", { ctrlKey: true }))).toBe("undo");
    expect(deckHistoryShortcut(shortcut("Z", { metaKey: true, shiftKey: true }))).toBe("redo");
    expect(deckHistoryShortcut(shortcut("z", { ctrlKey: true, shiftKey: true }))).toBe("redo");
    expect(deckHistoryShortcut(shortcut("y", { ctrlKey: true }))).toBe("redo");
  });

  it("ignores unrelated or modified keys", () => {
    expect(deckHistoryShortcut(shortcut("z"))).toBeNull();
    expect(deckHistoryShortcut(shortcut("z", { ctrlKey: true, altKey: true }))).toBeNull();
    expect(deckHistoryShortcut(shortcut("y", { metaKey: true }))).toBeNull();
    expect(deckHistoryShortcut(shortcut("y", { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(deckHistoryShortcut(shortcut("a", { ctrlKey: true }))).toBeNull();
  });

  it("does not intercept text or contenteditable editing", () => {
    for (const tag of ["input", "textarea", "select", "contenteditable"]) {
      expect(deckHistoryShortcut(shortcut("z", { ctrlKey: true, target: editingTarget(tag) }))).toBeNull();
      expect(deckHistoryShortcut(shortcut("z", { metaKey: true, shiftKey: true, target: editingTarget(tag) }))).toBeNull();
    }
    expect(deckHistoryShortcut(shortcut("z", { ctrlKey: true, target: editingTarget("button") }))).toBe("undo");
  });
});
