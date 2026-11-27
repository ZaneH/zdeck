import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { PluginArchiveDialog } from "./PluginArchiveInstaller";
import type { ArchiveView } from "../lib/nativePluginArchive";
import { EMPTY_ARCHIVE } from "../lib/nativePluginArchive";

const review = { reviewId: "a".repeat(32), id: "home-assistant", version: "0.2.0", protocolVersion: 1, runtime: "node" as const,
  identity: "b".repeat(64), archiveSha256: "c".repeat(64), files: 11, bytes: 100000, collision: false, runtimeStatus: "detected" as const, runtimeVersion: "22.18.0" };
function Example({ state = "inspect" }: { state?: "inspect" | "invalid" | "replace" | "busy" | "error" | "runtime-missing" | "registry-unavailable" }) {
  const [view, setView] = useState<ArchiveView>({ ...EMPTY_ARCHIVE,
    review: state === "invalid" || state === "registry-unavailable" ? null : { ...review, collision: state === "replace", runtimeStatus: state === "runtime-missing" ? "not_found" : "detected" },
    busy: state === "busy", error: state === "registry-unavailable" ? "Registry install requests are not available in this build: no trusted signed release resolver is configured. Nothing was downloaded or installed. Use Install from… → Local .zdx for a separately obtained archive; local archives remain unsigned and unverified." : state === "invalid" ? "This is not a supported .zdx ZIP. Use a complete root-layout prebuilt plugin with no links, ambiguous paths or ZIP extras."
      : state === "error" ? "The package could not be published without replacing existing files. Nothing was overwritten; refresh the catalog before trying again." : null });
  return <><p>Storybook simulation only. No files are installed, trusted or enabled.</p>
    <PluginArchiveDialog view={view} onCancel={() => setView(EMPTY_ARCHIVE)} onInstall={() => setView({ ...EMPTY_ARCHIVE, error: "Fixture install refused. No native files were written." })} /></>;
}
const meta = { title: "Settings/Local archive", component: Example, args: { state: "inspect" } } satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
const verifyReview: Story["play"] = async ({ canvasElement }) => {
  const dialog = canvasElement.querySelector<HTMLDialogElement>("dialog")!;
  await expect(dialog).toBeVisible();
  const ui = within(dialog);
  await expect(ui.getByText(/Local custom archive/)).toBeVisible();
  await expect(ui.getByText("Not a sandbox.")).toBeVisible();
  await expect(ui.getByRole("button", { name: "Install disabled" })).toBeEnabled();
  await userEvent.click(ui.getByText("Local integrity details"));
  await expect(ui.getByText(review.archiveSha256)).toBeVisible();
  const bounds = dialog.getBoundingClientRect();
  await expect(bounds.left).toBeGreaterThanOrEqual(0);
  await expect(bounds.right).toBeLessThanOrEqual(window.innerWidth);
  await expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
};
export const Inspect: Story = { play: verifyReview };
export const Narrow: Story = { globals: { viewport: { value: "mobile1", isRotated: false } }, play: verifyReview };
export const Invalid: Story = { args: { state: "invalid" }, play: async ({ canvasElement }) => {
  const ui = within(canvasElement.querySelector("dialog")!); await expect(ui.getByRole("alert")).toBeVisible();
  await expect(ui.getByRole("button", { name: "Install disabled" })).toBeDisabled();
  await userEvent.click(ui.getByRole("button", { name: "Cancel" }));
  await expect(canvasElement.querySelector("dialog")).not.toBeVisible();
} };
export const ReplaceRefused: Story = { args: { state: "replace" }, play: async ({ canvasElement }) => {
  const dialog = canvasElement.querySelector("dialog")!; const ui = within(dialog);
  const alert = ui.getByRole("alert"); await expect(alert).toHaveTextContent("Nothing will be replaced");
  await expect(ui.getByRole("button", { name: "Install disabled" })).toBeDisabled();
  // A missing left border reads as a clipped edge; keep all four sides equal and inside the dialog.
  const alertEl = canvasElement.querySelector("[role=alert]")!; const s = getComputedStyle(alertEl);
  await expect([s.borderLeftWidth, s.borderLeftStyle, s.borderLeftColor]).toEqual([s.borderRightWidth, s.borderRightStyle, s.borderRightColor]);
  const box = alertEl.getBoundingClientRect(); const frame = dialog.getBoundingClientRect();
  await expect(box.left).toBeGreaterThanOrEqual(frame.left);
  await expect(box.right).toBeLessThanOrEqual(frame.right);
} };
export const Busy: Story = { args: { state: "busy" }, play: async ({ canvasElement }) => {
  const dialog = canvasElement.querySelector<HTMLDialogElement>("dialog")!; const ui = within(dialog);
  await expect(ui.getByRole("button", { name: "Install disabled" })).toBeDisabled();
  await expect(ui.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await userEvent.keyboard("{Escape}"); await expect(dialog).toBeVisible();
} };
export const Error: Story = { args: { state: "error" } };
export const RegistryUnavailable: Story = { args: { state: "registry-unavailable" }, play: async ({ canvasElement }) => {
  const ui = within(canvasElement.querySelector("dialog")!);
  await expect(ui.getByRole("heading", { name: "Plugin installation unavailable" })).toBeVisible();
  await expect(ui.getByRole("alert")).toHaveTextContent("Nothing was downloaded or installed.");
  await expect(ui.getByRole("button", { name: "Install disabled" })).toBeDisabled();
} };
export const RuntimeMissing: Story = { args: { state: "runtime-missing" }, play: async ({ canvasElement }) => {
  const ui = within(canvasElement.querySelector("dialog")!);
  await expect(ui.getByText(/Install is allowed/)).toBeVisible();
  await expect(ui.getByRole("button", { name: "Install disabled" })).toBeEnabled();
} };
export const CancelAndFocus: Story = { play: async ({ canvasElement }) => {
  const dialog = canvasElement.querySelector<HTMLDialogElement>("dialog")!;
  await expect(dialog.contains(document.activeElement)).toBe(true);
  // Synthetic keyboard events do not trigger the browser's native dialog cancel action.
  dialog.dispatchEvent(new Event("cancel", { cancelable: true, bubbles: true }));
  await waitFor(() => expect(dialog).not.toBeVisible());
} };
