import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHomeAssistant } from '../home-assistant.js';
import { validateManifest } from '../../../packages/plugin-sdk/index.js';
import manifest from '../manifest.json' with { type: 'json' };
class PluginError extends Error { constructor(code) { super(code); this.code = code; } }
const entity = (id, state, attributes = {}) => ({ entity_id: id, state, attributes });
const json = (v) => new Response(JSON.stringify(v));

test('temperature and boolean readings are GET-only, unit-preserving and origin-stable', async () => {
  validateManifest(manifest);
  const calls = [];
  let raw = [
    entity('light.' + 'a'.repeat(250), 'off', { friendly_name: 'A long friendly name '.repeat(15) }),
    entity('switch.fan', 'unknown'),
    entity('sensor.room', '21.5', { unit_of_measurement: '°C', friendly_name: 'Room temperature' }),
    entity('sensor.outdoor', '-4.2', { unit_of_measurement: '°F' }),
    entity('sensor.unavailable', 'unavailable', { unit_of_measurement: '°C' }),
    entity('sensor.bad', 'NaN', { unit_of_measurement: '°C' }),
    entity('sensor.energy', '20', { unit_of_measurement: 'kWh' }),
    entity('climate.hall', 'heat', { current_temperature: 68.5 }),
    entity('climate.offline', 'unavailable', { current_temperature: 21, temperature_unit: '°C' }),
  ];
  const plugin = createHomeAssistant({ PluginError, fetch: async (url, init) => {
    calls.push({ url, method: init.method });
    assert.equal(init.method, 'GET');
    return json(url.endsWith('/api/config') ? { unit_system: { temperature: '°F' } } : raw);
  } });
  await plugin.configure({ url: 'http://127.0.0.1:8123', token: 'fake-only' });
  const first = await plugin.state();
  assert.equal(first.entities[0].description.length, 256);
  assert.ok(first.entities[0].label.length >= 250);
  assert.deepEqual(first.entities.map((c) => c.observation.value), [false, null]);
  assert.deepEqual(first.temperatures.map((c) => [c.observation.value, c.observation.unit]), [
    [21.5, '°C'], [-4.2, '°F'], [null, '°C'], [null, '°C'], [68.5, '°F'], [null, '°C'],
  ]);
  assert.ok(first.temperatures.every((c) => c.observation.observedAtMs > 0));
  for (const id of ['state', 'temperature']) await assert.rejects(plugin.execute(id, { entity: first.temperatures[0].value }), { code: 'unknown_action' });
  raw.reverse();
  const second = await plugin.state();
  assert.equal(second.temperatures.find((c) => c.description === 'sensor.room').value, first.temperatures[0].value);
  assert.equal(calls.filter((c) => c.url.endsWith('/api/config')).length, 2);
  assert.ok(calls.every((c) => c.method === 'GET'));
});

test('invalid or missing thermostat unit is not guessed', async () => {
  const plugin = createHomeAssistant({ PluginError, fetch: async (url) => json(url.endsWith('/api/config')
    ? { unit_system: { temperature: 'bogus' } } : [entity('climate.hall', 'heat', { current_temperature: 21 })]) });
  await plugin.configure({ url: 'https://fixture.invalid', token: 'fake-only' });
  assert.deepEqual((await plugin.state()).temperatures[0].observation.value, null);
});
