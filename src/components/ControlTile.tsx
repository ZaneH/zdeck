import { ChevronDown, ChevronUp } from "lucide-react";
import { actionDefinition, controlSummary } from "../lib/actions";
import type { Control } from "../lib/types";
import { ActionIcon } from "./ActionIcon";

interface ControlTileProps {
  control: Control;
  variant: "editor" | "phone";
  volume: number;
  selected?: boolean;
  pressed?: boolean;
  onPrimary?: () => void;
  onVolumeChange?: (value: number) => void;
  onMove?: (delta: number) => void;
  canMoveUp?: boolean;
  canMoveDown?: boolean;
}

export function ControlTile({
  control,
  variant,
  volume,
  selected = false,
  pressed = false,
  onPrimary,
  onVolumeChange,
  onMove,
  canMoveUp = false,
  canMoveDown = false,
}: ControlTileProps) {
  const definition = actionDefinition(control.action);
  const primaryLabel =
    variant === "phone"
      ? `Press ${control.label} (local preview only)`
      : `Select ${control.label}`;
  const content = (
    <>
      <span className="tile-icon">
        <ActionIcon kind={control.action} />
      </span>
      <span className="tile-copy">
        <span className="tile-label">{control.label}</span>
        <span className="tile-meta">
          {definition.category} · {controlSummary(control)}
        </span>
      </span>
    </>
  );

  return (
    <article
      className={`control-tile${selected ? " is-selected" : ""}${
        pressed ? " is-pressed" : ""
      }`}
      data-action={control.action}
    >
      {variant === "editor" && onMove ? (
        <div className="tile-tools">
          <button
            type="button"
            className="icon-button"
            onClick={() => onMove(-1)}
            disabled={!canMoveUp}
            aria-label={`Move ${control.label} up`}
            title="Move up"
          >
            <ChevronUp size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => onMove(1)}
            disabled={!canMoveDown}
            aria-label={`Move ${control.label} down`}
            title="Move down"
          >
            <ChevronDown size={15} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {control.action === "volume" && variant === "phone" ? (
        <div className="tile-primary tile-primary-static">{content}</div>
      ) : (
        <button
          type="button"
          className="tile-primary"
          onClick={onPrimary}
          aria-label={primaryLabel}
          aria-pressed={variant === "editor" ? selected : undefined}
        >
          {content}
        </button>
      )}

      {control.action === "volume" ? (
        <div className="tile-volume">
          <label className="sr-only" htmlFor={`vol-${variant}-${control.id}`}>
            Preview volume for {control.label}
          </label>
          <input
            id={`vol-${variant}-${control.id}`}
            type="range"
            min={0}
            max={100}
            step={1}
            value={volume}
            onChange={(event) => onVolumeChange?.(Number(event.target.value))}
          />
          <span className="volume-readout" aria-hidden="true">
            {volume}%
          </span>
        </div>
      ) : null}
    </article>
  );
}
