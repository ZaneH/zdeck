import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import manifest from "../plugins/spotify/manifest.json";
import { Inspector } from "../src/components/Inspector";
import { createControl } from "../src/lib/actions";
import { createDefaultDeck, isDeck, updateControl } from "../src/lib/deck";
import { parsePluginManifest, pluginDefaults } from "../src/lib/plugin";
import { compatiblePresentations, presentationCompatible } from "../src/lib/presentations";
import { DesktopActions } from "../src/lib/useDesktopActions";
import type { PluginSnapshots } from "../src/lib/plugin";

const parsed = parsePluginManifest(manifest)!;
const action = parsed.actions.find(action => action.id === "set-volume")!;
const plugins: PluginSnapshots = { spotify: { status: "connected", manifest: parsed, state: null, lastError: null } };

function savedVolume() {
  const control = createControl("plugin", { pluginId: parsed.id, pluginAction: action.id, pluginArgs: pluginDefaults(action) });
  const deck = createDefaultDeck();
  deck.pages[0].sections[0].controls.push(control);
  return { deck, control };
}

describe("actual Spotify set-volume presentation", () => {
  it("offers a reachable Presentation chooser for an existing button without needing observed state", () => {
    const { control } = savedVolume();
    expect(control.presentation).toBeUndefined();
    expect(compatiblePresentations(control, plugins)).toEqual(["button", "slider", "dial"]);
    const html = renderToStaticMarkup(createElement(Inspector, {
      control, pageName: "Main", previewVolume: 50,
      obs: { native: false }, system: { native: false },
      plugin: { native: true, snapshots: plugins, busy: {}, errors: {}, completedIds: {} },
      onPatch: vi.fn(), onRemove: vi.fn(), onPreviewPress: vi.fn(), onPreviewVolume: vi.fn(),
    } as unknown as ComponentProps<typeof Inspector>));
    expect(html).toContain('class="icon-picker action-picker presentation-picker"');
    expect(html).toMatch(/<summary><span>Presentation<\/span><span class="icon-picker-status">Button<\/span>/);
    expect(html).toMatch(/aria-label="Choose presentation"><button type="button" aria-pressed="true">Button<\/button><button type="button" aria-pressed="false">Slider<\/button>/);
  });

  it("round-trips the chosen slider without changing saved args and dispatches only the scalar target", async () => {
    const { deck, control } = savedVolume();
    const saved = JSON.parse(JSON.stringify(updateControl(deck, deck.pages[0].id, control.id, { presentation: "slider" })));
    expect(isDeck(saved)).toBe(true);
    expect(saved.pages[0].sections[0].controls.at(-1)).toMatchObject({ presentation: "slider", pluginArgs: { volume: 50 } });
    const dispatch = vi.fn(async (command) => ({ id: command.commandId, state: "confirmed" as const, message: "Confirmed." }));
    const actions = new DesktopActions(() => ({ native: true, editor: true, deck: saved, savedRevision: 8, plugins }), dispatch, () => "spotify-target");
    actions.enter();
    await actions.press(control.id, 73);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ commandId: "spotify-target", revision: 8, controlId: control.id, value: 73 });
    expect(saved.pages[0].sections[0].controls.at(-1).pluginArgs).toEqual({ volume: 50 });
  });

  it("does not infer slider support for an older installed manifest or erase a saved choice", () => {
    const { deck, control } = savedVolume();
    const older = structuredClone(parsed);
    delete older.actions.find(action => action.id === "set-volume")!.config.volume.control;
    const oldPlugins = { spotify: { ...plugins.spotify, manifest: older } };
    expect(compatiblePresentations(control, oldPlugins)).toEqual(["button"]);
    const saved = updateControl(deck, deck.pages[0].id, control.id, { presentation: "slider" }).pages[0].sections[0].controls.at(-1)!;
    expect(presentationCompatible(saved, oldPlugins)).toBe(false);
    expect(saved.presentation).toBe("slider");
    expect(presentationCompatible(saved, plugins)).toBe(true);
  });
});
