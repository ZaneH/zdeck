import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, validateArguments } from '@zdeck/plugin-sdk';

const level = { id: 'level', title: 'Level', config: {
  amount: { type: 'integer', minimum: -20, maximum: 200, control: { step: 5 } },
  zone: { type: 'integer', minimum: 1, maximum: 4 },
} };
const power = { id: 'power', title: 'Power', config: { enabled: { type: 'boolean', control: { stateKey: 'powered' } } } };
const manifest = { id: 'mixer', version: '1.0.0', protocolVersion: 1, actions: [level, power] };

test('declared numeric and boolean control contracts validate full arguments', () => {
  assert.deepEqual(validateManifest(manifest), manifest);
  assert.deepEqual(validateArguments(level, { amount: 75, zone: 2 }), { amount: 75, zone: 2 });
  for (const enabled of [false, true]) assert.deepEqual(validateArguments(power, { enabled }), { enabled });
  for (const amount of [-25, 201, 76, 0.5, NaN, Infinity, true, '75']) {
    assert.throws(() => validateArguments(level, { amount, zone: 2 }), { code: 'invalid_arguments' });
  }
  for (const enabled of [0, 1, 'true', null]) assert.throws(() => validateArguments(power, { enabled }), { code: 'invalid_arguments' });
  for (const args of [{ amount: 75 }, { amount: 75, zone: 5 }, { amount: 75, zone: 2, injected: 1 }]) {
    assert.throws(() => validateArguments(level, args), { code: 'invalid_arguments' });
  }
});

test('metadata is explicit, singular, bounded and strict', () => {
  for (const field of [
    { type: 'integer', minimum: 0, maximum: 10, control: { step: 0 } },
    { type: 'integer', minimum: 0, maximum: 10, control: { step: 3 } },
    { type: 'integer', minimum: 0, maximum: 0, control: { step: 1 } },
    { type: 'integer', minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER, control: { step: 1 } },
    { type: 'boolean', control: null }, { type: 'boolean', control: { stateKey: '../secret' } },
    { type: 'boolean', minimum: 0 },
  ]) assert.throws(() => validateManifest({ ...manifest, actions: [{ ...level, config: { value: field } }] }), TypeError);
  assert.throws(() => validateManifest({ ...manifest, actions: [{ ...level, config: { a: level.config.amount, b: level.config.amount } }] }), TypeError);
  assert.deepEqual(validateArguments({ ...level, config: { n: { type: 'integer', minimum: 0, maximum: 10 } } }, { n: 3 }), { n: 3 });
});
