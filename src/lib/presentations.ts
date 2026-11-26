import { pluginControlAction, pluginControlField, pluginEntry, pluginArgumentsValid } from "./plugin";
import type { PluginSnapshots } from "./plugin";
import type { Control, Presentation } from "./types";

type Contract =
  | { kind: "numeric"; minimum: number; maximum: number; step: number; value: number }
  | { kind: "boolean"; value: boolean | null };

/** Metadata, never field/action names, determines the writable scalar contract. */
export function controlContract(control: Control, plugins: PluginSnapshots = {}): Contract | null {
  if (control.action === "volume") return { kind: "numeric", minimum: 0, maximum: 100, step: 1, value: control.volume };
  if (control.action !== "plugin") return null;
  const snapshot = pluginEntry(plugins, control.pluginId);
  if (!snapshot) return null;
  const action = pluginControlAction(snapshot, control);
  if (!action || !pluginArgumentsValid(action, control.pluginArgs)) return null;
  const entry = pluginControlField(action);
  if (!entry) return null;
  const [key, field] = entry;
  if (field.type === "integer" && field.control) return {
    kind: "numeric", minimum: field.minimum, maximum: field.maximum, step: field.control.step,
    value: control.pluginArgs[key] as number,
  };
  if (field.type === "boolean" && field.control) {
    const observed = snapshot.state?.[field.control.stateKey];
    return { kind: "boolean", value: snapshot.status === "connected" && !snapshot.lastError && typeof observed === "boolean" ? observed : null };
  }
  return null;
}

export function compatiblePresentations(control: Control, plugins: PluginSnapshots = {}): Presentation[] {
  const contract = controlContract(control, plugins);
  return contract?.kind === "numeric" ? ["button", "slider", "dial"]
    : contract?.kind === "boolean" ? ["button", "toggle-switch", "toggle-button"] : ["button"];
}

export function effectivePresentation(control: Control, plugins: PluginSnapshots = {}): Presentation {
  const requested = control.presentation ?? (control.action === "volume" ? "slider" : "button");
  return compatiblePresentations(control, plugins).includes(requested) ? requested : "button";
}

export function presentationCompatible(control: Control, plugins: PluginSnapshots = {}): boolean {
  return !control.presentation || compatiblePresentations(control, plugins).includes(control.presentation);
}

export function validControlValue(control: Control, value: number, plugins: PluginSnapshots = {}): boolean {
  if (!Number.isFinite(value) || !presentationCompatible(control, plugins)) return false;
  const presentation = effectivePresentation(control, plugins);
  const contract = controlContract(control, plugins);
  if (contract?.kind === "numeric" && (presentation === "slider" || presentation === "dial")) {
    return (control.action === "volume" || Number.isSafeInteger(value)) && value >= contract.minimum && value <= contract.maximum
      && (control.action === "volume" || (value - contract.minimum) % contract.step === 0);
  }
  return contract?.kind === "boolean" && contract.value !== null
    && (presentation === "toggle-switch" || presentation === "toggle-button") && (value === 0 || value === 1);
}
