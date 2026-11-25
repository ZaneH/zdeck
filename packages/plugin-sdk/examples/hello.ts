import { serve, type Plugin } from '@zdeck/plugin-sdk';

let count = 0;
const plugin: Plugin = {
  manifest: {
    id: 'hello', version: '0.1.0', protocolVersion: 1,
    actions: [{ id: 'increment', title: 'Increment', config: {} }],
    icons: [{ id: 'counter', title: 'Counter', category: 'General',
      src: 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="4" fill="#4cc9f0"/><path d="M12 6v12M6 12h12" stroke="#151719" stroke-width="2"/></svg>').toString('base64') }],
  },
  state: () => ({ count }),
  execute: () => ({ count: ++count }),
};
// Native TypeScript stripping needs Node >=22.18; no build or SDK runtime dependencies.
await serve(plugin);
