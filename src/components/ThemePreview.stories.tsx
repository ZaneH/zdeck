import { useEffect } from "react";
import type { CSSProperties } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent } from "storybook/test";
import { applyTheme } from "../lib/theme";
import { appearanceTokens } from "../lib/customThemes";
import type { ThemePackageAppearance } from "../lib/themePackage";
import { ACCENTS, PRESENTATIONS } from "../lib/types";
import type { Control, Theme } from "../lib/types";
import type { PluginSnapshots } from "../lib/plugin";
import { ControlTile } from "./ControlTile";

/**
 * The standard sample deck every built-in appearance is judged against. Keep this content
 * identical across themes so a preview shows the appearance, not different controls.
 */
const NORMAL_CONTROLS: Control[] = [
  { id: "sample-button", action: "obs-scene", label: "Camera", scene: "Camera" },
  { id: "sample-slider", action: "volume", label: "Speakers", volume: 62 },
  { id: "sample-dial", action: "volume", label: "Gain", volume: 38, presentation: "dial" },
  { id: "sample-switch", action: "plugin", label: "Studio mute", pluginId: "sample", pluginAction: "mute", pluginArgs: { enabled: true }, presentation: "toggle-switch" },
  { id: "sample-toggle", action: "plugin", label: "Arm relay", pluginId: "sample", pluginAction: "arm", pluginArgs: { armed: false }, presentation: "toggle-button" },
];
const STATE_CONTROLS: Control[] = [
  { id: "sample-value", action: "plugin", label: "Input level", pluginId: "sample", pluginAction: "level", pluginArgs: { level: 62 }, presentation: "value" },
  { id: "sample-unknown", action: "plugin", label: "Coolant", pluginId: "sample-unknown", pluginAction: "mute", pluginArgs: { enabled: false }, presentation: "toggle-switch" },
  { id: "sample-failed", action: "plugin", label: "Reactor", pluginId: "sample-failed", pluginAction: "level", pluginArgs: { level: 10 }, presentation: "value" },
];
const SAMPLE_CONTROLS = [...NORMAL_CONTROLS, ...STATE_CONTROLS];

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

const THEMES: Theme[] = ["dark", "light", "glass", "terminal", "macintosh"];
const THEME_LABEL: Record<Theme, string> = { dark: "Dark", light: "Light", glass: "Glass", terminal: "Wasteland Terminal", macintosh: "Classic Macintosh" };
// Signatures the theme stylesheet promises; a preview that misses them is not that appearance.
const TILE_RADIUS: Record<Theme, string> = { dark: "7px", light: "7px", glass: "30px", terminal: "2px", macintosh: "4px" };
const BACKGROUND: Record<Theme, string> = { dark: "#18191b", light: "#f4f5f6", glass: "#15171b", terminal: "#0b0f08", macintosh: "#ffffff" };

type Viewport = "desktop" | "phone";

export function StandardFixture({ theme, viewport, customAppearance }: { theme: Theme; viewport: Viewport; customAppearance?: ThemePackageAppearance }) {
  // The Storybook toolbar decorator applies its own theme after this story mounts; the args win.
  useEffect(() => { applyTheme(theme, ACCENTS[0].value, customAppearance ?? null); }, [theme, customAppearance]);
  const customStyle = customAppearance ? appearanceTokens(customAppearance) as CSSProperties : undefined;
  const customAttributes = customAppearance ? { "data-custom-theme": "true", "data-custom-motif": customAppearance.motif } : {};
  // Inherited sections stay opaque, as in the editor and phone renderers.
  const customSectionAttributes = customAppearance ? { "data-custom-theme": "true" } : {};
  const customBackground = customAppearance ? "var(--custom-motif-image), var(--app-bg-image)" : "var(--app-bg-image)";
  const customBackgroundSize = customAppearance ? "320px 320px, auto" : undefined;
  const renderTiles = (controls: Control[]) => controls.map(control => (
    <ControlTile key={control.id} control={control} plugins={plugins}
      variant={viewport === "phone" ? "phone" : "editor"} appearance={theme} volume={62} />
  ));
  const caption = "Local preview only. No actions are sent.";
  if (viewport === "phone") return (
    <div data-theme={theme} data-appearance={theme} data-testid="theme-preview" {...customAttributes}
      style={{ minHeight: "100dvh", display: "grid", gridTemplateColumns: "minmax(0, 1fr)", placeItems: "start center", background: "var(--bg)", backgroundImage: customBackground, backgroundSize: customBackgroundSize, ...customStyle }}>
      <div className="phone-shell" data-theme={theme} data-appearance={theme} {...customAttributes} style={{ width: 390, maxWidth: "100%", ...customStyle }}>
        {/* Outside the scroller: a phone section fills the page, so anything below it would scroll away. */}
        <p className="phone-status">{caption}</p>
        <main className="phone-main">
          <div className="phone-page-heading"><h1>Theme preview</h1></div>
          <section className="phone-section" data-theme={theme} data-appearance={theme} {...customSectionAttributes} style={customStyle} aria-labelledby="theme-preview-heading">
            <h2 className="section-heading" id="theme-preview-heading">Standard controls</h2>
            <div className="phone-grid">{renderTiles(SAMPLE_CONTROLS)}</div>
          </section>
        </main>
      </div>
    </div>
  );
  // A 2-column section is wider and taller than the old 4x2 strip, so a desktop capture can
  // fill its frame without shrinking the controls. Glass keeps its own square grid geometry.
  const desktopGrid: CSSProperties = theme === "glass" ? {} : { gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gridAutoRows: 156 };
  return (
    <div data-theme={theme} data-appearance={theme} data-testid="theme-preview" {...customAttributes}
      style={{ minHeight: "100dvh", padding: 24, background: "var(--bg)", backgroundImage: customBackground, backgroundSize: customBackgroundSize, ...customStyle }}>
      {/* The exporter fits and centers this group inside the fixed capture viewport. */}
      <div data-testid="theme-preview-content" style={{ width: "fit-content" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 20 }}>
          <section className="deck-section" data-theme={theme} data-appearance={theme} {...customSectionAttributes} aria-labelledby="theme-preview-heading" style={{ width: 396, ...customStyle }}>
            <h2 className="section-heading" id="theme-preview-heading">Standard controls</h2>
            <div className="control-grid" style={desktopGrid}>{renderTiles(NORMAL_CONTROLS)}</div>
          </section>
          <section className="deck-section" data-theme={theme} data-appearance={theme} {...customSectionAttributes} aria-labelledby="theme-preview-states-heading" style={{ width: 396, ...customStyle }}>
            <h2 className="section-heading" id="theme-preview-states-heading">Readings and states</h2>
            <div className="control-grid" style={desktopGrid}>{renderTiles(STATE_CONTROLS)}</div>
          </section>
        </div>
        <p className="field-note" style={{ margin: "8px 0 0" }}>{caption}</p>
      </div>
    </div>
  );
}

const meta = {
  title: "Themes/Theme preview",
  excludeStories: ["StandardFixture"],
  component: StandardFixture,
  args: { theme: "dark", viewport: "desktop" },
  argTypes: {
    theme: { control: "inline-radio", options: THEMES, labels: THEME_LABEL },
    viewport: { control: "inline-radio", options: ["desktop", "phone"] },
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof StandardFixture>;
export default meta;
type Story = StoryObj<typeof meta>;

function expectInside(rect: DOMRect, bounds: DOMRect, edge = 1) {
  expect(rect.left).toBeGreaterThanOrEqual(bounds.left - edge);
  expect(rect.right).toBeLessThanOrEqual(bounds.right + edge);
  expect(rect.top).toBeGreaterThanOrEqual(bounds.top - edge);
  expect(rect.bottom).toBeLessThanOrEqual(bounds.bottom + edge);
}

// Glass capsules and modules keep their labels, bodies and 44px targets inside the tile.
// Check the inner content, not only the tile box.
function assertGlassSpacing(sections: HTMLElement[]) {
  const tiles = sections.flatMap(part => Array.from(part.querySelectorAll<HTMLElement>(".control-tile")));
  for (const tile of tiles) {
    const box = tile.getBoundingClientRect();
    // Capsule content clears the curved edge by at least the narrow-phone inset.
    // The full-bleed slider centers its icon circle rather than insetting it from an edge.
    const inset = tile.dataset.shape === "capsule" ? 13 : tile.dataset.shape === "slider" ? 0 : 16;
    const icon = tile.querySelector<HTMLElement>(".tile-icon");
    const label = tile.querySelector<HTMLElement>(".tile-label");
    const labelVisible = !!label && getComputedStyle(label).display !== "none";
    if (icon && getComputedStyle(icon).display !== "none") {
      const iconBox = icon.getBoundingClientRect();
      expect(iconBox.left).toBeGreaterThanOrEqual(box.left + inset - 1);
      expect(iconBox.top).toBeGreaterThanOrEqual(box.top - 1);
      if (labelVisible) {
        const labelBox = label!.getBoundingClientRect();
        // Stacked module labels (icon above, label below) have no side-by-side gap to check.
        if (labelBox.top < iconBox.bottom && labelBox.bottom > iconBox.top) {
          expect(labelBox.left - iconBox.right).toBeGreaterThanOrEqual(5);
        }
        expect(labelBox.left).toBeGreaterThanOrEqual(box.left + inset - 1);
        expect(labelBox.right).toBeLessThanOrEqual(box.right - inset + 1);
        expect(labelBox.top).toBeGreaterThanOrEqual(box.top + 4);
      }
    }
    const labelBox = labelVisible ? label!.getBoundingClientRect() : null;
    const belowLabel = (rect: DOMRect) => {
      if (labelBox) expect(rect.top - labelBox.bottom).toBeGreaterThanOrEqual(4);
    };
    const toggle = tile.querySelector<HTMLElement>(".tile-toggle");
    if (toggle) {
      const toggleBox = toggle.getBoundingClientRect();
      expect(toggleBox.height).toBeGreaterThanOrEqual(44);
      expectInside(toggleBox, box);
      for (const selector of [".toggle-track", ".toggle-state"]) {
        const part = tile.querySelector<HTMLElement>(selector);
        if (!part) continue;
        const partBox = part.getBoundingClientRect();
        if (partBox.width === 0) continue;
        expectInside(partBox, box);
        belowLabel(partBox);
      }
    }
    const dial = tile.querySelector<HTMLElement>(".dial-face");
    if (dial) {
      const dialBox = dial.getBoundingClientRect();
      expect(dialBox.width).toBeGreaterThanOrEqual(44);
      expect(dialBox.height).toBeGreaterThanOrEqual(44);
      expectInside(dialBox, box);
      if (labelBox) expect(dialBox.top - labelBox.bottom).toBeGreaterThanOrEqual(6);
      const readout = tile.querySelector<HTMLElement>(".volume-readout");
      if (readout) {
        const readoutBox = readout.getBoundingClientRect();
        expectInside(readoutBox, box);
        belowLabel(readoutBox);
        expect(readoutBox.top - dialBox.bottom).toBeGreaterThanOrEqual(6);
      }
    }
    const reading = tile.querySelector<HTMLElement>(".tile-reading");
    if (reading) {
      for (const selector of [".tile-reading", ".tile-reading output", ".reading-time"]) {
        const part = tile.querySelector<HTMLElement>(selector);
        if (part) expectInside(part.getBoundingClientRect(), box);
      }
      belowLabel(reading.querySelector<HTMLElement>("output")!.getBoundingClientRect());
    }
  }
}

async function assertPreview(canvasElement: HTMLElement, theme: Theme, viewport: Viewport) {
  const fixture = canvasElement.querySelector<HTMLElement>('[data-testid="theme-preview"]')!;
  const sections = Array.from(fixture.querySelectorAll<HTMLElement>(".deck-section, .phone-section"));
  const section = sections[0] ?? fixture;
  // Desktop shows normal controls and state examples side by side; phone keeps one section.
  expect(sections).toHaveLength(viewport === "desktop" ? 2 : 1);
  // The theme must be scoped to this fixture, whatever the Storybook toolbar left on the page.
  expect(fixture.dataset.theme).toBe(theme);
  expect(fixture.dataset.appearance).toBe(theme);
  expect(getComputedStyle(section).getPropertyValue("--tile-radius").trim()).toBe(TILE_RADIUS[theme]);
  expect(getComputedStyle(section).getPropertyValue("--bg").trim()).toBe(BACKGROUND[theme]);
  // Outside the boundary the page keeps its own appearance instead of leaking the fixture's.
  const pageTheme = document.documentElement.dataset.theme as Theme;
  expect(getComputedStyle(document.body).getPropertyValue("--tile-radius").trim()).toBe(TILE_RADIUS[pageTheme]);

  expect(section.classList.contains(viewport === "phone" ? "phone-section" : "deck-section")).toBe(true);
  const tiles = sections.flatMap(part => Array.from(part.querySelectorAll<HTMLElement>(".control-tile")));
  expect(tiles).toHaveLength(SAMPLE_CONTROLS.length);
  for (const presentation of PRESENTATIONS) expect(tiles.map(tile => tile.dataset.presentation)).toContain(presentation);
  expect(tiles[6].querySelector(".tile-toggle")!.textContent).toContain("State unknown");
  expect(tiles[7].querySelector(".tile-reading output")!.textContent).toContain("Reading failed");
  // Presentation belongs to the appearance, not to the story: Glass rounds and blurs its material,
  // Wasteland Terminal squares its instruments and switches to the mono face.
  if (theme === "glass") {
    expect(getComputedStyle(tiles[0]).borderTopLeftRadius).toBe("30px");
    const supported = CSS.supports("backdrop-filter", "blur(1px)") || CSS.supports("-webkit-backdrop-filter", "blur(1px)");
    if (supported) expect(getComputedStyle(tiles[0]).getPropertyValue("backdrop-filter") || getComputedStyle(tiles[0]).getPropertyValue("-webkit-backdrop-filter")).toContain("blur");
    expect(getComputedStyle(section).fontFamily).toContain("Segoe UI");
    // The on surface needs dark ink in every slot, not only in the switch body.
    for (const selector of [".tile-icon", ".tile-label", ".toggle-state"]) {
      expect(getComputedStyle(tiles[3].querySelector<HTMLElement>(selector)!).color).toBe("rgb(32, 35, 40)");
    }
    expect(getComputedStyle(tiles[3]).backgroundImage).not.toBe(getComputedStyle(tiles[4]).backgroundImage);
  } else if (theme === "terminal") {
    expect(getComputedStyle(tiles[0]).borderTopLeftRadius).toBe("2px");
    expect(getComputedStyle(section).fontFamily).toContain("monospace");
  } else if (theme === "macintosh") {
    expect(getComputedStyle(tiles[0]).borderTopLeftRadius).toBe("4px");
    expect(getComputedStyle(section).fontFamily).toContain("ChicagoFLF");
    expect(getComputedStyle(tiles[0]).getPropertyValue("--control-accent").trim()).toBe("#000");
    expect(getComputedStyle(section.querySelector(".section-heading")!, "::before").backgroundImage).toContain("repeating-linear-gradient");
    expect(getComputedStyle(tiles[2].querySelector(".dial-face")!).backgroundImage).toContain("repeating-conic-gradient");
    expect(getComputedStyle(tiles[3].querySelector(".toggle-track")!).borderRadius).toBe("0px");
    const dial = tiles[2].querySelector<HTMLElement>('[role="slider"]')!;
    const before = Number(dial.getAttribute("aria-valuenow"));
    dial.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(Number(dial.getAttribute("aria-valuenow"))).toBe(before + 1);
    await userEvent.keyboard("{ArrowLeft}");
    dial.blur();
    if (viewport === "phone") {
      fixture.style.width = "320px";
      expect(fixture.querySelector(".phone-shell")!.getBoundingClientRect().width).toBeLessThanOrEqual(320);
      for (const tile of tiles) expectInside(tile.getBoundingClientRect(), section.getBoundingClientRect());
      fixture.style.width = "";
    }
  } else {
    expect(getComputedStyle(tiles[0]).borderTopLeftRadius).toBe("7px");
  }

  // No overflow: every tile is fully visible and inside the section it belongs to.
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(window.innerHeight + 1);
  for (const part of sections) {
    expect(part.querySelector(".phone-grid, .control-grid")!.children.length).toBeGreaterThan(0);
    const bounds = part.getBoundingClientRect();
    expect(bounds.right).toBeLessThanOrEqual(window.innerWidth + 1);
    for (const tile of part.querySelectorAll<HTMLElement>(".control-tile")) {
      const box = tile.getBoundingClientRect();
      expect(box.width).toBeGreaterThan(0);
      expect(box.left).toBeGreaterThanOrEqual(-1);
      expect(box.right).toBeLessThanOrEqual(window.innerWidth + 1);
      expect(box.bottom).toBeLessThanOrEqual(window.innerHeight + 1);
      expect(box.right).toBeLessThanOrEqual(bounds.right + 1);
    }
  }
  if (theme === "glass") {
    assertGlassSpacing(sections);
    // Narrow phones must keep the same inset and spacing, not just avoid page overflow.
    const shell = fixture.querySelector<HTMLElement>(".phone-shell");
    if (viewport === "phone" && shell) {
      const width = shell.style.width;
      shell.style.width = "320px";
      assertGlassSpacing(sections);
      shell.style.width = width;
    }
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
export const MacintoshDesktop: Story = { args: { theme: "macintosh", viewport: "desktop" }, play: play("macintosh", "desktop") };
export const MacintoshPhone: Story = { args: { theme: "macintosh", viewport: "phone" }, play: play("macintosh", "phone") };
