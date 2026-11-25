import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ControlTile } from "./ControlTile";
import type { Control } from "../lib/types";

const controls: Control[] = [
  { id: "story-scene", action: "obs-scene", label: "Camera", scene: "Camera" },
  { id: "story-mic", action: "mic-mute", label: "Microphone" },
  { id: "story-media", action: "media-play-pause", label: "Play / pause" },
  { id: "story-volume", action: "volume", label: "Speakers", volume: 50 },
  { id: "story-plugin", action: "plugin", label: "Spotify · next", pluginId: "spotify", pluginAction: "next", pluginArgs: {} },
];
function TileExample({ control, disabled = false, selected = false }: { control: Control; disabled?: boolean; selected?: boolean }) {
  const [volume, setVolume] = useState(control.action === "volume" ? control.volume : 50);
  const [presses, setPresses] = useState(0);
  const [commits, setCommits] = useState(0);
  return <div>
    <ControlTile control={control} variant={selected ? "editor" : "phone"} selected={selected} volume={volume}
      disabled={disabled} onPrimary={() => setPresses((n) => n + 1)} onVolumeChange={setVolume}
      onVolumeCommit={() => setCommits((n) => n + 1)} />
    <p className="field-note" role="status">Local only · presses {presses} · volume commits {commits}</p>
  </div>;
}
const meta = { title: "Controls/Control tile", component: ControlTile,
  args: { control: controls[0], variant: "phone", volume: 50 },
  parameters: { layout: "padded" } } satisfies Meta<typeof ControlTile>;
export default meta;
type Story = StoryObj<typeof meta>;
export const AllActions: Story = { render: () => <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, maxWidth: 900 }}>
  {controls.map((control) => <TileExample key={control.id} control={control} />)}
</div> };
export const Busy: Story = { args: { busy: true, disabled: true, semantics: "remote" },
  decorators: [(Story) => <div style={{ maxWidth: 240 }}><Story /></div>] };
export const Disabled: Story = { render: () => <div style={{ maxWidth: 240 }}><TileExample control={controls[1]} disabled /></div> };
export const SelectedEditor: Story = { render: () => <div style={{ maxWidth: 240 }}><TileExample control={controls[0]} selected /></div> };
export const LongLabel: Story = { render: () => <div style={{ width: 200, maxWidth: "100%" }}>
  <TileExample control={{ ...controls[0], label: "A deliberately long control label to check wrapping and truncation" }} />
</div> };
export const NarrowVolume: Story = { render: () => <div style={{ width: 240, maxWidth: "100%" }}><TileExample control={controls[3]} /></div> };
