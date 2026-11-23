import { createDefaultDeck, isDeck } from "./deck";
import type { Deck, StorageLike } from "./types";

export const STORAGE_KEY = "deck.local.v1";

export type LoadStatus = "loaded" | "empty" | "invalid" | "unavailable";

export interface LoadResult {
  deck: Deck;
  status: LoadStatus;
}

export function getStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadDeck(storage: StorageLike | null): LoadResult {
  if (!storage) return { deck: createDefaultDeck(), status: "unavailable" };

  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return { deck: createDefaultDeck(), status: "unavailable" };
  }

  if (raw === null) return { deck: createDefaultDeck(), status: "empty" };

  try {
    const parsed: unknown = JSON.parse(raw);
    if (isDeck(parsed)) return { deck: parsed, status: "loaded" };
  } catch {
    // Fall through to the safe sample deck.
  }

  return { deck: createDefaultDeck(), status: "invalid" };
}

export function saveDeck(storage: StorageLike | null, deck: Deck): boolean {
  if (!storage || !isDeck(deck)) return false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(deck));
    return true;
  } catch {
    return false;
  }
}
