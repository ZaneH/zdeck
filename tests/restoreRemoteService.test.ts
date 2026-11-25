import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ raw: null as string | null, blocked: false, status: vi.fn(), start: vi.fn() }));
vi.mock("../src/lib/persistence", () => ({ getStorage: () => ({ getItem: () => {
  if (fixture.blocked) throw new Error("Storage unavailable");
  return fixture.raw;
} }) }));
vi.mock("../src/lib/nativeRemote", () => ({
  remoteStatus: fixture.status,
  remoteStart: fixture.start,
  toRemoteError: (cause: unknown) => ({ message: cause instanceof Error ? cause.message : "Service unavailable" }),
}));

beforeEach(() => {
  vi.resetModules();
  fixture.raw = null;
  fixture.blocked = false;
  fixture.status.mockReset().mockResolvedValue({ running: false });
  fixture.start.mockReset().mockResolvedValue({ running: true });
});

it("restores on exactly once per launch, without writing a shutdown preference", async () => {
  fixture.raw = JSON.stringify({ origin: "https://computer.tailnet.ts.net", mode: "tailscale" });
  const { restoreRemoteService } = await import("../src/lib/useRestoreRemoteService");
  const first = restoreRemoteService();
  expect(restoreRemoteService()).toBe(first);
  expect(await first).toBeNull();
  expect(fixture.start).toHaveBeenCalledExactlyOnceWith("https://computer.tailnet.ts.net", "tailscale");
  expect(fixture.raw).toContain("computer.tailnet.ts.net");
});

it("does not start a service when desired off, missing, or already running", async () => {
  for (const raw of [null, "false", JSON.stringify({ origin: "https://192.168.1.20:8443", mode: "local_https" })]) {
    vi.resetModules();
    fixture.raw = raw;
    fixture.status.mockResolvedValue({ running: true });
    const { restoreRemoteService } = await import("../src/lib/useRestoreRemoteService");
    expect(await restoreRemoteService()).toBeNull();
  }
  expect(fixture.start).not.toHaveBeenCalled();
});

it("restores Local HTTPS using its saved mode and reports start failure without retry", async () => {
  fixture.raw = JSON.stringify({ origin: "https://192.168.1.20:8443", mode: "local_https" });
  fixture.start.mockRejectedValue(new Error("Port is busy"));
  const { restoreRemoteService } = await import("../src/lib/useRestoreRemoteService");
  expect(await restoreRemoteService()).toContain("Port is busy");
  expect(await restoreRemoteService()).toContain("Open Settings");
  expect(fixture.start).toHaveBeenCalledExactlyOnceWith("https://192.168.1.20:8443", "local_https");
});

it("settings errors resolve to a focused notice rather than preventing launch", async () => {
  for (const blocked of [false, true]) {
    vi.resetModules();
    fixture.raw = "{bad settings";
    fixture.blocked = blocked;
    const { restoreRemoteService } = await import("../src/lib/useRestoreRemoteService");
    expect(await restoreRemoteService()).toContain("Local service was not restored");
  }
  expect(fixture.status).not.toHaveBeenCalled();
  expect(fixture.start).not.toHaveBeenCalled();
});
