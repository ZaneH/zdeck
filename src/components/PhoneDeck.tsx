import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { clampVolume, controlVolume } from "../lib/actions";
import { activePage, findPage, pageControls } from "../lib/deck";
import { sectionStyle } from "../lib/sections";
import { resolveDeckTheme, resolveSectionTheme } from "../lib/customThemes";
import type { InstalledTheme } from "../lib/customThemes";
import { getStorage, loadDeck, STORAGE_KEY } from "../lib/persistence";
import type { LoadStatus } from "../lib/persistence";
import { applyTheme } from "../lib/theme";
import type { PluginSnapshots } from "../lib/plugin";
import type { Control, Deck } from "../lib/types";
import { BrandMark } from "./BrandMark";
import { ControlTile } from "./ControlTile";
import { PhoneSectionNav, usePhoneNavigation } from "./phoneNavigation";
import { UpdateBanner } from "./UpdateBanner";

interface PhoneDeckProps {
  plugins?: PluginSnapshots;
  initialDeck: Deck;
  initialStatus: LoadStatus;
  /** "native" shows the live native deck; "browser" follows localStorage. */
  mode: "browser" | "native";
  /** Exact installed packages for resolving custom references; empty when unavailable. */
  installedThemes?: InstalledTheme[];
}

export function PhoneDeck({ initialDeck, initialStatus, mode, plugins = {}, installedThemes = [] }: PhoneDeckProps) {
  const [deck, setDeck] = useState(initialDeck);
  const [status, setStatus] = useState<LoadStatus>(initialStatus);
  const [pageId, setPageId] = useState(initialDeck.activePageId);
  const [previewVolumes, setPreviewVolumes] = useState<Record<string, number>>({});
  const [pressedId, setPressedId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [orientation, setOrientation] = useState<"portrait" | "landscape">("landscape");
  const pressTimer = useRef<number | null>(null);
  const scrollerRef = useRef<HTMLElement>(null);

  const deckTheme = resolveDeckTheme(deck, installedThemes);
  useEffect(() => {
    applyTheme(deckTheme.appearance, deck.accent, deckTheme.custom?.package.appearance ?? null);
  }, [deckTheme.appearance, deck.accent, installedThemes, deck.customTheme?.digest]);

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
  const navigation = usePhoneNavigation({
    pageId: page.id,
    pageIds: deck.pages.map((item) => item.id),
    sectionIds: page.sections.map((section) => section.id),
    onPageChange: setPageId,
    scrollerRef,
  });

  const surfaceSection = page.sections[navigation.sectionIndex] ?? page.sections[0];
  const surface = resolveSectionTheme(deck, surfaceSection, installedThemes);

  const press = (control: Control) => {
    setPressedId(control.id);
    setNotice(`Preview only: ${control.label} pressed. No desktop action was sent.`);
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current);
    pressTimer.current = window.setTimeout(() => setPressedId(null), 700);
  };

  const changeVolume = (control: Control, value: number) => {
    const next = control.action === "volume" ? clampVolume(value) : value;
    setPreviewVolumes((current) => ({ ...current, [control.id]: next }));
    setNotice(`Preview only: ${control.label} target ${next}. No desktop action was sent.`);
  };

  return (
    <div className={`phone-preview is-${orientation}`}>
      <div className="phone-preview-bar">
        <span className="phone-preview-title">Phone preview</span>
        <div className="segmented" role="group" aria-label="Preview orientation">
          <button type="button" className="button secondary" aria-pressed={orientation === "portrait"} onClick={() => setOrientation("portrait")}>
            Portrait
          </button>
          <button type="button" className="button secondary" aria-pressed={orientation === "landscape"} onClick={() => setOrientation("landscape")}>
            Landscape
          </button>
        </div>
        <a href="#/" className="icon-button preview-close preview-close-desktop" aria-label="Close preview" title="Close preview">
          <X size={18} aria-hidden="true" />
        </a>
      </div>
      <div className="phone-device">
      <div className="phone-shell" data-appearance={surface.appearance}
        data-custom-theme={surface.custom ? "true" : undefined}
        data-custom-motif={surface.motif ?? undefined}
        style={{ ...sectionStyle(surfaceSection), ...surface.style }}>
      <UpdateBanner />
      <header className="phone-header">
        <div className="phone-brand">
          <BrandMark />
        </div>
        <a href="#/" className="icon-button preview-close preview-close-narrow" aria-label="Close preview" title="Close preview">
          <X size={18} aria-hidden="true" />
        </a>
      </header>

      <p className="phone-status">Local preview only. No desktop actions are sent.</p>
      {deck.customTheme && deckTheme.missing ? (
        <p className="phone-storage-note" role="alert">
          This deck uses an installed theme that is not available in this preview. Choose a built-in theme in the desktop editor or import the exact package.
        </p>
      ) : null}

      <main className="phone-main" ref={scrollerRef} {...navigation.pagerProps}>
        <div className="phone-page-heading">
          <h1>{page.name}</h1>
        </div>

        {page.sections.map((section) => {
          const resolved = resolveSectionTheme(deck, section, installedThemes);
          return (
          <section
            key={section.id} className="phone-section" data-phone-section={section.id}
            data-theme={section.theme} data-appearance={resolved.appearance}
            data-custom-theme={resolved.custom ? "true" : undefined}
            data-custom-motif={section.customTheme ? resolved.motif ?? undefined : undefined}
            style={{ ...sectionStyle(section), ...resolved.style }}
            aria-labelledby={`phone-section-${section.id}`}
          >
            <h2 id={`phone-section-${section.id}`} className="section-heading" data-redundant={section.name === page.name || undefined}>{section.name}</h2>
            {resolved.missing ? <p className="theme-recovery" role="alert">Installed theme unavailable; this section uses its built-in base.</p> : null}
            <div className="phone-grid">
              {section.controls.map((control) => (
                <ControlTile
                  key={control.id}
                  control={control}
                  plugins={plugins}
                  variant="phone"
                  appearance={resolved.appearance}
                  volume={previewVolumes[control.id] ?? controlVolume(control)}
                  pressed={pressedId === control.id}
                  onPrimary={() => press(control)}
                  onVolumeChange={(value) => changeVolume(control, value)}
                />
              ))}
            </div>
          </section>
          );
        })}

        {pageControls(page).length === 0 ? (
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
        <PhoneSectionNav
          count={page.sections.length}
          index={navigation.sectionIndex}
          onSelect={navigation.goToSection}
          announcement={navigation.announcement}
        />
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
      </div>
    </div>
  );
}
