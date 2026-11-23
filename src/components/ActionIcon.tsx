import { Clapperboard, MicOff, Play, Volume2 } from "lucide-react";
import type { ActionKind } from "../lib/types";

export function ActionIcon({ kind, size = 20 }: { kind: ActionKind; size?: number }) {
  switch (kind) {
    case "obs-scene":
      return <Clapperboard size={size} aria-hidden="true" />;
    case "mic-mute":
      return <MicOff size={size} aria-hidden="true" />;
    case "media-play-pause":
      return <Play size={size} aria-hidden="true" />;
    case "volume":
      return <Volume2 size={size} aria-hidden="true" />;
  }
}
