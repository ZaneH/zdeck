import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Moon, PanelRightClose, PanelRightOpen, Plus, Settings, Smartphone, Sun } from "lucide-react";
import { ACCENTS } from "./lib/types";
import type {
  Accent,
  ActionKind,
  Control,
  ControlPatch,
  ControlOptions,
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
  setupDismissed,
  dismissSetup,
  loadSidebar,
  saveSidebar,
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
import { useDesktopActions } from "./lib/useDesktopActions";
import { usePluginConsole } from "./lib/usePluginConsole";
import { enabledPluginManifests } from "./lib/plugin";
import { PluginSettingsCard } from "./components/PluginSettingsCard";
import { ActionLibrary } from "./components/ActionLibrary";
import { BrandMark } from "./components/BrandMark";
import { effectivePresentation } from "./lib/presentations";
import { ControlTile } from "./components/ControlTile";
import { Inspector } from "./components/Inspector";
import { ObsSettingsCard } from "./components/ObsSettingsCard";
import { PageList } from "./components/PageList";
import { PhoneDeck } from "./components/PhoneDeck";
import { RemoteSettingsCard } from "./components/RemoteSettingsCard";
import { useRestoreRemoteService } from "./lib/useRestoreRemoteService";
import { UpdateBanner } from "./components/UpdateBanner";
import { SetupGuide } from "./components/SetupGuide";
import { DesktopTrayNotice } from "./components/DesktopTrayNotice";
import { DesktopPreferencesCard } from "./components/DesktopPreferencesCard";

import { SettingsSections } from "./components/SettingsSections";

type Route = "editor" | "settings" | "phone";

function parseRoute(): Route {
  if (window.location.hash === "#/phone") return "phone";
  if (window.location.hash === "#/settings" || window.location.hash.startsWith("#/settings/")) return "settings";
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
  const serviceRestore = useRestoreRemoteService();
  const [initial] = useState(() => loadDeck(getStorage()));
  const [route, setRoute] = useState<Route>(() => parseRoute());
  const [sidebar, setSidebar] = useState(() => loadSidebar(getStorage()));
  const toggleSidebar = () => {
    const collapsed = !sidebar.collapsed;
    const saved = saveSidebar(getStorage(), collapsed);
    setSidebar({ collapsed, error: saved ? null : "Sidebar preference was not saved. Storage is unavailable or full; this choice may not survive a restart." });
  };
  const [deck, setDeck] = useState<Deck>(initial.deck);
  const [loadStatus, setLoadStatus] = useState<LoadStatus>(initial.status);
  const [saveError, setSaveError] = useState(initial.status === "unavailable");
  const [selectedControlId, setSelectedControlId] = useState<string | null>(
    () => activePage(initial.deck).controls[0]?.id ?? null,
  );
  const actionDialog = useRef<HTMLDialogElement>(null);
  const [setupOpen, setSetupOpen] = useState(!nativeMode && initial.status === "empty" && !setupDismissed(getStorage()));
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
  const plugin = usePluginConsole();
  const desktop = useDesktopActions({ native: nativeMode, deck, plugins: plugin.snapshots,
    editor: route === "editor" && !setupOpen && !nativeLoading && !nativeBlocked,
    savedRevision: nativeSave.phase === "saved" ? nativeSave.revision : null,
  });

  const handleNativeStatus = useCallback((status: DeckSyncStatus) => {
    setNativeSave(status);
    if (status.phase === "conflict") setNativeBlocked(status.error);
  }, []);

  const commitDeck = useCallback(
    (next: Deck) => {
      desktop.invalidate();
      setDeck(next);
      if (nativeMode) {
        syncRef.current?.update(next);
        return;
      }
      const saved = saveDeck(getStorage(), next);
      setSaveError(!saved);
      if (saved) setLoadStatus("loaded");
    },
    [nativeMode, desktop.invalidate],
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
          setNativeSave({ phase: "saved", revision: snapshot.revision });
          setSetupOpen(false);
          setDeck(snapshot.deck);
        } else {
          const browser = loadDeck(getStorage());
          const initialDeck =
            browser.status === "loaded" ? browser.deck : snapshot.deck;
          setDeck(initialDeck);
          setSetupOpen(browser.status !== "loaded" && !setupDismissed(getStorage()));
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

  const openActionPicker = () => {
    actionDialog.current?.showModal();
    actionDialog.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
  };

  const handleAddControl = (kind: ActionKind, options?: ControlOptions) => {
    const result = addControl(deck, page.id, kind, options);
    if (!result) {
      setPreviewNotice("Control limit reached on this page.");
      return;
    }
    commitDeck(result.deck);
    setSelectedControlId(result.control.id);
    setPreviewNotice(`Added ${result.control.label}. Local preview only.`);
  };

  const closeSetup = () => {
    dismissSetup(getStorage());
    setSetupOpen(false);
    window.requestAnimationFrame(() => document.getElementById("page-title")?.focus());
  };

  const finishSetup = (control: Control) => {
    const result = addControl(deck, page.id, control.action, control);
    if (!result) return false;
    commitDeck(result.deck);
    setSelectedControlId(result.control.id);
    setPreviewNotice(`Added ${result.control.label}. No desktop action was sent.`);
    closeSetup();
    return true;
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

  const handleMoveControl = (controlId: string, targetIndex: number) => {
    if (desktop.live || desktop.inflight || desktop.pending) return;
    const index = page.controls.findIndex((control) => control.id === controlId);
    const next = moveControl(deck, page.id, controlId, targetIndex - index);
    if (next === deck) return;
    commitDeck(next);
    setPreviewNotice(`Moved ${page.controls[index].label} to position ${targetIndex + 1} of ${page.controls.length}.`);
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

  if (nativeMode && nativeLoading) return <NativeGate error={null} onRetry={reloadNativeDeck} />;
  if (nativeMode && nativeBlocked) return <NativeGate error={nativeBlocked} onRetry={reloadNativeDeck} />;

  if (route === "phone") {
    return (
      <PhoneDeck
        initialDeck={deck}
        plugins={plugin.snapshots}
        initialStatus={loadStatus}
        mode={nativeMode ? "native" : "browser"}
      />
    );
  }

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

  if (setupOpen && route === "editor") {
    return <><SetupGuide pageName={page.name} canAdd={page.controls.length < MAX_CONTROLS_PER_PAGE} storageAlert={storageAlert} onFinish={finishSetup} onDismiss={closeSetup} /><UpdateBanner /></>;
  }

  return (
    <div
      className="app-shell"
      data-build={import.meta.env.VITE_BUILD_MARKER || undefined}
      onClick={(event) => {
        if (route === "editor" && event.target instanceof Element &&
          !event.target.closest(".control-tile, .inspector-dock, dialog")) setSelectedControlId(null);
      }}
    >
      <header className={`topbar${route === "settings" ? " settings-topbar" : ""}`}>
        <a className="brand" href="#/" aria-label="zDeck editor"><BrandMark /></a>
        {route === "editor" ? (
          <PageList
            deck={deck} activePageId={page.id} onSelect={handleSelectPage}
            onAdd={handleAddPage} onRename={handleRenamePage}
            onRemove={handleRemovePage} onMove={handleMovePage}
          />
        ) : <a className="back-link" href="#/"><ArrowLeft size={15} aria-hidden="true" /> Back to deck</a>}
        <div className="topbar-spacer" />
        {nativeMode && route === "editor" ? <div className="segmented desktop-mode" role="group" aria-label="Desktop control mode">
          <button type="button" className="button secondary" aria-pressed={!desktop.live} onClick={desktop.preview}>Editor</button>
          <button type="button" className="button secondary" aria-pressed={desktop.live}
            disabled={!desktop.ready || desktop.inflight || !!desktop.pending}
            onClick={() => { setPreviewNotice(null); desktop.enter(); }}>Live</button>
        </div> : null}
        {route === "editor" ? (
          <button type="button" className="button secondary add-control" disabled={page.controls.length >= MAX_CONTROLS_PER_PAGE} onClick={openActionPicker}>
            <Plus size={15} aria-hidden="true" /> Add control
          </button>
        ) : null}

        {route === "editor" ? <button type="button" className="icon-button"
          aria-label={sidebar.collapsed ? "Expand Inspector sidebar" : "Collapse Inspector sidebar"}
          aria-expanded={!sidebar.collapsed} aria-controls="inspector-sidebar" onClick={toggleSidebar}>
          {sidebar.collapsed ? <PanelRightOpen size={17} aria-hidden="true" /> : <PanelRightClose size={17} aria-hidden="true" />}
        </button> : null}

        <a
          className="button secondary"
          href="#/phone"
          aria-label="Open phone preview"
          title="Open phone preview"
        >
          <Smartphone size={16} aria-hidden="true" />
          <span>Preview</span>
        </a>

        <a
          href={route === "settings" ? "#/" : "#/settings"}
          className="icon-button"
          aria-label={route === "settings" ? "Back to editor" : "Open settings"}
          title={route === "settings" ? "Back to editor" : "Settings"}
          aria-current={route === "settings" ? "page" : undefined}
        >
          <Settings size={17} aria-hidden="true" />
        </a>
      </header>

      <DesktopTrayNotice />
      {route === "settings" ? (
        <main className="settings-view" id="main">
          <div className="settings-header">
            <h1>Settings</h1>
            <p>Phone connection, OBS, external plugin, appearance, and local storage.</p>
          </div>

          <SettingsSections phone={<>
            {serviceRestore.error ? <p className="settings-error" role="alert">{serviceRestore.error}</p> : null}
            {serviceRestore.pending ? <p role="status">Checking local service…</p> : <RemoteSettingsCard onServiceAction={serviceRestore.clearError} />}
          </>} general={<>
          <DesktopPreferencesCard />
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

          <section className="settings-card">
            <h2>Storage</h2>
            <p>{storageSummary}</p>
            <details className="storage-details">
              <summary className="disclosure">Storage details</summary>
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
                only. Valid version 1 decks are upgraded in memory and saved as version 2 on your next edit.
                Invalid, unknown-field or unsupported-version data is left unchanged until an explicit edit replaces it.
              </p>
            )}
            </details>
          </section>

          <details className="settings-card preview-scope">
            <summary className="disclosure">About this preview</summary>
            <p>
              Desktop tiles default to Editor. Explicit Live mode runs saved controls on this computer without a phone or phone service.
              Editing or leaving the editor returns to Editor. The phone preview is always simulated. In the
              desktop Inspector, OBS scene switching runs natively while OBS is
              connected. Microphone mute, output volume, and system play/pause
              work on macOS, Windows, and Linux. Audio actions read their state
              back; macOS and Windows media keys report unknown outcomes because
              sending a key cannot confirm playback. No uncertain action is retried automatically.
            </p>
            <p>
              Desktop Settings can manage the private connection and approve phones.
              Paired phones can run saved controls through the private HTTPS service.
              Real-phone installation and Tailscale connectivity still need device testing.
            </p>
          </details>

          <section className="settings-card">
            <h2>Getting started</h2>
            <p>Build and rehearse another control without changing your existing ones.</p>
            <div><button type="button" className="button secondary" onClick={() => { setSetupOpen(true); window.location.hash = "#/"; }}>Replay setup</button></div>
          </section>

          <section className="settings-card">
            <h2>Installable web app</h2>
            <p>
              A web manifest and a production-only offline shell are included. Installation
              over HTTPS or localhost is available where the browser supports it.
              Network-device installation remains unverified.
            </p>
          </section>
          </>} integrations={<>
            <ObsSettingsCard obs={obs} />
            <PluginSettingsCard plugin={plugin} />
          </>} />
        </main>
      ) : (
        <main className={`workspace${sidebar.collapsed ? " sidebar-collapsed" : ""}`} id="main">
          <section className="canvas-panel" aria-labelledby="page-title">
            <h1 id="page-title" className="sr-only" tabIndex={-1}>{page.name}</h1>
            {serviceRestore.error ? <p className="settings-error" role="alert">{serviceRestore.error} <a className="button secondary small" href="#/settings/phone">Review service settings</a></p> : null}
            {storageAlert ? (
              <p className="storage-alert" role="status">
                {storageAlert}
              </p>
            ) : null}

            {sidebar.error ? <p className="storage-alert" role="alert">{sidebar.error}</p> : null}
            {nativeMode && !desktop.ready ? <p className="desktop-mode-note">Save a valid synchronized deck before entering Live.</p> : null}
            {!desktop.live ? <p className="reorder-note">Drag tiles to reorder, or use Alt + arrow keys.</p> : null}
            <div className="deck-workbench">
              <div className="control-grid">
                {page.controls.map((control, index) => (
                  <ControlTile
                    key={control.id}
                    control={control}
                    plugins={plugin.snapshots}
                    variant="editor"
                    order={!desktop.live ? { index, total: page.controls.length, move: handleMoveControl } : undefined}
                    semantics={desktop.live ? "live" : "preview"}
                    disabled={!!desktop.pending || (desktop.inflight && !["slider", "dial"].includes(effectivePresentation(control, plugin.snapshots)))}
                    busy={desktop.inflight}
                    volume={previewVolumes[control.id] ?? controlVolume(control)}
                    selected={selectedControlId === control.id}
                    pressed={pressedId === control.id}
                    onPrimary={() => {
                      setSelectedControlId(control.id);
                      if (desktop.live && effectivePresentation(control, plugin.snapshots) === "button") {
                        void desktop.press(control.id).then(() => { if (control.action === "plugin") void plugin.refreshSnapshots(); });
                      }
                    }}
                    onVolumeChange={(value) => {
                      if (control.action !== "volume") return;
                      if (desktop.live) setPreviewVolumes((current) => ({ ...current, [control.id]: clampVolume(value) }));
                      else previewVolume(control, value);
                    }}
                    onVolumeCommit={(value) => {
                      if (desktop.live) void desktop.press(control.id, value).then(() => { if (control.action === "plugin") void plugin.refreshSnapshots(); });
                    }}
                  />
                ))}
                {page.controls.length === 0 ? (
                  <button
                    type="button"
                    className="empty-key"
                    onClick={openActionPicker}
                  >
                    <Plus size={20} aria-hidden="true" /> Add your first control
                  </button>
                ) : null}
              </div>
            </div>

          </section>

          <section className="inspector-dock" id="inspector-sidebar" aria-label="Control properties" hidden={sidebar.collapsed}>
            {selectedControl && !desktop.live ? <label className="field"><span>Position</span>
              <select aria-label={`Position of ${selectedControl.label}`} value={page.controls.indexOf(selectedControl)}
                disabled={desktop.inflight || !!desktop.pending}
                onChange={(event) => handleMoveControl(selectedControl.id, Number(event.target.value))}
                onKeyDown={(event) => {
                  if (event.altKey || event.ctrlKey || event.metaKey) return;
                  const index = page.controls.indexOf(selectedControl);
                  const target = event.key === "Home" ? 0 : event.key === "End" ? page.controls.length - 1
                    : event.key === "ArrowUp" ? Math.max(0, index - 1)
                    : event.key === "ArrowDown" ? Math.min(page.controls.length - 1, index + 1) : null;
                  if (target === null) return;
                  event.preventDefault();
                  handleMoveControl(selectedControl.id, target);
                }}>
                {page.controls.map((control, index) => <option key={control.id} value={index}>{index + 1} of {page.controls.length}</option>)}
              </select>
            </label> : null}
            <Inspector
              key={selectedControl?.id ?? "empty"}
              control={selectedControl}
              pageName={page.name}
              obs={obs}
              system={system}
              plugin={plugin}
              previewVolume={selectedControl ? previewVolumes[selectedControl.id] ?? controlVolume(selectedControl) : 0}
              onPatch={handlePatchControl}
              onRemove={handleRemoveControl}
              onPreviewPress={() => selectedControl && previewControl(selectedControl)}
              onPreviewVolume={(value) =>
                selectedControl && previewVolume(selectedControl, value)
              }
            />
          </section>
          <footer className="workspace-footer">
            {desktop.live ? <span className="desktop-live-indicator" role="status" aria-label="Live: controls run on this computer">LIVE</span> : null}
            {desktop.error || (desktop.result && desktop.result.state !== "confirmed" && desktop.result.code !== "media_key_sent") ? <p className={`native-feedback is-${desktop.result?.state ?? "failed"}`} role="alert">
              {desktop.error ?? desktop.result?.message}
            </p> : !desktop.live && previewNotice ? <p className="preview-feedback" role="status">{previewNotice}</p> : null}
            {desktop.pending ? <button type="button" className="button secondary" disabled={desktop.inflight} onClick={() => void desktop.check().then(() => plugin.refreshSnapshots())}>Check result</button> : null}
          </footer>
          <ActionLibrary
            dialogRef={actionDialog} pageName={page.name}
            manifests={enabledPluginManifests(plugin.snapshots)}
            disabled={page.controls.length >= MAX_CONTROLS_PER_PAGE} onAdd={handleAddControl}
          />
        </main>
      )}

      <UpdateBanner />
    </div>
  );
}
