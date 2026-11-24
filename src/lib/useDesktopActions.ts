import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { isDeck } from "./deck";
import { desktopRunControl, toDesktopActionError } from "./nativeActions";
import type { DesktopCommand, DesktopResult } from "./nativeActions";
import type { Deck } from "./types";

export interface DesktopContext { native: boolean; editor: boolean; deck: Deck; savedRevision: number | null }
export function desktopReady(context: DesktopContext): boolean {
  return context.native && context.editor && context.savedRevision !== null && Number.isSafeInteger(context.savedRevision)
    && context.savedRevision >= 0 && isDeck(context.deck);
}
interface ActionView {
  live: boolean;
  deck: Deck | null;
  revision: number | null;
  inflight: boolean;
  result: DesktopResult | null;
  error: string | null;
  pending: DesktopCommand | null;
}

/** One user gesture at a time. No polling, automatic checks, retries, or action payloads. */
export class DesktopActions {
  private view: ActionView = { live: false, deck: null, revision: null, inflight: false, result: null, error: null, pending: null };
  private listeners = new Set<() => void>();
  private invalidated: { deck: Deck; revision: number | null } | null = null;
  constructor(private context: () => DesktopContext, private dispatch = desktopRunControl,
    private newId = () => crypto.randomUUID() as string) {}
  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<ActionView>) { this.view = { ...this.view, ...patch }; this.listeners.forEach((listener) => listener()); }
  isLive(): boolean {
    const context = this.context();
    return this.view.live && desktopReady(context) && this.view.deck === context.deck && this.view.revision === context.savedRevision;
  }
  preview = () => { if (this.view.live) this.update({ live: false }); };
  invalidate = () => {
    const context = this.context();
    this.invalidated = { deck: context.deck, revision: context.savedRevision };
    this.preview();
  };
  enter = () => {
    const context = this.context();
    if (!desktopReady(context) || this.view.inflight || this.view.pending
      || (this.invalidated?.deck === context.deck && this.invalidated.revision === context.savedRevision)) return;
    this.update({ live: true, deck: context.deck, revision: context.savedRevision });
  };
  press = async (controlId: string, value?: number) => {
    if (!this.isLive() || this.view.inflight || this.view.pending) return;
    const context = this.context();
    const control = context.deck.pages.flatMap((page) => page.controls).find((item) => item.id === controlId);
    if (!control || (value !== undefined && (control.action !== "volume" || !Number.isFinite(value) || value < 0 || value > 100))) return;
    let command: DesktopCommand;
    try { command = { commandId: this.newId(), revision: context.savedRevision!, controlId, ...(value === undefined ? {} : { value }) }; }
    catch { this.update({ live: false, error: "Secure command IDs are unavailable. Live controls are disabled." }); return; }
    await this.send(command);
  };
  check = async () => {
    // Only a validated pending response proves the backend reserved this ID.
    // A lost/unknown response is never resubmitted, even as a purported result check.
    if (!this.context().native || this.view.inflight || !this.view.pending) return;
    await this.send(this.view.pending);
  };
  private async send(command: DesktopCommand) {
    this.update({ inflight: true, error: null });
    try {
      const result = await this.dispatch(command);
      this.update({ result, pending: result.state === "pending" ? command : null,
        ...(result.state === "unknown" ? { live: false } : {}) });
    } catch (cause) {
      const error = toDesktopActionError(cause);
      this.update({ live: false, pending: null, result: error.outcome === "unknown"
        ? { id: command.commandId, state: "unknown", message: error.message } : null, error: error.message });
    } finally { this.update({ inflight: false }); }
  }
}

export function useDesktopActions(context: DesktopContext) {
  const current = useRef(context);
  current.current = context;
  const [actions] = useState(() => new DesktopActions(() => current.current));
  const state = useSyncExternalStore(actions.subscribe, actions.getSnapshot, actions.getSnapshot);
  const live = actions.isLive();
  useEffect(() => { if (state.live && !live) actions.preview(); }, [actions, live, state.live]);
  return { ...state, live, ready: desktopReady(context), enter: actions.enter, preview: actions.preview, invalidate: actions.invalidate, press: actions.press, check: actions.check };
}
