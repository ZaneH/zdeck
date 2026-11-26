import type { ActionKind, Control, ControlOptions } from "./types";
import { isPluginArgs, pluginIdentifier } from "./plugin";

export interface ActionDefinition {
  kind: ActionKind;
  name: string;
  category: "OBS" | "System" | "Media" | "Plugins";
  description: string;
  defaultLabel: string;
  note?: string;
}

export const ACTION_CATALOG: ActionDefinition[] = [
  {
    kind: "obs-scene",
    name: "OBS scene",
    category: "OBS",
    description: "Switch to a configured OBS scene.",
    defaultLabel: "Scene 1",
  },
  {
    kind: "mic-mute",
    name: "Microphone mute",
    category: "System",
    description: "Toggle the default system microphone on macOS, Windows, or Linux.",
    defaultLabel: "Mic mute",
    note: "System default input, not an OBS input.",
  },
  {
    kind: "media-play-pause",
    name: "Play / pause",
    category: "Media",
    description: "System play/pause on macOS and Windows; default MPRIS player on Linux. Media-key outcomes cannot be confirmed.",
    defaultLabel: "Play / pause",
  },
  {
    kind: "volume",
    name: "Volume slider",
    category: "Media",
    description: "Set the default system output volume on macOS, Windows, or Linux.",
    defaultLabel: "Volume",
    note: "Local preview in a browser.",
  },
];

export function actionDefinition(kind: ActionKind): ActionDefinition {
  if (kind === "plugin") return { kind, name: "Plugin action", category: "Plugins", description: "Run a saved external plugin action.", defaultLabel: "Plugin action" };
  const definition = ACTION_CATALOG.find((item) => item.kind === kind);
  if (!definition) {
    throw new Error(`Unknown action kind: ${kind}`);
  }
  return definition;
}

export function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function newId(prefix: string): string {
  const random =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${random}`;
}

export function createControl(
  kind: ActionKind,
  options: ControlOptions = {},
): Control {
  const definition = actionDefinition(kind);
  const id = newId("ctl");
  const label = options.label?.trim() || definition.defaultLabel;

  switch (kind) {
    case "plugin":
      if (!pluginIdentifier(options.pluginId) || !pluginIdentifier(options.pluginAction) || !isPluginArgs(options.pluginArgs)) {
        throw new Error("Invalid plugin control configuration.");
      }
      return { id, label, action: kind, pluginId: options.pluginId, pluginAction: options.pluginAction, pluginArgs: { ...options.pluginArgs } };
    case "obs-scene": {
      const scene = options.scene?.trim() || "Scene 1";
      const autoLabel = options.autoLabel === true || !options.label?.trim();
      return {
        id,
        label: autoLabel ? scene : label,
        action: kind,
        scene,
        ...(autoLabel ? { autoLabel: true } : {}),
      };
    }
    case "mic-mute":
      return { id, label, action: kind };
    case "media-play-pause":
      return { id, label, action: kind };
    case "volume":
      return { id, label, action: kind, volume: clampVolume(options.volume ?? 50) };
  }
}

export function controlVolume(control: Control): number {
  return control.action === "volume" ? control.volume : 0;
}

export function controlSummary(control: Control): string {
  switch (control.action) {
    case "plugin":
      return `${control.pluginId} · ${control.pluginAction}${Object.entries(control.pluginArgs).map(([key, value]) => ` · ${key}: ${value}`).join("")}`;
    case "obs-scene":
      return control.scene;
    case "mic-mute":
      return "System default input";
    case "media-play-pause":
      return "Media transport";
    case "volume":
      return `Default ${control.volume}%`;
  }
}
