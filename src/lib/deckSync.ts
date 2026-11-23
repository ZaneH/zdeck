import type { DeckError, DeckSnapshot } from "./nativeDeck";
import { toDeckError } from "./nativeDeck";
import type { Deck } from "./types";

export type DeckSyncStatus =
  | { phase: "idle" }
  | { phase: "saving" }
  | { phase: "saved"; revision: number }
  | { phase: "error"; error: DeckError }
  | { phase: "conflict"; error: DeckError };

export interface DeckBackend {
  load(): Promise<DeckSnapshot>;
  save(expectedRevision: number, deck: Deck): Promise<DeckSnapshot>;
}

/**
 * Sequential, latest-state save queue around a revision compare-and-swap.
 *
 * At most one save is in flight. Edits that arrive during a save replace a
 * single pending slot, so the newest deck is written next and rapid changes are
 * not lost to concurrent CAS calls. A conflict blocks further saves until the
 * caller reloads, so a stale writer can never overwrite another writer. A
 * non-conflict failure is reported and retried on the next edit.
 */
export class DeckSync {
  private revision: number;
  private pending: Deck | null = null;
  private saving = false;
  private blocked = false;

  constructor(
    private readonly backend: DeckBackend,
    private readonly onStatus: (status: DeckSyncStatus) => void,
    revision: number,
  ) {
    this.revision = revision;
  }

  get currentRevision(): number {
    return this.revision;
  }

  get conflictBlocked(): boolean {
    return this.blocked;
  }

  /** Queue the newest in-memory deck. Called on every edit. */
  update(deck: Deck): void {
    if (this.blocked) return;
    this.pending = deck;
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.saving || this.pending === null) return;
    this.saving = true;
    const deck = this.pending;
    this.pending = null;
    this.onStatus({ phase: "saving" });

    try {
      const snapshot = await this.backend.save(this.revision, deck);
      this.revision = snapshot.revision;
      this.saving = false;
      if (this.pending !== null) {
        void this.drain();
      } else {
        this.onStatus({ phase: "saved", revision: this.revision });
      }
    } catch (value) {
      this.saving = false;
      // Never auto-retry; keep the caller's in-memory deck untouched and report.
      const error = toDeckError(value);
      if (error.kind === "conflict") {
        // A conflict must not overwrite the other writer; wait for a reload.
        this.pending = null;
        this.blocked = true;
      }
      this.onStatus(
        error.kind === "conflict"
          ? { phase: "conflict", error }
          : { phase: "error", error },
      );
    }
  }
}
