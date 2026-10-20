import type { AgentContext } from '../agent/context';
import { isAnalysisActor, isClipMentorAnalysis, checkAnalysisHandoff, type ClipMentorAnalysis } from './analysis';
import { isSourceTranscription } from '../../shared/clipmentor-asr';

/** Asset-only ASR. No clip placement, caption edits, model-written claims or automatic approvals. */
export async function transcribeClipMentorAsset(args: Record<string, unknown>, ctx: AgentContext): Promise<unknown> {
  const doc = ctx.getDoc();
  if (doc.clipMentorAnalysis) return { error: 'Analysis already exists; source transcription initialization will not overwrite it' };
  if (args.expectedRevision !== 0 || !isAnalysisActor(args.actor) || typeof args.reason !== 'string' || !args.reason.trim()) return { error: 'Fresh analysis, declared actor and reason required' };
  const asset = doc.assets.find((a) => a.id === args.assetId);
  if (!asset || asset.kind !== 'video') return { error: 'Exact original video asset ID required' };
  let result: unknown;
  try {
    const response = await fetch('/api/clipmentor/transcribe-source', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ src: asset.src, expectedSourceHash: asset.sourceContentHash, sourceSize: asset.sourceSize,
        language: args.language ?? 'auto', operationId: args.operationId, maxRequests: args.maxRequests }) });
    if (!response.ok) return { error: `Source ASR request was not completed (HTTP ${response.status}); do not automatically retry. Keep the operationId to inspect/recover its result.` };
    result = await response.json();
  } catch {
    return { error: 'Source ASR outcome unknown; do not automatically retry. Keep the operationId; the server may already have reserved a paid request.' };
  }
  if (!isSourceTranscription(result) || result.operation_id !== args.operationId
    || (asset.sourceContentHash && result.source_hash !== asset.sourceContentHash)) return { error: 'Invalid or mismatched ASR result; no analysis written' };
  if (result.issues.includes('source_changed_during_transcription')) return { error: 'Source bytes changed during transcription; retained server result is stale and was not applied' };
  if (ctx.getDoc() !== doc) return { error: 'Project changed during ASR; result retained server-side under operationId, not applied. Do not start a new paid operation.' };
  const now = Date.now();
  const analysis: ClipMentorAnalysis = {
    schema_version: 1, analysis_id: `source-asr:${result.operation_id}`, revision: 1,
    source: { asset_id: asset.id, sourceContentHash: result.source_hash, duration_seconds: result.duration_seconds, fps: result.fps },
    product: { name: '待分析（未提取产品信息）', category: '' }, import_origin: 'clipmentor_original_source_asr',
    source_transcription: result,
    evidence: [], points: [], blueprint: [], reviews: [],
    transcripts: [{ source_id: `asr:${result.operation_id}`, provider: `${result.provider}:${result.model}`,
      origin: 'clipmentor_server_original_source', status: 'machine_transcript_candidate_not_listening_verified', words: result.words }],
    audit: [{ revision: 1, action: 'source_transcription', target_id: asset.id, actor: args.actor, at: now, reason: args.reason }],
  };
  if (!isClipMentorAnalysis(analysis)) return { error: 'ASR analysis schema rejected; no project write' };
  const next = { ...doc, assets: doc.assets.map((a) => a.id === asset.id ? { ...a, sourceContentHash: result.source_hash } : a), clipMentorAnalysis: analysis };
  const handoff = await checkAnalysisHandoff(next);
  if (ctx.getDoc() !== doc) return { error: 'Project changed during analysis write; no stale result applied' };
  ctx.commands.applyDoc(next);
  return { ok: true, revision: 1, operationId: result.operation_id, status: result.status, requestsAttempted: result.requests_attempted,
    wordCount: result.words.length, chunks: result.chunks.length, conflicts: result.conflicts, issues: result.issues,
    handoff, listeningVerified: false, sellingPointsExtracted: false };
}
