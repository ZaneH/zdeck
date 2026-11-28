# External theme packages

Status: local desktop import, preview, explicit install, apply/remove, persistent catalog, deck v4
references and authenticated phone delivery are implemented (unreleased). Registry downloads and
one-click installation are not implemented. Manual native verification on all three operating
systems remains a release gate. This document describes the bounded data contract implemented
in `src/lib/themePackage.ts` and `crates/zdeck-schema/src/theme_package.rs`, the host-owned catalog
primitive in `src-tauri/src/theme_store.rs`, and the renderer flow in
`src/lib/customThemes.ts`, `src/components/ThemesSettingsCard.tsx`, `src/lib/theme.ts` and
`src/lib/remotePhone.ts`.

## Contract

A package is one UTF-8 JSON object with schema `1`, at most **16 KiB of exact input bytes**
(including whitespace), and these top-level fields only:

| Field | Required value |
| --- | --- |
| `schema` | integer `1` |
| `kind` | `"zdeck-theme"` |
| `id` | `^[a-z][a-z0-9-]{0,63}$` |
| `version` | three integer components of 1–4 digits, such as `0.1.0` |
| `name` | nonempty trimmed metadata text, at most 80 UTF-8 bytes |
| `author` | nonempty trimmed metadata text, at most 160 UTF-8 bytes |
| `license` | nonempty trimmed metadata text, at most 80 UTF-8 bytes |
| `source` | nonempty trimmed metadata text, at most 512 UTF-8 bytes |
| `appearance` | appearance object below |

Metadata text must not contain control characters, and leading or trailing whitespace is rejected.
`source` is plain metadata. Never fetch or execute it, and never turn it into a rendered link
without a separate, explicit UI decision.

`appearance` accepts only these fields:

| Field | Required value |
| --- | --- |
| `base` | one existing built-in appearance: `dark`, `light`, `glass`, `terminal`, `macintosh` |
| `motif` | `none` or `maze` |
| `colors` | exactly the 15 keys below, each matching `^#[0-9a-f]{6}$` |
| `tileRadius` | integer `0`–`32` |
| `sectionRadius` | integer `0`–`32` |

Required color keys: `bg`, `bgSoft`, `surface`, `surface2`, `surface3`, `border`,
`borderStrong`, `text`, `textMuted`, `textFaint`, `danger`, `warning`, `maze`, `pellet`,
`tileSurface`.

Unknown fields are rejected at every object. Missing fields, `null`, arrays, wrong types, unsafe
integers, non-integer radii, unknown bases or motifs, malformed hex colors and over-limit metadata
are rejected rather than silently dropped. There is no arbitrary CSS, selector, `url()`, remote
asset, HTML, JavaScript or font field. A package also must not contain its own digest.

## Parsing

- TypeScript: `parseThemePackageBytes(bytes: Uint8Array)` returns a validated `ThemePackage` or
  `null`, rejecting BOM, invalid UTF-8, malformed JSON and duplicate keys.
  `validateThemePackage(value: unknown)` validates a parsed value’s fields and values.
- Rust: `parse_theme_package(bytes: &[u8]) -> Option<ThemePackage>` does the same through
  `serde` with `deny_unknown_fields` plus explicit validation.

Both implementations share the same valid sample bytes in
`tests/fixtures/theme-packages/midnight-maze.json`. The sample package
`packages/themes/midnight-maze.zdeck-theme.json` maps the Midnight Maze prototype palette to safe
tokens (for example maze `#3158ff`, pellet `#ffe34b`, tile surface `#101a38`). Authorship and
licence come from this repository (`Zane Helton`, MIT).

## Try Midnight Maze

1. Open the desktop app, then **Settings → General → Installed themes**.
2. Choose **Import theme file…**, then `packages/themes/midnight-maze.zdeck-theme.json` from this repository.
3. Inspect the local preview and choose **Install theme**. Your current appearance stays unchanged.
4. Choose **Use for deck**, or select the installed version in a section’s Appearance menu.
5. To remove it, explicitly replace its deck and section references with built-in appearances first.
   The native host also refuses removal while Trash still references the package.

The example supplies colors, radii and a sparse host-rendered maze motif. Pixel icons remain a
separate prototype asset set, not part of this package or an installed icon pack.

## Custom theme references

A deck or installation record that later refers to a custom appearance needs an exact reference,
validated separately from package bytes:

```json
{ "id": "midnight-maze", "version": "0.1.0", "digest": "<64 lowercase hex sha256>" }
```

`CustomThemeReference` accepts exactly `id`, `version` and `digest`; `id` and `version` follow the
package rules and `digest` is 64 lowercase hexadecimal characters. Deck schema v4 stores these
references on the deck and optionally its sections; v1–v3 documents migrate in memory without an
automatic rewrite. Older apps cannot read v4 decks: update desktop and phone assets together.
A package never supplies its own reference digest.

## Native catalog storage

The host owns `<app-data>/themes.v1.json`. The renderer never supplies this path. The catalog
retains each package's **exact source bytes as a UTF-8 string**, validates them with
`parse_theme_package` on every read and import, and derives the reference digest as SHA-256 of
those exact bytes. Stored metadata each look like `{ "source": "<exact package text>" }`.

Limits:

- one package: 16 KiB exact bytes (the shared package parser's bound);
- at most 16 installed packages;
- the whole catalog file: at most 256 KiB, including JSON keys, escaping and separators. Package
  bytes and catalog overhead share this budget, so 16 maximal 16 KiB packages cannot all fit.
- installing an exact duplicate (same id, version and digest) is idempotent and does not rewrite
  the file; the same id and version with a different digest is a visible conflict; different
  versions of one id may coexist.

Reads are bounded before reading and accept only a regular file; a symlink or directory at the
catalog path is rejected. A missing file is an empty catalog. A corrupt, oversized or invalid
catalog (unknown fields, wrong schema, invalid package, duplicate id+version) fails visibly and
its bytes are preserved; it is never treated as empty or overwritten. Writes are serialized, go to
a same-directory `create_new` temporary file, are flushed and synced, then renamed over the
destination. A failed write leaves the previous catalog intact. Construction performs no I/O, so a
catalog or settings problem cannot prevent launch.

`ThemeStore` exposes asynchronous `list()`, `install(bytes)` and
`remove(reference, in_use_references)`. Errors are typed and serializable. Removal refuses any
reference supplied by the trusted caller, including Trash; it never edits a deck. Native
commands obtain this list from the authoritative saved deck, not renderer claims. Each command
requires the local main editor window; the renderer never supplies a filesystem path.

## Renderer import, preview, install, apply and remove

`ThemesSettingsCard` lists installed packages with id, version, author, licence, source text and
the exact SHA-256 digest. Importing picks one local source file, validates its bounded bytes and
renders a local preview using the real shared `ControlTile`; only the explicit **Install theme**
action calls the native installer. Installation never applies a theme and never arms controls.

Applying is explicit and uses the existing deck history and save path:

- **Use for deck** stores an exact `CustomThemeReference` through `setCustomTheme`.
- The deck Appearance dropdown lists built-ins plus installed packages under their exact
  `id@version#digest` identity. The section menu does the same through `setSectionCustomTheme`.
- Removing an installed theme is disabled with an explanation while the current deck uses it.
  Choosing a built-in appearance explicitly replaces that selection’s package reference, not the
  installed package or references in other sections.
- A missing or different-digest reference keeps its deck/section reference and shows a visible
  recovery choice: import the exact package or explicitly choose a built-in appearance. It never
  substitutes another version or digest, and it never clears a reference silently.
- Catalog load failures stay visible in Settings but do not block launch. Built-ins keep working.

Resolution is shared by the editor, local phone preview and remote phone. A package may map only
the 15 documented hex colors and two integer radii to host tokens; it cannot supply CSS, selectors,
URLs or assets. The package `base` still owns geometry, focus and interaction behavior. The sparse
maze/pellet motif is host-owned SVG generated from validated `maze` and `pellet` colors, drawn at
320px with `.12`/`.25` opacity only on a resolved custom deck/section/phone surface. Switching back
to a built-in appearance removes every inline custom property from the root.

## Phone delivery client

The authenticated `GET /api/v1/state`, reading refreshes and websocket snapshots may include
`externalThemes: Array<{ reference, source }>` and an optional `themeError`. The client:

- accepts at most 16 entries and at most 128 KiB of serialized `externalThemes`;
- re-validates every package source (untrusted even when the authenticated desktop supplied it),
  requires the source id/version to match the exact reference and rejects duplicate identities;
- fails closed on a malformed payload rather than rendering a silently different theme;
- keeps the deck's reference and shows a visible warning when a definition is absent, including
  after reconnect.

## Limitations and next stages

- No registry download, signing, deck export/import or one-click install is added here.
- Oversized appearance delivery drops optional definitions with a visible warning rather than
  disconnecting an otherwise valid phone snapshot. Saved references remain unchanged.
- Native removal checks the saved deck before catalog removal; a concurrent deck edit can introduce
  a missing reference afterward. Recovery preserves that reference and asks for the exact package.
- Built-in appearances remain the only values in the `Theme` enum. Custom identity stays in
  `CustomThemeReference`; control tiles receive only the validated built-in base for geometry.
- Authenticated release/catalog identity is future work. A SHA-256 digest proves byte identity,
  not authorship. Do not treat a parsed or installed package as trusted provenance.
- Contrast, forced colors and reduced motion use the fixed base palette and host tokens; a package
  cannot add motion or unrestricted styling. Native three-platform parity is not claimed by these
  browser/unit checks.

## Registry previews

`Themes / External theme preview` renders the validated Midnight Maze package on the same
`zdeck-sample-deck-1` controls as the built-in themes. Inherited sections keep the app’s opaque
panel treatment; only the outer background carries the package motif. Pixel icons are not injected.

With `npm run storybook` running, capture the registry’s genuine fixed-size PNGs:

```bash
CHROME_BIN="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
  node scripts/external-theme-preview.mjs --url http://127.0.0.1:6006 --out /tmp
```

The desktop capture fits the shared fixture at 1200×800 using the built-in exporter’s framing;
the phone renders naturally at 390×844. No image post-resize is applied. Recapture when the exact
package or host rendering changes; screenshots are browser evidence, not native verification.

Checks used for this foundation:

```bash
npm test -- tests/themePackage.test.ts
npm run typecheck
cargo test --locked --manifest-path src-tauri/Cargo.toml -p zdeck-schema
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib theme_store
```
