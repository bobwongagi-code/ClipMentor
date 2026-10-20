import type { ClipMentorAnalysis } from './analysis';
import { isClipMentorAnalysis, invalidateChangedReviews, type AnalysisActor } from './analysis';

export const OBSERVATION_ID_MISMATCH = 'Visible action observation_id must exactly match a saved observation ID, including its observation: prefix; nothing changed';

/** Add candidates, not approvals. Existing records can only be changed through the revision path. */
export async function appendAnalysisFindings(current: ClipMentorAnalysis, input: unknown, actor: AnalysisActor, reason: string): Promise<ClipMentorAnalysis> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Findings object required');
  const records = input as Record<string, unknown>;
  if (!Object.keys(records).length || Object.keys(records).some((k) => !['product', 'evidence', 'points', 'blueprint', 'transcripts'].includes(k))) throw new Error('Only candidate findings fields allowed');
  const a = structuredClone(current);
  if (records.product !== undefined) a.product = structuredClone(records.product) as ClipMentorAnalysis['product'];
  for (const key of ['evidence', 'points', 'blueprint', 'transcripts'] as const) {
    if (records[key] !== undefined) {
      if (!Array.isArray(records[key])) throw new Error('Record collections must be arrays');
      (a[key] as unknown[]).push(...structuredClone(records[key]) as unknown[]);
    }
  }
  if (!isClipMentorAnalysis(a)) throw new Error('Invalid or duplicate records');
  const added = a.evidence.slice(current.evidence.length);
  const statuses = { original_claim: 'candidate_unverified_speech', visible_action: 'agent_observed_candidate',
    expression_analysis_not_verified_causal_effect: 'inferred_not_verified_causal_effect', operator_supplied: 'operator_provided_not_independently_verified' };
  for (const e of added) {
    if (e.kind === 'source_frame' || e.status !== statuses[e.kind]) throw new Error('Use observation tool for frames; new findings must remain candidates');
    if (e.kind !== 'operator_supplied' && !e.source_range_seconds) throw new Error('Source time required');
    if (e.kind === 'original_claim' && !e.source_ids.length) throw new Error('Speech candidates need a transcript source');
    if (e.kind === 'visible_action') {
      const observation = a.observations?.find((o) => o.observation_id === e.observation_id);
      if (!observation) throw new Error(OBSERVATION_ID_MISMATCH);
      if (observation?.status !== 'images_returned' || observation.source_hash !== a.source.sourceContentHash
        || !e.supporting_evidence_ids.length || !e.supporting_evidence_ids.every((id) => observation.frame_evidence_ids.includes(id))
        || e.observation_method !== 'main_agent_direct_image_read_not_independently_verified'
        || e.call_status !== 'unknown') throw new Error('Visible actions must cite returned frames; image interpretation is Agent-declared, not independently verified');
    }
    if (e.kind === 'expression_analysis_not_verified_causal_effect' && !e.supporting_evidence_ids.length) throw new Error('Interpretations require evidence');
  }
  for (const p of a.points.slice(current.points.length)) {
    if (p.status !== 'candidate' || p.review_status !== 'pending' || !p.evidence_ids.length) throw new Error('New points must be evidenced candidates pending review');
  }
  const evidence = new Set(a.evidence.map((e) => e.evidence_id));
  const transcripts = new Set(a.transcripts.map((t) => t.source_id));
  const units = new Map(a.blueprint.map((b) => [b.unit_id, b]));
  const inSource = (r: [number, number]) => r[0] >= 0 && r[1] <= a.source.duration_seconds;
  for (const e of added) {
    if ((e.source_range_seconds && !inSource(e.source_range_seconds))
      || e.supporting_evidence_ids.some((id) => id === e.evidence_id || !evidence.has(id))
      || e.source_ids.some((id) => !transcripts.has(id))) throw new Error('Invalid evidence reference or source time');
  }
  for (const p of a.points.slice(current.points.length)) {
    if (!inSource(p.source_range_seconds) || p.evidence_ids.some((id) => !evidence.has(id))) throw new Error('Invalid point reference or source time');
    const unit = units.get(p.unit_id);
    if (unit && !unit.point_ids.includes(p.point_id)) throw new Error('Point/unit mapping mismatch');
  }
  for (const b of a.blueprint.slice(current.blueprint.length)) {
    if (b.point_ids.some((id) => !a.points.some((p) => p.point_id === id && p.unit_id === b.unit_id))) throw new Error('Invalid blueprint point mapping');
  }
  // Supplemental text may be segment-aligned; do not fabricate word-level timestamps or listening approval.
  for (const t of a.transcripts.slice(current.transcripts.length)) {
    if (t.status !== 'operator_provided_segment_text_not_independently_listened'
      || !t.words.length || t.words.some((w) => !inSource([w.start_seconds, w.end_seconds]))) throw new Error('Supplementary text must remain unverified and inside source time');
  }
  await invalidateChangedReviews(a);
  a.revision += 1;
  a.audit.push({ revision: a.revision, action: 'append_findings', target_id: a.analysis_id, actor, at: Date.now(), reason });
  return a;
}
