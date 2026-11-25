# Process plugins: SDK and Spotify developer preview

## Implemented vs planned

Implemented: an MIT-licensed npm-ready SDK, protocol v1, typed author example, Rust process host shared by desktop and phone, local plugin-folder discovery, Node detection, explicit trust/enable controls, generic deck actions, and a macOS Spotify reference plugin. There is no runtime bundling, automatic download/update, persistent enabling or marketplace. One plugin can be active per desktop session. The existing default-MPRIS media action is separate from Spotify. `docs/protocol.md` describes the phone protocol, not this stdio protocol.

The SDK is plain ESM JavaScript plus `.d.ts`, with explicit package exports and no dependencies or build scripts. An **installed Node.js >=22.18.0** is required, including for Spotify; npm distribution is not end-user runtime distribution. Node >=22.18 runs the included `.ts` example using native type stripping, not typechecking. No `tsc` is required to pack, run or test. Consumers using a TypeScript compiler supply their usual Node types. This preview was exercised on Node 26.12.1; the declared minimum was selected for stable built-in type stripping but was not separately exercised here.

## Install Spotify in the desktop app

Node.js **22.18.0 or newer** must be installed. Desktop Settings detects it using PATH and common runtime locations, including Homebrew locations used by macOS apps launched from Finder. No Node path entry is required. If Node is missing or too old, install a supported version and choose **Refresh**.

For developers distributing the included plugin, build the app first, then prepare the self-contained plugin folder:

```sh
npm run build
npm run plugin:package:spotify
```

The result is `dist/plugins/spotify/`, including the SDK runtime and licenses. A later frontend build can clear `dist`, so package after building. Distribute the **complete folder**; copying `plugins/spotify` directly from the source tree is not a supported installation. The source dependency now pins the published SDK version `0.1.0`; the generated folder includes real SDK files and version-only metadata, so recipients do not need npm or a repository checkout. Nothing is published, installed or enabled by the packaging command.

For users:

1. Open desktop **Settings → External plugins → Open plugin folder**.
2. Copy the complete `spotify` folder into `~/.config/zdeck/plugins/` (Linux honors an absolute `XDG_CONFIG_HOME`). The files should include `plugins/spotify/manifest.json` and `plugins/spotify/main.js`, without an extra nested folder.
3. Choose **Refresh**. Find the Spotify row, choose **Enable**, review its source/license and access, explicitly check the initially unchecked trust consent, then confirm **Enable plugin**. Enabling starts the process and reads its description only—not Spotify state or playback.
4. Open Spotify manually. Expand the row’s **Actions and last read state** and choose **Read state** when ready to request macOS Automation consent. Track information is the last successful read, not a live background feed.
5. Use **Add control → Plugins** to add an action, configure its integer arguments in the Inspector, and deliberately run it. Saved controls can also be executed from the authenticated paired phone; phone requests cannot specify executable paths or arbitrary plugin arguments. Preview remains simulated.

Refresh only discovers metadata and probes Node; it never enables a plugin. Invalid/incompatible folders are shown with a reason. Folder names must match manifest IDs; folder and entrypoint symlinks are rejected. Discovery is limited to 64 directory entries, with an explicit warning and enabling disabled when truncated. The Node path and plugin directory are read-only setup details, not routine inputs.

Up to **16 plugins** can be enabled independently in one session. Each row has its own status, busy/error state, trust confirmation and **Disable** action; disabling or failing one plugin does not disconnect another. All healthy enabled manifests contribute actions to the action library, and a saved control always uses its own plugin ID. Enabling is session-only; after an error, fix the cause and explicitly acknowledge trust again. Refresh clears pending trust without disabling cached enabled sessions. Nothing automatically reconnects, polls state, enables or replays an action. Plugins run with your user-level OS permissions, **not in a sandbox**. Never install code you do not trust. No npm commands or dependency installation are required for recipients of the prepared folder.

Use the row’s keyboard-accessible **⋯** menu for **Diagnostics** or **Uninstall…**, including invalid SDK installations with a valid folder ID. Diagnostics inspect local installation checks without executing a plugin or reading media state. SDK symlinks and source/developer npm layouts are not distribution installations: copy the complete prepared folder, including its real `node_modules/@zdeck/plugin-sdk` files. Do not suggest or run `npm install` as a repair for a distributed plugin; the separate developer workflow below is not an end-user installation method. Untrusted diagnostic text is replaced with bounded local guidance.

**Uninstall…** first asks for confirmation. Confirming stops only that plugin, removes it from the catalog, and moves the folder to `~/.config/zdeck/plugin-backups` (the corresponding configured location on Linux), rather than permanently deleting it. Recover a backup manually into the plugin directory, Refresh and explicitly enable with fresh trust. Saved deck buttons are preserved but cannot run while their plugin is absent. Neither diagnostics nor uninstall runs automatically.

Desktop startup requests `plugin_catalog` and cached `plugin_snapshots` only. Native lifecycle operations `plugin_enable`, `plugin_disconnect`, `plugin_snapshot`, `plugin_state`, `plugin_diagnostics` and `plugin_uninstall` take `{pluginId}`; execute additionally takes `{actionId,args}`. Snapshot-map keys must match manifest IDs. No operation can redirect a saved action to a different enabled plugin.

Deck schema v2 stores only plugin IDs, action IDs and bounded integer arguments—not launch paths or secrets. Valid v1 decks migrate in memory; migration alone does not rewrite stored data. A later explicit edit/save writes v2. The native filename remains `deck.v1.json`; older app versions cannot read the new schema.

## Develop the Spotify source plugin

`@zdeck/plugin-sdk@0.1.0` is published on the public npm registry. The reference plugin now pins that exact version:

```sh
npm install --prefix plugins/spotify --ignore-scripts --no-audit --no-fund
printf '{"protocolVersion":1,"id":"dev","type":"describe"}\n' | node plugins/spotify/main.js
```

The lockfile records the public registry tarball and its integrity, not a local `file:` resolution or `link: true`. npm installs the SDK as a real directory; no sibling SDK source tree is required. The plugin-only `.npmrc` retains `install-links=true` for intentional local-file experiments, but normal development uses the registry version. Offline tests substitute a local SDK only inside isolated temporary fixtures.

Running this command updates dependency-managed files in the repository plugin, not a separate installed `~/.config` copy. Older installed source metadata or SDK symlinks are not automatically repaired. The desktop catalog continues to reject symlinks; replace an old installation with the complete packaged artifact after reviewing/backing it up.

The request above is **describe only**, with no Spotify access or Automation prompt. Use `npm run plugin:package:spotify` for installation or distribution: it copies SDK runtime files directly from the repository's SDK source and records the bundled version. Recipients run **no npm install**. The source `.npmrc` and lockfile are not distributed.

## SDK author quickstart (local artifact, no dependency install)

From the repository root, on macOS or a Unix development machine with Node, npm and tar:

```sh
REPO="$PWD"
WORK="$(mktemp -d)"
(cd packages/plugin-sdk && npm pack --ignore-scripts --pack-destination "$WORK")
mkdir -p "$WORK/node_modules/@zdeck/plugin-sdk"
tar -xzf "$WORK/zdeck-plugin-sdk-0.1.0.tgz" --strip-components=1 \
  -C "$WORK/node_modules/@zdeck/plugin-sdk"
cp "$WORK/node_modules/@zdeck/plugin-sdk/examples/hello.ts" "$WORK/hello.ts"
printf '{"protocolVersion":1,"id":"d1","type":"describe"}\n{"protocolVersion":1,"id":"a1","type":"execute","action":"increment","args":{}}\n{"protocolVersion":1,"id":"s1","type":"state"}\n' \
  | (cd "$WORK" && node hello.ts)
```

Expect three JSONL results: the `hello` manifest, `{ "count": 1 }`, then the same state. EOF ends the process. The SDK is also published as `@zdeck/plugin-sdk@0.1.0`. This local-tarball workflow deliberately avoids npm lifecycle scripts and registry access, and can be used to test reviewed SDK source changes before a future release.

To stage Spotify against the same public package (no relative SDK-source imports), copy only runtime files, not development `node_modules` or the source lockfile:

```sh
mkdir -p "$WORK/spotify"
cp "$REPO/plugins/spotify/main.js" "$REPO/plugins/spotify/spotify.js" \
  "$REPO/plugins/spotify/manifest.json" "$REPO/plugins/spotify/package.json" "$WORK/spotify/"
printf '{"protocolVersion":1,"id":"d1","type":"describe"}\n' \
  | (cd "$WORK" && node spotify/main.js)
```

`describe` does not touch Spotify or request permissions. Do not send `state` or `execute` unless you intentionally want to access the installed application. The desktop host detects Node and launches the installed folder's fixed `main.js` entrypoint without a shell. Desktop plugin enabling uses catalog discovery and the validated fixed entrypoint; no manual runtime/entrypoint launch IPC is exposed. The manifest contains **no executable details**. Never accept executable paths from remote requests, deck imports or manifests.

### Verification

```sh
(cd packages/plugin-sdk && npm test)
```

This runs the SDK suite locally, then `npm pack --ignore-scripts` into a fresh temporary directory, checks its exact file allowlist, extracts it, and uses `node --test` to run SDK and Spotify fake-runner suites against the **packed public import**. It also runs the TypeScript quickstart and Spotify `describe` as real child processes. Only Node built-ins and local npm/tar are used. No publishing, dependency installation, live Spotify call or permission prompt is part of the tests. Temporary artifacts are removed after the check.

## SDK publication (maintainer only; 0.1.0 published)

The package remains `@zdeck/plugin-sdk@0.1.0`, ESM-only, MIT-licensed, with no runtime dependencies. Public access is configured in `packages/plugin-sdk/package.json`; the public runtime, declarations, typed example, README and license are the only packed files.

Version **0.1.0** has been published and verified against the public registry. Its integrity is `sha512-6TrAo35L2qjpfnlIIWsM3s2oXOYkOey7kb5yOkdjaSdUrnAqpbflgWqaQaB0RJxkEEspvXxlcoOjRHfPeQF4Zg==` and SHA-1 is `9a4f090bc79f961897c2ca9b04dfb0c869799e4d`.

For future releases, the maintainer must authenticate externally, confirm publishing rights under **`@zdeck`**, and deliberately choose a new version. Do not republish or modify the released 0.1.0 artifact, and do not put credentials in project files, chats or logs.

After authentication and scope verification, from `packages/plugin-sdk`:

```sh
npm test
npm pack --ignore-scripts --dry-run --json
npm publish --access public --ignore-scripts
```

The publish command is an intentional maintainer action for a future version, not part of tests or packaging. Verify the registry version and tarball integrity after every release. The Spotify source dependency is now pinned to the verified registry version 0.1.0. Publishing the SDK alone does not repair any existing installed plugin directory.

## Protocol v1 (Rust host handoff)

Transport: UTF-8 JSON objects, one per LF-terminated line on stdin/stdout, no banner or console logging on stdout. CRLF is accepted (CR is JSON whitespace). Invalid UTF-8, blank lines and non-object JSON are errors. Every request carries `protocolVersion: 1` and `id`: 1–64 ASCII letters, digits, `_` or `-`. Hosts must generate unique IDs for correlation; the SDK does **not** deduplicate requests or retain an ID cache. Reusing an ID can repeat an action.

Exactly these request shapes are allowed; unknown fields are rejected:

```json
{"protocolVersion":1,"id":"d1","type":"describe"}
{"protocolVersion":1,"id":"s1","type":"state"}
{"protocolVersion":1,"id":"a1","type":"execute","action":"set-volume","args":{"volume":50}}
```

Success responses carry the same ID, version and `type: "result"`, with **either** `manifest` for describe **or** `state` for state/execute:

```json
{"protocolVersion":1,"id":"s1","type":"result","state":{"title":"Example","artist":"Artist","playback":"playing","volume":50}}
```

`execute` returns fresh observed state, not a bare acknowledgment. Spotify executes the command then reads state; readback failure is `outcome_unknown`. A successful result reports a completed command/readback, not a guarantee that another app/user cannot immediately change playback. Generic SDK state is a JSON object; individual plugins define its fields.

```json
{"protocolVersion":1,"id":"a1","type":"error","error":{"code":"invalid_arguments","message":"Action arguments do not match its configuration.","hint":"Use only declared fields within their integer bounds.","outcome":"not_started"}}
```

Malformed framing/JSON/IDs use `id: null` if a valid ID cannot be recovered; a valid ID survives other request-validation failures. `error.code`, `message`, `hint` and `outcome` are always present. Messages/hints are SDK-owned fixed strings; thrown strings, raw exception messages, process stderr and request data are not echoed. `outcome: "not_started"` means the execute handler was not entered; `"unknown"` means it was entered and a side effect **might** have happened, even for errors from a preflight check. Error code alone is not permission to retry.

### Bounds and lifecycle

- Requests: **16,384 bytes excluding LF**; CR, if used, counts. Oversize lines are discarded through LF with one `request_too_large` error, then framing recovers. A trailing nonempty line without LF is `invalid_request`; an oversized unterminated line is `request_too_large`. EOF with no pending bytes is clean.
- Responses: **65,536 bytes excluding LF**. Oversized serialized results become `response_too_large`. No events/background polling in v1. Handlers are trusted local code and must construct bounded JSON state; this serialization cap is not a memory sandbox for malicious plugin code.
- Manifest: **16,384 serialized UTF-8 bytes**, 1–32 actions, 0–8 config fields per action. Schema below is deliberately narrower than JSON Schema.
- Sequential processing: the host sends one request and awaits its response before sending another. The SDK processes pipelined lines sequentially and respects stdout backpressure, but hosts must not build unbounded queues. Bound host stdout/stderr reads, total logs and process lifetimes independently.
- Handler deadline: **10 seconds**. SDK supplies an `AbortSignal`, sends `timeout` and stops serving more requests. Abort is cooperative; a handler may still be alive or have changed external state. Host must reap/kill an unresponsive child (including one stuck in synchronous code or blocked output). Recommended host deadline: **12 seconds**, then terminate; do not assume the SDK timer can enforce OS isolation.
- EOF: finish complete received requests sequentially, reject a partial last line, then return. No shutdown message, cancellation message, streaming state or automatic restart/retry is implemented. Host closes stdin, waits a bounded grace period, then terminates a stuck process. Crash/pipe closure without a correlated result leaves an in-flight action uncertain.
- **Never automatically retry side-effecting actions**, including after timeout, crash, lost output or restart. Reconnect with describe and read state, then let the user decide. `next`, `previous` and `play-pause` are particularly unsafe to repeat.
- All logs belong on **stderr**, never stdout. Host must cap/drain stderr separately and avoid retaining track metadata or secrets in support logs. The reference entry point emits only a fixed transport-failure diagnostic. There is no automatic logging/retry loop.

### Manifest and configuration

```json
{
  "id":"spotify", "version":"0.1.0", "protocolVersion":1,
  "actions":[
    {"id":"play","title":"Play","config":{}},
    {"id":"set-volume","title":"Set volume","config":{"volume":{"type":"integer","minimum":0,"maximum":100}}}
  ]
}
```

Manifest/action/config IDs: `[a-z][a-z0-9-]{0,63}`; action IDs unique within the manifest. Versions: three dot-separated 1–4 digit numeric parts (no prerelease/build syntax yet). Titles: 1–80 UTF-16 code units, no ASCII control characters. Unknown manifest, action and config-schema fields are rejected. Integer bounds must be ordered safe JavaScript integers (±9,007,199,254,740,991). Every declared config field is required at execute time; extra fields, strings, fractional values, null and arrays are rejected. Empty configuration is exactly `{}`. No defaults, arbitrary text, secret fields, remote URLs or executable launch metadata are supported. Treat every manifest and request as untrusted at the host boundary too; an SDK validator cannot protect a host from a different implementation lying about its output. Do not store secrets in config or manifests.

## Spotify reference implementation

Supported: macOS Spotify desktop at `/Applications/Spotify.app`, already running, with a playable context. Actions: `play`, `pause`, `play-pause`, `next`, `previous`, `set-volume` (required integer `volume`, 0–100). Other actions take `{}`. The volume is **Spotify's player volume**, not system output volume. This is local desktop Automation, not Spotify Web API, OAuth, account/device selection, search, playlists or Linux MPRIS. No Web API developer access, client secret or account token is required; playback remains subject to the installed application's account/content restrictions. This slice makes no promise to bypass account restrictions or offer Web API parity.

The plugin uses `/usr/bin/osascript` directly (`shell: false`), fixed allowlisted **JavaScript for Automation (JXA)** scripts, and the `com.spotify.client` scripting dictionary. No arbitrary AppleScript/JXA source is interpolated: volume is validated before any process call and passed only as a numeric argv value, with an additional check in the fixed script. The installed `Spotify.sdef` was inspected for playback commands, current-track title/artist, player state and sound volume. The JXA binding itself has not been exercised against live Spotify in this slice.

Each invocation is capped at 3 seconds and 8,192 bytes for each captured output stream; timeout uses SIGKILL. A fixed running check occurs before state or commands, so the plugin does not intentionally launch Spotify. An installation/running check is not atomic: app closure mid-command can fail. State is read-only: `{ title, artist, playback, volume }`; title/artist are nullable strings capped at 2,048 UTF-16 code units each, playback is `playing | paused | stopped`, and volume is an integer 0–100. Stopped playback reports null title/artist. Track text is encoded with `JSON.stringify`, so quotes, tabs and newlines do not break JSONL.

### Error reference

Every code has a fixed actionable hint in the wire response:

| Code | Meaning / action |
| --- | --- |
| `invalid_request` | Fix version, exact fields, IDs, JSON, UTF-8 or framing. |
| `request_too_large` | Reduce the request below the byte cap. |
| `unknown_action` | Rediscover supported actions with describe. |
| `invalid_arguments` | Supply exactly the declared integer config within bounds. |
| `internal_error` | Unexpected plugin failure; inspect trusted local diagnostics, not raw errors over the wire. |
| `response_too_large` | Plugin author must return smaller state. |
| `timeout` | Operation deadline reached; restart if necessary and inspect state, no automatic retry. |
| `unsupported_platform` | Run Spotify plugin on macOS. |
| `app_missing` | Install readable Spotify desktop at `/Applications/Spotify.app`. |
| `app_not_running` | Open Spotify manually. |
| `automation_denied` | Allow the launching application to control Spotify in macOS Automation settings. |
| `command_failed` | Spotify/osascript failed, including unavailable osascript; verify installation/responsiveness. |
| `invalid_state` | Unexpected or oversized Spotify readback; check compatibility. |
| `outcome_unknown` | Command returned successfully but state readback failed; inspect state manually before retrying. |

### macOS permissions and troubleshooting

The first intentional state/action request may trigger macOS's Automation consent prompt for the responsible launcher (for example Terminal, or a future signed desktop host) to control Spotify. Approve only when you trust that launcher and plugin. If denied, open **System Settings → Privacy & Security → Automation**, find the actual launching application and enable Spotify. A terminal-based approval may not apply to a future desktop launcher. If no entry exists, deliberately run an operation from the intended trusted launcher to request consent; tests do not do this. Do not blanket-reset privacy permissions or grant Accessibility/Full Disk Access for this plugin. Locked-down/managed Macs may need administrator policy changes. Open Spotify yourself and establish a playable track/context before troubleshooting actions. On a readback error after a command, verify the UI or use a fresh state request before pressing again.

## Trust and remaining compatibility work

**Stdio is not a sandbox.** A Node plugin runs arbitrary code with the current user's filesystem, network and OS permissions. Fixed scripts protect this reference's input boundary, not an untrusted package in general. Review source, origin, MIT license, runtime requirements and expected Spotify Automation access before intentionally running it. No credential reads, capabilities enforcement, signature verification or OS isolation are provided. Never auto-execute a package on import/preview or accept a launch path from a phone/deck/remote manifest.

The Rust host in `src-tauri/src/plugin.rs` implements this language-neutral protocol without Node SDK internals and maintains independently bounded per-plugin sessions shared by native commands and the phone service. `plugin_install.rs` validates local folders, probes Node and revalidates the complete manifest contract before describing a selected plugin. Plugin launches remove `NODE_OPTIONS` and `NODE_PATH`. The host serializes requests, bounds response framing, discards stderr, and kills/reaps failed processes. Any wire error stops only that plugin’s host instance, not healthy neighbors; recover through explicit enabling, never automatic action replay. Known Spotify setup errors use host-owned messages and hints; arbitrary plugin diagnostics are not reflected. Unknown-outcome warnings appear alongside setup hints. Terminating the direct plugin child does not guarantee termination of grandchildren: an already-started external command may still apply after a host timeout.

Automated verification covers Rust host/discovery, schema migration, TypeScript bridge/control validation, packed SDK consumption, self-contained Spotify packaging, and browser flows with fake IPC. Live Spotify/JXA, Automation attribution, the real folder opener, signed macOS distribution and real-phone plugin execution remain unverified. Python authoring, events, richer schemas, secret injection, cancellation, bundled Node and cross-platform Spotify support are deferred. The npm SDK **0.1.0 is published**; installed plugin folders still require a complete SDK runtime, not a symlink.
