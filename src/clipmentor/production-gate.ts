/** Copy/plan release gate. It does not certify audio, rendered video or efficacy. */
import type { AgentContext } from '../agent/context';
import type { ProjectDoc } from '../editor/types';
import regression from './fixtures/copy-review-blind-20261019.json';
import teachingRegression from './fixtures/copy-teaching-blind-v2-20261019.json';
import { checkSourceBreakdown, breakdownPointEvidence, originalPlaybackRanges } from './source-breakdown';

export const COPY_REVIEW_PROTOCOL = 'creator-copy-v2';
type Verdict = 'pass' | 'needs_revision' | 'insufficient_evidence';
export interface CopyUnitJudgment {
  unit_id: string;
  candidate_id: string;
  verdict: Verdict;
  findings: Array<{ severity: 'blocking' | 'suggestion' | 'unknown'; quote: string; reason: string }>;
}
export interface CopyProductionReview {
  scope: 'copy_and_planned_picture_only';
  protocol: string;
  analysis_revision: number;
  content_digest: string;
  author_run_id: string;
  reviewer_run_id: string;
  reviewed_at: number;
  verdict: Verdict;
  units: CopyUnitJudgment[];
  teaching_review?: TeachingEnvelope;
}
type Row = Record<string, unknown>;
const row = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const verdict = (v: unknown): v is Verdict => ['pass', 'needs_revision', 'insufficient_evidence'].includes(String(v));
export function isCopyProductionReview(v: unknown): v is CopyProductionReview {
  return row(v) && v.scope === 'copy_and_planned_picture_only' && text(v.protocol)
    && Number.isSafeInteger(v.analysis_revision) && Number(v.analysis_revision) > 0
    && typeof v.content_digest === 'string' && /^[a-f0-9]{64}$/.test(v.content_digest)
    && text(v.author_run_id) && text(v.reviewer_run_id) && v.author_run_id !== v.reviewer_run_id
    && typeof v.reviewed_at === 'number' && Number.isFinite(v.reviewed_at) && v.reviewed_at >= 0
    && verdict(v.verdict) && Array.isArray(v.units) && v.units.length > 0
    && v.units.every((u) => row(u) && text(u.unit_id) && text(u.candidate_id) && verdict(u.verdict)
      && Array.isArray(u.findings) && u.findings.every((f) => row(f)
        && ['blocking', 'suggestion', 'unknown'].includes(String(f.severity)) && text(f.quote) && text(f.reason)))
    && new Set(v.units.map((u) => u.unit_id)).size === v.units.length
    && (v.teaching_review === undefined || (row(v.teaching_review) && teachingPacket(v.teaching_review.packet) && teachingReviewShape(v.teaching_review.review)));
}

/** Preserve the blind verdicts. A missed known regression disqualifies automatic release. */
export function legacyCopyReviewCalibration() {
  const cases = regression.regression_oracles.map((oracle) => {
    const actual = regression.raw_review.cases.filter((c) => c.case_id === oracle.case_id);
    return { revision: oracle.revision, expected: oracle.expected,
      actual: actual.length === 1 ? actual[0].verdict : 'missing_or_duplicate',
      caught: actual.length === 1 && actual[0].verdict === oracle.expected };
  });
  return { protocol: 'creator-copy-v1', qualified: cases.length >= 2 && cases.every((c) => c.caught), cases };
}

export function copyReviewCalibration() {
  const cases = teachingRegression.regression_oracles.map((oracle) => {
    const input = teachingRegression.blind_input.cases.filter((c) => c.case_id === oracle.case_id);
    const raw = teachingRegression.raw_review.cases.filter((c) => c.case_id === oracle.case_id);
    const actual = input.length === 1 && raw.length === 1 ? assessTeachingReview(input[0].packet, raw[0]).verdict : 'insufficient_evidence';
    return { case_id: oracle.case_id, kind: oracle.kind, label: oracle.label, expected: oracle.expected,
      actual, matched: actual === oracle.expected };
  });
  const positive = cases.filter((c) => c.kind === 'positive');
  const negative = cases.filter((c) => c.kind === 'negative');
  return { protocol: COPY_REVIEW_PROTOCOL, scope: 'development_regressions_only',
    qualified: distinct(cases.map((c) => c.case_id)) && positive.length >= 2 && negative.length >= 2
      && positive.every((c) => c.expected === 'pass' && c.matched)
      && negative.every((c) => c.expected === 'needs_revision' && c.matched), cases };
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (row(v)) return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
export async function copyReviewSubject(doc: ProjectDoc) {
  const a = doc.clipMentorAnalysis;
  if (!a) throw new Error('analysis_missing');
  const units = a.blueprint.flatMap((unit) => {
    const review = (unit as unknown as Row).internal_review;
    if (!row(review) || !text(review.current_script_candidate)) return [];
    const id = review.current_script_candidate;
    const candidate = review[id];
    if (!row(candidate) || !Array.isArray(candidate.lines) || !candidate.lines.length
      || !candidate.lines.every((l) => row(l) && text(l.id) && text(l.narration_ms) && text(l.zh)
        && Array.isArray(l.caption_lines) && l.caption_lines.length && l.caption_lines.every(text)
        && Array.isArray(l.source_seconds) && l.source_seconds.length === 2
        && l.source_seconds.every((s) => typeof s === 'number' && Number.isFinite(s) && s >= 0)
        && l.source_seconds[0] < l.source_seconds[1] && l.source_seconds[1] <= a.source.duration_seconds)) {
      throw new Error('copy_candidate_incomplete');
    }
    return [{ unit_id: unit.unit_id, candidate_id: id,
      narration: candidate.lines.map((l) => String(l.narration_ms)),
      lines: candidate.lines.map((l) => ({ line_id: String(l.id),
        point_ids: stringList(l.point_ids) && l.point_ids.length ? l.point_ids : text(l.point) ? [l.point] : unit.point_ids,
        narration_ms: String(l.narration_ms), caption_lines: l.caption_lines as string[], meaning_zh: String(l.zh),
        labels: stringList(l.labels) ? l.labels : [] })),
    }];
  });
  if (!units.length) throw new Error('copy_candidate_missing');
  // Conservative first slice: all analysis content, source identity and revision are
  // bound. Reverting a sentence through the revision tool increments revision again;
  // it cannot revive an old receipt. Timeline production edits do not change this hash.
  const { production_copy_review: _receipt, ...content } = a;
  const bytes = new TextEncoder().encode(canonical({ protocol: COPY_REVIEW_PROTOCOL, calibration: teachingRegression, analysis: content,
    actual_source_hash: doc.assets.find((v) => v.id === a.source.asset_id)?.sourceContentHash ?? null }));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return { revision: a.revision, units, digest: [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('') };
}

export function isReviewedNarrationText(subject: Awaited<ReturnType<typeof copyReviewSubject>>, value: unknown) {
  const normalize = (v: string) => v.trim().replace(/\s+/g, ' ');
  const requested = typeof value === 'string' ? normalize(value) : '';
  return !!requested && subject.units.some((u) => [...u.narration, u.narration.join(' ')].some((line) => normalize(line) === requested));
}

/** Host review handoff, deliberately not an Agent tool. Never infer a pass from self_review. */
export async function bindCopyProductionReview(
  doc: ProjectDoc,
  input: Omit<CopyProductionReview, 'scope' | 'protocol'>,
): Promise<CopyProductionReview> {
  const subject = await copyReviewSubject(doc);
  // The host captures these BEFORE sending the review packet. Never re-stamp an
  // old response with the digest of a newer draft when the response comes back.
  if (input.analysis_revision !== subject.revision || input.content_digest !== subject.digest) throw new Error('review_subject_changed');
  const receipt = { ...input, scope: 'copy_and_planned_picture_only' as const, protocol: COPY_REVIEW_PROTOCOL };
  if (!isCopyProductionReview(receipt)) throw new Error('invalid_independent_copy_review');
  return receipt;
}

export async function checkCopyProduction(
  doc: ProjectDoc, creativeMode: string | null,
  // Pure-policy test seam; runtime tool callers always use the measured calibration.
  calibration = copyReviewCalibration(),
) {
  const result = (code: string, allowed = false) => ({ allowed, code, scope: 'copy_and_planned_picture_only' as const,
    complete_film_accepted: false as const });
  const a = doc.clipMentorAnalysis;
  if (!a && creativeMode !== 'clipmentor') return result('not_clipmentor', true);
  if (!a) return result('analysis_missing');
  if (!a.source.sourceContentHash || doc.assets.find((v) => v.id === a.source.asset_id)?.sourceContentHash !== a.source.sourceContentHash) return result('source_hash_missing_or_changed');
  const r = a.production_copy_review;
  if (r === undefined) return result('copy_review_missing');
  if (r.protocol === COPY_REVIEW_PROTOCOL && r.teaching_review === undefined) return result('copy_teaching_review_missing');
  if (!isCopyProductionReview(r)) return result('copy_review_invalid');
  if (r.protocol !== COPY_REVIEW_PROTOCOL || r.analysis_revision !== a.revision) return result('copy_review_stale');
  let subject: Awaited<ReturnType<typeof copyReviewSubject>>;
  try { subject = await copyReviewSubject(doc); } catch { return result('copy_candidate_missing_or_incomplete'); }
  if (subject.digest !== r.content_digest) return result('copy_review_stale');
  if (r.units.length !== subject.units.length || !subject.units.every((u) => r.units.some((v) => v.unit_id === u.unit_id && v.candidate_id === u.candidate_id))) return result('copy_review_scope_incomplete');
  const breakdown = checkSourceBreakdown(doc);
  if (breakdown.status !== 'structurally_ready') return { ...result('source_breakdown_not_ready'), breakdown_issues: breakdown.issues };
  if (!r.teaching_review || !teachingSubjectMatches(subject, r.teaching_review.packet)) return result('copy_teaching_scope_mismatch');
  const registered = await copyTeachingPacketFromDoc(doc);
  if (canonical(registered) !== canonical(r.teaching_review.packet)) return result('copy_teaching_ledger_mismatch');
  const teaching = assessTeachingReview(r.teaching_review.packet, r.teaching_review.review);
  if (teaching.verdict !== 'pass') return { ...result('copy_teaching_review_not_passed'), teaching_verdict: teaching.verdict, teaching_issues: teaching.issues };
  if (r.verdict !== 'pass' || r.units.some((u) => u.verdict !== 'pass' || u.findings.some((f) => f.severity !== 'suggestion'))) return result('copy_review_not_passed');
  if (calibration.protocol !== COPY_REVIEW_PROTOCOL || !calibration.qualified) return result('copy_review_method_unqualified');
  return result('copy_and_plan_ready', true);
}

const PREPARATION = new Set([
  'read_clipmentor_source_video',
  'observe_clipmentor_source_video',
  'request_clipmentor_copy_review',
  'read_timeline', 'read_project', 'read_script', 'read_captions', 'read_transcript', 'find_transcript',
  'read_agent_artifact', 'read_clipmentor_analysis', 'view_timeline_frames', 'view_asset_frames',
  'ToolSearch', 'load_skill', 'list_templates', 'search_templates', 'list_audio', 'browse_library',
  'search_media', 'search_stock_media', 'search_fonts', 'track_progress', 'track_export', 'probe_media',
  'inspect_color', 'analyze_scene_quality', 'report_user_friction', 'get_editor_url',
  'revise_clipmentor_analysis', 'review_clipmentor_analysis', 'observe_clipmentor_source',
  'transcribe_clipmentor_source', 'transcribe_track', 'import_media', 'download_media', 'push_asset',
  'import_url_asset', 'finalize_uploaded_asset', 'create_upload_session', 'get_upload_session',
  'ask_followup_questions', 'list_projects', 'target_project',
]);
function preparationTool(name: string, args: Row) {
  if (PREPARATION.has(name)) return true;
  // Multiplexed tools: only these exact read actions can precede copy approval.
  const readActions: Record<string, string[]> = {
    manage_timelines: ['list'], manage_versions: ['list'], manage_design_style: ['get', 'list'],
    manage_effects: ['list'], edit_item: ['list', 'get'], manage_project: ['list', 'get'],
    manage_template: ['get', 'list_assets'], manage_skill: ['list', 'read', 'activate'],
  };
  return readActions[name]?.includes(String(args.action)) ?? false;
}

/** Shared by browser/built-in dispatch and server data-only dispatch, before side effects. */
export async function clipMentorProductionBlock(name: string, args: Row, ctx: AgentContext) {
  if (preparationTool(name, args)) return null;
  const doc = ctx.getDoc();
  if (!doc.clipMentorAnalysis && ctx.getCreativeMode() !== 'clipmentor') return null;
  const gate = await checkCopyProduction(doc, ctx.getCreativeMode());
  // Hashing is asynchronous: never execute a mutation against a newer, unchecked doc.
  if (ctx.getDoc() !== doc) return { error: 'ClipMentor 制作被拦截：检查期间工程已变化，请重新读取。', production_gate: { ...gate, allowed: false, code: 'project_changed_during_gate' } };
  if (!gate.allowed) return { error: `ClipMentor 制作被拦截：${gate.code}。先完成当前稿件的独立审核；不得绕过或沿用旧批准。`, production_gate: gate };
  if (['submit_render_job', 'submit_export'].includes(name)) {
    const timeline = checkSourceBreakdown(doc, true);
    if (timeline.status !== 'structurally_ready') return { error: 'ClipMentor 导出被拦截：实际源片范围与讲解单元尚未对齐。', production_gate: { ...gate, allowed: false, code: 'breakdown_timeline_not_ready', breakdown_issues: timeline.issues } };
  }
  if (doc.clipMentorAnalysis && name === 'rerun_generation') return { error: 'ClipMentor 配音不可从旧资产重跑；请提交已审文本。', production_gate: { ...gate, allowed: false, code: 'rerun_requires_reviewed_submission' } };
  if (doc.clipMentorAnalysis && ['submit_voice', 'submit_voice_generation', 'generate_voice'].includes(name)) {
    const subject = await copyReviewSubject(doc);
    if (!isReviewedNarrationText(subject, args.text)) return { error: 'ClipMentor 制作被拦截：配音文本不等于已审句子或单元全文。', production_gate: { ...gate, allowed: false, code: 'tts_text_not_reviewed' } };
    if (ctx.getDoc() !== doc) return { error: 'ClipMentor 制作被拦截：检查期间工程已变化。', production_gate: { ...gate, allowed: false, code: 'project_changed_during_gate' } };
  }
  return null;
}

export interface TeachingLine {
  line_id: string;
  point_ids: string[];
  narration_ms: string;
  caption_lines: string[];
  meaning_zh: string;
  labels: string[];
}
export interface TeachingPoint {
  point_id: string;
  role: 'primary' | 'supporting' | 'auxiliary';
  question: string;
  evidence_ids: string[];
  supports_point_id?: string;
  buying_concern?: string;
  filming_conditions?: string[];
}
export interface TeachingPacket {
  audience: string;
  product: { name: string; purchase_concerns: string[]; unknowns: string[] };
  source_evidence: Array<{ evidence_id: string; observation: string; time_seconds?: number[]; operator_supplied_context?: string }>;
  units: Array<{ unit_id: string; points: TeachingPoint[]; lines: TeachingLine[]; picture_plan?: TeachingPicturePlan }>;
}
export interface TeachingPicturePlan {
  original_source_ranges: Array<[number, number]>;
  explanation_source_ranges: Array<[number, number]>;
  line_source_ranges: Array<{ line_id: string; source_range_seconds: [number, number] }>;
  registered_revisits: Array<{ from_source_range: [number, number]; to_source_range: [number, number] }>;
  /** Current operational plan, not author self-review or a rendered-video claim. */
  execution_plan?: { plan_id: string; script_candidate_id: string; content: Record<string, unknown> };
}

function reviewablePlan(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviewablePlan);
  if (!row(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/review|verdict|approval|self_eval|rationale|reason|history|production_allowed|source_binding|base_analysis_revision|^status$/i.test(key))
    .map(([key, entry]) => [key, reviewablePlan(entry)]));
}
export interface TeachingJudgment {
  point_id: string;
  learner_takeaway: string;
  connection: 'purchase_connected' | 'function_only' | 'action_only' | 'supporting_context' | 'auxiliary_transition' | 'not_explained';
  basis: 'in_copy' | 'within_unit' | 'background_only' | 'none';
  source_support: 'supported' | 'uncertain' | 'contradicted';
  meaning_alignment: 'aligned' | 'uncertain' | 'misaligned';
  quotes: Array<{ line_id: string; channel: 'narration' | 'caption' | 'label'; text: string }>;
  reason: string;
}
export interface TeachingEnvelope {
  packet: TeachingPacket;
  review: { units: Array<{ unit_id: string; points: TeachingJudgment[] }> };
}

/** Build from the registered pre-copy ledger, never from the author's self-review or a shorter draft. */
export async function copyTeachingPacketFromDoc(doc: ProjectDoc): Promise<TeachingPacket> {
  const a = doc.clipMentorAnalysis;
  if (!a?.source_breakdown || checkSourceBreakdown(doc).status !== 'structurally_ready') throw new Error('source_breakdown_not_ready');
  const b = a.source_breakdown;
  const subject = await copyReviewSubject(doc);
  const ids = new Set(b.points.flatMap((p) => breakdownPointEvidence(b, p.point_id)));
  return {
    audience: '给马来西亚创作者学习拍法与商品购买关注的关系；不是消费者广告或功效认证',
    product: { name: a.product.name, purchase_concerns: [...new Set(b.points.map((p) => p.buying_concern))], unknowns: [...new Set(b.segments.flatMap((s) => s.unknowns))] },
    source_evidence: a.evidence.filter((e) => ids.has(e.evidence_id)).map((e) => ({ evidence_id: e.evidence_id,
      observation: `[${e.kind}; ${e.status}] ${e.text}`,
      ...(e.source_range_seconds ? { time_seconds: e.source_range_seconds } : e.time_seconds === undefined ? {} : { time_seconds: [e.time_seconds] }) })),
    units: subject.units.map((u) => {
      const unit = b.units.find((v) => v.unit_id === u.unit_id);
      if (!unit) throw new Error('copy_unit_not_registered');
      const sourceRange = (id: string) => b.segments.find((s) => s.segment_id === id)!.source_range_seconds;
      const blueprint = a.blueprint.find((v) => v.unit_id === u.unit_id) as unknown as Row;
      const internal = blueprint.internal_review as Row;
      const candidate = internal[internal.current_script_candidate as string] as { lines: Array<{ id: string; source_seconds: [number, number] }> };
      const planId = internal.current_picture_plan;
      const execution = text(planId) ? internal[planId] : undefined;
      if (planId !== undefined && (!text(planId) || !row(execution) || execution.script_candidate_id !== internal.current_script_candidate)) throw new Error('picture_plan_candidate_mismatch');
      return { unit_id: u.unit_id, lines: u.lines,
        picture_plan: { original_source_ranges: originalPlaybackRanges(b, unit), explanation_source_ranges: unit.explanation_segment_ids.map(sourceRange),
          line_source_ranges: candidate.lines.map((l) => ({ line_id: l.id, source_range_seconds: l.source_seconds })),
          registered_revisits: unit.revisits.map((r) => ({ from_source_range: sourceRange(r.from_segment_id), to_source_range: sourceRange(r.to_segment_id) })),
          ...(text(planId) && row(execution) ? { execution_plan: { plan_id: planId, script_candidate_id: String(internal.current_script_candidate), content: reviewablePlan(execution) as Row } } : {}) },
        points: unit.coverage.map((c) => {
        const p = b.points.find((v) => v.point_id === c.point_id)!;
        return { point_id: p.point_id, role: p.role, question: p.teaching_question, evidence_ids: breakdownPointEvidence(b, p.point_id),
          buying_concern: p.buying_concern, filming_conditions: [...p.filming_conditions],
          ...(p.supports_point_id ? { supports_point_id: p.supports_point_id } : {}) };
      }) };
    }),
  };
}
const stringList = (v: unknown): v is string[] => Array.isArray(v) && v.every(text);
const distinct = (values: string[]) => new Set(values).size === values.length;
const sourceRangeShape = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && Number.isFinite(n)) && v[0] >= 0 && v[1] > v[0];
function picturePlanShape(v: unknown) {
  return row(v) && Array.isArray(v.original_source_ranges) && v.original_source_ranges.every(sourceRangeShape)
    && Array.isArray(v.explanation_source_ranges) && v.explanation_source_ranges.every(sourceRangeShape)
    && Array.isArray(v.line_source_ranges) && v.line_source_ranges.every((l) => row(l) && text(l.line_id) && sourceRangeShape(l.source_range_seconds))
    && Array.isArray(v.registered_revisits) && v.registered_revisits.every((r) => row(r) && sourceRangeShape(r.from_source_range) && sourceRangeShape(r.to_source_range))
    && (v.execution_plan === undefined || (row(v.execution_plan) && text(v.execution_plan.plan_id) && text(v.execution_plan.script_candidate_id) && row(v.execution_plan.content)));
}
function teachingPacket(v: unknown): v is TeachingPacket {
  if (!row(v) || !text(v.audience) || !row(v.product) || !text(v.product.name)
    || !stringList(v.product.purchase_concerns) || !v.product.purchase_concerns.length || !stringList(v.product.unknowns)
    || !Array.isArray(v.source_evidence) || !v.source_evidence.length || !v.source_evidence.every((e) => row(e) && text(e.evidence_id) && text(e.observation)
      && (e.time_seconds === undefined || (Array.isArray(e.time_seconds) && e.time_seconds.length > 0 && e.time_seconds.every((t) => typeof t === 'number' && Number.isFinite(t) && t >= 0)))
      && (e.operator_supplied_context === undefined || text(e.operator_supplied_context)))
    || !distinct(v.source_evidence.map((e) => e.evidence_id)) || !Array.isArray(v.units) || !v.units.length) return false;
  const evidence = new Set(v.source_evidence.map((e) => e.evidence_id));
  return v.units.every((u) => {
    if (!row(u) || !text(u.unit_id) || !Array.isArray(u.points) || !u.points.length || !Array.isArray(u.lines) || !u.lines.length) return false;
    if (u.picture_plan !== undefined && !picturePlanShape(u.picture_plan)) return false;
    const points = u.points;
    const lines = u.lines;
    return points.every((p) => row(p) && text(p.point_id) && ['primary', 'supporting', 'auxiliary'].includes(String(p.role))
      && text(p.question) && stringList(p.evidence_ids) && p.evidence_ids.length > 0 && p.evidence_ids.every((id) => evidence.has(id)))
      && points.every((p) => (p.buying_concern === undefined || text(p.buying_concern)) && (p.filming_conditions === undefined || stringList(p.filming_conditions)))
      && distinct(points.map((p) => p.point_id)) && points.some((p) => p.role === 'primary')
      && points.every((p) => p.role !== 'supporting' || points.some((target) => target.point_id === p.supports_point_id && target.role === 'primary'))
      && lines.every((l) => row(l) && text(l.line_id) && text(l.narration_ms)
        && stringList(l.caption_lines) && l.caption_lines.length > 0 && text(l.meaning_zh) && stringList(l.labels)
        && stringList(l.point_ids) && l.point_ids.length > 0 && distinct(l.point_ids) && l.point_ids.every((id) => points.some((p) => p.point_id === id)))
      && distinct(lines.map((l) => l.line_id)) && points.every((p) => lines.some((l) => l.point_ids.includes(p.point_id)));
  }) && distinct(v.units.map((u) => u.unit_id));
}
function teachingJudgment(v: unknown): v is TeachingJudgment {
  return row(v) && text(v.point_id) && text(v.learner_takeaway) && text(v.reason)
    && ['purchase_connected', 'function_only', 'action_only', 'supporting_context', 'auxiliary_transition', 'not_explained'].includes(String(v.connection))
    && ['in_copy', 'within_unit', 'background_only', 'none'].includes(String(v.basis))
    && ['supported', 'uncertain', 'contradicted'].includes(String(v.source_support))
    && ['aligned', 'uncertain', 'misaligned'].includes(String(v.meaning_alignment))
    && Array.isArray(v.quotes) && v.quotes.every((q) => row(q) && text(q.line_id)
      && ['narration', 'caption', 'label'].includes(String(q.channel)) && text(q.text));
}
const normalizeCopy = (v: string) => v.trim().replace(/\s+/g, ' ');
function teachingReviewShape(v: unknown): v is TeachingEnvelope['review'] {
  return row(v) && Array.isArray(v.units) && v.units.every((u) => row(u) && text(u.unit_id)
    && Array.isArray(u.points) && u.points.every(teachingJudgment));
}

/** The model supplies evidence/typed observations, never the release verdict. */
export function assessTeachingReview(packet: unknown, review: unknown) {
  const invalid = () => ({ verdict: 'insufficient_evidence' as Verdict, units: [] as Array<{ unit_id: string; verdict: Verdict }>,
    issues: [{ unit_id: '', point_id: '', code: 'teaching_review_invalid' }] });
  if (!teachingPacket(packet) || !teachingReviewShape(review)
    || !distinct(review.units.map((u) => u.unit_id)) || review.units.length !== packet.units.length) return invalid();
  const raw = review as TeachingEnvelope['review'];
  const issues: Array<{ unit_id: string; point_id: string; code: string }> = [];
  const outcomes: Array<{ unit_id: string; verdict: Verdict }> = [];
  for (const unit of packet.units) {
    const assessed = raw.units.find((u) => u.unit_id === unit.unit_id);
    if (!assessed || assessed.points.length !== unit.points.length || !distinct(assessed.points.map((p) => p.point_id))
      || assessed.points.some((p) => !unit.points.some((expected) => expected.point_id === p.point_id))) return invalid();
    let outcome: Verdict = 'pass';
    const fail = (id: string, code: string, unknown = false) => {
      issues.push({ unit_id: unit.unit_id, point_id: id, code });
      if (!unknown || outcome === 'pass') outcome = unknown ? 'insufficient_evidence' : 'needs_revision';
    };
    for (const point of unit.points) {
      const p = assessed.points.find((p) => p.point_id === point.point_id)!;
      const quotesMatch = p.quotes.every((q) => {
        const line = unit.lines.find((l) => l.line_id === q.line_id);
        if (!line) return false;
        const candidates = q.channel === 'narration' ? [line.narration_ms] : q.channel === 'caption' ? [line.caption_lines.join(' ')] : line.labels;
        return candidates.some((v) => normalizeCopy(v).includes(normalizeCopy(q.text)));
      });
      if (!p.quotes.length || !quotesMatch || !p.quotes.some((q) => unit.lines.some((l) => l.line_id === q.line_id && l.point_ids.includes(point.point_id)))) {
        fail(point.point_id, 'missing_or_unmatched_copy_quote', true); continue;
      }
      if (p.source_support === 'uncertain' || p.meaning_alignment === 'uncertain') fail(point.point_id, 'evidence_or_meaning_uncertain', true);
      if (p.source_support === 'contradicted' || p.meaning_alignment === 'misaligned') fail(point.point_id, 'evidence_or_meaning_mismatch');
      if (p.basis === 'background_only' || p.basis === 'none') fail(point.point_id, 'background_cannot_fill_copy_gap');
      if (point.role === 'primary' && p.connection !== 'purchase_connected') fail(point.point_id, 'primary_point_value_not_explained');
      if (point.role === 'supporting' && !['supporting_context', 'purchase_connected'].includes(p.connection)) fail(point.point_id, 'supporting_context_not_explained');
      if (point.role === 'auxiliary' && !['auxiliary_transition', 'purchase_connected', 'supporting_context'].includes(p.connection)) fail(point.point_id, 'auxiliary_role_not_explained');
    }
    outcomes.push({ unit_id: unit.unit_id, verdict: outcome });
  }
  const verdict: Verdict = outcomes.some((u) => u.verdict === 'needs_revision') ? 'needs_revision'
    : outcomes.some((u) => u.verdict === 'insufficient_evidence') ? 'insufficient_evidence' : 'pass';
  return { verdict, units: outcomes, issues };
}

/** Strip host metadata/expected verdicts/author arguments from review handoff. */
export function buildCopyTeachingReviewRequest(cases: Array<{ case_id: string; packet: TeachingPacket }>) {
  if (!cases.length || !distinct(cases.map((c) => c.case_id)) || cases.some((c) => !text(c.case_id) || !teachingPacket(c.packet))) throw new Error('Invalid teaching review packet');
  return { instructions: teachingRegression.instructions, input: { cases: cases.map(({ case_id, packet }) => ({ case_id, packet: {
    audience: packet.audience,
    product: { name: packet.product.name, purchase_concerns: [...packet.product.purchase_concerns], unknowns: [...packet.product.unknowns] },
    source_evidence: packet.source_evidence.map((e) => ({ evidence_id: e.evidence_id, observation: e.observation,
      ...(e.time_seconds ? { time_seconds: [...e.time_seconds] } : {}), ...(e.operator_supplied_context ? { operator_supplied_context: e.operator_supplied_context } : {}) })),
    units: packet.units.map((u) => ({ unit_id: u.unit_id,
      points: u.points.map((p) => ({ point_id: p.point_id, role: p.role, question: p.question, evidence_ids: [...p.evidence_ids],
        ...(p.buying_concern ? { buying_concern: p.buying_concern } : {}), ...(p.filming_conditions ? { filming_conditions: [...p.filming_conditions] } : {}),
        ...(p.supports_point_id ? { supports_point_id: p.supports_point_id } : {}) })),
      lines: u.lines.map((l) => ({ line_id: l.line_id, point_ids: [...l.point_ids], narration_ms: l.narration_ms,
        caption_lines: [...l.caption_lines], meaning_zh: l.meaning_zh, labels: [...l.labels] })),
      ...(u.picture_plan ? { picture_plan: {
        original_source_ranges: u.picture_plan.original_source_ranges.map((r) => [...r] as [number, number]),
        explanation_source_ranges: u.picture_plan.explanation_source_ranges.map((r) => [...r] as [number, number]),
        line_source_ranges: u.picture_plan.line_source_ranges.map((l) => ({ line_id: l.line_id, source_range_seconds: [...l.source_range_seconds] as [number, number] })),
        registered_revisits: u.picture_plan.registered_revisits.map((r) => ({ from_source_range: [...r.from_source_range] as [number, number], to_source_range: [...r.to_source_range] as [number, number] })),
        ...(u.picture_plan.execution_plan ? { execution_plan: { plan_id: u.picture_plan.execution_plan.plan_id,
          script_candidate_id: u.picture_plan.execution_plan.script_candidate_id,
          content: reviewablePlan(u.picture_plan.execution_plan.content) as Row } } : {}),
      } } : {}),
    })),
  } })) } };
}

function teachingSubjectMatches(subject: Awaited<ReturnType<typeof copyReviewSubject>>, packet: TeachingPacket) {
  return packet.units.length === subject.units.length && subject.units.every((u) => {
    const reviewed = packet.units.find((p) => p.unit_id === u.unit_id);
    return !!reviewed && canonical(reviewed.lines) === canonical(u.lines)
      && canonical(reviewed.points.map((p) => p.point_id).sort()) === canonical([...new Set(u.lines.flatMap((l) => l.point_ids))].sort());
  });
}
