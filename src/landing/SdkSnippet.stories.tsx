import type { Meta, StoryObj } from "@storybook/react-vite";
import { SdkSnippet } from "./SdkSnippet";

const meta = {
  title: "Landing/Plugin SDK snippet",
  component: SdkSnippet,
  parameters: { layout: "padded" },
} satisfies Meta<typeof SdkSnippet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div style={{ maxWidth: 480 }}>
      <SdkSnippet />
    </div>
  ),
};
