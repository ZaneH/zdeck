import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import "./landing.css";

export const SDK_SNIPPET_RAW = `import { serve, type Plugin } from "@zdeck/plugin-sdk";

let count = 0;
const plugin: Plugin = {
  manifest: {
    id: "counter", version: "0.1.0", protocolVersion: 1,
    actions: [{ id: "increment", title: "Increment", config: {} }],
  },
  state: () => ({ count }),
  execute: () => ({ count: ++count }),
};
await serve(plugin);`;

export function SdkSnippet() {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copyCode() {
    try {
      if (!navigator.clipboard) return;
      await navigator.clipboard.writeText(SDK_SNIPPET_RAW);
      setCopied(true);
    } catch {
      // Clipboard may be unavailable in sandboxed iframes.
    }
  }

  return (
    <div className="lp-sdk-wrap">
      <div className="lp-code-card">
        <div className="lp-code-head">
          <span>plugins/counter/main.ts</span>
          <button
            type="button"
            className="button small quiet"
            onClick={copyCode}
            aria-label="Copy plugin SDK snippet"
          >
            {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>

        <pre className="lp-code-pre"><code>{SDK_SNIPPET_RAW}</code></pre>
      </div>

      <div className="lp-deck-readout">
        <span>Manifest + TypeScript entrypoint; ESM package required.</span>
        <span className="lp-readout-meta">Node ≥22.18</span>
      </div>
    </div>
  );
}
