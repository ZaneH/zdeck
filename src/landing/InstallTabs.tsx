import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { INSTALL_OPTIONS, type OsId } from "./data";
import "./landing.css";

interface InstallTabsProps {
  defaultOs?: OsId;
}

export function InstallTabs({ defaultOs = "macos" }: InstallTabsProps) {
  const [os, setOs] = useState<OsId>(defaultOs);
  const [copied, setCopied] = useState(false);

  const active = INSTALL_OPTIONS.find((item) => item.id === os) ?? INSTALL_OPTIONS[0];

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copyCommand() {
    try {
      await navigator.clipboard?.writeText(active.command);
    } catch {
      // Clipboard may be unavailable in sandboxed iframes; still confirm selection.
    }
    setCopied(true);
  }

  return (
    <div className="lp-install">
      <div className="lp-os-tabs" role="tablist" aria-label="Operating system">
        {INSTALL_OPTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={item.id === active.id}
            className={`lp-os-tab${item.id === active.id ? " is-active" : ""}`}
            onClick={() => {
              setOs(item.id);
              setCopied(false);
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="lp-cmd-box">
        <code className="lp-cmd-text">
          <span className="lp-cmd-prompt" aria-hidden="true">
            $
          </span>
          {active.command}
        </code>
        <button
          type="button"
          className="button small secondary"
          onClick={copyCommand}
          aria-label={`Copy ${active.label} install command`}
        >
          {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <span className="lp-cmd-note">{active.note}</span>
    </div>
  );
}
