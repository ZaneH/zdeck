import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ raw: null as string | null, blocked: false, storage: vi.fn(), status: vi.fn(), start: vi.fn() }));
vi.mock("../src/lib/persistence", () => ({ getStorage: fixture.storage }));
vi.mock("../src/lib/nativeRemote", () => ({
  remoteStatus: fixture.status,
  remoteStart: fixture.start,
  toRemoteError: (cause: unknown) => ({ message: cause instanceof Error ? cause.message : "Service unavailable" }),
}));

beforeEach(() => {
  vi.resetModules();
  fixture.raw = null;
  fixture.blocked = false;
  fixture.storage.mockReset().mockImplementation(() => ({ getItem: () => {
    if (fixture.blocked) throw new Error("Storage unavailable");
    return fixture.raw;
  } }));
  fixture.status.mockReset().mockResolvedValue({ running: false, error: null });
  fixture.start.mockReset();
});

it("reads native startup status exactly once per launch, including remounts", async () => {
  const { restoreRemoteService } = await import("../src/lib/useRestoreRemoteService");
  const first = restoreRemoteService();
  expect(restoreRemoteService()).toBe(first);
  expect(await first).toBeNull();
  expect(fixture.status).toHaveBeenCalledTimes(1);
  expect(fixture.start).not.toHaveBeenCalled();
});

it("never overrides native Stop or running state with legacy browser preferences", async () => {
  for (const running of [false, true]) {
    for (const raw of [null, "false", JSON.stringify({ origin: "https://computer.tailnet.ts.net", mode: "tailscale" }), JSON.stringify({ origin: "https://192.168.1.20:8443", mode: "local_https" }), "{bad settings"]) {
      vi.resetModules();
      fixture.raw = raw;
      fixture.status.mockResolvedValue({ running, error: null });
      const { restoreRemoteService } = await import("../src/lib/useRestoreRemoteService");
      expect(await restoreRemoteService()).toBeNull();
    }
  }
  expect(fixture.storage).not.toHaveBeenCalled();
  expect(fixture.start).not.toHaveBeenCalled();
});

it("surfaces native bind or persistence failures without starting or retrying", async () => {
  for (const error of ["Port is busy", "Saved service settings are invalid"]) {
    vi.resetModules();
    fixture.status.mockClear().mockResolvedValue({ running: false, error });
    const { restoreRemoteService } = await import("../src/lib/useRestoreRemoteService");
    expect(await restoreRemoteService()).toContain(error);
    expect(await restoreRemoteService()).toContain("Open Settings");
    expect(fixture.status).toHaveBeenCalledTimes(1);
  }
  expect(fixture.start).not.toHaveBeenCalled();
});

it("status errors resolve to a focused notice rather than preventing launch", async () => {
  fixture.status.mockRejectedValue(new Error("Native service unavailable"));
  const { restoreRemoteService } = await import("../src/lib/useRestoreRemoteService");
  expect(await restoreRemoteService()).toContain("Could not check the local service. Native service unavailable");
  expect(await restoreRemoteService()).toContain("Open Settings");
  expect(fixture.status).toHaveBeenCalledTimes(1);
  expect(fixture.start).not.toHaveBeenCalled();
});

it("does not depend on browser storage availability", async () => {
  fixture.blocked = true;
  const { restoreRemoteService } = await import("../src/lib/useRestoreRemoteService");
  expect(await restoreRemoteService()).toBeNull();
  expect(fixture.storage).not.toHaveBeenCalled();
});
