# zDeck

> Project name: **zDeck**. Internal names `deck-editor` (npm), `deck` (Rust), and `com.deck.local` (Tauri app identifier) are retained so the display rename does not move existing app data. Storage/protocol identifiers are unchanged.

zDeck is a free, MIT-licensed desktop control deck with a Tauri editor and an authenticated phone PWA. The standalone browser build remains a local editor and simulated phone preview. The native desktop app can switch OBS program scenes and, on Linux, mute the default system microphone, set default output volume, and play/pause the default MPRIS player. Approved phones run those saved controls through an explicitly enabled private HTTPS service. Pairing, live edits, actions, revocation, and offline safety are tested against the actual Rust service with fake adapters and isolated Chrome; real Tailscale and physical-phone validation remain open.

## Design checkpoint

The current coordinator-led pass combines Touch Portal’s direct button editing with Hex’s focused onboarding and tactile controls. One compact toolbar, shallow pressable keys, an adjacent Inspector (stacked on narrow screens), and on-demand action/page dialogs keep the editor tight. Full-window setup carries your welcome rehearsal choice into naming and practice, with action changes tucked behind a disclosure. Skip is remembered; Settings → Replay setup never resets existing work. The navbar uses a key-shaped z logo; the action picker has category groups/filters, both dialogs dismiss on backdrop clicks, and the Settings button toggles back to the editor. Nothing runs on your desktop during rehearsal.

This replaces the rejected inline-guide pass and is ready for feedback, not an approved final design. See the [animated walkthrough, desktop, and phone screenshots](docs/design.md). No reference code/assets or new dependencies were added. The self-hosted Geist font is licensed under the [SIL Open Font License](src/assets/Geist-OFL.txt). Existing deck data and native execution guards are unchanged.

## What is in this slice

- Compact dark-first desktop editor with an optional light theme and five accent tokens.
- Page switcher and page manager, editable control canvas, searchable on-demand action picker, and a selected-control inspector beside the deck (beneath it on narrow screens).
- OBS scene, microphone mute, media play/pause, and volume controls. The microphone scope is the **default system input**, explicitly labelled as distinct from an OBS input. The dial is deferred.
- In the native desktop shell, an OBS scene control can switch the real OBS program scene after you connect OBS in Settings. On Linux, the Inspector also runs real microphone mute, output-volume, and media play/pause actions against session services.
- Add, select, edit, reorder, and remove controls; add, switch, rename, reorder, and remove pages.
- Every toolbar tile press is local preview feedback only, except a native **Run scene** while OBS is connected. In the desktop Inspector, the explicit native **Toggle**/**Apply**/**Run** actions on the selected mic, media, or volume control are real. Phone preview stays local. No other connected, pending, confirmed, or success state is simulated.
- Plain preview status text, with no decorative lights: “Local preview only. No desktop actions are sent.” The separate authenticated phone surface shows connection and action outcomes; native Settings manage explicit start/stop, expiring links, approval/denial, and revocation.
- Versioned, validated `localStorage` persistence under `deck.local.v1` in the browser build, and validated atomic file persistence in the native desktop shell. The two are separate stores.
- The local editor's `#/phone` route is simulated, with Landscape/Portrait desktop frames. Every route served by the private phone service instead stays on the authenticated remote surface: no local editor, sample fallback, or desktop IPC.
- PWA manifest, locally generated 192/512 icons, and a production-only service worker generated from the build output with a content-versioned cache and a user-triggered update flow.
- Minimal Tauri 2 Rust shell and configuration that points at the same built frontend. It exposes the four narrow OBS commands, six narrow system commands, two narrow native-deck persistence commands, and eight native-only private-service admin commands described below, plus no plugins.
- Vitest tests cover schema/persistence, editing, native adapters/save queue, invitation parsing, phone lifecycle cancellation, deadlines, and ambiguous outcomes. Rust tests cover fake OBS/system adapters, temporary atomic storage, and real loopback HTTP/WebSocket security. A separate HTTPS/Chrome smoke exercises the phone against that actual service.

## Requirements

- Node.js 22 or newer and npm 10 or newer. This machine currently has Node `v22.23.3` and npm `10.9.9`.
- For the Tauri desktop shell: use the repository-local Nix shell (`flake.nix`), which provides Rust/Cargo, rustfmt, Node, pkg-config, and the WebKitGTK 4.1/GTK3/libsoup3/openssl/XZ native libraries. See [Native development shell](#native-development-shell).
- For the native system actions (Linux only): the `wpctl` tool from WirePlumber and the `playerctl` tool. The Nix shell below already provides both. On a non-Nix system, install `wireplumber` and `playerctl` from your distribution. A session PipeWire/WirePlumber service and an MPRIS-compatible player are required at runtime.

## Web development

```bash
npm install
npm run dev
```

Open <http://localhost:1420>. The phone view is the top-bar **Preview** link or <http://localhost:1420/#/phone>.

### Checks

```bash
npm test
npm run typecheck
npm run build
npm run smoke
npm run smoke:remote  # Linux/Nix, installed google-chrome and openssl; fake actions only
```

`npm run build` also runs the TypeScript check before the production Vite build. The production bundle is written to `dist/`.

`npm run smoke` builds two frontend versions, then drives installed `google-chrome` headless over raw CDP in a throwaway `--user-data-dir` (no personal browser, no browser dependency). Its 202 checks exercise all four onboarding rehearsals, validation, save/skip/replay, full-page limits, keyboard focus and reduced motion, modal focus/search/keyboard behavior, page/control editing and removal confirmation, refresh persistence, same-origin cross-tab sync, phone page switching and slider keyboard/touch input, dark/light, narrow/short/portrait/landscape layouts, the offline shell, and a two-build service-worker update lifecycle. Screenshots and a pass/fail summary are written under `/tmp`. The final `dist/` is left as the unmarked build.

`npm run smoke:remote` builds the frontend and runs the opt-in Rust browser fixture. It starts the actual service with a temporary deck and fake action runner, then uses a disposable certificate, loopback HTTPS proxy, host-resolver mapping, and isolated Chrome profile. Host/Origin/cookies are forwarded unchanged; hostile Host/Origin probes must fail. It covers explicit pairing/approval, fresh-context link paste, authenticated GET/WSS, saved actions and results, deliberate slider commits, live edits, conflict resync, lost-response Unknown/no replay, revocation, and remote-only offline caching. The current run passes **62 checks**, alongside **93 frontend tests**, **202 local UI browser checks**, and **70 default Rust tests**. TypeScript, production build, and Tauri debug no-bundle build also pass. Certificate bypasses exist **only in this disposable test**, never as phone setup guidance. The fixture is ignored by default and has a 120-second deadline; no real system controls or Tailscale settings are touched.

### Production build preview

```bash
npm run preview
```

Open <http://localhost:4173>. This is also the useful way to exercise the service worker locally, because the service worker is registered only in production builds.

## Phone preview and PWA notes

- In the standalone browser build, the phone preview reads the same `localStorage` deck and listens for other tabs' edits. It sends no desktop commands and claims no pairing. The private service's phone client reads only authenticated desktop snapshots; it never uses browser-local/sample data.
- The manifest starts at `/#/phone`, uses locally created 192×192 and 512×512 PNG icons, and has `display: standalone`. The icons are also marked maskable; the artwork keeps its main content within the maskable safe area.
- The service worker is generated at build time (`build/serviceWorkerPlugin.ts`) from the real `dist/` output; there is no hand-written `public/sw.js`. Its cache name embeds a hash of the shell and hashed asset contents, so a new frontend build always produces a new worker and a distinct cache.
- It precaches only an exact allowlist: `index.html`, the manifest, the icons, and the hashed files under `assets/`. It never handles query strings, API-shaped paths, cross-origin requests, or non-GET requests, so server auth/API responses are never cached. The navigation fallback serves the cached `index.html` only for `/` and `/index.html`.
- A waiting worker installs into its own cache and never mutates the live cache or reloads the page. The app shows a **Reload** banner; the user applies the update, the previous cache is deleted, and only then does the page reload. Set `VITE_BUILD_MARKER` at build time to produce a distinguishable build when exercising the update lifecycle.
- Installation requires a browser-accepted secure context. **Physical iPhone/Android installation and real Tailscale Serve are not yet verified.** The phone UI and local HTTPS integration are implemented; LAN-only trusted HTTPS remains a release requirement.

## Tauri desktop shell

Scripts are exposed:

```bash
npm run tauri:dev
npm run tauri:build
```

They run the Tauri CLI against `src-tauri/`. The configuration:

- builds the same frontend from `dist/`;
- uses a restrictive production CSP with a separate development CSP for Vite HMR;
- exposes four narrow OBS commands (`obs_connect`, `obs_disconnect`, `obs_snapshot`, `obs_switch_scene`) that connect only to loopback (`127.0.0.1`, then `::1`) and return sanitized typed errors;
- exposes six narrow system commands (`system_output_snapshot`, `system_output_set_volume`, `system_microphone_snapshot`, `system_microphone_set_muted`, `system_media_snapshot`, `system_media_play_pause`) that run fixed executables with fixed argument arrays (no shell, no user-supplied program or command text) and return sanitized typed errors;
- owns the authoritative native deck through `native_deck_load` and `native_deck_save(expectedRevision, deck)`. The store validates the same schema and limits as the frontend, writes atomically, and returns typed sanitized errors. The frontend never supplies a path;
- adds no plugins, and `src-tauri/capabilities/default.json` keeps an empty permission list;
- allows no remote privileged pages.

### OBS Studio scene switching

The desktop shell can connect to the OBS Studio WebSocket server bundled with
OBS 30.2+ (obs-websocket 5.5+). It uses the maintained `obws` Rust client, so
authentication and socket handling are not reimplemented, and the socket stays
out of the webview.

Setup in OBS:

1. Open **Tools → WebSocket Server Settings**.
2. Check **Enable WebSocket server**.
3. Keep **Server Port** at the default `4455`, or enter the port you set in
   zDeck's **Settings → OBS Studio**.
4. If **Enable Authentication** is on, copy the generated password and paste it
   into zDeck. zDeck only ever connects to `127.0.0.1`/`::1`; it accepts no host,
   URL, or path.

Behavior:

- zDeck reads the scene list and current program scene from OBS on demand. Scene
  state is never shown as live without a successful OBS query.
- **Run scene** in the Inspector switches the program scene, then reads the
  program scene back. A mismatch shows as *Not applied*, a rejected request as
  *failed*, and a timeout or lost connection as *unknown* (the scene may already
  have changed). An uncertain switch is never retried automatically,
  and a failed native switch is never silently downgraded to local preview.
- The password is held in memory for the session only. It is never written to
  `localStorage`, the deck document, logs, errors, exports, or the phone preview,
  and it is dropped on disconnect. OS keychain persistence is deferred.
- The commands are app-local Tauri commands callable only from the bundled
  desktop UI. There is no generic execution command and no remote privileged
  origin.

This is covered by Rust integration tests that run a small fake OBS5 peer on an
owned ephemeral loopback port (`cargo test`). **No real OBS Studio instance or
hardware has been tested yet.**

### System microphone, output volume, and media (Linux only)

The desktop shell can also run three real system actions on Linux. They use
session services, not synthetic key input, so they work on KDE Wayland:

| Control | Read | Apply | Scope |
| --- | --- | --- | --- |
| Microphone mute | `wpctl get-volume @DEFAULT_AUDIO_SOURCE@` | `wpctl set-mute @DEFAULT_AUDIO_SOURCE@ 0\|1` | **Default system input**, not an OBS input |
| Output volume | `wpctl get-volume @DEFAULT_AUDIO_SINK@` | `wpctl set-volume @DEFAULT_AUDIO_SINK@ <0-100>%` | Default system output |
| Media play/pause | `playerctl status` | `playerctl play-pause` | playerctl's default MPRIS player |

Behavior and safety:

- Each action runs a fixed executable with a fixed argument array through Tokio's
  process API. There is no shell, no user-supplied executable, and no arbitrary
  command text. Every command has a bounded timeout and a timed-out child is
  killed and reaped. Raw stderr and process paths are never shown.
- The Inspector shows the **observed** state and when it was last read. A failed
  refresh clears the observed value instead of leaving a stale one advertised as
  live. Each action reads the state back and reports **confirmed**,
  **not applied**, **failed**, or **unknown**; a timeout is never retried blindly.
- Volume is validated to a finite `0-100` before applying, so zDeck never requests
  overdrive. If the OS itself reports a boost above 100%, zDeck displays it
  honestly rather than clamping the number.
- Microphone mute uses an explicit target derived from the observed state, not a
  blind toggle. Media play/pause reads the current status first, so a missing
  player fails without running `play-pause`.
- The three families are independent: a missing media player or missing tool does
  not disable working audio controls.
- **Linux only.** On other platforms the commands compile and return a typed
  `unsupported` error instead of breaking the build. No Windows or macOS
  implementation exists yet.

MPRIS player selection policy: zDeck does not pick or persist a specific player.
It uses playerctl's default selection (no `--player` flag), which chooses among
the available MPRIS players. Selecting a specific player is future work.

This is covered by 20 Rust adapter tests using an owned fake runner, so no real
`wpctl` or `playerctl` process runs and no live machine state is touched. **No
live hardware verification has been performed: the real volume, mute, and
play/pause commands have not been run on a real PipeWire session, and a real
MPRIS player has not been exercised.**

### Private phone service

Desktop Settings and the authenticated phone client implement the backend in
[`docs/protocol.md`](docs/protocol.md). The service is **not** started automatically.
Only the native desktop can administer it, using:

- `remote_start(origin)`, `remote_stop`, `remote_status`
- `remote_create_invitation`, `remote_list_devices`
- `remote_approve_device`, `remote_deny_device`, `remote_revoke_device`

Behavior:

- Binds only `127.0.0.1:45829` by default after an explicit native `remote_start`. The
  configured origin must be an HTTPS URL whose host ends in `.ts.net`, with no
  path, query, credentials, fragment, or non-default port. The service never
  runs Tailscale commands or changes Serve configuration.
- Serves the bundled PWA and `/api/v1/*` from that same origin. There are no
  HTTP admin endpoints. A server-rewritten HTML marker selects the remote client;
  a missing marker fails closed. Bundled lookup rejects missing assets rather
  than using Tauri's editor-index fallback. This marker is routing, not authorization.
  The Tauri asset provider does not depend on a mutable `cwd` or `dist/` in a
  packaged app; actual bundled resolver runtime still needs native validation.
- Pairing is session-only: one active invitation expires after two minutes and
  is consumed once at `POST /api/v1/pair`. The provisional `__Host-deck-device`
  cookie is `Secure; HttpOnly; SameSite=Strict; Path=/`; only its hash is kept
  in memory. An unapproved cookie can read only its own pairing status. Native
  approval upgrades it; deny/revoke invalidates it. Stopping or restarting the
  service clears the registry, so devices must pair again.
- `GET /api/v1/state` and `GET /api/v1/events` read the authoritative native
  deck store. The WebSocket sends an immediate snapshot and a new snapshot after
  each successful native save. A missing or corrupt store closes the socket
  instead of sending a sample deck.
- `POST /api/v1/commands` accepts only `id`, `revision`, `controlId`, and an
  optional finite `value` for volume controls. The server resolves the action
  from the saved deck and calls the same shared `ObsState`, `SystemState`, and
  `DeckStore` instances used by the native commands. Command IDs are reserved
  atomically before execution, results are cached for five minutes with a
  256-entry cap, and identical concurrent requests do not repeat the effect.
  Limits cover request bodies, invitations, pending/approved devices, pairing
  and command rates, in-flight commands, sockets, and socket payloads. The
  registry and command cache are in-memory and session-only; this is not
  exactly-once execution across crashes or restarts, or beyond the five-minute
  result window.
- Errors are sanitized and every API response, including failures, is
  `Cache-Control: no-store`. Static responses use an exact public allowlist and
  a restrictive CSP.

The backend is covered by 25 loopback integration tests that open real TCP and
WebSocket connections to temporary service instances. They use temporary deck
directories, fake assets, an injected fake system runner, and a fake OBS peer.
They verify invitation expiry/reuse, approval and denial, Host/Origin/cookie
rejection, socket closure on deny/revoke, strict command bodies, revision
conflicts, duplicate/concurrent commands, rate and capacity limits, initial and
post-save snapshots, fail-closed static routing, and stop/restart cleanup. The
additional actual-service HTTPS/Chrome harness verifies the phone UI with fake
actions, not just mocked fetch calls. Neither suite proves real Tailscale Serve,
physical phones, native WebKit rendering, or the desktop admin UI lifecycle.

**Manual Serve example (review your existing Serve configuration first; do not
run this automatically):**

```bash
# Example only. Check `tailscale serve status` and your existing Serve config
# before changing anything. Funnel is not needed and must not be enabled.
tailscale serve --bg --https=443 http://127.0.0.1:45829
```

The service trusts the configured public host and the exact loopback upstream
authority. If your Serve proxy rewrites `Host` or `Origin` differently, adjust
the proxy configuration or report the mismatch; the backend does not trust
arbitrary forwarded headers.

#### First physical-phone check (manual; not yet verified)

1. Launch the native desktop app. In **Settings → Phone connection**, enter the
   root `https://computer.tailnet-name.ts.net` origin and choose **Start connection**.
2. Review your current Serve configuration before deliberately applying an approved
   HTTPS-to-loopback proxy such as the example above. Never enable public Funnel.
   Keep Tailscale connected on both devices and the desktop app running.
3. On iPhone, open that root address in **Safari → Share → Add to Home Screen**.
   Launch the installed app. On Android, use the browser's install menu.
4. Only now create a fresh pairing link in desktop Settings. **Paste it inside
   the installed app**, name the phone, and choose **Request approval**. Links
   expire after two minutes; Safari, Brave, and standalone sessions must not be
   assumed to share cookies.
5. Approve the named request on the desktop. Confirm the phone shows the saved
   pages and live edits. Before pressing a control, remember: these are **real
   OBS/audio/media actions**, unlike the local Preview route. Choose a deliberate,
   reversible action and verify the actual desktop result. If the result is
   Unknown, check the desktop before retrying.
6. Revoke the phone and confirm controls disappear. Stopping/restarting the
   service invalidates every device; the next session needs fresh pairing.

Repeat in Brave and on Android separately. This checklist is a validation plan,
not a claim that physical-device installation or actions have succeeded.

**One-process prototype limit:** the deck store's compare-and-swap serializes
writes within one native app process. Do not run two native app instances
against the same app-data directory; multi-process writers are not supported.

### Manual native smoke (optional, MUTATES machine state)

These steps change the state of the machine you run them on. They are for a user
who chooses to verify the adapter by hand; they are not part of `npm run smoke`
and no automated test performs them.

1. Enter the shell: `nix develop path:.`.
2. Confirm the tools exist without changing anything: `command -v wpctl playerctl`.
3. Launch the desktop app: `npm run tauri:dev` (or run the debug build).
4. Add or select a **Microphone mute** control. Read the observed state, press
   **Toggle**, and confirm the physical/OS microphone indicator matches the
   reported state.
5. Select a **Media play/pause** control, start playback in a real MPRIS player,
   press **Play/Pause**, and confirm the player responds.
6. Select a **Volume slider** control, move the target away from the current
   value, press **Apply**, and confirm the system volume changes and the readback
   matches. A target is only sent on Apply, not while dragging.
7. Stop playback and close the app. Confirm the reported states were never shown
   as confirmed without a readback.

Reverse or re-adjust any volume, mute, or playback the smoke steps changed.

### Native development shell

`flake.nix` provides the Tauri Linux build environment and is pinned by `flake.lock` to the same `nixpkgs` revision used by `~/nix-config`. It supplies Rust/Cargo, rustfmt, Node 22, pkg-config, the `playerctl` and
`wireplumber` (which provides `wpctl`) session tools, and WebKitGTK 4.1, GTK3,
glib, libsoup3, openssl, librsvg, and XZ. The shell also prepends XZ to `LD_LIBRARY_PATH`, because the npm `@tauri-apps/cli` native binding needs `liblzma.so.5`, which is not on the default Nix loader path.

For Mesa-based graphics, the shell selects its **pinned Mesa EGL vendor and GBM backend** through `__EGL_VENDOR_LIBRARY_DIRS` and `GBM_BACKENDS_PATH`, preserving explicit overrides. Otherwise a newer host driver can require a newer glibc than the pinned app and WebKit aborts with `Could not create default EGL display: EGL_BAD_PARAMETER`. Both loader paths must match; no sandbox or GPU-acceleration disabling is needed. This was verified on the current AMD/Wayland machine; proprietary NVIDIA needs a compatible vendor/backend configuration of its own. This is a development-shell fix, not a validated packaging solution.

The Nix environment can be evaluated from the committed repository:

```bash
nix develop --command cargo --version
nix develop --command npm run tauri:build -- --debug --no-bundle
```

Run `nix develop` for an interactive shell. With direnv, `.envrc` can simply contain `use flake`; run `direnv reload` after changing the flake, then `npm run tauri:dev`. Generated `.direnv/` data is ignored. Keep new Nix source files tracked so the Git flake includes them; avoid `path:.`, which can copy ignored build artifacts into the Nix store.

Verified on this machine (NixOS `x86_64-linux`, KDE Plasma Wayland, Node `v22.23.3`, npm `10.9.9`, Nix `2.34.8`):

```text
$ nix develop path:. --command bash -c 'cargo --version; rustc --version; pkg-config --version'
cargo 1.97.0 (c980f4866 2026-06-30)
rustc 1.97.1 (8bab26f4f 2026-07-14)
0.29.2

$ nix develop path:. --command npx tauri info
  webkit2gtk-4.1: 2.52.6   rsvg2: 2.62.3   rustc: 1.97.1   cargo: 1.97.0   node: 22.23.2

$ nix develop path:. --command bash -c 'cd src-tauri && cargo test --locked'
...
test result: ok. 43 passed; 0 failed   # 10 deck store + 13 OBS + 20 system

$ nix develop path:. --command npm run tauri:build -- --debug --no-bundle
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 42.97s
    Built application at: src-tauri/target/debug/deck
```

The pinned dev shell includes `rustfmt`, so formatting can be checked in place:

```bash
nix develop path:. --command bash -c 'cd src-tauri && cargo fmt --check'
```

The commands above verify compilation and automated backend behavior, not live
integrations. A separate **opt-in headful startup check** is available:

```bash
npm run smoke:native
```

It builds the native debug app in the Nix shell, briefly opens a real window with
isolated temporary data/config/cache, and checks that WebKit actually initializes
the native deck—not merely that the GTK parent stays alive after a renderer
crash. No buttons are pressed and no OBS/audio/media or phone service is started.
This startup check passes on the current AMD/Wayland machine with matching EGL
and GBM libraries. It does not verify visual correctness, normal user app-data,
real OBS/PipeWire/MPRIS actions, or deb/AppImage packaging. To launch normally,
use `nix develop --command npm run tauri:dev` or the direnv flow above.

### Other Linux distributions

The Debian/Ubuntu packages for a non-Nix Tauri 2 build are:

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf
```

Do not run that here; this machine uses the Nix shell above.

### Icon caveat

`src-tauri/icons/32x32.png` is an 8-bit palette PNG, which Tauri's codegen rejects (bundle icons must be RGBA). It has been removed from the `bundle.icon` list in `src-tauri/tauri.conf.json`; the 128×128, 256×256, and 1024×1024 RGBA icons remain. Add a 32×32 RGBA replacement instead of a palette file if a small bundle icon is needed.

## Persistence and recovery

There are two storage modes and they do not share data.

### Browser build

- `loadDeck` accepts only schema version 1, a non-empty page list, an existing active page, unique IDs, valid action fields, and volume values from 0 through 100.
- Empty storage loads the sample two-page deck. Malformed JSON, an unknown version, or invalid data also loads the sample deck and leaves a visible storage warning. The next edit replaces the invalid document.
- Saves are single-key `localStorage` writes with validation before writing. Storage failures are reported in the editor; they are not silently treated as saved.
- The phone preview at `#/phone` reads the same `localStorage` document and listens for `storage` events from other tabs.

### Native desktop shell

The desktop app owns the authoritative deck in a single versioned JSON document,
`deck.v1.json`, in Tauri's app-data directory (on Linux,
`$XDG_DATA_HOME/com.deck.local/`, usually `~/.local/share/com.deck.local/`). The
path is resolved through Tauri's path API; no home path or frontend-supplied path
is used. The file contains only `{ revision, deck }` — no credentials or runtime
action state.

- Schema parity. The Rust store deserializes the same `action`-tagged control
  union as the frontend and enforces the same version, page/control caps, unique
  IDs, an existing active page, valid action fields, and volume `0-100`. It also
  enforces bounded ID/name/label/scene strings and rejects documents larger than
  256 KiB before reading them. One shared fixture
  (`tests/fixtures/deck.sample.json`) is validated by both suites and covers all
  four control kinds.
- Atomic writes with revision compare-and-swap. Writes are serialized in
  process, go to an owned same-directory temporary file, are flushed and synced,
  then renamed over the destination. The in-memory revision only advances after a
  durable successful write, so a failed write leaves the previous good bytes and
  the previous revision intact. Each save sends the revision it expects; a stale
  save returns a typed `conflict` with the current revision and never overwrites
  the newer file.
- Missing file. If no file exists, the app loads the sample deck and initializes
  once through a revision-0 save. If this browser already has a saved
  `localStorage` deck, that deck is used for the one-time initialization instead.
  The browser data is not deleted. An existing native file always wins.
- Invalid or newer file. A malformed, schema-invalid, or unknown-version file is
  never overwritten automatically. Loading returns `invalid_file`,
  `unsupported_version`, or `file_too_large`; the app keeps the original bytes,
  shows a recovery screen naming the file, and waits for a reload. Fix or move
  the file, then press **Reload deck**.
- Save failures. Edits are queued through a single sequential, latest-state save
  queue, so rapid edits are not lost to concurrent saves. While a save is
  pending the editor shows **Saving** / **Saved** / an error. On failure the
  in-memory edits are kept; the queue does not retry silently. A conflict blocks
  further saves until the authoritative deck is reloaded.
- Native phone preview. Inside the desktop shell, the `#/phone` route shows the
  current in-memory native deck and does not read browser `localStorage`.
- There is no export/import, cloud sync, or backup yet.

## Honest limitations

- The authenticated phone UI and private service work in isolated HTTPS/Chrome tests with fake adapters. Physical iPhone/Android PWAs, real Tailscale Serve, native desktop admin lifecycle, and packaged asset resolution remain unverified. There is no QR presentation, automatic Serve setup, or LAN HTTPS implementation. The service is explicit-enable only.
- Execution is limited to OBS program-scene switching and, on Linux only, default system microphone mute, default output volume, and MPRIS play/pause, from the native Inspector or approved phone. Local phone preview and toolbar tile presses remain simulated. Windows/macOS system actions are not implemented (typed `unsupported`).
- The system adapter is tested with a fake process runner; it has not been run against a live PipeWire session or a real media player, so runtime behavior on this machine's actual audio setup is unverified. OBS credentials are session-only; OS keychain persistence is not implemented.
- No real OBS Studio instance has been exercised in this repository; the Rust adapter is only tested against a fake OBS5 peer.
- Both browser suites run locally against isolated headless Chrome (`npm run smoke`, `npm run smoke:remote`); no physical-phone, pixel-regression, or real-network claim is made.
- Native startup is verified in a bounded real-window smoke with temporary app-data/config/cache; the frontend creates its native deck successfully. Normal user data was not touched. Visual correctness, desktop admin lifecycle, remote bundled-asset serving, live OBS/audio actions, and deb/AppImage packaging remain unverified.
- The native store and the browser store are independent. There is no continuous sync between the browser deck and the native file; migration happens only once, when the native file is missing.
- The dial control, drag-and-drop editing, multi-select, undo/redo, export/import, and CI are not included.
- The web app is installable only where the browser accepts it as a secure-context PWA. Network-device installation remains unverified.

## Project shape

```text
src/                 React editor, simulated preview, authenticated phone client, schema, persistence
public/              PWA manifest and generated icons (service worker is build-generated)
build/               Vite plugin that generates the versioned service worker
tests/               Vitest logic, native-save-queue, persistence, and service-worker policy tests
                     plus tests/fixtures/deck.sample.json shared with the Rust store tests
scripts/             Local UI and actual-service HTTPS/Chrome smoke helpers (raw CDP)
src-tauri/           Tauri 2 Rust shell: deck store, OBS and system audio/media adapters, private phone-service backend, tests, config, capabilities
roadmap.md           Product roadmap and confirmed decisions
```

## License

MIT. Copyright © 2026 Zane Helton. See `LICENSE`.
