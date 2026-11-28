import type { Accent, Control, Presentation, Theme } from "./types";
import type { ThemePackageAppearance } from "./themePackage";
import { appearanceTokens, CUSTOM_THEME_VARIABLES } from "./customThemes";

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

/**
 * Applies the built-in base plus an optional validated package overlay.
 * Choosing a built-in appearance removes every inline custom token, so no
 * package color, radius or motif leaks into the next theme.
 */
export function applyTheme(
  theme: Theme,
  accent: Accent,
  custom?: ThemePackageAppearance | null,
): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.setProperty("--accent", accent);
  if (custom) {
    for (const [property, value] of Object.entries(appearanceTokens(custom))) {
      root.style.setProperty(property, value);
    }
    root.dataset.customTheme = "true";
    root.dataset.customMotif = custom.motif;
  } else {
    for (const property of CUSTOM_THEME_VARIABLES) root.style.removeProperty?.(property);
    delete root.dataset.customTheme;
    delete root.dataset.customMotif;
  }
  const themeColor = theme === "dark" ? "#18191b" : theme === "glass" ? "#15171b" : theme === "terminal" ? "#0b0f08" : theme === "macintosh" ? "#ffffff" : "#f4f5f6";
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", themeColor);
}
