# Theme directory and installation proposal

Status: directory/source-preview foundation implemented; local desktop theme-package import, preview, explicit install, apply/remove, persistent storage and authenticated phone delivery are implemented (unreleased). Registry downloads and authenticated one-click installation remain proposals. The registry has separate Plugins/Themes categories, built-in Glass and Wasteland Terminal entries, local standard-fixture screenshots and a theme source-preview submission tool. The app provides the shared Storybook fixture and screenshot exporter; see [theme development](theme-development.md). Glass and Wasteland Terminal remain built-in appearances, not downloadable plugins.

## Recommendation

Keep the five default appearances built in. External themes now have a bounded local import path; verify native behavior on all three operating systems before enabling registry downloads. The existing static registry now has a separate Themes category with its Git-backed review workflow, not accounts or a publishing service. Community submissions document source and standard previews; they are not installable packages.

The registry at `../zdeck-registry` accepts executable plugin packages (`.zdx`), plugin records and signed plugin-install requests, separately from theme source-preview records. Do not disguise a theme as a plugin or enable an install link before the desktop can validate and install its actual format. No theme downloads, signing or publication are added by this proposal.

## Browse → preview → install → apply

- **Browse:** Plugins and Themes are separate categories using the established directory layout. Show name, author, short description and a representative preview. Built-in appearances say **Included in zDeck**, not **Download**.
- **Detail:** show the same sample deck for every theme, with buttons, a slider, a dial, both toggles and a numeric reading. Include desktop and phone views, long labels, active/inactive/unknown/error states, and a mixed-theme section. Do not run downloaded code or load submitted CSS into the registry page to generate a preview. Curated local images have text alternatives and no trackers.
- **Compatibility:** list minimum app/format version, package version, licence, source and verified release digest. Distinguish screenshots from actual accessibility, performance and platform evidence; do not assert three-platform support from a browser test.
- **Install:** a future **Install in zDeck** action opens an untrusted request. The desktop fetches and verifies a bounded, immutable package against an authenticated release record, then shows identity, source, version and a preview for confirmation. Downloading or following a link does not apply a theme. An explicit file-import fallback goes through the same validation, without implying registry provenance for an unsigned local file.
- **Apply:** after installation, offer **Use for deck** or **Keep current appearance**. Section overrides remain unchanged. Per-section selection stays in the established section menu, with inheritance explicit. Preview must be local, reversible and non-executing; applying uses existing save-on-change behavior and disarms live controls as any deck edit does.
- **Feedback:** use the control's busy state for quick operations, not flashing success messages. Keep download, validation and persistence errors visible with a retry or next action. Failed installation leaves both the current appearance and installed version intact.

## Author → review → publish

1. Author a data-only theme using the documented format and a local preview of the standard sample deck. Require only identity/version, author, licence, source and the actual appearance definition; derive size and digest from package bytes.
2. Validate locally: bounded file sizes, portable IDs, supported format, complete required tokens, permitted layout choices and values, no executable content or external resources. Reject unsafe input instead of silently dropping fields. Produce preview evidence against the same fixture used in the directory.
3. Submit a PR targeting registry `dev`, following the existing one-record/README pattern in `zdeck-registry/docs/submissions.md`, but with a separate theme validator and record type. Do not reuse the `.zdx` plugin archive assumptions.
4. Review licence, preview accuracy, contrast, keyboard/touch behavior, disabled/unknown/error states, reduced motion, forced colors, narrow screens and large decks. Check actual packaged bytes and platform evidence before making compatibility claims.
5. Maintainers deliberately approve an immutable authenticated release using a theme-specific payload. Do not reuse plugin signatures with a different interpretation. Signing, hosting and enabling one-click installation remain explicit release steps, never side effects of a community PR.

No new backend, ratings, account system, automatic publication or third-party code execution is needed.

## Themes, controls and plugin widgets

Theme authors style zDeck's existing controls; they do not reimplement sliders, dials, switches, buttons or their input behavior. zDeck owns accessibility, touch/keyboard handling, state delivery and safety gating. The standard Storybook fixture should render those real shared components, not a parallel implementation for screenshots.

Plugins own integration behavior and may eventually expose widgets as well as actions and readings. For example, a Twitch plugin could supply bounded chat messages and a chat widget; that is functionality, not a theme. A widget would use host-provided panel, scrolling list, text, badge, button and input components so its content adopts the active deck/section theme. The host owns widget lifecycle, responsive layout, accessible interactions and delivery to the phone. Credentials and service connections stay on the desktop; the phone receives only the authorized data it needs.

This is a proposed widget extension point, not an implemented plugin UI API. Start with host-rendered compositions of shared components rather than arbitrary plugin HTML/JavaScript in the phone. A genuinely custom renderer would require a separate isolation, resource-budget and versioning design. Theme packages must not introduce functionality, service connections or widget code. Widgets belong to their plugin's registry entry; themes remain a separate category.

## Package boundary: decide before building

A token-only format is safer but cannot express every theme's presentation. Glass already changes geometry, label placement and slider orientation; a whitelist of colors alone is not a faithful package for it.

Start with bounded data: whitelisted color/material tokens plus host-implemented presentation presets (for example classic tiles, Glass, and terminal instruments). The app owns accessible DOM, hit areas, state styling and rendering logic. Treat a new presentation preset as an app feature requiring tests, not a script shipped inside a theme. A data-only package must reject raw CSS, HTML, JavaScript, arbitrary selectors, `url()`, imports and remote assets. Restrict expensive effects rather than accepting arbitrary CSS values. Exact fields and limits need a versioned parser and adversarial tests before publication.

This deliberately limits independent creators to supported presentation presets. If that is insufficient, revisit a declarative layout contract with validation; do not quietly expand to unrestricted stylesheets. A signature proves provenance, not accessibility or safety.

## Persistence, phone delivery and recovery

- Persist explicit installation and application immediately, with atomic replacement and visible save failures. Installation does not arm controls or remember transient action state.
- Custom package IDs require an explicit deck/schema migration, not simply relaxing the current closed theme enum. Built-in themes remain readable without a package. Older clients currently reject unknown theme values; explain minimum-version requirements before sharing.
- A deck must identify the exact custom appearance version/digest. Define whether exports embed the bounded appearance data or require a separate package; do not resolve an arbitrary remote URL from deck data.
- The paired phone needs the same validated appearance definition through the authenticated deck/snapshot path. It must not fetch registry content independently or silently render a different theme. Include offline and reconnect tests.
- Opening a deck with an unavailable custom appearance must preserve its reference and show a visible recovery choice: locate the exact package or explicitly replace it with a built-in appearance. No silent permanent fallback.
- Update installation and applying an update are distinct. Keep the working version until replacement is validated and saved. Uninstalling a referenced theme offers cancellation or an explicit replacement for the affected local decks/sections; do not erase appearance references in unknown files.

## Implementation gates

1. **Implemented foundation:** built-in Wasteland Terminal; restart/schema/remote coverage; shared all-control Storybook fixture and local screenshot exporter; separate registry Themes browsing/detail, whole-catalogue validation, and source-preview PR tooling. No theme download claim.
2. **Package foundation:** versioned data parser and limits, immutable identity, local import/preview/explicit install/apply/remove, deck v4 references, atomic native catalog storage and authenticated phone delivery are implemented. The native picker/IPC module is landing separately; registry download, signing, export and one-click install remain proposals. Tests cover malformed/untrusted files, unavailable versions and exact-digest recovery.
3. **Package directory extension:** build on the implemented source-preview records, local curated previews and author tooling/docs with authenticated, verified exact-byte package downloads. Whole-catalogue validation remains mandatory.
4. **Desktop handoff:** authenticated theme release records, explicit install confirmation and cross-platform native verification before enabling one-click install.

Open product choice: how much control over the visual arrangement of existing slots should theme authors have beyond supported presets? This is presentation customization, not a requirement to recreate controls or add functionality. Resolve that before committing to a package format. Neither themes nor future plugin widgets should compromise remote-phone parity.
