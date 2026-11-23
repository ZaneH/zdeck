# Design review: control surface

**Status: awaiting user feedback.** This coordinator-led pass replaces the original dashboard styling. It does not add phone pairing or imply a live desktop connection.

- Graphite surfaces and quiet seams instead of nested rounded panels and cyan glow.
- One page/action strip, a central deck, and adjacent properties. Reorder controls appear on selection, hover, or keyboard focus.
- Warm scene cues, coral microphone cues, a round transport symbol, and a full-width phone volume slider. Colors identify action families, not simulated live state.
- Self-hosted Geist with system fallback; [font license](../src/assets/Geist-OFL.txt). No external font requests or new UI dependencies.
- One preview indicator, less repeated copy, bottom phone navigation, reduced-motion support, and 44px touch targets.

These are screenshots of the implemented browser UI, not mockups. Captured with isolated headless Chrome profiles at 1440×1000 and 390×844. The volume image uses the smoke test's 70% local preview; it is not an observed system volume.

## Desktop editor

![Desktop editor](design/desktop.png)

## Phone deck

![Phone deck](design/phone.png)

## Phone volume control

![Phone volume preview](design/volume.png)

## Checked, not assumed

52 frontend tests and 43 headless-browser checks pass, including editing/persistence, keyboard reorder visibility, font loading, layout overflow, phone target size/navigation, offline shell, and a two-build update. Dark desktop, phone portrait, and phone landscape screenshots were reviewed. Light-theme switching is exercised, but a dedicated light-theme visual review is still pending.

Native WebKit/Wayland appearance, real touch devices, and Tailscale/HTTPS phone installation remain unverified. Existing native settings/actions were preserved, not visually validated through a running desktop shell in this pass.
