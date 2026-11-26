import { useEffect, useRef, useState } from "react";
import { effectivePresentation } from "../lib/presentations";
import { controlVolume } from "../lib/actions";
import { activePage, findPage, pageControls } from "../lib/deck";
import { sectionStyle } from "../lib/sections";
import { applyTheme } from "../lib/theme";
import { useRemotePhone } from "../lib/useRemotePhone";
import type { RemotePhase } from "../lib/remotePhone";
import { BrandMark } from "./BrandMark";
import { ControlTile } from "./ControlTile";
import { PhoneSectionNav, usePhoneNavigation } from "./phoneNavigation";

const DEFAULT_NAME = "My phone";

function terminalMessage(phase: RemotePhase): string | null {
  switch (phase) {
    case "denied":
      return "The desktop denied this phone. Create a fresh pairing link in desktop Settings and try again.";
    case "expired":
      return "This approval expired. Create a fresh pairing link in desktop Settings and try again.";
    case "revoked":
      return "This phone was removed. Create a fresh pairing link in desktop Settings and try again.";
    default:
      return null;
  }
}

function connectionLabel(phase: RemotePhase): string {
  switch (phase) {
    case "active":
      return "Connected";
    case "disconnected":
      return "Disconnected";
    case "connecting":
      return "Connecting…";
    default:
      return "Offline";
  }
}

function stateLabel(state: string): string {
  switch (state) {
    case "pending":
      return "Pending";
    case "confirmed":
      return "Confirmed";
    case "not_applied":
      return "Not applied";
    case "failed":
      return "Failed";
    case "unknown":
      return "Unknown";
    case "info":
      return "Info";
    default:
      return state;
  }
}

function InstallHelp() {
  return (
    <details className="remote-install">
      <summary>Install help</summary>
      <div>
        <p>
          <strong>iPhone:</strong> open the root HTTPS address in Safari, then
          Share → Add to Home Screen. Launch the installed app and paste a fresh
          pairing link there: Safari, Brave, and the installed app can have
          separate pairing sessions. Pair inside the installed app rather than
          relying on the browser session.
        </p>
        <p>
          <strong>Android:</strong> use your browser's install menu to add the app
          to your home screen, then paste a fresh pairing link inside it.
        </p>
        <p>Keep Tailscale connected and the desktop app running.</p>
      </div>
    </details>
  );
}

function PairingScreen({
  phase,
  invite,
  name,
  setName,
  manualLink,
  setManualLink,
  pairingError,
  statusText,
  submit,
}: {
  phase: RemotePhase;
  invite: string | null;
  name: string;
  setName: (value: string) => void;
  manualLink: string;
  setManualLink: (value: string) => void;
  pairingError: string | null;
  statusText: string;
  submit: () => void;
}) {
  const terminal = terminalMessage(phase);
  return (
    <div className="remote-app">
      <header className="phone-header remote-header">
        <div className="phone-brand"><BrandMark /></div>
      </header>
      <main className="remote-pair" id="main">
        <h1>Connect your phone</h1>
        <p className="remote-lead">
          Approve this phone in the desktop app before it can control your saved
          deck. Nothing runs on the desktop until you press a control here.
        </p>
        {terminal ? <p className="remote-error" role="alert">{terminal}</p> : null}

        <label className="field">
          <span>Device name</span>
          <input
            type="text"
            value={name}
            maxLength={128}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        {invite ? (
          <p className="remote-captured">Pairing link captured from this address.</p>
        ) : (
          <label className="field">
            <span>Pairing link</span>
            <input
              type="text"
              value={manualLink}
              autoComplete="off"
              spellCheck={false}
              placeholder="https://…/#/pair?invite=…"
              maxLength={4096}
              onChange={(event) => setManualLink(event.target.value)}
            />
          </label>
        )}

        {pairingError ? <p className="remote-error" role="alert">{pairingError}</p> : null}

        <button
          type="button"
          className="button primary"
          disabled={phase === "requesting"}
          onClick={submit}
        >
          {phase === "requesting" ? "Requesting…" : "Request approval"}
        </button>

        {statusText ? (
          <p className="remote-status" role="status" aria-live="polite">{statusText}</p>
        ) : null}

        <InstallHelp />
      </main>
    </div>
  );
}

export function RemotePhoneApp({ initialInvite }: { initialInvite: string | null }) {
  const remote = useRemotePhone(initialInvite);
  const [name, setName] = useState(DEFAULT_NAME);
  const [manualLink, setManualLink] = useState("");
  const [targets, setTargets] = useState<Record<string, number>>({});
  const scrollerRef = useRef<HTMLElement>(null);
  const deck = remote.deck;
  const page = deck
    ? (remote.pageId ? findPage(deck, remote.pageId) ?? activePage(deck) : activePage(deck))
    : null;
  const theme = deck?.theme;
  const accent = deck?.accent;
  // Unconditional: this component returns early for pairing, so keep the hook above those paths.
  useEffect(() => {
    if (theme && accent) applyTheme(theme, accent);
  }, [theme, accent]);
  const navigation = usePhoneNavigation({
    pageId: page?.id ?? "",
    pageIds: deck?.pages.map((item) => item.id) ?? [],
    sectionIds: page?.sections.map((section) => section.id) ?? [],
    onPageChange: remote.setPage,
    scrollerRef,
  });

  const secure =
    typeof window !== "undefined" && window.location.protocol === "https:";

  if (!secure) {
    return (
      <div className="remote-app">
        <div className="remote-pair" id="main">
          <BrandMark />
          <h1>HTTPS required</h1>
          <p className="remote-lead">
            Open this phone app through its HTTPS address. Pairing and actions are
            disabled over plain HTTP.
          </p>
        </div>
      </div>
    );
  }

  const pairing =
    remote.phase === "unpaired" ||
    remote.phase === "requesting" ||
    remote.phase === "denied" ||
    remote.phase === "expired" ||
    remote.phase === "revoked";

  if (pairing) {
    return (
      <PairingScreen
        phase={remote.phase}
        invite={remote.invite}
        name={name}
        setName={setName}
        manualLink={manualLink}
        setManualLink={setManualLink}
        pairingError={remote.pairingError}
        statusText={remote.statusText}
        submit={() => {
          remote.submitPairing(remote.invite ?? manualLink, name);
          setManualLink("");
        }}
      />
    );
  }

  if (remote.phase === "pending") {
    return (
      <div className="remote-app">
        <header className="phone-header remote-header">
          <div className="phone-brand"><BrandMark /></div>
        </header>
        <main className="remote-pair" id="main">
          <h1>Approve this phone in desktop Settings</h1>
          <p className="remote-lead">
            This phone is waiting. In the desktop app, open Settings → Phone
            connection and approve “{name.trim() || DEFAULT_NAME}”.
          </p>
          <button type="button" className="button secondary" onClick={() => remote.cancelPairing()}>
            Cancel
          </button>
          <p className="remote-status" role="status" aria-live="polite">{remote.statusText}</p>
        </main>
      </div>
    );
  }

  if (!deck || !page) {
    return (
      <div className="remote-app">
        <header className="phone-header remote-header">
          <div className="phone-brand"><BrandMark /></div>
          <span className="remote-connection" data-state={remote.phase}>
            {connectionLabel(remote.phase)}
          </span>
        </header>
        <main className="remote-pair" id="main">
          <h1>Connecting to the desktop…</h1>
          <p className="remote-status" role="status" aria-live="polite">{remote.statusText}</p>
        </main>
      </div>
    );
  }

  const active = remote.phase === "active";
  const controlsDisabled = !active || remote.busyControlId !== null;
  const hasVolume = pageControls(page).some((control) => control.action === "volume");
  const latestActivity = remote.activity[0];

  return (
    <div className="remote-app" data-state={remote.phase}>
      <header className="phone-header remote-header">
        <div className="phone-brand"><BrandMark /></div>
        {active ? null : (
          <span className="remote-connection" data-state={remote.phase}>
            {connectionLabel(remote.phase)}
          </span>
        )}
      </header>

      <main className="phone-main" id="main" ref={scrollerRef} {...navigation.pagerProps}>
        <div className="phone-page-heading">
          <h1>{page.name}</h1>
        </div>

        {page.sections.map((section) => (
          <section
            key={section.id} className="phone-section" data-phone-section={section.id}
            data-theme={section.theme} style={sectionStyle(section)}
            aria-labelledby={`remote-section-${section.id}`}
          >
            <h2 id={`remote-section-${section.id}`} className="section-heading">{section.name}</h2>
            <div className="phone-grid">
              {section.controls.map((control) => (
                <ControlTile
                  key={control.id}
                  control={control}
                  plugins={remote.plugins}
                  onRefresh={control.presentation === "value" ? () => remote.refreshValue(control.id) : undefined}
                  variant="phone"
                  semantics="remote"
                  disabled={controlsDisabled && !(active && remote.busyControlId === control.id && ["slider", "dial"].includes(effectivePresentation(control, remote.plugins)))}
                  volume={targets[control.id] ?? controlVolume(control)}
                  pressed={false}
                  busy={remote.busyControlId === control.id}
                  onPrimary={() => remote.press(control)}
                  onVolumeChange={(value) =>
                    setTargets((current) => ({ ...current, [control.id]: value }))
                  }
                  onVolumeCommit={(value) => remote.commitVolume(control, value)}
                />
              ))}
            </div>
          </section>
        ))}

        {pageControls(page).length === 0 ? (
          <p className="empty-note">This page has no controls yet.</p>
        ) : null}

        {hasVolume ? (
          <p className="remote-target-note">
            Volume sliders set a target level. They show the value about to be
            sent, not a live device reading.
          </p>
        ) : null}

        {latestActivity && (latestActivity.state === "failed" || latestActivity.state === "not_applied") ? (
          <p className="remote-error" role="status">
            {latestActivity.label}: {stateLabel(latestActivity.state)} — {latestActivity.message}
          </p>
        ) : null}

        {remote.warning ? (
          <p className="remote-warning" data-kind="unknown" role="status" aria-live="polite">
            {remote.warning}
          </p>
        ) : null}

        {remote.phase === "disconnected" ? (
          <p className="remote-warning" data-kind="connection">
            Controls are disabled until the desktop connection returns.
          </p>
        ) : null}

        {remote.activity.length > 0 ? (
          <details className="remote-activity">
            <summary className="disclosure">Activity</summary>
            <ol className="remote-activity-list">
              {remote.activity.map((entry) => (
                <li key={entry.id} data-state={entry.state}>
                  <span className="remote-activity-label">{entry.label}</span>
                  <span className="remote-activity-state">{stateLabel(entry.state)}</span>
                  <span className="remote-activity-message">{entry.message}</span>
                </li>
              ))}
            </ol>
          </details>
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
              onClick={() => remote.setPage(item.id)}
              aria-current={item.id === page.id ? "page" : undefined}
            >
              {item.name}
            </button>
          ))}
        </nav>
      </footer>
    </div>
  );
}
