# @zdeck/plugin-sdk

MIT-licensed, zero-dependency ESM runtime with TypeScript declarations for ZDeck process protocol v1. Requires an **installed Node.js >=22.18.0**. No build step, TypeScript compiler, native module or bundled Node runtime. ESM import only; TypeScript tooling needs its normal Node type declarations for stream types.

```ts
import { serve, type Plugin } from '@zdeck/plugin-sdk';
```

Explicit public exports: `serve`, `validateManifest`, `validateArguments`, `PluginError`, `PROTOCOL_VERSION`, `LIMITS`, plus the types in `index.d.ts`. `examples/hello.ts` is a complete typed author example runnable with Node's native type stripping.

See the repository's `docs/plugins.md` for the protocol, tested local-tarball quickstart, security boundaries and Spotify reference plugin. This developer preview does not include a desktop host or install UI. A process is **not a sandbox**; only run code you trust. npm distribution of this SDK does not supply an end-user plugin runtime.

From this package directory: `npm test` uses only Node built-ins, `npm pack --ignore-scripts` produces the distributable. The packed-artifact test also requires local `npm` and `tar`; it never installs dependencies, publishes, or invokes live Spotify automation.
