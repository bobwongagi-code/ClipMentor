import {assertHandoffCopy} from '../../clipmentor/handoff-copy';
import {resolveFrozenEditParameters,assertFrozenParameterChanges} from '../../clipmentor/execution-parameters';
import type { AgentContext } from '../context';
import { makeDraft } from '../../editor/store';
import { GENERIC_ITEM_KINDS } from './edit-item-generic';
import { assertDeliveryPicturePreservation } from '../../clipmentor/delivery-bindings';
import type { OpResult } from './edit-item-shared';

type Args = Record<string, unknown>;
export type EditItemBucket = 'adds' | 'updates' | 'deletes';

export interface EditItemOperation {
  bucket: EditItemBucket;
  index: number;
  entry: Record<string, unknown>;
}

interface AtomicBatchCallbacks<Draft> {
  createDraft: () => Draft;
  /** Stage only conflicting clip removals early; reported results keep request order. */
  orderOperations?: (draft: Draft, operations: EditItemOperation[]) => EditItemOperation[];
  validate: (draft: Draft, operation: EditItemOperation) => OpResult;
  apply: (draft: Draft, plan: OpResult) => OpResult;
  /** The final constraints are identical for dry runs and published edits. */
  validateDraft?: (draft: Draft) => void;
  /** One state replacement after every draft operation succeeds. */
  publish: (draft: Draft) => void;
}

const TOP_LEVEL_KEYS: Record<string, true> = {
  adds: true,
  updates: true,
  deletes: true,
  ripple: true,
  validateOnly: true,
  projectId: true,
};

function failedBatch(
  results: OpResult[],
  validateOnly: boolean,
  error: string,
): OpResult {
  return {
    ok: false,
    atomic: true,
    validateOnly,
    aborted: true,
    failed: 1,
    results,
    error,
    note: 'No draft was published. Fix the reported entry and retry the whole batch.',
  };
}

function collectOperations(args: Args): { operations?: EditItemOperation[]; error?: string } {
  const unknown = Object.keys(args).find((key) => !TOP_LEVEL_KEYS[key]);
  if (unknown) return { error: `unknown field "${unknown}" on edit_item` };
  const operations: EditItemOperation[] = [];
  for (const bucket of ['adds', 'updates', 'deletes'] as const) {
    const rawBucket = args[bucket];
    if (rawBucket !== undefined && !Array.isArray(rawBucket)) {
      return { error: `${bucket} must be an array` };
    }
    for (const [index, raw] of (rawBucket ?? []).entries()) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { error: `${bucket}[${index}]: invalid ${bucket.slice(0, -1)} entry` };
      }
      operations.push({ bucket, index, entry: raw as Record<string, unknown> });
    }
  }
  return { operations };
}

/**
 * Apply one edit_item call to a private draft in request order, then publish once.
 * Validation and application failures discard the draft. validateOnly executes the
 * same draft path so later entries are checked against earlier planned changes.
 */
export function executeAtomicEditBatch<Draft>(
  args: Args,
  callbacks: AtomicBatchCallbacks<Draft>,
): OpResult {
  const validateOnly = args.validateOnly === true;
  if (validateOnly && args.ripple === true) {
    return { error: 'do not combine validateOnly with ripple' };
  }
  const collected = collectOperations(args);
  if (collected.error) return failedBatch([], validateOnly, collected.error);
  const operations = collected.operations!;
  if (!operations.length) {
    return {
      error: 'pass adds, updates, and/or deletes',
      hint: 'browse_library → edit_item adds:[{type:"effect"|"transition"|"motion-graphic"|"audio",...}]',
    };
  }

  const draft = callbacks.createDraft();
  let staged: EditItemOperation[];
  try { staged = callbacks.orderOperations?.(draft, operations) ?? operations; }
  catch (error) { return failedBatch([], validateOnly, `staging failed: ${error instanceof Error ? error.message : String(error)}`); }
  const plans: OpResult[] = [];
  const results: OpResult[] = [];
  const byOperation = new Map<EditItemOperation, { plan: OpResult; result: OpResult }>();
  for (const operation of staged) {
    let plan: OpResult;
    try {
      plan = callbacks.validate(draft, operation);
    } catch (error) {
      const message = `${operation.bucket}[${operation.index}] validator failed: ${error instanceof Error ? error.message : String(error)}`;
      return failedBatch(plans, validateOnly, message);
    }
    if (plan.error) {
      const error = String(plan.error);
      const prefixed = error.startsWith(`${operation.bucket}[`)
        ? error
        : `${operation.bucket}[${operation.index}]: ${error}`;
      const failed = { ...plan, error: prefixed };
      return failedBatch([...plans, failed], validateOnly, prefixed);
    }
    plans.push(plan);
    let result: OpResult;
    try {
      result = callbacks.apply(draft, plan);
    } catch (error) {
      const message = `${operation.bucket}[${operation.index}] apply failed: ${error instanceof Error ? error.message : String(error)}`;
      return failedBatch(results, validateOnly, message);
    }
    if (result.error) {
      const error = `${operation.bucket}[${operation.index}] apply failed: ${String(result.error)}`;
      return failedBatch([...results, { ...result, error }], validateOnly, error);
    }
    results.push(result);
    byOperation.set(operation, { plan, result });
  }

  try { callbacks.validateDraft?.(draft); }
  catch (error) { return failedBatch(results, validateOnly, `draft validation failed: ${error instanceof Error ? error.message : String(error)}`); }

  if (validateOnly) {
    return {
      ok: true,
      atomic: true,
      validateOnly: true,
      wouldApply: plans.length,
      results: operations.map(operation => {
        const plan = byOperation.get(operation)!.plan;
        return { ok: true, kind: plan.kind, plan: plan.plan, preview: plan };
      }),
    };
  }

  try {
    callbacks.publish(draft);
  } catch (error) {
    const message = `final publish failed: ${error instanceof Error ? error.message : String(error)}`;
    return failedBatch(results, false, message);
  }
  return {
    ok: true,
    atomic: true,
    validateOnly: false,
    ripple: args.ripple === true,
    results: operations.map(operation => byOperation.get(operation)!.result),
  };
}


interface ContextEditDraft {
  engine: ReturnType<typeof makeDraft>;
  context: AgentContext;
  replacementSlots: Array<{ track: unknown; start: number }>;
}
interface ContextEditHandlers {
  validateAdd: (ctx: AgentContext, entry: Record<string, unknown>) => OpResult;
  validate: (ctx: AgentContext, operation: EditItemOperation) => OpResult;
  apply: (ctx: AgentContext, plan: OpResult, ripple: boolean) => OpResult;
}
function stageReplacementDeletes(draft: ContextEditDraft, operations: EditItemOperation[], validateAdd: ContextEditHandlers['validateAdd']): EditItemOperation[] {
  const state = draft.context.getState();
  // Resolve aliases, source windows and library templates through the same
  // validator as commit. Raw asset lookup guessed a one-frame duration.
  const adds = operations.filter(op => op.bucket === 'adds').flatMap(op => {
    const plan = validateAdd(draft.context, op.entry);
    if (!plan.ok || plan.error || typeof plan.startFrame !== 'number' || !Number.isFinite(plan.startFrame)) return [];
    const asset = draft.context.getDoc().assets.find(a => a.id === plan.assetId);
    const template = draft.context.templates.find(t => t.id === plan.templateId);
    const duration = plan.durationInFrames ?? asset?.durationInFrames ?? template?.durationInFrames;
    if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) return [];
    return [{ start: plan.startFrame, end: plan.startFrame + duration, track: plan.track }];
  });
  const early = operations.filter(op => {
    if (op.bucket !== 'deletes' || !GENERIC_ITEM_KINDS.has(String(op.entry.type))) return false;
    const id = String(op.entry.itemId ?? op.entry.id ?? '');
    const old = state.items.find(item => item.id === id || (id && item.id.startsWith(id)));
    if (!old) return false; // normal validation reports missing/invalid targets atomically
    return adds.some(add => add.track === old.track
      && add.start < old.startFrame + old.durationInFrames && add.end > old.startFrame);
  });
  draft.replacementSlots = adds.filter(add => early.some(op => {
    const id = String(op.entry.itemId ?? op.entry.id ?? '');
    const old = state.items.find(item => item.id === id || (id && item.id.startsWith(id)))!;
    return add.track === old.track && add.start < old.startFrame + old.durationInFrames && add.end > old.startFrame;
  }));
  return [...early, ...operations.filter(op => !early.includes(op))];
}


/** Shared publication contract for UI and server; host-specific capabilities
 * stay in their validators, not in separate ordering/preservation implementations. */
export function executeContextEditBatch(args: Args, ctx: AgentContext, handlers: ContextEditHandlers): OpResult {
  const before = ctx.getDoc();
  const frozen = !!ctx.getAgentRunId?.() && !!before.clipMentorAnalysis;
  if (frozen) {
    try { assertHandoffCopy('edit_item', args, ctx); }
    catch (error) { return { error: error instanceof Error ? error.message : String(error), atomic: true, aborted: true }; }
  }
  const checkActive = () => {
    if (ctx.getAgentRunSignal?.().aborted) throw new Error('agent_run_cancelled: no edit published');
  };
  return executeAtomicEditBatch<ContextEditDraft>(args, {
    createDraft: () => {
      const engine = makeDraft(before);
      return { engine, replacementSlots: [], context: { ...ctx, ...engine } };
    },
    orderOperations: (draft, operations) => stageReplacementDeletes(draft, operations, handlers.validateAdd),
    validate: (draft, operation) => {
      if(frozen && operation.bucket!=='deletes'){
        const resolved=resolveFrozenEditParameters(draft.engine.getDoc(),{[operation.bucket]:[operation.entry]});
        operation.entry=(resolved[operation.bucket] as Args[])[0];
      }
      return handlers.validate(draft.context, operation);
    },
    apply: (draft, plan) => {
      const placedBefore = draft.replacementSlots.some(slot => slot.track === plan.track && slot.start === plan.startFrame)
        ? new Set(draft.engine.getState().items.map(i => i.id)) : null;
      const result = handlers.apply(draft.context, plan, args.ripple === true);
      if (placedBefore) {
        const placed = draft.engine.getState().items.filter(i => !placedBefore.has(i.id));
        if (placed.some(i => i.startFrame !== plan.startFrame)) return { error: 'replacement_position_conflict: requested slot is still occupied; no edit published' };
      }
      return result;
    },
    validateDraft: (draft) => { checkActive(); if(frozen)assertFrozenParameterChanges(before,draft.engine.getDoc()); assertDeliveryPicturePreservation(before, draft.engine.getDoc()); },
    publish: (draft) => { checkActive(); ctx.commands.applyDoc(draft.engine.getDoc()); },
  });
}
