import { useEffect } from "react";
import type { CSSProperties } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { ACCENTS } from "../lib/types";
import type { Control, Theme } from "../lib/types";
import { applyTheme } from "../lib/theme";
import { ControlTile } from "./ControlTile";

const tile: Control = { id: "story-volume", action: "volume", label: "Speakers", volume: 50 };

/** Fixture markup mirrors SectionList and PhoneDeck; the shared section classes carry the theme boundary. */
function SectionExample({ deckTheme, sectionTheme, accent }: { deckTheme: Theme; sectionTheme: Theme | null; accent?: string }) {
  // The deck theme is global in the app; Storybook's toolbar applies it too.
  useEffect(() => { applyTheme(deckTheme, ACCENTS[0].value); }, [deckTheme]);
  // Production sectionStyle only sets --accent inline; without data-theme the section inherits the deck theme.
  const style = accent ? ({ "--accent": accent } as CSSProperties) : undefined;
  return <div style={{ display: "grid", gap: 16, maxWidth: 520 }}>
    <section className="deck-section" data-theme={sectionTheme ?? undefined} style={style}>
      <h2 className="section-heading">Editor section</h2>
      <p>Inherited label text</p>
      <span className="sr-only" data-probe="muted" style={{ color: "var(--text-muted)" }} />
      <div className="control-grid"><ControlTile control={tile} variant="editor" volume={50} /></div>
    </section>
    <section className="phone-section" data-theme={sectionTheme ?? undefined} style={style}>
      <h2 className="section-heading">Phone section</h2>
      <p>Inherited label text</p>
      <span className="sr-only" data-probe="muted" style={{ color: "var(--text-muted)" }} />
      <div className="phone-grid"><ControlTile control={tile} variant="phone" volume={50} /></div>
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
function luminance(color: string): number {
  const channel = (value: number) => {
    const scaled = value / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = channels(color);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
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
  for (const section of sections) {
    const style = getComputedStyle(section);
    // A phone section without its own data-theme has no backdrop; its text sits on the deck.
    const ownBackground = style.backgroundColor;
    const background = ownBackground === "rgba(0, 0, 0, 0)" ? getComputedStyle(document.body).backgroundColor : ownBackground;
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
    for (const label of section.querySelectorAll<HTMLElement>(".section-heading, .tile-icon, .tile-label")) {
      const color = getComputedStyle(label).color;
      expect(color).toBe(getComputedStyle(muted).color);
      expect(color).not.toBe(style.color);
      expect(contrast(color, background)).toBeGreaterThanOrEqual(4.5);
    }
    // Assert the tile's resolved accent, not the serialized custom-property text.
    const tileElement = section.querySelector<HTMLElement>(".control-tile")!;
    const probe = document.createElement("span");
    probe.style.color = "var(--control-accent)";
    tileElement.appendChild(probe);
    const actual = getComputedStyle(probe).color;
    probe.remove();
    const sectionTheme = section.dataset.theme ?? deckTheme;
    const accent = getComputedStyle(section).getPropertyValue("--accent").trim() || ACCENTS[0].value;
    expectColor(actual, expectedMix(accent, style.color, sectionTheme === "dark" ? 1 : 0.65));
  }
}

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
