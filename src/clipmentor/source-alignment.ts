/** Original-expression evidence and accounting inside the existing copy-review packet. */
import type { ClipMentorAnalysis } from './analysis';

export interface SourceEvidence {
  evidence_id: string;
  observation: string;
  time_seconds?: number[];
  operator_supplied_context?: string;
}
export type SourceReviewScope = { kind: 'full_source'; instruction: string }
  | { kind: 'local_ranges'; source_ranges: Array<[number, number]>; instruction: string };
export interface SourceContext {
  scope: 'frozen_task_scope' | 'legacy_scope_unconfirmed';
  source_ranges: Array<[number, number]>;
  evidence_ids: string[];
  speech: 'asr_available_not_listening_verified' | 'unavailable';
}
export interface SourceClaimImpact {
  status: 'affects_current_claim' | 'does_not_affect_current_claim' | 'unresolved';
  unknown_detail: string;
  reason: string;
  claims: Array<{line_id: string; channel: 'narration' | 'caption' | 'label'; quote: string}>;
}
export interface SourceRelation {
  relation: string;
  evidence_ids: string[];
  point_ids: string[];
  line_ids: string[];
  assessment: 'covered' | 'material_gap' | 'optional_depth' | 'uncertain';
  reason: string;
  /** Reviewer/operator scope judgment, never inferred from keywords or IDs alone. */
  claim_impact?: SourceClaimImpact;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(text) && new Set(v).size === v.length;
const validRange = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2
  && v.every(n => typeof n === 'number' && Number.isFinite(n)) && v[0] >= 0 && v[1] > v[0];
const overlaps = (range: [number, number], times: number[]) => times.length === 1
  ? times[0] >= range[0] && times[0] < range[1] : times[0] < range[1] && times[1] > range[0];

export function isSourceContext(v: unknown): v is SourceContext {
  return object(v) && ['frozen_task_scope', 'legacy_scope_unconfirmed'].includes(v.scope as string) && Array.isArray(v.source_ranges)
    && v.source_ranges.length > 0 && v.source_ranges.every(validRange) && strings(v.evidence_ids)
    && ['asr_available_not_listening_verified', 'unavailable'].includes(v.speech as string);
}

export function isSourceReviewScope(v: unknown): v is SourceReviewScope {
  return object(v) && text(v.instruction) && (v.kind === 'full_source'
    ? Object.keys(v).every(k => ['kind', 'instruction'].includes(k))
    : v.kind === 'local_ranges' && Object.keys(v).every(k => ['kind', 'instruction', 'source_ranges'].includes(k))
      && Array.isArray(v.source_ranges) && v.source_ranges.length > 0 && v.source_ranges.every(validRange));
}

/** Task scope is recorded before clip selection; absent legacy scope cannot approve. */
export function sourceReviewRanges(a: ClipMentorAnalysis): Array<[number, number]> {
  const scope = a.source_breakdown?.review_scope;
  return scope?.kind === 'local_ranges' ? scope.source_ranges : [[0, a.source.duration_seconds]];
}

/** Add original facts/speech from the review scope, including those not selected as points.
 * No WHY entries, author verdicts, old reviews or reference answers enter this context.
 * Transcript words are compacted into <=32-word passages, once in source_evidence.
 */
export function buildSourceContext(a: ClipMentorAnalysis, ranges: Array<[number, number]>, pool: SourceEvidence[]): SourceContext {
  const merged: Array<[number, number]> = [];
  for (const range of ranges.slice().sort((a, b) => a[0] - b[0])) {
    if (!validRange(range) || range[1] > a.source.duration_seconds) throw new Error('source_context_range_invalid');
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  if (!merged.length) throw new Error('source_context_range_missing');
  const ids = new Set<string>();
  const add = (e: SourceEvidence) => {
    const existing = pool.find(p => p.evidence_id === e.evidence_id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(e)) throw new Error('source_context_evidence_collision');
    if (!existing) pool.push(e);
    ids.add(e.evidence_id);
  };
  for (const e of a.evidence) {
    if (!['original_claim', 'visible_action', 'source_frame'].includes(e.kind)) continue;
    const times = e.source_range_seconds ?? (e.time_seconds === undefined ? undefined : [e.time_seconds]);
    if (!times || !merged.some(r => times.length === 1 ? overlaps(r, times) : times[0] >= r[0] && times[1] <= r[1])) continue;
    add({ evidence_id: e.evidence_id, observation: `[${e.kind}; ${e.status}] ${e.text}`, time_seconds: times });
  }
  const transcription = a.source_transcription;
  const streams = transcription ? (transcription.source_hash === a.source.sourceContentHash
    ? [{ source_id: transcription.operation_id, status: transcription.status, provider: transcription.model, words: transcription.words }] : []) : a.transcripts;
  let speech = false;
  for (const stream of streams) {
    const words = stream.words.filter(w => text(w.text) && Number.isFinite(w.start_seconds) && Number.isFinite(w.end_seconds)
      && w.start_seconds >= 0 && w.end_seconds >= w.start_seconds && w.end_seconds <= a.source.duration_seconds
      && merged.some(r => overlaps(r, w.end_seconds === w.start_seconds ? [w.start_seconds] : [w.start_seconds, w.end_seconds]))).sort((a, b) => a.start_seconds - b.start_seconds);
    for (let i = 0; i < words.length; i += 32) {
      const passage = words.slice(i, i + 32);
      const start = passage[0].start_seconds;
      // Never create a passage that bridges an excluded source window.
      const range = merged.find(r => overlaps(r, passage[0].end_seconds === start ? [start] : [start, passage[0].end_seconds]))!;
      const current = passage.filter(w => overlaps(range, w.start_seconds === w.end_seconds ? [w.start_seconds] : [w.start_seconds, w.end_seconds]));
      i -= passage.length - current.length;
      const stop = Math.max(...current.map(w => w.end_seconds));
      add({ evidence_id: `raw-speech:${stream.source_id}:${start}:${stop}`,
        observation: `[original_asr; ${stream.provider}; ${stream.status}; not listening verified${start < range[0] || stop > range[1] ? '; boundary context; sentence boundary unverified' : ''}] ${current.map(w => w.text).join(' ')}`,
        time_seconds: [start, stop] });
      speech = true;
    }
  }
  return { scope: a.source_breakdown?.review_scope ? 'frozen_task_scope' : 'legacy_scope_unconfirmed', source_ranges: merged, evidence_ids: [...ids],
    speech: speech ? 'asr_available_not_listening_verified' : 'unavailable' };
}

function claimImpactShape(v: unknown): v is SourceClaimImpact {
  return object(v) && Object.keys(v).every(k => ['status','unknown_detail','reason','claims'].includes(k))
    && ['affects_current_claim','does_not_affect_current_claim','unresolved'].includes(v.status as string)
    && text(v.unknown_detail) && text(v.reason) && Array.isArray(v.claims) && v.claims.length > 0
    && v.claims.every(c => object(c) && Object.keys(c).every(k => ['line_id','channel','quote'].includes(k))
      && text(c.line_id) && ['narration','caption','label'].includes(c.channel as string) && text(c.quote));
}
export function sourceRelationsShape(value: unknown): value is SourceRelation[] {
  return Array.isArray(value) && value.every(r => object(r) && text(r.relation) && text(r.reason)
    && strings(r.evidence_ids) && strings(r.point_ids) && strings(r.line_ids)
    && typeof r.assessment === 'string' && ['covered', 'material_gap', 'optional_depth', 'uncertain'].includes(r.assessment)
    && (r.claim_impact === undefined || (r.assessment === 'uncertain' && claimImpactShape(r.claim_impact))));
}

/** Structural references and declared material gaps only; not a semantic quality oracle. */
export function assessSourceAlignment(context: SourceContext, points: Array<{point_id: string; treatment?: string}>,
  lines: Array<{line_id: string; point_ids: string[]; narration_ms?: string; caption_lines?: string[]; labels?: string[]}>, value: unknown) {
  const unknown = (issue: string) => ({ verdict: 'insufficient_evidence' as const, issues: [issue] });
  if (!isSourceContext(context) || context.scope !== 'frozen_task_scope' || !sourceRelationsShape(value) || !value.length) return unknown('source_relations_missing');
  for (const r of value) {
    if (!object(r) || !text(r.relation) || !text(r.reason) || !strings(r.evidence_ids) || !strings(r.point_ids) || !strings(r.line_ids)
      || typeof r.assessment !== 'string' || !['covered', 'material_gap', 'optional_depth', 'uncertain'].includes(r.assessment)) return unknown('source_relation_invalid');
    if (r.evidence_ids.some(id => !context.evidence_ids.includes(id)) || (!r.evidence_ids.length && r.assessment !== 'uncertain')
      || r.point_ids.some(id => !points.some(p => p.point_id === id)) || r.line_ids.some(id => !lines.some(l => l.line_id === id))) return unknown('source_relation_reference_invalid');
    if (r.assessment === 'covered' && (!r.point_ids.length || !r.point_ids.every(id =>
      points.some(p => p.point_id === id && p.treatment === 'visual_only')
      || lines.some(l => r.line_ids.includes(l.line_id) && l.point_ids.includes(id))))) return unknown('source_relation_landing_missing');
  }
  const relations = value as SourceRelation[];
  const gaps = relations.filter(r => r.assessment === 'material_gap');
  if (gaps.length) return { verdict: 'needs_revision' as const, issues: gaps.map(r => r.relation) };
  const unclear = relations.filter(r => {
    if (r.assessment !== 'uncertain') return false;
    const impact = r.claim_impact;
    if (!impact || impact.status !== 'does_not_affect_current_claim' || !r.line_ids.length || !r.point_ids.length || !r.evidence_ids.length) return true;
    // Code verifies the declared scope and real quotations; it does not decide semantic relevance.
    if (new Set(impact.claims.map(c => JSON.stringify(c))).size !== impact.claims.length
      || impact.claims.some(c => {
        const line = lines.find(l => l.line_id === c.line_id);
        const words = c.channel === 'narration' ? [line?.narration_ms] : c.channel === 'caption' ? line?.caption_lines : line?.labels;
        return !r.line_ids.includes(c.line_id) || !words?.some(w => typeof w === 'string' && w.includes(c.quote));
      }) || r.line_ids.some(id => !impact.claims.some(c => c.line_id === id))) return true;
    return r.point_ids.some(id => !relations.some(other => other.assessment === 'covered' && other.point_ids.includes(id)
      && other.evidence_ids.some(e => r.evidence_ids.includes(e))
      && r.line_ids.every(line => other.line_ids.includes(line))));
  });
  return unclear.length ? unknown('source_relationship_uncertain') : { verdict: 'pass' as const, issues: [] };
}
