import { useCallback, useEffect, useRef, useState } from "react";
import { nativeAvailable } from "./native";
import { pluginCatalog, pluginDiagnostics, pluginDisconnect, pluginEnable, pluginExecute, pluginOpenDirectory, pluginSnapshots, pluginState, pluginTrust, pluginUninstall } from "./nativePlugin";
import { canRunPlugin, EMPTY_PLUGIN, pluginEntry, pluginIdentifier, toPluginError } from "./plugin";
import type { PluginCatalog, PluginDiagnostics, PluginError, PluginSnapshots } from "./plugin";
import type { PluginControl } from "./types";

export function usePluginConsole() {
  const native = nativeAvailable();
  const [snapshots, setSnapshots] = useState<PluginSnapshots>({});
  const [catalog, setCatalog] = useState<PluginCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<PluginError | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(native);
  const [loading, setLoading] = useState(native);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, PluginError | null>>({});
  const [diagnostics, setDiagnostics] = useState<Record<string, PluginDiagnostics>>({});
  const [completedIds, setCompletedIds] = useState<Record<string, string | null>>({});
  const [trustEpoch, setTrustEpoch] = useState<Record<string, number>>({});
  const [catalogEpoch, setCatalogEpoch] = useState(0);
  const locks = useRef(new Set<string>());
  const enabling = useRef(new Set<string>());
  const catalogLock = useRef(false);
  const catalogVersion = useRef(0);
  const mounted = useRef(false);
  const ready = useRef(false);
  const resetTrust = (id: string) => setTrustEpoch((current) => ({ ...current, [id]: (pluginEntry(current, id) ?? 0) + 1 }));

  useEffect(() => {
    mounted.current = true;
    if (native) {
      let active = true;
      catalogLock.current = true;
      void Promise.allSettled([pluginSnapshots(), pluginCatalog()]).then(([sessions, discovery]) => {
        if (!active) return;
        if (sessions.status === "fulfilled") setSnapshots(sessions.value);
        else setCatalogError(toPluginError(sessions.reason));
        if (discovery.status === "fulfilled") setCatalog(discovery.value);
        else setCatalogError(toPluginError(discovery.reason));
        ready.current = sessions.status === "fulfilled";
        catalogLock.current = false;
        setLoading(false); setCatalogBusy(false);
      });
      return () => { active = false; mounted.current = false; ready.current = false; };
    }
    return () => { mounted.current = false; };
  }, [native]);

  const localOperation = useCallback(async (operation: () => Promise<void>) => {
    if (!native || catalogLock.current) return;
    catalogLock.current = true; setCatalogBusy(true); setCatalogError(null); setCatalogEpoch((n) => n + 1);
    try { await operation(); }
    catch (cause) { if (mounted.current) setCatalogError(toPluginError(cause)); }
    finally { catalogLock.current = false; if (mounted.current) setCatalogBusy(false); }
  }, [native]);

  const rowOperation = async (id: string, operation: () => Promise<void>, mutation = false): Promise<boolean> => {
    if (!native || !ready.current || !pluginIdentifier(id) || locks.current.has(id)
      || (!Object.hasOwn(snapshots, id) && !catalog?.plugins.some((entry) => entry.id === id))) return false;
    locks.current.add(id); setBusy((current) => ({ ...current, [id]: true }));
    resetTrust(id); setErrors((current) => ({ ...current, [id]: null })); setCompletedIds((current) => ({ ...current, [id]: null }));
    let succeeded = false;
    try { await operation(); succeeded = true; }
    catch (cause) {
      if (mounted.current) {
        const error = toPluginError(cause);
        setErrors((current) => ({ ...current, [id]: error }));
        if (mutation) setSnapshots((current) => ({ ...current, [id]: { ...(pluginEntry(current, id) ?? EMPTY_PLUGIN), status: "stopped", state: null, lastError: error } }));
      }
    } finally {
      locks.current.delete(id);
      if (mounted.current) setBusy((current) => ({ ...current, [id]: false }));
    }
    return succeeded;
  };
  const run = (id: string, operation: () => ReturnType<typeof pluginState>, completedId: string | null = null): Promise<void> => rowOperation(id, async () => {
    const snapshot = await operation();
    if (!mounted.current) return;
    setSnapshots((current) => ({ ...current, [id]: snapshot }));
    if (!snapshot.lastError && snapshot.status === "connected") setCompletedIds((current) => ({ ...current, [id]: completedId }));
  }, true).then(() => {});

  return {
    refreshSnapshots: async () => {
      if (!native) return;
      try { const next = await pluginSnapshots(); if (mounted.current) setSnapshots(next); }
      catch (cause) { if (mounted.current) setCatalogError(toPluginError(cause)); }
    },
    native, snapshots, catalog, catalogError, catalogBusy, loading, sessionsReady: ready.current, busy, errors, diagnostics, completedIds, trustEpoch, catalogEpoch,
    refreshCatalog: () => localOperation(async () => {
      const version = ++catalogVersion.current;
      const next = await pluginCatalog();
      if (mounted.current && version === catalogVersion.current) { setCatalog(next); setCatalogEpoch((n) => n + 1); }
    }),
    openDirectory: () => localOperation(pluginOpenDirectory),
    enable: (id: string) => {
      if (catalogLock.current || !catalog || catalog.node.status !== "detected"
        || !catalog.plugins.some((entry) => entry.id === id && entry.status === "ready")
        || pluginEntry(snapshots, id)?.status === "connected" || locks.current.has(id) || enabling.current.has(id)) return Promise.resolve();
      enabling.current.add(id);
      return run(id, () => pluginEnable(id)).finally(() => { enabling.current.delete(id); });
    },
    trust: (id: string, identity: string) => rowOperation(id, async () => {
      await pluginTrust(id, identity);
      if (mounted.current) setCatalog((current) => current ? { ...current, plugins: current.plugins.map((entry) => entry.id === id ? { ...entry, trusted: true } : entry) } : null);
    }),
    disconnect: (id: string) => run(id, () => pluginDisconnect(id)),
    readState: (id: string) => pluginEntry(snapshots, id)?.status === "connected" && !pluginEntry(snapshots, id)?.lastError ? run(id, () => pluginState(id)) : Promise.resolve(),
    execute: (control: PluginControl) => canRunPlugin(pluginEntry(snapshots, control.pluginId) ?? EMPTY_PLUGIN, control)
      ? run(control.pluginId, () => pluginExecute(control.pluginId, control.pluginAction, control.pluginArgs), control.id) : Promise.resolve(),
    diagnose: (id: string) => rowOperation(id, async () => {
      const result = await pluginDiagnostics(id);
      if (mounted.current) setDiagnostics((current) => ({ ...current, [id]: result }));
    }).then(() => {}),
    uninstall: (id: string) => rowOperation(id, async () => {
      await pluginUninstall(id);
      if (!mounted.current) return;
      catalogVersion.current += 1;
      setSnapshots((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)));
      setCatalog((current) => current ? { ...current, plugins: current.plugins.filter((entry) => entry.id !== id) } : null);
      setDiagnostics((current) => Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)));
    }, true).then(() => {}),
  };
}
export type PluginConsole = ReturnType<typeof usePluginConsole>;
