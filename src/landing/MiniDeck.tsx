import { useEffect, useState } from "react";
import { ControlTile } from "../components/ControlTile";
import type { Control } from "../lib/types";
import {
  INITIAL_DECK_STATE,
  MINI_DECK_CONTROLS,
  SCENES,
  applyMiniControl,
  type DeckDemoState,
} from "./data";
import "./landing.css";

interface MiniDeckProps {
  onInteract?: () => void;
}

export function MiniDeck({ onInteract }: MiniDeckProps) {
  const [state, setState] = useState<DeckDemoState>(INITIAL_DECK_STATE);
  const [pressedId, setPressedId] = useState<string | null>(null);

  useEffect(() => {
    if (!pressedId) return;
    const timer = window.setTimeout(() => setPressedId(null), 140);
    return () => window.clearTimeout(timer);
  }, [pressedId]);

  useEffect(() => {
    const pressable = MINI_DECK_CONTROLS.filter((c) => c.action !== "volume");
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const idx = Number(event.key) - 1;
      if (idx >= 0 && idx < pressable.length) {
        const control = pressable[idx];
        setPressedId(control.id);
        setState((prev) => applyMiniControl(prev, control));
        onInteract?.();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onInteract]);

  function fire(control: Control, volume?: number) {
    setPressedId(control.id);
    setState((prev) => applyMiniControl(prev, control, volume));
    onInteract?.();
  }

  return (
    <div className="lp-deck-wrap">
      <div className="lp-deck-grid" aria-label="Interactive mini deck">
        {MINI_DECK_CONTROLS.map((control) => {
          const displayControl =
            control.action === "obs-scene"
              ? { ...control, label: SCENES[state.sceneIndex], scene: SCENES[state.sceneIndex] }
              : control.action === "mic-mute"
                ? { ...control, label: state.micMuted ? "Mic muted" : "Mic live" }
                : control;
          return (
            <ControlTile
              key={control.id}
              control={displayControl}
              variant="phone"
              volume={state.volume}
              pressed={pressedId === control.id}
              onPrimary={() => fire(control)}
              onVolumeChange={(val) => setState((prev) => ({ ...prev, volume: val }))}
              onVolumeCommit={(val) => fire(control, val)}
            />
          );
        })}
      </div>

      <div className="lp-deck-readout">
        <span className="lp-status-pill" role="status" aria-live="polite">
          <span className={`lp-led${state.micMuted ? " is-muted" : ""}`} aria-hidden="true" />
          <span>{state.status}</span>
        </span>
        <span className="lp-readout-meta">{state.volume}%</span>
      </div>
    </div>
  );
}
