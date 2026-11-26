import { compatiblePresentations, effectivePresentation } from "../lib/presentations";
import type { Presentation } from "../lib/types";
import { useState } from "react";
import type { ReactNode } from "react";
import { ChevronDown, Trash2 } from "lucide-react";
import { ActionIcon } from "./ActionIcon";
import { isSpan, MAX_COLUMN_SPAN, MAX_ROW_SPAN } from "../lib/deck";
import { ACTION_CATALOG, clampVolume } from "../lib/actions";
import { IconPicker } from "./IconPicker";
import { canRunPlugin, enabledPluginManifests, EMPTY_PLUGIN, pluginControlAction, pluginDefaults, pluginEntry } from "../lib/plugin";
import type { PluginControl } from "../lib/types";
import type { PluginConsole } from "../lib/usePluginConsole";
import { PluginErrorNotice } from "./PluginSettingsCard";
import type { ActionKind, Control, ControlPatch } from "../lib/types";
import type { ObsConsole, SceneSwitchFeedback } from "../lib/useObsConsole";
import { formatPercent } from "../lib/useSystemConsole";
import { useMediaPermission } from "../lib/useMediaPermission";
import type { ApplyFeedback, SystemConsole } from "../lib/useSystemConsole";

interface InspectorProps {
  control: Control | null;
  pageName: string;
  previewVolume: number;
  obs: ObsConsole;
  system: SystemConsole;
  plugin: PluginConsole;
  onPatch: (patch: ControlPatch) => void;
  onRemove: () => void;
  onPreviewPress: () => void;
  onPreviewVolume: (value: number) => void;
}

function isSystemAction(kind: ActionKind): boolean {
  return kind === "mic-mute" || kind === "media-play-pause" || kind === "volume";
}

function observedLine(observedAtMs: number | null | undefined): string {
  return observedAtMs ? `checked ${new Date(observedAtMs).toLocaleTimeString()}` : "not checked";
}

function NativeStatus({ feedback, error }: { feedback: ApplyFeedback | null; error: string | null }) {
  return (
    <>
      {feedback ? (
        <p className={`native-feedback is-${feedback.state}`} role="status" aria-live="polite">
          {feedback.message}
        </p>
      ) : null}
      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}

function MediaPermissionGate({ children }: { children: ReactNode }) {
  const { permission, error, busy, refresh, openSettings } = useMediaPermission();
  const missing = permission?.platform === "macos" && permission.status === "required";
  if (missing) return <div className="media-permission-setup">
    <p className="field-note">Allow zDeck to control playback.</p>
    <button type="button" className="button primary" disabled={busy}
      onClick={() => void openSettings()}>Open System Settings</button>
    {error ? <p className="settings-error" role="alert">{error}</p> : null}
  </div>;
  return <>{children}{error ? <div className="native-control">
    <p className="settings-error" role="alert">{error}</p>
    <button type="button" className="button secondary" disabled={busy}
      onClick={() => void refresh()}>Check permission</button>
  </div> : null}</>;
}

function switchFeedbackText(
  feedback: SceneSwitchFeedback,
  current: string | null,
): string {
  switch (feedback.state) {
    case "confirmed":
      return `Confirmed: OBS is on “${feedback.scene}”.`;
    case "not_applied":
      return `Not applied: OBS reports “${current ?? "unknown"}”.`;
    case "failed":
      return "Scene switch failed.";
    case "unknown":
      return "Result unknown. Check OBS before retrying.";
  }
}

function PluginControlEditor({ control, plugin, onPatch }: { control: PluginControl; plugin: PluginConsole; onPatch: (patch: ControlPatch) => void }) {
  const snapshot = pluginEntry(plugin.snapshots, control.pluginId) ?? EMPTY_PLUGIN;
  const busy = pluginEntry(plugin.busy, control.pluginId) === true;
  const action = pluginControlAction(snapshot, control);
  const [drafts, setDrafts] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(control.pluginArgs).map(([key, n]) => [key, String(n)])));
  const validDraft = action && Object.entries(action.config).every(([key, field]) => field.type === "boolean"
    ? ["true", "false"].includes(drafts[key]) : drafts[key]?.trim()
      && Number.isSafeInteger(Number(drafts[key])) && Number(drafts[key]) >= field.minimum && Number(drafts[key]) <= field.maximum
      && (!field.control || (Number(drafts[key]) - field.minimum) % field.control.step === 0));
  return <div className="native-control">
    <p>{control.pluginId} · {control.pluginAction}</p>
    {action ? Object.entries(action.config).map(([key, field]) => field.type === "boolean" ? <label className="field" key={key}>
      <span>{key}</span><select value={drafts[key] ?? "false"} disabled={busy} onChange={(event) => {
        const text = event.target.value; setDrafts((current) => ({ ...current, [key]: text }));
        onPatch({ pluginArgs: { ...control.pluginArgs, [key]: text === "true" } });
      }}><option value="false">Off</option><option value="true">On</option></select>
    </label> : <label className="field" key={key}>
      <span>{key} ({field.minimum}–{field.maximum})</span>
      <input type="number" step={field.control?.step ?? 1} min={field.minimum} max={field.maximum} value={drafts[key] ?? ""}
        aria-invalid={!drafts[key]?.trim() || !Number.isSafeInteger(Number(drafts[key])) || Number(drafts[key]) < field.minimum || Number(drafts[key]) > field.maximum
          || !!field.control && (Number(drafts[key]) - field.minimum) % field.control.step !== 0}
        disabled={busy} onChange={(event) => {
          const text = event.target.value;
          setDrafts((current) => ({ ...current, [key]: text }));
          if (text.trim() && Number.isSafeInteger(Number(text))) onPatch({ pluginArgs: { ...control.pluginArgs, [key]: Number(text) } });
        }} />
    </label>) : <p className="field-note">Connect the matching plugin in Settings to configure and run this saved action.</p>}
    {action ? <button type="button" className="button secondary" disabled={busy} onClick={() => {
      const args = pluginDefaults(action);
      setDrafts(Object.fromEntries(Object.entries(args).map(([key, n]) => [key, String(n)])));
      onPatch({ pluginArgs: args });
    }}>Use declared defaults</button> : null}
    <div className="native-actions"><button type="button" className="button primary"
      disabled={!plugin.native || busy || !validDraft || !canRunPlugin(snapshot, control)}
      onClick={() => void plugin.execute(control)}>{busy ? "Request pending…" : "Run plugin action"}</button></div>
    <p className="field-note">Runs on this computer. Preview never runs the plugin. No automatic retry.</p>
    {plugin.completedIds[control.pluginId] === control.id ? <p className="native-feedback is-confirmed" role="status">Command completed and state read back. This is not live state.</p> : null}
    {action && (!validDraft || !canRunPlugin(snapshot, control)) ? <p className="field-note">Run requires a connected matching manifest and every required value within its declared contract.</p> : null}
    <PluginErrorNotice error={pluginEntry(plugin.errors, control.pluginId) ?? snapshot.lastError} />
  </div>;
}

export function Inspector({
  control,
  pageName,
  previewVolume,
  obs,
  system,
  plugin,
  onPatch,
  onRemove,
  onPreviewPress,
  onPreviewVolume,
}: InspectorProps) {
  const obsActive = obs.native && obs.status === "connected";
  const systemNative = system.native;
  const obsScene = control?.action === "obs-scene" ? control.scene : null;
  const obsPending = obsActive && obs.pendingScene !== null && obs.pendingScene === obsScene;
  const obsFeedback =
    obs.native && obsScene !== null && obs.lastSwitch?.scene === obsScene
      ? obs.lastSwitch
      : null;

  return (
    <details className="panel" open>
      <summary className="panel-head">
        <span>Selected control</span>
        <span className="panel-hint">{control ? control.label : "No selection"}</span>
      </summary>
      <div className="panel-body">
        {!control ? (
          <div className="empty-note">
            <p>Select a key on {pageName}.</p>
            <p>Its settings appear here.</p>
          </div>
        ) : (
          <form className="inspector-form" onSubmit={(event) => event.preventDefault()}>
            <details className="inspector-section" open>
              <summary className="disclosure">Appearance</summary>
              <div className="inspector-section-body">
            <label className="field">
              <span>{control.action === "obs-scene" ? "Custom label (optional)" : "Label"}</span>
              <input
                key={`${control.id}-${control.action}-${control.label}-label`}
                type="text"
                defaultValue={control.action === "obs-scene" && control.autoLabel ? "" : control.label}
                placeholder={control.action === "obs-scene" ? control.scene : undefined}
                maxLength={40}
                onBlur={(event) => {
                  const label = event.currentTarget.value.trim();
                  if (!label && control.action !== "obs-scene") {
                    event.currentTarget.value = control.label;
                    return;
                  }
                  event.currentTarget.value = label;
                  onPatch({ label });
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                  if (event.key === "Escape") {
                    event.currentTarget.value = control.action === "obs-scene" && control.autoLabel ? "" : control.label;
                    event.currentTarget.blur();
                  }
                }}
              />
            </label>

            <details className="icon-picker action-picker">
              <summary><span>Action</span>
                <span className="icon-picker-status">{control.action === "plugin" ? control.pluginId : ACTION_CATALOG.find((action) => action.kind === control.action)?.name}</span>
                <ChevronDown className="icon-picker-toggle" size={16} aria-hidden="true" />
              </summary>
              <div className="icon-picker-body" role="group" aria-label="Choose action">
                {ACTION_CATALOG.map((action) => <button type="button" key={action.kind} aria-pressed={control.action === action.kind}
                  onClick={(event) => {
                    onPatch({ action: action.kind });
                    const details = event.currentTarget.closest("details")!;
                    details.open = false;
                    details.querySelector("summary")?.focus();
                  }}><ActionIcon kind={action.kind} size={18} />{action.name}</button>)}
              </div>
            </details>

            <label className="field"><span>Presentation</span>
              <select value={effectivePresentation(control, plugin.snapshots)} onChange={(event) => onPatch({ presentation: event.target.value as Presentation })}>
                {compatiblePresentations(control, plugin.snapshots).map((value) => <option key={value} value={value}>
                  {{ button: "Button", slider: "Slider", dial: "Dial", "toggle-switch": "Toggle switch", "toggle-button": "Toggle button" }[value]}
                </option>)}
              </select>
            </label>
            <IconPicker key={control.id} control={control} manifests={enabledPluginManifests(plugin.snapshots)} onPatch={onPatch} />

              </div>
            </details>
            <details className="inspector-section" open>
              <summary className="disclosure">Layout</summary>
              <div className="inspector-section-body span-fields">
                {([['columnSpan', 'Width', MAX_COLUMN_SPAN], ['rowSpan', 'Height', MAX_ROW_SPAN]] as const).map(([key, label, maximum]) =>
                  <label className="field" key={key}><span>{label}</span><input type="number" min={1} max={maximum} step={1}
                    key={`${control.id}-${key}`} defaultValue={control[key] ?? 1}
                    onChange={(event) => {
                      const value = Number(event.currentTarget.value);
                      if (isSpan(value, maximum)) onPatch({ [key]: value });
                    }}
                    onBlur={(event) => {
                      event.currentTarget.value = String(control[key] ?? 1);
                    }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} /></label>)}
              </div>
            </details>
            <details className="inspector-section" open>
              <summary className="disclosure">Action settings</summary>
              <div className="inspector-section-body">
            {control.action === "plugin" ? <PluginControlEditor
              key={`${control.id}-${control.pluginId}-${control.pluginAction}-${JSON.stringify(pluginControlAction(pluginEntry(plugin.snapshots, control.pluginId) ?? EMPTY_PLUGIN, control)?.config)}`}
              control={control} plugin={plugin} onPatch={onPatch} /> : null}

            {control.action === "obs-scene" ? (
              <label className="field">
                <span>Scene</span>
                {obsActive ? (
                  <select
                    value={control.scene}
                    disabled={obsPending}
                    onChange={(event) => onPatch({ scene: event.target.value })}
                  >
                    {obs.scenes.includes(control.scene) ? null : (
                      <option value={control.scene}>
                        {control.scene} (not in OBS)
                      </option>
                    )}
                    {obs.scenes.map((scene) => (
                      <option key={scene} value={scene}>
                        {scene}
                        {scene === obs.currentScene ? " · live" : ""}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    key={`${control.id}-${control.scene}-scene`}
                    type="text"
                    defaultValue={control.scene}
                    maxLength={40}
                    onBlur={(event) => {
                      const scene = event.currentTarget.value.trim();
                      if (!scene) {
                        event.currentTarget.value = control.scene;
                        return;
                      }
                      event.currentTarget.value = scene;
                      onPatch({ scene });
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                      if (event.key === "Escape") {
                        event.currentTarget.value = control.scene;
                        event.currentTarget.blur();
                      }
                    }}
                  />
                )}
              </label>
            ) : null}

            {control.action === "obs-scene" ? (
              obsActive || obsFeedback ? (
                <p
                  className={`obs-switch${obsFeedback ? ` is-${obsFeedback.state}` : ""}`}
                  role="status"
                  aria-live="polite"
                >
                  {obsPending
                    ? `Switching to “${control.scene}”…`
                    : obsFeedback
                      ? switchFeedbackText(obsFeedback, obs.currentScene)
                      : `OBS is connected. Run scene switches program output to “${control.scene}”.`}
                </p>
              ) : (
                <p className="field-note">
                  {obs.native ? "Connect OBS in Settings to run this scene." : "OBS runs in the desktop app."}
                </p>
              )
            ) : null}

            {control.action === "volume" ? (
              <>
                <label className="field">
                  <span>Default volume</span>
                  <input
                    key={`${control.id}-${control.volume}-default-volume`}
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    defaultValue={control.volume}
                    onBlur={(event) => {
                      if (event.currentTarget.value.trim() === "") {
                        event.currentTarget.value = String(control.volume);
                        return;
                      }
                      const value = Number(event.currentTarget.value);
                      if (!Number.isFinite(value)) {
                        event.currentTarget.value = String(control.volume);
                        return;
                      }
                      const clamped = clampVolume(value);
                      event.currentTarget.value = String(clamped);
                      onPatch({ volume: clamped });
                    }}
                  />
                </label>
                {systemNative ? (
                  <div className="native-control">
                    <p className="native-state">
                      Current output:{" "}
                      {system.output
                        ? `${formatPercent(system.output.volumePercent)}${
                            system.output.muted ? " · muted" : ""
                          }`
                        : "unknown"}{" "}
                      · {observedLine(system.output?.observedAtMs)}
                    </p>
                    <label className="field">
                      <span>Target output ({system.outputTarget}%)</span>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={1}
                        value={system.outputTarget}
                        onChange={(event) => system.setOutputTarget(Number(event.target.value))}
                      />
                    </label>
                    <div className="native-actions">
                      <button
                        type="button"
                        className="button primary"
                        onClick={() => void system.applyOutput()}
                        disabled={system.outputPending || system.output === null}
                      >
                        {system.outputPending ? "Applying…" : `Apply ${system.outputTarget}%`}
                      </button>
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => void system.refreshOutput()}
                        disabled={system.outputRefreshing || system.outputPending}
                      >
                        Refresh
                      </button>
                    </div>
                    <NativeStatus feedback={system.outputFeedback} error={system.outputError} />
                  </div>
                ) : (
                  <label className="field">
                    <span>Preview volume</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={previewVolume}
                      onChange={(event) => onPreviewVolume(Number(event.target.value))}
                    />
                  </label>
                )}
              </>
            ) : null}

            {control.action === "mic-mute" ? (
              systemNative ? (
                <div className="native-control">
                  <p className="native-state">
                    Default system input (not an OBS input):{" "}
                    {system.microphone
                      ? system.microphone.muted
                        ? "muted"
                        : "live"
                      : "unknown"}{" "}
                    · {observedLine(system.microphone?.observedAtMs)}
                  </p>
                  <div className="native-actions">
                    <button
                      type="button"
                      className="button primary"
                      onClick={() => void system.toggleMicrophone()}
                      disabled={system.microphonePending || system.microphone === null}
                    >
                      {system.microphonePending
                        ? "Applying…"
                        : system.microphone?.muted
                          ? "Unmute"
                          : "Mute"}
                    </button>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => void system.refreshMicrophone()}
                      disabled={system.microphoneRefreshing || system.microphonePending}
                    >
                      Refresh
                    </button>
                  </div>
                  <NativeStatus
                    feedback={system.microphoneFeedback}
                    error={system.microphoneError}
                  />
                  <p className="field-note">
                    macOS devices without native mute use zero input level with saved-level restore,
                    not a hardware privacy switch. Unmute restores this device’s saved levels, even after restart.
                    If you switch inputs while muted, switch back and unmute to restore the previous device.
                  </p>
                </div>
              ) : (
                <p className="field-note">
                  Default system input, not an OBS source.
                </p>
              )
            ) : null}

            {control.action === "media-play-pause" ? (
              systemNative ? (
                <MediaPermissionGate key={control.id}>
                  <div className="native-control">
                    <p className="native-state">
                      System media: {system.media ? system.media.status : "unknown"} ·{" "}
                      {observedLine(system.media?.observedAtMs)}
                    </p>
                    <div className="native-actions">
                      <button
                        type="button"
                        className="button primary"
                        onClick={() => void system.runMedia()}
                        disabled={system.mediaPending || system.media === null}
                      >
                        {system.mediaPending
                          ? "Sending…"
                          : system.media?.status === "playing"
                            ? "Pause"
                            : system.media?.status === "unknown"
                              ? "Play / pause"
                              : "Play"}
                      </button>
                      <button
                        type="button"
                        className="button secondary"
                        onClick={() => void system.refreshMedia()}
                        disabled={system.mediaRefreshing || system.mediaPending}
                      >
                        Refresh
                      </button>
                    </div>
                    <NativeStatus feedback={system.mediaFeedback} error={system.mediaError} />
                  </div>
                </MediaPermissionGate>
              ) : (
                <p className="field-note">
                  System play/pause in the desktop app (default MPRIS player on Linux).
                </p>
              )
            ) : null}

            <div className="inspector-actions">
              {control.action !== "volume" ? (
                control.action === "obs-scene" && obsActive ? (
                  <button
                    type="button"
                    className="button primary"
                    onClick={() => void obs.runScene(control.scene)}
                    disabled={obsPending}
                  >
                    {obsPending ? "Switching…" : "Run scene"}
                  </button>
                ) : systemNative && isSystemAction(control.action) ? null : (
                  <button
                    type="button"
                    className="button primary"
                    onClick={onPreviewPress}
                  >
                    Preview press
                  </button>
                )
              ) : null}
              <button
                type="button"
                className="button danger"
                onClick={onRemove}
                aria-label={`Remove ${control.label}`}
              >
                <Trash2 size={15} aria-hidden="true" />
                Remove
              </button>
            </div>

            {(control.action === "obs-scene" && obsActive) || (systemNative && isSystemAction(control.action)) ? (
              <p className="preview-note">Runs on this computer.</p>
            ) : null}
              </div>
            </details>
          </form>
        )}
      </div>
    </details>
  );
}
