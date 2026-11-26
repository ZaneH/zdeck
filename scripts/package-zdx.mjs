// Offline prebuilt ZIP packaging. Reads files only: never imports or executes package code.
import { lstat, readFile, readdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { packageSpotify, packageHomeAssistant } from './package-spotify.mjs';

const reserved = new Set(['manifest.json', 'main.js', 'main.py', 'package.json', 'node_modules', 'node_modules/@zdeck', 'node_modules/@zdeck/plugin-sdk',
  'node_modules/@zdeck/plugin-sdk/package.json', 'node_modules/@zdeck/plugin-sdk/index.js', 'zdeck_plugin_sdk', 'zdeck_plugin_sdk/__init__.py', 'zdeck_plugin_sdk/types.py']);
const portable = (part) => part.length > 0 && part.length <= 64 && /^[a-zA-Z0-9._@+-]+$/.test(part)
  && part !== '.' && part !== '..' && !part.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part);
async function realDirectory(path) {
  for (let current = path; ; current = dirname(current)) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Source and output ancestors must be real directories, not symlinks.');
    if (dirname(current) === current) break;
  }
}
/** Generic packager for an already-prebuilt root-layout folder. Metadata is JSON, never describe. */
export async function packageZdx(folder, output) {
  if (resolve(folder) !== folder || resolve(output) !== output || !output.endsWith('.zdx')) throw new Error('Use absolute local folder and .zdx output paths.');
  await realDirectory(folder);
  await realDirectory(dirname(output));
  const files = Object.create(null);
  const names = new Map();
  let total = 0;
  let count = 0;
  async function walk(directory, prefix = '') {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const name = prefix + entry.name;
      if (!portable(entry.name) || name.length > 200 || name.split('/').length > 16 || (reserved.has(name.toLowerCase()) && name !== name.toLowerCase())) throw new Error('Package contains a nonportable path.');
      if (++count > 4096 || names.has(name.toLowerCase())) throw new Error('Package has too many entries or case-ambiguous paths.');
      names.set(name.toLowerCase(), name);
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error('Package symlinks are not allowed.');
      if (info.isDirectory()) await walk(path, `${name}/`);
      else if (info.isFile()) {
        if (info.nlink !== 1 || info.size > 8 * 1024 * 1024) throw new Error('Only bounded regular files without hardlinks can be packaged.');
        total += info.size;
        if (total > 64 * 1024 * 1024) throw new Error('Package exceeds the 64 MiB unpacked limit.');
        files[name] = new Uint8Array(await readFile(path));
        if (files[name].length !== info.size) throw new Error('Package changed while being read.');
      } else throw new Error('Only regular files and directories can be packaged.');
    }
  }
  await walk(folder);
  if (!files['manifest.json'] || files['manifest.json'].length > 16384 || !!files['main.js'] === !!files['main.py']) throw new Error('Root manifest.json and exactly one main.js or main.py are required.');
  const manifest = JSON.parse(Buffer.from(files['manifest.json']).toString('utf8'));
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(manifest.id) || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(manifest.version) || manifest.protocolVersion !== 1) throw new Error('Unsupported manifest identity or protocol.');
  // Stored ZIP32 is interoperable and cannot create excessive compression ratios. The desktop
  // independently validates the entire manifest, SDK, layout, CRCs and package fingerprint.
  const bytes = zipSync(files, { level: 0, mtime: new Date(2020, 0, 1, 0, 0, 0) });
  if (bytes.length > 16 * 1024 * 1024) throw new Error('Archive exceeds the 16 MiB limit.');
  const temporary = join(dirname(output), `.zdeck-zdx-${randomUUID()}`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o644 });
    await rename(temporary, output); // replace the generated archive inode, never follow output links
  } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
  return { path: output, id: manifest.id, version: manifest.version, sha256: createHash('sha256').update(bytes).digest('hex') };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const id = process.argv[2];
    if (process.argv.length !== 3 || !['spotify', 'home-assistant'].includes(id)) throw new Error('Usage: node scripts/package-zdx.mjs spotify|home-assistant');
    const folder = await (id === 'spotify' ? packageSpotify() : packageHomeAssistant());
    const result = await packageZdx(folder, join(dirname(folder), `${id}.zdx`));
    console.log(`${result.path}\nSHA-256 ${result.sha256}\nLocal unsigned package only. Nothing was installed, trusted or enabled.`);
  } catch (error) { console.error(error instanceof Error ? error.message : 'Archive packaging failed.'); process.exitCode = 1; }
}
