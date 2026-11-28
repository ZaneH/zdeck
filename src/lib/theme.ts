import type { Accent, Control, Presentation, Theme } from "./types";

/** Glass sliders need 1×2 and dials at least 2×2; saved spans are never rewritten. */
export function controlGeometry(control: Control, presentation: Presentation, theme: Theme) {
  const glass = theme === "glass";
  const module = glass && (control.action === "obs-scene" || presentation === "value");
  const wide = glass && (control.action === "media-play-pause" || presentation.startsWith("toggle-"));
  const verticalSlider = glass && presentation === "slider";
  const dial = glass && presentation === "dial";
  const columns = verticalSlider ? 1 : dial ? Math.max(2, control.columnSpan ?? 2)
    : control.columnSpan ?? (module || wide ? 2 : 1);
  const rows = verticalSlider || dial ? Math.max(2, control.rowSpan ?? 2) : control.rowSpan ?? (module ? 2 : 1);
  const shape = !glass ? "tile" : verticalSlider ? "slider" : dial ? "module"
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
