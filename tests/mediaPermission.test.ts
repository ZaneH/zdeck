import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise effect/callback boundaries without a browser or native OS access.
const mocks = vi.hoisted(() => ({
  status: vi.fn(), request: vi.fn(), setters: [] as ReturnType<typeof vi.fn>[],
  effects: [] as (() => void | (() => void))[],
}));
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useRef: (current: unknown) => ({ current }),
  useState: () => {
    const set = vi.fn();
    mocks.setters.push(set);
    return [null, set];
  },
  useEffect: (effect: () => void | (() => void)) => { mocks.effects.push(effect); },
}));
vi.mock("../src/lib/native", () => ({
  systemMediaPermissionStatus: mocks.status,
  systemMediaPermissionRequest: mocks.request,
  toSystemError: () => ({ message: "Setup failed." }),
}));
import { useMediaPermission } from "../src/lib/useMediaPermission";

const required = { platform: "macos", status: "required" };
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));
let target: EventTarget;
let cleanup: (() => void) | void;

beforeEach(() => {
  mocks.status.mockReset().mockResolvedValue(required);
  mocks.request.mockReset().mockResolvedValue(required);
  mocks.setters.length = 0;
  mocks.effects.length = 0;
  target = new EventTarget();
  vi.stubGlobal("window", target);
});
afterEach(() => { cleanup?.(); cleanup = undefined; vi.unstubAllGlobals(); });

function mount() {
  const hook = useMediaPermission();
  cleanup = mocks.effects[0]();
  return hook;
}

describe("contextual media permission lifecycle", () => {
  it("only observes on selection, refresh and focus; requests only on explicit setup", async () => {
    const hook = mount();
    await flush();
    await hook.refresh();
    target.dispatchEvent(new Event("focus"));
    await flush();
    expect(mocks.status).toHaveBeenCalledTimes(3);
    expect(mocks.request).not.toHaveBeenCalled();
    await hook.openSettings();
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.setters[0]).toHaveBeenLastCalledWith(required);
    // The hook has no playback callback, so grant can never replay a media action.
  });

  it("ignores a stale selection reply and removes the focus listener on cleanup", async () => {
    let resolve!: (value: unknown) => void;
    mocks.status.mockReturnValue(new Promise((done) => { resolve = done; }));
    mount();
    mocks.setters.forEach((set) => set.mockClear());
    cleanup?.(); cleanup = undefined;
    resolve(required);
    await flush();
    target.dispatchEvent(new Event("focus"));
    expect(mocks.status).toHaveBeenCalledTimes(1);
    expect(mocks.setters.every((set) => set.mock.calls.length === 0)).toBe(true);
  });

  it("drops older status replies and does not duplicate a pending setup request", async () => {
    let resolve!: (value: unknown) => void;
    mocks.status.mockReturnValue(new Promise((done) => { resolve = done; }));
    let grant!: (value: unknown) => void;
    mocks.request.mockReturnValue(new Promise((done) => { grant = done; }));
    const hook = mount();
    const request = hook.openSettings();
    await hook.openSettings();
    target.dispatchEvent(new Event("focus"));
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(mocks.status).toHaveBeenCalledTimes(1);
    const granted = { platform: "macos", status: "granted" };
    grant(granted);
    await request;
    resolve(required);
    await flush();
    expect(mocks.setters[0]).toHaveBeenCalledExactlyOnceWith(granted);
  });
});
