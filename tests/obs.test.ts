import { describe, expect, it } from "vitest";
import {
  nativeAvailable,
  obsConnect,
  obsDisconnect,
  obsSnapshot,
  obsSwitchScene,
  sceneSwitchFailureState,
  toObsError,
} from "../src/lib/native";

describe("native OBS bridge", () => {
  it("reports browser mode when not inside the Tauri shell", () => {
    expect(nativeAvailable()).toBe(false);
  });

  it("keeps well-formed typed OBS errors", () => {
    expect(
      toObsError({ kind: "auth_rejected", message: "OBS rejected the password." }),
    ).toEqual({
      kind: "auth_rejected",
      message: "OBS rejected the password.",
    });
  });

  it("sanitizes unknown and raw string errors instead of echoing them", () => {
    expect(toObsError("raw server text with a secret")).toEqual({
      kind: "request_failed",
      message: "The OBS request failed.",
    });
    expect(toObsError(null)).toEqual({
      kind: "request_failed",
      message: "The OBS request failed.",
    });
    expect(toObsError({ kind: "not_a_real_kind", message: "x" })).toMatchObject({
      kind: "request_failed",
    });
  });

  it("fills in a safe message when a typed error carries none", () => {
    expect(toObsError({ kind: "timeout" })).toEqual({
      kind: "timeout",
      message: "OBS did not respond in time.",
    });
  });

  it.each(["timeout", "disconnected"] as const)(
    "treats a switch with %s as unknown, since OBS may already have applied it",
    (kind) => {
      expect(sceneSwitchFailureState({ kind, message: "Connection lost." })).toBe("unknown");
    },
  );

  it("keeps an explicit OBS rejection as failed", () => {
    expect(sceneSwitchFailureState({ kind: "request_failed", message: "OBS rejected the request." })).toBe("failed");
  });

  it("refuses native OBS commands in a browser", async () => {
    await expect(obsConnect(4455, "hunter2")).rejects.toMatchObject({
      kind: "unavailable",
    });
    await expect(obsDisconnect()).rejects.toMatchObject({ kind: "unavailable" });
    await expect(obsSnapshot()).rejects.toMatchObject({ kind: "unavailable" });
    await expect(obsSwitchScene("Scene A")).rejects.toMatchObject({
      kind: "unavailable",
    });
  });
});
