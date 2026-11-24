import { beforeEach, describe, expect, it, vi } from "vitest";
import { pluginCatalog, pluginDisconnect, pluginEnable, pluginExecute, pluginOpenDirectory, pluginSnapshot, pluginState } from "../src/lib/nativePlugin";
import { EMPTY_PLUGIN } from "../src/lib/plugin";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), native: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../src/lib/native", () => ({ nativeAvailable: mocks.native }));
beforeEach(() => { mocks.invoke.mockReset().mockResolvedValue(EMPTY_PLUGIN); mocks.native.mockReturnValue(true); });

describe("frozen native plugin command bridge", () => {
  it("maps exact command names and camelCase parameters without extra data", async () => {
    await pluginDisconnect();
    await pluginSnapshot();
    await pluginState();
    await pluginExecute("spotify", "set-volume", { volume: 50 });
    expect(mocks.invoke.mock.calls).toEqual([
      ["plugin_disconnect", {}], ["plugin_snapshot", {}], ["plugin_state", {}],
      ["plugin_execute", { pluginId: "spotify", actionId: "set-volume", args: { volume: 50 } }],
    ]);
  });

  it("maps catalog, enable and fixed directory opening without caller paths", async () => {
    const catalog = { directory: "/home/test/.config/zdeck/plugins", node: { status: "not_found", version: null, path: null }, plugins: [], truncated: false };
    mocks.invoke.mockImplementation(async (command: string) => command === "plugin_catalog" ? catalog : command === "plugin_open_directory" ? null : EMPTY_PLUGIN);
    expect(await pluginCatalog()).toEqual(catalog);
    await pluginEnable("spotify");
    await pluginOpenDirectory();
    expect(mocks.invoke.mock.calls).toEqual([["plugin_catalog", {}], ["plugin_enable", { pluginId: "spotify" }], ["plugin_open_directory", {}]]);
    await expect(pluginEnable("../spotify")).rejects.toMatchObject({ kind: "invalid_arguments", outcome: "not_started" });
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
  });

  it("rejects malformed catalogs and opener responses without exposing raw exception paths", async () => {
    mocks.invoke.mockResolvedValue({ directory: "/private/secret", plugins: [] });
    await expect(pluginCatalog()).rejects.toMatchObject({ kind: "protocol", outcome: "not_started" });
    mocks.invoke.mockResolvedValue("/private/secret");
    await expect(pluginOpenDirectory()).rejects.toMatchObject({ kind: "protocol" });
    mocks.invoke.mockRejectedValue(new Error("/private/secret"));
    await expect(pluginCatalog()).rejects.not.toHaveProperty("message", expect.stringContaining("/private/secret"));
  });

  it("refuses browser use and invalid argument input before invoking Rust", async () => {
    await expect(pluginExecute("../bad", "play", {})).rejects.toMatchObject({ kind: "invalid_arguments" });
    await expect(pluginExecute("spotify", "set-volume", { volume: 1.5 })).rejects.toMatchObject({ kind: "invalid_arguments" });
    expect(mocks.invoke).not.toHaveBeenCalled();
    mocks.native.mockReturnValue(false);
    for (const operation of [pluginCatalog, pluginOpenDirectory, () => pluginEnable("spotify"), pluginDisconnect, pluginSnapshot, pluginState,
      () => pluginExecute("spotify", "play", {})]) await expect(operation()).rejects.toMatchObject({ kind: "unavailable", outcome: "not_started" });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("validates snapshots and normalizes untrusted exceptions without echoing diagnostics", async () => {
    mocks.invoke.mockResolvedValue({ ...EMPTY_PLUGIN, status: "connected" });
    await expect(pluginSnapshot()).rejects.toMatchObject({ kind: "protocol" });
    mocks.invoke.mockResolvedValue("secret");
    await expect(pluginExecute("spotify", "next", {})).rejects.toMatchObject({ kind: "protocol", outcome: "unknown" });
    for (const error of ["secret", new Error("secret"), { kind: "plugin_failed", code: "automation_denied", outcome: "unknown", message: "secret", hint: "secret" }]) {
      mocks.invoke.mockRejectedValue(error);
      try { await pluginState(); throw new Error("expected rejection"); }
      catch (actual) { expect(JSON.stringify(actual)).not.toContain("secret"); }
    }
  });
});
