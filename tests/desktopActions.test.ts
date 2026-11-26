import { describe, expect, it, vi } from "vitest";
import { createDefaultDeck } from "../src/lib/deck";
import { DesktopActions, desktopReady } from "../src/lib/useDesktopActions";
import type { DesktopContext } from "../src/lib/useDesktopActions";
import type { DesktopCommand, DesktopResult } from "../src/lib/nativeActions";

function harness() {
  let context: DesktopContext = { native: true, editor: true, deck: createDefaultDeck(), savedRevision: 7 };
  let count = 0;
  const dispatch = vi.fn(async (command: DesktopCommand): Promise<DesktopResult> => ({ id: command.commandId, state: "confirmed", message: "Confirmed." }));
  const actions = new DesktopActions(() => context, dispatch, () => `command-${++count}`);
  return { actions, dispatch, context: () => context, patch: (patch: Partial<DesktopContext>) => { context = { ...context, ...patch }; } };
}

describe("explicit desktop Live actions", () => {
  it("defaults Preview, never dispatches on mode changes, and sends only persisted revision/control ID", async () => {
    const { actions, dispatch } = harness();
    await actions.press("ctl_play_pause");
    expect(dispatch).not.toHaveBeenCalled();
    actions.enter();
    expect(dispatch).not.toHaveBeenCalled();
    await actions.press("ctl_play_pause");
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ commandId: "command-1", revision: 7, controlId: "ctl_play_pause" });
    actions.preview();
    await actions.press("ctl_play_pause");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it("fails closed on browser, phone preview, saving, dirty, failed/conflicting or invalid deck state", async () => {
    for (const patch of [{ native: false }, { editor: false }, { savedRevision: null }, { savedRevision: -1 },
      { deck: { ...createDefaultDeck(), pages: [] } }]) {
      const h = harness(); h.patch(patch);
      expect(desktopReady(h.context())).toBe(false);
      h.actions.enter(); await h.actions.press("ctl_mic");
      expect(h.actions.isLive()).toBe(false); expect(h.dispatch).not.toHaveBeenCalled();
    }
    const h = harness(); h.actions.enter();
    h.patch({ deck: { ...h.context().deck, theme: "light" } });
    await h.actions.press("ctl_mic");
    expect(h.actions.isLive()).toBe(false); expect(h.dispatch).not.toHaveBeenCalled();
    h.patch({ savedRevision: null });
    h.actions.enter(); expect(h.actions.isLive()).toBe(false);
  });
  it("invalidates synchronously before React can render an edited/saving deck", async () => {
    const h = harness(); h.actions.enter(); h.actions.invalidate();
    h.actions.enter(); await h.actions.press("ctl_mic");
    expect(h.dispatch).not.toHaveBeenCalled();
    h.patch({ savedRevision: null }); h.actions.enter(); expect(h.actions.isLive()).toBe(false);
    h.patch({ savedRevision: 8 }); h.actions.enter(); await h.actions.press("ctl_mic");
    expect(h.dispatch.mock.calls[0][0].revision).toBe(8);
  });
  it("serializes numeric gestures and delivers the latest final value, not intermediate releases", async () => {
    const h = harness(); h.actions.enter();
    let resolve!: (result: DesktopResult) => void;
    h.dispatch.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    expect(h.actions.getSnapshot().busyControlId).toBeNull();
    const first = h.actions.press("ctl_volume", 63);
    expect(h.actions.getSnapshot()).toMatchObject({ inflight: true, busyControlId: "ctl_volume" });
    await h.actions.press("ctl_volume", 64);
    await h.actions.press("ctl_volume", 85);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.actions.getSnapshot().busyControlId).toBe("ctl_volume");
    resolve({ id: "command-1", state: "confirmed", message: "Confirmed." }); await first;
    expect(h.actions.getSnapshot()).toMatchObject({ inflight: false, busyControlId: null });
    await h.actions.press("ctl_mic", 50); await h.actions.press("missing"); await h.actions.press("ctl_volume", 101);
    expect(h.dispatch).toHaveBeenCalledTimes(2);
    expect(h.dispatch.mock.calls[0][0]).toEqual({ commandId: "command-1", revision: 7, controlId: "ctl_volume", value: 63 });
    expect(h.dispatch.mock.calls[1][0].value).toBe(85);
  });
  it("does not replay queued targets after an uncertain delivery or deck change", async () => {
    for (const changeDeck of [false, true]) {
      const h = harness(); h.actions.enter();
      let resolve!: (result: DesktopResult) => void;
      h.dispatch.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
      const first = h.actions.press("ctl_volume", 20);
      await h.actions.press("ctl_volume", 90);
      if (changeDeck) h.patch({ savedRevision: 8 });
      resolve({ id: "command-1", state: changeDeck ? "confirmed" : "unknown", message: "Inspect before retrying." });
      await first;
      expect(h.dispatch).toHaveBeenCalledTimes(1);
    }
  });
  it("routes declared plugin scalar targets, not saved values, and rejects incompatible presentations", async () => {
    const h = harness();
    const deck = createDefaultDeck();
    deck.pages[0].controls.push({ id: "level", action: "plugin", label: "Level", pluginId: "mixer", pluginAction: "level", pluginArgs: { amount: 50 }, presentation: "dial" });
    h.patch({ deck, plugins: { mixer: { status: "connected", state: {}, lastError: null, manifest: { id: "mixer", version: "1.0.0", protocolVersion: 1,
      actions: [{ id: "level", title: "Level", config: { amount: { type: "integer", minimum: -20, maximum: 200, control: { step: 5 } } } }] } } } });
    h.actions.enter();
    await h.actions.press("level", 75);
    expect(h.dispatch.mock.calls[0][0].value).toBe(75);
    await h.actions.press("level", 76); await h.actions.press("level");
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });
  it("only explicitly checks an acknowledged pending request using exactly the same ID and body", async () => {
    const h = harness(); h.actions.enter();
    h.dispatch.mockImplementationOnce(async (command) => ({ id: command.commandId, state: "pending", message: "Pending." }));
    await h.actions.press("ctl_volume", 25);
    await h.actions.press("ctl_volume", 25);
    h.actions.preview(); h.actions.enter();
    expect(h.actions.isLive()).toBe(false); expect(h.dispatch).toHaveBeenCalledTimes(1);
    h.patch({ savedRevision: 8 });
    await h.actions.check();
    expect(h.dispatch).toHaveBeenCalledTimes(2);
    expect(h.dispatch.mock.calls[1][0]).toEqual(h.dispatch.mock.calls[0][0]);
    expect(h.actions.getSnapshot().pending).toBeNull();
    h.actions.enter(); expect(h.actions.isLive()).toBe(true);
  });
  it("keeps Live ready after a sent media key without replay or a result check", async () => {
    const h = harness(); h.actions.enter();
    h.dispatch.mockImplementation(async (command) => ({ id: command.commandId, state: "unknown", code: "media_key_sent", message: "Media key sent." }));
    await h.actions.press("ctl_play_pause");
    expect(h.actions.isLive()).toBe(true);
    expect(h.actions.getSnapshot().pending).toBeNull();
    await h.actions.check();
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    await h.actions.press("ctl_play_pause");
    expect(h.dispatch).toHaveBeenCalledTimes(2);
    expect(h.dispatch.mock.calls[1][0].commandId).not.toBe(h.dispatch.mock.calls[0][0].commandId);
  });
  it("unknown replies and transport loss return Preview with a warning and no retry/check", async () => {
    for (const failure of ["unknown", "plugin_outcome_unknown", "transport"]) {
      const h = harness(); h.actions.enter();
      if (failure === "transport") h.dispatch.mockRejectedValueOnce(new Error("secret timeout"));
      else h.dispatch.mockImplementationOnce(async (command) => ({ id: command.commandId, state: "unknown", message: "Inspect application before retrying.", ...(failure === "plugin_outcome_unknown" ? { code: failure } : {}) }));
      await h.actions.press("ctl_mic");
      await h.actions.check(); await h.actions.press("ctl_mic");
      expect(h.dispatch).toHaveBeenCalledTimes(1);
      expect(h.actions.isLive()).toBe(false);
      expect(h.actions.getSnapshot().result?.state).toBe("unknown");
      expect(JSON.stringify(h.actions.getSnapshot())).not.toContain("secret timeout");
    }
  });
});
