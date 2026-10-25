import type { AgentContext } from '../agent/context';
import type { SourceVideoRequest, SourceVideoResult, SourceVideoReceipt } from '../../shared/clipmentor-source-video';
import { validateSourceVideoTask } from '../../shared/clipmentor-source-video';
import { copyReviewSubject, copyTeachingPacketFromDoc } from './production-gate';

/** Paid source observation only: no approval binding, project mutation or editing. */
export async function requestSourceVideo(args: Record<string, unknown>, ctx: AgentContext): Promise<unknown> {
  if (Object.keys(args).some(k => !['operationId','maxRequests','expectedRevision','observationTask'].includes(k))
    || typeof args.operationId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(args.operationId)
    || args.maxRequests !== 1) return {error:'Explicit one-request authorization and stable UUID v4 required'};
  const doc = ctx.getDoc(), a = doc.clipMentorAnalysis, author = ctx.getAgentRunId?.(), project = ctx.getProjectId?.();
  if (!a || a.revision !== args.expectedRevision || !author || !project) return {error:'Current revision and host context required'};
  const asset = doc.assets.find(x => x.id === a.source.asset_id);
  if (!asset || !a.source.sourceContentHash || asset.sourceContentHash !== a.source.sourceContentHash) return {error:'Hash-bound source required'};
  let sent = false;
  try {
    const subject = await copyReviewSubject(doc), packet = await copyTeachingPacketFromDoc(doc);
    if(args.observationTask!==undefined) validateSourceVideoTask(args.observationTask,a.source.duration_seconds,subject.units.map(u=>u.unit_id));
    const request:SourceVideoRequest = {operationId:args.operationId,maxRequests:1,projectId:project,authorRunId:author,
      source:{src:asset.src,hash:a.source.sourceContentHash,fps:a.source.fps,duration:a.source.duration_seconds},
      subject:{revision:subject.revision,digest:subject.digest,units:subject.units.map(({unit_id,candidate_id})=>({unit_id,candidate_id}))},packet,
      ...(args.observationTask===undefined?{}:{observationTask:args.observationTask})};
    if(ctx.getDoc()!==doc) return {error:'Project changed; no request sent',requestsSent:0};
    ctx.onToolProgress?.('3.8连续源片视听观察：一次预算，不重试，不改稿或制作');
    const timeout=AbortSignal.timeout(660000), outer=ctx.getAgentRunSignal?.();sent=true;
    const response=await (ctx.hostFetch ?? fetch)('/api/clipmentor/observe-video',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request),signal:outer?AbortSignal.any([outer,timeout]):timeout});
    if(!response.ok) {
      const failure = await response.json().catch(() => null) as {receipt?:SourceVideoReceipt} | null;
      const receipt = failure?.receipt;
      if(receipt?.operationId===args.operationId && receipt.subject?.digest===subject.digest && receipt.projectId===project
        && receipt.actual_handoff_verified===false && receipt.complete_film_accepted===false) {
        return {error:'Source observation failed; read the saved receipt, do not retry',receipt,requestsSent:receipt.requestsSent,requestsAttempted:receipt.requestsAttempted,local_http_status:response.status};
      }
      return {error:`Source observation failed or unknown (local HTTP ${response.status}); retain operationId, no retry or new operation`};
    }
    const r=await response.json() as SourceVideoResult;
    if(r.operationId!==args.operationId || r.subject?.digest!==subject.digest || r.subject.revision!==a.revision || r.source_hash!==a.source.sourceContentHash
      || JSON.stringify(r.observation_task)!==JSON.stringify(request.observationTask)
      || r.scope!=='source_windows_and_planned_capacity_only' || r.actual_handoff_verified!==false || r.complete_film_accepted!==false) return {error:'Invalid source receipt; do not treat as approval'};
    return {ok:true,...r,current_binding:ctx.getDoc()===doc?'current':'stale',requestsSent:r.cached?0:1,
      note:'Source observation only. Actual original-to-narration handoff, narration sync, captions and complete film remain unverified. No project change.'};
  } catch { return {error:'Source observation unavailable or unknown; keep operationId, no retry',...(sent?{}:{requestsSent:0})}; }
}

/** Read an existing result or its explicit offline revalidation; never send a model request or change the project. */
export async function readSourceVideo(args: Record<string, unknown>, ctx: AgentContext): Promise<unknown> {
  if (Object.keys(args).some(k => k !== 'operationId') || typeof args.operationId !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(args.operationId)) return {error:'Stable operation UUID required'};
  const doc=ctx.getDoc(), projectId=ctx.getProjectId?.();
  if(!projectId) return {error:'Host project required'};
  try {
    const response=await (ctx.hostFetch ?? fetch)('/api/clipmentor/observe-video',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'read_receipt',operationId:args.operationId,projectId})});
    if(!response.ok) return {error:'Saved source receipt unavailable or not bound to this project; no model request sent',requestsSent:0};
    const receipt=await response.json() as SourceVideoReceipt;
    if(receipt.operationId!==args.operationId || receipt.projectId!==projectId || receipt.requestsSent!==0
      || receipt.actual_handoff_verified!==false || receipt.complete_film_accepted!==false) return {error:'Invalid saved source receipt',requestsSent:0};
    const subject=await copyReviewSubject(doc);
    const a=doc.clipMentorAnalysis,asset=doc.assets.find(x=>x.id===a?.source.asset_id);
    return {ok:true,receipt,current_binding:ctx.getDoc()===doc && subject.digest===receipt.subject.digest && subject.revision===receipt.subject.revision
      && a?.source.sourceContentHash===receipt.source_hash && asset?.sourceContentHash===receipt.source_hash ? 'current':'stale',requestsSent:0,
      note:'Receipt read only. Validation means structure/time tolerance, not semantic or production approval. Original failure and raw timestamps are retained.'};
  } catch { return {error:'Cannot read/bind saved source receipt; no model request sent',requestsSent:0}; }
}
