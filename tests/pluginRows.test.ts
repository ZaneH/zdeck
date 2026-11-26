import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PluginSettingsCard } from "../src/components/PluginSettingsCard";
import type { PluginConsole } from "../src/lib/usePluginConsole";
import type { PluginCatalogEntry, PluginSnapshots } from "../src/lib/plugin";
import { toPluginError } from "../src/lib/plugin";

function entry(id: string, patch: Partial<PluginCatalogEntry> = {}): PluginCatalogEntry {
  return { id, name: id, version: "1.0.0", protocolVersion: 1, status: "ready", message: null, icon: null, trusted: false, identity: "0123456789abcdef".repeat(4), ...patch };
}
function fixture(snapshots: PluginSnapshots = {}, plugins: PluginCatalogEntry[] = ["spotify", "other"].map((id) => entry(id))): PluginConsole {
  return { native: true, snapshots, catalog: { directory: "/example/plugins",
    node: { status: "detected", path: "/example/node", version: "22.18.0" }, plugins },
    refreshSnapshots: vi.fn(async () => {}),
    loading: false, sessionsReady: true, catalogBusy: false, catalogError: null, catalogEpoch: 0,
    trustEpoch: {}, busy: {}, errors: {}, diagnostics: {}, completedIds: {},
    enable: vi.fn(async () => {}), trust: vi.fn(async () => true), disconnect: vi.fn(async () => {}), readState: vi.fn(async () => {}),
    execute: vi.fn(async () => {}), diagnose: vi.fn(async () => {}), uninstall: vi.fn(async () => {}),
    refreshCatalog: vi.fn(async () => {}), openDirectory: vi.fn(async () => {}),
  };
}
function connected(id: string) { return { status: "connected" as const, manifest: { id, version: "1.0.0", protocolVersion: 1 as const,
  actions: [{ id: "next", title: "Next", config: {} }] }, state: null, lastError: null }; }
describe("independent plugin rows", () => {
  it("shows row actions with no global selector or pre-acknowledged trust, and never enables during render", () => {
    const plugin = fixture({ spotify: connected("spotify"), other: connected("other") });
    const html = renderToStaticMarkup(createElement(PluginSettingsCard, { plugin }));
    expect(html.match(/>Disable<\/button>/g)).toHaveLength(2);
    expect(html).not.toContain("Disable on next launch");
    expect(html).not.toContain("<select"); expect(html).not.toContain('type="checkbox"');
    expect(html).toContain("More options for spotify"); expect(html).toContain("Uninstall…");
    expect(plugin.enable).not.toHaveBeenCalled(); expect(plugin.trust).not.toHaveBeenCalled();
    expect(plugin.diagnose).not.toHaveBeenCalled(); expect(plugin.uninstall).not.toHaveBeenCalled();
  });
  it("offers an accessible trust confirmation dialog instead of an inline checkbox", () => {
    const plugin = fixture();
    const html = renderToStaticMarkup(createElement(PluginSettingsCard, { plugin }));
    expect(html).toContain("<dialog"); expect(html).toContain("Enable spotify?");
    expect(html).toContain("Trust and enable"); expect(html).toContain("Cancel");
    expect(html).toContain("process separation is not a sandbox");
    expect(html).toContain("Changing its files revokes trust");
    expect(html.match(/>Disable on next launch<\/button>/g)).toHaveLength(2);
    expect(plugin.disconnect).not.toHaveBeenCalled();
  });
  it("renders a plugin thumbnail with an embedded image or a generic fallback", () => {
    const plugin = fixture({}, [entry("spotify", { icon: "data:image/svg+xml;base64,PHN2Zy8+" }), entry("other")]);
    const html = renderToStaticMarkup(createElement(PluginSettingsCard, { plugin }));
    expect(html).toContain("plugin-thumbnail");
    expect(html).toContain("data:image/svg+xml;base64,PHN2Zy8+");
    expect((html.match(/class="plugin-thumbnail"/g) ?? []).length).toBe(2);
    expect((html.match(/<svg/g) ?? []).length).toBeGreaterThan(0);
  });
  it("keeps errors scoped to their own row", () => {
    const plugin = fixture({ spotify: { ...connected("spotify"), status: "stopped", lastError: toPluginError({ kind: "timeout", outcome: "unknown" }) }, other: connected("other") });
    const html = renderToStaticMarkup(createElement(PluginSettingsCard, { plugin }));
    expect(html).toContain("Outcome unknown");
    const other = html.slice(html.indexOf('data-plugin-id="other"'));
    expect(other).not.toContain("Outcome unknown"); expect(other).toContain("Disable other");
  });
  it("lists every installed plugin beyond sixteen with no arbitrary cap message", () => {
    const plugins = Array.from({ length: 40 }, (_, index) => entry(`p${index}`, { name: `Plugin ${index}` }));
    const html = renderToStaticMarkup(createElement(PluginSettingsCard, { plugin: fixture({}, plugins) }));
    expect((html.match(/data-plugin-id=/g) ?? []).length).toBe(40);
    expect(html).not.toContain("enabled plugin limit"); expect(html).not.toContain("more than 64 entries");
  });
  it("fails closed when cached sessions are unavailable", () => {
    const plugin = fixture(); plugin.sessionsReady = false;
    const html = renderToStaticMarkup(createElement(PluginSettingsCard, { plugin }));
    expect(html).toContain("Reload the app before enabling"); expect(html).toMatch(/disabled=""[^>]*aria-label="Enable spotify"/);
  });
  it("enables Python rows without Node and disables only rows whose runtime is missing", () => {
    const plugin = fixture({}, [entry("python-example", { runtime: "python" }), entry("node-example", { runtime: "node" })]);
    plugin.catalog!.node = { status: "not_found", version: null, path: null };
    plugin.catalog!.python = { status: "detected", version: "3.10.0", path: "/example/python" };
    let html = renderToStaticMarkup(createElement(PluginSettingsCard, { plugin }));
    expect(html).toMatch(/disabled=""[^>]*aria-label="Enable node-example"/);
    expect(html).not.toMatch(/disabled=""[^>]*aria-label="Enable python-example"/);
    expect(html).toContain("Detected Python 3.10.0");
    plugin.catalog!.python = { status: "not_found", version: null, path: null };
    html = renderToStaticMarkup(createElement(PluginSettingsCard, { plugin }));
    expect(html).toMatch(/disabled=""[^>]*aria-label="Enable python-example"/);
    expect(html).toContain("Python 3.10 or newer is required");
    expect(plugin.enable).not.toHaveBeenCalled();
  });
  it("keeps cached sessions manageable when an installed folder disappears", () => {
    const plugin = fixture({ spotify: connected("spotify") }); plugin.catalog!.plugins = [];
    const html = renderToStaticMarkup(createElement(PluginSettingsCard, { plugin }));
    expect(html).toContain("Disable spotify"); expect(html).toContain("Folder is not in the current catalog");
    expect(html).not.toContain("Nothing installed yet");
  });
  it("does not treat Object prototype properties as plugin state/errors/diagnostics", () => {
    const plugin = fixture({}, [entry("constructor", { name: "Constructor" })]);
    const html = renderToStaticMarkup(createElement(PluginSettingsCard, { plugin }));
    expect(html).toContain("Enable Constructor"); expect(html).not.toContain("Installation diagnostics"); expect(html).not.toContain('role="alert"');
  });
});
