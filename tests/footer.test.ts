import { createElement } from "react";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_FOOTER, loadFooter, saveFooter } from "../src/lib/footerPreferences";
import { StatusFooter } from "../src/components/StatusFooter";

const props = {
  preferences: DEFAULT_FOOTER, native: true,
  service: { running: true, mode: "tailscale" as const, origin: "https://deck.example", port: 45829,
    pendingDevices: 0, approvedDevices: 0, connectedSockets: 0 },
  serviceFailed: false, pluginCount: 2, pluginsUnknown: false,
  live: false, canRun: true, onEdit() {}, onRun() {}, feedback: null,
};
const render = (patch: Partial<ComponentProps<typeof StatusFooter>> = {}) => renderToStaticMarkup(createElement(StatusFooter, { ...props, ...patch }));

describe("footer", () => {
  it("round-trips every visibility setting independently without storing execution state", () => {
    const data = new Map<string, string>();
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
    expect(loadFooter(storage)).toEqual({ value: DEFAULT_FOOTER, error: null });
    for (let mask = 0; mask < 8; mask++) {
      const value = { service: !!(mask & 1), plugins: !!(mask & 2), dividers: !!(mask & 4) };
      expect(saveFooter(storage, value)).toBe(true);
      expect(loadFooter(storage)).toEqual({ value, error: null });
    }
    expect([...data.keys()]).toEqual(["deck.footer.v1"]);
    expect([...data.values()].join()).not.toMatch(/live|armed|origin/);
  });

  it.each(["invalid", "null", "[]", '{"service":true}', '{"service":true,"plugins":true,"dividers":1}',
    '{"service":true,"plugins":true,"dividers":true,"live":true}'])('loads defaults without blocking launch for %s', raw => {
    expect(loadFooter({ getItem: () => raw, setItem() {} })).toEqual({ value: DEFAULT_FOOTER, error: expect.any(String) });
  });

  it("surfaces storage failures", () => {
    const blocked = { getItem(): string { throw Error("blocked"); }, setItem() { throw Error("full"); } };
    for (const storage of [null, blocked]) {
      expect(loadFooter(storage).error).toBeTruthy();
      expect(saveFooter(storage, DEFAULT_FOOTER)).toBe(false);
    }
  });

  it("shows local service state, loaded plugins and an explicit execution mode", () => {
    const html = render();
    expect(html).toContain("Service running");
    expect(html).toContain("2 plugins loaded");
    expect(html).toContain("Editing");
    expect(html).not.toContain("Controls armed");
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('href="#/settings"');
    expect(html).not.toContain('href="#/settings/footer"');
    expect(render({ live: true })).toContain("Controls armed");
  });

  it("uses one labelled toggle and keeps disarming available when arming is blocked", () => {
    const toggle = (patch: Partial<ComponentProps<typeof StatusFooter>>) => render(patch).match(/<button[^>]*aria-label="Run controls on this computer"[^>]*>/)?.[0];
    expect(toggle({})).toContain('aria-pressed="false"');
    expect(toggle({ canRun: false })).toContain('disabled=""');
    expect(toggle({ native: false })).toContain('disabled=""');
    expect(toggle({ live: true, canRun: false })).toContain('aria-pressed="true"');
    expect(toggle({ live: true, canRun: false })).not.toContain("disabled");
    expect(toggle({})).not.toContain("aria-haspopup");
  });

  it("does not confuse unknown or browser-only state with a running service", () => {
    expect(render({ service: { ...props.service, running: false } })).toContain("Service stopped");
    expect(render({ service: null, serviceFailed: true })).toContain("Service unknown");
    expect(render({ service: null })).toContain("Checking service");
    const browser = render({ native: false, service: null });
    expect(browser).toContain("Service unavailable");
    expect(browser).toContain("Preview only");
    expect(browser).not.toContain("Service running");
    expect(render({ pluginsUnknown: true })).toContain("Plugins unknown");
  });

  it("hides optional items and dividers but never hides mode or configuration", () => {
    const html = render({ preferences: { service: false, plugins: false, dividers: false } });
    expect(html).not.toMatch(/Service running|plugins loaded|has-dividers/);
    expect(html).toContain("Editing");
    expect(html).toContain("Open settings");
    expect(html).not.toContain('aria-label="Controls on/off help"');
    expect(html).toMatch(/aria-pressed="false" aria-describedby="[^"]+"/);
  });
});
