import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { GripVertical } from "lucide-react";
import { controlSummary } from "../lib/actions";
import type { Control } from "../lib/types";
import { ActionIcon } from "./ActionIcon";

const VOLUME_COMMIT_KEYS = new Set([
  "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown",
  "Home", "End", "PageUp", "PageDown",
]);

interface ControlTileProps {
  control: Control;
  order?: { index: number; total: number; move: (sourceId: string, targetIndex: number) => void };
  variant: "editor" | "phone";
  volume: number;
  selected?: boolean;
  pressed?: boolean;
  disabled?: boolean;
  /** In-flight action; shown separately from disabled controls. */
  busy?: boolean;
  /** "preview" keeps local-only wording; "remote" drops it for the real phone. */
  semantics?: "preview" | "remote" | "live";
  onPrimary?: () => void;
  onVolumeChange?: (value: number) => void;
  /** Fired on deliberate slider release or value key-up, never on cancel/blur. */
  onVolumeCommit?: (value: number) => void;
}

export function ControlTile({
  control, variant, volume, selected = false, pressed = false, disabled = false,
  busy = false, semantics = "preview", onPrimary, onVolumeChange, onVolumeCommit, order,
}: ControlTileProps) {
  const [dragOver, setDragOver] = useState(false);
  const [dragging, setDragging] = useState(false);
  const remote = semantics === "remote";
  const live = semantics === "live";
  const volumeGesture = useRef<string | null>(null);
  useEffect(() => { volumeGesture.current = null; }, [disabled, control.id, semantics]);
  const content = (
    <>
      <span className="tile-icon"><ActionIcon kind={control.action} icon={control.icon} size={22} /></span>
      <span className="tile-label" title={control.label}>{control.label}</span>
    </>
  );

  const primaryLabel =
    live && control.action !== "volume"
      ? `Run ${control.label} on this computer`
      : variant === "editor"
      ? `Select ${control.label}`
      : remote
        ? `Press ${control.label}`
        : `Press ${control.label} (local preview only)`;

  return (
    <article
      className={`control-tile${selected ? " is-selected" : ""}${pressed ? " is-pressed" : ""}${disabled ? " is-disabled" : ""}${busy ? " is-busy" : ""}${dragOver ? " is-drop-target" : ""}${dragging ? " is-dragging" : ""}${order ? " is-reorderable" : ""}`}
      style={{ "--column-span": control.columnSpan ?? 1, gridRow: `span ${control.rowSpan ?? 1}` } as CSSProperties}
      data-action={control.action} data-variant={variant} aria-busy={busy || undefined}
      onDragOver={(event) => {
        if (!order || disabled || !event.dataTransfer.types.includes("application/x-zdeck-control")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDragOver(true);
      }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false); }}
      onDrop={(event) => {
        setDragOver(false);
        if (!order || disabled) return;
        event.preventDefault();
        order.move(event.dataTransfer.getData("application/x-zdeck-control"), order.index);
      }}
    >
      {order ? <details className="tile-order">
        <summary aria-label={`Move ${control.label}`} title="Drag to reorder, or choose a position"
          draggable={!disabled} onClick={(event) => event.stopPropagation()}
          onDragStart={(event) => {
            event.currentTarget.closest("details")!.open = false;
            event.dataTransfer.setData("application/x-zdeck-control", control.id);
            event.dataTransfer.effectAllowed = "move";
            setDragging(true);
          }} onDragEnd={() => { setDragging(false); setDragOver(false); }}>
          <GripVertical size={16} aria-hidden="true" />
        </summary>
        <label className="field"><span>Position</span><select aria-label={`Position of ${control.label}`} value={order.index} disabled={disabled}
          onChange={(event) => order.move(control.id, Number(event.target.value))}
          onKeyDown={(event) => {
            if (event.altKey || event.ctrlKey || event.metaKey) return;
            const target = event.key === "Home" ? 0 : event.key === "End" ? order.total - 1
              : event.key === "ArrowUp" ? Math.max(0, order.index - 1)
              : event.key === "ArrowDown" ? Math.min(order.total - 1, order.index + 1) : null;
            if (target === null) return;
            event.preventDefault();
            const select = event.currentTarget;
            order.move(control.id, target);
            window.requestAnimationFrame(() => select.focus());
          }}>
          {Array.from({ length: order.total }, (_, index) => <option key={index} value={index}>{index + 1} of {order.total}</option>)}
        </select></label>
      </details> : null}
      {control.action === "volume" && variant === "phone" ? (
        <div className="tile-primary tile-primary-static">{content}</div>
      ) : (
        <button
          type="button" className="tile-primary" onClick={onPrimary} disabled={disabled}
          aria-label={busy ? `${primaryLabel} — running` : primaryLabel}
          aria-pressed={variant === "editor" ? selected : undefined} title={controlSummary(control)}
        >
          {content}
        </button>
      )}
      {control.action === "volume" ? (
        <div className="tile-volume">
          <label className="sr-only" htmlFor={`vol-${variant}-${control.id}`}>
            {remote || live ? `Target volume for ${control.label}` : `Preview volume for ${control.label}`}
          </label>
          <input
            id={`vol-${variant}-${control.id}`} type="range" min={0} max={100} step={1} value={volume}
            disabled={disabled}
            onChange={(event) => onVolumeChange?.(Number(event.target.value))}
            onPointerDown={(event) => {
              volumeGesture.current = !disabled && event.button === 0 ? "pointer" : null;
            }}
            onPointerUp={(event) => {
              const commit = volumeGesture.current === "pointer" && event.button === 0 && !disabled;
              volumeGesture.current = null;
              if (commit) onVolumeCommit?.(Number(event.currentTarget.value));
            }}
            onPointerCancel={() => { volumeGesture.current = null; }}
            onBlur={() => { volumeGesture.current = null; }}
            onKeyDown={(event) => {
              if (!disabled && VOLUME_COMMIT_KEYS.has(event.key)) volumeGesture.current = event.key;
            }}
            onKeyUp={(event) => {
              const commit = volumeGesture.current === event.key && !disabled;
              volumeGesture.current = null;
              if (commit) onVolumeCommit?.(Number(event.currentTarget.value));
            }}
          />
          <span className="volume-readout" aria-hidden="true">{volume}%</span>
        </div>
      ) : null}
    </article>
  );
}
