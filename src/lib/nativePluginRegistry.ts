import { invoke } from "@tauri-apps/api/core";
import { nativeAvailable } from "./native";

export interface RegistryWebsiteStatus { available: boolean; explanation: string | null }
export const WEBSITE_UNAVAILABLE: RegistryWebsiteStatus = { available: false, explanation: "Registry website not configured for this build." };
export async function registryWebsiteStatus(): Promise<RegistryWebsiteStatus> {
  if (!nativeAvailable()) return { available: false, explanation: "Open the desktop app to browse the registry." };
  const value = await invoke<unknown>("plugin_registry_website_status", {});
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2
    || !("available" in value) || !("explanation" in value) || typeof value.available !== "boolean"
    || (value.available ? value.explanation !== null : typeof value.explanation !== "string" || !value.explanation.length || value.explanation.length > 320 || /[\x00-\x1f\x7f]/.test(value.explanation))) {
    throw new Error("Registry website availability could not be checked. Reload the desktop app.");
  }
  return value as RegistryWebsiteStatus;
}
export async function registryOpenWebsite(): Promise<void> {
  if (!nativeAvailable()) throw new Error("Open the desktop app to browse the registry.");
  // No URL, browser command, or other caller-controlled argument crosses IPC.
  if (await invoke<unknown>("plugin_registry_open_website", {}) !== null) throw new Error("The browser launch could not be confirmed. Check your browser before trying again.");
}
