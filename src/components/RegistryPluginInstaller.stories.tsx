import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { PluginArchiveDialog } from "./PluginArchiveInstaller";
import { EMPTY_ARCHIVE, type ArchiveView, type RegistryRelease } from "../lib/nativePluginArchive";

const id = "fixture-only-" + "long-id-".repeat(6);
const release: RegistryRelease = { schema: 1, id, version: "1.2.3", artifact: { url: `https://artifacts.example.test/${id}/immutable/1.2.3.zdx`, sha256: "c".repeat(64), bytes: 100000 }, compatibility: { protocol: 1, runtime: "node", minimum: "22.18.0", platforms: ["macos", "windows", "linux"] }, source: { repo: `https://source.example.test/${id}`, commit: "d".repeat(40), license: "MIT" } };
function Example({ state = "intent" }: { state?: "intent" | "metadata" | "lookup-busy" | "download-busy" | "error" | "archive" }) {
  const [view, setView] = useState<ArchiveView>({ ...EMPTY_ARCHIVE,
    registry: { reviewId: "a".repeat(32), id, version: "1.2.3", keyId: state === "intent" || state === "lookup-busy" ? null : "fixture-only", release: state === "intent" || state === "lookup-busy" ? null : release },
    busy: state === "lookup-busy" || state === "download-busy", error: state === "error" ? "The downloaded archive does not match the signed size and SHA-256. Nothing was installed." : null,
    review: state === "archive" ? { reviewId: "a".repeat(32), id, version: "1.2.3", protocolVersion: 1, runtime: "node", identity: "b".repeat(64), archiveSha256: "c".repeat(64), files: 2, bytes: 100000, collision: false, runtimeStatus: "not_found", runtimeVersion: null } : null,
  });
  return <><p>Fixture-only simulation. No network, installation or plugin execution.</p><PluginArchiveDialog view={view} onCancel={() => setView(EMPTY_ARCHIVE)} onInstall={() => setView({ ...EMPTY_ARCHIVE, error: "Fixture only; no files were installed." })} onResolve={() => setView(current => current.registry ? { ...current, registry: { ...current.registry, keyId: "fixture-only", release } } : current)} /></>;
}
const meta = { title: "Settings/Registry release", component: Example } satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Intent: Story = { play: async ({ canvasElement }) => {
  const ui = within(canvasElement.querySelector("dialog")!);
  await expect(ui.getByRole("button", { name: "Look up release" })).toBeEnabled();
  await expect(ui.queryByRole("button", { name: "Install disabled" })).toBeNull();
  await userEvent.click(ui.getByRole("button", { name: "Look up release" }));
  await expect(ui.getByRole("button", { name: "Download for review" })).toBeEnabled();
  await expect(ui.getByText(/not a safety review/)).toBeVisible();
} };
export const Metadata: Story = { args: { state: "metadata" } };
export const Narrow: Story = { args: { state: "metadata" }, globals: { viewport: { value: "mobile1", isRotated: false } }, play: async ({ canvasElement }) => {
  const dialog = canvasElement.querySelector("dialog")!;
  await expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth + 1);
  await expect(within(dialog).getByText(release.source.commit)).toBeVisible();
} };
const cancellableBusy: Story["play"] = async ({ canvasElement }) => {
  const dialog = canvasElement.querySelector("dialog")!; const ui = within(dialog);
  await expect(dialog).toHaveAttribute("aria-busy", "true");
  await expect(ui.getByRole("button", { name: /Look up release|Download for review/ })).toBeDisabled();
  await expect(ui.getByRole("button", { name: "Cancel" })).toBeEnabled();
  await userEvent.click(ui.getByRole("button", { name: "Cancel" }));
  await expect(dialog).not.toBeVisible();
};
export const LookupBusy: Story = { args: { state: "lookup-busy" }, play: cancellableBusy };
export const DownloadBusy: Story = { args: { state: "download-busy" }, play: cancellableBusy };
export const DigestError: Story = { args: { state: "error" }, play: async ({ canvasElement }) => {
  const ui = within(canvasElement.querySelector("dialog")!);
  await expect(ui.getByRole("alert")).toHaveTextContent("Nothing was installed.");
  await expect(ui.queryByRole("button", { name: "Install disabled" })).toBeNull();
} };
export const ArchiveReview: Story = { args: { state: "archive" }, play: async ({ canvasElement }) => {
  const ui = within(canvasElement.querySelector("dialog")!);
  await expect(ui.getByRole("button", { name: "Install disabled" })).toBeEnabled();
  await expect(ui.getByText(/Signed registry archive/)).toBeVisible();
  await expect(ui.getByText("disabled and untrusted")).toBeVisible();
  await expect(ui.queryByRole("button", { name: "Download for review" })).toBeNull();
} };
