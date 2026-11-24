import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const fixture = vi.hoisted(() => ({ remote: {} as Record<string, unknown>, start: vi.fn() }));
vi.mock("../src/lib/useRemoteConsole", () => ({ useRemoteConsole: () => fixture.remote }));
vi.mock("../src/lib/persistence", () => ({ getStorage: () => null }));
import { RemoteSettingsCard } from "../src/components/RemoteSettingsCard";
const render = () => renderToStaticMarkup(createElement(RemoteSettingsCard));
beforeEach(() => {
  fixture.start.mockReset();
  fixture.remote = { native: true, running: false, mode: null, status: { running: false, mode: null }, origin: null,
    busy: false, invitation: null, pending: [], approved: [], error: null, start: fixture.start };
});
describe("connection mode presentation", () => {
  it("renders linked tabs/panels with one selected tab and never starts during render", () => {
    const html = render();
    expect(html).toContain('role="tablist"');
    expect(html).toContain('id="remote-tab-tailscale"');
    expect(html).toContain('aria-controls="remote-panel-local_https"');
    expect(html).toContain('role="tabpanel" id="remote-panel-local_https"');
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toContain('aria-labelledby="remote-tab-tailscale"');
    expect(html).toContain('tabindex="-1"');
    expect(fixture.start).not.toHaveBeenCalled();
  });
  it("running local status overrides the default tailnet choice, with readonly origin and explicit stop guidance", () => {
    fixture.remote = { ...fixture.remote, running: true, mode: "local_https", origin: "https://192.168.1.20:8443", port: 45829 };
    const html = render();
    expect(html).toMatch(/id="remote-tab-local_https"[^>]*aria-selected="true"/);
    expect(html).toContain('value="https://192.168.1.20:8443"');
    expect(html).toContain('disabled=""');
    expect(html).toContain("Stop the local service before switching");
    expect(html).toContain("rootCA-key.pem");
    expect(html).toContain("full trust");
    expect(html).toContain("administrator");
    expect(html).toContain("auto_https disable_redirects");
    expect(html).toContain("reverse_proxy 127.0.0.1:45829");
    expect(html).not.toContain("tailscale serve --bg");
    expect(fixture.start).not.toHaveBeenCalled();
  });
  it("retains a visible copyable Tailscale command outside collapsed help", () => {
    const html = render();
    expect(html.indexOf("tailscale serve --bg")).toBeGreaterThan(html.indexOf("</details>"));
    expect(html).toContain("Copy command");
    expect(html).toContain("tailscale serve status");
    expect(html).toContain("Do not enable Funnel");
  });
  it("disables mode switching while busy and keeps browser builds preview only", () => {
    fixture.remote.busy = true;
    expect(render()).toContain("Wait for this operation to finish");
    expect(render()).toMatch(/role="tab"[^>]*disabled=""/);
    fixture.remote.native = false;
    expect(render()).not.toContain('role="tablist"');
    expect(render()).toContain("never starts the private");
    expect(fixture.start).not.toHaveBeenCalled();
  });
});
