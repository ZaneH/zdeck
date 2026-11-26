import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { Inspector } from "./Inspector";
import { ControlTile } from "./ControlTile";
import rawManifest from "../../plugins/home-assistant/manifest.json";
import { parsePluginManifest } from "../lib/plugin";
import type { PluginControl } from "../lib/types";
import type { ObsConsole } from "../lib/useObsConsole";
import type { PluginConsole } from "../lib/usePluginConsole";
import type { SystemConsole } from "../lib/useSystemConsole";

const manifest = parsePluginManifest(rawManifest)!;
const longName = "Kitchen pendant beside the reading nook, overlooking the garden and the conservatory — ".repeat(4);
const longId = `light.${"kitchen_pendant_".repeat(19)}`;
const choices = [
  { value: 7, label: longName.slice(0, 310), description: longId, available: true, observation: { value: true, unit: "", observedAtMs: 1795746000000 } },
  { value: 30, label: "Hall light", description: "light.hall", available: false, observation: { value: null, unit: "", observedAtMs: 1795746000000 } },
  { value: 9, label: "Desk lamp", description: "light.desk", available: true, observation: { value: false, unit: "", observedAtMs: 1795746000000 } },
];
type Fixture = "toggle" | "fixed" | "unavailable" | "temperature" | "fahrenheit" | "state" | "unavailable-value";
const obs = { native: false, status: "disconnected", scenes: [] } as unknown as ObsConsole;
const system = { native: false } as SystemConsole;

function InspectorExample({ fixture = "toggle", width = 320, long = true }: { fixture?: Fixture; width?: number; long?: boolean }) {
  const [lastArgs, setLastArgs] = useState<unknown>(null);
  const value = ["temperature", "fahrenheit", "state", "unavailable-value"].includes(fixture);
  const temperature = ["temperature", "fahrenheit", "unavailable-value"].includes(fixture);
  const [control, setControl] = useState<PluginControl>({ id: "ha", label: temperature ? "Hall temperature" : "Kitchen light", action: "plugin",
    pluginId: "home-assistant", pluginAction: temperature ? "temperature" : value ? "state" : "power",
    presentation: value ? "value" : fixture === "fixed" ? "button" : "toggle-switch",
    pluginArgs: value ? { entity: 7 } : { entity: fixture === "unavailable" ? 30 : 7, enabled: true } });
  const snapshots: PluginConsole["snapshots"] = { "home-assistant": { status: "connected", manifest, lastError: null,
    state: { entities: long ? choices : [{ ...choices[0], label: "Kitchen light", description: "light.kitchen" }, ...choices.slice(1)],
      temperatures: [{ value: 7, label: "Hall thermostat", description: "climate.hall", available: fixture !== "unavailable-value",
        observation: { value: fixture === "unavailable-value" ? null : fixture === "fahrenheit" ? 70.7 : 21.5, unit: fixture === "fahrenheit" ? "°F" : "°C", observedAtMs: 1795746000000 } }] } } };
  const plugin = { native: true, snapshots, busy: {}, errors: {}, completedIds: {}, readState: async () => {}, execute: async (target: PluginControl) => { setLastArgs(target.pluginArgs); } } as unknown as PluginConsole;
  return <div data-last-args={JSON.stringify(lastArgs)} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", width, maxWidth: "100%", gap: 24 }}>
    <Inspector control={control} pageName="Home" previewVolume={50} obs={obs} system={system} plugin={plugin}
      onPatch={(patch) => setControl((current) => ({ ...current, ...patch } as PluginControl))} onRemove={() => {}} onPreviewPress={() => {}} onPreviewVolume={() => {}} />
    <div className="phone-grid" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}><ControlTile control={control} plugins={snapshots} variant="phone" semantics="remote" volume={0} onRefresh={value ? async () => {} : undefined} /></div>
  </div>;
}
const meta = { title: "Controls/Home Assistant", component: InspectorExample, args: { fixture: "toggle", width: 320, long: true } } satisfies Meta<typeof InspectorExample>;
export default meta;
type Story = StoryObj<typeof meta>;
const assertFits = (element: HTMLElement) => {
  expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
  for (const node of element.querySelectorAll<HTMLElement>(".panel, .inspector-section-body, .native-control, .dropdown, .dropdown-menu, .dropdown-trigger")) {
    expect(node.scrollWidth).toBeLessThanOrEqual(node.clientWidth + 1);
    expect(node.getBoundingClientRect().right).toBeLessThanOrEqual(element.getBoundingClientRect().right + 1);
  }
};
export const SelectedLongEntity: Story = { play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  expect(canvas.queryByRole("button", { name: /^On press:/ })).not.toBeInTheDocument();
  for (const toggle of canvas.getAllByRole("switch", { name: "Kitchen light" })) expect(toggle).toBeChecked();
  await userEvent.click(within(canvasElement.querySelector('.native-control') as HTMLElement).getByRole('switch', { name: 'Kitchen light' }));
  expect(canvasElement.querySelector('[data-last-args]')).toHaveAttribute('data-last-args', JSON.stringify({ entity: 7, enabled: false }));
  for (const toggle of canvas.getAllByRole("switch", { name: "Kitchen light" })) expect(toggle).toBeChecked();
  assertFits(canvasElement);
} };
export const OpenLongEntity: Story = { play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: /^Entity:/ }));
  expect(canvas.getAllByRole("menuitemradio")).toHaveLength(3);
  expect(canvas.getAllByRole("menuitemradio")[0]).toHaveFocus();
  assertFits(canvasElement);
} };
export const NarrowInspector: Story = { args: { width: 260 }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const trigger = canvas.getByRole("button", { name: /^Entity:/ });
  trigger.focus();
  await userEvent.keyboard("{ArrowDown}{End}");
  expect(canvas.getByRole("menuitemradio", { name: "Desk lamp" })).toHaveFocus();
  assertFits(canvasElement);
  await userEvent.keyboard("{Escape}");
  expect(trigger).toHaveFocus();
  expect(canvas.queryByRole("menu")).not.toBeInTheDocument();
} };
export const ExplicitOnOff: Story = { args: { fixture: "fixed", long: false }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const trigger = canvas.getByRole("button", { name: "On press: Turn on" });
  await userEvent.click(trigger);
  await userEvent.click(canvas.getByRole("menuitemradio", { name: "Turn off" }));
  expect(canvas.getByRole("button", { name: "On press: Turn off" })).toBeVisible();
  expect(canvas.queryByRole("switch")).not.toBeInTheDocument();
  await userEvent.click(canvas.getByRole("button", { name: "On press: Turn off" }));
  await userEvent.click(canvas.getByRole("menuitemradio", { name: "Toggle" }));
  for (const toggle of canvas.getAllByRole("switch", { name: "Kitchen light" })) expect(toggle).toBeChecked();
} };
export const UnavailableToggle: Story = { args: { fixture: "unavailable", long: false }, play: async ({ canvasElement }) => {
  for (const toggle of within(canvasElement).getAllByRole("button", { name: /Kitchen light — state unknown/ })) expect(toggle).toBeDisabled();
} };
export const ReadOnlyTemperature: Story = { args: { fixture: "temperature", long: false }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  expect(canvas.getByLabelText("Hall temperature reading")).toHaveTextContent("21.5°C");
  expect(canvas.queryByRole("button", { name: "Run plugin action" })).not.toBeInTheDocument();
  await waitFor(() => expect(canvas.getByRole("button", { name: "Refresh Hall temperature" })).toBeVisible());
  assertFits(canvasElement);
} };
export const Fahrenheit: Story = { args: { fixture: "fahrenheit", long: false } };
export const ReadOnlyLightState: Story = { args: { fixture: "state", long: false } };
export const UnavailableValue: Story = { args: { fixture: "unavailable-value", long: false }, play: async ({ canvasElement }) => {
  expect(within(canvasElement).getByLabelText("Hall temperature reading")).toHaveTextContent("Unknown / unavailable");
} };
