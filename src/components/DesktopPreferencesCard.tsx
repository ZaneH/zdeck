import { useEffect, useState } from "react";
import { Info } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { nativeAvailable } from "../lib/native";

export function DesktopPreferencesCard() {
  const native = nativeAvailable();
  const [enabled, setEnabled] = useState(false);
  const [pending, setPending] = useState(native);
  const [error, setError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  useEffect(() => {
    if (!native) return;
    let mounted = true;
    invoke<boolean>("desktop_close_to_tray").then(value => {
      if (mounted) setEnabled(value);
    }).catch(reason => {
      if (mounted) setError(String(reason));
    }).finally(() => { if (mounted) setPending(false); });
    return () => { mounted = false; };
  }, [native]);
  if (!native) return null;
  async function change(value: boolean) {
    setPending(true);
    setError(null);
    try {
      setEnabled(await invoke<boolean>("desktop_set_close_to_tray", { enabled: value }));
    } catch (reason) {
      setError(`Preference was not saved. ${String(reason)}`);
    } finally {
      setPending(false);
    }
  }
  return <section className="settings-card" aria-labelledby="desktop-preferences-heading">
    <h2 id="desktop-preferences-heading">Closing zDeck</h2>
    <div className="desktop-close-row">
      <label className="desktop-close-choice">
        <input type="checkbox" checked={enabled} disabled={pending}
          aria-describedby="close-to-tray-help" onChange={event => void change(event.target.checked)} />
        <span>Keep running in the tray or menu bar when I close the window</span>
      </label>
      <span className="setting-help" onMouseEnter={() => setHelpOpen(true)} onMouseLeave={() => setHelpOpen(false)}
        onFocus={() => setHelpOpen(true)} onBlur={() => setHelpOpen(false)}
        onKeyDown={event => { if (event.key === "Escape") setHelpOpen(false); }}>
        <button type="button" aria-label="Closing behavior help" aria-describedby="closing-behavior-tooltip"
          onClick={() => setHelpOpen(true)}><Info size={16} aria-hidden="true" /></button>
        <span id="closing-behavior-tooltip" className="setting-tooltip" role="tooltip" aria-hidden={!helpOpen}>
          On: closing hides zDeck and keeps it running. Off: closing quits zDeck.
        </span>
      </span>
    </div>
    <span id="close-to-tray-help" className="sr-only">When off, closing quits zDeck and disconnects phones. When on, zDeck keeps running in the background.</span>
    {error ? <p className="settings-error" role="alert">{error}</p> : null}
  </section>;
}
