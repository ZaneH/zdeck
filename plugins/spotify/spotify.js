import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import manifest from './manifest.json' with { type: 'json' };
import { PluginError, validateArguments, validateManifest } from '@zdeck/plugin-sdk';

const APP_PATH = '/Applications/Spotify.app';
const preflight = `const app = Application('com.spotify.client');
if (!app.running()) throw new Error('ZDECK_NOT_RUNNING');`;
// Fixed JavaScript for Automation sources. User data is argv, never script source.
const commands = Object.freeze({
  play: 'app.play();', pause: 'app.pause();', 'play-pause': 'app.playpause();',
  next: 'app.nextTrack();', previous: 'app.previousTrack();',
  'set-volume': `const volume = Number(argv[0]);
if (argv.length !== 1 || !Number.isInteger(volume) || volume < 0 || volume > 100) throw new Error('ZDECK_BAD_VOLUME');
app.soundVolume = volume;`,
});
const scripts = Object.freeze(Object.fromEntries(Object.entries(commands).map(([id, command]) =>
  [id, `function run(argv) { ${preflight}\n${command}\n}`])));
const stateScript = `function run() {
${preflight}
const playback = app.playerState();
let title = null, artist = null;
if (playback !== 'stopped') {
  const track = app.currentTrack();
  title = track.name(); artist = track.artist();
}
return JSON.stringify({ title, artist, playback, volume: app.soundVolume() });
}`;

function runProcess(file, args, options) {
  return new Promise((resolve, reject) => execFile(file, args, options, (error, stdout, stderr) => {
    if (error) { error.stderr = stderr; reject(error); }
    else resolve(stdout);
  }));
}

export function createSpotify({ platform = process.platform, runner = runProcess,
  appExists = () => access(APP_PATH, constants.R_OK) } = {}) {
  validateManifest(manifest);
  async function invoke(script, args, signal) {
    if (platform !== 'darwin') throw new PluginError('unsupported_platform');
    try { await appExists(); } catch { throw new PluginError('app_missing'); }
    try {
      const stdout = await runner('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, ...args], {
        shell: false, timeout: 3000, maxBuffer: 8192, encoding: 'utf8', killSignal: 'SIGKILL', signal,
      });
      if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 8192) throw new PluginError('invalid_state');
      return stdout;
    } catch (error) {
      if (error instanceof PluginError) throw error;
      // Inspect diagnostics only for known errors; never send raw stderr or paths to the host.
      const diagnostic = typeof error?.stderr === 'string' ? error.stderr.slice(0, 8192) : '';
      if (/-1743|not authorized to send apple events/i.test(diagnostic)) throw new PluginError('automation_denied');
      if (diagnostic.includes('ZDECK_NOT_RUNNING') || /\(-600\)/.test(diagnostic)) throw new PluginError('app_not_running');
      if (error?.killed || error?.name === 'AbortError') throw new PluginError('timeout');
      throw new PluginError('command_failed');
    }
  }
  async function state(signal) {
    const stdout = await invoke(stateScript, [], signal);
    let value;
    try { value = JSON.parse(stdout); } catch { throw new PluginError('invalid_state'); }
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'artist,playback,title,volume'
      || !['playing', 'paused', 'stopped'].includes(value.playback)
      || !Number.isInteger(value.volume) || value.volume < 0 || value.volume > 100
      || ![value.title, value.artist].every((text) => text === null || (typeof text === 'string' && text.length <= 2048))) {
      throw new PluginError('invalid_state');
    }
    return value;
  }
  return {
    manifest,
    state,
    async execute(action, args, signal) {
      const definition = manifest.actions.find((item) => item.id === action);
      if (!definition) throw new PluginError('unknown_action');
      validateArguments(definition, args);
      await invoke(scripts[action], action === 'set-volume' ? [String(args.volume)] : [], signal);
      try { return await state(signal); } catch { throw new PluginError('outcome_unknown'); }
    },
  };
}
