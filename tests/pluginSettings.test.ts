import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createControl } from "../src/lib/actions";
import { addControl, isDeck, normalizeDeck } from "../src/lib/deck";
import {
  canRunPlugin,
  parsePluginCatalog,
  parsePluginManifest,
  parsePluginSettingsView,
  pluginArgumentsValid,
  pluginChoices,
  pluginDefaults,
  validPluginSettingsSchema,
} from "../src/lib/plugin";
import type { PluginAction, PluginField, PluginManifest, PluginSnapshot, PluginSettingsSchema } from "../src/lib/plugin";
import type { PluginControl } from "../src/lib/types";
import { loadDeck, saveDeck, STORAGE_KEY } from "../src/lib/persistence";

const IDENTITY = "0123456789abcdef".repeat(4);
const settings: PluginSettingsSchema = {
  url: { type: "text", label: "Home Assistant URL" },
  token: { type: "secret", label: "Long-lived access token" },
};
const power: PluginAction = {
  id: "power", title: "Power", config: {
    entity: { type: "integer", minimum: 1, maximum: 281474976710655, choicesKey: "entities" },
    enabled: { type: "boolean" },
  },
};
const manifest: PluginManifest = {
  id: "home-assistant", version: "0.1.0", protocolVersion: 1, settings, actions: [power],
};
const entities = [
  { value: 30, label: "Desk light", available: false },
  { value: 7, label: "Kitchen lamp", available: true },
];
const snapshot = (state: Record<string, unknown> | null): PluginSnapshot => ({
  status: "connected", manifest, state, lastError: null,
});
const control = createControl("plugin", {
  pluginId: "home-assistant", pluginAction: "power", pluginArgs: { entity: 7, enabled: true },
}) as PluginControl;

describe("plugin settings schemas and saved views", () => {
  it("accepts a small declared text/secret schema and rejects anything undeclared", () => {
    expect(validPluginSettingsSchema(settings)).toBe(true);
    expect(validPluginSettingsSchema({ token: { type: "secret", label: "Token" } })).toBe(true);
    expect(validPluginSettingsSchema({})).toBe(true);
    const five = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`f${index}`, { type: "text", label: "Label" }]));
    for (const bad of [null, [], { url: { type: "password", label: "URL" } },
      { url: { type: "text", label: "" } }, { url: { type: "text", label: "x".repeat(81) } },
      { url: { type: "text", label: "line\nbreak" } }, { url: { type: "text", label: "URL", extra: true } },
      { "../url": { type: "text", label: "URL" } }, { "1url": { type: "text", label: "URL" } }, five]) {
      expect(validPluginSettingsSchema(bad)).toBe(false);
    }
  });

  it("parses only bounded, disjoint text values and secret-configured flags", () => {
    const view = { values: { url: "https://example.invalid" }, secretConfigured: { token: true } };
    expect(parsePluginSettingsView(view)).toEqual(view);
    expect(parsePluginSettingsView({ values: { url: "" }, secretConfigured: { token: false } })).not.toBeNull();
    expect(parsePluginSettingsView({ values: { url: "x".repeat(2048) }, secretConfigured: {} })).not.toBeNull();
    const five = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`f${index}`, "value"]));
    for (const bad of [null, [], { values: {}, secretConfigured: {}, extra: true }, { values: [], secretConfigured: {} },
      { values: { url: 1 }, secretConfigured: {} }, { values: { "Bad_key": "x" }, secretConfigured: {} },
      { values: { url: "x".repeat(2049) }, secretConfigured: {} }, { values: {}, secretConfigured: { token: "yes" } },
      { values: { token: "example-token" }, secretConfigured: { token: true } },
      { values: five, secretConfigured: {} }]) {
      expect(parsePluginSettingsView(bad)).toBeNull();
    }
  });

  it("carries settings and choicesKey through manifests and catalogs, bounded by the same rules", () => {
    expect(parsePluginManifest(manifest)).toEqual(manifest);
    expect(parsePluginManifest({ ...manifest, settings: undefined })).toBeNull();
    expect(parsePluginManifest({ ...manifest, settings: {} })).toMatchObject({ settings: {} });
    for (const bad of [{ settings: { url: { type: "text", label: "" } } },
      { actions: [{ ...power, config: { entity: { type: "integer", minimum: 1, maximum: 10, choicesKey: "../entities" } } }] },
      { actions: [{ ...power, config: { entity: { type: "integer", minimum: 1, maximum: 10, choicesKey: "entities", control: { step: 1 } } } }] },
      { actions: [{ ...power, config: { enabled: { type: "boolean", choicesKey: "states" } } }] },
    ]) expect(parsePluginManifest({ ...manifest, ...bad })).toBeNull();

    const ready = { id: "home-assistant", name: "Home Assistant", version: "0.1.0", protocolVersion: 1,
      status: "ready", message: null, icon: null, trusted: false, identity: IDENTITY, settings };
    const catalog = { directory: "/example/plugins", node: { status: "not_found", version: null, path: null }, plugins: [ready] };
    expect(parsePluginCatalog(catalog)?.plugins[0].settings).toEqual(settings);
    expect(parsePluginCatalog({ ...catalog, plugins: [{ ...ready, settings: {} }] })).not.toBeNull();
    expect(parsePluginCatalog({ ...catalog, plugins: [{ ...ready, settings: { url: { type: "text", label: "" } } }] })).toBeNull();
  });
});

describe("plugin choices are untrusted display data", () => {
  const field = power.config.entity as PluginField;
  it("keeps declared order, labels and availability without renumbering saved values", () => {
    expect(pluginChoices(snapshot({ entities }), field)).toEqual(entities);
    const empty = snapshot({ entities: [] });
    expect(pluginChoices(empty, field)).toEqual([]);
    expect(pluginDefaults(power)).toEqual({ entity: 1, enabled: false });
  });

  it("fails closed for missing state, wrong fields and out-of-range or duplicated choices", () => {
    expect(pluginChoices(snapshot(null), field)).toBeNull();
    expect(pluginChoices(snapshot({}), field)).toBeNull();
    expect(pluginChoices(snapshot({ entities }), { type: "boolean" })).toBeNull();
    expect(pluginChoices(snapshot({ entities }), { type: "integer", minimum: 1, maximum: 10 })).toBeNull();
    const tooMany = Array.from({ length: 257 }, (_, value) => ({ value, label: `Entity ${value}`, available: true }));
    const badChoices = [null, {}, "entities", [null], [{ value: 1, label: "One" }],
      [{ ...entities[0], extra: true }], [{ value: 0, label: "Low", available: true }],
      [{ value: 2 ** 48, label: "High", available: true }], [{ value: 1.5, label: "Fraction", available: true }],
      [{ value: "1", label: "String", available: true }], [entities[0], { ...entities[0] }],
      [{ value: 1, label: "", available: true }], [{ value: 1, label: "x".repeat(161), available: true }],
      [{ value: 1, label: "line\nbreak", available: true }], [{ value: 1, label: "One", available: "yes" }], tooMany];
    for (const choices of badChoices) expect(pluginChoices(snapshot({ entities: choices }), field)).toBeNull();
    expect(pluginChoices(snapshot({ entities: tooMany.slice(1, 257) }), field)).toHaveLength(256);
    expect(pluginChoices(snapshot({ entities: ["private secret"] }), field)).toBeNull();
  });

  it("only runs a connected action when the saved numeric value is an available choice", () => {
    expect(canRunPlugin(snapshot({ entities }), control)).toBe(true);
    const unavailable = snapshot({ entities: [{ value: 7, label: "Kitchen lamp", available: false }] });
    expect(canRunPlugin(unavailable, control)).toBe(false);
    expect(canRunPlugin(snapshot({ entities: [] }), control)).toBe(false);
    expect(canRunPlugin(snapshot({ entities: [{ value: 8, label: "Other lamp", available: true }] }), control)).toBe(false);
    expect(canRunPlugin(snapshot({ entities: [{ ...entities[0], value: 7 }] }), control)).toBe(false);
    expect(canRunPlugin(snapshot(null), control)).toBe(false);
    expect(canRunPlugin({ ...snapshot({ entities }), status: "stopped" }, control)).toBe(false);
    expect(canRunPlugin(snapshot({ entities }), { ...control, pluginArgs: { entity: 7.5, enabled: true } })).toBe(false);
    expect(pluginArgumentsValid(manifest.actions[0], { entity: 7, enabled: true })).toBe(true);
  });

  it("round-trips large stable entity numbers through the shared deck fixture", () => {
    const raw = readFileSync(new URL("./fixtures/deck.sample.json", import.meta.url), "utf8");
    const fixture = normalizeDeck(JSON.parse(raw));
    expect(fixture).not.toBeNull();
    const added = addControl(fixture!, "page_stream", "plugin", {
      pluginId: "home-assistant", pluginAction: "power",
      pluginArgs: { entity: 281474976710655, enabled: true },
    });
    expect(added).not.toBeNull();
    let stored = raw;
    const storage = {
      getItem: (key: string) => key === STORAGE_KEY ? stored : null,
      setItem: (_key: string, value: string) => { stored = value; },
    };
    expect(saveDeck(storage, added!.deck)).toBe(true);
    const reloaded = loadDeck(storage);
    expect(reloaded.status).toBe("loaded");
    expect(isDeck(reloaded.deck)).toBe(true);
    const saved = reloaded.deck.pages[0].sections[0].controls.at(-1);
    expect(saved).toMatchObject({ action: "plugin", pluginId: "home-assistant",
      pluginAction: "power", pluginArgs: { entity: 281474976710655, enabled: true } });
    expect(stored).toContain("281474976710655");
  });
});
