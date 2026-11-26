import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { PluginError, serve, validateManifest } from '@zdeck/plugin-sdk';

const manifest = { id: 'gated', version: '0.1.0', protocolVersion: 1,
  actions: [{ id: 'go', title: 'Go', config: {} }],
  settings: { token: { type: 'secret', label: 'Token' }, name: { type: 'text', label: 'Name' } } };
const request = (type, extra = {}) => JSON.stringify({ protocolVersion: 1, id: 'r1', type, ...extra }) + '\n';
async function session(chunks, overrides = {}) {
  let output = '', calls = [];
  const plugin = { manifest, state: () => ({ ready: true }), execute: () => ({ ready: true }),
    configure: (settings, signal) => { calls.push([settings, signal]); }, ...overrides };
  await serve(plugin, { input: Readable.from(chunks), output: new Writable({ write(chunk, _, done) {
    output += chunk; done();
  } }) });
  return { responses: output.trim().split('\n').filter(Boolean).map(JSON.parse), calls, output };
}

test('declared settings and choicesKey validate with the wire contract', () => {
  assert.equal(validateManifest(manifest), manifest);
  const choices = { ...manifest.actions[0], config: { level: { type: 'integer', minimum: 0, maximum: 3, choicesKey: 'levels' } } };
  assert.equal(validateManifest({ ...manifest, actions: [choices] }).actions[0], choices);
  assert.deepEqual(validateManifest({ ...manifest, settings: {} }).settings, {});
  for (const settings of [null, [], { ok: { type: 'text', label: '' } },
    { ok: { type: 'secret', label: 'x'.repeat(81) } }, { ok: { type: 'password', label: 'Password' } },
    { ok: { type: 'text', label: 'OK', extra: 1 } },
    Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`field-${i}`, { type: 'text', label: 'Label' }]))]) {
    assert.throws(() => validateManifest({ ...manifest, settings }), /Invalid plugin manifest/);
  }
  for (const field of [
    { type: 'integer', minimum: 0, maximum: 3, choicesKey: '../levels' },
    { type: 'integer', minimum: 0, maximum: 3, choicesKey: 'levels', control: { step: 1 } },
    { type: 'boolean', choicesKey: 'levels' },
  ]) assert.throws(() => validateManifest({ ...manifest, actions: [{ id: 'go', title: 'Go', config: { value: field } }] }), TypeError);
});

test('configure is required before state or execute and returns exactly empty state', async () => {
  const before = await session([request('state'), request('execute', { action: 'go', args: {} })]);
  assert.deepEqual(before.responses.map((r) => r.error.code), ['invalid_request', 'invalid_request']);
  assert.deepEqual(before.calls, []);
  const configured = await session([request('configure', { settings: { token: 's3cret', name: 'Ada' } }), request('state')]);
  assert.deepEqual(configured.responses[0].state, {});
  assert.deepEqual(configured.responses[1].state, { ready: true });
  assert.deepEqual(configured.calls.map(([settings]) => settings), [{ token: 's3cret', name: 'Ada' }]);
  const ignored = await session([request('configure', { settings: { token: 's3cret', name: 'Ada' } })], {
    configure: () => ({ should: 'not escape' }),
  });
  assert.deepEqual(ignored.responses[0].state, {});
});

test('failed reconfiguration invalidates old configuration and a handler timeout stops the queue', async () => {
  const good = request('configure', { settings: { token: 's3cret', name: 'Ada' } });
  const invalid = request('configure', { settings: {} });
  const result = await session([good, invalid, request('state')]);
  assert.equal(result.responses[1].error.code, 'invalid_arguments');
  assert.equal(result.responses[2].error.code, 'invalid_request');
  const stopped = await session([good, request('state'), request('execute', { action: 'go', args: {} })], {
    state: () => { throw new PluginError('timeout'); },
    execute: () => { assert.fail('A handler-raised timeout must not admit another action'); },
  });
  assert.equal(stopped.responses.length, 2);
  assert.equal(stopped.responses[1].error.code, 'timeout');
});

test('configure rejects undeclared, missing, extra and oversized values without leaking secrets', async () => {
  for (const settings of [{}, { token: 'only' }, { token: 'a', name: 'b', extra: 'c' },
    { token: 1, name: 'b' }, { token: 'x'.repeat(2049), name: 'b' }]) {
    const result = await session([request('configure', { settings })]);
    assert.equal(result.responses[0].error.code, 'invalid_arguments');
    assert.deepEqual(result.calls, []);
  }
  const exact = await session([request('configure', { settings: { token: 'x'.repeat(2048), name: '' } })]);
  assert.deepEqual(exact.responses[0].state, {});
  const missing = await session([request('configure', { settings: { token: 'a', name: 'b' } })], { configure: undefined });
  assert.equal(missing.responses[0].error.code, 'internal_error');
  const failed = await session([request('configure', { settings: { token: 'secret-token', name: 'Ada' } })], {
    configure: () => { throw new Error('secret-token /private/token'); },
  });
  assert.equal(failed.responses[0].error.code, 'internal_error');
  assert.ok(!failed.output.includes('secret-token') && !failed.output.includes('/private/token'));
  const { settings: _, ...plainManifest } = manifest;
  const plain = await session([request('configure', { settings: {} })], { manifest: plainManifest });
  assert.equal(plain.responses[0].error.code, 'invalid_request');
});
