import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, copyFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const sdk = fileURLToPath(new URL('..', import.meta.url));
const root = resolve(sdk, '../..');
test('packed artifact: clean public-path SDK + Spotify tests and documented TypeScript quickstart', { timeout: 30000 }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'zdeck-plugin-'));
  try {
    const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], {
      cwd: sdk, encoding: 'utf8',
    }))[0];
    const files = packed.files.map((file) => file.path).sort();
    assert.deepEqual(files, ['LICENSE', 'README.md', 'examples/hello.ts', 'index.d.ts', 'index.js', 'package.json']);
    const installed = join(temp, 'node_modules/@zdeck/plugin-sdk');
    await mkdir(installed, { recursive: true });
    execFileSync('tar', ['-xzf', join(temp, packed.filename), '--strip-components=1', '-C', installed]);
    await copyFile(join(sdk, 'test/sdk.test.js'), join(temp, 'sdk.test.js'));
    await cp(join(root, 'plugins/spotify'), join(temp, 'spotify'), { recursive: true });
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const tests = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'sdk.test.js', 'spotify/test/spotify.test.js'], {
      cwd: temp, encoding: 'utf8', timeout: 20000, env,
    });
    assert.equal(tests.status, 0, tests.stdout + tests.stderr);
    assert.match(tests.stdout, /# fail 0/);
    await copyFile(join(installed, 'examples/hello.ts'), join(temp, 'hello.ts'));
    const quickstart = spawnSync(process.execPath, ['hello.ts'], { cwd: temp, encoding: 'utf8',
      input: '{"protocolVersion":1,"id":"d1","type":"describe"}\n'
        + '{"protocolVersion":1,"id":"a1","type":"execute","action":"increment","args":{}}\n'
        + '{"protocolVersion":1,"id":"s1","type":"state"}\n', timeout: 5000 });
    assert.equal(quickstart.status, 0, quickstart.stderr);
    assert.equal(quickstart.stderr, '');
    const messages = quickstart.stdout.trim().split('\n').map(JSON.parse);
    assert.equal(messages[0].manifest.id, 'hello');
    assert.deepEqual(messages.slice(1).map((r) => r.state), [{ count: 1 }, { count: 1 }]);
    // Describe is intentionally side-effect-free: no osascript, even on macOS.
    const spotify = spawnSync(process.execPath, ['spotify/main.js'], { cwd: temp, encoding: 'utf8',
      input: '{"protocolVersion":1,"id":"d1","type":"describe"}\n', timeout: 5000 });
    assert.equal(spotify.status, 0, spotify.stderr);
    assert.equal(spotify.stderr, '');
    assert.deepEqual(JSON.parse(spotify.stdout).manifest,
      JSON.parse(await readFile(join(root, 'plugins/spotify/manifest.json'), 'utf8')));
    console.log(`Packed ${packed.filename}: ${files.length} files; ${tests.stdout.match(/# tests \d+/)?.[0]}; clean artifact suite and quickstart passed.`);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
