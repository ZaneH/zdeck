import { useEffect } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { applyTheme } from "../lib/theme";
import { ACCENTS } from "../lib/types";
import type { Control, Deck } from "../lib/types";
import { PhoneDeck } from "./PhoneDeck";
import type { PluginSnapshots } from "../lib/plugin";
import { ControlTile } from "./ControlTile";

const controls: Control[] = [
  { id: "glass-scene", action: "obs-scene", label: "Camera", scene: "Camera" },
  { id: "glass-mic", action: "mic-mute", label: "Mic" },
  { id: "glass-volume", action: "volume", label: "Volume", volume: 64 },
  { id: "glass-toggle", action: "plugin", label: "Studio mute", pluginId: "studio", pluginAction: "mute", pluginArgs: { enabled: false }, presentation: "toggle-switch" },
  { id: "glass-value", action: "plugin", label: "Input level", pluginId: "studio", pluginAction: "level", pluginArgs: { level: 50 }, presentation: "value" },
];

const plugins: PluginSnapshots = {
  studio: {
    status: "connected",
    lastError: null,
    state: {
      muted: true,
      levels: [{ value: 50, label: "Input", available: true, observation: { value: 50, unit: "%", observedAtMs: 1_700_000_000_000 } }],
    },
    manifest: {
      id: "studio", version: "1.0.0", protocolVersion: 1,
      actions: [
        { id: "mute", title: "Studio mute", config: { enabled: { type: "boolean", control: { stateKey: "muted" } } } },
        { id: "level", title: "Input level", config: { level: { type: "integer", minimum: 0, maximum: 100, choicesKey: "levels" } } },
      ],
      values: [
        { id: "level", title: "Input level", config: { level: { type: "integer", minimum: 0, maximum: 100, choicesKey: "levels" } }, stateKey: "levels", entityKey: "level" },
      ],
    },
  },
};

function GlassPhoneFixture() {
  useEffect(() => { applyTheme("glass", ACCENTS[0].value); }, []);
  return <div style={{ width: 390, maxWidth: "100%", height: 760, overflow: "hidden", borderRadius: 40, background: "var(--bg)", backgroundImage: "var(--app-bg-image)", border: "1px solid rgba(255,255,255,.28)" }}>
    <main className="phone-main" style={{ height: "100%" }}>
      <div className="phone-page-heading"><h1>Studio</h1></div>
      <section className="phone-section" data-theme="glass" data-appearance="glass">
        <h2 className="section-heading">Control Center</h2>
        <div className="phone-grid">
          {controls.map((control) => <ControlTile key={control.id} control={control} plugins={plugins} variant="phone" appearance="glass" volume={64} />)}
        </div>
      </section>
    </main>
  </div>;
}

const meta = {
  title: "Workspace/Glass phone",
  component: GlassPhoneFixture,
  parameters: { layout: "centered" },
} satisfies Meta<typeof GlassPhoneFixture>;
export default meta;
type Story = StoryObj<typeof meta>;

const savedDeck: Deck = {
  version: 3, theme: "dark", accent: ACCENTS[0].value, activePageId: "stream",
  pages: [{ id: "stream", name: "Stream", sections: [{
    id: "stream-controls", name: "Stream", theme: "glass",
    controls: [
      { id: "saved-mic", action: "mic-mute", label: "Microphone", columnSpan: 1, rowSpan: 1,
        icon: { type: "image", src: "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M9 18V6l10-2v12M9 18c0 3-6 3-6 0s6-3 6 0Zm10-2c0 3-6 3-6 0s6-3 6 0Z" fill="none" stroke="white" stroke-width="2"/></svg>') } },
      { id: "saved-play", action: "media-play-pause", label: "Play / pause", columnSpan: 1, rowSpan: 1 },
      { id: "saved-scene", action: "obs-scene", label: "Screen w Cam", scene: "Camera", columnSpan: 2, rowSpan: 2 },
      { id: "saved-volume", action: "volume", label: "Volume", volume: 64 },
    ],
  }] }],
};

export const SavedLayoutInDarkDeck: Story = {
  render: () => <PhoneDeck initialDeck={savedDeck} initialStatus="loaded" mode="native" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const shell = canvasElement.querySelector<HTMLElement>(".phone-shell")!;
    await expect(shell).toHaveAttribute("data-appearance", "glass");
    await expect(getComputedStyle(shell).backgroundImage).toContain("radial-gradient");
    await expect(getComputedStyle(shell).backgroundColor).toBe("rgb(21, 23, 27)");
    await expect(getComputedStyle(shell).fontFamily).toContain("Segoe UI");
    await expect(getComputedStyle(canvasElement.querySelector<HTMLElement>(".phone-page-heading h1")!).color).toBe("rgb(245, 246, 247)");
    const play = canvas.getByRole("button", { name: /Press Play \/ pause/ });
    await expect(play).toHaveAccessibleName(/Play \/ pause/);
    await expect(play.closest("article")).toHaveAttribute("data-shape", "circle");
    await expect(play.querySelector(".tile-label")).not.toBeVisible();
    const box = play.closest("article")!.getBoundingClientRect();
    await expect(Math.abs(box.width - box.height)).toBeLessThanOrEqual(2);
    await expect(box.width).toBeGreaterThanOrEqual(44);
    const image = canvasElement.querySelector<HTMLImageElement>('.control-icon-image')!;
    await expect(image.getBoundingClientRect().width).toBe(28);
    await expect(image.getBoundingClientRect().height).toBe(28);
    await expect(getComputedStyle(canvasElement.querySelector<HTMLElement>('[data-redundant="true"]')!).clipPath).toBe("inset(50%)");
  },
};

export const ControlCenter: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const grid = canvasElement.querySelector<HTMLElement>(".phone-grid");
    expect(getComputedStyle(grid!).gridTemplateColumns.split(" ")).toHaveLength(4);

    // Circular controls are icon-only, but keep their accessible name and a bigger icon.
    const mic = canvasElement.querySelector<HTMLElement>('[data-action="mic-mute"]')!;
    expect(getComputedStyle(mic).borderRadius).toBe("50%");
    const micButton = canvas.getByRole("button", { name: /Press Mic/ });
    expect(micButton).toHaveAccessibleName(/Press Mic/);
    expect(getComputedStyle(micButton.querySelector<HTMLElement>(".tile-label")!).display).toBe("none");
    expect(micButton.querySelector("svg")!.getBoundingClientRect().width).toBeGreaterThanOrEqual(24);

    // Larger modules and toggle capsules keep their visible labels.
    expect(getComputedStyle(canvasElement.querySelector<HTMLElement>('[data-action="obs-scene"] .tile-label')!).display).not.toBe("none");
    expect(getComputedStyle(canvasElement.querySelector<HTMLElement>('[data-presentation="toggle-switch"] .tile-label')!).display).not.toBe("none");

    // The whole pill is the vertical native range; no inner rail and no visible thumb.
    const volume = canvasElement.querySelector<HTMLElement>('[data-action="volume"]')!;
    expect(getComputedStyle(volume).borderRadius).toBe("999px");
    expect(getComputedStyle(volume).gridRowStart).toBe("span 2");
    const input = canvas.getByRole("slider");
    expect(volume.querySelector<HTMLElement>(".tile-label")!).not.toBeVisible();
    const tileBox = volume.getBoundingClientRect();
    const inputBox = input.getBoundingClientRect();
    expect(Math.abs(inputBox.height - tileBox.height)).toBeLessThanOrEqual(2);
    expect(Math.abs(inputBox.width - tileBox.width)).toBeLessThanOrEqual(2);
    expect(inputBox.height).toBeGreaterThan(inputBox.width);
    expect(getComputedStyle(input).writingMode).toBe("vertical-lr");
    expect(input).toHaveAttribute("aria-orientation", "vertical");
    expect(getComputedStyle(input).backgroundImage).toContain("linear-gradient");
    expect(getComputedStyle(volume).getPropertyValue("--control-fill").trim()).toBe("64%");
    const volumeIcon = volume.querySelector<HTMLElement>(".tile-icon")!.getBoundingClientRect();
    expect(volumeIcon.top).toBeGreaterThan(tileBox.top + tileBox.height / 2);
    expect(volumeIcon.width).toBeGreaterThanOrEqual(28);

    // Keyboard and focus behaviour is exercised against the real phone in browser-smoke.mjs.

    const toggle = canvasElement.querySelector<HTMLElement>('[data-presentation="toggle-switch"]');
    expect(getComputedStyle(toggle!).backgroundImage).toContain("linear-gradient");
  },
};
