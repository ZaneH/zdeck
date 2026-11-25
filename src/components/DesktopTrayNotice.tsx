import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";

/** Native failures remain visible even when a tray gesture happened off-screen. */
export function DesktopTrayNotice() {
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let mounted = true;
    let pending = false;
    const check = async () => {
      if (pending) return;
      pending = true;
      try {
        const message = await invoke<string | null>("desktop_tray_notice");
        if (mounted) setNotice(message);
      } catch {
        if (mounted) setNotice("Could not check desktop tray availability. Keep this window open until you can confirm the tray menu works.");
      } finally {
        pending = false;
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 2000);
    return () => { mounted = false; window.clearInterval(timer); };
  }, []);
  if (!notice) return null;
  return <aside className="settings-card" role="status">
    <p>{notice}</p>
    <a className="button secondary small" href="#/settings/phone">Service settings</a>{" "}
    <button className="button secondary small" onClick={() => {
      void invoke("desktop_quit").catch(() => setNotice("Could not quit zDeck. Use Quit zDeck in the application menu, or your operating system's Quit command."));
    }}>Quit zDeck</button>
  </aside>;
}
