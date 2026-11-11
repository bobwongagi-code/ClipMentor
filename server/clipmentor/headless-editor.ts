import {sourceFrameSeekMs}from'../../shared/source-frame-seek';
import {voiceAssetProvenance} from '../../shared/voice-word-timing';
import {assertFrozenParameterChanges} from '../../src/clipmentor/execution-parameters';
import {assertLocalFeedbackPreservation} from './production-feedback';
import {reusableVoiceForRequest} from './audio-reuse';
import {assertProductionAudioFile} from './production-readiness';
import {randomUUID} from 'node:crypto';
import {readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {makeDraft} from '../../src/editor/store';
import {migrateProjectDoc} from '../../src/persist/projectStore';
import {revisionOf} from '../../src/agent/external-edit-session';
import type {AgentContext} from '../../src/agent/context';
import type {MediaAsset,ProjectDoc} from '../../src/editor/types';
import {executeOfflineTool} from '../external-agent/offline-executor';
import {DEFAULT_PERSISTENCE,type OfflineEditPersistence} from '../external-agent/offline-runtime-support';
import {isProjectConnected} from '../external-agent/broker';
import {assertDeliveryPicturePreservation} from '../../src/clipmentor/delivery-bindings';
import {checkSourceBreakdown} from '../../src/clipmentor/source-breakdown';
import {copyTeachingPacketFromDoc,clipMentorProductionBlock} from '../../src/clipmentor/production-gate';
import {execClipMentorAnalysisTool} from '../../src/agent/tools/clipmentor-analysis-tools';
import {executeCoreEditItem} from './headless-edit-item';
import {pickFrames,constrainSourceFrameArgs} from '../../src/agent/tools/frame-coordinates';
import {sourceWindowForTimelineRange} from '../../src/editor/sourceLimit';
import {isExternalServerDirectCall} from '../../src/agent/external-tool-policy';
import {resolveUploadFile,uploadDir} from '../media-dir';
import {sha256File} from '../../shared/node-content-hash';
import {extractOneFrame} from '../plugins/extract-frames';
import {copyReviewDependencies,reviewClipMentorCopy} from './copy-review';
import {exportJobResultName} from '../plugins/export-runtime';
import {apiCopyReviewDependencies,type ReviewApiConfig} from './copy-review-api';

export interface HeadlessOptions {
 projectId:string;runId:string;origin:string;review:ReviewApiConfig;
 reviewBackend?:'codex';
 retryGateway?:boolean;
 voice?:{provider:string;voiceId:string};signal?:AbortSignal;
 finalFeedback?:Record<string,unknown>;
 assertCanvas?:(doc:ProjectDoc)=>void;
 effect<T>(kind:'review'|'observation'|'tts'|'render'|'preview_review',key:string,work:(operationId:string)=>Promise<T>,recover?:(operationId:string)=>Promise<T>):Promise<T>;
 persistence?:OfflineEditPersistence;browserConnected?:(id:string)=>boolean;fetch?:typeof fetch;
}
/** Server-owned editor. No MCP connection, DOM, user browser or Codex process. */
export async function openHeadlessEditor(options:HeadlessOptions) {
 const checkedOrigin=new URL(options.origin);
 if(!['127.0.0.1','localhost','[::1]'].includes(checkedOrigin.hostname)||!['http:','https:'].includes(checkedOrigin.protocol)||checkedOrigin.username||checkedOrigin.password)throw new Error('Trusted local service origin required');
 const persistence=options.persistence??DEFAULT_PERSISTENCE;
 if((options.browserConnected??isProjectConnected)(options.projectId))throw new Error('project_busy_browser');
 const claimed=await persistence.claimProject(options.projectId,randomUUID());
 if(claimed.status!=='claimed')throw new Error(`project_${claimed.status}`);
 let ownership=claimed.claim,committed=claimed.doc,revision=claimed.revision,closed=false;
 let engine:ReturnType<typeof makeDraft>;
 try{engine=makeDraft(committed);}catch(error){await persistence.releaseOwnership(ownership);throw error;}
 const origin=checkedOrigin;
 const transport=options.fetch??fetch;
 async function local(path:string,init?:RequestInit) {
  if(!/^\/(api\/(clipmentor\/|extract-frames)|render-still|export\/job|generate\/voice)/.test(path))throw new Error('Service route not permitted');
  return transport(new URL(path,origin),{...init,signal:init?.signal??options.signal,headers:{...Object.fromEntries(new Headers(init?.headers)),origin:origin.origin,'sec-fetch-site':'same-origin'}});
 }
 const hostFetch:typeof fetch=async(input,init)=>{
  const path=String(input),body=JSON.parse(String(init?.body??'{}'));
  if(path==='/api/clipmentor/review-copy'){
   const dependencies=options.reviewBackend==='codex'?copyReviewDependencies():apiCopyReviewDependencies(options.review);
   const result=await options.effect('review',body.operationId,async()=>{
    try{return {body:await reviewClipMentorCopy(body,dependencies,init?.signal??undefined),status:200};}
    catch(e){const error=e as {status?:number;diagnostic?:unknown};return {body:{error:'Independent API review failed',diagnostic:error.diagnostic},status:error.status??500};}
   },async()=>({body:await reviewClipMentorCopy(body,dependencies,init?.signal??undefined,'resume_preparation'),status:200}));
   return Response.json(result.body,{status:result.status});
  }
  if(body.action==='read'||path==='/api/clipmentor/observe-video'&&body.action==='read_receipt')return local(path,init);
  if(path.includes('observe-video')||path.includes('transcribe-source')||path.includes('review-preview')){
   const readReceipt=async(operationId:string,resumePreparation=false)=>{
    const isSource=path==='/api/clipmentor/observe-video';
    const receiptDeadline=AbortSignal.timeout(10_000);
    const signal=options.signal?AbortSignal.any([options.signal,receiptDeadline]):receiptDeadline;
    const response=await local(path,{...init,signal,body:JSON.stringify({action:isSource?'read_receipt':'read',operationId,projectId:body.projectId,
     ...(path==='/api/clipmentor/review-preview'?{videoSha256:body.videoSha256}:{})})});
    if(!response.ok)throw new Error('Original receipt unavailable; outcome unknown, no resubmission');
    const receipt=await response.json();
    if(receipt.operationId!==body.operationId||receipt.projectId!==body.projectId)throw new Error('Original receipt binding mismatch');
    if(isSource&&resumePreparation&&receipt.status==='preparing'&&receipt.requestsAttempted===0){
     const resumed=await local(path,{...init,body:JSON.stringify({...body,action:'resume_preparation'})});
     const data=await resumed.json();
     if((!resumed.ok||data?.error)&&!data?.receipt)throw new Error('Original observation preparation did not complete; retain its operation ID');
     return {status:resumed.status,body:data};
    }
    if(isSource)return receipt.status==='completed'&&receipt.result
     ?{status:200,body:{...receipt.result,cached:true}}
     :{status:409,body:{error:'Original observation is failed or unknown; no resubmission',receipt}};
    return {status:response.status,body:receipt};
   };
   const result=await options.effect(path.includes('review-preview')?'preview_review':'observation',body.operationId,async(operationId)=>{
    try{
     const response=await local(path,init);
     const data=await response.json();
     if(options.retryGateway&&path==='/api/clipmentor/observe-video'&&response.status>=500&&!data?.receipt)
      return readReceipt(operationId);
     return {status:response.status,body:data};
    }catch(error){
     if(!options.retryGateway||path.includes('transcribe-source')||options.signal?.aborted)throw error;
     return readReceipt(operationId);
    }
   },operationId=>readReceipt(operationId,true));
   return Response.json(result.body,{status:result.status});
  }
  return local(path,init);
 };
 const ctx:AgentContext={...engine,templates:[],audio:[],hostFetch,getCreativeMode:()=>engine.getDoc().clipMentorAnalysis?'clipmentor':null,
  getProjectId:()=>options.projectId,getAgentRunId:()=>options.runId,...(options.signal?{getAgentRunSignal:()=>options.signal!}:{})};
 let operationTail:Promise<unknown>=Promise.resolve();
 function exclusive<T>(work:()=>Promise<T>):Promise<T>{const pending=operationTail.then(work,work);operationTail=pending.catch(()=>undefined);return pending;}
 const active=()=>{options.signal?.throwIfAborted();if(closed)throw new Error('Editor closed');if((options.browserConnected??isProjectConnected)(options.projectId))throw new Error('project_busy_browser');};
 const canCommit=()=>!closed&&!options.signal?.aborted&&!(options.browserConnected??isProjectConnected)(options.projectId);
 const savedResult=(result:unknown)=>result&&typeof result==='object'&&!Array.isArray(result)
  ?{...result,projectId:options.projectId,projectRevision:revision,saved:true}:result;
 let leaseError:unknown;
 let leaseTail:Promise<unknown>=Promise.resolve();
 function withLease<T>(work:()=>Promise<T>):Promise<T>{const pending=leaseTail.then(work,work);leaseTail=pending.catch(()=>undefined);return pending;}
 const heartbeat=setInterval(()=>{void validate().catch(error=>{if(!closed)leaseError=error;});},10000);heartbeat.unref?.();
 const sync=()=>{ctx.commands=engine.commands;ctx.getDoc=engine.getDoc;ctx.getState=engine.getState;};
 async function renew(){
  active();if(leaseError)throw leaseError;
  const renewed=await persistence.renewOwnership(ownership,revision);active();if(renewed.status!=='renewed')throw new Error('Project ownership lost');ownership=renewed.claim;
 }
 const validate=()=>withLease(renew);
 async function commitDraft(onWrite?:()=>void){return withLease(async()=>{
  await renew();const doc=migrateProjectDoc(engine.getDoc());if(!doc)throw new Error('Invalid saved project');
  if(revisionOf(doc)!==revision){options.assertCanvas?.(doc);assertFrozenParameterChanges(committed,doc);assertLocalFeedbackPreservation(committed,doc,options.finalFeedback);assertDeliveryPicturePreservation(committed,doc);onWrite?.();const result=await persistence.commitProject({projectId:options.projectId,expectedRevision:revision,doc,ownership,canCommit});
   if(result.status!=='applied'||!result.revision)throw new Error(`Project commit ${result.status}`);revision=result.revision;ownership=result.ownership??{...ownership,baseRevision:revision};
  }
  committed=doc;engine=makeDraft(doc);sync();return {saved:true,revision,projectId:options.projectId};
 });}
 const commit=()=>exclusive(async()=>{try{return await commitDraft();}catch(error){engine=makeDraft(committed);sync();throw error;}});
 async function readExport(id:string){
  options.signal?.throwIfAborted();
  if(!/^[a-zA-Z0-9_-]+$/.test(id))throw new Error('Render ID required');
  const response=await local(`/export/job/${id}`),result=await response.json();
  options.signal?.throwIfAborted();if(!response.ok)throw new Error('Render read failed');if(result.id!==id)throw new Error('Render binding mismatch');
  if(['completed','succeeded'].includes(result.status)&&typeof result.result?.path==='string'
   &&result.result.path.startsWith('/media/uploads/openchatcut-export-job-')){
   const temporary=exportJobResultName(result.result.path,String(result.result.assetId??''));
   if(!temporary)throw Error('Preview publication source binding mismatch');
   const publishedResponse=await local(`/export/job/${id}/promote`,{method:'POST'});
   options.signal?.throwIfAborted();if(!publishedResponse.ok)throw Error('Preview publication failed; saved render retained');
   const published=await publishedResponse.json();
   if(published.assetId!==result.result.assetId||published.path!==`/media/uploads/${temporary.replace('openchatcut-export-job-','openchatcut-derived-')}`)
    throw Error('Preview publication binding mismatch');
   return {...result,result:{...result.result,...published}};
  }
  return result;
 }
 const execute=(name:string,args:Record<string,unknown>,callId:string)=>exclusive(()=>executeOperation(name,args,callId));
 async function executeOperation(name:string,args:Record<string,unknown>,callId:string):Promise<unknown>{
  await validate();const before=engine.getDoc(),beforeRevision=revision;
  if(args.projectId!==undefined&&args.projectId!==options.projectId)throw new Error('Tool project binding mismatch');
  try{
   const blocked=await clipMentorProductionBlock(name,args,ctx);if(blocked)return {...blocked,issues:before.clipMentorAnalysis?checkSourceBreakdown(before,true).issues:[]};
   if(name==='save_clipmentor_source_frame'){
    const asset=before.assets.find(a=>a.id===args.assetId);const seconds=args.seconds;
    if(!asset||asset.kind!=='video'||typeof seconds!=='number'||!Number.isFinite(seconds)||seconds<0||seconds>=asset.durationInFrames/engine.getState().fps)throw new Error('Invalid source frame');
    const file=resolveUploadFile(asset.src.replace(/^\/media\/uploads\//,''));if(!file||!asset.sourceContentHash||await sha256File(file)!==asset.sourceContentHash)throw new Error('Source changed');
    const name=`clipmentor-frame-${randomUUID()}.png`,target=join(uploadDir(),name);
    let commitStarted=false;
    try{
     await extractOneFrame(file,sourceFrameSeekMs(seconds*1000),target,true,undefined,options.signal);
     const image:MediaAsset={id:randomUUID(),name,kind:'image',src:`/media/uploads/${name}`,durationInFrames:1,width:asset.width,height:asset.height,
      sourceContentHash:await sha256File(target),props:{sourceAssetId:asset.id,sourceSeconds:seconds,sourceHash:asset.sourceContentHash}};
     active();
     ctx.commands.applyDoc({...before,assets:[...before.assets,image]});
     await commitDraft(()=>{commitStarted=true;});
     return savedResult({asset:image});
    }catch(error){
     if(!commitStarted)await rm(target,{force:true}).catch(()=>undefined);
     throw error;
    }
   }
   if(name==='submit_voice'){
    const voice=options.voice;
    if(!voice||args.provider!==voice.provider||args.voiceId!==voice.voiceId||(args.speed??1)!==1||(args.speedRatio??1)!==1)throw new Error('Task-confirmed voice and normal speed required');
    const packet=await copyTeachingPacketFromDoc(before);
    if(!packet.units.some(u=>u.lines.some(l=>l.narration_ms===args.text))&&!packet.delivery_sections?.some(s=>s.line.narration_ms===args.text))throw new Error('Voice text does not match current reviewed copy');
    const reusable=reusableVoiceForRequest(before,args);
    if(reusable.status==='reusable'){
     const {audioHash,...result}=reusable;
     await assertProductionAudioFile(result.asset,audioHash);
     active();
     return savedResult(result);
    }
    if(reusable.status!=='missing')return{error:`voice_reuse_${reusable.status}:${reusable.reason}`,voice_reuse:reusable,production_approved:false};
    const obtainVoice=async(operationId:string,readOnly=false)=>{
    const res=await local('/generate/voice',{method:'POST',headers:{'Content-Type':'application/json','X-ClipMentor-Project':options.projectId,'X-ClipMentor-Operation':operationId,...(readOnly?{'X-ClipMentor-Recover':'1'}:{})},body:JSON.stringify(args)}),data=await res.json();
    if(!res.ok||!data.path||!Number.isFinite(data.durationSeconds))throw new Error('Voice result missing measured duration');
    const provenance=voiceAssetProvenance(data,typeof args.subtitleType==='string'?args.subtitleType:undefined);
    const asset:MediaAsset={id:randomUUID(),name:String(args.name??'Reviewed voice'),kind:'audio',src:data.path,durationInFrames:Math.ceil(data.durationSeconds*ctx.getState().fps),...provenance,
     props:{...provenance.props,
      generation:{pitch:args.pitch??0,volume:args.volume??1,languageBoost:args.languageBoost??'auto',sampleRate:args.sampleRate??32000,channel:args.channel??1,audioFormat:args.audioFormat??'mp3',provider:args.provider,voiceId:args.voiceId,text:args.text,speed:args.speedRatio??args.speed??1,operationId:callId,durationSeconds:data.durationSeconds}}};
    ctx.commands.applyDoc({...ctx.getDoc(),assets:[...ctx.getDoc().assets,asset]});await commitDraft();return savedResult({asset});
   };
   return options.effect('tts',callId,id=>obtainVoice(id),id=>obtainVoice(id,true));
   }
   if(name==='submit_render_job'){
    options.assertCanvas?.(before);
    if(revisionOf(before)!==revision)throw new Error('export_requires_committed_project');
    const result=await options.effect('render',callId,async(operationId)=>{
     const response=await local('/export/job',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...args,operationId,format:'video',state:ctx.getState(),project:committed,timelineId:committed.activeTimelineId})});
     const result=await response.json();if(!response.ok||!result.renderId)throw new Error(result.error??'Render submission failed');
     if(result.projectRevision!==revision||result.timelineId!==committed.activeTimelineId)throw new Error('Render snapshot binding mismatch; inspect original job, no resubmission');
     return {...result,projectId:options.projectId};
    },async(operationId)=>{const response=await local(`/export/job/${operationId}`);if(!response.ok)throw new Error('Original render operation unavailable; do not resubmit');const job=await response.json();if(job.id!==operationId||job.params?.projectRevision!==revision||job.params?.timelineId!==committed.activeTimelineId)throw new Error('Render snapshot binding missing or mismatch; no resubmission');return {renderId:job.id,projectRevision:job.params.projectRevision,timelineId:job.params.timelineId,projectId:options.projectId};});
    if(result.projectRevision!==revision||result.timelineId!==committed.activeTimelineId)throw new Error('Cached render snapshot binding mismatch; no resubmission');
    return result;
   }
   if(name==='track_export'){
    return readExport(String(args.renderIds??''));
   }
   if(name==='view_asset_frames'){
    const timeline=args.timelineId?before.timelines.find(t=>t.id===args.timelineId):ctx.getState();
    if(!timeline)throw new Error('Timeline not found');
    const item=args.itemId?timeline.items.find(i=>i.id===args.itemId):undefined;
    if(args.itemId&&!item)return {error:'Exact timeline item ID required'};
    const assetId=item?.sourceAssetId??args.assetId;
    if(item&&args.assetId&&args.assetId!==assetId)return {error:'Asset ID does not match the timeline item'};
    const asset=before.assets.find(a=>a.id===assetId);
    if(!asset||!['video','image'].includes(asset.kind))return {error:'Exact video/image asset or item ID required'};
    const sampling=item?constrainSourceFrameArgs(args,sourceWindowForTimelineRange(item,0,item.durationInFrames),timeline.fps):args;
    const times=asset.kind==='image'?[0]:pickFrames(sampling,asset.durationInFrames,timeline.fps,6).map(f=>f/timeline.fps*1000);
    const res=await local('/api/extract-frames',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({src:asset.src,output:'frames',sourceTimesMs:times})});
    if(!res.ok)throw new Error('Source frame extraction failed');const data=await res.json();
    if(!Array.isArray(data.frames)||!data.frames.length)throw new Error('Source frame extraction returned no images');
    return {...data,__images:data.frames.map((f:{sourceTimeMs:number;base64:string})=>({frame:Math.round(f.sourceTimeMs*timeline.fps/1000),base64:f.base64}))};
   }
   if(name==='view_timeline_frames'){
    const timeline=args.timelineId?before.timelines.find(t=>t.id===args.timelineId):ctx.getState();if(!timeline)throw new Error('Timeline not found');
    const total=Math.max(1,...timeline.items.map(i=>i.startFrame+i.durationInFrames));
    const frames=pickFrames(args,total,timeline.fps,4);
    const res=await local('/render-still',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state:timeline,project:before,timelineId:args.timelineId??before.activeTimelineId,frames})});
    if(!res.ok)throw new Error('Timeline frame render failed');const data=await res.json();return {...data,__images:data.frames};
   }
   let result:unknown;
   if(name==='edit_item')result=executeCoreEditItem(args,ctx);
   else if(name.includes('clipmentor'))result=await execClipMentorAnalysisTool(name,args,ctx);
   else if(isExternalServerDirectCall(name,args))result=await executeOfflineTool(name,args,ctx);
   else throw new Error(`Tool/action requires an unsupported browser host: ${name}`);
   if(result&&typeof result==='object'&&'error' in result){engine=makeDraft(before);sync();return result;}
   // Preparation and committed editing never rely on browser settlement.
   await commitDraft();return revision!==beforeRevision?savedResult(result):result;
  }catch(error){engine=makeDraft(committed);sync();throw error;}
 }
 async function loadSkill(name:string,file='SKILL.md'){
  if(!/^[a-z0-9_-]+$/.test(name)||!/^([a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_.-]+\.md$/.test(file)||file.includes('..'))throw new Error('Unsupported skill file');
  return readFile(new URL(`../../src/agent/skills/${name}/${file}`,import.meta.url),'utf8');
 }
 async function loadSkillTool(args:Record<string,unknown>){
  const name=String(args.name);
  if(args.files!==undefined){
   if(args.file!==undefined||args.offset!==undefined||args.limit!==undefined||!Array.isArray(args.files)||!args.files.length||args.files.length>64||!args.files.every(f=>typeof f==='string'))throw new Error('Skill file selectors conflict');
   const contents:Record<string,string>={},omittedFiles:string[]=[];let size=0;
   for(const file of args.files){const body=await loadSkill(name,file);if(size+body.length>48000){omittedFiles.push(file);continue;}contents[file]=body;size+=body.length;}
   return {skill:name,contents,omittedFiles,note:'Read omitted files individually with file/offset/limit.'};
  }
  const file=typeof args.file==='string'?args.file:'SKILL.md',body=await loadSkill(name,file),offset=args.offset??0,limit=args.limit??48000;
  if(!Number.isSafeInteger(offset)||Number(offset)<0||Number(offset)>body.length||!Number.isSafeInteger(limit)||Number(limit)<1||Number(limit)>48000)throw new Error('Invalid skill page');
  if(Number(offset)>0&&/[\uDC00-\uDFFF]/.test(body.charAt(Number(offset))))throw new Error('Skill page splits a Unicode character');
  let end=Math.min(body.length,Number(offset)+Number(limit));if(end<body.length&&/[\uD800-\uDBFF]/.test(body.charAt(end-1)))end--;
  if(end===Number(offset)&&end<body.length)throw new Error('Page limit is too small for a Unicode character');
  return {skill:name,file,contents:{[file]:body.slice(Number(offset),end)},offset,nextOffset:end<body.length?end:null,totalChars:body.length};
 }
 return {context:ctx,execute,commit,readExport,getDoc:()=>engine.getDoc(),get revision(){return revision;},async close(){closed=true;clearInterval(heartbeat);await operationTail;await leaseTail;await persistence.releaseOwnership(ownership);},loadSkill,loadSkillTool};
}
