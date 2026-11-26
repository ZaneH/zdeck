import type { Readable, Writable } from 'node:stream';

export const PROTOCOL_VERSION: 1;
export const LIMITS: Readonly<{
  requestBytes: 16384; responseBytes: 65536; manifestBytes: 16384; requestTimeoutMs: 10000;
}>;
/** At most one field per action may declare control. Integer values align to minimum + n * step. */
export interface IntegerConfig { type: 'integer'; minimum: number; maximum: number; control?: { step: number }; /** Names a bounded state array for UI selection; never combine with control. */ choicesKey?: string }
/** true means On, false means Off; stateKey reads an observed top-level boolean, never inferred playback. */
export interface BooleanConfig { type: 'boolean'; control?: { stateKey: string } }
/** choicesKey arrays: at most 256 unique bounded values, with nonempty labels up to 160 characters.
 * The app validates these display-only arrays; plugins must independently validate the selected binding. */
export interface Choice { value: number; label: string; available: boolean }
export type Args = Record<string, number | boolean>;
export interface Action { id: string; title: string; config: Record<string, IntegerConfig | BooleanConfig> }
export interface SettingsField { type: 'text' | 'secret'; label: string }
/** Declared settings keys and the operator-visible label for each. At most four. */
export type Settings = Record<string, SettingsField>;
export type SettingsValues = Record<string, string>;
/** Base64 data URL: PNG, JPEG, WebP, GIF or SVG. At most 8192 characters, within the 16 KiB manifest budget. */
export interface Icon { id: string; title: string; category: string; src: string }
export interface Manifest { id: string; version: string; protocolVersion: 1; actions: Action[]; icons?: Icon[]; /** Optional plugin-identity thumbnail: one bounded embedded image data URL. */ icon?: string; /** Optional settings required before state or execution. */ settings?: Settings }
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type State = { [key: string]: Json };
export type Request =
  | { protocolVersion: 1; id: string; type: 'describe' | 'state' }
  | { protocolVersion: 1; id: string; type: 'execute'; action: string; args: Args }
  | { protocolVersion: 1; id: string; type: 'configure'; settings: SettingsValues };
export type ErrorCode = 'invalid_request' | 'request_too_large' | 'unknown_action' | 'invalid_arguments'
  | 'internal_error' | 'response_too_large' | 'timeout' | 'unsupported_platform' | 'app_missing'
  | 'app_not_running' | 'automation_denied' | 'command_failed' | 'invalid_state' | 'outcome_unknown'
  | 'authentication_failed' | 'connection_failed' | 'state_required' | 'entity_unavailable';
export type Response =
  | { protocolVersion: 1; id: string; type: 'result'; manifest: Manifest }
  | { protocolVersion: 1; id: string; type: 'result'; state: State }
  | { protocolVersion: 1; id: string | null; type: 'error'; error: {
      code: ErrorCode; message: string; hint: string; outcome: 'unknown' | 'not_started';
    } };
export class PluginError extends Error { readonly code: ErrorCode; constructor(code: ErrorCode) }
export interface Plugin {
  manifest: Manifest;
  state(signal: AbortSignal): State | Promise<State>;
  execute(action: string, args: Args, signal: AbortSignal): State | Promise<State>;
  /** Required when the manifest declares settings; its return value is ignored. */
  configure?(settings: SettingsValues, signal: AbortSignal): void | Promise<void>;
}
export function validateManifest(value: unknown): Manifest;
export function validateArguments(action: Action, args: unknown): Args;
export function serve(plugin: Plugin, streams?: { input?: Readable; output?: Writable }): Promise<void>;
