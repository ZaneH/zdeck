import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ControlTile } from "../src/components/ControlTile";
import { createDefaultDeck, isDeck, moveControl, updateControl } from "../src/lib/deck";
import { loadDeck, saveDeck } from "../src/lib/persistence";

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe("control layout and ordering", () => {
  it("defaults legacy controls, including volume, to 1×1 in both tile renderers", () => {
    for (const control of createDefaultDeck().pages.flatMap((page) => page.sections.flatMap((section) => section.controls))) {
      for (const variant of ["editor", "phone"] as const) {
        const html = renderToStaticMarkup(createElement(ControlTile, { control, variant, volume: 50 }));
        expect(html).not.toContain('--column-span');
        expect(html).not.toContain('data-column-span');
      }
    }
  });

  it("persists both spans and retains them through action and icon changes", () => {
    let deck = createDefaultDeck();
    deck = updateControl(deck, "page_stream", "ctl_mic", { rowSpan: 24, columnSpan: 4 });
    deck = updateControl(deck, "page_stream", "ctl_mic", { action: "volume", icon: { type: "builtin", name: "star" } });
    const storage = memoryStorage();
    expect(saveDeck(storage, deck)).toBe(true);
    expect(loadDeck(storage)).toEqual({ status: "loaded", deck, trash: [] });
    const control = deck.pages[0].sections[0].controls[2];
    for (const variant of ["editor", "phone"] as const) {
      expect(renderToStaticMarkup(createElement(ControlTile, { control, variant, semantics: "remote", volume: 50 })))
        .toContain('--column-span:4;--row-span:24');
      expect(renderToStaticMarkup(createElement(ControlTile, { control, variant, semantics: "remote", volume: 50 })))
        .toContain('data-column-span="4" data-row-span="24"');
    }
  });

  it("round-trips wide saved Glass sliders while rendering narrow in editor, preview and remote", () => {
    let deck = createDefaultDeck();
    deck.theme = "glass";
    deck = updateControl(deck, "page_stream", "ctl_mic", { action: "volume", rowSpan: 1, columnSpan: 4 });
    const storage = memoryStorage();
    expect(saveDeck(storage, deck)).toBe(true);
    const loaded = loadDeck(storage);
    expect(loaded.deck).toEqual(deck);
    const control = loaded.deck.pages[0].sections[0].controls[2];
    for (const variant of ["editor", "phone"] as const) {
      for (const semantics of ["preview", "remote"] as const) {
        const html = renderToStaticMarkup(createElement(ControlTile, { control, variant, semantics, appearance: "glass", volume: 50 }));
        expect(html).toContain('--column-span:1;--row-span:2');
        expect(html).toContain('data-column-span="4" data-row-span="1"');
        expect(html).toContain('aria-orientation="vertical"');
      }
    }
    expect(saveDeck(storage, loaded.deck)).toBe(true);
    expect(loadDeck(storage).deck).toEqual(deck);
  });

  it("keeps a transient volume-disabled tile visibly enabled while its real disabled state remains", () => {
    const control = createDefaultDeck().pages[0].sections[0].controls[0];
    const html = renderToStaticMarkup(createElement(ControlTile, {
      control, variant: "editor", volume: 50, disabled: true, transientDisabled: true,
    }));
    expect(html).toContain("is-disabled");
    expect(html).toContain("is-transient-disabled");
    expect(html).toContain("disabled");
  });

  it("rejects invalid spans at both the document and patch boundaries", () => {
    const deck = createDefaultDeck();
    for (const [key, values] of [["rowSpan", [0, -1, 1.5, 25, Infinity, NaN, "2", null]], ["columnSpan", [0, -1, 1.5, 5, Infinity, NaN, "2", null]]] as const) {
      for (const value of values) {
        const invalid = structuredClone(deck);
        Object.assign(invalid.pages[0].sections[0].controls[0], { [key]: value });
        expect(isDeck(invalid), `${key}: ${value}`).toBe(false);
        expect(updateControl(deck, "page_stream", "ctl_starting_soon", { [key]: value } as never).pages[0].sections[0].controls[0]).toEqual(deck.pages[0].sections[0].controls[0]);
      }
    }
  });

  it("moves to a drop position without swapping or losing the intervening controls", () => {
    const deck = createDefaultDeck();
    const ids = deck.pages[0].sections[0].controls.map((control) => control.id);
    const moved = moveControl(deck, "page_stream", ids[0], 3);
    expect(moved.pages[0].sections[0].controls.map((control) => control.id)).toEqual([...ids.slice(1), ids[0]]);
    expect(moveControl(moved, "page_stream", ids[0], -3)).toEqual(deck);
    for (const delta of [0, 0.5, NaN, Infinity, -1, 4]) expect(moveControl(deck, "page_stream", ids[0], delta)).toBe(deck);
    expect(moveControl(deck, "page_stream", "external-drag", 1)).toBe(deck);
  });
});
