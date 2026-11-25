#!/usr/bin/env node
// Offline file packaging only. Never installs dependencies or evaluates plugin code.
import { constants } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUTPUT = join(ROOT, 'dist/plugins/spotify');
const MARKER = '.zdeck-generated';
const OWNER = 'zdeck Spotify folder artifact v1\n';
const source = (path) => join(ROOT, path);

async function stat(path) {
  try { return await lstat(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function directory(path) {
  const parent = dirname(path);
  if (parent !== path) await directory(parent);
  const info = await stat(path);
  if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error('Unsafe output: directory is a symlink or not a directory.');
  if (!info) await mkdir(path);
}
async function sourceFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe source: expected a regular file.');
  return readFile(path);
}
async function validateOutput(output, files) {
  const allowedFiles = new Set(files.keys());
  const allowedDirectories = new Set();
  for (const name of allowedFiles) {
    for (let parent = dirname(name); parent !== '.'; parent = dirname(parent)) allowedDirectories.add(parent);
  }
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      const name = relative(output, full);
      if (entry.isSymbolicLink()) throw new Error('Unsafe output: symlinks are not allowed.');
      if (entry.isDirectory() && allowedDirectories.has(name)) await visit(full);
      else if (!entry.isFile() || !allowedFiles.has(name)) throw new Error('Unsafe output: unexpected files or directories; nothing was overwritten.');
    }
  }
  const info = await stat(output);
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe output directory.');
  if ((await readdir(output)).length) {
    const marker = join(output, MARKER);
    const markerInfo = await stat(marker);
    if (!markerInfo?.isFile() || markerInfo.isSymbolicLink() || markerInfo.size !== Buffer.byteLength(OWNER) || await readFile(marker, 'utf8') !== OWNER) {
      throw new Error('Refusing to overwrite a directory not owned by this packager.');
    }
  }
  await visit(output);
}

/** Output injection is for isolated tests; the CLI always uses dist/plugins/spotify. */
export async function packageSpotify(output = OUTPUT) {
  if (typeof output !== 'string' || resolve(output) !== output || output === dirname(output)) throw new Error('An absolute non-root output directory is required.');
  const files = new Map();
  for (const name of ['manifest.json', 'main.js', 'spotify.js', 'LICENSE', 'README.md']) {
    files.set(name, await sourceFile(source(`plugins/spotify/${name}`)));
  }
  const metadata = JSON.parse(await sourceFile(source('plugins/spotify/package.json')));
  const { name, version, type, license, engines } = metadata;
  const sdk = JSON.parse(await sourceFile(source('packages/plugin-sdk/package.json')));
  // Distribution copies SDK files directly, never development node_modules.
  const dependencies = { '@zdeck/plugin-sdk': sdk.version };
  files.set('package.json', Buffer.from(JSON.stringify({ name, version, private: true, type, license, engines, dependencies }, null, 2) + '\n'));
  for (const name of ['index.js', 'index.d.ts', 'package.json', 'LICENSE']) {
    files.set(join('node_modules/@zdeck/plugin-sdk', name), await sourceFile(source(`packages/plugin-sdk/${name}`)));
  }
  files.set(MARKER, Buffer.from(OWNER));
  // Validate everything before replacing any generated file. Never recursively remove output.
  await validateOutput(output, files);
  await directory(output);
  for (const [name, bytes] of files) {
    const target = join(output, name);
    await directory(dirname(target));
    const temporary = join(dirname(target), `.zdeck-tmp-${randomUUID()}`);
    await writeFile(temporary, bytes, { flag: constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode: 0o644 });
    // Atomic replacement breaks existing hardlinks instead of modifying their other targets.
    await rename(temporary, target);
  }
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('This command takes no output argument.');
    console.log(`Packaged Spotify folder: ${await packageSpotify()}`);
    console.log('Copy the complete spotify folder into ~/.config/zdeck/plugins, then Refresh in desktop Settings. Nothing was installed or enabled.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Spotify folder packaging failed.');
    process.exitCode = 1;
  }
}
