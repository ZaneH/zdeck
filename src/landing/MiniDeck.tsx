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
  const [held, setHeld] = useState<Record<string, string>>({});

  function hold(source: string, id: string) {
    setHeld((prev) => ({ ...prev, [source]: id }));
  }

  function release(source: string) {
    setHeld((prev) => {
      const next = { ...prev };
      delete next[source];
      return next;
    });
  }

  useEffect(() => {
    const pressable = MINI_DECK_CONTROLS.filter((c) => c.action !== "volume");
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
          (event.target as HTMLElement | null)?.closest?.('[contenteditable]:not([contenteditable="false"])')) return;
      const idx = Number(event.key) - 1;
      if (idx >= 0 && idx < pressable.length) {
        if (event.repeat) return;
        const control = pressable[idx];
        hold(`shortcut:${event.code || event.key}`, control.id);
        setState((prev) => applyMiniControl(prev, control));
        onInteract?.();
      }
    }
    function onKeyUp(event: KeyboardEvent) {
      release(`shortcut:${event.code || event.key}`);
    }
    function reset() { setHeld({}); }
    function onVisibilityChange() {
      if (document.hidden) reset();
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", reset);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", reset);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [onInteract]);

  function fire(control: Control, volume?: number) {
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
            <div
              key={control.id}
              style={{ display: "contents" }}
              onPointerDown={(event) => {
                const button = (event.target as HTMLElement).closest("button");
                if (!button || event.button !== 0) return;
                button.setPointerCapture(event.pointerId);
                hold(`pointer:${event.pointerId}`, control.id);
              }}
              onPointerUp={(event) => release(`pointer:${event.pointerId}`)}
              onPointerCancel={(event) => release(`pointer:${event.pointerId}`)}
              onLostPointerCapture={(event) => release(`pointer:${event.pointerId}`)}
              onKeyDown={(event) => {
                if (!(event.target as HTMLElement).closest("button") ||
                    (event.key !== " " && event.key !== "Enter")) return;
                if (event.repeat) { event.preventDefault(); return; }
                hold(`button:${control.id}:${event.key}`, control.id);
              }}
              onKeyUp={(event) => release(`button:${control.id}:${event.key}`)}
              onBlur={() => {
                release(`button:${control.id}: `);
                release(`button:${control.id}:Enter`);
              }}
            >
              <ControlTile
                control={displayControl}
                variant="phone"
                volume={state.volume}
                pressed={Object.values(held).includes(control.id)}
                onPrimary={() => fire(control)}
                onVolumeChange={(val) => setState((prev) => ({ ...prev, volume: val }))}
                onVolumeCommit={(val) => fire(control, val)}
              />
            </div>
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
