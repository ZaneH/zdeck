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
