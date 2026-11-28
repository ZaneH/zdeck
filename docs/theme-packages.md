# Theme package format (foundation)

Status: format parser plus a native catalog storage foundation. Theme packages are **not
installable through the app** yet: no picker, IPC command, preview, apply/remove flow or phone
delivery exists, and the catalog is not opened at launch. This document describes the bounded data
contract implemented in `src/lib/themePackage.ts` and
`crates/zdeck-schema/src/theme_package.rs`, and the host-owned catalog primitive in
`src-tauri/src/theme_store.rs`.

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
  `null`. `validateThemePackage(value: unknown)` validates a parsed value. Both reject BOM, invalid
  UTF-8, malformed JSON, unknown fields and invalid values.
- Rust: `parse_theme_package(bytes: &[u8]) -> Option<ThemePackage>` does the same through
  `serde` with `deny_unknown_fields` plus explicit validation.

Both implementations share the same valid sample bytes in
`tests/fixtures/theme-packages/midnight-maze.json`. The sample package
`packages/themes/midnight-maze.zdeck-theme.json` maps the Midnight Maze prototype palette to safe
tokens (for example maze `#3158ff`, pellet `#ffe34b`, tile surface `#101a38`). Authorship and
licence come from this repository (`Zane Helton`, MIT). The sample is format evidence only.

## Custom theme references

A deck or installation record that later refers to a custom appearance needs an exact reference,
validated separately from package bytes:

```json
{ "id": "midnight-maze", "version": "0.1.0", "digest": "<64 lowercase hex sha256>" }
```

`CustomThemeReference` accepts exactly `id`, `version` and `digest`; `id` and `version` follow the
package rules and `digest` is 64 lowercase hexadecimal characters. The reference is defined here,
but deck integration does not exist yet. A package never supplies its own reference digest.

## Native catalog storage (foundation)

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
reference supplied by the trusted caller, including Trash; it never edits a deck. Wiring into
launch, IPC, deck validation or migration is a later stage.

## Limitations and next stages

- No in-app installation, file picker, registry download, signature verification, preview,
  apply/remove flow, migration, export or phone delivery. The native catalog primitive is not yet
  wired to launch, IPC or the deck UI.
- Built-in appearances remain the only selectable themes. Existing deck validation still rejects
  unknown theme values; adding custom IDs requires a deliberate schema migration.
- Authenticated release/catalog identity is future work. A SHA-256 digest proves byte identity,
  not authorship. Do not treat a parsed or installed package as trusted provenance.
- Accessibility, contrast, layout presets and cross-platform behavior still need review before a
  package can be offered to users.
- Future work must keep installation atomic, preserve the current appearance on failure, and make
  unavailable references recoverable rather than silently replaced.

Checks used for this foundation:

```bash
npm test -- tests/themePackage.test.ts
npm run typecheck
cargo test --locked --manifest-path src-tauri/Cargo.toml -p zdeck-schema
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib theme_store
```
