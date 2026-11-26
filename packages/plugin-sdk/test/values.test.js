import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateManifest } from '../index.js';
const manifest = JSON.parse(readFileSync(new URL('../../../plugins/home-assistant/manifest.json', import.meta.url)));
test('selected boolean observations and separate read-only value bindings', () => {
  assert.equal(validateManifest(manifest), manifest);
  for (const mutate of [
    (m) => { m.values[0].id = 'power'; },
    (m) => { m.values[0].entityKey = 'missing'; },
    (m) => { m.values[0].stateKey = 'missing'; },
    (m) => { m.values[0].config.extra = { type: 'boolean' }; },
    (m) => { m.values = null; },
    (m) => { m.actions[0].config.enabled.control.entityKey = null; },
  ]) { const changed = structuredClone(manifest); mutate(changed); assert.throws(() => validateManifest(changed), TypeError); }
});
