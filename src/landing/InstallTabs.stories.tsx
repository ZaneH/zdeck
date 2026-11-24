import type { Meta, StoryObj } from "@storybook/react-vite";
import { InstallTabs } from "./InstallTabs";

const meta = {
  title: "Landing/Install tabs",
  component: InstallTabs,
  parameters: { layout: "padded" },
  args: { defaultOs: "macos" },
} satisfies Meta<typeof InstallTabs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: (args) => (
    <div style={{ maxWidth: 460 }}>
      <InstallTabs {...args} />
    </div>
  ),
};
