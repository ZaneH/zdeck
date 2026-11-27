import type { Accent, Theme } from "./types";

export function applyTheme(theme: Theme, accent: Accent): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.setProperty("--accent", accent);
  const themeColor = theme === "dark" ? "#18191b" : theme === "glass" ? "#302844" : "#f4f5f6";
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", themeColor);
}
