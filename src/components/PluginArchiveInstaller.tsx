import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { nativeAvailable } from "../lib/native";
import { archiveCancel, archiveError, archiveInstall, archiveListen, archiveResolve, archiveView, EMPTY_ARCHIVE } from "../lib/nativePluginArchive";
import type { ArchiveView } from "../lib/nativePluginArchive";
import { useDialogBackdrop } from "../lib/useDialogBackdrop";

export function PluginArchiveDialog({ view, onCancel, onInstall, onResolve }: { view: ArchiveView; onCancel: () => void; onInstall: () => void; onResolve?: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancellable = !view.busy || (!!view.registry && !view.review);
  useDialogBackdrop(ref, cancellable, onCancel);
  const open = !!view.review || !!view.error || !!view.registry;
  useEffect(() => { if (open && !ref.current?.open) ref.current?.showModal(); else if (!open) ref.current?.close(); }, [open]);
  const review = view.review;
  const registry = view.registry;
  const release = registry?.release;
  return <dialog ref={ref} className="dialog plugin-dialog archive-dialog" aria-labelledby="archive-heading" aria-busy={view.busy || undefined}
    onCancel={(event) => { event.preventDefault(); if (cancellable) onCancel(); }}>
    <div className="dialog-heading"><h2 id="archive-heading">{registry ? "Review registry plugin" : review ? "Review local plugin" : "Plugin installation unavailable"}</h2>
      <button type="button" className="icon-button" aria-label="Close archive review" disabled={!cancellable} onClick={onCancel}><X size={16} aria-hidden="true" /></button></div>
    {registry ? <>
      {!review ? <dl className="archive-facts"><dt>Plugin ID</dt><dd>{registry.id}</dd><dt>Version</dt><dd>{registry.version}</dd></dl> : null}
      {!release ? <p>This browser link is an untrusted request. Look up this exact release using this build’s configured endpoint and public keys. No archive has been downloaded.</p> : <>
        <p>Release metadata authenticated by registry key <code>{registry.keyId}</code>. This is provenance and integrity, not a safety review or verified publisher identity.</p>
        <dl className="archive-facts"><dt>Source</dt><dd>{release.source.repo}</dd><dt>Commit</dt><dd><code>{release.source.commit}</code></dd><dt>License</dt><dd>{release.source.license}</dd>
          <dt>Compatibility</dt><dd>{release.compatibility.runtime} ≥{release.compatibility.minimum} · {release.compatibility.platforms.join(", ")}</dd>
          <dt>Archive</dt><dd>{release.artifact.url} · {Math.ceil(release.artifact.bytes / 1024)} KiB</dd><dt>SHA-256</dt><dd><code>{release.artifact.sha256}</code></dd></dl>
        {!review ? <p>Download only these signed bytes for local archive validation and a separate install review. Nothing will run or be enabled.</p> : null}
      </>}
    </> : null}
    {review ? <>
      <dl className="archive-facts"><dt>Plugin ID</dt><dd>{review.id}</dd><dt>Version</dt><dd>{review.version}</dd>
        <dt>Protocol</dt><dd>{review.protocolVersion} — supported</dd>
        <dt>Runtime</dt><dd>{review.runtime === "node" ? "Node.js ≥22.18.0" : "Python ≥3.10"}{review.runtimeStatus === "detected" ? ` — detected ${review.runtimeVersion ?? ""}` : " — not ready"}</dd>
        <dt>Source</dt><dd>{release ? "Signed registry archive · unverified publisher" : "Local custom archive · unsigned / unverified publisher"}</dd>
        <dt>Contents</dt><dd>{review.files} files · {Math.ceil(review.bytes / 1024)} KiB unpacked</dd></dl>
      {review.runtimeStatus !== "detected" ? <p>Install is allowed, but enabling requires a supported runtime. Install that runtime, then Refresh in External plugins.</p> : null}
      <p><strong>Not a sandbox.</strong> Once separately trusted and enabled, this package can access your user-level files, network and OS permissions. Its source and publisher have not been verified. Review the code and license before trusting it.</p>
      <p>Install adds this exact reviewed package <strong>disabled and untrusted</strong>. No plugin code or install scripts run. Trust and enable are separate actions in External plugins.</p>
      {review.collision ? <p className="settings-error" role="alert">This plugin ID is already installed. Disable and explicitly uninstall the existing package first, then select this archive again. Nothing will be replaced. Saved controls and credentials are preserved.</p> : null}
      <details className="settings-help"><summary className="disclosure">Local integrity details</summary>
        <p>{release ? "The archive matches the authenticated release digest. The package fingerprint identifies staged files; neither proves safety." : "These hashes identify local bytes; they do not verify a publisher or registry signature."}</p>
        <dl className="archive-facts"><dt>Archive SHA-256</dt><dd><code>{review.archiveSha256}</code></dd><dt>Package fingerprint</dt><dd><code>{review.identity}</code></dd></dl>
      </details>
    </> : !view.error && !registry ? <p>Only local .zdx archives are supported. Installation never trusts or enables a package.</p> : null}
    {view.error ? <p className="settings-error" role="alert">{view.error}</p> : null}
    <div className="settings-actions">
      {registry && !review ? <button type="button" className="button primary" disabled={view.busy || !onResolve} onClick={onResolve}>{release ? "Download for review" : "Look up release"}</button>
        : <button type="button" className="button primary" disabled={view.busy || !review || review.collision} onClick={onInstall}>Install disabled</button>}
      <button type="button" className="button secondary" disabled={!cancellable} onClick={onCancel}>Cancel</button>
    </div>
  </dialog>;
}

/** Mounted once in the desktop shell, not just Settings, so native drops work on the editor too. */
export function PluginArchiveInstaller({ onInstalled }: { onInstalled: () => void }) {
  const [view, setView] = useState(EMPTY_ARCHIVE);
  const installed = useRef<number | null>(null);
  const callback = useRef(onInstalled);
  callback.current = onInstalled;
  useEffect(() => {
    if (!nativeAvailable()) return;
    let active = true;
    let sequence = 0;
    let unlisten: (() => void) | undefined;
    const refresh = async () => {
      const ticket = ++sequence;
      try {
        const next = await archiveView();
        if (!active || ticket !== sequence) return;
        if (installed.current !== null && next.installedEpoch > installed.current) callback.current();
        installed.current = next.installedEpoch;
        setView(next);
      } catch (error) { if (active && ticket === sequence) setView((current) => ({ ...current, busy: false, error: archiveError(error) })); }
    };
    void archiveListen(() => void refresh()).then((stop) => { if (active) { unlisten = stop; void refresh(); } else stop(); })
      .catch(() => { if (active) setView({ ...EMPTY_ARCHIVE, error: "Native archive notifications are unavailable. Reload the desktop app before selecting a package." }); });
    return () => { active = false; sequence++; unlisten?.(); };
  }, []);
  const run = async (operation: () => Promise<void>, installing = false) => {
    setView((current) => ({ ...current, busy: true }));
    try {
      await operation();
      const next = await archiveView();
      if (installed.current !== null && next.installedEpoch > installed.current) callback.current();
      installed.current = next.installedEpoch;
      setView(next);
    }
    catch (error) {
      // Refresh metadata only, never retry an uncertain write or keep a stale authorization token.
      const current = await archiveView().catch(() => EMPTY_ARCHIVE);
      setView({ ...current, error: installing
        ? "The install result could not be confirmed. The package may already be installed. Check External plugins before selecting it again; nothing will be trusted or enabled automatically."
        : archiveError(error) });
      if (installing) callback.current();
    }
  };
  return <PluginArchiveDialog view={view} onCancel={() => void run(() => archiveCancel(view.review?.reviewId ?? view.registry?.reviewId ?? null))}
    onResolve={() => { if (view.registry) void run(() => archiveResolve(view.registry!.reviewId)); }}
    onInstall={() => { if (view.review) void run(() => archiveInstall(view.review!.reviewId), true); }} />;
}
