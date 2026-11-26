import { beforeEach, describe, expect, it, vi } from "vitest";
import { pluginCatalog, pluginDiagnostics, pluginDisconnect, pluginEnable, pluginExecute, pluginOpenDirectory, pluginSettingsForget, pluginSettingsLoad, pluginSettingsSave, pluginSnapshot, pluginSnapshots, pluginState, pluginTrust, pluginUninstall } from "../src/lib/nativePlugin";
import { EMPTY_PLUGIN } from "../src/lib/plugin";
const IDENTITY = "0123456789abcdef".repeat(4);
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), native: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../src/lib/native", () => ({ nativeAvailable: mocks.native }));
beforeEach(() => { mocks.invoke.mockReset().mockResolvedValue(EMPTY_PLUGIN); mocks.native.mockReturnValue(true); });

describe("per-plugin native command bridge", () => {
  it("routes each operation by pluginId without paths or extra action data", async () => {
    await pluginDisconnect("spotify"); await pluginSnapshot("notes"); await pluginState("spotify");
    await pluginExecute("notes", "next", {}); await pluginEnable("spotify");
    mocks.invoke.mockResolvedValue(null); await pluginTrust("spotify", IDENTITY);
    expect(mocks.invoke.mock.calls).toEqual([
      ["plugin_disconnect", { pluginId: "spotify" }], ["plugin_snapshot", { pluginId: "notes" }], ["plugin_state", { pluginId: "spotify" }],
      ["plugin_execute", { pluginId: "notes", actionId: "next", args: {} }], ["plugin_enable", { pluginId: "spotify" }],
      ["plugin_trust", { pluginId: "spotify", expectedIdentity: IDENTITY }],
    ]);
  });
  it("reads cached aggregate snapshots and rejects cross-plugin identity", async () => {
    mocks.invoke.mockResolvedValue({ spotify: EMPTY_PLUGIN, notes: EMPTY_PLUGIN });
    expect(await pluginSnapshots()).toEqual({ spotify: EMPTY_PLUGIN, notes: EMPTY_PLUGIN });
    expect(mocks.invoke).toHaveBeenCalledWith("plugin_snapshots", {});
    const wrong = { status: "connected", manifest: { id: "notes", version: "1.0.0", protocolVersion: 1, actions: [{ id: "next", title: "Next", config: {} }] }, state: null, lastError: null };
    mocks.invoke.mockResolvedValue(wrong); await expect(pluginSnapshot("spotify")).rejects.toMatchObject({ kind: "protocol" });
    mocks.invoke.mockResolvedValue({ spotify: wrong }); await expect(pluginSnapshots()).rejects.toMatchObject({ kind: "protocol" });
  });
  it("diagnoses and reversibly uninstalls only the named plugin; validates replies", async () => {
    mocks.invoke.mockResolvedValue({ pluginId: "spotify", checks: [{ name: "SDK", status: "fail", message: "raw secret" }] });
    const diagnostics = await pluginDiagnostics("spotify");
    expect(JSON.stringify(diagnostics)).not.toContain("raw secret"); expect(diagnostics.checks[0].message).toContain("complete packaged");
    mocks.invoke.mockResolvedValue(null); await pluginUninstall("notes");
    expect(mocks.invoke.mock.calls).toEqual([["plugin_diagnostics", { pluginId: "spotify" }], ["plugin_uninstall", { pluginId: "notes" }]]);
    mocks.invoke.mockResolvedValue({ pluginId: "notes", checks: [] }); await expect(pluginDiagnostics("spotify")).rejects.toMatchObject({ kind: "protocol" });
    mocks.invoke.mockResolvedValue("secret"); await expect(pluginUninstall("spotify")).rejects.toMatchObject({ kind: "protocol" });
  });
  it("maps safe catalog and fixed opener commands", async () => {
    const catalog = { directory: "/example/plugins", node: { status: "not_found", version: null, path: null }, plugins: [] };
    mocks.invoke.mockImplementation(async (command: string) => command === "plugin_catalog" ? catalog : null);
    expect(await pluginCatalog()).toEqual(catalog); await pluginOpenDirectory();
    expect(mocks.invoke.mock.calls).toEqual([["plugin_catalog", {}], ["plugin_open_directory", {}]]);
  });
  it("rejects invalid IDs and browser operations before invoke", async () => {
    for (const operation of [pluginEnable, (pluginId: string) => pluginTrust(pluginId, IDENTITY), pluginDisconnect, pluginSnapshot, pluginState, pluginDiagnostics, pluginUninstall])
      await expect(operation("../bad")).rejects.toMatchObject({ kind: "invalid_arguments" });
    await expect(pluginTrust("spotify", "not-an-identity")).rejects.toMatchObject({ kind: "invalid_arguments" });
    await expect(pluginExecute("spotify", "set-volume", { volume: 1.5 })).rejects.toMatchObject({ kind: "invalid_arguments" });
    expect(mocks.invoke).not.toHaveBeenCalled(); mocks.native.mockReturnValue(false);
    for (const operation of [pluginCatalog, pluginSnapshots, pluginOpenDirectory, () => pluginEnable("spotify"), () => pluginState("spotify"), () => pluginUninstall("spotify")])
      await expect(operation()).rejects.toMatchObject({ kind: "unavailable", outcome: "not_started" });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("loads only redacted settings and saves or forgets the declared fields separately", async () => {
    const view = { values: { url: "https://example.invalid" }, secretConfigured: { token: true } };
    mocks.invoke.mockImplementation(async (command: string) => command === "plugin_settings_load" ? view : null);
    expect(await pluginSettingsLoad("home-assistant")).toEqual(view);
    await pluginSettingsSave("home-assistant", { url: "https://example.invalid" }, { token: "example-token" });
    await pluginSettingsForget("home-assistant", "token");
    expect(mocks.invoke.mock.calls).toEqual([
      ["plugin_settings_load", { pluginId: "home-assistant" }],
      ["plugin_settings_save", { pluginId: "home-assistant", values: { url: "https://example.invalid" }, secrets: { token: "example-token" } }],
      ["plugin_settings_forget", { pluginId: "home-assistant", key: "token" }],
    ]);
    const loaded = await pluginSettingsLoad("home-assistant");
    expect(JSON.stringify(loaded)).not.toContain("example-token");
    for (const bad of [{ values: { token: "example-token" }, secretConfigured: { token: true } },
      { values: { url: 1 }, secretConfigured: {} }, { values: {}, secretConfigured: { token: "yes" } },
      { values: {}, secretConfigured: {}, extra: true }]) {
      mocks.invoke.mockResolvedValue(bad);
      await expect(pluginSettingsLoad("home-assistant")).rejects.toMatchObject({ kind: "protocol" });
    }
    mocks.invoke.mockResolvedValue("secret");
    await expect(pluginSettingsSave("home-assistant", {}, {})).rejects.toMatchObject({ kind: "protocol" });
    await expect(pluginSettingsForget("home-assistant", "token")).rejects.toMatchObject({ kind: "protocol" });
  });
  it("rejects invalid settings IDs and browser operations before invoke", async () => {
    for (const operation of [pluginSettingsLoad, (id: string) => pluginSettingsSave(id, {}, {}), (id: string) => pluginSettingsForget(id, "token"), (id: string) => pluginSettingsForget("home-assistant", id)]) {
      await expect(operation("../bad")).rejects.toMatchObject({ kind: "invalid_arguments" });
    }
    expect(mocks.invoke).not.toHaveBeenCalled();
    mocks.native.mockReturnValue(false);
    for (const operation of [() => pluginSettingsLoad("home-assistant"), () => pluginSettingsSave("home-assistant", {}, {}), () => pluginSettingsForget("home-assistant", "token")]) {
      await expect(operation()).rejects.toMatchObject({ kind: "unavailable", outcome: "not_started" });
    }
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("normalizes rejected diagnostics without raw error reflection", async () => {
    for (const error of ["secret", new Error("secret"), { kind: "plugin_failed", outcome: "unknown", message: "secret", hint: "secret" }]) {
      mocks.invoke.mockRejectedValue(error);
      await expect(pluginState("spotify")).rejects.not.toHaveProperty("message", expect.stringContaining("secret"));
    }
  });
});
