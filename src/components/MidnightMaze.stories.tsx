import { useState } from "react";
import type { CSSProperties } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { isControlIcon, isIconSource } from "../lib/icons";
import type { PluginSnapshots } from "../lib/plugin";
import { PRESENTATIONS, THEMES } from "../lib/types";
import type { Control, Theme } from "../lib/types";
import { ControlTile } from "./ControlTile";
import { MIDNIGHT_MAZE_ICONS } from "./fixtures/midnightMazeIcons";
import type { MidnightMazeIconName } from "./fixtures/midnightMazeIcons";
import "./midnight-maze.css";

/**
 * A Storybook-only visual prototype. It uses the real section, grid and ControlTile markup with
 * local preview semantics: no theme id, no install path, no native or plugin call.
 */
const icon = (name: MidnightMazeIconName) => MIDNIGHT_MAZE_ICONS[name].icon;
const LABELS = [
  "Camera", "Speakers", "Monitor gain", "Studio mute", "Arm relay",
  "Play the long ambient loop for the studio", "Transport offline",
  "Input level", "Coolant", "Reactor",
];

const NORMAL_CONTROLS: Control[] = [
  { id: "mm-camera", action: "obs-scene", scene: "Camera", label: "Camera", icon: icon("camera") },
  { id: "mm-volume", action: "volume", label: "Speakers", volume: 62, icon: icon("volume") },
  { id: "mm-gain", action: "volume", label: "Monitor gain", volume: 38, presentation: "dial", icon: icon("volume") },
  { id: "mm-mute", action: "plugin", label: "Studio mute", pluginId: "mm", pluginAction: "mute", pluginArgs: { enabled: true }, presentation: "toggle-switch", icon: icon("microphone") },
  { id: "mm-arm", action: "plugin", label: "Arm relay", pluginId: "mm", pluginAction: "arm", pluginArgs: { armed: false }, presentation: "toggle-button", icon: icon("power") },
];
const EXTRA_CONTROLS: Control[] = [
  { id: "mm-long", action: "media-play-pause", label: "Play the long ambient loop for the studio", icon: icon("play") },
  { id: "mm-disabled", action: "media-play-pause", label: "Transport offline", icon: icon("pause") },
];
const STATE_CONTROLS: Control[] = [
  { id: "mm-value", action: "plugin", label: "Input level", pluginId: "mm", pluginAction: "level", pluginArgs: { level: 62 }, presentation: "value", icon: icon("light") },
  { id: "mm-unknown", action: "plugin", label: "Coolant", pluginId: "mm-unknown", pluginAction: "mute", pluginArgs: { enabled: false }, presentation: "toggle-switch", icon: icon("star") },
  { id: "mm-failed", action: "plugin", label: "Reactor", pluginId: "mm-failed", pluginAction: "level", pluginArgs: { level: 10 }, presentation: "value", icon: icon("power") },
];
const ALL_CONTROLS = [...NORMAL_CONTROLS, ...EXTRA_CONTROLS, ...STATE_CONTROLS];
const DISABLED_IDS = new Set(["mm-disabled"]);

const levelConfig = { level: { type: "integer" as const, minimum: 0, maximum: 100, control: { step: 1 }, choicesKey: "levels" } };
const levelValue = { id: "level", title: "Input level", config: levelConfig, stateKey: "levels", entityKey: "level" };
const plugins: PluginSnapshots = {
  mm: {
    status: "connected", lastError: null,
    state: {
      muted: true, armed: false,
      levels: [{ value: 62, label: "Input", available: true, observation: { value: 62, unit: "%", observedAtMs: 1_700_000_000_000 } }],
    },
    manifest: {
      id: "mm", version: "1.0.0", protocolVersion: 1,
      actions: [
        { id: "mute", title: "Studio mute", config: { enabled: { type: "boolean", control: { stateKey: "muted" } } } },
        { id: "arm", title: "Arm relay", config: { armed: { type: "boolean", control: { stateKey: "armed" } } } },
        { id: "level", title: "Input level", config: levelConfig },
      ],
      values: [levelValue],
    },
  },
  "mm-unknown": {
    status: "connected", lastError: null, state: {},
    manifest: {
      id: "mm-unknown", version: "1.0.0", protocolVersion: 1,
      actions: [{ id: "mute", title: "Coolant", config: { enabled: { type: "boolean", control: { stateKey: "muted" } } } }],
    },
  },
  "mm-failed": {
    status: "connected",
    lastError: { kind: "plugin", code: null, outcome: "not_started", message: "Reading failed.", hint: "Check the plugin." },
    state: { levels: [] },
    manifest: { id: "mm-failed", version: "1.0.0", protocolVersion: 1, actions: [levelValue], values: [levelValue] },
  },
};

const CAPTION = "Prototype only — not an installable theme or a built-in appearance. Local preview; nothing is sent.";

type Viewport = "desktop" | "phone";

function MidnightMaze({ viewport }: { viewport: Viewport }) {
  const [volumes, setVolumes] = useState<Record<string, number>>({ "mm-volume": 62, "mm-gain": 38 });
  const tiles = (controls: Control[], variant: "editor" | "phone") => controls.map(control => (
    <ControlTile key={control.id} control={control} plugins={plugins} variant={variant} appearance="dark"
      volume={volumes[control.id] ?? 0} disabled={DISABLED_IDS.has(control.id)}
      onVolumeChange={value => setVolumes(current => ({ ...current, [control.id]: value }))} />
  ));
  const grid: CSSProperties = { gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gridAutoRows: 156 };

  if (viewport === "phone") return (
    <div className="midnight-maze-stage midnight-maze" data-theme="dark" data-testid="midnight-maze"
      style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", placeItems: "start center" }}>
      <div className="phone-shell" data-theme="midnight" style={{ width: 390, maxWidth: "100%" }}>
        <p className="phone-status">{CAPTION}</p>
        <main className="phone-main">
          <div className="phone-page-heading"><h1>Midnight Maze</h1></div>
          <section className="phone-section" data-theme="midnight" aria-labelledby="mm-phone-heading">
            <h2 className="section-heading" id="mm-phone-heading">Deck controls</h2>
            <div className="phone-grid">{tiles(ALL_CONTROLS, "phone")}</div>
          </section>
        </main>
      </div>
    </div>
  );

  return (
    <div className="midnight-maze-stage midnight-maze" data-theme="dark" data-testid="midnight-maze"
      style={{ padding: 24, display: "grid", placeItems: "start center" }}>
      <div data-testid="midnight-maze-content" style={{ width: "fit-content" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 20 }}>
          <section className="deck-section" data-theme="midnight" aria-labelledby="mm-desktop-heading" style={{ width: 396 }}>
            <h2 className="section-heading" id="mm-desktop-heading">Deck controls</h2>
            <div className="control-grid" style={grid}>{tiles([...NORMAL_CONTROLS, ...EXTRA_CONTROLS], "editor")}</div>
          </section>
          <section className="deck-section" data-theme="midnight" aria-labelledby="mm-states-heading" style={{ width: 396 }}>
            <h2 className="section-heading" id="mm-states-heading">Readings and states</h2>
            <div className="control-grid" style={grid}>{tiles(STATE_CONTROLS, "editor")}</div>
          </section>
        </div>
        <p className="field-note" style={{ margin: "10px 0 0" }}>{CAPTION}</p>
      </div>
    </div>
  );
}

function IconSurfaces() {
  const entries = Object.entries(MIDNIGHT_MAZE_ICONS) as [MidnightMazeIconName, (typeof MIDNIGHT_MAZE_ICONS)[MidnightMazeIconName]][];
  const surfaces: { theme: Theme; title: string }[] = [
    { theme: "dark", title: "Production dark surface" },
    { theme: "light", title: "Production light surface" },
  ];
  return (
    <div data-testid="midnight-maze-icons" style={{ display: "grid", gap: 16, maxWidth: 760 }}>
      {surfaces.map(({ theme, title }) => (
        <section key={theme} className="deck-section" data-theme={theme} data-appearance={theme} aria-label={title}>
          <h2 className="section-heading">{title}</h2>
          <div className="control-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gridAutoRows: 104 }}>
            {entries.map(([name, entry]) => (
              <ControlTile key={name} control={{ id: `mm-icon-${name}`, action: "media-play-pause", label: entry.title, icon: entry.icon }}
                variant="editor" appearance={theme} volume={0} />
            ))}
          </div>
        </section>
      ))}
      <p className="field-note">The same data-only pixel icons, rendered without Midnight Maze CSS on the existing Dark and Light surfaces.</p>
    </div>
  );
}

const meta = {
  title: "Themes/Midnight Maze (prototype)",
  component: MidnightMaze,
  args: { viewport: "desktop" },
  argTypes: { viewport: { control: "inline-radio", options: ["desktop", "phone"] } },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof MidnightMaze>;
export default meta;
type Story = StoryObj<typeof meta>;

function expectInside(rect: DOMRect, bounds: DOMRect, edge = 1) {
  expect(rect.left).toBeGreaterThanOrEqual(bounds.left - edge);
  expect(rect.right).toBeLessThanOrEqual(bounds.right + edge);
  expect(rect.top).toBeGreaterThanOrEqual(bounds.top - edge);
  expect(rect.bottom).toBeLessThanOrEqual(bounds.bottom + edge);
}

async function assertFixture(fixture: HTMLElement, viewport: Viewport) {
  const sections = Array.from(fixture.querySelectorAll<HTMLElement>(".deck-section, .phone-section"));
  expect(sections).toHaveLength(viewport === "desktop" ? 2 : 1);
  const tiles = sections.flatMap(section => Array.from(section.querySelectorAll<HTMLElement>(".control-tile")));
  expect(tiles).toHaveLength(ALL_CONTROLS.length);

  // The prototype is scoped: the page outside keeps the production appearance and theme list.
  expect(THEMES).toEqual(["dark", "light", "glass", "terminal", "macintosh"]);
  expect((THEMES as readonly string[]).includes("midnight")).toBe(false);
  expect(getComputedStyle(fixture).getPropertyValue("--bg").trim()).toBe("#05060c");
  expect(getComputedStyle(document.documentElement).getPropertyValue("--bg").trim()).not.toBe("#05060c");

  for (const label of LABELS) expect(fixture.textContent).toContain(label);
  for (const presentation of PRESENTATIONS) {
    expect(tiles.map(tile => tile.dataset.presentation)).toContain(presentation);
  }
  expect(fixture.querySelector(".control-tile.is-disabled")).not.toBeNull();
  expect(fixture.textContent).toContain("State unknown");
  expect(fixture.textContent).toContain("Reading failed");

  const images = Array.from(fixture.querySelectorAll<HTMLImageElement>(".control-icon-image"));
  expect(images.length).toBeGreaterThanOrEqual(9);
  for (const image of images) {
    expect(isIconSource(image.src)).toBe(true);
    if (!image.complete) await new Promise(resolve => {
      image.addEventListener("load", resolve, { once: true });
      image.addEventListener("error", resolve, { once: true });
    });
    await image.decode?.().catch(() => undefined);
    expect(image.naturalWidth).toBeGreaterThan(0);
    expect(image.naturalHeight).toBeGreaterThan(0);
  }
  for (const entry of Object.values(MIDNIGHT_MAZE_ICONS)) {
    expect(isControlIcon(entry.icon)).toBe(true);
  }

  // Every focusable/touch target keeps a 44px hit area, and the main button takes focus.
  for (const target of Array.from(fixture.querySelectorAll<HTMLElement>('[data-presentation="button"] .tile-primary:is(button):not(:disabled), .tile-toggle:not(:disabled), .dial-face, .tile-volume input:not([hidden]):not(:disabled)'))) {
    const box = target.getBoundingClientRect();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
  const primary = tiles.find(tile => tile.dataset.presentation === "button")!.querySelector<HTMLButtonElement>(".tile-primary")!;
  primary.focus();
  expect(document.activeElement).toBe(primary);
  const dial = fixture.querySelector<HTMLElement>(".dial-face")!;
  dial.focus();
  expect(document.activeElement).toBe(dial);

  for (const tile of tiles) {
    const box = tile.getBoundingClientRect();
    const section = tile.closest<HTMLElement>(".deck-section, .phone-section")!;
    const sectionBox = section.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(0);
    expectInside(box, sectionBox);
    if (tile.dataset.presentation === "dial") {
      const header = tile.querySelector<HTMLElement>(".tile-primary")!.getBoundingClientRect();
      const face = tile.querySelector<HTMLElement>(".dial-face")!.getBoundingClientRect();
      expect(face.width).toBeGreaterThanOrEqual(44);
      expect(face.height).toBeGreaterThanOrEqual(44);
      expect(face.top - header.bottom).toBeGreaterThanOrEqual(4);
      expect(box.bottom - face.bottom).toBeGreaterThanOrEqual(6);
      expectInside(face, box);
    }
  }

  const assertViewport = () => {
    for (const section of sections) {
      const box = section.getBoundingClientRect();
      expect(box.left).toBeGreaterThanOrEqual(-1);
      expect(box.right).toBeLessThanOrEqual(window.innerWidth + 1);
      for (const tile of section.querySelectorAll<HTMLElement>(".control-tile")) {
        expectInside(tile.getBoundingClientRect(), box);
        expect(tile.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth + 1);
      }
    }
  };
  assertViewport();
  if (viewport === "phone") {
    const shell = fixture.querySelector<HTMLElement>(".phone-shell")!;
    expect(shell.getBoundingClientRect().width).toBeLessThanOrEqual(390);
    const width = shell.style.width;
    shell.style.width = "320px";
    assertViewport();
    for (const section of sections) {
      for (const tile of section.querySelectorAll<HTMLElement>(".control-tile")) {
        expectInside(tile.getBoundingClientRect(), section.getBoundingClientRect());
      }
    }
    shell.style.width = width;
  }
}

export const Desktop: Story = {
  args: { viewport: "desktop" },
  play: async ({ canvasElement }) => {
    await document.fonts.ready;
    await assertFixture(canvasElement.querySelector<HTMLElement>('[data-testid="midnight-maze"]')!, "desktop");
  },
};

export const Phone: Story = {
  args: { viewport: "phone" },
  play: async ({ canvasElement }) => {
    await document.fonts.ready;
    await assertFixture(canvasElement.querySelector<HTMLElement>('[data-testid="midnight-maze"]')!, "phone");
  },
};

export const IconsOnSurfaces: Story = {
  render: () => <IconSurfaces />,
  parameters: { layout: "padded" },
  play: async ({ canvasElement }) => {
    const fixture = canvasElement.querySelector<HTMLElement>('[data-testid="midnight-maze-icons"]')!;
    const sections = Array.from(fixture.querySelectorAll<HTMLElement>(".deck-section"));
    expect(sections.map(section => section.dataset.theme)).toEqual(["dark", "light"]);
    expect(fixture.querySelectorAll(".control-icon-image")).toHaveLength(Object.keys(MIDNIGHT_MAZE_ICONS).length * 2);
    // Production surfaces own their tokens; the prototype token block is not applied here.
    expect(getComputedStyle(sections[0]).getPropertyValue("--bg").trim()).toBe("#18191b");
    expect(getComputedStyle(sections[1]).getPropertyValue("--bg").trim()).toBe("#f4f5f6");
  },
};
