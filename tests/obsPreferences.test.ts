import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, isTauri } = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri }));
import { obsLoadPreferences, obsSavePreferences, obsForgetPreferences } from "../src/lib/native";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("window", {});
  isTauri.mockReturnValue(true);
});

describe("secure OBS preferences IPC", () => {
  it("loads, saves and forgets through native commands only", async () => {
    const saved = { port: 4455, password: "test password" };
    invoke.mockResolvedValueOnce(saved).mockResolvedValue(undefined);
    await expect(obsLoadPreferences()).resolves.toEqual(saved);
    await obsSavePreferences(saved.port, saved.password);
    await obsForgetPreferences();
    expect(invoke.mock.calls).toEqual([
      ["obs_load_preferences", {}],
      ["obs_save_preferences", saved],
      ["obs_forget_preferences", {}],
    ]);
  });

  it("preserves missing entries and reports storage failures", async () => {
    invoke.mockResolvedValueOnce(null);
    await expect(obsLoadPreferences()).resolves.toBeNull();
    invoke.mockRejectedValue("Could not access secure storage.");
    await expect(obsLoadPreferences()).rejects.toBe("Could not access secure storage.");
    await expect(obsSavePreferences(4455, "")).rejects.toBe("Could not access secure storage.");
    await expect(obsForgetPreferences()).rejects.toBe("Could not access secure storage.");
  });

  it("refuses browser access without invoking IPC", async () => {
    isTauri.mockReturnValue(false);
    await expect(obsLoadPreferences()).rejects.toMatchObject({ kind: "unavailable" });
    await expect(obsSavePreferences(4455, "")).rejects.toMatchObject({ kind: "unavailable" });
    await expect(obsForgetPreferences()).rejects.toMatchObject({ kind: "unavailable" });
    expect(invoke).not.toHaveBeenCalled();
  });
});
