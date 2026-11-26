import type { StorageLike } from "./types";

const KEY = "deck.footer.v1";
export const DEFAULT_FOOTER = { service: true, plugins: true, dividers: true };
export type FooterPreferences = typeof DEFAULT_FOOTER;

export function loadFooter(storage: StorageLike | null): { value: FooterPreferences; error: string | null } {
  try {
    if (!storage) throw new Error("Storage unavailable");
    const raw = storage.getItem(KEY);
    if (raw === null) return { value: { ...DEFAULT_FOOTER }, error: null };
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== 3
      || !Object.keys(DEFAULT_FOOTER).every(key => Object.hasOwn(value, key) && typeof (value as Record<string, unknown>)[key] === "boolean")) {
      throw new Error("Invalid footer preferences");
    }
    return { value: value as FooterPreferences, error: null };
  } catch {
    return { value: { ...DEFAULT_FOOTER }, error: "Footer preferences could not be loaded. Using defaults for this session." };
  }
}

export function saveFooter(storage: StorageLike | null, value: FooterPreferences): boolean {
  try {
    if (!storage) return false;
    storage.setItem(KEY, JSON.stringify(value));
    return true;
  } catch { return false; }
}
