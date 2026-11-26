import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, MoreHorizontal, Pencil, Plus, Trash2, X } from "lucide-react";
import { ACCENTS } from "../lib/types";
import type { Accent, Deck, Page, Section, Theme } from "../lib/types";
import { sectionNameError } from "../lib/sections";
import { useDialogBackdrop } from "../lib/useDialogBackdrop";

interface SectionListProps {
  deck: Deck;
  page: Page;
  selectedSectionId: string | null;
  /** Matches the editor's live/inflight guards: structural edits pause while running. */
  disabled?: boolean;
  onSelect: (sectionId: string) => void;
  onAdd: (afterSectionId: string | null) => void;
  onRename: (sectionId: string, name: string) => void;
  onRemove: (sectionId: string) => void;
  onMove: (sectionId: string, delta: number) => void;
  onTheme: (sectionId: string, theme: Theme | null) => void;
  onAccent: (sectionId: string, accent: Accent | null) => void;
}

export function SectionList({
  deck, page, selectedSectionId, disabled = false,
  onSelect, onAdd, onRename, onRemove, onMove, onTheme, onAccent,
}: SectionListProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const confirmRef = useRef<HTMLDialogElement>(null);
  const cancelRemoveRef = useRef<HTMLButtonElement>(null);
  useDialogBackdrop(dialogRef);
  useDialogBackdrop(confirmRef);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const selected = page.sections.find((section) => section.id === selectedSectionId)
    ?? page.sections[0];
  const selectedIndex = selected ? page.sections.indexOf(selected) : -1;
  const confirming = confirmingId
    ? page.sections.find((section) => section.id === confirmingId) ?? null
    : null;
  const accentName = ACCENTS.find((accent) => accent.value === deck.accent)?.name ?? deck.accent;

  useEffect(() => {
    setRenamingId(null);
    setRenameError(null);
    setConfirmingId(null);
  }, [page.id]);

  useEffect(() => {
    if (confirmingId && !confirming) setConfirmingId(null);
  }, [confirming, confirmingId]);

  const startRename = (section: Section) => {
    setRenamingId(section.id);
    setDraft(section.name);
    setRenameError(null);
  };
  const commitRename = () => {
    if (!renamingId) return;
    const error = sectionNameError(draft);
    if (error) {
      setRenameError(error);
      return;
    }
    onRename(renamingId, draft);
    setRenamingId(null);
    setRenameError(null);
  };
  const requestRemove = (section: Section) => {
    if (section.controls.length === 0) {
      onRemove(section.id);
      return;
    }
    setConfirmingId(section.id);
    confirmRef.current?.showModal();
    cancelRemoveRef.current?.focus();
  };

  return (
    <>
      <div className="section-panel">
        <label className="sr-only" htmlFor="section-target">Target section for new controls</label>
        <select
          id="section-target"
          value={selected?.id ?? ""}
          onChange={(event) => onSelect(event.target.value)}
          title="Section for new controls"
        >
          {page.sections.map((section) => (
            <option key={section.id} value={section.id}>{section.name}</option>
          ))}
        </select>
        <button
          type="button" className="icon-button" aria-label="Manage sections" title="Manage sections"
          onClick={() => dialogRef.current?.showModal()}
        >
          <MoreHorizontal size={17} aria-hidden="true" />
        </button>
        <button
          type="button" className="icon-button" aria-label="Add section" title="Add section after the selected one"
          disabled={disabled} onClick={() => onAdd(selected?.id ?? null)}
        >
          <Plus size={16} aria-hidden="true" />
        </button>
      </div>

      <dialog ref={dialogRef} className="dialog section-dialog" aria-labelledby="sections-title">
        <div className="dialog-heading">
          <h2 id="sections-title">Sections</h2>
          <button type="button" className="icon-button" aria-label="Close section manager" onClick={() => dialogRef.current?.close()}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <p className="field-note">New controls go to the selected section.</p>
        {disabled ? <p className="field-note">Switch to Editing to change sections.</p> : null}
        <ul className="page-list">
          {page.sections.map((section) => (
            <li key={section.id} className={`page-item${section.id === selected?.id ? " is-active" : ""}`}>
              {renamingId === section.id ? (
                <form
                  className="page-rename"
                  onSubmit={(event) => { event.preventDefault(); commitRename(); }}
                >
                  <label className="sr-only" htmlFor={`rename-section-${section.id}`}>Section name</label>
                  <input
                    id={`rename-section-${section.id}`}
                    value={draft}
                    onChange={(event) => { setDraft(event.target.value); setRenameError(null); }}
                    autoFocus
                    disabled={disabled}
                    aria-invalid={renameError ? true : undefined}
                    aria-describedby={renameError ? "section-rename-error" : undefined}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setRenamingId(null);
                        setRenameError(null);
                      }
                    }}
                  />
                  <button type="submit" className="icon-button" disabled={disabled} aria-label={`Save name for ${section.name}`}>
                    <Check size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button" className="icon-button" disabled={disabled}
                    onClick={() => { setRenamingId(null); setRenameError(null); }}
                    aria-label="Cancel rename"
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </form>
              ) : (
                <button
                  type="button" className="page-select" onClick={() => onSelect(section.id)}
                  aria-current={section.id === selected?.id ? "true" : undefined}
                >
                  <span className="page-name">{section.name}</span>
                  <span className="page-count">{section.controls.length}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
        {renameError ? <p id="section-rename-error" className="settings-error" role="alert">{renameError}</p> : null}

        {selected ? (
          <fieldset className="section-appearance">
            <legend>Appearance</legend>
            <p className="field-note">Follows the deck unless overridden. Overrides apply only to this section.</p>
            <label className="field">
              <span>Theme</span>
              <select
                value={selected.theme ?? ""}
                disabled={disabled}
                onChange={(event) => onTheme(selected.id, event.target.value ? event.target.value as Theme : null)}
              >
                <option value="">Inherit from deck ({deck.theme})</option>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </label>
            <label className="field">
              <span>Accent</span>
              <select
                value={selected.accent ?? ""}
                disabled={disabled}
                onChange={(event) => onAccent(selected.id, event.target.value ? event.target.value as Accent : null)}
              >
                <option value="">Inherit from deck ({accentName})</option>
                {ACCENTS.map((accent) => (
                  <option key={accent.value} value={accent.value}>{accent.name}</option>
                ))}
              </select>
            </label>
          </fieldset>
        ) : null}

        {selected ? (
          <div className="page-actions" aria-label={`Edit section ${selected.name}`}>
            <button
              type="button" className="icon-button" onClick={() => onMove(selected.id, -1)}
              disabled={disabled || selectedIndex <= 0}
              aria-label={`Move ${selected.name} up`} title="Move section up"
            >
              <ArrowUp size={14} aria-hidden="true" />
            </button>
            <button
              type="button" className="icon-button" onClick={() => onMove(selected.id, 1)}
              disabled={disabled || selectedIndex >= page.sections.length - 1}
              aria-label={`Move ${selected.name} down`} title="Move section down"
            >
              <ArrowDown size={14} aria-hidden="true" />
            </button>
            <button
              type="button" className="icon-button" onClick={() => startRename(selected)}
              disabled={disabled}
              aria-label={`Rename ${selected.name}`} title="Rename section"
            >
              <Pencil size={14} aria-hidden="true" />
            </button>
            <button
              type="button" className="icon-button danger" onClick={() => requestRemove(selected)}
              disabled={disabled || page.sections.length <= 1}
              aria-label={`Remove ${selected.name}`} title="Remove section"
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </div>
        ) : null}
        <button
          type="button" className="button secondary add-page" disabled={disabled}
          onClick={() => onAdd(selected?.id ?? null)} aria-label="Add section after the selected section"
        >
          <Plus size={15} aria-hidden="true" /> Add section
        </button>
      </dialog>

      <dialog ref={confirmRef} className="dialog" aria-labelledby="remove-section-title" onClose={() => setConfirmingId(null)}>
        <div className="dialog-heading">
          <h2 id="remove-section-title">Remove section?</h2>
          <button type="button" className="icon-button" aria-label="Close remove section confirmation" onClick={() => confirmRef.current?.close()}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <p>
          Remove “{confirming?.name}” and its {confirming?.controls.length ?? 0} {confirming?.controls.length === 1 ? "control" : "controls"}?
          This cannot be undone.
        </p>
        <div className="settings-actions">
          <button
            type="button" className="button danger" disabled={disabled || !confirming}
            onClick={() => {
              if (confirming) onRemove(confirming.id);
              confirmRef.current?.close();
            }}
          >
            Remove section
          </button>
          <button type="button" className="button secondary" ref={cancelRemoveRef} onClick={() => confirmRef.current?.close()}>
            Cancel
          </button>
        </div>
      </dialog>
    </>
  );
}
