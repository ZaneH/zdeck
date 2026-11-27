# Signed registry releases v1 (unreleased)

This checkout ships the public default `https://zreg.zaaane.com/` and reviewed public key
`registry-2026-01` in `src-tauri/registry-public-keys.json`. The registry has a genuine signed HA
0.2.0 **macOS-only pilot**, locally retained and verified, awaiting CT deployment. The website
remains `ready:false`. The operator authorized the registry's existing offline CLI to sign using
an external private-key file; no private bytes were exposed or added to either repository. A configured resolver is not evidence of native release readiness. A signature is
registry-key provenance/integrity, not a safety review, publisher identity, sandbox or execution
permission. Local unsigned imports are unchanged. Updates/replacements are still out of scope.

## Build-owned bootstrap

Normal builds need no registry environment variables. To build for a custom registry, deliberately
set these Rust compile-time overrides (not `VITE_*`):

- `ZDECK_REGISTRY_RELEASE_URL`: an owned public HTTPS base ending in `/`, without credentials,
  query, fragment or a non-443 port. Lookup is exactly
  `<base>releases/<validated-id>/<exact-version>.json`.
- `ZDECK_REGISTRY_PUBLIC_KEYS`: JSON array of 1–8 `{ "id": "key-id", "publicKey": "<standard padded base64 of raw 32-byte Ed25519 public key>" }` records. IDs are unique,
  lowercase letters/digits/hyphens, 1–64 bytes. Unknown fields are rejected.
- `ZDECK_REGISTRY_WEBSITE_URL`: separate, optional external catalogue website (see `zdx.md`).

If neither release URL nor keys override is set, use the independently checked-in defaults.
If either is set, **both must be supplied**; partial/empty/invalid overrides fail closed without
borrowing official trust. Setting both to empty disables the resolver. The separate website
override defaults to the same public site; set it explicitly for a custom catalogue, or empty to
disable the menu item. Cargo rebuilds on all three environment changes and public-key file edits.
There are no runtime URL/key preferences, renderer trust configuration, key discovery endpoint or
private-network debug bypass. Invalid trust configuration produces a visible unavailable notice
only on request, never blocks launch. Existing TLS, public DNS pinning, no-proxy/no-redirect and
signature gates are unchanged. Do not put a private signing key in any of these variables or in a Vite variable.

Distribute reviewed public keys independently in the desktop build, after an out-of-band
maintainer review of key ownership/fingerprint. Never bootstrap trust from the website/lookup
response. For rotation, first ship builds trusting both old and new key IDs, then publish new
releases under the new key. Removing an ID in a new desktop build manually revokes it for that
build; already installed packages/older offline builds are not remotely revoked. There is no
expiry, online revocation, transparency log or automated key rollover in v1. A compromised key
requires a new desktop release and publication response, not a website-only edit. Never overwrite
an `(id,version)` record to change keys or content; publish a new exact version. Removing a website
verification key also fails its whole build while historical records reference that key; maintainers
must explicitly withdraw affected records from future build input/catalogue without overwriting
historically hosted bytes. Older trusted app builds may still accept that history. V1 deliberately
has no separate historical-verification PKI or silent record skipping.

## Exact signed bytes

Envelope (UTF-8 JSON, maximum **32 KiB**, all fields required, no unknown/duplicate fields):

```text
{schema: 1, keyId: string, payload: base64, signature: base64}
```

Algorithm is **Ed25519** only (ring in Rust, Node's standard crypto in tooling). Signature is 64
bytes; payload/signature use standard padded base64. Verify with the independently configured
`keyId`. Signed message is the ASCII bytes `zdeck-release-v1` followed by one NUL byte followed
by the **decoded payload bytes unchanged**. Never parse/reserialize JSON before verification.
The domain and payload schema bind this protocol; there is no algorithm supplied by a server.

Decoded payload (all fields required, nested unknown/duplicate fields rejected):

```text
{
  schema: 1,
  id: lowercase [a-z][a-z0-9-]{0,63},
  version: three 1–4-digit numeric parts,
  artifact: {url: public HTTPS .zdx URL, sha256: 64 lowercase hex, bytes: 1..16777216},
  compatibility: {
    protocol: 1,
    runtime: "node" | "python",
    minimum: "22.18.0" for node | "3.10.0" for python,
    platforms: nonempty unique subset of ["macos", "windows", "linux"]
  },
  source: {repo: public HTTPS source URL, commit: 40 lowercase hex, license: 1..40 characters}
}
```

Only the host's current runtime baselines/protocol are supported, not arbitrary version-range
negotiation. The current OS must be listed. ID/version must equal the exact request; source commit
must be immutable (a branch/tag is not a commit). Source/licence/platform facts are signed
maintainer assertions, not independently proven by the downloader. The installer additionally
compares the actual archive manifest ID/version/protocol and detected static runtime with this
payload. Presentation name/author/summary/tags are optional website fields, not signed identity.

The registry tooling emits compact JSON plus an optional final newline and rejects noncompact
or duplicate-key input. That is an input-format restriction of the tooling, not a JSON
canonicalization algorithm used for signatures. The desktop accepts ordinary strict JSON and
verifies raw bytes. Public-only Node/Rust interop fixtures are checked into both test suites;
no private key or real artifact exists for those fixtures.

## HTTPS and immutable hosting

Metadata: `200`, `Content-Type: application/json` (optional parameters), ≤32 KiB.
Artifact: `200`, `Content-Type: application/zip`, exact signed byte size ≤16 MiB and exact SHA-256.
No redirect (including same-origin), credentials, query, fragment, downgrade, content encoding,
proxy, cookies or browser-provided URL is supported. Configure the final immutable object URLs,
not a GitHub download redirect/CDN redirector. Disable gzip/Brotli for these routes. Never mutate
or overwrite published paths. A deployment must preserve historical release JSON too.

Normal rustls certificate validation/SNI is enabled. DNS is resolved under a 60-second overall
operation deadline; all answers must be public unicast (empty, excessive or mixed private/public
answers fail), and that validated address set is pinned to the request. Conservative special-use
IPv4/IPv6 ranges, local host suffixes and loopback are rejected. No second DNS lookup can rebind a
validated hostname to a private address. Connect deadline is 10 seconds, HTTP request/body is 50
seconds, whole fetch including DNS is 60 seconds. Bodies are capped while streaming, regardless
of missing/lying Content-Length. Failed/invalid metadata never authorizes an artifact request.

## Desktop intent and lifetime

A browser/native link supplies **only ID and exact version**. First show an identity-only prompt;
**Look up release** fetches read-only metadata. Show authenticated source/commit/licence,
compatibility, key ID, URL, size and digest. **Download for review** is a separate explicit action.
Only then do verified snapshot bytes enter the same ZIP validation, private staging and opaque
archive review token used by local picker/drop. **Install disabled** remains a third action.
Neither lookup, download, validation nor install executes plugin code. Runtime detection uses
only the host's existing version probes. Trust and enable are separate fingerprint-bound actions.

The native inbox retains one active review and at most one pending registry identity (first wins),
behind local picker/review/errors; no link replaces existing authorization. Extra waiting identities
are not queued. Deduplication remembers up to 128 identities for the session, including canceled or
ignored identities; retrying the same link after cancel needs an app restart. Invalid links and
capacity notices are bounded. Lookup/download can be canceled: abort the async transport, clear
verified metadata, drop owned staging, and ignore stale completion tokens. A blocking ZIP worker
already running may finish its bounded validation before its discarded temporary result is dropped.
Install publication itself is not cancelable. No retry can replace an installed ID, and no remote
path can name a local file or extraction target. Native commands still require the local main
editor origin and receive only opaque tokens, never release JSON/URLs/paths.

## Local smoke, no user settings or network

Run from this repo:

```sh
cargo test --locked --manifest-path src-tauri/Cargo.toml -p zdeck-plugin-host --test registry_release
cargo test --locked --manifest-path src-tauri/Cargo.toml -p zdeck-plugin-host --lib registry_release
cargo test --locked --manifest-path src-tauri/Cargo.toml -p zDeck --lib plugin_archive
npm test
CHROME_BIN='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' npm run storybook:test -- src/components/RegistryPluginInstaller.stories.tsx src/components/PluginArchiveInstaller.stories.tsx
```

Tests generate fixture-only keys in process memory; registry CLI tests use private temporary key
files and delete them in `finally`. All endpoints are injected clients/synthetic HTTP responses,
not relaxed localhost TLS rules. The signed fixture ZIP has a deliberately throwing `main.js`,
never executed; installation/restart use only a fresh temporary config/plugin directory and empty
runtime candidates. These tests do **not** read user settings, credential stores or integrations.
The registry repo's `docs/releases.md` contains the external-key maintainer path and matching
static build contract. No real signing key generation/access, publication, remote creation,
push or deployment is authorized by these smoke commands.

## Release verification gates

Automated fixture evidence is not proof of real publication, DNS/TLS hosting or OS URL handlers.
Before enabling the website's reviewed `app-contract.json` gate: review real artifacts and keys,
publish immutable JSON/ZIP with the exact content types, distribute a configured desktop build,
and exercise installed handlers on **every platform claimed by each release** (closed/running/hidden), local priority,
lookup/download cancellation, native dialogs/drop, certificate failures and no-replace filesystems.
Do not launch a development binary against live user plugins merely to demonstrate the resolver.
A verified single-platform pilot is allowed; other OSes must be excluded from signed compatibility
and explicitly rejected (before archive download). All three implementations and eventual native
verification remain required; pilot success never implies parity.

## Real signed pilot check (operator opt-in)

On macOS, set `ZDECK_REVIEWED_RELEASE` to the reviewed **public signed envelope** and
`ZDECK_ZDX_ARTIFACT` to its exact archive, then run:

```sh
cargo test --locked --manifest-path src-tauri/Cargo.toml -p zdeck-plugin-host \
  --test registry_release reviewed_production_release -- --ignored --nocapture
```

This uses the independently shipped production public key, verifies source/hash and macOS-only
compatibility, rejects tampering/Windows/Linux, and checks actual ZIP install, restart with no
execution, and collision refusal in a fresh temporary directory. Default transport is injected
local bytes, explicitly **not public-host evidence**. Only after the exact bytes are hosted, set
`ZDECK_PUBLIC_RELEASE=1` to use the real production HTTPS lookup and download with unchanged
DNS/TLS/signature policy. No signing key, user settings, credentials or devices are accessed.
