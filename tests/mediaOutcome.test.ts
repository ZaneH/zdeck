import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), setters: [] as ReturnType<typeof vi.fn>[],
  media: { status: "unknown", observedAtMs: 1 },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, isTauri: () => true }));
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useRef: (current: unknown) => ({ current }),
  useEffect: () => {},
  useState: (initial: unknown) => {
    const index = mocks.setters.length;
    const set = vi.fn();
    mocks.setters.push(set);
    return [index === 11 ? mocks.media : initial, set];
  },
}));
import { useSystemConsole } from "../src/lib/useSystemConsole";

beforeEach(() => { mocks.setters.length = 0; mocks.invoke.mockReset(); vi.stubGlobal("window", {}); });
afterEach(() => vi.unstubAllGlobals());
describe("Inspector media dispatch feedback", () => {
  it("keeps unobservable media ready without a warning, refresh or replay", async () => {
    mocks.invoke.mockRejectedValue({ kind: "media_key_sent", message: "Media key sent. Playback state is unavailable." });
    const system = useSystemConsole();
    await system.runMedia();
    expect(mocks.setters[11]).not.toHaveBeenCalled(); // no fabricated playback or cleared snapshot
    expect(mocks.setters[15]).toHaveBeenCalledExactlyOnceWith(null); // no outcome banner
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("system_media_play_pause", {});
    await system.runMedia();
    expect(mocks.invoke).toHaveBeenCalledTimes(2); // only the second intentional gesture
  });
  it.each(["timeout", "outcome_unknown"])("retains the warning and refresh safeguard for %s", async (kind) => {
    mocks.invoke.mockRejectedValue({ kind, message: "Check before retrying." });
    await useSystemConsole().runMedia();
    expect(mocks.setters[11]).toHaveBeenCalledWith(null);
    expect(mocks.setters[15]).toHaveBeenLastCalledWith({ state: "unknown", message: "Check before retrying." });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
});
