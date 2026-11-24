import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { createControl, controlSummary, ACTION_CATALOG } from "../src/lib/actions";
import { addControl, createDefaultDeck, isDeck, normalizeDeck, updateControl } from "../src/lib/deck";
import { canEnablePlugin, canRunPlugin, EMPTY_PLUGIN, EMPTY_SELECTION, isPluginArgs, parsePluginCatalog, parsePluginManifest, parsePluginSnapshot, pluginArgumentsValid,
  pluginDefaults, pluginLaunchAllowed, pluginSelectionReducer, spotifyState, toPluginError } from "../src/lib/plugin";
import type { PluginCatalog, PluginManifest, PluginSnapshot } from "../src/lib/plugin";
import { loadDeck, saveDeck, STORAGE_KEY } from "../src/lib/persistence";
import { ControlTile } from "../src/components/ControlTile";
import { ActionLibrary } from "../src/components/ActionLibrary";

const manifest: PluginManifest = { id: "spotify", version: "0.1.0", protocolVersion: 1, actions: [
  { id: "play", title: "Play", config: {} },
  { id: "set-volume", title: "<b>Volume</b>", config: { volume: { type: "integer", minimum: 0, maximum: 100 } } },
] };
const snapshot: PluginSnapshot = { status: "connected", manifest, state: null, lastError: null };
const options = { pluginId: "spotify", pluginAction: "set-volume", pluginArgs: { volume: 50 } };

describe("plugin boundary validation", () => {
  it("strictly validates manifest fields, schemas, IDs, versions, duplicates and byte bounds", () => {
    expect(parsePluginManifest(manifest)).toEqual(manifest);
    for (const bad of [null, {}, { ...manifest, executable: "/bin/sh" }, { ...manifest, id: "../spotify" },
      { ...manifest, protocolVersion: 2 }, { ...manifest, version: "latest" }, { ...manifest, actions: [] },
      { ...manifest, actions: Array(33).fill(manifest.actions[0]) },
      { ...manifest, actions: [manifest.actions[0], manifest.actions[0]] },
      ...["", "x".repeat(81), "tab\t"].map((title) => ({ ...manifest, actions: [{ ...manifest.actions[0], title }] })),
      { ...manifest, actions: [{ ...manifest.actions[0], config: { n: { type: "string" } } }] },
      { ...manifest, actions: [{ ...manifest.actions[0], config: { n: { type: "integer", minimum: 1, maximum: 0 } } }] },
      { ...manifest, actions: [{ ...manifest.actions[0], config: { n: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER + 1 } } }] },
    ]) expect(parsePluginManifest(bad)).toBeNull();
    const config = Object.fromEntries(Array.from({ length: 8 }, (_, i) => ["n" + i + "x".repeat(50), { type: "integer", minimum: 0, maximum: 1 }]));
    expect(parsePluginManifest({ ...manifest, actions: Array.from({ length: 32 }, (_, i) => ({ id: "a" + i, title: "Action", config })) })).toBeNull();
  });

  it("requires safe bounded snapshots and shows only validated Spotify fields", () => {
    expect(parsePluginSnapshot(snapshot)).toEqual(snapshot);
    expect(parsePluginSnapshot(EMPTY_PLUGIN)).toEqual(EMPTY_PLUGIN);
    for (const bad of [null, { ...snapshot, status: "launching" }, { ...snapshot, status: ["connected"] },
      { ...snapshot, manifest: null }, { ...snapshot, state: [] }, { ...snapshot, lastError: {} },
      { ...snapshot, state: { huge: "x".repeat(131072) } }, { ...snapshot, launch: "/bin/sh" }]) {
      expect(parsePluginSnapshot(bad)).toBeNull();
    }
    const state = { title: "<script>unsafe</script>", artist: "Artist", playback: "playing", volume: 50, secret: "not rendered" };
    expect(spotifyState({ ...snapshot, state })).toEqual({ title: state.title, artist: "Artist", playback: "playing", volume: 50 });
    for (const bad of [{ ...state, volume: 1.5 }, { ...state, volume: 101 }, { ...state, title: "x".repeat(2049) },
      { ...state, playback: ["playing"] }, { ...state, artist: {} }]) expect(spotifyState({ ...snapshot, state: bad })).toBeNull();
    expect(spotifyState({ ...snapshot, manifest: { ...manifest, id: "other" }, state })).toBeNull();
  });

  it("never echoes raw exceptions, even plausible error-shaped objects", () => {
    for (const bad of [null, "secret", new Error("secret"), { kind: "bad", outcome: "not_started", message: "secret" },
      { kind: "plugin_failed", code: "secret", outcome: "unknown", message: "secret", hint: "secret" }]) {
      expect(JSON.stringify(toPluginError(bad))).not.toContain("secret");
      expect(toPluginError(bad).outcome).toBe("unknown");
    }
    for (const code of ["missing_dependency", "runtime_missing", "runtime_incompatible", "startup_exit"]) {
      const error = toPluginError({ kind: "unavailable", code, outcome: "not_started", message: "secret", hint: "secret" });
      expect(error.code).toBe(code);
      expect(error.hint).toMatch(/packaged|Node/);
      expect(JSON.stringify(error)).not.toContain("secret");
    }
    expect(toPluginError({ kind: "plugin_failed", code: "automation_denied", outcome: "not_started" })).toMatchObject({
      outcome: "not_started", hint: expect.stringContaining("Automation"),
    });
  });

  it("trust gate starts unchecked and requires exact absolute paths; no command-like input", () => {
    expect(pluginLaunchAllowed("/usr/local/bin/node", "/plugins/spotify/main.js", false)).toBe(false);
    expect(pluginLaunchAllowed("/usr/local/bin/node", "/plugins/spotify/main.js", true)).toBe(true);
    for (const [program, entrypoint] of [["node", "/main.js"], ["/node", "main.js"], ["/node\n--eval", "/main.js"], ["", ""]]) {
      expect(pluginLaunchAllowed(program, entrypoint, true)).toBe(false);
    }
  });
});

describe("local plugin catalog and per-selection trust", () => {
  const ready = { id: "spotify", name: "spotify", version: "0.1.0", protocolVersion: 1, status: "ready" as const, message: null };
  const catalog: PluginCatalog = { directory: "/home/test/.config/zdeck/plugins", node: { status: "detected", version: "22.18.0", path: "/usr/local/bin/node" }, plugins: [ready], truncated: false };
  it("validates coherent bounded runtimes and catalog entries, including invalid folder placeholders", () => {
    expect(parsePluginCatalog(catalog)).toEqual(catalog);
    expect(parsePluginCatalog({ ...catalog, node: { status: "detected", version: "23.0.0", path: "/node" } })).not.toBeNull();
    expect(parsePluginCatalog({ ...catalog, node: { status: "unsupported", version: "22.17.9", path: "/node" } })).not.toBeNull();
    expect(parsePluginCatalog({ ...catalog, node: { status: "not_found", version: null, path: null }, plugins: [] })).not.toBeNull();
    const invalid = { id: "", name: "Invalid plugin folder", version: "", protocolVersion: 0, status: "invalid", message: "private-path/raw diagnostic" };
    const parsed = parsePluginCatalog({ ...catalog, plugins: [invalid, invalid, { ...ready, id: "future", protocolVersion: 2, status: "incompatible", message: "future protocol" }] });
    expect(parsed?.plugins).toHaveLength(3);
    expect(JSON.stringify(parsed)).not.toContain("private-path");
    expect(parsed?.plugins[2].message).toBe("Protocol version 1 is required.");
    const incomplete = parsePluginCatalog({ ...catalog, plugins: [{ ...ready, status: "invalid", message: "Required bundled @zdeck/plugin-sdk files are missing. Copy the complete packaged plugin folder, including node_modules; do not copy the source folder alone." }] });
    expect(incomplete?.plugins[0].message).toContain("including node_modules");
    expect(incomplete?.plugins[0].message).toContain("not the source folder");
  });

  it("fails closed on malformed catalogs, paths, counts, metadata, enums and duplicate IDs", () => {
    for (const bad of [null, {}, { ...catalog, extra: true }, { ...catalog, truncated: "false" },
      ...["relative", "/bad\npath", "/" + "x".repeat(4096)].map((directory) => ({ ...catalog, directory })),
      { ...catalog, plugins: Array(65).fill(ready) }, { ...catalog, plugins: [ready, ready] },
      ...[{ status: "found", version: "22.18.0", path: "/node" }, { status: "not_found", version: "22.18.0", path: null },
        { status: "detected", version: "22.17.0", path: "/node" }, { status: "unsupported", version: "23.0.0", path: "/node" },
        { status: "detected", version: "22.18.0", path: "node" }].map((node) => ({ ...catalog, node })),
      ...[{ id: "../spotify" }, { id: "" }, { version: "" }, { protocolVersion: 2 }, { status: "available" },
        { message: "unexpected" }, { name: "x".repeat(81) }, { status: "invalid", message: "x".repeat(301) },
        { status: "incompatible", message: "no", protocolVersion: 1 }, { launch: "/node" }]
        .map((patch) => ({ ...catalog, plugins: [{ ...ready, ...patch }] })),
    ]) expect(parsePluginCatalog(bad)).toBeNull();
  });

  it("requires selected ready plugin, supported runtime and fresh trust; resets for refresh/selection/disconnect/error", () => {
    expect(canEnablePlugin(catalog, EMPTY_SELECTION)).toBe(false);
    const selected = pluginSelectionReducer(EMPTY_SELECTION, { type: "select", pluginId: "spotify" });
    const trusted = pluginSelectionReducer(selected, { type: "trust", checked: true });
    expect(canEnablePlugin(catalog, trusted)).toBe(true);
    for (const event of [{ type: "refresh" as const }, { type: "reset" as const }, { type: "select" as const, pluginId: "spotify" },
      { type: "select" as const, pluginId: "other" }]) expect(pluginSelectionReducer(trusted, event).trusted).toBe(false);
    expect(pluginSelectionReducer(EMPTY_SELECTION, { type: "trust", checked: true }).trusted).toBe(false);
    for (const next of [null, { ...catalog, truncated: true }, { ...catalog, plugins: [] },
      { ...catalog, node: { status: "not_found" as const, path: null, version: null } },
      { ...catalog, node: { status: "unsupported" as const, path: "/node", version: "20.0.0" } }]) expect(canEnablePlugin(next, trusted)).toBe(false);
  });
});

describe("generic saved plugin controls", () => {
  it("creates, patches and summarizes without extending the built-in catalog", () => {
    expect(ACTION_CATALOG).toHaveLength(4);
    const added = addControl(createDefaultDeck(), "page_stream", "plugin", options)!;
    expect(isDeck(added.deck)).toBe(true);
    expect(controlSummary(added.control)).toBe("spotify · set-volume · volume: 50");
    const changed = updateControl(added.deck, "page_stream", added.control.id, { pluginArgs: { volume: 75 }, label: "Spotify volume" });
    expect(changed.pages[0].controls.at(-1)).toMatchObject({ ...options, pluginArgs: { volume: 75 }, label: "Spotify volume" });
    const builtin = updateControl(changed, "page_stream", added.control.id, { action: "mic-mute" }).pages[0].controls.at(-1)!;
    expect(builtin).toEqual({ id: added.control.id, label: "Mic mute", action: "mic-mute" });
    expect(() => createControl("plugin")).toThrow();
    for (const args of [null, [], { n: 1.5 }, { n: "50" }, { n: Number.MAX_SAFE_INTEGER + 1 },
      { "bad-key!": 1 }, Object.fromEntries(Array.from({ length: 9 }, (_, i) => ["n" + i, i]))]) expect(isPluginArgs(args)).toBe(false);
    const bad = structuredClone(added.deck);
    Object.assign(bad.pages[0].controls.at(-1)!, { pluginArgs: { volume: "50" } });
    expect(isDeck(bad)).toBe(false);
    expect(updateControl(added.deck, "page_stream", added.control.id, { pluginId: "../bad" }).pages[0].controls.at(-1)).toEqual(added.control);
  });

  it("defaults every required integer and disables mismatched/disconnected/invalid runs", () => {
    const action = manifest.actions[1];
    expect(pluginDefaults(action)).toEqual({ volume: 50 });
    expect(pluginDefaults({ ...action, config: { volume: { type: "integer", minimum: 60, maximum: 90 },
      n: { type: "integer", minimum: -10, maximum: -1 } } })).toEqual({ volume: 60, n: -1 });
    const control = createControl("plugin", options);
    if (control.action !== "plugin") throw new Error("expected plugin");
    expect(canRunPlugin(snapshot, control)).toBe(true);
    for (const next of [EMPTY_PLUGIN, { ...snapshot, status: "stopped" as const }, { ...snapshot, manifest: { ...manifest, id: "other" } },
      { ...snapshot, lastError: toPluginError(null) }]) expect(canRunPlugin(next, control)).toBe(false);
    for (const args of [{} as Record<string, number>, { volume: 101 }, { volume: 0, extra: 1 }]) expect(pluginArgumentsValid(action, args)).toBe(false);
    expect(canRunPlugin(snapshot, { ...control, pluginAction: "missing" })).toBe(false);
  });

  it("uses an ordinary phone button and escapes manifest-authored labels", () => {
    const control = createControl("plugin", { ...options, label: "<img src=x onerror=alert(1)>" });
    const tile = renderToStaticMarkup(createElement(ControlTile, { control, variant: "phone", semantics: "remote", volume: 0 }));
    expect(tile).not.toContain('type="range"');
    expect(tile).toContain("&lt;img");
    const library = renderToStaticMarkup(createElement(ActionLibrary, { pageName: "Stream", dialogRef: { current: null }, manifest, onAdd: () => {} }));
    expect(library).toContain("&lt;b&gt;Volume&lt;/b&gt;");
    expect(library).not.toContain("<b>Volume</b>");
  });
});

describe("legacy local deck migration", () => {
  it("upgrades in memory only and writes v2 on the normal explicit save", () => {
    const legacy = { ...createDefaultDeck(), version: 1 };
    let stored = JSON.stringify(legacy), writes = 0;
    const storage = { getItem: () => stored, setItem: (_: string, value: string) => { stored = value; writes++; } };
    const loaded = loadDeck(storage);
    expect(loaded.status).toBe("loaded");
    expect(loaded.deck.version).toBe(2);
    expect(isDeck(legacy)).toBe(false);
    expect(JSON.parse(stored).version).toBe(1);
    expect(writes).toBe(0);
    expect(saveDeck(storage, loaded.deck)).toBe(true);
    expect(JSON.parse(stored).version).toBe(2);
    expect(writes).toBe(1);
  });

  it("refuses v1 plugin variants, unknown fields, corrupt data and newer versions without clobbering", () => {
    const legacy = { ...createDefaultDeck(), version: 1 };
    const control = createControl("plugin", options);
    const badDecks = [{ ...legacy, version: 3 }, { ...legacy, unknown: true },
      { ...legacy, pages: [{ ...legacy.pages[0], unknown: true }] },
      { ...legacy, pages: [{ ...legacy.pages[0], controls: [control] }] },
      { ...legacy, pages: [{ ...legacy.pages[0], controls: [{ id: "mic", label: "Mic", action: "mic-mute", unknown: true }] }] },
      { ...legacy, pages: [{ ...legacy.pages[0], controls: [{ id: "media", label: "Media", action: "media-play-pause", pluginArgs: {} }] }] },
    ];
    for (const deck of badDecks) expect(normalizeDeck(deck)).toBeNull();
    for (const raw of ["{broken", ...badDecks.map((deck) => JSON.stringify(deck))]) {
      const storage = { getItem: (key: string) => key === STORAGE_KEY ? raw : null, setItem: () => { throw new Error("must not write"); } };
      expect(loadDeck(storage).status).toBe("invalid");
      expect(storage.getItem(STORAGE_KEY)).toBe(raw);
    }
  });
});
