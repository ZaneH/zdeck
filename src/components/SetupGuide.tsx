import { ArrowRight, Plus, X } from "lucide-react";

export type SetupStep = "start" | "configure" | "preview" | "done";

interface SetupGuideProps {
  step: SetupStep;
  hasSelection: boolean;
  onAdd: () => void;
  onConfigure: () => void;
  onPreview: () => void;
  onDismiss: () => void;
}

export function SetupGuide({ step, hasSelection, onAdd, onConfigure, onPreview, onDismiss }: SetupGuideProps) {
  const current = !hasSelection && step !== "done" ? "start" : step;
  return (
    <section className="setup-guide" aria-labelledby="setup-title">
      <div className="setup-copy" aria-live="polite">
        <h2 id="setup-title">{current === "start" ? "Make your first control" : current === "configure" ? "Make it yours" : current === "preview" ? "Give it a try" : "Your first control is ready"}</h2>
        <p>{current === "start" ? "The sample deck is yours to change. Add an action to get started." : current === "configure" ? "Change its label and action settings below. Changes save automatically." : current === "preview" ? "Try a local preview. This won’t change your microphone, playback, or OBS." : "Keep building here, or open Preview to try the phone layout. Phone pairing isn’t connected yet."}</p>
      </div>
      {current === "start" ? (
        <button type="button" className="button primary" onClick={onAdd}><Plus size={15} aria-hidden="true" /> Add a control</button>
      ) : current === "configure" ? (
        <button type="button" className="button primary" onClick={onConfigure}>Continue <ArrowRight size={15} aria-hidden="true" /></button>
      ) : current === "preview" ? (
        <button type="button" className="button primary" onClick={onPreview}>Try local preview</button>
      ) : (
        <button type="button" className="button primary" onClick={onDismiss}>Done</button>
      )}
      <button type="button" className="icon-button" onClick={onDismiss} aria-label="Dismiss setup guide"><X size={15} aria-hidden="true" /></button>
    </section>
  );
}
