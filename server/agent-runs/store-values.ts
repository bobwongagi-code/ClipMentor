import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { projectToolResultForPersistence } from '../../src/agent/runtime-artifact';
import type { AgentRunEvent } from '../../src/persist/agentRuntimeStore';
import { MAX_SERVER_EVENT_BYTES, MAX_SERVER_TOOL_REQUEST_EVENT_BYTES, type ServerRunEvent } from './store-types';

export function stableValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value == null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const next = Array.isArray(value)
    ? value.map((item) => stableValue(item, seen))
    : Object.fromEntries(Object.keys(value as object).sort().map((key) => [
      key,
      stableValue((value as Record<string, unknown>)[key], seen),
    ]));
  seen.delete(value);
  return next;
}

export function digestValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

export function digestToolArgs(args: Record<string, unknown>): string {
  return digestValue(args);
}

const SERVER_RUN_CAPABILITY_BYTES = 32;
const SERVER_RUN_CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SERVER_RUN_CAPABILITY_VERIFIER_PATTERN = /^[a-f0-9]{64}$/;
const INVALID_CAPABILITY_VERIFIER = Buffer.alloc(SERVER_RUN_CAPABILITY_BYTES);

export interface ServerRunCapability {
  readonly capability: string;
  readonly verifier: string;
}

export function serverRunCapabilityVerifier(capability: string): string {
  return createHash('sha256').update(capability, 'utf8').digest('hex');
}

export function createServerRunCapability(): ServerRunCapability {
  const capability = randomBytes(SERVER_RUN_CAPABILITY_BYTES).toString('base64url');
  return { capability, verifier: serverRunCapabilityVerifier(capability) };
}
export function isServerRunCapability(value: unknown): value is string {
  return typeof value === 'string' && SERVER_RUN_CAPABILITY_PATTERN.test(value);
}

export function isServerRunCapabilityVerifier(value: unknown): value is string {
  return typeof value === 'string' && SERVER_RUN_CAPABILITY_VERIFIER_PATTERN.test(value);
}

export function verifyServerRunCapability(verifier: string, capability: string | null): boolean {
  const validVerifier = isServerRunCapabilityVerifier(verifier);
  const validCapability = isServerRunCapability(capability);
  const expected = validVerifier ? Buffer.from(verifier, 'hex') : INVALID_CAPABILITY_VERIFIER;
  const actual = createHash('sha256').update(capability ?? '', 'utf8').digest();
  const matches = timingSafeEqual(expected, actual);
  return validVerifier && validCapability && matches;
}

export function eventBytes(event: ServerRunEvent): number {
  return Buffer.byteLength(JSON.stringify(stableValue(event)));
}

/** Tool request admission and cold persistence must use the same byte budget. */
export function serverEventMaxBytes(type: string): number {
  return type === 'tool-request' || type === 'server-tool-request'
    ? MAX_SERVER_TOOL_REQUEST_EVENT_BYTES : MAX_SERVER_EVENT_BYTES;
}

function durableEventData(value: unknown, maxBytes: number): unknown {
  const projected = projectToolResultForPersistence(value);
  const encoded = JSON.stringify(projected);
  return typeof encoded === 'string' && Buffer.byteLength(encoded) <= maxBytes
    ? projected
    : { omitted: true, digest: digestValue(projected) };
}

export function runtimeEvent(
  event: ServerRunEvent,
): Omit<AgentRunEvent, 'eventId' | 'projectId' | 'runId' | 'sequence' | 'createdAt'> {
  const raw = stableValue(event.data);
  const fields = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const data = durableEventData(raw, serverEventMaxBytes(event.type));
  const textProof = event.type === 'text-delta' && typeof fields.text === 'string'
    ? data && typeof data === 'object' && 'text' in data && data.text === fields.text
      ? { rawTextDigest: digestValue(fields.text) }
      : { rawTextChanged: true }
    : {};
  const type: AgentRunEvent['type'] = (event.type === 'tool-request' || event.type === 'server-tool-request')
    ? 'tool_requested'
    : (event.type === 'tool-result' || event.type === 'server-tool-result')
      ? 'tool_outcome'
      : 'final';
  const unknown = (event.type === 'tool-result' || event.type === 'server-tool-result') && fields.outcome && typeof fields.outcome === 'object'
    && (fields.outcome as {kind?:unknown}).kind === 'outcome_unknown';
  const error = typeof fields.error === 'string' ? fields.error : fields.success === false ? 'Tool returned an unsuccessful result' : undefined;
  return {
    type,
    summary: JSON.stringify({
      serverEvent: {
        id: event.id,
        type: event.type,
        data,
        ...textProof,
        at: event.at,
      },
    }),
    ...(typeof fields.toolCallId === 'string' ? { toolCallId: fields.toolCallId } : {}),
    ...(typeof fields.name === 'string' ? { toolName: fields.name } : {}),
    ...(typeof fields.toolName === 'string' ? { toolName: fields.toolName } : {}),
    ...(typeof fields.argsDigest === 'string' ? { argsDigest: fields.argsDigest } : {}),
    ...((event.type === 'tool-result' || event.type === 'server-tool-result')
      ? {
          resultDigest: digestValue(fields.error === undefined ? fields.result : { error: fields.error }),
          outcome: {
            kind: unknown ? 'outcome_unknown' as const : error === undefined ? 'success' as const : 'terminal_failure' as const,
            ...(unknown && typeof fields.toolCallId === 'string' ? {operationId: fields.toolCallId} : {}),
            ...(error ? { summary: error } : {}),
          },
        }
      : {}),
  };
}
