import type { AgentContext } from './context';
import { TOOL_SCHEMAS } from './tools';
import { executeCodexTool } from './runtime';
import { ToolActivation } from './tool-activation';
import type { AgentSettings } from './settings/agentSettings';
import { draftContext } from './useAgentRun';
import { makeDraft, type DraftEngine } from '../editor/store';
import type { ProjectDoc } from '../editor/types';
import type { DisplayMessage, LiveTool } from './agent-session';

import type { AgentEvent } from './runtime';
import {
  SERVER_RUN_CAPABILITY_HEADER,
  type ServerRunToolAction,
} from './serverRunProtocol';
import { permanentServerRunRecoveryError } from './serverRunRecovery';
import { ServerRunToolRequestQueue } from './serverRunEvents';
import { toolExecutionMode } from './tools/execution-modes';
import { environmentFailureHint } from './serverRunToolEnvironment';
import { isFailedToolResult, toolFailureReason, structuredToolFailure } from './toolFailure';
import { EditorBridgeRequestError } from './external-bridge-registration';
import {
  beginStoredToolAttempt,
  captureStoredToolResult,
  clearStoredToolAttempt,
  findStoredToolAttempt,
  patchStoredServerRun,
  storedClaimIdentity,
  type StoredToolAttempt,
} from './serverRunSessionStorage';
import { projectServerRunToolResult } from './serverRunToolResult';
import {
  permanentToolHttpStatus, scheduleServerRunToolResultRetry,
  type BrowserToolRequest, type ToolClaimResponse,
} from './serverRunToolTransport';
import {
  browserServerRunLockManager,
  withServerRunToolLock,
  type ServerRunLockManager,
} from './serverRunToolLock';
export {
  serverRunToolLockName,
  withServerRunToolLock,
  type ServerRunLockManager,
} from './serverRunToolLock';
import {
  reconcileStoredServerRunToolAttempts,
  type RecoveredServerTool,
} from './serverRunToolRecovery';
export type { RecoveredServerTool } from './serverRunToolRecovery';

export interface ServerToolExecutorCallbacks {
  readonly ctx: () => AgentContext;
  readonly settings: () => AgentSettings;
  readonly onToolAction: (action: ServerRunToolAction) => void | Promise<void>;
  readonly updateMessages: (
    update: (messages: DisplayMessage[]) => DisplayMessage[],
  ) => void;
  readonly setLiveTool: (tool: LiveTool | null) => void;
  readonly retryStream: (runId: string) => void;
  readonly abandonRecovery: (runId: string, error: unknown) => void;
}

export interface ServerToolExecutorStart {
  readonly capability: string;
  readonly baseDoc: ProjectDoc;
  readonly draftDoc?: ProjectDoc;
  readonly activation: ToolActivation;
  readonly runId: string;
  readonly abort: AbortController;
  readonly recovered: ReadonlyMap<string, RecoveredServerTool>;
}

/**
 * Immutable identity of one run: everything a late async continuation needs to
 * settle with ITS OWN authority. start() replaces the whole object, so
 * `session === this.session` is the staleness fence. Issue #125: these fields
 * used to live mutably on the executor, so a tool completing after the next
 * run started read the NEW run's capability, posted a foreign-authority
 * /tool-result (HTTP 403), and triggered stale-recovery against the new run.
 */
interface RunSession {
  readonly runId: string;
  readonly capability: string;
  readonly claimId: string | null;
  readonly abort: AbortController;
}

export class ServerRunToolExecutor {
  private readonly projectId: string;
  private readonly requestQueue = new ServerRunToolRequestQueue();
  private callbacks: ServerToolExecutorCallbacks;
  private active = new Set<string>();
  private recovered = new Map<string, RecoveredServerTool>();
  private activation = new ToolActivation(TOOL_SCHEMAS, []);
  private draft: DraftEngine | null = null;
  private baseDoc: ProjectDoc | null = null;
  private session: RunSession | null = null;
  private readonly lockManager: ServerRunLockManager | null;

  constructor(
    projectId: string,
    callbacks: ServerToolExecutorCallbacks,
    lockManager: ServerRunLockManager | null = browserServerRunLockManager(),
  ) {
    this.projectId = projectId;
    this.callbacks = callbacks;
    this.lockManager = lockManager;
  }

  configure(callbacks: ServerToolExecutorCallbacks): void {
    this.callbacks = callbacks;
  }

  private recoveredActivation(input: ServerToolExecutorStart): ToolActivation {
    let activation = input.activation;
    for (const outcome of input.recovered.values()) {
      if (!outcome.name || outcome.error !== undefined) continue;
      activation = activation.withToolResult(outcome.name, outcome.result).activation;
    }
    return activation;
  }

  start(input: ServerToolExecutorStart): void {
    this.session = {
      runId: input.runId,
      capability: input.capability,
      claimId: storedClaimIdentity(this.projectId),
      abort: input.abort,
    };
    this.active.clear();
    this.recovered = new Map(input.recovered);
    this.activation = this.recoveredActivation(input);
    this.baseDoc = input.baseDoc;
    this.draft = input.draftDoc ? makeDraft(input.draftDoc) : null;
    patchStoredServerRun(this.projectId, {
      activeToolNames: this.activation.names(),
    });
  }

  stop(): void {
    this.session?.abort.abort();
  }

  /** True while `session` is still the run this executor serves. */
  private current(session: RunSession): boolean {
    return this.session === session && !session.abort.signal.aborted;
  }

  private failSession(session: RunSession, message: string): void {
    if (!this.current(session)) return;
    const error = permanentServerRunRecoveryError(message);
    session.abort.abort(error);
    this.callbacks.abandonRecovery(session.runId, error);
  }

  private async claim(
    session: RunSession,
    toolCallId: string,
    argsDigest: string,
  ): Promise<ToolClaimResponse | null> {
    if (!session.claimId) return null;
    const response = await fetch(`/api/agent-runs/${session.runId}/tool-claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [SERVER_RUN_CAPABILITY_HEADER]: session.capability,
      },
      body: JSON.stringify({
        projectId: this.projectId,
        toolCallId,
        argsDigest,
        claimId: session.claimId,
      }),
      signal: session.abort.signal,
    }).catch(() => null);
    if (response && response.status !== 409 && permanentToolHttpStatus(response.status)) {
      const detail = await EditorBridgeRequestError.fromResponse('tool claim', response);
      if (!this.current(session)) return null;
      this.failSession(session,
        `Server tool claim is permanently unavailable: HTTP ${response.status}${detail.detail ? ` (${detail.detail})` : ''}`);
      return null;
    }
    if (!response || (response.status !== 200 && response.status !== 409)) return null;
    const claim = await response.json().catch(() => null) as ToolClaimResponse | null;
    if (!this.current(session)) return null;
    // A settled call is normal during event replay or cloned-tab recovery.
    // Unknown calls, mismatched bindings and malformed replies cannot be retried
    // as though another host merely owns the tool.
    if (claim && ((response.status === 200 && claim.claimed === true
      && (claim.outcome === 'claimed' || claim.outcome === 'duplicate'))
      || (response.status === 409 && claim.claimed === false
        && (claim.outcome === 'already-claimed' || claim.outcome === 'run-settled')))) return claim;
    this.failSession(session,
      `Server tool claim rejected or invalid: HTTP ${response.status}${claim?.outcome === 'mismatch' || claim?.outcome === 'unknown-call' ? ` (${claim.outcome})` : ''}. Saved tool attempts are retained.`);
    return null;
  }

  private async postResult(
    session: RunSession,
    toolCallId: string,
    outcome: RecoveredServerTool,
  ): Promise<boolean> {
    if (!session.claimId || !this.current(session)) return false;
    const body = outcome.error === undefined
      ? {
        projectId: this.projectId,
        toolCallId,
        argsDigest: outcome.argsDigest,
        claimId: session.claimId,
        result: projectServerRunToolResult(outcome.result),
      }
      : {
        projectId: this.projectId,
        toolCallId,
        argsDigest: outcome.argsDigest,
        claimId: session.claimId,
        error: outcome.error,
      };
    const response = await fetch(`/api/agent-runs/${session.runId}/tool-result`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [SERVER_RUN_CAPABILITY_HEADER]: session.capability,
      },
      body: JSON.stringify(body),
      signal: session.abort.signal,
    }).catch(() => null);
    if (!this.current(session)) return false;
    if (response && permanentToolHttpStatus(response.status)) {
      const detail = await EditorBridgeRequestError.fromResponse('tool result', response);
      this.failSession(session,
        `Server tool result is permanently unavailable: HTTP ${response.status}${detail.detail ? ` (${detail.detail})` : ''}. Saved tool attempts are retained.`);
      return false;
    }
    return response?.ok === true;
  }

  private retry(session: RunSession, toolCallId: string): void {
    this.active.delete(toolCallId);
    this.callbacks.retryStream(session.runId);
  }
  private scheduleResultRetry(
    session: RunSession,
    toolCallId: string,
    outcome: RecoveredServerTool,
  ): void {
    if (!this.current(session)) return;
    scheduleServerRunToolResultRetry(
      () => this.postResult(session, toolCallId, outcome),
      () => clearStoredToolAttempt(this.projectId, toolCallId),
      () => this.current(session),
    );
  }

  private async deliverClaimedRecovered(
    session: RunSession,
    toolCallId: string,
    argsDigest: string,
    outcome: RecoveredServerTool,
  ): Promise<boolean> {
    const replay = outcome.argsDigest === argsDigest
      ? outcome
      : { argsDigest, error: 'Recovered tool arguments do not match the server request.' };
    if (!await this.postResult(session, toolCallId, replay)) {
      this.scheduleResultRetry(session, toolCallId, replay);
      return false;
    }
    clearStoredToolAttempt(this.projectId, toolCallId);
    return true;
  }

  private async rejectClaimedInterrupted(
    session: RunSession,
    toolCallId: string,
    argsDigest: string,
  ): Promise<boolean> {
    const outcome = {
      argsDigest,
      error: 'Browser reloaded after this tool began; the operation was not replayed automatically.',
    };
    if (!await this.postResult(session, toolCallId, outcome)) {
      this.scheduleResultRetry(session, toolCallId, outcome);
      return false;
    }
    clearStoredToolAttempt(this.projectId, toolCallId);
    return true;
  }
  reconcileStoredAttempts(
    runId: string,
    attempts: readonly StoredToolAttempt[],
  ): Promise<void> {
    const session = this.session;
    if (!session || session.runId !== runId) return Promise.resolve();
    return reconcileStoredServerRunToolAttempts({
      projectId: this.projectId,
      runId,
      attempts,
      lockManager: this.lockManager,
      active: () => this.current(session),
      failed: (message) => this.failSession(session, message),
      claim: (attempt) => this.claim(session, attempt.toolCallId, attempt.argsDigest),
      recovered: (toolCallId) => this.recovered.get(toolCallId),
      post: (toolCallId, outcome) => this.postResult(session, toolCallId, outcome),
    });
  }



  private async reportFailure(
    session: RunSession,
    toolCallId: string,
    request: BrowserToolRequest,
    error: unknown,
    persist: boolean,
    /** Draft document as of just before this tool ran. Present when the tool
     *  reached execution: the draft is rewound to it so partial mutations from
     *  a failed tool cannot leak into the tools that follow. */
    draftDocBeforeTool?: ProjectDoc,
  ): Promise<boolean> {
    if (!this.current(session)) return false;
    const details = structuredToolFailure(error);
    const message = environmentFailureHint(details?.error ?? (isFailedToolResult(error) ? toolFailureReason(error) : error));
    const outcome: ServerRunToolAction = {
      runId: session.runId,
      toolCallId,
      argsDigest: request.argsDigest,
      name: request.name,
      args: request.args,
      // Keep the failed-result envelope intact for journal/reload. Its nonempty
      // error still drives isFailedToolResult, rollback and server rejection.
      ...(details ? { result: details } : { error: message }),
      actions: persist ? (this.draft?.takeActions() ?? []) : [],
      baseDoc: this.baseDoc ?? this.callbacks.ctx().getDoc(),
    };
    if (draftDocBeforeTool) this.draft = makeDraft(draftDocBeforeTool);
    if (persist) {
      await Promise.resolve(this.callbacks.onToolAction(outcome)).catch(() => undefined);
      if (!this.current(session)) return false;
    }
    const recovered = { name: request.name, argsDigest: request.argsDigest,
      ...(details ? { result: details } : { error: message }) };
    void captureStoredToolResult(this.projectId, toolCallId, recovered);
    this.recovered.set(toolCallId, recovered);
    if (!await this.postResult(session, toolCallId, recovered)) {
      this.scheduleResultRetry(session, toolCallId, recovered);
      return false;
    }
    clearStoredToolAttempt(this.projectId, toolCallId);
    return true;
  }

  private async finishExecution(
    session: RunSession,
    toolCallId: string,
    request: BrowserToolRequest,
    result: unknown,
  ): Promise<boolean> {
    if (!this.current(session)) return false;
    if (!patchStoredServerRun(this.projectId, {
      activeToolNames: this.activation.names(),
    })) {
      return this.reportFailure(
        session,
        toolCallId,
        request,
        new Error('Browser durable storage could not save the active tool set.'),
        false,
      );
    }
    this.callbacks.updateMessages((current) => [
      ...current,
      { role: 'tool', text: '', tool: { name: request.name, args: request.args, result } },
    ]);
    const recovered = {
      name: request.name,
      argsDigest: request.argsDigest,
      result: result ?? null,
    };
    void captureStoredToolResult(this.projectId, toolCallId, recovered);
    this.recovered.set(toolCallId, recovered);
    if (!await this.postResult(session, toolCallId, recovered)) {
      this.scheduleResultRetry(session, toolCallId, recovered);
      return false;
    }
    clearStoredToolAttempt(this.projectId, toolCallId);
    return true;
  }

  private async execute(
    session: RunSession,
    toolCallId: string,
    request: BrowserToolRequest,
  ): Promise<boolean> {
    if (!this.draft) this.draft = makeDraft(this.baseDoc ?? this.callbacks.ctx().getDoc());
    // Snapshot for rollback: a tool that mutates and THEN fails leaves partial
    // changes in this draft, while the proposal side discards a failed tool's
    // actions entirely (applyToolActions returns early on error). Without the
    // rollback below the two drift apart, and every later tool in the turn
    // runs against state the user's preview does not have.
    const draftDocBeforeTool = this.draft.getDoc();
    this.callbacks.setLiveTool({ name: request.name, partial: '' });
    try {
      let update;
      try {
        update = await executeCodexTool({
          name: request.name,
          args: request.args,
          activation: this.activation,
          ctx: {
            ...draftContext(this.callbacks.ctx(), this.draft),
            getProjectId: () => this.projectId,
            getAgentRunId: () => session.runId,
            getAgentRunSignal: () => session.abort.signal,
            onToolProgress: (note: string) => {
              if (this.current(session)) {
                this.callbacks.setLiveTool({ name: request.name, partial: note });
              }
            },
          },
          settings: this.callbacks.settings(),
          onEvent: (_event: AgentEvent) => undefined,
          toolCallId,
          signal: session.abort.signal,
        });
      } catch (error) {
        return this.reportFailure(session, toolCallId, request, error, true, draftDocBeforeTool);
      }
      // The fence that motivated sessions (issue #125): past this await the
      // next run may own the executor. A stale completion must not touch the
      // activation, draft, recovered map, chat, or the new run's authority.
      if (!this.current(session)) return false;
      this.activation = update.activation;
      if (isFailedToolResult(update.execution.result)) {
        return this.reportFailure(
          session,
          toolCallId,
          request,
          update.execution.result,
          true,
          draftDocBeforeTool,
        );
      }
      const outcome: ServerRunToolAction = {
        runId: session.runId,
        toolCallId,
        argsDigest: request.argsDigest,
        name: request.name,
        args: request.args,
        result: update.execution.result,
        actions: this.draft.takeActions(),
        baseDoc: this.baseDoc ?? this.callbacks.ctx().getDoc(),
      };
      try {
        await this.callbacks.onToolAction(outcome);
      } catch {
        // The tool already executed; retry the durable draft write once so
        // its actions are not lost (reportFailure with persist=false would
        // drop them and a model-side retry could double-execute).
        try {
          await this.callbacks.onToolAction(outcome);
        } catch (retryError) {
          // The host may have committed the atomic edit but failed its authority
          // readback. Do not rewind to a pre-commit draft or claim success.
          const rollbackDoc = retryError instanceof Error
            && 'code' in retryError && retryError.code === 'editing_checkpoint_readback_failed'
            ? this.callbacks.ctx().getDoc()
            : retryError instanceof Error && 'code' in retryError && retryError.code === 'editing_checkpoint_commit_failed'
              ? this.draft.getDoc() : draftDocBeforeTool;
          return this.reportFailure(session, toolCallId, request, retryError, false, rollbackDoc);
        }
      }
      return this.finishExecution(session, toolCallId, request, update.execution.result);
    } finally {
      // A stale run's cleanup must not blank the live-tool indicator the
      // current run is showing.
      if (this.session === session) this.callbacks.setLiveTool(null);
    }
  }

  private async processLocked(
    session: RunSession,
    toolCallId: string,
    request: BrowserToolRequest,
  ): Promise<boolean> {
    const claim = await this.claim(session, toolCallId, request.argsDigest);
    if (!this.current(session)) return false;
    if (!claim) {
      this.retry(session, toolCallId);
      return false;
    }
    if (!claim.claimed) return false;
    const recovered = this.recovered.get(toolCallId);
    if (recovered) {
      if (!request.admit()) return false;
      return this.deliverClaimedRecovered(session, toolCallId, request.argsDigest, recovered);
    }
    if (findStoredToolAttempt(this.projectId, toolCallId)) {
      if (!request.admit()) return false;
      return this.rejectClaimedInterrupted(session, toolCallId, request.argsDigest);
    }
    const durableAttempt = beginStoredToolAttempt(
      this.projectId,
      toolCallId,
      request.argsDigest,
    );
    if (!request.admit()) return false;
    if (!durableAttempt || claim.outcome === 'duplicate') {
      const error = durableAttempt
        ? 'The tool claim was recovered without a durable result; the operation was not replayed.'
        : 'Browser durable storage is unavailable; the tool was not executed.';
      const outcome = { name: request.name, argsDigest: request.argsDigest, error };
      this.recovered.set(toolCallId, outcome);
      if (!await this.postResult(session, toolCallId, outcome)) {
        this.scheduleResultRetry(session, toolCallId, outcome);
        return false;
      }
      clearStoredToolAttempt(this.projectId, toolCallId);
      return true;
    }
    return this.execute(session, toolCallId, request);
  }

  private async process(
    session: RunSession,
    toolCallId: string,
    name: string,
    args: Record<string, unknown>,
    argsDigest: string,
    admit: () => boolean,
  ): Promise<boolean> {
    if (this.active.has(toolCallId)) return false;
    this.active.add(toolCallId);
    const request = { name, args, argsDigest, admit };
    const locked = await withServerRunToolLock(
      this.lockManager,
      this.projectId,
      session.runId,
      toolCallId,
      () => this.processLocked(session, toolCallId, request),
    );
    if (!locked.acquired && this.current(session)) {
      this.active.delete(toolCallId);
      this.failSession(session,
        `Server tool dispatch could not complete under its lock: ${name}. Saved tool attempts are retained.`,
      );
    }
    return locked.acquired ? locked.value : false;
  }

  handle(
    runId: string,
    toolCallId: string,
    name: string,
    args: Record<string, unknown>,
    argsDigest: string,
    admit: () => boolean,
  ): Promise<boolean> {
    const session = this.session;
    const run = async (): Promise<boolean> => {
      // The runId check rejects a request delivered by a superseded event
      // stream: without it, an old run's tool would execute under the new
      // run's authority.
      if (!session
        || session.runId !== runId
        || !this.current(session)) return false;
      return this.process(session, toolCallId, name, args, argsDigest, admit);
    };
    return toolExecutionMode(name, args) === 'parallel'
      ? this.requestQueue.enqueueParallel(runId, run)
      : this.requestQueue.enqueueExclusive(runId, run);
  }
}
