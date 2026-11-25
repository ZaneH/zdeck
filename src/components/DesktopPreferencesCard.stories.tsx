import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { mockDesktopPreferences } from "../../.storybook/desktopPreferences";
import { DesktopPreferencesCard } from "./DesktopPreferencesCard";

const meta = {
  title: "Settings/Closing zDeck",
  component: DesktopPreferencesCard,
  decorators: [(Story) => <div style={{ width: 720, maxWidth: "100%" }}><Story /></div>],
  beforeEach: ({ parameters }) => mockDesktopPreferences(parameters.preferenceFixture),
} satisfies Meta<typeof DesktopPreferencesCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const OffByDefault: Story = {
  play: async ({ canvasElement }) => {
    const checkbox = within(canvasElement).getByRole("checkbox");
    await waitFor(() => expect(checkbox).toBeEnabled());
    await expect(checkbox).not.toBeChecked();
    await userEvent.click(checkbox);
    await waitFor(() => expect(checkbox).toBeChecked());
    await userEvent.click(checkbox);
    await waitFor(() => expect(checkbox).not.toBeChecked());
  },
};
export const On: Story = {
  parameters: { preferenceFixture: "on" },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(within(canvasElement).getByRole("checkbox")).toBeChecked());
  },
};
export const OptionalHelp: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const help = canvas.getByRole("button", { name: "Closing behavior help" });
    await expect(canvas.queryByRole("tooltip")).not.toBeInTheDocument();
    await userEvent.hover(help);
    await expect(canvas.getByRole("tooltip")).toBeVisible();
    await expect(help).not.toHaveAttribute("title");
    await userEvent.unhover(help);
    await expect(canvas.queryByRole("tooltip")).not.toBeInTheDocument();
    help.focus();
    await waitFor(() => expect(canvas.getByRole("tooltip")).toBeVisible());
    await userEvent.keyboard("{Escape}");
    await expect(canvas.queryByRole("tooltip")).not.toBeInTheDocument();
  },
};
export const Loading: Story = {
  parameters: { preferenceFixture: "loading" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("checkbox")).toBeDisabled();
    await expect(within(canvasElement).queryByRole("status")).not.toBeInTheDocument();
  },
};
export const Saving: Story = {
  parameters: { preferenceFixture: "saving" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const checkbox = canvas.getByRole("checkbox");
    await waitFor(() => expect(checkbox).toBeEnabled());
    await userEvent.click(checkbox);
    await expect(checkbox).toBeDisabled();
    await expect(checkbox).not.toBeChecked();
    await expect(canvas.queryByRole("status")).not.toBeInTheDocument();
  },
};
export const FailedSave: Story = {
  parameters: { preferenceFixture: "failed" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const checkbox = canvas.getByRole("checkbox");
    await waitFor(() => expect(checkbox).toBeEnabled());
    await userEvent.click(checkbox);
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Preference was not saved.");
    await expect(checkbox).not.toBeChecked();
    await expect(checkbox).toBeEnabled();
  },
};
export const Narrow: Story = { decorators: [(Story) => <div style={{ width: 320, maxWidth: "100%" }}><Story /></div>] };
