import { activePage, findPage, isDeck, isRecord, MAX_CONTROLS_PER_PAGE } from "./deck";
import { DECK_VERSION, ACCENTS } from "./types";
import type { Control, Deck, Section } from "./types";

/** Newest deleted entries kept for restore; never part of the deck or phone wire. */
export const MAX_TRASH_ITEMS = 10;
/** Keeps trash growth from making a previously valid deck unsavable. */
export const MAX_TRASH_BYTES = 256 * 1024;

export interface TrashLocation {
  pageId: string;
  pageName: string;
  /** Present on a control entry; absent on a section entry. */
  sectionId?: string;
  sectionName?: string;
  index: number;
}

export type TrashEntry =
  | { kind: "control"; id: string; deletedAt: number; control: Control; location: TrashLocation }
  | { kind: "section"; id: string; deletedAt: number; section: Section; location: TrashLocation };

const TRASH_PAGE = "__trash_page";
const TRASH_SECTION = "__trash_section";

/** Reuse full deck validation for a lone section or control payload. */
function validSectionPayload(value: unknown): value is Section {
  return isDeck({
    version: DECK_VERSION, theme: "dark", accent: ACCENTS[0].value, activePageId: TRASH_PAGE,
    pages: [{ id: TRASH_PAGE, name: "Trash", sections: [value] }],
  });
}

function validControlPayload(value: unknown): value is Control {
  return isDeck({
    version: DECK_VERSION, theme: "dark", accent: ACCENTS[0].value, activePageId: TRASH_PAGE,
    pages: [{
      id: TRASH_PAGE, name: "Trash",
      sections: [{ id: TRASH_SECTION, name: "Trash", controls: [value] }],
    }],
  });
}

function validLocation(value: unknown, kind: TrashEntry["kind"]): value is TrashLocation {
  if (!isRecord(value) || typeof value.pageId !== "string" || !value.pageId
    || typeof value.pageName !== "string" || !value.pageName.trim()
    || !Number.isSafeInteger(value.index) || (value.index as number) < 0) return false;
  const hasSection = Object.hasOwn(value, "sectionId") || Object.hasOwn(value, "sectionName");
  if (kind === "section") return !hasSection && Object.keys(value).length === 3;
  return typeof value.sectionId === "string" && !!value.sectionId
    && typeof value.sectionName === "string" && !!value.sectionName.trim()
    && Object.keys(value).length === 5;
}

export function isTrashEntry(value: unknown): value is TrashEntry {
  if (!isRecord(value) || Object.keys(value).length !== 5) return false;
  if (value.kind !== "control" && value.kind !== "section") return false;
  if (!["kind", "id", "deletedAt", "location"].every((key) => Object.hasOwn(value, key))) return false;
  if (typeof value.id !== "string" || !value.id) return false;
  if (!Number.isSafeInteger(value.deletedAt) || (value.deletedAt as number) <= 0) return false;
  if (!validLocation(value.location, value.kind)) return false;
  if (value.kind === "control") {
    return Object.hasOwn(value, "control") && !Object.hasOwn(value, "section")
      && validControlPayload(value.control) && value.control.id === value.id;
  }
  return Object.hasOwn(value, "section") && !Object.hasOwn(value, "control")
    && validSectionPayload(value.section) && value.section.id === value.id;
}

/** Trust-boundary check for stored trash: bounded count, valid payloads and unique IDs. */
export function isTrash(value: unknown): value is TrashEntry[] {
  if (!Array.isArray(value) || value.length > MAX_TRASH_ITEMS) return false;
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_TRASH_BYTES) return false;
  const ids = new Set<string>();
  for (const entry of value) {
    if (!isTrashEntry(entry) || ids.has(`${entry.kind}:${entry.id}`)) return false;
    ids.add(`${entry.kind}:${entry.id}`);
  }
  return true;
}

function sectionIds(deck: Deck): Set<string> {
  return new Set(deck.pages.flatMap((page) => page.sections.map((section) => section.id)));
}

function controlIds(deck: Deck): Set<string> {
  return new Set(deck.pages.flatMap((page) => page.sections.flatMap((section) => section.controls.map((control) => control.id))));
}

/**
 * Derive the next trash from one deck transition. Every application goes
 * through here, so undo/redo stay in step: entries whose IDs reappear are
 * dropped, entries deleted by an ordinary edit are added once, and a page
 * removal never floods its sections or controls.
 */
export function deriveTrash(
  previous: Deck,
  next: Deck,
  trash: TrashEntry[],
  now = Date.now(),
): TrashEntry[] {
  const nextSections = sectionIds(next);
  const nextControls = controlIds(next);
  const kept = trash.filter((entry) => entry.kind === "section"
    ? !nextSections.has(entry.id)
    : !nextControls.has(entry.id));

  const added: TrashEntry[] = [];
  const seen = new Set(kept.map((entry) => `${entry.kind}:${entry.id}`));
  for (const previousPage of previous.pages) {
    const nextPage = next.pages.find((page) => page.id === previousPage.id);
    if (!nextPage) continue;
    for (const [sectionIndex, previousSection] of previousPage.sections.entries()) {
      const nextSection = nextPage.sections.find((section) => section.id === previousSection.id);
      if (!nextSection) {
        // A section or control moved to another page/section is live, not deleted.
        if (nextSections.has(previousSection.id)) continue;
        const key = `section:${previousSection.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        added.push({
          kind: "section", id: previousSection.id, deletedAt: now, section: previousSection,
          location: {
            pageId: previousPage.id, pageName: nextPage.name, index: sectionIndex,
          },
        });
        continue;
      }
      for (const [controlIndex, control] of previousSection.controls.entries()) {
        if (nextControls.has(control.id)) continue;
        const key = `control:${control.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        added.push({
          kind: "control", id: control.id, deletedAt: now, control,
          location: {
            pageId: previousPage.id, pageName: nextPage.name,
            sectionId: previousSection.id, sectionName: previousSection.name,
            index: controlIndex,
          },
        });
      }
    }
  }

  const capped = [...added, ...kept].slice(0, MAX_TRASH_ITEMS);
  // A byte cap is a documented bound, not a collision drop: keep at least the newest entry.
  while (capped.length > 1 && new TextEncoder().encode(JSON.stringify(capped)).length > MAX_TRASH_BYTES) {
    capped.pop();
  }
  return capped;
}

function replacePage(deck: Deck, pageId: string, update: (page: Deck["pages"][number]) => Deck["pages"][number]): Deck {
  return { ...deck, pages: deck.pages.map((page) => (page.id === pageId ? update(page) : page)) };
}

function clampedIndex(index: number, length: number): number {
  return Math.min(index, length);
}

/** Restore is an ordinary undoable edit; a full or colliding target refuses and keeps the entry. */
export function restoreTrashEntry(
  deck: Deck,
  entry: TrashEntry,
): { deck: Deck } | { error: string } {
  const page = findPage(deck, entry.location.pageId) ?? activePage(deck);

  if (entry.kind === "section") {
    if (sectionIds(deck).has(entry.id)) {
      return { error: "A section with this ID already exists. Rename or remove it before restoring." };
    }
    const controls = controlIds(deck);
    if (entry.section.controls.some((control) => controls.has(control.id))) {
      return { error: "A control in this section already exists elsewhere. Rename or remove it before restoring." };
    }
    const total = page.sections.reduce((count, section) => count + section.controls.length, 0);
    if (total + entry.section.controls.length > MAX_CONTROLS_PER_PAGE) {
      return { error: `“${page.name}” already has ${MAX_CONTROLS_PER_PAGE} controls. Remove one before restoring this section.` };
    }
    const index = clampedIndex(entry.location.index, page.sections.length);
    return {
      deck: replacePage(deck, page.id, (current) => {
        const sections = [...current.sections];
        sections.splice(index, 0, entry.section);
        return { ...current, sections };
      }),
    };
  }

  if (controlIds(deck).has(entry.id)) {
    return { error: "A control with this ID already exists. Rename or remove it before restoring." };
  }
  const section = page.sections.find((item) => item.id === entry.location.sectionId) ?? page.sections[0];
  if (!section) return { error: "This page has no section to restore the control into." };
  const total = page.sections.reduce((count, item) => count + item.controls.length, 0);
  if (total >= MAX_CONTROLS_PER_PAGE) {
    return { error: `“${page.name}” already has ${MAX_CONTROLS_PER_PAGE} controls. Remove one before restoring.` };
  }
  const index = clampedIndex(entry.location.index, section.controls.length);
  return {
    deck: replacePage(deck, page.id, (current) => ({
      ...current,
      sections: current.sections.map((item) => {
        if (item.id !== section.id) return item;
        const controls = [...item.controls];
        controls.splice(index, 0, entry.control);
        return { ...item, controls };
      }),
    })),
  };
}

/** Human location for the grouped trash dialog. */
export function trashEntryLocation(entry: TrashEntry): string {
  return entry.kind === "control"
    ? `${entry.location.pageName} · ${entry.location.sectionName}`
    : entry.location.pageName;
}
