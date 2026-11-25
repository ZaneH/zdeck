export const BUILTIN_ICONS = [
  { id: "obs-scene", title: "Scene", category: "Media" },
  { id: "mic-mute", title: "Microphone muted", category: "Media" },
  { id: "media-play-pause", title: "Play", category: "Media" },
  { id: "pause", title: "Pause", category: "Media" },
  { id: "skip-back", title: "Previous track", category: "Media" },
  { id: "skip-forward", title: "Next track", category: "Media" },
  { id: "volume", title: "Volume", category: "Media" },
  { id: "music", title: "Music", category: "Media" },
  { id: "headphones", title: "Headphones", category: "Media" },
  { id: "camera", title: "Camera", category: "Media" },
  { id: "monitor", title: "Monitor", category: "System" },
  { id: "power", title: "Power", category: "System" },
  { id: "plugin", title: "Plugin", category: "System" },
  { id: "lightbulb", title: "Light", category: "General" },
  { id: "heart", title: "Heart", category: "General" },
  { id: "star", title: "Star", category: "General" },
] as const;
export type BuiltinIconName = (typeof BUILTIN_ICONS)[number]["id"];
export type ControlIcon = { type: "builtin"; name: BuiltinIconName } | { type: "image"; src: string };
export interface PluginIcon { id: string; title: string; category: string; src: string }

// Image context (never inline SVG/HTML); no network URLs, local paths or executable schemes.
export function isIconSource(value: unknown): value is string {
  return typeof value === "string" && value.length <= 8192
    && /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    && !value.endsWith(",");
}
export function isControlIcon(value: unknown): value is ControlIcon {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const icon = value as Record<string, unknown>;
  if (Object.keys(icon).length !== 2) return false;
  return icon.type === "builtin" ? BUILTIN_ICONS.some((item) => item.id === icon.name)
    : icon.type === "image" && isIconSource(icon.src);
}
export function isPluginIcons(value: unknown): value is PluginIcon[] {
  if (!Array.isArray(value) || value.length > 32) return false;
  const ids = new Set<string>();
  return value.every((icon) => {
    if (!icon || typeof icon !== "object" || Array.isArray(icon) || Object.keys(icon).length !== 4
      || typeof icon.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(icon.id) || ids.has(icon.id)
      || ![icon.title, icon.category].every((text) => typeof text === "string" && text.trim().length > 0
        && text.length <= 80 && !/[\x00-\x1f\x7f]/.test(text)) || !isIconSource(icon.src)) return false;
    ids.add(icon.id);
    return true;
  });
}
