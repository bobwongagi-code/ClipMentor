import type { TimelineItem } from '../../editor/types';
import type { SlipFailure } from '../../editor/slip';

export type OpResult = Record<string, unknown>;

export function slipFailureToOpResult(failure: SlipFailure): OpResult {
  return {
    ok: false,
    code: failure.code,
    itemId: failure.itemId,
    error: failure.error,
  };
}

/** Exact IDs precede prefixes; ambiguous prefixes never choose an arbitrary clip. */
export function findGenericItem(items: readonly TimelineItem[], value: unknown): TimelineItem | null {
  const query = String(value ?? '').trim();
  if (!query) return null;
  const exact = items.find(item => item.id === query);
  if (exact) return exact;
  const matches = items.filter(item => item.id.startsWith(query));
  return matches.length === 1 ? matches[0]! : null;
}
