import { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { clampVolume, controlVolume } from "../lib/actions";
import { activePage, findPage } from "../lib/deck";
import { getStorage, loadDeck, STORAGE_KEY } from "../lib/persistence";
import type { LoadStatus } from "../lib/persistence";
import { applyTheme } from "../lib/theme";
import type { Control, Deck } from "../lib/types";
import { ControlTile } from "./ControlTile";
import { UpdateBanner } from "./UpdateBanner";

interface PhoneDeckProps {
  initialDeck: Deck;
  initialStatus: LoadStatus;
  /** "native" shows the live native deck; "browser" follows localStorage. */
  mode: "browser" | "native";
}

export function PhoneDeck({ initialDeck, initialStatus, mode }: PhoneDeckProps) {
  const [deck, setDeck] = useState(initialDeck);
  const [status, setStatus] = useState<LoadStatus>(initialStatus);
  const [pageId, setPageId] = useState(initialDeck.activePageId);
  const [previewVolumes, setPreviewVolumes] = useState<Record<string, number>>({});
  const [pressedId, setPressedId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const pressTimer = useRef<number | null>(null);

  useEffect(() => {
    applyTheme(deck.theme, deck.accent);
  }, [deck.theme, deck.accent]);

  // Native mode renders the live deck owned by App, never browser storage.
  useEffect(() => {
    if (mode === "native") setDeck(initialDeck);
  }, [mode, initialDeck]);

  useEffect(() => {
    if (mode !== "browser") return;
    const reload = () => {
      const result = loadDeck(getStorage());
      setDeck(result.deck);
      setStatus(result.status);
      setPageId((current) =>
        findPage(result.deck, current) ? current : result.deck.activePageId,
      );
    };

    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) reload();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") reload();
    };

    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("storage", onStorage);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [mode]);

  useEffect(
    () => () => {
      if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    },
    [],
  );

  const page = findPage(deck, pageId) ?? activePage(deck);

  const press = (control: Control) => {
    setPressedId(control.id);
    setNotice(`Preview only: ${control.label} pressed. No desktop action was sent.`);
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = window.setTimeout(() => setPressedId(null), 700);
  };

  const changeVolume = (control: Control, value: number) => {
    const next = clampVolume(value);
    setPreviewVolumes((current) => ({ ...current, [control.id]: next }));
    setNotice(`Preview only: volume ${next}%. No desktop action was sent.`);
  };

  return (
    <div className="phone-shell">
      <UpdateBanner />
      <header className="phone-header">
        <div className="phone-brand">
          <div className="brand-copy">
            <strong>Deck</strong>
          </div>
        </div>
        <a href="#/" className="phone-back">
          <ArrowLeft size={16} aria-hidden="true" />
          Editor
        </a>
      </header>

      <p className="phone-status">Local preview only. No desktop actions are sent.</p>

      <main className="phone-main">
        <div className="phone-page-heading">
          <h1>{page.name}</h1>
          <span className="phone-page-count">{page.controls.length} controls</span>
        </div>

        <div className="phone-grid">
          {page.controls.map((control) => (
            <ControlTile
              key={control.id}
              control={control}
              variant="phone"
              volume={previewVolumes[control.id] ?? controlVolume(control)}
              pressed={pressedId === control.id}
              onPrimary={() => press(control)}
              onVolumeChange={(value) => changeVolume(control, value)}
            />
          ))}
        </div>

        {page.controls.length === 0 ? (
          <p className="empty-note">This page has no controls yet.</p>
        ) : null}

        <p className="phone-notice" role="status" aria-live="polite">
          {notice}
        </p>

        {mode === "browser" && (status === "invalid" || status === "unavailable") ? (
          <p className="phone-storage-note">
            Saved deck unavailable; showing the sample deck. This preview is local only.
          </p>
        ) : null}
      </main>

      <footer className="phone-footer">
        <nav className="phone-pages" aria-label="Deck pages">
          {deck.pages.map((item) => (
            <button
              key={item.id}
              type="button"
              className="phone-page-tab"
              onClick={() => setPageId(item.id)}
              aria-current={item.id === page.id ? "page" : undefined}
            >
              {item.name}
            </button>
          ))}
        </nav>
      </footer>
    </div>
  );
}
