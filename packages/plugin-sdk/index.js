import { TextDecoder } from 'node:util';

export const PROTOCOL_VERSION = 1;
export const LIMITS = Object.freeze({ requestBytes: 16384, responseBytes: 65536, manifestBytes: 16384, requestTimeoutMs: 10000 });
const errors = {
  invalid_request: ['Invalid protocol v1 request.', 'Check the request shape, version, ID and newline framing.'],
  request_too_large: ['Request exceeds 16384 bytes.', 'Send a smaller request.'],
  unknown_action: ['Action is not declared by this plugin.', 'Use describe to discover supported action IDs.'],
  invalid_arguments: ['Action arguments do not match its configuration.', 'Use only declared fields with bounded, step-aligned integers or boolean values.'],
  internal_error: ['Plugin operation failed.', 'Check trusted local stderr diagnostics; do not automatically retry actions.'],
  response_too_large: ['Plugin response exceeds 65536 bytes.', 'Reduce the state returned by the plugin.'],
  timeout: ['Plugin operation timed out.', 'Restart the plugin; inspect state before manually retrying an action.'],
  unsupported_platform: ['Spotify control requires macOS.', 'Run this plugin on macOS with Spotify desktop installed.'],
  app_missing: ['Spotify was not found at /Applications/Spotify.app.', 'Install Spotify desktop in /Applications.'],
  app_not_running: ['Spotify is not running.', 'Open Spotify manually, then try again.'],
  automation_denied: ['macOS denied Spotify Automation access.', 'Allow the launching application to control Spotify in Privacy & Security > Automation.'],
  command_failed: ['Plugin command failed.', 'Check the integration connection and permissions; inspect state before manually retrying an action.'],
  invalid_state: ['Plugin returned unreadable state.', 'Check plugin compatibility and restart the plugin.'],
  authentication_failed: ['Integration authentication failed.', 'Disable the plugin, replace its saved token in connection settings, apply and enable again.'],
  connection_failed: ['Integration connection failed.', 'Check the configured URL, network and trusted TLS certificate. No automatic retry was made.'],
  state_required: ['Read state before running this action.', 'After enabling or reconnecting, explicitly read state to inspect devices before deciding whether to send an action.'],
  entity_unavailable: ['Selected entity is unavailable.', 'Read state and check the device in Home Assistant before deciding whether to run it.'],
  outcome_unknown: ['Action may have applied, but state could not be read.', 'Read state before deciding whether to retry; never automatically retry.'],
};
export class PluginError extends Error {
  constructor(code) {
    super(Object.hasOwn(errors, code) ? errors[code][0] : errors.internal_error[0]);
    this.code = Object.hasOwn(errors, code) ? code : 'internal_error';
  }
}
const record = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, keys) => record(x) && Object.keys(x).length === keys.length && keys.every((key) => Object.hasOwn(x, key));
const identifier = (x) => typeof x === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(x);
const requestId = (x) => typeof x === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x);
const text = (x) => typeof x === 'string' && x.length > 0 && x.length <= 80 && !/[\x00-\x1f\x7f]/.test(x);
const integer = Number.isSafeInteger;
const settingsField = (x) => exact(x, ['type', 'label']) && (x.type === 'text' || x.type === 'secret') && text(x.label);
const pluginSettings = (x) => record(x) && Object.keys(x).length <= 4
  && Object.entries(x).every(([key, field]) => identifier(key) && settingsField(field));

function iconSource(value) {
  return typeof value === 'string' && value.length <= 8192 && !value.endsWith(',')
    && /^data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}
function pluginIcons(value) {
  if (!Array.isArray(value) || value.length > 32) return false;
  const ids = new Set();
  return value.every((icon) => {
    if (!exact(icon, ['id', 'title', 'category', 'src']) || !identifier(icon.id) || ids.has(icon.id)
      || !text(icon.title) || !icon.title.trim() || !text(icon.category) || !icon.category.trim() || !iconSource(icon.src)) return false;
    ids.add(icon.id);
    return true;
  });
}

function validField(field) {
  if (!record(field)) return false;
  const controlled = Object.hasOwn(field, 'control');
  const choices = Object.hasOwn(field, 'choicesKey');
  if (field.type === 'boolean') return exact(field, ['type', ...(controlled ? ['control'] : [])])
    && (!controlled || exact(field.control, ['stateKey']) && identifier(field.control.stateKey));
  return field.type === 'integer' && exact(field, ['type', 'minimum', 'maximum',
    ...(controlled ? ['control'] : []), ...(choices ? ['choicesKey'] : [])])
    && integer(field.minimum) && integer(field.maximum) && field.minimum <= field.maximum
    && !(controlled && choices) && (!choices || identifier(field.choicesKey))
    && (!controlled || exact(field.control, ['step']) && integer(field.control.step) && field.control.step > 0
      && Number.isSafeInteger(field.maximum - field.minimum) && field.control.step <= field.maximum - field.minimum && (field.maximum - field.minimum) % field.control.step === 0);
}

export function validateManifest(value) {
  let valid = record(value) && exact(value, ['id', 'version', 'protocolVersion', 'actions', ...(Object.hasOwn(value, 'icons') ? ['icons'] : []), ...(Object.hasOwn(value, 'icon') ? ['icon'] : []), ...(Object.hasOwn(value, 'settings') ? ['settings'] : [])])
    && (!Object.hasOwn(value, 'icons') || pluginIcons(value.icons)) && (!Object.hasOwn(value, 'icon') || iconSource(value.icon))
    && (!Object.hasOwn(value, 'settings') || pluginSettings(value.settings)) && identifier(value.id)
    && typeof value.version === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value.version)
    && value.protocolVersion === 1 && Array.isArray(value.actions) && value.actions.length > 0 && value.actions.length <= 32;
  const seen = new Set();
  if (valid) for (const action of value.actions) {
    if (!exact(action, ['id', 'title', 'config']) || !identifier(action.id) || seen.has(action.id) || !text(action.title)
      || !record(action.config) || Object.keys(action.config).length > 8) { valid = false; break; }
    seen.add(action.id);
    for (const [key, field] of Object.entries(action.config)) {
      if (!identifier(key) || !validField(field)) valid = false;
    }
    if (Object.values(action.config).filter((field) => field.control).length > 1) valid = false;
  }
  if (!valid || Buffer.byteLength(JSON.stringify(value)) > LIMITS.manifestBytes) throw new TypeError('Invalid plugin manifest.');
  return value;
}

export function validateArguments(action, args) {
  if (!record(args) || Object.keys(args).length !== Object.keys(action.config).length
    || !Object.entries(action.config).every(([key, field]) => Object.hasOwn(args, key)
      && (field.type === 'boolean' ? typeof args[key] === 'boolean'
        : integer(args[key]) && args[key] >= field.minimum && args[key] <= field.maximum
          && (!field.control || (args[key] - field.minimum) % field.control.step === 0)))) {
    throw new PluginError('invalid_arguments');
  }
  return args;
}

function validateSettings(declared, settings) {
  if (!record(settings) || Object.keys(settings).length !== Object.keys(declared).length
    || !Object.keys(declared).every((key) => Object.hasOwn(settings, key)
      && typeof settings[key] === 'string' && Buffer.byteLength(settings[key]) <= 2048)) {
    throw new PluginError('invalid_arguments');
  }
  return settings;
}

function validateRequest(value) {
  if (!record(value) || value.protocolVersion !== 1 || !requestId(value.id)
    || !['describe', 'state', 'execute', 'configure'].includes(value.type)
    || !exact(value, value.type === 'execute'
      ? ['protocolVersion', 'id', 'type', 'action', 'args']
      : value.type === 'configure' ? ['protocolVersion', 'id', 'type', 'settings']
        : ['protocolVersion', 'id', 'type'])
    || (value.type === 'execute' && (!identifier(value.action) || !record(value.args)))
    || (value.type === 'configure' && !record(value.settings))) {
    throw new PluginError('invalid_request');
  }
  return value;
}

// Keep at most one bounded line; discard oversized lines through their next LF.
async function* frames(input) {
  let parts = [], size = 0, oversized = false;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < bytes.length) {
      const end = bytes.indexOf(10, start);
      const part = bytes.subarray(start, end < 0 ? bytes.length : end);
      size += part.length;
      if (size > LIMITS.requestBytes) { oversized = true; parts = []; }
      else if (!oversized) parts.push(Buffer.from(part));
      if (end < 0) break;
      yield oversized ? null : Buffer.concat(parts);
      parts = []; size = 0; oversized = false; start = end + 1;
    }
  }
  if (size) yield oversized ? null : false;
}

export async function serve(plugin, { input = process.stdin, output = process.stdout } = {}) {
  // Snapshot metadata so a handler cannot silently change the advertised contract.
  const manifest = JSON.parse(JSON.stringify(validateManifest(plugin.manifest)));
  let configured = false;
  for await (const frame of frames(input)) {
    let id = null, invoked = false, timedOut = false, response;
    try {
      if (frame === null) throw new PluginError('request_too_large');
      if (frame === false) throw new PluginError('invalid_request');
      let request;
      try { request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame)); }
      catch { throw new PluginError('invalid_request'); }
      if (record(request) && requestId(request.id)) id = request.id;
      validateRequest(request);
      let result;
      if (request.type === 'describe') result = { manifest };
      else {
        if (request.type === 'configure') {
          configured = false;
          if (!Object.hasOwn(manifest, 'settings')) throw new PluginError('invalid_request');
          validateSettings(manifest.settings, request.settings);
          if (typeof plugin.configure !== 'function') throw new PluginError('internal_error');
        } else if (Object.hasOwn(manifest, 'settings') && !configured) {
          throw new PluginError('invalid_request');
        }
        if (request.type === 'execute') {
          const action = manifest.actions.find((item) => item.id === request.action);
          if (!action) throw new PluginError('unknown_action');
          validateArguments(action, request.args);
        }
        const controller = new AbortController();
        let timer;
        try {
          invoked = request.type === 'execute';
          const handler = request.type === 'configure' ? () => plugin.configure(request.settings, controller.signal)
            : request.type === 'state' ? () => plugin.state(controller.signal)
              : () => plugin.execute(request.action, request.args, controller.signal);
          const value = await Promise.race([
            Promise.resolve().then(handler),
            new Promise((_, reject) => { timer = setTimeout(() => {
              timedOut = true; reject(new PluginError('timeout')); controller.abort();
            }, LIMITS.requestTimeoutMs); }),
          ]);
          // Configure returns no state; the protocol always answers with exactly {}.
          if (request.type === 'configure') { configured = true; result = { state: {} }; }
          else result = { state: value };
          // State is a JSON object, never undefined, class instances or executable data.
          if (!record(result.state)) throw new PluginError('invalid_state');
          const json = JSON.stringify(result.state);
          if (json === undefined || !record(JSON.parse(json))) throw new PluginError('invalid_state');
        } finally { clearTimeout(timer); }
      }
      response = JSON.stringify({ protocolVersion: 1, id, type: 'result', ...result });
      if (Buffer.byteLength(response) > LIMITS.responseBytes) throw new PluginError('response_too_large');
    } catch (error) {
      const code = error instanceof PluginError && Object.hasOwn(errors, error.code) ? error.code : 'internal_error';
      if (code === 'timeout') timedOut = true;
      const [message, hint] = errors[code];
      response = JSON.stringify({ protocolVersion: 1, id, type: 'error', error: {
        code, message, hint, outcome: invoked ? 'unknown' : 'not_started',
      } });
    }
    await new Promise((resolve, reject) => output.write(response + '\n', (error) => error ? reject(error) : resolve()));
    // A timed-out handler might still be running: never start another request in this process.
    if (timedOut) return;
  }
}
