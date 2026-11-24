import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { PluginSettingsCard } from "./PluginSettingsCard";
import { EMPTY_PLUGIN, parsePluginDiagnostics, toPluginError } from "../lib/plugin";
import type { PluginConsole } from "../lib/usePluginConsole";
import type { PluginCatalog, PluginDiagnostics, PluginManifest, PluginSnapshots } from "../lib/plugin";

const manifests: Record<string, PluginManifest> = Object.fromEntries(["spotify", "notes"].map((id) => [id, { id, version: "0.1.0", protocolVersion: 1,
  actions: [{ id: "next", title: id === "spotify" ? "Next track" : "Next note", config: {} }] }]));
const observed = { title: "Example track", artist: "Example artist", playback: "paused", volume: 42 };
type Fixture = "runtime-missing" | "nothing-installed" | "ready" | "two-enabled" | "one-failed" | "invalid-sdk";
function PluginExample({ initial = "ready", width = 720 }: { initial?: Fixture; width?: number }) {
  const [note, setNote] = useState("Local fixtures only. No native IPC, folder access, plugin launch, or media actions.");
  const [catalog, setCatalog] = useState<PluginCatalog>(() => ({ directory: "/example/zdeck/plugins", truncated: false,
    node: initial === "runtime-missing" ? { status: "not_found", version: null, path: null } : { status: "detected", version: "22.18.0", path: "/example/bin/node" },
    plugins: initial === "nothing-installed" || initial === "runtime-missing" ? [] : ["spotify", "notes"].map((id) => ({ id, name: id === "spotify" ? "Spotify" : "Notes", version: "0.1.0", protocolVersion: 1,
      status: initial === "invalid-sdk" && id === "spotify" ? "invalid" : "ready", message: initial === "invalid-sdk" && id === "spotify" ? "SDK symlink/source layout. Copy the complete packaged folder, including node_modules; do not use npm install as distribution repair." : null })) }));
  const [snapshots, setSnapshots] = useState<PluginSnapshots>((): PluginSnapshots => initial === "two-enabled" || initial === "one-failed" ? {
    spotify: initial === "one-failed" ? { status: "stopped", manifest: manifests.spotify, state: null, lastError: toPluginError({ kind: "timeout", outcome: "unknown" }) }
      : { status: "connected", manifest: manifests.spotify, state: observed, lastError: null },
    notes: { status: "connected", manifest: manifests.notes, state: null, lastError: null },
  } : {});
  const [diagnostics, setDiagnostics] = useState<Record<string, PluginDiagnostics>>({});
  const [trustEpoch, setTrustEpoch] = useState<Record<string, number>>({});
  const [catalogEpoch, setCatalogEpoch] = useState(0);
  const reset = (id: string) => setTrustEpoch((current) => ({ ...current, [id]: (current[id] ?? 0) + 1 }));
  const plugin: PluginConsole = {
    native: true, snapshots, catalog, catalogError: null, catalogBusy: false, loading: false, sessionsReady: true,
    busy: {}, errors: {}, diagnostics, completedIds: {}, trustEpoch, catalogEpoch,
    refreshCatalog: async () => { setCatalogEpoch((n) => n + 1); setNote("Demo refresh: pending trust cleared; enabled sessions preserved."); },
    openDirectory: async () => { setCatalogEpoch((n) => n + 1); setNote("Demo only: no folder was opened."); },
    enable: async (id, trusted) => { if (!trusted) return; reset(id); setSnapshots((current) => ({ ...current, [id]: { status: "connected", manifest: manifests[id], state: null, lastError: null } })); setNote(`Demo enabled ${id}; no process launched.`); },
    readState: async (id) => { reset(id); setSnapshots((current) => ({ ...current, [id]: { ...current[id], state: id === "spotify" ? observed : null } })); },
    disconnect: async (id) => { reset(id); setSnapshots((current) => ({ ...current, [id]: EMPTY_PLUGIN })); setNote(`Demo disabled ${id}; other plugins unchanged.`); },
    execute: async () => { setNote("Demo only: no action executed."); },
    diagnose: async (id) => { reset(id); const result = parsePluginDiagnostics({ pluginId: id, checks: [{ name: "SDK dependency", status: initial === "invalid-sdk" ? "fail" : "pass", message: "Example local check." }] }, id)!; setDiagnostics((current) => ({ ...current, [id]: result })); },
    uninstall: async (id) => { reset(id); setSnapshots((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id))); setCatalog((current) => ({ ...current, plugins: current.plugins.filter((entry) => entry.id !== id) })); setNote(`Demo removed ${id} from the list. No files were moved or deleted.`); },
  };
  return <div style={{ width, maxWidth: "100%" }}><p className="field-note" role="status">{note}</p><PluginSettingsCard plugin={plugin} /></div>;
}
const meta = { title: "Settings/External plugin", component: PluginExample, args: { initial: "ready", width: 720 } } satisfies Meta<typeof PluginExample>;
export default meta;
type Story = StoryObj<typeof meta>;
export const RuntimeMissing: Story = { args: { initial: "runtime-missing" } };
export const NothingInstalled: Story = { args: { initial: "nothing-installed" } };
export const ReadyForTrust: Story = { args: { initial: "ready" } };
export const TwoEnabled: Story = { args: { initial: "two-enabled" } };
export const OneFailedOneHealthy: Story = { args: { initial: "one-failed" } };
export const InvalidSdkDiagnostics: Story = { args: { initial: "invalid-sdk" } };
export const NarrowTrust: Story = { args: { initial: "ready", width: 320 } };
