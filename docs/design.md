# Design review: build it, then try it

**Status:** the user likes the rehearsal-based onboarding, side Inspector, and phone preview. This refinement pass implements their follow-up feedback; final visual acceptance is still open. The project is now **zDeck**, with an original key-shaped z mark rather than a navbar wordmark.

## References and direction

The user requested a combination of [Touch Portal](https://www.touch-portal.com/) and [Hex](https://github.com/anomalyco/hex): direct button editing, compact pages, tactile controls, and focused, enjoyable onboarding.

We inspected Touch Portal’s official [main-window guide](https://www.touch-portal.com/blog/post/tutorials/understanding_section_pages.php), [button editor](https://www.touch-portal.com/blog/post/tutorials/button-edit-window-explanation.php), and [first-run guide](https://www.touch-portal.com/blog/post/tutorials/onboarding-touch-portal_v3.php), including their screenshots. For Hex we inspected its [design rules](https://github.com/anomalyco/hex/blob/e5f6dac8f9c92876bf449be0b50b24c1878f952b/docs/design-system.md), committed onboarding screenshots, and the actual onboarding state/transition and key-material code at that revision. No reference code, branding, or assets are included in zDeck.

- One compact toolbar: page switcher, page management, Add control, Preview, Settings.
- A recessed deck surface with shallow key edges, soft face shading, and a short downward press. No category-color decoration, numbered slots, decorative status lights, or slash-separated status labels.
- Selected-control settings beside the deck on desktop; stacked beneath it at widths of 800px and below. Reordering stays in the Inspector, not on every key.
- Native action/page dialogs retain background inertness, Escape, and focus return, and now dismiss on backdrop clicks. A shared pointer-start/outside-rectangle check preserves inside padding clicks and inside-to-outside drags. The action picker focuses search on every opening.
- Actions are grouped under OBS, System, and Media headings. Compact category filters combine with search and reset on close. No oversized table of contents is needed for the current four actions.
- The Settings icon toggles back to the editor when clicked again. Remove has a visible danger-tinted surface/border at rest. Closed “About this preview” no longer reserves a flex gap below its summary.
- Default desktop window reduced from 1280×820 to **960×680** (minimum 760×540).

Dark tokens remain background `#18191b`, surface `#212326`, secondary text `#b2b6bc`, and primary text `#f1f2f3`. Light mode uses neutral gray/white surfaces. Accent is configurable and used sparingly for selection/focus. One self-hosted typeface, [Geist (OFL)](../src/assets/Geist-OFL.txt). No external font requests. The later pairing QR uses the MIT-licensed `qrcode-generator` locally.

## Onboarding in motion

[Watch the browser recording (WebM)](design/onboarding.webm). The GIF below shows the same real browser interaction, not a design mockup.

![Animated onboarding walkthrough](design/onboarding.gif)

The recording captures the earlier visual checkpoint, before phone pairing was wired. Current setup points to Settings rather than saying pairing is unavailable.

The full-window flow deliberately shows one task at a time:

1. **Start with one button.** Try four example keys and watch the rehearsal respond: scene change, microphone mute, playback, or volume.
2. **Make it yours.** The welcome action choice carries forward automatically; enter a label and the scene name when relevant. Changing action is optional, tucked behind “Change action,” not a second mandatory picker. Blank labels/scenes cannot advance, and Back/Next preserves the draft.
3. **Give it a press / slide.** Rehearse the configured control. **Add to page** becomes available only after trying it; the destination is shown separately as “Page: Stream.” Adding appends exactly one control to that page and selects it for editing. The final note now points to “Connect your phone in Settings.”

Everything before Add is a local draft. Nothing runs on OBS, microphone, playback, or output volume during setup. Rehearsal outcomes are explicitly labelled; they do not claim observed native success. The sample deck is retained, not replaced. Existing saved decks go directly to the editor. Settings → **Replay setup** opens the flow without resetting work.

Skip is always available. Dismissal is remembered separately under `deck.setup.v1`, without writing a browser deck. If browser storage is blocked, dismissal lasts for the session. In-progress drafts do not resume after restart; the native store initializes its default document before onboarding and subsequent launches treat that as an existing deck. Pairing is a separate explicit Settings step, never part of rehearsal.

Motion uses short key entrances, a downward press, scene slides, and approximately 340ms step transitions. Supported browsers use the platform View Transition API; other browsers use a CSS entrance. Reduced-motion preference skips the view transition and shortens CSS animation. Each step focuses its heading; exiting focuses the editor page title. Action choices are ordinary keyboard-operable radio inputs.

![Customize the chosen action](design/setup-build.png)

![Rehearse the configured control](design/setup-result.png)

## Desktop editor

![Dark desktop editor](design/desktop.png)

![Light desktop editor](design/light.png)

![Searchable action picker](design/actions.png)

## Phone preview

The phone retains touch-sized keys and bottom page navigation without editing tools. On desktop, an external **Landscape / Portrait** toggle changes the preview frame and grid; Landscape is the default. Long pages scroll inside the frame with page navigation reachable. On narrow/short real-phone viewports the desktop controls are hidden and the grid follows viewport orientation, without requesting orientation permissions. This setting is preview-only, not saved deck data.

![Desktop landscape preview with a long test page](design/preview-landscape.png)

![Desktop portrait preview of the same test page](design/preview-portrait.png)

![Phone deck](design/phone.png)

![Phone volume preview](design/volume.png)

These are implemented browser screens from isolated Chrome profiles: desktop/setup at 960×680, desktop device previews at 1024×900, and phone at 390×844. Screenshots wait for finite entrance animations to finish. The light editor includes a renamed test control; the 70% phone volume is a local preview value, not observed system output.

## Authenticated phone

The private service serves a separate phone surface, never the local editor or sample fallback. It starts with **Connect your phone** and supports pasting a fresh link inside the installed app, rather than assuming Safari/Brave/standalone cookies are shared. Explicit desktop approval unlocks saved pages and controls only after a live validated snapshot. Disconnection disables keys; an ambiguous result is **Unknown**, not an optimistic success. Sliders show local targets and commit only on deliberate release, not drag/cancel/blur. The shared user-applied update banner is also present here.

![Phone pairing in the actual-service test](design/remote-pairing.png)

![Approved phone showing the saved fixture deck](design/remote-active.png)

These are real Chrome screenshots at 390×844 against the Rust service through a disposable loopback HTTPS proxy. The fixture label distinguishes authoritative saved data from a preview fallback. No real OBS/audio action was run.

## Desktop pairing presentation

Settings names **Start/Stop local service** and distinguishes loopback availability from unverified phone access. Four short steps use subtly highlighted numbered circles; technical Serve setup and installation caveats live under **Connection help**. Connection help, Storage details, and About this preview share one native disclosure-row style, with centered text/chevron and no closed-state blank space. Native WebKit and Chrome geometry checks cover the alignment. Open the root HTTPS address on the phone first; only generate an invitation once that route works. Port 45829 is not a phone-facing endpoint, and Wi-Fi alone does not publish the app.

Expiry sits directly under the selectable link field, above **Copy link**, independently of copy feedback. The same expiring invitation is encoded into a locally generated black-on-white SVG QR with a four-module quiet zone. Replacement, expiry, stopping, or leaving Settings removes it. QR camera scanning normally opens a browser, so an installed iPhone app should still receive a fresh pasted link in its own session.

![Pairing field, expiry, Copy and local QR](design/pairing.png)

![Compact setup steps and shared disclosure row](design/pairing-steps.png)

These Settings screenshots use an owned fake native-IPC adapter in an isolated browser, not a real invitation. An independent QR decoder recovered the exact fixture URL at the earlier QR checkpoint. Coordinator checks now pass **107 frontend tests**, **225 local UI browser checks**, **65 actual-service HTTPS checks**, native WebKit welcome/build/try/editor/Settings geometry smoke, and production/native debug builds. The user reports that the phone connected after manually configuring Tailscale Serve; these automated tests did not change Tailscale or establish physical camera/install coverage.

## Quieter phone controls

Preview now has an explicit 44px **Close preview** X at the top right: outside the device frame on desktop, in the header at narrow sizes. Only one is visible at each breakpoint. Authenticated phones never gain an editor route/close button. Neither surface shows a redundant control count.

Routine action outcomes live in a collapsed **Activity** disclosure with the last ten completed results, newest first, saved control labels and no persistence. Opening it exposes diagnostics without constant below-grid status noise. Connection status stays visible; pending marks the key. Unknown outcomes deliberately retain a visible check-the-desktop warning outside Activity, even after another action succeeds, until a new session/terminal cleanup. This avoids disguising an uncertain side effect as a failure that is safe to repeat.

![Optional Activity opened for diagnostics](design/remote-activity.png)

![Unknown warning remains visible with Activity collapsed](design/remote-unknown.png)

Both screenshots use the real service with fake action adapters. Settings navigation/grouping, Spotify-specific player targeting, and QR artwork are separate future work.

## Verification and limits

The earlier UI checkpoint passed **54 frontend tests**, **202 browser checks**, TypeScript, production build, and the Tauri debug no-bundle build. The browser suite covers all four rehearsal actions, repeated scene presses, draft validation/back navigation, required practice, save-on-Add, skip/replay persistence, a full page, keyboard activation and focus, radio arrows, reduced motion, light mode, short/narrow layouts, welcome-to-configuration continuity, optional action disclosure, category filtering/keyboard access, backdrop pointer interaction, Settings toggling, brand identity, preview orientation/scrolling, and the existing editing/dialog/slider/offline/update behavior. The coordinator reviewed the DeepSeek worker’s diff/screenshots and independently reran checks; an earlier read-only review’s minor documentation, length-limit, and dead-style findings were also addressed.

The connection checkpoint adds authenticated phone rendering and fail-closed server routing, without changing saved schema, app/storage/protocol identifiers, or desktop authority. Unit coverage includes late/canceled responses, hidden-page suspension, uncertain actions and bounded requests; actual-service browser coverage includes pairing, real HTTP/WSS snapshots, saved fake actions, live revisions, conflict resync, revocation and offline/auth boundaries. The coordinator independently passed **93 frontend tests**, **202 local UI browser checks**, **62 actual-service HTTPS browser checks**, and **70 default Rust tests**, plus typecheck and production/Tauri debug builds. See the README for reproducible checks.

Swipeable panels within pages and per-page themes remain planned migrations; appearance controls are still global. Physical iPhone/Android installation, Safari/Brave-specific behavior, bundled phone-asset resolution, and the full real OBS/audio checklist remain unverified. The user reports successful phone connection after manually setting up Tailscale Serve, but media play/pause did not affect the intended player; read-only inspection found Gwenview first in the default MPRIS player list. A later AMD/Wayland check with isolated data passes after aligning the Nix shell's Mesa EGL/GBM loaders with its glibc and guarding GTK's unset DPI before WebKit starts. It verifies native welcome/build/try/editor/Settings geometry (positive pixel ratio, viewport/font sizes, content widths, disclosure and numbered-step alignment, and no overflow), not comprehensive visual QA. The user also confirmed that the collapsed native layout is fixed. An isolated Chromium HTTPS test is not a real-device result.
