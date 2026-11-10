import {
  appendAgentRunEvents,
  loadAgentRuntimeSidecar,
  AgentRunEventConflictError,
  type AgentApprovalRecord,
  type AgentRunContext,
  type AgentRunRecord,
} from '../../src/persist/agentRuntimeStore';
import {
  adoptAgentSessionWriteGeneration,
  currentAgentSessionGeneration,
} from '../../src/persist/agentSessionGeneration';
import type { ServerRun, ServerRunEvent, ServerRunStatus } from './store-types';
import { eventBytes, isServerRunCapabilityVerifier, runtimeEvent } from './store-values';

const RECOVERY_ERROR = 'Agent run interrupted because the server restarted before provider state could be resumed.';

export interface StoreRecoveryDependencies {
  runs: Map<string, ServerRun>;
  recovery: Map<string, Promise<ServerRun | undefined>>;
  evictRun: (run: ServerRun, message: string) => void;
  pruneRuns: () => void;
}

interface TerminalTransportEvidence {
  status: Extract<ServerRunStatus, 'completed' | 'failed' | 'cancelled'>;
  error: string | null;
}

interface TerminalTransportRepair {
  inferred: TerminalTransportEvidence | undefined;
  status: TerminalTransportEvidence['status'];
  error: string | null;
  context: AgentRunContext;
  nextId: number;
  at: number;
}

function serverEvents(record: AgentRunRecord): ServerRunEvent[] {
  return record.events.flatMap((event) => {
    try {
      const payload = JSON.parse(event.summary ?? '') as { serverEvent?: ServerRunEvent };
      return payload.serverEvent && Number.isSafeInteger(payload.serverEvent.id)
        ? [payload.serverEvent]
        : [];
    } catch {
      return [];
    }
  }).sort((a, b) => a.id - b.id);
}

const INTERRUPTED_TOOL_ERROR = 'The agent run was interrupted before this tool returned a result.';

/** Missing results are unknown outcomes, never proof a tool did not run. */
function interruptedToolClosers(events: ServerRunEvent[]): ServerRunEvent[] {
  const settled = new Set<string>();
  for (const event of events) {
    if (event.type !== 'tool-result' && event.type !== 'server-tool-result') continue;
    const data = event.data as { toolCallId?: unknown } | null;
    if (typeof data?.toolCallId === 'string') settled.add(data.toolCallId);
  }
  const pending = events.filter((event) => {
    if (event.type !== 'tool-request' && event.type !== 'server-tool-request') return false;
    const data = event.data as { toolCallId?: unknown } | null;
    return typeof data?.toolCallId === 'string' && !settled.has(data.toolCallId);
  });
  let nextId = (events.at(-1)?.id ?? 0) + 1;
  const now = Date.now();
  return pending.map((event) => {
    const data = event.data as { toolCallId: string; name?: unknown; toolName?: unknown; argsDigest?: unknown };
    const name = typeof data.name === 'string' ? data.name : data.toolName;
    return {
      id: nextId++,
      type: event.type === 'server-tool-request' ? 'server-tool-result' : 'tool-result',
      data: {
        toolCallId: data.toolCallId,
        outcome: { kind: 'outcome_unknown', operationId: data.toolCallId },
        ...(typeof name === 'string' ? { toolName: name } : {}),
        ...(typeof data.argsDigest === 'string' ? { argsDigest: data.argsDigest } : {}),
        error: INTERRUPTED_TOOL_ERROR,
      },
      at: now,
    };
  });
}

/** Keep immutable journal IDs; only the last durable done terminates replay. */
function replayEvents(record: AgentRunRecord): ServerRunEvent[] {
  const events = serverEvents(record);
  const lastDone = events.findLastIndex(event => !!terminalTransportEvidence([event], true));
  return events.filter((event, index) => event.type !== 'done' || index === lastDone);
}

function terminalTransportEvidence(
  events: readonly ServerRunEvent[],
  doneOnly: boolean,
): TerminalTransportEvidence | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (
      (event.type !== 'done' && (doneOnly || event.type !== 'status'))
      || !event.data
      || typeof event.data !== 'object'
    ) {
      continue;
    }
    const status = Reflect.get(event.data, 'status');
    if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') continue;
    const error = Reflect.get(event.data, 'error');
    return {
      status,
      error: typeof error === 'string' ? error : null,
    };
  }
  return undefined;
}

function restoredRun(
  projectId: string,
  sessionGeneration: string,
  record: AgentRunRecord,
  capabilityVerifier: string,
): ServerRun {
  const events = replayEvents(record);
  const status = terminalTransportEvidence(events, true)?.status ?? 'failed';
  const runtimeContext: AgentRunContext = record.context ?? {
    requestShapeHash: record.userInputDigest,
    ...(record.modelId ? { modelId: record.modelId } : {}),
  };
  const transportError = typeof runtimeContext.transportError === 'string'
    ? runtimeContext.transportError
    : null;
  // Pre-backend records stored the provider name in `backend`; new records
  // store the execution backend ('api' | 'codex') plus `provider` separately.
  const storedBackend = record.backend;
  const hasNewBackend = storedBackend === 'api' || storedBackend === 'codex';
  return {
    id: record.runId,
    projectId,
    sessionGeneration,
    capabilityVerifier,
    requestShapeHash: runtimeContext.requestShapeHash,
    backend: hasNewBackend ? storedBackend : 'api',
    provider: record.provider ?? (hasNewBackend ? 'unknown' : (storedBackend ?? 'unknown')),
    model: record.modelId ?? 'unknown',
    askOnly: record.askOnly,
    references: [],
    ...(record.externalSessionId ? { externalSessionId: record.externalSessionId } : {}),
    status,
    createdAt: record.createdAt,
    events,
    error: status === 'completed'
      ? null
      : transportError ?? (status === 'failed' ? RECOVERY_ERROR : null),
    retainedEventBytes: events.reduce((total, event) => total + eventBytes(event), 0),
    replayStart: events[0]?.id ?? 1,
    subscriberCount: 0,
    waiters: new Set(),
    eventCursor: events.at(-1)?.id ?? 0,
    pendingEventBytes: 0,
    pendingEventCount: 0,
    runtimeContext,
    toolRequests: new Map(),
  };
}

function terminalTransportRepair(
  record: AgentRunRecord,
  events: readonly ServerRunEvent[],
): TerminalTransportRepair {
  const inferred = terminalTransportEvidence(events, false);
  const status = inferred?.status ?? 'failed';
  const previousError = typeof record.context?.transportError === 'string'
    ? record.context.transportError
    : null;
  const error = status === 'completed'
    ? null
    : inferred?.error ?? previousError ?? (status === 'failed' ? RECOVERY_ERROR : null);
  const at = Date.now();
  const nextId = (events.at(-1)?.id ?? 0) + 1;
  const context: AgentRunContext = {
    ...(record.context ?? {
      requestShapeHash: record.userInputDigest,
      ...(record.modelId ? { modelId: record.modelId } : {}),
    }),
    transportStatus: status,
    transportError: error,
  };
  return {
    inferred,
    status,
    error,
    context,
    nextId,
    at,
  };
}

async function persistTerminalTransportRepair(
  projectId: string,
  sessionGeneration: string,
  record: AgentRunRecord,
  repair: TerminalTransportRepair,
  closers: ServerRunEvent[],
  terminalRequired: boolean,
): Promise<void> {
  let nextId = repair.nextId + closers.length;
  const suffix: ServerRunEvent[] = [...closers];
  if (terminalRequired && !repair.inferred) {
    suffix.push({ id: nextId++, type: 'status',
      data: { status: repair.status, error: repair.error, reason: 'server-restart' }, at: repair.at });
  }
  if (terminalRequired) suffix.push({ id: nextId, type: 'done', data: {
    status: repair.status, error: repair.error,
    reason: repair.inferred ? 'server-restart-terminal-recovery' : 'server-restart',
  }, at: repair.at });
  adoptAgentSessionWriteGeneration(projectId, sessionGeneration);
  await appendAgentRunEvents(projectId, record.runId, suffix.map(runtimeEvent), {
    sessionGeneration, expectedSequence: record.events.at(-1)?.sequence ?? 0, context: repair.context,
  });
}
async function ensureTerminalTransport(
  projectId: string,
  sessionGeneration: string,
  initial: AgentRunRecord,
  initialApprovals: readonly AgentApprovalRecord[],
): Promise<AgentRunRecord> {
  let record = initial, approvals = initialApprovals;
  for (let attempt = 0; attempt <= 3; attempt++) {
    const events = serverEvents(record), closers = interruptedToolClosers(events);
    const terminalRequired = !terminalTransportEvidence(events.slice(-1), true) || closers.length > 0;
    if (!terminalRequired && !approvals.some(a => a.runId === record.runId && a.status === 'pending')) return record;
    if (attempt === 3) break;
    try {
      await persistTerminalTransportRepair(projectId, sessionGeneration, record, terminalTransportRepair(record, events), closers, terminalRequired);
    } catch (error) {
      if (!(error instanceof AgentRunEventConflictError) || error.reason !== 'sequence') throw error;
      // Only reread the journal; conflict never grants another tool/provider submission.
    }
    const sidecar = await loadAgentRuntimeSidecar(projectId);
    if (sidecar.sessionGeneration !== sessionGeneration || await currentAgentSessionGeneration(projectId) !== sessionGeneration)
      throw new AgentRunEventConflictError('generation');
    const saved = sidecar.runs.find(item => item.runId === record.runId);
    if (!saved) throw new Error('Recovered Agent run record is unavailable');
    record = saved; approvals = sidecar.approvals;
  }
  throw new Error('Agent run recovery changed during bounded readback');
}

async function recoverServerRunOnce(
  dependencies: StoreRecoveryDependencies,
  projectId: string,
  runId: string,
  sessionGeneration: string,
): Promise<ServerRun | undefined> {
  const active = dependencies.runs.get(runId);
  if (active) {
    if (active.projectId !== projectId) return undefined;
    if (active.sessionGeneration !== sessionGeneration) {
      dependencies.evictRun(active, 'Agent session generation changed.');
      return undefined;
    }
    return active;
  }
  adoptAgentSessionWriteGeneration(projectId, sessionGeneration);
  const sidecar = await loadAgentRuntimeSidecar(projectId);
  if (sidecar.sessionGeneration !== sessionGeneration) return undefined;
  let record = sidecar.runs.find((item) => item.runId === runId);
  if (await currentAgentSessionGeneration(projectId) !== sessionGeneration) return undefined;
  if (!record || !record.userInputPreview.startsWith('server:')) return undefined;
  const verifier = record.context?.serverRunCapabilityVerifier;
  if (!isServerRunCapabilityVerifier(verifier)) return undefined;
  try {
    record = await ensureTerminalTransport(projectId, sessionGeneration, record, sidecar.approvals);
  } catch (error) {
    if (error instanceof AgentRunEventConflictError && error.reason === 'generation') return undefined;
    throw error;
  }
  if (await currentAgentSessionGeneration(projectId) !== sessionGeneration) return undefined;
  const run = restoredRun(projectId, sessionGeneration, record, verifier);
  dependencies.runs.set(run.id, run);
  dependencies.pruneRuns();
  return dependencies.runs.get(run.id);
}

export async function recoverServerRun(
  dependencies: StoreRecoveryDependencies,
  projectId: string,
  runId: string,
): Promise<ServerRun | undefined> {
  const sessionGeneration = await currentAgentSessionGeneration(projectId);
  adoptAgentSessionWriteGeneration(projectId, sessionGeneration);
  const active = dependencies.runs.get(runId);
  if (active) {
    if (active.projectId !== projectId) return undefined;
    if (active.sessionGeneration !== sessionGeneration) {
      dependencies.evictRun(active, 'Agent session generation changed.');
      return undefined;
    }
    return active;
  }
  const key = `${projectId}\u0000${sessionGeneration}\u0000${runId}`;
  const pending = dependencies.recovery.get(key)
    ?? recoverServerRunOnce(dependencies, projectId, runId, sessionGeneration);
  dependencies.recovery.set(key, pending);
  const cleanup = (): void => {
    if (dependencies.recovery.get(key) === pending) dependencies.recovery.delete(key);
  };
  void pending.then(cleanup, cleanup);
  return pending;
}

export async function recoverServerRuns(
  dependencies: StoreRecoveryDependencies,
  projectId: string,
): Promise<ServerRun[]> {
  const sessionGeneration = await currentAgentSessionGeneration(projectId);
  adoptAgentSessionWriteGeneration(projectId, sessionGeneration);
  const sidecar = await loadAgentRuntimeSidecar(projectId);
  if (sidecar.sessionGeneration !== sessionGeneration) return [];
  const restored = await Promise.all(sidecar.runs
    .filter((record) => record.userInputPreview.startsWith('server:'))
    .map((record) => recoverServerRun(dependencies, projectId, record.runId)));
  return restored.filter((run): run is ServerRun => run !== undefined);
}
