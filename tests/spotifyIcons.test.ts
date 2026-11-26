import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import manifest from "../plugins/spotify/manifest.json";
import { validateManifest } from "../packages/plugin-sdk/index.js";
import { parsePluginManifest, enabledPluginManifests } from "../src/lib/plugin";
import { createDefaultDeck, updateControl } from "../src/lib/deck";
import { loadDeck, saveDeck } from "../src/lib/persistence";
import { IconPicker, iconGroups } from "../src/components/IconPicker";

describe("Spotify provided icons", () => {
  it("embeds both repository assets within the unchanged SDK and app budgets", () => {
    expect(validateManifest(manifest)).toEqual(manifest);
    expect(parsePluginManifest(manifest)).toEqual(manifest);
    expect(manifest.icons.map(({ id, title, category }) => ({ id, title, category }))).toEqual([
      { id: "spotify-monochrome", title: "Spotify (monochrome)", category: "Media" },
      { id: "spotify-original", title: "Spotify (original)", category: "Media" },
    ]);
    for (const [index, file, mime] of [[0, "spotify-monochrome.svg", "svg+xml"], [1, "spotify-original.webp", "webp"]] as const) {
      const bytes = readFileSync(new URL(`../plugins/spotify/assets/${file}`, import.meta.url));
      expect(manifest.icons[index].src).toBe(`data:image/${mime};base64,${bytes.toString("base64")}`);
    }
    const svg = Buffer.from(manifest.icons[0].src.split(",")[1], "base64").toString();
    expect(svg).toContain('fill="#80868e"');
    expect(svg).not.toMatch(/<script|<foreignObject|href=|url\(/i);
  });

  it("offers both through enabled-plugin discovery and preserves selected images in saved decks", () => {
    const parsed = parsePluginManifest(manifest)!;
    const enabled = enabledPluginManifests({ spotify: { status: "connected", manifest: parsed, state: null, lastError: null } });
    const groups = iconGroups(enabled, "spotify");
    expect(groups.map(([group]) => group)).toEqual(["spotify / Media"]);
    expect(groups[0][1].map(({ icon }) => icon)).toEqual(manifest.icons.map(({ src }) => ({ type: "image", src })));
    for (const provided of manifest.icons) {
      const initial = createDefaultDeck(), control = initial.pages[0].controls[0];
      const deck = updateControl(initial, initial.activePageId, control.id, { icon: { type: "image", src: provided.src } });
      let stored = "";
      const storage = { getItem: () => stored, setItem: (_: string, value: string) => { stored = value; } };
      expect(saveDeck(storage, deck)).toBe(true);
      expect(loadDeck(storage).deck).toEqual(deck);
      const html = renderToStaticMarkup(createElement(IconPicker, { control: deck.pages[0].controls[0], manifests: enabled, onPatch: () => {} }));
      expect(html).toContain(`spotify / Media: ${provided.title}`);
      expect(html).toContain('aria-pressed="true"');
      expect(html).toContain(`src="${provided.src}"`);
      const pluginGroup = html.split("<legend>spotify / Media</legend>")[1].split("</fieldset>")[0];
      expect(pluginGroup).not.toContain("<svg");
      expect(pluginGroup).not.toContain("<path");
    }
  });
});
