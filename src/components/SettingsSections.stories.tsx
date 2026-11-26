import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { mockDesktopPreferences } from "../../.storybook/desktopPreferences";
import { DesktopPreferencesCard } from "./DesktopPreferencesCard";
import { SettingsSections } from "./SettingsSections";

function SettingsExample({ width = 960 }: { width?: number }) {
  return <main className="settings-view" style={{ width, maxWidth: "100%" }}>
    <div className="settings-header"><h1>Settings</h1><p>Navigation fixture with local-only cards; no phone service or integrations are started.</p></div>
    <SettingsSections general={<DesktopPreferencesCard />}
      footer={<section className="settings-card"><h2>Footer</h2><p>Footer visibility preferences live here.</p></section>}
      phone={<section className="settings-card"><h2>Phone connection</h2><label className="field">Device name<input defaultValue="Studio phone" /></label></section>}
      integrations={<section className="settings-card"><h2>Integrations</h2><p>OBS and external plugin settings live here.</p></section>} />
  </main>;
}
const meta = {
  title: "Settings/Grouped navigation",
  component: SettingsExample,
  args: { width: 960 },
  // Vitest's base URL would navigate hash-only links out of the test iframe.
  decorators: [(Story) => <div onClick={(event) => {
    const link = (event.target as Element).closest("a");
    const href = link?.getAttribute("href");
    if (!href?.startsWith("#")) return;
    event.preventDefault();
    window.history.pushState(null, "", href);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }}><Story /></div>],
  beforeEach: ({ parameters }) => {
    const hash = window.location.hash;
    window.history.replaceState(null, "", `#/settings/${parameters.settingsSection ?? "general"}`);
    const cleanup = mockDesktopPreferences();
    return () => {
      cleanup();
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${hash}`);
    };
  },
} satisfies Meta<typeof SettingsExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const General: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const nav = within(canvas.getByRole("navigation", { name: "Settings sections" }));
    const checkbox = canvas.getByRole("checkbox");
    await waitFor(() => expect(checkbox).toBeEnabled());
    await userEvent.click(checkbox);
    await waitFor(() => expect(checkbox).toBeChecked());
    await userEvent.click(nav.getByRole("link", { name: "Phone connection" }));
    await waitFor(() => expect(canvas.getByRole("region", { name: "Phone connection" })).toBeVisible());
    const device = canvas.getByRole("textbox", { name: "Device name" });
    await userEvent.type(device, " edited");
    await userEvent.click(nav.getByRole("link", { name: "Integrations" }));
    await waitFor(() => expect(canvas.getByRole("region", { name: "Integrations" })).toBeVisible());
    await expect(nav.getByRole("link", { name: "Integrations" })).toHaveAttribute("aria-current", "page");
    await expect(window.location.hash).toBe("#/settings/integrations");
    await expect(checkbox).not.toBeVisible();
    await expect(checkbox).toBeInTheDocument();
    await userEvent.click(nav.getByRole("link", { name: "Phone connection" }));
    await waitFor(() => expect(device).toBeVisible());
    await expect(device).toHaveValue("Studio phone edited");
    await userEvent.click(nav.getByRole("link", { name: "General" }));
    await waitFor(() => expect(checkbox).toBeVisible());
    await expect(checkbox).toBeChecked();
  },
};
const checkDeepLink: Story["play"] = async ({ canvasElement, parameters }) => {
  const canvas = within(canvasElement);
  const label = parameters.settingsSection === "phone" ? "Phone connection" : "Integrations";
  await expect(canvas.getByRole("region", { name: label })).toBeVisible();
  await expect(canvas.getByRole("link", { name: label })).toHaveAttribute("aria-current", "page");
  await expect(window.location.hash).toBe(`#/settings/${parameters.settingsSection}`);
};
export const PhoneConnectionDeepLink: Story = { parameters: { settingsSection: "phone" }, play: checkDeepLink };
export const IntegrationsDeepLink: Story = { parameters: { settingsSection: "integrations" }, play: checkDeepLink };
export const Narrow: Story = { args: { width: 320 }, play: General.play };
