import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createDefaultDeck } from "../src/lib/deck";

const fixture = vi.hoisted(() => ({
  remote: {} as Record<string, unknown>,
  showActivity: false,
  navigation: {} as { pageId: string; pageIds: string[]; sectionIds: string[]; onPageChange: (id: string) => void },
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => initial === false
    ? [fixture.showActivity, (value: boolean) => { fixture.showActivity = value; }]
    : react.useState(initial) };
});
vi.mock("../src/components/phoneNavigation", async (original) => {
  const navigation = await original<typeof import("../src/components/phoneNavigation")>();
  return { ...navigation, usePhoneNavigation: (options: Parameters<typeof navigation.usePhoneNavigation>[0]) => {
    fixture.navigation = options;
    return navigation.usePhoneNavigation(options);
  } };
});
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

describe("remote phone command gating", () => {
  beforeEach(() => {
    fixture.showActivity = false;
    vi.stubGlobal("window", { location: { protocol: "https:" } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("puts activity on the final swipe page, not below the controls, and returns to the deck", () => {
    fixture.remote = makeRemote({ activity: [{ id: "entry", label: "Test action", state: "confirmed", message: "Delivered" }] });
    const render = () => renderToStaticMarkup(createElement(RemotePhoneApp, { initialInvite: null }));
    const controls = render();
    expect(controls).not.toContain('aria-label="Activity log"');
    expect(controls).toContain("Activity</button>");
    const activityId = fixture.navigation.pageIds.at(-1)!;
    expect(fixture.navigation.pageIds.slice(0, -1)).toEqual(deck.pages.map((page) => page.id));
    fixture.navigation.onPageChange(activityId);
    const activity = render();
    expect(activity).toContain("<h1>Activity</h1>");
    expect(activity).toContain('aria-label="Activity log"');
    expect(activity).toContain("Delivered");
    expect(activity).not.toContain('class="control-tile');
    expect(fixture.navigation.sectionIds).toEqual([]);
    expect(fixture.remote.setPage).not.toHaveBeenCalled();
    fixture.navigation.onPageChange(deck.pages[0].id);
    expect(fixture.remote.setPage).toHaveBeenCalledWith(deck.pages[0].id);
    expect(render()).not.toContain('aria-label="Activity log"');
  });

  it("offers an empty activity page before the first command", () => {
    fixture.remote = makeRemote();
    fixture.showActivity = true;
    const html = renderToStaticMarkup(createElement(RemotePhoneApp, { initialInvite: null }));
    expect(html).toContain("No activity yet.");
    expect(html).not.toContain('class="control-tile');
  });

  it("keeps other controls safely disabled without dimming while a volume slider is in flight", () => {
    fixture.remote = makeRemote({ busyControlId: "ctl_volume" });
    const html = renderToStaticMarkup(createElement(RemotePhoneApp, { initialInvite: null }));
    expect(tileClass(html, "volume")).not.toContain("is-disabled");
    expect(tileClass(html, "media-play-pause")).toContain("is-disabled");
    expect(tileClass(html, "media-play-pause")).toContain("is-transient-disabled");
  });

  it("does not append routine volume instructions to the section scroller", () => {
    fixture.remote = makeRemote();
    const html = renderToStaticMarkup(createElement(RemotePhoneApp, { initialInvite: null }));
    expect(html).not.toContain("Volume sliders set a target level");
    expect(html).not.toContain("remote-target-note");
    expect(html).toContain("Target value for Volume");
  });

  it("keeps other controls safely disabled without dimming during a button action", () => {
    fixture.remote = makeRemote({ busyControlId: "ctl_media_pause" });
    const html = renderToStaticMarkup(createElement(RemotePhoneApp, { initialInvite: null }));
    for (const action of ["volume", "media-play-pause"]) {
      expect(tileClass(html, action)).toContain("is-disabled");
    }
    expect(tileClass(html, "volume")).toContain("is-transient-disabled");
    expect(tileClass(html, "media-play-pause")).toContain("is-busy");
    expect(html).toMatch(/type="range"[^>]*disabled=""/);
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
