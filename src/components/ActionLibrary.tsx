import { useMemo, useState } from "react";
import { Plus, Search } from "lucide-react";
import { ACTION_CATALOG } from "../lib/actions";
import type { ActionKind } from "../lib/types";
import { ActionIcon } from "./ActionIcon";

interface ActionLibraryProps {
  pageName: string;
  disabled?: boolean;
  onAdd: (kind: ActionKind) => void;
}

const CATEGORIES = ["OBS", "System", "Media"] as const;

export function ActionLibrary({ pageName, disabled = false, onAdd }: ActionLibraryProps) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return ACTION_CATALOG;
    return ACTION_CATALOG.filter((action) =>
      [action.name, action.category, action.description, action.note ?? ""]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [query]);

  return (
    <details className="panel" open>
      <summary className="panel-head">
        <span>Add controls</span>
      </summary>
      <div className="panel-body">
        <label className="sr-only" htmlFor="action-search">
          Search actions
        </label>
        <div className="search-field">
          <Search size={16} aria-hidden="true" />
          <input
            id="action-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search actions"
            autoComplete="off"
          />
        </div>

        <div className="action-groups">
          {CATEGORIES.map((category) => {
            const actions = filtered.filter((action) => action.category === category);
            if (actions.length === 0) return null;
            return (
              <section key={category} className="action-group" aria-label={category}>
                <h3>{category}</h3>
                {actions.map((action) => (
                  <button
                    key={action.kind}
                    type="button"
                    className="action-row"
                    onClick={() => onAdd(action.kind)}
                    disabled={disabled}
                    aria-label={`Add ${action.name} to ${pageName}`}
                    title={[action.description, action.note].filter(Boolean).join(" ")}
                  >
                    <span className="action-row-icon">
                      <ActionIcon kind={action.kind} size={18} />
                    </span>
                    <span className="action-row-copy">
                      <span className="action-row-name">{action.name}</span>

                    </span>
                    <Plus size={16} aria-hidden="true" className="action-row-plus" />
                  </button>
                ))}
              </section>
            );
          })}
          {filtered.length === 0 ? (
            <p className="empty-note">No actions match “{query.trim()}”.</p>
          ) : null}
        </div>
      </div>
    </details>
  );
}
