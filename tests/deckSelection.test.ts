import { describe, expect, it } from "vitest";
import { addControl, createDefaultDeck, removeControl } from "../src/lib/deck";
import { reconcileControlSelection, reconcileSectionSelection } from "../src/lib/deckSelection";

describe("deck selection reconciliation", () => {
  it("keeps a selected control that still exists and clears one that does not", () => {
    const original = createDefaultDeck();
    const { deck, control } = addControl(original, "page_stream", "mic-mute")!;
    expect(reconcileControlSelection(original, deck, "ctl_mic")).toBe("ctl_mic");
    expect(reconcileControlSelection(deck, original, control.id)).toBeNull();
  });

  it("selects a control restored by undo or redo", () => {
    const original = createDefaultDeck();
    const { deck, control } = addControl(original, "page_stream", "mic-mute")!;
    expect(reconcileControlSelection(original, deck, null)).toBe(control.id);
    expect(reconcileControlSelection(deck, original, null)).toBeNull();
    const removed = removeControl(deck, "page_stream", control.id);
    expect(reconcileControlSelection(removed, deck, null)).toBe(control.id);
  });

  it("keeps a valid section and falls back to the first section", () => {
    const original = createDefaultDeck();
    const sectionId = original.pages[0].sections[0].id;
    expect(reconcileSectionSelection(original, original, sectionId)).toBe(sectionId);
    expect(reconcileSectionSelection(original, original, "missing")).toBe(sectionId);
  });
});
