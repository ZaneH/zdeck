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

## Maintainer releases

Releases use the public `@zdeck` scope. Authenticate externally and verify permission before publishing. Do not paste credentials into source, chats or logs.

After authentication and scope verification, from this directory:

```sh
npm test
npm pack --ignore-scripts --dry-run --json
npm publish --access public --ignore-scripts
```

Only claim publication, or switch a source dependency to the registry version, after verifying the published version and tarball integrity. The SDK remains ESM-only with explicit exports; no CommonJS `main` or build step is required.
