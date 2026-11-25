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

## Outstanding evidence

- macOS: compilation and fake-backed automated checks only; no live device,
  media-key delivery, Accessibility, or restart-on-real-hardware verification.
- Windows: native implementation supplied; compilation/runtime need a Windows
  host or a successful CI run. No runtime verification claimed.
- Linux: existing process behavior retained and fake-backed tests run on macOS;
  Linux-only process cancellation tests need Linux CI/host execution.
