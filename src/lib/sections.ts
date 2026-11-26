import type { CSSProperties } from "react";
import { ACCENTS, THEMES } from "./types";
import type { Accent, Deck, Section, Theme } from "./types";
import { newId } from "./actions";

/** Matches the schema's byte bound for section ids and names. */
export const MAX_SECTION_NAME_BYTES = 128;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Returns a user-facing reason, or null when the name can be saved. */
export function sectionNameError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a section name.";
  if (utf8Length(trimmed) > MAX_SECTION_NAME_BYTES) {
    return `Section names are limited to ${MAX_SECTION_NAME_BYTES} bytes.`;
  }
  return null;
}

export function findSection(
  deck: Deck,
  pageId: string,
  sectionId: string,
): Section | undefined {
  return deck.pages.find((page) => page.id === pageId)
    ?.sections.find((section) => section.id === sectionId);
}

function mapSections(
  deck: Deck,
  pageId: string,
  update: (sections: Section[]) => Section[] | null,
): Deck {
  let changed = false;
  const pages = deck.pages.map((page) => {
    if (page.id !== pageId) return page;
    const sections = update(page.sections);
    if (!sections) return page;
    changed = true;
    return { ...page, sections };
  });
  return changed ? { ...deck, pages } : deck;
}

/** Inserts an empty section after `afterSectionId`, or at the end when null. */
export function addSection(
  deck: Deck,
  pageId: string,
  afterSectionId: string | null = null,
  name?: string,
): { deck: Deck; section: Section } | null {
  const page = deck.pages.find((item) => item.id === pageId);
  if (!page) return null;
  const index = afterSectionId
    ? page.sections.findIndex((section) => section.id === afterSectionId)
    : page.sections.length - 1;
  if (afterSectionId && index < 0) return null;

  const trimmed = name?.trim();
  if (trimmed && sectionNameError(trimmed)) return null;
  const section: Section = {
    id: newId("section"),
    name: trimmed || `Section ${page.sections.length + 1}`,
    controls: [],
  };
  const sections = [...page.sections];
  sections.splice(index + 1, 0, section);
  return {
    deck: mapSections(deck, pageId, () => sections),
    section,
  };
}

export function renameSection(
  deck: Deck,
  pageId: string,
  sectionId: string,
  name: string,
): Deck {
  if (sectionNameError(name)) return deck;
  const trimmed = name.trim();
  const section = findSection(deck, pageId, sectionId);
  if (!section || section.name === trimmed) return deck;
  return mapSections(deck, pageId, (sections) =>
    sections.map((item) => item.id === sectionId ? { ...item, name: trimmed } : item),
  );
}

export function moveSection(
  deck: Deck,
  pageId: string,
  sectionId: string,
  delta: number,
): Deck {
  const page = deck.pages.find((item) => item.id === pageId);
  const index = page?.sections.findIndex((section) => section.id === sectionId) ?? -1;
  const target = index + delta;
  if (!page || index < 0 || !Number.isSafeInteger(target) || target < 0 || target >= page.sections.length || target === index) {
    return deck;
  }
  const sections = [...page.sections];
  const [section] = sections.splice(index, 1);
  sections.splice(target, 0, section);
  return mapSections(deck, pageId, () => sections);
}

/** Removes a section unless it is the page's last one. */
export function removeSection(deck: Deck, pageId: string, sectionId: string): Deck {
  const page = deck.pages.find((item) => item.id === pageId);
  if (!page || page.sections.length <= 1) return deck;
  if (!page.sections.some((section) => section.id === sectionId)) return deck;
  return mapSections(deck, pageId, (sections) =>
    sections.filter((section) => section.id !== sectionId),
  );
}

export function setSectionTheme(
  deck: Deck,
  pageId: string,
  sectionId: string,
  theme: Theme | null,
): Deck {
  if (theme !== null && !THEMES.includes(theme)) return deck;
  const section = findSection(deck, pageId, sectionId);
  if (!section || section.theme === (theme ?? undefined)) return deck;
  return mapSections(deck, pageId, (sections) =>
    sections.map((item) => {
      if (item.id !== sectionId) return item;
      if (theme === null) {
        const { theme: _removed, ...rest } = item;
        return rest;
      }
      return { ...item, theme };
    }),
  );
}

export function setSectionAccent(
  deck: Deck,
  pageId: string,
  sectionId: string,
  accent: Accent | null,
): Deck {
  if (accent !== null && !ACCENTS.some((item) => item.value === accent)) return deck;
  const section = findSection(deck, pageId, sectionId);
  if (!section || section.accent === (accent ?? undefined)) return deck;
  return mapSections(deck, pageId, (sections) =>
    sections.map((item) => {
      if (item.id !== sectionId) return item;
      if (accent === null) {
        const { accent: _removed, ...rest } = item;
        return rest;
      }
      return { ...item, accent };
    }),
  );
}

/** Effective appearance; an absent override follows the deck. */
export function sectionAppearance(
  deck: Deck,
  section: Section,
): { theme: Theme; accent: Accent } {
  return { theme: section.theme ?? deck.theme, accent: section.accent ?? deck.accent };
}

/** Scoped token override for one section; inherited values need no inline style. */
export function sectionStyle(section: Section): CSSProperties | undefined {
  return section.accent ? ({ "--accent": section.accent } as CSSProperties) : undefined;
}

const OWNS_ARROWS =
  "input, textarea, select, button, a, dialog, [contenteditable]:not([contenteditable='false']), [role='slider'], .control-tile";

/**
 * Desktop left/right page navigation: only plain arrows on neutral content.
 * Returns 0 when the event belongs to a control or a modifier combination.
 */
export function pageArrowDelta(event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  target: EventTarget | null;
}): -1 | 0 | 1 {
  if (
    event.defaultPrevented || event.altKey || event.ctrlKey ||
    event.metaKey || event.shiftKey
  ) return 0;
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return 0;
  const target = event.target as { closest?: (selector: string) => unknown } | null;
  if (!target || typeof target.closest !== "function" || target.closest(OWNS_ARROWS)) return 0;
  return event.key === "ArrowLeft" ? -1 : 1;
}
