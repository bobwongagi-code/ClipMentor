/** Historical JSON adapter, not a Flayr runner or a new analysis inference pass. */
import type { AnalysisActor, AnalysisEvidence, ClipMentorAnalysis } from './analysis.js';
import { isClipMentorAnalysis } from './analysis.js';

type Row = Record<string, unknown>;
function object(v: unknown): Row {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Expected historical JSON object');
  return v as Row;
}
function list(v: unknown): Row[] {
  if (!Array.isArray(v)) throw new Error('Expected historical JSON array');
  return v.map(object);
}
function text(v: unknown): string {
  if (typeof v !== 'string') throw new Error('Expected historical text');
  return v;
}
function ids(v: unknown): string[] {
  if (!Array.isArray(v)) throw new Error('Expected historical ID list');
  return v.map(text);
}

export function importTeashellAnalysis(
  input: unknown, assetId: string, actor: AnalysisActor, now = Date.now(),
): ClipMentorAnalysis {
  const pack = object(input);
  const inventory = object(pack.inventory);
  const source = object(inventory.source);
  const manifest = object(pack.frame_manifest);
  const copy = object(pack.copy_input);
  const product = object(copy.product);
  if (source.source_sha256 !== manifest.source_sha256) throw new Error('Historical source hashes disagree');
  const claims: AnalysisEvidence[] = list(inventory.claim_and_operator_evidence).map((e) => ({
    evidence_id: text(e.evidence_id), kind: text(e.kind) as AnalysisEvidence['kind'],
    text: text(e.text), status: text(e.status), source_ids: e.source_ids ? ids(e.source_ids) : [],
    supporting_evidence_ids: [],
    provenance: typeof e.source === 'string' ? e.source : 'historical_machine_transcript',
    ...(e.source_range_seconds ? { source_range_seconds: e.source_range_seconds as [number, number] } : {}),
  }));
  const frames: AnalysisEvidence[] = list(manifest.frames).map((f) => ({
    evidence_id: text(f.evidence_id), kind: 'source_frame', text: '历史原片采样帧',
    status: 'historical_import', source_ids: [], supporting_evidence_ids: [],
    time_seconds: Number(f.time_seconds), source_frame: Number(f.source_frame),
    observation_method: 'historical_import_sampled_source_frames', call_status: 'historical_unknown',
  }));
  const points = list(inventory.points);
  const evidence = [...frames, ...claims];
  for (const p of points) {
    const visible = object(p.visible_action);
    const interpretation = object(p.analyst_interpretation);
    evidence.push({
      evidence_id: `${text(p.point_id)}:visible`, kind: 'visible_action', text: text(visible.text),
      status: text(p.review_status), source_ids: [], supporting_evidence_ids: ids(visible.evidence_ids),
      source_range_seconds: p.source_range_seconds as [number, number],
      observation_method: `historical_import:${text(visible.observation_method)}`, call_status: 'historical_unknown',
    }, {
      evidence_id: `${text(p.point_id)}:interpretation`, kind: 'expression_analysis_not_verified_causal_effect',
      text: text(interpretation.text), status: text(p.review_status), source_ids: [],
      supporting_evidence_ids: ids(interpretation.supporting_evidence_ids),
      source_range_seconds: p.source_range_seconds as [number, number],
    });
  }
  const transcripts = list(pack.transcripts).map((entry) => {
    const words = object(entry.data);
    const sourceId = text(entry.source_id);
    const meta = list(inventory.transcript_sources).find((s) => s.source_id === sourceId);
    if (!meta) throw new Error('Historical transcript source not registered');
    const offset = Number(meta.source_offset_seconds ?? 0);
    return {
      source_id: sourceId, provider: text(words.provider), origin: 'historical_import:VidLingo+Flayr.run_online_asr',
      status: 'machine_transcript_candidate_not_listening_verified',
      words: list(words.words).map((w) => ({ text: text(w.text), start_seconds: Number(w.start_seconds) + offset, end_seconds: Number(w.end_seconds) + offset })),
    };
  });
  const fpsParts = text(source.fps).split('/').map(Number);
  const analysis: ClipMentorAnalysis = {
    schema_version: 1, analysis_id: 'teashell-comparison-and-closing-20261016', revision: 1,
    source: { asset_id: assetId, sourceContentHash: text(source.source_sha256),
      duration_seconds: Number(source.duration_seconds), fps: fpsParts[0] / (fpsParts[1] ?? 1) },
    product: { name: text(product.name), category: text(product.category) },
    import_origin: `historical_import:Teashell:${text(inventory.version)};${text(copy.version)};${text(inventory.status)}`,
    evidence,
    points: points.map((p) => ({
      point_id: text(p.point_id), unit_id: text(p.unit_id), source_range_seconds: p.source_range_seconds as [number, number],
      buying_reason_or_function: text(p.buying_reason_or_function),
      filming_conditions: [text(object(p.visible_action).text)],
      evidence_ids: [...ids(p.original_claim_or_operator_evidence_ids), `${text(p.point_id)}:visible`, `${text(p.point_id)}:interpretation`],
      uncertainties: ids(copy.unresolved), required: true, explanation_priority: text(p.explanation_priority),
      status: 'historical_import', review_status: text(p.review_status), provenance: text(p.provenance),
    })),
    blueprint: list(copy.units).map((u) => ({
      unit_id: text(u.unit_id), point_ids: ids(u.point_ids), intent_zh: text(u.intent_zh),
      line_guidance: text(u.line_guidance), narration_budget_seconds: u.narration_budget_seconds as [number, number],
    })),
    transcripts, reviews: [],
    audit: [{ revision: 1, action: 'historical_import', target_id: 'analysis', actor, at: now,
      reason: '导入比较与普通收尾的开发数据；不代表新视觉调用、听审或当前人工确认。' }],
  };
  if (!isClipMentorAnalysis(analysis)) throw new Error('Historical analysis does not satisfy schema v1');
  return structuredClone(analysis);
}
