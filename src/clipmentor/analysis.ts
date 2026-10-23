/** Project-owned pre-edit analysis. No inference, model calls, or timeline edits. */
import { isCopyProductionReview, type CopyProductionReview } from './production-gate';
import type { ProjectDoc } from '../editor/types.js';
import { isSourceTranscription, type SourceTranscription } from '../../shared/clipmentor-asr';
import { isSourceBreakdown, checkSourceBreakdown, type SourceBreakdown } from './source-breakdown';

export interface AnalysisActor {
  operator: string;
  executor: string;
  instruction: string;
  identity: 'local_declared_not_authenticated';
}
export interface AnalysisEvidence {
  evidence_id: string;
  kind: 'source_frame' | 'original_claim' | 'visible_action' | 'expression_analysis_not_verified_causal_effect' | 'operator_supplied';
  text: string;
  status: string;
  provenance?: string;
  source_range_seconds?: [number, number];
  time_seconds?: number;
  source_frame?: number;
  supporting_evidence_ids: string[];
  source_ids: string[];
  observation_method?: string;
  call_status?: 'historical_unknown' | 'unknown' | 'failed' | 'succeeded';
  observation_id?: string;
}
/** Extraction/delivery only. Does not certify that a model understood an image. */
export interface AnalysisObservation {
  observation_id: string;
  source_hash: string;
  requested_times_seconds: number[];
  frame_evidence_ids: string[];
  status: 'images_returned' | 'failed';
  method: 'source_frames_for_main_agent';
  image_layout?: 'individual_frames';
  sampling?: 'explicit_times' | 'sequence';
  at: number;
  failure?: 'extraction_failed_or_incomplete';
}
export interface AnalysisPoint {
  point_id: string;
  unit_id: string;
  source_range_seconds: [number, number];
  buying_reason_or_function: string;
  filming_conditions: string[];
  evidence_ids: string[];
  uncertainties: string[];
  required: boolean;
  explanation_priority: string;
  status: string;
  review_status: string;
  provenance: string;
}
export interface AnalysisUnit {
  unit_id: string;
  point_ids: string[];
  intent_zh: string;
  line_guidance: string;
  narration_budget_seconds?: [number, number];
}
export interface AnalysisReview {
  point_id: string;
  state: 'confirmed' | 'needs_revision' | 'stale';
  content_digest: string;
  source_hash: string | null;
  actor: AnalysisActor;
  at: number;
  reason: string;
}
export interface ClipMentorAnalysis {
  source_breakdown?: SourceBreakdown;
  production_copy_review?: CopyProductionReview;
  schema_version: 1;
  analysis_id: string;
  revision: number;
  source: { asset_id: string; sourceContentHash: string | null; duration_seconds: number; fps: number };
  product: { name: string; category: string };
  import_origin: string;
  /** Actual original-source ASR run, never a claim of listening verification. */
  source_transcription?: SourceTranscription;
  observations?: AnalysisObservation[];
  evidence: AnalysisEvidence[];
  points: AnalysisPoint[];
  blueprint: AnalysisUnit[];
  transcripts: Array<{
    source_id: string; provider: string; origin: string; status: string;
    words: Array<{ start_seconds: number; end_seconds: number; text: string }>;
  }>;
  reviews: AnalysisReview[];
  audit: Array<{ revision: number; action: string; target_id: string; actor: AnalysisActor; at: number; reason: string }>;
}

type Row = Record<string, unknown>;
const row = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const nonempty = (v: unknown): v is string => str(v) && !!v.trim();
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(nonempty);
const hash = (v: unknown): boolean => v === null || (str(v) && /^[a-f0-9]{64}$/.test(v));
const range = (v: unknown, instant = false): boolean => Array.isArray(v) && v.length === 2 && v.every(finite) && v[0] >= 0 && (instant ? v[1] >= v[0] : v[1] > v[0]);
const rows = (v: unknown, check: (r: Row) => boolean): boolean => Array.isArray(v) && v.every((x) => row(x) && check(x));
const unique = (v: unknown[], key: string): boolean => new Set(v.map((x) => (x as Row)[key])).size === v.length;
export function isAnalysisActor(v: unknown): v is AnalysisActor {
  return row(v) && nonempty(v.operator) && nonempty(v.executor) && nonempty(v.instruction)
    && v.identity === 'local_declared_not_authenticated';
}
/** Shape validation preserves uncertain/dangling records for review; handoff validates references. */
export function isClipMentorAnalysis(v: unknown): v is ClipMentorAnalysis {
  if (!row(v) || v.schema_version !== 1 || !nonempty(v.analysis_id)
    || !Number.isSafeInteger(v.revision) || Number(v.revision) < 1 || !row(v.source)
    || !nonempty(v.source.asset_id) || !hash(v.source.sourceContentHash)
    || !finite(v.source.duration_seconds) || v.source.duration_seconds <= 0
    || !finite(v.source.fps) || v.source.fps <= 0 || !row(v.product)
    || !nonempty(v.product.name) || !str(v.product.category) || !nonempty(v.import_origin)) return false;
  if (v.production_copy_review !== undefined && !isCopyProductionReview(v.production_copy_review)) return false;
  if (v.source_breakdown !== undefined && !isSourceBreakdown(v.source_breakdown)) return false;
  if (v.source_transcription !== undefined && !isSourceTranscription(v.source_transcription)) return false;
  if (v.observations !== undefined && (!rows(v.observations, (o) => nonempty(o.observation_id)
    && str(o.source_hash) && /^[a-f0-9]{64}$/.test(o.source_hash)
    && Array.isArray(o.requested_times_seconds) && o.requested_times_seconds.length > 0
    && o.requested_times_seconds.every((t) => finite(t) && t >= 0)
    && strings(o.frame_evidence_ids) && (typeof o.status === 'string' && ['images_returned', 'failed'].includes(o.status))
    && o.method === 'source_frames_for_main_agent' && finite(o.at) && o.at >= 0
    && (o.image_layout === undefined || o.image_layout === 'individual_frames')
    && (o.sampling === undefined || (typeof o.sampling === 'string' && ['explicit_times', 'sequence'].includes(o.sampling)))
    && (o.failure === undefined || o.failure === 'extraction_failed_or_incomplete'))
    || !unique(v.observations as unknown[], 'observation_id'))) return false;
  if (!rows(v.evidence, (e) => nonempty(e.evidence_id) && nonempty(e.status) && str(e.text)
    && (typeof e.kind === 'string' && ['source_frame', 'original_claim', 'visible_action', 'expression_analysis_not_verified_causal_effect', 'operator_supplied'].includes(e.kind))
    && (e.provenance === undefined || nonempty(e.provenance))
    && strings(e.supporting_evidence_ids) && strings(e.source_ids)
    && (e.source_range_seconds === undefined || range(e.source_range_seconds, e.kind === 'visible_action'))
    && (e.time_seconds === undefined || (finite(e.time_seconds) && e.time_seconds >= 0))
    && (e.source_frame === undefined || (Number.isSafeInteger(e.source_frame) && Number(e.source_frame) >= 0))
    && (e.observation_method === undefined || nonempty(e.observation_method))
    && (e.call_status === undefined || (typeof e.call_status === 'string' && ['historical_unknown', 'unknown', 'failed', 'succeeded'].includes(e.call_status)))
    && (e.observation_id === undefined || nonempty(e.observation_id))
    && (e.kind !== 'source_frame' || (finite(e.time_seconds) && Number.isSafeInteger(e.source_frame)))
    && (!(typeof e.kind === 'string' && ['source_frame', 'visible_action'].includes(e.kind)) || (nonempty(e.observation_method) && nonempty(e.call_status))))) return false;
  if (!rows(v.points, (p) => nonempty(p.point_id) && nonempty(p.unit_id) && range(p.source_range_seconds)
    && nonempty(p.buying_reason_or_function) && strings(p.filming_conditions) && strings(p.evidence_ids)
    && strings(p.uncertainties) && typeof p.required === 'boolean' && nonempty(p.explanation_priority) && nonempty(p.status)
    && nonempty(p.review_status) && nonempty(p.provenance))) return false;
  if (!rows(v.blueprint, (b) => nonempty(b.unit_id) && strings(b.point_ids) && nonempty(b.intent_zh)
    && str(b.line_guidance) && (b.narration_budget_seconds === undefined || range(b.narration_budget_seconds)))) return false;
  if (!rows(v.transcripts, (t) => nonempty(t.source_id) && nonempty(t.provider) && nonempty(t.origin) && nonempty(t.status)
    && rows(t.words, (w) => finite(w.start_seconds) && finite(w.end_seconds) && w.start_seconds >= 0
      && w.end_seconds >= w.start_seconds && nonempty(w.text)))) return false;
  if (!rows(v.reviews, (r) => nonempty(r.point_id) && (typeof r.state === 'string' && ['confirmed', 'needs_revision', 'stale'].includes(r.state))
    && hash(r.source_hash) && str(r.content_digest) && /^[a-f0-9]{64}$/.test(r.content_digest)
    && isAnalysisActor(r.actor) && finite(r.at) && r.at >= 0 && nonempty(r.reason))) return false;
  if (!rows(v.audit, (a) => Number.isSafeInteger(a.revision) && Number(a.revision) > 0 && nonempty(a.action)
    && nonempty(a.target_id) && isAnalysisActor(a.actor) && finite(a.at) && a.at >= 0 && nonempty(a.reason))) return false;
  return unique(v.evidence as unknown[], 'evidence_id') && unique(v.points as unknown[], 'point_id')
    && unique(v.blueprint as unknown[], 'unit_id') && unique(v.transcripts as unknown[], 'source_id')
    && unique(v.reviews as unknown[], 'point_id');
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (row(v)) return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
export async function pointDigest(a: ClipMentorAnalysis, pointId: string): Promise<string> {
  const point = a.points.find((p) => p.point_id === pointId);
  if (!point) throw new Error('Analysis point not found');
  const needed = new Set(point.evidence_ids);
  let size = -1;
  while (size !== needed.size) {
    size = needed.size;
    for (const e of a.evidence) if (needed.has(e.evidence_id)) for (const id of e.supporting_evidence_ids) needed.add(id);
  }
  const evidence = [...needed].sort().map((id) => a.evidence.find((e) => e.evidence_id === id) ?? { missing_id: id });
  const transcriptIds = new Set(evidence.flatMap((e) => 'source_ids' in e ? e.source_ids : []));
  const { review_status: _historicalReviewStatus, ...content } = point;
  const bytes = new TextEncoder().encode(canonical({ point: content, evidence,
    transcripts: a.transcripts.filter((t) => transcriptIds.has(t.source_id)),
    product: a.product, source: a.source, source_breakdown: a.source_breakdown,
    blueprint: a.blueprint.filter((b) => b.point_ids.includes(pointId)),
  }));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export interface AnalysisHandoff {
  scope: 'pre_edit_analysis_only';
  status: 'ready_for_copy_review' | 'review_required';
  issues: Array<{ code: string; id: string }>;
  point_states: Array<{ point_id: string; state: 'pending' | 'confirmed' | 'needs_revision' | 'stale' }>;
}
export async function checkAnalysisHandoff(doc: ProjectDoc): Promise<AnalysisHandoff> {
  const result: AnalysisHandoff = { scope: 'pre_edit_analysis_only', status: 'review_required', issues: [], point_states: [] };
  const a = doc.clipMentorAnalysis;
  const issue = (code: string, id: string) => result.issues.push({ code, id });
  if (!a) { issue('analysis_missing', 'project'); return result; }
  if (a.source_breakdown) for (const i of checkSourceBreakdown(doc).issues) issue(i.code, i.id);
  const asset = doc.assets.find((v) => v.id === a.source.asset_id);
  const validSource = !!a.source.sourceContentHash && asset?.sourceContentHash === a.source.sourceContentHash;
  if (!validSource) issue('source_hash_missing_or_changed', a.source.asset_id);
  if (a.source_transcription) {
    if (a.source_transcription.source_hash !== a.source.sourceContentHash) issue('transcription_source_mismatch', a.source.asset_id);
    if (a.source_transcription.status !== 'completed') issue('source_transcription_incomplete', a.source_transcription.operation_id);
    for (const code of a.source_transcription.issues) issue(`asr:${code}`, a.source_transcription.operation_id);
  }
  const ids = new Map(a.evidence.map((e) => [e.evidence_id, e]));
  const transcriptIds = new Set(a.transcripts.map((t) => t.source_id));
  const pointIds = new Set(a.points.map((p) => p.point_id));
  const duration = a.source.duration_seconds;
  const checkRange = (r: [number, number] | undefined, id: string) => {
    if (r && (r[0] < 0 || r[1] > duration)) issue('source_time_out_of_bounds', id);
  };
  for (const o of a.observations ?? []) {
    if (o.source_hash !== a.source.sourceContentHash) issue('observation_source_mismatch', o.observation_id);
    if (o.status === 'failed') issue('failed_observation', o.observation_id);
    for (const time of o.requested_times_seconds) if (time >= duration) issue('invalid_frame_time', o.observation_id);
    for (const id of o.frame_evidence_ids) if (ids.get(id)?.observation_id !== o.observation_id) issue('missing_observation_frame', id);
  }
  for (const e of a.evidence) {
    checkRange(e.source_range_seconds, e.evidence_id);
    for (const id of e.supporting_evidence_ids) if (!ids.has(id)) issue('missing_evidence_reference', id);
    for (const id of e.source_ids) if (!transcriptIds.has(id)) issue('missing_transcript_reference', id);
    if (e.kind === 'source_frame' && (e.time_seconds! >= duration || Math.abs(e.source_frame! / a.source.fps - e.time_seconds!) > 0.5 / a.source.fps)) issue('invalid_frame_time', e.evidence_id);
    if (e.kind === 'visible_action' && !e.supporting_evidence_ids.some((id) => ids.get(id)?.kind === 'source_frame')) issue('visible_action_without_frame', e.evidence_id);
    if (e.call_status === 'failed') issue('failed_observation', e.evidence_id);
    if (e.observation_id && !(a.observations ?? []).some((o) => o.observation_id === e.observation_id && o.status === 'images_returned')) issue('unavailable_observation', e.evidence_id);
  }
  for (const t of a.transcripts) for (const w of t.words) if (w.end_seconds > duration) { issue('source_time_out_of_bounds', t.source_id); break; }
  if (!a.points.length || !a.blueprint.length) issue('empty_analysis', a.analysis_id);
  for (const r of a.reviews) if (!pointIds.has(r.point_id)) issue('missing_review_point', r.point_id);
  for (const b of a.blueprint) for (const id of b.point_ids) {
    const p = a.points.find((p) => p.point_id === id);
    if (!p || p.unit_id !== b.unit_id) issue('invalid_blueprint_point', id);
  }
  for (const p of a.points) {
    checkRange(p.source_range_seconds, p.point_id);
    if (!p.evidence_ids.length) issue('point_without_evidence', p.point_id);
    for (const id of p.evidence_ids) if (!ids.has(id)) issue('missing_evidence_reference', id);
    const review = a.reviews.find((r) => r.point_id === p.point_id);
    const state = !validSource || (review && (review.source_hash !== a.source.sourceContentHash || review.content_digest !== await pointDigest(a, p.point_id)))
      ? 'stale' : review?.state ?? 'pending';
    result.point_states.push({ point_id: p.point_id, state });
    const used = a.blueprint.some((b) => b.unit_id === p.unit_id && b.point_ids.includes(p.point_id));
    if (p.required && !used) issue('required_point_not_in_blueprint', p.point_id);
    if ((p.required || used) && state !== 'confirmed') issue(`point_${state}`, p.point_id);
  }
  if (!result.issues.length) result.status = 'ready_for_copy_review';
  return result;
}

export async function invalidateChangedReviews(a: ClipMentorAnalysis): Promise<void> {
  for (const review of a.reviews) {
    if (!a.points.some((p) => p.point_id === review.point_id) || review.content_digest !== await pointDigest(a, review.point_id)) review.state = 'stale';
  }
}
