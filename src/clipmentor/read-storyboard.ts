import type {AgentContext} from '../agent/context';
import type {ClipMentorStoryboard,StoryboardImages} from '../../shared/clipmentor-storyboard';
import {canonicalProjectJson,revisionOf} from '../agent/external-edit-session';

export async function readClipMentorStoryboard(args:Record<string,unknown>,ctx:AgentContext){
 const projectId=ctx.getProjectId?.(),doc=ctx.getDoc(),part=args.boardPart??'summary';
 if(!projectId||!['summary','source','actual'].includes(String(part)))return{error:'storyboard_project_or_part_missing'};
 if(part!=='summary'&&(typeof args.unitId!=='string'||typeof args.boardDigest!=='string'||!/^[a-f0-9]{64}$/.test(args.boardDigest)))return{error:'storyboard_card_and_digest_required'};
 if(args.boardOffset!==undefined&&(!Number.isSafeInteger(args.boardOffset)||Number(args.boardOffset)<0))return{error:'storyboard_offset_invalid'};
 const revision=revisionOf(doc),snapshot=canonicalProjectJson(doc),runId=ctx.getAgentRunId?.(),signal=ctx.getAgentRunSignal?.();
 const current=()=>!signal?.aborted&&ctx.getAgentRunSignal?.()===signal&&ctx.getProjectId?.()===projectId
  &&ctx.getAgentRunId?.()===runId&&canonicalProjectJson(ctx.getDoc())===snapshot;
 const stale=()=>({error:'storyboard_context_changed_or_cancelled',review_approved:false,production_approved:false});
 if(!current())return stale();
 const params=new URLSearchParams({view:'storyboard',projectId,part:String(part),expectedProjectRevision:revision});
 if(args.boardDigest!==undefined)params.set('expectedDigest',String(args.boardDigest));
 if(part!=='summary'){params.set('cardId',String(args.unitId));params.set('offset',String(args.boardOffset??0));}
 try{
  const res=await(ctx.hostFetch??fetch)('/api/clipmentor/production-task?'+params,{method:'GET',signal}),data=await res.json();
  if(!res.ok)return{error:data.error??'storyboard_read_failed',production_approved:false};
  if(!current())return stale();
  if(part==='summary'){
   const board=data as ClipMentorStoryboard&{board_url:string};
   if(board.project_id!==projectId||board.project_revision!==revision)return{error:'storyboard_snapshot_changed'};
   const cards=args.unitId===undefined?board.cards.map(c=>({id:c.id,subject_id:c.subject_id,kind:c.kind,title:c.title,line_ids:c.lines.map(l=>l.id),source_samples:c.source.length,actual_samples:c.actual.length,actual_status:c.actual_status})):board.cards.filter(c=>c.id===args.unitId);
   if(!cards.length)return{error:'storyboard_card_missing'};
   const result={storyboard:{...board,cards},host_save:'saved_snapshot_only_not_a_new_save_tool',review_approved:false};
   if(JSON.stringify(result).length>14_000)return{error:'storyboard_read_too_large_use_unitId',digest:board.digest,board_url:board.board_url};return result;
  }
  const page=data as StoryboardImages;
  if(page.digest!==args.boardDigest||page.card_id!==args.unitId||page.part!==part||page.offset!==Number(args.boardOffset??0)||!Array.isArray(page.images))return{error:'storyboard_page_mismatch'};
  const available=page.images.filter((i):i is Extract<StoryboardImages['images'][number],{status:'available'}>=>i.status==='available');
  if(available.length>6||available.reduce((n,i)=>n+i.base64.length,0)>3_500_000)return{error:'storyboard_image_payload_too_large',digest:page.digest};
  return{...page,images:page.images.map(i=>{if(i.status!=='available')return i;const{base64:_,...info}=i;return info;}),
   // Source seconds are already a canonical frame start from the server;
   // round its integer tag instead of flooring a floating-point round-trip.
   __images:available.map(i=>({frame:i.frame??Math.round((i.source_seconds??0)*(doc.clipMentorAnalysis?.source.fps??1)),base64:i.base64})),review_approved:false};
 }catch{return{error:'storyboard_read_unavailable',review_approved:false,production_approved:false};}
}
