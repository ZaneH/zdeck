import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  isTauri: mocks.isTauri,
}));

import {
  REMOTE_ERROR_KINDS,
  invitationExpired,
  remoteApproveDevice,
  remoteCreateInvitation,
  remoteDenyDevice,
  remoteListDevices,
  remoteRevokeDevice,
  remoteStart,
  remoteStatus,
  remoteStop,
  parseRemoteStatus,
  toRemoteError,
} from "../src/lib/nativeRemote";

const STOPPED = {
  running: false,
  mode: null,
  origin: null,
  port: null,
  pendingDevices: 0,
  approvedDevices: 0,
  connectedSockets: 0,
};

beforeEach(() => {
  // nativeAvailable() checks for a window before isTauri(); provide a minimal
  // one so the mocked Tauri flag is what decides native mode.
  Object.defineProperty(globalThis, "window", {
    value: {},
    configurable: true,
    writable: true,
  });
  mocks.invoke.mockReset();
  mocks.isTauri.mockReset();
  mocks.isTauri.mockReturnValue(false);
});

describe("native remote admin bridge", () => {
  it("refuses every command in a browser and never calls invoke", async () => {
    await expect(remoteStart("https://host.ts.net")).rejects.toMatchObject({
      kind: "unavailable",
    });
    await expect(remoteStop()).rejects.toMatchObject({ kind: "unavailable" });
    await expect(remoteStatus()).rejects.toMatchObject({ kind: "unavailable" });
    await expect(remoteCreateInvitation()).rejects.toMatchObject({
      kind: "unavailable",
    });
    await expect(remoteListDevices()).rejects.toMatchObject({
      kind: "unavailable",
    });
    await expect(remoteApproveDevice("req_1")).rejects.toMatchObject({
      kind: "unavailable",
    });
    await expect(remoteDenyDevice("req_1")).rejects.toMatchObject({
      kind: "unavailable",
    });
    await expect(remoteRevokeDevice("req_1")).rejects.toMatchObject({
      kind: "unavailable",
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("passes the origin to remote_start", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.invoke.mockResolvedValue({ ...STOPPED, running: true, mode: "tailscale", origin: "https://computer.tailnet-name.ts.net", port: 45829 });
    await remoteStart("https://computer.tailnet-name.ts.net");
    expect(mocks.invoke).toHaveBeenCalledWith("remote_start", {
      origin: "https://computer.tailnet-name.ts.net", mode: "tailscale",
    });
  });

  it("passes local mode and canonical origin explicitly and validates the returned mode", async () => {
    mocks.isTauri.mockReturnValue(true);
    const local = { ...STOPPED, running: true, mode: "local_https", origin: "https://deck.lan:8443", port: 45829 };
    mocks.invoke.mockResolvedValue(local);
    await expect(remoteStart("HTTPS://Deck.LAN:8443/", "local_https")).resolves.toEqual(local);
    expect(mocks.invoke).toHaveBeenCalledWith("remote_start", { origin: local.origin, mode: "local_https" });
    mocks.invoke.mockResolvedValue(STOPPED);
    await expect(remoteStart(local.origin, "local_https")).rejects.toMatchObject({ kind: "internal" });
    await expect(remoteStart("https://example.com", "local_https")).rejects.toMatchObject({ kind: "invalid_origin" });
  });

  it("rejects missing/unknown/mismatched status modes without guessing a default", () => {
    const local = { ...STOPPED, running: true, mode: "local_https", origin: "https://192.168.1.20:8443", port: 45829 };
    expect(parseRemoteStatus(local)).toEqual(local);
    for (const bad of [{ ...STOPPED, mode: undefined }, { ...local, mode: undefined }, { ...local, mode: "other" },
      { ...local, mode: "tailscale" }, { ...local, origin: "https://8.8.8.8" }, { ...local, port: 0 },
      { ...local, pendingDevices: -1 }, { ...STOPPED, mode: "local_https" }]) expect(parseRemoteStatus(bad)).toBeNull();
  });

  it("uses empty args for status, stop, invitation, and device list", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.invoke.mockResolvedValue(STOPPED);
    await remoteStop();
    await remoteStatus();
    await remoteCreateInvitation();
    await remoteListDevices();
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "remote_stop", {});
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "remote_status", {});
    expect(mocks.invoke).toHaveBeenNthCalledWith(
      3,
      "remote_create_invitation",
      {},
    );
    expect(mocks.invoke).toHaveBeenNthCalledWith(4, "remote_list_devices", {});
  });

  it("passes requestId to approve, deny, and revoke", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.invoke.mockResolvedValue({ requestId: "req_1", name: "Phone" });
    await remoteApproveDevice("req_1");
    await remoteDenyDevice("req_2");
    await remoteRevokeDevice("req_3");
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "remote_approve_device", {
      requestId: "req_1",
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "remote_deny_device", {
      requestId: "req_2",
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, "remote_revoke_device", {
      requestId: "req_3",
    });
  });

  it("preserves native startup and Stop persistence warnings alongside usable status", async () => {
    mocks.isTauri.mockReturnValue(true);
    const warning = { ...STOPPED, error: "Service paused, but auto-start could not be disabled. Check app-data permissions." };
    mocks.invoke.mockResolvedValue(warning);
    await expect(remoteStop()).resolves.toEqual(warning);
    await expect(remoteStatus()).resolves.toEqual(warning);
    expect(parseRemoteStatus({ ...STOPPED, error: null })).toEqual(STOPPED);
  });

  it("returns the stopped status unchanged", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.invoke.mockResolvedValue(STOPPED);
    await expect(remoteStatus()).resolves.toEqual(STOPPED);
  });

  it("propagates a typed native error for the caller to sanitize", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.invoke.mockRejectedValue({
      kind: "already_running",
      message: "The private phone service is already running.",
    });
    await expect(remoteStart("https://host.ts.net")).rejects.toMatchObject({
      kind: "already_running",
    });
  });
});

describe("remote error normalization", () => {
  it("keeps every well-formed typed error", () => {
    for (const kind of REMOTE_ERROR_KINDS) {
      expect(toRemoteError({ kind, message: "detail" })).toEqual({
        kind,
        message: "detail",
      });
    }
  });

  it("sanitizes unknown and raw values instead of echoing them", () => {
    expect(toRemoteError("raw socket text with a secret")).toEqual({
      kind: "internal",
      message: "The phone connection service could not complete that operation.",
    });
    expect(toRemoteError(new Error("boom"))).toMatchObject({ kind: "internal" });
    expect(toRemoteError({ kind: "not_a_kind", message: "x" })).toMatchObject({
      kind: "internal",
    });
  });

  it("fills in a safe message when a typed error carries none", () => {
    expect(toRemoteError({ kind: "not_running" })).toEqual({
      kind: "not_running",
      message: "The phone connection service is not running.",
    });
    expect(toRemoteError({ kind: "invalid_origin", message: "   " })).toEqual({
      kind: "invalid_origin",
      message: "Use a valid HTTPS address for the selected connection mode, without credentials, path, query or fragment.",
    });
  });
});

describe("invitation expiry", () => {
  it("is false before the server-provided expiry and true at or after it", () => {
    expect(invitationExpired(2000, 1999)).toBe(false);
    expect(invitationExpired(2000, 2000)).toBe(true);
    expect(invitationExpired(2000, 2001)).toBe(true);
  });
});
