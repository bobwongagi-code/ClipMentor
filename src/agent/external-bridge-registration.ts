import { externalToolSchemas } from './external-tool-schemas';
import type { ExternalEditSessionTerminalStatus } from './external-edit-session';
import type { BrowserProjectOwnership } from '../persist/projectStoreTransport';
import { redactTextForAgentRuntime } from './runtime-artifact';

const EDITOR_REGISTRATION_CAPABILITY_HEADER = 'X-OpenChatCut-Editor-Registration';

export class EditorBridgeRequestError extends Error {
  readonly operation: string;
  readonly status: number;
  readonly detail?: string;

  constructor(operation: string, status: number, detail?: string) {
    super(`${operation} failed: HTTP ${status}${detail ? ` (${detail})` : ''}`);
    this.name = 'EditorBridgeRequestError';
    this.operation = operation;
    this.status = status;
    this.detail = detail;
  }

  static async fromResponse(operation: string, response: Response): Promise<EditorBridgeRequestError> {
    let detail: string | undefined;
    if (response.headers.get('content-type')?.includes('application/json')) {
      try {
        const body: unknown = await response.json();
        if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
          detail = redactTextForAgentRuntime(body.error).slice(0, 600);
        }
      } catch { /* The HTTP status remains useful when the error body is malformed. */ }
    }
    return new EditorBridgeRequestError(operation, response.status, detail);
  }
}

export function editorBridgeHeaders(
  json = false,
  registrationCapability?: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (registrationCapability) {
    headers[EDITOR_REGISTRATION_CAPABILITY_HEADER] = registrationCapability;
  }
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

export async function sendEditorBridgeResult(
  id: string,
  outcome: ExternalEditSessionTerminalStatus,
  value: unknown,
  signal: AbortSignal,
  registrationCapability: string,
  baseRevision?: string,
): Promise<void> {
  const response = await fetch('/api/external-agent/result', {
    method: 'POST',
    headers: editorBridgeHeaders(true, registrationCapability),
    body: JSON.stringify({ id, outcome, value, ...(baseRevision ? { baseRevision } : {}) }),
    signal,
  });
  if (!response.ok && response.status !== 404) {
    throw await EditorBridgeRequestError.fromResponse('result', response);
  }
}

export async function unregisterEditorBridge(
  projectId: string,
  editorInstanceId: string,
  registrationCapability?: string,
): Promise<void> {
  if (!registrationCapability) return;
  await fetch('/api/external-agent/unregister', {
    method: 'POST',
    headers: editorBridgeHeaders(true, registrationCapability),
    body: JSON.stringify({ projectId, editorId: editorInstanceId }),
    keepalive: true,
  }).catch(() => undefined);
}

export async function registerEditorBridge(
  projectId: string,
  editorInstanceId: string,
  baseRevision: string,
  signal: AbortSignal,
  registrationCapability?: string,
): Promise<BrowserProjectOwnership> {
  const response = await fetch('/api/external-agent/register', {
    method: 'POST',
    headers: editorBridgeHeaders(true, registrationCapability),
    body: JSON.stringify({
      projectId,
      editorId: editorInstanceId,
      baseRevision,
      tools: externalToolSchemas(),
    }),
    signal,
  });
  if (!response.ok) throw await EditorBridgeRequestError.fromResponse('registration', response);
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object') throw new Error('invalid editor registration response');
  const registration = value as Partial<{
    ok: boolean;
    ownershipEpoch: number;
    registrationCapability: string;
  }>;
  if (registration.ok !== true || typeof registration.ownershipEpoch !== 'number'
    || !Number.isSafeInteger(registration.ownershipEpoch) || registration.ownershipEpoch < 1
    || typeof registration.registrationCapability !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(registration.registrationCapability)) {
    throw new Error('invalid editor registration response');
  }
  return {
    projectId,
    ownerId: editorInstanceId,
    epoch: registration.ownershipEpoch,
    baseRevision,
    registrationCapability: registration.registrationCapability,
  };
}
