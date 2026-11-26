import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { EMPTY_PLUGIN, pluginEntry, pluginIdentifier, runtimeForPlugin, spotifyState, pluginChoices, trustAndEnablePlugin } from "../lib/plugin";
import { useDialogBackdrop } from "../lib/useDialogBackdrop";
import type { PluginCatalogEntry, PluginError } from "../lib/plugin";
import type { PluginConsole } from "../lib/usePluginConsole";
import { ActionIcon } from "./ActionIcon";
import { PluginConnectionSettings } from "./PluginConnectionSettings";

export function PluginErrorNotice({ error }: { error: PluginError | null }) {
  if (!error) return null;
  return <div className="settings-error" role="alert">
    <p>{error.message} {error.code ? `(${error.code})` : ""}</p><p>{error.hint}</p>
    {error.outcome === "unknown" ? <p>Outcome unknown: the action may already have happened. Inspect the application before retrying. Nothing will be replayed.</p> : null}
  </div>;
}

/** Plugin-identity thumbnail. Renders only a bounded embedded image data URL; never remote or markup. */
function PluginThumbnail({ icon }: { icon: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  return <span className="plugin-thumbnail" aria-hidden="true">
    {icon && icon !== failed
      ? <img src={icon} alt="" width={28} height={28} onError={() => setFailed(icon)} />
      : <ActionIcon kind="plugin" size={20} />}
  </span>;
}

function PluginRow({ entry, plugin }: { entry: PluginCatalogEntry; plugin: PluginConsole }) {
  const id = entry.id;
  const snapshot = pluginEntry(plugin.snapshots, id) ?? EMPTY_PLUGIN;
  const connected = snapshot.status === "connected";
  const busy = pluginEntry(plugin.busy, id) === true;
  const dialogRef = useRef<HTMLDialogElement>(null);
  useDialogBackdrop(dialogRef);
  const [confirmation, setConfirmation] = useState<"uninstall" | null>(null);
  // Frozen when the confirmation opens so a changed package cannot be trusted silently.
  const [trustIdentity, setTrustIdentity] = useState<string | null>(null);
  useEffect(() => { setConfirmation(null); setTrustIdentity(null); dialogRef.current?.close(); }, [plugin.catalogEpoch, pluginEntry(plugin.trustEpoch, id)]);
  const reason = entry.status !== "ready" ? "Fix this installation before enabling. Diagnostics are available in the row menu."
    : runtimeForPlugin(plugin.catalog, entry)?.status !== "detected" ? entry.runtime === "python" ? "Python 3.10 or newer is required." : "Node.js 22.18.0 or newer is required."
      : !plugin.sessionsReady ? "Cached plugin sessions are unavailable. Reload the app before enabling."
        : null;
  const state = spotifyState(snapshot);
  const diagnostics = pluginEntry(plugin.diagnostics, id);
  return <li className="plugin-row" data-plugin-id={id} aria-busy={busy || undefined}>
    <div className="plugin-row-header">
      <PluginThumbnail icon={entry.icon} />
      <div className="plugin-row-copy">
        <h3>{entry.name}</h3><p className="plugin-metadata">{id || "Invalid folder ID"} · {entry.version || "Unknown version"} · protocol {entry.protocolVersion}</p>
        <p className="plugin-row-status" role="status">{busy ? "Request pending…" : connected ? "Enabled" : snapshot.status === "stopped" ? "Stopped" : "Disabled"} · {entry.status}</p>
        {entry.message ? <p className="field-note">{entry.message}</p> : null}
        {reason && !connected ? <p className="field-note">{reason}</p> : null}
        <PluginErrorNotice error={pluginEntry(plugin.errors, id) ?? snapshot.lastError} />
      </div>
      <div className="plugin-row-actions">
        <button type="button" className={`button ${connected ? "secondary" : "primary"}`} disabled={busy || plugin.loading || (!connected && (!!reason || plugin.catalogBusy))}
          aria-label={`${connected ? "Disable" : "Enable"} ${entry.name}`}
          onClick={() => {
            if (connected) void plugin.disconnect(id);
            else if (entry.trusted) void plugin.enable(id);
            else { setTrustIdentity(entry.identity); dialogRef.current?.showModal(); }
          }}>{connected ? "Disable" : "Enable"}</button>
        <details className="plugin-menu">
          <summary className="icon-button" aria-label={`More options for ${entry.name}`} title="More options">⋯</summary>
          <div className="plugin-menu-actions">
            {!connected ? <button type="button" className="button quiet" disabled={busy || plugin.loading || !pluginIdentifier(id)} onClick={(event) => {
              event.currentTarget.closest("details")?.removeAttribute("open"); void plugin.disconnect(id);
            }}>Disable on next launch</button> : null}
            <button type="button" className="button quiet" disabled={busy || plugin.loading || !pluginIdentifier(id)} onClick={(event) => {
              event.currentTarget.closest("details")?.removeAttribute("open"); void plugin.diagnose(id);
            }}>Diagnostics</button>
            <button type="button" className="button quiet" disabled={busy || plugin.loading || !pluginIdentifier(id)} onClick={(event) => {
              event.currentTarget.closest("details")?.removeAttribute("open"); setConfirmation("uninstall");
            }}>Uninstall…</button>
          </div>
        </details>
      </div>
    </div>
    {entry.settings ? <PluginConnectionSettings key={`${id}:${entry.identity}:${entry.trusted}:${connected}`} id={id} schema={entry.settings} trusted={entry.trusted} connected={connected} /> : null}
    <dialog ref={dialogRef} className="dialog plugin-dialog" aria-labelledby={`plugin-trust-${id || "invalid"}`} onClose={() => setConfirmation(null)}>
      <div className="dialog-heading">
        <h2 id={`plugin-trust-${id || "invalid"}`}>Enable {entry.name}?</h2>
        <button type="button" className="icon-button" aria-label={`Close trust confirmation for ${entry.name}`} onClick={() => dialogRef.current?.close()}><X size={16} aria-hidden="true" /></button>
      </div>
      <p>{entry.name} {entry.version} runs as a separate local process, but process separation is not a sandbox. It can access your user-level files, network and OS permissions. Enable it only if you reviewed its source, origin and license.</p>
      <p className="field-note">Trust is remembered for this exact installed package. Changing its files revokes trust and asks again.</p>
      <div className="settings-actions">
        <button type="button" className="button primary" disabled={busy || plugin.catalogBusy || !!reason || !trustIdentity}
          onClick={() => { dialogRef.current?.close(); if (trustIdentity) void (entry.settings ? plugin.trust(id, trustIdentity) : trustAndEnablePlugin(plugin, id, trustIdentity)); }}>{entry.settings ? "Trust package" : "Trust and enable"}</button>
        <button type="button" className="button secondary" onClick={() => dialogRef.current?.close()}>Cancel</button>
      </div>
    </dialog>
    {confirmation === "uninstall" ? <div className="plugin-confirm" role="group" aria-label={`Uninstall ${entry.name}`}>
      <p>Uninstall {entry.name}? This stops only this plugin and removes its folder from the catalog. The folder is moved to <code>~/.config/zdeck/plugin-backups</code> for recovery, not permanently deleted. Saved buttons remain but cannot run until the plugin is restored and explicitly enabled.</p>
      {entry.settings && Object.values(entry.settings).some((field) => field.type === "secret") ? <p>Saved credentials are not removed by uninstall. Cancel and use Forget in Connection settings first if you want to remove them. Revoke the token at its provider separately.</p> : null}
      <div className="settings-actions"><button type="button" className="button danger" disabled={busy} onClick={() => { setConfirmation(null); void plugin.uninstall(id); }}>Confirm uninstall</button>
        <button type="button" className="button secondary" onClick={() => setConfirmation(null)}>Cancel</button></div>
    </div> : null}
    {diagnostics ? <section className="plugin-diagnostics" aria-label={`Diagnostics for ${entry.name}`} role="status">
      <h4>Installation diagnostics</h4><p className="field-note">Local checks only; no plugin code or media state was read.</p>
      <ul>{diagnostics.checks.map((check, index) => <li key={index}><strong>{check.name} · {check.status}</strong><p>{check.message}</p></li>)}</ul>
    </section> : null}
    {snapshot.manifest ? <details className="plugin-state"><summary className="disclosure">Actions and last read state</summary>
      <div className="plugin-state-content">
        <section className="plugin-state-section" aria-label={`Available actions for ${entry.name}`}>
          <h4>Available actions</h4>
          <ul className="plugin-action-list">{snapshot.manifest.actions.map((action) => <li key={action.id}>
            <span>{action.title}</span><code>{action.id}</code>
          </li>)}</ul>
        </section>
        <section className="plugin-state-section" aria-label={`Last read state for ${entry.name}`}>
          <h4>Last read state</h4>
          <p className="field-note">Last successful read, not live. No background polling.</p>
          {state ? <dl className="plugin-state-values"><dt>Title</dt><dd>{state.title ?? "No track"}</dd><dt>Artist</dt><dd>{state.artist ?? "No artist"}</dd><dt>Playback</dt><dd>{state.playback}</dd><dt>Spotify volume</dt><dd>{state.volume}%</dd></dl>
            : <p className="field-note">{snapshot.state ? "State read. Selections below show the last observed values, not live device state." : "No state has been read. Read state to discover available selections."}</p>}
          {snapshot.manifest.actions.flatMap((action) => Object.values(action.config)).filter((field, index, fields) => field.type === "integer" && field.choicesKey
            && fields.findIndex((other) => other.type === "integer" && other.choicesKey === field.choicesKey) === index).map((field, index) => {
            const choices = pluginChoices(snapshot, field);
            return choices ? <ul key={index} className="plugin-action-list">{choices.map((choice) => <li key={choice.value}>{choice.label}{!choice.available ? " — unavailable" : ""}</li>)}</ul> : null;
          })}
          <div className="plugin-read-control">
            <button type="button" className="button secondary" disabled={busy || !connected || !!snapshot.lastError} onClick={() => void plugin.readState(id)}>Read state</button>
            <p className="field-note">{id === "spotify" ? "May prompt for macOS Automation permission." : "Reads the configured integration. No actions are sent and nothing is retried."}</p>
          </div>
          <details className="settings-help"><summary className="disclosure">About state reads</summary>
            <p>Only supported state and declared selection lists are displayed. Arbitrary plugin state is not dumped. Read state explicitly to update the values above.</p>
          </details>
        </section>
      </div>
    </details> : null}
  </li>;
}
export function PluginSettingsCard({ plugin }: { plugin: PluginConsole }) {
  const runtime = plugin.catalog?.node;
  const python = plugin.catalog?.python;
  const entries = [...(plugin.catalog?.plugins ?? [])];
  // Keep an enabled/failed cached session manageable even if its folder disappeared.
  for (const [id, snapshot] of Object.entries(plugin.snapshots)) {
    if (snapshot.status !== "disconnected" && !entries.some((entry) => entry.id === id)) entries.push({ id, name: id,
      version: snapshot.manifest?.version ?? "", protocolVersion: snapshot.manifest?.protocolVersion ?? 0, status: "invalid",
      icon: snapshot.manifest?.icon ?? null, trusted: false, identity: null,
      message: "Folder is not in the current catalog. Disable this session or restore the complete packaged folder before enabling again." });
  }
  return <section className="settings-card plugin-settings" aria-labelledby="plugin-heading">
    <h2 id="plugin-heading">External plugins</h2>
    <p>Install complete plugin folders, then trust and enable each plugin explicitly.</p>
    <details className="settings-help"><summary className="disclosure">Requirements and startup behavior</summary>
      <p>Node.js ≥22.18.0 and Python ≥3.10 are detected automatically. Each plugin needs only its own runtime. The Spotify reference requires macOS and Spotify desktop.</p>
      <p>Trust is saved in local app settings for each exact installed package and survives restarts; changing its files revokes trust. Enabled preferences survive restarts for that exact trusted package. Native startup attempts to restore each saved plugin once, without reading state, running actions or retrying. Disable or uninstall turns off restoration. Use a row’s menu for diagnostics or reversible uninstall.</p>
    </details>
    {!plugin.native ? <p>This browser stays preview-only. Previews never scan folders, launch plugins or run actions.</p> : <>
      <p className="obs-status" role="status">{!runtime ? "Runtime not checked." : runtime.status === "detected" ? `Detected Node ${runtime.version}.` : runtime.status === "unsupported" ? `Unsupported Node ${runtime.version}. JavaScript/TypeScript plugins require Node.js 22.18.0 or newer.` : "Node not found. Only JavaScript/TypeScript plugins require Node.js 22.18.0 or newer."}</p>
      {python ? <p className="obs-status" role="status">{python.status === "detected" ? `Detected Python ${python.version}.` : python.status === "unsupported" ? `Unsupported Python ${python.version}. Install Python 3.10 or newer for Python plugins.` : "Python not found. Python plugins require Python 3.10 or newer, then Refresh."}</p> : null}
      <details className="plugin-locations settings-help"><summary className="disclosure">Local folder and runtime details</summary>
        <p>Plugin folder: <code>{plugin.catalog?.directory ?? "~/.config/zdeck/plugins"}</code></p>{runtime?.path ? <p>Node runtime: <code>{runtime.path}</code></p> : null}{python?.path ? <p>Python runtime: <code>{python.path}</code></p> : null}
      </details>
      <div className="settings-actions"><button type="button" className="button secondary" disabled={plugin.catalogBusy} onClick={() => void plugin.openDirectory()}>Open plugin folder</button>
        <button type="button" className="button secondary" disabled={plugin.catalogBusy} onClick={() => void plugin.refreshCatalog()}>Refresh</button></div>
      {!plugin.sessionsReady && !plugin.loading ? <p className="settings-error" role="alert">Cached plugin sessions could not be loaded. Reload the app before enabling plugins.</p> : null}
      {plugin.catalog?.plugins.length === 0 && entries.length === 0 ? <p>Nothing installed yet. Copy the complete self-contained packaged folder, including manifest.json and either main.js with its dependencies or main.py with zdeck_plugin_sdk, into the plugin folder, then Refresh. Source/developer npm layouts and SDK symlinks are not distribution installs.</p> : null}
      <ul className="plugin-list" aria-label="Installed plugins">{entries.map((entry, index) => <PluginRow key={entry.id || `invalid-${index}`} entry={entry} plugin={plugin} />)}</ul>
      <PluginErrorNotice error={plugin.catalogError} />
    </>}
  </section>;
}
