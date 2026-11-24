import { useState } from "react";
import type { RefObject } from "react";
import { Plus, Search, X } from "lucide-react";
import { ACTION_CATALOG } from "../lib/actions";
import { useDialogBackdrop } from "../lib/useDialogBackdrop";
import type { ActionKind } from "../lib/types";
import { ActionIcon } from "./ActionIcon";

type ActionCategory = (typeof ACTION_CATALOG)[number]["category"];
type CategoryFilter = "All" | ActionCategory;

const CATEGORIES: CategoryFilter[] = [
  "All",
  ...Array.from(new Set(ACTION_CATALOG.map((action) => action.category))),
];

interface ActionLibraryProps {
  pageName: string;
  disabled?: boolean;
  dialogRef: RefObject<HTMLDialogElement | null>;
  onAdd: (kind: ActionKind) => void;
}

export function ActionLibrary({ pageName, disabled = false, dialogRef, onAdd }: ActionLibraryProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("All");
  useDialogBackdrop(dialogRef);

  const reset = () => {
    setQuery("");
    setCategory("All");
  };
  const needle = query.trim().toLowerCase();
  const filtered = ACTION_CATALOG.filter(
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
        <button type="button" className="icon-button" onClick={() => dialogRef.current?.close()} aria-label="Close action picker">
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="search-field">
        <Search size={16} aria-hidden="true" />
        <input id="action-search" type="search" aria-label="Search actions" placeholder="Search actions…" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <div className="action-categories" role="group" aria-label="Filter actions by category">
        {CATEGORIES.map((item) => (
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
        {CATEGORIES.filter((item) => item !== "All").map((item) => {
          const actions = filtered.filter((action) => action.category === item);
          if (actions.length === 0) return null;
          return (
            <section key={item} className="action-group" aria-label={item}>
              <h3 className="action-group-title">{item}</h3>
              {actions.map((action) => (
                <button
                  key={action.kind} type="button" className="action-row" disabled={disabled}
                  aria-label={`Add ${action.name} to ${pageName}`}
                  onClick={() => { onAdd(action.kind); dialogRef.current?.close(); }}
                >
                  <ActionIcon kind={action.kind} size={20} />
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
