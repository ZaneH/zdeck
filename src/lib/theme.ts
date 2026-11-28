import type { Accent, Control, Presentation, Theme } from "./types";

/** Saved sizing wins; the theme chooses geometry only where the user left it automatic. */
export function controlGeometry(control: Control, presentation: Presentation, theme: Theme) {
  const glass = theme === "glass";
  const module = glass && (control.action === "obs-scene" || presentation === "value");
  const wide = glass && (control.action === "media-play-pause" || presentation.startsWith("toggle-"));
  const columns = control.columnSpan ?? (module || wide ? 2 : 1);
  const rows = control.rowSpan ?? (module || glass && presentation === "slider" ? 2 : 1);
  const shape = !glass ? "tile" : presentation === "slider" ? "slider"
    : columns === 1 && rows === 1 && presentation === "button" ? "circle"
    : columns > rows ? "capsule" : "module";
  return { columns, rows, shape };
}

export function applyTheme(theme: Theme, accent: Accent): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.setProperty("--accent", accent);
  const themeColor = theme === "dark" ? "#18191b" : theme === "glass" ? "#15171b" : theme === "terminal" ? "#0b0f08" : "#f4f5f6";
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", themeColor);
}
