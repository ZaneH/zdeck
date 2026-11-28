import { THEMES, type Theme } from "./types";

/** Exact UTF-8 byte budget for one theme package, including whitespace. */
export const MAX_THEME_PACKAGE_BYTES = 16 * 1024;
export const THEME_COLOR_KEYS = [
  "bg", "bgSoft", "surface", "surface2", "surface3", "border", "borderStrong",
  "text", "textMuted", "textFaint", "danger", "warning", "maze", "pellet", "tileSurface",
] as const;

export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];
export type ThemeColors = Record<ThemeColorKey, string>;
export type ThemeMotif = "none" | "maze";

export interface ThemePackageAppearance {
  base: Theme;
  motif: ThemeMotif;
  colors: ThemeColors;
  tileRadius: number;
  sectionRadius: number;
}

export interface ThemePackage {
  schema: 1;
  kind: "zdeck-theme";
  id: string;
  version: string;
  name: string;
  author: string;
  license: string;
  /** Plain metadata text. Never fetch, execute or render it as a link. */
  source: string;
  appearance: ThemePackageAppearance;
}

export interface CustomThemeReference {
  id: string;
  version: string;
  digest: string;
}

const encoder = new TextEncoder();
const record = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const exact = (x: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(x).length === keys.length && keys.every((key) => Object.hasOwn(x, key));
const bytes = (x: string) => encoder.encode(x).length;
const metadata = (x: unknown, max: number): x is string =>
  typeof x === "string" && x.length > 0 && x.trim() === x && bytes(x) <= max && !/\p{Cc}/u.test(x);
const themeId = (x: unknown): x is string => typeof x === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(x);
const versionString = (x: unknown): x is string => typeof x === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(x);
const digest = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const hexColor = (x: unknown): x is string => typeof x === "string" && /^#[0-9a-f]{6}$/.test(x);
const radius = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0 && x <= 32;

const PACKAGE_KEYS = ["schema", "kind", "id", "version", "name", "author", "license", "source", "appearance"] as const;
const APPEARANCE_KEYS = ["base", "motif", "colors", "tileRadius", "sectionRadius"] as const;

/** Strict parsed-value validation, matching the Rust serde model. */
export function validateThemePackage(value: unknown): ThemePackage | null {
  if (!record(value) || !exact(value, PACKAGE_KEYS) || value.schema !== 1 || value.kind !== "zdeck-theme"
    || !themeId(value.id) || !versionString(value.version)
    || !metadata(value.name, 80) || !metadata(value.author, 160)
    || !metadata(value.license, 80) || !metadata(value.source, 512)) return null;
  const appearance = value.appearance;
  if (!record(appearance) || !exact(appearance, APPEARANCE_KEYS)
    || !(THEMES as readonly string[]).includes(appearance.base as string)
    || (appearance.motif !== "none" && appearance.motif !== "maze")
    || !radius(appearance.tileRadius) || !radius(appearance.sectionRadius)
    || !record(appearance.colors) || !exact(appearance.colors, THEME_COLOR_KEYS)) return null;
  const colors = {} as ThemeColors;
  for (const key of THEME_COLOR_KEYS) {
    if (!hexColor(appearance.colors[key])) return null;
    colors[key] = appearance.colors[key];
  }
  return {
    schema: 1, kind: "zdeck-theme", id: value.id, version: value.version,
    name: value.name, author: value.author, license: value.license, source: value.source,
    appearance: {
      base: appearance.base as Theme, motif: appearance.motif,
      colors, tileRadius: appearance.tileRadius, sectionRadius: appearance.sectionRadius,
    },
  };
}

/** Parses bounded raw package bytes. Rejects BOM, invalid UTF-8 and malformed JSON. */
export function parseThemePackageBytes(input: Uint8Array): ThemePackage | null {
  if (!(input instanceof Uint8Array) || input.byteLength > MAX_THEME_PACKAGE_BYTES) return null;
  if (input.byteLength >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) return null;
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(input); } catch { return null; }
  try { return validateThemePackage(JSON.parse(text)); } catch { return null; }
}

export function validateCustomThemeReference(value: unknown): CustomThemeReference | null {
  if (!record(value) || !exact(value, ["id", "version", "digest"])
    || !themeId(value.id) || !versionString(value.version) || !digest(value.digest)) return null;
  return { id: value.id, version: value.version, digest: value.digest };
}
