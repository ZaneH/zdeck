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
  ["#/settings/unknown", "General"],
])("selects the accessible section for %s and keeps every card mounted", (hash, label) => {
  vi.stubGlobal("window", { location: { hash } });
  const html = renderToStaticMarkup(createElement(SettingsSections, {
    general: "General card", phone: "Phone card", integrations: "Integration card",
  }));
  expect(html).toContain(`aria-current="page">${label}</a>`);
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  expect(html.match(/hidden=""/g)).toHaveLength(2);
  expect(html).toContain(`class="settings-group" role="region" aria-label="${label}"`);
  for (const section of ["general", "phone", "integrations"]) {
    expect(html).toContain(`href="#/settings/${section}"`);
  }
  for (const card of ["General card", "Phone card", "Integration card"]) expect(html).toContain(card);
});
