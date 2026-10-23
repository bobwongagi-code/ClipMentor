import type { AgentContext } from '../agent/context';
import type { MediaAsset, ProjectDoc, Timeline } from '../editor/types';

export const PREVIEW_EDIT_SCOPE = 'authorized_local_preview_revision';
export interface PreviewEditPlan {
  operationId: string;
  projectId: string;
  baseline: MediaAsset;
  patches: Array<{ asset: MediaAsset; startFrame: number; endFrame: number; name: string }>;
  fps: number;
  totalFrames: number;
  baseSegments?: Array<{ startFrame: number; durationInFrames: number; srcInFrame: number }>;
  audio?: MediaAsset;
}
export async function previewDocDigest(doc: ProjectDoc): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(doc)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
/** Keep the rendered baseline and its exact mixed soundtrack; local overlays remain editable. */
export function buildPreviewRevision(doc: ProjectDoc, plan: PreviewEditPlan): ProjectDoc {
  const id = `preview_${plan.operationId}`;
  if (doc.timelines.some(t => t.id === id)) throw new Error('Preview revision already exists');
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
      return {...await execExportTool('submit_render_job',{format:'video',codec:'h264',name:before.timelines.find(t=>t.id===before.activeTimelineId)?.name.includes('近鼻讲解精简')?'Teashell-近鼻讲解精简-待审.mp4':'Teashell-88秒-局部承接修订-待审.mp4'},snapshotContext) as object,
        scope:PREVIEW_EDIT_SCOPE,full_film_accepted:false,quality_status:'review_required'};
    }
    throw new Error('Unknown preview action');
  } catch(error) {return {error:error instanceof Error?error.message:'Preview revision failed; no automatic retry'};}
}
