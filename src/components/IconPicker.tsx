import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { BUILTIN_ICONS } from "../lib/icons";
import type { ControlIcon } from "../lib/icons";
import type { PluginManifest } from "../lib/plugin";
import type { Control, ControlPatch } from "../lib/types";
import { ActionIcon } from "./ActionIcon";

export function iconGroups(manifests: PluginManifest[], query = "") {
  const groups = new Map<string, { key: string; title: string; icon: ControlIcon }[]>();
  const add = (group: string, key: string, title: string, icon: ControlIcon) => {
    if (!`${group} ${title} ${key}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) return;
    const items = groups.get(group) ?? [];
    items.push({ key, title, icon });
    groups.set(group, items);
  };
  for (const item of BUILTIN_ICONS) add(`Built-in / ${item.category}`, item.id, item.title, { type: "builtin", name: item.id });
  for (const manifest of manifests) for (const item of manifest.icons ?? []) {
    add(`${manifest.id} / ${item.category}`, `${manifest.id}/${item.id}`, item.title, { type: "image", src: item.src });
  }
  return [...groups.entries()];
}

export function IconPicker({ control, manifests, onPatch }: {
  control: Control; manifests: PluginManifest[]; onPatch: (patch: ControlPatch) => void;
}) {
  const [query, setQuery] = useState("");
  const groups = iconGroups(manifests, query);
  return <details className="icon-picker">
    <summary><ActionIcon kind={control.action} icon={control.icon} size={20} />
      <span>Icon</span><span className="icon-picker-status">{control.icon ? "Custom" : "Action default"}</span>
      <ChevronDown size={16} className="icon-picker-toggle" aria-hidden="true" /></summary>
    <div className="icon-picker-body">
      <button type="button" className="button secondary" disabled={!control.icon} onClick={() => onPatch({ icon: null })}>Use action default</button>
      <label className="field"><span>Find an icon</span>
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search icons, plugins or categories" />
      </label>
      <div className="icon-picker-groups">
        {groups.map(([group, items]) => <fieldset key={group} className="icon-picker-group">
          <legend>{group}</legend>
          <div className="icon-picker-grid">{items.map((item) => <button type="button" key={item.key}
            title={item.title} aria-label={`${group}: ${item.title}`}
            aria-pressed={item.icon.type === "builtin" ? control.icon?.type === "builtin" && control.icon.name === item.icon.name
              : control.icon?.type === "image" && control.icon.src === item.icon.src}
            onClick={() => onPatch({ icon: item.icon })}>
            <ActionIcon kind={control.action} icon={item.icon} size={24} /><span>{item.title}</span>
          </button>)}</div>
        </fieldset>)}
        {!groups.length ? <p className="field-note" role="status">No matching icons.</p> : null}
      </div>
      <p className="field-note">Use any icon on any control. Enabled plugins can add icons here; selected images stay with your deck even when their plugin is disabled.</p>
    </div>
  </details>;
}
