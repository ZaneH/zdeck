# @zdeck/plugin-sdk

MIT-licensed, zero-dependency ESM runtime with TypeScript declarations for ZDeck process protocol v1. Requires an **installed Node.js >=22.18.0**. No build step, TypeScript compiler, native module or bundled Node runtime. ESM import only; TypeScript tooling needs its normal Node type declarations for stream types.

```ts
import { serve, type Plugin } from '@zdeck/plugin-sdk';
```

Explicit public exports: `serve`, `validateManifest`, `validateArguments`, `PluginError`, `PROTOCOL_VERSION`, `LIMITS`, plus the types in `index.d.ts`. `examples/hello.ts` is a complete typed author example runnable with Node's native type stripping.

See the repository's `docs/plugins.md` for the protocol, tested local-tarball quickstart, security boundaries, desktop host integration and Spotify reference plugin. This npm package supplies only the SDK, not the desktop application or a Node runtime. A process is **not a sandbox**; only run code you trust.

From this package directory: `npm test` uses only Node built-ins, `npm pack --ignore-scripts` produces the distributable. The packed-artifact test also requires local `npm` and `tar`; it never installs dependencies, publishes, or invokes live Spotify automation.

## Installation and development

```sh
npm install @zdeck/plugin-sdk
```

End users of the desktop app receive the complete generated Spotify folder and run no npm install. Plugin authors can install this package normally from npm. Repository development can also use a local `file:../../packages/plugin-sdk` dependency with `install-links=true` to copy files instead of creating symlinks. This does not automatically migrate old development links or repair installed plugins.

## Shared icon packs (unreleased)

The repository SDK and updated app accept an optional `manifest.icons` array. This addition is **not in the published 0.1.0 SDK**: use a locally packed copy of this source until a new version is published. Older apps reject manifests with this field. Existing manifests without it still work.

```ts
import { readFileSync } from 'node:fs';
import type { Icon } from '@zdeck/plugin-sdk';

const icons: Icon[] = [{
  id: 'play', title: 'Play', category: 'Media',
  src: 'data:image/svg+xml;base64,' + readFileSync(new URL('./icons/play.svg', import.meta.url)).toString('base64'),
}];
// Include `icons` alongside id, version, protocolVersion and actions in your manifest.
```

Any control can use these icons, not just this plugin's actions. The picker groups them by plugin ID and category. Use short titles and recognizable artwork; SVGs should have a `viewBox` and explicit colors (image SVGs do not inherit the app's `currentColor`). For PNG, JPEG, WebP or GIF, use the matching `data:image/png;base64,`, `data:image/jpeg;base64,`, `data:image/webp;base64,` or `data:image/gif;base64,` prefix.

Separately, a manifest may declare one optional `icon` string as the plugin's own row thumbnail in Settings; it uses the same embedded-image validation and a generic fallback when absent. It is plugin identity, not part of the selectable action-icon pack.

Each icon has exactly `id`, `title`, `category`, `src`. IDs use the same rules as action IDs and must be unique within the pack. Titles/categories are nonblank, at most 80 UTF-16 code units, without ASCII control characters. At most 32 icons are allowed. Each source is a nonempty base64 data URL of at most **8192 characters**, and the **entire manifest still must fit within 16384 UTF-8 bytes**. Optimize artwork; these are small control icons, not album artwork. Paths, remote URLs, HTML and raw SVG markup are rejected. SVG is rendered through an image element, never injected into the page. Invalid image content falls back to the control's action icon.

When distributing a folder, `manifest.json` and the process's `describe` response must include identical icon metadata, just like actions. Keep any authoring assets available to the process if it reads them at startup, or pre-encode the data into both manifests during packaging. The selected image is copied into the deck for persistence and phone rendering without fetching assets or keeping the plugin enabled. The existing 256 KiB native deck-file budget still applies; many distinct large images can exhaust it. Resetting to the action default removes the saved override.

See `examples/hello.ts` for a self-contained SVG example. No icon-specific action execution, extra host permissions or network requests are required.

## Compatible control presentations (unreleased)

The updated app/SDK support optional `control` metadata on **at most one config field per action**. Older apps/SDKs reject it; distribute a matching locally packaged SDK and app until released. Existing fields without metadata retain saved-button behavior.

```ts
const actions = [
  { id: 'level', title: 'Level', config: {
    amount: { type: 'integer', minimum: 0, maximum: 100, control: { step: 1 } },
  } },
  { id: 'power', title: 'Power', config: {
    enabled: { type: 'boolean', control: { stateKey: 'enabled' } },
  } },
];
```

Numeric metadata offers slider/dial/button. Step and range width are positive safe integers; the range must have at least one step and both bounds must align (`maximum - minimum` is divisible by step). Values must be safe integers in bounds, aligned from minimum. Newly added numeric plugin controls default to slider; existing saved controls without `presentation` remain buttons. Numeric gestures preview locally and submit only on completed pointer/value-key adjustment, not movement, cancel or blur. While a request is busy, the latest deliberate numeric target replaces earlier queued targets; it sends with a new ID only after confirmation. Uncertain delivery, failure, navigation or a changed deck discards that queue rather than retrying.

Boolean fields accept only JSON booleans. `true` explicitly means **On**, `false` means **Off**; implement an idempotent setter, not a one-shot toggle command. `stateKey` is a plugin identifier naming a top-level observed boolean in returned state. It enables toggle switch/toggle button/button. Unknown/missing/nonboolean state disables live toggles; never invent playback state. Buttons still send their saved arguments. No metadata is inferred from names. Other config fields remain saved, strictly validated configuration.

Desktop and phone adjustment commands carry a scalar only (boolean targets use 0/1 on this transport). The server maps it into the sole declared field, converts boolean targets to JSON booleans, and validates presentation compatibility, bounds/step and the complete argument object before execution. Phone snapshots contain manifests and declared observed booleans only, not arbitrary plugin state. No new executable paths, arbitrary phone argument maps or automatic retries are introduced. Keep on-disk and describe manifests identical when packaging.

## Declared connection settings and selections (unreleased)

These optional protocol-v1 extensions require the updated app and SDK source
bundled together. They are **not in the published npm 0.1.0 artifact**. Older
apps/SDKs reject them; old manifests without the fields continue to work.

A manifest can declare at most four settings, for example
`settings: { url: {type: 'text', label: 'Server URL'}, token: {type: 'secret', label: 'Token'} }`.
Each key is a plugin identifier; labels are 1–80 UTF-16 units without ASCII control
characters. Implement `configure(settings, signal)` when declaring settings.
The host verifies the installed/runtime manifest and exact package trust first,
then sends `{protocolVersion:1,id,type:'configure',settings:{...}}` over stdin.
Only the declared keys are accepted, each with a string of at most 2048 UTF-8
bytes. The SDK ignores the handler's return value and returns exactly `state:{}`.
State/execute are refused before configuration. Configure should validate/setup
only, never issue device actions; do not return or log credentials.

The desktop supplies a generic opt-in settings form backed by native OS
credential storage. Stored secret values never return to the form. Apply persists
immediately; it does not enable, run or test the plugin. Disable before applying
or forgetting a secret. The complete native credential envelope is capped at
2400 UTF-16 bytes (Windows credential-store budget), so four individually valid
values may still exceed the combined limit. Storage failures are visible; there
is no plaintext fallback. Saved credentials belong to the plugin ID and remain
available to an explicitly re-trusted update, but never become action arguments,
manifest data, deck exports or browser storage. This is not permission enforcement
or a sandbox against trusted plugin code.

An integer action field can declare `choicesKey: 'entities'` instead of `control`.
Its state array uses `Choice`: `{value: number, label: string, available: boolean}`.
The **app** validates at most 256 unique safe integer values inside field bounds,
nonempty labels up to 320 characters without control characters, and availability;
it renders a shared dropdown and disables unavailable/missing bindings. Multiple
actions may refer to the same array. The SDK/host validate the key name and normal
integer arguments, not the arbitrary state object. The plugin must independently
resolve and validate the binding before any side effect. Never use discovery
order as identity or execute actions/commands from selection metadata.

The Home Assistant reference uses fixed services and stable origin/entity-ID
bindings. It requires an explicit successful state read after every enable and
confirms post-action observation without replaying commands. Generic SDK errors
remain conservative: once an execute handler is entered, an error reports outcome
unknown even if the handler failed preflight. A handler-raised `timeout`, like an
SDK deadline, stops serving further requests in both JS and Python.

## Read-only values and selected boolean observations (unreleased)

`Choice` also accepts `description` (1–320 characters) and `observation: {value: boolean | number | null, unit: string, observedAtMs: number}`. Numbers must be finite with magnitude ≤ MAX_SAFE_INTEGER, units ≤24 characters without control characters, and timestamps positive safe integers. `null` means unknown/unavailable, never Off/zero. Return timestamped observations, not optimistic command targets.

A boolean control can use `{stateKey:'entities', entityKey:'entity'}` to read the selected choice's observation. Its `entity` config field must be an integer with matching `choicesKey:'entities'`. Omitting `entityKey` keeps the original top-level observed boolean behavior. Existing fixed buttons keep their saved arguments; new boolean controls default to observed toggles.

Declare read-only bindings separately from actions, e.g. `values: [{id:'temperature', title:'Temperature', config:{entity:{type:'integer',minimum:1,maximum:100,choicesKey:'temperatures'}}, stateKey:'temperatures',entityKey:'entity'}]`. At most 32, exactly one integer selection field per value, no writable metadata, IDs unique across actions and values. Do not add fake read actions: value IDs are not executable, and the existing `state` handler observes them. The app stores the selected ID/binding with read-only `value` presentation and offers explicit refresh without sending `execute`. No new stdio request type or background events/polling were added. See [the host contract](../../docs/plugins.md#selected-observations-and-read-only-values-unreleased) for compatibility and phone refresh.

## Maintainer releases

Releases use the public `@zdeck` scope. Authenticate externally and verify permission before publishing. Do not paste credentials into source, chats or logs.

After authentication and scope verification, from this directory:

```sh
npm test
npm pack --ignore-scripts --dry-run --json
npm publish --access public --ignore-scripts
```

Only claim publication, or switch a source dependency to the registry version, after verifying the published version and tarball integrity. The SDK remains ESM-only with explicit exports; no CommonJS `main` or build step is required.
