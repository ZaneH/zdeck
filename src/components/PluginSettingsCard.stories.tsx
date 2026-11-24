import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { PluginSettingsCard } from "./PluginSettingsCard";
import type { PluginConsole } from "../lib/usePluginConsole";
import type { PluginCatalog, PluginManifest, PluginSnapshot } from "../lib/plugin";

const manifest: PluginManifest = { id: "spotify", version: "0.1.0", protocolVersion: 1,
  actions: [{ id: "play-pause", title: "Play / pause", config: {} }, { id: "next", title: "Next track", config: {} }] };
const empty: PluginSnapshot = { status: "disconnected", manifest: null, state: null, lastError: null };
const observed = { title: "Example track", artist: "Example artist", playback: "paused", volume: 42 };
type Fixture = "runtime-missing" | "nothing-installed" | "ready" | "connected" | "unknown";
function PluginExample({ initial = "ready", width = 640 }: { initial?: Fixture; width?: number }) {
  const [selectedId, setSelectedId] = useState(initial === "ready" || initial === "connected" || initial === "unknown" ? "spotify" : "");
  const [trusted, setTrusted] = useState(false);
  const [note, setNote] = useState("Local Storybook fixtures only. No runtime probing, folder access, plugin launch, or media actions.");
  const [snapshot, setSnapshot] = useState<PluginSnapshot>(() => initial === "connected"
    ? { status: "connected", manifest, state: observed, lastError: null }
    : initial === "unknown" ? { status: "stopped", manifest, state: null, lastError: {
      kind: "timeout", code: null, outcome: "unknown", message: "Example unknown outcome.", hint: "Visual fixture only; no request was sent." } } : empty);
  const catalog: PluginCatalog = { directory: "/example/zdeck/plugins", truncated: false,
    node: initial === "runtime-missing" ? { status: "not_found", version: null, path: null }
      : { status: "detected", version: "22.18.0", path: "/example/bin/node" },
    plugins: initial === "runtime-missing" || initial === "nothing-installed" ? []
      : [{ id: "spotify", name: "Spotify", version: "0.1.0", protocolVersion: 1, status: "ready", message: null }] };
  // Type-only console import: this fixture never imports or mounts the native hook.
  const plugin: PluginConsole = {
    native: true, snapshot, catalog, catalogError: null, busy: false, completedId: null, selectedId, trusted,
    selectPlugin: (id) => { setSelectedId(id); setTrusted(false); }, setTrusted,
    refreshCatalog: async () => { setSelectedId(""); setTrusted(false); setNote("Demo refresh: selection and trust cleared. No folders scanned."); },
    openDirectory: async () => { setTrusted(false); setNote("Demo only: no folder was opened."); },
    enable: async () => { if (trusted && selectedId) { setSnapshot({ status: "connected", manifest, state: null, lastError: null }); setNote("Demo enabled. No process was launched."); } },
    readState: async () => { setSnapshot((previous) => ({ ...previous, state: observed })); setNote("Example state shown. No media application was queried."); },
    disconnect: async () => { setSnapshot(empty); setTrusted(false); setNote("Demo disconnected."); },
    execute: async () => { setNote("Demo only: no action was executed."); },
  };
  return <div style={{ width, maxWidth: "100%" }}><p className="field-note" role="status">{note}</p><PluginSettingsCard plugin={plugin} /></div>;
}
const meta = { title: "Settings/External plugin", component: PluginExample,
  args: { initial: "ready", width: 640 } } satisfies Meta<typeof PluginExample>;
export default meta;
type Story = StoryObj<typeof meta>;
export const RuntimeMissing: Story = { args: { initial: "runtime-missing" } };
export const NothingInstalled: Story = { args: { initial: "nothing-installed" } };
export const ReadyForTrust: Story = { args: { initial: "ready" } };
export const Connected: Story = { args: { initial: "connected" } };
export const UnknownOutcome: Story = { args: { initial: "unknown" } };
export const NarrowTrust: Story = { args: { initial: "ready", width: 320 } };
