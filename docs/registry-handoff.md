# Registry handoff boundary (unreleased)

## Implemented in this desktop milestone

- Settings → Integrations → External plugins has the shared, right-aligned **Install from…** menu
  immediately above the plugin list: **Local .zdx**, then **Open plugin registry**. The old install
  button is removed. The picker, native OS drop and safe local review/install path are unchanged.
- The website opener is fixed native code, configured at **build time**, not a URL IPC or user
  setting. No canonical deployed website URL was found in the app/registry checked-in configuration.
  Unconfigured/invalid builds leave the registry option unavailable with visible keyboard-accessible
  guidance. See [local preview and build configuration](zdx.md#registry-website-menu).
- Packaged desktop scheme declaration: `zdeck`. Tauri's deep-link plugin receives macOS opened-URL
  events and Windows/Linux startup arguments. The single-instance plugin is first in the builder;
  its `deep-link` feature forwards subsequent Windows/Linux launches to the first instance.
  The first instance subscribes before reading startup URLs; both use the same native inbox.
- Only `zdeck://plugins/install?id=<id>&version=<exact-version>` is accepted, with either query
  order. The native parser caps input at 512 ASCII bytes; ID is `[a-z][a-z0-9-]{0,63}`; version is
  three 1–4 digit numeric parts. Values can be percent encoded. Missing, duplicate, extra or encoded
  field names, fragments, paths, credentials, ports, arbitrary archive URLs, executable fields,
  version ranges/prereleases and invalid encodings are rejected. Native URL APIs can normalize a
  URI before delivery; only the resulting exact route/ID/version can ever be used, never its path
  as a filesystem location. No renderer link-submission or event-emission permission is exposed.
- Every valid request currently **fails closed** with: no trusted signed release resolver is
  configured; nothing was downloaded or installed. Invalid input gets fixed guidance without
  echoing the URL. No publisher/reviewed/signature assertion is made. No network request, staging,
  install, trust or enable operation is reachable from a deep link in this milestone.
- The error uses the existing native installer notification/view channel, not browser-supplied
  metadata. The window is shown for new requests. A local picker/review/install or existing error
  is not replaced: one bounded notice waits until it finishes or is canceled/dismissed. Notices
  never carry a review token. Only the local archive path can produce install authorization.
- Valid identities are deduplicated for this process's entire session (including canceled/rejected
  requests and startup/running overlap). At 128 identities, one limit notice asks to restart; no
  entries are evicted. Invalid requests produce at most one notice per session. A native callback
  processes at most 16 delivered URLs. There is no persistent link queue or automatic retry.
- Native archive commands and the website commands additionally validate the local `main` window
  URL. Native drops check that same local editor boundary. No registry/remote origin is privileged;
  capabilities remain listen/unlisten only. Opener JS interception is off. No shell interpolation,
  arbitrary-open-URL IPC, runtime scheme registration or global settings changes were added.

**Not end-to-end:** the registry checkout still has `INSTALL_REQUESTS_ENABLED=false`, unpublished
entries and no verified release records. It was read-only in this task. Opening the website is not
installing a plugin. A handcrafted install link only exercises the unavailable-resolution boundary.
Local unsigned archives must never be relabeled signed or publisher-verified as a workaround.

## Concrete release prerequisites (next milestone, not an implemented signing framework)

The registry's current optional `{keyId,value}` signature is shape-only. It does not define an
algorithm, signed bytes, endpoint or trust-root distribution. Adding a downloader behind that
schema today would create an unsigned remote-code installation path. Before enabling browser
install controls, maintainers of both projects need to agree and publish:

1. **One versioned signed release envelope.** Select a standard signature algorithm (Ed25519 is a
   suitable candidate, not yet an adopted contract) and specify the exact signed bytes/domain
   separation. Bind at least schema version, plugin ID, exact immutable version, runtime/platform
   requirements, source/licence/publisher metadata when asserted, artifact HTTPS URL, archive byte
   size and SHA-256. Reject unknown fields and mismatched identity. Do not sign only a digest while
   leaving identity, compatibility or artifact location unauthenticated.
2. **A project-owned trust root and exact release lookup.** Choose an owned HTTPS endpoint with
   immutable `(id,version)` records, bounded signed responses and documented key IDs, rotation and
   revocation behavior. Distribute reviewed public keys in the desktop build independently of
   website JSON; never fetch a trust root from a browser request. No private key belongs in this
   repo, plugin archives, frontend bundle, logs or tests. No endpoint/key is configured here.
3. **Deliberate publication.** Build self-contained `.zdx` artifacts offline, run archive/schema/
   host checks, verify source/licence/compatibility facts, compute byte size and SHA-256, sign the
   immutable record in a maintainer-controlled signing environment, then publish those exact bytes
   to an immutable HTTPS artifact store. No overwrite of an existing version; do not call the two
   local example archives published releases. Website availability and publication are separate.
4. **A bounded native resolver/downloader.** Resolve only ID/exact version, verify signatures with
   the independently configured key, and reject missing/untrusted/expired/revoked/mismatched records.
   Use HTTPS with normal certificate verification, fixed origin policy, bounded redirects (each
   target revalidated, no downgrade/private-network escape), connect/overall deadlines, streamed
   byte caps (including absent/lying Content-Length), exact signed size and digest verification.
   No browser-provided download URL, executable path or hook. Stage privately; cancellation cleans
   up installer-owned files and never retries an uncertain write.
5. **Bridge only verified bytes into the existing installer.** Inspect the same strict ZIP subset,
   compare static manifest identity/runtime against the signed record, show honest verified-record
   provenance and source/compatibility facts for explicit review, then install **disabled and
   untrusted**. Keep all staging, revalidation, atomic no-replace/collision and fingerprint checks.
   A signature is provenance/integrity, not sandboxing or permission to execute. Trust and enable
   stay separate. Updates/replacements remain manual and unavailable in this milestone.
6. **Test before activation.** Use isolated local fixture endpoints and test-only keys for immutable
   lookup, tampered signatures/records/bytes, wrong ID/version/runtime, unknown/revoked keys, timeout,
   redirect/SSRF, oversized/truncated archives, cancellation, startup/running duplicate delivery,
   collision, unsigned downgrade and untrusted origins. No real release, key or publisher should be
   invented merely to make a demo green. Only after native QA and a real publication should the
   registry project deliberately enable its install controls.

No unused generic signing library or pretend resolver/downloader was shipped here. Missing signing
and publication decisions are a real boundary, not a successful install result.

## Native registration and release gates

Declaration is not proof of OS registration. macOS requires an installed `.app` bundle whose
Info.plist has the scheme (a bare `cargo run` executable is not a handler). Windows requires the
packaged installer/association; Linux needs an installed desktop entry/MIME handler. AppImage
registration varies by desktop/launcher. The app does not silently rewrite user associations with
`register_all()`. If a browser cannot find a handler, install an appropriate packaged build or use
the desktop's local picker; this cannot be detected or repaired by the registry website.

Release QA must physically test **Windows, macOS and Linux**: installed-handler launch with app
closed; delivery to the already-running/tray-hidden app without a second active process; malformed
links; cancel then reopen the same link (no new prompt); simultaneous local picker/drop/review;
keyboard focus, browser return, no replacement; real file dialogs/drop; atomic publication on each
filesystem; and signed packaged-webview origins. Current bundle targets remain `deb`/`appimage`;
macOS/Windows release packaging and associations are not verified by a no-bundle Rust build.

Automated checks are not physical three-OS verification. The current checks use native inbox/parser
unit tests, isolated host archive fixtures and Brave fake IPC. No live user plugins, credential
stores, integrations, device actions, OS URL association or remote deployment is exercised.

## Verification for this milestone

Executed on the macOS development host:

```sh
npm test
npm run typecheck
cargo test --locked --manifest-path src-tauri/Cargo.toml -p zDeck --lib
cargo test --locked --manifest-path crates/zdeck-plugin-host/Cargo.toml
CHROME_BIN='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' npm run storybook:test -- src/components/PluginArchiveInstaller.stories.tsx src/components/PluginInstallDropdown.stories.tsx src/components/PluginSettingsCard.stories.tsx src/components/Inspector.homeassistant.stories.tsx
npm run storybook:build
npm run tauri:build -- --debug --no-bundle
npm run plugin:zdx:spotify
npm run plugin:zdx:home-assistant
ZDECK_ZDX_ARTIFACT="$PWD/dist/plugins/spotify.zdx" cargo test --locked --manifest-path crates/zdeck-plugin-host/Cargo.toml --test plugin_archive generated_artifact -- --ignored --nocapture
ZDECK_ZDX_ARTIFACT="$PWD/dist/plugins/home-assistant.zdx" cargo test --locked --manifest-path crates/zdeck-plugin-host/Cargo.toml --test plugin_archive generated_artifact -- --ignored --nocapture
```

Results: 357 frontend unit tests, 45 native library tests, 79 host tests (one generated-artifact
check initially ignored), 36 focused Storybook tests passed. Each generated artifact also passed
its opt-in isolated installation test. The native no-bundle build runs `npm run build` first
(typecheck and production Vite build); the final `.zdx` packaging was rerun **after** that build
cleared `dist`. Spotify SHA-256: `4483286cdfe8fed0620879b7cca4821cd63932b8579181e79fff067b66980d8a`;
Home Assistant SHA-256: `2bc4fde8f462feabbf91b929a9b5213eee63183972f34435b53485de225e979d`.
These are local artifact identities, not published/signed releases. Plugin dependencies are pinned
to Tauri 2/MSRV-compatible versions; lockfile metadata was checked, but Rust 1.89 and Windows/Linux
compilation were not separately exercised (local compiler: 1.100.0).

The existing `scripts/zdx-ui-smoke.mjs` was extended for the action menu, website IPC/error and
registry-unavailable state. Serve the production app on 1421 and built Storybook on 6010, then:

```sh
ZDX_ARTIFACT_DIR=/tmp/zdeck-registry-handoff CHROME_BIN='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' node scripts/zdx-ui-smoke.mjs
```

Passed: seven archive states at 960/320px, picker/drop fake parity, cancellation/focus restoration,
collision, busy Escape/backdrop, failed/uncertain publication, disabled/untrusted installation,
no trust/enable calls, browser preview restrictions; menu ordering, disabled explanation reachable
by keyboard, right alignment above the list, narrow overflow/cursor/reduced-motion checks, and a
fixed opener with no URL arguments and a persistent launch error. The shared menu's reduced-motion
rule was moved below its animation rule so it actually wins the CSS cascade. The existing plugin
Storybook thumbnail fixture was corrected to valid SVG rather than racing image-error fallback.

Screenshots and measured results are under `/tmp/zdeck-registry-handoff/`, including
`install-menu-960.png`, `install-menu-320.png`, `install-menu-unconfigured.png`,
`registry-unavailable-320.png`, `registry-open-error.png`, `installed-disabled.png` and `results.json`.
Storybook build has the existing large-chunk advisory; Node emits a `module.register()` deprecation
warning. Neither failed a check.

The native executable was **built, not launched**: this macOS app resolves the real home/plugin
folder through Tauri and can restore enabled plugins on startup; the current isolated GUI smoke
harness supports Linux only. Running it against user settings would violate this task's side-effect
boundary. Actual native picker/drop and closed/running OS-link behavior therefore remain unverified
on all three OSes. No network/signature tests were fabricated for a resolver that does not exist.
