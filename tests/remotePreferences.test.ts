import { describe, expect, it, vi } from "vitest";
import { loadRemoteMode, rememberRemoteMode, LOCAL_REMOTE_ORIGIN_KEY, REMOTE_MODE_KEY, loadRemoteOrigin, normalizeRemoteOrigin, rememberRemoteOrigin, REMOTE_ORIGIN_KEY } from "../src/lib/remotePreferences";
import type { StorageLike } from "../src/lib/types";

function memory(initial: string | null = null) {
  let value = initial;
  return { getItem: vi.fn(() => value), setItem: vi.fn((_key: string, next: string) => { value = next; }) };
}

describe("non-secret remote origin preference", () => {
  it("normalizes only HTTPS tailnet origins on the default port", () => {
    for (const value of ["https://computer.tailnet.ts.net", "https://COMPUTER.tailnet.ts.net:443/", "HTTPS://computer.tailnet.ts.net/"]) {
      expect(normalizeRemoteOrigin(value)).toBe("https://computer.tailnet.ts.net");
    }
  });

  it("rejects pairing tokens, paths, queries, fragments, credentials and unsupported origins without stripping secrets", () => {
    for (const value of [" https://computer.tailnet.ts.net", "https://computer.tailnet.ts.net:443\n", null, {}, 443, "", "http://computer.tailnet.ts.net", "https://computer.tailnet.ts.net:45829",
      "https://computer.example.com", "https://ts.net", "https://.ts.net", "https://computer.tailnet.ts.net.",
      "https://user:secret@computer.tailnet.ts.net", "https://@computer.tailnet.ts.net", "https://computer.tailnet.ts.net/path",
      "https://computer.tailnet.ts.net/path/..", "https://computer.tailnet.ts.net/?token=secret", "https://computer.tailnet.ts.net/?",
      "https://computer.tailnet.ts.net/#/pair?invite=" + "a".repeat(64), "https://computer.tailnet.ts.net/#",
      "https://computer.tailnet.ts.net\\", "https://com\tputer.tailnet.ts.net", "a".repeat(64), "https://" + "x".repeat(4096) + ".ts.net",
      JSON.stringify({ origin: "https://computer.tailnet.ts.net", invitation: "secret" }),
    ]) expect(normalizeRemoteOrigin(value)).toBeNull();
  });

  it("remembers only successful starts in its separate key, and loads after a simulated restart", () => {
    const storage = memory();
    expect(rememberRemoteOrigin(storage, "https://HOST.tailnet.ts.net:443/", true)).toBe(true);
    expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(REMOTE_ORIGIN_KEY, "https://host.tailnet.ts.net");
    expect(loadRemoteOrigin(storage)).toBe("https://host.tailnet.ts.net");
    expect(storage.getItem).toHaveBeenCalledWith(REMOTE_ORIGIN_KEY);
    expect(loadRemoteOrigin(memory(storage.getItem()))).toBe("https://host.tailnet.ts.net");
    expect(storage.setItem.mock.calls.flat().join(" ")).not.toMatch(/invite|cookie|approval|token/);
  });

  it("failed starts and invalid drafts never overwrite the last successful address", () => {
    const storage = memory("https://previous.tailnet.ts.net");
    expect(rememberRemoteOrigin(storage, "https://new.tailnet.ts.net", false)).toBe(false);
    for (const value of ["draft", "https://new.tailnet.ts.net/?token=secret", "https://new.tailnet.ts.net/#/pair?invite=secret"]) {
      expect(rememberRemoteOrigin(storage, value, true)).toBe(false);
    }
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(loadRemoteOrigin(storage)).toBe("https://previous.tailnet.ts.net");
  });

  it("treats unavailable/full storage and corrupt values as nonfatal, without writes on load", () => {
    const throwing: StorageLike = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); } };
    expect(loadRemoteOrigin(null)).toBe("");
    expect(loadRemoteOrigin(throwing)).toBe("");
    expect(rememberRemoteOrigin(null, "https://host.tailnet.ts.net", true)).toBe(false);
    expect(rememberRemoteOrigin(throwing, "https://host.tailnet.ts.net", true)).toBe(false);
    for (const value of ["{broken", "https://host.tailnet.ts.net/?token=secret", "a".repeat(64)]) {
      const storage = memory(value);
      expect(loadRemoteOrigin(storage)).toBe("");
      expect(storage.setItem).not.toHaveBeenCalled();
      expect(storage.getItem()).toBe(value);
    }
  });
});

// The same representative acceptance/rejection cases as Rust remote_service.rs.
describe("mode-specific backend parity and preferences", () => {
  it("canonicalizes local RFC1918, ULA/link-local IPv6 and local DNS with explicit ports", () => {
    for (const [input, canonical] of [
      ["https://deck.local", "https://deck.local"], ["HTTPS://Deck.LAN:8443/", "https://deck.lan:8443"],
      ["https://room.deck.home.arpa:443", "https://room.deck.home.arpa"], ["https://10.0.0.1:1", "https://10.0.0.1:1"],
      ["https://172.16.0.1:8443", "https://172.16.0.1:8443"], ["https://172.31.255.255:65535", "https://172.31.255.255:65535"],
      ["https://192.168.0.1:443", "https://192.168.0.1"], ["https://[fc00::1]:8443", "https://[fc00::1]:8443"],
      ["https://[FD00:0:0:0:0:0:0:1]:8443", "https://[fd00::1]:8443"], ["https://[fe80::1]:8443", "https://[fe80::1]:8443"],
      ["https://[febf::1]", "https://[febf::1]"],
    ]) { expect(normalizeRemoteOrigin(input, "local_https"), input).toBe(canonical); expect(normalizeRemoteOrigin(input, "tailscale")).toBeNull(); }
  });
  it("rejects public/loopback addresses, aliases, parser repairs and secret-bearing URLs", () => {
    for (const input of [
      "http://deck.local", "https://example.com", "https://deck.ts.net", "https://localhost", "https://localhost.local",
      "https://127.0.0.1", "https://127.1.2.3", "https://0.0.0.0", "https://8.8.8.8", "https://224.0.0.1",
      "https://169.254.1.1", "https://100.64.0.1", "https://172.15.0.1", "https://172.32.0.1", "https://192.169.0.1",
      "https://[::]", "https://[::1]", "https://[::ffff:192.168.1.1]", "https://[2001:db8::1]", "https://[ff02::1]", "https://[fec0::1]",
      "https://[fe80::1%25en0]", "https://10.1", "https://0x0a000001", "https://167772161", "https://010.0.0.1", "https://10.0.0.01",
      "https://deck.local.", "https://deck.local:0", "https://deck.local:65536", "https://deck.local:", "https://deck.local:08443",
      "https://user@deck.local", "https://user:password@deck.local", "https://@deck.local", "https://deck.local/path", "https://deck.local/.",
      "https://deck.local/..", "https://deck.local//", "https://deck.local?", "https://deck.local#", "https://deck.local/?token=secret",
      "https://deck.local/#/pair?invite=secret", " https://deck.local", "https://deck.local ", "https://deck%2elocal", "https:///deck.local",
      "https://déck.local", "https://*.local", "https://-deck.local", "https://deck-.local", "https://deck_name.local", "https://deck..local",
      "https://.local", "https://local", "https://home.arpa", "https://deck.local.example.com", "https://[fd00::1]:443:8443",
      "https://" + "x".repeat(64) + ".local", "https://" + ("x".repeat(63) + ".").repeat(4) + "local",
      "https://deck.local:443\n", "https://deck.\tlocal", "https://deck.local\\evil",
    ]) expect(normalizeRemoteOrigin(input, "local_https"), input).toBeNull();
  });
  it("reads the legacy tailnet key without writes, keeps addresses separate, and stores only explicit safe modes", () => {
    const values = new Map([[REMOTE_ORIGIN_KEY, "https://old.ts.net"]]);
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: vi.fn((key: string, value: string) => { values.set(key, value); }) };
    expect(loadRemoteMode(storage)).toBe("tailscale");
    expect(loadRemoteOrigin(storage)).toBe("https://old.ts.net");
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(rememberRemoteOrigin(storage, "https://192.168.1.20:8443", false, "local_https")).toBe(false);
    expect(rememberRemoteOrigin(storage, "https://192.168.1.20:8443/#/pair?invite=secret", true, "local_https")).toBe(false);
    expect(values.has(LOCAL_REMOTE_ORIGIN_KEY)).toBe(false);
    expect(rememberRemoteOrigin(storage, "https://192.168.1.20:8443/", true, "local_https")).toBe(true);
    expect(rememberRemoteMode(storage, "local_https")).toBe(true);
    expect(loadRemoteMode(storage)).toBe("local_https");
    expect(loadRemoteOrigin(storage, "local_https")).toBe("https://192.168.1.20:8443");
    expect(loadRemoteOrigin(storage)).toBe("https://old.ts.net");
    values.set(REMOTE_MODE_KEY, "secret-token");
    expect(loadRemoteMode(storage)).toBe("tailscale");
    expect(rememberRemoteMode(storage, "bad" as "tailscale")).toBe(false);
    expect(rememberRemoteMode(null, "local_https")).toBe(false);
    const broken = { getItem: () => { throw Error(); }, setItem: () => { throw Error(); } };
    expect(loadRemoteMode(broken)).toBe("tailscale"); expect(rememberRemoteMode(broken, "local_https")).toBe(false);
  });
});
