import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ControlTile } from "../src/components/ControlTile";
import { createDefaultDeck, isDeck, moveControl, updateControl } from "../src/lib/deck";
import { loadDeck, saveDeck } from "../src/lib/persistence";
import { loadDesiredService, rememberDesiredService, REMOTE_DESIRED_KEY } from "../src/lib/remotePreferences";

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe("control layout and ordering", () => {
  it("defaults legacy controls, including volume, to 1×1 in both tile renderers", () => {
    for (const control of createDefaultDeck().pages.flatMap((page) => page.controls)) {
      for (const variant of ["editor", "phone"] as const) {
        const html = renderToStaticMarkup(createElement(ControlTile, { control, variant, volume: 50 }));
        expect(html).toContain('--column-span:1;grid-row:span 1');
      }
    }
  });

  it("persists both spans and retains them through action and icon changes", () => {
    let deck = createDefaultDeck();
    deck = updateControl(deck, "page_stream", "ctl_mic", { rowSpan: 24, columnSpan: 4 });
    deck = updateControl(deck, "page_stream", "ctl_mic", { action: "volume", icon: { type: "builtin", name: "star" } });
    const storage = memoryStorage();
    expect(saveDeck(storage, deck)).toBe(true);
    expect(loadDeck(storage)).toEqual({ status: "loaded", deck });
    const control = deck.pages[0].controls[2];
    for (const variant of ["editor", "phone"] as const) {
      expect(renderToStaticMarkup(createElement(ControlTile, { control, variant, semantics: "remote", volume: 50 })))
        .toContain('--column-span:4;grid-row:span 24');
    }
  });

  it("rejects invalid spans at both the document and patch boundaries", () => {
    const deck = createDefaultDeck();
    for (const [key, values] of [["rowSpan", [0, -1, 1.5, 25, Infinity, NaN, "2", null]], ["columnSpan", [0, -1, 1.5, 5, Infinity, NaN, "2", null]]] as const) {
      for (const value of values) {
        const invalid = structuredClone(deck);
        Object.assign(invalid.pages[0].controls[0], { [key]: value });
        expect(isDeck(invalid), `${key}: ${value}`).toBe(false);
        expect(updateControl(deck, "page_stream", "ctl_starting_soon", { [key]: value } as never).pages[0].controls[0]).toEqual(deck.pages[0].controls[0]);
      }
    }
  });

  it("moves to a drop position without swapping or losing the intervening controls", () => {
    const deck = createDefaultDeck();
    const ids = deck.pages[0].controls.map((control) => control.id);
    const moved = moveControl(deck, "page_stream", ids[0], 3);
    expect(moved.pages[0].controls.map((control) => control.id)).toEqual([...ids.slice(1), ids[0]]);
    expect(moveControl(moved, "page_stream", ids[0], -3)).toEqual(deck);
    for (const delta of [0, 0.5, NaN, Infinity, -1, 4]) expect(moveControl(deck, "page_stream", ids[0], delta)).toBe(deck);
    expect(moveControl(deck, "page_stream", "external-drag", 1)).toBe(deck);
  });
});

describe("desired service preference", () => {
  it("defaults off, remembers on configuration atomically, and preserves deliberate off", () => {
    const storage = memoryStorage();
    expect(loadDesiredService(storage)).toBe(false);
    const desired = { mode: "local_https", origin: "https://192.168.1.20:8443" } as const;
    expect(rememberDesiredService(storage, desired)).toBe(true);
    expect(loadDesiredService(storage)).toEqual(desired);
    expect(rememberDesiredService(storage, false)).toBe(true);
    expect(loadDesiredService(storage)).toBe(false);
  });

  it("rejects malformed settings and reports unavailable storage instead of claiming persistence", () => {
    const storage = memoryStorage();
    for (const raw of ['{', 'true', 'null', '{"mode":"public","origin":"https://example.com"}', '{"mode":"tailscale","origin":"https://x.ts.net/#/pair?invite=secret"}']) {
      storage.setItem(REMOTE_DESIRED_KEY, raw);
      expect(() => loadDesiredService(storage)).toThrow();
    }
    expect(rememberDesiredService(null, false)).toBe(false);
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(rememberDesiredService(blocked, false)).toBe(false);
    expect(() => loadDesiredService(blocked)).toThrow();
  });
});
