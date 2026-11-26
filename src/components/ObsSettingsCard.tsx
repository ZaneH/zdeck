import { useEffect, useState } from "react";
import { obsLoadPreferences, obsSavePreferences, obsForgetPreferences } from "../lib/native";
import type { ObsConsole } from "../lib/useObsConsole";

interface ObsSettingsCardProps {
  obs: ObsConsole;
}

function statusLine(obs: ObsConsole): string {
  if (obs.status === "connecting") return "Connecting to OBS…";
  if (obs.status === "connected") {
    const scene = obs.currentScene ?? "unknown";
    const checked = new Date(obs.snapshot?.observedAtMs ?? Date.now()).toLocaleTimeString();
    return `Connected · program scene: ${scene} · last checked ${checked}`;
  }
  return "Not connected.";
}

/** Compact OBS connection card. Only rendered with native controls in the desktop app. */
export function ObsSettingsCard({ obs }: ObsSettingsCardProps) {
  const [port, setPort] = useState(4455);
  const [password, setPassword] = useState("");
  const [preferencesBusy, setPreferencesBusy] = useState(obs.native);
  const [preferencesError, setPreferencesError] = useState<string | null>(null);

  useEffect(() => {
    if (!obs.native) return;
    let active = true;
    void obsLoadPreferences().then((saved) => {
      if (active && saved) {
        setPort(saved.port);
        setPassword(saved.password);
      }
    }).catch(() => {
      if (active) setPreferencesError("Could not load the saved OBS connection. You can still connect manually.");
    }).finally(() => {
      if (active) setPreferencesBusy(false);
    });
    return () => { active = false; };
  }, [obs.native]);

  if (!obs.native) {
    return (
      <section className="settings-card" aria-labelledby="obs-heading">
        <h2 id="obs-heading">OBS Studio</h2>
        <p>
          OBS scene switching runs natively in the desktop app. This browser build
          stays local preview only and never contacts OBS.
        </p>
      </section>
    );
  }

  const handleConnect = async () => {
    if (!Number.isInteger(port) || port < 1 || port > 65535 || new TextEncoder().encode(password).length > 4096) {
      setPreferencesError("Use a port from 1 to 65535 and a password of at most 4096 bytes.");
      return;
    }
    setPreferencesBusy(true);
    setPreferencesError(null);
    try {
      const connected = await obs.connect(port, password);
      if (connected) {
        try {
          await obsSavePreferences(port, password);
        } catch {
          setPreferencesError("Connected, but could not save the OBS connection in secure storage.");
        }
      }
    } finally {
      setPreferencesBusy(false);
    }
  };

  const handleForget = async () => {
    setPreferencesBusy(true);
    setPreferencesError(null);
    try {
      await obsForgetPreferences();
      setPassword("");
      setPort(4455);
    } catch {
      setPreferencesError("Could not forget the saved OBS connection. It may still be in secure storage.");
    } finally {
      setPreferencesBusy(false);
    }
  };

  const editing = obs.status === "disconnected" && !preferencesBusy;

  return (
    <section className="settings-card" aria-labelledby="obs-heading">
      <h2 id="obs-heading">OBS Studio</h2>
      <p>In OBS: Tools → WebSocket Server Settings, enable the server, and copy the
        password if authentication is on.</p>
      <details className="settings-help">
        <summary className="disclosure">Connection and privacy details</summary>
        <p>Connects to OBS Studio&apos;s WebSocket server on this machine only
          (127.0.0.1 or ::1). After a successful connection, the port and password
          are saved in your operating system&apos;s secure credential store. They are
          never included in decks, logs, or the phone preview. Saved details fill
          these inputs only; they never connect automatically.</p>
        <p>Scene state is read on demand from OBS, not pushed live.</p>
      </details>

      <label className="field">
        <span>WebSocket port</span>
        <input
          type="number"
          min={1}
          max={65535}
          step={1}
          value={port}
          disabled={!editing}
          onChange={(event) => setPort(Number(event.target.value))}
        />
      </label>

      <label className="field">
        <span>Password (optional)</span>
        <input
          type="password"
          value={password}
          autoComplete="off"
          disabled={!editing}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>

      <div className="settings-actions">
        {obs.status === "connected" ? (
          <button
            type="button"
            className="button secondary"
            onClick={() => void obs.disconnect()}
          >
            Disconnect
          </button>
        ) : (
          <button
            type="button"
            className="button primary"
            onClick={() => void handleConnect()}
            disabled={obs.status === "connecting" || preferencesBusy}
          >
            {obs.status === "connecting" ? "Connecting…" : "Connect"}
          </button>
        )}
        <button
          type="button"
          className="button secondary"
          onClick={() => void obs.refresh()}
          disabled={obs.status !== "connected"}
        >
          Refresh scenes
        </button>
        <button
          type="button"
          className="button secondary"
          onClick={() => void handleForget()}
          disabled={preferencesBusy || obs.status === "connecting"}
        >
          Forget saved connection
        </button>
      </div>

      {preferencesError ? <p className="settings-error" role="alert">{preferencesError}</p> : null}

      <p className="obs-status" role="status" aria-live="polite">
        {statusLine(obs)}
      </p>

      {obs.error ? (
        <p className="settings-error" role="alert">
          {obs.error}
        </p>
      ) : null}
    </section>
  );
}
