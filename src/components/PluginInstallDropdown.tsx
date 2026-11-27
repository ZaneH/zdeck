import { useEffect, useState } from "react";
import { Dropdown } from "./Dropdown";
import { archiveError, archivePick } from "../lib/nativePluginArchive";
import { registryOpenWebsite, registryWebsiteStatus, WEBSITE_UNAVAILABLE } from "../lib/nativePluginRegistry";
import type { RegistryWebsiteStatus } from "../lib/nativePluginRegistry";

export function PluginInstallMenu({ website, busy, onSelect }: {
  website: RegistryWebsiteStatus; busy: boolean; onSelect: (source: string) => void;
}) {
  return <Dropdown label="Install from…" value="" actionMenu disabled={busy} onChange={onSelect} options={[
    { value: "local", label: "Local .zdx" },
    { value: "registry", label: "Open plugin registry", disabled: !website.available,
      description: website.explanation ?? "Opens the registry website in your browser." },
  ]} />;
}
export function PluginInstallDropdown() {
  const [website, setWebsite] = useState(WEBSITE_UNAVAILABLE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void registryWebsiteStatus().then((status) => { if (active) setWebsite(status); })
      .catch(() => { if (active) setWebsite({ available: false, explanation: "Registry website availability could not be checked. Reload the desktop app." }); });
    return () => { active = false; };
  }, []);
  return <div className="plugin-install-tools">
    <PluginInstallMenu website={website} busy={busy} onSelect={(source) => {
      if (busy || (source !== "local" && source !== "registry") || (source === "registry" && !website.available)) return;
      setBusy(true); setError(null);
      void (source === "local" ? archivePick() : registryOpenWebsite())
        .catch((cause) => setError(archiveError(cause))).finally(() => setBusy(false));
    }} />
    {error ? <p className="settings-error" role="alert">{error}</p> : null}
  </div>;
}
