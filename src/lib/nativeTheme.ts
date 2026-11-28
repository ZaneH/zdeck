import { invoke } from "@tauri-apps/api/core";
import { nativeAvailable } from "./native";
import {
  MAX_THEME_PACKAGE_BYTES,
  parseThemePackageBytes,
  validateCustomThemeReference,
  validateThemePackage,
} from "./themePackage";
import type { CustomThemeReference, ThemePackage } from "./themePackage";

/** Installed package, its authoritative native digest, and the exact validated source text. */
export interface InstalledTheme {
  package: ThemePackage;
  reference: CustomThemeReference;
  source: string;
}

export const THEME_ERROR_KINDS = [
  "invalid_package",
  "limit_reached",
  "invalid_catalog",
  "conflict",
  "in_use",
  "not_found",
  "forbidden",
  "unavailable",
  "io",
  "invalid_arguments",
  "protocol",
] as const;

export type ThemeErrorKind = (typeof THEME_ERROR_KINDS)[number];

export interface ThemeError {
  kind: ThemeErrorKind;
  message: string;
}

const FALLBACK_MESSAGES: Record<ThemeErrorKind, string> = {
  invalid_package: "This file is not a valid theme package.",
  limit_reached: "The installed theme limit is reached. Remove a theme first.",
  invalid_catalog: "The installed theme catalog is invalid. It was left unchanged.",
  conflict: "A different theme is already installed with this id and version.",
  in_use: "This theme is still used by the deck or Trash. Replace those references first.",
  not_found: "That theme version is not installed.",
  forbidden: "Theme installation is only available in the local desktop editor.",
  unavailable: "The native theme catalog is only available in the desktop app.",
  io: "The theme catalog could not be read or written.",
  invalid_arguments: "The theme reference is not valid.",
  protocol: "The native theme response was invalid.",
};

const MAX_INSTALLED_THEMES = 16;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const encoder = new TextEncoder();

/** Normalize anything thrown by `invoke` into a typed, sanitized theme error. */
export function toThemeError(value: unknown): ThemeError {
  if (record(value) && typeof value.kind === "string"
    && (THEME_ERROR_KINDS as readonly string[]).includes(value.kind)) {
    const kind = value.kind as ThemeErrorKind;
    const message = typeof value.message === "string" && value.message.trim()
      ? value.message
      : FALLBACK_MESSAGES[kind];
    return { kind, message };
  }
  return { kind: "io", message: FALLBACK_MESSAGES.io };
}

export function nativeThemeAvailable(): boolean {
  return nativeAvailable();
}

function validSource(value: unknown): string | null {
  if (typeof value !== "string" || encoder.encode(value).length > MAX_THEME_PACKAGE_BYTES) return null;
  return parseThemePackageBytes(encoder.encode(value)) ? value : null;
}

/** Strict reply validation; the native side computes the authoritative digest. */
export function parseInstalledTheme(value: unknown): InstalledTheme | null {
  if (!record(value) || !exact(value, ["package", "reference", "source"])) return null;
  const packageValue = validateThemePackage(value.package);
  const reference = validateCustomThemeReference(value.reference);
  const source = validSource(value.source);
  if (!packageValue || !reference || source === null) return null;
  const parsedSource = parseThemePackageBytes(encoder.encode(source));
  if (!parsedSource
    || JSON.stringify(parsedSource) !== JSON.stringify(packageValue)
    || packageValue.id !== reference.id
    || packageValue.version !== reference.version) return null;
  return { package: packageValue, reference, source };
}

export function parseInstalledThemes(value: unknown): InstalledTheme[] | null {
  if (!Array.isArray(value) || value.length > MAX_INSTALLED_THEMES) return null;
  const themes: InstalledTheme[] = [];
  for (const entry of value) {
    const theme = parseInstalledTheme(entry);
    if (!theme) return null;
    themes.push(theme);
  }
  return themes;
}

async function invokeNative(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  if (!nativeAvailable()) {
    throw { kind: "unavailable", message: FALLBACK_MESSAGES.unavailable } satisfies ThemeError;
  }
  try {
    return await invoke<unknown>(command, args);
  } catch (error) {
    throw toThemeError(error);
  }
}

export async function listNativeThemes(): Promise<InstalledTheme[]> {
  const themes = parseInstalledThemes(await invokeNative("theme_list"));
  if (!themes) throw { kind: "protocol", message: FALLBACK_MESSAGES.protocol } satisfies ThemeError;
  return themes;
}

/** Native picker; returns the exact validated source text, or null when cancelled. */
export async function pickNativeTheme(): Promise<string | null> {
  const value = await invokeNative("theme_pick");
  if (value === null) return null;
  const source = validSource(value);
  if (source === null) throw { kind: "protocol", message: FALLBACK_MESSAGES.protocol } satisfies ThemeError;
  return source;
}

/** The native side validates and stores the same source again; nothing is executed. */
export async function installNativeTheme(source: string): Promise<InstalledTheme> {
  if (validSource(source) === null) {
    throw { kind: "invalid_package", message: FALLBACK_MESSAGES.invalid_package } satisfies ThemeError;
  }
  const theme = parseInstalledTheme(await invokeNative("theme_install", { source }));
  if (!theme) throw { kind: "protocol", message: FALLBACK_MESSAGES.protocol } satisfies ThemeError;
  return theme;
}

export async function removeNativeTheme(reference: CustomThemeReference): Promise<void> {
  const valid = validateCustomThemeReference(reference);
  if (!valid) {
    throw { kind: "invalid_arguments", message: FALLBACK_MESSAGES.invalid_arguments } satisfies ThemeError;
  }
  if (await invokeNative("theme_remove", { reference: valid }) !== null) {
    throw { kind: "protocol", message: FALLBACK_MESSAGES.protocol } satisfies ThemeError;
  }
}
