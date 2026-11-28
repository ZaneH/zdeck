import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import {
  nativeThemeAvailable, listNativeThemes, pickNativeTheme, installNativeTheme, removeNativeTheme,
} from "./nativeTheme";
import type { InstalledTheme } from "./nativeTheme";
export type { InstalledTheme } from "./nativeTheme";
import type { Deck, Section, Theme } from "./types";
import { sectionAppearance } from "./sections";
import {
  THEME_COLOR_KEYS,
  validateCustomThemeReference,
  validateThemePackage,
} from "./themePackage";
import type {
  CustomThemeReference,
  ThemePackage,
  ThemePackageAppearance,
  ThemeColorKey,
  ThemeMotif,
} from "./themePackage";

/** Injectable seam: App uses native IPC, Storybook uses a local fake. */
export interface ThemeAdapter {
  available(): boolean;
  list(): Promise<InstalledTheme[]>;
  pick(): Promise<string | null>;
  install(source: string): Promise<InstalledTheme>;
  remove(reference: CustomThemeReference): Promise<void>;
}

export function nativeThemeAdapter(): ThemeAdapter {
  return {
    available: nativeThemeAvailable,
    list: listNativeThemes,
    pick: pickNativeTheme,
    install: installNativeTheme,
    remove: removeNativeTheme,
  };
}

/** Exact identity: same id, version and digest; a different digest never substitutes. */
export function referenceKey(reference: CustomThemeReference): string {
  return `${reference.id}@${reference.version}#${reference.digest}`;
}

export function findInstalledTheme(
  themes: readonly InstalledTheme[],
  reference: CustomThemeReference | undefined,
): InstalledTheme | null {
  const valid = reference ? validateCustomThemeReference(reference) : null;
  if (!valid) return null;
  const found = themes.find((theme) =>
    theme.reference.id === valid.id
    && theme.reference.version === valid.version
    && theme.reference.digest === valid.digest);
  if (!found) return null;
  const pkg = validateThemePackage(found.package);
  if (!pkg || pkg.id !== valid.id || pkg.version !== valid.version) return null;
  return { ...found, package: pkg };
}

const COLOR_TOKENS: Record<ThemeColorKey, string> = {
  bg: "--bg",
  bgSoft: "--bg-soft",
  surface: "--surface",
  surface2: "--surface-2",
  surface3: "--surface-3",
  border: "--border",
  borderStrong: "--border-strong",
  text: "--text",
  textMuted: "--text-muted",
  textFaint: "--text-faint",
  danger: "--danger",
  warning: "--warning",
  maze: "--maze",
  pellet: "--pellet",
  tileSurface: "--tile-surface",
};

/** Every package color and radius maps to a host token; no raw CSS value is accepted. */
export function appearanceTokens(appearance: ThemePackageAppearance): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const key of THEME_COLOR_KEYS) tokens[COLOR_TOKENS[key]] = appearance.colors[key];
  tokens["--section-bg"] = appearance.colors.bg;
  tokens["--tile-radius"] = `${appearance.tileRadius}px`;
  tokens["--section-radius"] = `${appearance.sectionRadius}px`;
  tokens["--phone-section-radius"] = `${appearance.sectionRadius}px`;
  tokens["--custom-motif-image"] = motifImage(appearance) ?? "none";
  return tokens;
}

export const CUSTOM_THEME_VARIABLES = [
  ...Object.values(COLOR_TOKENS),
  "--section-bg", "--tile-radius", "--section-radius", "--phone-section-radius",
  "--custom-motif-image",
];

const MAZE_SVG = (maze: string, pellet: string) =>
  `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160' viewBox='0 0 160 160'>`
  + `<g fill='none' stroke='${maze}' stroke-opacity='.12' stroke-width='2'>`
  + `<path d='M0 24H56V56H104V0'/><path d='M0 88H40V120H96V88H160'/></g>`
  + `<g fill='${pellet}' fill-opacity='.25'><circle cx='20' cy='72' r='2'/><circle cx='76' cy='20' r='2'/></g></svg>`;

/** Host-owned sparse maze/pellet motif; only validated hex colors enter the data URL. */
function motifImage(appearance: ThemePackageAppearance): string | null {
  if (appearance.motif !== "maze") return null;
  const maze = appearance.colors.maze;
  const pellet = appearance.colors.pellet;
  return `url("data:image/svg+xml,${encodeURIComponent(MAZE_SVG(maze, pellet))}")`;
}

export function customThemeStyle(pkg: ThemePackage): CSSProperties | null {
  const valid = validateThemePackage(pkg);
  if (!valid) return null;
  return appearanceTokens(valid.appearance) as CSSProperties;
}

export interface ResolvedTheme {
  /** Built-in base that keeps control geometry and focus behavior. */
  appearance: Theme;
  custom: InstalledTheme | null;
  /** A reference exists but no exact installed package was found. */
  missing: boolean;
  style: CSSProperties;
  motif: ThemeMotif | null;
}

const BUILTIN_STYLE = {} as CSSProperties;

function resolvedCustom(custom: InstalledTheme): ResolvedTheme {
  return {
    appearance: custom.package.appearance.base,
    custom,
    missing: false,
    style: customThemeStyle(custom.package) ?? BUILTIN_STYLE,
    motif: custom.package.appearance.motif,
  };
}

export function resolveDeckTheme(deck: Deck, themes: readonly InstalledTheme[]): ResolvedTheme {
  if (!deck.customTheme) {
    return { appearance: deck.theme, custom: null, missing: false, style: BUILTIN_STYLE, motif: null };
  }
  const custom = findInstalledTheme(themes, deck.customTheme);
  return custom
    ? resolvedCustom(custom)
    : { appearance: deck.theme, custom: null, missing: true, style: BUILTIN_STYLE, motif: null };
}

export function resolveSectionTheme(
  deck: Deck,
  section: Section,
  themes: readonly InstalledTheme[],
): ResolvedTheme {
  const surface = sectionAppearance(deck, section);
  if (!surface.customTheme) {
    return { appearance: surface.theme, custom: null, missing: false, style: BUILTIN_STYLE, motif: null };
  }
  const custom = findInstalledTheme(themes, surface.customTheme);
  return custom
    ? resolvedCustom(custom)
    : { appearance: surface.theme, custom: null, missing: true, style: BUILTIN_STYLE, motif: null };
}

/** Exact references currently stored in this deck, including explicit section overrides. */
export function deckThemeReferences(deck: Deck): CustomThemeReference[] {
  const references = deck.customTheme ? [deck.customTheme] : [];
  for (const page of deck.pages) {
    for (const section of page.sections) if (section.customTheme) references.push(section.customTheme);
  }
  return references;
}

export function isThemeInUse(deck: Deck, reference: CustomThemeReference): boolean {
  const key = referenceKey(reference);
  return deckThemeReferences(deck).some((candidate) => referenceKey(candidate) === key);
}

/** Visible, concise recovery text. Never resolves a different digest or clears a reference. */
export function missingThemeWarning(
  deck: Deck,
  themes: readonly InstalledTheme[],
  serverError?: string | null,
): string | null {
  const missing = deckThemeReferences(deck).find((reference) => !findInstalledTheme(themes, reference));
  if (!missing) return serverError ?? null;
  return `This deck uses the installed theme ${missing.id} ${missing.version}, which is not available here. Import the exact package or choose a built-in theme.`;
}

/** Native errors are short and sanitized; anything else gets a generic message. */
export function themeErrorMessage(value: unknown): string {
  const raw = typeof value === "string"
    ? value
    : value && typeof value === "object" && typeof (value as { message?: unknown }).message === "string"
      ? (value as { message: string }).message
      : "";
  const cleaned = raw.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  return (cleaned || "The theme operation failed.").slice(0, 300);
}

/** Loads the native catalog once; a failure stays visible without blocking launch. */
export function useInstalledThemes(adapter: ThemeAdapter, enabled: boolean) {
  const [themes, setThemes] = useState<InstalledTheme[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!adapter.available()) return;
    setLoading(true);
    try {
      setThemes(await adapter.list());
      setError(null);
    } catch (value) {
      setError(themeErrorMessage(value));
    } finally {
      setLoading(false);
    }
  }, [adapter]);
  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);
  return { themes, loading, error, refresh };
}
