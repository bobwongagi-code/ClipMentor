import {createHash} from 'node:crypto';
import {createRun,flushRunPersistence} from '../agent-runs/store';
import {executeRun} from '../agent-runs/executor';
import {canonicalServerRunToolCatalog} from '../agent-runs/tool-policy';
import {currentAgentSessionGeneration} from '../../src/persist/agentSessionGeneration';
import {checkCopyProduction,copyTeachingPacketFromDoc} from '../../src/clipmentor/production-gate';
import {checkSourceBreakdown} from '../../src/clipmentor/source-breakdown';
import {isClipMentorAnalysis} from '../../src/clipmentor/analysis';
import {isExternalServerDirectTool} from '../../src/agent/external-tool-policy';
import {resolveUploadFile} from '../media-dir';
import {sha256File} from '../../shared/node-content-hash';
import {verifyProductionNarration,verifyProductionEditing} from './production-readiness';
import {openHeadlessEditor} from './headless-editor';
import type {ProjectDoc,TimelineState} from '../../src/editor/types';
import type {TeachingPacket} from '../../src/clipmentor/production-gate';
import type {StageWorker} from './production-task';

const hostNames=new Set(['load_skill','edit_item','read_clipmentor_analysis','revise_clipmentor_analysis','observe_clipmentor_source',
 'observe_clipmentor_source_video','read_clipmentor_source_video','view_asset_frames','view_timeline_frames','save_clipmentor_source_frame','submit_voice']);
const goals={
 analysis:'完整观察原片，理解商品购买理由及结构，登记证据、重点与blueprint。区分所见、原话及推论；不能听清的留未知。不得配音或剪辑。',
 blueprint:'按整组教学关系登记source_breakdown、现行马来语口播/同文字幕/中文意思及picture plan，说明素材有效范围、必要拍法、回看进出与视觉继承。画面承担可以无独立旁白。不得自签审核或剪辑。',
 audio:'只处理已审现行稿。先找同文、同音色现有音频；仅合成缺少的句子，保留实测声长及来源。按整组核承载，缺素材或需改稿时说明冲突，不赶读、慢放、循环或长定格凑时长。',
 edit:'按当前已审蓝图和真实音频执行，保留教学重点和必要拍法，原片/讲解强区分、字幕实底可读且无阴影。源片对象、阶段与讲解意群对应。需要定格时用save_clipmentor_source_frame，不临时编新意思。用实际合成帧自查，保存后停止，不自行导出。'
};
/** The same service worker is used by the HTTP task and by zero-provider regression fixtures. */
export const productionStageWorker:StageWorker=async(task,stage)=>{
 const editor=await openHeadlessEditor({projectId:task.projectId,runId:task.taskId,origin:task.input.author.origin,review:task.input.reviewer,voice:task.input.voice,signal:stage.signal,
  effect:(kind,key,work,recover)=>stage.effect(kind,key,work,recover)});
 editor.context.getAgentRunSignal=()=>stage.signal;
 const operation=(scope:string)=>{const h=createHash('sha256').update(`${task.taskId}:${task.stage}:${task.repairs}:${task.feedbackUsed}:${scope}`).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
 try{
  if(task.projectRevision&&editor.revision!==task.projectRevision)throw new Error('production_project_changed; reconcile the saved project before resuming');
  if(!editor.getDoc().clipMentorAnalysis){
   const doc=editor.getDoc(),source=doc.assets.find(a=>a.id===task.input.sourceAssetId);
   if(!source||source.kind!=='video')throw new Error('Original video asset missing');
   const file=resolveUploadFile(source.src.replace(/^\/media\/uploads\//,''));if(!file)throw new Error('Original upload unavailable');
   const hash=await sha256File(file);
   if(source.sourceContentHash&&source.sourceContentHash!==hash)throw new Error('Original source changed');
   editor.context.commands.applyDoc({...doc,assets:doc.assets.map(a=>a.id===source.id?{...a,sourceContentHash:hash}:a),clipMentorAnalysis:{
    schema_version:1,analysis_id:`production:${task.taskId}`,revision:1,source:{asset_id:source.id,sourceContentHash:hash,duration_seconds:source.durationInFrames/editor.context.getState().fps,fps:editor.context.getState().fps},
    product:task.input.product,import_origin:'production_source_facts_only',evidence:[],points:[],blueprint:[],transcripts:[],reviews:[],audit:[]}});
   await editor.commit();
  }
  const doc=editor.getDoc(),a=doc.clipMentorAnalysis!;
  if(a.source.asset_id!==task.input.sourceAssetId)throw new Error('Task/source binding changed');
  if(task.stage==='copy_review'){
   const result=await editor.execute('request_clipmentor_copy_review',{operationId:operation('independent-review'),maxRequests:1,expectedRevision:a.revision},'copy-review') as Record<string,unknown>;
   if(result.error)throw new Error(String(result.error));
   const gate=await checkCopyProduction(editor.getDoc(),'clipmentor');
   if(!gate.allowed)return {artifact:{receipt:result,revision:editor.revision},repair:'blueprint'};
   return {artifact:{revision:editor.revision,gate,receipt:result}};
  }
  if(task.stage==='export'){
   const result=await editor.execute('submit_render_job',{format:'video',codec:'h264',resolution:'720p',fps:30,videoBitrate:3000000,name:'ClipMentor-review-preview.mp4'},'export') as {renderId:string};
   if(!result.renderId)throw new Error('Missing render ID');
   for(;;){
    stage.signal.throwIfAborted();const snapshot=await editor.execute('track_export',{renderIds:result.renderId},'export-read') as {status:string;result?:Record<string,unknown>;error?:string};
    if(['succeeded','completed'].includes(snapshot.status)&&snapshot.result)return {artifact:{renderId:result.renderId,...snapshot.result,revision:editor.revision}};
    if(['failed','cancelled'].includes(snapshot.status))throw new Error(snapshot.error??'Render failed; committed editing retained');
    await new Promise<void>((resolve,reject)=>{const stop=()=>{clearTimeout(timer);reject(stage.signal.reason);};const timer=setTimeout(()=>{stage.signal.removeEventListener('abort',stop);resolve();},1000);stage.signal.addEventListener('abort',stop,{once:true});});
   }
  }
  if(task.stage==='self_check'){
   const exported=task.completed.export?.artifact,src=exported?.path??exported?.downloadUrl;
   if(typeof src!=='string')throw new Error('Exported preview path missing');
   const file=resolveUploadFile(src.replace(/^\/media\/uploads\//,''));if(!file)throw new Error('Preview missing');
   const packet=await copyTeachingPacketFromDoc(doc),t=editor.context.getState();
   const {input,executionManifest}=productionPreviewFacts(doc,t,packet);
   const result=await editor.execute('review_clipmentor_preview',{action:'request',operationId:operation('independent-review'),maxRequests:1,src,videoSha256:await sha256File(file),input,
    executionManifest},'preview-review') as Record<string,unknown>;
   if(result.error)throw new Error(String(result.error));
   if(!(result.effective_review as {can_use_as_pass?:boolean})?.can_use_as_pass)return {artifact:{receipt:result,revision:editor.revision},repair:'edit'};
   return {artifact:{receipt:result,preview:src,language_review:'final_operator_required',complete_film_accepted:false}};
  }
  // Only these author stages may call the API model; review/export have separate host paths.
  const prefix=`${task.stage}:${task.feedbackUsed?'feedback':'initial'}:${task.repairs}:`;
  if(Object.entries(task.effects).some(([id,e])=>id.startsWith(prefix)&&e.kind==='model'))throw new Error('author_stage_already_attempted; inspect saved run before explicit reconciliation, no repeat submission');
  const goal=goals[task.stage];
  const skills=await editor.loadSkill('clipmentor'),planning=await editor.loadSkill('clipmentor','references/planning.md');
  const run=createRun({projectId:task.projectId,sessionGeneration:await currentAgentSessionGeneration(task.projectId),backend:'api',provider:task.input.author.provider,model:task.input.author.model,context:{productionTaskId:task.taskId,stage:task.stage}});
  await flushRunPersistence(run);
  const tools=canonicalServerRunToolCatalog(false,true).filter(s=>hostNames.has(s.name)||isExternalServerDirectTool(s.name));
  await executeRun(run,{backend:'api',provider:task.input.author.provider,model:task.input.author.model,openAiApiMode:task.input.author.apiMode,cacheMode:'short',maxOutputTokens:8192,
   autonomousAcceptance:false,maxAcceptanceIterations:1,origin:task.input.author.origin,tools,
   messages:[{role:'user',content:JSON.stringify({task:task.input.brief,stage:task.stage,goal,feedback:task.feedback??null,repairContext:task.repairContext??null,voice:task.input.voice??null,sourceAssetId:task.input.sourceAssetId,revision:a.revision,
    actor:{operator:'task_operator',executor:'builtin_api_agent',instruction:task.input.brief,identity:'local_declared_not_authenticated'}})}],
   instructions:`${skills}\n${planning}\n服务端制作任务；只使用可用工具。不要等待逐阶段人工指令，不能调用本机Codex、文件脚本或自签审核。先读当前工程与现行稿，不读旧稿替代当前指针。阶段目标：${goal}`,
   host:{signal:stage.signal,maxTurns:Math.max(1,task.input.budget.model-task.attempts.model),deadlineAt:task.createdAt+task.input.budget.maxElapsedMs,
    beforeRequest:()=>stage.effect('model',`author-${task.attempts.model}`,async()=>null).then(()=>undefined),
    execute:async(name,args,id)=>name==='load_skill'?editor.loadSkillTool(args):editor.execute(name,args,id)}});
  if(run.status!=='completed')throw new Error(run.error??'Author stage failed');
  const next=editor.getDoc(),analysis=next.clipMentorAnalysis;
  if(!isClipMentorAnalysis(analysis)||!analysis.points.length||!analysis.blueprint.length||!analysis.evidence.length)throw new Error('analysis_stage_incomplete');
  if(task.stage==='blueprint'){
   const check=checkSourceBreakdown(next);if(check.status!=='structurally_ready')throw new Error(`blueprint_stage_incomplete:${JSON.stringify(check.issues).slice(0,1600)}`);
   await copyTeachingPacketFromDoc(next);
  }
  if(task.stage==='audio')await verifyProductionNarration(next,task.input.voice);
  if(task.stage==='edit')await verifyProductionEditing(next,task.input.voice);
  await editor.commit();
  return {artifact:{revision:editor.revision,analysisRevision:analysis.revision,runId:run.id,semantic_quality:'not_certified_by_structure'}};
 }finally{await editor.close();}
};

/** Project actual placements; never substitute teaching IDs with transition candidate IDs. */
export function productionPreviewFacts(doc:ProjectDoc,t:TimelineState,packet:TeachingPacket){
 const mediaTrack=t.items.find(i=>i.kind==='video'&&i.sourceAssetId===doc.clipMentorAnalysis!.source.asset_id)?.track;
   if(!mediaTrack)throw new Error('No source-bearing picture track');
   const sourcePictures=t.items.filter(i=>['video','image'].includes(i.kind));
   if(sourcePictures.some(i=>i.track!==mediaTrack))throw new Error('Multi-track picture composition requires an exact execution manifest; cannot invent a single-track projection');
   const scenes=t.items.filter(i=>i.track===mediaTrack&&['video','image'].includes(i.kind)).sort((a,b)=>a.startFrame-b.startFrame).map(i=>({start_frame:i.startFrame,end_frame:i.startFrame+i.durationInFrames,
    kind:i.kind==='image'?'still':(i.volume??1)>0?'original':'video',content:i.kind==='image'?Number(doc.assets.find(a=>a.id===i.sourceAssetId)?.props?.sourceSeconds):(i.srcInFrame??0)/t.fps,label:i.id}));
   if(scenes.some(s=>!Number.isFinite(s.content)))throw new Error('Still source provenance missing');
   const audios=t.items.filter(i=>i.kind==='audio'||i.kind==='video'&&(i.volume??1)>0).map(i=>({start:i.startFrame/t.fps,end:(i.startFrame+i.durationInFrames)/t.fps,kind:i.kind==='audio'?'narration':'original'}));
   const input={duration_seconds:Math.max(...t.items.map(i=>i.startFrame+i.durationInFrames))/t.fps,
    points:packet.units.flatMap(u=>u.points.map(p=>({point_id:p.point_id,teaching_goal_zh:p.question,product_relevance:p.buying_concern}))),
    units:packet.units.map(u=>{
     const placement=doc.clipMentorAnalysis?.source_breakdown?.units.find(v=>v.unit_id===u.unit_id)?.placement;
     if(!placement||placement.timeline_id!==doc.activeTimelineId)throw new Error(`Teaching unit output placement missing/stale: ${u.unit_id}`);
     return {unit_id:u.unit_id,point_ids:u.points.map(p=>p.point_id),
      output_range_seconds:[placement.original_frames[0]/t.fps,placement.explanation_frames[1]/t.fps] as [number,number]};
    }),
    reference_text:t.items.flatMap(i=>{const asset=doc.assets.find(a=>a.id===i.sourceAssetId);const text=(asset?.props?.generation as {text?:string}|undefined)?.text;
     return i.kind==='audio'&&text?[{channel:'narration',start_seconds:i.startFrame/t.fps,end_seconds:(i.startFrame+i.durationInFrames)/t.fps,text}]:[];})};

 return {input,executionManifest:{fps:t.fps,total_frames:Math.round(input.duration_seconds*t.fps),scenes,audios}};
}
