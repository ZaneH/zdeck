import { obsForgetPreferences, obsLoadPreferences, obsSavePreferences } from "./native";
import type { ObsPreferences } from "./native";

/**
 * Session-only view of the OBS credentials kept in the OS credential store.
 *
 * Settings remounts and StrictMode can repeat credential reads, so successful
 * reads are shared and remembered here. Nothing is written to
 * browser storage, logs or exports, and a saved connection is never used to
 * connect automatically.
 */
let saved: ObsPreferences | null | undefined;
let loading: Promise<ObsPreferences | null> | null = null;
/** Bumped whenever save/forget resolves, so a stale read cannot restore old credentials. */
let revision = 0;

export function loadObsPreferences(): Promise<ObsPreferences | null> {
  if (saved !== undefined) return Promise.resolve(saved);
  if (loading) return loading;
  const startedAt = revision;
  const request = obsLoadPreferences()
    .then((value) => {
      if (startedAt === revision) saved = value;
      return saved ?? null;
    })
    .finally(() => {
      if (loading === request) loading = null;
    });
  loading = request;
  return request;
}

export async function saveObsPreferences(port: number, password: string): Promise<void> {
  await obsSavePreferences(port, password);
  saved = { port, password };
  revision += 1;
}

export async function forgetObsPreferences(): Promise<void> {
  await obsForgetPreferences();
  saved = null;
  revision += 1;
}

/** Test hook: the cache lives as long as the webview session. */
export function resetObsPreferencesCache(): void {
  saved = undefined;
  loading = null;
  revision += 1;
}
