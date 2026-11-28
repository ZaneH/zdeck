import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import sample from "../../packages/themes/midnight-maze.zdeck-theme.json";
import { controlVolume } from "../lib/actions";
import { createDefaultDeck, pageControls } from "../lib/deck";
import { addSection, setSectionCustomTheme } from "../lib/sections";
import { validateThemePackage } from "../lib/themePackage";
import type { CustomThemeReference } from "../lib/themePackage";
import type { InstalledTheme } from "../lib/customThemes";
import { resolveSectionTheme } from "../lib/customThemes";
import { ControlTile } from "./ControlTile";
import { PhoneDeck } from "./PhoneDeck";
import { SectionList } from "./SectionList";

const pkg = validateThemePackage(sample)!;
const reference: CustomThemeReference = { id: pkg.id, version: pkg.version, digest: "a".repeat(64) };
const installed: InstalledTheme = { package: pkg, reference, source: JSON.stringify(pkg) };
const FIRST = "page_stream_section";
const withSecond = addSection(createDefaultDeck(), "page_stream")!.deck;
const themed = setSectionCustomTheme(withSecond, FIRST, reference, pkg.appearance.base);

function SectionExample() {
  const page = themed.pages[0];
  return (
    <div style={{ width: 520, maxWidth: "100%" }}>
      <SectionList
        deck={themed} page={page} selectedSectionId={FIRST} themes={[installed]}
        onSelect={() => {}} onAdd={() => {}} onRename={() => {}} onDuplicate={() => {}}
        onRemove={() => {}} onMove={() => {}} onTheme={() => {}} onCustomTheme={() => {}} onAccent={() => {}}
        resolveTheme={(section) => resolveSectionTheme(themed, section, [installed])}
        renderControls={(section) => {
          const appearance = resolveSectionTheme(themed, section, [installed]).appearance;
          return <div className="control-grid">
            {section.controls.map((control) => <ControlTile key={control.id} control={control}
              variant="editor" appearance={appearance} volume={controlVolume(control)} />)}
          </div>;
        }}
      />
    </div>
  );
}

function PhoneExample() {
  return <div style={{ width: 390, maxWidth: "100%" }}>
    <PhoneDeck initialDeck={themed} initialStatus="loaded" mode="native" installedThemes={[installed]} />
  </div>;
}

const meta = {
  title: "Settings/External theme rendering",
  component: SectionExample,
  parameters: { layout: "padded" },
} satisfies Meta<typeof SectionExample>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Section: Story = {
  play: async ({ canvasElement }) => {
    const custom = canvasElement.querySelector<HTMLElement>('.deck-section[data-custom-theme="true"]')!;
    expect(custom.dataset.customMotif).toBe("maze");
    expect(custom.style.getPropertyValue("--bg")).toBe("#05060c");
    expect(custom.style.getPropertyValue("--tile-radius")).toBe("8px");
    expect(custom.querySelectorAll(".control-tile").length).toBeGreaterThan(0);
    const builtin = canvasElement.querySelector<HTMLElement>(".deck-section:not([data-custom-theme])")!;
    expect(builtin.dataset.customMotif).toBeUndefined();
    expect(builtin.style.getPropertyValue("--bg")).toBe("");
    expect(pageControls(themed.pages[0]).length).toBeGreaterThan(0);
  },
};

export const Phone: Story = {
  render: () => <PhoneExample />,
  play: async ({ canvasElement }) => {
    const shell = canvasElement.querySelector<HTMLElement>(".phone-shell")!;
    expect(shell.dataset.customTheme).toBe("true");
    expect(shell.dataset.customMotif).toBe("maze");
    expect(shell.style.getPropertyValue("--surface-2")).toBe("#111a3a");
    const custom = canvasElement.querySelector<HTMLElement>('.phone-section[data-custom-theme="true"]')!;
    expect(custom.dataset.customMotif).toBe("maze");
    expect(custom.querySelectorAll(".control-tile").length).toBeGreaterThan(0);
  },
};
