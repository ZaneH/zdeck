import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { serve, validateManifest, validateArguments, PluginError, LIMITS } from '@zdeck/plugin-sdk';

const manifest = { id: 'test', version: '0.1.0', protocolVersion: 1, actions: [
  { id: 'go', title: 'Go', config: {} },
  { id: 'volume', title: 'Volume', config: { volume: { type: 'integer', minimum: 0, maximum: 100 } } },
] };
const request = (type, extra = {}) => JSON.stringify({ protocolVersion: 1, id: 'r1', type, ...extra }) + '\n';
async function session(chunks, overrides = {}) {
  let output = '', calls = [];
  const plugin = { manifest, state: () => ({ ready: true }), execute: (action, args) => {
    calls.push([action, args]); return { ready: true };
  }, ...overrides };
  await serve(plugin, { input: Readable.from(chunks), output: new Writable({ write(chunk, _, done) {
    output += chunk; done();
  } }) });
  return { responses: output.trim().split('\n').filter(Boolean).map(JSON.parse), calls, output };
}

test('optional icon packs are bounded and accept only embedded image sources', async () => {
  const icon = { id: 'play', title: 'Play', category: 'Media', src: 'data:image/svg+xml;base64,PHN2Zy8+' };
  const pack = { ...manifest, icons: [icon] };
  assert.equal(validateManifest(pack), pack);
  const { responses } = await session([request('describe')], { manifest: pack });
  assert.deepEqual(responses[0].manifest.icons, [icon]);
  for (const icons of [null, [icon, icon], Array(33).fill(icon), [{ ...icon, src: 'https://example.com/icon.svg' }],
    [{ ...icon, src: 'data:text/html;base64,PHN2Zy8+' }], [{ ...icon, src: 'data:image/png;base64,a===' }],
    [{ ...icon, category: ' ' }], [{ ...icon, title: 'x'.repeat(81) }], [{ ...icon, unknown: true }]]) {
    assert.throws(() => validateManifest({ ...manifest, icons }), /Invalid plugin manifest/);
  }
});

test('a singular plugin identity icon is optional and bounded', async () => {
  const icon = 'data:image/svg+xml;base64,PHN2Zy8+';
  const withIcon = { ...manifest, icon };
  assert.equal(validateManifest(withIcon), withIcon);
  const { responses } = await session([request('describe')], { manifest: withIcon });
  assert.equal(responses[0].manifest.icon, icon);
  for (const bad of [null, 42, 'https://example.com/icon.svg', 'data:text/html;base64,PHN2Zy8+', 'data:image/png;base64,']) {
    assert.throws(() => validateManifest({ ...manifest, icon: bad }), /Invalid plugin manifest/);
  }
});

test('public constants and strict manifest validation', () => {
  assert.equal(validateManifest(manifest), manifest);
  for (const bad of [null, {}, { ...manifest, protocolVersion: 2 }, { ...manifest, executable: '/bin/sh' },
    { ...manifest, id: '../test' }, { ...manifest, version: 'latest' },
    { ...manifest, actions: [manifest.actions[0], manifest.actions[0]] },
    { ...manifest, actions: Array(33).fill(manifest.actions[0]) },
    { ...manifest, actions: [{ id: 'bad', title: 'Bad', config: { secret: { type: 'string' } } }] },
    { ...manifest, actions: [{ id: 'bad', title: 'Bad', config: { n: { type: 'integer', minimum: 3, maximum: 2 } } }] },
  ]) assert.throws(() => validateManifest(bad), /Invalid plugin manifest/);
  const config = Object.fromEntries(Array.from({ length: 8 }, (_, i) =>
    [`field-${i}-${'x'.repeat(50)}`, { type: 'integer', minimum: 0, maximum: 100 }]));
  const oversized = { ...manifest, actions: Array.from({ length: 32 }, (_, i) =>
    ({ id: `action-${i}`, title: 'Title', config })) };
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) > LIMITS.manifestBytes);
  assert.throws(() => validateManifest(oversized), /Invalid plugin manifest/);
  assert.equal(LIMITS.requestBytes, 16384);
});

test('describe, state and execute with IDs and bounded config', async () => {
  const { responses, calls } = await session([request('describe') + request('state')
    + request('execute', { action: 'volume', args: { volume: 100 } })]);
  assert.equal(responses.length, 3);
  assert.deepEqual(responses[0], { protocolVersion: 1, id: 'r1', type: 'result', manifest });
  assert.deepEqual(responses[1].state, { ready: true });
  assert.deepEqual(calls, [['volume', { volume: 100 }]]);
});

test('strict arguments reject missing/extra/noninteger/out-of-bounds fields before execution', async () => {
  for (const args of [null, [], {}, { volume: -1 }, { volume: 101 }, { volume: 1.5 },
    { volume: '50' }, { volume: 50, extra: 1 }, JSON.parse('{"__proto__":1}')]) {
    assert.throws(() => validateArguments(manifest.actions[1], args), PluginError);
    const { responses, calls } = await session([request('execute', { action: 'volume', args })]);
    assert.equal(calls.length, 0);
    assert.equal(responses[0].error.outcome, 'not_started');
  }
  for (const volume of [0, 100]) assert.deepEqual(validateArguments(manifest.actions[1], { volume }), { volume });
});

test('invalid JSON/UTF8, blank lines, invalid shapes/version/ID/type and unknown action are safe', async () => {
  const invalid = ['{\n', '\n', 'null\n', '[]\n', Buffer.from([0xff, 10]),
    request('state', { protocolVersion: 2 }), request('state', { id: '' }),
    request('state', { id: 'a'.repeat(65) }), request('state', { extra: true }), request('shutdown'),
    request('execute', { action: 'go' }), request('execute', { action: 'absent', args: {} })];
  const { responses, calls, output } = await session(invalid);
  assert.equal(responses.length, invalid.length);
  assert.equal(calls.length, 0);
  assert.ok(responses.every((x) => x.type === 'error'));
  assert.equal(responses[0].id, null);
  assert.equal(responses[5].id, 'r1');
  assert.equal(responses.at(-1).error.code, 'unknown_action');
  assert.ok(!output.includes('SyntaxError'));
});

test('fragmentation, CRLF, multiple frames, oversize recovery and truncated EOF', async () => {
  const wire = Buffer.from(request('state').replace('\n', '\r\n'));
  const { responses } = await session([wire.subarray(0, 4), wire.subarray(4),
    Buffer.alloc(10000, 120), Buffer.alloc(10000, 120), '\n' + request('describe'), '{']);
  assert.deepEqual(responses.map((r) => r.type), ['result', 'error', 'result', 'error']);
  assert.equal(responses[1].error.code, 'request_too_large');
  assert.equal(responses[3].error.code, 'invalid_request');
  const boundary = request('state').trimEnd();
  const exact = boundary + ' '.repeat(LIMITS.requestBytes - Buffer.byteLength(boundary));
  assert.equal((await session([exact + '\n'])).responses[0].type, 'result');
  assert.equal((await session([exact + ' \n'])).responses[0].error.code, 'request_too_large');
  assert.equal((await session([Buffer.alloc(20000)])).responses[0].error.code, 'request_too_large');
});

test('raw handler errors and unsafe output never escape', async () => {
  for (const state of [() => { throw new Error('secret /private/token'); },
    () => { const error = new PluginError('internal_error'); error.code = 'untrusted'; throw error; },
    () => undefined, () => ({ big: 1n }), () => { const x = {}; x.x = x; return x; }]) {
    const result = await session([request('state')], { state });
    assert.equal(result.responses[0].type, 'error');
    assert.ok(!result.output.includes('secret'));
  }
  const large = await session([request('state')], { state: () => ({ text: 'x'.repeat(65536) }) });
  assert.equal(large.responses[0].error.code, 'response_too_large');
  const failure = await session([request('execute', { action: 'go', args: {} })], {
    execute: () => { throw new PluginError('command_failed'); },
  });
  assert.equal(failure.responses[0].error.outcome, 'unknown');
});

test('requests are sequential and EOF drains complete work', async () => {
  const order = [];
  const { responses } = await session([request('state') + request('state')], { state: async () => {
    order.push('start'); await new Promise((resolve) => setTimeout(resolve, 5)); order.push('end'); return {};
  } });
  assert.equal(responses.length, 2);
  assert.deepEqual(order, ['start', 'end', 'start', 'end']);
  assert.deepEqual((await session([])).responses, []);
});

test('deadline aborts handler and stops queued execution', async () => {
  let signal;
  const { responses, calls } = await session([request('state') + request('execute', { action: 'go', args: {} })], {
    state: (s) => { signal = s; return new Promise(() => {}); },
  });
  assert.equal(responses.length, 1);
  assert.equal(responses[0].error.code, 'timeout');
  assert.equal(signal.aborted, true);
  assert.equal(calls.length, 0);
});

test('transport write failures propagate rather than printing protocol noise', async () => {
  await assert.rejects(serve({ manifest, state: () => ({}) }, {
    input: Readable.from([request('state')]), output: new Writable({ write(_, __, done) {
      done(new Error('closed pipe'));
    } }).on('error', () => {}),
  }), /closed pipe/);
});
