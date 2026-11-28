import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import sample from "../../packages/themes/midnight-maze.zdeck-theme.json";
import { appearanceTokens } from "../lib/customThemes";
import { validateThemePackage } from "../lib/themePackage";
import type { ThemePackage } from "../lib/themePackage";
import { PRESENTATIONS } from "../lib/types";
import { StandardFixture } from "./ThemePreview.stories";

// The story imports the shared package locally. It is not a built-in appearance and is not
// added to the theme list; installing or selecting it remains a separate desktop action.
const parsed = validateThemePackage(sample);
if (!parsed) throw new Error("packages/themes/midnight-maze.zdeck-theme.json is not a valid theme package");
const pkg: ThemePackage = parsed;
const tokens = appearanceTokens(pkg.appearance);

const meta = {
  title: "Themes/External theme preview",
  component: StandardFixture,
  args: { theme: pkg.appearance.base, viewport: "desktop", customAppearance: pkg.appearance },
  argTypes: {
    theme: { control: false },
    customAppearance: { control: false },
    viewport: { control: "inline-radio", options: ["desktop", "phone"] },
  },
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component: "External package preview. This story imports packages/themes/midnight-maze.zdeck-theme.json locally; the package is not a built-in appearance and is not in the theme list.",
      },
    },
  },
} satisfies Meta<typeof StandardFixture>;
export default meta;
type Story = StoryObj<typeof meta>;

function assertExternalPreview(canvasElement: HTMLElement, viewport: "desktop" | "phone") {
  const fixture = canvasElement.querySelector<HTMLElement>('[data-testid="theme-preview"]')!;
  const sections = Array.from(fixture.querySelectorAll<HTMLElement>(".deck-section, .phone-section"));
  expect(sections).toHaveLength(viewport === "desktop" ? 2 : 1);
  expect(fixture.dataset.theme).toBe("dark");
  expect(fixture.dataset.appearance).toBe("dark");
  expect(fixture.dataset.customTheme).toBe("true");
  expect(fixture.dataset.customMotif).toBe("maze");

  const customTargets = [fixture, ...sections];
  const shell = fixture.querySelector<HTMLElement>(".phone-shell");
  if (shell) customTargets.push(shell);
  for (const target of customTargets) {
    expect(target.dataset.customTheme).toBe("true");
    expect(target.dataset.customMotif).toBe(sections.includes(target) ? undefined : "maze");
    expect(getComputedStyle(target).getPropertyValue("--bg").trim()).toBe("#05060c");
    expect(getComputedStyle(target).getPropertyValue("--tile-radius").trim()).toBe("8px");
    expect(getComputedStyle(target).getPropertyValue("--custom-motif-image").trim()).toContain("data:image/svg+xml");
  }

  const tiles = sections.flatMap((section) => Array.from(section.querySelectorAll<HTMLElement>(".control-tile")));
  expect(tiles).toHaveLength(8);
  for (const presentation of PRESENTATIONS) expect(tiles.map((tile) => tile.dataset.presentation)).toContain(presentation);
  expect(tiles[6].querySelector(".tile-toggle")!.textContent).toContain("State unknown");
  expect(tiles[7].querySelector(".tile-reading output")!.textContent).toContain("Reading failed");
  expect(getComputedStyle(tiles[0]).borderTopLeftRadius).toBe("8px");
  expect(getComputedStyle(sections[0]).backgroundImage).toBe("none");

  for (const section of sections) {
    const bounds = section.getBoundingClientRect();
    expect(bounds.right).toBeLessThanOrEqual(window.innerWidth + 1);
    for (const tile of section.querySelectorAll<HTMLElement>(".control-tile")) {
      const box = tile.getBoundingClientRect();
      expect(box.width).toBeGreaterThan(0);
      expect(box.left).toBeGreaterThanOrEqual(-1);
      expect(box.right).toBeLessThanOrEqual(window.innerWidth + 1);
      expect(box.right).toBeLessThanOrEqual(bounds.right + 1);
    }
  }
  expect(Object.keys(tokens)).toHaveLength(20);
  expect(pkg.id).toBe("midnight-maze");
  expect(pkg.version).toBe("0.1.0");
}

export const MidnightMazePackageDesktop: Story = {
  name: "Midnight Maze external package — desktop (local import)",
  args: { viewport: "desktop" },
  play: async ({ canvasElement }) => assertExternalPreview(canvasElement, "desktop"),
};

export const MidnightMazePackagePhone: Story = {
  name: "Midnight Maze external package — phone (local import)",
  args: { viewport: "phone" },
  play: async ({ canvasElement }) => assertExternalPreview(canvasElement, "phone"),
};
