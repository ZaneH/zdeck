import { createHash } from 'node:crypto';
import manifest from './manifest.json' with { type: 'json' };

const MAX_ENTITY = 281474976710655; // 48-bit control value; also the manifest maximum.
const MAX_LABEL_BYTES = 160;
const MAX_CHOICES = 100;
const MAX_STATE_BYTES = 50000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_DISCOVERY_ITEMS = 5000;
const MAX_URL_LENGTH = 2048;
const MAX_TOKEN_LENGTH = 2048;
const ENTITY_ID = /^(?:light|switch)\.[a-z0-9_]+$/;
const POWERS = new Set(['on', 'off']);
const PRIVATE_SUFFIXES = ['.local', '.lan', '.home.arpa'];

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Scope bindings to the configured origin: changing instances must not retarget saved controls.
function hashEntityId(entityId, origin) {
  return createHash('sha256').update(`${origin}\n${entityId}`, 'utf8').digest().readUIntBE(0, 6);
}

function clipLabel(value) {
  const clean = value.replace(/\p{Cc}/gu, ' ');
  const bytes = Buffer.from(clean, 'utf8');
  if (bytes.length <= MAX_LABEL_BYTES) return clean;
  let end = MAX_LABEL_BYTES;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function privateIpv4(hostname) {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const [a, b] = octets;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function localSuffix(hostname) {
  return PRIVATE_SUFFIXES.some((suffix) => hostname.length > suffix.length && hostname.endsWith(suffix));
}

// Settings are origin-only. Plain HTTP is limited to loopback/private/link-local IPv4 and local hostnames.
function validateSettings(settings) {
  if (!record(settings) || Object.keys(settings).length !== 2
    || !Object.hasOwn(settings, 'url') || !Object.hasOwn(settings, 'token')) return null;
  const { url, token } = settings;
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH
    || /[\x00-\x20\x7f]/.test(url) || url.includes('?') || url.includes('#')) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname
    || parsed.username || parsed.password || parsed.search || parsed.hash
    || parsed.pathname !== '/') return null;
  if (parsed.protocol === 'http:'
    && !privateIpv4(parsed.hostname) && !localSuffix(parsed.hostname)) return null;
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH
    || /[\x00-\x20\x7f]/.test(token)) return null;
  return { origin: parsed.origin, token };
}

function supportedBrightness(attributes) {
  const modes = attributes.supported_color_modes;
  return Array.isArray(modes) && modes.some((mode) => ['brightness', 'color_temp', 'hs', 'xy', 'rgb', 'rgbw', 'rgbww', 'white'].includes(mode));
}

function brightnessPercent(attributes) {
  if (typeof attributes.brightness === 'number' && Number.isFinite(attributes.brightness)
    && attributes.brightness >= 0 && attributes.brightness <= 255) {
    return Math.round((attributes.brightness * 100) / 255);
  }
  return null;
}

function observedLabel(candidate) {
  const state = POWERS.has(candidate.state) ? candidate.state : 'unavailable';
  const suffix = state === 'on' && candidate.brightness !== null ? `, ${candidate.brightness}%` : '';
  return `${candidate.id} — ${state}${suffix}${candidate.name === candidate.id ? '' : ` · ${candidate.name}`}`;
}

function readChoices(raw) {
  const candidates = [];
  for (const item of raw.slice(0, MAX_DISCOVERY_ITEMS)) {
    if (!record(item) || typeof item.entity_id !== 'string' || !ENTITY_ID.test(item.entity_id) || item.entity_id.length > 128) continue;
    const attributes = record(item.attributes) ? item.attributes : {};
    const domain = item.entity_id.slice(0, item.entity_id.indexOf('.'));
    const name = typeof attributes.friendly_name === 'string' && attributes.friendly_name.trim()
      ? attributes.friendly_name.trim() : item.entity_id;
    candidates.push({
      id: item.entity_id,
      domain,
      state: typeof item.state === 'string' ? item.state : 'unknown',
      name,
      brightness: brightnessPercent(attributes),
      brightCapable: domain === 'light' && supportedBrightness(attributes),
    });
  }
  return candidates;
}

function optionalDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createHomeAssistant({
  fetch: doFetch = globalThis.fetch,
  PluginError,
  hash = hashEntityId,
  delay = optionalDelay,
  budgetMs = 8000,
  readbackAttempts = 5,
  readbackDelayMs = 150,
} = {}) {
  if (typeof doFetch !== 'function' || typeof PluginError !== 'function') {
    throw new TypeError('Home Assistant plugin needs fetch and PluginError.');
  }
  let config = null;
  let latched = false;
  let needsRead = true;
  // Values already bound to an entity id. A later different id with the same value is a replacement.
  let known = new Map();

  const authHeaders = () => ({ Authorization: `Bearer ${config.token}` });

  async function response(url, init, signal) {
    try {
      return await doFetch(url, { ...init, redirect: 'error', signal });
    } catch {
      throw new PluginError(signal?.aborted ? 'timeout' : 'connection_failed');
    }
  }

  async function bodyText(res) {
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          try { await reader.cancel(); } catch { /* already closed */ }
          throw new PluginError('invalid_state');
        }
        chunks.push(chunk);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* released with cancel */ }
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  function bind(candidates) {
    const counts = new Map();
    for (const candidate of candidates) {
      candidate.value = hash(candidate.id, config.origin);
      if (counts.has(candidate.value)) counts.set(candidate.value, counts.get(candidate.value) + 1);
      else counts.set(candidate.value, 1);
    }
    const usable = [];
    for (const candidate of candidates) {
      const { value } = candidate;
      if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ENTITY) continue;
      if (counts.get(value) !== 1) continue;
      if (known.has(value) && known.get(value) !== candidate.id) continue;
      known.set(value, candidate.id);
      candidate.available = POWERS.has(candidate.state);
      candidate.label = clipLabel(observedLabel(candidate));
      usable.push(candidate);
    }
    return usable;
  }

  function choices(candidates) {
    let power = candidates.map((candidate) => ({
      candidate, entry: { value: candidate.value, label: candidate.label, available: candidate.available },
    })).slice(0, MAX_CHOICES);
    let brightness = candidates.filter((candidate) => candidate.brightCapable).map((candidate) => ({
      candidate, entry: { value: candidate.value, label: candidate.label, available: candidate.available },
    })).slice(0, MAX_CHOICES);
    const state = () => ({
      entities: power.map((item) => item.entry),
      'brightness-entities': brightness.map((item) => item.entry),
    });
    while (Buffer.byteLength(JSON.stringify(state())) > MAX_STATE_BYTES && (power.length || brightness.length)) {
      if (power.length >= brightness.length) power.pop();
      else brightness.pop();
    }
    return {
      state: state(),
      power: new Map(power.map((item) => [item.entry.value, item.candidate])),
      brightness: new Map(brightness.map((item) => [item.entry.value, item.candidate])),
    };
  }

  async function discover(signal) {
    if (!config) throw new PluginError('internal_error');
    const res = await response(`${config.origin}/api/states`, { method: 'GET', headers: authHeaders() }, signal);
    if (!res.ok) throw new PluginError(res.status === 401 || res.status === 403 ? 'authentication_failed' : 'connection_failed');
    let raw;
    try { raw = JSON.parse(await bodyText(res)); } catch (error) {
      if (error instanceof PluginError) throw error;
      throw new PluginError('invalid_state');
    }
    if (!Array.isArray(raw)) throw new PluginError('invalid_state');
    return choices(bind(readChoices(raw)));
  }

  async function readEntity(entityId, signal) {
    const res = await response(
      `${config.origin}/api/states/${encodeURIComponent(entityId)}`,
      { method: 'GET', headers: authHeaders() },
      signal,
    );
    if (!res.ok) throw new PluginError(res.status === 401 || res.status === 403 ? 'authentication_failed' : 'connection_failed');
    let value;
    try { value = JSON.parse(await bodyText(res)); } catch (error) {
      if (error instanceof PluginError) throw error;
      throw new PluginError('invalid_state');
    }
    if (!record(value) || value.entity_id !== entityId || typeof value.state !== 'string') {
      throw new PluginError('invalid_state');
    }
    return value;
  }

  function validateArguments(action, args) {
    if (!record(args) || Object.keys(args).length !== Object.keys(action.config).length) {
      throw new PluginError('invalid_arguments');
    }
    for (const [key, field] of Object.entries(action.config)) {
      if (!Object.hasOwn(args, key)) throw new PluginError('invalid_arguments');
      if (field.type === 'boolean') {
        if (typeof args[key] !== 'boolean') throw new PluginError('invalid_arguments');
      } else if (!Number.isSafeInteger(args[key]) || args[key] < field.minimum || args[key] > field.maximum
        || (field.control && (args[key] - field.minimum) % field.control.step !== 0)) {
        throw new PluginError('invalid_arguments');
      }
    }
  }

  function matches(entity, action, args) {
    if (entity.state === 'unavailable' || entity.state === 'unknown') return false;
    if (action === 'power') return args.enabled ? entity.state === 'on' : entity.state === 'off';
    // Brightness 0 is sent as turn_off; anything else must read back on at the requested percentage.
    if (args.brightness === 0) return entity.state === 'off';
    const attributes = record(entity.attributes) ? entity.attributes : {};
    return entity.state === 'on' && brightnessPercent(attributes) === args.brightness;
  }

  async function withinDeadline(signal, work) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    const forward = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', forward, { once: true });
    if (controller.signal.aborted) {
      clearTimeout(timer);
      throw new PluginError('timeout');
    }
    try { return await work(controller.signal); } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forward);
    }
  }

  return {
    manifest,

    async configure(settings) {
      const next = validateSettings(settings);
      if (!next) throw new PluginError('invalid_arguments');
      config = next;
      needsRead = true;
      latched = false;
      known = new Map();
      return {};
    },

    async state(signal) {
      return withinDeadline(signal, async (deadline) => {
        const result = await discover(deadline);
        needsRead = false;
        latched = false;
        return result.state;
      });
    },

    async execute(actionId, args, signal) {
      const definition = manifest.actions.find((action) => action.id === actionId);
      if (!definition) throw new PluginError('unknown_action');
      if (latched) throw new PluginError('outcome_unknown');
      validateArguments(definition, args);
      if (!config) throw new PluginError('internal_error');
      return withinDeadline(signal, async (deadline) => {
        if (needsRead) throw new PluginError('state_required');
        const discovery = await discover(deadline);
        const candidate = (actionId === 'power' ? discovery.power : discovery.brightness).get(args.entity);
        // No binding means renamed, collided, replaced or trimmed away: fail closed.
        if (!candidate) {
          if (actionId === 'brightness' && discovery.power.has(args.entity)) {
            throw new PluginError('invalid_state');
          }
          throw new PluginError('invalid_arguments');
        }
        if (!candidate.available) throw new PluginError('entity_unavailable');
        if (actionId === 'brightness' && !candidate.brightCapable) throw new PluginError('invalid_state');

        const service = actionId === 'power' ? (args.enabled ? 'turn_on' : 'turn_off')
          : (args.brightness === 0 ? 'turn_off' : 'turn_on');
        const payload = { entity_id: candidate.id };
        if (actionId === 'brightness' && args.brightness > 0) payload.brightness_pct = args.brightness;

        let res;
        try {
          res = await response(`${config.origin}/api/services/${candidate.domain}/${service}`, {
            method: 'POST',
            headers: { ...authHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          }, deadline);
        } catch {
          latched = true;
          throw new PluginError('outcome_unknown');
        }
        try { await bodyText(res); } catch { /* delivery already decided below */ }
        if (!res.ok) {
          // A 4xx rejection is a known failure; a server/request-timeout status may have applied.
          if (res.status >= 500 || res.status === 408) {
            latched = true;
            throw new PluginError('outcome_unknown');
          }
          throw new PluginError(res.status === 401 || res.status === 403 ? 'authentication_failed' : 'command_failed');
        }

        let confirmed = false;
        let observed;
        for (let attempt = 0; attempt < readbackAttempts && !confirmed; attempt += 1) {
          try {
            observed = await readEntity(candidate.id, deadline);
            confirmed = matches(observed, actionId, args);
          } catch (error) {
            if (error.code === 'timeout') break;
          }
          if (!confirmed && attempt + 1 < readbackAttempts) {
            await delay(readbackDelayMs);
            if (deadline.aborted) break;
          }
        }
        if (!confirmed) {
          // Never repeat the POST. The host must reconcile with an explicit state read first.
          latched = true;
          throw new PluginError('outcome_unknown');
        }
        // Return the confirmed observation, never the stale pre-command label on a later read failure.
        const label = clipLabel(observedLabel({ ...candidate, state: observed.state,
          brightness: brightnessPercent(record(observed.attributes) ? observed.attributes : {}) }));
        for (const list of Object.values(discovery.state)) {
          for (const choice of list) if (choice.value === args.entity) choice.label = label;
        }
        return discovery.state;
      });
    },
  };
}
