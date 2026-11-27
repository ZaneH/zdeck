# Local `.zdx` installation (unreleased)

Local imports remain **unsigned custom archives**. The native `zdeck://plugins/install` path can
also resolve an exact signed release and explicitly download its bounded HTTPS archive into this
same review/installer, but only with independently configured build-owned public keys and endpoint.
The public endpoint/key defaults are compiled into new desktop builds, but no signed release or
native QA readiness is implied; preview registry entries remain unavailable. See the
[signed contract and isolated smoke](registry-releases.md) and [native handoff gates](registry-handoff.md).
No publisher identity verification, update/replacement flow, bundled runtimes or sandbox is implied.

## User flow

1. In desktop **Settings → Integrations → External plugins**, choose **Install from… → Local .zdx**, or drop
   exactly one local `.zdx` onto the desktop editor/settings window. Both native sources use the
   same inspector and installer. Browser preview has no native file installation.
2. Review the actual static manifest ID/version/protocol, detected runtime compatibility, local
   custom-source provenance and **not a sandbox** warning. Local hashes identify bytes, not a
   publisher. No plugin code, `describe`, npm/pip command or install hook runs during inspection.
3. Choose **Install disabled**. Cancel leaves no installed package. Runtime absence does not
   prevent installation, but prevents later enabling. A collision (including a case alias) is
   refused: first disable and explicitly uninstall the old package using the existing reversible
   backup flow, then select the archive again. There is no overwrite/replace button.
4. The package appears **disabled and untrusted** in External plugins. Review its source/license,
   then use the existing exact-fingerprint trust flow and enable separately. For settings-declaring
   plugins, trust the package, apply connection settings, then enable. Restart cannot restore a
   newly installed archive until the user explicitly trusts and enables it.

Deck controls and OS-stored credentials are preserved. Uninstall still moves the old folder to
`plugin-backups`; it does not delete credentials. Use a secret's **Forget** control before
uninstalling if that is intended, and revoke the credential at its provider separately.

## Registry website menu

The right-aligned **Install from…** shared menu sits directly above the installed plugin list.
**Local .zdx** opens the existing native picker; **Open plugin registry** opens a fixed, build-owned
website in the external default browser. It never navigates the privileged webview. There is no
runtime-editable registry URL. New native builds default to `https://zreg.zaaane.com/` using
independently shipped public trust; opening it does not imply any release is installable.
An explicitly empty/invalid website override leaves the option keyboard-reachable but unavailable
with an inline explanation. There is no end-user URL setting, arbitrary-open-URL IPC, or website privilege grant.

Maintainers can set `ZDECK_REGISTRY_WEBSITE_URL=https://<actual-owned-website>/` when building the
native app. This is a Rust compile-time variable (not `VITE_*`); changing it rebuilds the binary.
An explicitly empty/invalid override disables only that option, never application launch. URLs must be
bounded ASCII HTTPS without credentials, whitespace, query or fragment. Debug builds additionally
permit HTTP on exact `localhost`, `127.0.0.1` or `[::1]` for local preview; release builds refuse
loopback. For example, start the separate registry checkout with `npm run dev` (port 1430), then:

```sh
ZDECK_REGISTRY_WEBSITE_URL=http://localhost:1430 npm run tauri:dev
```

This opens a local prototype, not a published registry or an installable release. The native opener
has no general renderer opener permission and automatic JS link opening is disabled. Remote pages
are not Tauri origins. Browser previews cannot install local files or call the native opener.

## Canonical layout

A `.zdx` is an ordinary ZIP32 archive of the **contents** of one prebuilt plugin folder, not a ZIP
containing a wrapping ID directory. There is no nested-folder guessing or executable-path field:

```text
manifest.json              # existing strict protocol-v1 manifest, ≤16 KiB
main.js                    # OR main.py, exactly one fixed entrypoint
package.json               # Node metadata, when applicable
LICENSE
README.md
node_modules/@zdeck/plugin-sdk/…   # real complete SDK files for the included Node examples
# OR zdeck_plugin_sdk/__init__.py and types.py for a Python plugin
```

Everything needed by the plugin at runtime must be prebuilt and included. Node >=22.18.0 or Python
>=3.10 is installed separately. Runtime/platform requirements of the integration itself still
apply (Spotify remains macOS-only). The old folder contract is retained. Static inspection cannot
prove that arbitrary code is self-contained or safe, resolve every third-party dependency, detect
all malicious behavior, or verify a publisher. Installation does **not** authorize execution.

### Supported ZIP subset and limits

- Archive file ≤16 MiB; ≤4096 entries/files; each regular file ≤8 MiB; total declared **and actual**
  decompressed bytes ≤64 MiB. Compression is Stored or Deflate, ratio ≤200:1 per file.
- ZIP32 only, single disk, no encryption, archive/file comments or extra fields (including ZIP64,
  alternate Unicode paths, link extensions, reparse data and vendor-specific extraction behavior).
  The supplied packager creates deterministic Stored ZIPs, without these optional features.
- Relative forward-slash paths only, ≤200 bytes, ≤16 components, each ≤64 bytes. Components use
  ASCII letters/digits and `._@+-`. No empty/`.`/`..` segments, trailing dots, Windows device names,
  absolute/drive/UNC paths, backslashes, colons/ADS, spaces/control characters or Unicode aliases.
  Duplicate paths, case aliases (including parent directories) and file/directory conflicts fail.
- Ordinary files/directories only. Symlinks, hard-link extensions and special Unix types fail.
  No permissions, ownership, executable bits, symlinks or hardlinks are restored from ZIP metadata.
- Local/central headers must agree. Duplicate headers, overlapping entries, unlisted local
  headers, bad CRCs, malformed sizes and truncation fail. Entry-count/central-directory bounds
  are checked before the ZIP library allocates its index. Output reads independently enforce
  byte caps even if a header lies.
- Root manifest/schema, ID, fixed entrypoint, applicable bundled SDK preflight and the existing
  bounded whole-package fingerprint are validated before review and again before publication.

This is intentionally stricter than a general-purpose unzip tool. Repackage unsupported archives
with the project packager; do not weaken inspection just because another unzip tool accepts them.

## Native boundary and publication

Only the Rust Tauri picker callback and native `WebviewEvent::DragDrop(Drop)` handler provide
local paths. A separately authorized registry download supplies a signature/digest-verified bounded
byte snapshot, never a local path, into the same ZIP validator. Native commands and drop delivery
require the local main editor URL; registry links never provide paths or review authorization. No renderer command accepts a source path, executable, download URL or extraction target.
The picker uses the cross-platform Tauri dialog plugin from Rust; the frontend has **no dialog,
filesystem, shell or event-emission permission**. Only event listen/unlisten is granted to `main`.
Notifications carry no paths/metadata; the renderer re-reads authoritative native review state.
A browser DOM drop is not an authorization channel.

One native inbox owns one private `TempDir` review at a time, with a random opaque review ID.
The archive is snapshotted in bounded memory once; changing the original after review cannot
change the reviewed bytes. Extraction creates fresh regular files exclusively inside that private
staging directory. Cancellation/failure drops only installer-owned staging, never the selected
archive. A second selection cannot replace a pending review; stale tokens cannot install/cancel it.
Normal cancellation and process exit clean up owned staging. A hard crash can leave a bounded
installer-named temporary directory; no broad startup deletion of user files is attempted.

Install revalidates the staged fingerprint, copies into a second owned same-filesystem staging
folder, and publishes using atomic **no-replace** rename (`renamex_np(RENAME_EXCL)` on macOS,
`renameat2(RENAME_NOREPLACE)` on Linux, `MoveFileExW` with flags `0` on Windows). Filesystems
without the primitive fail explicitly; there is no overwrite fallback. It shares the host's
preferences/lifecycle lock and per-plugin gate with enable/restore/disable/uninstall. Catalog
reads wait for publication. An enabled session or existing ID cannot be replaced. Saved trust and
enabled intent for the new ID are cleared **before** publication, including stale records from
manual folder removal; other IDs' settings are preserved. Secure credentials and decks are not read
or changed by the installer.

The existing same-user filesystem race limitation of the folder fingerprint walk still applies:
a malicious process already running as this user can change their files or tamper with their app.
Private staging, snapshotting, repeat fingerprints and atomic no-replace publication narrow the
installer's race surface; they do not provide a security boundary against the same OS account.
Trust/enabling remains an explicit decision to run unsandboxed code.

## Packaging (offline, after the final frontend build)

```sh
npm run build                       # clears dist; always build before packaging
npm run plugin:zdx:spotify
npm run plugin:zdx:home-assistant
```

Outputs: `dist/plugins/spotify.zdx`, `dist/plugins/home-assistant.zdx`, and the existing complete
folder artifacts alongside them. The generic `packageZdx(folder, output)` export in
`scripts/package-zdx.mjs` can package other prebuilt folders; CLI output is limited to the two
included examples. It reads files/JSON, rejects source links and ambiguous paths, includes complete
bundled SDK files/licenses, and writes Stored ZIP32 without evaluating package code or running
package-manager hooks. It prints archive SHA-256 but **does not sign or install anything**.

## Verification and release gaps

- `cargo test --locked --manifest-path crates/zdeck-plugin-host/Cargo.toml`: isolated host/installer
  fixtures, malicious paths/types/headers/bombs, cancellation, stale selection, race/collision,
  exact identity, disabled/untrusted restart, reversible uninstall and no-replace publication.
- `cargo test --locked --manifest-path src-tauri/Cargo.toml -p zDeck --lib`: native inbox/selection
  fakes plus command/API wiring and minimal-permission assertions. No real dialog/user config.
- `npm test`, `npm run typecheck`, `npm run build`, `npm run storybook:build`.
- `CHROME_BIN='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' npm run storybook:test -- src/components/PluginArchiveInstaller.stories.tsx`.
- `scripts/zdx-ui-smoke.mjs`: bounded Brave screenshots/keyboard/layout plus app fake IPC for
  picker/drop review parity, cancel, collision, error, disabled install, browser preview and no
  trust/enable calls. Start app/Storybook at the URLs named in the script. These are simulations.
- After packaging, `ZDECK_ZDX_ARTIFACT="$PWD/dist/plugins/spotify.zdx" cargo test --locked --manifest-path crates/zdeck-plugin-host/Cargo.toml --test plugin_archive generated_artifact -- --ignored --nocapture`
  installs only into a fresh temporary fixture. Repeat for Home Assistant. Never exercise this
  check against the user's plugin directory.

Local macOS Rust compilation/tests and Brave fixtures are not native Windows/Linux/macOS picker,
OS-drop or signed-webview verification. All three actual OS file dialogs, drop event delivery,
focus/restoration, filesystem no-replace semantics and signed packaging still require native QA
before release. Do not claim three-platform native parity from browser/fake-IPC tests. No real
plugin enablement, credentials, Spotify/HA connection, device command or registry install occurs
in these checks.
