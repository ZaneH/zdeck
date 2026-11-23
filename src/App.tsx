import { useCallback, useEffect, useRef, useState } from "react";
import { LayoutGrid, Link2Off, Moon, Settings, Smartphone, Sun } from "lucide-react";
import { ACCENTS } from "./lib/types";
import type {
  Accent,
  ActionKind,
  Control,
  ControlPatch,
  Deck,
  Theme,
} from "./lib/types";
import { clampVolume, controlVolume } from "./lib/actions";
import {
  MAX_CONTROLS_PER_PAGE,
  activePage,
  addControl,
  addPage,
  findControl,
  findPage,
  moveControl,
  movePage,
  removeControl,
  removePage,
  renamePage,
  setAccent,
  setActivePage,
  setTheme,
  updateControl,
} from "./lib/deck";
import {
  getStorage,
  loadDeck,
  saveDeck,
  STORAGE_KEY,
} from "./lib/persistence";
import type { LoadStatus } from "./lib/persistence";
import { nativeAvailable } from "./lib/native";
import {
  nativeDeckLoad,
  nativeDeckSave,
  NATIVE_DECK_FILE_NAME,
  toDeckError,
} from "./lib/nativeDeck";
import type { DeckError } from "./lib/nativeDeck";
import { DeckSync } from "./lib/deckSync";
import type { DeckSyncStatus } from "./lib/deckSync";
import { applyTheme } from "./lib/theme";
import { useObsConsole } from "./lib/useObsConsole";
import { useSystemConsole } from "./lib/useSystemConsole";
import { ActionLibrary } from "./components/ActionLibrary";
import { ControlTile } from "./components/ControlTile";
import { Inspector } from "./components/Inspector";
import { ObsSettingsCard } from "./components/ObsSettingsCard";
import { PageList } from "./components/PageList";
import { PhoneDeck } from "./components/PhoneDeck";
import { UpdateBanner } from "./components/UpdateBanner";

type Route = "editor" | "settings" | "phone";

function parseRoute(): Route {
  if (window.location.hash === "#/phone") return "phone";
  if (window.location.hash === "#/settings") return "settings";
  return "editor";
}

/** Full-window loading and recovery screen for the native deck store. */
function NativeGate({
  error,
  onRetry,
}: {
  error: DeckError | null;
  onRetry: () => void;
}) {
  return (
    <div className="app-shell">
      <main className="settings-view" id="main">
        <div className="settings-header">
          <p className="eyebrow">Desktop storage</p>
          <h1>{error ? "The deck file needs attention" : "Loading the desktop deck…"}</h1>
          {error ? (
            <>
              <p>{error.message}</p>
              <p className="muted">
                The existing file was not changed and nothing was overwritten.
                {error.kind === "conflict"
                  ? " Another writer changed the deck after this window loaded."
                  : " Fix or move the file, then reload."}
              </p>
              <p className="muted">
                Native file: <code>{NATIVE_DECK_FILE_NAME}</code> in the desktop
                app's app-data directory.
              </p>
              <button
                type="button"
                className="button secondary"
                onClick={onRetry}
              >
                Reload deck
              </button>
            </>
          ) : (
            <p>
              Reading the authoritative deck file before enabling edits.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}

export default function App() {
  const nativeMode = nativeAvailable();
  const [initial] = useState(() => loadDeck(getStorage()));
  const [route, setRoute] = useState<Route>(() => parseRoute());
  const [deck, setDeck] = useState<Deck>(initial.deck);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>(initial.status);
  const [saveError, setSaveError] = useState(initial.status === "unavailable");
  const [selectedControlId, setSelectedControlId] = useState<string | null>(null);
  const [previewVolumes, setPreviewVolumes] = useState<Record<string, number>>({});
  const [previewNotice, setPreviewNotice] = useState<string | null>(null);
  const [pressedId, setPressedId] = useState<string | null>(null);
  const [nativeLoading, setNativeLoading] = useState(nativeMode);
  const [nativeBlocked, setNativeBlocked] = useState<DeckError | null>(null);
  const [nativeSave, setNativeSave] = useState<DeckSyncStatus>({ phase: "idle" });
  const [reloadToken, setReloadToken] = useState(0);
  const syncRef = useRef<DeckSync | null>(null);
  const pressTimer = useRef<number | null>(null);
  const obs = useObsConsole();
  const system = useSystemConsole();

  const handleNativeStatus = useCallback((status: DeckSyncStatus) => {
    setNativeSave(status);
    if (status.phase === "conflict") setNativeBlocked(status.error);
  }, []);

  const commitDeck = useCallback(
    (next: Deck) => {
      setDeck(next);
      if (nativeMode) {
        syncRef.current?.update(next);
        return;
      }
      const saved = saveDeck(getStorage(), next);
      setSaveError(!saved);
      if (saved) setLoadStatus("loaded");
    },
    [nativeMode],
  );

  // Native: load the authoritative deck before enabling edits. A missing file
  // is initialized once from the browser-local deck (if any) or the default,
  // through an explicit revision-0 compare-and-swap.
  useEffect(() => {
    if (!nativeMode) return;
    let cancelled = false;
    setNativeLoading(true);
    setNativeBlocked(null);
    setNativeSave({ phase: "idle" });
    syncRef.current = null;

    void (async () => {
      try {
        const snapshot = await nativeDeckLoad();
        if (cancelled) return;
        const sync = new DeckSync(
          { load: nativeDeckLoad, save: nativeDeckSave },
          handleNativeStatus,
          snapshot.revision,
        );
        syncRef.current = sync;
        setLoadStatus("loaded");
        if (snapshot.exists) {
          setDeck(snapshot.deck);
        } else {
          const browser = loadDeck(getStorage());
          const initialDeck =
            browser.status === "loaded" ? browser.deck : snapshot.deck;
          setDeck(initialDeck);
          sync.update(initialDeck);
        }
        setNativeLoading(false);
      } catch (value) {
        if (cancelled) return;
        setNativeLoading(false);
        setNativeBlocked(toDeckError(value));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [nativeMode, handleNativeStatus, reloadToken]);

  const reloadNativeDeck = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(parseRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (nativeMode) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY && event.key !== null) return;
      const result = loadDeck(getStorage());
      setDeck(result.deck);
      setLoadStatus(result.status);
      setSaveError(result.status === "unavailable");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [nativeMode]);

  useEffect(() => {
    applyTheme(deck.theme, deck.accent);
  }, [deck.theme, deck.accent]);

  useEffect(
    () => () => {
      if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    },
    [],
  );

  const page = activePage(deck);
  const selectedControl = selectedControlId
    ? findControl(deck, page.id, selectedControlId) ?? null
    : null;
  const selectedIndex = selectedControl
    ? page.controls.findIndex((control) => control.id === selectedControl.id)
    : -1;

  useEffect(() => {
    if (selectedControlId && !findControl(deck, page.id, selectedControlId)) {
      setSelectedControlId(null);
    }
  }, [deck, page.id, selectedControlId]);

  const previewControl = (control: Control) => {
    setPressedId(control.id);
    setPreviewNotice(`Preview only: ${control.label} pressed. No desktop action was sent.`);
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = window.setTimeout(() => setPressedId(null), 700);
  };

  const previewVolume = (control: Control, value: number) => {
    const next = clampVolume(value);
    setPreviewVolumes((current) => ({ ...current, [control.id]: next }));
    setPreviewNotice(`Preview only: volume ${next}%. No desktop action was sent.`);
  };

  const handleAddControl = (kind: ActionKind) => {
    const result = addControl(deck, page.id, kind);
    if (!result) {
      setPreviewNotice("Control limit reached on this page.");
      return;
    }
    commitDeck(result.deck);
    setSelectedControlId(result.control.id);
    setPreviewNotice(`Added ${result.control.label}. Local preview only.`);
  };

  const handlePatchControl = (patch: ControlPatch) => {
    if (!selectedControl) return;
    commitDeck(updateControl(deck, page.id, selectedControl.id, patch));
  };

  const handleRemoveControl = () => {
    if (!selectedControl) return;
    commitDeck(removeControl(deck, page.id, selectedControl.id));
    setSelectedControlId(null);
    setPreviewNotice("Control removed. Local preview only.");
  };

  const handleMoveControl = (control: Control, delta: number) => {
    commitDeck(moveControl(deck, page.id, control.id, delta));
  };

  const handleSelectPage = (pageId: string) => {
    commitDeck(setActivePage(deck, pageId));
    setSelectedControlId(null);
    setPreviewNotice(null);
  };

  const handleAddPage = () => {
    const result = addPage(deck);
    if (!result) {
      setPreviewNotice("Page limit reached (12).");
      return;
    }
    commitDeck(result.deck);
    setSelectedControlId(null);
    setPreviewNotice(`Added ${result.page.name}. Local preview only.`);
  };

  const handleRenamePage = (pageId: string, name: string) => {
    commitDeck(renamePage(deck, pageId, name));
  };

  const handleRemovePage = (pageId: string) => {
    const target = findPage(deck, pageId);
    if (!target) return;
    if (deck.pages.length <= 1) {
      setPreviewNotice("A deck needs at least one page.");
      return;
    }
    if (!window.confirm(`Remove page “${target.name}” and its controls?`)) return;
    commitDeck(removePage(deck, pageId));
    setSelectedControlId(null);
    setPreviewNotice("Page removed. Local preview only.");
  };

  const handleMovePage = (pageId: string, delta: number) => {
    commitDeck(movePage(deck, pageId, delta));
  };

  const handleTheme = (theme: Theme) => commitDeck(setTheme(deck, theme));
  const handleAccent = (accent: Accent) => commitDeck(setAccent(deck, accent));
  const toggleTheme = () => handleTheme(deck.theme === "dark" ? "light" : "dark");

  if (nativeMode && nativeLoading) return <NativeGate error={null} onRetry={reloadNativeDeck} />;
  if (nativeMode && nativeBlocked) return <NativeGate error={nativeBlocked} onRetry={reloadNativeDeck} />;

  if (route === "phone") {
    return (
      <PhoneDeck
        initialDeck={deck}
        initialStatus={loadStatus}
        mode={nativeMode ? "native" : "browser"}
      />
    );
  }

  const obsPill = !obs.native
    ? {
        title: "This build has no desktop connection.",
        strong: "Local preview",
        rest: "Desktop not connected",
        live: false,
      }
    : obs.status === "connected"
      ? {
          title: `Connected to local OBS. Last checked ${new Date(
            obs.snapshot?.observedAtMs ?? Date.now(),
          ).toLocaleTimeString()}.`,
          strong: "OBS connected",
          rest: obs.currentScene ? `Scene: ${obs.currentScene}` : "Scene unknown",
          live: true,
        }
      : obs.status === "connecting"
        ? {
            title: "Connecting to the local OBS Studio WebSocket server.",
            strong: "Connecting to OBS",
            rest: "…",
            live: false,
          }
        : {
            title: "The desktop app is running; OBS is not connected.",
            strong: "OBS not connected",
            rest: "Local preview only",
            live: false,
          };

  const nativeWriteError =
    nativeSave.phase === "error" || nativeSave.phase === "conflict"
      ? nativeSave.error
      : null;

  const storageAlert = nativeMode
    ? nativeWriteError?.message ?? null
    : saveError
      ? "Changes are not being saved. Local storage is unavailable or full."
      : loadStatus === "invalid"
        ? "Saved deck data was invalid; showing the sample deck. Your next change will replace it."
        : loadStatus === "unavailable"
          ? "Local storage is unavailable. This session is preview-only and changes will not persist."
          : null;

  const storageSummary = nativeMode
    ? nativeSave.phase === "saving"
      ? "Saving to the desktop deck file…"
      : nativeSave.phase === "saved"
        ? "Saved to the desktop deck file."
        : nativeSave.phase === "error" || nativeSave.phase === "conflict"
          ? nativeSave.error.message
          : "Loaded from the desktop deck file."
    : saveError
      ? "Saving failed. Local storage is unavailable or full."
      : loadStatus === "loaded"
        ? "Saved to this browser."
        : loadStatus === "empty"
          ? "No saved deck yet. The sample deck is shown."
          : loadStatus === "invalid"
            ? "Saved data was invalid. The sample deck is shown."
            : "Local storage is unavailable.";

  return (
    <div
      className="app-shell"
      data-build={import.meta.env.VITE_BUILD_MARKER || undefined}
    >
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <LayoutGrid size={18} />
          </span>
          <div className="brand-copy">
            <span className="brand-name">Deck</span>
            <span className="brand-tag">provisional name</span>
          </div>
        </div>

        <div className="topbar-spacer" />

        <div className="status-pill" title={obsPill.title}>
          <span
            className={`status-dot${obsPill.live ? " is-live" : ""}`}
            aria-hidden="true"
          />
          <span>
            <strong>{obsPill.strong}</strong>
            <span className="status-sep"> / </span>
            {obsPill.rest}
          </span>
        </div>

        <button
          type="button"
          className="button secondary theme-toggle"
          onClick={toggleTheme}
          aria-label={`Switch to ${deck.theme === "dark" ? "light" : "dark"} theme`}
        >
          {deck.theme === "dark" ? (
            <Sun size={16} aria-hidden="true" />
          ) : (
            <Moon size={16} aria-hidden="true" />
          )}
          <span>{deck.theme === "dark" ? "Light" : "Dark"}</span>
        </button>

        <a
          className="button secondary"
          href="#/phone"
          aria-label="Open phone preview"
          title="Open phone preview"
        >
          <Smartphone size={16} aria-hidden="true" />
          <span>Phone preview</span>
        </a>

        <div className="pairing">
          <button
            type="button"
            className="button secondary"
            disabled
            aria-label="Pair device (unavailable: desktop service not built)"
            title="Pairing needs the desktop connection service, which is not built yet."
          >
            <Link2Off size={16} aria-hidden="true" />
            <span>Pair device</span>
          </button>
          <span className="pairing-note">Pairing needs the desktop service (not built).</span>
        </div>
      </header>

      <nav className="nav" aria-label="Primary">
        <a
          href="#/"
          className={route === "editor" ? "is-active" : undefined}
          aria-current={route === "editor" ? "page" : undefined}
        >
          <LayoutGrid size={18} aria-hidden="true" />
          <span>Decks</span>
        </a>
        <a
          href="#/settings"
          className={route === "settings" ? "is-active" : undefined}
          aria-current={route === "settings" ? "page" : undefined}
        >
          <Settings size={18} aria-hidden="true" />
          <span>Settings</span>
        </a>
        <div className="nav-spacer" />
        <p className="nav-note">
          {obs.native ? "Native desktop shell" : "Browser preview only"}
          <br />
          {obs.status === "connected" ? "OBS connected" : "OBS not connected"}
        </p>
      </nav>

      {route === "settings" ? (
        <main className="settings-view" id="main">
          <div className="settings-header">
            <p className="eyebrow">Settings</p>
            <h1>Local editor</h1>
            <p>
              Deck is a provisional name. This build is a local editor and
              phone-preview foundation. OBS scene switching runs natively when you
              connect OBS in the desktop app. On Linux, the Inspector can also run
              real default-microphone mute, output-volume, and media play/pause
              actions; phone preview and toolbar tile presses stay local.
            </p>
          </div>

          <section className="settings-card">
            <h2>Appearance</h2>
            <div className="field">
              <span>Theme</span>
              <div className="segmented">
                <button
                  type="button"
                  className="button secondary"
                  aria-pressed={deck.theme === "dark"}
                  onClick={() => handleTheme("dark")}
                >
                  <Moon size={16} aria-hidden="true" />
                  Dark
                </button>
                <button
                  type="button"
                  className="button secondary"
                  aria-pressed={deck.theme === "light"}
                  onClick={() => handleTheme("light")}
                >
                  <Sun size={16} aria-hidden="true" />
                  Light
                </button>
              </div>
            </div>
            <fieldset className="field accent-field">
              <legend>Accent</legend>
              <div className="accent-grid">
                {ACCENTS.map((accent) => (
                  <button
                    key={accent.value}
                    type="button"
                    className="accent-button"
                    aria-pressed={deck.accent === accent.value}
                    aria-label={`Use ${accent.name} accent`}
                    onClick={() => handleAccent(accent.value)}
                  >
                    <span
                      className="accent-swatch"
                      style={{ backgroundColor: accent.value }}
                      aria-hidden="true"
                    />
                    <span>{accent.name}</span>
                  </button>
                ))}
              </div>
            </fieldset>
          </section>

          <ObsSettingsCard obs={obs} />

          <section className="settings-card">
            <h2>Storage</h2>
            <p>{storageSummary}</p>
            {nativeMode ? (
              <p className="muted">
                Saved as a versioned, validated JSON document in{" "}
                <code>{NATIVE_DECK_FILE_NAME}</code> under the desktop app's app-data
                directory. Edits are written atomically with a revision check. A missing
                file is initialized once from this browser's saved deck or the sample
                deck. An invalid or newer file is left unchanged and the app asks you to
                fix it instead of overwriting it.
              </p>
            ) : (
              <p className="muted">
                Saved as versioned JSON under <code>{STORAGE_KEY}</code> in this browser
                only. Invalid or older data is ignored and the sample deck is loaded.
              </p>
            )}
          </section>

          <section className="settings-card">
            <h2>Preview scope</h2>
            <p>
              Toolbar tile presses and the phone preview are local only. In the
              desktop Inspector, OBS scene switching runs natively while OBS is
              connected, and on Linux the microphone mute, output-volume, and
              media play/pause actions run against system session services. Every
              native action reads its state back and reports pending, confirmed,
              not applied, failed, or unknown results.
            </p>
            <p>
              Pairing is disabled because the desktop connection service is not built. No
              connected or success state is simulated.
            </p>
          </section>

          <section className="settings-card">
            <h2>Installable web app</h2>
            <p>
              A web manifest and a production-only offline shell are included. Installation
              over HTTPS or localhost is available where the browser supports it.
              Network-device installation remains unverified.
            </p>
          </section>
        </main>
      ) : (
        <main className="workspace" id="main">
          <PageList
            deck={deck}
            activePageId={page.id}
            onSelect={handleSelectPage}
            onAdd={handleAddPage}
            onRename={handleRenamePage}
            onRemove={handleRemovePage}
            onMove={handleMovePage}
          />

          <section className="canvas-panel" aria-labelledby="page-title">
            {storageAlert ? (
              <p className="storage-alert" role="status">
                {storageAlert}
              </p>
            ) : null}

            <div className="canvas-header">
              <div>
                <p className="eyebrow">Deck page</p>
                <h1 id="page-title">{page.name}</h1>
                <p className="canvas-subtitle">
                  {page.controls.length} controls · Local preview only
                </p>
              </div>
              <span className="preview-badge">Preview only</span>
            </div>

            <div className="control-grid">
              {page.controls.map((control, index) => (
                <ControlTile
                  key={control.id}
                  control={control}
                  variant="editor"
                  volume={previewVolumes[control.id] ?? controlVolume(control)}
                  selected={selectedControlId === control.id}
                  pressed={pressedId === control.id}
                  onPrimary={() => setSelectedControlId(control.id)}
                  onVolumeChange={(value) => previewVolume(control, value)}
                  onMove={(delta) => handleMoveControl(control, delta)}
                  canMoveUp={index > 0}
                  canMoveDown={index < page.controls.length - 1}
                />
              ))}
            </div>

            {page.controls.length === 0 ? (
              <div className="empty-canvas">
                <p>No controls on this page yet.</p>
                <p>Add one from the action library to start shaping the deck.</p>
              </div>
            ) : null}

            <p className="preview-feedback" role="status" aria-live="polite">
              {previewNotice ??
                "Select a control or add one from the action library. Nothing is sent to the desktop."}
            </p>
          </section>

          <aside className="right-panel" aria-label="Actions and inspector">
            <ActionLibrary
              pageName={page.name}
              disabled={page.controls.length >= MAX_CONTROLS_PER_PAGE}
              onAdd={handleAddControl}
            />
            <Inspector
              control={selectedControl}
              pageName={page.name}
              obs={obs}
              system={system}
              previewVolume={selectedControl ? previewVolumes[selectedControl.id] ?? controlVolume(selectedControl) : 0}
              canMoveUp={selectedIndex > 0}
              canMoveDown={selectedIndex >= 0 && selectedIndex < page.controls.length - 1}
              onPatch={handlePatchControl}
              onRemove={handleRemoveControl}
              onMove={(delta) => selectedControl && handleMoveControl(selectedControl, delta)}
              onPreviewPress={() => selectedControl && previewControl(selectedControl)}
              onPreviewVolume={(value) =>
                selectedControl && previewVolume(selectedControl, value)
              }
            />
          </aside>
        </main>
      )}

      <UpdateBanner />
    </div>
  );
}
