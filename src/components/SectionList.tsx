import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { GripVertical, Plus, Trash2, X } from "lucide-react";
import { ACCENTS } from "../lib/types";
import type { Accent, Deck, Page, Section, Theme } from "../lib/types";
import { sectionNameError, sectionStyle } from "../lib/sections";
import { useDialogBackdrop } from "../lib/useDialogBackdrop";
import { SectionSettingsMenu } from "./SectionSettingsMenu";

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
  /** Renders the control grid for one section. */
  renderControls: (section: Section) => ReactNode;
}

export function SectionList({
  deck, page, selectedSectionId, disabled = false,
  onSelect, onAdd, onRename, onRemove, onMove, onTheme, onAccent, renderControls,
}: SectionListProps) {
  const confirmRef = useRef<HTMLDialogElement>(null);
  const cancelRemoveRef = useRef<HTMLButtonElement>(null);
  useDialogBackdrop(confirmRef);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const drag = useRef<{ id: number; sectionId: string; x: number; y: number; active: boolean } | null>(null);
  const skipBlur = useRef(false);

  const selected = page.sections.find((section) => section.id === selectedSectionId)
    ?? page.sections[0];
  const confirming = confirmingId
    ? page.sections.find((section) => section.id === confirmingId) ?? null
    : null;
  const accentName = ACCENTS.find((accent) => accent.value === deck.accent)?.name ?? deck.accent;

  useEffect(() => {
    setEditingId(null);
    setRenameError(null);
    setConfirmingId(null);
    setDraggingId(null);
    setDropId(null);
  }, [page.id]);

  useEffect(() => {
    if (confirmingId && !confirming) setConfirmingId(null);
  }, [confirming, confirmingId]);

  const startRename = (section: Section) => {
    setEditingId(section.id);
    setDraft(section.name);
    setRenameError(null);
  };
  const commitRename = (section: Section) => {
    if (editingId !== section.id) return;
    const error = sectionNameError(draft);
    if (error) {
      setRenameError(error);
      return;
    }
    onRename(section.id, draft);
    setEditingId(null);
    setRenameError(null);
  };
  const cancelRename = () => {
    setEditingId(null);
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

  const clearDrag = () => {
    drag.current = null;
    setDraggingId(null);
    setDropId(null);
  };
  const finishDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const gesture = drag.current;
    const hit = gesture?.active
      ? document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".deck-section")?.dataset.sectionId
      : undefined;
    const sourceIndex = gesture ? page.sections.findIndex((section) => section.id === gesture.sectionId) : -1;
    const targetIndex = hit ? page.sections.findIndex((section) => section.id === hit) : -1;
    clearDrag();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!disabled && sourceIndex >= 0 && targetIndex >= 0 && targetIndex !== sourceIndex) {
      onMove(gesture!.sectionId, targetIndex - sourceIndex);
    }
  };

  return (
    <>
      <div className="section-panel">
        <button
          type="button" className="button secondary small"
          aria-label="Add section" title="Add section after the selected one"
          disabled={disabled} onClick={() => onAdd(selected?.id ?? null)}
        >
          <Plus size={15} aria-hidden="true" /> Add section
        </button>
      </div>

      <div className="deck-sections">
        {page.sections.map((section, index) => {
          const editing = editingId === section.id;
          const error = editing ? renameError : null;
          return (
            <section
              key={section.id} id={`section-card-${section.id}`} data-section-id={section.id}
              className={`deck-section${section.id === selected?.id ? " is-selected" : ""}${section.id === draggingId ? " is-dragging" : ""}${section.id === dropId ? " is-drop-target" : ""}`}
              data-theme={section.theme} style={sectionStyle(section)}
              aria-labelledby={`section-${section.id}`}
            >
              <h2 id={`section-${section.id}`} className="sr-only">{section.name}</h2>
              <header className="deck-section-head" onClick={() => onSelect(section.id)}>
                <button
                  type="button" className="icon-button section-drag"
                  aria-label={`Reorder ${section.name}`} title="Drag to reorder, or press Alt + Up/Down"
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown" disabled={disabled}
                  onPointerDown={(event) => {
                    if (disabled || event.button !== 0) return;
                    event.preventDefault();
                    event.currentTarget.focus();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    drag.current = { id: event.pointerId, sectionId: section.id, x: event.clientX, y: event.clientY, active: false };
                  }}
                  onPointerMove={(event) => {
                    const gesture = drag.current;
                    if (!gesture || disabled) return;
                    if (!gesture.active) {
                      if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 5) return;
                      gesture.active = true;
                      setDraggingId(gesture.sectionId);
                    }
                    const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>(".deck-section")?.dataset.sectionId;
                    setDropId(hit && hit !== gesture.sectionId ? hit : null);
                  }}
                  onPointerUp={finishDrag}
                  onPointerCancel={clearDrag}
                  onLostPointerCapture={(event) => { if (event.target === event.currentTarget) clearDrag(); }}
                  onKeyDown={(event) => {
                    if (disabled || !event.altKey || event.ctrlKey || event.metaKey) return;
                    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                    event.preventDefault();
                    onMove(section.id, event.key === "ArrowUp" ? -1 : 1);
                  }}
                >
                  <GripVertical size={15} aria-hidden="true" />
                </button>

                <input
                  className="section-name-input"
                  value={editing ? draft : section.name}
                  readOnly={!editing}
                  disabled={disabled}
                  aria-label="Section name"
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? `section-rename-error-${section.id}` : undefined}
                  onFocus={() => {
                    onSelect(section.id);
                    if (!editing) startRename(section);
                  }}
                  onClick={() => { if (!editing) startRename(section); }}
                  onChange={(event) => { setDraft(event.target.value); setRenameError(null); }}
                  onBlur={() => {
                    if (skipBlur.current) { skipBlur.current = false; return; }
                    if (editing) commitRename(section);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      skipBlur.current = true;
                      cancelRename();
                      event.currentTarget.blur();
                    }
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.currentTarget.blur();
                    }
                  }}
                />
                <div className="section-actions">
                  <SectionSettingsMenu
                    sectionName={section.name} controlCount={section.controls.length}
                    theme={section.theme ?? null} accent={section.accent ?? null}
                    inheritedTheme={deck.theme} inheritedAccentName={accentName}
                    disabled={disabled}
                    onTheme={(theme) => onTheme(section.id, theme)}
                    onAccent={(accent) => onAccent(section.id, accent)}
                  />
                  <button
                    type="button" className="icon-button danger"
                    aria-label={`Remove ${section.name}`} title="Remove section"
                    disabled={disabled || page.sections.length <= 1}
                    onClick={() => requestRemove(section)}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
              </header>
              {error ? <p id={`section-rename-error-${section.id}`} className="section-error" role="alert">{error}</p> : null}
              <div className="section-body">{renderControls(section)}</div>
              <span className="sr-only">Section {index + 1} of {page.sections.length}</span>
            </section>
          );
        })}
      </div>

      <dialog ref={confirmRef} className="dialog" aria-labelledby="remove-section-title" onClose={() => {
        // A queued close event must not clear a newly reopened confirmation.
        if (!confirmRef.current?.open) setConfirmingId(null);
      }}>
        <div className="dialog-heading">
          <h2 id="remove-section-title">Remove section?</h2>
          <button type="button" className="icon-button" aria-label="Close remove section confirmation" onClick={() => confirmRef.current?.close()}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="dialog-body">
          <p>
            Remove “{confirming?.name}” and its {confirming?.controls.length ?? 0} {confirming?.controls.length === 1 ? "control" : "controls"}?
          </p>
          <p className="field-note">This cannot be undone.</p>
        </div>
        <div className="dialog-actions">
          <button type="button" className="button secondary" ref={cancelRemoveRef} onClick={() => confirmRef.current?.close()}>
            Cancel
          </button>
          <button
            type="button" className="button danger" disabled={disabled || !confirming}
            onClick={() => {
              if (confirming) onRemove(confirming.id);
              confirmRef.current?.close();
            }}
          >
            Remove section
          </button>
        </div>
      </dialog>
    </>
  );
}
