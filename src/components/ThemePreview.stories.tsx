import { useEffect } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { applyTheme } from "../lib/theme";
import { ACCENTS, PRESENTATIONS } from "../lib/types";
import type { Control, Theme } from "../lib/types";
import type { PluginSnapshots } from "../lib/plugin";
import { ControlTile } from "./ControlTile";

/**
 * The standard sample deck every built-in appearance is judged against. Keep this content
 * identical across themes so a preview shows the appearance, not different controls.
 */
const SAMPLE_CONTROLS: Control[] = [
  { id: "sample-button", action: "obs-scene", label: "Camera", scene: "Camera" },
  { id: "sample-slider", action: "volume", label: "Speakers", volume: 62 },
  { id: "sample-dial", action: "volume", label: "Gain", volume: 38, presentation: "dial" },
  { id: "sample-switch", action: "plugin", label: "Studio mute", pluginId: "sample", pluginAction: "mute", pluginArgs: { enabled: true }, presentation: "toggle-switch" },
  { id: "sample-toggle", action: "plugin", label: "Arm relay", pluginId: "sample", pluginAction: "arm", pluginArgs: { armed: false }, presentation: "toggle-button" },
  { id: "sample-value", action: "plugin", label: "Input level", pluginId: "sample", pluginAction: "level", pluginArgs: { level: 62 }, presentation: "value" },
  { id: "sample-unknown", action: "plugin", label: "Coolant", pluginId: "sample-unknown", pluginAction: "mute", pluginArgs: { enabled: false }, presentation: "toggle-switch" },
  { id: "sample-failed", action: "plugin", label: "Reactor", pluginId: "sample-failed", pluginAction: "level", pluginArgs: { level: 10 }, presentation: "value" },
];

const levelConfig = { level: { type: "integer" as const, minimum: 0, maximum: 100, control: { step: 1 }, choicesKey: "levels" } };
const levelValue = { id: "level", title: "Input level", config: levelConfig, stateKey: "levels", entityKey: "level" };
// Fixed observation time keeps the reading caption identical in every theme and screenshot.
const OBSERVED_AT_MS = 1_700_000_000_000;
const plugins: PluginSnapshots = {
  sample: {
    status: "connected", lastError: null,
    state: {
      muted: true, armed: false,
      levels: [{ value: 62, label: "Input", available: true, observation: { value: 62, unit: "%", observedAtMs: OBSERVED_AT_MS } }],
    },
    manifest: {
      id: "sample", version: "1.0.0", protocolVersion: 1,
      actions: [
        { id: "mute", title: "Studio mute", config: { enabled: { type: "boolean", control: { stateKey: "muted" } } } },
        { id: "arm", title: "Arm relay", config: { armed: { type: "boolean", control: { stateKey: "armed" } } } },
        { id: "level", title: "Input level", config: levelConfig },
      ],
      values: [levelValue],
    },
  },
  "sample-unknown": {
    status: "connected", lastError: null, state: {},
    manifest: {
      id: "sample-unknown", version: "1.0.0", protocolVersion: 1,
      actions: [{ id: "mute", title: "Coolant", config: { enabled: { type: "boolean", control: { stateKey: "muted" } } } }],
    },
  },
  "sample-failed": {
    status: "connected",
    lastError: { kind: "plugin", code: null, outcome: "not_started", message: "Reading failed.", hint: "Check the plugin." },
    state: { levels: [] },
    manifest: { id: "sample-failed", version: "1.0.0", protocolVersion: 1, actions: [levelValue], values: [levelValue] },
  },
};

const THEMES: Theme[] = ["dark", "light", "glass", "terminal"];
const THEME_LABEL: Record<Theme, string> = { dark: "Dark", light: "Light", glass: "Glass", terminal: "Wasteland Terminal" };
// Signatures the theme stylesheet promises; a preview that misses them is not that appearance.
const TILE_RADIUS: Record<Theme, string> = { dark: "7px", light: "7px", glass: "30px", terminal: "2px" };
const BACKGROUND: Record<Theme, string> = { dark: "#18191b", light: "#f4f5f6", glass: "#ac83f6", terminal: "#0b0f08" };

type Viewport = "desktop" | "phone";

function StandardFixture({ theme, viewport }: { theme: Theme; viewport: Viewport }) {
  // The Storybook toolbar decorator applies its own theme after this story mounts; the args win.
  useEffect(() => { applyTheme(theme, ACCENTS[0].value); }, [theme]);
  const tiles = SAMPLE_CONTROLS.map(control => {
    // Glass cells are square and narrow; a dial's face and readout need two of them.
    const columnSpan = theme === "glass" && control.presentation === "dial" ? 2 : undefined;
    return (
      <ControlTile key={control.id} control={{ ...control, columnSpan }} plugins={plugins}
        variant={viewport === "phone" ? "phone" : "editor"} appearance={theme} volume={62} />
    );
  });
  const caption = "Local preview only. No actions are sent.";
  if (viewport === "phone") return (
    <div data-theme={theme} data-appearance={theme} data-testid="theme-preview"
      style={{ minHeight: "100dvh", display: "grid", placeItems: "start center", background: "var(--bg)", backgroundImage: "var(--app-bg-image)" }}>
      <div className="phone-shell" data-theme={theme} data-appearance={theme} style={{ width: 390, maxWidth: "100%" }}>
        {/* Outside the scroller: a phone section fills the page, so anything below it would scroll away. */}
        <p className="phone-status">{caption}</p>
        <main className="phone-main">
          <div className="phone-page-heading"><h1>Theme preview</h1></div>
          <section className="phone-section" data-theme={theme} data-appearance={theme} aria-labelledby="theme-preview-heading">
            <h2 className="section-heading" id="theme-preview-heading">Standard controls</h2>
            <div className="phone-grid">{tiles}</div>
          </section>
        </main>
      </div>
    </div>
  );
  return (
    <div data-theme={theme} data-appearance={theme} data-testid="theme-preview"
      style={{ minHeight: "100dvh", padding: 24, background: "var(--bg)", backgroundImage: "var(--app-bg-image)" }}>
      <section className="deck-section" data-theme={theme} data-appearance={theme} aria-labelledby="theme-preview-heading" style={{ maxWidth: 760 }}>
        <h2 className="section-heading" id="theme-preview-heading">Standard controls</h2>
        <div className="control-grid">{tiles}</div>
      </section>
      <p className="field-note">{caption}</p>
    </div>
  );
}

const meta = {
  title: "Themes/Theme preview",
  component: StandardFixture,
  args: { theme: "dark", viewport: "desktop" },
  argTypes: {
    theme: { control: "inline-radio", options: THEMES, labels: { terminal: THEME_LABEL.terminal } },
    viewport: { control: "inline-radio", options: ["desktop", "phone"] },
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof StandardFixture>;
export default meta;
type Story = StoryObj<typeof meta>;

async function assertPreview(canvasElement: HTMLElement, theme: Theme, viewport: Viewport) {
  const fixture = canvasElement.querySelector<HTMLElement>('[data-testid="theme-preview"]')!;
  const section = fixture.querySelector<HTMLElement>(".deck-section, .phone-section") ?? fixture;
  // The theme must be scoped to this fixture, whatever the Storybook toolbar left on the page.
  expect(fixture.dataset.theme).toBe(theme);
  expect(fixture.dataset.appearance).toBe(theme);
  expect(getComputedStyle(section).getPropertyValue("--tile-radius").trim()).toBe(TILE_RADIUS[theme]);
  expect(getComputedStyle(section).getPropertyValue("--bg").trim()).toBe(BACKGROUND[theme]);
  // Outside the boundary the page keeps its own appearance instead of leaking the fixture's.
  const pageTheme = document.documentElement.dataset.theme as Theme;
  expect(getComputedStyle(document.body).getPropertyValue("--tile-radius").trim()).toBe(TILE_RADIUS[pageTheme]);

  expect(section.classList.contains(viewport === "phone" ? "phone-section" : "deck-section")).toBe(true);
  const grid = section.querySelector<HTMLElement>(".phone-grid, .control-grid")!;
  expect(grid.children).toHaveLength(SAMPLE_CONTROLS.length);
  const tiles = Array.from(grid.querySelectorAll<HTMLElement>(".control-tile"));
  for (const presentation of PRESENTATIONS) expect(tiles.map(tile => tile.dataset.presentation)).toContain(presentation);
  expect(tiles[6].querySelector(".tile-toggle")!.textContent).toContain("State unknown");
  expect(tiles[7].querySelector(".tile-reading output")!.textContent).toContain("Reading failed");
  // Presentation belongs to the appearance, not to the story: Glass rounds and blurs its material,
  // Wasteland Terminal squares its instruments and switches to the mono face.
  if (theme === "glass") {
    expect(getComputedStyle(tiles[0]).borderTopLeftRadius).toBe("30px");
    expect(getComputedStyle(tiles[0]).getPropertyValue("backdrop-filter")).toContain("blur");
  } else if (theme === "terminal") {
    expect(getComputedStyle(tiles[0]).borderTopLeftRadius).toBe("2px");
    expect(getComputedStyle(section).fontFamily).toContain("monospace");
  } else {
    expect(getComputedStyle(tiles[0]).borderTopLeftRadius).toBe("7px");
  }

  // No overflow: every tile is fully visible and inside the section it belongs to.
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(window.innerHeight + 1);
  const bounds = section.getBoundingClientRect();
  for (const tile of tiles) {
    const box = tile.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(0);
    expect(box.left).toBeGreaterThanOrEqual(-1);
    expect(box.right).toBeLessThanOrEqual(window.innerWidth + 1);
    expect(box.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
    expect(box.right).toBeLessThanOrEqual(bounds.right + 1);
  }
}

function play(theme: Theme, viewport: Viewport): NonNullable<Story["play"]> {
  return async ({ canvasElement }) => assertPreview(canvasElement, theme, viewport);
}

// One story per built-in appearance and viewport, so every appearance is rendered and checked.
export const DarkDesktop: Story = { args: { theme: "dark", viewport: "desktop" }, play: play("dark", "desktop") };
export const DarkPhone: Story = { args: { theme: "dark", viewport: "phone" }, play: play("dark", "phone") };
export const LightDesktop: Story = { args: { theme: "light", viewport: "desktop" }, play: play("light", "desktop") };
export const LightPhone: Story = { args: { theme: "light", viewport: "phone" }, play: play("light", "phone") };
export const GlassDesktop: Story = { args: { theme: "glass", viewport: "desktop" }, play: play("glass", "desktop") };
export const GlassPhone: Story = { args: { theme: "glass", viewport: "phone" }, play: play("glass", "phone") };
export const TerminalDesktop: Story = { args: { theme: "terminal", viewport: "desktop" }, play: play("terminal", "desktop") };
export const TerminalPhone: Story = { args: { theme: "terminal", viewport: "phone" }, play: play("terminal", "phone") };
