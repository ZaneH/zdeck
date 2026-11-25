import { useState } from "react";
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
    const connected = await obs.connect(port, password);
    if (connected) setPassword("");
  };

  const editing = obs.status === "disconnected";

  return (
    <section className="settings-card" aria-labelledby="obs-heading">
      <h2 id="obs-heading">OBS Studio</h2>
      <p>In OBS: Tools → WebSocket Server Settings, enable the server, and copy the
        password if authentication is on.</p>
      <details className="settings-help">
        <summary className="disclosure">Connection and privacy details</summary>
        <p>Connects to OBS Studio&apos;s WebSocket server on this machine only
          (127.0.0.1 or ::1). The password stays in memory for this session — it is
          never saved, logged, exported, or shared with the phone preview.</p>
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
            disabled={obs.status === "connecting"}
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
      </div>

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
