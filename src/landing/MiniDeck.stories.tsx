import type { Meta, StoryObj } from "@storybook/react-vite";
import { MiniDeck } from "./MiniDeck";

const meta = {
  title: "Landing/Mini deck",
  component: MiniDeck,
  parameters: { layout: "padded" },
} satisfies Meta<typeof MiniDeck>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div style={{ maxWidth: 420 }}>
      <MiniDeck />
    </div>
  ),
};
