import type { ClipMentorAnalysis } from './analysis';
import { invalidAnalysisEvidenceField, isClipMentorAnalysis, invalidateChangedReviews, type AnalysisActor } from './analysis';

type EvidenceIssue = { index: number; evidence_id?: string; field: string; reason: string };

export class AnalysisEvidenceInputError extends Error {
  readonly issues: EvidenceIssue[];

  constructor(issues: EvidenceIssue[]) {
    const first = issues[0];
    super(`Evidence ${first.evidence_id ?? first.index} ${first.field}: ${first.reason}; nothing changed`);
    this.issues = issues;
  }
}

/** Add candidates, not approvals. Existing records can only be changed through the revision path. */
export async function appendAnalysisFindings(current: ClipMentorAnalysis, input: unknown, actor: AnalysisActor, reason: string, suppliedImageIds: readonly string[] = []): Promise<ClipMentorAnalysis> {
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
  const added = a.evidence.slice(current.evidence.length);
  const evidenceInputIssues: EvidenceIssue[] = [];
  const recordIssue = (index: number, evidenceId: unknown, field: string, reason: string) => {
    evidenceInputIssues.push({ index, ...(typeof evidenceId === 'string' && /^[\p{L}\p{N}_:.-]{1,160}$/u.test(evidenceId) ? { evidence_id: evidenceId } : {}), field, reason });
  };
  const ids = new Set(current.evidence.map((e) => e.evidence_id));
  const validFields: Array<[number, typeof added[number]]> = [];
  for (const [index, item] of added.entries()) {
    const field = invalidAnalysisEvidenceField(item);
    if (field) recordIssue(index, item?.evidence_id, field, 'Expected a valid evidence field');
    else if (ids.has(item.evidence_id)) recordIssue(index, item.evidence_id, 'evidence_id', 'Evidence ID already registered in the project or this batch');
    else {
      ids.add(item.evidence_id);
      validFields.push([index, item]);
    }
  }

  const statuses = { original_claim: 'candidate_unverified_speech', visible_action: 'agent_observed_candidate',
    expression_analysis_not_verified_causal_effect: 'inferred_not_verified_causal_effect', operator_supplied: 'operator_provided_not_independently_verified' };
  const transcripts = new Set(a.transcripts.map((t) => t?.source_id));
  const inSource = (r: [number, number]) => r[0] >= 0 && r[1] <= a.source.duration_seconds;
  for (const [index, e] of validFields) {
    const issue = (field: string, reason: string) => recordIssue(index, e.evidence_id, field, reason);
    if (e.kind === 'source_frame') issue('kind', 'Use the source observation tool to register frames');
    else if (e.status !== statuses[e.kind]) issue('status', 'New findings must use the candidate status for their evidence kind');
    if (e.source_range_seconds ? !inSource(e.source_range_seconds) : e.kind !== 'operator_supplied')
      issue('source_range_seconds', 'Expected a range inside the original source');
    if (e.kind === 'original_claim' && !e.source_ids.length)
      issue('source_ids', 'A speech candidate requires a registered transcript ID');
    if (e.source_ids.some((id) => !transcripts.has(id) && !(e.kind === 'operator_supplied' && suppliedImageIds.includes(id))))
      issue('source_ids', e.kind === 'operator_supplied'
        ? 'Invalid evidence reference: use a supplied image asset ID or a registered transcript ID. Cite original video via registered frame evidence in supporting_evidence_ids'
        : 'Invalid evidence reference: use a registered transcript ID');
    if (e.supporting_evidence_ids.some((id) => id === e.evidence_id || !ids.has(id)))
      issue('supporting_evidence_ids', 'Expected registered evidence IDs other than the row itself');
    if (e.kind === 'expression_analysis_not_verified_causal_effect' && !e.supporting_evidence_ids.length)
      issue('supporting_evidence_ids', 'Interpretations require supporting evidence');
    if (e.kind === 'visible_action') {
      const observation = a.observations?.find((o) => o.observation_id === e.observation_id);
      if (!observation) issue('observation_id', 'Must exactly match a saved observation ID, including its observation: prefix');
      else if (observation.status !== 'images_returned' || observation.source_hash !== a.source.sourceContentHash)
        issue('observation_id', 'Expected returned frames from the current original source');
      else if (!e.supporting_evidence_ids.length || !e.supporting_evidence_ids.every((id) => observation.frame_evidence_ids.includes(id)))
        issue('supporting_evidence_ids', 'Cite frames returned by the selected observation');
      if (e.observation_method !== 'main_agent_direct_image_read_not_independently_verified')
        issue('observation_method', 'Use the declared direct image-read method');
      if (e.call_status !== 'unknown') issue('call_status', 'Image interpretation remains unverified');
    }
  }
  if (evidenceInputIssues.length) throw new AnalysisEvidenceInputError(evidenceInputIssues.sort((a, b) => a.index - b.index));
  if (!isClipMentorAnalysis(a)) throw new Error('Invalid or duplicate records');
  const units = new Map(a.blueprint.map((b) => [b.unit_id, b]));
  for (const p of a.points.slice(current.points.length)) {
    if (p.status !== 'candidate' || p.review_status !== 'pending' || !p.evidence_ids.length) throw new Error('New points must be evidenced candidates pending review');
    if (!inSource(p.source_range_seconds) || p.evidence_ids.some((id) => !ids.has(id))) throw new Error('Invalid point reference or source time');
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
