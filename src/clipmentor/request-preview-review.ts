import type { AgentContext } from '../agent/context';
import {canonicalProjectJson} from '../agent/external-edit-session';
import {sha256Text} from '../persist/agentRuntimeStore';

/** Agent initiates the paid review; the server keeps credentials and immutable receipts. */
export async function requestPreviewReview(args: Record<string, unknown>, ctx: AgentContext) {
  const projectId = ctx.getProjectId?.(), runId = ctx.getAgentRunId?.();
  if (!projectId || !runId || typeof args.action !== 'string' || !['request','read'].includes(args.action)
    || typeof args.operationId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(args.operationId)
    || (args.action==='request' && args.maxRequests!==1)
    || (args.includeVisualEvidence!==undefined&&(args.action!=='read'||typeof args.includeVisualEvidence!=='boolean'))
    || Object.keys(args).some(k=>!['action','operationId','maxRequests','src','videoSha256','input','executionManifest','includeVisualEvidence'].includes(k))) return {error:'Host context, stable operation and one-request budget required'};
  try {
    const timeout = AbortSignal.timeout(680_000), outer = ctx.getAgentRunSignal?.();
    const snapshot=canonicalProjectJson(ctx.getDoc()),signal=outer?AbortSignal.any([outer,timeout]):timeout;
    const current=()=>!signal.aborted&&ctx.getAgentRunSignal?.()===outer&&ctx.getProjectId?.()===projectId
      &&ctx.getAgentRunId?.()===runId&&canonicalProjectJson(ctx.getDoc())===snapshot;
    const stale=()=>({error:'Preview context changed or cancelled; retain saved operationId, read in the correct context; no retry',operationId:args.operationId,can_use_as_pass:false});
    if(!current())return{...stale(),requestsSent:0};
    const response = await (ctx.hostFetch ?? fetch)('/api/clipmentor/review-preview', { method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...args,projectId}),signal });
    if (!response.ok) return {error:`Continuous preview review unavailable (HTTP ${response.status}); retain operationId; no retry`};
    const receipt = await response.json();
    // Drain the saved receipt after keepalive headers before rejecting a changed context.
    if(!current())return stale();
    if (receipt.operationId!==args.operationId || receipt.projectId!==projectId || receipt.full_film_accepted!==false
      || receipt.scope!=='rendered_preview_continuous_review'
      || (args.action==='request' && receipt.videoSha256!==args.videoSha256)) return {error:'Invalid preview binding; no retry'};
    const gate=receipt.effective_review;
    const recheck=gate?.contract_revalidation;
    const revalidatedBoundary=receipt.result?.status==='review_required'&&['observation-centisecond-eof-v1','film-origin-continuity-v1'].includes(recheck?.method)
      &&recheck.original_status===receipt.result.status&&JSON.stringify(recheck.original_issues)===JSON.stringify(receipt.result.issues)
      &&typeof receipt.result.raw_public_judgment==='string'
      &&recheck.raw_judgment_sha256===await sha256Text(receipt.result.raw_public_judgment);

    if(!current())return stale();
    if (!gate || !['pass','review_required'].includes(gate.status) || !Array.isArray(gate.blockers)
      || typeof gate.can_use_as_pass!=='boolean' || gate.can_use_as_pass!==(gate.status==='pass') || gate.full_film_accepted!==false
      || (gate.can_use_as_pass && (receipt.status!=='completed' || (receipt.result?.status!=='pass'&&!revalidatedBoundary)
        || gate.blockers.length!==0 || gate.manifest_binding!=='frozen_at_request' || receipt.timeline_check?.status!=='no_detected_conflict'))) {
      return {error:'Preview evidence gate missing or inconsistent; review required, no retry',can_use_as_pass:false};
    }
    return {...receipt,ok:receipt.status==='completed',note:'ok/completed means receipt retrieval only. Use effective_review.status and can_use_as_pass; raw supported/pass cannot waive timeline conflicts or missing evidence. Preserve original judgment. No rewrite, project change or complete-film approval.'};
  } catch { return {error:'Continuous review failed or outcome unknown; retain operationId, no retry',operationId:args.operationId,can_use_as_pass:false}; }
}
