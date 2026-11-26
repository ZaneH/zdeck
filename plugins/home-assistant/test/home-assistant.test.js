import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import manifest from '../manifest.json' with { type: 'json' };
import { createHomeAssistant } from '../home-assistant.js';

class PluginError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const TOKEN = 'test-long-lived-token';
const URL_VALUE = 'http://192.168.1.10:8123';
const valueOf = (entityId, origin = URL_VALUE) => createHash('sha256').update(`${origin}\n${entityId}`, 'utf8').digest().readUIntBE(0, 6);
const entity = (entityId, state, attributes = {}) => ({ entity_id: entityId, state, attributes });
const code = (expected) => (error) => { assert.equal(error.code, expected); return true; };
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' },
});

function discovery(states = [], { post } = {}) {
  const calls = [];
  let current = structuredClone(states);
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const parsed = new URL(url);
    if (init.method === 'GET' && parsed.pathname === '/api/states') return json(current);
    if (init.method === 'GET' && parsed.pathname.startsWith('/api/states/')) {
      const id = decodeURIComponent(parsed.pathname.slice('/api/states/'.length));
      const found = current.find((item) => item.entity_id === id);
      return found ? json(found) : new Response('missing', { status: 404 });
    }
    if (init.method === 'POST' && parsed.pathname.startsWith('/api/services/')) {
      const body = JSON.parse(init.body);
      const parts = parsed.pathname.split('/');
      const [domain, service] = parts.slice(-2);
      if (post) current = post(current, { domain, service, body });
      return json([]);
    }
    throw new Error(`unexpected request ${parsed.pathname}`);
  };
  return { fetch, calls };
}

function plugin(options = {}) {
  return createHomeAssistant({ PluginError, delay: async () => {}, ...options });
}

async function ready(options = {}) {
  const instance = plugin(options);
  await instance.configure({ url: URL_VALUE, token: TOKEN });
  return instance;
}

test('manifest declares one instance, settings and choice-bound actions', () => {
  assert.deepEqual(manifest.settings, {
    url: { type: 'text', label: 'Home Assistant URL' },
    token: { type: 'secret', label: 'Long-lived access token' },
  });
  const [power, brightness] = manifest.actions;
  assert.equal(power.id, 'power');
  assert.deepEqual(power.config.entity, {
    type: 'integer', minimum: 1, maximum: 281474976710655, choicesKey: 'entities',
  });
  assert.deepEqual(power.config.enabled, { type: 'boolean' });
  assert.equal(brightness.id, 'brightness');
  assert.deepEqual(brightness.config.entity, {
    type: 'integer', minimum: 1, maximum: 281474976710655, choicesKey: 'brightness-entities',
  });
  assert.deepEqual(brightness.config.brightness, {
    type: 'integer', minimum: 0, maximum: 100, control: { step: 1 },
  });
});

test('settings are origin-only and HTTP is limited to local networks', async () => {
  const accepted = [
    'https://ha.example.com', 'https://ha.example.com:8443/',
    'http://127.0.0.1:8123', 'http://10.1.2.3:8123', 'http://172.16.0.1',
    'http://172.31.255.255:8123', 'http://192.168.1.10:8123',
    'http://169.254.10.2:8123', 'http://homeassistant.local:8123',
    'http://ha.lan:8123', 'http://ha.home.arpa:8123',
  ];
  for (const url of accepted) {
    const instance = plugin({ fetch: async () => { throw new Error('must not fetch'); } });
    assert.deepEqual(await instance.configure({ url, token: TOKEN }), {});
  }
  const rejected = [
    '', 'ftp://ha.example.com', '//ha.example.com', 'ha.example.com',
    'http://8.8.8.8:8123', 'http://localhost:8123', 'http://172.32.0.1',
    'http://192.169.1.1', 'https://user:pass@ha.example.com',
    'https://ha.example.com/api', 'https://ha.example.com/?x=1',
    'https://ha.example.com/#x', 'https://ha.example.com?', 'https://ha.example.com#',
    'https://ha.example.com:99999',
  ];
  for (const url of rejected) {
    const instance = plugin({ fetch: async () => { throw new Error('must not fetch'); } });
    await assert.rejects(instance.configure({ url, token: TOKEN }), code('invalid_arguments'));
  }
  for (const token of ['', 'two words', 'line\nbreak', 'x'.repeat(2049)]) {
    const instance = plugin({ fetch: async () => { throw new Error('must not fetch'); } });
    await assert.rejects(instance.configure({ url: URL_VALUE, token }), code('invalid_arguments'));
  }
  await assert.rejects(plugin().configure({ url: URL_VALUE }), code('invalid_arguments'));
  await assert.rejects(plugin().configure({ url: URL_VALUE, token: TOKEN, extra: true }), code('invalid_arguments'));
  await assert.rejects(plugin().configure(null), code('invalid_arguments'));
});

test('state discovery filters domains, keeps stable hashes and honest labels', async () => {
  const server = discovery([
    entity('light.kitchen', 'on', {
      friendly_name: 'Kitchen', supported_color_modes: ['color_temp'], brightness: 128,
    }),
    entity('switch.fan', 'on', { friendly_name: 'Fan' }),
    entity('light.porch', 'off', { friendly_name: 'Porch', supported_color_modes: ['onoff'] }),
    entity('light.hall', 'unavailable', { friendly_name: 'Hall', supported_color_modes: ['brightness'] }),
    entity('sensor.temperature', '21'),
    entity('light.Bad', 'on'),
  ]);
  const instance = await ready({ fetch: server.fetch });
  const state = await instance.state();

  assert.equal(server.calls.length, 1);
  assert.equal(server.calls[0].url, `${URL_VALUE}/api/states`);
  assert.equal(server.calls[0].init.method, 'GET');
  assert.equal(server.calls[0].init.redirect, 'error');
  assert.equal(server.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(state.entities.map((item) => item.value), [
    valueOf('light.kitchen'), valueOf('switch.fan'), valueOf('light.porch'), valueOf('light.hall'),
  ]);
  assert.deepEqual(state.entities.map((item) => item.label), [
    'light.kitchen — on, 50% · Kitchen', 'switch.fan — on · Fan', 'light.porch — off · Porch', 'light.hall — unavailable · Hall',
  ]);
  assert.deepEqual(state.entities.map((item) => item.available), [true, true, true, false]);
  assert.deepEqual(state['brightness-entities'].map((item) => item.value), [
    valueOf('light.kitchen'), valueOf('light.hall'),
  ]);
  const serialized = JSON.stringify(state);
  assert.ok(!serialized.includes(TOKEN));
  assert.ok(!serialized.includes(URL_VALUE));
  assert.ok(serialized.length < 50000);
});

test('choice arrays and labels stay bounded', async () => {
  const states = Array.from({ length: 150 }, (_, index) => entity(
    `light.room_${index}`, index % 2 ? 'on' : 'off',
    { friendly_name: `${'Long room name '.repeat(12)}${index}`, supported_color_modes: ['brightness'], brightness: 128 },
  ));
  const instance = await ready({ fetch: discovery(states).fetch });
  const state = await instance.state();
  assert.equal(state.entities.length, 100);
  assert.equal(state['brightness-entities'].length, 100);
  assert.ok(state.entities.every((item) => Buffer.byteLength(item.label, 'utf8') <= 160));
  assert.ok(Buffer.byteLength(JSON.stringify(state), 'utf8') <= 50000);
});

test('selection values do not depend on discovery order or indices', async () => {
  const states = [
    entity('light.b', 'on', { friendly_name: 'B', supported_color_modes: ['brightness'] }),
    entity('light.a', 'off', { friendly_name: 'A' }),
  ];
  const server = discovery(states);
  const instance = await ready({ fetch: server.fetch });
  const first = await instance.state();
  const reversed = discovery([...states].reverse());
  const other = await ready({ fetch: reversed.fetch });
  const second = await other.state();
  const byValue = (state) => Object.fromEntries(state.entities.map((item) => [item.value, item]));
  assert.deepEqual(byValue(second), byValue(first));
});

test('renames, collisions and replacements never retarget a saved value', async () => {
  const server = discovery([entity('light.a', 'on')]);
  const instance = await ready({ fetch: server.fetch });
  const oldValue = (await instance.state()).entities[0].value;
  assert.equal(oldValue, valueOf('light.a'));

  const renamed = discovery([entity('light.b', 'on')]);
  const renamedPlugin = await ready({ fetch: renamed.fetch });
  const newState = await renamedPlugin.state();
  assert.equal(newState.entities[0].value, valueOf('light.b'));
  assert.notEqual(newState.entities[0].value, oldValue);
  await assert.rejects(renamedPlugin.execute('power', { entity: oldValue, enabled: true }), code('invalid_arguments'));
  assert.equal(renamed.calls.filter((call) => call.init.method === 'POST').length, 0);

  const collisions = await ready({ fetch: discovery([
    entity('light.a', 'on'), entity('light.b', 'off'),
  ]).fetch, hash: () => 5 });
  assert.deepEqual((await collisions.state()).entities, []);
  await assert.rejects(collisions.execute('power', { entity: 5, enabled: true }), code('invalid_arguments'));

  let current = [entity('light.a', 'on')];
  const replacement = await ready({
    hash: () => 9,
    fetch: async (url) => json(url.endsWith('/api/states') ? current : current[0]),
  });
  assert.equal((await replacement.state()).entities[0].value, 9);
  current = [entity('light.b', 'on')];
  assert.deepEqual((await replacement.state()).entities, []);
  await assert.rejects(replacement.execute('power', { entity: 9, enabled: true }), code('invalid_arguments'));
});

test('argument validation happens before any network access', async () => {
  let calls = 0;
  const instance = await ready({ fetch: async () => { calls += 1; throw new Error('no'); } });
  await assert.rejects(instance.execute('toggle', {}), code('unknown_action'));
  for (const args of [
    {}, { entity: 1 }, { entity: 1, enabled: 'on' }, { entity: 0, enabled: true },
    { entity: 281474976710656, enabled: true }, { entity: 1.5, enabled: true },
    { entity: 1, enabled: true, extra: true }, null, [],
  ]) await assert.rejects(instance.execute('power', args), code('invalid_arguments'));
  for (const args of [
    { entity: 1, brightness: -1 }, { entity: 1, brightness: 101 },
    { entity: 1, brightness: 1.5 }, { entity: 1, brightness: '50' },
    { entity: 1, brightness: 50, extra: true },
  ]) await assert.rejects(instance.execute('brightness', args), code('invalid_arguments'));
  assert.equal(calls, 0);
  await assert.rejects(plugin().state(), code('internal_error'));
  await assert.rejects(plugin().execute('power', { entity: 1, enabled: true }), code('internal_error'));
});

test('power uses explicit services and confirms the observed state', async () => {
  const server = discovery([
    entity('switch.fan', 'off', { friendly_name: 'Fan' }),
    entity('light.lamp', 'off', { friendly_name: 'Lamp', supported_color_modes: ['brightness'] }),
  ], {
    post: (states, { service, body }) => states.map((item) => item.entity_id === body.entity_id
      ? { ...item, state: service === 'turn_on' ? 'on' : 'off' } : item),
  });
  const instance = await ready({ fetch: server.fetch });
  const state = await instance.state();
  const fan = state.entities.find((item) => item.value === valueOf('switch.fan'));
  const result = await instance.execute('power', { entity: fan.value, enabled: true });

  const post = server.calls.find((call) => call.init.method === 'POST');
  assert.equal(post.url, `${URL_VALUE}/api/services/switch/turn_on`);
  assert.equal(post.init.redirect, 'error');
  assert.equal(post.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(post.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(post.init.body), { entity_id: 'switch.fan' });
  assert.equal(server.calls.filter((call) => call.init.method === 'POST').length, 1);
  assert.ok(server.calls.some((call) => call.init.method === 'GET'
    && call.url === `${URL_VALUE}/api/states/switch.fan`));
  assert.equal(result.entities.find((item) => item.value === fan.value).label, 'switch.fan — on · Fan');

  const off = await instance.execute('power', { entity: fan.value, enabled: false });
  assert.equal(server.calls.filter((call) => call.init.method === 'POST').at(-1).url,
    `${URL_VALUE}/api/services/switch/turn_off`);
  assert.equal(off.entities.find((item) => item.value === fan.value).label, 'switch.fan — off · Fan');
  assert.equal(server.calls.filter((call) => call.init.method === 'POST').length, 2);
});

test('brightness requires official dimming support and reads back the level', async () => {
  const server = discovery([
    entity('light.kitchen', 'on', {
      friendly_name: 'Kitchen', supported_color_modes: ['hs'], brightness: 100,
    }),
    entity('light.porch', 'on', { friendly_name: 'Porch', supported_color_modes: ['onoff'] }),
  ], {
    post: (states, { service, body }) => states.map((item) => {
      if (item.entity_id !== body.entity_id) return item;
      if (service === 'turn_off') return { ...item, state: 'off', attributes: { ...item.attributes, brightness: 0 } };
      return {
        ...item, state: 'on',
        attributes: { ...item.attributes, brightness: Math.round((body.brightness_pct * 255) / 100) },
      };
    }),
  });
  const instance = await ready({ fetch: server.fetch });
  const state = await instance.state();
  const kitchen = state['brightness-entities'].find((item) => item.value === valueOf('light.kitchen'));
  const porch = state.entities.find((item) => item.value === valueOf('light.porch'));
  assert.ok(!state['brightness-entities'].some((item) => item.value === porch.value));

  await instance.execute('brightness', { entity: kitchen.value, brightness: 42 });
  const on = server.calls.filter((call) => call.init.method === 'POST').at(-1);
  assert.equal(on.url, `${URL_VALUE}/api/services/light/turn_on`);
  assert.deepEqual(JSON.parse(on.init.body), { entity_id: 'light.kitchen', brightness_pct: 42 });

  await instance.execute('brightness', { entity: kitchen.value, brightness: 0 });
  const off = server.calls.filter((call) => call.init.method === 'POST').at(-1);
  assert.equal(off.url, `${URL_VALUE}/api/services/light/turn_off`);
  assert.deepEqual(JSON.parse(off.init.body), { entity_id: 'light.kitchen' });

  await assert.rejects(instance.execute('brightness', { entity: porch.value, brightness: 10 }), code('invalid_state'));
  assert.equal(server.calls.filter((call) => call.init.method === 'POST').length, 2);
});

test('unavailable entities are rejected before any POST', async () => {
  const server = discovery([
    entity('light.hall', 'unavailable', { supported_color_modes: ['brightness'] }),
  ]);
  const instance = await ready({ fetch: server.fetch });
  const state = await instance.state();
  const hall = state.entities[0];
  await assert.rejects(instance.execute('power', { entity: hall.value, enabled: true }), code('entity_unavailable'));
  await assert.rejects(instance.execute('brightness', { entity: hall.value, brightness: 10 }), code('entity_unavailable'));
  assert.equal(server.calls.filter((call) => call.init.method === 'POST').length, 0);
});

test('missing bindings fail closed without a POST', async () => {
  const server = discovery([entity('light.a', 'on')]);
  const instance = await ready({ fetch: server.fetch });
  await instance.state();
  await assert.rejects(instance.execute('power', { entity: 12345, enabled: true }), code('invalid_arguments'));
  await assert.rejects(instance.execute('brightness', { entity: 12345, brightness: 10 }), code('invalid_arguments'));
  assert.equal(server.calls.filter((call) => call.init.method === 'POST').length, 0);
});

test('readback mismatch is outcome_unknown, latches and never repeats the POST', async () => {
  const server = discovery([entity('switch.fan', 'off')]);
  const instance = await ready({ fetch: server.fetch, readbackAttempts: 2 });
  const fan = (await instance.state()).entities[0];
  await assert.rejects(instance.execute('power', { entity: fan.value, enabled: true }), code('outcome_unknown'));
  assert.equal(server.calls.filter((call) => call.init.method === 'POST').length, 1);
  assert.equal(server.calls.filter((call) => call.init.method === 'GET'
    && call.url === `${URL_VALUE}/api/states/switch.fan`).length, 2);

  const calls = server.calls.length;
  await assert.rejects(instance.execute('power', { entity: fan.value, enabled: true }), code('outcome_unknown'));
  assert.equal(server.calls.length, calls, 'latched execute must not touch the network');

  await instance.state();
  await assert.rejects(instance.execute('power', { entity: fan.value, enabled: true }), code('outcome_unknown'));
  assert.equal(server.calls.filter((call) => call.init.method === 'POST').length, 2);
});

test('uncertain delivery and server errors latch, client rejection does not', async () => {
  const fan = entity('switch.fan', 'off');
  let posts = 0;
  const throws = await ready({
    fetch: async (url, init) => {
      if (init.method === 'POST') { posts += 1; throw new TypeError('socket closed'); }
      return json(url.endsWith('/api/states') ? [fan] : fan);
    },
  });
  const value = (await throws.state()).entities[0].value;
  await assert.rejects(throws.execute('power', { entity: value, enabled: true }), code('outcome_unknown'));
  await assert.rejects(throws.execute('power', { entity: value, enabled: true }), code('outcome_unknown'));
  assert.equal(posts, 1);

  for (const [status, expected] of [[500, 'outcome_unknown'], [408, 'outcome_unknown'], [400, 'command_failed']]) {
    let attempts = 0;
    const instance = await ready({
      fetch: async (url, init) => {
        if (init.method === 'POST') { attempts += 1; return new Response('rejected', { status }); }
        return json(url.endsWith('/api/states') ? [fan] : fan);
      },
    });
    await instance.state();
    await assert.rejects(instance.execute('power', { entity: value, enabled: true }), code(expected));
    assert.equal(attempts, 1);
  }
});

test('responses are streamed with a hard cap and requests forbid redirects', async () => {
  const cap = 1024 * 1024;
  const instance = await ready({
    fetch: async () => new Response('x'.repeat(cap + 1), { headers: { 'Content-Type': 'application/json' } }),
  });
  await assert.rejects(instance.state(), code('invalid_state'));

  const server = discovery([entity('light.a', 'on')]);
  const second = await ready({ fetch: server.fetch });
  await second.state();
  for (const call of server.calls) assert.equal(call.init.redirect, 'error');
});

test('a fresh process or reconfiguration cannot execute before an explicit successful state read', async () => {
  const server = discovery([entity('switch.a', 'off')]);
  const first = await ready({ fetch: server.fetch });
  const value = (await first.state()).entities[0].value;
  const restarted = await ready({ fetch: server.fetch });
  const count = server.calls.length;
  await assert.rejects(restarted.execute('power', { entity: value, enabled: true }), code('state_required'));
  assert.equal(server.calls.length, count);
  await restarted.state();
  await restarted.configure({ url: URL_VALUE, token: TOKEN });
  await assert.rejects(restarted.execute('power', { entity: value, enabled: true }), code('state_required'));
  assert.equal(server.calls.filter((call) => call.init.method === 'POST').length, 0);
});

test('changing the configured origin invalidates saved bindings, including across restart', async () => {
  const server = discovery([entity('light.a', 'off')]);
  const first = await ready({ fetch: server.fetch });
  const value = (await first.state()).entities[0].value;
  const second = plugin({ fetch: server.fetch });
  await second.configure({ url: 'https://another.example.test', token: TOKEN });
  assert.notEqual((await second.state()).entities[0].value, value);
  await assert.rejects(second.execute('power', { entity: value, enabled: true }), code('invalid_arguments'));
  assert.equal(server.calls.filter((call) => call.init.method === 'POST').length, 0);
});

test('unknown color modes never advertise brightness and long labels retain identity and state', async () => {
  const server = discovery([entity('light.a', 'on', { friendly_name: 'Name\u0085'.repeat(100), supported_color_modes: ['unknown'] })]);
  const instance = await ready({ fetch: server.fetch });
  const state = await instance.state();
  assert.deepEqual(state['brightness-entities'], []);
  assert.ok(state.entities[0].label.startsWith('light.a — on'));
  assert.ok(!/\p{Cc}/u.test(state.entities[0].label));
});

test('successful execute returns the confirmed observation, not stale pre-command discovery', async () => {
  let discoveryReads = 0;
  let posted = false;
  const instance = await ready({ fetch: async (url, init) => {
    if (init.method === 'POST') { posted = true; return json([]); }
    if (url.endsWith('/api/states')) {
      discoveryReads += 1;
      if (posted) throw new Error('discovery unavailable after successful readback');
      return json([entity('switch.a', 'off')]);
    }
    return json(entity('switch.a', posted ? 'on' : 'off'));
  } });
  const state = await instance.state();
  const result = await instance.execute('power', { entity: state.entities[0].value, enabled: true });
  assert.equal(result.entities[0].label, 'switch.a — on');
  assert.equal(discoveryReads, 2);
});

test('an aborted or expired request never starts a command', async () => {
  let calls = 0;
  const instance = await ready({ budgetMs: 20, fetch: (url, init) => {
    calls += 1;
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  } });
  await assert.rejects(instance.state(), code('timeout'));
  assert.equal(calls, 1);

  const controller = new AbortController();
  controller.abort();
  const aborted = await ready({ fetch: async () => { calls += 1; return json([]); } });
  await assert.rejects(aborted.execute('power', { entity: 1, enabled: true }, controller.signal), code('timeout'));
  assert.equal(calls, 1);
});
