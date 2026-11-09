import sharp from 'sharp';
import {mkdtemp,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {validatePreviewReviewInput} from './preview-review';
import {previewReviewWindows} from './preview-timeline-check';
import {checkTransitionManifest,type Scene} from '../../src/clipmentor/transition-check';
import {atomicWriteFile} from '../plugins/project-store-durable';
import {reviewBoardArtifactRoot,reviewBoardArtifactUrl} from './blueprint-review-board-artifacts';

const VERSION='export-reference-comparison-v1';
const MAX_FRAMES=64;
type SharedEvidence={promise:Promise<Awaited<ReturnType<typeof buildPreviewVisualEvidence>>>;controller:AbortController;waiters:number;settled:boolean};
const pending=new Map<string,SharedEvidence>();
const recentFailures=new Map<string,{until:number;error:unknown}>();
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const esc=(v:string)=>v.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export interface VisualEvidenceIO {
 hash(file:string):Promise<string>;
 frame(file:string,seconds:number,output:string,signal?:AbortSignal):Promise<string>;
}

/** Supplement an already retrieved result; local evidence failure must not erase it. */
export async function collectSavedPreviewVisualEvidence(receipt:Record<string,unknown>,read:(args:Record<string,unknown>)=>Promise<unknown>){
 const comparison=receipt.visual_comparison as {status?:string}|undefined;
 if(receipt.status!=='completed'||comparison?.status!=='deferred')return receipt;
 let evidence:unknown,negativeGate:Record<string,unknown>|undefined,timeline:unknown;
 try{
  const next=await read({action:'read',operationId:receipt.operationId,videoSha256:receipt.videoSha256,includeVisualEvidence:true}) as Record<string,unknown>;
  const value=next?.visual_comparison as {status?:string;full_film_accepted?:boolean}|undefined;
  if(next?.error||next?.operationId!==receipt.operationId||next?.projectId!==receipt.projectId||next?.videoSha256!==receipt.videoSha256
    ||next?.status!=='completed'||next?.full_film_accepted!==false||!value||value.full_film_accepted!==false
    ||!['collected','not_collected','not_applicable'].includes(value.status??''))throw Error('visual_comparison_receipt_invalid');
  evidence=value;
  const gate=next.effective_review as Record<string,unknown>|undefined;
  if(gate?.status==='review_required'&&gate.can_use_as_pass===false&&Array.isArray(gate.blockers)){
   const prior=receipt.effective_review as {blockers?:unknown[]}|undefined;
   negativeGate={...gate,blockers:[...new Set([...(prior?.blockers??[]),...gate.blockers])],full_film_accepted:false};
   timeline=next.timeline_check;
  }
 }catch{
  evidence={status:'not_collected',code:'local_read_unavailable',reason:'审核结果已保存，本地对照读取未完成；不重新审核。',full_film_accepted:false};
 }
 return {...receipt,visual_comparison:evidence,...(negativeGate?{effective_review:negativeGate,...(timeline===undefined?{}:{timeline_check:timeline})}:{})};
}
function ceilFrame(seconds:number,fps:number){
 const value=seconds*fps,nearest=Math.round(value);
 return Math.abs(value-nearest)<=Number.EPSILON*Math.max(1,Math.abs(value))*4?nearest:Math.ceil(value);
}
export function visualEvidenceFailure(error:unknown){
 const message=error instanceof Error?error.message:'',limit=/^visual_comparison_(?:frame|pair)_limit:(\d+)\/(\d+)$/.exec(message);
 const code=limit?(message.includes('_pair_')?'pair_limit':'frame_limit'):error instanceof Error&&error.name==='TimeoutError'?'deadline'
  :error instanceof Error&&error.name==='AbortError'?'cancelled'
   :message.includes('export_changed')?'export_changed':message.includes('manifest_changed')?'manifest_changed'
    :message.includes('binding_missing')?'binding_missing':message.includes('reader_unavailable')?'reader_unavailable':'local_processing_failed';
 const reason={pair_limit:'本地对照超出对照图数量上限，未截断生成。',frame_limit:'本地对照超出取样上限，未截断生成。',deadline:'本地对照已到截止时间，未完成采集。',cancelled:'本地对照已取消，未完成采集。',export_changed:'实际导出已变化，不能复用旧对照。',manifest_changed:'执行快照已变化，不能复用旧对照。',binding_missing:'旧回执缺少冻结的定位依据，不能从历史猜素材。',reader_unavailable:'实际导出或本地抽帧能力不可用。',local_processing_failed:'本地抽帧或证据保存失败，未完成采集。'}[code];
 return {status:'not_collected' as const,code,reason,...(limit?(code==='pair_limit'?{pair_count:Number(limit[1]),pair_limit:Number(limit[2])}:{frame_count:Number(limit[1]),frame_limit:Number(limit[2])}):{}),full_film_accepted:false};
}

/** Frozen scene data locates samples; it never certifies visible text or style. */
export function visualEvidenceSamples(inputValue:unknown,manifest:unknown){
 const input=validatePreviewReviewInput(inputValue),structural=checkTransitionManifest(manifest);
 const windows=previewReviewWindows(manifest,input);
 const rows=(input.visual_criteria??[]).flatMap(criterion=>input.units.filter(u=>u.point_ids.includes(criterion.point_id)).map(unit=>{
  const window=windows.find(w=>w.group_id===unit.unit_id)!;
  const first=ceilFrame(window.start_seconds,structural.fps),last=ceilFrame(window.end_seconds,structural.fps)-1;
  if(last<first)throw Error('visual_comparison_window_has_no_frame');
  const frames=new Set([first,Math.floor((first+last)/2),last]);
  // Include each native text instance, even when the fixed samples miss it.
  const items=new Map<string,{start:number;end:number}>();
  for(const scene of (manifest as {scenes:Scene[]}).scenes)if(scene.kind==='composition')for(const layer of scene.layers){
   if(layer.kind!=='text')continue;
   const start=Math.max(first,layer.item_start_frame),end=Math.min(last,layer.item_end_frame-1);
   if(start<=end)items.set(layer.item_id,{start,end});
  }
  for(const {start,end}of items.values())frames.add(Math.floor((start+end)/2));
  return {criterion,unitId:unit.unit_id,range:[window.start_seconds,window.end_seconds],frames:[...frames].sort((a,b)=>a-b)};
 }));
 if((input.visual_criteria?.length??0)!==new Set(rows.map(r=>r.criterion.point_id)).size)throw Error('visual_comparison_unmapped_reference');
 const frames=[...new Set(rows.flatMap(r=>r.frames))].sort((a,b)=>a-b);
 if(frames.length>MAX_FRAMES)throw Error('visual_comparison_frame_limit:'+frames.length+'/'+MAX_FRAMES);
 const pairs=rows.reduce((n,row)=>n+row.frames.length,0);
 if(pairs>128)throw Error('visual_comparison_pair_limit:'+pairs+'/128');
 return {input,rows,frames,fps:structural.fps};
}

/** Offline evidence only. No verdict mutation, provider request, OCR or inferred effect. */
async function buildPreviewVisualEvidence(projectId:string,file:string,videoSha256:string,inputValue:unknown,manifest:unknown,io:VisualEvidenceIO,
 root=reviewBoardArtifactRoot(projectId),callerSignal?:AbortSignal){
 const signal=callerSignal?AbortSignal.any([callerSignal,AbortSignal.timeout(90_000)]):AbortSignal.timeout(90_000);
 signal.throwIfAborted();
 if(!/^[A-Za-z0-9_-]{1,160}$/.test(projectId)||!/^[a-f0-9]{64}$/.test(videoSha256))throw Error('visual_comparison_identity_invalid');
 const plan=visualEvidenceSamples(inputValue,manifest);
 if(!plan.rows.length)return {status:'not_applicable' as const,full_film_accepted:false};
 if(await io.hash(file)!==videoSha256)throw Error('visual_comparison_export_changed');
 const identity=hash(JSON.stringify({version:VERSION,projectId,videoSha256,input:plan.input,manifest,samples:plan.rows.map(r=>[r.unitId,r.criterion.point_id,r.frames])}));
 const name='审片板-实际视觉对照-'+identity+'.html',path=join(root,name),metadataPath=path+'.json';
 const result={status:'collected' as const,scope:'sampled_export_reference_comparison' as const,full_film_accepted:false,
  video_sha256:videoSha256,identity,frame_count:plan.frames.length,unit_count:plan.rows.length,path,url:reviewBoardArtifactUrl(projectId,name)};
 try{
  const saved=JSON.parse(await readFile(metadataPath,'utf8')),bytes=await readFile(path);
  if(saved.identity===identity&&saved.html_sha256===hash(bytes)&&await io.hash(file)===videoSha256){signal.throwIfAborted();return {...result,cached:true};}
 }catch{/* Missing/damaged local evidence is rebuilt, never another external request. */}
 signal.throwIfAborted();
 const work=await mkdtemp(join(tmpdir(),'clipmentor-export-compare-'));
 let published=false;
 try{
  const pictures=new Map<number,{base64:string;width:number;height:number}>();
  for(const frame of plan.frames){
   signal.throwIfAborted();
   const base64=await io.frame(file,frame/plan.fps,join(work,frame+'.jpg'),signal);
   if(!base64||base64.length>16_000_000||!/^[A-Za-z0-9+/]+={0,2}$/.test(base64))throw Error('visual_comparison_frame_invalid');
   const bytes=Buffer.from(base64,'base64');
   const meta=await sharp(bytes,{limitInputPixels:16_777_216}).metadata();
   if(!meta.width||!meta.height)throw Error('visual_comparison_frame_invalid');
   pictures.set(frame,{base64:(await sharp(bytes,{limitInputPixels:16_777_216}).rotate().resize({width:640,height:960,fit:'inside',withoutEnlargement:true}).jpeg({quality:85}).toBuffer()).toString('base64'),width:meta.width,height:meta.height});
  }
  const sections=[];
  for(const row of plan.rows){
   const ref=await sharp(Buffer.from(row.criterion.base64,'base64'),{limitInputPixels:16_777_216}).rotate().resize({width:640,height:960,fit:'inside',withoutEnlargement:true}).jpeg({quality:85}).toBuffer();
   sections.push(`<section><h2>${esc(row.criterion.question)}</h2><blockquote>${esc(row.criterion.quote)}</blockquote><p>${esc(row.unitId)} · 核对阶段：${esc(row.criterion.pictureStage??'本段画面')} · ${row.range.join('–')}秒</p><p>按整段及原生文字实例取样，可能包含其他阶段；请逐处查看，不代表该阶段或整段已通过。</p>${row.frames.map(frame=>{const picture=pictures.get(frame)!;return `<div class="pair"><figure><img src="data:image/jpeg;base64,${ref.toString('base64')}" alt="指定参照"><figcaption>指定参照 · ${esc(row.criterion.fileName)} · ${row.criterion.seconds}秒</figcaption></figure><figure><img src="data:image/jpeg;base64,${picture.base64}" alt="实际导出"><figcaption>实际导出 · ${(frame/plan.fps).toFixed(3)}秒 · ${picture.width}×${picture.height}</figcaption></figure></div>`;}).join('')}</section>`);
  }
  if(await io.hash(file)!==videoSha256)throw Error('visual_comparison_export_changed');
  const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>实际画面与参照对照</title><style>body{font:16px/1.6 system-ui;margin:24px auto;padding:0 20px;max-width:1100px;color:#252e29}section{border-top:1px solid #ddd;margin-top:32px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:20px}figure{margin:12px 0}img{width:100%;max-height:720px;object-fit:contain;background:#eee}figcaption,p{color:#647064}blockquote{white-space:pre-wrap}@media(max-width:600px){.pair{gap:8px}}</style><h1>实际画面与参照对照</h1><p>内部视觉证据。逐处核对背景、文字尺度、位置、阴影和短标。尺寸来自截图，样式未做自动识别。图片不能验证声音、动效、完整动作或代表片视频步骤。</p>${sections.join('')}</html>`;
  if(Buffer.byteLength(html)>32_000_000)throw Error('visual_comparison_artifact_limit');
  signal.throwIfAborted();
  await mkdir(root,{recursive:true});
  signal.throwIfAborted();
  await atomicWriteFile(path,html);
  published=true;
  signal.throwIfAborted();
  await atomicWriteFile(metadataPath,JSON.stringify({identity,html_sha256:hash(html)}));
  signal.throwIfAborted();
  return {...result,cached:false};
 }catch(error){
  if(signal.aborted&&published){await rm(path,{force:true});await rm(metadataPath,{force:true});}
  throw error;
 }finally{await rm(work,{recursive:true,force:true});}
}

function waitForEvidence(job:SharedEvidence,signal?:AbortSignal):SharedEvidence['promise']{
 if(signal?.aborted){if(job.waiters===0&&!job.settled)job.controller.abort();return Promise.reject(signal.reason);}
 job.waiters++;
 return new Promise((resolve,reject)=>{
  let detached=false;
  const detach=()=>{
   if(detached)return;detached=true;job.waiters--;signal?.removeEventListener('abort',abort);
   if(job.waiters===0&&!job.settled)job.controller.abort();
  };
  const abort=()=>{detach();reject(signal!.reason);};signal?.addEventListener('abort',abort,{once:true});
  job.promise.then(value=>{detach();resolve(value);},error=>{detach();reject(error);});
 });
}

/** Concurrent reads share bounded local work; brief negative caching avoids poll storms. */
export async function previewVisualEvidence(...args:Parameters<typeof buildPreviewVisualEvidence>):ReturnType<typeof buildPreviewVisualEvidence>{
 args[7]?.throwIfAborted();
 const key=hash(JSON.stringify([...args.slice(0,5),args[6]??reviewBoardArtifactRoot(args[0])]));
 for(const [k,v]of recentFailures)if(v.until<=Date.now())recentFailures.delete(k);
 const failure=recentFailures.get(key);if(failure)throw failure.error;
 const running=pending.get(key);
 if(running){
  if(running.controller.signal.aborted){await running.promise.catch(()=>{});return previewVisualEvidence(...args);}
  return waitForEvidence(running,args[7]);
 }
 const controller=new AbortController(),sharedArgs=[...args] as Parameters<typeof buildPreviewVisualEvidence>;
 sharedArgs[7]=controller.signal;
 const job:SharedEvidence={promise:buildPreviewVisualEvidence(...sharedArgs),controller,waiters:0,settled:false};pending.set(key,job);
 const settled=()=>{job.settled=true;pending.delete(key);};
 void job.promise.then(settled,error=>{
  settled();
  if(!controller.signal.aborted&&['deadline','local_processing_failed'].includes(visualEvidenceFailure(error).code)){
   if(recentFailures.size>=128)recentFailures.delete(recentFailures.keys().next().value!);
   recentFailures.set(key,{until:Date.now()+30_000,error});
  }
 });
 return waitForEvidence(job,args[7]);
}
