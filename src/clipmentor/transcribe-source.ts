import type { AgentContext } from '../agent/context';
import {canonicalProjectJson} from '../agent/external-edit-session';
import { isAnalysisActor, isClipMentorAnalysis, checkAnalysisHandoff, type ClipMentorAnalysis } from './analysis';
import { isSourceTranscription } from '../../shared/clipmentor-asr';

/** Asset-only ASR. No clip placement, caption edits, model-written claims or automatic approvals. */
export async function transcribeClipMentorAsset(args: Record<string, unknown>, ctx: AgentContext): Promise<unknown> {
  const liveDoc = ctx.getDoc(), projectId=ctx.getProjectId?.(), runId=ctx.getAgentRunId?.(), signal=ctx.getAgentRunSignal?.();
  if(signal?.aborted)return {error:'Source ASR cancelled before submission',requestsSent:0};
  const snapshot=canonicalProjectJson(liveDoc),doc=JSON.parse(snapshot) as typeof liveDoc;
  const current=(expected=snapshot)=>canonicalProjectJson(ctx.getDoc())===expected&&ctx.getProjectId?.()===projectId
    &&ctx.getAgentRunId?.()===runId&&ctx.getAgentRunSignal?.()===signal&&!signal?.aborted;
  if (doc.clipMentorAnalysis) return { error: 'Analysis already exists; source transcription initialization will not overwrite it' };
  if (args.expectedRevision !== 0 || !isAnalysisActor(args.actor) || typeof args.reason !== 'string' || !args.reason.trim()) return { error: 'Fresh analysis, declared actor and reason required' };
  const asset = doc.assets.find((a) => a.id === args.assetId);
  if (!asset || asset.kind !== 'video') return { error: 'Exact original video asset ID required' };
  let result: unknown;
  try {
    const response = await (ctx.hostFetch ?? fetch)('/api/clipmentor/transcribe-source', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ src: asset.src, expectedSourceHash: asset.sourceContentHash, sourceSize: asset.sourceSize,
        language: args.language ?? 'auto', operationId: args.operationId, maxRequests: args.maxRequests, projectId }),signal });
    if (!response.ok) return { error: `Source ASR request was not completed (HTTP ${response.status}); do not automatically retry. Keep the operationId to inspect/recover its result.` };
    result = await response.json();
  } catch {
    return { error: 'Source ASR outcome unknown; do not automatically retry. Keep the operationId; the server may already have reserved a paid request.' };
  }
  if (!isSourceTranscription(result) || result.operation_id !== args.operationId
    || (asset.sourceContentHash && result.source_hash !== asset.sourceContentHash)) return { error: 'Invalid or mismatched ASR result; no analysis written' };
  if (result.issues.includes('source_changed_during_transcription')) return { error: 'Source bytes changed during transcription; retained server result is stale and was not applied' };
  if (!current()) return { error: 'Project changed or run cancelled during ASR; result retained server-side under operationId, not applied. Do not start a new paid operation.' };
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
  if (!current()) return { error: 'Project changed or run cancelled during analysis write; no stale result applied' };
  const unconfirmed={error:'ASR received but project write could not be confirmed. Read the current project and saved receipt.',operationId:result.operation_id};
  const expected=canonicalProjectJson(next);
  try{ctx.commands.applyDoc(next);if(!current(expected))return unconfirmed;}
  catch{return unconfirmed;}
  return { ok: true, revision: 1, operationId: result.operation_id, status: result.status, requestsAttempted: result.requests_attempted,
    wordCount: result.words.length, chunks: result.chunks.length, conflicts: result.conflicts, issues: result.issues,
    handoff, listeningVerified: false, sellingPointsExtracted: false };
}
