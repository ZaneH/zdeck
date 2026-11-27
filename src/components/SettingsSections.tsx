import { useEffect, useState } from "react";
import type { ReactNode } from "react";

const sections = [["general", "General"], ["phone", "Phone connection"], ["integrations", "Integrations"], ["footer", "Toolbar"]] as const;
type SettingsSection = typeof sections[number][0];

function currentSection(): SettingsSection {
  const section = window.location.hash.split("/")[2];
  return section === "phone" || section === "integrations" || section === "footer" ? section : "general";
}

export function SettingsSections({ general, phone, integrations, footer }: Record<SettingsSection, ReactNode>) {
  // Mount a section when it is first opened, then keep it mounted so unsaved
  // fields survive tab switches. Unopened sections never mount (and never read
  // their settings).
  const [view, setView] = useState(() => {
    const active = currentSection();
    return { active, visited: [active] as SettingsSection[] };
  });
  useEffect(() => {
    const onHash = () => setView(({ active, visited }) => {
      const section = currentSection();
      if (section === active) return { active, visited };
      return { active: section, visited: visited.includes(section) ? visited : [...visited, section] };
    });
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const content = { general, phone, integrations, footer };
  return <>
    <nav className="settings-nav" aria-label="Settings sections">
      {sections.map(([section, label]) => <a key={section} className="button secondary"
        href={`#/settings/${section}`} aria-current={view.active === section ? "page" : undefined}>{label}</a>)}
    </nav>
    {sections.filter(([section]) => view.visited.includes(section)).map(([section, label]) => <div key={section} className="settings-group"
      hidden={view.active !== section} role="region" aria-label={label}>{content[section]}</div>)}
  </>;
}
