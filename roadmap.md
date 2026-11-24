# Project roadmap

> Project name: **zDeck** (chosen by the user). Status: **implementation started; remaining choices stay provisional**.
> Initial scope approved: MIT, KDE Wayland/Linux first, Tailscale-first private prototype, OBS scenes, microphone mute, media play/pause, and volume. LAN-only remains a release requirement.

### Confirmed decisions

- License: **MIT**.
- First desktop: **Linux, KDE Plasma, Wayland**; existing machine configuration lives in `~/nix-config` and is not to be changed as part of project scaffolding.
- Prototype connectivity: **Tailscale first**; do not confuse this with completed LAN-only support.
- First action targets: **OBS scene switching, microphone mute, media play/pause, and volume**. Clarify whether microphone mute means system default input, an OBS input, or both before wiring that action.
- Controls: **buttons and a slider first**; a dial is a follow-up once shared state and interaction behavior are proven.
- Phone test targets: **iPhone + Android**. The user normally browses with **Brave**, installs iPhone PWAs using **Safari**, and then uses the standalone app. Tailscale is installed on the phone. Test pairing within the installed PWA; do not assume browser and standalone cookie stores are shared. No physical-device validation yet.
- User has authorized implementation and coordinated subworkers. Use bounded, sequential tasks and independently verify their results.
- Coordinator/ChatGPT owns visual direction. The user likes the rehearsal-based onboarding, side Inspector, and phone preview; the latest refinement pass still awaits feedback. Earlier dashboard, colored-console, and inline-guide directions were rejected.
- Product terminology: a **page** is the named layout; future **panels** are alternative groups within a page, switched by vertical swipe with an accessible non-gesture alternative. Panels are planned, not implemented.
- Future themes belong to individual pages. The prototype’s global appearance setting is not the final page-theme model.
- Display branding is zDeck. Keep existing storage keys, protocol names, and app identifier stable until an explicit migration is designed.
- Make reviewable Git checkpoint commits as work progresses. Do not push without authorization.

## 1. Product

An open-source, local-first control deck: arrange buttons on a desktop, then use them from an installable phone or tablet web app. Inspired by Touch Portal, with an original interface and implementation.

- **Desktop:** Tauri app for Linux, Windows, and macOS. Owns configuration, integrations, credentials, and action execution.
- **Phone/tablet:** PWA, installed from the browser without an App Store or Play Store download.
- **Network:** same-LAN connections and private Tailscale connections, with QR pairing.
- **Business model:** no application license fees, subscriptions, paid button limits, or required hosted service. Optional external services may have their own fees and terms.
- **Experience:** compact, polished, dark by default, themeable, and immediately understandable.
- **Ecosystem:** documented extensions that individuals can build and distribute without our permission or marketplace account.

### First useful outcome

Open the desktop app, create two pages, add a few real actions, pair a phone, install the PWA, and control the desktop. Edits appear on the phone without a reload. Both screens communicate connection and action status honestly.

### Boundaries

- The desktop must be running and reachable for actions to execute. A cached PWA is not an offline desktop controller.
- Desktop editing is authoritative initially. Phone page switching is supported; phone layout editing is deferred.
- No required cloud account, analytics, public relay, or port forwarding.
- Native Tauri mobile builds are optional future distribution, not a prerequisite for the PWA.
- Touch Portal feature breadth is a long-term target, not a promise of complete parity in the first release. No proprietary assets, code, or automatic plugin compatibility.

## 2. Design direction

**Future-forward, not visually noisy.** Near-black surfaces, crisp typography, restrained accent lighting, quiet borders, and precise feedback. Avoid a wall of neon, oversized cards, or decorative animation.

### Desktop workspace

- Narrow navigation: **Decks**, **Integrations**, **Automations**, **Extensions**, **Settings**. Group pages under Decks; values, events, and flows under Automations when implemented.
- Main area: page canvas, quick page switching, and a collapsible action library/inspector. Editing and preview should not require separate workflows.
- Searchable action library grouped by category: Media, System, OBS, Twitch, Home, and installed extensions. Filter, favorite, and drag an action onto the grid.
- Reorder pages and buttons directly. Provide keyboard and move-menu alternatives to dragging.
- Hide unavailable functionality until it exists. Do not fill the initial app with empty tabs.
- Put Logs, Guides/Help, and a future Discord link in Settings/help surfaces, not persistent promotional chrome.

### Phone workspace

- The deck is the interface: generous touch targets, little chrome, thumb-friendly page navigation.
- Responsive portrait/landscape layouts with safe-area support; no desktop editor squeezed onto a phone.
- Stable button positions as status changes. Editing preview must match the selected device profile; orientation behavior is explicit, not surprising auto-reordering.
- Support icon-only buttons, optional short labels, and accessible names. Tooltips must not be the only way to understand controls.

### Interaction and themes

- Distinguish **pressed locally**, **pending**, **confirmed**, **failed**, **disabled**, and **disconnected**. A tap animation is not proof that an action succeeded.
- Live toggle states come from the integration, not optimistic guesses. Clearly mark actions whose underlying API cannot confirm the final result.
- A small token-based theme system: dark default, light alternative, configurable accent. User requirement: page-specific themes so each page can look different; the current global appearance control is a prototype. Later: theme import/export and page backgrounds.
- Add multiple panels of controls within a page, with swipe up/down to quickly reach alternative groupings. Preserve slider interaction and offer visible/keyboard navigation instead of requiring gestures. This needs an explicit schema/storage/protocol migration, not just a preview animation.
- Compact visual density without tiny hit areas: aim for 44×44 CSS-pixel phone targets, visible focus, readable contrast, and reduced-motion support.
- Use one modern, openly licensed font, preferably self-hosted. System fallback, clear icons, no color-only status information.
- Short labels; inline detail only when useful; actionable errors instead of unexplained codes.

**Design acceptance:** agree on one desktop editor and one phone deck prototype before broad implementation. Review empty, loading, connected, reconnecting, and failed states—not just the happy-path screenshot.

## 3. Proposed technical foundation

These are recommendations to approve after the feasibility work, not dependencies already installed.

| Area | Starting proposal | Reason |
| --- | --- | --- |
| Desktop shell | Tauri 2 + Rust | Native desktop capabilities with a web UI |
| Web UI | TypeScript + React + Vite | One familiar SPA toolchain; share components and design tokens |
| Styling | CSS tokens and a small accessible component set | Consistent density and themes without building a design framework |
| Desktop service | Rust HTTP/WebSocket server, likely Axum/Tokio | Desktop owns state and execution; no mandatory Node/Python runtime |
| Device transport | Same-origin HTTPS + WSS | Pairing, snapshots, live changes, commands, acknowledgements |
| Configuration | Versioned local documents with atomic writes and backup | Start simple; add a database only for a demonstrated need |
| Extensions | Versioned process protocol; TypeScript example first | Language-neutral host with familiar authoring tools |
| Checks | Rust tests, TypeScript tests, browser E2E, real-device checks | Exercise protocol, persistence, UI, and platform boundaries |

### Shared code, distinct capabilities

Share UI primitives, theme tokens, configuration schemas, and protocol types. Desktop editor and phone deck are different views, not identical screens.

Keep Tauri-native calls out of shared browser components. A phone invokes only the paired desktop's validated remote API. Tauri capabilities remain scoped to the bundled desktop UI; never give a remote PWA access to arbitrary Tauri commands.

The desktop service owns the authoritative deck and invokes the same action engine regardless of whether a command originates in the desktop preview or on a phone.

### Minimum model

- **Deck:** a collection of pages; support multiple independent devices later.
- **Page:** ordered button layout and presentation settings.
- **Button:** stable ID, appearance, action reference/configuration, and optional state binding. The first release supports one action per button; action sequences arrive with flows.
- **Action definition:** stable namespaced ID, category, configuration schema, and execution contract.
- **Device:** paired identity, access scope, and revocable credentials.
- **Later:** typed values, event rules, reusable flows, slider/connector definitions, and extension manifests.

Do not implement every future object up front. Reserve stable IDs and schema versions so later changes can migrate safely.

## 4. Connectivity and security: resolve before promising the MVP

### The HTTPS constraint

A phone visiting `http://192.168.x.x` is not visiting `localhost`. A QR code containing that address does not make it a secure, fully installable PWA. Service workers require a secure context; browser installation requirements vary. An HTTPS page also cannot simply open an insecure WebSocket to the desktop.

**Both LAN-only and Tailscale are product requirements.** A Tailscale-first private prototype may be useful if approved, but it does not fulfill LAN-only support.

| Connection mode | Candidate | Outstanding work |
| --- | --- | --- |
| Tailscale | Serve proxies a loopback-only desktop service at a trusted `https://…ts.net` origin | Phone joins the tailnet; enable HTTPS, respect access rules, document setup and certificate-name privacy |
| LAN only | Direct HTTPS/WSS on a selected interface using a certificate trusted by the phone | Choose and test certificate provisioning, trust, renewal, naming/address changes, and user setup |
| Developer preview | Plain local HTTP | Development only; not the production installation story |

For LAN, evaluate a local CA/trust-install flow versus user-provided trusted certificates/domain/reverse-proxy setup. Neither should be advertised as zero-setup until tested. Do not ship a shared private key or recommend bypassing certificate warnings. A public hosted PWA is not a shortcut around local API TLS, browser network permissions, or mixed-content restrictions.

Tailscale is optional third-party infrastructure, not our licensing model. Never enable public Funnel or change a user's existing Serve configuration without consent. Certificates may disclose machine/tailnet names in public Certificate Transparency logs. Changing an origin can require reinstalling/re-pairing a PWA; stable URLs matter.

### Pairing flow

1. User selects a reachable endpoint/interface in the desktop app: LAN or Tailscale. Show the actual advertised URL and health.
2. Desktop creates a short-lived, single-use invitation and displays a QR plus a manual link/code fallback.
3. Phone scans using its normal camera; an in-PWA scanner is not necessary initially.
4. Desktop asks the user to approve the new device. Exchange the invitation for a per-device credential over HTTPS; the QR must not carry a permanent bearer secret.
5. Phone receives the current deck and opens an authenticated live connection. Desktop lists connected devices and supports immediate revocation.

Keep invitation secrets out of server access logs and browser history where possible; if carried in a URL fragment, remove it from the visible URL immediately after consumption. Choose credential storage and CSRF/session handling in the protocol design, not ad hoc in UI components.

### Required trust boundaries

- Deny unauthenticated actions, expired/reused invitations, revoked devices, and unexpected origins/hosts. Apply pairing rate limits and payload size limits.
- Remote clients send an authorized button/action ID, not arbitrary shell text, filesystem paths, or integration credentials.
- Protect local endpoints too: loopback is not proof of trust. Do not expose admin operations to arbitrary web origins.
- Keep integration tokens in OS-backed credential storage where available; document platform fallback explicitly. Never sync tokens to phones, exports, or logs.
- Bind only where necessary. Tailscale proxy mode can stay loopback-only; LAN mode needs an explicit listener and firewall guidance.
- Treat deck imports, images, extension manifests, and web content as untrusted input. Validate schemas, sizes, paths, and URLs; disallow executable HTML/SVG content unless safely handled.
- Use restrictive content security policies; redact secrets from diagnostics. No telemetry by default.

### Reliable behavior

- Send a snapshot plus revision on connect; publish edits and action state changes afterward. Reconnect must resynchronize, not assume no changes were missed.
- Assign command IDs and bound deduplication so transport retries do not double-toggle a real action. Do not claim exactly-once execution across crashes.
- Never queue offline button presses for later replay. After an ambiguous timeout, show an unknown result rather than blindly repeating a side effect.
- Persist configuration safely; migrate with a backup and report incompatible versions. Keep UI assets cached separately from authenticated state and secrets.
- Expect mobile browsers to suspend background sockets. Resync when the app resumes; no background execution guarantee.

## 5. Feature roadmap

The categories below cover the requested direction and researched Touch Portal concepts. An exhaustive parity audit remains future work.

| Capability | First working release | Follow-up / full product direction |
| --- | --- | --- |
| Pages and decks | Create, rename, duplicate, delete, reorder; select starting page; switch from phone | Folders, device-specific assignments, richer layouts/backgrounds, page templates |
| Buttons | Icons, short labels, color, grid position, clear feedback, one action | Multi-cell controls, hold/release, long press, sliders/dials, dynamic styling |
| Editor | Searchable categorized actions, drag/drop and accessible move controls, live preview | Multi-select, undo/redo, reusable button templates, richer device previews |
| Themes | Prototype dark/light, accent, shared desktop/phone tokens | Per-page themes (user requirement), import/export, community themes |
| Media/System | One useful real action family chosen after OS spike | Media transport, volume, app launch, hotkeys, text input, mouse, HTTP/OSC as supported |
| OBS | Recommended early integration; exact inclusion needs approval | Scenes, sources, audio/mute, recording/streaming state, richer controls through OBS WebSocket |
| Twitch | Deferred | OAuth/account connection, chat/moderation and stream actions within API permissions; never bypass platform restrictions |
| Home automation | Deferred | Home Assistant first candidate: services and live entity state; other systems through extensions |
| Values | Only integration state needed by shipped actions | Typed local/plugin values, bindings, expressions, inspect/reset tools |
| Events | Connection and button events internally | User rules on value changes, app/page changes, timers, integration events; loop prevention |
| Flows | Deferred; avoid a premature node editor | Reusable action lists with delay, conditions, bounded repeats, cancellation, errors, and tracing; graphical editing only if justified |
| Extensions | Host feasibility spike, no unsafe install shortcut | Public SDK/protocol, install/update/remove, settings, actions, events, values, connectors |
| Marketplace | No required marketplace service | Curated static directory linking externally hosted packages; inspect permissions, provenance, versions, and licenses |
| Guides and help | Pairing/install guide and troubleshooting | Searchable guides, example decks, extension docs, tucked-away Discord link when provided |
| Logs | Connection/action diagnostics and redaction | Filters, flow/extension traces, bounded retention, safe support export |
| Settings | Network endpoint, devices, theme, essential integration settings | Backup/restore, update preferences, advanced controls, accessibility |
| Devices | One paired phone exercised end to end | Multiple clients, independent active pages, scopes, reconnect/resume and contention policy |
| Portability | Safe local persistence; basic deck export/import | Version migrations, portable assets, selective sharing without secrets |

System automation must have a documented capability matrix. Registering a global shortcut is different from synthesizing a remote keypress. Wayland, X11, Windows privileges, and macOS Accessibility permissions require separate checks. Prefer integration APIs where practical; do not promise universal input injection.

## 6. Extension approach

**Goal:** someone can write a small extension without compiling the desktop app or asking us to approve it.

- Start with a declarative manifest and a versioned JSON message protocol over standard I/O. The desktop discovers actions/settings and exchanges commands, state, and events with the process.
- Provide one TypeScript example and a Python example once the protocol is proven. Other languages can speak the same protocol.
- Make runtime requirements explicit: do not assume Node or Python is installed, and do not quietly bundle both before deciding the distribution strategy.
- Schemas describe settings/configuration so most extensions need no custom UI. Later custom UI must be isolated from the desktop's privileges.
- Publish timeouts, lifecycle, cancellation, error handling, compatibility, and restart behavior. Bound messages, logs, and restarts so one broken extension cannot freeze the app.
- Manifest capability declarations and install warnings communicate trust; a separate process is **not an OS sandbox**. An installed Python/JavaScript program can act with the user's OS permissions unless actual isolation is implemented.
- Local sideloading comes before a marketplace. Show origin, license, compatibility, and requested access before installation. No automatic execution of downloaded packages on preview/import.
- Keep integration credentials host-owned where the API permits; document any extension that necessarily receives secrets.

**Not initially:** Touch Portal plugin compatibility, two bespoke scripting engines, arbitrary plugin code inside the main webview, paid distribution, or a centralized account system.

## 7. Delivery plan and gates

The user has approved starting implementation. Begin M1's reversible UI/scaffold work alongside the remaining M0 decisions; do not present a local preview as an authenticated remote controller. Later milestones become agent-sized tasks after their dependencies are resolved. No speculative deadlines.

### M0 — Decisions and feasibility

- [x] Choose MIT, KDE Wayland/Linux first, Tailscale-first prototype, and initial action targets (OBS scenes, microphone mute, media play/pause, volume).
- [x] Choose project name: **zDeck**.
- [x] Choose phone/browser test targets: Safari-installed iPhone PWA first, Brave browser use, and Android. Tailscale is installed on the phone.
- [ ] Confirm the provisional default-system-input microphone scope.
- [ ] Prove trusted HTTPS/WSS + Home Screen installation on a real target phone over Tailscale.
- [ ] Select and prove a LAN-only trusted HTTPS path, including reconnect after desktop restart and certificate lifecycle notes.
- [x] Label the approved Tailscale-first prototype explicitly; retain trusted LAN HTTPS proof as a release gate.
- [ ] Prove one actual desktop action on each target OS; record unsupported permissions/capabilities, especially Wayland. One developer's OS is not cross-platform verification.
- [ ] Agree on desktop/phone visual prototypes and interaction states.
- [ ] Record transport/pairing threat model, stable-origin plan, configuration schema, and extension runtime decision.

**Exit:** architecture choices have evidence, unsupported scenarios are explicit, and the first end-to-end slice is approved.

### M1 — Runnable foundation and polished UI slice

- [x] Scaffold shared web frontend and minimal Tauri shell with documented commands. Repository-local Nix shell is pinned; coordinator verified cargo check/test and a debug no-bundle Tauri build on x86_64-linux. No native runtime or packaging claim yet.
- [x] Establish design tokens, dark/light themes, desktop editor, and same-origin phone preview.
- [ ] Obtain final user acceptance of the implemented redesign. The user likes rehearsal-based onboarding, the side Inspector, and phone preview. Follow-up refinements carry the welcome choice into configuration, tuck action changes behind a disclosure, use “Add to page,” shorten the pairing note, enable backdrop dismissal and a Settings toggle, add category navigation and desktop portrait/landscape previews, improve Remove visibility/Settings spacing, and introduce the zDeck logo. Coordinator verified 202 Chrome checks and 54 frontend tests; screenshots and motion recording are updated. Further visual feedback remains welcome.
- [x] Add minimal deck/page/button schema, sample data, and validated browser-local persistence. Coordinator verified 29 tests plus 36 Chrome smoke checks, including cross-tab edits and refresh persistence. Desktop-owned atomic file persistence remains M2 work.
- [ ] Add CI for formatting, type checking, unit tests, and desktop build checks on Linux/Windows/macOS.
- [x] Add PWA manifest and generated icons.
- [x] Verify offline shell and user-applied update/reload lifecycle across two different builds in isolated headless Chrome; generated, content-versioned caches replace the initial worker.
- [x] Upgrade vulnerable development/test dependencies; coordinator reran npm audit (zero findings), tests, typecheck, build, and the 36-check browser smoke suite.

**Exit:** a fresh checkout runs by following the docs; the desktop editor and phone preview look intentional. This milestone is not yet a working remote controller.

### M2 — Secure end-to-end controller

- [x] Implement private loopback HTTP/WebSocket backend, session-only pairing/approval/revocation, request guards, and deduplicated saved-control commands. Coordinator verified 68 Rust tests including 24 real-loopback service tests; actual Tailscale proxy behavior remains unverified.
- [x] Wire native desktop connection settings, session-only expiring pairing links, approval/denial/revocation; coordinator verified 64 frontend tests and the existing 202-check browser suite. Links and locally generated QR codes are available. Settings explicitly distinguishes local service from unverified phone access and requires separate Tailscale Serve setup. Owned fake-IPC browser checks cover expiry/copy layout, replacement/expiry/stop cleanup and narrow QR layout; real native admin lifecycle and physical scanning still need validation.
- [x] Wire authenticated phone pairing/control UI, including fresh-link paste for independent standalone/browser sessions. Actual-service HTTPS/Chrome tests cover the paste flow in a fresh cookie context; Safari installation remains a physical-device gate. Keep every private-service route remote and local Preview simulated.
- [x] Wire revisioned snapshots/live edits; authenticate and wait for a fresh valid WebSocket snapshot before enabling controls. Suspend/abort stale work in the background, bound requests/snapshot waits, and reconnect reads without replay.
- [x] Share native Inspector and approved-phone execution through the same saved-control action adapters. Never make local preview presses real.
- [x] Show pending/typed results/disconnection honestly; correlate IDs, deduplicate on the server, mark ambiguous actions Unknown, and prevent offline queuing or automatic mutation retries. Slider targets commit only on deliberate release, never cancel/blur.
- [x] Add desktop-owned validated atomic file persistence, native migration/load gate, revision CAS, and a sequential frontend save queue; corruption is surfaced without overwrite. Coordinator verified 44 Rust tests (including a temp-file ownership regression) and 52 frontend tests.
- [ ] Finish page editing, phone page navigation, and basic export/import without secrets.
- [x] Add focused protocol/security tests and opt-in actual Rust + HTTPS/Chrome coverage of invitation → pair → approve → press → live edit → conflict resync → revoke, plus independent link paste and offline caching. Fake adapters only; real native/phone/network acceptance is not implied.
- [ ] Validate PWA installation and real button execution on the chosen phone over both approved network modes.

**Exit: minimal working project.** Two pages, real actions, secure pairing, live mirroring, persistence across restart, usable phone installation, clear errors. No mock-only action demos counted as completion.

### M3 — Useful integrations and extension developer preview

**User priority after the interface is settled:** Spotify as the first requested plugin: play, pause, next/previous track, and volume. Before choosing an implementation, distinguish Linux player control from Spotify Web API integration and document account/API restrictions. Existing default-MPRIS play/pause is not a Spotify plugin. No Spotify implementation is included in the design pass.

- [ ] Finish OBS acceptance on a real OBS/native runtime. Initial native implementation connects to loopback with session-only credentials, discovers scenes, and verifies scene switches; coordinator verified 13 fake-peer Rust tests and 37 TypeScript tests. Manual snapshots are implemented, not pushed live state.
- [ ] Finish live Media/System acceptance and extend the OS matrix. Initial Linux adapter implements system-default microphone mute, output volume, and default MPRIS play/pause with fixed wpctl/playerctl commands; coordinator verified 33 Rust tests total (13 OBS + 20 system), 45 frontend tests, and 36 browser smoke checks. No live audio/playback mutation has been tested.
- [ ] Implement the minimal process extension host and publish its versioned protocol.
- [ ] Ship a working TypeScript sample, then Python sample; validate runtime installation instructions.
- [ ] Test extension crash, malformed messages, action timeout, missing runtime, uninstall, and restart recovery.
- [ ] Polish action discovery, favorites, diagnostics, and onboarding against real user tasks.

**Exit:** an external developer can build an action without modifying core code; a broken extension does not take down the app.

### M4 — Automations and broader integration coverage

- [ ] User-facing values and button-state bindings.
- [ ] Events and reusable flows with bounded execution, cancellation, failure handling, and trace logs.
- [ ] Twitch and Home Assistant integration spikes followed by scoped releases.
- [ ] Swipeable panels within a page, with accessible non-gesture navigation and explicit schema/protocol migration.
- [ ] Page-specific themes (not only a global theme), page templates, and improved import/export.
- [ ] Multiple-device behavior and richer controls.
- [ ] Revisit parity gaps against current Touch Portal documentation and user priorities.

**Exit:** important automation tasks work safely without building a flow engine or extension for every button.

### M5 — Public beta and distribution

- [ ] Reproducible install packages and smoke tests on all three desktop OSes; document actual supported versions.
- [ ] Decide Windows signing and macOS signing/notarization funding. Free software does not make distribution certificates, developer programs, or external services free.
- [ ] Publish source-build and unsigned-install limitations transparently; never tell users to disable OS protections globally.
- [ ] Test fresh install, upgrade/migration, backup/restore, uninstall, revoked/expired credentials, and corrupted config recovery.
- [ ] Document firewall, TLS, Tailscale, iOS installation, mobile suspension, and unsupported input capabilities.
- [ ] Add contribution guide, security reporting, license notices, and a compatibility policy.
- [ ] Add a curated extension/theme directory and Discord link only when there is content and a server URL.
- [ ] Test old PWA/new desktop version mismatch and a safe update/reconnect path before enabling automatic updates.

**Exit:** someone outside the project can install, pair, troubleshoot, and contribute without personal assistance or paying an application license fee.

## 8. Agent execution plan

Use small reviewable tasks, not “build the app” prompts. Each handoff names allowed files, dependencies, acceptance checks, and unresolved decisions. Do not let concurrent agents edit shared schemas or integration code without coordination.

| Order | Bounded assignment | Evidence required |
| --- | --- | --- |
| 1 | Connectivity research/prototype | Real-device HTTPS, WSS, installation and pairing findings; setup steps for both modes |
| 2 | Design prototype | Desktop/phone views with core states, keyboard access, contrast, and responsive review |
| 3 | Foundation/schema | Reproducible builds, schema tests, safe persistence, frontend/browser separation |
| 4 | Transport/pairing | Authentication, invite expiry/reuse, origin rejection, revocation and reconnect tests |
| 5 | Editor/phone integration | Real end-to-end mirroring, page switching and command feedback against the agreed protocol |
| 6 | First action adapter | Real hardware/OS execution and error/state tests; no placeholder success |
| 7 | QA/security review | Independent negative tests, secret handling review, target OS/phone evidence |
| 8 | Integrations/extensions | One integration or protocol slice per task after M2 acceptance |

Schema/protocol decisions precede dependent implementation. Parallel UI and host work is useful only once that contract is agreed. Every milestone gets coordinator review; workers do not publish releases, commit, or push unless explicitly authorized.

## 9. Decisions for discussion

### Needed before implementation

1. **Name:** working name still TBD. **License resolved: MIT.**
2. **Devices:** iPhone, Android, or both? Which phone/browser versions are available for real testing?
3. **First desktop resolved:** Linux, KDE, Wayland. Windows/macOS remain intended targets.
4. **First actions resolved:** OBS scenes, microphone mute, play/pause, volume. **Still open:** system microphone mute, OBS microphone mute, or both? Start with default system input unless clarified otherwise, and label the scope explicitly.
5. **Prototype sequencing resolved:** Tailscale-first private prototype approved; general LAN support remains planned and required before claiming both modes work.
6. **LAN setup tolerance:** acceptable to install/trust a local certificate, provide a domain/certificate, or is near-zero setup a hard requirement? This materially affects feasibility and support.

### Can be decided after the first slice

- TypeScript-first extension documentation, with Python using the same protocol: acceptable?
- One deck shared across devices initially, then device-specific decks and independent page state?
- Home Assistant as the first home-automation integration?
- Any visual references beyond “compact, dark, future-forward,” and a preferred accent?
- Is copyleft protection for extensions desired? Resolve SDK/example licensing alongside the main license.
- Which Touch Portal workflows beyond those listed are must-haves? “All features” needs a prioritized checklist, not an assumed compatibility claim.

## 10. Research and known unknowns

Official documentation reviewed by a read-only research agent; the coordinator also fetched the MDN service-worker, Tailscale Serve, and Tauri frontend pages to check the central constraints. This was documentation research, not hardware or browser validation.

- [Touch Portal docs](https://www.touch-portal.com/docs/), [capability model](https://www.touch-portal.com/docs/capability-model/), and [plugin API](https://www.touch-portal.com/api/): pages, values, events, flows, plugin actions/states/connectors. Capability coverage is broader than any single category list.
- [MDN: installable PWAs](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable) and [service workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API): secure-context requirements and installation differences. Service-worker/offline support and browser install criteria are related but not identical.
- [WebKit: iOS/iPadOS web apps](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/): Home Screen behavior. Do not depend on background execution; verify foreground resume on actual target devices.
- [Tailscale Serve](https://tailscale.com/kb/1312/serve), [HTTPS](https://tailscale.com/kb/1153/enabling-https), and [Funnel](https://tailscale.com/kb/1223/funnel): private Serve versus public Funnel, certificate setup, and access control. Serve is not LAN access for a phone outside the tailnet.
- [Tauri frontend](https://v2.tauri.app/start/frontend/), [architecture](https://v2.tauri.app/concept/architecture/), [Rust bridge](https://v2.tauri.app/develop/calling-rust/), and [webviews](https://v2.tauri.app/reference/webview-versions/): shared frontend is feasible; native bridges and browser engines differ by target.
- [Tauri global shortcuts](https://v2.tauri.app/plugin/global-shortcut/) and [underlying global-hotkey crate](https://github.com/tauri-apps/global-hotkey): desktop/platform restrictions. These concern shortcut registration, not proof of synthetic input support.

**Still unverified:** the chosen LAN certificate experience, mobile browser local-network permissions, real phone reconnect behavior, synthetic input/media APIs across target OSes, plugin runtime packaging, and distribution/signing costs. These are feasibility tasks, not details to discover after promising universal support.
