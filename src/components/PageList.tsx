import { useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, MoreHorizontal, Pencil, Plus, Trash2, X } from "lucide-react";
import { useDialogBackdrop } from "../lib/useDialogBackdrop";
import type { Deck, Page } from "../lib/types";

interface PageListProps {
  deck: Deck;
  activePageId: string;
  onSelect: (pageId: string) => void;
  onAdd: () => void;
  onRename: (pageId: string, name: string) => void;
  onRemove: (pageId: string) => void;
  onMove: (pageId: string, delta: number) => void;
}

export function PageList({
  deck, activePageId, onSelect, onAdd, onRename, onRemove, onMove,
}: PageListProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useDialogBackdrop(dialogRef);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const activeIndex = deck.pages.findIndex((page) => page.id === activePageId);
  const active = deck.pages[Math.max(0, activeIndex)];

  const startRename = (page: Page) => {
    setRenamingId(page.id);
    setDraft(page.name);
  };
  const commitRename = () => {
    if (!renamingId) return;
    onRename(renamingId, draft);
    setRenamingId(null);
  };

  return (
    <div className="page-panel">
      <label className="sr-only" htmlFor="page-switcher">Current page</label>
      <select id="page-switcher" value={active.id} onChange={(event) => onSelect(event.target.value)}>
        {deck.pages.map((page) => <option key={page.id} value={page.id}>{page.name}</option>)}
      </select>
      <button type="button" className="icon-button" aria-label="Manage pages" title="Manage pages" onClick={() => dialogRef.current?.showModal()}>
        <MoreHorizontal size={17} aria-hidden="true" />
      </button>
      <dialog ref={dialogRef} className="dialog page-dialog" aria-labelledby="pages-title" onClose={() => setRenamingId(null)}>
        <div className="dialog-heading">
          <h2 id="pages-title">Pages</h2>
          <button type="button" className="icon-button" aria-label="Close page manager" onClick={() => dialogRef.current?.close()}><X size={16} aria-hidden="true" /></button>
        </div>
      <ul className="page-list">
        {deck.pages.map((page) => (
          <li key={page.id} className={`page-item${page.id === activePageId ? " is-active" : ""}`}>
            {renamingId === page.id ? (
              <form
                className="page-rename"
                onSubmit={(event) => { event.preventDefault(); commitRename(); }}
              >
                <label className="sr-only" htmlFor={`rename-${page.id}`}>Page name</label>
                <input
                  id={`rename-${page.id}`}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  maxLength={40}
                  autoFocus
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setRenamingId(null);
                    }
                  }}
                />
                <button type="submit" className="icon-button" aria-label={`Save name for ${page.name}`}>
                  <Check size={14} aria-hidden="true" />
                </button>
                <button
                  type="button" className="icon-button" onClick={() => setRenamingId(null)}
                  aria-label="Cancel rename"
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </form>
            ) : (
              <button
                type="button" className="page-select" onClick={() => { onSelect(page.id); dialogRef.current?.close(); }}
                aria-current={page.id === activePageId ? "page" : undefined}
              >
                <span className="page-name">{page.name}</span>
                <span className="page-count">{page.controls.length}</span>
              </button>
            )}
          </li>
        ))}
      </ul>
      <div className="page-actions" aria-label="Edit current page">
        <button
          type="button" className="icon-button" onClick={() => onMove(active.id, -1)}
          disabled={activeIndex <= 0} aria-label={`Move ${active.name} left`} title="Move page left"
        >
          <ArrowLeft size={14} aria-hidden="true" />
        </button>
        <button
          type="button" className="icon-button" onClick={() => onMove(active.id, 1)}
          disabled={activeIndex >= deck.pages.length - 1}
          aria-label={`Move ${active.name} right`} title="Move page right"
        >
          <ArrowRight size={14} aria-hidden="true" />
        </button>
        <button
          type="button" className="icon-button" onClick={() => startRename(active)}
          aria-label={`Rename ${active.name}`} title="Rename page"
        >
          <Pencil size={14} aria-hidden="true" />
        </button>
        <button
          type="button" className="icon-button danger" onClick={() => onRemove(active.id)}
          disabled={deck.pages.length <= 1} aria-label={`Remove ${active.name}`} title="Remove page"
        >
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </div>
      <button type="button" className="button secondary add-page" onClick={() => { onAdd(); dialogRef.current?.close(); }} aria-label="Add page">
        <Plus size={15} aria-hidden="true" /> Add page
      </button>
      </dialog>
    </div>
  );
}
