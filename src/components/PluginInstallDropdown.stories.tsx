import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { PluginInstallMenu } from "./PluginInstallDropdown";
import { WEBSITE_UNAVAILABLE } from "../lib/nativePluginRegistry";

function Example({ configured = false, busy = false }: { configured?: boolean; busy?: boolean }) {
  const [selection, setSelection] = useState("");
  return <section className="settings-card plugin-settings" style={{ maxWidth: 700 }}>
    <h2>External plugins</h2><p>Storybook fixture only. No browser or file picker is opened.</p>
    <div className="plugin-install-tools"><PluginInstallMenu busy={busy} website={configured ? { available: true, explanation: null } : WEBSITE_UNAVAILABLE} onSelect={setSelection} /></div>
    <ul className="plugin-list" aria-label="Installed plugins"><li className="plugin-row"><h3>Fixture plugin</h3><p>Disabled · untrusted</p></li></ul>
    <output aria-label="Fixture selection">{selection}</output>
  </section>;
}
const meta = { title: "Settings/Install from", component: Example } satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
const verify: Story["play"] = async ({ canvasElement }) => {
  const ui = within(canvasElement);
  const trigger = ui.getByRole("button", { name: "Install from…" });
  trigger.focus(); await userEvent.keyboard("{ArrowDown}");
  const rows = ui.getAllByRole("menuitem");
  await expect(rows.map((r) => r.getAttribute("aria-label"))).toEqual(["Local .zdx", "Open plugin registry"]);
  await expect(rows[0]).toHaveFocus();
  await userEvent.keyboard("{End}"); await expect(rows[1]).toHaveFocus();
  await expect(rows[1]).toHaveAttribute("aria-disabled", "true");
  await waitFor(() => expect(ui.getByText("Registry website not configured for this build.")).toBeVisible());
  await userEvent.keyboard("{Enter}"); await expect(ui.getByRole("menu")).toBeVisible();
  await expect(ui.getByLabelText("Fixture selection")).toHaveTextContent("");
  await userEvent.keyboard("{Escape}"); await expect(trigger).toHaveFocus();
  await userEvent.click(trigger); await userEvent.click(ui.getByRole("menuitem", { name: "Local .zdx" }));
  await expect(ui.getByLabelText("Fixture selection")).toHaveTextContent("local");
  await expect(trigger).toHaveFocus();
  const list = ui.getByRole("list", { name: "Installed plugins" }).getBoundingClientRect();
  const button = trigger.getBoundingClientRect();
  await expect(button.bottom).toBeLessThanOrEqual(list.top);
  await expect(Math.abs(button.right - list.right)).toBeLessThan(2);
  await expect(canvasElement.scrollWidth).toBeLessThanOrEqual(canvasElement.clientWidth + 1);
};
export const Unconfigured: Story = { play: verify };
export const Narrow: Story = { globals: { viewport: { value: "mobile1", isRotated: false } }, play: verify };
export const Busy: Story = { args: { busy: true }, play: async ({ canvasElement }) => {
  await expect(within(canvasElement).getByRole("button", { name: "Install from…" })).toBeDisabled();
} };
export const MacPointerFocus: Story = { args: { configured: true }, play: async ({ canvasElement }) => {
  const ui = within(canvasElement);
  await userEvent.click(ui.getByRole("button", { name: "Install from…" }));
  const local = ui.getByRole("menuitem", { name: "Local .zdx" });
  const registry = ui.getByRole("menuitem", { name: "Open plugin registry" });
  await expect(local).toHaveFocus();
  // WebKit can blur the focused row without focusing the clicked button, removing it before click.
  const mouseDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
  registry.dispatchEvent(mouseDown);
  await expect(mouseDown.defaultPrevented).toBe(true);
  await expect(local).toHaveFocus();
  await userEvent.click(registry);
  await expect(ui.getByLabelText("Fixture selection")).toHaveTextContent("registry");
  await expect(ui.queryByRole("menu")).not.toBeInTheDocument();
  await expect(ui.getByRole("button", { name: "Install from…" })).toHaveFocus();
} };
export const Configured: Story = { args: { configured: true }, play: async ({ canvasElement }) => {
  const ui = within(canvasElement); await userEvent.click(ui.getByRole("button", { name: "Install from…" }));
  await userEvent.click(ui.getByRole("menuitem", { name: "Open plugin registry" }));
  await expect(ui.getByLabelText("Fixture selection")).toHaveTextContent("registry");
} };
