import { useEffect, useState } from "react";
import { BrandMark } from "../components/BrandMark";
import { ACCENTS, type Accent } from "../lib/types";
import { LINKS } from "./data";
import { InstallTabs } from "./InstallTabs";
import { MiniDeck } from "./MiniDeck";
import { SdkSnippet } from "./SdkSnippet";
import "./landing.css";

type PanelTab = "deck" | "sdk";

interface LandingPageProps {
  initialAccent?: Accent;
  initialTab?: PanelTab;
}

export function LandingPage({
  initialAccent = ACCENTS[0].value,
  initialTab = "deck",
}: LandingPageProps) {
  const [accent, setAccent] = useState<Accent>(initialAccent);
  const [tab, setTab] = useState<PanelTab>(initialTab);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const [pulse, setPulse] = useState(false);

  // Subtle cursor-following tilt on the key-shaped z mark.
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    function onMove(event: MouseEvent) {
      const nx = (event.clientX / window.innerWidth - 0.5) * 14;
      const ny = (event.clientY / window.innerHeight - 0.5) * -14;
      setTilt({ x: nx, y: ny });
    }
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  useEffect(() => {
    if (!pulse) return;
    const timer = window.setTimeout(() => setPulse(false), 160);
    return () => window.clearTimeout(timer);
  }, [pulse]);

  return (
    <div className="lp-page" style={{ ["--accent" as string]: accent }}>
      <div className="lp-shell">
        <header className="lp-header">
          <a href="#top" className="lp-brand">
            <span
              className="lp-brand-tilt"
              style={{
                transform: `perspective(240px) rotateX(${tilt.y}deg) rotateY(${tilt.x}deg) scale(${pulse ? 0.92 : 1})`,
              }}
            >
              <BrandMark />
            </span>
            <span>zDeck</span>
          </a>

          <nav className="lp-header-links" aria-label="Links">
            <a href={LINKS.github} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a href={LINKS.docs}>Docs</a>
            <a href={LINKS.discord}>Discord</a>
          </nav>
        </header>

        <main id="top" className="lp-main">
          <div className="lp-pitch">
            <h1 className="lp-title">A tactile macro deck on your phone.</h1>
            <p className="lp-copy">
              Control OBS scenes, system audio, Spotify, and your own plugins from any browser.
              Free, open source, and local-first — with unlimited pages, plugins, and themes.
            </p>

            <InstallTabs />

            <div className="lp-facts">
              <span>MIT open source</span>
              <span>No account or cloud</span>
              <span>Pairs over local QR</span>
            </div>
          </div>

          <section className="lp-panel" aria-label="Interactive preview and plugin SDK">
            <div className="lp-panel-bar">
              <div className="lp-panel-tabs" role="tablist" aria-label="Preview mode">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "deck"}
                  className={`lp-panel-tab${tab === "deck" ? " is-active" : ""}`}
                  onClick={() => setTab("deck")}
                >
                  Deck
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "sdk"}
                  className={`lp-panel-tab${tab === "sdk" ? " is-active" : ""}`}
                  onClick={() => setTab("sdk")}
                >
                  Plugin SDK
                </button>
              </div>

              <div className="lp-swatches" role="group" aria-label="Accent color">
                {ACCENTS.map((swatch) => (
                  <button
                    key={swatch.value}
                    type="button"
                    className={`lp-swatch${accent === swatch.value ? " is-active" : ""}`}
                    style={{ ["--swatch" as string]: swatch.value }}
                    aria-label={`${swatch.name} accent`}
                    aria-pressed={accent === swatch.value}
                    onClick={() => setAccent(swatch.value)}
                  />
                ))}
              </div>
            </div>

            {tab === "deck" ? (
              <MiniDeck onInteract={() => setPulse(true)} />
            ) : (
              <SdkSnippet />
            )}
          </section>
        </main>

        <footer className="lp-footer">
          <span>zDeck, MIT licensed</span>
          <div className="lp-footer-links">
            <a href={LINKS.github} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a href={LINKS.download}>Download (soon)</a>
            <a href={LINKS.docs}>Docs (soon)</a>
            <a href={LINKS.discord}>Discord (soon)</a>
          </div>
        </footer>
      </div>
    </div>
  );
}
