import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { CSSProperties } from "react";
import { controlContract, effectivePresentation, presentationCompatible } from "../lib/presentations";
import { pluginValue, pluginEntry, EMPTY_PLUGIN } from "../lib/plugin";
import type { PluginSnapshots } from "../lib/plugin";
import { controlSummary } from "../lib/actions";
import type { Control, Theme } from "../lib/types";
import { ActionIcon } from "./ActionIcon";
import { Dropdown } from "./Dropdown";
import { verticalReorderIndex } from "../lib/tileNavigation";
import { controlGeometry } from "../lib/theme";

const VOLUME_COMMIT_KEYS = new Set([
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "Home", "End", "PageUp", "PageDown",
]);

interface ControlTileProps {
  control: Control;
  plugins?: PluginSnapshots;
  order?: { index: number; total: number; move: (sourceId: string, targetIndex: number) => void };
  variant: "editor" | "phone";
  /** Resolved section appearance; drives Glass-only vertical slider semantics. */
  appearance?: Theme;
  volume: number;
  selected?: boolean;
  pressed?: boolean;
  disabled?: boolean;
  /** Disabled only while a volume gesture is in flight; keep the safety state without a dimmed flash. */
  transientDisabled?: boolean;
  /** In-flight action; shown separately from disabled controls. */
  busy?: boolean;
  /** "preview" keeps local-only wording; "remote" drops it for the real phone. */
  semantics?: "preview" | "remote" | "live";
  onRename?: () => void;
  onDuplicate?: () => void;
  /** Present when the page cannot accept another control; the menu row stays visible and disabled. */
  duplicateReason?: string;
  onDelete?: () => void;
  onPrimary?: () => void;
  onRefresh?: () => Promise<void>;
  onVolumeChange?: (value: number) => void;
  /** Numeric targets stream during live gestures; preview targets fire on release. Never fires on cancel/blur. */
  onVolumeCommit?: (value: number) => void;
}

export function ControlTile({
  control, variant, appearance = "dark", volume, selected = false, pressed = false, disabled = false,
  transientDisabled = false, busy = false, semantics = "preview", onPrimary, onVolumeChange, onVolumeCommit, order, plugins = {}, onRefresh, onRename, onDuplicate, duplicateReason, onDelete,
}: ControlTileProps) {
  const tileRef = useRef<HTMLElement>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState(false);
  const readOnly = control.presentation === "value";
  const observation = control.action === "plugin" && readOnly ? pluginValue(pluginEntry(plugins, control.pluginId) ?? EMPTY_PLUGIN, control) : null;
  const readingFailed = readError || control.action === "plugin" && !!pluginEntry(plugins, control.pluginId)?.lastError;
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ x: number; y: number; active: boolean } | null>(null);
  const dropTarget = useRef<HTMLElement | null>(null);
  const suppressClick = useRef(false);
  function clearDrag() {
    dropTarget.current?.classList.remove("is-drop-target");
    dropTarget.current = null;
    drag.current = null;
    setDragging(false);
  }
  useEffect(() => () => { dropTarget.current?.classList.remove("is-drop-target"); }, []);
  const contract = controlContract(control, plugins);
  const presentation = effectivePresentation(control, plugins);
  const geometry = controlGeometry(control, presentation, appearance);
  const numeric = contract?.kind === "numeric" && (presentation === "slider" || presentation === "dial") ? contract : null;
  const toggle = contract?.kind === "boolean" && (presentation === "toggle-switch" || presentation === "toggle-button") ? contract : null;
  const [localValue, setLocalValue] = useState<number | null>(null);
  const [previewToggle, setPreviewToggle] = useState<boolean | null>(null);
  useEffect(() => { setLocalValue(null); setPreviewToggle(null); }, [control.id, control.action, control.presentation, semantics, control.action === "plugin" ? JSON.stringify(control.pluginArgs) : volume]);
  const currentValue = localValue ?? (control.action === "volume" ? volume : numeric?.value ?? 0);
  const toggleValue = semantics === "preview" ? previewToggle ?? toggle?.value : toggle?.value;
  const valueRef = useRef(currentValue);
  valueRef.current = currentValue;
  const sentValue = useRef<number | null>(null);
  const commitValue = (value: number) => {
    if (sentValue.current === value) return;
    sentValue.current = value;
    onVolumeCommit?.(value);
  };
  const changeValue = (value: number) => {
    valueRef.current = value;
    setLocalValue(value);
    onVolumeChange?.(value);
    if (!disabled && semantics !== "preview" && (volumeGesture.current || dialPointer.current)) commitValue(value);
  };
  const dialPointer = useRef<{ id: number; y: number; value: number } | null>(null);
  const remote = semantics === "remote";
  const live = semantics === "live";
  const volumeGesture = useRef<string | null>(null);
  useEffect(() => { volumeGesture.current = null; dialPointer.current = null; }, [disabled, control.id, semantics]);
  const content = (
    <>
      <span className="tile-icon"><ActionIcon kind={control.action} icon={control.icon} size={22} /></span>
      <span className="tile-label" title={control.label}>{control.label}</span>
    </>
  );

  const primaryLabel =
    live && presentation === "button"
      ? `Run ${control.label} on this computer`
      : variant === "editor"
      ? `Select ${control.label}`
      : remote
        ? `Press ${control.label}`
        : `Press ${control.label} (local preview only)`;

  return (
    <article ref={tileRef}
      onContextMenu={event => { if (variant === "editor") event.preventDefault(); }}
      className={`control-tile${selected ? " is-selected" : ""}${pressed ? " is-pressed" : ""}${disabled ? " is-disabled" : ""}${transientDisabled ? " is-transient-disabled" : ""}${busy ? " is-busy" : ""}${dragging ? " is-dragging" : ""}${order ? " is-reorderable" : ""}`}
      style={{ ...(appearance === "glass" || control.columnSpan ? { "--column-span": geometry.columns } : {}), ...(appearance === "glass" || control.rowSpan ? { "--row-span": geometry.rows } : {}),
        ...(numeric ? { "--control-fill": `${100 * (currentValue - numeric.minimum) / (numeric.maximum - numeric.minimum)}%` } : {}),
      } as CSSProperties}
      data-presentation={presentation} data-action={control.action} data-variant={variant} aria-busy={busy || undefined}
      data-column-span={control.columnSpan} data-row-span={control.rowSpan} data-shape={geometry.shape}
      data-order-index={order?.index}
      onPointerDownCapture={(event) => {
        if (!order || disabled || event.button !== 0 || (event.target as HTMLElement).closest(".tile-reading button, .dropdown")) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.querySelector<HTMLButtonElement>(".tile-primary")?.focus();
        suppressClick.current = false;
        drag.current = { x: event.clientX, y: event.clientY, active: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onClickCapture={(event) => {
        if (!order || (event.target as HTMLElement).closest(".tile-reading button, .dropdown")) return;
        event.stopPropagation();
        if (!disabled && !suppressClick.current) onPrimary?.();
        suppressClick.current = false;
      }}
      onPointerMove={(event) => {
        const gesture = drag.current;
        if (!gesture || disabled) return;
        if (!gesture.active) {
          if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 5) return;
          gesture.active = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          suppressClick.current = true;
          setDragging(true);
        }
        const source = event.currentTarget;
        const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".control-tile");
        const target = hit && hit !== source && hit.parentElement === source.parentElement && hit.dataset.orderIndex !== undefined && !hit.classList.contains("is-disabled") ? hit : null;
        dropTarget.current?.classList.remove("is-drop-target");
        dropTarget.current = target;
        target?.classList.add("is-drop-target");
      }}
      onPointerUp={(event) => {
        const targetIndex = dropTarget.current?.dataset.orderIndex;
        const move = drag.current?.active && !disabled && targetIndex !== undefined;
        clearDrag();
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        if (move) order?.move(control.id, Number(targetIndex));
      }}
      onPointerCancel={clearDrag}
      onLostPointerCapture={(event) => { if (event.target === event.currentTarget) clearDrag(); }}
      onKeyDownCapture={(event) => {
        if (event.key === "Escape") clearDrag();
        if (!order || disabled || !event.altKey || event.ctrlKey || event.metaKey) return;
        if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const tiles = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLElement>(".control-tile") ?? []);
        const target = event.key === "ArrowLeft" ? order.index - 1 : event.key === "ArrowRight" ? order.index + 1
          : verticalReorderIndex(tiles.map(tile => ({
            // Layout bounds ignore entrance/press transforms while keys are moving.
            top: tile.offsetTop, bottom: tile.offsetTop + tile.offsetHeight,
            left: tile.offsetLeft, right: tile.offsetLeft + tile.offsetWidth,
          })), order.index, event.key === "ArrowUp" ? "up" : "down");
        order.move(control.id, Math.max(0, Math.min(order.total - 1, target)));
      }}
    >
      {((numeric || toggle || readOnly) && variant === "phone") || (readOnly && live) ? (
        <div className="tile-primary tile-primary-static">{content}</div>
      ) : (
        <button
          type="button" className="tile-primary" onClick={onPrimary} disabled={disabled || (semantics !== "preview" && (!presentationCompatible(control, plugins) || busy))}
          aria-label={busy ? `${primaryLabel} — running` : primaryLabel}
          aria-description={order ? "Drag tiles to reorder, or use Alt + arrow keys." : undefined}
          aria-keyshortcuts={order ? "Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight" : undefined}
          aria-pressed={variant === "editor" ? selected : undefined} title={controlSummary(control)}
        >
          {content}
        </button>
      )}
      {readOnly ? <div className="tile-reading">
        <output className={readingFailed || observation?.value == null ? "reading-unknown" : undefined} aria-label={`${control.label} reading`}>{readingFailed ? "Reading failed" : observation?.value == null ? "Unknown / unavailable" : typeof observation.value === "boolean" ? observation.value ? "On" : "Off" : <>{observation.value}<span className="value-unit">{observation.unit}</span></>}</output>
        <span className="reading-time">{observation ? `Checked ${new Date(observation.observedAtMs).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}` : "Not checked"}</span>
        {onRefresh ? <button type="button" className="icon-button reading-refresh" disabled={disabled || reading} aria-label={`Refresh ${control.label}`}  aria-busy={reading || undefined}
          onClick={async () => { setReading(true); setReadError(false); try { await onRefresh(); } catch { setReadError(true); } finally { setReading(false); } }}><RefreshCw size={14} aria-hidden="true" /></button> : null}
        {readingFailed ? <span className="sr-only" role="alert">Reading failed. Refresh or check the plugin in Settings.</span> : null}
      </div> : null}
      {toggle ? <button type="button" className={`tile-toggle ${presentation}`} disabled={(!busy && disabled) || toggleValue == null}
        aria-disabled={busy || undefined}
        role={presentation === "toggle-switch" && toggleValue != null ? "switch" : undefined}
        aria-checked={presentation === "toggle-switch" && toggleValue != null ? toggleValue : undefined}
        aria-pressed={presentation === "toggle-button" && toggleValue != null ? toggleValue : undefined}
        aria-label={`${control.label}${toggleValue == null ? " — state unknown" : ""}`}
        onClick={() => {
          if (disabled || busy) return;
          const next = !toggleValue;
          if (semantics === "preview") setPreviewToggle(next);
          else onVolumeCommit?.(next ? 1 : 0);
        }}><span className="toggle-track" aria-hidden="true"><span /></span><span className="toggle-state">{toggleValue == null ? "State unknown" : toggleValue ? "On" : "Off"}</span></button> : null}
      {numeric ? (
        <div className={`tile-volume${presentation === "dial" ? " tile-dial" : ""}`}>
          <label className="sr-only" htmlFor={`vol-${variant}-${control.id}`}>
            {remote || live ? `Target value for ${control.label}` : `Preview value for ${control.label}`}
          </label>
          <input
            id={`vol-${variant}-${control.id}`} type="range" min={numeric.minimum} max={numeric.maximum} step={numeric.step} value={currentValue}
            disabled={disabled} hidden={presentation === "dial"} aria-orientation={appearance === "glass" && presentation === "slider" ? "vertical" : undefined}
            onChange={(event) => changeValue(Number(event.target.value))}
            onPointerDown={(event) => {
              volumeGesture.current = !disabled && event.button === 0 && event.isPrimary ? `pointer:${event.pointerId}` : null;
              // Native ranges own thumb capture and release; do not replace it with input capture.
              if (volumeGesture.current) sentValue.current = null;
            }}
            onPointerUp={(event) => {
              const commit = volumeGesture.current === `pointer:${event.pointerId}` && event.button === 0 && !disabled;
              volumeGesture.current = null;
              if (commit) commitValue(Number(event.currentTarget.value));
            }}
            onPointerCancel={() => { volumeGesture.current = null; }}
            onLostPointerCapture={() => { volumeGesture.current = null; }}
            onBlur={() => { volumeGesture.current = null; }}
            onKeyDown={(event) => {
              if (event.key === "Escape") volumeGesture.current = null;
              else if (!disabled && VOLUME_COMMIT_KEYS.has(event.key)) {
                if (!volumeGesture.current) sentValue.current = null;
                volumeGesture.current = event.key;
              }
            }}
            onKeyUp={(event) => {
              const commit = volumeGesture.current === event.key && !disabled;
              volumeGesture.current = null;
              if (commit) commitValue(Number(event.currentTarget.value));
            }}
          />
          {presentation === "dial" ? <div className="dial-face" role="slider" tabIndex={disabled ? -1 : 0}
            aria-label={control.label} aria-valuemin={numeric.minimum} aria-valuemax={numeric.maximum} aria-valuenow={currentValue} aria-orientation="vertical" aria-disabled={disabled}
            style={{ "--dial-angle": `${-135 + 270 * (currentValue - numeric.minimum) / (numeric.maximum - numeric.minimum)}deg` } as CSSProperties}
            onPointerDown={(event) => {
              if (disabled || event.button !== 0 || !event.isPrimary) return;
              event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
              sentValue.current = null;
              dialPointer.current = { id: event.pointerId, y: event.clientY, value: currentValue };
            }} onPointerMove={(event) => {
              const gesture = dialPointer.current;
              if (!gesture || gesture.id !== event.pointerId || disabled) return;
              const raw = gesture.value + (gesture.y - event.clientY) * (numeric.maximum - numeric.minimum) / 150;
              changeValue(Math.max(numeric.minimum, Math.min(numeric.maximum, numeric.minimum + Math.round((raw - numeric.minimum) / numeric.step) * numeric.step)));
            }} onPointerUp={(event) => {
              if (dialPointer.current?.id !== event.pointerId) return;
              dialPointer.current = null;
              if (!disabled) commitValue(valueRef.current);
            }} onPointerCancel={() => { dialPointer.current = null; }} onLostPointerCapture={() => { dialPointer.current = null; }}
            onBlur={() => { dialPointer.current = null; volumeGesture.current = null; }}
            onKeyDown={(event) => {
              if (disabled) return;
              if (event.key === "Escape") { volumeGesture.current = null; dialPointer.current = null; return; }
              if (!VOLUME_COMMIT_KEYS.has(event.key)) return;
              event.preventDefault();
              if (!volumeGesture.current) sentValue.current = null;
              volumeGesture.current = event.key;
              const delta = ["ArrowDown", "ArrowLeft", "PageDown"].includes(event.key) ? -1 : 1;
              changeValue(event.key === "Home" ? numeric.minimum : event.key === "End" ? numeric.maximum
                : Math.max(numeric.minimum, Math.min(numeric.maximum, currentValue + delta * numeric.step * (event.key.startsWith("Page") ? 10 : 1))));
            }} onKeyUp={(event) => {
              const commit = volumeGesture.current === event.key && !disabled;
              volumeGesture.current = null; if (commit) commitValue(valueRef.current);
            }}>
              <svg className="dial-scale" viewBox="0 0 48 48" aria-hidden="true">
                <circle className="dial-scale-track" cx="24" cy="24" r="21" pathLength="100" strokeDasharray="75 100" />
                <circle className="dial-scale-value" cx="24" cy="24" r="21" pathLength="100"
                  strokeDasharray={`${75 * (currentValue - numeric.minimum) / (numeric.maximum - numeric.minimum)} 100`} />
              </svg>
              <span className="dial-indicator" aria-hidden="true" />
            </div> : null}
          <span className="volume-readout" aria-hidden="true">{currentValue}{control.action === "volume" ? <span className="value-unit">%</span> : null}</span>
        </div>
      ) : null}
      {onRename || onDuplicate || onDelete ? <Dropdown label={`Options for ${control.label}`} value="" actionMenu contextTarget={tileRef}
        disabled={disabled} options={[
          ...(onRename ? [{ value: "rename", label: "Rename" }] : []),
          ...(onDuplicate ? [{ value: "duplicate", label: "Duplicate", ...(duplicateReason ? { description: duplicateReason, disabled: true } : {}) }] : []),
          ...(onDelete ? [{ value: "delete", label: "Delete" }] : []),
        ]}
        onChange={(action) => {
          if (action === "rename") onRename?.();
          else if (action === "duplicate") onDuplicate?.();
          else onDelete?.();
        }} /> : null}
    </article>
  );
}
