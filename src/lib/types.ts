import type { ControlIcon } from "./icons";

export const DECK_VERSION = 2 as const;

export const THEMES = ["dark", "light"] as const;
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

interface ControlBase {
  id: string;
  label: string;
  icon?: ControlIcon;
}

export interface ObsSceneControl extends ControlBase {
  action: "obs-scene";
  scene: string;
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
  pluginArgs: Record<string, number>;
}

export type ControlOptions = {
  label?: string;
  scene?: string;
  volume?: number;
  pluginId?: string;
  pluginAction?: string;
  pluginArgs?: Record<string, number>;
};

export type Control =
  | PluginControl
  | ObsSceneControl
  | MicMuteControl
  | MediaPlayPauseControl
  | VolumeControl;

export interface Page {
  id: string;
  name: string;
  controls: Control[];
}

export interface Deck {
  version: typeof DECK_VERSION;
  pages: Page[];
  activePageId: string;
  theme: Theme;
  accent: Accent;
}

export type ControlPatch = {
  label?: string;
  /** null resets to the action's default icon. */
  icon?: ControlIcon | null;
  action?: ActionKind;
  scene?: string;
  volume?: number;
  pluginId?: string;
  pluginAction?: string;
  pluginArgs?: Record<string, number>;
};

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};
