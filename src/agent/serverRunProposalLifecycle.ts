import { useCallback, useRef } from 'react';
import { makeDraft, replayActions } from '../editor/store';
import type { ProjectDoc } from '../editor/types';
import { assertDeliveryPicturePreservation } from '../clipmentor/delivery-bindings';
import { migrateProjectDoc, saveProject } from '../persist/projectStore';
import { kvGetAuthoritative } from '../persist/sharedKv';
import { saveAutomaticVersion } from '../persist/versionStore';
import type { AgentContext } from './context';
import {
  buildOperation,
  partitionProposalActions,
  projectDocsDiffer,
} from './proposal';
import {
  commitPersistentOperations,
  createPendingProposal,
  discardUnexposedProposal,
  exposePendingProposal,
  type AgentTurn,
} from './useAgentRun';
import { settleServerRun } from './serverRunSettleClient';
import type { AgentHookState, MutableValue } from './useAgentState';
import { isFailedToolResult } from './toolFailure';
import {
  clearServerRunDraft,
  loadServerRunDraft,
  saveServerRunDraftBase,
  saveServerRunDraftTool,
  type ServerRunDraftToolBody,
} from './serverRunDraftStore';
import { ServerRunTerminalHandoffs } from './serverRunTerminalHandoff';
import { permanentServerRunRecoveryError } from './serverRunRecovery';
import type {
  ServerRunPreparation,
  ServerRunRecovery,
  ServerRunStart,
  ServerRunTerminal,
  ServerRunTerminalResolution,
  ServerRunToolAction,
} from './serverRunProtocol';

interface ProposalRunState {
  turn: AgentTurn | null;
  seenToolCalls: Set<string>;
  handoffs: ServerRunTerminalHandoffs;
}

type ProposalRunRef = MutableValue<ProposalRunState>;
export function serverRunDraftBaseChanged(
  baseDoc: ProjectDoc,
  currentDoc: ProjectDoc,
): boolean {
  return projectDocsDiffer(baseDoc, currentDoc);
}


function turnContext(ctx: AgentContext, doc: ProjectDoc) {
  const draft = makeDraft(doc);
  return {
    draft,
    draftCtx: {
      commands: draft.commands,
      getState: draft.getState,
      getDoc: draft.getDoc,
      getCreativeMode: ctx.getCreativeMode,
      setCreativeMode: ctx.setCreativeMode,
      templates: ctx.templates,
      audio: ctx.audio,
      getProjectId: ctx.getProjectId,
      openProject: ctx.openProject,
      onProjectRenamed: ctx.onProjectRenamed,
      getUndoTarget: ctx.getUndoTarget,
      getRedoTarget: ctx.getRedoTarget,
      getApprovalMode: ctx.getApprovalMode,
      getOfflineMediaSrcs: ctx.getOfflineMediaSrcs,
    },
  };
}

function createTurn(
  state: AgentHookState,
  ctx: AgentContext,
  projectId: string,
  input: ServerRunStart,
  baseDoc: ProjectDoc,
): AgentTurn {
  const abortController = new AbortController();
  const { draft, draftCtx } = turnContext(ctx, baseDoc);
  state.abortRef.current = abortController;
  state.runningRef.current = true;
  state.setRunning(true);
  state.setProposalStale(false);
  return {
    state,
    projectId,
    trimmed: input.text.trim(),
    retryOptions: {
      askOnly: input.askOnly,
      ...(input.references.length ? { references: [...input.references] } : {}),
    },
    askOnly: input.askOnly,
    baseDoc,
    proposalBaseDoc: baseDoc,
    draft,
    draftCtx,
    ops: [],
    persistentOps: [],
    persistentBeforeDoc: null,
    persistentSnapshot: Promise.resolve(),
    persistentSaveError: undefined,
    draftInvalidated: false,
    assistantText: '',
    completionStatus: 'completed',
    runtimeErrorShown: false,
    toolCallCount: 0,
    runId: input.runId,
    abortController,
  };
}

function applyToolActions(
  turn: AgentTurn,
  input: ServerRunToolAction,
  projectId: string,
): void {
  if (input.error !== undefined || isFailedToolResult(input.result) || !input.actions.length) return;
  const { persistent, proposed } = partitionProposalActions(input.actions);
  if (persistent.length) {
    const observed = turn.state.ctxRef.current.getDoc();
    if (!turn.persistentBeforeDoc) {
      turn.persistentBeforeDoc = turn.baseDoc;
      turn.persistentSnapshot = saveAutomaticVersion(projectId, 'Agent 修改前', turn.baseDoc).then(
        () => undefined,
        (error) => { turn.persistentSaveError = error; },
      );
    }
    if (serverRunDraftBaseChanged(turn.baseDoc, observed)) turn.draftInvalidated = true;
    turn.proposalBaseDoc = replayActions(turn.proposalBaseDoc, persistent);
    turn.persistentOps.push(buildOperation(input.name, input.args, persistent));
  }
  if (proposed.length) turn.ops.push(buildOperation(input.name, input.args, proposed));
  const nextDoc = replayActions(turn.draft.getDoc(), input.actions);
  const next = turnContext(turn.state.ctxRef.current, nextDoc);
  turn.draft = next.draft;
  turn.draftCtx = next.draftCtx;
}

const checkpointReadbacks = new WeakMap<AgentTurn, ProjectDoc>();
export async function readCommittedEditingProject(projectId: string): Promise<ProjectDoc | null> {
  return migrateProjectDoc(await kvGetAuthoritative(`project:${projectId}`));
}
async function confirmEditingCheckpoint(turn: AgentTurn, read: typeof readCommittedEditingProject): Promise<void> {
  const expected = checkpointReadbacks.get(turn);
  if (!expected) return;
  try {
    const saved = await read(turn.projectId);
    if (!saved || serverRunDraftBaseChanged(migrateProjectDoc(expected) ?? expected, saved)) throw new Error('cold read mismatch');
    checkpointReadbacks.delete(turn);
  } catch {
    throw Object.assign(new Error('Editing checkpoint saved but cold readback could not be confirmed; draft journal retained.'),
      {code:'editing_checkpoint_readback_failed'});
  }
}

/** Bind automatic writes to this run, never to the next run or an offline replay. */
function activeTurnPersist(turn: AgentTurn, persist = saveProject): typeof saveProject {
 return (id, doc) => persist(id, doc, {
  ...(turn.runId ? { agentRunId: turn.runId } : {}), signal: turn.abortController.signal,
 });
}

/** Only the host's existing auto-apply mode can commit editing checkpoints.
 * One successful tool is atomic; export, failure and manual mode cannot commit it.
 */
export async function checkpointAutoAppliedTurn(
  turn: AgentTurn,
  persist = saveProject,
  read = readCommittedEditingProject,
): Promise<void> {
  await confirmEditingCheckpoint(turn, read);
  if (turn.askOnly || turn.state.ctxRef.current.getApprovalMode?.() !== 'auto'
    || (!turn.ops.length && !turn.persistentOps.length)) return;
  if (turn.abortController.signal.aborted) throw new Error('Editing checkpoint cancelled; draft retained.');
  const live = turn.state.ctxRef.current.getDoc();
  const after = turn.draft.getDoc();
  if (turn.draftInvalidated || serverRunDraftBaseChanged(turn.baseDoc, live)) {
    throw new Error('Project changed before editing checkpoint; draft retained, nothing overwritten.');
  }
  assertDeliveryPicturePreservation(live, after);
  const durable: AgentTurn = { ...turn, persistentBeforeDoc: live,
    persistentOps: [buildOperation('editing_checkpoint', {}, [{type:'tl.setDoc',doc:after}])],
    persistentSaveError: undefined,
    persistentSnapshot: saveAutomaticVersion(turn.projectId, 'Agent 编辑检查点前', live).then(
      () => undefined, error => { durable.persistentSaveError = error; }),
  };
  if (!await commitPersistentOperations(durable, activeTurnPersist(turn, persist))) throw Object.assign(
    new Error('Editing checkpoint was not committed; draft retained.'), {code:'editing_checkpoint_commit_failed'});
  // Rebase immediately after the confirmed save. A readback failure must not
  // replay this already committed batch or roll it back on a later export.
  // The saved snapshot is the baseline, not a possibly deferred React ref.
  turn.baseDoc = after;
  turn.proposalBaseDoc = after;
  turn.ops = [];
  turn.persistentOps = [];
  turn.persistentBeforeDoc = null;
  turn.persistentSaveError = undefined;
  turn.persistentSnapshot = Promise.resolve();
  checkpointReadbacks.set(turn,after);
  await confirmEditingCheckpoint(turn,read);
}

/** Preparation survives later review failure; this never commits a timeline proposal. */
function copyCandidateCheckpointDoc(turn: AgentTurn, input: ServerRunToolAction): ProjectDoc | null {
  if (input.name !== 'revise_clipmentor_analysis'
    || !['set_source_breakdown', 'set_copy_candidate', 'select_copy_lines', 'set_picture_plan'].includes(String(input.args.action))
    || input.error !== undefined || isFailedToolResult(input.result) || !input.actions.length) return null;
  if (turn.askOnly || turn.abortController.signal.aborted) throw new Error('Preparation checkpoint is not authorized in a read-only or cancelled run.');
  if (turn.ops.length || turn.persistentOps.length) throw new Error('Save analysis preparation in a preparation-only step, without pending project edits.');
  const before = turn.draft.getDoc();
  const after = replayActions(before, input.actions);
  const { clipMentorAnalysis: oldAnalysis, ...beforeMedia } = before;
  const { clipMentorAnalysis: nextAnalysis, ...afterMedia } = after;
  if (!oldAnalysis || !nextAnalysis || nextAnalysis.revision !== oldAnalysis.revision + 1
    || input.args.expectedRevision !== oldAnalysis.revision
    || JSON.stringify(beforeMedia) !== JSON.stringify(afterMedia)
    || JSON.stringify(turn.baseDoc.clipMentorAnalysis) !== JSON.stringify(oldAnalysis)) {
    throw new Error('Preparation checkpoint requires one current analysis-only revision; nothing committed.');
  }
  return after;
}

async function checkpointCopyCandidate(turn: AgentTurn, input: ServerRunToolAction): Promise<boolean> {
  const after = copyCandidateCheckpointDoc(turn, input);
  if (!after) return false;
  const live = turn.state.ctxRef.current.getDoc();
  let durableDoc = live;
  // On recovery the tool journal can predate an already durable checkpoint.
  if (serverRunDraftBaseChanged(after, live)) {
    if (turn.draftInvalidated || serverRunDraftBaseChanged(turn.baseDoc, live)) throw new Error('Project changed before preparation checkpoint; nothing committed.');
    const next = { ...live, clipMentorAnalysis: after.clipMentorAnalysis };
    const durable: AgentTurn = { ...turn, persistentBeforeDoc: live,
      persistentOps: [buildOperation(input.name, input.args, [{ type: 'tl.setDoc', doc: next }])],
      persistentSaveError: undefined,
      persistentSnapshot: saveAutomaticVersion(turn.projectId, '分析准备登记前', live).then(() => undefined, (error) => { durable.persistentSaveError = error; }),
    };
    if (!await commitPersistentOperations(durable, activeTurnPersist(turn))) throw new Error('Preparation checkpoint could not be saved; no production approval was granted.');
    durableDoc = next;
  }
  // Rebase the run after its independently saved preparation step. No proposed action remains.
  // Keep the exact committed object: later persistent edits use identity to detect concurrency.
  turn.baseDoc = durableDoc;
  turn.proposalBaseDoc = durableDoc;
  const next = turnContext(turn.state.ctxRef.current, durableDoc);
  turn.draft = next.draft;
  turn.draftCtx = next.draftCtx;
  return true;
}

function draftBase(
  input: ServerRunPreparation | ServerRunStart,
  baseDoc: ProjectDoc,
) {
  return {
    text: input.text,
    content: input.content,
    askOnly: input.askOnly,
    references: input.references,
    baseDoc,
  };
}

async function prepareServerRun(
  projectId: string,
  input: ServerRunPreparation,
): Promise<void> {
  if (await loadServerRunDraft(projectId, input.runId)) return;
  await saveServerRunDraftBase(
    projectId,
    input.runId,
    draftBase(input, input.baseDoc),
  );
}

async function loadStartDraft(projectId: string, input: ServerRunStart) {
  const recovered = await loadServerRunDraft(projectId, input.runId);
  if (input.resumed && !recovered) {
    throw permanentServerRunRecoveryError(
      'Server run draft is unavailable; interrupted tools cannot be recovered safely.',
    );
  }
  const baseDoc = recovered?.base.baseDoc ?? input.baseDoc;
  if (!recovered) {
    await saveServerRunDraftBase(projectId, input.runId, draftBase(input, baseDoc));
  }
  return { recovered, baseDoc };
}

async function restoreToolActions(
  turn: AgentTurn,
  input: ServerRunStart,
  tools: readonly ServerRunDraftToolBody[],
  baseDoc: ProjectDoc,
  ref: ProposalRunRef,
  projectId: string,
): Promise<void> {
  const live = turn.state.ctxRef.current.getDoc();
  let replay = baseDoc, committedThrough = -1;
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];
    if (tool.error !== undefined || isFailedToolResult(tool.result)) continue;
    replay = replayActions(replay, [...tool.actions]);
    if (!serverRunDraftBaseChanged(replay, live)) committedThrough = i;
  }
  if (committedThrough >= 0) {
    turn.baseDoc = live;
    turn.proposalBaseDoc = live;
    const next = turnContext(turn.state.ctxRef.current, live);
    turn.draft = next.draft;
    turn.draftCtx = next.draftCtx;
  }
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];
    ref.current.seenToolCalls.add(tool.toolCallId);
    if (i <= committedThrough) continue;
    const action: ServerRunToolAction = {
      runId: input.runId,
      toolCallId: tool.toolCallId,
      argsDigest: tool.argsDigest,
      name: tool.name,
      args: tool.args,
      ...(tool.error === undefined ? { result: tool.result } : { error: tool.error }),
      actions: [...tool.actions],
      baseDoc,
    };
    if (!await checkpointCopyCandidate(turn, action)) applyToolActions(turn, action, projectId);
  }
}

export async function startServerRun(
  state: AgentHookState,
  ctx: AgentContext,
  projectId: string,
  input: ServerRunStart,
  ref: ProposalRunRef,
): Promise<ServerRunRecovery> {
  const { recovered, baseDoc } = await loadStartDraft(projectId, input);
  const turn = createTurn(state, ctx, projectId, input, baseDoc);
  const tools = recovered?.tools ?? [];
  ref.current.turn = turn;
  ref.current.seenToolCalls = new Set();
  await restoreToolActions(turn, input, tools, baseDoc, ref, projectId);
  return {
    tools: tools.map((tool) => ({
      name: tool.name,
      toolCallId: tool.toolCallId,
      argsDigest: tool.argsDigest,
      ...(tool.error === undefined ? { result: tool.result } : { error: tool.error }),
    })),
    baseDoc: turn.baseDoc,
    draftDoc: turn.draft.getDoc(),
  };
}

export async function persistToolAction(
  projectId: string,
  input: ServerRunToolAction,
  ref: ProposalRunRef,
): Promise<void> {
  const turn = ref.current.turn;
  if (!turn || turn.runId !== input.runId) {
    throw new Error('Server run proposal state is unavailable.');
  }
  if (ref.current.seenToolCalls.has(input.toolCallId)) {
    await checkpointAutoAppliedTurn(turn);
    return;
  }
  if (input.error === undefined && !isFailedToolResult(input.result) && input.actions.length) {
    replayActions(turn.draft.getDoc(), input.actions);
  }
  // Reject an invalid preparation step before journaling it as a successful tool.
  copyCandidateCheckpointDoc(turn, input);
  await saveServerRunDraftTool(projectId, input.runId, {
    toolCallId: input.toolCallId,
    argsDigest: input.argsDigest,
    name: input.name,
    args: input.args,
    ...(input.error === undefined ? { result: input.result } : { error: input.error }),
    actions: input.actions,
  });
  try {
    if (!await checkpointCopyCandidate(turn, input)) applyToolActions(turn, input, projectId);
  } catch (error) {
    // A storage/concurrency failure after journaling must not replay as success on reload.
    await saveServerRunDraftTool(projectId, input.runId, {
      toolCallId: input.toolCallId, argsDigest: input.argsDigest, name: input.name, args: input.args,
      error: 'Local tool actions were not committed; recovery must not replay this result.', actions: [],
    });
    throw error;
  }
  ref.current.seenToolCalls.add(input.toolCallId);
  await checkpointAutoAppliedTurn(turn);
}

function beginTerminal(turn: AgentTurn, input: ServerRunTerminal): void {
  if (input.status === 'failed' || input.status === 'cancelled') {
    turn.abortController.abort(new Error(`Server run ${input.status}; pending checkpoint cancelled.`));
  }
  turn.assistantText = input.assistantText;
  turn.state.abortRef.current = null;
  turn.state.runningRef.current = false;
  turn.state.setRunning(false);
}

async function finalizeCompletedTurn(
  turn: AgentTurn,
  input: ServerRunTerminal,
): Promise<ServerRunTerminalResolution> {
  let committed: boolean;
  try {
    await confirmEditingCheckpoint(turn,readCommittedEditingProject);
    committed = await commitPersistentOperations(turn);
  } catch (error) {
    await settleServerRun(turn.projectId, input.runId, {
      status: 'failed',
      summary: error instanceof Error ? error.message : String(error),
    });
    return 'finalized';
  }
  if (!committed) {
    await settleServerRun(turn.projectId, input.runId, {
      status: 'failed',
      summary: 'server run persistent operations failed',
    });
    return 'finalized';
  }
  turn.persistentOps = [];
  turn.persistentBeforeDoc = null;
  if (!turn.ops.length) {
    await settleServerRun(turn.projectId, input.runId, {
      status: 'completed',
      summary: input.assistantText || 'server run completed',
    });
    return 'finalized';
  }
  let proposal;
  try {
    proposal = await createPendingProposal(turn, undefined, false);
  } catch (error) {
    await settleServerRun(turn.projectId, input.runId, {
      status: 'failed',
      summary: error instanceof Error ? error.message : String(error),
    });
    return 'finalized';
  }
  if (!proposal) {
    await settleServerRun(turn.projectId, input.runId, {
      status: 'aborted',
      summary: 'server run proposal was not exposed',
    });
    return 'finalized';
  }
  return {
    disposition: 'waiting_approval',
    afterModelCommit: () => exposePendingProposal(turn, proposal),
    onAbandon: () => discardUnexposedProposal(turn.projectId, proposal),
  };
}

async function resolveTerminalDisposition(
  turn: AgentTurn,
  input: ServerRunTerminal,
): Promise<ServerRunTerminalResolution> {
  if (turn.completionStatus === 'waiting_approval') {
    await settleServerRun(turn.projectId, input.runId, {
      status: 'waiting_approval',
      summary: 'server run proposal awaiting approval',
    });
    return 'waiting_approval';
  }
  if (input.status === 'awaiting_user') {
    turn.completionStatus = 'awaiting_user';
    await settleServerRun(turn.projectId, input.runId, {
      status: 'completed',
      summary: input.assistantText || 'server run awaiting user input',
    });
    return 'finalized';
  }
  if (input.status !== 'completed') {
    turn.completionStatus = input.status === 'cancelled' ? 'aborted' : 'failed';
    await settleServerRun(turn.projectId, input.runId, {
      status: turn.completionStatus,
      summary: input.assistantText || turn.completionStatus,
    });
    return 'finalized';
  }
  return finalizeCompletedTurn(turn, input);
}

export async function finishServerRun(
  projectId: string,
  input: ServerRunTerminal,
  ref: ProposalRunRef,
): Promise<ServerRunTerminalResolution | false> {
  const cached = ref.current.handoffs.get(input.runId);
  if (cached) return cached;
  const turn = ref.current.turn;
  if (!turn || turn.runId !== input.runId) return false;
  beginTerminal(turn, input);
  const disposition = await resolveTerminalDisposition(turn, input);
  if (typeof disposition === 'object') {
    return ref.current.handoffs.retain(input.runId, disposition, async () => {
      if (ref.current.turn?.runId === input.runId) ref.current.turn = null;
      await clearServerRunDraft(projectId, input.runId).catch(() => undefined);
    });
  }
  ref.current.turn = null;
  // A failed/cancelled producer is not authority to discard uncommitted edits.
  // Retain its journal for explicit recovery; never label it a committed project.
  if (input.status === 'completed' && !turn.ops.length && !turn.persistentOps.length && !checkpointReadbacks.has(turn)) {
    await clearServerRunDraft(projectId, input.runId).catch(() => undefined);
  }
  return disposition;
}

/** Navigation/transport abandonment is not a request to delete edited work. */
export async function abandonServerRun(projectId: string, runId: string, ref: ProposalRunRef): Promise<void> {
  if (ref.current.turn?.runId === runId) {
    ref.current.turn.abortController.abort(new Error('Server run abandoned; pending checkpoint cancelled.'));
  }
  await ref.current.handoffs.clear(runId);
  if (ref.current.turn?.runId === runId) ref.current.turn = null;
  try {
    const journal = await loadServerRunDraft(projectId,runId);
    if (journal?.tools.some(tool=>tool.actions.length)) return;
  } catch { return; } // An unreadable journal is evidence, not disposable emptiness.
  await clearServerRunDraft(projectId,runId);
}

export function useServerRunProposalCallbacks(
  state: AgentHookState,
  ctx: AgentContext,
  projectId: string,
) {
  const ref = useRef<ProposalRunState>({
    turn: null,
    seenToolCalls: new Set(),
    handoffs: new ServerRunTerminalHandoffs(),
  });
  const onRunPrepare = useCallback(
    (input: ServerRunPreparation) => prepareServerRun(projectId, input),
    [projectId],
  );
  const onRunAbandon = useCallback(async (runId: string) => {
    await abandonServerRun(projectId,runId,ref);
  }, [projectId]);
  const onRunStart = useCallback(
    (input: ServerRunStart) => startServerRun(state, ctx, projectId, input, ref),
    [ctx, projectId, state],
  );
  const onToolAction = useCallback(
    (input: ServerRunToolAction) => persistToolAction(projectId, input, ref),
    [projectId],
  );
  const onTerminal = useCallback(
    (input: ServerRunTerminal) => finishServerRun(projectId, input, ref),
    [projectId],
  );
  return { onRunPrepare, onRunAbandon, onRunStart, onToolAction, onTerminal };
}
