import type { ControlIcon } from "./icons";

export const DECK_VERSION = 3 as const;

export const THEMES = ["dark", "light", "glass", "terminal"] as const;
export type Theme = (typeof THEMES)[number];

export const ACCENTS = [
  { name: "Cyan", value: "#4cc9f0" },
  { name: "Mint", value: "#6ee7b7" },
  { name: "Amber", value: "#f4b860" },
  { name: "Rose", value: "#ff7a9c" },
  { name: "Violet", value: "#a78bfa" },
] as const;

export type Accent = (typeof ACCENTS)[number]["value"];

export const ACTION_KINDS = [
  "obs-scene",
  "mic-mute",
  "media-play-pause",
  "volume",
  "plugin",
] as const;

export type ActionKind = (typeof ACTION_KINDS)[number];

export const PRESENTATIONS = ["button", "slider", "dial", "toggle-switch", "toggle-button", "value"] as const;
export type Presentation = (typeof PRESENTATIONS)[number];
export type PluginArgs = Record<string, number | boolean>;

interface ControlBase {
  presentation?: Presentation;
  id: string;
  label: string;
  icon?: ControlIcon;
  rowSpan?: number;
  columnSpan?: number;
}

export interface ObsSceneControl extends ControlBase {
  action: "obs-scene";
  scene: string;
  /** Automatic labels track the assigned scene; absent on legacy/custom labels. */
  autoLabel?: boolean;
}

export interface MicMuteControl extends ControlBase {
  action: "mic-mute";
}

export interface MediaPlayPauseControl extends ControlBase {
  action: "media-play-pause";
}

export interface VolumeControl extends ControlBase {
  action: "volume";
  volume: number;
}

export interface PluginControl extends ControlBase {
  action: "plugin";
  pluginId: string;
  pluginAction: string;
  pluginArgs: PluginArgs;
}

export type ControlOptions = {
  autoLabel?: boolean;
  presentation?: Presentation;
  label?: string;
  scene?: string;
  volume?: number;
  pluginId?: string;
  pluginAction?: string;
  pluginArgs?: PluginArgs;
};

export type Control =
  | PluginControl
  | ObsSceneControl
  | MicMuteControl
  | MediaPlayPauseControl
  | VolumeControl;

export interface Section {
  id: string;
  name: string;
  controls: Control[];
  theme?: Theme;
  accent?: Accent;
}

export interface Page {
  id: string;
  name: string;
  sections: Section[];
}

export interface Deck {
  version: typeof DECK_VERSION;
  pages: Page[];
  activePageId: string;
  theme: Theme;
  accent: Accent;
}

export type ControlPatch = {
  presentation?: Presentation;
  rowSpan?: number;
  columnSpan?: number;
  label?: string;
  /** null resets to the action's default icon. */
  icon?: ControlIcon | null;
  action?: ActionKind;
  scene?: string;
  volume?: number;
  pluginId?: string;
  pluginAction?: string;
  pluginArgs?: PluginArgs;
};

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};
