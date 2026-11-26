import { useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { PluginConnectionSettings } from "./PluginConnectionSettings";
import type { PluginSettingsSchema, PluginSettingsView } from "../lib/plugin";

const schema: PluginSettingsSchema = {
  url: { type: "text", label: "Home Assistant URL" },
  token: { type: "secret", label: "Long-lived access token" },
};
type Fixture = "empty" | "configured" | "load-failure" | "save-failure" | "connected" | "untrusted" | "corrupt";

function SettingsExample({ initial = "empty", width = 720 }: { initial?: Fixture; width?: number }) {
  const secretSaved = useRef(initial === "configured");
  const corrupt = useRef(initial === "corrupt");
  const values = useRef<Record<string, string>>(initial === "configured" ? { url: "http://homeassistant.local:8123" } : {});
  const [note, setNote] = useState("Local fixture only. The injected fake never calls native IPC, a keyring or Home Assistant.");
  const io = {
    load: async (): Promise<PluginSettingsView> => {
      if (initial === "load-failure") throw new Error("credential store unavailable");
      if (corrupt.current) throw { kind: "invalid_arguments", code: "settings_invalid", outcome: "not_started" };
      return { values: values.current, secretConfigured: { token: secretSaved.current } };
    },
    save: async (_id: string, nextValues: Record<string, string>, secrets: Record<string, string>) => {
      if (initial === "save-failure") throw new Error("credential store locked");
      values.current = nextValues;
      if (Object.keys(secrets).length > 0) secretSaved.current = true;
      setNote(`Demo saved ${Object.keys(nextValues).length} text field(s) and ${Object.keys(secrets).length} secret field(s). No credential was stored or displayed.`);
    },
    forget: async () => {
      corrupt.current = false;
      secretSaved.current = false;
      setNote("Demo forgot the saved secret flag. No credential store was touched.");
    },
  };
  return <div style={{ width, maxWidth: "100%" }}><p className="field-note" role="status">{note}</p>
    <PluginConnectionSettings id="home-assistant" schema={schema} trusted={initial !== "untrusted"}
      connected={initial === "connected"} io={io} />
  </div>;
}

const meta = { title: "Settings/Plugin connection settings", component: SettingsExample,
  args: { initial: "empty", width: 720 } } satisfies Meta<typeof SettingsExample>;
export default meta;
type Story = StoryObj<typeof meta>;

const open = async (canvasElement: HTMLElement) => {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByText("Connection settings"));
  await waitFor(() => expect(canvas.getByRole("button", { name: "Load settings" })).toBeVisible());
  return canvas;
};

export const EmptyAndApply: Story = { play: async ({ canvasElement }) => {
  const canvas = await open(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "Load settings" }));
  const url = await canvas.findByLabelText("Home Assistant URL");
  const token = canvas.getByLabelText("Long-lived access token");
  await waitFor(() => expect(url).toHaveValue(""));
  expect(token).toHaveValue("");
  expect(canvas.getByText("No secret saved")).toBeVisible();
  expect(canvas.getByRole("button", { name: "Forget Long-lived access token" })).toBeDisabled();
  await userEvent.type(url, "https://example.invalid");
  await userEvent.type(token, "example-token");
  await userEvent.click(canvas.getByRole("button", { name: "Apply settings" }));
  await waitFor(() => expect(canvas.getByRole("status")).toHaveTextContent("Demo saved 1 text field(s) and 1 secret field(s)"));
  await waitFor(() => expect(token).toHaveValue(""));
  expect(token).toHaveAttribute("placeholder", "Saved — leave blank to keep");
  expect(canvasElement.textContent).not.toContain("example-token");
}};

export const ConfiguredAndForget: Story = { args: { initial: "configured" }, play: async ({ canvasElement }) => {
  const canvas = await open(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "Load settings" }));
  const token = await canvas.findByLabelText("Long-lived access token");
  await waitFor(() => expect(canvas.getByLabelText("Home Assistant URL")).toHaveValue("http://homeassistant.local:8123"));
  expect(token).toHaveValue("");
  expect(token).toHaveAttribute("placeholder", "Saved — leave blank to keep");
  expect(canvas.getByText("Secret saved")).toBeVisible();
  expect(canvasElement.textContent).not.toContain("example-token");
  const forget = canvas.getByRole("button", { name: "Forget Long-lived access token" });
  expect(forget).toBeEnabled();
  await userEvent.click(forget);
  await waitFor(() => expect(canvas.getByText("No secret saved")).toBeVisible());
  expect(forget).toBeDisabled();
  expect(canvas.getByRole("status")).toHaveTextContent("Demo forgot the saved secret flag");
}};

export const LoadFailure: Story = { args: { initial: "load-failure" }, play: async ({ canvasElement }) => {
  const canvas = await open(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "Load settings" }));
  await waitFor(() => expect(canvas.getByRole("alert")).toHaveTextContent("OS credential store"));
  expect(canvas.getByRole("button", { name: "Load settings" })).toBeEnabled();
  expect(canvasElement.textContent).not.toContain("example-token");
}};

export const CorruptSettingsRecovery: Story = { args: { initial: "corrupt" }, play: async ({ canvasElement }) => {
  const canvas = await open(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "Load settings" }));
  await waitFor(() => expect(canvas.getByRole("alert")).toHaveTextContent("2400 UTF-16 bytes"));
  expect(canvas.getByText("If saved settings are damaged, forgetting a secret clears all saved settings for this plugin.")).toBeVisible();
  await userEvent.click(canvas.getByRole("button", { name: "Forget Long-lived access token and recover settings" }));
  await waitFor(() => expect(canvas.getByLabelText("Home Assistant URL")).toHaveValue(""));
  expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
  expect(canvas.getByText("No secret saved")).toBeVisible();
}};

export const SaveFailure: Story = { args: { initial: "save-failure" }, play: async ({ canvasElement }) => {
  const canvas = await open(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "Load settings" }));
  const url = await canvas.findByLabelText("Home Assistant URL");
  await userEvent.type(url, "https://example.invalid");
  await userEvent.click(canvas.getByRole("button", { name: "Apply settings" }));
  await waitFor(() => expect(canvas.getByRole("alert")).toHaveTextContent("No plaintext fallback is used"));
  expect(url).toHaveValue("https://example.invalid");
}};

export const ConnectedDisabled: Story = { args: { initial: "connected" }, play: async ({ canvasElement }) => {
  const canvas = await open(canvasElement);
  expect(canvas.getByText("Disable the plugin before changing or forgetting connection settings.")).toBeVisible();
  expect(canvas.getByRole("button", { name: "Load settings" })).toBeDisabled();
}};

export const UntrustedDisabled: Story = { args: { initial: "untrusted" }, play: async ({ canvasElement }) => {
  const canvas = await open(canvasElement);
  expect(canvas.getByText("Trust this exact package before configuring it. Settings do not enable the plugin.")).toBeVisible();
  expect(canvas.getByRole("button", { name: "Load settings" })).toBeDisabled();
}};

export const Narrow: Story = { args: { initial: "configured", width: 320 }, play: async ({ canvasElement }) => {
  const canvas = await open(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "Load settings" }));
  const url = await canvas.findByLabelText("Home Assistant URL");
  await waitFor(() => expect(url).toBeVisible());
  expect(url.getBoundingClientRect().width).toBeLessThanOrEqual(320);
  expect(canvas.getByLabelText("Long-lived access token")).toHaveAttribute("placeholder", "Saved — leave blank to keep");
}};
