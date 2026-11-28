import { useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import sample from "../../packages/themes/midnight-maze.zdeck-theme.json";
import { validateThemePackage } from "../lib/themePackage";
import type { CustomThemeReference } from "../lib/themePackage";
import type { InstalledTheme, ThemeAdapter } from "../lib/customThemes";
import { ThemesSettingsCard } from "./ThemesSettingsCard";

const pkg = validateThemePackage(sample)!;
const SOURCE = JSON.stringify(pkg);
const reference: CustomThemeReference = { id: pkg.id, version: pkg.version, digest: "a".repeat(64) };
const installed: InstalledTheme = { package: pkg, reference, source: SOURCE };

type Fixture = {
  initialThemes?: InstalledTheme[];
  pick?: () => Promise<string | null>;
  installError?: string;
  removeError?: string;
  width?: number;
};

function ThemesHarness({ initialThemes = [], pick = async () => SOURCE, installError, removeError, width = 720 }: Fixture) {
  const [themes, setThemes] = useState(initialThemes);
  const [events, setEvents] = useState<string[]>([]);
  const log = (event: string) => setEvents((current) => [...current, event]);
  const adapter: ThemeAdapter = useMemo(() => ({
    available: () => true,
    list: async () => themes,
    pick: async () => { log("pick"); return pick(); },
    install: async () => {
      log("install");
      if (installError) throw new Error(installError);
      const next = { ...installed, reference: { ...reference, digest: "b".repeat(64) } };
      setThemes([next]);
      return next;
    },
    remove: async () => {
      log("remove");
      if (removeError) throw new Error(removeError);
      setThemes([]);
    },
  }), [themes, pick, installError, removeError]);
  return (
    <div style={{ width, maxWidth: "100%" }} data-events={events.join(",")}>
      <ThemesSettingsCard adapter={adapter} themes={themes} loading={false} loadError={null}
        onRefresh={async () => log("refresh")}
        onUseTheme={(theme) => log(`use:${theme.reference.digest}`)}
        isInUse={() => false} />
    </div>
  );
}

const meta = {
  title: "Settings/External themes",
  component: ThemesHarness,
  args: {},
  parameters: { layout: "padded" },
} satisfies Meta<typeof ThemesHarness>;
export default meta;
type Story = StoryObj<typeof meta>;

const events = (canvasElement: HTMLElement) => canvasElement.querySelector<HTMLElement>("[data-events]")?.dataset.events ?? "";

export const ImportCancel: Story = {
  args: { pick: async () => null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Import theme file…" }));
    await waitFor(() => expect(events(canvasElement)).toContain("pick"));
    expect(canvas.queryByRole("button", { name: "Install theme" })).toBeNull();
    expect(events(canvasElement)).not.toContain("install");
  },
};

export const InvalidPackage: Story = {
  args: { pick: async () => "{}" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Import theme file…" }));
    await waitFor(() => expect(canvas.getByRole("alert")).toHaveTextContent("not a valid theme package"));
    expect(canvas.queryByRole("button", { name: "Install theme" })).toBeNull();
    expect(events(canvasElement)).not.toContain("install");
  },
};

export const InstallPreviewDoesNotApply: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Import theme file…" }));
    await waitFor(() => expect(canvas.getByText("Midnight Maze")).toBeVisible());
    expect(canvas.getByText("Preview only. No appearance has been saved.")).toBeVisible();
    expect(canvasElement.querySelector(".theme-preview .control-tile")).not.toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Install theme" }));
    await waitFor(() => expect(events(canvasElement)).toContain("install"));
    expect(events(canvasElement)).not.toContain("use:");
    expect(canvasElement.querySelector(".theme-row[data-theme-id='midnight-maze']")).not.toBeNull();
  },
};

export const ExplicitUseForDeck: Story = {
  args: { initialThemes: [installed] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Use for deck" }));
    await waitFor(() => expect(events(canvasElement)).toContain("use:"));
    expect(events(canvasElement)).toContain(reference.digest);
  },
};

export const RemoveFailure: Story = {
  args: { initialThemes: [installed], removeError: "Theme is in use by a saved deck." },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(canvas.getByRole("alert")).toHaveTextContent("Theme is in use by a saved deck."));
    expect(events(canvasElement)).toContain("remove");
  },
};

export const RestartWithProvidedCatalog: Story = {
  args: { initialThemes: [installed] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("Midnight Maze")).toBeVisible();
    expect(canvas.getByText("SHA-256")).toBeVisible();
    expect(canvas.getByText(reference.digest)).toBeVisible();
    expect(canvasElement.textContent).toContain("Zane Helton");
    expect(events(canvasElement)).toBe("");
  },
};

export const Narrow: Story = {
  args: { initialThemes: [installed], width: 320 },
  play: async ({ canvasElement }) => {
    const row = canvasElement.querySelector<HTMLElement>(".theme-row")!;
    expect(row.getBoundingClientRect().width).toBeLessThanOrEqual(320);
  },
};
