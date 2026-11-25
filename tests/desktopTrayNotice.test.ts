import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), native: true, set: vi.fn(), effects: [] as (() => void | (() => void))[],
}));
vi.mock("react", () => ({
  useState: () => [null, mocks.set],
  useEffect: (effect: () => void | (() => void)) => { mocks.effects.push(effect); },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, isTauri: () => mocks.native }));
import { DesktopTrayNotice } from "../src/components/DesktopTrayNotice";

let cleanup: (() => void) | void;
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  mocks.native = true;
  mocks.invoke.mockReset().mockResolvedValue(null);
  mocks.set.mockReset();
  mocks.effects.length = 0;
});
afterEach(() => { cleanup?.(); cleanup = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });
function mount() { DesktopTrayNotice(); cleanup = mocks.effects[0](); }

it("does not call desktop IPC in the browser or phone", () => {
  mocks.native = false;
  mount();
  vi.advanceTimersByTime(4000);
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("shows native tray errors and clears them when native state clears", async () => {
  mocks.invoke.mockResolvedValueOnce("Tray unavailable").mockResolvedValue(null);
  mount();
  await flush();
  expect(mocks.set).toHaveBeenLastCalledWith("Tray unavailable");
  await vi.advanceTimersByTimeAsync(2000);
  expect(mocks.set).toHaveBeenLastCalledWith(null);
  expect(mocks.invoke).toHaveBeenCalledWith("desktop_tray_notice");
});

it("does not overlap polls or publish a late reply after unmount", async () => {
  let resolve!: (value: string) => void;
  mocks.invoke.mockReturnValue(new Promise<string>((done) => { resolve = done; }));
  mount();
  vi.advanceTimersByTime(6000);
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  cleanup?.(); cleanup = undefined;
  resolve("Late error");
  await flush();
  vi.advanceTimersByTime(4000);
  expect(mocks.set).not.toHaveBeenCalled();
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
});

it("surfaces failed IPC rather than implying the tray is available", async () => {
  mocks.invoke.mockRejectedValue(new Error("IPC failed"));
  mount();
  await flush();
  expect(mocks.set).toHaveBeenLastCalledWith(expect.stringContaining("Keep this window open"));
});
