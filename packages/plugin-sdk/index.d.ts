import type { Readable, Writable } from 'node:stream';

export const PROTOCOL_VERSION: 1;
export const LIMITS: Readonly<{
  requestBytes: 16384; responseBytes: 65536; manifestBytes: 16384; requestTimeoutMs: 10000;
}>;
/** At most one field per action may declare a control. Integer values align to minimum + n * step. */
export interface IntegerConfig { type: 'integer'; minimum: number; maximum: number; control?: { step: number } }
/** true means On, false means Off; stateKey reads an observed top-level boolean, never inferred playback. */
export interface BooleanConfig { type: 'boolean'; control?: { stateKey: string } }
export type Args = Record<string, number | boolean>;
export interface Action { id: string; title: string; config: Record<string, IntegerConfig | BooleanConfig> }
/** Base64 data URL: PNG, JPEG, WebP, GIF or SVG. At most 8192 characters, within the 16 KiB manifest budget. */
export interface Icon { id: string; title: string; category: string; src: string }
export interface Manifest { id: string; version: string; protocolVersion: 1; actions: Action[]; icons?: Icon[]; /** Optional plugin-identity thumbnail: one bounded embedded image data URL. */ icon?: string }
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type State = { [key: string]: Json };
export type Request =
  | { protocolVersion: 1; id: string; type: 'describe' | 'state' }
  | { protocolVersion: 1; id: string; type: 'execute'; action: string; args: Args };
export type ErrorCode = 'invalid_request' | 'request_too_large' | 'unknown_action' | 'invalid_arguments'
  | 'internal_error' | 'response_too_large' | 'timeout' | 'unsupported_platform' | 'app_missing'
  | 'app_not_running' | 'automation_denied' | 'command_failed' | 'invalid_state' | 'outcome_unknown';
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
}
export function validateManifest(value: unknown): Manifest;
export function validateArguments(action: Action, args: unknown): Args;
export function serve(plugin: Plugin, streams?: { input?: Readable; output?: Writable }): Promise<void>;
