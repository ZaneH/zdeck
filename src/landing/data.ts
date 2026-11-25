import type { Control } from "../lib/types";

export const LINKS = {
  github: "https://github.com/ZaneH/zdeck",
  download: "#download",
  docs: "#docs",
  discord: "https://discord.gg/PyeaPSPZe2",
} as const;

export type OsId = "macos" | "linux" | "windows";

export interface InstallOption {
  id: OsId;
  label: string;
  command: string;
  note: string;
}

export const INSTALL_OPTIONS: InstallOption[] = [
  {
    id: "macos",
    label: "macOS",
    command: "brew install --cask zdeck",
    note: "Placeholder command — universal binary coming soon",
  },
  {
    id: "linux",
    label: "Linux",
    command: "curl -fsSL https://zdeck.app/install.sh | sh",
    note: "Placeholder command — AppImage & Nix flake",
  },
  {
    id: "windows",
    label: "Windows",
    command: "winget install ZaneH.zDeck",
    note: "Placeholder command — Windows installer coming soon",
  },
];

export const MINI_DECK_CONTROLS: Control[] = [
  { id: "mini-scene", action: "obs-scene", label: "Camera", scene: "Camera" },
  { id: "mini-mic", action: "mic-mute", label: "Mic" },
  {
    id: "mini-spotify",
    action: "plugin",
    label: "Next track",
    pluginId: "spotify",
    pluginAction: "next",
    pluginArgs: {},
  },
  { id: "mini-play", action: "media-play-pause", label: "Play / pause" },
  { id: "mini-vol", action: "volume", label: "Speakers", volume: 72 },
];

export const TRACKS = [
  "Midnight Keycaps",
  "Lo-Fi Loop 04",
  "Late Night Commit",
  "Analog Desk",
] as const;

export const SCENES = ["Camera", "Desktop", "Be right back"] as const;

export interface DeckDemoState {
  sceneIndex: number;
  micMuted: boolean;
  playing: boolean;
  volume: number;
  trackIndex: number;
  status: string;
}

export const INITIAL_DECK_STATE: DeckDemoState = {
  sceneIndex: 0,
  micMuted: false,
  playing: true,
  volume: 72,
  trackIndex: 0,
  status: "Press a key or 1–4",
};

export function applyMiniControl(
  state: DeckDemoState,
  control: Control,
  volumeValue?: number,
): DeckDemoState {
  switch (control.action) {
    case "obs-scene": {
      const sceneIndex = (state.sceneIndex + 1) % SCENES.length;
      return { ...state, sceneIndex, status: `Scene: ${SCENES[sceneIndex]}` };
    }
    case "mic-mute": {
      const micMuted = !state.micMuted;
      return { ...state, micMuted, status: micMuted ? "Mic muted" : "Mic live" };
    }
    case "media-play-pause": {
      const playing = !state.playing;
      return { ...state, playing, status: playing ? "Playing" : "Paused" };
    }
    case "volume": {
      const volume = Math.max(0, Math.min(100, Math.round(volumeValue ?? control.volume)));
      return { ...state, volume, status: `Speakers ${volume}%` };
    }
    case "plugin": {
      const trackIndex = (state.trackIndex + 1) % TRACKS.length;
      return { ...state, playing: true, trackIndex, status: TRACKS[trackIndex] };
    }
  }
}

export const SDK_SNIPPET_RAW = `import { definePlugin } from "@zdeck/plugin-sdk";

export default definePlugin({
  id: "lights",
  name: "Desk Lights",
  actions: {
    toggle: async () => {
      await fetch("http://127.0.0.1:8123/toggle", { method: "POST" });
      return { ok: true };
    },
  },
});`;
