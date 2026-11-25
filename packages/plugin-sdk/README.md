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

## Maintainer releases

Releases use the public `@zdeck` scope. Authenticate externally and verify permission before publishing. Do not paste credentials into source, chats or logs.

After authentication and scope verification, from this directory:

```sh
npm test
npm pack --ignore-scripts --dry-run --json
npm publish --access public --ignore-scripts
```

Only claim publication, or switch a source dependency to the registry version, after verifying the published version and tarball integrity. The SDK remains ESM-only with explicit exports; no CommonJS `main` or build step is required.
