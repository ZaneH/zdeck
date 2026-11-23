import { controlSummary } from "../lib/actions";
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
}

export function ControlTile({ control, variant, volume, selected = false, pressed = false, onPrimary, onVolumeChange }: ControlTileProps) {
  const content = (
    <>
      <span className="tile-icon"><ActionIcon kind={control.action} size={22} /></span>
      <span className="tile-label" title={control.label}>{control.label}</span>
    </>
  );

  return (
    <article
      className={`control-tile${selected ? " is-selected" : ""}${pressed ? " is-pressed" : ""}`}
      data-action={control.action} data-variant={variant}
    >
      {control.action === "volume" && variant === "phone" ? (
        <div className="tile-primary tile-primary-static">{content}</div>
      ) : (
        <button
          type="button" className="tile-primary" onClick={onPrimary}
          aria-label={variant === "phone" ? `Press ${control.label} (local preview only)` : `Select ${control.label}`}
          aria-pressed={variant === "editor" ? selected : undefined} title={controlSummary(control)}
        >
          {content}
        </button>
      )}
      {control.action === "volume" ? (
        <div className="tile-volume">
          <label className="sr-only" htmlFor={`vol-${variant}-${control.id}`}>Preview volume for {control.label}</label>
          <input
            id={`vol-${variant}-${control.id}`} type="range" min={0} max={100} step={1} value={volume}
            onChange={(event) => onVolumeChange?.(Number(event.target.value))}
          />
          <span className="volume-readout" aria-hidden="true">{volume}%</span>
        </div>
      ) : null}
    </article>
  );
}
