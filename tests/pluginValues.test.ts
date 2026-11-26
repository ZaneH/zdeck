import { describe, expect, it } from 'vitest';
import manifest from '../plugins/home-assistant/manifest.json';
import { canRunPlugin, parsePluginManifest, pluginValue, pluginDefaults } from '../src/lib/plugin';
import type { PluginManifest, PluginSnapshot } from '../src/lib/plugin';
import { compatiblePresentations, controlContract, effectivePresentation, validControlValue } from '../src/lib/presentations';
import { isDeck, createDefaultDeck } from '../src/lib/deck';
import type { PluginControl } from '../src/lib/types';
const parsed = parsePluginManifest(manifest)!;
const snapshot = (value: boolean | number | null): PluginSnapshot => ({ status: 'connected', manifest: parsed, lastError: null,
  state: { entities: [{ value: 7, label: 'Kitchen', description: 'light.kitchen', available: value !== null,
    observation: { value, unit: '', observedAtMs: 1000 } }] } });
const power: PluginControl = { id: 'ha', label: 'Kitchen', action: 'plugin', pluginId: 'home-assistant', pluginAction: 'power', pluginArgs: { entity: 7, enabled: false } };

describe('selected observations and read-only bindings', () => {
  it('validates the actual manifest and rejects ambiguous or executable read contracts', () => {
    expect(parsed).not.toBeNull();
    for (const change of [
      (m: PluginManifest) => { m.values![0].id = 'power'; },
      (m: PluginManifest) => { m.values![0].entityKey = 'other'; },
      (m: PluginManifest) => { m.values![0].stateKey = 'other'; },
      (m: PluginManifest) => { m.values![0].config.extra = { type: 'boolean' }; },
      (m: PluginManifest) => { (m.actions[0].config.enabled as any).control.entityKey = null; },
    ]) { const changed = structuredClone(parsed); change(changed); expect(parsePluginManifest(changed)).toBeNull(); }
  });
  it('preserves fixed saved buttons while explicit toggles use the selected entity only', () => {
    expect(effectivePresentation(power, { 'home-assistant': snapshot(true) })).toBe('button');
    const toggle: PluginControl = { ...power, presentation: 'toggle-switch' };
    expect(controlContract(toggle, { 'home-assistant': snapshot(true) })).toEqual({ kind: 'boolean', value: true });
    expect(controlContract(toggle, { 'home-assistant': snapshot(null) })).toEqual({ kind: 'boolean', value: null });
    expect(validControlValue(toggle, 1, { 'home-assistant': snapshot(null) })).toBe(false);
    expect(pluginDefaults(parsed.actions[0])).toEqual({ entity: 1, enabled: false });
    const unavailable = snapshot(true); (unavailable.state!.entities as any[])[0].available = false;
    expect(controlContract(toggle, { 'home-assistant': unavailable })).toEqual({ kind: 'boolean', value: null });
  });
  it('readings cannot run or accept target values, even without a manifest', () => {
    const value: PluginControl = { ...power, pluginAction: 'state', pluginArgs: { entity: 7 }, presentation: 'value' };
    expect(pluginValue(snapshot(false), value)).toEqual({ value: false, unit: '', observedAtMs: 1000 });
    expect(canRunPlugin(snapshot(false), value)).toBe(false);
    expect(validControlValue(value, 1, { 'home-assistant': snapshot(false) })).toBe(false);
    expect(compatiblePresentations(value)).toEqual(['value']);
    expect(pluginValue({ ...snapshot(false), status: 'stopped', state: null }, value)).toBeNull();
    const deck = createDefaultDeck();
    deck.pages[0].sections[0].controls = [value];
    expect(isDeck(JSON.parse(JSON.stringify(deck)))).toBe(true);
  });
  it('rejects malformed observations instead of inventing state', () => {
    const value: PluginControl = { ...power, pluginAction: 'state', pluginArgs: { entity: 7 }, presentation: 'value' };
    for (const observation of [{ value: 'on', unit: '', observedAtMs: 1000 }, { value: 20, unit: 'x'.repeat(25), observedAtMs: 1000 }, { value: 20, unit: '°C', observedAtMs: 0 }]) {
      const state = snapshot(false); (state.state!.entities as any[])[0].observation = observation;
      expect(pluginValue(state, value)).toBeNull();
    }
  });
});
