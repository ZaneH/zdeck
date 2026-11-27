import type { Deck } from "./types";

/** Bounded in-memory undo/redo snapshots; never persisted with the deck. */
export const DECK_HISTORY_LIMIT = 50;

export interface DeckHistory {
  past: Deck[];
  future: Deck[];
}

export function createDeckHistory(): DeckHistory {
  return { past: [], future: [] };
}

export function sameDeck(a: Deck, b: Deck): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Record one real edit. No-op edits keep the redo branch intact. */
export function recordDeckChange(
  history: DeckHistory,
  previous: Deck,
  next: Deck,
): DeckHistory {
  if (sameDeck(previous, next)) return history;
  return {
    past: [...history.past, previous].slice(-DECK_HISTORY_LIMIT),
    future: [],
  };
}

export function undoDeck(
  history: DeckHistory,
  current: Deck,
): { deck: Deck; history: DeckHistory } | null {
  const previous = history.past.at(-1);
  if (!previous) return null;
  return {
    deck: previous,
    history: {
      past: history.past.slice(0, -1),
      future: [current, ...history.future].slice(0, DECK_HISTORY_LIMIT),
    },
  };
}

export function redoDeck(
  history: DeckHistory,
  current: Deck,
): { deck: Deck; history: DeckHistory } | null {
  const next = history.future[0];
  if (!next) return null;
  return {
    deck: next,
    history: {
      past: [...history.past, current].slice(-DECK_HISTORY_LIMIT),
      future: history.future.slice(1),
    },
  };
}

export function canUndo(history: DeckHistory): boolean {
  return history.past.length > 0;
}

export function canRedo(history: DeckHistory): boolean {
  return history.future.length > 0;
}

const EDITING_TARGET =
  "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']";

/** Standard deck undo/redo shortcuts, excluding text editing and modified keys. */
export function deckHistoryShortcut(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey?: boolean;
  target: EventTarget | null;
}): "undo" | "redo" | null {
  if (event.altKey) return null;
  const target = event.target as { closest?: (selector: string) => unknown } | null;
  if (target && typeof target.closest === "function" && target.closest(EDITING_TARGET)) return null;
  const key = event.key.toLowerCase();
  if (event.ctrlKey || event.metaKey) {
    if (key === "z") return event.shiftKey ? "redo" : "undo";
    if (key === "y" && event.ctrlKey && !event.metaKey && !event.shiftKey) return "redo";
  }
  return null;
}
