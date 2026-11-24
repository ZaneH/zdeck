# Private prototype protocol (v1)

Implementation contract for the first remote controller. This describes intended behavior; the roadmap/README record what has actually been verified.

## Scope and trust

- Explicitly enable a Rust service on **127.0.0.1**, default port **45829**. No public/LAN listener or automatic Tailscale configuration.
- User configures a stable, trusted **HTTPS origin on their tailnet**, without path/query/credentials, then deliberately proxies it with Tailscale Serve. Funnel is not needed or enabled.
- The service serves the bundled PWA and `/api/v1/*` from that same origin. It does not expose Tauri IPC, OBS settings/passwords, arbitrary commands, filesystem paths, or deck editing over HTTP.
- Tailscale membership is not application authorization. Every device requires desktop approval.
- Initial device credentials are **session-only**: stopping the service or restarting the app requires pairing again. Durable device enrollment is deferred, explicitly visible to users.
- All API responses, including errors, use `Cache-Control: no-store`. Static assets contain no secrets and keep the existing exact-allowlist PWA cache policy.
- The service rewrites `data-zdeck-local` to `data-zdeck-remote` in its index before serving or caching it. Missing/invalid index markers fail closed; missing bundled assets cannot fall back to the editor index. All remote routes remain remote. This marker is UI routing only, never authentication.

## Request boundary

- Validate `Host` against the configured public host or exact loopback upstream authority. Do not trust arbitrary forwarded headers to select an origin or identity.
- Require the exact configured `Origin` for pairing/command POSTs and WebSocket upgrades. No wildcard CORS or credentials accepted cross-origin. Reject unexpected/missing origins on these routes.
- Authenticated read-only GETs need a valid active device cookie; no reliance on Origin being present on same-origin GETs.
- Credential: CSPRNG 256-bit opaque token in a `__Host-deck-device` cookie, `Secure; HttpOnly; SameSite=Strict; Path=/`, no Domain. Store its hash in the in-memory registry, never expose the token to JavaScript, URLs, logs, deck data, or localStorage.
- An unapproved token grants only its own pairing-status read, never deck/action access. Revocation invalidates subsequent requests and closes its live socket. An already-started OS side effect cannot be undone by revocation.
- Bound JSON bodies, pending/device/invitation counts, pairing request rate, command rate, socket sizes, and in-flight work. Fail closed before starting side effects when limits are reached.
- Public static routes are an exact set of shell/icon/build assets; path traversal and arbitrary Tauri assets are not served. Browser CSP has no IPC privileges, frames, external scripts, or remote executable content.

## Pairing

Native-only admin operations: start/stop/status, create invitation, list pending/approved devices, approve/deny, revoke. There are **no HTTP admin endpoints**.

1. Desktop creates a CSPRNG invitation, one active invitation at a time, expires after two minutes. Store only its hash; keep the returned raw invitation transiently in the desktop pairing view.
2. Share `https://<configured-origin>/#/pair?invite=<token>` by expiring link or a locally generated QR carrying that exact link. The fragment is not sent to the server. The phone captures/removes it synchronously before rendering or registering its service worker. Alternatively paste a fresh same-origin root link inside the installed PWA; do not assume Safari, Brave, and standalone sessions share cookies. Neither form persists the invitation.
3. Phone `POST /api/v1/pair` with `{ invitation, name }`. Consume the invitation atomically once; enforce expiry, limits, and bounded name. Return `{ requestId, status: "pending" }` and set the provisional device cookie.
4. Desktop shows the pending request/name and approves or denies it. The invitation alone does not authorize an action.
5. Phone polls `GET /api/v1/pair/status` about every two seconds, without overlap, until approved/denied/expired. Cookie identifies only its own pending request. Pause on hide and stop on terminal status/cancellation. Cancellation is local, not a promise of server denial. Resume uses non-mutating status reads; it never repeats the pairing POST.
6. On approval, that cookie becomes an active device credential. On denial/expiry/revocation, it has no deck or action access. Cap pending lifetime; do not retain abandoned secrets indefinitely.

Avoid access/request-body logging of invitations or cookies. Invitation matching and registry updates are atomic. Pairing request IDs and display names are metadata, not authorization secrets.

## Deck snapshots and synchronization

- `GET /api/v1/state`: authenticated `{ protocolVersion: 1, revision, deck }` from the desktop's durable deck store. Never send a sample deck to conceal a storage error.
- `GET /api/v1/events`: authenticated WebSocket upgrade; exact Origin required. Sends `{ type: "snapshot", protocolVersion: 1, revision, deck }` immediately and after successful native deck saves.
- A revision describes the complete deck, not an incremental patch. Reconnect/resume always gets a fresh snapshot, so missed messages require no replay log.
- No editing over the socket. Ignore/reject unsolicited non-protocol messages with bounded framing; support normal socket close/ping behavior.
- Phone page selection is local per client. New snapshots preserve that selection while the page exists; otherwise use the desktop's starting page.
- Actions require protocol v1, a safe positive revision, runtime-valid deck data, and a fresh valid WebSocket snapshot, not merely a successful HTTP read. Reject invalid/oversized socket messages.
- Loss of socket/foreground session disables actions until authentication and a fresh snapshot have been checked. HTTP reads/bodies and the first socket snapshot have 12-second deadlines. Reconnect delays cap at 15 seconds and pause while hidden; terminal authorization failures halt reconnects. Never queue presses offline. In-flight callbacks cannot revive canceled/old sessions.

## Action commands

`POST /api/v1/commands`:

```json
{
  "id": "client-generated-unique-id",
  "revision": 12,
  "controlId": "ctl_live"
}
```

Only a volume control can additionally send `value` (finite 0–100). Every other action uses the **desktop's saved configuration**; the phone cannot supply an action kind, OBS scene, shell command, executable, or path. Reject unknown fields, oversized IDs, missing controls, mismatched revisions, invalid values, and values on non-volume controls before any action.

- OBS: switch to the stored scene via the existing adapter.
- Microphone: read default system input, then set the opposite mute state explicitly.
- Media: invoke existing MPRIS play/pause adapter.
- Volume: set the supplied validated target, or the saved default when no target is supplied.
- Native inspector and remote execution share the same adapter instances. No duplicate credential/session store.

Outcome shape:

```json
{
  "id": "client-generated-unique-id",
  "state": "confirmed",
  "message": "Action confirmed.",
  "observed": {}
}
```

States are `pending`, `confirmed`, `not_applied`, `failed`, or `unknown`. `observed` is an optional typed adapter result with its observation time; never treat a configured default as a live device reading. A lost response/readback after a possible mutation is **unknown**, not proof of failure. No automatic mutation retries.

The phone allows one command request at a time and correlates the returned ID without optimistic native state. Completed typed outcomes and saved control labels appear in a collapsed **Activity** view (newest first, at most ten, memory only). Pending is marked on the key. A visible unknown-outcome warning remains outside Activity even after a later successful action; a new pairing/session or terminal/stop cleanup clears this local history and warning. Connection status remains visible. Volume movement updates a local **target**, not an observed reading; only a deliberate pointer release or value-key release commits. Cancellation, blur, or disabling the control cancels that gesture. A stale-revision 409 resyncs reads only. Timeout, lost/unreadable reply, or interruption after a possible action shows **Unknown — check the desktop before retrying**. No offline queue or application-level POST retry exists. Browser/transport behavior can still repeat an identical request, so server deduplication remains necessary.

### Bounded deduplication

- Reserve `(device ID, command ID)` atomically **before** running the action. Serialize action execution to keep toggles ordered and resource use bounded.
- Cache the fingerprint and result for five minutes, with a finite global capacity (initially 256 commands); pending reservations cannot be evicted to make room for new work. Reject when full before executing.
- Identical duplicate requests return the pending/cached result; same ID with different input is a conflict. They never repeat the side effect, even if the deck revision later changes.
- `GET /api/v1/commands/<id>` reads that device's pending/cached result. A client may inspect an ambiguous result after reconnect; it must not replay a mutation automatically.
- Expired/missing results are unknown to the client, not permission to silently retry. This is **not exactly-once execution across crashes/restarts or beyond the retention window**.

## Verification before calling it working

- Test invalid/expired/reused invitations, explicit approval, missing/pending/revoked credentials, wrong Host/Origin, rejected values/payloads/revisions, and revoked sockets.
- Test duplicate and concurrent commands with an injected fake system runner: one execution, stable result, no live audio/media changes.
- Test saved-deck changes over a real local socket, restart/resync semantics, server stop/start cleanup, and resource caps.
- Browser-test the phone against the actual Rust service with owned fake adapters and an isolated local HTTPS proxy, not a mocked fetch-only API. Test TLS bypasses, if needed for a disposable browser profile, must never become installation guidance.
- `npm run smoke:remote` runs an opt-in actual-service browser fixture with built assets, fake actions, private stdio administration, loopback HTTPS, and disposable Chrome. Test-only certificate bypass and hostname mapping must never be offered as installation instructions. The default Rust suite ignores this fixture.
- Real Tailscale Serve, phone Home Screen install, native GUI/bundled-resolver behavior, and LAN-only HTTPS are separate manual/device validation gates. Do not configure the user's services automatically.
