import type { StorageLike } from "./types";

const KEY = "deck.volumes.v1";

export function loadVolumes(storage: StorageLike | null): { value: Record<string, number>; error: string | null } {
  try {
    if (!storage) throw new Error("Storage unavailable");
    const raw = storage.getItem(KEY);
    if (raw === null) return { value: {}, error: null };
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)
      || !Object.values(value).every(volume => typeof volume === "number" && Number.isInteger(volume) && volume >= 0 && volume <= 100)) {
      throw new Error("Invalid volume preferences");
    }
    return { value: value as Record<string, number>, error: null };
  } catch {
    return { value: {}, error: "Volume preferences could not be loaded. Using control defaults for this session." };
  }
}

export function saveVolumes(storage: StorageLike | null, value: Record<string, number>): boolean {
  try {
    if (!storage) return false;
    storage.setItem(KEY, JSON.stringify(value));
    return true;
  } catch { return false; }
}
