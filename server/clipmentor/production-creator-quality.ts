import type {OpeningComparisonCriterion} from '../../shared/clipmentor-handoff';
import { deliverySectionsFromDoc } from '../../src/clipmentor/delivery-bindings';
import { creatorAnswer, creatorFilmQuestions, creatorGroupQuestions, creatorQuestions } from '../../src/clipmentor/creator-teaching-quality';
import { readBlueprint } from '../../src/clipmentor/blueprint-lint';
import { originalPlaybackRanges } from '../../src/clipmentor/source-breakdown';
import { hasConciseFilmingChoice } from '../../src/clipmentor/teaching-selection';
import type { ProjectDoc } from '../../src/editor/types';
import { creatorExemplarCards, creatorJudgment } from './creator-exemplar-cards';

export const creatorQualityVersion = 'creator-teaching-v1';
type GroupQuestion = typeof creatorGroupQuestions[number];
type FilmQuestion = typeof creatorFilmQuestions[number];
type Row = Record<string, unknown>;
const row = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const normalize = (value: string) => value.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
const cardsByEntry = new Map(creatorExemplarCards.flatMap(card => card.entries.map(entry => [entry.id, entry] as const)));
const selected = (doc: ProjectDoc) => new Map(readBlueprint(doc).selectedPlans.map(plan => [plan.unit.unit_id, plan]));
const text = (value: unknown) => typeof value === 'string' ? value : undefined;

export function creatorOpeningMetricsValid(results: OpeningComparisonCriterion['results']) {
  if (!results) return false;
  const number = /^(?:[0-9]+(?:[., ][0-9]+)*)(?:\s*(?:[kmb]|ribu|juta|bilion|万|亿))?$/iu;
  const currency = /^(?:\p{Sc}|[A-Z]{2,3})\s*|\s*(?:\p{Sc}|[A-Z]{2,3})$/gu;
  const readable = (value: string) => value.normalize('NFKC').trim();
  return number.test(readable(results.views)) && number.test(readable(results.units))
    && number.test(readable(results.revenue).replace(currency,''));
}

export function creatorAuthorInstruction(doc: ProjectDoc, decisions: readonly string[] = []) {
  const baseline = doc.clipMentorAnalysis?.source_breakdown;
  return {
    version: creatorQualityVersion, judgment: creatorJudgment, questions: creatorQuestions, cards: creatorExemplarCards.map(({title,file,use})=>({title,file,use})),
    ...(decisions.length ? { confirmed_decision_ids: decisions } : {}),
    worksheet: baseline?.creator_quality,
    groups: baseline?.units.map(unit => ({ unit_id: unit.unit_id, ...unit.teaching_selection })),
    instruction: '分析阶段保留 decision、first_glance、omission_loss。各组 teaching_selection.creator_quality 写 next_decision、narration_why、still_focus 及 analogy:{entry,evidence_ids,application,difference}。先看共同判断，再用 load_skill 按 file 读取最接近的一至两张卡，借其中对本片有用的判断。只能用本任务该组已选证据编号。application 说清这项判断如何改变本组，difference 写本片成立条件和边界。如有已确认决定，选择它的 confirmed_decision_id。全片 source_breakdown.creator_quality 写 opening、balance，各用一句白话。写蓝图时按已核定的表编排实际原声、画面和马来语口播。每个讲解组在当前画面 plan.creator_conclusion_line_id 选择一个真正讲出取舍和作用的本组主讲句。只需要看图的细节作为组内画面或辅助点，写清读图任务。意外发现登记为建议。',
  };
}

export function creatorWorksheetGaps(doc: ProjectDoc, decisions: readonly string[], evidence: ReadonlySet<string>) {
  const analysis = doc.clipMentorAnalysis, baseline = analysis?.source_breakdown;
  if (!analysis || !baseline) return ['film:worksheet'];
  const segments = new Map(baseline.segments.map(segment => [segment.segment_id, segment]));
  const points = new Map(baseline.points.map(point => [point.point_id, point]));
  const gaps = creatorFilmQuestions.filter(question => !creatorAnswer(baseline.creator_quality?.[question])).map(question => 'film:' + question);
  const used = new Map<string, number>();
  const usedCards = new Set<string>();
  for (const unit of baseline.units) {
    const selection = unit.teaching_selection, quality = selection?.creator_quality;
    const add = (field: string) => gaps.push(unit.unit_id + ':' + field);
    if (!creatorAnswer(selection?.decision) || !hasConciseFilmingChoice(selection.decision)) add('decision');
    for (const field of ['first_glance','omission_loss'] as const)
      if (!creatorAnswer(selection?.[field])) add(field);
    for (const field of ['next_decision','narration_why','still_focus'] as const)
      if (!creatorAnswer(quality?.[field])) add(field);
    if (quality && normalize(quality.narration_why) === normalize(selection!.decision)) add('narration_why');
    const analogy = quality?.analogy;
    const card = analogy && creatorExemplarCards.find(item => item.entries.some(entry => entry.id === analogy.entry));
    if (card) usedCards.add(card.title);
    const unitSegments = new Set([...unit.original_segment_ids,...unit.explanation_segment_ids]);
    const associated = new Set(unit.coverage.filter(item => item.treatment !== 'omit').flatMap(item =>
      (points.get(item.point_id)?.segment_ids ?? []).flatMap(id => {
        const segment = segments.get(id);
        if (!segment || !unitSegments.has(id)) return [];
        const selectedPoint = points.get(item.point_id)?.teaching_basis?.evidence_ids;
        return [...segment.visible_evidence_ids,...segment.claim_evidence_ids].filter(id => !selectedPoint || selectedPoint.includes(id));
      })));
    if (!analogy || !card || normalize(analogy.application) === normalize(analogy.difference)
      || analogy.evidence_ids.some(id => !evidence.has(id) || !associated.has(id))) add('analogy');
    const decision = quality?.confirmed_decision_id;
    if (decision) {
      if (!decisions.includes(decision)) add('confirmed_decision_id');
      used.set(decision, (used.get(decision) ?? 0) + 1);
    }
  }
  if (usedCards.size > 2) gaps.push('film:analogy_card_limit');
  for (const id of decisions) if (used.get(id) !== 1) gaps.push('film:confirmed_decision:' + id);
  return [...new Set(gaps)].sort();
}

export function creatorBlueprintFacts(doc: ProjectDoc) {
  const analysis = doc.clipMentorAnalysis, baseline = analysis?.source_breakdown;
  if (!analysis || !baseline) return [];
  const plans = selected(doc);
  const units = new Map(baseline.units.map(unit => [unit.unit_id,unit]));
  const boardIds = new Set(analysis.blueprint.map(unit => unit.unit_id));
  const names = [...boardIds,...baseline.units.filter(unit => !boardIds.has(unit.unit_id)).map(unit => unit.unit_id)];
  return names.flatMap(id => {
    const unit = units.get(id);
    if (!unit) return [];
    const plan = plans.get(unit.unit_id);
    const explained = new Set(unit.coverage.filter(item => item.treatment === 'explain').map(item => item.point_id));
    const primary = new Set(baseline.points.filter(point => point.role === 'primary' && explained.has(point.point_id)).map(point => point.point_id));
    const anchors = primary.size ? primary : explained;
    const internal = row(plan?.unit.internal_review) ? plan.unit.internal_review : undefined;
    const candidate = plan && internal?.[plan.candidate_id];
    const currentLines = row(candidate) && Array.isArray(candidate.lines) ? candidate.lines : [];
    const lines = currentLines.filter(row).flatMap(line =>
      typeof line.id === 'string' && typeof line.narration_ms === 'string' && line.narration_ms.trim()
        ? [{ id: line.id, narration: line.narration_ms, primary: (Array.isArray(line.point_ids) ? line.point_ids : [line.point]).some(id => typeof id === 'string' && anchors.has(id)) }] : []);
    const bound = plan && (plan.plan.selected_narration === undefined
      || JSON.stringify(currentLines) === JSON.stringify(plan.plan.selected_narration));
    const conclusion = text(plan?.plan.creator_conclusion_line_id);
    const original = originalPlaybackRanges(baseline, unit);
    return [{ unit_id: unit.unit_id, decision: unit.teaching_selection?.creator_quality?.confirmed_decision_id,
      narrated: explained.size > 0 || lines.length > 0, conclusion: bound && lines.some(line => line.id === conclusion && line.primary) ? conclusion : undefined,
      lines, original, originalSeconds: original.reduce((duration, [from, to]) => duration + to - from, 0),
      phases: plan?.resolved?.phases ?? [] }];
  });
}

export function creatorSharedTeaching(doc: ProjectDoc) {
  return {
    film: doc.clipMentorAnalysis?.source_breakdown?.creator_quality,
    groups: creatorBlueprintFacts(doc).map(({unit_id,conclusion,lines})=>({unit_id,conclusion,lines})),
  };
}

interface GroupReference {
  id: string;
  originalSeconds: number;
  sentences: number;
  longestSentence: number;
}

export interface CreatorConfirmedReference {
  revision: string;
  originalSha256: string;
  salesSha256: string;
  groups: GroupReference[];
}

export function isCreatorConfirmedReference(value: unknown): value is CreatorConfirmedReference {
  if (!row(value) || typeof value.revision !== 'string' || !/^v[0-9]+-[a-f0-9]{8,64}$/u.test(value.revision)
    || ![value.originalSha256,value.salesSha256].every(item => typeof item === 'string' && /^[a-f0-9]{64}$/u.test(item))
    || !Array.isArray(value.groups) || !value.groups.length) return false;
  return value.groups.every(item => row(item) && creatorAnswer(item.id)
    && typeof item.originalSeconds === 'number' && item.originalSeconds > 0 && Number.isFinite(item.originalSeconds)
    && [item.sentences,item.longestSentence].every(count => Number.isSafeInteger(count) && Number(count) >= 0)
    && (item.sentences === 0) === (item.longestSentence === 0))
    && new Set(value.groups.map(item => item.id)).size === value.groups.length;
}

export function creatorCopyMeasures(lines: readonly { narration: string }[]) {
  const lengths = lines.flatMap(line => line.narration.split(/[!?。！？]+|\.(?!\d)/u))
    .map(part => part.match(/[\p{L}\p{N}]+/gu)?.length ?? 0).filter(Boolean);
  return { sentences: lengths.length, longestSentence: Math.max(0, ...lengths) };
}

export function captureCreatorReference(doc: ProjectDoc, revision: string, salesSha256: string, units: Record<string,string>) {
  const facts = creatorBlueprintFacts(doc);
  const names = Object.keys(units);
  if (!facts.length || names.length !== facts.length || facts.some(group => !Object.hasOwn(units,group.unit_id)))
    throw Error('creator_reference_group_mapping_invalid');
  const reference = {
    revision, originalSha256: doc.clipMentorAnalysis?.source.sourceContentHash, salesSha256,
    groups: facts.map(group => ({ id: units[group.unit_id], originalSeconds: group.originalSeconds, ...creatorCopyMeasures(group.lines) })),
  };
  if (!isCreatorConfirmedReference(reference)) throw Error('creator_reference_projection_invalid');
  return reference;
}

export function creatorRegressionGaps(facts: ReturnType<typeof creatorBlueprintFacts>, reference?: CreatorConfirmedReference) {
  const gaps = facts.flatMap(group => group.narrated && !group.conclusion
    ? [{ code: 'creator_conclusion_missing', id: group.unit_id }] : []);
  if (!reference) return gaps;
  const previous = new Map(reference.groups.map(group => [group.id, group]));
  const order = facts.flatMap(group => group.decision && previous.has(group.decision) ? [group.decision] : []);
  if (facts.length !== reference.groups.length || order.length !== reference.groups.length || order.some((id,index) => id !== reference.groups[index].id))
    gaps.push({ code: 'creator_confirmed_group_order_changed', id: 'teaching' });

  for (const group of facts) {
    const before = group.decision && previous.get(group.decision);
    if (!before) continue;
    const { sentences, longestSentence } = creatorCopyMeasures(group.lines);
    // Compare like-for-like to the confirmed group, allowing concise rephrasing and small cut changes.
    if (group.narrated && before.sentences > 0 && (sentences > before.sentences + 1 || longestSentence > Math.max(before.longestSentence + 5, before.longestSentence * 1.25)))
      gaps.push({ code: 'creator_copy_expanded', id: group.unit_id });
    if (group.originalSeconds > Math.max(before.originalSeconds + 1, before.originalSeconds * 1.25))
      gaps.push({ code: 'creator_original_expanded', id: group.unit_id });
  }
  return gaps;
}

export function creatorReviewWorksheet(doc: ProjectDoc, copy: boolean, evidence: ReadonlySet<string>, performance?: OpeningComparisonCriterion['results']) {
  const baseline = doc.clipMentorAnalysis?.source_breakdown;
  if (!baseline) throw Error('creator_worksheet_missing');
  const facts = copy ? creatorBlueprintFacts(doc) : [];
  const opening = copy ? deliverySectionsFromDoc(doc).find(section => section.kind === 'performance_opening') : undefined;
  return {
    version: creatorQualityVersion, judgment: creatorJudgment,
    questions: copy ? creatorQuestions : {...creatorQuestions,opening:'计划给观众什么继续看的理由？如何用当前已登记的三项成绩提问？'},
    ...(performance ? { performance } : {}),
    ...(opening ? { opening: { narration: opening.line.narration_ms, caption_lines: opening.line.caption_lines, layout: opening.picture.layout } } : {}),
    film: baseline.creator_quality,
    groups: baseline.units.map(unit => {
      const selection = unit.teaching_selection, quality = selection?.creator_quality;
      const analogy = quality?.analogy, example = analogy && cardsByEntry.get(analogy.entry);
      const neutral = example && { payoff: example.payoff, why: example.why, mistake: example.mistake, limit: example.limit };
      return {
        unit_id: unit.unit_id, decision: selection?.decision, first_glance: selection?.first_glance, omission_loss: selection?.omission_loss,
        next_decision: quality?.next_decision, narration_why: quality?.narration_why, still_focus: quality?.still_focus,
        analogy: analogy && { ...neutral, evidence_ids: analogy.evidence_ids.filter(id => evidence.has(id)), application: analogy.application, difference: analogy.difference },
      };
    }),
    ...(copy ? { copy: facts.map(({unit_id,narrated,conclusion,lines,original,phases}) => ({unit_id,narrated,conclusion,lines,original,phases})) } : {}),
  };
}

type Criterion<Q> = { question: Q; status: 'ok' | 'fix' | 'unresolved'; answer: string };
export type CreatorChecks = {
  film: Criterion<FilmQuestion>[];
  groups: { unit_id: string; checks: Criterion<GroupQuestion>[]; analogy: Omit<Criterion<'analogy'>,'question'> & { evidence_id?: string }; conclusion_line_id?: string }[];
  suggestions?: string[];
};

function readCriteria<Q extends string>(value: unknown, questions: readonly Q[]): Criterion<Q>[] {
  if (!Array.isArray(value) || value.length !== questions.length) throw Error('creator_review_criteria_invalid');
  return questions.map(question => {
    const matches = value.filter(item => row(item) && item.question === question);
    const item = matches[0];
    if (matches.length !== 1 || !row(item) || !creatorAnswer(item.answer) || normalize(item.answer).length < 2
      || (item.status !== 'ok' && item.status !== 'fix' && item.status !== 'unresolved')) throw Error('creator_review_criteria_invalid');
    return { question, status: item.status, answer: item.answer };
  });
}

export function readCreatorChecks(value: unknown, input: ReturnType<typeof creatorReviewWorksheet>): CreatorChecks {
  const invalid = () => Error('creator_review_criteria_invalid');
  if (!row(value) || !Array.isArray(value.groups) || value.groups.length !== input.groups.length) throw invalid();
  const groups = value.groups;
  const suggestions = value.suggestions;
  if (suggestions !== undefined && (!Array.isArray(suggestions) || suggestions.length > 3 || !suggestions.every(creatorAnswer))) throw invalid();
  return {
    film: readCriteria(value.film, creatorFilmQuestions),
    groups: input.groups.map(({ unit_id, analogy }) => {
      const matches = groups.filter(item => row(item) && item.unit_id === unit_id);
      const item = matches[0];
      if (matches.length !== 1 || !row(item)) throw invalid();
      const checks = readCriteria(item.checks, creatorGroupQuestions);
      const verdict = item.analogy;
      if (!row(verdict) || !creatorAnswer(verdict.answer)
        || (verdict.status !== 'ok' && verdict.status !== 'fix' && verdict.status !== 'unresolved')
        || (verdict.status === 'ok' && (typeof verdict.evidence_id !== 'string' || !analogy?.evidence_ids.includes(verdict.evidence_id)))
        || (verdict.evidence_id !== undefined && (typeof verdict.evidence_id !== 'string' || !analogy?.evidence_ids.includes(verdict.evidence_id))))
        throw invalid();
      const analogyCheck: CreatorChecks['groups'][number]['analogy'] = { status: verdict.status, answer: verdict.answer,
        ...(typeof verdict.evidence_id === 'string' ? { evidence_id: verdict.evidence_id } : {}) };
      const copy = input.copy?.find(group => group.unit_id === unit_id);
      const conclusion_line_id = item.conclusion_line_id;
      if (copy?.narrated && analogyCheck.status === 'ok' && checks.every(check => check.status === 'ok')
        && (!copy.conclusion || conclusion_line_id !== copy.conclusion)) throw invalid();
      if (conclusion_line_id !== undefined && (typeof conclusion_line_id !== 'string'
        || !copy?.lines.some(line => line.id === conclusion_line_id && line.primary))) throw invalid();
      return { unit_id, checks, analogy: analogyCheck, ...(typeof conclusion_line_id === 'string' ? { conclusion_line_id } : {}) };
    }),
    ...(Array.isArray(suggestions) ? { suggestions } : {}),
  };
}

export function hasBoundCreatorRejection(value: unknown, input: ReturnType<typeof creatorReviewWorksheet>) {
  if (!row(value)) return false;
  const rejected = (item: unknown): item is Row => row(item)
    && (item.status === 'fix' || item.status === 'unresolved') && creatorAnswer(item.answer);
  const namedRejection = (entries: unknown, questions: readonly string[]) => Array.isArray(entries)
    && entries.some(item => rejected(item) && typeof item.question === 'string' && questions.includes(item.question));
  return namedRejection(value.film,creatorFilmQuestions) || (Array.isArray(value.groups) && value.groups.some(item =>
    row(item) && input.groups.some(group => group.unit_id === item.unit_id)
    && (namedRejection(item.checks,creatorGroupQuestions) || rejected(item.analogy))));
}

export function creatorReviewIssues(receipt: CreatorChecks | undefined) {
  if (!receipt) return [];
  const groups = receipt.groups.map(group => ({
    unit_id: group.unit_id, checks: [...group.checks,{question:'analogy',...group.analogy}],
  }));
  return [{ unit_id: 'film', checks: receipt.film }, ...groups].flatMap(group =>
    group.checks.filter(check => check.status !== 'ok').map(check =>
      ({ key: group.unit_id + ':' + check.question, reason: check.answer })));
}
