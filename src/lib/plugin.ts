import type { PluginControl } from "./types";

export interface PluginField { type: "integer"; minimum: number; maximum: number }
export interface PluginAction { id: string; title: string; config: Record<string, PluginField> }
export interface PluginManifest { id: string; version: string; protocolVersion: 1; actions: PluginAction[] }
export interface PluginError {
  kind: string;
  code: string | null;
  outcome: "not_started" | "unknown";
  message: string;
  hint: string;
}
export interface PluginSnapshot {
  status: "disconnected" | "connected" | "stopped";
  manifest: PluginManifest | null;
  state: Record<string, unknown> | null;
  lastError: PluginError | null;
}
export interface PluginCatalogEntry {
  id: string;
  name: string;
  version: string;
  protocolVersion: number;
  status: "ready" | "invalid" | "incompatible";
  message: string | null;
}
export interface PluginCatalog {
  directory: string;
  node: { status: "detected" | "not_found" | "unsupported"; version: string | null; path: string | null };
  plugins: PluginCatalogEntry[];
  truncated: boolean;
}
export type PluginSnapshots = Record<string, PluginSnapshot>;
export function pluginEntry<T>(entries: Record<string, T>, id: string): T | undefined {
  return Object.hasOwn(entries, id) ? entries[id] : undefined;
}
export interface PluginDiagnostics { pluginId: string; checks: { name: string; status: "pass" | "fail" | "warning"; message: string }[] }
export const MAX_ENABLED_PLUGINS = 16;
const SDK_INSTALL_HINTS: Record<string, string> = {
  "Required bundled @zdeck/plugin-sdk files are missing. Copy the complete packaged plugin folder, including node_modules; do not copy the source folder alone.": "Bundled SDK files are missing. Copy the complete packaged folder including node_modules, not the source folder.",
  "Bundled SDK files must be readable regular local files, with valid package metadata and no symlinks. Copy the complete packaged plugin folder.": "Bundled SDK files or metadata are invalid. Copy the complete packaged folder with regular local SDK files and no symlinks.",
  "The SDK is symlinked, as created by npm source-development installs. Copy the complete generated distribution folder with regular bundled SDK files instead.": "The SDK is symlinked by a source/developer npm layout. Copy the complete generated distribution folder with regular bundled SDK files, not the source folder.",
};
export function parsePluginSnapshots(value: unknown): PluginSnapshots | null {
  if (!record(value) || Object.keys(value).length > 64) return null;
  const entries: [string, PluginSnapshot][] = [];
  for (const [id, raw] of Object.entries(value)) {
    const snapshot = parsePluginSnapshot(raw);
    if (!pluginIdentifier(id) || !snapshot || (snapshot.manifest && snapshot.manifest.id !== id)) return null;
    entries.push([id, snapshot]);
  }
  if (entries.filter(([, snapshot]) => snapshot.status === "connected").length > MAX_ENABLED_PLUGINS) return null;
  return Object.fromEntries(entries);
}
export function enabledPluginManifests(snapshots: PluginSnapshots): PluginManifest[] {
  return Object.values(snapshots).flatMap((snapshot) => snapshot.status === "connected" && !snapshot.lastError && snapshot.manifest ? [snapshot.manifest] : []);
}
export function parsePluginDiagnostics(value: unknown, expectedId: string): PluginDiagnostics | null {
  if (!record(value) || !exact(value, ["pluginId", "checks"]) || value.pluginId !== expectedId || !pluginIdentifier(value.pluginId)
    || !Array.isArray(value.checks) || value.checks.length > 16) return null;
  const checks: PluginDiagnostics["checks"] = [];
  for (const check of value.checks) {
    if (!record(check) || !exact(check, ["name", "status", "message"]) || !boundedText(check.name, 80) || !boundedText(check.message, 500)
      || !["pass", "fail", "warning"].includes(check.status as string)) return null;
    const sdk = /sdk|dependenc/i.test(check.name);
    checks.push({ name: sdk ? "SDK dependency" : /runtime|node/i.test(check.name) ? "Node runtime" : /manifest/i.test(check.name) ? "Manifest" : /entry|main/i.test(check.name) ? "Entrypoint" : "Local installation check",
      status: check.status as "pass" | "fail" | "warning", message: check.status === "pass" ? "Check passed."
        : sdk ? check.status === "warning" ? "SDK dependency was not verified. Check the installation before enabling; no plugin code was executed."
          : `${Object.hasOwn(SDK_INSTALL_HINTS, check.message) ? SDK_INSTALL_HINTS[check.message] : "SDK dependency check failed. Copy the complete packaged folder including node_modules, not a source/developer npm layout."} Do not repair a distribution install with npm install.`
          : "Check this installation before enabling. Use the complete packaged folder; review the manifest, main.js, runtime and dependencies. No plugin code was executed." });
  }
  return { pluginId: expectedId, checks };
}

export interface PluginSelection { pluginId: string; trusted: boolean }
export const EMPTY_SELECTION: PluginSelection = { pluginId: "", trusted: false };
export function pluginSelectionReducer(previous: PluginSelection, event:
  | { type: "select"; pluginId: string } | { type: "trust"; checked: boolean } | { type: "refresh" | "reset" }): PluginSelection {
  switch (event.type) {
    case "select": return { pluginId: pluginIdentifier(event.pluginId) ? event.pluginId : "", trusted: false };
    case "trust": return { ...previous, trusted: !!previous.pluginId && event.checked };
    case "refresh": return EMPTY_SELECTION;
    case "reset": return { ...previous, trusted: false };
  }
}
export function canEnablePlugin(catalog: PluginCatalog | null, selection: PluginSelection): boolean {
  return !!catalog && !catalog.truncated && catalog.node.status === "detected" && selection.trusted
    && catalog.plugins.some((plugin) => plugin.id === selection.pluginId && plugin.status === "ready");
}

export const EMPTY_PLUGIN: PluginSnapshot = { status: "disconnected", manifest: null, state: null, lastError: null };
const record = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const exact = (x: Record<string, unknown>, keys: string[]) => Object.keys(x).length === keys.length && keys.every((key) => Object.hasOwn(x, key));
export const pluginIdentifier = (x: unknown): x is string => typeof x === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(x);
const safeInteger = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x);
const versionString = (x: unknown): x is string => typeof x === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(x);
const boundedText = (x: unknown, max: number): x is string => typeof x === "string" && x.trim().length > 0 && x.length <= max && !/\p{Cc}/u.test(x);
const absolutePath = (x: unknown): x is string => boundedText(x, 4096) && new TextEncoder().encode(x).length <= 4096 && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(x);

export function parsePluginCatalog(value: unknown): PluginCatalog | null {
  if (!record(value) || !exact(value, ["directory", "node", "plugins", "truncated"]) || !absolutePath(value.directory)
    || typeof value.truncated !== "boolean" || !record(value.node) || !exact(value.node, ["status", "version", "path"])
    || !Array.isArray(value.plugins) || value.plugins.length > 64) return null;
  const node = value.node;
  if (node.status === "not_found") {
    if (node.version !== null || node.path !== null) return null;
  } else if (node.status === "detected" || node.status === "unsupported") {
    if (!versionString(node.version) || !absolutePath(node.path)) return null;
    const [major, minor] = node.version.split(".").map(Number);
    if ((major > 22 || (major === 22 && minor >= 18)) !== (node.status === "detected")) return null;
  } else return null;
  const seen = new Set<string>();
  for (const plugin of value.plugins) {
    if (!record(plugin) || !exact(plugin, ["id", "name", "version", "protocolVersion", "status", "message"])
      || !(plugin.id === "" || pluginIdentifier(plugin.id)) || !boundedText(plugin.name, 80)
      || !(plugin.version === "" || versionString(plugin.version))
      || !safeInteger(plugin.protocolVersion) || plugin.protocolVersion < 0 || plugin.protocolVersion > 255
      || !(plugin.message === null || boundedText(plugin.message, 300))) return null;
    if (plugin.id) { if (seen.has(plugin.id)) return null; seen.add(plugin.id); }
    if (plugin.status === "ready") {
      if (!pluginIdentifier(plugin.id) || !versionString(plugin.version) || plugin.protocolVersion !== 1 || plugin.message !== null) return null;
    } else if (plugin.status === "invalid") {
      if (plugin.message === null) return null;
    } else if (plugin.status === "incompatible") {
      if (!pluginIdentifier(plugin.id) || !versionString(plugin.version) || plugin.protocolVersion <= 1 || plugin.message === null) return null;
    } else return null;
  }
  try { if (new TextEncoder().encode(JSON.stringify(value)).length > 65536) return null; }
  catch { return null; }
  const catalog = value as unknown as PluginCatalog;
  return { ...catalog, plugins: catalog.plugins.map((plugin) => ({ ...plugin, message: plugin.status === "ready" ? null
    : plugin.status === "incompatible" ? "Protocol version 1 is required."
      : plugin.message && Object.hasOwn(SDK_INSTALL_HINTS, plugin.message) ? `${SDK_INSTALL_HINTS[plugin.message]} Do not repair a distribution install with npm install.`
          : "Invalid plugin folder. Check its name, manifest.json, main.js and bundled SDK. SDK symlinks/source npm layouts are not distribution installs: copy the complete packaged folder, including node_modules. Do not repair a distribution install with npm install." })) };
}

export function isPluginArgs(value: unknown): value is Record<string, number> {
  return record(value) && Object.keys(value).length <= 8
    && Object.entries(value).every(([key, n]) => pluginIdentifier(key) && safeInteger(n));
}
export function parsePluginManifest(value: unknown): PluginManifest | null {
  if (!record(value) || !exact(value, ["id", "version", "protocolVersion", "actions"])
    || !pluginIdentifier(value.id) || typeof value.version !== "string" || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value.version)
    || value.protocolVersion !== 1 || !Array.isArray(value.actions) || value.actions.length < 1 || value.actions.length > 32) return null;
  const seen = new Set<string>();
  for (const action of value.actions) {
    if (!record(action) || !exact(action, ["id", "title", "config"]) || !pluginIdentifier(action.id) || seen.has(action.id)
      || typeof action.title !== "string" || action.title.length < 1 || action.title.length > 80 || /[\x00-\x1f\x7f]/.test(action.title)
      || !record(action.config) || Object.keys(action.config).length > 8) return null;
    seen.add(action.id);
    for (const [key, field] of Object.entries(action.config)) {
      if (!pluginIdentifier(key) || !record(field) || !exact(field, ["type", "minimum", "maximum"])
        || field.type !== "integer" || !safeInteger(field.minimum) || !safeInteger(field.maximum) || field.minimum > field.maximum) return null;
    }
  }
  try { if (new TextEncoder().encode(JSON.stringify(value)).length > 16384) return null; }
  catch { return null; }
  return value as unknown as PluginManifest;
}

const ERROR_MESSAGES: Record<string, string> = {
  invalid_launch: "Select absolute paths to a trusted Node runtime and plugin entrypoint.",
  unavailable: "Plugin process unavailable.", stopped: "Plugin stopped. Enable it explicitly again in Settings.",
  invalid_manifest: "The plugin manifest is invalid.", invalid_arguments: "Arguments do not match the action configuration.",
  unknown_action: "This action is not declared by the connected plugin.", protocol: "Invalid plugin response.",
  timeout: "Plugin request timed out.", plugin_failed: "Plugin operation failed.",
};
const CODE_HINTS: Record<string, string> = {
  missing_dependency: "Required plugin dependencies are missing. Copy the complete packaged plugin folder, including node_modules—not the source folder.",
  runtime_missing: "Node could not be started. Install Node.js 22.18.0 or newer and refresh the catalog.",
  runtime_incompatible: "Node is too old. Install Node.js 22.18.0 or newer and refresh the catalog.",
  startup_exit: "The plugin exited before describing its actions. Check that its complete packaged folder is installed and Node.js is 22.18.0 or newer. No action was sent.",
  unsupported_platform: "Spotify control requires macOS.", app_missing: "Install Spotify desktop in /Applications.",
  app_not_running: "Open Spotify manually.", automation_denied: "Allow the launching application to control Spotify in macOS Privacy & Security → Automation.",
  invalid_state: "Spotify returned unreadable state. Check application compatibility.",
  command_failed: "Check Spotify is responsive and inspect state before manually retrying.",
  outcome_unknown: "The command may have applied but its state could not be read.",
};
const ERROR_CODES = new Set([...Object.keys(CODE_HINTS), "invalid_request", "request_too_large", "unknown_action", "invalid_arguments",
  "internal_error", "response_too_large", "timeout"]);

/** Fixed local copy: even an exception shaped like a backend error cannot inject raw diagnostic text. */
export function toPluginError(value: unknown): PluginError {
  const known = record(value) && typeof value.kind === "string" && Object.hasOwn(ERROR_MESSAGES, value.kind);
  const kind = known ? value.kind as string : "unavailable";
  const code = known && typeof value.code === "string" && ERROR_CODES.has(value.code) ? value.code : null;
  const outcome = known && value.outcome === "not_started" ? "not_started" : "unknown";
  return { kind, code, outcome, message: ERROR_MESSAGES[kind], hint:
    `${code && CODE_HINTS[code] ? CODE_HINTS[code] + " " : ""}Refresh the catalog and explicitly enable the trusted plugin after checking its local configuration. Never automatically retry actions.` };
}
export function parsePluginSnapshot(value: unknown): PluginSnapshot | null {
  if (!record(value) || !exact(value, ["status", "manifest", "state", "lastError"])
    || typeof value.status !== "string" || !["disconnected", "connected", "stopped"].includes(value.status)) return null;
  const manifest = value.manifest === null ? null : parsePluginManifest(value.manifest);
  if (value.manifest !== null && !manifest) return null;
  if (value.status === "connected" && !manifest) return null;
  if (value.state !== null && (!record(value.state) || value.status !== "connected")) return null;
  if (value.status === "disconnected" && (manifest !== null || value.lastError !== null)) return null;
  if (value.lastError !== null && (!record(value.lastError)
    || typeof value.lastError.kind !== "string" || !Object.hasOwn(ERROR_MESSAGES, value.lastError.kind)
    || (value.lastError.outcome !== "not_started" && value.lastError.outcome !== "unknown")
    || !(value.lastError.code === null || typeof value.lastError.code === "string")
    || typeof value.lastError.message !== "string" || typeof value.lastError.hint !== "string")) return null;
  try { if (new TextEncoder().encode(JSON.stringify(value)).length > 131072) return null; }
  catch { return null; }
  return { status: value.status as PluginSnapshot["status"], manifest, state: value.state as PluginSnapshot["state"],
    lastError: value.lastError === null ? null : toPluginError(value.lastError) };
}
export function pluginDefaults(action: PluginAction): Record<string, number> {
  return Object.fromEntries(Object.entries(action.config).map(([key, field]) =>
    [key, Math.max(field.minimum, Math.min(field.maximum, key === "volume" ? 50 : 0))]));
}
export function pluginControlAction(snapshot: PluginSnapshot, control: PluginControl): PluginAction | null {
  return snapshot.manifest?.id === control.pluginId
    ? snapshot.manifest.actions.find((action) => action.id === control.pluginAction) ?? null : null;
}
export function pluginArgumentsValid(action: PluginAction, args: Record<string, number>): boolean {
  return isPluginArgs(args) && Object.keys(args).length === Object.keys(action.config).length
    && Object.entries(action.config).every(([key, field]) => Object.hasOwn(args, key) && args[key] >= field.minimum && args[key] <= field.maximum);
}
export function canRunPlugin(snapshot: PluginSnapshot, control: PluginControl): boolean {
  const action = pluginControlAction(snapshot, control);
  return snapshot.status === "connected" && !snapshot.lastError && action !== null && pluginArgumentsValid(action, control.pluginArgs);
}
export function pluginLaunchAllowed(program: string, entrypoint: string, trusted: boolean): boolean {
  return trusted && absolutePath(program) && absolutePath(entrypoint);
}

/** Only this bounded Spotify view is displayed; arbitrary plugin state is never dumped. */
export function spotifyState(snapshot: PluginSnapshot): { title: string | null; artist: string | null; playback: string; volume: number } | null {
  if (snapshot.manifest?.id !== "spotify" || !snapshot.state) return null;
  const { title, artist, playback, volume } = snapshot.state;
  if (![title, artist].every((text) => text === null || (typeof text === "string" && text.length <= 2048))
    || typeof playback !== "string" || !["playing", "paused", "stopped"].includes(playback) || !safeInteger(volume) || volume < 0 || volume > 100) return null;
  return { title: title as string | null, artist: artist as string | null, playback: playback as string, volume };
}
