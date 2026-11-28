import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor } from "storybook/test";
import { ControlTile } from "./ControlTile";
import type { Control, Presentation } from "../lib/types";
import type { PluginSnapshots } from "../lib/plugin";

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
const presentationPlugins: PluginSnapshots = { mixer: { status: "connected", lastError: null, state: { powered: false },
  manifest: { id: "mixer", version: "1.0.0", protocolVersion: 1, actions: [
    { id: "level", title: "Monitor level", config: { amount: { type: "integer", minimum: -20, maximum: 100, control: { step: 5 } } } },
    { id: "power", title: "Monitor power", config: { enabled: { type: "boolean", control: { stateKey: "powered" } } } },
  ] },
} };
function PresentationExample({ presentation, busy = false, disabled = false, unknown = false }: { presentation: Presentation; busy?: boolean; disabled?: boolean; unknown?: boolean }) {
  const [plugins, setPlugins] = useState(presentationPlugins);
  const [target, setTarget] = useState<number | null>(null);
  const boolean = presentation.startsWith("toggle");
  const control: Control = boolean
    ? { id: presentation, label: "Monitor power", action: "plugin", pluginId: "mixer", pluginAction: "power", pluginArgs: { enabled: false }, presentation }
    : { id: presentation, label: "Monitor level", action: "plugin", pluginId: "mixer", pluginAction: "level", pluginArgs: { amount: 50 }, presentation };
  const snapshots = unknown ? { mixer: { ...plugins.mixer, state: {} } } : plugins;
  return <div style={{ width: "100%", maxWidth: 240 }}>
    <div className="control-grid" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
    <ControlTile control={control} plugins={snapshots} variant="phone" semantics="remote" volume={50} disabled={disabled} busy={busy}
      onPrimary={() => setTarget(50)} onVolumeCommit={(value) => {
        setTarget(value);
        if (boolean) setPlugins({ mixer: { ...plugins.mixer, state: { powered: value === 1 } } });
      }} />
    </div>
    <p className="field-note">Local demo only. {target === null ? "No target sent." : `Last target: ${target}`}</p>
  </div>;
}
export const AllPresentations: Story = { render: () => <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 16, maxWidth: 1000 }}>
  {(["button", "slider", "dial", "toggle-switch", "toggle-button"] as const).map(presentation => <PresentationExample key={presentation} presentation={presentation} />)}
</div> };
export const Button: Story = { render: () => <PresentationExample presentation="button" /> };
export const Slider: Story = { render: () => <PresentationExample presentation="slider" /> };
export const Dial: Story = { render: () => <PresentationExample presentation="dial" /> };
export const MacintoshDialAlignment: Story = {
  render: () => <div style={{ display: "grid", gap: 24, maxWidth: 400 }}>
    {(["editor", "phone"] as const).map(variant => <section key={variant} className="deck-section" data-appearance="macintosh">
      <div className={variant === "phone" ? "phone-grid" : "control-grid"}
        style={{ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
        <ControlTile control={{ ...controls[3], label: "Volume", presentation: "dial" }} variant={variant} appearance="macintosh" volume={50} />
        <ControlTile control={{ id: "power", label: "Power", action: "plugin", pluginId: "mixer", pluginAction: "power", pluginArgs: { enabled: false } }}
          plugins={presentationPlugins} variant={variant} appearance="macintosh" volume={50} />
      </div>
    </section>)}
  </div>,
  play: async ({ canvasElement }) => {
    await document.fonts.ready;
    const center = (element: Element) => {
      const box = element.getBoundingClientRect();
      return box.top + box.height / 2;
    };
    for (const grid of canvasElement.querySelectorAll(".control-grid, .phone-grid")) {
      const dialTile = grid.querySelector('[data-presentation="dial"]')!;
      const button = grid.querySelector('[data-presentation="button"]')!;
      const dial = dialTile.querySelector<HTMLElement>(".dial-face")!;
      const readout = dialTile.querySelector(".volume-readout")!;
      expect(Math.abs(center(dialTile.querySelector(".tile-icon")!) - center(button.querySelector(".tile-icon")!))).toBeLessThan(1);
      expect(Math.abs(center(readout) - center(button.querySelector(".tile-label")!))).toBeLessThan(1);
      expect(Math.abs(center(dial) - center(readout))).toBeLessThan(1);
      const bounds = dialTile.getBoundingClientRect();
      expect(dial.getBoundingClientRect().top).toBeGreaterThan(bounds.top);
      expect(dial.getBoundingClientRect().bottom).toBeLessThan(bounds.bottom);
      expect(dial.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    }
  },
};
export const ToggleSwitch: Story = { render: () => <PresentationExample presentation="toggle-switch" /> };
export const ToggleButton: Story = { render: () => <PresentationExample presentation="toggle-button" /> };
export const PresentationStates: Story = { render: () => <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
  <PresentationExample presentation="slider" busy />
  <PresentationExample presentation="dial" disabled />
  <PresentationExample presentation="toggle-switch" unknown />
  <PresentationExample presentation="toggle-button" disabled />
</div> };
export const BriefCommandGating: Story = {
  render: () => <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12, maxWidth: 700 }}>
    {([controls[0], { ...controls[3], id: "blocked-slider", presentation: "slider" }, { ...controls[3], presentation: "dial" },
      { id: "power", action: "plugin", label: "Power", pluginId: "mixer", pluginAction: "power", pluginArgs: { enabled: false }, presentation: "toggle-switch" },
    ] as Control[]).map(control => <ControlTile key={control.id} control={control} plugins={presentationPlugins}
      variant="phone" semantics="remote" volume={50} disabled transientDisabled />)}
    <ControlTile control={{ id: "unknown-power", action: "plugin", label: "Unknown power", pluginId: "mixer", pluginAction: "power", pluginArgs: { enabled: false }, presentation: "toggle-switch" }}
      plugins={{ mixer: { ...presentationPlugins.mixer, state: {} } }} variant="phone" semantics="remote" volume={50} disabled transientDisabled />
  </div>,
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      for (const tile of canvasElement.querySelectorAll(".control-tile")) expect(getComputedStyle(tile).opacity).toBe("1");
    });
    expect(canvasElement.querySelector<HTMLButtonElement>("button.tile-primary")!.disabled).toBe(true);
    const slider = canvasElement.querySelector<HTMLInputElement>('input[type="range"]:not([hidden])')!;
    expect(slider.disabled).toBe(true);
    expect(getComputedStyle(slider).opacity).toBe("1");
    const dial = canvasElement.querySelector<HTMLElement>(".dial-face")!;
    expect(dial.getAttribute("aria-disabled")).toBe("true");
    expect(getComputedStyle(dial).opacity).toBe("1");
    const toggle = canvasElement.querySelector<HTMLButtonElement>(".tile-toggle")!;
    expect(toggle.disabled).toBe(true);
    expect(getComputedStyle(toggle).opacity).toBe("1");
    const unknown = canvasElement.querySelector<HTMLButtonElement>(".control-tile:last-child .tile-toggle")!;
    expect(unknown.disabled).toBe(true);
    expect(unknown.textContent).toContain("State unknown");
    expect(getComputedStyle(unknown).opacity).toBe("0.55");
  },
};
export const NarrowVolume: Story = { render: () => <div style={{ width: 240, maxWidth: "100%" }}><TileExample control={controls[3]} /></div> };
