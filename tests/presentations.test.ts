import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ControlTile } from "../src/components/ControlTile";
import { compatiblePresentations, controlContract, effectivePresentation, presentationCompatible, validControlValue } from "../src/lib/presentations";
import { parsePluginManifest, pluginArgumentsValid } from "../src/lib/plugin";
import type { PluginSnapshots } from "../src/lib/plugin";
import type { Control, PluginArgs, PluginControl } from "../src/lib/types";
import { createDefaultDeck, isDeck, updateControl } from "../src/lib/deck";

export const plugins: PluginSnapshots = { mixer: {
  status: "connected", lastError: null, state: { powered: true },
  manifest: { id: "mixer", version: "1.0.0", protocolVersion: 1, actions: [
    { id: "level", title: "Level", config: { amount: { type: "integer", minimum: -20, maximum: 200, control: { step: 5 } }, zone: { type: "integer", minimum: 1, maximum: 4 } } },
    { id: "power", title: "Power", config: { enabled: { type: "boolean", control: { stateKey: "powered" } } } },
    { id: "legacy", title: "Legacy", config: { volume: { type: "integer", minimum: 0, maximum: 100 } } },
  ] },
} };
export const level: PluginControl = { id: "level", label: "Level", action: "plugin", pluginId: "mixer", pluginAction: "level", pluginArgs: { amount: 50, zone: 2 }, presentation: "slider" };
export const power: PluginControl = { ...level, id: "power", label: "Power", pluginAction: "power", pluginArgs: { enabled: false }, presentation: "toggle-switch" };

const render = (control: Control, snapshots = plugins, extra = {}) => renderToStaticMarkup(createElement(ControlTile, {
  control, plugins: snapshots, variant: "phone", semantics: "remote", volume: 42, ...extra,
}));

describe("presentation contracts", () => {
  it("keeps legacy plugin buttons and built-in volume, without inferring contracts from names", () => {
    expect(effectivePresentation({ ...level, presentation: undefined }, plugins)).toBe("button");
    const volume: Control = { id: "v", label: "Speakers", action: "volume", volume: 50 };
    expect(effectivePresentation(volume)).toBe("slider");
    expect(validControlValue(volume, 42.5)).toBe(true);
    expect(compatiblePresentations(volume)).toEqual(["button", "slider", "dial"]);
    expect(render(volume)).toContain('value="42"');
    expect(compatiblePresentations({ ...level, pluginAction: "legacy", pluginArgs: { volume: 50 } }, plugins)).toEqual(["button"]);
  });
  it("uses generic numeric metadata and rejects out-of-bounds, fractional, unsafe and misaligned targets", () => {
    expect(controlContract(level, plugins)).toEqual({ kind: "numeric", minimum: -20, maximum: 200, step: 5, value: 50 });
    for (const value of [-20, 75, 200]) expect(validControlValue(level, value, plugins)).toBe(true);
    for (const value of [-25, 201, 2, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) expect(validControlValue(level, value, plugins)).toBe(false);
    expect(validControlValue({ ...level, presentation: "button" }, 75, plugins)).toBe(false);
    expect(validControlValue({ ...level, pluginArgs: { amount: 50, zone: 9 } }, 75, plugins)).toBe(false);
  });
  it("uses only declared observed booleans, never saved args or truthiness, as toggle state", () => {
    expect(controlContract(power, plugins)).toEqual({ kind: "boolean", value: true });
    for (const value of [0, 1]) expect(validControlValue(power, value, plugins)).toBe(true);
    for (const value of [-1, 0.5, 2]) expect(validControlValue(power, value, plugins)).toBe(false);
    for (const status of ["disconnected", "stopped"] as const) {
      expect(controlContract(power, { mixer: { ...plugins.mixer, status } })).toEqual({ kind: "boolean", value: null });
    }
    for (const state of [null, {}, { powered: 1 }, { enabled: true }]) {
      const snapshots = { mixer: { ...plugins.mixer, state } };
      expect(controlContract(power, snapshots)).toEqual({ kind: "boolean", value: null });
      expect(validControlValue(power, 1, snapshots)).toBe(false);
      const html = render(power, snapshots);
      expect(html).toContain("state unknown"); expect(html).toContain('disabled=""');
      expect(html).not.toContain('aria-checked="false"'); expect(html).not.toContain('role="switch"');
    }
  });
  it("fails closed for incompatible or missing metadata and preserves document compatibility", () => {
    expect(presentationCompatible({ ...power, presentation: "slider" }, plugins)).toBe(false);
    expect(presentationCompatible(level, {})).toBe(false);
    expect(render(level, {})).toMatch(/<button[^>]*disabled=""/);
    let deck = createDefaultDeck();
    deck.pages[0].sections[0].controls.push(power);
    expect(isDeck(JSON.parse(JSON.stringify(deck)))).toBe(true);
    deck = updateControl(deck, deck.pages[0].id, power.id, { action: "media-play-pause" });
    expect(deck.pages[0].sections[0].controls.at(-1)?.presentation).toBeUndefined();
    deck.pages[0].sections[0].controls[0].presentation = "dial";
    expect(isDeck(deck)).toBe(false);
  });
  it("renders all five presentations with separate, named interactive elements", () => {
    expect(render({ ...level, presentation: "button" })).not.toContain('type="range"');
    const slider = render(level);
    expect(slider).toContain('type="range"'); expect(slider).toContain('min="-20" max="200" step="5"');
    expect(slider).not.toMatch(/<button[^>]*>[\s\S]*<input/);
    const dial = render({ ...level, presentation: "dial" });
    expect(dial).toContain('role="slider"'); expect(dial).toContain('aria-valuenow="50"'); expect(dial).toContain('aria-label="Level"');
    expect(render(power)).toContain('role="switch" aria-checked="true"');
    expect(render({ ...power, presentation: "toggle-button" })).toContain('aria-pressed="true"');
    expect(render(power, plugins, { busy: true })).toContain('aria-disabled="true"');
    expect(render({ ...level, presentation: "dial" }, plugins, { disabled: true })).toContain('aria-disabled="true"');
  });
  it("validates manifest metadata and complete saved args strictly", () => {
    const manifest = plugins.mixer.manifest!;
    expect(parsePluginManifest(manifest)).toEqual(manifest);
    const action = manifest.actions[0];
    expect(pluginArgumentsValid(action, { amount: 75, zone: 2 })).toBe(true);
    for (const args of [{ amount: 76, zone: 2 }, { amount: 75 }, { amount: true, zone: 2 }, { amount: 75, zone: 2, extra: 1 }]) expect(pluginArgumentsValid(action, args as PluginArgs)).toBe(false);
    for (const field of [
      { type: "integer", minimum: 0, maximum: 10, control: { step: 0 } },
      { type: "integer", minimum: 0, maximum: 10, control: { step: 3 } },
      { type: "integer", minimum: 1, maximum: 1, control: { step: 1 } },
      { type: "integer", minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER, control: { step: 1 } },
      { type: "boolean", control: null }, { type: "boolean", control: { stateKey: "../secret" } },
      { type: "boolean", minimum: 0 },
    ]) expect(parsePluginManifest({ ...manifest, actions: [{ ...action, config: { value: field } }] })).toBeNull();
    expect(parsePluginManifest({ ...manifest, actions: [{ ...action, config: { a: action.config.amount, b: action.config.amount } }] })).toBeNull();
  });
});
