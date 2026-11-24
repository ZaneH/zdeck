import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { nativeAvailable } from "./native";
import { pluginCatalog, pluginDisconnect, pluginEnable, pluginExecute, pluginOpenDirectory, pluginSnapshot, pluginState } from "./nativePlugin";
import { canEnablePlugin, canRunPlugin, EMPTY_PLUGIN, EMPTY_SELECTION, pluginSelectionReducer, toPluginError } from "./plugin";
import type { PluginCatalog, PluginError, PluginSnapshot } from "./plugin";
import type { PluginControl } from "./types";

export function usePluginConsole() {
  const native = nativeAvailable();
  const [snapshot, setSnapshot] = useState<PluginSnapshot>(EMPTY_PLUGIN);
  const [catalog, setCatalog] = useState<PluginCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<PluginError | null>(null);
  const [selection, select] = useReducer(pluginSelectionReducer, EMPTY_SELECTION);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const generation = useRef(0);
  const [completedId, setCompletedId] = useState<string | null>(null);

  useEffect(() => {
    if (!native) return;
    let active = true;
    const token = ++generation.current;
    lock.current = true;
    setBusy(true);
    // Discovery probes the runtime only. Cached snapshot does not exchange with a plugin.
    void Promise.allSettled([pluginSnapshot(), pluginCatalog()]).then(([session, discovery]) => {
      if (!active || generation.current !== token) return;
      if (session.status === "fulfilled") setSnapshot(session.value);
      if (discovery.status === "fulfilled") { setCatalog(discovery.value); setCatalogError(null); }
      else setCatalogError({ ...toPluginError(discovery.reason), outcome: "not_started" });
      lock.current = false;
      setBusy(false);
    });
    return () => { active = false; };
  }, [native]);

  const localOperation = useCallback(async (operation: () => Promise<void>) => {
    if (!native || lock.current) return;
    lock.current = true;
    generation.current += 1;
    setBusy(true);
    setCatalogError(null);
    select({ type: "reset" });
    try { await operation(); }
    catch (cause) { setCatalogError({ ...toPluginError(cause), outcome: "not_started" }); }
    finally { lock.current = false; setBusy(false); }
  }, [native]);

  const run = useCallback(async (operation: () => Promise<PluginSnapshot>, controlId: string | null = null) => {
    if (!native || lock.current) return;
    lock.current = true;
    generation.current += 1;
    setBusy(true);
    setCompletedId(null);
    try {
      const next = await operation();
      setSnapshot(next);
      if (next.lastError) select({ type: "reset" });
      else if (next.status === "connected") setCompletedId(controlId);
    } catch (cause) {
      setSnapshot((previous) => ({ ...previous, status: "stopped", state: null, lastError: toPluginError(cause) }));
      select({ type: "reset" });
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }, [native]);

  return {
    native, snapshot, catalog, catalogError, busy, completedId,
    selectedId: selection.pluginId, trusted: selection.trusted,
    selectPlugin: (pluginId: string) => select({ type: "select", pluginId }),
    setTrusted: (checked: boolean) => select({ type: "trust", checked }),
    refreshCatalog: () => localOperation(async () => {
      select({ type: "refresh" });
      setCatalog(null);
      setCatalog(await pluginCatalog());
    }),
    openDirectory: () => localOperation(pluginOpenDirectory),
    enable: () => snapshot.status !== "connected" && canEnablePlugin(catalog, selection)
      ? run(() => pluginEnable(selection.pluginId)) : Promise.resolve(),
    disconnect: () => { select({ type: "reset" }); return run(pluginDisconnect); },
    readState: () => snapshot.status === "connected" && !snapshot.lastError ? run(pluginState) : Promise.resolve(),
    execute: (control: PluginControl) => canRunPlugin(snapshot, control)
      ? run(() => pluginExecute(control.pluginId, control.pluginAction, control.pluginArgs), control.id) : Promise.resolve(),
  };
}
export type PluginConsole = ReturnType<typeof usePluginConsole>;
