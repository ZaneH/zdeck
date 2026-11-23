import { useState } from "react";
import type { RefObject } from "react";
import { Plus, Search, X } from "lucide-react";
import { ACTION_CATALOG } from "../lib/actions";
import type { ActionKind } from "../lib/types";
import { ActionIcon } from "./ActionIcon";

interface ActionLibraryProps {
  pageName: string;
  disabled?: boolean;
  dialogRef: RefObject<HTMLDialogElement | null>;
  onAdd: (kind: ActionKind) => void;
}

export function ActionLibrary({ pageName, disabled = false, dialogRef, onAdd }: ActionLibraryProps) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const filtered = ACTION_CATALOG.filter((action) =>
    [action.name, action.category, action.description, action.note ?? ""].join(" ").toLowerCase().includes(needle),
  );

  return (
    <dialog ref={dialogRef} className="action-library dialog" aria-labelledby="action-picker-title" onClose={() => setQuery("")}>
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
      {disabled ? <p className="field-note">This page has reached its control limit.</p> : null}
      <div className="action-groups">
        {filtered.map((action) => (
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
        {filtered.length === 0 ? <p className="empty-note">No actions match “{query.trim()}”. Try “volume” or “OBS”.</p> : null}
      </div>
    </dialog>
  );
}
