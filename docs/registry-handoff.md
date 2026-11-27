# Registry handoff (unreleased)

## Current implementation

Settings → Integrations → External plugins uses the shared right-aligned **Install from…** menu:
**Local .zdx**, then **Open plugin registry**. The website opener is a fixed build-owned external
URL, never navigation of the privileged webview or arbitrary URL IPC. Missing website configuration
leaves that action unavailable with keyboard-accessible guidance. See [zdx.md](zdx.md).

Packaged scheme: `zdeck`. Tauri's native deep-link plugin receives macOS opened-URL events and
Windows/Linux startup arguments. The single-instance plugin is first; subsequent Windows/Linux
launches forward links to the first instance. Subscribe before reading startup links; native
session deduplication covers overlap. There is no JS link-submission/event-emission permission,
automatic runtime scheme registration or website origin privilege.

Only `zdeck://plugins/install?id=<id>&version=<exact-version>` is accepted. Input is ≤512 ASCII
bytes, ID `[a-z][a-z0-9-]{0,63}`, version three 1–4-digit numeric parts. Query order and encoded
values are allowed; unknown/duplicate/encoded field names, paths, credentials, ports, fragments,
URLs, executable fields, ranges/prereleases and malformed encoding fail. At most 16 URLs from one
native callback are examined. Up to 128 identities are retained for the entire session without
eviction (including canceled/rejected links); invalid and overflow notices are bounded.

The signed resolver now ships an independently compiled public endpoint/key default for
`https://zreg.zaaane.com/`; no genuine signed release is published by this change. Lookup still
requires explicit user intent, and absent metadata fails without downloading an archive. See [registry-releases.md](registry-releases.md) for the exact Ed25519 payload,
build-owned key bootstrap/rotation/revocation, fixed lookup paths, public-DNS-pinned HTTPS,
byte/time limits, content types and isolated smoke commands.

For a deliberately configured build and a genuinely signed release:

1. Link creates an identity-only intent, not archive authorization.
2. **Look up release** verifies metadata against independent build-owned public keys.
3. Show authenticated registry-key provenance and source/commit/licence/compatibility/artifact
   facts, without claiming publisher identity or safety review.
4. **Download for review** verifies the signed size/digest, then feeds the exact memory snapshot
   into the local installer's ZIP validation/private staging. Cross-check archive manifest
   ID/version/protocol/runtime before issuing an archive review token.
5. **Install disabled** uses the same serialized, fingerprint-revalidated, atomic no-replace
   installer. Trust/enable remain separate. Existing IDs are refused; no updates or execution.

One active review; at most one waiting registry identity, first wins. Local picker/review/error
state is never replaced by a link. Lookup/download can be canceled and stale completions ignored;
installation itself cannot be canceled mid-publication. Extra waiting identities are ignored and
remain deduplicated, not persisted/retried. Native commands/drop require the local main editor
origin. A remote page never supplies an archive URL, filesystem path or install authorization.

## Matching static registry

The separate `zdeck-registry` repo now has external-key signing/verification tooling, immutable
`releases/<id>/<version>.json` output, whole-catalogue/release checks and an explicit app-ready
contract gate. A decorative signature field no longer enables anything. A published record needs
a verified local envelope matching its source/compatibility facts, and the reviewed website gate
must deliberately match the distributed app's endpoint/public keys. Spotify remains a preview; HA 0.2.0 has a real signed **macOS-only pilot** record and locally
retained archive. Both remain un-installable from the website with `ready:false`. Read-only live
checks on 2026-11-27 confirmed the public page/health and release-path 404 policy, not public
artifact delivery or an OS handler. The registry's operator-authorized existing CLI signed
locally; no key bytes were exposed. See its `docs/home-assistant-candidate.md` for exact hashes.

## Native registration/release gates

Declaration is not proof of OS association. macOS needs an installed `.app` whose Info.plist has
the scheme, Windows an installer/association, Linux an installed desktop entry/MIME handler.
AppImage registration varies by desktop/launcher. No silent association rewrite is attempted.
Install an appropriate packaged build if a browser has no handler; the website cannot repair it.

Physically verify **every platform claimed by the release** before activating its website link:
closed-app handler startup;
running/tray-hidden delivery without a second active process; malformed/duplicate links; cancel
then reopen; simultaneous local picker/drop/review; focus/browser return; native dialogs/drop;
immutable HTTPS content types/TLS/DNS behavior; private-address/redirect refusal; no-replace
publication and packaged-webview local-origin checks. Normal configured bundle targets remain `deb`/`appimage`; an explicit macOS `.app` pilot build
is now checked. No browser/OS association is claimed. Unverified OSes must be excluded from a
pilot's signed compatibility and explicitly rejected. All three OS implementations and native
verification remain project requirements; a pilot does not assert parity.

Automated checks use ephemeral signing keys, injected HTTP clients, synthetic HTTP bodies,
private temporary plugin/config directories and Brave Storybook/fake IPC. The fixture demonstrates
resolver → archive review → disabled/untrusted install/restart, not an actual published release.
No user plugins/settings, credentials, integrations, OS associations or remote deployment are
exercised. The opt-in smoke `.app` was launched only with a distinct identifier/scheme, fresh native data
and plugin roots, no runtime candidates/settings loader and in-memory mock credentials. The
actual bundled WebKit/IPC path reviewed and installed HA disabled/untrusted without execution;
its production-endpoint 404 path also failed closed. It exposed and fixed macOS's slashless
`tauri://localhost` root being rejected by the origin guard; only that exact local root is
normalized. User plugin storage was not accessed. Browser evidence must never be reported as three-OS native parity.

## Historical verification of the resolver milestone

Executed on the macOS development host:

- `cargo test --locked --manifest-path src-tauri/Cargo.toml -p zdeck-plugin-host`: 86 passed,
  one opt-in generated-artifact test ignored in the default run. Includes five signed resolver
  integration tests and two HTTP/DNS-policy unit tests.
- `cargo test --locked --manifest-path src-tauri/Cargo.toml -p zDeck --lib`: 48 passed, including
  current/stale remote tokens, local priority, metadata not authorizing installation and actual
  asynchronous transport abort on cancel.
- `npm test`: 358 passed; `npm run typecheck`, production frontend build, `npm run storybook:build`
  and `npm run tauri:build -- --debug --no-bundle` passed. Native executable built, not launched.
- Focused Brave Storybook tests for `RegistryPluginInstaller`, `PluginArchiveInstaller` and
  `PluginInstallDropdown`: 20 passed. `scripts/zdx-ui-smoke.mjs` passed six registry/seven local
  states at 960/320px, long IDs/URLs, busy cancellation, metadata vs archive authorization,
  existing picker/drop/menu/uncertain-publication fake IPC and disabled/untrusted install checks.
  Screenshots/measured results: `/tmp/zdeck-registry-resolver/`.
- Both local `.zdx` artifacts were repackaged **after** the final native build's frontend build
  cleared `dist`, then each passed its isolated opt-in host installation check without execution.
  Spotify SHA-256: `4483286cdfe8fed0620879b7cca4821cd63932b8579181e79fff067b66980d8a`;
  Home Assistant: `2bc4fde8f462feabbf91b929a9b5213eee63183972f34435b53485de225e979d`.
  These remain local unsigned artifacts, not registry releases.

Storybook retains a large-chunk advisory and Node a `module.register()` deprecation warning.
The 2026-11-27 preparation corrects the desktop manifest's inherited 1.89 mismatch to **1.90**
(required by locked Tauri 2.12.7 family/muda/tray-icon) and pins desktop CI to 1.90.0. Standalone
crates retain their independent declarations. Local checks use Rust 1.100.0; no local 1.90
compiler or Windows/Linux packaging result is claimed. The newly pinned CI has not run until
pushed/authorized; the declared minimum still requires that CI evidence.
