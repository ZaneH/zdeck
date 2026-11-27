import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { addControl, createDefaultDeck, removeControl } from "../lib/deck";
import { addSection, removeSection } from "../lib/sections";
import { deriveTrash } from "../lib/trash";
import type { TrashEntry } from "../lib/trash";
import { DeckTrash } from "./DeckTrash";

const deck = createDefaultDeck();
const withSection = addSection(deck, "page_stream", null, "Audio")!;
const withControl = addControl(withSection.deck, "page_stream", "mic-mute", undefined, withSection.section.id)!;
const deletedSection = removeSection(withControl.deck, "page_stream", withSection.section.id);
const sectionTrash = deriveTrash(withControl.deck, deletedSection, [], 2000);
const deletedControl = removeControl(deletedSection, "page_stream", "ctl_mic");
const entries = deriveTrash(deletedSection, deletedControl, sectionTrash, 3000);

const meta = {
  title: "Workspace/Trash",
  component: DeckTrash,
  args: { entries, onRestore: fn((_: TrashEntry): string | null => null) },
} satisfies Meta<typeof DeckTrash>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Grouped: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: "Trash" });
    await userEvent.click(trigger);
    const dialog = await canvas.findByRole("dialog", { name: "Trash" });
    await expect(within(dialog).getByRole("heading", { name: "Controls" })).toBeVisible();
    await expect(within(dialog).getByRole("heading", { name: "Sections" })).toBeVisible();
    await expect(within(dialog).getByRole("button", { name: "Restore Mic mute" })).toBeVisible();
    await expect(within(dialog).getByText("1 control")).toBeVisible();
    await expect(within(dialog).getByRole("button", { name: "Restore Audio" })).toBeVisible();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Restore Mic mute" })).toHaveFocus());
    await userEvent.click(within(dialog).getByRole("button", { name: "Restore Mic mute" }));
    await expect(args.onRestore).toHaveBeenCalledOnce();
    await userEvent.click(within(dialog).getByRole("button", { name: "Close trash" }));
    await waitFor(() => expect(dialog).not.toBeVisible());
    await expect(trigger).toHaveFocus();
  },
};

export const Empty: Story = {
  args: { entries: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: "Trash" });
    await userEvent.click(trigger);
    const dialog = await canvas.findByRole("dialog", { name: "Trash" });
    await expect(within(dialog).getByText("Nothing deleted yet. Removed controls and sections appear here.")).toBeVisible();
    await userEvent.click(within(dialog).getByRole("button", { name: "Close trash" }));
    await waitFor(() => expect(dialog).not.toBeVisible());
    await expect(trigger).toHaveFocus();
  },
};

export const RestoreError: Story = {
  args: { onRestore: fn((_: TrashEntry): string | null => "“Stream” already has 24 controls. Remove one before restoring.") },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Trash" }));
    const dialog = await canvas.findByRole("dialog", { name: "Trash" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Restore Mic mute" }));
    await expect(args.onRestore).toHaveBeenCalledOnce();
    await expect(within(dialog).getByRole("alert")).toHaveTextContent("Remove one before restoring");
    // The entry remains available after a refused restore.
    await expect(within(dialog).getByRole("button", { name: "Restore Mic mute" })).toBeVisible();
  },
};
