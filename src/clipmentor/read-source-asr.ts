import type {AgentContext} from '../agent/context';
import {isSourceAsrRead} from '../../shared/clipmentor-asr';

/** Saved ASR inspection uses the explicit read action, never the submit fallback. */
export async function readClipMentorSourceAsr(args:Record<string,unknown>,ctx:AgentContext):Promise<unknown>{
 if(Object.keys(args).some(k=>!['view','operationId','assetId'].includes(k))||args.view!=='source_asr'
  ||typeof args.operationId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(args.operationId)
  ||typeof args.assetId!=='string'||!args.assetId)return {error:'Saved ASR read requires an exact asset and operation UUID',requestsSent:0};
 const doc=ctx.getDoc(),projectId=ctx.getProjectId?.(),asset=doc.assets.find(a=>a.id===args.assetId),source=doc.clipMentorAnalysis?.source;
 if(!projectId||!asset||asset.kind!=='video'||!asset.sourceContentHash||!/^[a-f0-9]{64}$/.test(asset.sourceContentHash)
  ||(source&&(source.asset_id!==asset.id||source.sourceContentHash!==asset.sourceContentHash)))
  return {error:'Current hash-bound original source and host project required',requestsSent:0};
 const binding=()=>JSON.stringify({project:ctx.getProjectId?.(),asset:ctx.getDoc().assets.find(a=>a.id===args.assetId),source:ctx.getDoc().clipMentorAnalysis?.source});
 const initial=binding();
 try{
  const deadline=AbortSignal.timeout(10_000),outer=ctx.getAgentRunSignal?.();
  outer?.throwIfAborted();
  const response=await(ctx.hostFetch??fetch)('/api/clipmentor/transcribe-source',{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({action:'read',operationId:args.operationId,projectId,src:asset.src,expectedSourceHash:asset.sourceContentHash}),
   signal:outer?AbortSignal.any([outer,deadline]):deadline});
  if(!response.ok)return {error:'Saved ASR unavailable; no provider request sent',requestsSent:0};
  const value:unknown=await response.json();
  outer?.throwIfAborted();
  if(!isSourceAsrRead(value)||value.operationId!==args.operationId||value.source_hash!==asset.sourceContentHash)
   return {error:'Invalid saved ASR response; no provider request sent',requestsSent:0};
  if(ctx.getDoc()!==doc||binding()!==initial)return {error:'Project/source changed during saved ASR read; result not current',requestsSent:0};
  return {ok:true,...value,note:'Saved machine transcript only; no project import, listening verification or production approval.'};
 }catch{return {error:'Saved ASR read unavailable; retain operation ID, no submission or retry was made',requestsSent:0};}
}
