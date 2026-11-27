import { activePage, pageControls } from "./deck";
import type { Deck } from "./types";

/** Keep a valid selection; when undo/redo restores exactly one control, select it. */
export function reconcileControlSelection(
  previous: Deck,
  next: Deck,
  selectedId: string | null,
): string | null {
  const controls = pageControls(activePage(next));
  if (selectedId && controls.some((control) => control.id === selectedId)) return selectedId;
  const previousIds = new Set(pageControls(activePage(previous)).map((control) => control.id));
  const restored = controls.filter((control) => !previousIds.has(control.id));
  return restored.length === 1 ? restored[0].id : null;
}

/** Keep a valid section selection; fall back to the first section when needed. */
export function reconcileSectionSelection(
  previous: Deck,
  next: Deck,
  selectedId: string | null,
): string | null {
  const page = activePage(next);
  if (selectedId && page.sections.some((section) => section.id === selectedId)) return selectedId;
  const previousIds = new Set(activePage(previous).sections.map((section) => section.id));
  const restored = page.sections.filter((section) => !previousIds.has(section.id));
  return restored.length === 1 ? restored[0].id : page.sections[0]?.id ?? null;
}
