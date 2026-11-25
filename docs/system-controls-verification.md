# Built-in system controls: verification

## Automated, non-disruptive checks

From the repository root with the project's dependencies already available:

```sh
npm run typecheck
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --locked
# macOS only: fake CoreAudio devices, no live audio/media actions
bash scripts/test-system-macos.sh
```

The native helper is compiled into the app, not installed or launched as an
external executable. Building macOS requires Xcode Command Line Tools;
Windows uses the MSVC C++ toolchain and Windows SDK. `cc` is the only added build
dependency (already present in the dependency graph). Linux's process backend,
WirePlumber/playerctl selection, command timeout, volume limits, and boost
reporting are unchanged.

CI builds/tests on all three platforms. Its audio/media tests are fake-backed;
a green compile does **not** establish device, permission, or player behavior.
No real microphone/volume/playback mutation was performed during development.

## Contextual media permission setup

Selecting a native media control checks the explicit `{ platform, status }`
permission API. On macOS, missing Accessibility trust shows an inline **Open
System Settings** button. Only that local button calls
`AXIsProcessTrustedWithOptions(kAXTrustedCheckOptionPrompt)` and opens the fixed
Accessibility Settings deep link through NSWorkspace. The OS user must enable
zDeck; the app cannot grant itself permission. If the link fails, open System
Settings → Privacy & Security → Accessibility and add/enable zDeck manually.

Selection, **Check permission**, and window focus only observe trust; no startup,
render, or background polling prompts. Returning from Settings refreshes the
notice, which disappears when granted. No play/pause is automatically replayed.
Changing selection/unmounting invalidates pending replies and removes the focus
listener. Windows/Linux report `not_required` for this permission (not a promise
that media delivery will succeed); unsupported platforms report `unsupported`.
Browser preview stays simulated and never calls the native setup API.

Setup is not a saved control action and is not exposed by phone routing. Its
Tauri request also checks the local main-editor window/origin and dispatches
AppKit work on the main thread. No caller supplies a URL or native operation.
Automated tests intercept permission prompts, Settings launch, and media events;
they must never display real permission dialogs or mutate playback/input state.

## Manual checks — only with the user's permission

These checks change live microphone, volume, or playback state. Do not run while
recording, on a call, or without explicit permission. First record the default
input/output devices, their original levels (all channels where applicable),
mute state, and the active player's playback state. Restore every changed state
immediately after each check, including failures. A second person/device can
help verify actual silencing rather than just a reported slider position.

For **each macOS, Windows, and Linux host**:

1. Read input/output state in the Inspector. Compare with OS sound settings.
   Refresh must not change volume, mute, or playback. Changing devices should
   switch subsequent reads/actions to the new default, not the old device.
2. Mute/unmute the default input in the Inspector; verify both OS readback and
   real captured sound. Repeat from a saved native Live tile and an approved
   phone to verify the shared dispatcher. Restore the original state.
3. On macOS, test both a native-mute device and one with only writable scalar
   input levels. For the latter, record unequal channel levels, mute, quit and
   reopen zDeck, unmute, and verify the exact original levels return. Verify
   repeated mute does not overwrite the restore record with zeros. Never delete
   `app.zdeck.system-controls` preferences while relying on a restore record.
   Switch the default input while muted: the previous device stays muted until
   you select it again and explicitly unmute it to restore its saved levels.
   Devices with no writable mute or level controls should fail without changes.
   A zero scalar level is not a hardware privacy guarantee; test actual capture.
4. Set output to a safe, nearby level, check fresh readback, and restore its
   original level/mute. Test 0 and 100 only if safe and specifically authorized.
   Invalid/out-of-range targets must be rejected before accessing OS controls.
5. With a media-key-compatible player, press built-in play/pause once; inspect
   actual playback and restore it with one deliberate press if appropriate.
   On macOS/Windows a fully sent key reports **unknown** with `media_key_sent`,
   even if playback changed. It should show no warning and remain ready for the
   next intentional press. Genuine timeouts/partial delivery must still warn.
   Test paused/playing, multiple players, no player, and a locked/elevated
   desktop as applicable. Never automatically repeat an unknown action.
6. macOS: deny Accessibility permission; selecting media properties must show
   the inline setup notice without prompting. A media request (including from a
   phone) should fail with guidance, not launch Settings or claim confirmation.
   Click **Open System Settings** locally and verify the prompt and Accessibility
   deep link. Enable zDeck, return to the editor, and verify the notice hides;
   play/pause must not run until deliberately pressed again. **Check permission**
   must only refresh status. Switch selections while checks are pending and verify
   no stale notice/error appears. Repeat step 5 after granting permission.
   A packaged app may have different permission identity from a development
   binary; test the packaged app too. No AppleEvents or microphone-capture
   permission should be required merely to access device control properties.
7. Linux: test a PipeWire/WirePlumber session and MPRIS player (including KDE
   Wayland), missing tools, no default device, and multiple players. Selection
   remains playerctl's default; it is not a Spotify binding.

Native OS calls cannot be forcibly cancelled safely. After a deadline the app
reports unknown and keeps its gate until the worker exits. Concurrent requests
wait within their own deadline and fail without sending if the gate stays busy. Check real state before retrying; restart does not mean an action was
not applied. A native call that never returns blocks subsequent native system
controls until app restart. Ordinary permission/device failures never prevent
app launch or other independent control families from working.

## Desktop tray and menu bar

Implementation uses Tauri's existing native tray/menu feature, not a new plugin.
Open restores/focuses the existing window; tray Settings and service errors navigate
to `#/settings/phone`. Settings has General, Phone connection and Integrations
sections with keyboard-accessible links and active-section indication. Section
changes keep cards mounted, retaining drafts and polling without stopping services.

**Close-to-tray is opt-in, OFF by default**, under General in the desktop app only.
The native close handler reads `desktop-preferences.json` in app-data, never a
browser draft. Missing preferences mean OFF. Load errors are reported without
blocking launch and fall back to OFF; failed saves report an error and do not
optimistically change the checkbox. OFF closes via the same graceful shutdown
as Quit, disconnecting phones/OBS/plugins. Explicit Quit exits regardless of the
preference. ON hides the window without changing the service; macOS also hides the
Dock icon and restores it on Open/Settings/reopen. Windows supports native left
double-click; Linux tray-icon click events are not provided by Tauri, so use its
native menu's **Open zDeck** action. Right-click menus follow Windows/Linux
conventions; macOS also opens the menu on left click.

The grouped menu is also available under **zDeck** in the application/window
menu, including explicit Quit. With close-to-tray ON, tray creation failure leaves
the window accessible. With it OFF, closing still quits. Linux checks `org.kde.StatusNotifierWatcher`'s
`IsStatusNotifierHostRegistered` before hiding: an absent/unrecognized/legacy
host conservatively keeps the window visible, with a short notice and Quit
fallback. A successful tray object alone is not proof of a Linux panel host.
Panel crashes/removal after hiding cannot be guaranteed recoverable; verify the
host is working before relying on unattended background operation.

Tray Start uses the last successfully saved **native** origin/mode, not an
unsaved browser draft. Missing settings open Settings with an actionable error;
no default origin or silent retry is used. Menu and Settings mutations share a
native gate and authoritative RemoteAdmin state; a stale menu action cannot
accidentally toggle the service back. Failures restore Settings and remain
visible in the desktop notice. Stop retains existing persistence-error handling.
Quit waits for an in-flight service operation, closes phone connections,
disconnects OBS/plugins, then exits. Unlike explicit Stop, Quit preserves the
saved auto-start preference.

### Evidence from the close-preference / grouped Settings implementation

On macOS arm64 using installed Cargo/Rust (`~/.cargo/bin` on PATH; Nix unavailable):

- `cargo test --locked --manifest-path src-tauri/Cargo.toml`: 157 passed,
  one existing opt-in real-service browser smoke ignored. Includes opt-in default,
  persisted ON/OFF, failed-save retention, malformed preference errors, tray-host
  hide/fallback policy, duplicate/shutdown gate and existing service lifecycle tests.
- `cargo build --locked --manifest-path src-tauri/Cargo.toml`: passed.
- Focused `npm test -- tests/desktopPreferences.test.ts tests/desktopTrayNotice.test.ts`:
  9 passed (native read/save failures, no optimistic success, browser isolation and notices).
- `npm run typecheck` and `npm run build`: passed.
- `CHROME_BIN='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' npm run smoke`:
  **364/364 passed**, including keyboard section navigation, active indication,
  browser omission, mounted phone-card/draft retention, native preference save/failure,
  and 320px General layout. Screenshots inspected at
  `/tmp/zdeck-settings-general-desktop.png` and `/tmp/zdeck-settings-general-narrow.png`.
  Smoke uses owned fake native preference/service stores, not real tray operations.
  Service persistence assertions now reflect native ownership rather than the
  removed browser desired-state store.
- Final `npm test`: **223 passed, 1 failed** in concurrent, unrelated presentation
  work: `tests/remotePhone.test.ts:138` accesses an absent `harness.sockets[0]`.
  An earlier full run had a then-concurrent `tests/presentations.test.ts` failure.
  Neither area was modified for this task; full-suite green is not claimed.
- `git diff --check`: passed.
- Initial plain `npm run smoke` could not find `google-chrome`; the installed Brave
  binary was selected via `CHROME_BIN` instead. No dependencies were installed.
- No Windows/Linux compilation or native tray interaction is claimed by these checks.

No interactive tray/Dock/taskbar checks were performed. Windows and Linux were
not built or run here; Linux-specific D-Bus code still needs compilation on a
Linux host. Compilation and fake-backed tests do not establish OS behavior.

### Required runtime checks on each OS

1. Start without a desktop preference file: General must show OFF. Closing must
   quit the process and disconnect phones. Enable, relaunch and confirm ON persists;
   disable, relaunch and confirm OFF persists. Test malformed/unreadable preference
   files: launch must still work and closing must quit. Test unwritable app-data:
   save errors must remain visible and must not claim success.
2. With close-to-tray ON and the service stopped, close the window, confirm native icon/menu access,
   restore using Open and Settings, and confirm no duplicate window. On macOS
   verify Dock disappearance/restoration and application Quit/reopen behavior;
   on Windows/Linux verify the hidden taskbar entry. Check left double-click
   on Windows; on Linux verify Open from the menu instead.
3. With close-to-tray ON, start from Settings with saved origin/mode. Close while an
   approved phone is connected: verify the same service/socket keeps working.
   Stop/start from the tray and confirm Settings/menu converge to actual state.
4. Rapidly press service controls in Settings and the tray. Verify no repeated
   start/stop or stale-toggle reversal. Test occupied port, missing settings,
   and unwritable app-data: no false success, no automatic retry, useful error.
5. With both preference values, Quit while running and while a service mutation is pending. Confirm process,
   listener and phone sockets close, then verify saved auto-start on relaunch.
   Explicit Stop must still disable auto-start.
6. With close-to-tray ON on Linux: check KDE and a GNOME/AppIndicator host, no watcher/host, and host loss
   before Close. Without a confirmed host, Close must keep the window visible
   and show the limitation; application-menu/UI Quit must remain available.
   Check Linux tray packaging/runtime dependencies in the actual distribution.
7. In Settings on each OS, use keyboard section links, direct section URLs, and
   narrow windows. Edit a phone URL or integration form, switch away and back:
   retain the draft, keep polling and service alive. Tray service failures must
   restore Phone connection, not leave the error hidden in another section.

## Outstanding evidence

- macOS: compilation and fake-backed automated checks only; no live device,
  media-key delivery, Accessibility, or restart-on-real-hardware verification.
- Windows: native implementation supplied; compilation/runtime need a Windows
  host or a successful CI run. No runtime verification claimed.
- Linux: existing process behavior retained and fake-backed tests run on macOS;
  Linux-only process cancellation tests need Linux CI/host execution.
