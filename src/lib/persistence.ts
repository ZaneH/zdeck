import { createDefaultDeck, isDeck, normalizeDeck } from "./deck";
import type { Deck, StorageLike } from "./types";

export const STORAGE_KEY = "deck.local.v1";
const SETUP_KEY = "deck.setup.v1";
const SIDEBAR_KEY = "deck.sidebar.v1";

export function loadSidebar(storage: StorageLike | null): { collapsed: boolean; error: string | null } {
  try {
    if (!storage) throw new Error("Storage unavailable");
    const value = storage.getItem(SIDEBAR_KEY);
    if (value !== null && value !== "collapsed" && value !== "expanded") throw new Error("Invalid preference");
    return { collapsed: value === "collapsed", error: null };
  } catch {
    return { collapsed: false, error: "Sidebar preference could not be loaded. Using the expanded sidebar for this session." };
  }
}

export function saveSidebar(storage: StorageLike | null, collapsed: boolean): boolean {
  try {
    if (!storage) return false;
    storage.setItem(SIDEBAR_KEY, collapsed ? "collapsed" : "expanded");
    return true;
  } catch { return false; }
}

export function setupDismissed(storage: StorageLike | null): boolean {
  try { return storage?.getItem(SETUP_KEY) === "dismissed"; }
  catch { return false; }
}

export function dismissSetup(storage: StorageLike | null): void {
  try { storage?.setItem(SETUP_KEY, "dismissed"); }
  catch { /* Setup stays dismissible even when storage is blocked. */ }
}

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
    const deck = normalizeDeck(parsed);
    if (deck) return { deck, status: "loaded" };
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
