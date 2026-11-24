# Spotify local plugin folder

This MIT-licensed reference plugin controls Spotify desktop on macOS through local Automation. It does not use the Spotify Web API, credentials or OAuth. An installed Node.js **22.18.0 or newer** is required; Node itself is not bundled.

## Develop from this repository

The SDK is not published to npm. From the repository root, install the plugin's **local SDK dependency**:

```sh
npm install --prefix plugins/spotify --ignore-scripts --offline --no-audit --no-fund
printf '{"protocolVersion":1,"id":"dev","type":"describe"}\n' | node plugins/spotify/main.js
```

This uses `file:../../packages/plugin-sdk`, not the npm registry. Keep the repository layout intact. `describe` reads only the manifest; it does not access Spotify or request Automation permission. npm normally creates a symlink for this development dependency. The desktop catalog intentionally rejects symlinked SDK installations: do not copy the source folder or its development `node_modules` into the plugin directory. Use the packaged folder below instead.

## Build the self-contained folder (from the repository)

Run `npm run plugin:package:spotify` from the repository root. This offline command copies the runtime files and the public SDK into `dist/plugins/spotify`. It installs nothing, makes no network request and does not execute the plugin. Build the app before packaging: the normal app build may clear `dist`.

Recipients do **not** run `npm install`. The packager copies real SDK files, not the development symlink, and replaces the source `file:` dependency with the bundled SDK version (`0.1.0`); no repository-relative dependency or development lockfile is distributed.

The generated folder contains `manifest.json`, `main.js`, `spotify.js`, ESM package metadata, this README, the plugin MIT license, and the real SDK under `node_modules/@zdeck/plugin-sdk` with its own MIT license. The `.zdeck-generated` marker identifies packager-owned output. Keep the whole folder together; the source scripts alone are not a self-contained installation.

## Install and enable

1. Review the source, origin and both licenses. A plugin can access your user-level files, network and OS permissions. Stdio is not a sandbox.
2. In desktop Settings, choose **External plugin → Open plugin folder**. The default is `~/.config/zdeck/plugins` (an absolute `XDG_CONFIG_HOME` is honored on Linux).
3. Copy the complete generated `spotify` folder into that directory, so the fixed files are at `plugins/spotify/manifest.json` and `plugins/spotify/main.js`. Do not replace an existing user installation without reviewing/backing it up yourself. The packaging command never installs into your home directory.
4. Choose **Refresh**, select Spotify, acknowledge trust and **Enable plugin**. Node is detected automatically; there are no executable paths to enter. If no supported Node is found, install Node >=22.18 and Refresh.
5. Enabling reads the plugin description only. Read state is a separate intentional operation. Add actions from the editor's Plugins category, configure their integer arguments, and deliberately Run when ready. Preview remains simulated.

Only one plugin is active at a time. Disconnect before switching. Enabling is session-local, with no startup persistence, automatic polling, reconnect or action replay. Folder discovery and Refresh never execute the plugin; runtime discovery only probes Node's version.

## Spotify and macOS permissions

Spotify must be installed at `/Applications/Spotify.app` and already open with a playable context. Play, pause, play-pause, next, previous and Spotify volume (integer 0–100) are supported. Volume is player volume, not system volume.

The first intentional Read state or Run may request Automation permission for the actual launching application to control Spotify. Allow only a launcher/plugin you trust in **System Settings → Privacy & Security → Automation**. An approval for Terminal may not apply to the desktop app. Accessibility and Full Disk Access are not required by this reference.

On timeout, disconnect, crash or an unknown outcome, check Spotify before retrying manually. A command may already have applied. There is no automatic retry. Live Spotify/Automation and real-phone operation require separate device testing.
