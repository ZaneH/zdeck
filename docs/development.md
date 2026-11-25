# Developing and verifying zDeck

Start with the [README](../README.md) for the product, source quick start, platform gaps and phone setup. This guide holds implementation and verification detail; [plugins](plugins.md) and the [phone protocol](protocol.md) are the dedicated contracts for those subsystems.

## Development commands

Use Node.js 22.18+ and npm 10+. Run `npm ci` in the repository root to install the locked frontend dependencies. Commands below run from that root unless stated otherwise.

| Command | Purpose / prerequisites |
| --- | --- |
| `npm run dev` | Vite editor at `http://localhost:1420`; all browser actions simulated |
| `npm test` / `npm run test:watch` | Vitest logic tests / watch mode |
| `npm run typecheck` | TypeScript check without emitting |
| `npm run build` | TypeScript check and Vite production output in `dist/` |
| `npm run preview` | Serve the production build at `http://localhost:4173`; build first |
| `npm run tauri:dev` | Native app; requires Rust and platform libraries |
| `npm run tauri:build -- --debug --no-bundle` | Debug executable without installer packaging |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml` | Desktop Rust suite; use the native build environment |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml -p zdeck-obs` | Standalone OBS fake-peer tests; no desktop/native dependencies or live OBS required |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml -p zdeck-schema` | Standalone deck/icon validation and stored-document migration tests; no desktop/native dependencies |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml -p zdeck-system` | Standalone system adapter and fake-backed tests; needs the platform compiler/SDK, not Tauri, frontend assets or live controls |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --workspace` | Full Rust workspace suite (desktop, OBS, schema and system); requires the native build environment |
| `cargo fmt --manifest-path src-tauri/Cargo.toml --all --check` | Workspace Rust formatting |
| `npm run storybook` | Real components with local fixtures at `http://localhost:6006` |
| `npm run storybook:build` | Standalone fixture site in ignored `storybook-static/` |
| `npm run landing:dev` / `npm run landing:build` | Separate landing site / build to `dist-landing/` |
| `npm run plugin:package:spotify` | Complete local Spotify folder in `dist/plugins/spotify/`; run after frontend build |
| `(cd packages/plugin-sdk && npm test)` | SDK, packed-consumer and fake Spotify checks; see [plugin verification](plugins.md#verification) |

The Cargo workspace is rooted at `src-tauri/Cargo.toml`, with a shared `src-tauri/Cargo.lock` and target directory. The reusable OBS adapter lives in `crates/zdeck-obs`; desktop callers retain the `deck_lib::obs` path through a re-export. `cargo test --locked --manifest-path crates/zdeck-obs/Cargo.toml` also runs just the OBS crate. The pure schema crate lives in `crates/zdeck-schema` and depends only on `serde` and `serde_json`. It owns deck/icon models, defaults, validation, typed deck errors, plugin identifier/safe-integer primitives and stored-document v1-to-v2 decoding. Desktop callers retain `deck_lib::deck::*` and `deck_lib::icons::*` through re-exports; `DeckStore`, file limits/naming, bounded reads, locking, atomic writes and revision conflict handling stay in the app. `cargo test --locked --manifest-path crates/zdeck-schema/Cargo.toml` runs just the schema crate. The system platform adapter lives in `crates/zdeck-system` and owns the Linux process runner, macOS/Windows native sources, native build/link directives and fake-backed system tests. Desktop callers retain `deck_lib::system` through a re-export; Tauri IPC, main-thread permission dispatch and Windows Common Controls manifest embedding stay in the app. `cargo test --locked --manifest-path crates/zdeck-system/Cargo.toml` runs just this adapter, with no Tauri/GTK/wry dependencies. It uses the platform compiler/SDK on macOS/Windows; `bash scripts/test-system-macos.sh` runs its fake CoreAudio regression tests without live device access or permission prompts. Standalone schema/OBS/system commands do not build Tauri or need frontend assets; full-workspace tests need the native prerequisites and `npm run build` first. CI runs all three standalone crates on the existing macOS/Windows/Linux matrix before installing desktop native prerequisites.

A later frontend build can clear `dist/`, including a packaged plugin folder. Packaging a plugin does not install, enable or publish it. No automatic download or registry service is part of the desktop catalog.

### Browser and native smoke checks

These scripts are opt-in, not part of `npm test`. Do not quote historical check counts as current results; record the actual run, platform and limitations.

#### `npm run smoke`

Builds two frontend versions and drives installed `google-chrome` headlessly using raw CDP and a throwaway browser profile, not your personal browser. `CHROME_BIN` can select a different executable. No browser dependency is installed by the script.

Coverage includes setup rehearsals, validation/save/skip/replay, page/control editing, modal focus/search/keyboard behavior, persistence and cross-tab sync, phone-preview page/slider input, themes and constrained layouts, offline shell behavior and the two-build service-worker update lifecycle. Fake desktop IPC checks Settings/QR/link lifecycle and plugin flows without native execution. Screenshots and a summary go under `/tmp`; the final `dist/` is an unmarked build.

#### `npm run smoke:remote`

The npm script uses the repository's **Linux/Nix** environment and the ignored Rust `remote_browser_smoke` fixture. Requires installed Chrome and `openssl`. It builds the frontend, starts the actual Rust phone service with a temporary deck and fake action runner, and drives the phone UI through a disposable loopback HTTPS proxy. Host/Origin/cookies are forwarded unchanged; hostile boundary probes must fail.

Coverage includes invitation/approval, fresh-context paste, authenticated GET/WSS, saved controls/results, deliberate slider commits, live edits, conflict resync, lost-response Unknown/no replay, revocation and remote-only offline caching. The fixture has a bounded deadline. Certificate bypass and host mapping exist **only in the isolated test profile**, never as phone setup guidance. It changes no Tailscale settings and runs no real system actions.

#### `npm run smoke:native`

**Linux-only, opt-in, headful.** Builds with the `native-smoke` feature and briefly opens a real native window using temporary app-data/config/cache. Checks native deck initialization and WebKit geometry: positive pixel ratio, viewport/font size, setup widths, editor grid/Inspector, Settings alignment and horizontal overflow. Navigation advances/skips setup and opens Settings; it does not start OBS/audio/media or the phone service.

The hook requires both the build feature and launcher-set environment flag and is absent from normal builds. Previous successful runs were on AMD/KDE Wayland with matching EGL/GBM libraries. This does not prove visual correctness, normal-user-data behavior, real actions, desktop admin lifecycle, bundled remote asset resolution or installer packaging.

### Storybook boundaries

Stories render real components with the local Geist font, app CSS tokens and Dark/Light toolbar. Control presses, slider releases, setup completion and plugin actions update local fixtures only. They never launch plugins, read media, probe Node, open folders, move real files or start phone services. Narrow stories constrain width without a viewport addon. Reload or switch stories to reset state.

Serve `storybook-static/` with an HTTP static server rather than opening files directly. Fixture sites are separate from production `dist/` and are not evidence of native permissions, connectivity or action outcomes.

## Native development

Install the [Tauri 2 platform prerequisites](https://v2.tauri.app/start/prerequisites/) and Rust. The checked-in Tauri bundle targets are `deb` and `appimage`; neither packaging nor macOS/Windows installers are validated. A successful no-bundle build is not a release installer.

### Pinned Linux/Nix shell

[`flake.nix`](../flake.nix) supplies an **x86_64-linux-only** shell pinned by `flake.lock`: Rust/Cargo/rustfmt, Node 22, pkg-config, WebKitGTK 4.1, GTK3, glib, libsoup3, OpenSSL, librsvg, XZ, `playerctl` and WirePlumber (`wpctl`).

```sh
nix develop
npm ci
npm run tauri:dev
```

Non-interactive examples:

```sh
nix develop --command cargo --version
nix develop --command cargo test --locked --manifest-path src-tauri/Cargo.toml
nix develop --command cargo fmt --manifest-path src-tauri/Cargo.toml --check
nix develop --command npm run tauri:build -- --debug --no-bundle
```

For direnv, a local `.envrc` can contain `use flake`; explicitly allow/reload it after review. Keep new Nix source tracked so the Git flake sees it. Avoid `path:.` as the default: it can copy ignored build artifacts into the store.

For Debian/Ubuntu without Nix, the usual Tauri build packages are:

```sh
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf
```

This is an intentional system-install example, not a test command. Check your distribution and current Tauri prerequisites first. Linux built-in runtime controls additionally need WirePlumber/`wpctl`, `playerctl`, an active PipeWire/WirePlumber session and an MPRIS-compatible player.

### Linux graphics and WebKitGTK

The Nix shell prepends XZ to `LD_LIBRARY_PATH` because the npm Tauri CLI binding needs `liblzma.so.5` outside the default Nix loader path.

For Mesa graphics, it selects the **pinned EGL vendor and GBM backend** with `__EGL_VENDOR_LIBRARY_DIRS` and `GBM_BACKENDS_PATH`, preserving explicit overrides. A newer host driver can otherwise require a newer glibc and fail with `Could not create default EGL display: EGL_BAD_PARAMETER`. Both loader paths must match. No sandbox/GPU disabling is needed. The previous validation was AMD/Wayland; proprietary NVIDIA needs its own compatible configuration. This is a development-shell fix, not validated packaging.

WebKitGTK 2.52 can turn GTK3's unset screen resolution (`-1`) into negative page zoom, negative `devicePixelRatio` and a thin-column layout. [`linux_display.rs`](../src-tauri/src/linux_display.rs) initializes GTK before the webview and replaces only invalid/unset resolution with the configured GTK font DPI (96 if unset), honoring valid `GDK_DPI_SCALE`. Valid resolution is unchanged; the fix is process-local, not a KDE/display-settings or CSS change. Native smoke checks the resulting geometry.

Upstream context: [`xftDPI()`](https://github.com/WebKit/WebKit/blob/webkitgtk-2.52.6/Source/WebKit/UIProcess/gtk/SystemSettingsManagerProxyGtk.cpp) feeds [`fontDPI()`](https://github.com/WebKit/WebKit/blob/webkitgtk-2.52.6/Source/WebCore/platform/gtk/PlatformScreenGtk.cpp) and page scale.

### Branding and tray icons

The logo is a Z inside a rounded box, without a lower deck/shadow. `src/components/BrandMark.tsx` uses theme ink; app/browser icons use the dark/cyan palette. Run `python3 scripts/generate-brand-icons.py` with Pillow available to regenerate and validate the SVG, RGBA PNG, Windows ICO and macOS ICNS assets. Keep the generator's shapes and `BrandMark.tsx` geometry in sync.

[`tray.rs`](../src-tauri/src/tray.rs) creates the native status icon with **Open zDeck**, local service controls, **Settings**, and **Quit zDeck**. macOS uses the transparent monochrome `tray-template.png` with Tauri's `icon_as_template(true)`: macOS chooses white/dark ink for the current menu bar, rather than displaying the colored app icon. Windows and Linux keep the colored app icon (Linux needs a desktop with system-tray/AppIndicator support). The existing opt-in close-to-tray preference and safe shutdown behavior are unchanged. Tray creation failures remain visible through the existing desktop notice without blocking launch.

Reference: [Tauri system tray](https://v2.tauri.app/learn/system-tray/) and [`TrayIconBuilder::icon_as_template`](https://docs.rs/tauri/latest/tauri/tray/struct.TrayIconBuilder.html#method.icon_as_template). For visual verification, launch on macOS in both light and dark menu bars and check the menu's Open/Quit actions; check the colored tray on Windows and a tray-enabled Linux desktop as well.

## Architecture and execution boundaries

```text
src/                    React editor, simulated preview, authenticated phone client
src/lib/                Schema, persistence, native bridges, connection/action lifecycles
crates/zdeck-schema/    Pure Rust deck/icon models, validation and stored-document migration
crates/zdeck-obs/       Reusable OBS adapter and fake-peer tests
crates/zdeck-system/    System platform adapter, native build/sources and fake-backed tests
src-tauri/src/          Native deck store, shared action runner, adapter IPC and plugin host,
                        private phone service, Linux display initialization
src-tauri/tests/        Rust adapter, storage, host/discovery and real loopback service tests
packages/plugin-sdk/    ESM SDK, declarations, typed example and packed-consumer tests
plugins/spotify/        macOS Spotify reference source, not an end-user installation folder
public/                Manifest and local icons
build/                 Build-generated versioned service worker
scripts/               Raw-CDP smoke launchers and plugin packager
tests/                 Frontend tests and shared schema fixtures
landing/, src/landing/ Separate landing page
```

The native shell builds the same frontend as the browser build, with restrictive production CSP and a separate Vite/HMR development CSP. Remote pages have no privileged Tauri origin. Native commands are narrow; there is no general shell-execution command. The capability file has no Tauri framework-plugin permissions; the external-process extension host is implemented through narrow native commands and explicit local trust.

- **OBS** stays in Rust using `obws`, connects only to loopback and holds passwords in session memory. A scene change is read back; mismatch is not-applied, and timeout/disconnection after possible mutation is unknown. Fake OBS5 peers cover the adapter without running OBS.
- **Linux system actions** use fixed `wpctl` / `playerctl` executables and argument arrays, not a shell or user-supplied command. Processes have bounded timeouts and timed-out children are killed/reaped. Raw stderr/paths are not shown. A failed refresh clears observed state instead of advertising stale data as live. Volume input is finite 0–100; if the OS reports boost above 100%, readback displays it honestly. Microphone mute uses an explicit target derived from read state; media checks for a player before play/pause. Families fail independently. macOS uses CoreAudio/AppKit and Windows uses Core Audio/SendInput through the crate's fixed native ABI; native media keys honestly leave playback state unknown.
- **Desktop Live** uses the saved control/revision through the shared action runner. A valid synchronized saved deck is required. Editing/leaving resets Preview; in-flight/unknown outcomes are not blindly repeated. Explicit Inspector execution remains real.
- **Plugins** have independently bounded sessions shared by desktop and phone. Local discovery validates folders/entrypoints/SDK and probes Node without running plugin code; enabling requires explicit trust. See [the plugin guide](plugins.md) for its protocol and unsandboxed trust boundary rather than duplicating it here.
- **Phone service** binds HTTP only at `127.0.0.1:45829` behind user-managed HTTPS. Admin is native-only. The remote HTML marker selects the remote client but is not authorization; missing markers/assets fail closed. Cookies, exact Host/Origin validation, device approval, revision checks, limits and bounded command deduplication enforce the service boundary. See [protocol.md](protocol.md) for exact contracts. Deduplication is not exactly-once execution across crashes/restarts or beyond its result window.

### PWA shell and updates

The manifest starts at `/#/phone`, with local 192/512 icons and `display: standalone`. The standalone browser route is simulated; every route served by the private service remains on its authenticated remote surface, with no editor/sample fallback.

[`build/serviceWorkerPlugin.ts`](../build/serviceWorkerPlugin.ts) generates the worker from real build output; there is no hand-written `public/sw.js`. Registration is production-only. Cache versions hash shell/asset contents. The exact precache allowlist includes `index.html`, manifest, icons and hashed `assets/`; it excludes query strings, API-shaped paths, cross-origin and non-GET requests. Navigation fallback handles only `/` and `/index.html`. Authenticated responses are never cached.

A waiting worker installs into a separate cache without reloading or changing the active cache. A user-triggered **Reload** applies it and removes the previous cache. `VITE_BUILD_MARKER` can distinguish builds when testing this lifecycle. An installed shell is not offline authorization: disconnected phones cannot execute or queue actions.

## Persistence and recovery

The browser and native stores are independent. Internal names (`deck-editor`, `deck`, `com.deck.local`, `deck.local.v1`, `deck.v1.json`) intentionally survive the display rename to avoid moving data.

### Browser storage

`localStorage` key `deck.local.v1` holds the deck. Current schema v2 supports plugin controls; valid v1 documents upgrade in memory. Validation covers version, non-empty pages, existing active page, unique IDs, bounded strings/control counts and valid action fields/volume. No credentials or observed runtime state belong in the document.

Empty storage loads the sample deck. Malformed/unsupported/invalid data loads a sample **with a visible warning**; the next edit replaces the invalid document. Saves validate before a single-key write and report failures rather than claiming success. The browser phone preview reads this same store and listens for other-tab edits. Back up invalid data before editing if recovery matters.

### Native store

`deck.v1.json` lives in Tauri's resolved app-data directory, typically `$XDG_DATA_HOME/com.deck.local/` or `~/.local/share/com.deck.local/` on Linux. The frontend never supplies a path. The document contains `{ revision, deck }`, not credentials or runtime action state; the filename remains unchanged even when the deck schema is v2.

- **Validation:** Rust enforces schema/limits and rejects files over 256 KiB before reading. Shared fixtures in `tests/fixtures/` help enforce parity with frontend validation.
- **Atomic saves:** serialized in-process writes go to a same-directory temporary file, are flushed/synced, then renamed. Revision advances only after success. Expected-revision compare-and-swap rejects stale writes without overwriting a newer deck.
- **Missing file:** initialize once from a valid browser-local webview deck if present, otherwise the sample. Browser data is not deleted. An existing native file always wins; this is not continuous browser/native sync.
- **Invalid/newer file:** preserve the original bytes and show recovery, not a silent sample overwrite. Errors include `invalid_file`, `unsupported_version` and `file_too_large`. Back up the file, repair or move it deliberately, then **Reload deck**.
- **Save failures:** the sequential latest-state queue retains in-memory edits, reports the failure and does not silently retry. Conflict blocks further saves until authoritative reload; preserve any needed unsaved work before reloading.
- **Migration:** valid v1 decks upgrade in memory; migration alone does not rewrite disk. The next explicit edit/save writes v2. Older apps cannot read that new schema; keep a backup before downgrading.
- **Preview:** native `#/phone` uses the in-memory native deck, not browser `localStorage`.

There is no deck export/import, cloud sync or automatic backup. Compare-and-swap coordinates only a **single native process**: do not run two instances against the same app-data directory.

## Verification status and remaining gates

Existing automated coverage includes schema/migration, editing, persistence/save queue, native action bridges, invitations, phone lifecycle cancellation/deadlines, ambiguous outcomes, fake OBS/system adapters, temporary atomic storage, plugin host/discovery and packed SDK consumption. Loopback service tests open real HTTP/WebSocket connections to owned temporary instances with fake assets/actions; they exercise authorization, strict bodies, revision conflicts, concurrent duplicates, limits, snapshots, fail-closed routing and cleanup.

The actual-service HTTPS browser fixture adds UI integration with fake actions. The native startup smoke adds an isolated Linux window/layout check. These are different evidence, not substitutes for physical integrations. Historical README pass counts were snapshots of earlier code and are intentionally not carried forward as current results.

Still open: Windows/macOS live native validation; live OBS/PipeWire/MPRIS validation; live Spotify/JXA and macOS Automation attribution; physical phone installs/actions and trusted LAN HTTPS; native desktop phone-admin lifecycle; packaged bundled-asset resolution; signed/distributed installers and deb/AppImage validation. A user-reported Tailscale Serve phone connection does not close those gates.

### Physical-phone verification

This is a manual validation plan, not a claim of success:

1. Launch one native app, configure a saved deck and choose Tailscale or Local HTTPS. Enter the actual stable HTTPS root and explicitly start the loopback service.
2. Deliberately set up the chosen proxy after reviewing existing configuration. Follow [phone setup](../README.md#put-your-deck-on-a-phone) and the [Local HTTPS trust precautions](protocol.md#local-https-setup). Do not enable Funnel, bypass TLS warnings or copy private keys. Keep app/proxy running.
3. Open the HTTPS root on the phone and confirm **Connect your phone**. Install to the home screen if testing PWA installation. iPhone Safari and Android/browser variants require separate checks.
4. Launch the intended browser/PWA, paste a fresh two-minute invitation inside it, request approval and approve the named device on the desktop. Do not assume QR-opened browser and installed app cookies are shared.
5. Confirm saved pages and live edits. Choose a reversible action, deliberately run it and verify the actual desktop result; check the desktop before retrying Unknown. Verify disconnection disables controls and no offline press is replayed.
6. Revoke and confirm access/socket loss. Stop/Start and relaunch zDeck at the same origin/mode; confirm approved phones resume without pairing, Start opts into auto-start and Stop opts out. Revoke, restart and confirm the old phone stays rejected. Change origin/mode and confirm switching back does not restore approvals. Check storage/bind failures appear in Settings without blocking launch. Check origin/certificate stability and reinstall/re-pair after origin changes as needed.

Repeat in the browsers/devices you intend to support. Record OS, browser, installation context, adapter dependencies, observed effect and readback—not just that the page loaded.

### Manual Linux action smoke — changes real machine state

Only perform these steps deliberately on your own session. Automated smoke checks do not run them.

1. Enter `nix develop` (or your configured native environment) and check `command -v wpctl playerctl`.
2. Launch `npm run tauri:dev` and select a **Microphone mute** control. Read its observed state, press **Toggle**, and compare with the OS/physical microphone indicator.
3. Open a real MPRIS player and start playback deliberately. Select **Media play/pause**, run it, and confirm which player responds. Multiple players may change default selection.
4. Select **Volume slider**, choose a safe target away from the current value and press Inspector **Apply**. Confirm system volume and readback match. Inspector Apply is distinct from Live tile release-to-commit behavior.
5. Check that failed reads are not shown as confirmed/live, then restore any changed volume/mute/playback and close the app.

Do not treat fake-runner tests as this check. Avoid unattended tests that mutate hardware, permissions, certificates, network/proxy state or personal app-data.
