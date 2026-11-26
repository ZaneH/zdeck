import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { PluginSettingsCard } from "./PluginSettingsCard";
import { EMPTY_PLUGIN, parsePluginDiagnostics, toPluginError } from "../lib/plugin";
import type { PluginConsole } from "../lib/usePluginConsole";
import type { PluginCatalog, PluginDiagnostics, PluginManifest, PluginSnapshots } from "../lib/plugin";

const manifests: Record<string, PluginManifest> = Object.fromEntries(["spotify", "notes"].map((id) => [id, { id, version: "0.1.0", protocolVersion: 1,
  actions: [{ id: "next", title: id === "spotify" ? "Next track" : "Next note", config: {} }] }]));
const observed = { title: "Example track", artist: "Example artist", playback: "paused", volume: 42 };
type Fixture = "runtime-missing" | "nothing-installed" | "ready" | "two-enabled" | "one-failed" | "invalid-sdk" | "long-content";
function PluginExample({ initial = "ready", width = 720 }: { initial?: Fixture; width?: number }) {
  const demoManifests = initial === "long-content" ? { ...manifests, spotify: { ...manifests.spotify, actions: [
    { id: "resume_playback_from_the_current_queue_and_keep_the_selected_output_device", title: "Resume playback from the current queue without changing the selected output device", config: {} },
    { id: "next", title: "Skip to the next track in the listening session", config: {} },
  ] } } : manifests;
  const demoObserved = initial === "long-content" ? {
    ...observed, title: "A very long track title from a live recording with an extended introduction and an encore",
    artist: "An artist with a long name featuring another artist and the complete festival orchestra",
  } : observed;
  const [note, setNote] = useState("Local fixtures only. No native IPC, folder access, plugin launch, or media actions.");
  const [catalog, setCatalog] = useState<PluginCatalog>(() => ({ directory: "/example/zdeck/plugins", truncated: false,
    node: initial === "runtime-missing" ? { status: "not_found", version: null, path: null } : { status: "detected", version: "22.18.0", path: "/example/bin/node" },
    plugins: initial === "nothing-installed" || initial === "runtime-missing" ? [] : ["spotify", "notes"].map((id) => ({ id, name: id === "spotify" ? "Spotify" : "Notes", version: "0.1.0", protocolVersion: 1,
      icon: id === "spotify" ? "data:image/svg+xml;base64,PHN2Zy8+" : null, trusted: initial === "two-enabled" && id === "notes",
      identity: initial === "invalid-sdk" && id === "spotify" ? null : "0123456789abcdef".repeat(4),
      status: initial === "invalid-sdk" && id === "spotify" ? "invalid" : "ready", message: initial === "invalid-sdk" && id === "spotify" ? "SDK symlink/source layout. Copy the complete packaged folder, including node_modules; do not use npm install as distribution repair." : null })) }));
  const [snapshots, setSnapshots] = useState<PluginSnapshots>((): PluginSnapshots => initial === "two-enabled" || initial === "one-failed" || initial === "long-content" ? {
    spotify: initial === "one-failed" ? { status: "stopped", manifest: demoManifests.spotify, state: null, lastError: toPluginError({ kind: "timeout", outcome: "unknown" }) }
      : { status: "connected", manifest: demoManifests.spotify, state: demoObserved, lastError: null },
    notes: { status: "connected", manifest: demoManifests.notes, state: null, lastError: null },
  } : {});
  const [diagnostics, setDiagnostics] = useState<Record<string, PluginDiagnostics>>({});
  const [trustEpoch, setTrustEpoch] = useState<Record<string, number>>({});
  const [catalogEpoch, setCatalogEpoch] = useState(0);
  const reset = (id: string) => setTrustEpoch((current) => ({ ...current, [id]: (current[id] ?? 0) + 1 }));
  const plugin: PluginConsole = {
    native: true, snapshots, catalog, catalogError: null, catalogBusy: false, loading: false, sessionsReady: true,
    busy: {}, errors: {}, diagnostics, completedIds: {}, trustEpoch, catalogEpoch,
    refreshSnapshots: async () => {},
    refreshCatalog: async () => { setCatalogEpoch((n) => n + 1); setNote("Demo refresh: pending trust cleared; enabled sessions preserved."); },
    openDirectory: async () => { setCatalogEpoch((n) => n + 1); setNote("Demo only: no folder was opened."); },
    trust: async (id, _identity) => { reset(id); setCatalog((current) => ({ ...current, plugins: current.plugins.map((entry) => entry.id === id ? { ...entry, trusted: true } : entry) })); setNote(`Demo trusted ${id}; no trust was persisted.`); return true; },
    enable: async (id) => { reset(id); setSnapshots((current) => ({ ...current, [id]: { status: "connected", manifest: demoManifests[id], state: null, lastError: null } })); setNote(`Demo enabled ${id}; no process launched.`); },
    readState: async (id) => { reset(id); setSnapshots((current) => ({ ...current, [id]: { ...current[id], state: id === "spotify" ? demoObserved : null } })); },
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
const inspectState: Story["play"] = async ({ canvasElement }) => {
  canvasElement.querySelectorAll<HTMLDetailsElement>(".plugin-state").forEach((panel) => {
    panel.querySelector<HTMLElement>("summary")!.click();
    if (!panel.open || !panel.querySelector(".plugin-action-list code") || !panel.querySelector(".plugin-read-control button")) {
      throw new Error("Actions and state must have separate readable sections and an explicit read control.");
    }
  });
  const values = canvasElement.querySelector(".plugin-state-values");
  if (!values || values.querySelectorAll("dt").length !== 4 || values.querySelectorAll("dd").length !== 4) {
    throw new Error("Last read state must retain all four labeled values.");
  }
};
export const LongActionsAndState: Story = { args: { initial: "long-content" }, play: inspectState };
export const NarrowActionsAndState: Story = { args: { initial: "long-content", width: 320 }, play: inspectState };
export const NarrowEmptyState: Story = { args: { initial: "two-enabled", width: 320 }, play: inspectState };
export const TrustDialogAndThumbnail: Story = { args: { initial: "ready" }, play: async ({ canvasElement }) => {
  const thumbnail = canvasElement.querySelector<HTMLImageElement>(`[data-plugin-id=spotify] .plugin-thumbnail img`);
  if (thumbnail?.getAttribute("src")?.startsWith("data:image/svg+xml") !== true) {
    throw new Error("A plugin-provided identity thumbnail must render as a bounded embedded image.");
  }
  const fallback = canvasElement.querySelector(`[data-plugin-id=notes] .plugin-thumbnail svg`);
  if (!fallback) throw new Error("A plugin without an icon must render a generic fallback.");
  canvasElement.querySelector<HTMLButtonElement>(`[data-plugin-id=spotify] .plugin-row-actions > button`)?.click();
  const dialog = canvasElement.querySelector<HTMLDialogElement>(`[data-plugin-id=spotify] dialog`);
  if (!dialog?.open) throw new Error("Enable must open a confirmation dialog rather than enabling directly.");
  if (!dialog.textContent?.includes("Trust and enable") || !dialog.textContent.includes("not a sandbox")) {
    throw new Error("The trust dialog must offer Trust and enable and explain local code risk.");
  }
  dialog.querySelector<HTMLButtonElement>("button.secondary")?.click();
  if (dialog.open) throw new Error("Cancel must dismiss the trust dialog.");
}};
export const PluginErrorWithoutStripe: Story = { args: { initial: "one-failed" }, play: async ({ canvasElement }) => {
  const alert = canvasElement.querySelector<HTMLElement>(`[data-plugin-id=spotify] .settings-error`);
  if (!alert || alert.getAttribute("role") !== "alert") throw new Error("A plugin error must remain a visible alert.");
  const style = getComputedStyle(alert);
  if (style.borderLeftWidth !== "0px") throw new Error("Plugin errors must not carry a colored left stripe.");
  if (parseFloat(style.paddingTop) < 10) throw new Error("Plugin errors need readable padding.");
}};
