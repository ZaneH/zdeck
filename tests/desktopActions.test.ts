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
  it("admits one gesture at a time and accepts values only for saved volume controls", async () => {
    const h = harness(); h.actions.enter();
    let resolve!: (result: DesktopResult) => void;
    h.dispatch.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const first = h.actions.press("ctl_volume", 63);
    await h.actions.press("ctl_volume", 64);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    resolve({ id: "command-1", state: "confirmed", message: "Confirmed." }); await first;
    await h.actions.press("ctl_mic", 50); await h.actions.press("missing"); await h.actions.press("ctl_volume", 101);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.dispatch.mock.calls[0][0]).toEqual({ commandId: "command-1", revision: 7, controlId: "ctl_volume", value: 63 });
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
  it("unknown replies and transport loss return Preview with a warning and no retry/check", async () => {
    for (const rejected of [false, true]) {
      const h = harness(); h.actions.enter();
      if (rejected) h.dispatch.mockRejectedValueOnce(new Error("secret timeout"));
      else h.dispatch.mockImplementationOnce(async (command) => ({ id: command.commandId, state: "unknown", message: "Inspect application before retrying." }));
      await h.actions.press("ctl_mic");
      await h.actions.check(); await h.actions.press("ctl_mic");
      expect(h.dispatch).toHaveBeenCalledTimes(1);
      expect(h.actions.isLive()).toBe(false);
      expect(h.actions.getSnapshot().result?.state).toBe("unknown");
      expect(JSON.stringify(h.actions.getSnapshot())).not.toContain("secret timeout");
    }
  });
});
