import type { Meta, StoryObj } from "@storybook/react-vite";
import { ACCENTS } from "../lib/types";
import { LandingPage } from "./LandingPage";

const meta = {
  title: "Landing/One-pager",
  component: LandingPage,
  parameters: { layout: "fullscreen" },
  args: { initialAccent: ACCENTS[0].value, initialTab: "deck" },
} satisfies Meta<typeof LandingPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const PluginSdkOpen: Story = {
  args: { initialTab: "sdk" },
};

export const Mobile: Story = {
  render: (args) => (
    <div style={{ maxWidth: 390, margin: "0 auto", border: "1px solid var(--border)" }}>
      <LandingPage {...args} />
    </div>
  ),
};
