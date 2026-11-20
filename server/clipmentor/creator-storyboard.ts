import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import type {AnalysisEvidence,ClipMentorAnalysis} from '../../src/clipmentor/analysis';
import type {ProjectDoc} from '../../src/editor/types';
import {sha256File} from '../../shared/node-content-hash';
import {sourceFrameSeekMs} from '../../shared/source-frame-seek';
import {resolveUploadFile,isSafeUploadName} from '../media-dir';
import {resolveProductAsset} from '../product-assets';
import {extractOneFrame} from '../plugins/extract-frames';
import {runtimeProfile} from '../runtime-profile';
import {readSourceVideoReceipt} from './source-video';
import {loadCreatorStoryboardDocument,type CreatorStoryboardDocument} from './creator-storyboard-document';
import {creatorDocumentHtml,renderCreatorDocument} from './creator-storyboard-pdf';

const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');

/** The creator document describes the source, independently of selected teaching windows. */
export function creatorStoryboardSource(doc:ProjectDoc){
 const a=doc.clipMentorAnalysis,s=a?.source;
 if(!a||!s?.sourceContentHash||!/^[a-f0-9]{64}$/.test(s.sourceContentHash)||!Number.isFinite(s.duration_seconds)||s.duration_seconds<=0||!Number.isFinite(s.fps)||s.fps<=0)
  throw Error('storyboard_original_plan_missing');
 return {title:a.product.name,source:s};
}

/** A local frame proves provenance and timing only. Spoken claims still use
 * the saved continuous-audio evidence path below. */
function visibleStoryboardFrameBound(analysis:ClipMentorAnalysis,evidence:AnalysisEvidence,document:CreatorStoryboardDocument){
 if(evidence.kind!=='visible_action'||evidence.status!=='agent_observed_candidate'||evidence.call_status!=='unknown'
  ||evidence.observation_method!=='main_agent_direct_image_read_not_independently_verified'
  ||!evidence.supporting_evidence_ids.length||!evidence.source_range_seconds)return false;
 const observation=analysis.observations?.find(record=>record.observation_id===evidence.observation_id);
 if(observation?.status!=='images_returned'||observation.source_hash!==analysis.source.sourceContentHash)return false;
 const [start,end]=evidence.source_range_seconds;
 const frames=evidence.supporting_evidence_ids.map(id=>{
  const frame=analysis.evidence.find(entry=>entry.evidence_id===id);
  const n=frame?.source_frame;
  if(!frame||n===undefined||!Number.isSafeInteger(n)||n<0||frame.kind!=='source_frame'||frame.call_status!=='succeeded'
   ||frame.observation_method!=='local_frame_extraction_only'||frame.observation_id!==observation.observation_id
   ||!observation.frame_evidence_ids.includes(id)||id!==observation.observation_id+':f'+n)return;
  const seconds=n/analysis.source.fps;
  if(seconds<start||seconds>end||seconds>=analysis.source.duration_seconds||frame.time_seconds!==seconds
   ||!observation.requested_times_seconds.includes(seconds))return;
  return n;
 });
 return frames.every(n=>n!==undefined)&&document.rows.filter(row=>row.visible_evidence_ids.includes(evidence.evidence_id))
  .every(row=>row.source_frames.some(n=>frames.includes(n)));
}

export async function verifyCreatorStoryboardEvidence(doc:ProjectDoc,signal?:AbortSignal){
 signal?.throwIfAborted();
 const model=creatorStoryboardSource(doc),asset=doc.assets.find(a=>a.id===model.source.asset_id);
 const document=await loadCreatorStoryboardDocument(doc);
 const receipts=new Map<string,Awaited<ReturnType<typeof readSourceVideoReceipt>>>();
 const ids=new Set(document.rows.flatMap(r=>[...r.visible_evidence_ids,...r.claim_evidence_ids]));
 const originalEvidence=doc.clipMentorAnalysis!.evidence.filter(e=>ids.has(e.evidence_id));
 for(const evidence of originalEvidence){
  const equivalent=doc.clipMentorAnalysis!.evidence.filter(e=>e.kind===evidence.kind&&e.text===evidence.text&&e.call_status!=='failed'
   &&JSON.stringify(e.source_range_seconds)===JSON.stringify(evidence.source_range_seconds));
  const text=evidence.observation_method==='saved_source_video_model_receipt'
   ?evidence.text.replace(/^模型听音记录（可能含概述，非逐字核准）：/u,''):evidence.text;
  const claim={range:evidence.source_range_seconds!,text,sourceIds:[...new Set(equivalent.flatMap(e=>e.source_ids))]};
  const directory=join(runtimeProfile().rootDir,'clipmentor-source-video');
  const normal=(text:string)=>text.normalize('NFKC').replace(/…/g,'...').replace(/\s+/g,' ').trim();
  let verified=false;
  for(const id of claim.sourceIds){
   if(id===model.source.asset_id||!/^[a-zA-Z0-9_-]{1,160}$/.test(id))continue;
   let receipt=receipts.get(id);
   try{if(!receipt){const record=JSON.parse(await readFile(join(directory,id+'.json'),'utf8'));receipt=await readSourceVideoReceipt(id,record.projectId,{directory});receipts.set(id,receipt);}}
   catch{continue;} // Sources are an unordered set; one bad reference cannot hide a valid receipt.
   if(receipt.source_hash!==model.source.sourceContentHash||receipt.result?.validation.status!=='valid')continue;
   if(receipt.result.raw_observation.windows.flatMap(w=>w.evidence).some(e=>Math.abs(e.start_seconds-claim.range[0])<.01
    &&Math.abs(e.end_seconds-claim.range[1])<.01&&normal(evidence.kind==='visible_action'?e.visible:e.audible).includes(normal(claim.text)))){verified=true;break;}
  }
  if(!verified&&!visibleStoryboardFrameBound(doc.clipMentorAnalysis!,evidence,document))throw Error(`storyboard_original_excerpt_changed:${evidence.evidence_id}`);
 }
 const name=asset?.src.startsWith('/media/uploads/')?asset.src.slice('/media/uploads/'.length):'';
 const file=asset?.kind==='video'&&isSafeUploadName(name)?resolveUploadFile(name):null;
 if(!file||asset?.sourceContentHash!==model.source.sourceContentHash||await sha256File(file)!==model.source.sourceContentHash)
  throw Error('storyboard_original_source_changed');
 signal?.throwIfAborted();
 return {model,document,file};
}

const running=new Map<string,Promise<{bytes:Buffer;preview:Buffer;pages:number}>>();
/** Content-addressed reuse; callers still recheck actual source bytes before using cached output. */
export async function creatorStoryboard(doc:ProjectDoc,signal?:AbortSignal){
 signal?.throwIfAborted();
 const {model,document,file}=await verifyCreatorStoryboardEvidence(doc,signal);
 const binding=JSON.stringify({model,document});
 const logo=resolveProductAsset('clipmentor/rootify-logo.png');
 if(!logo)throw Error('storyboard_logo_unavailable');
 const logoBytes=await readFile(logo),key=hash(JSON.stringify({version:2,model,document,logo:hash(logoBytes)}));
 let job=running.get(key);
 if(!job){
  job=(async()=>{
   const deadline=AbortSignal.timeout(45_000);
   const work=await mkdtemp(join(tmpdir(),'clipmentor-creator-storyboard-'));
   try{
    const images:string[][]=[];
    for(const [index,row]of document.rows.entries()){
     const frames:string[]=[];
     for(const [j,frameNumber]of row.source_frames.entries()){
      deadline.throwIfAborted();
      const frame=join(work,`${index}-${j}.jpg`);
      await extractOneFrame(file,sourceFrameSeekMs(frameNumber/model.source.fps*1000),frame,true,undefined,deadline);
      frames.push('data:image/jpeg;base64,'+(await readFile(frame)).toString('base64'));
     }
     images.push(frames);
    }
    if(await sha256File(file)!==model.source.sourceContentHash)throw Error('storyboard_original_source_changed');
     const logoImage=await sharp(logoBytes).trim().png().toBuffer();
    const html=creatorDocumentHtml(model.title,document,images,'data:image/png;base64,'+logoImage.toString('base64'));
    const result=await renderCreatorDocument(html,deadline);
    // Source identity is rechecked independently for each subscriber below.
    return {...result,pages:Math.ceil(document.rows.length/3)};
   }finally{await rm(work,{recursive:true,force:true});}
  })();
  running.set(key,job);
  void job.catch(()=>{if(running.get(key)===job)running.delete(key);});
  if(running.size>8)running.delete(running.keys().next().value!);
 }
 const result=!signal?await job:await new Promise<Awaited<typeof job>>((resolve,reject)=>{
  const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};
  signal.addEventListener('abort',abort,{once:true});
  job.then(v=>{signal.removeEventListener('abort',abort);resolve(v);},e=>{signal.removeEventListener('abort',abort);reject(e);});
  if(signal.aborted)abort();
 });
 const verified=await verifyCreatorStoryboardEvidence(doc,signal);
 if(JSON.stringify({model:verified.model,document:verified.document})!==binding)throw Error('storyboard_original_excerpt_changed');
 return result;
}
