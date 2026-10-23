import type { ProjectDoc } from '../editor/types';
import { checkCopyProduction } from './production-gate';

type Row = Record<string, unknown>;
const object = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);
const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : object(v) ? `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
    : JSON.stringify(v) ?? 'undefined';

export interface DeliveryChange { scope: string; id: string; change: 'added' | 'removed' | 'changed'; fields: string[] }
function compare(scope: string, before: Row[], after: Row[]): DeliveryChange[] {
  const index = (rows: Row[]) => {
    const map = new Map<string, Row>();
    for (const row of rows) {
      if (typeof row.id !== 'string' || map.has(row.id)) throw new Error('Duplicate or missing comparison ID');
      map.set(row.id, row);
    }
    return map;
  };
  const a = index(before), b = index(after);
  return [...new Set([...a.keys(), ...b.keys()])].sort().flatMap<DeliveryChange>(id => {
    const old = a.get(id), next = b.get(id);
    if (!old || !next) return [{ scope, id, change: old ? 'removed' as const : 'added' as const, fields: [] }];
    const fields = [...new Set([...Object.keys(old), ...Object.keys(next)])].sort().filter(k => canonical(old[k]) !== canonical(next[k]));
    return fields.length ? [{ scope, id, change: 'changed' as const, fields }] : [];
  });
}

function currentUnits(doc: ProjectDoc): Row[] {
  return doc.clipMentorAnalysis?.blueprint.map(unit => {
    const r = (unit as unknown as Row).internal_review;
    const internal = object(r) ? r : {};
    return { id: unit.unit_id, point_ids: unit.point_ids, intent_zh: unit.intent_zh, narration_budget_seconds: unit.narration_budget_seconds, line_guidance: unit.line_guidance,
      candidate_id: internal.current_script_candidate, picture_plan_id: internal.current_picture_plan,
      copy: typeof internal.current_script_candidate === 'string' ? internal[internal.current_script_candidate] : null,
      picture_plan: typeof internal.current_picture_plan === 'string' ? internal[internal.current_picture_plan] : null };
  }) ?? [];
}

function selectedPoints(doc: ProjectDoc): Row[] {
  const b = doc.clipMentorAnalysis?.source_breakdown;
  if (!b) return [];
  const coverage = new Map<string, Row[]>();
  for (const unit of b.units) for (const c of unit.coverage) {
    const entries = coverage.get(c.point_id) ?? [];
    entries.push({ unit_id: unit.unit_id, ...c }); coverage.set(c.point_id, entries);
  }
  return b.points.map(p => ({ ...p, id: p.point_id, coverage: coverage.get(p.point_id) ?? [] }));
}
function reviewedUnits(doc: ProjectDoc): Row[] {
  const receipt = doc.clipMentorAnalysis?.production_copy_review;
  const points = new Map(receipt?.teaching_review?.review.units.map(u => [u.unit_id, u]) ?? []);
  return receipt?.units.map(u => ({ id: u.unit_id,
    candidate_id: u.candidate_id, verdict: u.verdict, group_checks: u.group_checks,
    narration_checks: u.narration_checks, findings: u.findings, point_review: points.get(u.unit_id) })) ?? [];
}

/** Compare explicit snapshots, never infer missing revisions or mutate an approval. */
export async function diffDeliveryCheck(before: ProjectDoc, after: ProjectDoc,
  persisted: { before: Pick<ProjectDoc, 'assets' | 'timelines'> & { activeTimelineId?: unknown }; after: Pick<ProjectDoc, 'assets' | 'timelines'> & { activeTimelineId?: unknown } } = { before, after }) {
  const a = before.clipMentorAnalysis, b = after.clipMentorAnalysis;
  const changes = [
    ...compare('source', a ? [{ id: 'source', ...a.source }] : [], b ? [{ id: 'source', ...b.source }] : []),
    ...compare('product', a ? [{ id: 'product', ...a.product }] : [], b ? [{ id: 'product', ...b.product }] : []),
    ...compare('analysis_point', a?.points.map(p => ({ id: p.point_id, ...p })) ?? [], b?.points.map(p => ({ id: p.point_id, ...p })) ?? []),
    ...compare('analysis_point_review', a?.reviews.map(r => ({ id: r.point_id, ...r })) ?? [], b?.reviews.map(r => ({ id: r.point_id, ...r })) ?? []),
    ...compare('transcript', a?.transcripts.map(t => ({ id: t.source_id, ...t })) ?? [], b?.transcripts.map(t => ({ id: t.source_id, ...t })) ?? []),
    ...compare('observation', a?.observations?.map(o => ({ id: o.observation_id, ...o })) ?? [], b?.observations?.map(o => ({ id: o.observation_id, ...o })) ?? []),
    ...compare('source_transcription', a?.source_transcription ? [{ id: 'transcription', ...a.source_transcription }] : [], b?.source_transcription ? [{ id: 'transcription', ...b.source_transcription }] : []),
    ...compare('evidence', a?.evidence.map(e => ({ id: e.evidence_id, ...e })) ?? [], b?.evidence.map(e => ({ id: e.evidence_id, ...e })) ?? []),
    ...compare('source_segment', a?.source_breakdown?.segments.map(s => ({ id: s.segment_id, ...s })) ?? [], b?.source_breakdown?.segments.map(s => ({ id: s.segment_id, ...s })) ?? []),
    ...compare('selected_point', selectedPoints(before), selectedPoints(after)),
    ...compare('current_unit', currentUnits(before), currentUnits(after)),
    ...compare('unit_plan', a?.source_breakdown?.units.map(u => ({ id: u.unit_id, ...u })) ?? [], b?.source_breakdown?.units.map(u => ({ id: u.unit_id, ...u })) ?? []),
    ...compare('review_receipt', a?.production_copy_review ? [{ id: 'receipt', ...a.production_copy_review }] : [], b?.production_copy_review ? [{ id: 'receipt', ...b.production_copy_review }] : []),
    ...compare('copy_review', reviewedUnits(before), reviewedUnits(after)),
    ...compare('asset', persisted.before.assets as unknown as Row[], persisted.after.assets as unknown as Row[]),
    ...compare('timeline', persisted.before.timelines as unknown as Row[], persisted.after.timelines as unknown as Row[]),
  ];
  const gate = async (doc: ProjectDoc) => {
    try { const result = await checkCopyProduction(doc, 'clipmentor'); return { code: result.code, allowed: result.allowed }; }
    catch { return { code: 'invalid_project_state', allowed: false }; }
  };
  const [from_gate, to_gate] = await Promise.all([gate(before), gate(after)]);
  const oldAssetIds = new Set(before.assets.map(asset => asset.id));
  return {
    from_revision: a?.revision ?? null, to_revision: b?.revision ?? null,
    baseline_changed: canonical(a?.source) !== canonical(b?.source),
    active_timeline_changed: canonical(persisted.before.activeTimelineId) !== canonical(persisted.after.activeTimelineId),
    review_binding_changed: canonical(a?.production_copy_review && { revision: a.production_copy_review.analysis_revision, digest: a.production_copy_review.content_digest })
      !== canonical(b?.production_copy_review && { revision: b.production_copy_review.analysis_revision, digest: b.production_copy_review.content_digest }),
    from_gate, to_gate, changes,
    added_audio_assets: after.assets.filter(asset => asset.kind === 'audio' && !oldAssetIds.has(asset.id)).length,
    scope: 'snapshot_difference_only' as const, complete_film_accepted: false as const,
  };
}
