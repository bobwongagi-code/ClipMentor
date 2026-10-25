import type { AgentContext } from '../agent/context';
import type { CopyReviewRequest, CopyReviewResult } from '../../shared/clipmentor-copy-review';
import { isCopyReviewFailure } from '../../shared/clipmentor-copy-review';
import { bindCopyProductionReview, checkCopyProduction, copyReviewSubject, copyTeachingPacketFromDoc, isCopyProductionReview } from './production-gate';

/** Always an isolated current-subject review, even when its author worked collaboratively.
 * Only the independent host result is written. The author cannot inject history, modes or approvals. */
export async function requestClipMentorCopyReview(args: Record<string, unknown>, ctx: AgentContext): Promise<unknown> {
  if (Object.keys(args).some((k) => !['operationId', 'maxRequests', 'expectedRevision'].includes(k))
    || typeof args.operationId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(args.operationId)
    || args.maxRequests !== 1) return { error: 'A stable UUID v4 and explicitly authorized maxRequests=1 are required; no verdict input is accepted' };
  const doc = ctx.getDoc();
  const analysis = doc.clipMentorAnalysis;
  const author = ctx.getAgentRunId?.(), project = ctx.getProjectId?.();
  if (!analysis || analysis.revision !== args.expectedRevision || !author || !project) return { error: 'Current revision and host project/run context required' };
  const asset = doc.assets.find((a) => a.id === analysis.source.asset_id);
  if (!asset || !analysis.source.sourceContentHash || asset.sourceContentHash !== analysis.source.sourceContentHash) return { error: 'Hash-bound original source required' };
  let requestSent = false;
  try {
    const subject = await copyReviewSubject(doc);
    const packet = await copyTeachingPacketFromDoc(doc);
    if (packet.units.some((u) => !u.picture_plan?.execution_plan)) return { error: 'Save a current picture plan for each selected copy unit before requesting review' };
    const input: CopyReviewRequest = { operationId: args.operationId, maxRequests: 1, projectId: project, authorRunId: author,
      source: { src: asset.src, hash: analysis.source.sourceContentHash, fps: analysis.source.fps, duration: analysis.source.duration_seconds },
      subject: { revision: subject.revision, digest: subject.digest, units: subject.units.map(({ unit_id, candidate_id }) => ({ unit_id, candidate_id })) }, packet };
    if (ctx.getDoc() !== doc) return { error: 'Project changed before review; no request sent' };
    ctx.onToolProgress?.('独立审核当前文案与画面计划；未进行配音或剪辑');
    const timeout = AbortSignal.timeout(660_000), cancellation = ctx.getAgentRunSignal?.();
    requestSent = true;
    const response = await (ctx.hostFetch ?? fetch)('/api/clipmentor/review-copy', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input), signal: cancellation ? AbortSignal.any([timeout, cancellation]) : timeout });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      const diagnostic = body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>).diagnostic : undefined;
      const valid = isCopyReviewFailure(diagnostic) && diagnostic.operationId === args.operationId;
      return { error: `Independent review unavailable (HTTP ${response.status}${valid ? `; ${diagnostic.stage}/${diagnostic.code}` : ''}); keep operationId, do not automatically retry`,
        operationId: args.operationId, ...(valid ? { diagnostic, requestsAttempted: diagnostic.requestsAttempted } : {}),
        production_approved: false };
    }
    const result = await response.json() as CopyReviewResult;
    if (result.operationId !== args.operationId || !isCopyProductionReview(result.receipt)
      || result.receipt.author_run_id !== author || result.receipt.reviewer_run_id !== `clipmentor-review:${args.operationId}`) return { error: 'Invalid independent review response; no project write' };
    if (ctx.getDoc() !== doc) return { error: 'Project changed during review; result retained by operationId, no stale approval applied' };
    const receipt = await bindCopyProductionReview(doc, result.receipt);
    if (ctx.getDoc() !== doc) return { error: 'Project changed during binding; no stale approval applied' };
    const next = { ...doc, clipMentorAnalysis: { ...analysis, production_copy_review: receipt } };
    const gate = await checkCopyProduction(next, ctx.getCreativeMode());
    if (ctx.getDoc() !== doc) return { error: 'Project changed before saving review; no result applied' };
    ctx.commands.applyDoc(next);
    return { ok: true, operationId: result.operationId, requestsAttempted: result.requestsAttempted,
      cached: result.cached === true, requestsSent: result.cached ? 0 : result.requestsAttempted,
      revision: analysis.revision, verdict: receipt.verdict, units: receipt.units, production_gate: gate,
      teaching: receipt.teaching_review?.review,
      inspection: result.inspection, complete_film_accepted: false };
  } catch (error) {
    if (!requestSent) {
      const code = error instanceof Error && ['picture_plan_candidate_mismatch', 'copy_candidate_pointer_invalid', 'picture_plan_pointer_invalid', 'source_breakdown_not_ready', 'copy_candidate_missing', 'copy_candidate_incomplete', 'copy_unit_not_registered'].includes(error.message)
        ? error.message : 'current_review_material_not_ready';
      return { error: `Independent review preflight failed: ${code}. No model request sent.`, requestsSent: 0 };
    }
    return { error: 'Review could not be completed or bound. Keep operationId; do not automatically retry or create a new operation to bypass the budget' };
  }
}
