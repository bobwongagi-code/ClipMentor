export { EDIT_ITEM_TOOL_SCHEMAS, EDIT_ITEM_TOOL_NAMES } from './schemas/edit-item-tools';
import type { AgentContext } from '../context';
import { executeContextEditBatch } from './edit-item-batch';
import { commitPlan } from './edit-item-commit';
import type { Args } from './edit-item-shared';
import { validateAdd, validateDelete, validateUpdate } from './edit-item-validate';

export async function execEditItemTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'edit_item') return { error: `unknown tool ${name}` };
  return executeContextEditBatch(args, ctx, {
    validateAdd,
    validate: (draft, operation) => operation.bucket === 'adds' ? validateAdd(draft, operation.entry)
      : operation.bucket === 'updates' ? validateUpdate(draft, operation.entry) : validateDelete(draft, operation.entry),
    apply: commitPlan,
  });
}
