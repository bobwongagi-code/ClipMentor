import type { SourceBreakdown } from './source-breakdown';

export const buyerRoles = ['reassurance', 'interest'] as const;
export type BuyerRole = typeof buyerRoles[number];

export const comparisonSelectionReview = '当主线是比较，先顺原片核对整条关系：比较对象如何建立、各对象有哪些可比参照、首次应用和后续结果分别让买家判断什么，以及原作者个人判断的适用范围。跨组有递进时，把前段参照、后段观察及各自证据一起看。实际条件或证据不同，就写清比较能支持的范围。';

export interface SourceInventory {
  function: string;
  tracks: Record<'picture' | 'speech' | 'captions' | 'sound', string>;
  emphasis: string[];
}

export const filmingChoiceLimit = 20;
export const hasConciseFilmingChoice = (value: string | undefined) =>
  !!value?.trim() && Array.from(value.trim()).length <= filmingChoiceLimit;

export interface TeachingSelection {
  decision: string;
  omission_loss: string;
  /** Plain-language synthesis of the filming choice and its immediate teaching payoff. */
  first_glance?: string;
  /** The specific question raised by an original hook taught by this unit. */
  hook_curiosity?: { point_id: string; question: string };
  buyer_roles: BuyerRole[];
  basis: 'observed' | 'inferred';
  alternative?: { decision: string; reason: string; segment_ids: string[] };
  /** Existing direct source segments, in original order, when the teaching depends on a sequence. */
  sequence_segment_ids?: string[];
}

const row = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const note = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && v.length <= 500;
const notes = (v: unknown): v is string[] => Array.isArray(v) && v.every(note) && new Set(v).size === v.length;
const sameDecision = (v: string) => v.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function isSourceInventory(value: unknown): value is SourceInventory {
  return row(value) && note(value.function) && row(value.tracks)
    && ['picture', 'speech', 'captions', 'sound'].every(key => note((value.tracks as Record<string, unknown>)[key]))
    && notes(value.emphasis);
}

export function isTeachingSelection(value: unknown): value is TeachingSelection {
  return row(value) && note(value.decision) && note(value.omission_loss)
    && (value.first_glance === undefined || note(value.first_glance))
    && (value.hook_curiosity === undefined || note(value.first_glance) && row(value.hook_curiosity)
      && note(value.hook_curiosity.point_id) && note(value.hook_curiosity.question))
    && notes(value.buyer_roles) && value.buyer_roles.length > 0
    && value.buyer_roles.every(role => buyerRoles.some(item => item === role))
    && (value.basis === 'observed' || value.basis === 'inferred')
    && (value.alternative === undefined || row(value.alternative) && note(value.alternative.decision)
      && note(value.alternative.reason) && notes(value.alternative.segment_ids) && value.alternative.segment_ids.length > 0)
    && (value.sequence_segment_ids === undefined || notes(value.sequence_segment_ids) && value.sequence_segment_ids.length >= 2);
}

export function isUnselectedBuyerRoles(value: unknown): value is Partial<Record<BuyerRole, string>> {
  return row(value) && Object.entries(value).every(([role, reason]) =>
    buyerRoles.some(item => item === role) && note(reason));
}

/** Only main points carried by narration require a writing brief. */
export function firstGlanceWritingUnits(breakdown: SourceBreakdown | undefined, requireConciseChoice = false) {
  if (!breakdown) return [];
  const primary = new Set(breakdown.points.filter(point => point.role === 'primary').map(point => point.point_id));
  return breakdown.units.flatMap(unit => {
    const narrated = unit.coverage.some(entry => entry.treatment === 'explain' && primary.has(entry.point_id));
    if (!narrated && !(requireConciseChoice && unit.coverage.some(entry => entry.treatment === 'visual_only'))) return [];
    const selection = unit.teaching_selection;
    const hook = selection?.hook_curiosity;
    return [{ unit_id: unit.unit_id, first_glance: selection?.first_glance, hook_curiosity: hook,
      ...(requireConciseChoice ? {filming_choice:selection?.decision??'', omission_loss:selection?.omission_loss??''} : {}),
      ...(hook && !unit.coverage.some(entry => entry.treatment === 'explain' && entry.point_id === hook.point_id && primary.has(entry.point_id))
        ? { invalid_hook_point: true } : {}) }];
  });
}

/** Author and reviewer prompts. Selection quality is decided in the existing evidence review. */
export function teachingSelectionGaps(breakdown: SourceBreakdown, duration: number, fps: number) {
  const gaps: string[] = [];
  for (const point of breakdown.points) {
    if (point.teaching_basis && sameDecision(point.teaching_basis.selling_point) === sameDecision(point.buying_concern))
      gaps.push(point.point_id + ' 卖点与买家顾虑文案相同。核对商品提供什么，以及买家下单前想判断什么。');
  }
  const inventory = breakdown.segments.filter(segment => segment.inventory)
    .sort((a, b) => a.source_range_seconds[0] - b.source_range_seconds[0]);
  let covered = 0;
  const tolerance = 1 / fps + 1e-6;
  for (const segment of inventory) {
    const [from, to] = segment.source_range_seconds;
    if (from > covered + tolerance) break;
    covered = Math.max(covered, to);
  }
  if (!inventory.length || covered + tolerance < duration) gaps.push('全片四轨盘点有缺窗。建议回看缺窗，无法核实的轨可记为 unknown。');

  const indexed = new Map(inventory.map(segment => [segment.segment_id, segment]));
  const pointSegments = new Map(breakdown.points.map(point => [point.point_id, point.segment_ids]));
  const decisions = new Map<string, string>();
  const roles = new Set<BuyerRole>();
  for (const unit of breakdown.units) {
    if (!unit.coverage.some(coverage => ['explain', 'visual_only'].includes(coverage.treatment))) continue;
    const selection = unit.teaching_selection;
    if (!selection) {
      gaps.push(unit.unit_id + ' 尚未登记选组决定、删去后的损失和购买作用。');
      continue;
    }
    selection.buyer_roles.forEach(role => roles.add(role));
    const decision = sameDecision(selection.decision);
    const other = decisions.get(decision);
    if (other) gaps.push(unit.unit_id + ' 与 ' + other + ' 登记了同一个拍摄决定。');
    decisions.set(decision, unit.unit_id);
    const alternative = selection.alternative;
    if (alternative && (sameDecision(alternative.decision) === decision || alternative.segment_ids.some(id => !indexed.has(id))))
      gaps.push(unit.unit_id + ' 备选须是不同决定，并引用已盘点的原片段。');
    const selected = new Set(unit.coverage.filter(coverage => coverage.treatment !== 'omit')
      .flatMap(coverage => pointSegments.get(coverage.point_id) ?? []));
    if (![...selected].some(id => indexed.has(id))) gaps.push(unit.unit_id + ' 选组缺原片盘点出处。');
    let previousEnd = 0;
    for (const id of selection.sequence_segment_ids ?? []) {
      const segment = indexed.get(id);
      if (!selected.has(id) || !segment?.visible_evidence_ids.length || segment.source_range_seconds[0] < previousEnd) {
        gaps.push(unit.unit_id + ' 合组顺序未绑定到相互独立且按原片顺序排列的可见证据窗。');
        break;
      }
      previousEnd = segment.source_range_seconds[1];
    }
  }
  for (const role of buyerRoles) {
    if (!roles.has(role) && !breakdown.unselected_buyer_roles?.[role])
      gaps.push(role === 'interest' ? '未说明想试层为何未选。' : '未说明放心层为何未选。');
  }
  return gaps;
}
