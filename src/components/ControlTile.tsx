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
      className={`control-tile${selected ? " is-selected" : ""}${pressed ? " is-pressed" : ""}${disabled ? " is-disabled" : ""}${busy ? " is-busy" : ""}${dragging ? " is-dragging" : ""}${order ? " is-reorderable" : ""}`}
      style={{ "--column-span": control.columnSpan ?? 1, gridRow: `span ${control.rowSpan ?? 1}` } as CSSProperties}
      data-action={control.action} data-variant={variant} aria-busy={busy || undefined}
      data-order-index={order?.index}
      onPointerMove={(event) => {
        const gesture = drag.current;
        if (!gesture || disabled) return;
        if (!gesture.active) {
          if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 5) return;
          gesture.active = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          suppressClick.current = true;
          event.currentTarget.querySelector("details")!.open = false;
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
      onKeyDown={(event) => { if (event.key === "Escape") clearDrag(); }}
    >
      {order ? <details className="tile-order">
        <summary aria-label={`Move ${control.label}`} title="Drag to reorder, or choose a position"
          draggable={false} aria-disabled={disabled || undefined}
          onClick={(event) => {
            event.stopPropagation();
            if (disabled || suppressClick.current) event.preventDefault();
            suppressClick.current = false;
          }}
          onDragStart={(event) => event.preventDefault()}
          onPointerDown={(event) => {
            if (disabled || event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus();
            suppressClick.current = false;
            drag.current = { x: event.clientX, y: event.clientY, active: false };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}>
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
