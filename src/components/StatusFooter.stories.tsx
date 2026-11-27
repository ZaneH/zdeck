import type { Meta, StoryObj } from "@storybook/react-vite";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { DEFAULT_FOOTER } from "../lib/footerPreferences";
import { REMOTE_MODE_KEY, REMOTE_ORIGIN_KEY } from "../lib/remotePreferences";
import { StatusFooter } from "./StatusFooter";

const stopped = { running: false, mode: null, origin: null, port: null, pendingDevices: 0, approvedDevices: 0, connectedSockets: 0 };
const running = { ...stopped, running: true, mode: "tailscale" as const, origin: "https://deck.example.ts.net", port: 45829 };
const meta = {
  title: "Workspace/Status footer",
  component: StatusFooter,
  decorators: [(Story) => <div style={{ paddingTop: 360 }}><Story /></div>],
  args: { preferences: DEFAULT_FOOTER, native: true, service: running, serviceFailed: false,
    pluginCount: 2, pluginsUnknown: false, live: false, canRun: true, onEdit: fn(), onRun: fn(), feedback: null },
} satisfies Meta<typeof StatusFooter>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ControlsToggle: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const toggle = canvas.getByRole("button", { name: "Run controls on this computer" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect(toggle).not.toHaveAttribute("aria-haspopup");
    for (const trigger of canvasElement.querySelectorAll<HTMLElement>(".footer-trigger")) {
      await expect(trigger.getBoundingClientRect().height).toBe(trigger.closest(".footer-item")!.getBoundingClientRect().height);
      await expect(getComputedStyle(trigger).borderRadius).toBe("0px");
    }
    // The power fill covers its whole slot: same box as the slot, no inset pill.
    const slot = toggle.closest(".footer-mode")!.getBoundingClientRect();
    const power = toggle.getBoundingClientRect();
    await expect(power.width).toBe(slot.width);
    await expect(power.height).toBe(slot.height);
    await expect(getComputedStyle(toggle).backgroundColor).toBe("rgb(180, 35, 50)");
    await expect(power.width).toBeGreaterThanOrEqual(44);
    await userEvent.hover(toggle);
    await expect(canvas.getByRole("tooltip")).toHaveTextContent("Turn on to run saved controls");
    await userEvent.unhover(toggle);
    toggle.focus();
    await waitFor(() => expect(canvas.getByRole("tooltip")).toBeVisible());
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(canvas.queryByRole("tooltip")).not.toBeInTheDocument());
    await expect(toggle).toHaveFocus();
    await expect(canvas.getByRole("link", { name: "Open settings" })).toHaveAttribute("href", "#/settings");
    await userEvent.keyboard(" ");
    await expect(args.onRun).toHaveBeenCalledOnce();
    await expect(args.onEdit).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole("button", { name: /plugins loaded/ }));
    await waitFor(() => expect(canvas.getByText("Loaded plugins are enabled and ready to provide controls. Disabled plugins are not counted.")).toBeVisible());
    await userEvent.keyboard("{Escape}");
    await expect(canvas.getByRole("button", { name: /plugins loaded/ })).toHaveFocus();
  },
};
export const DisarmAlwaysAvailable: Story = {
  args: { live: true, canRun: false },
  play: async ({ canvasElement, args }) => {
    const toggle = within(canvasElement).getByRole("button", { name: "Run controls on this computer" });
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(getComputedStyle(toggle).backgroundColor).toBe("rgb(22, 115, 68)");
    await userEvent.click(toggle);
    await expect(args.onEdit).toHaveBeenCalledOnce();
  },
};
export const BrowserPreview: Story = {
  args: { native: false, service: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Run controls on this computer" })).toBeDisabled();
    await userEvent.hover(canvasElement.querySelector<HTMLElement>(".footer-mode .setting-help")!);
    await expect(canvas.getByRole("tooltip")).toHaveTextContent("Browser controls are simulated.");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(canvas.queryByRole("tooltip")).not.toBeInTheDocument());
    await userEvent.click(canvas.getByRole("button", { name: "Service unavailable" }));
    await expect(canvas.getByRole("menuitem", { name: "Start service" })).toBeDisabled();
    await expect(canvas.getByRole("menuitem", { name: "Stop service" })).toBeDisabled();
  },
};

export const ServiceActions: Story = {
  beforeEach: ({ parameters }) => {
    const tauri = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
    Object.defineProperty(globalThis, "isTauri", { configurable: true, value: true });
    const saved = localStorage.getItem(REMOTE_ORIGIN_KEY);
    const savedMode = localStorage.getItem(REMOTE_MODE_KEY);
    localStorage.setItem(REMOTE_MODE_KEY, "tailscale");
    localStorage.setItem(REMOTE_ORIGIN_KEY, running.origin);
    mockIPC(command => {
      if (parameters.serviceFailure) throw { kind: "internal", message: "Could not stop the service. Check its state before retrying." };
      if (command === "remote_stop") return new Promise(resolve => setTimeout(() => resolve(stopped), 700));
      if (command === "remote_start") return running;
      throw new Error(`Unexpected command: ${command}`);
    });
    return () => {
      clearMocks();
      if (tauri) Object.defineProperty(globalThis, "isTauri", tauri);
      else Reflect.deleteProperty(globalThis, "isTauri");
      if (saved === null) localStorage.removeItem(REMOTE_ORIGIN_KEY);
      else localStorage.setItem(REMOTE_ORIGIN_KEY, saved);
      if (savedMode === null) localStorage.removeItem(REMOTE_MODE_KEY);
      else localStorage.setItem(REMOTE_MODE_KEY, savedMode);
    };
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Service running" }));
    await expect(canvas.getByRole("menuitem", { name: "Start service" })).toBeDisabled();
    await userEvent.click(canvas.getByRole("menuitem", { name: "Stop service" }));
    await userEvent.click(canvas.getByRole("button", { name: "Service running" }));
    await expect(canvas.getByRole("menuitem", { name: "Start service" })).toBeDisabled();
    await expect(canvas.getByRole("menuitem", { name: "Stop service" })).toBeDisabled();
    await waitFor(() => expect(canvas.getByRole("button", { name: "Service stopped" })).toBeVisible());
    await expect(canvas.getByRole("menuitem", { name: "Start service" })).toBeEnabled();
    await expect(canvas.getByRole("menuitem", { name: "Stop service" })).toBeDisabled();
    await userEvent.click(canvas.getByRole("menuitem", { name: "Start service" }));
    await waitFor(() => expect(canvas.getByRole("button", { name: "Service running" })).toBeVisible());
  },
};
export const FailedServiceAction: Story = {
  beforeEach: ServiceActions.beforeEach,
  parameters: { serviceFailure: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Service running" }));
    await userEvent.click(canvas.getByRole("menuitem", { name: "Stop service" }));
    await expect(canvas.getByRole("alert")).toHaveTextContent("Check its state before retrying.");
    await userEvent.click(canvas.getByRole("button", { name: "Service unknown" }));
    await expect(canvas.getByRole("menuitem", { name: "Start service" })).toBeDisabled();
    await expect(canvas.getByRole("menuitem", { name: "Stop service" })).toBeDisabled();
  },
};
export const BlockedControls: Story = { args: { canRun: false } };
export const UnknownService: Story = {
  args: { service: null, serviceFailed: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Service unknown" }));
    await expect(canvas.getByRole("menuitem", { name: "Start service" })).toBeDisabled();
    await expect(canvas.getByRole("menuitem", { name: "Stop service" })).toBeDisabled();
  },
};
