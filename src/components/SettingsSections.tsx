import { useEffect, useState } from "react";
import type { ReactNode } from "react";

const sections = [["general", "General"], ["phone", "Phone connection"], ["integrations", "Integrations"]] as const;
type SettingsSection = typeof sections[number][0];

function currentSection(): SettingsSection {
  const section = window.location.hash.split("/")[2];
  return section === "phone" || section === "integrations" ? section : "general";
}

export function SettingsSections({ general, phone, integrations }: Record<SettingsSection, ReactNode>) {
  const [active, setActive] = useState(currentSection);
  useEffect(() => {
    const onHash = () => setActive(currentSection());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const content = { general, phone, integrations };
  return <>
    <nav className="settings-nav" aria-label="Settings sections">
      {sections.map(([section, label]) => <a key={section} className="button secondary"
        href={`#/settings/${section}`} aria-current={active === section ? "page" : undefined}>{label}</a>)}
    </nav>
    {sections.map(([section, label]) => <div key={section} className="settings-group"
      hidden={active !== section} role="region" aria-label={label}>{content[section]}</div>)}
  </>;
}
