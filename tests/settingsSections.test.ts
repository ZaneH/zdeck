import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsSections } from "../src/components/SettingsSections";

afterEach(() => vi.unstubAllGlobals());
it.each([
  ["#/settings", "General"],
  ["#/settings/general", "General"],
  ["#/settings/phone", "Phone connection"],
  ["#/settings/integrations", "Integrations"],
  ["#/settings/footer", "Toolbar"],
  ["#/settings/unknown", "General"],
])("selects the accessible section for %s and mounts only that card", (hash, label) => {
  vi.stubGlobal("window", { location: { hash } });
  const html = renderToStaticMarkup(createElement(SettingsSections, {
    general: "General card", phone: "Phone card", integrations: "Integration card", footer: "Footer card",
  }));
  expect(html).toContain(`aria-current="page">${label}</a>`);
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  expect(html).toContain(`class="settings-group" role="region" aria-label="${label}"`);
  for (const section of ["general", "phone", "integrations", "footer"]) {
    expect(html).toContain(`href="#/settings/${section}"`);
  }
  const cards = { General: "General card", "Phone connection": "Phone card", Integrations: "Integration card", Toolbar: "Footer card" };
  for (const [name, card] of Object.entries(cards)) {
    if (name === label) expect(html).toContain(card);
    else expect(html).not.toContain(card);
  }
});

it("never renders other settings cards, so unopened tabs cannot read their settings", () => {
  vi.stubGlobal("window", { location: { hash: "#/settings/general" } });
  let integrationMounts = 0;
  function IntegrationProbe() { integrationMounts += 1; return createElement("p", null, "Integration card"); }
  const html = renderToStaticMarkup(createElement(SettingsSections, {
    general: "General card", phone: "Phone card", footer: "Footer card",
    integrations: createElement(IntegrationProbe),
  }));
  expect(html).toContain("General card");
  expect(html).not.toContain("Integration card");
  expect(integrationMounts).toBe(0);
});
