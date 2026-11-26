import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
// @ts-expect-error project packaging module deliberately uses plain Node ESM
import { packageZdx } from '../scripts/package-zdx.mjs';
// @ts-expect-error existing offline folder packagers
import { packageSpotify, packageHomeAssistant } from '../scripts/package-spotify.mjs';

describe('offline root-layout .zdx packaging', () => {
  it('packages complete self-contained Spotify and HA archives without evaluating entrypoints', async () => {
    const temp = await realpath(await mkdtemp(join(tmpdir(), 'zdeck-zdx-')));
    try {
      for (const [id, build] of [['spotify', packageSpotify], ['home-assistant', packageHomeAssistant]] as const) {
        const folder = await build(join(temp, id)); const output = join(temp, `${id}.zdx`);
        const result = await packageZdx(folder, output);
        expect(result.id).toBe(id); expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
        const bytes = await readFile(output); const files = unzipSync(bytes);
        expect(files['manifest.json']).toBeDefined(); expect(files['main.js']).toBeDefined();
        expect(files['node_modules/@zdeck/plugin-sdk/index.js']).toBeDefined();
        expect(files['node_modules/@zdeck/plugin-sdk/LICENSE']).toBeDefined();
        expect(Object.keys(files).some((n) => n.startsWith(`${id}/`) || n.endsWith('package-lock.json') || n === '.npmrc')).toBe(false);
        expect(Buffer.from(files['package.json']).toString()).not.toContain('file:');
        expect(JSON.parse(Buffer.from(files['manifest.json']).toString()).version).toBe(result.version);
        await packageZdx(folder, output); expect(await readFile(output)).toEqual(bytes);
      }
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
  it('refuses source symlinks, case aliases and unexpected layouts without modifying output', async () => {
    const temp = await realpath(await mkdtemp(join(tmpdir(), 'zdeck-zdx-')));
    try {
      const folder = join(temp, 'plugin'); await mkdir(folder);
      const output = join(temp, 'result.zdx'); await writeFile(output, 'keep');
      await writeFile(join(folder, 'manifest.json'), JSON.stringify({ id: 'fixture', version: '1.0.0', protocolVersion: 1 }));
      await expect(packageZdx(folder, output)).rejects.toThrow('exactly one');
      await writeFile(join(folder, 'main.js'), 'throw new Error("do not run");');
      await symlink(join(folder, 'main.js'), join(folder, 'linked.js'));
      await expect(packageZdx(folder, output)).rejects.toThrow('symlinks');
      await rm(join(folder, 'linked.js'));
      await writeFile(join(folder, 'CON.txt'), 'invalid');
      await expect(packageZdx(folder, output)).rejects.toThrow('nonportable');
      expect(await readFile(output, 'utf8')).toBe('keep');
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
});
