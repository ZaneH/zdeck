# zDeck Home Assistant plugin

Self-contained Home Assistant REST plugin for ZDeck. It needs an installed Node.js **22.18.0 or newer**; Node is not bundled. It uses the built-in `fetch` and has no runtime dependencies beyond `@zdeck/plugin-sdk`.

## Install and configure

From the repository root run `npm run build`, then
`npm run plugin:package:home-assistant`. Copy the **complete** generated
`dist/plugins/home-assistant/` folder into the plugin folder shown by desktop
Settings. Packaging is offline: it does not install, enable, connect or control
anything. A later frontend build may clear `dist`, so package after building.

Refresh the catalog, choose Enable and **Trust package**, then expand
**Connection settings → Load settings**. Apply the URL and token, enable
separately, and choose **Read state**. Add a plugin control and select its entity
in the Inspector. Apply persists immediately without a network request; disable
before editing settings. **Forget Long-lived access token** removes the saved
secret (it does not revoke the token at HA). Secrets use macOS Keychain, Windows
Credential Manager or Linux Secret Service through the host; an unavailable or
locked store produces a visible error with no plaintext fallback.

One enabled plugin controls **one** Home Assistant instance. Configure:

- **Home Assistant URL** — an origin only, for example `https://ha.example.com:8123` or `http://192.168.1.10:8123`. Paths, queries, fragments and credentials in the URL are rejected.
- **Long-lived access token** — created in Home Assistant under your user profile. The host stores it as a secret; the plugin itself never returns or logs it.

Plain HTTP is only accepted for loopback, private and link-local IPv4 addresses (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`) and any hostname ending in `.local`, `.lan` or `.home.arpa` (the suffix allowlist does not verify DNS resolves privately). `http://localhost` is rejected; use its address or a local hostname. **Plain HTTP sends the bearer token unencrypted over the LAN.** Prefer trusted HTTPS, especially on shared or untrusted networks. The plugin disables redirects and refuses responses larger than 1 MiB.

## Controls

Actions use Home Assistant's REST API, verified against the official [REST API](https://developers.home-assistant.io/docs/api/rest/) and [authentication](https://developers.home-assistant.io/docs/auth_api/) documentation: `Authorization: Bearer <token>`, `GET /api/states`, and `POST /api/services/<domain>/<service>`.

- **Power** — `entity` plus `enabled` (on/off). Sends `light.turn_on`, `light.turn_off`, `switch.turn_on` or `switch.turn_off`. There is no toggle call.
- **Brightness** — `entity` plus `brightness` 0–100. Sends `light.turn_on` with `brightness_pct`; `0` sends `light.turn_off`. Only lights whose `supported_color_modes` contains a recognized dimming mode (`brightness`, `color_temp`, `hs`, `xy`, `rgb`, `rgbw`, `rgbww` or `white`; never `onoff` or `unknown`) are offered, following the [light entity semantics](https://developers.home-assistant.io/docs/core/entity/light/).

Discovery reads `GET /api/states` and exposes only `light.*` and `switch.*` entities. Choice labels show the honest last-observed `on`, `off` or `unavailable` state and, when known, the current brightness. Unavailable entities are listed as unavailable and cannot be executed. The returned arrays are bounded to 100 entries each, labels are bounded to 160 UTF-8 bytes, and the whole state stays under the SDK response limit. The URL and token are never included in state.

### Stable entity selection

A saved control stores a 48-bit value derived from the normalized configured origin and entity ID (`SHA-256(origin + "\n" + entity_id)` first six bytes), never a discovery index. Changing the URL/origin invalidates old controls rather than retargeting same-named entities on another instance. Reordering discovery does not change it. Colliding values are omitted, and a value already bound to a different entity ID in this process is never silently retargeted. If an entity is renamed, the old saved value has no binding and fails closed; choose the entity again in the inspector. The plugin does not guess. This is an entity-ID binding, not immutable physical-device identity: reusing the same entity ID at the same origin refers to that ID's current device. A simultaneous hash collision is rejected, and a different ID colliding with one seen in this process is rejected; the 48-bit fingerprint is not a cryptographic identity guarantee across process restarts.

### Delivery and readback

After **every enable/restart or settings configuration**, explicitly **Read state** before running actions. Until a read succeeds the plugin refuses commands without sending a POST, including via the phone. Before every command the plugin reads current state to verify the entity still has the expected domain, is available, and supports brightness when needed. After a successful service POST it observes the entity with `GET /api/states/<entity_id>` using short, bounded read-only polling. It never retries the POST.

Any uncertain delivery, readback failure or observed-value mismatch raises `outcome_unknown` and latches the plugin. Further executes are refused without network access until an explicit **Read state** succeeds and reconciles the current state. The zDeck host stops the process on any wire error: explicitly re-enable it, then Read state; a fresh process also refuses actions until this read. There is no implicit replay. A 401/403 rejection reports `authentication_failed`; other 4xx service rejections report `command_failed`; 5xx, 408 and transport failures are treated as uncertain. Execute errors are conservatively marked outcome unknown by the shared SDK once the handler is entered, even for a preflight rejection. Brightness readback must round to the requested percentage; devices that clamp/quantize differently produce an uncertain outcome rather than a false success. Documents are never written through the plugin: state changes use services only.

## Development

```sh
cd plugins/home-assistant
node --test test/*.test.js
```

Tests use only injected `fetch` fakes and Node built-ins: no installed Home Assistant, credentials or devices are contacted. They cover settings and origin validation, auth headers, discovery filtering and stable values, reorder/rename/collision/replacement behavior, argument validation, unavailable and unsupported-brightness rejection, successful readback, mismatch and transport uncertainty and latching, the no-POST-retry rule, redirect rejection, streaming caps and secret non-exposure. The plugin core takes `PluginError` by injection; `main.js` imports it from the SDK.

`describe` only reads the manifest and performs no network request:

```sh
# From the repository root, after offline packaging:
printf '{"protocolVersion":1,"id":"d1","type":"describe"}\n' | node dist/plugins/home-assistant/main.js
```

For distribution, use the same offline, self-contained folder layout as the Spotify plugin: copy `manifest.json`, `main.js`, `home-assistant.js`, `package.json`, `README.md` and `LICENSE`, plus real SDK files under `node_modules/@zdeck/plugin-sdk` (`index.js`, `index.d.ts`, `package.json`, `LICENSE`). Do not install dependencies or distribute a development `node_modules`. The plugin requires the SDK release that adds `settings`, `choicesKey` and `configure`; an older SDK rejects this manifest.

The source dependency points to the local SDK because the published npm 0.1.0 package does **not** support these extensions. The offline packager copies the current repository SDK as regular files and rewrites distribution metadata; recipients run no npm install. Keep `manifest.json` and the runtime `describe` metadata identical. Settings are capped at 2048 UTF-8 bytes per value and 2400 UTF-16 bytes for the entire native storage envelope.

## Security and limits

The plugin is trusted local code, not a sandbox. It holds a Home Assistant bearer token in process memory, sends it only to the configured origin, and makes no other network requests. It does not read files, run commands or log request data. Response bodies are capped, errors are fixed SDK codes without server payload echoes, and the plugin returns only bounded choice arrays.
