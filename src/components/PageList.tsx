import { useState } from "react";
import { ArrowDown, ArrowUp, Check, Pencil, Plus, Trash2, X } from "lucide-react";
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
  deck,
  activePageId,
  onSelect,
  onAdd,
  onRename,
  onRemove,
  onMove,
}: PageListProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

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
    <aside className="page-panel" aria-label="Deck pages">
      <div className="panel-heading">
        <h2>Pages</h2>
        <button
          type="button"
          className="icon-button"
          onClick={onAdd}
          aria-label="Add page"
          title="Add page"
        >
          <Plus size={18} aria-hidden="true" />
        </button>
      </div>

      <ul className="page-list">
        {deck.pages.map((page, index) => {
          const isActive = page.id === activePageId;
          return (
            <li key={page.id} className={`page-item${isActive ? " is-active" : ""}`}>
              {renamingId === page.id ? (
                <form
                  className="page-rename"
                  onSubmit={(event) => {
                    event.preventDefault();
                    commitRename();
                  }}
                >
                  <label className="sr-only" htmlFor={`rename-${page.id}`}>
                    Page name
                  </label>
                  <input
                    id={`rename-${page.id}`}
                    type="text"
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
                  <button
                    type="submit"
                    className="icon-button"
                    aria-label={`Save name for ${page.name}`}
                  >
                    <Check size={16} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => setRenamingId(null)}
                    aria-label="Cancel rename"
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                </form>
              ) : (
                <>
                  <button
                    type="button"
                    className="page-select"
                    onClick={() => onSelect(page.id)}
                    aria-current={isActive ? "page" : undefined}
                  >
                    <span className="page-dot" aria-hidden="true" />
                    <span className="page-name">{page.name}</span>
                    <span className="page-count">{page.controls.length}</span>
                  </button>
                  {isActive ? (
                    <div className="page-actions">
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => onMove(page.id, -1)}
                        disabled={index === 0}
                        aria-label={`Move ${page.name} up`}
                        title="Move page up"
                      >
                        <ArrowUp size={15} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => onMove(page.id, 1)}
                        disabled={index === deck.pages.length - 1}
                        aria-label={`Move ${page.name} down`}
                        title="Move page down"
                      >
                        <ArrowDown size={15} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => startRename(page)}
                        aria-label={`Rename ${page.name}`}
                        title="Rename page"
                      >
                        <Pencil size={15} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="icon-button danger"
                        onClick={() => onRemove(page.id)}
                        disabled={deck.pages.length <= 1}
                        aria-label={`Remove ${page.name}`}
                        title="Remove page"
                      >
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    </div>
                  ) : null}
                </>
              )}
            </li>
          );
        })}
      </ul>


    </aside>
  );
}
