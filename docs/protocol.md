# Private prototype protocol (v1)

Implementation contract for the first remote controller. This describes intended behavior; the roadmap/README record what has actually been verified.

## Scope and trust

- Explicitly enable a Rust service on **127.0.0.1**, default port **45829**. No public/LAN listener or automatic Tailscale configuration.
- User explicitly chooses **Tailscale** or **Local HTTPS**, configures a stable trusted HTTPS origin, and supplies an external HTTPS-to-loopback reverse proxy. Tailscale uses Serve; Local HTTPS needs no Tailscale. No public tunnel, Funnel, HTTP fallback, certificate bypass, or automatic network/certificate/firewall/proxy setup is provided.
- The service serves the bundled PWA and `/api/v1/*` from that same origin. It does not expose Tauri IPC, OBS settings/passwords, arbitrary commands, filesystem paths, or deck editing over HTTP.
- Network access (tailnet or LAN) is not application authorization. Every device requires desktop approval.
- Native settings and approved device verifiers persist in a separate bounded, validated, versioned `remote.v1.json` app-data file, using same-directory temporary writes, file sync and atomic replacement like DeckStore. Only approved credential hashes, request IDs, names and pairing wall-clock timestamps persist, never raw bearer tokens. Invitations, pending requests, rate limits and caches stay ephemeral. Corrupt/unsupported files remain untouched and block trust restoration with an actionable Settings error; settings failures never block application launch.
- All API responses, including errors, use `Cache-Control: no-store`. Static assets contain no secrets and keep the existing exact-allowlist PWA cache policy.
- The service rewrites `data-zdeck-local` to `data-zdeck-remote` in its index before serving or caching it. Missing/invalid index markers fail closed; missing bundled assets cannot fall back to the editor index. All remote routes remain remote. This marker is UI routing only, never authentication.

## Connection modes and origin validation

Native `remote_start` accepts `{ origin, mode?: "tailscale" | "local_https" }`; omitted mode defaults to `tailscale`. Status includes `mode`, equal to the running mode or `null` when stopped. Both modes still bind plain HTTP only on **127.0.0.1:45829**, never a LAN listener. Mode changes require stopping the service first. A normalized origin/mode change clears the single durable allowlist; switching back cannot resurrect old approvals. Stop/Start at the same scope preserves approvals.

- **Tailscale:** HTTPS DNS host ending in `.ts.net`, default port 443 only.
- **Local HTTPS:** HTTPS with canonical RFC1918 IPv4 (`10/8`, `172.16/12`, `192.168/16`), IPv6 ULA (`fc00::/7`) or link-local (`fe80::/10`), or ASCII DNS ending in `.local`, `.lan`, or `.home.arpa`. Explicit ports 1–65535 are accepted; 443 canonicalizes away. These are address syntax checks, not proof of ownership, resolution, certificate trust, or reachability. Link-local IPv6 without a zone may not be usable on a particular network; zone identifiers are rejected.
- Both reject credentials, non-root paths (including normalized dot paths), query/fragment syntax (even empty), whitespace, Unicode/IDNA input, percent escapes, backslashes, wildcard/invalid DNS labels, trailing dots, empty/zero/leading-zero ports, IPv4 aliases (octal, hex, integer, shorthand), and IPv6 zone identifiers. A single trailing root slash is allowed. Input is bounded to 2048 ASCII bytes. DNS case, default HTTPS port and IPv6 representation are canonicalized. Local mode rejects public addresses/domains, loopback, IPv4 link-local and CGNAT; Tailscale mode does not accept local addresses.

Settings has keyboard-accessible tabs. Browser preferences restore the explicitly chosen mode and last **successfully started** origin for each mode. Separately, a successful explicit native Start opts into service restoration on app launch using native saved origin/mode; explicit Stop disables auto-start without forgetting approved devices. Native setup is the sole startup authority; the frontend only reads its status and never retries a failed restore. The obsolete browser `deck.remote.desired.v1` preference is ignored, left untouched, and never migrated over native settings. Users with only that legacy preference must explicitly Start once to opt in. No polling or retry loop opens a listener. Startup bind/load/write failures appear in Settings. The legacy `deck.remote.origin.v1` key remains the tailnet preference; `deck.remote.local-origin.v1` holds the local origin and `deck.remote.mode.v1` only the mode enum. Running status hydrates the active tab/address in memory, without persisting status or overwriting edited drafts. No pairing link, token, cookie or approval is stored in these preferences.

## Local HTTPS setup

This is a **manual example**, not a claim of tested LAN connectivity. Install tools yourself if you choose this method. The app does not run these commands. Both devices need a permitted, mutually reachable network. Wi-Fi client isolation, routing, name resolution and firewall policy can prevent access; use a permitted home network or hotspot if appropriate, not an administrator-policy bypass. A `.local` name is not guaranteed to resolve.

1. Choose this computer's **actual stable private IP** (or a local name that your phone resolves). Every `192.168.1.20` below is an example to replace, including the certificate name, Caddy listener/bind address and Settings URL. Keep the scheme, name/IP and port stable; reserve the address on a network you control if appropriate.
2. With user-installed **mkcert**, create and deliberately trust your own development CA:

   ```sh
   mkcert -install
   mkcert -CAROOT
   mkcert -cert-file zdeck-cert.pem -key-file zdeck-key.pem 192.168.1.20
   ```

   Review the trust implications before running `mkcert -install`: a trusted CA can authenticate arbitrary HTTPS sites, not just zDeck. Trust only a CA you personally control. Securely transfer **only `rootCA.pem`**, the CA certificate in the directory printed by `mkcert -CAROOT`, to your own phone. **Never transfer `rootCA-key.pem`, `zdeck-key.pem`, or any private key.** Keep those keys protected on the desktop. On iOS, explicitly install the certificate profile in Settings → General → VPN & Device Management (or Profile Downloaded), then separately enable full trust under Settings → General → About → Certificate Trust Settings. Review/remove that trust when no longer needed. Android trust/install behavior varies by OS/browser; verify the phone accepts the certificate without a warning rather than assuming desktop trust transfers.
3. With user-installed **Caddy**, save this as `Caddyfile`. Replace the example IP and both `/absolute/path/...` placeholders with your actual private interface address and generated certificate/key paths. Review existing proxy configurations and port use first; do not overwrite them blindly.

   ```caddyfile
   {
     auto_https disable_redirects
   }
   https://192.168.1.20:8443 {
     bind 192.168.1.20
     tls /absolute/path/zdeck-cert.pem /absolute/path/zdeck-key.pem
     reverse_proxy 127.0.0.1:45829
   }
   ```

   Run it explicitly with `caddy run --config ./Caddyfile`. The global option prevents unrelated automatic HTTP redirects on port 80; the explicit TLS certificate avoids automatic certificate issuance. The listener binds only the chosen private interface. Its port must be reachable under your network/firewall policy. The HTTP upstream preserves the incoming **Host** and **Origin** by default: do not rewrite them to the loopback address. zDeck ignores forwarded headers for its origin/identity boundary.
4. In native **Settings → Phone connection → Local HTTPS**, enter `https://192.168.1.20:8443` with your actual address and start the local service. On the phone, open that HTTPS root **without a certificate warning**, install the PWA if wanted, and use a fresh pairing link within that browser/installed-app session. Approve the request on the desktop. Being on the LAN or trusting the CA is not approval.

If the origin (scheme/name/IP/port) changes, re-pair and remove/reinstall the PWA at the new origin as needed; mint a new certificate if its IP/name changes. After one pairing, bookmark or revisit the same HTTPS root in the same browser/installed app. Stop/Start and app restart preserve approved credentials at that scope; Revoke removes the durable approval and invalidates live sockets. Approval is not reported before a successful durable write. A failed revocation pauses all phone access for the current process, returns an error, and does not claim the device is durably forgotten. Restarting may restore access from the unchanged allowlist: repair storage and retry Revoke successfully before restarting. A failed Stop still closes the listener but warns that next-launch auto-start could not be disabled. Do not weaken HTTPS, browser secure-context checks, Host/Origin enforcement or cookie authentication to troubleshoot connectivity.

## Request boundary

- Validate `Host` against the configured HTTPS authority or exact loopback upstream authority. Do not trust arbitrary forwarded headers to select an origin or identity.
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
3. Phone `POST /api/v1/pair` with `{ invitation, name }`. Consume the invitation atomically once; enforce expiry, limits, and bounded name. Return `{ requestId, status: "pending" }` and set the provisional device cookie: `__Host-deck-device`, Secure, HttpOnly, SameSite=Strict, Path=/, no Domain, Max-Age=15552000 (180 days). The server enforces the same fixed lifetime from pairing using persisted wall-clock timestamps; neither approval nor resume renews it. Expired or future-dated records grant no access.
4. Desktop shows the pending request/name and approves or denies it. The invitation alone does not authorize an action.
5. Phone polls `GET /api/v1/pair/status` about every two seconds, without overlap, until approved/denied/expired. Cookie identifies only its own pending request. Pause on hide and stop on terminal status/cancellation. Cancellation is local, not a promise of server denial. Resume uses non-mutating status reads; it never repeats the pairing POST.
6. On approval, that cookie becomes an active device credential. On denial/expiry/revocation, it has no deck or action access. Cap pending lifetime; do not retain abandoned secrets indefinitely.

Avoid access/request-body logging of invitations or cookies. Invitation matching and registry updates are atomic. Pairing request IDs and display names are metadata, not authorization secrets.

## Explicit dashboard observation

`GET /api/v1/readings/{savedControlId}` refreshes a saved read-only plugin value. It requires an approved strict device cookie and the normal exact Host guard; an Origin header, when present, must match, and cross-site Fetch Metadata is refused. Same-origin GET fetches normally omit Origin. The route resolves `presentation: "value"` and its declared binding from the saved deck, never accepts plugin arguments, services, credentials or launch paths, and cannot call `execute`. The existing per-device rate budget and dispatcher try-lock bound reads. It returns the standard `{protocolVersion,revision,deck,plugins}` snapshot plus `readingFailed: boolean`, without command admission, IDs, Activity, result replay or automatic retry. Read failures project stopped/unknown plugin state; transport failures leave the last timestamp visible with a reading error. Other values remain timestamped observations, not live subscriptions. Cached state/socket snapshots do not initiate plugin reads. The client only offers this deliberate refresh while foreground and connected, including when desktop actions are disarmed.

Plugin presentation snapshots now include only declared top-level booleans and projected choice observations referenced by boolean controls or separate `values` bindings; arbitrary plugin state and unknown nested choice fields are excluded. Saved value controls cannot be submitted to `/commands`, with or without scalar targets. Ship updated desktop and phone assets together; older clients may reject the new manifest/presentation fields.

## Deck snapshots and synchronization

- `GET /api/v1/state`: authenticated `{ protocolVersion: 1, revision, deck }` from the desktop's durable deck store. Never send a sample deck to conceal a storage error.
- `GET /api/v1/events`: authenticated WebSocket upgrade; exact Origin required. Sends `{ type: "snapshot", protocolVersion: 1, revision, deck }` immediately and after successful native deck saves.
- A revision describes the complete deck, not an incremental patch. Reconnect/resume always gets a fresh snapshot, so missed messages require no replay log.
- Canonical deck snapshots are version 3: every page has at least one ordered section, and every section carries its own ordered controls. Persisted version 1 and 2 documents are migrated to version 3 in memory only at the trusted native/local load boundary; the wire is never normalized. A snapshot with legacy pages, unknown fields, duplicate/empty section IDs, blank names or invalid section overrides is rejected rather than repaired.
- An old phone build that cached the version 2 client skips version 3 snapshots because its local validator is version 2-only. It rejects the snapshot, keeps controls disabled and cannot send actions until the page is reloaded (or the installed PWA is updated) to the matching version 3 client. The desktop must not downgrade or normalise snapshots for that old client; reloading the phone is the supported path.
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
- Real Tailscale Serve, trusted-certificate LAN proxy/phone connectivity, phone Home Screen install, and native GUI/bundled-resolver behavior remain separate manual/device validation gates. Do not configure the user's services automatically.
