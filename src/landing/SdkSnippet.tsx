import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { SDK_SNIPPET_RAW } from "./data";
import "./landing.css";

export function SdkSnippet() {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copyCode() {
    try {
      await navigator.clipboard?.writeText(SDK_SNIPPET_RAW);
    } catch {
      // Clipboard may be unavailable in sandboxed iframes.
    }
    setCopied(true);
  }

  return (
    <div className="lp-sdk-wrap">
      <div className="lp-code-card">
        <div className="lp-code-head">
          <span>plugins/lights/main.js</span>
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

        <pre className="lp-code-pre">
          <code>
            <span className="tok-kw">import</span> <span className="tok-p">{"{ "}</span>
            <span className="tok-fn">definePlugin</span>
            <span className="tok-p">{" } "}</span>
            <span className="tok-kw">from</span>{" "}
            <span className="tok-str">&quot;@zdeck/plugin-sdk&quot;</span>
            <span className="tok-p">;</span>
            {"\n\n"}
            <span className="tok-kw">export default</span>{" "}
            <span className="tok-fn">definePlugin</span>
            <span className="tok-p">({"{"}</span>
            {"\n  "}
            <span className="tok-prop">id</span>
            <span className="tok-p">: </span>
            <span className="tok-str">&quot;lights&quot;</span>
            <span className="tok-p">,</span>
            {"\n  "}
            <span className="tok-prop">name</span>
            <span className="tok-p">: </span>
            <span className="tok-str">&quot;Desk Lights&quot;</span>
            <span className="tok-p">,</span>
            {"\n  "}
            <span className="tok-prop">actions</span>
            <span className="tok-p">: {"{"}</span>
            {"\n    "}
            <span className="tok-fn">toggle</span>
            <span className="tok-p">: </span>
            <span className="tok-kw">async</span> <span className="tok-p">() =&gt; {"{"}</span>
            {"\n      "}
            <span className="tok-kw">await</span> <span className="tok-fn">fetch</span>
            <span className="tok-p">(</span>
            <span className="tok-str">&quot;http://127.0.0.1:8123/toggle&quot;</span>
            <span className="tok-p">, {"{ "}</span>
            <span className="tok-prop">method</span>
            <span className="tok-p">: </span>
            <span className="tok-str">&quot;POST&quot;</span>
            <span className="tok-p">{" }"}</span>
            <span className="tok-p">);</span>
            {"\n      "}
            <span className="tok-kw">return</span> <span className="tok-p">{"{ "}</span>
            <span className="tok-prop">ok</span>
            <span className="tok-p">: </span>
            <span className="tok-bool">true</span>
            <span className="tok-p">{" }"}</span>
            <span className="tok-p">;</span>
            {"\n    "}
            <span className="tok-p">{"},"}</span>
            {"\n  "}
            <span className="tok-p">{"},"}</span>
            {"\n"}
            <span className="tok-p">{"});"}</span>
          </code>
        </pre>
      </div>

      <div className="lp-deck-readout">
        <span>Drop a folder with a manifest and JS file.</span>
        <span className="lp-readout-meta">Node 22+</span>
      </div>
    </div>
  );
}
