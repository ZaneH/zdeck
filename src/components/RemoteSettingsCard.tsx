import { useEffect, useState } from "react";
import { PairingQrCode } from "./PairingQrCode";
import { useRemoteConsole } from "../lib/useRemoteConsole";
import { getStorage } from "../lib/persistence";
import { loadRemoteMode, loadRemoteOrigin, normalizeRemoteOrigin, rememberRemoteMode, rememberRemoteOrigin } from "../lib/remotePreferences";
import type { RemoteMode } from "../lib/remotePreferences";
const MODES = ["tailscale", "local_https"] as const;

const SERVE_COMMAND = "tailscale serve --bg --https=443 http://127.0.0.1:45829";

/**
 * Compact phone-connection card. Admin controls only exist in the desktop app.
 * The admin console lives here so leaving Settings unmounts it: polling stops
 * and the transient pairing link is dropped.
 */
export function RemoteSettingsCard() {
  const remote = useRemoteConsole();
  const [chosenMode, setChosenMode] = useState<RemoteMode>(() => remote.native ? loadRemoteMode(getStorage()) : "tailscale");
  const [remembered, setRemembered] = useState(() => ({
    tailscale: remote.native ? loadRemoteOrigin(getStorage(), "tailscale") : "",
    local_https: remote.native ? loadRemoteOrigin(getStorage(), "local_https") : "",
  }));
  const [drafts, setDrafts] = useState<Record<RemoteMode, string | null>>({ tailscale: null, local_https: null });
  const [commandCopyMessage, setCommandCopyMessage] = useState<string | null>(null);
  const mode = remote.running && remote.mode ? remote.mode : chosenMode;
  const observedOrigin = remote.running ? normalizeRemoteOrigin(remote.origin, mode) : null;
  const origin = drafts[mode] ?? observedOrigin ?? remembered[mode];
  const normalizedOrigin = normalizeRemoteOrigin(origin, mode);

  useEffect(() => {
    // Running status hydrates the tab/address in memory only, without overwriting drafts or preferences.
    const observedMode = remote.mode;
    if (observedOrigin && observedMode) {
      setChosenMode(observedMode);
      setRemembered((current) => current[observedMode] === observedOrigin ? current : { ...current, [observedMode]: observedOrigin });
    }
  }, [observedOrigin, remote.mode]);
  const [copyMessage, setCopyMessage] = useState<
    { expiresAtMs: number; text: string } | null
  >(null);

  if (!remote.native) {
    return (
      <section className="settings-card" aria-labelledby="remote-heading">
        <h2 id="remote-heading">Phone connection</h2>
        <p>
          Phone connection management is available in the desktop app. This
          browser build stays local preview only and never starts the private
          service.
        </p>
      </section>
    );
  }

  const running = remote.running;
  const editing = remote.status !== null && !running && !remote.busy;
  const chooseMode = (next: RemoteMode) => {
    if (!editing) return;
    setChosenMode(next);
    rememberRemoteMode(getStorage(), next);
  };
  const handleStart = async () => {
    if (!editing || !normalizedOrigin) return;
    if (await remote.start(normalizedOrigin, mode)) {
      rememberRemoteOrigin(getStorage(), normalizedOrigin, true, mode);
      rememberRemoteMode(getStorage(), mode);
      setRemembered((current) => ({ ...current, [mode]: normalizedOrigin }));
      setDrafts((current) => ({ ...current, [mode]: null }));
    }
  };

  const handleCommandCopy = async () => {
    try {
      await navigator.clipboard.writeText(SERVE_COMMAND);
      setCommandCopyMessage("Command copied.");
    } catch {
      setCommandCopyMessage("Could not copy automatically. Select the command above and copy it manually.");
    }
  };

  const handleCopy = async () => {
    if (!remote.invitation) return;
    const { url, expiresAtMs } = remote.invitation;
    try {
      await navigator.clipboard.writeText(url);
      setCopyMessage({ expiresAtMs, text: "Link copied." });
    } catch {
      setCopyMessage({
        expiresAtMs,
        text: "Could not copy automatically. Select the link above and copy it manually.",
      });
    }
  };

  return (
    <section className="settings-card" aria-labelledby="remote-heading">
      <h2 id="remote-heading">Phone connection</h2>
      <div className="segmented remote-tabs" role="tablist" aria-label="Phone connection method" aria-describedby="remote-mode-note">
        {MODES.map((item, index) => <button key={item} id={`remote-tab-${item}`} type="button" role="tab"
          className="button secondary" aria-selected={mode === item} aria-controls={`remote-panel-${item}`}
          tabIndex={mode === item ? 0 : -1} disabled={!editing} onClick={() => chooseMode(item)}
          onKeyDown={(event) => {
            if (!editing || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = MODES[event.key === "Home" ? 0 : event.key === "End" ? 1 : (index + 1) % MODES.length];
            chooseMode(next);
            document.getElementById(`remote-tab-${next}`)?.focus();
          }}>{item === "tailscale" ? "Tailscale" : "Local HTTPS"}</button>)}
      </div>
      <p id="remote-mode-note" className="field-note">
        {running ? "Stop the local service before switching connection methods." : remote.busy ? "Wait for this operation to finish before switching methods." : "Choose how your phone reaches this computer. Neither mode configures your network for you."}
      </p>
      {MODES.map((panel) => <div key={panel} className="remote-panel" role="tabpanel" id={`remote-panel-${panel}`}
        aria-labelledby={`remote-tab-${panel}`} hidden={mode !== panel} tabIndex={0}>
        {mode === panel ? <>
          <p>{mode === "tailscale" ? "Connect your phone privately. Keep Tailscale turned on on both devices."
            : "No Tailscale needed. Use a reachable local network and a separately configured HTTPS reverse proxy with a certificate your phone trusts."}</p>
          <ol className="remote-steps" role="list">
            {mode === "tailscale" ? <>
              <li>Start the desktop service below.</li><li>Publish its address with Tailscale Serve.</li>
              <li>Open that address on your phone, then scan the QR.</li><li>Request access, then approve this phone here.</li>
            </> : <>
              <li>Prepare a trusted-certificate HTTPS reverse proxy on this computer.</li>
              <li>Enter its local HTTPS address below and start the desktop service.</li>
              <li>Open that address on your phone, pair, then approve the request here.</li>
            </>}
          </ol>
          <details className="remote-help">
            <summary className="disclosure">Connection help</summary>
            <p>The service is always plain HTTP on loopback-only <code>127.0.0.1:45829</code> behind your external HTTPS proxy.
              The app does not configure networks, certificates, firewalls or proxies, or check live phone connectivity.</p>
            {mode === "tailscale" ? <p>
              This app never configures Tailscale. Use this computer’s actual tailnet DNS name (for example{" "}
              <code>computer.tailnet-name.ts.net</code> — replace this example). Wi-Fi alone does not expose the loopback service.
              The app does not detect whether DNS or Serve is working.
            </p> : <>
              <p>Both devices must be on a network that permits them to reach each other. Wi-Fi client isolation can block access.
                Use a permitted home network or hotspot if necessary; do not bypass an administrator’s policy. A <code>.local</code> name is not guaranteed to resolve.</p>
              <ol>
                <li>Choose this computer’s stable private IP or resolvable local name. Install <code>mkcert</code> and <code>Caddy</code> yourself if using this example; the app never installs or runs them.</li>
                <li>Create your own CA with <code>mkcert -install</code> and a certificate for the exact address below. Transfer only the CA certificate <code>rootCA.pem</code> (located with <code>mkcert -CAROOT</code>) to your own phone, never <code>rootCA-key.pem</code> or any server private key.
                  On iOS, explicitly install the certificate profile and then enable full trust in Certificate Trust Settings. Trusting a CA allows it to authenticate arbitrary HTTPS sites: only trust a CA you personally control.</li>
                <li>Configure Caddy to listen on that private address and proxy to <code>127.0.0.1:45829</code>. Preserve the original Host and Origin; forwarded headers are not trusted. Open the HTTPS root on your phone without a certificate warning before pairing.</li>
              </ol>
              <p>Example only: replace <code>192.168.1.20</code> with this computer’s actual private IP and supply your own absolute certificate/key paths.</p>
              <pre tabIndex={0} aria-label="Example local certificate command"><code>mkcert -cert-file zdeck-cert.pem -key-file zdeck-key.pem 192.168.1.20</code></pre>
              <pre tabIndex={0} aria-label="Example local Caddyfile"><code>{`{
  auto_https disable_redirects
}
https://192.168.1.20:8443 {
  bind 192.168.1.20
  tls /absolute/path/zdeck-cert.pem /absolute/path/zdeck-key.pem
  reverse_proxy 127.0.0.1:45829
}`}</code></pre>
              <p>Save as <code>Caddyfile</code>, then run <code>caddy run --config ./Caddyfile</code> yourself. The private port must be reachable under your network/firewall policy. No HTTP fallback or public tunnel is needed.</p>
            </>}
            <p>On iPhone, open the root address in Safari and install the app first, then paste a fresh pairing link inside the installed app.
              A camera QR usually opens the browser, not the installed app’s session. Opening a link never approves a phone; approve it separately here.</p>
            <p>Start remembers this service for the next zDeck launch. Stop pauses access and disables auto-start, but keeps approved phones. Revoke forgets a phone. Pairing links are never saved.</p>
          </details>
          {mode === "tailscale" ? <div className="remote-command">
            <p>On this desktop, review <code>tailscale serve status</code> first. Do not enable Funnel or overwrite an existing Serve configuration without reviewing it.</p>
            <div className="remote-command-row">
              <pre tabIndex={0} aria-label="Tailscale background HTTPS command"><code>{SERVE_COMMAND}</code></pre>
              <button type="button" className="button secondary" onClick={() => void handleCommandCopy()}>Copy command</button>
            </div>
            {commandCopyMessage ? <span className="muted" role="status" aria-live="polite">{commandCopyMessage}</span> : null}
          </div> : null}
          <label className="field">
            <span>{mode === "tailscale" ? "This computer’s Tailscale address" : "This computer’s local HTTPS address"}</span>
            <input type="url" inputMode="url" placeholder={mode === "tailscale" ? "https://computer.tailnet-name.ts.net" : "https://192.168.1.20:8443"}
              value={observedOrigin ?? origin} autoComplete="off" spellCheck={false} disabled={!editing}
              onChange={(event) => { const value = event.currentTarget.value; setDrafts((current) => ({ ...current, [mode]: value })); }} />
          </label>
          <p className="field-note">
            {mode === "tailscale" ? "Use https:// followed by this computer’s Tailscale name. No port needed. "
              : "Use HTTPS with a private IPv4, local IPv6, or .local/.lan/.home.arpa name; include your proxy’s port if not 443. "}
            Use only the root address, without credentials, path, query or fragment.
          </p>
          <p className="field-note">Changing the address or connection method forgets approved phones and requires re-pairing; a new address may require reinstalling the phone app. Keep the address{mode === "local_https" ? " and trusted certificate" : ""} stable.</p>
        </> : null}
      </div>)}
      <div className="settings-actions">
        {running ? <button type="button" className="button secondary" disabled={remote.busy} onClick={() => void remote.stop()}>Stop local service</button>
          : <button type="button" className="button primary" disabled={!editing || !normalizedOrigin} onClick={() => void handleStart()}>
            {remote.busy ? "Working…" : "Start local service"}
          </button>}
      </div>

      <p className="obs-status" role="status" aria-live="polite">
        {remote.status === null
          ? "Checking local service…"
          : running
            ? `Local service running on 127.0.0.1:${remote.port ?? 45829}${remote.origin ? ` · ${remote.origin}` : ""}. Phone access is not checked.`
            : "Local service stopped."}
      </p>

      {remote.status?.error || remote.error ? (
        <p className="settings-error" role="alert">
          {remote.status?.error || remote.error}
        </p>
      ) : null}

      {running ? (
        <>
          <p className="muted">
            After pairing once, bookmark or revisit the same HTTPS address in the same browser or installed app.
            Approved phones reconnect after Stop/Start or a zDeck restart, for up to 180 days from pairing.
            Start enables auto-start; Stop pauses access without forgetting phones. Revoke forgets a phone.
          </p>

          <div className="settings-actions">
            <button
              type="button"
              className="button secondary"
              disabled={remote.busy}
              onClick={() => void remote.createInvitation()}
            >
              {remote.invitation ? "Replace pairing link" : "Create pairing link"}
            </button>
          </div>

          {remote.invitation ? (
            <div className="remote-invite">
              <label className="field">
                <span>Pairing link (expires in 2 minutes)</span>
                <input
                  type="text"
                  readOnly
                  value={remote.invitation.url}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </label>
              <p className="muted remote-invite-expiry">
                Expires at{" "}
                {new Date(remote.invitation.expiresAtMs).toLocaleTimeString()}.
              </p>
              <div className="settings-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void handleCopy()}
                >
                  Copy link
                </button>
                {copyMessage?.expiresAtMs === remote.invitation.expiresAtMs ? (
                  <span className="muted" role="status" aria-live="polite">
                    {copyMessage.text}
                  </span>
                ) : null}
              </div>
              <PairingQrCode
                value={remote.invitation.url}
                label="Pairing QR code. Scan with your phone camera to open the pairing link."
              />
              <p className="muted remote-qr-caption">
                Scan with your phone, then approve its request below.
              </p>
            </div>
          ) : null}

          <div className="remote-devices">
            <h3>Pending requests</h3>
            {remote.pending.length === 0 ? (
              <p className="muted">No phones are waiting for approval.</p>
            ) : (
              <ul className="remote-device-list">
                {remote.pending.map((device) => (
                  <li key={device.requestId}>
                    <span>{device.name}</span>
                    <div className="settings-actions">
                      <button
                        type="button"
                        className="button small primary"
                        disabled={remote.busy}
                        onClick={() => void remote.approve(device.requestId)}
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        className="button small secondary"
                        disabled={remote.busy}
                        onClick={() => void remote.deny(device.requestId)}
                      >
                        Deny
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="remote-devices">
            <h3>Approved phones</h3>
            {remote.approved.length === 0 ? (
              <p className="muted">No phones are approved.</p>
            ) : (
              <ul className="remote-device-list">
                {remote.approved.map((device) => (
                  <li key={device.requestId}>
                    <span>{device.name}</span>
                    <button
                      type="button"
                      className="button small danger"
                      disabled={remote.busy}
                      onClick={() => void remote.revoke(device.requestId)}
                    >
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}
