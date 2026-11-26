import { isIconSource, isPluginIcons } from "./icons";
import type { PluginIcon } from "./icons";
import type { PluginArgs, PluginControl } from "./types";

export type PluginField =
  | { type: "integer"; minimum: number; maximum: number; control?: { step: number }; choicesKey?: string }
  | { type: "boolean"; control?: { stateKey: string; entityKey?: string } };
export interface PluginAction { id: string; title: string; config: Record<string, PluginField> }
export interface PluginValue extends PluginAction { stateKey: string; entityKey: string }
export type PluginSettingsSchema = Record<string, { type: "text" | "secret"; label: string }>;
export interface PluginSettingsView { values: Record<string, string>; secretConfigured: Record<string, boolean> }
export interface PluginManifest { id: string; version: string; protocolVersion: 1; actions: PluginAction[]; values?: PluginValue[]; icons?: PluginIcon[]; icon?: string; settings?: PluginSettingsSchema }
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
  icon: string | null;
  /** Absent in older catalogs means Node. */
  runtime?: "node" | "python";
  trusted: boolean;
  /** Opaque validated package identity for a ready plugin; null otherwise. */
  identity: string | null;
  settings?: PluginSettingsSchema;
}
export interface PluginRuntime { status: "detected" | "not_found" | "unsupported"; version: string | null; path: string | null }
export interface PluginCatalog {
  directory: string;
  node: PluginRuntime;
  python?: PluginRuntime;
  plugins: PluginCatalogEntry[];
}
export type PluginSnapshots = Record<string, PluginSnapshot>;
export function pluginEntry<T>(entries: Record<string, T>, id: string): T | undefined {
  return Object.hasOwn(entries, id) ? entries[id] : undefined;
}
export interface PluginDiagnostics { pluginId: string; checks: { name: string; status: "pass" | "fail" | "warning"; message: string }[] }
const SDK_INSTALL_HINTS: Record<string, string> = {
  "Required bundled @zdeck/plugin-sdk files are missing. Copy the complete packaged plugin folder, including node_modules; do not copy the source folder alone.": "Bundled SDK files are missing. Copy the complete packaged folder including node_modules, not the source folder.",
  "Bundled SDK files must be readable regular local files, with valid package metadata and no symlinks. Copy the complete packaged plugin folder.": "Bundled SDK files or metadata are invalid. Copy the complete packaged folder with regular local SDK files and no symlinks.",
  "The SDK is symlinked, as created by npm source-development installs. Copy the complete generated distribution folder with regular bundled SDK files instead.": "The SDK is symlinked by a source/developer npm layout. Copy the complete generated distribution folder with regular bundled SDK files, not the source folder.",
};
export function parsePluginSnapshots(value: unknown): PluginSnapshots | null {
  if (!record(value)) return null;
  const entries: [string, PluginSnapshot][] = [];
  for (const [id, raw] of Object.entries(value)) {
    const snapshot = parsePluginSnapshot(raw);
    if (!pluginIdentifier(id) || !snapshot || (snapshot.manifest && snapshot.manifest.id !== id)) return null;
    entries.push([id, snapshot]);
  }
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
    checks.push({ name: sdk ? "SDK dependency" : /runtime|node/i.test(check.name) ? "Plugin runtime" : /manifest/i.test(check.name) ? "Manifest" : /entry|main/i.test(check.name) ? "Entrypoint" : "Local installation check",
      status: check.status as "pass" | "fail" | "warning", message: check.status === "pass" ? "Check passed."
        : sdk && /python/i.test(check.name) ? "Copy the complete packaged Python plugin folder, including main.py and the regular zdeck_plugin_sdk directory. Do not install dependencies in the distribution folder."
        : sdk ? check.status === "warning" ? "SDK dependency was not verified. Check the installation before enabling; no plugin code was executed."
          : `${Object.hasOwn(SDK_INSTALL_HINTS, check.message) ? SDK_INSTALL_HINTS[check.message] : "SDK dependency check failed. Copy the complete packaged folder including node_modules, not a source/developer npm layout."} Do not repair a distribution install with npm install.`
          : "Check this installation before enabling. Use the complete packaged folder; review the manifest, main.js or main.py, runtime and dependencies. No plugin code was executed." });
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
export function runtimeForPlugin(catalog: PluginCatalog | null, entry: PluginCatalogEntry): PluginRuntime | undefined {
  return entry.runtime === "python" ? catalog?.python : catalog?.node;
}
export function canEnablePlugin(catalog: PluginCatalog | null, selection: PluginSelection): boolean {
  return !!catalog && selection.trusted && catalog.plugins.some((entry) => entry.id === selection.pluginId
    && entry.status === "ready" && runtimeForPlugin(catalog, entry)?.status === "detected");
}

export const EMPTY_PLUGIN: PluginSnapshot = { status: "disconnected", manifest: null, state: null, lastError: null };
const record = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const exact = (x: Record<string, unknown>, keys: string[]) => Object.keys(x).length === keys.length && keys.every((key) => Object.hasOwn(x, key));
export const pluginIdentifier = (x: unknown): x is string => typeof x === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(x);
const safeInteger = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x);
const versionString = (x: unknown): x is string => typeof x === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(x);
const boundedText = (x: unknown, max: number): x is string => typeof x === "string" && x.trim().length > 0 && x.length <= max && !/\p{Cc}/u.test(x);
const packageIdentity = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{64}$/.test(x);
const absolutePath = (x: unknown): x is string => boundedText(x, 4096) && new TextEncoder().encode(x).length <= 4096 && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(x);

export function validPluginSettingsSchema(value: unknown): value is PluginSettingsSchema {
  return record(value) && Object.keys(value).length <= 4
    && Object.entries(value).every(([key, field]) => pluginIdentifier(key) && record(field)
      && exact(field, ["type", "label"]) && ["text", "secret"].includes(field.type as string) && typeof field.label === "string" && field.label.length > 0 && field.label.length <= 80 && !/[\x00-\x1f\x7f]/.test(field.label));
}
export function parsePluginSettingsView(value: unknown): PluginSettingsView | null {
  if (!record(value) || !exact(value, ["values", "secretConfigured"]) || !record(value.values) || !record(value.secretConfigured)) return null;
  if (Object.keys(value.values).length + Object.keys(value.secretConfigured).length > 4
    || !Object.entries(value.values).every(([key, text]) => pluginIdentifier(key) && typeof text === "string" && new TextEncoder().encode(text).length <= 2048)
    || !Object.entries(value.secretConfigured).every(([key, set]) => pluginIdentifier(key) && typeof set === "boolean" && !Object.hasOwn(value.values as object, key))) return null;
  return value as unknown as PluginSettingsView;
}
export function parsePluginCatalog(value: unknown): PluginCatalog | null {
  if (!record(value) || !exact(value, ["directory", "node", "plugins", ...(Object.hasOwn(value, "python") ? ["python"] : [])]) || !absolutePath(value.directory)
    || !record(value.node) || !exact(value.node, ["status", "version", "path"])
    || !Array.isArray(value.plugins)) return null;
  const node = value.node;
  if (node.status === "not_found") {
    if (node.version !== null || node.path !== null) return null;
  } else if (node.status === "detected" || node.status === "unsupported") {
    if (!versionString(node.version) || !absolutePath(node.path)) return null;
    const [major, minor] = node.version.split(".").map(Number);
    if ((major > 22 || (major === 22 && minor >= 18)) !== (node.status === "detected")) return null;
  } else return null;
  if (Object.hasOwn(value, "python")) {
    const python = value.python;
    if (!record(python) || !exact(python, ["status", "version", "path"])) return null;
    if (python.status === "not_found") {
      if (python.version !== null || python.path !== null) return null;
    } else if (python.status === "detected" || python.status === "unsupported") {
      if (!versionString(python.version) || !absolutePath(python.path)) return null;
      const [major, minor] = python.version.split(".").map(Number);
      if ((major > 3 || (major === 3 && minor >= 10)) !== (python.status === "detected")) return null;
    } else return null;
  }
  const seen = new Set<string>();
  for (const plugin of value.plugins) {
    if (!record(plugin) || !exact(plugin, ["id", "name", "version", "protocolVersion", "status", "message", "icon", "trusted", "identity", ...(Object.hasOwn(plugin, "runtime") ? ["runtime"] : []), ...(Object.hasOwn(plugin, "settings") ? ["settings"] : [])])
      || (Object.hasOwn(plugin, "settings") && !validPluginSettingsSchema(plugin.settings))
      || (Object.hasOwn(plugin, "runtime") && plugin.runtime !== "node" && plugin.runtime !== "python")
      || !(plugin.id === "" || pluginIdentifier(plugin.id)) || !boundedText(plugin.name, 80)
      || !(plugin.version === "" || versionString(plugin.version))
      || !safeInteger(plugin.protocolVersion) || plugin.protocolVersion < 0 || plugin.protocolVersion > 255
      || !(plugin.message === null || boundedText(plugin.message, 300))
      || !(plugin.icon === null || isIconSource(plugin.icon)) || typeof plugin.trusted !== "boolean") return null;
    if (plugin.id) { if (seen.has(plugin.id)) return null; seen.add(plugin.id); }
    if (plugin.status === "ready") {
      if (!pluginIdentifier(plugin.id) || !versionString(plugin.version) || plugin.protocolVersion !== 1 || plugin.message !== null || !packageIdentity(plugin.identity)) return null;
    } else if (plugin.status === "invalid") {
      if (plugin.message === null || plugin.identity !== null) return null;
    } else if (plugin.status === "incompatible") {
      if (!pluginIdentifier(plugin.id) || !versionString(plugin.version) || plugin.protocolVersion <= 1 || plugin.message === null || plugin.identity !== null) return null;
    } else return null;
  }
  try { if (new TextEncoder().encode(JSON.stringify(value)).length > 1_048_576) return null; }
  catch { return null; }
  const catalog = value as unknown as PluginCatalog;
  return { ...catalog, plugins: catalog.plugins.map((plugin) => ({ ...plugin, message: plugin.status === "ready" ? null
    : plugin.status === "incompatible" ? "Protocol version 1 is required."
      : plugin.runtime === "python" ? "Invalid Python plugin folder. Include manifest.json, exactly one main.py entrypoint and the complete zdeck_plugin_sdk directory, with regular files and no symlinks."
      : plugin.message && Object.hasOwn(SDK_INSTALL_HINTS, plugin.message) ? `${SDK_INSTALL_HINTS[plugin.message]} Do not repair a distribution install with npm install.`
          : "Invalid plugin folder. Check its name, manifest.json, main.js and bundled SDK. SDK symlinks/source npm layouts are not distribution installs: copy the complete packaged folder, including node_modules. Do not repair a distribution install with npm install." })) };
}

export function isPluginArgs(value: unknown): value is PluginArgs {
  return record(value) && Object.keys(value).length <= 8
    && Object.entries(value).every(([key, n]) => pluginIdentifier(key) && (safeInteger(n) || typeof n === "boolean"));
}
export function validPluginField(field: unknown): field is PluginField {
  if (!record(field)) return false;
  const controlled = Object.hasOwn(field, "control");
  if (field.type === "boolean") return exact(field, ["type", ...(controlled ? ["control"] : [])])
    && (!controlled || record(field.control) && exact(field.control, ["stateKey", ...(Object.hasOwn(field.control, "entityKey") ? ["entityKey"] : [])]) && pluginIdentifier(field.control.stateKey)
      && (!Object.hasOwn(field.control, "entityKey") || pluginIdentifier(field.control.entityKey)));
  return field.type === "integer" && exact(field, ["type", "minimum", "maximum", ...(controlled ? ["control"] : []), ...(Object.hasOwn(field, "choicesKey") ? ["choicesKey"] : [])])
    && (!Object.hasOwn(field, "choicesKey") || !controlled && pluginIdentifier(field.choicesKey))
    && safeInteger(field.minimum) && safeInteger(field.maximum) && field.minimum <= field.maximum
    && (!controlled || record(field.control) && exact(field.control, ["step"]) && safeInteger(field.control.step)
      && field.control.step > 0 && Number.isSafeInteger(field.maximum - field.minimum) && field.control.step <= field.maximum - field.minimum
      && (field.maximum - field.minimum) % field.control.step === 0);
}
export function pluginControlField(action: PluginAction): [string, PluginField] | null {
  return Object.entries(action.config).find(([, field]) => field.control) ?? null;
}
export function parsePluginManifest(value: unknown): PluginManifest | null {
  if (!record(value) || !exact(value, ["id", "version", "protocolVersion", "actions", ...(Object.hasOwn(value, "icons") ? ["icons"] : []), ...(Object.hasOwn(value, "icon") ? ["icon"] : []), ...(Object.hasOwn(value, "settings") ? ["settings"] : []), ...(Object.hasOwn(value, "values") ? ["values"] : [])])
    || (Object.hasOwn(value, "values") && (!Array.isArray(value.values) || value.values.length > 32))
    || (Object.hasOwn(value, "settings") && !validPluginSettingsSchema(value.settings))
    || (Object.hasOwn(value, "icons") && !isPluginIcons(value.icons))
    || (Object.hasOwn(value, "icon") && !isIconSource(value.icon))
    || !pluginIdentifier(value.id) || typeof value.version !== "string" || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value.version)
    || value.protocolVersion !== 1 || !Array.isArray(value.actions) || value.actions.length < 1 || value.actions.length > 32) return null;
  const seen = new Set<string>();
  for (const action of [...value.actions, ...(value.values as unknown[] ?? [])]) {
    const reading = (value.values as unknown[] | undefined)?.includes(action);
    if (!record(action) || !exact(action, ["id", "title", "config", ...(reading ? ["stateKey", "entityKey"] : [])]) || !pluginIdentifier(action.id) || seen.has(action.id)
      || typeof action.title !== "string" || action.title.length < 1 || action.title.length > 80 || /[\x00-\x1f\x7f]/.test(action.title)
      || !record(action.config) || Object.keys(action.config).length > 8) return null;
    seen.add(action.id);
    for (const [key, field] of Object.entries(action.config)) {
      if (!pluginIdentifier(key) || !validPluginField(field)) return null;
    }
    if (Object.values(action.config).filter((field) => (field as PluginField).control).length > 1) return null;
    for (const field of Object.values(action.config) as PluginField[]) {
      if (field.type === "boolean" && field.control?.entityKey && !selectionBinding(action.config as PluginAction["config"], field.control)) return null;
    }
    if (reading && (!selectionBinding(action.config as PluginAction["config"], action)
      || Object.keys(action.config).length !== 1 || Object.values(action.config).some((field) => (field as PluginField).control))) return null;
  }
  try { if (new TextEncoder().encode(JSON.stringify(value)).length > 16384) return null; }
  catch { return null; }
  return value as unknown as PluginManifest;
}

function selectionBinding(config: PluginAction["config"], binding: { stateKey?: unknown; entityKey?: unknown }): boolean {
  if (!pluginIdentifier(binding.stateKey) || !pluginIdentifier(binding.entityKey)) return false;
  const field = config[binding.entityKey];
  return field?.type === "integer" && field.choicesKey === binding.stateKey;
}

const ERROR_MESSAGES: Record<string, string> = {
  invalid_launch: "Select absolute paths to a trusted Node runtime and plugin entrypoint.",
  unavailable: "Plugin process unavailable.", stopped: "Plugin stopped. Enable it explicitly again in Settings.",
  invalid_manifest: "The plugin manifest is invalid.", invalid_arguments: "Arguments do not match the action configuration.",
  unknown_action: "This action is not declared by the connected plugin.", protocol: "Invalid plugin response.",
  timeout: "Plugin request timed out.", plugin_failed: "Plugin operation failed.",
};
const CODE_HINTS: Record<string, string> = {
  missing_dependency: "Required plugin dependencies are missing. Copy the complete packaged plugin folder, including node_modules or zdeck_plugin_sdk as appropriate—not the source folder.",
  runtime_missing: "The plugin runtime could not be started. Install its required runtime (Node.js 22.18.0+ or Python 3.10+) and refresh the catalog.",
  runtime_incompatible: "The plugin runtime is too old. Install its required runtime (Node.js 22.18.0+ or Python 3.10+) and refresh the catalog.",
  startup_exit: "The plugin exited before describing its actions. Check its complete packaged folder and required runtime (Node.js 22.18.0+ or Python 3.10+). No action was sent.",
  unsupported_platform: "Spotify control requires macOS.", app_missing: "Install Spotify desktop in /Applications.",
  app_not_running: "Open Spotify manually.", automation_denied: "Allow the launching application to control Spotify in macOS Privacy & Security → Automation.",
  invalid_state: "Read state and check integration compatibility and the selected entity's capabilities.",
  invalid_arguments: "Check connection settings and declared arguments, then read state and select an available binding before manually retrying.",
  command_failed: "Check the integration connection and permissions; inspect state before manually retrying.",
  authentication_failed: "Authentication failed. Disable the plugin, replace its saved token in connection settings, apply and enable again.",
  connection_failed: "Check the configured URL, network and trusted TLS certificate. No automatic retry was made.",
  state_required: "After enabling or reconnecting, explicitly read state before deciding whether to send an action.",
  entity_unavailable: "The selected entity is unavailable. Read state and check the device before deciding whether to run it.",
  settings_required: "Trust the package, open Connection settings, load and apply the required values, then enable it.",
  settings_unavailable: "OS credential storage is unavailable or locked. Check secure storage access, then try again. No plaintext fallback is used.",
  settings_invalid: "Use only declared settings. Each value is limited to 2048 UTF-8 bytes; the stored settings envelope must fit 2400 UTF-16 bytes.",
  plugin_connected: "Disable this plugin before changing or forgetting settings. Apply never enables or runs it.",
  outcome_unknown: "The command may have applied but its state could not be read.",
  not_trusted: "Confirm trust for this exact installed package, then enable it. If its files changed, review them again before enabling.",
  stale_identity: "This plugin changed on disk after the confirmation was opened. Refresh the catalog, review the current files, and confirm trust again.",
  capacity: "Runtime capacity is reached: too many plugins are running at once. Disable one plugin, then enable this one again.",
};
const ERROR_CODES = new Set([...Object.keys(CODE_HINTS), "invalid_request", "request_too_large", "unknown_action", "invalid_arguments",
  "internal_error", "response_too_large", "timeout", "not_trusted", "capacity", "stale_identity"]);

/** Fixed local copy: even an exception shaped like a backend error cannot inject raw diagnostic text. */
export function toPluginError(value: unknown): PluginError {
  const known = record(value) && typeof value.kind === "string" && Object.hasOwn(ERROR_MESSAGES, value.kind);
  const kind = known ? value.kind as string : "unavailable";
  const code = known && typeof value.code === "string" && ERROR_CODES.has(value.code) ? value.code : null;
  const outcome = known && value.outcome === "not_started" ? "not_started" : "unknown";
  return { kind, code, outcome, message: ERROR_MESSAGES[kind], hint:
    code && ["settings_required", "settings_unavailable", "settings_invalid", "plugin_connected", "authentication_failed", "connection_failed", "state_required", "entity_unavailable"].includes(code)
      ? CODE_HINTS[code]
      : `${code && CODE_HINTS[code] ? CODE_HINTS[code] + " " : ""}Refresh the catalog and explicitly enable the trusted plugin after checking its local configuration. Never automatically retry actions.` };
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
export function pluginDefaults(action: PluginAction): PluginArgs {
  return Object.fromEntries(Object.entries(action.config).map(([key, field]) => {
    if (field.type === "boolean") return [key, false];
    const value = Math.max(field.minimum, Math.min(field.maximum, key === "volume" ? 50 : 0));
    return [key, field.control ? field.minimum + Math.floor((value - field.minimum) / field.control.step) * field.control.step : value];
  }));
}
export function pluginControlAction(snapshot: PluginSnapshot, control: PluginControl): PluginAction | null {
  return snapshot.manifest?.id === control.pluginId
    ? (control.presentation === "value" ? snapshot.manifest.values : snapshot.manifest.actions)?.find((action) => action.id === control.pluginAction) ?? null : null;
}
export function pluginArgumentsValid(action: PluginAction, args: PluginArgs): boolean {
  return isPluginArgs(args) && Object.keys(args).length === Object.keys(action.config).length
    && Object.entries(action.config).every(([key, field]) => {
      const value = args[key];
      return Object.hasOwn(args, key) && (field.type === "boolean" ? typeof value === "boolean"
        : typeof value === "number" && value >= field.minimum && value <= field.maximum
          && (!field.control || (value - field.minimum) % field.control.step === 0));
    });
}
export interface PluginObservation { value: number | boolean | null; unit: string; observedAtMs: number }
export interface PluginChoice { value: number; label: string; available: boolean; description?: string; observation?: PluginObservation }
function validObservation(value: unknown): value is PluginObservation {
  return record(value) && exact(value, ["value", "unit", "observedAtMs"])
    && (value.value === null || typeof value.value === "boolean" || typeof value.value === "number" && Number.isFinite(value.value) && Math.abs(value.value) <= Number.MAX_SAFE_INTEGER)
    && typeof value.unit === "string" && value.unit.length <= 24 && !/\p{Cc}/u.test(value.unit)
    && safeInteger(value.observedAtMs) && value.observedAtMs > 0;
}
export function pluginObservation(snapshot: PluginSnapshot, control: PluginControl, binding: { stateKey: string; entityKey: string }): PluginObservation | null {
  const action = pluginControlAction(snapshot, control);
  if (snapshot.status !== "connected" || snapshot.lastError || !action || !pluginArgumentsValid(action, control.pluginArgs)) return null;
  const field = action.config[binding.entityKey];
  if (!field || field.type !== "integer" || field.choicesKey !== binding.stateKey) return null;
  const choice = pluginChoices(snapshot, field)?.find((choice) => choice.value === control.pluginArgs[binding.entityKey]);
  return choice?.observation ? { ...choice.observation, value: choice.available ? choice.observation.value : null } : null;
}
export function pluginValue(snapshot: PluginSnapshot, control: PluginControl): PluginObservation | null {
  const binding = snapshot.manifest?.values?.find((value) => value.id === control.pluginAction);
  return control.presentation === "value" && binding ? pluginObservation(snapshot, control, binding) : null;
}
/** State is untrusted display data, not executable metadata or an action target. */
export function pluginChoices(snapshot: PluginSnapshot, field: PluginField): PluginChoice[] | null {
  if (field.type !== "integer" || !field.choicesKey || !snapshot.state) return null;
  const choices = snapshot.state[field.choicesKey];
  if (!Array.isArray(choices) || choices.length > 256) return null;
  const seen = new Set<number>();
  for (const choice of choices) {
    if (!record(choice) || !exact(choice, ["value", "label", "available", ...(Object.hasOwn(choice, "description") ? ["description"] : []), ...(Object.hasOwn(choice, "observation") ? ["observation"] : [])]) || !safeInteger(choice.value)
      || choice.value < field.minimum || choice.value > field.maximum || seen.has(choice.value)
      || !boundedText(choice.label, 320) || typeof choice.available !== "boolean"
      || Object.hasOwn(choice, "description") && !boundedText(choice.description, 320)
      || Object.hasOwn(choice, "observation") && !validObservation(choice.observation)) return null;
    seen.add(choice.value);
  }
  return choices as PluginChoice[];
}
export function canRunPlugin(snapshot: PluginSnapshot, control: PluginControl): boolean {
  const action = pluginControlAction(snapshot, control);
  return control.presentation !== "value" && snapshot.status === "connected" && !snapshot.lastError && action !== null && pluginArgumentsValid(action, control.pluginArgs)
    && Object.entries(action.config).every(([key, field]) => field.type !== "integer" || !field.choicesKey
      || pluginChoices(snapshot, field)?.some((choice) => choice.value === control.pluginArgs[key] && choice.available) === true);
}
export function pluginLaunchAllowed(program: string, entrypoint: string, trusted: boolean): boolean {
  return trusted && absolutePath(program) && absolutePath(entrypoint);
}
/** Trust must succeed before enable runs; a failed trust never attempts enable. */
export interface PluginTrustConsole {
  trust(id: string, identity: string): Promise<boolean>;
  enable(id: string): Promise<unknown>;
}
export async function trustAndEnablePlugin(plugin: PluginTrustConsole, id: string, identity: string): Promise<boolean> {
  if (!(await plugin.trust(id, identity))) return false;
  await plugin.enable(id);
  return true;
}

/** Only this bounded Spotify view is displayed; arbitrary plugin state is never dumped. */
export function spotifyState(snapshot: PluginSnapshot): { title: string | null; artist: string | null; playback: string; volume: number } | null {
  if (snapshot.manifest?.id !== "spotify" || !snapshot.state) return null;
  const { title, artist, playback, volume } = snapshot.state;
  if (![title, artist].every((text) => text === null || (typeof text === "string" && text.length <= 2048))
    || typeof playback !== "string" || !["playing", "paused", "stopped"].includes(playback) || !safeInteger(volume) || volume < 0 || volume > 100) return null;
  return { title: title as string | null, artist: artist as string | null, playback: playback as string, volume };
}
