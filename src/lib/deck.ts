import { isControlIcon } from "./icons";
import { ACCENTS, DECK_VERSION } from "./types";
import type {
  Accent,
  ActionKind,
  Control,
  ControlPatch,
  ControlOptions,
  Deck,
  Page,
  Presentation,
  Section,
  Theme,
} from "./types";
import { actionDefinition, clampVolume, createControl, newId } from "./actions";
import { isPluginArgs, pluginIdentifier } from "./plugin";

export const MAX_PAGES = 12;
export const MAX_CONTROLS_PER_PAGE = 24;
export const MAX_ROW_SPAN = 24;
export const MAX_COLUMN_SPAN = 4;
const MAX_SECTION_BYTES = 128;
export function isSpan(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}

export function findPage(deck: Deck, pageId: string): Page | undefined {
  return deck.pages.find((page) => page.id === pageId);
}

export function pageControls(page: Page): Control[] {
  return page.sections.flatMap((section) => section.controls);
}

export function findControl(
  deck: Deck,
  pageId: string,
  controlId: string,
): Control | undefined {
  const page = findPage(deck, pageId);
  return page ? pageControls(page).find((control) => control.id === controlId) : undefined;
}

export function activePage(deck: Deck): Page {
  return findPage(deck, deck.activePageId) ?? deck.pages[0];
}

function mapPage(deck: Deck, pageId: string, update: (page: Page) => Page): Deck {
  let changed = false;
  const pages = deck.pages.map((page) => {
    if (page.id !== pageId) return page;
    const next = update(page);
    if (next === page) return page;
    changed = true;
    return next;
  });
  return changed ? { ...deck, pages } : deck;
}

export function setActivePage(deck: Deck, pageId: string): Deck {
  if (deck.activePageId === pageId || !findPage(deck, pageId)) return deck;
  return { ...deck, activePageId: pageId };
}

export function addPage(deck: Deck, name?: string): { deck: Deck; page: Page } | null {
  if (deck.pages.length >= MAX_PAGES) return null;
  const page: Page = {
    id: newId("page"),
    name: name?.trim() || `Page ${deck.pages.length + 1}`,
    sections: [{ id: newId("section"), name: "Section 1", controls: [] }],
  };
  return {
    deck: { ...deck, pages: [...deck.pages, page], activePageId: page.id },
    page,
  };
}

export function renamePage(deck: Deck, pageId: string, name: string): Deck {
  const trimmed = name.trim();
  if (!trimmed) return deck;
  return mapPage(deck, pageId, (page) =>
    page.name === trimmed ? page : { ...page, name: trimmed },
  );
}

export function removePage(deck: Deck, pageId: string): Deck {
  if (deck.pages.length <= 1) return deck;
  const index = deck.pages.findIndex((page) => page.id === pageId);
  if (index < 0) return deck;

  const pages = deck.pages.filter((page) => page.id !== pageId);
  const activePageId =
    deck.activePageId === pageId
      ? pages[Math.min(index, pages.length - 1)].id
      : deck.activePageId;
  return { ...deck, pages, activePageId };
}

export function movePage(deck: Deck, pageId: string, delta: number): Deck {
  const index = deck.pages.findIndex((page) => page.id === pageId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= deck.pages.length) return deck;

  const pages = [...deck.pages];
  [pages[index], pages[target]] = [pages[target], pages[index]];
  return { ...deck, pages };
}

export function addControl(
  deck: Deck,
  pageId: string,
  kind: ActionKind,
  options?: ControlOptions,
  sectionId?: string,
): { deck: Deck; control: Control } | null {
  const page = findPage(deck, pageId);
  const section = page?.sections.find((item) => item.id === (sectionId ?? page.sections[0]?.id));
  if (!page || !section || pageControls(page).length >= MAX_CONTROLS_PER_PAGE) return null;

  const control = createControl(kind, options);
  const next = mapPage(deck, pageId, (current) => ({
    ...current,
    sections: current.sections.map((item) =>
      item.id === section.id ? { ...item, controls: [...item.controls, control] } : item,
    ),
  }));
  return { deck: next, control };
}

function patchControl(control: Control, patch: ControlPatch): Control {
  const action = patch.action ?? control.action;
  const actionChanged = action !== control.action;
  if (patch.icon !== undefined && patch.icon !== null && !isControlIcon(patch.icon)) return control;
  const icon = patch.icon === undefined ? control.icon : patch.icon;
  if (patch.rowSpan !== undefined && !isSpan(patch.rowSpan, MAX_ROW_SPAN)) return control;
  if (patch.columnSpan !== undefined && !isSpan(patch.columnSpan, MAX_COLUMN_SPAN)) return control;
  const presentation = actionChanged ? undefined : patch.presentation ?? control.presentation;
  if (presentation !== undefined && !validPresentation(action, presentation)) return control;
  const base = {
    ...(presentation ? { presentation } : {}),
    ...(patch.rowSpan !== undefined || control.rowSpan !== undefined ? { rowSpan: patch.rowSpan ?? control.rowSpan } : {}),
    ...(patch.columnSpan !== undefined || control.columnSpan !== undefined ? { columnSpan: patch.columnSpan ?? control.columnSpan } : {}),
    ...(icon ? { icon } : {}),
    id: control.id,
    label:
      patch.label !== undefined
        ? patch.label.trim() || control.label
        : actionChanged
          ? actionDefinition(action).defaultLabel
          : control.label,
  };

  switch (action) {
    case "plugin": {
      const previous = control.action === "plugin" ? control : null;
      const pluginId = patch.pluginId ?? previous?.pluginId;
      const pluginAction = patch.pluginAction ?? previous?.pluginAction;
      const pluginArgs = patch.pluginArgs ?? previous?.pluginArgs;
      if (!pluginIdentifier(pluginId) || !pluginIdentifier(pluginAction) || !isPluginArgs(pluginArgs)) return control;
      return { ...base, action, pluginId, pluginAction, pluginArgs: { ...pluginArgs } };
    }
    case "obs-scene": {
      const scene =
        action === control.action && control.action === "obs-scene"
          ? control.scene
          : "Scene 1";
      const nextScene = patch.scene?.trim() || scene;
      const autoLabel = patch.label !== undefined
        ? !patch.label.trim()
        : actionChanged || (control.action === "obs-scene" && control.autoLabel === true);
      return {
        ...base,
        action,
        scene: nextScene,
        label: autoLabel ? nextScene : base.label,
        ...(autoLabel ? { autoLabel: true } : {}),
      };
    }
    case "mic-mute":
      return { ...base, action };
    case "media-play-pause":
      return { ...base, action };
    case "volume": {
      const volume =
        action === control.action && control.action === "volume" ? control.volume : 50;
      return { ...base, action, volume: clampVolume(patch.volume ?? volume) };
    }
  }
}

function mapSection(deck: Deck, pageId: string, controlId: string, update: (section: Section) => Section): Deck {
  return mapPage(deck, pageId, (current) => ({
    ...current,
    sections: current.sections.map((section) =>
      section.controls.some((control) => control.id === controlId)
        ? update(section)
        : section,
    ),
  }));
}

export function updateControl(
  deck: Deck,
  pageId: string,
  controlId: string,
  patch: ControlPatch,
): Deck {
  const page = findPage(deck, pageId);
  if (!page || !findControl(deck, pageId, controlId)) return deck;

  return mapSection(deck, pageId, controlId, (section) => ({
    ...section,
    controls: section.controls.map((control) =>
      control.id === controlId ? patchControl(control, patch) : control,
    ),
  }));
}

export function removeControl(deck: Deck, pageId: string, controlId: string): Deck {
  const page = findPage(deck, pageId);
  if (!page || !findControl(deck, pageId, controlId)) return deck;

  return mapSection(deck, pageId, controlId, (section) => ({
    ...section,
    controls: section.controls.filter((control) => control.id !== controlId),
  }));
}

export function moveControl(
  deck: Deck,
  pageId: string,
  controlId: string,
  delta: number,
): Deck {
  const page = findPage(deck, pageId);
  if (!page) return deck;
  const section = page.sections.find((item) =>
    item.controls.some((control) => control.id === controlId),
  );
  if (!section) return deck;
  const index = section.controls.findIndex((control) => control.id === controlId);
  const target = index + delta;
  if (!Number.isSafeInteger(target) || target < 0 || target >= section.controls.length || target === index) return deck;

  return mapSection(deck, pageId, controlId, (current) => {
    const controls = [...current.controls];
    const [control] = controls.splice(index, 1);
    controls.splice(target, 0, control);
    return { ...current, controls };
  });
}

export function setTheme(deck: Deck, theme: Theme): Deck {
  return deck.theme === theme ? deck : { ...deck, theme };
}

export function setAccent(deck: Deck, accent: Accent): Deck {
  return deck.accent === accent ? deck : { ...deck, accent };
}

export function createDefaultDeck(): Deck {
  return {
    version: DECK_VERSION,
    theme: "dark",
    accent: "#4cc9f0",
    activePageId: "page_stream",
    pages: [
      {
        id: "page_stream",
        name: "Stream",
        sections: [
          {
            id: "page_stream_section",
            name: "Stream",
            controls: [
              {
                id: "ctl_starting_soon",
                label: "Starting soon",
                action: "obs-scene",
                scene: "Starting soon",
              },
              {
                id: "ctl_live",
                label: "Go live",
                action: "obs-scene",
                scene: "Live",
              },
              {
                id: "ctl_mic",
                label: "Mic mute",
                action: "mic-mute",
              },
              {
                id: "ctl_play_pause",
                label: "Play / pause",
                action: "media-play-pause",
              },
            ],
          },
        ],
      },
      {
        id: "page_media",
        name: "Media",
        sections: [
          {
            id: "page_media_section",
            name: "Media",
            controls: [
              {
                id: "ctl_volume",
                label: "Volume",
                action: "volume",
                volume: 50,
              },
              {
                id: "ctl_media_pause",
                label: "Play / pause",
                action: "media-play-pause",
              },
            ],
          },
        ],
      },
    ],
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isTheme(value: unknown): value is Theme {
  return value === "dark" || value === "light";
}

export function isAccent(value: unknown): value is Accent {
  return ACCENTS.some((accent) => accent.value === value);
}

function validPresentation(action: unknown, presentation: unknown): presentation is Presentation {
  return presentation === "button" || (action === "volume" && (presentation === "slider" || presentation === "dial"))
    || (action === "plugin" && ["slider", "dial", "toggle-switch", "toggle-button", "value"].includes(presentation as string));
}

function isControl(value: unknown): value is Control {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || !value.id) return false;
  if (typeof value.label !== "string" || !value.label.trim()) return false;

  if (Object.hasOwn(value, "icon") && !isControlIcon(value.icon)) return false;
  if (Object.hasOwn(value, "rowSpan") && !isSpan(value.rowSpan, MAX_ROW_SPAN)) return false;
  if (Object.hasOwn(value, "columnSpan") && !isSpan(value.columnSpan, MAX_COLUMN_SPAN)) return false;
  if (Object.hasOwn(value, "presentation") && !validPresentation(value.action, value.presentation)) return false;
  const fields = ["id", "label", "action", ...["icon", "rowSpan", "columnSpan", "presentation"].filter((key) => Object.hasOwn(value, key))];
  switch (value.action) {
    case "plugin":
      return onlyFields(value, [...fields, "pluginId", "pluginAction", "pluginArgs"])
        && pluginIdentifier(value.pluginId) && pluginIdentifier(value.pluginAction) && isPluginArgs(value.pluginArgs);
    case "obs-scene":
      return onlyFields(value, [...fields, "scene", ...(Object.hasOwn(value, "autoLabel") ? ["autoLabel"] : [])])
        && typeof value.scene === "string" && value.scene.trim().length > 0
        && (!Object.hasOwn(value, "autoLabel") || typeof value.autoLabel === "boolean")
        && (value.autoLabel !== true || value.label === value.scene);
    case "mic-mute":
    case "media-play-pause":
      return onlyFields(value, fields);
    case "volume":
      return (
        onlyFields(value, [...fields, "volume"]) && typeof value.volume === "number" &&
        Number.isFinite(value.volume) &&
        value.volume >= 0 &&
        value.volume <= 100
      );
    default:
      return false;
  }
}

function onlyFields(value: Record<string, unknown>, fields: string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function migratedSectionId(pageId: string, index: number, used: Set<string>): string {
  const candidate = `${pageId}_section`;
  if (utf8Length(candidate) <= MAX_SECTION_BYTES && !used.has(candidate)) return candidate;
  let fallbackIndex = index;
  while (used.has(`section_${fallbackIndex}`)) fallbackIndex += 1;
  return `section_${fallbackIndex}`;
}

/** Only local import/load may upgrade a fully validated legacy deck; phone snapshots stay v3-only. */
export function normalizeDeck(value: unknown): Deck | null {
  if (isDeck(value)) return value;
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2) || !Array.isArray(value.pages)) return null;
  const usedSectionIds = new Set<string>();
  const pages: unknown[] = [];
  for (const [index, page] of value.pages.entries()) {
    // Promotion accepts only the original flat page shape; mixed v3 pages are not legacy data.
    if (!isRecord(page) || !onlyFields(page, ["id", "name", "controls"])
      || typeof page.id !== "string" || typeof page.name !== "string"
      || !Array.isArray(page.controls)) return null;
    if (value.version === 1 && page.controls.some((control) => isRecord(control) && control.action === "plugin")) return null;
    const sectionId = migratedSectionId(page.id, index, usedSectionIds);
    usedSectionIds.add(sectionId);
    pages.push({
      id: page.id,
      name: page.name,
      sections: [{ id: sectionId, name: page.name, controls: page.controls }],
    });
  }
  const upgraded = { ...value, version: DECK_VERSION, pages };
  return isDeck(upgraded) ? upgraded : null;
}

export function isDeck(value: unknown): value is Deck {
  if (!isRecord(value) || !onlyFields(value, ["version", "pages", "activePageId", "theme", "accent"])) return false;
  if (value.version !== DECK_VERSION) return false;
  if (!isTheme(value.theme) || !isAccent(value.accent)) return false;
  if (
    !Array.isArray(value.pages) ||
    value.pages.length === 0 ||
    value.pages.length > MAX_PAGES
  ) {
    return false;
  }

  const pageIds = new Set<string>();
  const sectionIds = new Set<string>();
  const controlIds = new Set<string>();

  for (const page of value.pages) {
    if (!isRecord(page) || !onlyFields(page, ["id", "name", "sections"])) return false;
    if (typeof page.id !== "string" || !page.id || pageIds.has(page.id)) return false;
    pageIds.add(page.id);
    if (typeof page.name !== "string" || !page.name.trim()) return false;
    if (!Array.isArray(page.sections) || page.sections.length === 0) return false;

    let controlCount = 0;
    for (const section of page.sections) {
      if (!isRecord(section) || !onlyFields(section, ["id", "name", "controls",
        ...["theme", "accent"].filter((key) => Object.hasOwn(section, key))])) return false;
      if (typeof section.id !== "string" || !section.id || sectionIds.has(section.id)
        || utf8Length(section.id) > MAX_SECTION_BYTES) return false;
      sectionIds.add(section.id);
      if (typeof section.name !== "string" || !section.name.trim()
        || utf8Length(section.name) > MAX_SECTION_BYTES) return false;
      if (Object.hasOwn(section, "theme") && !isTheme(section.theme)) return false;
      if (Object.hasOwn(section, "accent") && !isAccent(section.accent)) return false;
      if (!Array.isArray(section.controls)) return false;
      controlCount += section.controls.length;

      for (const control of section.controls) {
        if (!isControl(control) || controlIds.has(control.id)) return false;
        controlIds.add(control.id);
      }
    }
    if (controlCount > MAX_CONTROLS_PER_PAGE) return false;
  }

  return (
    typeof value.activePageId === "string" && pageIds.has(value.activePageId)
  );
}
