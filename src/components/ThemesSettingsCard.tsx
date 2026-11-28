import { useState } from "react";
import { Upload } from "lucide-react";
import { parseThemePackageBytes } from "../lib/themePackage";
import type { ThemePackage } from "../lib/themePackage";
import {
  customThemeStyle,
  referenceKey,
  themeErrorMessage,
} from "../lib/customThemes";
import type { InstalledTheme, ThemeAdapter } from "../lib/customThemes";
import { ControlTile } from "./ControlTile";
import type { Control } from "../lib/types";

const PREVIEW_CONTROLS: Control[] = [
  { id: "theme-preview-button", action: "media-play-pause", label: "Play / pause" },
  { id: "theme-preview-volume", action: "volume", label: "Level", volume: 62 },
];

export function ThemesSettingsCard({
  adapter,
  themes,
  loading,
  loadError,
  onRefresh,
  onUseTheme,
  isInUse,
}: {
  adapter: ThemeAdapter;
  themes: InstalledTheme[];
  loading: boolean;
  loadError: string | null;
  onRefresh: () => Promise<void>;
  /** Explicit "Use for deck"; installing never applies by itself. */
  onUseTheme?: (theme: InstalledTheme) => void;
  isInUse?: (theme: InstalledTheme) => boolean;
}) {
  const [preview, setPreview] = useState<{ source: string; package: ThemePackage } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const available = adapter.available();

  const choose = async () => {
    if (busy || !available) return;
    setError(null);
    setBusy("choose");
    try {
      const source = await adapter.pick();
      if (source === null) return;
      const pkg = parseThemePackageBytes(new TextEncoder().encode(source));
      if (!pkg) {
        setPreview(null);
        setError("That file is not a valid theme package.");
        return;
      }
      setPreview({ source, package: pkg });
    } catch (value) {
      setError(themeErrorMessage(value));
    } finally {
      setBusy(null);
    }
  };

  const install = async () => {
    if (!preview || busy) return;
    setError(null);
    setBusy("install");
    try {
      await adapter.install(preview.source);
      setPreview(null);
      await onRefresh();
    } catch (value) {
      setError(themeErrorMessage(value));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (theme: InstalledTheme) => {
    if (busy || (isInUse?.(theme) ?? false)) return;
    setError(null);
    setBusy(`remove:${referenceKey(theme.reference)}`);
    try {
      await adapter.remove(theme.reference);
      await onRefresh();
    } catch (value) {
      setError(themeErrorMessage(value));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="settings-card" aria-labelledby="themes-heading">
      <h2 id="themes-heading">Installed themes</h2>
      <p className="muted">
        Data-only packages follow the built-in base for controls. Importing previews locally; nothing is applied until you choose it.
      </p>
      {error ? <p className="settings-error" role="alert">{error}</p> : null}
      {loadError ? (
        <p className="settings-error" role="alert">
          {loadError}{" "}
          <button type="button" className="button secondary small" disabled={loading} onClick={() => void onRefresh()}>
            Retry
          </button>
        </p>
      ) : null}
      {!available ? (
        <p className="field-note" role="status">Importing themes requires the desktop app.</p>
      ) : null}

      {preview ? (
        <div className="theme-preview" data-theme={preview.package.appearance.base}
          data-appearance={preview.package.appearance.base} data-custom-theme="true"
          data-custom-motif={preview.package.appearance.motif}
          style={customThemeStyle(preview.package) ?? undefined}>
          <div className="theme-preview-heading">
            <div>
              <p className="theme-preview-name">{preview.package.name}</p>
              <p className="field-note">
                {preview.package.id} {preview.package.version} · {preview.package.author} · {preview.package.license}
              </p>
            </div>
          </div>
          <p className="field-note">Preview only. No appearance has been saved.</p>
          <div className="theme-preview-grid">
            {PREVIEW_CONTROLS.map((control) => (
              <ControlTile key={control.id} control={control} variant="editor"
                appearance={preview.package.appearance.base} volume={62} />
            ))}
          </div>
          <div className="theme-preview-actions">
            <button type="button" className="button primary" disabled={!!busy} onClick={() => void install()}>
              Install theme
            </button>
            <button type="button" className="button secondary" disabled={!!busy} onClick={() => setPreview(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <div className="theme-list">
        {themes.length === 0 && !loading ? <p className="muted">No installed themes yet.</p> : null}
        {themes.map((theme) => {
          const inUse = isInUse?.(theme) ?? false;
          const key = referenceKey(theme.reference);
          return (
            <article key={key} className="theme-row" data-theme-id={theme.package.id}>
              <div className="theme-row-copy">
                <p className="theme-row-name">{theme.package.name}</p>
                <p className="theme-row-meta">
                  {theme.package.id} {theme.package.version} · {theme.package.author} · {theme.package.license}
                </p>
                <p className="theme-row-source">{theme.package.source}</p>
                <p className="theme-row-digest">
                  SHA-256 <code>{theme.reference.digest}</code>
                </p>
                {inUse ? <p className="field-note">Used by this deck. Choose a built-in appearance before removing it.</p> : null}
              </div>
              <div className="theme-row-actions">
                {onUseTheme ? (
                  <button type="button" className="button secondary small" onClick={() => onUseTheme(theme)}>
                    Use for deck
                  </button>
                ) : null}
                <button type="button" className="button secondary small" disabled={inUse || !!busy}
                  onClick={() => void remove(theme)}>
                  Remove
                </button>
              </div>
            </article>
          );
        })}
      </div>

      <div className="theme-import">
        <button type="button" className="button secondary" disabled={!available || !!busy} onClick={() => void choose()}>
          <Upload size={15} aria-hidden="true" /> Import theme file…
        </button>
      </div>
    </section>
  );
}
