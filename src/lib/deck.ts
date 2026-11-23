import { ACCENTS, DECK_VERSION } from "./types";
import type {
  Accent,
  ActionKind,
  Control,
  ControlPatch,
  Deck,
  Page,
  Theme,
} from "./types";
import { actionDefinition, clampVolume, createControl, newId } from "./actions";

export const MAX_PAGES = 12;
export const MAX_CONTROLS_PER_PAGE = 24;

export function findPage(deck: Deck, pageId: string): Page | undefined {
  return deck.pages.find((page) => page.id === pageId);
}

export function findControl(
  deck: Deck,
  pageId: string,
  controlId: string,
): Control | undefined {
  return findPage(deck, pageId)?.controls.find((control) => control.id === controlId);
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
    controls: [],
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
  options?: { label?: string; scene?: string; volume?: number },
): { deck: Deck; control: Control } | null {
  const page = findPage(deck, pageId);
  if (!page || page.controls.length >= MAX_CONTROLS_PER_PAGE) return null;

  const control = createControl(kind, options);
  const next = mapPage(deck, pageId, (current) => ({
    ...current,
    controls: [...current.controls, control],
  }));
  return { deck: next, control };
}

function patchControl(control: Control, patch: ControlPatch): Control {
  const action = patch.action ?? control.action;
  const actionChanged = action !== control.action;
  const base = {
    id: control.id,
    label:
      patch.label !== undefined
        ? patch.label.trim() || control.label
        : actionChanged
          ? actionDefinition(action).defaultLabel
          : control.label,
  };

  switch (action) {
    case "obs-scene": {
      const scene =
        action === control.action && control.action === "obs-scene"
          ? control.scene
          : "Scene 1";
      return {
        ...base,
        action,
        scene: patch.scene?.trim() || scene,
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

export function updateControl(
  deck: Deck,
  pageId: string,
  controlId: string,
  patch: ControlPatch,
): Deck {
  const page = findPage(deck, pageId);
  if (!page || !page.controls.some((control) => control.id === controlId)) return deck;

  return mapPage(deck, pageId, (current) => ({
    ...current,
    controls: current.controls.map((control) =>
      control.id === controlId ? patchControl(control, patch) : control,
    ),
  }));
}

export function removeControl(deck: Deck, pageId: string, controlId: string): Deck {
  const page = findPage(deck, pageId);
  if (!page || !page.controls.some((control) => control.id === controlId)) return deck;

  return mapPage(deck, pageId, (current) => ({
    ...current,
    controls: current.controls.filter((control) => control.id !== controlId),
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
  const index = page.controls.findIndex((control) => control.id === controlId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= page.controls.length) return deck;

  return mapPage(deck, pageId, (current) => {
    const controls = [...current.controls];
    [controls[index], controls[target]] = [controls[target], controls[index]];
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
      {
        id: "page_media",
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

function isControl(value: unknown): value is Control {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || !value.id) return false;
  if (typeof value.label !== "string" || !value.label.trim()) return false;

  switch (value.action) {
    case "obs-scene":
      return typeof value.scene === "string" && value.scene.trim().length > 0;
    case "mic-mute":
    case "media-play-pause":
      return true;
    case "volume":
      return (
        typeof value.volume === "number" &&
        Number.isFinite(value.volume) &&
        value.volume >= 0 &&
        value.volume <= 100
      );
    default:
      return false;
  }
}

export function isDeck(value: unknown): value is Deck {
  if (!isRecord(value)) return false;
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
  const controlIds = new Set<string>();

  for (const page of value.pages) {
    if (!isRecord(page)) return false;
    if (typeof page.id !== "string" || !page.id || pageIds.has(page.id)) return false;
    pageIds.add(page.id);
    if (typeof page.name !== "string" || !page.name.trim()) return false;
    if (
      !Array.isArray(page.controls) ||
      page.controls.length > MAX_CONTROLS_PER_PAGE
    ) {
      return false;
    }

    for (const control of page.controls) {
      if (!isControl(control) || controlIds.has(control.id)) return false;
      controlIds.add(control.id);
    }
  }

  return (
    typeof value.activePageId === "string" && pageIds.has(value.activePageId)
  );
}
