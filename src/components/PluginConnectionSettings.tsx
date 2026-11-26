import { useState } from "react";
import { pluginSettingsForget, pluginSettingsLoad, pluginSettingsSave } from "../lib/nativePlugin";
import { pluginEntry, toPluginError } from "../lib/plugin";
import type { PluginSettingsSchema, PluginSettingsView } from "../lib/plugin";

export interface PluginSettingsIO {
  load(id: string): Promise<PluginSettingsView>;
  save(id: string, values: Record<string, string>, secrets: Record<string, string>): Promise<void>;
  forget(id: string, key: string): Promise<void>;
}
const nativeIO: PluginSettingsIO = { load: pluginSettingsLoad, save: pluginSettingsSave, forget: pluginSettingsForget };

/** Declared settings only. Password drafts are memory-only and cleared after apply/forget. */
export function PluginConnectionSettings({ id, schema, trusted, connected, io = nativeIO }: {
  id: string; schema: PluginSettingsSchema; trusted: boolean; connected: boolean; io?: PluginSettingsIO;
}) {
  const [view, setView] = useState<PluginSettingsView | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = !trusted || connected;
  const operation = async (run: () => Promise<void>) => {
    if (busy || blocked) return;
    setBusy(true); setError(null);
    try { await run(); }
    catch (cause) {
      const failure = toPluginError(cause);
      setError(failure.code && ["settings_invalid", "settings_required", "settings_unavailable", "plugin_connected", "not_trusted"].includes(failure.code)
        ? failure.hint : "Plugin settings could not be read or saved securely. Check the OS credential store is available and unlocked, then try again. No plaintext fallback is used.");
    }
    finally { setSecrets({}); setBusy(false); }
  };
  const load = async () => { const next = await io.load(id); setView(next); setValues(next.values); };
  return <details className="settings-help">
    <summary className="disclosure">Connection settings</summary>
    {!trusted ? <p>Trust this exact package before configuring it. Settings do not enable the plugin.</p> : null}
    {connected ? <p>Disable the plugin before changing or forgetting connection settings.</p> : null}
    <p className="field-note">Saved in the OS credential store, separate from decks and exports. Secrets are never read back into this form. An updated package receives saved settings only after you trust it.</p>
    {error ? <p className="settings-error" role="alert">{error}</p> : null}
    {error ? <p className="field-note">If saved settings are damaged, forgetting a secret clears all saved settings for this plugin.</p> : null}
    {!view && error ? <div className="settings-actions">{Object.entries(schema).filter(([, field]) => field.type === "secret").map(([key, field]) =>
      <button key={key} type="button" className="button secondary" disabled={blocked || busy}
        onClick={() => void operation(async () => { await io.forget(id, key); await load(); })}>Forget {field.label} and recover settings</button>)}</div> : null}
    {!view ? <button type="button" className="button secondary" disabled={blocked || busy} onClick={() => void operation(load)}>Load settings</button> : <form onSubmit={(event) => {
      event.preventDefault();
      void operation(async () => { await io.save(id, values, Object.fromEntries(Object.entries(secrets).filter(([, value]) => value.length > 0))); await load(); });
    }}>
      {Object.entries(schema).map(([key, field]) => <div key={key}>
        <label className="field"><span>{field.label}</span>
          <input type={field.type === "secret" ? "password" : "text"} autoComplete="off" spellCheck={false} maxLength={2048}
            disabled={blocked || busy} value={(field.type === "secret" ? pluginEntry(secrets, key) : pluginEntry(values, key)) ?? ""}
            placeholder={field.type === "secret" && pluginEntry(view.secretConfigured, key) ? "Saved — leave blank to keep" : undefined}
            onChange={(event) => {
              const value = event.target.value;
              if (field.type === "secret") setSecrets((current) => ({ ...current, [key]: value }));
              else setValues((current) => ({ ...current, [key]: value }));
            }} />
        </label>
        {field.type === "secret" ? <div className="settings-actions">
          <span className="field-note">{pluginEntry(view.secretConfigured, key) ? "Secret saved" : "No secret saved"}</span>
          <button type="button" className="button secondary" disabled={blocked || busy || !pluginEntry(view.secretConfigured, key)}
            onClick={() => void operation(async () => { await io.forget(id, key); await load(); })}>Forget {field.label}</button>
        </div> : null}
      </div>)}
      {Object.values(values).some((value) => /^http:\/\//i.test(value)) ? <p className="field-note">HTTP sends credentials unencrypted. Use trusted HTTPS when possible; use HTTP only on a network you trust.</p> : null}
      <div className="settings-actions"><button type="submit" className="button primary" disabled={blocked || busy}>Apply settings</button></div>
      <p className="field-note">Apply saves immediately without connecting or controlling devices. Enable the plugin separately.</p>
    </form>}
  </details>;
}
