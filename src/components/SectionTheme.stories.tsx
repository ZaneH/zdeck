import { useEffect } from "react";
import type { CSSProperties } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { ACCENTS } from "../lib/types";
import type { Control, Theme } from "../lib/types";
import type { PluginSnapshots } from "../lib/plugin";
import { applyTheme } from "../lib/theme";
import { ControlTile } from "./ControlTile";

const tile: Control = { id: "story-volume", action: "volume", label: "Speakers", volume: 50 };
const stateControls: Control[] = [
  { id: "button", action: "obs-scene", label: "Camera", scene: "Camera" },
  ...["toggle-switch", "toggle-button"].flatMap(presentation => [true, false, null].map(value => ({
    id: `${presentation}-${value}`, action: "plugin" as const, label: value === null ? "Unknown" : value ? "On" : "Off",
    pluginId: "contrast", pluginAction: value === null ? "unknown" : value ? "on" : "off",
    pluginArgs: { enabled: false }, presentation: presentation as "toggle-switch" | "toggle-button",
  }))),
  { id: "value", action: "plugin", label: "Input level", pluginId: "contrast", pluginAction: "level", pluginArgs: { level: 50 }, presentation: "value" },
];
const levelConfig = { level: { type: "integer" as const, minimum: 0, maximum: 100, choicesKey: "levels" } };
const plugins: PluginSnapshots = {
  contrast: {
    status: "connected", lastError: null,
    state: { on: true, off: false, levels: [{ value: 50, label: "Input", available: true, observation: { value: 50, unit: "%", observedAtMs: 1_700_000_000_000 } }] },
    manifest: {
      id: "contrast", version: "1.0.0", protocolVersion: 1,
      actions: [
        ...["on", "off", "unknown"].map(id => ({ id, title: id, config: { enabled: { type: "boolean" as const, control: { stateKey: id } } } })),
        { id: "level", title: "Input level", config: levelConfig },
      ],
      values: [{ id: "level", title: "Input level", config: levelConfig, stateKey: "levels", entityKey: "level" }],
    },
  },
};

/** Fixture markup mirrors SectionList and PhoneDeck; the shared section classes carry the theme boundary. */
function SectionExample({ deckTheme, sectionTheme, accent }: { deckTheme: Theme; sectionTheme: Theme | null; accent?: string }) {
  // The deck theme is global in the app; Storybook's toolbar applies it too.
  useEffect(() => { applyTheme(deckTheme, ACCENTS[0].value); }, [deckTheme]);
  // Production sectionStyle only sets --accent inline; without data-theme the section inherits the deck theme.
  const style = accent ? ({ "--accent": accent } as CSSProperties) : undefined;
  const appearance = sectionTheme ?? deckTheme;
  return <div data-theme={deckTheme} data-appearance={deckTheme} style={{ display: "grid", gap: 16, maxWidth: 520 }}>
    <section className="deck-section" data-theme={sectionTheme ?? undefined} data-appearance={appearance} style={style}>
      <h2 className="section-heading">Editor section</h2>
      <p>Inherited label text</p>
      <span className="sr-only" data-probe="muted" style={{ color: "var(--text-muted)" }} />
      <div className="control-grid">{[tile, ...stateControls].map(control => <ControlTile key={control.id} control={control} plugins={plugins} variant="editor" appearance={appearance} volume={50} />)}</div>
    </section>
    <section className="phone-section" data-theme={sectionTheme ?? undefined} data-appearance={appearance} style={style}>
      <h2 className="section-heading">Phone section</h2>
      <p>Inherited label text</p>
      <span className="sr-only" data-probe="muted" style={{ color: "var(--text-muted)" }} />
      <div className="phone-grid">{[tile, ...stateControls].map(control => <ControlTile key={control.id} control={control} plugins={plugins} variant="phone" appearance={appearance} volume={50} />)}</div>
    </section>
  </div>;
}

function channels(color: string): number[] {
  if (color.startsWith("#")) {
    const hex = color.slice(1);
    const full = hex.length === 3 ? [...hex].map(c => c + c).join("") : hex;
    return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16));
  }
  const values = color.match(/[\d.]+/g)!.slice(0, 3).map(Number);
  // color(srgb …) serializes 0–1 channels; rgb() uses 0–255.
  return color.startsWith("color(") ? values.map(value => value * 255) : values;
}
function alphaOf(color: string): number {
  if (color.startsWith("#")) return color.length === 9 ? parseInt(color.slice(7, 9), 16) / 255 : 1;
  const values = color.match(/[\d.]+/g)!.map(Number);
  return values[3] ?? 1;
}
function blend(foreground: string, background: number[]): number[] {
  const alpha = alphaOf(foreground);
  return channels(foreground).map((value, index) => value * alpha + background[index] * (1 - alpha));
}
function luminanceChannels(rgb: number[]): number {
  const channel = (value: number) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}
// Composite translucent text and surfaces before comparing, as the eye sees them.
function contrast(foreground: string, background: number[]): number {
  const [lighter, darker] = [luminanceChannels(blend(foreground, background)), luminanceChannels(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}
function colorsIn(value: string): string[] {
  return value.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}/gi) ?? [];
}
// The lightest plausible backdrop is worst for every label: light text in Glass/Dark, dark text in Light.
function lightest(colors: number[][]): number[] {
  return colors.reduce((worst, color) => luminanceChannels(color) > luminanceChannels(worst) ? color : worst);
}
// Glass paints translucent groups over a gradient backdrop, so check composed paint, not token alpha 1.
function backdropCandidates(): number[][] {
  const body = getComputedStyle(document.body);
  const base = channels(body.backgroundColor);
  const tokens = colorsIn(body.backgroundImage);
  const stops = tokens.map(token => blend(token, base));
  const candidates = [base, ...stops];
  for (const token of tokens) for (const stop of stops) candidates.push(blend(token, stop));
  return candidates;
}
function paintedBackgrounds(style: CSSStyleDeclaration, background: number[]): number[][] {
  const base = blend(style.backgroundColor, background);
  const stops = colorsIn(style.backgroundImage);
  return stops.length ? stops.map(color => blend(color, base)) : [base];
}
function expectedMix(accent: string, text: string, weight: number): number[] {
  const accentChannels = channels(accent);
  const textChannels = channels(text);
  return accentChannels.map((value, index) => value * weight + textChannels[index] * (1 - weight));
}
function expectColor(actual: string, expected: number[]) {
  const resolved = channels(actual);
  resolved.forEach((value, index) => expect(Math.abs(value - expected[index])).toBeLessThanOrEqual(2));
}

const meta = {
  title: "Workspace/Section theme",
  component: SectionExample,
  args: { deckTheme: "dark", sectionTheme: "light", accent: undefined },
  parameters: { layout: "padded" },
} satisfies Meta<typeof SectionExample>;
export default meta;
type Story = StoryObj<typeof meta>;

async function assertSectionContrast(canvasElement: HTMLElement, deckTheme: Theme) {
  applyTheme(deckTheme, ACCENTS[0].value);
  const sections = Array.from(canvasElement.querySelectorAll<HTMLElement>(".deck-section, .phone-section"));
  expect(sections).toHaveLength(2);
  const backdrops = backdropCandidates();
  const supportsBackdrop = CSS.supports("backdrop-filter", "blur(1px)") || CSS.supports("-webkit-backdrop-filter", "blur(1px)");
  for (const section of sections) {
    const style = getComputedStyle(section);
    const sectionTheme = section.dataset.theme ?? deckTheme;
    const appearance = section.dataset.appearance ?? sectionTheme;
    // A phone section without its own data-theme has no backdrop; its text sits on the deck.
    const sectionBackgrounds = backdrops.flatMap(backdrop => paintedBackgrounds(style, backdrop));
    const background = lightest(sectionBackgrounds);
    // Glass headings sit directly on the deck backdrop, including a flat Light deck.
    if (appearance === "glass") {
      const heading = section.querySelector<HTMLElement>(".section-heading")!;
      const headingStyle = getComputedStyle(heading);
      for (const backdrop of sectionBackgrounds) {
        expect(contrast(headingStyle.color, blend(headingStyle.backgroundColor, backdrop))).toBeGreaterThanOrEqual(4.5);
      }
    }
    // Glass sections are transparent: their labels sit on the wallpaper, controls carry the material.
    if (appearance !== "glass") {
      // The section text token follows the section's own theme, not the deck's.
      expect(contrast(style.color, background)).toBeGreaterThanOrEqual(4.5);
      const inherited = Array.from(section.querySelectorAll<HTMLElement>("p"));
      expect(inherited.length).toBeGreaterThan(0);
      for (const label of inherited) {
        expect(getComputedStyle(label).color).toBe(style.color);
        expect(contrast(getComputedStyle(label).color, background)).toBeGreaterThanOrEqual(4.5);
      }
      // Explicit control colors stay scoped to their own element and stay readable.
      const muted = section.querySelector<HTMLElement>("[data-probe=muted]")!;
      for (const label of section.querySelectorAll<HTMLElement>('.section-heading, [data-presentation="slider"] .tile-icon, [data-presentation="slider"] .tile-label')) {
        const color = getComputedStyle(label).color;
        expect(color).toBe(getComputedStyle(muted).color);
        expect(color).not.toBe(style.color);
        expect(contrast(color, background)).toBeGreaterThanOrEqual(4.5);
      }
    }
    const tileElement = section.querySelector<HTMLElement>(".control-tile")!;
    const tileStyle = getComputedStyle(tileElement);
    // Presentation belongs to the nearest appearance only: Glass hides the slider label and
    // stretches the native range over the whole pill; Dark/Light keep their labelled horizontal fader.
    const tileLabel = tileElement.querySelector<HTMLElement>(".tile-label")!;
    const tileInput = tileElement.querySelector<HTMLInputElement>(".tile-volume input")!;
    const inputBox = tileInput.getBoundingClientRect();
    const tileBox = tileElement.getBoundingClientRect();
    if (appearance === "glass") {
      expect(getComputedStyle(tileLabel).display).toBe("none");
      expect(inputBox.height).toBeGreaterThan(inputBox.width);
      expect(Math.abs(inputBox.height - tileBox.height)).toBeLessThanOrEqual(2);
      expect(Math.abs(inputBox.width - tileBox.width)).toBeLessThanOrEqual(2);
    } else {
      expect(getComputedStyle(tileLabel).display).not.toBe("none");
      expect(getComputedStyle(tileInput).writingMode).not.toBe("vertical-lr");
      expect(inputBox.height).toBeLessThan(tileBox.height);
    }
    // Check actual button, reading, on/off/unknown switch AND button paints, not just Glass tokens.
    for (const tile of section.querySelectorAll<HTMLElement>(".control-tile")) {
      const paints = sectionBackgrounds.flatMap(backdrop => paintedBackgrounds(getComputedStyle(tile), backdrop));
      for (const label of tile.querySelectorAll<HTMLElement>(".tile-icon, .tile-label, .volume-readout, .tile-reading output, .reading-time, .value-unit, .toggle-state")) {
        const labelStyle = getComputedStyle(label);
        if (labelStyle.display === "none") continue;
        for (const paint of paints) {
          // The full-bleed slider's icon has its own opaque disk over the light value fill.
          const labelPaint = blend(labelStyle.backgroundColor, paint);
          expect(contrast(labelStyle.color, labelPaint), `${appearance} ${tile.id || tile.dataset.presentation} ${label.className}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      for (const token of ["--text", "--text-muted", "--text-faint"]) {
        const probe = document.createElement("span");
        probe.style.color = `var(${token})`;
        tile.appendChild(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        for (const paint of paints) expect(contrast(color, paint), `${appearance} ${token}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    if (appearance === "glass") {
      // Editor sections own a graphite canvas; the phone shell owns it in the real phone.
      expect(alphaOf(style.backgroundColor)).toBe(section.classList.contains("phone-section") ? 0 : 1);
      const tileTokens = colorsIn(tileStyle.backgroundImage);
      expect(tileTokens.length).toBeGreaterThan(0);
      for (const token of tileTokens) {
        if (supportsBackdrop) expect(alphaOf(token)).toBeLessThan(1);
        else expect(alphaOf(token)).toBe(1);
      }
    }
    // Glass controls own the material; Dark/Light keep flat tiles.
    const tileFilter = tileStyle.getPropertyValue("backdrop-filter") || tileStyle.getPropertyValue("-webkit-backdrop-filter");
    if (appearance === "glass") {
      if (supportsBackdrop) expect(tileFilter).toContain("blur");
    } else {
      expect(tileFilter === "none" || tileFilter === "").toBe(true);
    }
    const sectionFilter = style.getPropertyValue("backdrop-filter") || style.getPropertyValue("-webkit-backdrop-filter");
    expect(sectionFilter === "none" || sectionFilter === "").toBe(true);
    // Preserve Dark/Light geometry; Glass intentionally removes the group container.
    if (appearance === "glass") {
      expect(style.borderRadius).toBe(section.classList.contains("phone-section") ? "0px" : "30px");
      if (section.classList.contains("deck-section")) {
        expect(section.querySelector(".control-grid")!.getBoundingClientRect().width).toBeLessThanOrEqual(360);
        const bounds = tileElement.getBoundingClientRect();
        expect(bounds.width).toBeLessThanOrEqual(80);
        expect(Math.abs(bounds.height - (bounds.width * 2 + 14))).toBeLessThanOrEqual(1);
      }
    } else if (section.classList.contains("phone-section")) {
      if (section.dataset.theme) expect(style.borderRadius).toBe("8px");
    } else {
      expect(style.borderRadius).toBe("10px");
    }
    // Assert the tile's resolved accent, not the serialized custom-property text.
    const probe = document.createElement("span");
    probe.style.color = "var(--control-accent)";
    tileElement.appendChild(probe);
    const actual = getComputedStyle(probe).color;
    probe.remove();
    const accent = getComputedStyle(section).getPropertyValue("--accent").trim() || ACCENTS[0].value;
    expectColor(actual, expectedMix(accent, style.color, sectionTheme === "light" ? 0.65 : 1));
  }
}

function assertMacintoshBoundary(canvasElement: HTMLElement) {
  for (const section of canvasElement.querySelectorAll<HTMLElement>(".deck-section, .phone-section")) {
    const style = getComputedStyle(section);
    expect(style.fontFamily).toContain("ChicagoFLF");
    expect(style.getPropertyValue("--bg").trim()).toBe("#ffffff");
    expect(style.borderRadius).toBe("0px");
    const slider = section.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect(getComputedStyle(slider).writingMode).not.toBe("vertical-lr");
    const button = section.querySelector<HTMLElement>('.toggle-button[aria-pressed="true"]')!;
    expect(contrast(getComputedStyle(button).color, channels(getComputedStyle(button).backgroundColor))).toBeGreaterThanOrEqual(4.5);
  }
}

export const MacintoshSectionInDarkDeck: Story = {
  args: { deckTheme: "dark", sectionTheme: "macintosh", accent: ACCENTS[3].value },
  play: async ({ canvasElement }) => assertMacintoshBoundary(canvasElement),
};
export const DarkSectionInMacintoshDeck: Story = {
  args: { deckTheme: "macintosh", sectionTheme: "dark", accent: undefined },
  play: async ({ canvasElement }) => {
    // Dark toggles have transparent paint; their existing contrast test covers the tile backdrop.
    for (const section of canvasElement.querySelectorAll<HTMLElement>(".deck-section, .phone-section")) {
      expect(getComputedStyle(section).fontFamily).toContain("Geist");
      expect(getComputedStyle(section).getPropertyValue("--bg").trim()).toBe("#18191b");
      expect(getComputedStyle(section.querySelector(".control-tile")!).borderRadius).toBe("7px");
    }
  },
};

export const LightSectionInDarkDeck: Story = {
  args: { deckTheme: "dark", sectionTheme: "light", accent: undefined },
  play: async ({ canvasElement }) => assertSectionContrast(canvasElement, "dark"),
};

export const DarkSectionInLightDeck: Story = {
  args: { deckTheme: "light", sectionTheme: "dark", accent: undefined },
  play: async ({ canvasElement }) => assertSectionContrast(canvasElement, "light"),
};

export const AccentOnlySectionInDarkDeck: Story = {
  args: { deckTheme: "dark", sectionTheme: null, accent: ACCENTS[1].value },
  play: async ({ canvasElement }) => assertSectionContrast(canvasElement, "dark"),
};

export const AccentOnlySectionInLightDeck: Story = {
  args: { deckTheme: "light", sectionTheme: null, accent: ACCENTS[1].value },
  play: async ({ canvasElement }) => assertSectionContrast(canvasElement, "light"),
};

export const GlassDeckInheritedWithLocalAccent: Story = {
  args: { deckTheme: "glass", sectionTheme: null, accent: ACCENTS[1].value },
  play: async ({ canvasElement }) => assertSectionContrast(canvasElement, "glass"),
};

export const GlassSectionInDarkDeck: Story = {
  args: { deckTheme: "dark", sectionTheme: "glass", accent: undefined },
  play: async ({ canvasElement }) => assertSectionContrast(canvasElement, "dark"),
};

export const GlassSectionInLightDeck: Story = {
  args: { deckTheme: "light", sectionTheme: "glass", accent: undefined },
  play: async ({ canvasElement }) => assertSectionContrast(canvasElement, "light"),
};

export const DarkSectionInGlassDeck: Story = {
  args: { deckTheme: "glass", sectionTheme: "dark", accent: undefined },
  play: async ({ canvasElement }) => assertSectionContrast(canvasElement, "glass"),
};

export const LightSectionInGlassDeck: Story = {
  args: { deckTheme: "glass", sectionTheme: "light", accent: undefined },
  play: async ({ canvasElement }) => assertSectionContrast(canvasElement, "glass"),
};

export const GlassSectionWithLocalAccentInGlassDeck: Story = {
  args: { deckTheme: "glass", sectionTheme: "glass", accent: ACCENTS[4].value },
  play: async ({ canvasElement }) => assertSectionContrast(canvasElement, "glass"),
};

export const TerminalDeckInheritedWithLocalAccent: Story = {
  args: { deckTheme: "terminal", sectionTheme: null, accent: ACCENTS[1].value },
  play: async ({ canvasElement }) => assertSectionContrast(canvasElement, "terminal"),
};

export const TerminalSectionInDarkDeck: Story = {
  args: { deckTheme: "dark", sectionTheme: "terminal", accent: undefined },
  play: async ({ canvasElement }) => assertSectionContrast(canvasElement, "dark"),
};

export const DarkSectionInTerminalDeck: Story = {
  args: { deckTheme: "terminal", sectionTheme: "dark", accent: undefined },
  play: async ({ canvasElement }) => assertSectionContrast(canvasElement, "terminal"),
};
