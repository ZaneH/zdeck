import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PluginSettingsCard } from "../src/components/PluginSettingsCard";
import type { PluginConsole } from "../src/lib/usePluginConsole";
import type { PluginSnapshots } from "../src/lib/plugin";
import { toPluginError } from "../src/lib/plugin";

function fixture(snapshots: PluginSnapshots = {}): PluginConsole {
  return { native: true, snapshots, catalog: { directory: "/example/plugins", truncated: false,
    node: { status: "detected", path: "/example/node", version: "22.18.0" },
    plugins: ["spotify", "other"].map((id) => ({ id, name: id, version: "1.0.0", protocolVersion: 1, status: "ready", message: null })) },
    loading: false, sessionsReady: true, catalogBusy: false, catalogError: null, catalogEpoch: 0,
    trustEpoch: {}, busy: {}, errors: {}, diagnostics: {}, completedIds: {},
    enable: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), readState: vi.fn(async () => {}), execute: vi.fn(async () => {}),
    diagnose: vi.fn(async () => {}), uninstall: vi.fn(async () => {}), refreshCatalog: vi.fn(async () => {}), openDirectory: vi.fn(async () => {}),
  };
}
function connected(id: string) { return { status: "connected" as const, manifest: { id, version: "1.0.0", protocolVersion: 1 as const,
  actions: [{ id: "next", title: "Next", config: {} }] }, state: null, lastError: null }; }
describe("independent plugin rows", () => {
  it("shows row actions with no global selector or pre-acknowledged trust, and never enables during render", () => {
    const plugin = fixture({ spotify: connected("spotify"), other: connected("other") });
    const html = renderToStaticMarkup(createElement(PluginSettingsCard, { plugin }));
    expect(html.match(/>Disable<\/button>/g)).toHaveLength(2);
    expect(html).not.toContain("<select"); expect(html).not.toContain('type="checkbox"');
    expect(html).toContain("More options for spotify"); expect(html).toContain("Uninstall…");
    expect(plugin.enable).not.toHaveBeenCalled(); expect(plugin.diagnose).not.toHaveBeenCalled(); expect(plugin.uninstall).not.toHaveBeenCalled();
  });
  it("keeps errors scoped to their own row", () => {
    const plugin = fixture({ spotify: { ...connected("spotify"), status: "stopped", lastError: toPluginError({ kind: "timeout", outcome: "unknown" }) }, other: connected("other") });
    const html = renderToStaticMarkup(createElement(PluginSettingsCard, { plugin }));
    expect(html).toContain("Outcome unknown");
    const other = html.slice(html.indexOf('data-plugin-id="other"'));
    expect(other).not.toContain("Outcome unknown"); expect(other).toContain("Disable other");
  });
  it("explains the 16-process cap and fails closed when cached sessions are unavailable", () => {
    const plugin = fixture(Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`p${i}`, connected(`p${i}`)])));
    let html = renderToStaticMarkup(createElement(PluginSettingsCard, { plugin }));
    expect(html).toContain("16 enabled plugin limit"); expect(html).toMatch(/disabled=""[^>]*aria-label="Enable spotify"/);
    plugin.snapshots = {}; plugin.sessionsReady = false;
    html = renderToStaticMarkup(createElement(PluginSettingsCard, { plugin }));
    expect(html).toContain("Reload the app before enabling"); expect(html).toMatch(/disabled=""[^>]*aria-label="Enable spotify"/);
  });
  it("keeps cached sessions manageable when an installed folder disappears", () => {
    const plugin = fixture({ spotify: connected("spotify") }); plugin.catalog!.plugins = [];
    const html = renderToStaticMarkup(createElement(PluginSettingsCard, { plugin }));
    expect(html).toContain("Disable spotify"); expect(html).toContain("Folder is not in the current catalog");
    expect(html).not.toContain("Nothing installed yet");
  });
  it("does not treat Object prototype properties as plugin state/errors/diagnostics", () => {
    const plugin = fixture(); plugin.catalog!.plugins = [{ ...plugin.catalog!.plugins[0], id: "constructor", name: "Constructor" }];
    const html = renderToStaticMarkup(createElement(PluginSettingsCard, { plugin }));
    expect(html).toContain("Enable Constructor"); expect(html).not.toContain("Installation diagnostics"); expect(html).not.toContain('role="alert"');
  });
});
