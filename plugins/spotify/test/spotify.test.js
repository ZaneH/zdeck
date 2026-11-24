import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpotify } from '../spotify.js';

const snapshot = { title: 'A\ttrack\n"🎵"', artist: 'Artist', playback: 'playing', volume: 42 };
function fake(options = {}) {
  const calls = [];
  const plugin = createSpotify({ platform: 'darwin', appExists: async () => {},
    runner: async (...args) => { calls.push(args); return JSON.stringify(snapshot); }, ...options });
  return { plugin, calls };
}
const code = (expected) => (error) => { assert.equal(error.code, expected); return true; };

test('all actions use fixed osascript executable, no shell, limits, and state readback', async () => {
  const { plugin, calls } = fake();
  for (const action of plugin.manifest.actions) {
    assert.deepEqual(await plugin.execute(action.id, action.id === 'set-volume' ? { volume: 42 } : {}), snapshot);
  }
  assert.equal(calls.length, 12);
  for (const [file, args, options] of calls) {
    assert.equal(file, '/usr/bin/osascript');
    assert.deepEqual(args.slice(0, 3), ['-l', 'JavaScript', '-e']);
    assert.ok(args[3].includes("if (!app.running()) throw new Error('ZDECK_NOT_RUNNING')"));
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 3000);
    assert.equal(options.maxBuffer, 8192);
    assert.equal(options.killSignal, 'SIGKILL');
  }
  const sources = calls.filter((_, index) => index % 2 === 0).map((call) => call[1][3]);
  for (const [index, command] of ['app.play();', 'app.pause();', 'app.playpause();',
    'app.nextTrack();', 'app.previousTrack();', 'app.soundVolume = volume;'].entries()) {
    assert.ok(sources[index].includes(command));
  }
  assert.deepEqual(calls[10][1].slice(4), ['42']);
  assert.ok(!calls[10][1][3].includes('42'));
  assert.deepEqual(calls[11][1].slice(4), []);
});

test('invalid action/arguments never reach process runner', async () => {
  const { plugin, calls } = fake();
  await assert.rejects(plugin.execute('run-shell', {}), code('unknown_action'));
  for (const args of [{}, { volume: -1 }, { volume: 101 }, { volume: 1.1 }, { volume: '0; do shell script' },
    { volume: 0, extra: 'x' }, null, []]) {
    await assert.rejects(plugin.execute('set-volume', args), code('invalid_arguments'));
  }
  await assert.rejects(plugin.execute('play', { track: 'arbitrary' }), code('invalid_arguments'));
  assert.equal(calls.length, 0);
  for (const volume of [0, 100]) await plugin.execute('set-volume', { volume });
  assert.deepEqual(calls.filter((_, i) => i % 2 === 0).map((call) => call[1].at(-1)), ['0', '100']);
});

test('platform and installation checks precede any automation', async () => {
  for (const [options, expected] of [
    [{ platform: 'linux' }, 'unsupported_platform'],
    [{ appExists: async () => { throw new Error('/private/path'); } }, 'app_missing'],
  ]) {
    const { plugin, calls } = fake(options);
    await assert.rejects(plugin.state(), code(expected));
    await assert.rejects(plugin.execute('play', {}), code(expected));
    assert.equal(calls.length, 0);
  }
});

test('process errors map to safe actionable categories', async () => {
  for (const [error, expected] of [
    [{ stderr: 'Error: ZDECK_NOT_RUNNING' }, 'app_not_running'],
    [{ stderr: 'Application is not running. (-600)' }, 'app_not_running'],
    [{ stderr: 'Not authorized to send Apple events (-1743)' }, 'automation_denied'],
    [{ killed: true }, 'timeout'], [{ name: 'AbortError' }, 'timeout'],
    [{ stderr: 'secret /private/token', code: 'ENOENT' }, 'command_failed'],
  ]) {
    const { plugin } = fake({ runner: async () => { throw error; } });
    await assert.rejects(plugin.state(), (actual) => {
      assert.equal(actual.code, expected); assert.ok(!actual.message.includes('secret')); return true;
    });
  }
});

test('state is read-only, typed, bounded and safely transports track text', async () => {
  const { plugin, calls } = fake();
  assert.deepEqual(await plugin.state(), snapshot);
  const script = calls[0][1][3];
  assert.ok(script.includes('JSON.stringify'));
  assert.ok(!script.includes('app.play('));
  assert.ok(!script.includes('app.soundVolume ='));
  for (const value of [null, [], {}, { ...snapshot, volume: 101 }, { ...snapshot, volume: 0.5 },
    { ...snapshot, title: 'x'.repeat(2049) }, { ...snapshot, playback: 'buffering' }, { ...snapshot, extra: true }]) {
    const { plugin } = fake({ runner: async () => JSON.stringify(value) });
    await assert.rejects(plugin.state(), code('invalid_state'));
  }
  for (const stdout of ['not JSON', 'x'.repeat(8193), undefined]) {
    const { plugin } = fake({ runner: async () => stdout });
    await assert.rejects(plugin.state(), code('invalid_state'));
  }
  const stopped = { title: null, artist: null, playback: 'stopped', volume: 0 };
  assert.deepEqual(await fake({ runner: async () => JSON.stringify(stopped) }).plugin.state(), stopped);
});

test('successful mutation followed by read failure is explicitly uncertain and never retried', async () => {
  let count = 0;
  const signal = new AbortController().signal;
  const { plugin } = fake({ runner: async (_, __, options) => {
    assert.equal(options.signal, signal);
    if (++count === 2) throw new Error('readback failed');
    return '';
  } });
  await assert.rejects(plugin.execute('next', {}, signal), code('outcome_unknown'));
  assert.equal(count, 2);
});
