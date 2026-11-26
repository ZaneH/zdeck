import { beforeEach, describe, expect, it, vi } from "vitest";
import { desktopRunControl, parseDesktopResult, toDesktopActionError, validDesktopCommand } from "../src/lib/nativeActions";
import type { DesktopCommand } from "../src/lib/nativeActions";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), native: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../src/lib/native", () => ({ nativeAvailable: mocks.native }));
const command = { commandId: "cmd-1", revision: 4, controlId: "ctl_play_pause" };
const result = { id: "cmd-1", state: "confirmed", message: "Action confirmed." };
beforeEach(() => { mocks.invoke.mockReset().mockResolvedValue(result); mocks.native.mockReturnValue(true); });

describe("saved desktop control bridge", () => {
  it("uses the actual flat Tauri JSON body, with no request wrapper, action or args", async () => {
    await desktopRunControl(command);
    await desktopRunControl({ ...command, value: 50 });
    expect(mocks.invoke.mock.calls).toEqual([["desktop_run_control", command], ["desktop_run_control", { ...command, value: 50 }]]);
    expect(Object.hasOwn(mocks.invoke.mock.calls[0][1], "value")).toBe(false);
  });
  it("rejects invalid bounds, IDs, explicit null/undefined and unexpected action payloads before invoke", async () => {
    for (const bad of [{ ...command, commandId: "" }, { ...command, controlId: "bad\n" }, { ...command, revision: -1 },
      { ...command, revision: 1.5 }, { ...command, revision: Number.MAX_SAFE_INTEGER + 1 }, { ...command, value: null },
      { ...command, value: undefined }, { ...command, value: Number.MAX_SAFE_INTEGER + 1 }, { ...command, value: "50" },
      { ...command, action: "plugin" }, { ...command, args: {} }, Object.create(command)]) {
      expect(validDesktopCommand(bad as DesktopCommand)).toBe(false);
      await expect(desktopRunControl(bad as DesktopCommand)).rejects.toMatchObject({ code: "invalid_request", outcome: "not_started" });
    }
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("refuses browser execution and normalizes rejected diagnostics with fixed messages", async () => {
    mocks.native.mockReturnValue(false);
    await expect(desktopRunControl(command)).rejects.toMatchObject({ code: "unavailable", outcome: "not_started" });
    expect(mocks.invoke).not.toHaveBeenCalled();
    mocks.native.mockReturnValue(true);
    for (const code of ["invalid_request", "deck_unavailable", "stale_revision", "control_not_found", "command_conflict", "busy", "capacity"]) {
      mocks.invoke.mockRejectedValue({ code, message: "private-secret" });
      await expect(desktopRunControl(command)).rejects.toMatchObject({ code, outcome: "not_started", message: expect.not.stringContaining("private-secret") });
    }
    for (const error of ["private-secret", new Error("private-secret"), { code: "not_known", message: "private-secret" }]) {
      expect(JSON.stringify(toDesktopActionError(error))).not.toContain("private-secret");
      expect(toDesktopActionError(error).outcome).toBe("unknown");
    }
  });
  it("keeps sent media keys unknown with a distinct non-warning message", () => {
    expect(parseDesktopResult({ ...result, state: "unknown", code: "media_key_sent" }, "cmd-1")).toMatchObject({
      state: "unknown", code: "media_key_sent", message: "Media key sent. Playback state is unavailable.",
    });
    for (const state of ["confirmed", "pending", "failed", "not_applied"]) {
      expect(parseDesktopResult({ ...result, state, code: "media_key_sent" }, "cmd-1")).toBeNull();
    }
  });
  it("validates correlated bounded replies and never exposes observed state or raw messages", async () => {
    for (const state of ["pending", "confirmed", "not_applied", "failed", "unknown"]) expect(parseDesktopResult({ ...result, state }, "cmd-1")?.state).toBe(state);
    const parsed = parseDesktopResult({ ...result, state: "failed", message: "private-secret", observed: { secret: "private-secret" }, code: "plugin_unavailable" }, "cmd-1");
    expect(parsed?.message).toContain("Enable the trusted plugin");
    const unsupported = parseDesktopResult({ ...result, state: "failed", code: "platform_unsupported" }, "cmd-1");
    expect(unsupported?.message).toContain("macOS, Windows, or Linux");
    expect(unsupported?.message).not.toContain("Spotify");
    expect(parseDesktopResult({ ...result, state: "confirmed", code: "platform_unsupported" }, "cmd-1")).toBeNull();
    expect(JSON.stringify(parsed)).not.toContain("private-secret");
    for (const bad of [null, [], { ...result, id: "different" }, { ...result, state: "done" }, { ...result, message: "" },
      { ...result, message: "x".repeat(513) }, { ...result, message: "bad\n" }, { ...result, code: "untrusted" },
      { ...result, code: "plugin_outcome_unknown" }, { ...result, code: "plugin_unavailable" },
      { ...result, observed: [] }, { ...result, observed: { huge: "x".repeat(131072) } }, { ...result, type: "result" }]) {
      expect(parseDesktopResult(bad, "cmd-1")).toBeNull();
      mocks.invoke.mockResolvedValue(bad);
      await expect(desktopRunControl(command)).rejects.toMatchObject({ outcome: "unknown" });
    }
  });
});
