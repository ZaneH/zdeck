import { useState } from "react";
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
        Starts a private service on this computer that listens only on
        127.0.0.1:45829. It is not reachable from your phone until you separately
        configure Tailscale Serve to proxy an HTTPS tailnet address to that
        loopback port. This app never configures Tailscale for you.
      </p>

      <label className="field">
        <span>HTTPS tailnet origin</span>
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
        Example: https://computer.tailnet-name.ts.net — HTTPS with no path,
        query, credentials, or non-default port. The desktop app validates the
        origin before starting.
      </p>

      <div className="settings-actions">
        {running ? (
          <button
            type="button"
            className="button secondary"
            disabled={remote.busy}
            onClick={() => void remote.stop()}
          >
            Stop connection
          </button>
        ) : (
          <button
            type="button"
            className="button primary"
            disabled={remote.busy || origin.trim().length === 0}
            onClick={() => void remote.start(origin.trim())}
          >
            {remote.busy ? "Working…" : "Start connection"}
          </button>
        )}
      </div>

      <p className="obs-status" role="status" aria-live="polite">
        {remote.status === null
          ? "Checking connection…"
          : running
            ? `Running on 127.0.0.1:${remote.port ?? 45829}${remote.origin ? ` · ${remote.origin}` : ""}.`
            : "Stopped."}
      </p>

      {remote.error ? (
        <p className="settings-error" role="alert">
          {remote.error}
        </p>
      ) : null}

      {running ? (
        <>
          <p className="muted">
            Session-only: stopping the service or restarting the app clears every
            device, so each phone must pair again. The origin is kept for this
            session only and is disabled while the service runs.
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
              <div className="settings-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void handleCopy()}
                >
                  Copy link
                </button>
                <span className="muted" role="status" aria-live="polite">
                  {copyMessage?.expiresAtMs === remote.invitation.expiresAtMs
                    ? copyMessage.text
                    : `Expires at ${new Date(remote.invitation.expiresAtMs).toLocaleTimeString()}.`}
                </span>
              </div>
              <p className="muted">
                Sharing this link does not approve a phone. Approve the request
                below after the phone opens it.
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
