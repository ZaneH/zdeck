import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BUILTIN_ICONS, isControlIcon, isIconSource, isPluginIcons } from "../src/lib/icons";
import { createDefaultDeck, isDeck, normalizeDeck, updateControl } from "../src/lib/deck";
import { loadDeck, saveDeck } from "../src/lib/persistence";
import { parsePluginManifest } from "../src/lib/plugin";
import { parseSnapshot } from "../src/lib/remotePhone";
import { IconPicker, iconGroups } from "../src/components/IconPicker";
import { ControlTile } from "../src/components/ControlTile";
import { validateManifest } from "../packages/plugin-sdk/index.js";

const src = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2h20v20H2z"/></svg>').toString("base64")}`;
const icon = { id: "album", title: "Album art", category: "Media", src };
const manifest = { id: "player", version: "0.1.0", protocolVersion: 1 as const, actions: [{ id: "play", title: "Play", config: {} }], icons: [icon] };

describe("portable custom icons", () => {
  it("agrees with SDK validation for optional, bounded image metadata", () => {
    for (const value of [manifest, { ...manifest, icons: [] }]) {
      expect(parsePluginManifest(value)).toEqual(value);
      expect(validateManifest(value)).toEqual(value);
    }
    const { icons: _, ...legacy } = manifest;
    expect(parsePluginManifest(legacy)).toEqual(legacy);
    expect(validateManifest(legacy)).toEqual(legacy);
    for (const icons of [null, {}, [icon, icon], Array(33).fill(icon), [{ ...icon, id: "../escape" }],
      [{ ...icon, title: " " }], [{ ...icon, category: "\n" }], [{ ...icon, category: "x".repeat(81) }],
      [{ ...icon, extra: true }], [{ ...icon, src: "https://example.com/private.svg" }],
      [{ ...icon, src: `data:image/png;base64,${"A".repeat(8192)}` }]]) {
      expect(parsePluginManifest({ ...manifest, icons })).toBeNull();
      expect(() => validateManifest({ ...manifest, icons })).toThrow();
    }
    // The existing total manifest budget still applies, not just per-image limits.
    const big = { ...manifest, icons: Array.from({ length: 3 }, (_, n) => ({ ...icon, id: `i${n}`, src: `data:image/png;base64,${"A".repeat(8000)}` })) };
    expect(parsePluginManifest(big)).toBeNull();
    expect(() => validateManifest(big)).toThrow();
  });

  it("rejects network/file/script/HTML sources and malformed base64", () => {
    expect(isIconSource(src)).toBe(true);
    for (const mime of ["png", "jpeg", "gif", "webp", "svg+xml"]) expect(isIconSource(`data:image/${mime};base64,PHN2Zy8+`)).toBe(true);
    for (const bad of [null, "file:///tmp/icon.png", "https://example.com/icon.svg", "javascript:alert(1)",
      "data:text/html;base64,PHN2Zy8+", "data:image/svg+xml,<svg/>", "data:image/png;base64,",
      "data:image/png;base64,abc", "data:image/png;base64,====", "data:image/png;base64,a===", "data:image/png;base64,aa=a"]) {
      expect(isIconSource(bad)).toBe(false);
      expect(isPluginIcons([{ ...icon, src: bad }])).toBe(false);
    }
    for (const item of BUILTIN_ICONS) expect(isControlIcon({ type: "builtin", name: item.id })).toBe(true);
    for (const bad of [null, {}, { type: "builtin", name: "nope" }, { type: "image", src, onclick: "bad" }]) expect(isControlIcon(bad)).toBe(false);
  });

  it("persists any icon independently of action, survives edits and resets cleanly", () => {
    let deck = createDefaultDeck();
    const id = deck.pages[0].controls[0].id;
    const pageId = deck.activePageId;
    deck = updateControl(deck, pageId, id, { icon: { type: "image", src } });
    deck = updateControl(deck, pageId, id, { action: "volume", volume: 33 });
    expect(deck.pages[0].controls[0]).toMatchObject({ action: "volume", icon: { type: "image", src } });
    let stored = "";
    const storage = { getItem: () => stored, setItem: (_: string, value: string) => { stored = value; } };
    expect(saveDeck(storage, deck)).toBe(true);
    expect(loadDeck(storage).deck).toEqual(deck);
    expect(parseSnapshot({ type: "snapshot", protocolVersion: 1, revision: 1, deck })?.deck).toEqual(deck);
    expect(normalizeDeck({ ...createDefaultDeck(), version: 1 })?.version).toBe(2);
    deck = updateControl(deck, pageId, id, { icon: { type: "builtin", name: "star" } });
    expect(isDeck(deck)).toBe(true);
    deck = updateControl(deck, pageId, id, { label: "New label" });
    expect(deck.pages[0].controls[0].icon).toEqual({ type: "builtin", name: "star" });
    deck = updateControl(deck, pageId, id, { icon: null });
    expect(deck.pages[0].controls[0]).not.toHaveProperty("icon");
    for (const invalid of [null, { type: "builtin", name: "nope" }, { type: "image", src: "file:///secret" }]) {
      const bad = structuredClone(deck) as any;
      bad.pages[0].controls[0].icon = invalid;
      expect(isDeck(bad)).toBe(false);
    }
  });

  it("groups by plugin and category, searches ownership and keeps image markup isolated", () => {
    const groups = iconGroups([manifest, { ...manifest, id: "other" }]);
    expect(groups.map(([group]) => group)).toEqual(["Built-in / Media", "Built-in / System", "Built-in / General", "player / Media", "other / Media"]);
    expect(iconGroups([manifest], "player").map(([group]) => group)).toEqual(["player / Media"]);
    expect(iconGroups([manifest], "album")[0][1][0].icon).toEqual({ type: "image", src });
    expect(iconGroups([manifest], "missing")).toEqual([]);
    const control = { ...createDefaultDeck().pages[0].controls[0], icon: { type: "image" as const, src } };
    for (const variant of ["editor", "phone"] as const) {
      const html = renderToStaticMarkup(createElement(ControlTile, { control, variant, volume: 50 }));
      expect(html).toContain(`src="${src}"`);
      expect(html).toContain('alt=""');
      expect(html).not.toContain("<path");
    }
    const html = renderToStaticMarkup(createElement(IconPicker, { control, manifests: [manifest], onPatch: () => {} }));
    expect(html).toContain("player / Media: Album art");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Use action default");
  });
});
