import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The card is presentational for the pairing area: replace the native console
// hook so desktop states render without a Tauri host or a DOM.
const state = vi.hoisted(() => ({ remote: null as unknown }));

vi.mock("../src/lib/useRemoteConsole", () => ({
  useRemoteConsole: () => state.remote,
}));

import { RemoteSettingsCard } from "../src/components/RemoteSettingsCard";
import {
  PairingQrCode,
  QR_QUIET_ZONE_MODULES,
  createQrMatrix,
} from "../src/components/PairingQrCode";

const ORIGIN = "https://computer.tailnet-name.ts.net";
const INVITE_URL = `${ORIGIN}/#/pair?invite=${"a".repeat(64)}`;

function makeRemote(overrides: Record<string, unknown> = {}) {
  const running = overrides.running ?? true;
  return {
    native: true,
    status: running
      ? {
          running: true,
          origin: ORIGIN,
          port: 45829,
          pendingDevices: 0,
          approvedDevices: 0,
          connectedSockets: 0,
        }
      : {
          running: false,
          origin: null,
          port: null,
          pendingDevices: 0,
          approvedDevices: 0,
          connectedSockets: 0,
        },
    running,
    origin: running ? ORIGIN : null,
    port: running ? 45829 : null,
    pending: [],
    approved: [],
    invitation: null,
    error: null,
    busy: false,
    start: async () => true,
    stop: async () => {},
    createInvitation: async () => {},
    approve: async () => {},
    deny: async () => {},
    revoke: async () => {},
    ...overrides,
  };
}

function makeInvitation(url: string, token: string) {
  return { invitation: token, url, expiresAtMs: Date.now() + 120_000 };
}

const render = () => renderToStaticMarkup(createElement(RemoteSettingsCard));

beforeEach(() => {
  state.remote = makeRemote();
});

describe("invitation layout", () => {
  it("orders the link field, then expiry, then the Copy link button", () => {
    state.remote = makeRemote({ invitation: makeInvitation(INVITE_URL, "TOKEN123") });
    const html = render();
    const fieldIndex = html.indexOf(INVITE_URL);
    const expiryIndex = html.indexOf("remote-invite-expiry");
    const copyIndex = html.indexOf("Copy link");
    expect(fieldIndex).toBeGreaterThan(-1);
    expect(expiryIndex).toBeGreaterThan(fieldIndex);
    expect(copyIndex).toBeGreaterThan(expiryIndex);
  });

  it("keeps the expiry timestamp visible without any copied feedback", () => {
    state.remote = makeRemote({ invitation: makeInvitation(INVITE_URL, "TOKEN123") });
    const html = render();
    // No copy has happened, yet the timestamp is its own paragraph, not the
    // conditional copy-feedback status element.
    expect(html).toContain('class="muted remote-invite-expiry"');
    expect(html).toContain("Expires at");
    expect(html).not.toMatch(/remote-invite-expiry[^>]*role="status"/);
  });
});

describe("pairing QR code", () => {
  it("renders an inline SVG with a quiet zone and an accessible label", () => {
    state.remote = makeRemote({ invitation: makeInvitation(INVITE_URL, "TOKEN123") });
    const html = render();
    const matrix = createQrMatrix(INVITE_URL);
    expect(matrix).not.toBeNull();
    const size = matrix!.moduleCount + QR_QUIET_ZONE_MODULES * 2;
    expect(html).toContain('class="pairing-qr"');
    expect(html).toContain('role="img"');
    expect(html).toContain(
      'aria-label="Pairing QR code. Scan with your phone camera to open the pairing link."',
    );
    expect(html).toContain(`viewBox="0 0 ${size} ${size}"`);
    expect(html).toContain('fill="#ffffff"');
    expect(html).toContain('fill="#000000"');
    expect(html).toContain('shape-rendering="crispEdges"');
  });

  it("encodes the exact invitation URL, including the fragment", () => {
    state.remote = makeRemote({ invitation: makeInvitation(INVITE_URL, "TOKEN123") });
    const html = render();
    // The link is present exactly once, as the selectable input value.
    expect(html.split(INVITE_URL).length - 1).toBe(1);
    // The raw token never appears in the SVG element.
    const svg = html.slice(html.indexOf("<svg"), html.indexOf("</svg>") + 6);
    expect(svg).not.toContain("a".repeat(64));
    expect(svg).not.toContain(INVITE_URL);
  });

  it("keeps the selectable link and copy button when encoding fails", () => {
    const overflowUrl = `${ORIGIN}/?invite=${"a".repeat(5000)}`;
    state.remote = makeRemote({
      invitation: makeInvitation(overflowUrl, "a".repeat(5000)),
    });
    const html = render();
    expect(html).toContain("QR code unavailable");
    expect(html).not.toContain("<svg");
    expect(html).toContain(overflowUrl);
    expect(html).toContain("Copy link");
  });

  it("shows no QR code without a live invitation or while stopped", () => {
    state.remote = makeRemote({ invitation: null });
    expect(render()).not.toContain("<svg");

    state.remote = makeRemote({ running: false, invitation: null });
    const stopped = render();
    expect(stopped).not.toContain("<svg");
    expect(stopped).not.toContain("Copy link");
  });

  it("never pulls in an external image or QR endpoint", () => {
    state.remote = makeRemote({ invitation: makeInvitation(INVITE_URL, "TOKEN123") });
    const html = render();
    expect(html).not.toMatch(/<img|<image|xlink:href/i);
    expect(html).not.toMatch(
      /chart\.googleapis|api\.qrserver|quickchart|goqr\.me|qrcode.*http/i,
    );
  });
});

describe("createQrMatrix", () => {
  it("builds modules for a normal value and rejects empty or oversized input", () => {
    const matrix = createQrMatrix("hello");
    expect(matrix).not.toBeNull();
    expect(matrix!.moduleCount).toBeGreaterThan(0);
    expect(matrix!.isDark(0, 0)).toBe(true);
    expect(QR_QUIET_ZONE_MODULES).toBe(4);
    expect(createQrMatrix("")).toBeNull();
    expect(createQrMatrix("a".repeat(5000))).toBeNull();
  });

  it("renders a fallback paragraph through PairingQrCode on failure", () => {
    const html = renderToStaticMarkup(
      createElement(PairingQrCode, { value: "", label: "Pairing QR code." }),
    );
    expect(html).toContain("QR code unavailable");
    expect(html).not.toContain("<svg");
  });
});

describe("local service clarity", () => {
  it("names the local service and disclaims phone reachability while running", () => {
    const html = render();
    expect(html).toContain("Stop local service");
    expect(html).toContain("Local service running on 127.0.0.1:45829");
    expect(html).toContain("Phone access is not checked.");
  });

  it("reports a stopped local service without implying reachability", () => {
    state.remote = makeRemote({ running: false });
    const html = render();
    expect(html).toContain("Local service stopped.");
    expect(html).toContain("Start local service");
    expect(html).not.toContain("Phone access is not checked.");
  });

  it("keeps four short ordered steps with the exact command in Connection help", () => {
    const html = render();
    const start = html.indexOf('<ol class="remote-steps" role="list">');
    expect(start).toBeGreaterThan(-1);
    const steps = html.slice(start, html.indexOf("</ol>", start));
    expect((steps.match(/<li>/g) ?? []).length).toBe(4);
    expect(steps).toContain("Start the desktop service below.");
    expect(steps).toContain("Publish its address with Tailscale Serve.");
    expect(steps).toContain("Open that address on your phone, then scan the QR.");
    expect(steps).toContain("Request access, then approve this phone here.");
    const help = html.slice(html.indexOf('<details class="remote-help">'));
    expect(help).toContain("tailscale serve status");
    expect(help).toContain(
      "tailscale serve --bg --https=443 http://127.0.0.1:45829",
    );
    expect(help).toContain("Do not enable Funnel");
    expect(help).toContain("install the app first");
    expect(html).toContain("never configures Tailscale");
    expect(html).toContain("loopback-only");
  });
});
