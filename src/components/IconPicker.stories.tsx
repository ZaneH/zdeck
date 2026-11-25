import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { Control } from "../lib/types";
import type { PluginManifest } from "../lib/plugin";
import { createDefaultDeck, updateControl } from "../lib/deck";
import { IconPicker } from "./IconPicker";
import { ControlTile } from "./ControlTile";

const svg = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="4" fill="#6ee7b7"/><path d="m9 6 9 6-9 6Z" fill="#151719"/></svg>');
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const manifests: PluginManifest[] = [
  { id: "player", version: "0.1.0", protocolVersion: 1, actions: [{ id: "play", title: "Play", config: {} }],
    icons: [{ id: "play", title: "Play badge", category: "Media", src: svg }, { id: "pixel", title: "White pixel (PNG)", category: "General", src: png }] },
  { id: "studio", version: "0.1.0", protocolVersion: 1, actions: [{ id: "cue", title: "Cue", config: {} }],
    icons: [{ id: "cue", title: "Cue", category: "Media", src: svg }] },
];
const meta = { title: "Controls/Icon picker", component: IconPicker,
  args: { control: createDefaultDeck().pages[0].controls[0], manifests, onPatch: () => {} },
  parameters: { layout: "padded" },
} satisfies Meta<typeof IconPicker>;
export default meta;
type Story = StoryObj<typeof meta>;

function Example({ control, manifests }: { control: Control; manifests: PluginManifest[] }) {
  const [deck, setDeck] = useState(() => {
    const deck = createDefaultDeck();
    deck.pages[0].controls[0] = control;
    return deck;
  });
  const current = deck.pages[0].controls[0];
  return <div style={{ display: "grid", gap: 16, maxWidth: 360 }}>
    <ControlTile control={current} variant="phone" volume={50} />
    <IconPicker control={current} manifests={manifests} onPatch={(patch) => setDeck((deck) => updateControl(deck, deck.activePageId, current.id, patch))} />
  </div>;
}
export const PluginPacks: Story = { render: (args) => <Example {...args} /> };
export const BuiltinsOnly: Story = { args: { manifests: [] }, render: (args) => <Example {...args} /> };
export const SavedImageWithoutPlugin: Story = { args: { manifests: [], control: { ...meta.args.control, icon: { type: "image", src: svg } } }, render: (args) => <Example {...args} /> };
export const UnreadableImageFallback: Story = { args: { manifests: [], control: { ...meta.args.control, icon: { type: "image", src: "data:image/png;base64,AAAA" } } }, render: (args) => <Example {...args} /> };
