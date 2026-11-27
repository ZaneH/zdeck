import { useEffect, useRef, useState } from "react";
import { RotateCcw, Trash2, X } from "lucide-react";
import { useDialogBackdrop } from "../lib/useDialogBackdrop";
import { trashEntryLocation } from "../lib/trash";
import type { TrashEntry } from "../lib/trash";
import { HelpTooltip } from "./HelpTooltip";

interface DeckTrashProps {
  entries: TrashEntry[];
  disabled?: boolean;
  /** Returns a visible error and keeps the entry, or null after a successful restore. */
  onRestore: (entry: TrashEntry) => string | null;
}

const nameOf = (entry: TrashEntry) => entry.kind === "control" ? entry.control.label : entry.section.name;

/** Grouped, accessible Trash for recently deleted controls and sections. */
export function DeckTrash({ entries, disabled = false, onRestore }: DeckTrashProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string | null>(null);
  useDialogBackdrop(dialogRef);

  const close = () => {
    setError(null);
    dialogRef.current?.close();
  };
  const open = () => {
    setError(null);
    dialogRef.current?.showModal();
    window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      (dialog?.querySelector<HTMLButtonElement>(".trash-restore")
        ?? dialog?.querySelector<HTMLButtonElement>(".dialog-heading .icon-button"))?.focus();
    });
  };
  const restore = (entry: TrashEntry) => {
    const failure = onRestore(entry);
    setError(failure);
    if (failure) return;
    window.requestAnimationFrame(() => {
      const next = dialogRef.current?.querySelector<HTMLButtonElement>(".trash-restore");
      if (next) next.focus();
      else close();
    });
  };

  useEffect(() => {
    // Trash can empty through undo/redo while the dialog is open.
    if (dialogRef.current?.open && entries.length === 0) close();
  }, [entries.length]);

  const groups = [
    { kind: "control" as const, title: "Controls" },
    { kind: "section" as const, title: "Sections" },
  ];

  return (
    <>
    <HelpTooltip label="Trash help" trigger={(descriptionId) => (
      <button ref={triggerRef} type="button" className="icon-button" aria-label="Trash"
        aria-describedby={descriptionId} aria-haspopup="dialog" onClick={open}>
        <Trash2 size={16} aria-hidden="true" />
      </button>
    )}>
      Trash
    </HelpTooltip>

    <dialog ref={dialogRef} className="dialog trash-dialog" aria-labelledby="trash-title"
      onClose={() => { setError(null); triggerRef.current?.focus(); }}>
      <div className="dialog-heading">
        <h2 id="trash-title">Trash</h2>
        <button type="button" className="icon-button" aria-label="Close trash" onClick={close}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="dialog-body">
        {error ? <p className="section-error" role="alert">{error}</p> : null}
        {entries.length === 0 ? (
          <p className="empty-note">Nothing deleted yet. Removed controls and sections appear here.</p>
        ) : (
          <div className="trash-groups">
            {groups.map(({ kind, title }) => {
              const items = entries.filter((entry) => entry.kind === kind);
              if (items.length === 0) return null;
              return (
                <section key={kind} className="trash-group" aria-label={title}>
                  <h3>{title}</h3>
                  <ul className="trash-list">
                    {items.map((entry) => (
                      <li key={`${entry.kind}:${entry.id}`} className="trash-row">
                        <span className="trash-copy">
                          <span className="trash-name">{nameOf(entry)}</span>
                          <span className="trash-location">{trashEntryLocation(entry)}</span>
                          {entry.kind === "section" ? (
                            <span className="trash-location">
                              {entry.section.controls.length} {entry.section.controls.length === 1 ? "control" : "controls"}
                            </span>
                          ) : null}
                        </span>
                        <button type="button" className="button secondary small trash-restore"
                          aria-label={`Restore ${nameOf(entry)}`} disabled={disabled}
                          onClick={() => restore(entry)}>
                          <RotateCcw size={14} aria-hidden="true" /> Restore
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </dialog>
    </>
  );
}
