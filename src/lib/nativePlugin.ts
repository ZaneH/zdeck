import { invoke } from "@tauri-apps/api/core";
import { nativeAvailable } from "./native";
import { isPluginArgs, parsePluginCatalog, parsePluginDiagnostics, parsePluginSnapshot, parsePluginSnapshots, pluginIdentifier, toPluginError } from "./plugin";
import type { PluginCatalog, PluginDiagnostics, PluginSnapshot, PluginSnapshots } from "./plugin";

async function invokeNative(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  if (!nativeAvailable()) throw toPluginError({ kind: "unavailable", outcome: "not_started" });
  try { return await invoke<unknown>(command, args); }
  catch (error) { throw toPluginError(error); }
}
function requireId(pluginId: string) {
  if (!pluginIdentifier(pluginId)) throw toPluginError({ kind: "invalid_arguments", outcome: "not_started" });
}
async function invokePlugin(command: string, pluginId: string, extra: Record<string, unknown> = {}): Promise<PluginSnapshot> {
  requireId(pluginId);
  const snapshot = parsePluginSnapshot(await invokeNative(command, { pluginId, ...extra }));
  if (!snapshot || (snapshot.manifest && snapshot.manifest.id !== pluginId)) throw toPluginError({ kind: "protocol", outcome: command === "plugin_execute" ? "unknown" : "not_started" });
  return snapshot;
}
export async function pluginCatalog(): Promise<PluginCatalog> {
  const catalog = parsePluginCatalog(await invokeNative("plugin_catalog"));
  if (!catalog) throw toPluginError({ kind: "protocol", outcome: "not_started" });
  return catalog;
}
export async function pluginSnapshots(): Promise<PluginSnapshots> {
  const snapshots = parsePluginSnapshots(await invokeNative("plugin_snapshots"));
  if (!snapshots) throw toPluginError({ kind: "protocol", outcome: "not_started" });
  return snapshots;
}
export function pluginEnable(pluginId: string): Promise<PluginSnapshot> { return invokePlugin("plugin_enable", pluginId); }
/** Persists trust for the exact reviewed package identity; the backend refuses a stale/mismatched fingerprint. */
export async function pluginTrust(pluginId: string, expectedIdentity: string): Promise<void> {
  requireId(pluginId);
  if (!/^[a-f0-9]{64}$/.test(expectedIdentity)) throw toPluginError({ kind: "invalid_arguments", outcome: "not_started" });
  if (await invokeNative("plugin_trust", { pluginId, expectedIdentity }) !== null) throw toPluginError({ kind: "protocol", outcome: "not_started" });
}
export function pluginDisconnect(pluginId: string): Promise<PluginSnapshot> { return invokePlugin("plugin_disconnect", pluginId); }
/** Cached metadata only; neither operation executes plugin code. */
export function pluginSnapshot(pluginId: string): Promise<PluginSnapshot> { return invokePlugin("plugin_snapshot", pluginId); }
export function pluginState(pluginId: string): Promise<PluginSnapshot> { return invokePlugin("plugin_state", pluginId); }
export async function pluginDiagnostics(pluginId: string): Promise<PluginDiagnostics> {
  requireId(pluginId);
  const diagnostics = parsePluginDiagnostics(await invokeNative("plugin_diagnostics", { pluginId }), pluginId);
  if (!diagnostics) throw toPluginError({ kind: "protocol", outcome: "not_started" });
  return diagnostics;
}
export async function pluginUninstall(pluginId: string): Promise<void> {
  requireId(pluginId);
  if (await invokeNative("plugin_uninstall", { pluginId }) !== null) throw toPluginError({ kind: "protocol", outcome: "unknown" });
}
export async function pluginOpenDirectory(): Promise<void> {
  if (await invokeNative("plugin_open_directory") !== null) throw toPluginError({ kind: "protocol", outcome: "not_started" });
}
export async function pluginExecute(pluginId: string, actionId: string, args: Record<string, number>): Promise<PluginSnapshot> {
  if (!pluginIdentifier(actionId) || !isPluginArgs(args)) throw toPluginError({ kind: "invalid_arguments", outcome: "not_started" });
  return invokePlugin("plugin_execute", pluginId, { actionId, args });
}
