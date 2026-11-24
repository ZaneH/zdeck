import { invoke } from "@tauri-apps/api/core";
import { nativeAvailable } from "./native";
import { isPluginArgs, parsePluginCatalog, parsePluginSnapshot, pluginIdentifier, toPluginError } from "./plugin";
import type { PluginCatalog, PluginSnapshot } from "./plugin";

async function invokeNative(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  if (!nativeAvailable()) throw toPluginError({ kind: "unavailable", outcome: "not_started" });
  try { return await invoke<unknown>(command, args); }
  catch (error) { throw toPluginError(error); }
}
async function invokePlugin(command: string, args: Record<string, unknown> = {}): Promise<PluginSnapshot> {
  const snapshot = parsePluginSnapshot(await invokeNative(command, args));
  if (!snapshot) throw toPluginError({ kind: "protocol", outcome: command === "plugin_execute" ? "unknown" : "not_started" });
  return snapshot;
}
export async function pluginCatalog(): Promise<PluginCatalog> {
  const catalog = parsePluginCatalog(await invokeNative("plugin_catalog"));
  if (!catalog) throw toPluginError({ kind: "protocol", outcome: "not_started" });
  return catalog;
}
export async function pluginEnable(pluginId: string): Promise<PluginSnapshot> {
  if (!pluginIdentifier(pluginId)) throw toPluginError({ kind: "invalid_arguments", outcome: "not_started" });
  return invokePlugin("plugin_enable", { pluginId });
}
export async function pluginOpenDirectory(): Promise<void> {
  if (await invokeNative("plugin_open_directory") !== null) throw toPluginError({ kind: "protocol", outcome: "not_started" });
}
export function pluginDisconnect(): Promise<PluginSnapshot> { return invokePlugin("plugin_disconnect"); }
/** Cached host metadata only: no child-process exchange or permission prompt. */
export function pluginSnapshot(): Promise<PluginSnapshot> { return invokePlugin("plugin_snapshot"); }
/** Intentional read: may cause macOS Automation consent. Never poll this. */
export function pluginState(): Promise<PluginSnapshot> { return invokePlugin("plugin_state"); }
export async function pluginExecute(pluginId: string, actionId: string, args: Record<string, number>): Promise<PluginSnapshot> {
  if (!pluginIdentifier(pluginId) || !pluginIdentifier(actionId) || !isPluginArgs(args)) {
    throw toPluginError({ kind: "invalid_arguments", outcome: "not_started" });
  }
  return invokePlugin("plugin_execute", { pluginId, actionId, args });
}
