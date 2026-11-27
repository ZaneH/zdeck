import { beforeEach, expect, it, vi } from "vitest";
import { registryOpenWebsite, registryWebsiteStatus } from "../src/lib/nativePluginRegistry";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), native: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../src/lib/native", () => ({ nativeAvailable: mocks.native }));
beforeEach(() => { mocks.invoke.mockReset().mockResolvedValue(null); mocks.native.mockReturnValue(true); });
it("uses a fixed native opener with no caller-provided URL or command", async () => {
  await registryOpenWebsite();
  mocks.invoke.mockResolvedValue({ available: false, explanation: "Not configured." });
  expect(await registryWebsiteStatus()).toEqual({ available: false, explanation: "Not configured." });
  expect(mocks.invoke.mock.calls).toEqual([["plugin_registry_open_website", {}], ["plugin_registry_website_status", {}]]);
});
it("rejects malformed availability and uncertain opener replies", async () => {
  for (const value of [null, [], {}, { available: true, explanation: "misleading" }, { available: false, explanation: null }, { available: false, explanation: "\nraw" }, { available: true, explanation: null, url: "https://evil.test" }]) {
    mocks.invoke.mockResolvedValue(value); await expect(registryWebsiteStatus()).rejects.toThrow();
  }
  mocks.invoke.mockResolvedValue({ available: true, explanation: null });
  expect(await registryWebsiteStatus()).toEqual({ available: true, explanation: null });
  await expect(registryOpenWebsite()).rejects.toThrow("could not be confirmed");
});
it("does not call native IPC in browser preview", async () => {
  mocks.native.mockReturnValue(false);
  expect((await registryWebsiteStatus()).available).toBe(false);
  await expect(registryOpenWebsite()).rejects.toThrow("desktop app");
  expect(mocks.invoke).not.toHaveBeenCalled();
});
