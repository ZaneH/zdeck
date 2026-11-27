import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { controlVolume } from "../lib/actions";
import {
  MAX_CONTROLS_PER_PAGE,
  addControl,
  createDefaultDeck,
  duplicateControl,
  pageControls,
} from "../lib/deck";
import { duplicateSection } from "../lib/sections";
import type { Deck } from "../lib/types";
import { ControlTile } from "./ControlTile";
import { SectionList } from "./SectionList";

function DuplicateHarness({ deck: initialDeck }: { deck: Deck }) {
  const [deck, setDeck] = useState(initialDeck);
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(initialDeck.pages[0].sections[0].id);
  const [selectedControlId, setSelectedControlId] = useState<string | null>(null);
  const page = deck.pages[0];
  const pageIsFull = pageControls(page).length >= MAX_CONTROLS_PER_PAGE;

  return <SectionList
    deck={deck} page={page} selectedSectionId={selectedSectionId}
    onSelect={setSelectedSectionId} onAdd={() => {}}
    onRename={() => {}} onDuplicate={(sectionId) => {
      const result = duplicateSection(deck, page.id, sectionId);
      if (!result) return;
      setDeck(result.deck);
      setSelectedSectionId(result.section.id);
      setSelectedControlId(null);
    }} onRemove={() => {}} onMove={() => {}} onTheme={() => {}} onAccent={() => {}}
    renderControls={(section) => <div className="control-grid">
      {section.controls.map((control) => <ControlTile
        key={control.id} control={control} variant="editor" volume={controlVolume(control)}
        selected={selectedControlId === control.id}
        onRename={() => {}} onDelete={() => {}}
        onDuplicate={() => {
          const result = duplicateControl(deck, page.id, control.id);
          if (!result) return;
          setDeck(result.deck);
          setSelectedSectionId(section.id);
          setSelectedControlId(result.control.id);
        }}
        duplicateReason={pageIsFull ? "Page has 24 controls. Remove one first." : undefined}
      />)}
    </div>}
  />;
}

const deck = createDefaultDeck();
let fullDeck = deck;
for (let index = pageControls(fullDeck.pages[0]).length; index < MAX_CONTROLS_PER_PAGE; index += 1) {
  fullDeck = addControl(fullDeck, "page_stream", "mic-mute", { label: `Mute ${index}` })!.deck;
}

const meta = {
  title: "Workspace/Duplicate",
  component: DuplicateHarness,
  args: { deck },
  parameters: { layout: "padded" },
} satisfies Meta<typeof DuplicateHarness>;
export default meta;
type Story = StoryObj<typeof meta>;

function labels(canvasElement: HTMLElement): string[] {
  return Array.from(canvasElement.querySelectorAll(".control-tile .tile-label"), (node) => node.textContent ?? "");
}

export const ControlContextMenu: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    canvasElement.querySelector<HTMLElement>(".control-tile")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await userEvent.click(await canvas.findByRole("menuitem", { name: "Duplicate" }));
    expect(labels(canvasElement).slice(0, 2)).toEqual(["Starting soon", "Starting soon copy"]);
    expect(canvasElement.querySelector(".control-tile.is-selected .tile-label")?.textContent).toBe("Starting soon copy");
  },
};

export const SectionSettings: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Section settings for Stream" }));
    await userEvent.click(await canvas.findByRole("menuitem", { name: "Duplicate section" }));
    const names = Array.from(canvasElement.querySelectorAll<HTMLInputElement>(".section-name-input"), (input) => input.value);
    expect(names).toEqual(["Stream", "Stream copy"]);
    expect(canvasElement.querySelector<HTMLInputElement>(".deck-section.is-selected .section-name-input")?.value).toBe("Stream copy");
    expect(canvasElement.querySelectorAll(".deck-section")[1].querySelectorAll(".control-tile")).toHaveLength(4);
  },
};

export const Capacity: Story = {
  args: { deck: fullDeck },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    canvasElement.querySelector<HTMLElement>(".control-tile")!
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    const duplicate = await canvas.findByRole("menuitem", { name: "Duplicate" });
    expect(duplicate).toHaveAttribute("aria-disabled", "true");
    expect(duplicate).toHaveAccessibleDescription("Page has 24 controls. Remove one first.");
    await userEvent.click(duplicate);
    expect(canvasElement.querySelectorAll(".control-tile")).toHaveLength(MAX_CONTROLS_PER_PAGE);
    expect(labels(canvasElement).some((label) => label.endsWith(" copy"))).toBe(false);

    await userEvent.click(canvas.getByRole("button", { name: "Section settings for Stream" }));
    const sectionDuplicate = await canvas.findByRole("menuitem", { name: /Duplicate section/ });
    expect(sectionDuplicate).toBeDisabled();
    expect(sectionDuplicate).toHaveTextContent("Page has 24 controls; a copy needs 24 more.");
  },
};
