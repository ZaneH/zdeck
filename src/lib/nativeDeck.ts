import { invoke } from "@tauri-apps/api/core";
import { nativeAvailable } from "./native";
import type { Deck } from "./types";

/** Typed, sanitized errors returned by the native deck commands. */
export const DECK_ERROR_KINDS = [
  "invalid_input",
  "file_too_large",
  "invalid_file",
  "unsupported_version",
  "io",
  "conflict",
  "unavailable",
] as const;

export type DeckErrorKind = (typeof DECK_ERROR_KINDS)[number];

export interface DeckError {
  kind: DeckErrorKind;
  message: string;
  /** Present on a `conflict`, so a caller can report the winning revision. */
  currentRevision?: number;
}

export interface DeckSnapshot {
  revision: number;
  deck: Deck;
  exists: boolean;
}

/** File name inside the desktop app's app-data directory. */
export const NATIVE_DECK_FILE_NAME = "deck.v1.json";

const FALLBACK_MESSAGES: Record<DeckErrorKind, string> = {
  invalid_input: "The deck is not valid and was not saved.",
  file_too_large: "The deck file is too large to load or save safely.",
  invalid_file: "The saved deck file is invalid. It was left unchanged.",
  unsupported_version:
    "The saved deck file uses an unsupported version. It was left unchanged.",
  io: "The deck file could not be read or written.",
  conflict: "The deck changed elsewhere. Reload before saving.",
  unavailable: "The desktop deck store is unavailable.",
};

/** Normalize anything thrown by `invoke` into a typed, sanitized deck error. */
export function toDeckError(value: unknown): DeckError {
  if (value && typeof value === "object") {
    const candidate = value as {
      kind?: unknown;
      message?: unknown;
      currentRevision?: unknown;
    };
    if (
      typeof candidate.kind === "string" &&
      (DECK_ERROR_KINDS as readonly string[]).includes(candidate.kind)
    ) {
      const kind = candidate.kind as DeckErrorKind;
      const message =
        typeof candidate.message === "string" && candidate.message.trim()
          ? candidate.message
          : FALLBACK_MESSAGES[kind];
      const currentRevision =
        typeof candidate.currentRevision === "number"
          ? candidate.currentRevision
          : undefined;
      return { kind, message, currentRevision };
    }
  }
  return { kind: "io", message: FALLBACK_MESSAGES.io };
}

function requireNative(): void {
  if (!nativeAvailable()) {
    throw {
      kind: "unavailable",
      message: "The native deck store is only available in the desktop app.",
    } satisfies DeckError;
  }
}

export async function nativeDeckLoad(): Promise<DeckSnapshot> {
  requireNative();
  return invoke<DeckSnapshot>("native_deck_load");
}

export async function nativeDeckSave(
  expectedRevision: number,
  deck: Deck,
): Promise<DeckSnapshot> {
  requireNative();
  return invoke<DeckSnapshot>("native_deck_save", { expectedRevision, deck });
}
