import { compatiblePresentations, effectivePresentation, controlContract } from "../lib/presentations";
import type { Presentation } from "../lib/types";
import { useState } from "react";
import type { ReactNode } from "react";
import { ChevronDown, Trash2 } from "lucide-react";
import { ActionIcon } from "./ActionIcon";
import { Dropdown } from "./Dropdown";
import { isSpan, MAX_COLUMN_SPAN, MAX_ROW_SPAN } from "../lib/deck";
import { ACTION_CATALOG, clampVolume } from "../lib/actions";
import { IconPicker } from "./IconPicker";
import { canRunPlugin, enabledPluginManifests, EMPTY_PLUGIN, pluginControlAction, pluginEntry, pluginChoices, pluginValue } from "../lib/plugin";
import type { PluginControl } from "../lib/types";
import type { PluginConsole } from "../lib/usePluginConsole";
import { HelpTooltip } from "./HelpTooltip";
import { PluginErrorNotice } from "./PluginSettingsCard";
import type { ActionKind, Control, ControlPatch } from "../lib/types";
import type { ObsConsole, SceneSwitchFeedback } from "../lib/useObsConsole";
import { formatPercent } from "../lib/useSystemConsole";
import { useMediaPermission } from "../lib/useMediaPermission";
import type { ApplyFeedback, SystemConsole } from "../lib/useSystemConsole";

const PRESENTATION_LABELS: Record<Presentation, string> = {
  button: "Button", slider: "Slider", dial: "Dial", "toggle-switch": "Toggle switch", "toggle-button": "Toggle button", value: "Value",
};

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
  return observedAtMs ? `checked ${new Date(observedAtMs).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "not checked";
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
  const contract = controlContract(control, plugin.snapshots);
  const toggle = control.presentation?.startsWith("toggle-") === true;
  const observed = contract?.kind === "boolean" ? contract.value : null;
  const [drafts, setDrafts] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(control.pluginArgs).map(([key, n]) => [key, String(n)])));
  const validDraft = action && Object.entries(action.config).every(([key, field]) => field.type === "boolean"
    ? ["true", "false"].includes(drafts[key]) : drafts[key]?.trim()
      && Number.isSafeInteger(Number(drafts[key])) && Number(drafts[key]) >= field.minimum && Number(drafts[key]) <= field.maximum
      && (!field.control || (Number(drafts[key]) - field.minimum) % field.control.step === 0));
  return <div className="native-control">
    {action && Object.values(action.config).some((field) => field.type === "integer" && field.choicesKey) ? <div className="plugin-read-control">
      <button type="button" className="button secondary" disabled={busy || snapshot.status !== "connected" || !!snapshot.lastError} onClick={() => void plugin.readState(control.pluginId)}>Refresh entities</button>
      <HelpTooltip label="About entity readings">Readings are snapshots, not live. Refresh to observe this integration again. Saved bindings use the entity ID and instance, never list order.</HelpTooltip>
    </div> : null}
    {action ? Object.entries(action.config).map(([key, field]) => field.type === "boolean" ? field.control && control.presentation?.startsWith("toggle-") ? null : <Dropdown key={key} label={field.control ? "On press" : key}
      value={drafts[key] ?? "false"}
      options={[...(field.control ? [{ value: "toggle", label: "Toggle" }] : []), { value: "true", label: "Turn on" }, { value: "false", label: "Turn off" }]} disabled={busy} onChange={(text) => {
        if (text === "toggle") onPatch({ presentation: "toggle-switch" });
        else {
          setDrafts((current) => ({ ...current, [key]: text }));
          onPatch({ ...(field.control ? { presentation: "button" as const } : {}), pluginArgs: { ...control.pluginArgs, [key]: text === "true" } });
        }
      }} /> : field.choicesKey ? <Dropdown key={key} label={key === "entity" ? "Entity" : key} value={drafts[key] ?? ""}
        options={(() => {
          const choices = pluginChoices(snapshot, field) ?? [];
          const options = choices.map((choice) => ({ value: String(choice.value), label: choice.label + (choice.available ? "" : " — unavailable"), description: choice.description }));
          return options.some((choice) => choice.value === drafts[key]) ? options
            : [{ value: drafts[key] ?? "", label: "Select an entity (saved selection missing)" }, ...options];
        })()} disabled={busy || snapshot.status !== "connected"} onChange={(text) => {
          setDrafts((current) => ({ ...current, [key]: text }));
          onPatch({ pluginArgs: { ...control.pluginArgs, [key]: Number(text) } });
        }} /> : <label className="field" key={key}>
      <span>{key} ({field.minimum}–{field.maximum})</span>
      <input type="number" step={field.control?.step ?? 1} min={field.minimum} max={field.maximum} value={drafts[key] ?? ""}
        aria-invalid={!drafts[key]?.trim() || !Number.isSafeInteger(Number(drafts[key])) || Number(drafts[key]) < field.minimum || Number(drafts[key]) > field.maximum
          || !!field.control && (Number(drafts[key]) - field.minimum) % field.control.step !== 0}
        disabled={busy} onChange={(event) => {
          const text = event.target.value;
          setDrafts((current) => ({ ...current, [key]: text }));
          if (text.trim() && Number.isSafeInteger(Number(text))) onPatch({ pluginArgs: { ...control.pluginArgs, [key]: Number(text) } });
        }} />
    </label>) : <p className="field-note">Connect the matching plugin in Settings to configure this control.</p>}
    {action ? Object.entries(action.config).flatMap(([key, field]) => {
      const selected = pluginChoices(snapshot, field)?.find((choice) => choice.value === control.pluginArgs[key]);
      return selected ? [<details className="binding-details" key={key}><summary>Entity details</summary><p>{selected.label}</p>{selected.description ? <p>{selected.description}</p> : null}</details>] : [];
    }) : null}
    {control.presentation === "value" ? <p className="native-state">{(() => {
      const reading = pluginValue(snapshot, control);
      return `${reading?.value == null ? "Unknown / unavailable" : typeof reading.value === "boolean" ? reading.value ? "On" : "Off" : `${reading.value} ${reading.unit}`} · ${observedLine(reading?.observedAtMs)}`;
    })()}</p> : <div className="native-actions"><button type="button" className={toggle ? `tile-toggle ${control.presentation}` : "button primary"}
      disabled={!plugin.native || busy || !validDraft || !canRunPlugin(snapshot, control) || toggle && observed === null}
      aria-label={toggle ? `${control.label}${observed === null ? " — state unknown" : ""}` : undefined}
      role={toggle && control.presentation === "toggle-switch" && observed !== null ? "switch" : undefined}
      aria-checked={toggle && control.presentation === "toggle-switch" && observed !== null ? observed : undefined}
      aria-pressed={toggle && control.presentation === "toggle-button" && observed !== null ? observed : undefined}
      onClick={() => {
        const field = Object.entries(action?.config ?? {}).find(([, f]) => f.type === "boolean" && f.control);
        if (toggle && field && observed !== null)
          void plugin.execute({ ...control, pluginArgs: { ...control.pluginArgs, [field[0]]: !observed } });
        else if (!toggle) void plugin.execute(control);
      }}>{toggle ? <><span className="toggle-track" aria-hidden="true"><span /></span><span className="toggle-state">{observed === null ? "State unknown" : observed ? "On" : "Off"}</span></> : "Run plugin action"}</button></div>}
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

            <details className="icon-picker action-picker presentation-picker">
              <summary><span>Presentation</span>
                <span className="icon-picker-status">{PRESENTATION_LABELS[effectivePresentation(control, plugin.snapshots)]}</span>
                <ChevronDown className="icon-picker-toggle" size={16} aria-hidden="true" />
              </summary>
              <div className="icon-picker-body" role="group" aria-label="Choose presentation">
                {compatiblePresentations(control, plugin.snapshots).map((value) => <button type="button" key={value}
                  aria-pressed={effectivePresentation(control, plugin.snapshots) === value}
                  onClick={(event) => {
                    onPatch({ presentation: value });
                    const details = event.currentTarget.closest("details")!;
                    details.open = false;
                    details.querySelector("summary")?.focus();
                  }}>{value === "button" && controlContract(control, plugin.snapshots)?.kind === "boolean" ? "Button (fixed on/off)" : PRESENTATION_LABELS[value]}</button>)}
              </div>
            </details>
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
              <summary className="disclosure">{control.presentation === "value" ? "Value settings" : "Action settings"}</summary>
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
              {control.action !== "volume" && control.presentation !== "value" && control.action !== "plugin" ? (
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
