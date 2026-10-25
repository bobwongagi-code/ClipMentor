import type { AgentContext } from '../agent/context';
import type { MediaAsset, ProjectDoc, Timeline } from '../editor/types';
import { sourceRevisionOf } from '../editor/mediaSourceRevision';

export const PREVIEW_EDIT_SCOPE = 'authorized_local_preview_revision';
export interface NativeComparisonEdit {
  timelineId: string;
  range: [number, number];
  videoId: string;
  stillId: string;
  removeIds: string[];
  replaceAnnotationId?: string;
  sourceStartFrame: number;
  videoFrames: number;
  annotation: MediaAsset;
}
export interface PreviewEditPlan {
  operationId: string;
  projectId: string;
  baseline: MediaAsset;
  patches: Array<{ asset: MediaAsset; startFrame: number; endFrame: number; name: string }>;
  fps: number;
  totalFrames: number;
  baseSegments?: Array<{ startFrame: number; durationInFrames: number; srcInFrame: number }>;
  audio?: MediaAsset;
  native?: NativeComparisonEdit;
}
export async function previewDocDigest(doc: ProjectDoc): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(doc)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
/** Keep the rendered baseline and its exact mixed soundtrack; local overlays remain editable. */
export function buildPreviewRevision(doc: ProjectDoc, plan: PreviewEditPlan): ProjectDoc {
  const id = `preview_${plan.operationId}`;
  if (doc.timelines.some(t => t.id === id)) throw new Error('Preview revision already exists');
  if (plan.native) return buildNativeComparisonRevision(doc, plan, id);
  const timeline: Timeline = {
    id, name: plan.audio ? 'Teashell两段 · 近鼻讲解精简（待审）' : '88秒基线 · 已授权局部修订（待审）', order: Math.max(-1, ...doc.timelines.map(t => t.order)) + 1,
    fps: plan.fps, width: plan.baseline.width!, height: plan.baseline.height!, fit: 'contain',
    selectedId: null, selectedIds: [], transitions: [], captions: null,
    trackOrder: plan.audio ? ['preview_patches','preview_baseline','preview_audio'] : ['preview_labels', 'preview_patches', 'preview_baseline'],
    tracks: { preview_labels: {kind:'video', name:'回看讲解短标'}, preview_patches: {kind:'video', name:'已批准局部画面'},
      preview_baseline: {kind:'video', name:'锁定预览基线'},
      ...(plan.audio ? {preview_audio:{kind:'audio' as const,name:'复用原混音，仅删除获准动作复述'}} : {}) },
    items: [
      ...(plan.baseSegments ?? [{startFrame:0,durationInFrames:plan.totalFrames,srcInFrame:0}]).map((part,i)=>({
        id:plan.baseSegments?`${id}_base_${i}`:`${id}_base`,name:'锁定预览基线（保留现有字幕）',track:'preview_baseline',kind:'video' as const,
        ...part,src:plan.baseline.src,sourceAssetId:plan.baseline.id,
        width:plan.baseline.width,height:plan.baseline.height,volume:plan.audio?0:1,playbackRate:1})),
      ...plan.patches.map((p,i) => ({id:`${id}_${i}`,name:p.name,track:!plan.audio&&i===2?'preview_labels':'preview_patches',
        kind:p.asset.kind==='video'?'video' as const:'image' as const,
        startFrame:p.startFrame,durationInFrames:p.endFrame-p.startFrame,src:p.asset.src,sourceAssetId:p.asset.id,
        width:p.asset.width,height:p.asset.height,...(p.asset.kind==='video'?{srcInFrame:0,volume:0,playbackRate:1}:{})})),
      ...(plan.audio?[{id:`${id}_audio`,name:plan.audio.name,track:'preview_audio',kind:'audio' as const,
        startFrame:0,durationInFrames:plan.totalFrames,srcInFrame:0,src:plan.audio.src,sourceAssetId:plan.audio.id,volume:1,playbackRate:1}]:[]),
    ],
    markers: [{id:`${id}_pending`,scope:'project',fromFrame:0,durationFrames:0,color:'yellow',
      note:`${PREVIEW_EDIT_SCOPE} ${plan.operationId}；只允许既定局部修订；旧审核原判保留；待审预览，不是完整成片验收。基线字幕为已渲染内容，并非原始分层工程；音频仅按本次授权精简，不代表新增配音。`}],
  };
  return {...doc, assets:[...doc.assets, plan.baseline, ...plan.patches.map(p=>p.asset), ...(plan.audio?[plan.audio]:[])],
    timelines:[...doc.timelines,timeline],activeTimelineId:id};
}

/** Exact host-bound native picture delta. Text, audio, analysis and the original timeline survive unchanged. */
function buildNativeComparisonRevision(doc:ProjectDoc,plan:PreviewEditPlan,id:string):ProjectDoc {
  const n=plan.native!,t=doc.timelines.find(t=>t.id===n.timelineId),[a,b]=n.range;
  const invalid=()=>{throw new Error('Invalid native comparison scope');};
  if(!t||doc.activeTimelineId!==t.id||t.fps!==plan.fps||!Number.isInteger(a)||!Number.isInteger(b)||a<0||b<=a
    ||b>plan.totalFrames||Math.max(...t.items.map(i=>i.startFrame+i.durationInFrames))!==plan.totalFrames
    ||!Number.isInteger(n.videoFrames)||n.videoFrames<=0||n.videoFrames>=b-a||!Number.isInteger(n.sourceStartFrame)||n.sourceStartFrame<0) return invalid();
  const ids=[n.videoId,n.stillId,...n.removeIds];
  const video=t.items.find(i=>i.id===n.videoId),still=t.items.find(i=>i.id===n.stillId);
  if(new Set(ids).size!==ids.length||!video||video.kind!=='video'||video.volume!==0||!still||still.kind!=='image'||video.track!==still.track) return invalid();
  const selected=t.items.filter(i=>ids.includes(i.id)).sort((x,y)=>x.startFrame-y.startFrame);
  let edge=a;
  for(const item of selected) {
    if(!['video','image'].includes(item.kind)||item.track!==video.track||item.startFrame!==edge) return invalid();
    edge=item.startFrame+item.durationInFrames;
  }
  if(selected.length!==ids.length||edge!==b||t.items.some(i=>i.track===video.track&&!ids.includes(i.id)&&i.startFrame<b&&i.startFrame+i.durationInFrames>a)
    ||n.annotation.kind!=='image'||n.annotation.width!==t.width||n.annotation.height!==t.height
    ||doc.assets.some(x=>x.id===n.annotation.id)) return invalid();
  const track=`${id}_emphasis`;
  const previousAnnotation=n.replaceAnnotationId?t.items.find(i=>i.id===n.replaceAnnotationId):undefined;
  if(n.replaceAnnotationId&&(!previousAnnotation||previousAnnotation.kind!=='image'||previousAnnotation.name!=='比较区域框与箭头'
    ||!previousAnnotation.track.endsWith('_emphasis')||previousAnnotation.startFrame!==a+n.videoFrames
    ||previousAnnotation.durationInFrames!==b-a-n.videoFrames||ids.includes(previousAnnotation.id))) return invalid();
  const annotation={...n.annotation,sourceRevision:sourceRevisionOf(n.annotation)};
  const items=t.items.filter(i=>!n.removeIds.includes(i.id)&&i.id!==n.replaceAnnotationId).map(i=>i.id===n.videoId?{...i,startFrame:a,durationInFrames:n.videoFrames,srcInFrame:n.sourceStartFrame}:
    i.id===n.stillId?{...i,startFrame:a+n.videoFrames,durationInFrames:b-a-n.videoFrames}:i);
  items.push({id:`${id}_annotation`,name:'比较区域框与箭头',track,kind:'image',startFrame:a+n.videoFrames,
    durationInFrames:b-a-n.videoFrames,src:annotation.src,sourceAssetId:annotation.id,width:t.width,height:t.height,sourceRevision:annotation.sourceRevision});
  const timeline:Timeline={...t,id,name:'Teashell · 比较对象与框箭头修正（待审）',order:Math.max(...doc.timelines.map(t=>t.order))+1,
    selectedId:null,selectedIds:[],items,trackOrder:[track,...(t.trackOrder??Object.keys(t.tracks??{}))],tracks:{...t.tracks,[track]:{kind:'video',name:'比较区域重点强调'}},
    markers:[...(t.markers??[]),{id:`${id}_pending`,scope:'project',fromFrame:a,durationFrames:b-a,color:'yellow',
      note:`${PREVIEW_EDIT_SCOPE} ${plan.operationId}；仅比较画面与框箭头；文字/音频/其他段落不变，旧审核不恢复，待用户看片。`}]};
  return {...doc,assets:[...doc.assets,annotation],timelines:[...doc.timelines,timeline],activeTimelineId:id};
}

export async function previewEditRequest(action: string, args: Record<string,unknown>, ctx: AgentContext) {
  const response = await fetch('/api/clipmentor/preview-edit', {method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({action,projectId:ctx.getProjectId?.(),operationId:args.operationId,tailFrame:args.tailFrame,doc:ctx.getDoc()}),
    signal:ctx.getAgentRunSignal?.()});
  const result = await response.json();
  if (!response.ok || result.scope!==PREVIEW_EDIT_SCOPE || result.full_film_accepted!==false || result.allowed!==true
    || result.operationId!==args.operationId || result.projectId!==ctx.getProjectId?.()) {
    throw new Error(result.error || 'No matching host-authorized preview revision; production gate remains closed');
  }
  return result;
}
export async function previewEditGate(args: Record<string,unknown>, ctx: AgentContext) {
  try { await previewEditRequest(`check_${String(args.action)}`,args,ctx); return null; }
  catch {return {error:'局部预览门禁拒绝：缺少匹配的服务端授权，或工程／素材／范围已变化。旧质检状态不变。',
    production_gate:{allowed:false,code:'preview_revision_not_authorized',scope:PREVIEW_EDIT_SCOPE,complete_film_accepted:false}};}
}
export async function editClipMentorPreview(args: Record<string,unknown>, ctx: AgentContext) {
  try {
    if (args.action==='read') return await previewEditRequest('read',args,ctx);
    const before=ctx.getDoc();
    if(args.action==='apply') {
      const receipt=await previewEditRequest('prepare',args,ctx);
      if(ctx.getDoc()!==before || await previewDocDigest(before)!==receipt.baseProjectSha256) throw new Error('Project changed during preparation');
      const next=buildPreviewRevision(before,receipt.plan);
      if(await previewDocDigest(next)!==receipt.preparedProjectSha256) throw new Error('Prepared preview binding mismatch');
      ctx.commands.applyDoc(next);
      return {ok:true,scope:PREVIEW_EDIT_SCOPE,operationId:args.operationId,timelineId:next.activeTimelineId,
        totalFrames:receipt.plan.totalFrames,full_film_accepted:false,quality_status:'review_required',
        note:'Applied exactly the host-authorized local revision; no independent approval granted. Existing text/audio reused except the explicitly authorized removal.'};
    }
    if(args.action==='render') {
      await previewEditRequest('reserve_render',args,ctx);
      if(ctx.getDoc()!==before) throw new Error('Project changed before export; attempt consumed');
      const {execExportTool}=await import('../agent/tools/export-tools');
      if(ctx.getDoc()!==before) throw new Error('Project changed before export; attempt consumed');
      const snapshotContext: AgentContext = {...ctx,getDoc:()=>before,
        getState:()=>before.timelines.find(t=>t.id===before.activeTimelineId)!};
      const native=before.timelines.find(t=>t.id===before.activeTimelineId)?.name.includes('比较对象与框箭头');
      return {...await execExportTool('submit_render_job',{format:'video',codec:'h264',...(native?{resolution:'720p',fps:30,videoBitrate:3000000,saveToMediaPool:true}:{}),name:native?'Teashell-比较段最小修正-待审.mp4':before.timelines.find(t=>t.id===before.activeTimelineId)?.name.includes('近鼻讲解精简')?'Teashell-近鼻讲解精简-待审.mp4':'Teashell-88秒-局部承接修订-待审.mp4'},snapshotContext) as object,
        scope:PREVIEW_EDIT_SCOPE,full_film_accepted:false,quality_status:'review_required'};
    }
    throw new Error('Unknown preview action');
  } catch(error) {return {error:error instanceof Error?error.message:'Preview revision failed; no automatic retry'};}
}
