import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { Inspector } from "./Inspector";
import type { PluginManifest, PluginSnapshot } from "../lib/plugin";
import type { PluginControl } from "../lib/types";
import type { ObsConsole } from "../lib/useObsConsole";
import type { PluginConsole } from "../lib/usePluginConsole";
import type { SystemConsole } from "../lib/useSystemConsole";

const manifest: PluginManifest = { id: "home-assistant", version: "0.1.0", protocolVersion: 1, actions: [{
  id: "power", title: "Power", config: {
    entity: { type: "integer", minimum: 1, maximum: 281474976710655, choicesKey: "entities" },
    enabled: { type: "boolean" },
  },
}] };
const choices = [
  { value: 30, label: "Desk light", available: false },
  { value: 7, label: "Kitchen lamp", available: true },
];
type Fixture = "available" | "unavailable" | "missing";
const controlFor = (entity: number): PluginControl => ({ id: "ctl_ha_power", label: "Kitchen lamp", action: "plugin",
  pluginId: "home-assistant", pluginAction: "power", pluginArgs: { entity, enabled: true } });
const snapshot = (state: Record<string, unknown>): PluginSnapshot => ({ status: "connected", manifest, state, lastError: null });
const obs: ObsConsole = { native: false, status: "disconnected", snapshot: null, currentScene: null, scenes: [],
  error: null, pendingScene: null, lastSwitch: null, connect: async () => false, disconnect: async () => {},
  refresh: async () => {}, runScene: async () => {} };
const system: SystemConsole = { native: false, output: null, outputTarget: 50, outputPending: false,
  outputRefreshing: false, outputError: null, outputFeedback: null, setOutputTarget: () => {},
  refreshOutput: async () => {}, applyOutput: async () => {}, microphone: null, microphonePending: false,
  microphoneRefreshing: false, microphoneError: null, microphoneFeedback: null, refreshMicrophone: async () => {},
  toggleMicrophone: async () => {}, media: null, mediaPending: false, mediaRefreshing: false, mediaError: null,
  mediaFeedback: null, refreshMedia: async () => {}, runMedia: async () => {} };

function InspectorExample({ initial = "unavailable", width = 420 }: { initial?: Fixture; width?: number }) {
  const [control, setControl] = useState(() => controlFor(initial === "available" ? 7 : 30));
  const state = initial === "missing" ? { entities: [choices[1]] } : { entities: choices };
  const plugin: PluginConsole = {
    native: true, snapshots: { "home-assistant": snapshot(state) }, catalogBusy: false, loading: false, sessionsReady: true,
    catalog: { directory: "/example/zdeck/plugins", node: { status: "detected", version: "22.18.0", path: "/example/bin/node" },
      plugins: [{ id: "home-assistant", name: "Home Assistant", version: "0.1.0", protocolVersion: 1, status: "ready",
        message: null, icon: null, trusted: true, identity: "0123456789abcdef".repeat(4) }] },
    catalogError: null, busy: {}, errors: {}, diagnostics: {}, completedIds: {}, trustEpoch: {}, catalogEpoch: 0,
    refreshSnapshots: async () => {}, refreshCatalog: async () => {}, openDirectory: async () => {},
    trust: async () => true, enable: async () => {}, readState: async () => {}, disconnect: async () => {},
    execute: async () => {}, diagnose: async () => {}, uninstall: async () => {},
  };
  return <div style={{ width, maxWidth: "100%" }}><Inspector control={control} pageName="Home" previewVolume={50}
    obs={obs} system={system} plugin={plugin} onPatch={(patch) => setControl((current) => ({ ...current, ...patch } as PluginControl))}
    onRemove={() => {}} onPreviewPress={() => {}} onPreviewVolume={() => {}} /></div>;
}

const meta = { title: "Controls/Home Assistant choices", component: InspectorExample,
  args: { initial: "unavailable", width: 420 } } satisfies Meta<typeof InspectorExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const UnavailableChoice: Story = { play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const run = canvas.getByRole("button", { name: "Run plugin action" });
  expect(run).toBeDisabled();
  const trigger = canvas.getByRole("button", { name: "entity: Desk light — unavailable" });
  await userEvent.click(trigger);
  const menu = within(canvas.getByRole("menu", { name: "entity" }));
  const items = menu.getAllByRole("menuitemradio");
  expect(items.map((item) => item.textContent)).toEqual(["Desk light — unavailable", "Kitchen lamp"]);
  await userEvent.click(items[1]);
  await waitFor(() => expect(canvas.getByRole("button", { name: "entity: Kitchen lamp" })).toBeVisible());
  await waitFor(() => expect(run).toBeEnabled());
}};

export const AvailableChoice: Story = { args: { initial: "available" }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  expect(canvas.getByRole("button", { name: "entity: Kitchen lamp" })).toBeVisible();
  expect(canvas.getByRole("button", { name: "Run plugin action" })).toBeEnabled();
}};

export const MissingSavedChoice: Story = { args: { initial: "missing" }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  expect(canvas.getByRole("button", { name: "Run plugin action" })).toBeDisabled();
  const trigger = canvas.getByRole("button", { name: "entity: Select an entity (saved selection missing)" });
  await userEvent.click(trigger);
  const menu = within(canvas.getByRole("menu", { name: "entity" }));
  await waitFor(() => expect(menu.getByRole("menuitemradio", { name: "Select an entity (saved selection missing)" })).toBeVisible());
  expect(menu.getByRole("menuitemradio", { name: "Kitchen lamp" })).toBeVisible();
}};

export const NarrowUnavailableChoice: Story = { args: { initial: "unavailable", width: 320 }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const trigger = canvas.getByRole("button", { name: "entity: Desk light — unavailable" });
  expect(trigger.getBoundingClientRect().width).toBeLessThanOrEqual(320);
  await userEvent.click(trigger);
  await waitFor(() => expect(canvas.getByRole("menu", { name: "entity" })).toBeVisible());
}};
