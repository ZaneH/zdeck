import { beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), forget: vi.fn() }));
vi.mock("../src/lib/native", () => ({
  obsLoadPreferences: ipc.load, obsSavePreferences: ipc.save, obsForgetPreferences: ipc.forget,
}));
import { forgetObsPreferences, loadObsPreferences, resetObsPreferencesCache, saveObsPreferences } from "../src/lib/obsPreferences";

const saved = { port: 4466, password: "test password" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  resetObsPreferencesCache();
  ipc.load.mockResolvedValue(null);
  ipc.save.mockResolvedValue(undefined);
  ipc.forget.mockResolvedValue(undefined);
});

describe("OBS preferences session cache", () => {
  it("shares one native read across concurrent mounts and remounts", async () => {
    ipc.load.mockResolvedValue(saved);
    const [first, second] = await Promise.all([loadObsPreferences(), loadObsPreferences()]);
    expect(first).toBe(saved);
    expect(second).toBe(saved);
    await expect(loadObsPreferences()).resolves.toBe(saved);
    expect(ipc.load).toHaveBeenCalledTimes(1);
  });

  it("remembers an empty store without reading again", async () => {
    await expect(loadObsPreferences()).resolves.toBeNull();
    await expect(loadObsPreferences()).resolves.toBeNull();
    expect(ipc.load).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed read, so a later mount retries", async () => {
    ipc.load.mockRejectedValueOnce(new Error("locked"));
    await expect(loadObsPreferences()).rejects.toThrow("locked");
    ipc.load.mockResolvedValueOnce(saved);
    await expect(loadObsPreferences()).resolves.toBe(saved);
    expect(ipc.load).toHaveBeenCalledTimes(2);
  });

  it("refreshes the cache after a successful save and after forget", async () => {
    await loadObsPreferences();
    await saveObsPreferences(saved.port, saved.password);
    await expect(loadObsPreferences()).resolves.toEqual(saved);
    await forgetObsPreferences();
    await expect(loadObsPreferences()).resolves.toBeNull();
    expect(ipc.load).toHaveBeenCalledTimes(1);
    expect(ipc.save).toHaveBeenCalledWith(saved.port, saved.password);
    expect(ipc.forget).toHaveBeenCalledTimes(1);
  });

  it("never caches a failed save", async () => {
    ipc.load.mockResolvedValue({ port: 4455, password: "old" });
    await loadObsPreferences();
    ipc.save.mockRejectedValueOnce(new Error("locked"));
    await expect(saveObsPreferences(4466, "new")).rejects.toThrow("locked");
    await expect(loadObsPreferences()).resolves.toEqual({ port: 4455, password: "old" });
    expect(ipc.load).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale in-flight read restore forgotten credentials", async () => {
    const pending = deferred<typeof saved>();
    ipc.load.mockReturnValue(pending.promise);
    const loading = loadObsPreferences();
    await forgetObsPreferences();
    pending.resolve(saved);
    await expect(loading).resolves.toBeNull();
    await expect(loadObsPreferences()).resolves.toBeNull();
  });

});
