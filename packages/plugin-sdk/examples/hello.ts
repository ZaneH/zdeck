import { serve, type Plugin } from '@zdeck/plugin-sdk';

let count = 0;
const plugin: Plugin = {
  manifest: {
    id: 'hello', version: '0.1.0', protocolVersion: 1,
    actions: [{ id: 'increment', title: 'Increment', config: {} }],
  },
  state: () => ({ count }),
  execute: () => ({ count: ++count }),
};
// Native TypeScript stripping needs Node >=22.18; no build or SDK runtime dependencies.
await serve(plugin);
