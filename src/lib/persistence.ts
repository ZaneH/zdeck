import { createDefaultDeck, isDeck, isRecord, normalizeDeck } from "./deck";
import { isTrash } from "./trash";
import type { TrashEntry } from "./trash";
import { DECK_VERSION, type Deck, type StorageLike } from "./types";

export const STORAGE_KEY = "deck.local.v1";
/** One atomic local envelope holds the deck and its trash; trash is never inside a deck. */
export const LOCAL_DOCUMENT_VERSION = 1 as const;
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
  trash: TrashEntry[];
  status: LoadStatus;
}

interface LocalDocument {
  envelopeVersion: typeof LOCAL_DOCUMENT_VERSION;
  deck: Deck;
  trash: TrashEntry[];
}

/** Accept the current envelope and migrate an older bare deck to empty trash. */
function parseDocument(parsed: unknown): LocalDocument | null {
  if (isRecord(parsed) && Object.hasOwn(parsed, "envelopeVersion")) {
    if (parsed.envelopeVersion !== LOCAL_DOCUMENT_VERSION
      || Object.keys(parsed).length !== 3 || !isTrash(parsed.trash)) return null;
    if (isRecord(parsed.deck) && parsed.deck.version !== DECK_VERSION
      && parsed.trash.some(entry => entry.kind === "section" && Object.hasOwn(entry.section, "customTheme"))) return null;
    const deck = normalizeDeck(parsed.deck);
    return deck ? { envelopeVersion: LOCAL_DOCUMENT_VERSION, deck, trash: parsed.trash } : null;
  }
  const deck = normalizeDeck(parsed);
  return deck ? { envelopeVersion: LOCAL_DOCUMENT_VERSION, deck, trash: [] } : null;
}

export function getStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadDeck(storage: StorageLike | null): LoadResult {
  if (!storage) return { deck: createDefaultDeck(), trash: [], status: "unavailable" };

  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return { deck: createDefaultDeck(), trash: [], status: "unavailable" };
  }

  if (raw === null) return { deck: createDefaultDeck(), trash: [], status: "empty" };

  try {
    const document = parseDocument(JSON.parse(raw));
    if (document) return { deck: document.deck, trash: document.trash, status: "loaded" };
  } catch {
    // Fall through to the safe sample deck.
  }

  return { deck: createDefaultDeck(), trash: [], status: "invalid" };
}

export function saveDeck(storage: StorageLike | null, deck: Deck, trash: TrashEntry[] = []): boolean {
  if (!storage || !isDeck(deck) || !isTrash(trash)) return false;
  const document: LocalDocument = { envelopeVersion: LOCAL_DOCUMENT_VERSION, deck, trash };
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(document));
    return true;
  } catch {
    return false;
  }
}
