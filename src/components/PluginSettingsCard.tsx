import { canEnablePlugin, spotifyState } from "../lib/plugin";
import type { PluginError } from "../lib/plugin";
import type { PluginConsole } from "../lib/usePluginConsole";

export function PluginErrorNotice({ error }: { error: PluginError | null }) {
  if (!error) return null;
  return <div className="settings-error" role="alert">
    <p>{error.message} {error.code ? `(${error.code})` : ""}</p>
    <p>{error.hint}</p>
    {error.outcome === "unknown" ? <p>Outcome unknown: the action may already have happened. Check the application state before retrying. Nothing will be replayed.</p> : null}
  </div>;
}

export function PluginSettingsCard({ plugin }: { plugin: PluginConsole }) {
  const { snapshot, catalog } = plugin;
  const editing = !plugin.busy && snapshot.status !== "connected";
  const state = spotifyState(snapshot);
  const selected = catalog?.plugins.find((entry) => entry.id === plugin.selectedId && entry.status === "ready");
  const runtime = catalog?.node;
  const runtimeLine = !runtime ? "Runtime not checked." : runtime.status === "detected"
    ? `Detected Node ${runtime.version}.` : runtime.status === "unsupported"
      ? `Unsupported Node ${runtime.version}.` : "Node not found.";
  return <section className="settings-card plugin-settings" aria-labelledby="plugin-heading">
    <h2 id="plugin-heading">External plugin</h2>
    <p>Install a plugin folder once, then enable it here. An installed Node.js ≥22.18.0 runtime is required and detected automatically. The Spotify reference plugin requires macOS and Spotify desktop.</p>
    {!plugin.native ? <p>This browser stays preview-only. Manage plugins in the desktop app; previews never scan folders, launch a plugin or run its actions.</p> : <>
      <p className="obs-status" role="status" aria-live="polite">{runtimeLine}</p>
      {runtime && runtime.status !== "detected" ? <p>Install Node.js 22.18.0 or newer from nodejs.org or your package manager, then Refresh. The SDK and plugin folder do not bundle Node. No shell setup or executable paths are needed here.</p> : null}
      <p>Plugin folder: <code>~/.config/zdeck/plugins</code> (or the configured XDG location on Linux).</p>
      {catalog ? <details className="plugin-locations">
        <summary className="disclosure">Local folder and runtime details</summary>
        <p>Plugin folder: <code>{catalog.directory}</code></p>
        {runtime?.path ? <p>Detected runtime: <code>{runtime.path}</code></p> : null}
      </details> : null}
      <div className="settings-actions">
        <button type="button" className="button secondary" disabled={plugin.busy} onClick={() => void plugin.openDirectory()}>Open plugin folder</button>
        <button type="button" className="button secondary" disabled={plugin.busy} onClick={() => void plugin.refreshCatalog()}>Refresh</button>
      </div>
      {catalog?.plugins.length === 0 ? <p>Nothing installed yet. Copy the complete self-contained <code>spotify</code> folder from the release into this plugin folder, then Refresh. Keep its manifest.json, main.js and node_modules together. Do not copy only the source scripts.</p> : null}
      {catalog?.truncated ? <p className="settings-error" role="alert">The folder has more than 64 entries. Remove extras and Refresh before enabling a plugin.</p> : null}
      {catalog && catalog.plugins.length > 0 ? <>
        <ul aria-label="Installed plugins">{catalog.plugins.map((entry, index) => <li key={`${entry.id}-${index}`}>
          {entry.name} — {entry.status}{entry.version ? ` · ${entry.version}` : ""}{entry.message ? `: ${entry.message}` : ""}
        </li>)}</ul>
        <label className="field"><span>Plugin to enable</span>
          <select value={plugin.selectedId} disabled={!editing} onChange={(event) => plugin.selectPlugin(event.target.value)}>
            <option value="">Choose a ready plugin</option>
            {catalog.plugins.filter((entry) => entry.id).map((entry) => <option key={entry.id} value={entry.id} disabled={entry.status !== "ready"}>
              {entry.name} · {entry.version || entry.status}
            </option>)}
          </select>
        </label>
      </> : null}
      <label className="field plugin-trust">
        <span><input type="checkbox" checked={plugin.trusted} disabled={!editing || !selected} onChange={(event) => plugin.setTrusted(event.target.checked)} />{" "}
          I reviewed the source, origin and license of {selected ? `${selected.name} ${selected.version}` : "the selected plugin"}. I trust its code to access my user-level files, network and OS permissions. A separate process is not a sandbox.</span>
      </label>
      <div className="settings-actions">
        <button type="button" className="button primary" disabled={!editing || !canEnablePlugin(catalog, { pluginId: plugin.selectedId, trusted: plugin.trusted })} onClick={() => void plugin.enable()}>Enable plugin</button>
        <button type="button" className="button secondary" disabled={plugin.busy || snapshot.status !== "connected" || !!snapshot.lastError} onClick={() => void plugin.readState()}>Read state</button>
        <button type="button" className="button secondary" disabled={plugin.busy || snapshot.status === "disconnected"} onClick={() => void plugin.disconnect()}>Disconnect</button>
      </div>
      <p className="obs-status" role="status" aria-live="polite">{plugin.busy ? "Request pending…" : `Plugin ${snapshot.status}.`}</p>
      <p className="muted">One active plugin is supported. Disconnect before switching plugins. Enabling reads its description only, not media state. Nothing is automatically enabled, reconnected or polled; enabling and trust last only for this session. Refreshing, changing selection, disconnecting or an error clears trust.</p>
      {snapshot.manifest ? <>
        <p>Plugin: {snapshot.manifest.id} · version {snapshot.manifest.version} · protocol {snapshot.manifest.protocolVersion}</p>
        <ul>{snapshot.manifest.actions.map((action) => <li key={action.id}>{action.title} ({action.id})</li>)}</ul>
      </> : null}
      <p className="muted">Read state and Run may prompt for macOS Automation permission. Allow the actual launching app to control Spotify in Privacy &amp; Security → Automation. Read state is intentional, not a background refresh.</p>
      <p>State below is the last successful read, not live.</p>
      {state ? <dl>
        <dt>Title</dt><dd>{state.title ?? "No track"}</dd>
        <dt>Artist</dt><dd>{state.artist ?? "No artist"}</dd>
        <dt>Playback</dt><dd>{state.playback}</dd>
        <dt>Spotify volume</dt><dd>{state.volume}%</dd>
      </dl> : <p className="muted">No supported Spotify state has been read. Other plugin state is not displayed.</p>}
      <PluginErrorNotice error={plugin.catalogError} />
      <PluginErrorNotice error={snapshot.lastError} />
      {snapshot.status === "stopped" ? <p>Resolve the error and explicitly acknowledge trust to enable again. No action is automatically retried.</p> : null}
    </>}
  </section>;
}
