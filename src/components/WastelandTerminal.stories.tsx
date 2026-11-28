import { useEffect } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { applyTheme } from "../lib/theme";
import { ACCENTS, PRESENTATIONS } from "../lib/types";
import type { Control } from "../lib/types";
import type { PluginSnapshots } from "../lib/plugin";
import { ControlTile } from "./ControlTile";

const controls: Control[] = [
  { id: "terminal-button", action: "obs-scene", label: "Signal relay", scene: "Signal" },
  { id: "terminal-slider", action: "volume", label: "Output", volume: 68 },
  { id: "terminal-dial", action: "volume", label: "Gain", volume: 42, presentation: "dial" },
  { id: "terminal-switch", action: "plugin", label: "Mute bus", pluginId: "terminal", pluginAction: "mute", pluginArgs: { enabled: true }, presentation: "toggle-switch" },
  { id: "terminal-toggle", action: "plugin", label: "Arm relay", pluginId: "terminal", pluginAction: "arm", pluginArgs: { armed: false }, presentation: "toggle-button" },
  { id: "terminal-value", action: "plugin", label: "Radiation", pluginId: "terminal", pluginAction: "level", pluginArgs: { level: 62 }, presentation: "value" },
  { id: "terminal-disabled", action: "media-play-pause", label: "Transport offline" },
  { id: "terminal-unknown", action: "plugin", label: "Coolant", pluginId: "unknown", pluginAction: "mute", pluginArgs: { enabled: false }, presentation: "toggle-switch" },
  { id: "terminal-failed", action: "plugin", label: "Reactor", pluginId: "failed", pluginAction: "level", pluginArgs: { level: 10 }, presentation: "value" },
];

const levelConfig = { level: { type: "integer" as const, minimum: 0, maximum: 100, control: { step: 1 }, choicesKey: "levels" } };
const valueAction = { id: "level", title: "Input level", config: levelConfig, stateKey: "levels", entityKey: "level" };
const plugins: PluginSnapshots = {
  terminal: {
    status: "connected",
    lastError: null,
    state: {
      muted: true,
      armed: false,
      levels: [{ value: 62, label: "Input", available: true, observation: { value: 62, unit: "%", observedAtMs: 1_700_000_000_000 } }],
    },
    manifest: {
      id: "terminal", version: "1.0.0", protocolVersion: 1,
      actions: [
        { id: "mute", title: "Mute bus", config: { enabled: { type: "boolean", control: { stateKey: "muted" } } } },
        { id: "arm", title: "Arm relay", config: { armed: { type: "boolean", control: { stateKey: "armed" } } } },
        { id: "level", title: "Input level", config: levelConfig },
      ],
      values: [valueAction],
    },
  },
  unknown: {
    status: "connected",
    lastError: null,
    state: {},
    manifest: {
      id: "unknown", version: "1.0.0", protocolVersion: 1,
      actions: [{ id: "mute", title: "Mute bus", config: { enabled: { type: "boolean", control: { stateKey: "muted" } } } }],
    },
  },
  failed: {
    status: "connected",
    lastError: { kind: "plugin", code: null, outcome: "not_started", message: "Reading failed.", hint: "Check the plugin." },
    state: { levels: [] },
    manifest: { id: "failed", version: "1.0.0", protocolVersion: 1, actions: [valueAction], values: [valueAction] },
  },
};

function TerminalFixture() {
  useEffect(() => { applyTheme("terminal", ACCENTS[1].value); }, []);
  return <div style={{ display: "grid", gap: 16, maxWidth: 720 }}>
    <section className="deck-section" data-appearance="terminal" data-testid="terminal-section">
      <h2 className="section-heading">Wasteland Terminal</h2>
      <div className="control-grid">
        {controls.map((control, index) => <ControlTile key={control.id} control={control} plugins={plugins} variant="editor" appearance="terminal" volume={68} disabled={index === 6} />)}
      </div>
    </section>
    <section className="deck-section" data-theme="dark" data-appearance="dark" data-testid="dark-section">
      <h2 className="section-heading">Dark override</h2>
      <div className="control-grid"><ControlTile control={controls[0]} variant="editor" appearance="dark" volume={0} /></div>
    </section>
    <div className="phone-shell" data-appearance="terminal" data-testid="terminal-phone" style={{ width: "min(360px, 100%)", height: 620, overflow: "hidden" }}>
      <main className="phone-main">
        <div className="phone-page-heading"><h1>Relay deck</h1></div>
        <section className="phone-section" data-theme="terminal" data-appearance="terminal">
          <h2 className="section-heading">Wasteland Terminal</h2>
          <div className="phone-grid">
            {controls.map((control, index) => <ControlTile key={control.id} control={control} plugins={plugins} variant="phone" appearance="terminal" volume={68} disabled={index === 6} />)}
          </div>
        </section>
        <section className="phone-section" data-theme="dark" data-appearance="dark" data-testid="dark-phone-section">
          <h2 className="section-heading">Dark override</h2>
          <div className="phone-grid"><ControlTile control={controls[3]} plugins={plugins} variant="phone" appearance="dark" volume={0} /></div>
        </section>
      </main>
    </div>
  </div>;
}

const meta = {
  title: "Workspace/Wasteland Terminal",
  component: TerminalFixture,
  parameters: { layout: "padded" },
} satisfies Meta<typeof TerminalFixture>;
export default meta;
type Story = StoryObj<typeof meta>;

function channels(color: string): number[] {
  if (color.startsWith("#")) {
    const hex = color.slice(1);
    const full = hex.length === 3 ? [...hex].map(c => c + c).join("") : hex;
    return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16)).concat(hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1);
  }
  const values = color.match(/[\d.]+/g)!.map(Number);
  // color(srgb …) serializes 0–1 channels; rgb() uses 0–255.
  const rgb = color.startsWith("color(") ? values.slice(0, 3).map(value => value * 255) : values.slice(0, 3);
  return rgb.concat(values[3] ?? 1);
}
function colorsIn(value: string): number[][] {
  return (value.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}/gi) ?? []).map(channels);
}
function composite(foreground: number[], background: number[]): number[] {
  return foreground.slice(0, 3).map((value, index) => value * foreground[3] + background[index] * (1 - foreground[3]));
}
function luminance(rgb: number[]): number {
  const channel = (value: number) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}
function contrast(color: string, background: number[]): number {
  const [lighter, darker] = [luminance(composite(channels(color), background)), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}
function lightest(colors: number[][]): number[] {
  return colors.reduce((worst, color) => luminance(color) > luminance(worst) ? color : worst);
}

export const ControlsAndState: Story = {
  play: async ({ canvasElement }) => {
    // The Storybook toolbar decorator applies its own theme after this story mounts.
    applyTheme("terminal", ACCENTS[1].value);
    expect(document.documentElement.dataset.theme).toBe("terminal");
    expect(getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()).toBe(ACCENTS[1].value);
    const section = canvasElement.querySelector<HTMLElement>("[data-testid=terminal-section]")!;
    const sectionStyle = getComputedStyle(section);
    expect(sectionStyle.backgroundImage).toContain("repeating-linear-gradient");
    expect(sectionStyle.fontFamily).toContain("monospace");
    expect(sectionStyle.borderTopLeftRadius).toBe("10px");

    const tiles = Array.from(section.querySelectorAll<HTMLElement>(".control-tile"));
    expect(tiles).toHaveLength(controls.length);
    const presentations = tiles.map(tile => tile.dataset.presentation);
    for (const presentation of PRESENTATIONS) expect(presentations).toContain(presentation);
    for (const tile of tiles) {
      expect(getComputedStyle(tile).borderTopLeftRadius).toBe("2px");
      expect(getComputedStyle(tile).backgroundImage).toContain("repeating-linear-gradient");
      // Scanlines live on the surface, never as a full-screen overlay above the text.
      expect(getComputedStyle(tile, "::before").content).toBe("none");
      expect(getComputedStyle(tile, "::after").content).toBe("none");
    }

    const base = channels(getComputedStyle(document.body).backgroundColor);
    const sectionBackground = lightest(colorsIn(sectionStyle.backgroundImage).map(color => composite(color, base)));
    const tileBackgrounds = colorsIn(getComputedStyle(tiles[0]).backgroundImage).map(color => composite(color, sectionBackground));
    const tileBackground = lightest(tileBackgrounds);
    expect(contrast(getComputedStyle(section.querySelector(".section-heading")!).color, sectionBackground)).toBeGreaterThanOrEqual(4.5);
    for (const label of section.querySelectorAll<HTMLElement>(".tile-label, .tile-icon, .volume-readout, .tile-reading output, .reading-time")) {
      expect(contrast(getComputedStyle(label).color, tileBackground)).toBeGreaterThanOrEqual(4.5);
    }
    for (const token of ["--text", "--text-muted", "--text-faint"]) {
      const probe = document.createElement("span");
      probe.style.color = `var(${token})`;
      section.appendChild(probe);
      expect(contrast(getComputedStyle(probe).color, tileBackground)).toBeGreaterThanOrEqual(4.5);
      probe.remove();
    }

    // The explicit user accent stays authoritative on the segmented meter and active state.
    const accentProbe = document.createElement("span");
    accentProbe.style.color = "var(--control-accent)";
    tiles[0].appendChild(accentProbe);
    expect(channels(getComputedStyle(accentProbe).color).slice(0, 3).map(Math.round)).toEqual([110, 231, 183]);
    accentProbe.remove();
    const dial = tiles[2].querySelector<HTMLElement>(".dial-face")!;
    expect(getComputedStyle(dial).borderTopLeftRadius).toBe("50%");
    expect(getComputedStyle(dial, "::before").borderTopLeftRadius).toBe("50%");
    const activeTrack = tiles[3].querySelector<HTMLElement>(".toggle-track")!;
    expect(tiles[3].querySelector<HTMLElement>(".toggle-switch")!.getAttribute("aria-checked")).toBe("true");
    expect(getComputedStyle(activeTrack).borderTopLeftRadius).toBe("2px");
    expect(getComputedStyle(activeTrack).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");

    expect(tiles[6].classList.contains("is-disabled")).toBe(true);
    expect(tiles[7].querySelector(".tile-toggle")!.textContent).toContain("State unknown");
    expect((tiles[7].querySelector(".tile-toggle") as HTMLButtonElement).disabled).toBe(true);
    expect(tiles[8].querySelector(".tile-reading output")!.textContent).toContain("Reading failed");
    expect(tiles[8].querySelector("[role=alert]")).not.toBeNull();

    const dark = canvasElement.querySelector<HTMLElement>("[data-testid=dark-section]")!;
    expect(dark.dataset.theme).toBe("dark");
    expect(getComputedStyle(dark).backgroundImage).not.toContain("repeating-linear-gradient");
    expect(getComputedStyle(dark).borderTopLeftRadius).toBe("10px");
    expect(getComputedStyle(dark.querySelector(".tile-label")!).fontFamily).toContain("Geist");
    const darkPhone = canvasElement.querySelector<HTMLElement>("[data-testid=dark-phone-section]")!;
    expect(getComputedStyle(darkPhone.querySelector(".tile-label")!).fontFamily).toContain("Geist");
    expect(getComputedStyle(darkPhone.querySelector(".section-heading")!).textTransform).not.toBe("uppercase");
    expect(getComputedStyle(darkPhone.querySelector(".toggle-track")!).borderTopLeftRadius).not.toBe("2px");

    const phone = canvasElement.querySelector<HTMLElement>("[data-testid=terminal-phone]")!;
    expect(phone.dataset.appearance).toBe("terminal");
    const phoneSection = phone.querySelector<HTMLElement>(".phone-section")!;
    expect(getComputedStyle(phoneSection).borderTopLeftRadius).toBe("8px");
    expect(phoneSection.querySelectorAll(".control-tile")).toHaveLength(controls.length);
  },
};
