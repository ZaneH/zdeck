import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Inspector } from "../src/components/Inspector";
import { createElement } from "react";
import type { ComponentProps } from "react";
import { createDefaultDeck } from "../src/lib/deck";

const setup = vi.hoisted(() => ({
  permission: { platform: "macos", status: "required" }, error: null as string | null,
  busy: false, refresh: vi.fn(), openSettings: vi.fn(),
}));
vi.mock("../src/lib/useMediaPermission", () => ({ useMediaPermission: () => setup }));

function render(native = true) {
  // Only media fields are consumed for this selected control.
  const props = {
    control: createDefaultDeck().pages.flatMap(page => page.controls).find(control => control.action === "media-play-pause"),
    pageName: "Main", previewVolume: 50, canMoveUp: true, canMoveDown: true,
    obs: { native: false }, plugin: {},
    system: { native, media: { status: "unknown", observedAtMs: 0 }, mediaPending: false,
      mediaRefreshing: false, mediaError: "Old playback failure", mediaFeedback: null,
      runMedia: vi.fn(), refreshMedia: vi.fn() },
    onPatch: vi.fn(), onRemove: vi.fn(), onMove: vi.fn(), onPreviewPress: vi.fn(), onPreviewVolume: vi.fn(),
  } as unknown as ComponentProps<typeof Inspector>;
  return renderToStaticMarkup(createElement(Inspector, props));
}

beforeEach(() => { setup.permission = { platform: "macos", status: "required" }; setup.error = null; });
describe("selected media control setup", () => {
  it("replaces playback UI with one concise centered setup CTA while retaining editable properties", () => {
    const html = render();
    expect(html).toContain("Allow zDeck to control playback.");
    expect(html.match(/Open System Settings/g)).toHaveLength(1);
    expect(html).toContain("media-permission-setup");
    expect(html).toContain("<span>Label</span>");
    for (const noise of ["System media:", "Refresh", "Check permission", "Old playback failure", "Check playback before retrying", "Privacy &amp; Security"]) expect(html).not.toContain(noise);
    expect(setup.openSettings).not.toHaveBeenCalled();
  });
  it("shows actual setup failures rather than hiding them", () => {
    setup.error = "Could not open System Settings. Open Accessibility settings manually.";
    const html = render();
    expect(html).toContain('role="alert"');
    expect(html).toContain(setup.error);
    expect(html).not.toContain("Check permission");
  });
  it.each(["windows", "linux", "macos"])("keeps normal playback for %s without missing permission", (platform) => {
    setup.permission = { platform, status: platform === "macos" ? "granted" : "not_required" };
    const html = render();
    expect(html).toContain("System media:");
    expect(html).toContain("Refresh");
    expect(html).not.toContain("Open System Settings");
    expect(html).not.toContain("Linux uses the default MPRIS player.");
  });
  it("leaves browser preview unchanged", () => {
    const html = render(false);
    expect(html).toContain("System play/pause in the desktop app");
    expect(html).not.toContain("Open System Settings");
  });
});
