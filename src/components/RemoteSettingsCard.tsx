import { useState } from "react";
import { PairingQrCode } from "./PairingQrCode";
import { useRemoteConsole } from "../lib/useRemoteConsole";

/**
 * Compact phone-connection card. Admin controls only exist in the desktop app.
 * The admin console lives here so leaving Settings unmounts it: polling stops
 * and the transient pairing link is dropped.
 */
export function RemoteSettingsCard() {
  const remote = useRemoteConsole();
  const [origin, setOrigin] = useState("");
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
  const editing = !running && !remote.busy;

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
      <p>
        Connect your phone privately. Keep Tailscale turned on on both devices.
      </p>

      <ol className="remote-steps" role="list">
        <li>Start the desktop service below.</li>
        <li>Publish its address with Tailscale Serve.</li>
        <li>Open that address on your phone, then scan the QR.</li>
        <li>Request access, then approve this phone here.</li>
      </ol>

      <details className="remote-help">
        <summary className="disclosure">Connection help</summary>
        <p>
          This app never configures Tailscale for you. Its local service at
          127.0.0.1:45829 is loopback-only: Wi-Fi alone does not make it reachable
          from your phone.
        </p>
        <p>
          On this desktop, review <code>tailscale serve status</code> before
          changing anything, then point a private HTTPS proxy at the loopback
          service, for example{" "}
          <code>tailscale serve --bg --https=443 http://127.0.0.1:45829</code>.
          Do not enable Funnel, and do not overwrite an existing Serve config
          without reviewing it first.
        </p>
        <p>
          The phone must use the tailnet DNS name (for example{" "}
          <code>computer.tailnet-name.ts.net</code> — an example, not your
          host). This app does not detect whether DNS or Serve is working.
        </p>
        <p>
          On iPhone, open the root address in Safari and install the app first,
          then paste a fresh pairing link inside the installed app. A QR code
          scanned with the camera usually opens the browser, so it does not pair
          an installed app's session. Opening a pairing link never approves a
          phone; approval is always separate.
        </p>
      </details>

      <label className="field">
        <span>This computer’s Tailscale address</span>
        <input
          type="url"
          inputMode="url"
          placeholder="https://computer.tailnet-name.ts.net"
          value={running ? remote.origin ?? origin : origin}
          autoComplete="off"
          spellCheck={false}
          disabled={!editing}
          onChange={(event) => setOrigin(event.target.value)}
        />
      </label>
      <p className="field-note">
        Use https:// followed by this computer’s Tailscale name. No port needed.
      </p>

      <div className="settings-actions">
        {running ? (
          <button
            type="button"
            className="button secondary"
            disabled={remote.busy}
            onClick={() => void remote.stop()}
          >
            Stop local service
          </button>
        ) : (
          <button
            type="button"
            className="button primary"
            disabled={remote.busy || origin.trim().length === 0}
            onClick={() => void remote.start(origin.trim())}
          >
            {remote.busy ? "Working…" : "Start local service"}
          </button>
        )}
      </div>

      <p className="obs-status" role="status" aria-live="polite">
        {remote.status === null
          ? "Checking local service…"
          : running
            ? `Local service running on 127.0.0.1:${remote.port ?? 45829}${remote.origin ? ` · ${remote.origin}` : ""}. Phone access is not checked.`
            : "Local service stopped."}
      </p>

      {remote.error ? (
        <p className="settings-error" role="alert">
          {remote.error}
        </p>
      ) : null}

      {running ? (
        <>
          <p className="muted">
            Stopping the service or restarting zDeck disconnects all phones.
            Pair again next time.
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
