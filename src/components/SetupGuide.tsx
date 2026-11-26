import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ArrowLeft, ArrowRight, Clapperboard, Mic, MicOff, Pause, Play } from "lucide-react";
import { ACTION_CATALOG, actionDefinition, clampVolume, createControl } from "../lib/actions";
import type { Control } from "../lib/types";
import { ActionIcon } from "./ActionIcon";
import { BrandMark } from "./BrandMark";
import { ControlTile } from "./ControlTile";

type Step = "welcome" | "build" | "try";

interface SetupGuideProps {
  pageName: string;
  canAdd: boolean;
  storageAlert: string | null;
  onFinish: (control: Control) => boolean;
  onDismiss: () => void;
}

function Rehearsal({ control, active, volume }: { control: Control; active: boolean; volume: number }) {
  return (
    <div className={`rehearsal${active ? " is-active" : ""}`} aria-hidden="true">
      <div className="rehearsal-caption">Rehearsal</div>
      {control.action === "obs-scene" ? (
        <div className="rehearsal-scene">
          <div className="scene-before">Starting soon</div>
          <div className="scene-after"><Clapperboard size={32} /><span>{control.scene}</span></div>
        </div>
      ) : control.action === "mic-mute" ? (
        <div className="rehearsal-audio">
          {active ? <MicOff size={32} /> : <Mic size={32} />}
          <div className="rehearsal-wave">{[12, 24, 38, 20, 46, 30, 18, 36, 24].map((height, i) => <i key={i} style={{ height: active ? 4 : height }} />)}</div>
          <span>{active ? "Microphone muted" : "Microphone on"}</span>
        </div>
      ) : control.action === "media-play-pause" ? (
        <div className="rehearsal-player">
          <div className="rehearsal-record">{active ? <Pause size={22} /> : <Play size={22} />}</div>
          <span>Practice track</span>
          <small>{active ? "Playing" : "Paused"}</small>
        </div>
      ) : (
        <div className="rehearsal-volume">
          <strong>{volume}%</strong>
          <div>{Array.from({ length: 12 }, (_, i) => <i key={i} className={i < Math.round(volume * 12 / 100) ? "is-filled" : ""} />)}</div>
          <span>Output volume</span>
        </div>
      )}
    </div>
  );
}

export function SetupGuide({ pageName, canAdd, storageAlert, onFinish, onDismiss }: SetupGuideProps) {
  const [step, setStep] = useState<Step>("welcome");
  // Setup rehearses built-ins only; external actions come from a trusted connected manifest later.
  const [draft, setDraft] = useState<Control>(() => createControl("obs-scene"));
  const [demo, setDemo] = useState<Control>(() => createControl("obs-scene"));
  const [demoPresses, setDemoPresses] = useState(0);
  const [presses, setPresses] = useState(0);
  const [changedVolume, setChangedVolume] = useState(false);
  const [finishError, setFinishError] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const tried = presses > 0 || changedVolume;
  const valid = draft.label.trim().length > 0 && (draft.action !== "obs-scene" || draft.scene.trim().length > 0);
  const volume = draft.action === "volume" ? draft.volume : 50;

  useEffect(() => { heading.current?.focus(); }, [step]);

  const changeStep = (next: Step) => {
    const update = () => {
      setStep(next);
      if (next === "try") {
        setPresses(0);
        setChangedVolume(false);
        setFinishError(false);
      }
    };
    if (document.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      document.startViewTransition(() => flushSync(update));
    } else update();
  };

  const outcome = draft.action === "obs-scene" ? `Rehearsal switched to ${draft.scene}.` : draft.action === "mic-mute" ? (presses % 2 ? "Microphone muted." : "Microphone unmuted.") : draft.action === "media-play-pause" ? (presses % 2 ? "Playback started." : "Playback paused.") : `Volume changed to ${volume}%.`;

  return (
    <div className="setup-shell">
      <header className="setup-header">
        <span className="brand"><BrandMark /></span>
        <button type="button" className="button quiet" onClick={onDismiss}>Skip setup</button>
      </header>
      <main className="setup-main" id="main">
        <section className={`setup-story setup-${step}`} aria-labelledby="setup-title" key={step}>
          <div className="setup-heading">
            <h1 id="setup-title" ref={heading} tabIndex={-1}>{step === "welcome" ? "Start with one button." : step === "build" ? "Make it yours." : draft.action === "volume" ? "Give it a slide." : "Give it a press."}</h1>
            <p>{step === "welcome" ? "Give a desktop action a home on your phone." : step === "build" ? "Give your control a name." : draft.action === "volume" ? "Move the slider and watch the volume change here." : "Press your button and watch what happens here."}</p>
          </div>

          {step === "welcome" ? (
            <>
              <div className="setup-demonstration">
                <div className="setup-demo-keys" aria-label="Try example controls">
                  {ACTION_CATALOG.map((action) => (
                    <button type="button" className={`setup-demo-key${demo.action === action.kind && demoPresses % 2 ? " is-down" : ""}`} key={action.kind} aria-label={`Rehearse ${action.name}`} onClick={() => {
                      setDemo(createControl(action.kind));
                      setDraft((current) => current.action === action.kind ? current : createControl(action.kind));
                      setDemoPresses((current) => demo.action === action.kind ? current + 1 : 1);
                    }}>
                      <ActionIcon kind={action.kind} size={24} />
                      <span>{action.kind === "obs-scene" ? "Scene" : action.kind === "mic-mute" ? "Mic" : action.kind === "media-play-pause" ? "Playback" : "Volume"}</span>
                    </button>
                  ))}
                </div>
                <ArrowRight className="setup-connection" size={20} aria-hidden="true" />
                <Rehearsal control={demo} active={demo.action === "obs-scene" ? demoPresses > 0 : demoPresses % 2 === 1} volume={demoPresses % 2 ? 75 : 50} />
              </div>
              <p className="setup-hint" role="status" aria-live="polite">{demoPresses === 0 ? "Try a key. This is just a rehearsal." : demo.action === "obs-scene" ? "Rehearsal switched to Scene 1." : demo.action === "mic-mute" ? (demoPresses % 2 ? "Rehearsal microphone muted." : "Rehearsal microphone on.") : demo.action === "media-play-pause" ? (demoPresses % 2 ? "Rehearsal playback started." : "Rehearsal playback paused.") : `Rehearsal volume ${demoPresses % 2 ? 75 : 50}%.`}</p>
              <div className="setup-actions"><button type="button" className="button primary" onClick={() => changeStep("build")}>Make a button <ArrowRight size={15} aria-hidden="true" /></button></div>
            </>
          ) : step === "build" ? (
            <form onSubmit={(event) => { event.preventDefault(); if (valid) changeStep("try"); }}>
              <details className="setup-action-change">
                <summary aria-label="Change action"><ActionIcon kind={draft.action} size={20} /><span>{actionDefinition(draft.action).name}</span><span className="setup-change-label">Change action</span></summary>
              <fieldset className="setup-choices">
                <legend className="sr-only">Action</legend>
                {ACTION_CATALOG.map((action) => (
                  <label className={`setup-choice${draft.action === action.kind ? " is-chosen" : ""}`} key={action.kind}>
                    <input type="radio" name="setup-action" value={action.kind} checked={draft.action === action.kind} onChange={() => setDraft(createControl(action.kind))} />
                    <ActionIcon kind={action.kind} size={22} />
                    <span>{action.name}</span>
                  </label>
                ))}
              </fieldset>
              </details>
              <div className="setup-fields">
                <label className="field"><span>{draft.action === "obs-scene" ? "Custom label (optional)" : "Button label"}</span><input name="label" value={draft.action === "obs-scene" && draft.autoLabel ? "" : draft.label} placeholder={draft.action === "obs-scene" ? draft.scene : undefined} maxLength={40} required={draft.action !== "obs-scene"} onChange={(event) => {
                  const label = event.target.value;
                  setDraft(draft.action === "obs-scene" ? { ...draft, label: label.trim() ? label : draft.scene, autoLabel: !label.trim() } : { ...draft, label });
                }} /></label>
                {draft.action === "obs-scene" ? <label className="field"><span>OBS scene name</span><input name="scene" value={draft.scene} maxLength={40} required onChange={(event) => setDraft({ ...draft, scene: event.target.value, ...(draft.autoLabel ? { label: event.target.value } : {}) })} /></label> : null}
              </div>
              <p className="setup-action-note">{draft.action === "obs-scene" ? "Use an existing scene name. Connect OBS later in Settings." : draft.action === "mic-mute" ? "Controls your default system microphone, not an OBS input. On macOS, devices without mute use saved input levels for reversible software mute." : draft.action === "media-play-pause" ? "System play/pause on macOS and Windows; default MPRIS player on Linux. Sent media keys report an unknown outcome; macOS requires Accessibility permission." : "Controls your default audio output on macOS, Windows, and Linux. Never goes above 100%."}</p>
              <div className="setup-actions"><button type="button" className="button quiet" onClick={() => changeStep("welcome")}><ArrowLeft size={15} aria-hidden="true" /> Back</button><button type="submit" className="button primary" disabled={!valid}>Try this control <ArrowRight size={15} aria-hidden="true" /></button></div>
            </form>
          ) : (
            <>
              <div className="setup-demonstration setup-practice">
                <div className="setup-practice-key">
                  <ControlTile control={draft} variant="phone" volume={volume} onPrimary={() => setPresses((current) => current + 1)} onVolumeChange={(value) => {
                    if (draft.action !== "volume") return;
                    setDraft({ ...draft, volume: clampVolume(value) });
                    setChangedVolume(true);
                  }} />
                </div>
                <ArrowRight className="setup-connection" size={20} aria-hidden="true" />
                <Rehearsal control={draft} active={draft.action === "obs-scene" ? presses > 0 : presses % 2 === 1} volume={volume} />
              </div>
              <p className="setup-result" role="status" aria-live="polite">{tried ? (draft.action === "obs-scene" ? outcome : `Rehearsal: ${outcome}`) : draft.action === "volume" ? "Slide to try it." : "Your button is ready to try."}</p>
              <p className="setup-hint">Nothing runs on your desktop during setup.</p>
              <p className="setup-destination">Page: {pageName}</p>
              <div className="setup-actions"><button type="button" className="button quiet" onClick={() => changeStep("build")}><ArrowLeft size={15} aria-hidden="true" /> Edit button</button><button type="button" className="button primary" disabled={!tried || !canAdd} onClick={() => { if (!onFinish(draft)) setFinishError(true); }}>Add to page <ArrowRight size={15} aria-hidden="true" /></button></div>
              {!canAdd || finishError ? <p className="setup-error" role="status">This page is full. Skip setup to make room or choose another page.</p> : null}
              <p className="setup-limitation">Connect your phone in Settings.</p>
            </>
          )}
          {storageAlert ? <p className="storage-alert" role="status">{storageAlert}</p> : null}
        </section>
      </main>
    </div>
  );
}
