export { EDIT_ITEM_TOOL_SCHEMAS, EDIT_ITEM_TOOL_NAMES } from './schemas/edit-item-tools';
import type { AgentContext } from '../context';
import { makeDraft } from '../../editor/store';
import type { DraftEngine } from '../../editor/store';
import { executeAtomicEditBatch } from './edit-item-batch';
import type { EditItemOperation } from './edit-item-batch';
import { commitPlan } from './edit-item-commit';
import type { Args, OpResult } from './edit-item-shared';
import { validateAdd, validateDelete, validateUpdate } from './edit-item-validate';
import { GENERIC_ITEM_KINDS } from './edit-item-generic';
import { assertDeliveryPicturePreservation } from '../../clipmentor/delivery-bindings';

interface EditItemDraft {
  engine: DraftEngine;
  context: AgentContext;
  replacementSlots: Array<{ track: unknown; start: number }>;
}

function stageReplacementDeletes(draft: EditItemDraft, operations: EditItemOperation[]): EditItemOperation[] {
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

function validateOperation(draft: EditItemDraft, operation: EditItemOperation): OpResult {
  if (operation.bucket === 'adds') return validateAdd(draft.context, operation.entry);
  if (operation.bucket === 'updates') return validateUpdate(draft.context, operation.entry);
  return validateDelete(draft.context, operation.entry);
}

export async function execEditItemTool(
  name: string,
  args: Args,
  ctx: AgentContext,
): Promise<unknown> {
  if (name !== 'edit_item') return { error: `unknown tool ${name}` };
  const ripple = args.ripple === true;
  const before = ctx.getDoc();
  return executeAtomicEditBatch<EditItemDraft>(args, {
    createDraft: () => {
      const engine = makeDraft(before);
      return {
        engine,
        replacementSlots: [],
        context: {
          ...ctx,
          commands: engine.commands,
          getState: engine.getState,
          getDoc: engine.getDoc,
        },
      };
    },
    orderOperations: stageReplacementDeletes,
    validate: validateOperation,
    apply: (draft, plan) => {
      const placedBefore = draft.replacementSlots.some(slot => slot.track === plan.track && slot.start === plan.startFrame)
        ? new Set(draft.engine.getState().items.map(i => i.id)) : null;
      const result = commitPlan(draft.context, plan, ripple);
      if (placedBefore) {
        const placed = draft.engine.getState().items.filter(i => !placedBefore.has(i.id));
        if (placed.some(i => i.startFrame !== plan.startFrame)) return { error: 'replacement_position_conflict: requested slot is still occupied; no edit published' };
      }
      return result;
    },
    validateDraft: (draft) => {
      if (ctx.getAgentRunSignal?.().aborted) throw new Error('agent_run_cancelled: no edit published');
      assertDeliveryPicturePreservation(before, draft.engine.getDoc());
    },
    publish: (draft) => {
      if (ctx.getAgentRunSignal?.().aborted) throw new Error('agent_run_cancelled: no edit published');
      ctx.commands.applyDoc(draft.engine.getDoc());
    },
  });
}
