import { useState } from "react";
import type { RefObject } from "react";
import { Plus, Search, X } from "lucide-react";
import { ACTION_CATALOG } from "../lib/actions";
import { pluginControlField, pluginDefaults } from "../lib/plugin";
import type { PluginManifest } from "../lib/plugin";
import { useDialogBackdrop } from "../lib/useDialogBackdrop";
import type { ActionKind, ControlOptions } from "../lib/types";
import { ActionIcon } from "./ActionIcon";

type ActionCategory = (typeof ACTION_CATALOG)[number]["category"];
type CategoryFilter = "All" | ActionCategory;

const CATEGORIES: CategoryFilter[] = [
  "All",
  ...Array.from(new Set(ACTION_CATALOG.map((action) => action.category))),
  "Plugins",
];

interface ActionLibraryProps {
  pageName: string;
  disabled?: boolean;
  dialogRef: RefObject<HTMLDialogElement | null>;
  manifests?: PluginManifest[];
  onAdd: (kind: ActionKind, options?: ControlOptions) => void;
}

export function ActionLibrary({ pageName, disabled = false, dialogRef, manifests = [], onAdd }: ActionLibraryProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("All");
  useDialogBackdrop(dialogRef);

  const reset = () => {
    setQuery("");
    setCategory("All");
  };
  const close = () => { reset(); dialogRef.current?.close(); };
  const categories = CATEGORIES.filter((item) => item !== "Plugins" || manifests.length > 0);
  const needle = query.trim().toLowerCase();
  const catalog = [
    ...ACTION_CATALOG.map((action) => ({ ...action, icon: undefined, options: undefined as ControlOptions | undefined })),
    ...manifests.flatMap((manifest) => [...manifest.actions, ...(manifest.values ?? [])].map((action) => ({ kind: "plugin" as const, name: action.title, category: "Plugins" as const,
      description: `${manifest.id} · ${action.id}`, note: "Trusted local plugin", defaultLabel: action.title, icon: manifest.icon,
      options: { label: action.title, pluginId: manifest.id, pluginAction: action.id, pluginArgs: pluginDefaults(action),
        ...(manifest.values?.some((value) => value.id === action.id) ? { presentation: "value" as const }
          : pluginControlField(action)?.[1].type === "integer" ? { presentation: "slider" as const }
          : pluginControlField(action)?.[1].type === "boolean" ? { presentation: "toggle-switch" as const } : {}) },
    }))),
  ];
  const filtered = catalog.filter(
    (action) =>
      (category === "All" || action.category === category) &&
      [action.name, action.category, action.description, action.note ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(needle),
  );

  return (
    <dialog ref={dialogRef} className="action-library dialog" aria-labelledby="action-picker-title" onClose={reset}>
      <div className="dialog-heading">
        <h2 id="action-picker-title">Add a control</h2>
        <button type="button" className="icon-button" onClick={close} aria-label="Close action picker">
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="search-field">
        <Search size={16} aria-hidden="true" />
        <input id="action-search" type="search" aria-label="Search actions" placeholder="Search actions…" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <div className="action-categories" role="group" aria-label="Filter actions by category">
        {categories.map((item) => (
          <button
            key={item}
            type="button"
            className="action-category"
            aria-pressed={category === item}
            onClick={() => setCategory(item)}
          >
            {item}
          </button>
        ))}
      </div>
      {disabled ? <p className="field-note">This page has reached its control limit.</p> : null}
      <div className="action-groups">
        {categories.filter((item) => item !== "All").map((item) => {
          const actions = filtered.filter((action) => action.category === item);
          if (actions.length === 0) return null;
          return (
            <section key={item} className="action-group" aria-label={item}>
              <h3 className="action-group-title">{item}</h3>
              {actions.map((action) => (
                <button
                  key={`${action.kind}-${action.options?.pluginId ?? ""}-${action.options?.pluginAction ?? ""}`} type="button" className="action-row" disabled={disabled}
                  aria-label={`Add ${action.name}${action.options?.pluginId ? ` (${action.options.pluginId})` : ""} to ${pageName}`}
                  onClick={() => { onAdd(action.kind, action.options); close(); }}
                >
                  <ActionIcon kind={action.kind} icon={action.icon ? { type: "image", src: action.icon } : undefined} size={20} />
                  <span className="action-row-copy">
                    <span className="action-row-name">{action.name}</span>
                    <span className="action-row-note">{action.description}{action.kind === "mic-mute" ? " Not an OBS input." : ""}</span>
                  </span>
                  <Plus size={16} aria-hidden="true" />
                </button>
              ))}
            </section>
          );
        })}
        {filtered.length === 0 ? <p className="empty-note">No actions match “{query.trim() || category}”. Try “volume” or “OBS”.</p> : null}
      </div>
    </dialog>
  );
}
