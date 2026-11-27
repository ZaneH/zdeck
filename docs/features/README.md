# Feature behavior trees

These trees describe intended behavior, not a claim that every feature is implemented.

## Desktop tray and menu bar

Status: native implementation added; macOS arm64 build and automated policy/service/UI tests pass. OS runtime verification on Windows, macOS, and Linux is still required; this is not yet verified on all supported platforms. See [verification details](../system-controls-verification.md#desktop-tray-and-menu-bar).

```text
Keep zDeck available in the background                 // desktop.tray
├── Close the application window                       // desktop.close-to-tray
│   ├── Native preference in Settings > General; OFF by default (opt-in)
│   ├── OFF -> gracefully quit the entire app, disconnecting phones, OBS and plugins
│   ├── ON -> hide the window, retaining the current local service and phone connections
│   │   ├── macOS -> hide the Dock icon; keep the menu-bar icon
│   │   └── Windows / Linux -> keep the tray icon; hide the window's taskbar entry
│   ├── Use the persisted native preference, not a browser draft
│   └── Missing preference -> OFF; load errors never block launch; save errors never claim success
├── Open zDeck again                                   // desktop.tray.restore
│   ├── Windows / Linux -> double-click the tray icon, where supported
│   ├── Every platform -> choose Open zDeck from the icon's menu
│   └── Show and focus the existing window; restore the macOS Dock icon
├── Tray / menu-bar menu                               // desktop.tray.menu
│   ├── Open zDeck
│   ├── ── divider ──
│   ├── Start local service / Stop local service
│   │   ├── Show the action matching the actual service state
│   │   ├── Use the same saved connection settings and safeguards as Settings
│   │   └── Prevent duplicate requests while changing state; surface failures without claiming success
│   ├── ── divider ──
│   ├── Settings -> restore the window and open Phone connection (also the service-error destination)
│   ├── ── divider ──
│   └── Quit zDeck -> stop the local service and exit, regardless of the close preference
└── Platform conventions and availability              // desktop.tray.platforms
    ├── Windows / Linux -> right-click opens the menu
    ├── macOS -> menu-bar click opens the same grouped options using native conventions
    └── Close-to-tray ON but no usable tray / menu-bar host -> do not hide the only way back to the app;
        keep the window accessible and explain the limitation
        (Linux requires a confirmed StatusNotifier host; unrecognized/legacy hosts keep the window visible)
```

## Pages and sections

Status: implemented with automated migration, persistence, editor and phone-navigation coverage. Phone navigation is swipe-first with focus-revealed accessible alternatives, routine Connected text is hidden, and deck-accent inheritance is fixed on the remote phone and theme-only sections. Appearance offers Dark (default), Light and the opt-in Glass theme; Glass uses individual translucent controls on a bright lavender wallpaper and the existing deck/section `theme` field, so older clients that predate it reject the document and fail closed rather than silently rendering a different theme. Version 3 migrates existing pages into one section without changing their controls. Physical-phone gesture verification and native runtime verification on Windows, macOS and Linux remain open; browser checks do not establish native parity.

```text
Organize controls into pages and sections              // deck.sections
├── Hierarchy: deck -> ordered pages -> ordered sections -> controls
├── Edit sections within a page                        // deck.sections.edit
│   ├── Add, name and rename sections
│   ├── Insert a section between existing sections
│   ├── Reorder sections without changing their controls or appearance
│   ├── Delete sections; confirm before deleting a populated section
│   └── Keep at least one section per page; no arbitrary section-count limit
├── Navigate on the companion phone                    // deck.sections.phone
│   ├── Swipe left / right between pages
│   ├── One deliberate upward / downward swipe settles on the next / previous section
│   ├── No persistent footer tabs or page / section counters; controls remain the focus
│   ├── Keep keyboard / screen-reader navigation available without a permanently visible navigation bar
│   ├── Hide routine Connected text; keep disconnection, errors and recovery actions visible
│   ├── Each section fills the available control viewport when its controls fit
│   ├── Taller sections scroll internally; advance only at their scroll boundary
│   ├── Sliders and other interactive controls retain their own gestures
│   └── Provide accessible navigation alternatives; gestures are not the only way to navigate
├── Navigate on desktop                                // deck.sections.desktop
│   ├── Scroll vertically through the active page's stacked sections
│   ├── Left / right arrow keys switch pages without wrapping at the ends
│   └── Do not intercept keys while typing, editing, or using controls that own those keys
├── Configure appearance                               // deck.sections.appearance
│   ├── Sections immediately inherit the saved deck theme (Dark, Light or Glass) and accent on desktop and phone, including new sections
│   ├── Allow independent optional Dark, Light or Glass theme and accent overrides per section
│   ├── Let each theme own its presentation through the stable control slots (shape, size, label visibility, icon position); hidden visual labels keep an accessible name and Dark/Light stay unchanged
│   └── Reset an override to resume inheritance; inherited values follow deck changes
└── Preserve configuration                             // deck.sections.persistence
    ├── Migrate each existing page to one section containing its original controls
    ├── Preserve page and control identities, ordering, actions and appearance
    ├── Persist section order, names and appearance when applied, not only on quit
    ├── Keep sections intact through restart and companion synchronization
    ├── Future export / import must preserve sections; export / import itself is not part of this feature
    └── Validate section data at import and synchronization boundaries; report failures visibly
```

## Settings navigation

```text
Settings                                              // settings.navigation
├── General -> native closing preference, appearance, storage, preview/help, setup and web app
├── Phone connection -> local service, addresses, pairing and approved phones
├── Integrations -> OBS and external plugins
├── Named section links work with keyboard and narrow screens; active section is indicated
├── Switching sections retains mounted cards, drafts and background polling; it never stops the service
├── Direct section URLs work; tray Settings and service-error links open Phone connection
└── Browser mode omits the native-only closing preference
```

## Control press feedback

Status: implemented in the shared control tile; physical-phone verification pending.

```text
Press a control on the phone                           // controls.press-feedback
├── Keep its configured icon and label visible throughout the action
├── Do not replace the icon with a temporary "Running…" label
├── Keep accessible busy information and existing duplicate-tap safeguards
└── Preserve actionable errors and uncertain-delivery / retry safeguards
```

## Plugin registry link install

Status: implemented; macOS OS-handler branches marked below were exercised on a locally built
`.app` on 2026-11-27. Windows/Linux handler branches, native picker/drop overlap and website
`ready` activation are still unverified. See [registry handoff](../registry-handoff.md).

```text
Open zdeck://plugins/install?id=<id>&version=<x.y.z>   // plugins.registry.link
├── OS routing
│   ├── Closed app -> LaunchServices starts the app; the link arrives after load           (verified macOS)
│   ├── Running app -> same process handles it; no second instance or second window        (verified macOS)
│   ├── Hidden / tray-hidden app -> window is restored and focused with the prompt         (verified macOS)
│   ├── No registered handler -> browser reports no application; the website cannot repair it
│   └── Same build already running outside LaunchServices (dev binary) ->
│       single-instance forwards arguments only, so the URL is dropped (development only)
├── Link validation (before any UI)
│   ├── Valid id + exact three-part version -> identity-only prompt, no network yet
│   ├── Malformed id/version, unknown route, extra or duplicate or encoded field names,
│   │   path/credentials/port/fragment, oversized input -> rejected; native code emits one
│   │   invalid-request notice per session (native UI notice delivery not verified)
│   ├── Identity already active or queued -> window raised, no second prompt
│   └── Cancel or completed install forgets the identity -> the same link prompts again
├── Identity prompt                                       // plugins.registry.identity
│   ├── Shows only plugin ID and version; states no archive has been downloaded; it stays
│   │   unchanged over 12s of passive macOS observation; an earlier automation-associated
│   │   advance without an intentional click remains unexplained
│   ├── Look up release -> network lookup; Cancel -> prompt closes and the identity can prompt again
│   └── A second link while a prompt/review is open -> first identity wins; the extra gets one
│       focused notice and can be reopened after the current review finishes
├── Look up release                                       // plugins.registry.lookup
│   ├── 200 authenticated metadata -> show key ID, source/commit/licence, compatibility,
│   │   archive URL, size and digest; Download for review is the next action    (verified macOS)
│   ├── OS not in the signed compatibility list -> refuse before any archive request
│   ├── 404 / 5xx / redirect / TLS / DNS / shape failure -> visible error, retry allowed,
│   │   no archive authorized                                                            (404 verified macOS)
│   └── Cancel while looking up -> aborts, clears verified metadata
├── Download for review                                   // plugins.registry.download
│   ├── Size + SHA-256 match the signed record -> ZIP validation, static runtime cross-check,
│   │   then the archive review panel with an opaque review token                        (verified macOS)
│   ├── Digest/size mismatch, archive manifest id/version/protocol/runtime mismatch,
│   │   unsupported archive -> error, no review token
│   └── Cancel while downloading -> staging dropped, no review
├── Archive review                                        // plugins.registry.review
│   ├── Facts: protocol, detected runtime, signed-vs-local source, file count/size,
│   │   "not a sandbox" warning, install-means-disabled-and-untrusted statement
│   ├── Plugin ID already installed -> install stays disabled with a "already installed,
│   │   uninstall the existing package first, nothing will be replaced" message             (verified macOS)
│   ├── Plugin ID free (for example after uninstalling an older local copy through the
│   │   reversible in-app uninstall) -> Install disabled performs one atomic no-replace
│   │   publication; the package stays untrusted and unenabled, and no plugin code runs,
│   │   including after a normal restart                                            (verified macOS)
│   └── Cancel -> staged bytes dropped, installed set unchanged
└── After install / not covered here
    ├── Trust and Enable stay separate fingerprint-bound actions; nothing is auto-enabled
    ├── No updates, replacements, retries of a failed install, or remote revocation in v1
    └── Local .zdx picker, drag-drop and review keep priority over a link
```
