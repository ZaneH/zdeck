import { useState } from "react";
import { Clapperboard, MicOff, Play, Volume2, Plug, Pause, SkipBack, SkipForward,
  Music, Headphones, Camera, Monitor, Power, Lightbulb, Heart, Star } from "lucide-react";
import type { ActionKind } from "../lib/types";
import type { BuiltinIconName, ControlIcon } from "../lib/icons";

const icons = {
  "obs-scene": Clapperboard, "mic-mute": MicOff, "media-play-pause": Play, volume: Volume2,
  plugin: Plug, pause: Pause, "skip-back": SkipBack, "skip-forward": SkipForward,
  music: Music, headphones: Headphones, camera: Camera, monitor: Monitor, power: Power,
  lightbulb: Lightbulb, heart: Heart, star: Star,
} satisfies Record<BuiltinIconName, typeof Play>;

export function ActionIcon({ kind, icon, size = 20 }: { kind: ActionKind; icon?: ControlIcon; size?: number }) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  if (icon?.type === "image" && failedSource !== icon.src) return <img src={icon.src} width={size} height={size} alt="" aria-hidden="true"
    className="control-icon-image" onError={() => setFailedSource(icon.src)} />;
  const Icon = icons[icon?.type === "builtin" ? icon.name : kind];
  return <Icon size={size} aria-hidden="true" />;
}
