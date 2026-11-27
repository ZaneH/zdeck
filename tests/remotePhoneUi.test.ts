import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createDefaultDeck } from "../src/lib/deck";

const fixture = vi.hoisted(() => ({ remote: {} as Record<string, unknown> }));
vi.mock("../src/lib/useRemotePhone", () => ({ useRemotePhone: () => fixture.remote }));
import { RemotePhoneApp } from "../src/components/RemotePhoneApp";

const deck = createDefaultDeck();
const makeRemote = (overrides: Record<string, unknown> = {}) => ({
  phase: "active", deck, plugins: {}, revision: 1, pageId: "page_media",
  invite: null, pairingError: null, statusText: "", busyControlId: null,
  result: null, resultKind: "none", activity: [], warning: null,
  submitPairing: vi.fn(), cancelPairing: vi.fn(), press: vi.fn(),
  commitVolume: vi.fn(), setPage: vi.fn(), refreshValue: vi.fn(),
  ...overrides,
});
const tileClass = (html: string, action: string) =>
  html.match(new RegExp(`class="([^"]*)"[^>]*data-action="${action}"`))?.[1] ?? "";

describe("remote phone transient volume gating", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { location: { protocol: "https:" } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps other controls safely disabled without dimming while a volume slider is in flight", () => {
    fixture.remote = makeRemote({ busyControlId: "ctl_volume" });
    const html = renderToStaticMarkup(createElement(RemotePhoneApp, { initialInvite: null }));
    expect(tileClass(html, "volume")).not.toContain("is-disabled");
    expect(tileClass(html, "media-play-pause")).toContain("is-disabled");
    expect(tileClass(html, "media-play-pause")).toContain("is-transient-disabled");
  });

  it("keeps controls visibly disabled during a button action", () => {
    fixture.remote = makeRemote({ busyControlId: "ctl_media_pause" });
    const html = renderToStaticMarkup(createElement(RemotePhoneApp, { initialInvite: null }));
    for (const action of ["volume", "media-play-pause"]) {
      expect(tileClass(html, action)).toContain("is-disabled");
      expect(tileClass(html, action)).not.toContain("is-transient-disabled");
    }
  });

  it("keeps controls visibly disabled when the connection is unavailable", () => {
    fixture.remote = makeRemote({ phase: "disconnected", busyControlId: "ctl_volume" });
    const html = renderToStaticMarkup(createElement(RemotePhoneApp, { initialInvite: null }));
    for (const action of ["volume", "media-play-pause"]) {
      expect(tileClass(html, action)).toContain("is-disabled");
      expect(tileClass(html, action)).not.toContain("is-transient-disabled");
    }
  });
});
