import { describe, expect, it } from "vitest";
import {
  systemFailureState,
  systemMediaPlayPause,
  systemMediaSnapshot,
  systemMicrophoneSnapshot,
  systemOutputSnapshot,
  systemSetMicrophoneMuted,
  systemSetOutputVolume,
  toSystemError,
} from "../src/lib/native";
import { clampTarget, formatPercent } from "../src/lib/useSystemConsole";

describe("native system bridge", () => {
  it("keeps well-formed typed system errors", () => {
    expect(
      toSystemError({ kind: "no_player", message: "No media player is available." }),
    ).toEqual({
      kind: "no_player",
      message: "No media player is available.",
    });
  });

  it("sanitizes unknown and raw string errors instead of echoing them", () => {
    expect(toSystemError("wpctl: couldn't connect to session bus")).toEqual({
      kind: "command_failed",
      message: "The system command failed.",
    });
    expect(toSystemError(null)).toMatchObject({ kind: "command_failed" });
    expect(toSystemError({ kind: "not_a_real_kind", message: "x" })).toMatchObject({
      kind: "command_failed",
    });
  });

  it("fills in a safe message when a typed error carries none", () => {
    expect(toSystemError({ kind: "tool_missing" })).toEqual({
      kind: "tool_missing",
      message: "A required system tool is not installed.",
    });
  });

  it("treats a timeout as unknown, since the tool may have applied the change", () => {
    expect(systemFailureState({ kind: "timeout", message: "Timed out." })).toBe("unknown");
    expect(systemFailureState({ kind: "outcome_unknown", message: "Readback failed." })).toBe("unknown");
  });

  it("treats a missing player or tool as failed, not unknown", () => {
    expect(systemFailureState({ kind: "no_player", message: "No player." })).toBe("failed");
    expect(systemFailureState({ kind: "tool_missing", message: "No tool." })).toBe("failed");
  });

  it("never reports a boosted display volume as clamped", () => {
    expect(formatPercent(150)).toBe("150%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(Number.NaN)).toBe("unknown");
  });

  it("clamps only the user-selected apply target", () => {
    expect(clampTarget(Number.NaN)).toBe(50);
    expect(clampTarget(-5)).toBe(0);
    expect(clampTarget(42.6)).toBe(43);
    expect(clampTarget(150)).toBe(100);
  });

  it("refuses native system commands in a browser", async () => {
    await expect(systemOutputSnapshot()).rejects.toMatchObject({ kind: "unsupported" });
    await expect(systemSetOutputVolume(50)).rejects.toMatchObject({ kind: "unsupported" });
    await expect(systemMicrophoneSnapshot()).rejects.toMatchObject({ kind: "unsupported" });
    await expect(systemSetMicrophoneMuted(true)).rejects.toMatchObject({
      kind: "unsupported",
    });
    await expect(systemMediaSnapshot()).rejects.toMatchObject({ kind: "unsupported" });
    await expect(systemMediaPlayPause()).rejects.toMatchObject({ kind: "unsupported" });
  });
});
