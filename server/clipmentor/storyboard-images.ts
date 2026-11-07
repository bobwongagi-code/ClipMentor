import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ProjectDoc} from '../../src/editor/types';
import type {ClipMentorStoryboard,StoryboardImages} from '../../shared/clipmentor-storyboard';
import {resolveUploadFile} from '../media-dir';
import {sha256File} from '../../shared/node-content-hash';
import {digestValue} from '../agent-runs/store-values';
import {runtimeProfile} from '../runtime-profile';
import {copyReviewDependencies} from './copy-review';
import {acceptExportSubmission} from '../plugins/export-submission';
import {collectExportMediaPlan} from '../../src/export/exportMediaPlan';

type Image=Extract<StoryboardImages['images'][number],{status:'available'}>;
export interface StoryboardImageDependencies {
 resolve:(name:string)=>string|null;hash:(file:string)=>Promise<string>;
 source:(file:string,seconds:number,crop?:{left:number;right:number;top:number;bottom:number})=>Promise<string>;
 actual:(doc:ProjectDoc,frames:number[])=>Promise<Array<{frame:number;base64:string}>>;
}
export function storyboardImageDependencies():StoryboardImageDependencies{
 return{resolve:resolveUploadFile,hash:sha256File,
  async source(file,seconds,crop){const temp=await mkdtemp(join(tmpdir(),'storyboard-source-'));try{return await copyReviewDependencies().frame(file,seconds,join(temp,'frame.jpg'),crop);}finally{await rm(temp,{recursive:true,force:true});}},
  async actual(doc,frames){
   // Reuse the original server render acceptance/materialization boundary, with no cloud fetch/hydration.
   const state=doc.timelines.find(t=>t.id===doc.activeTimelineId);if(!state)throw Error('storyboard_timeline_missing');
   const accepted=await acceptExportSubmission({project:doc,state,timelineId:doc.activeTimelineId},{hydrateUpload:async()=>null,fetcher:async()=>{throw Error('storyboard_local_media_required');}});
   try{const {renderTimelineStills}=await import('../plugins/export-rendering');return await renderTimelineStills({project:accepted.plan.project,state:accepted.plan.state,timelineId:accepted.plan.timelineId,frames});}
   finally{await accepted.cleanup();}
  }};
}

/** Bounded thumbnail cache, never an approval or a replacement for rechecking files/version. */
export function createStoryboardImages(deps:StoryboardImageDependencies=storyboardImageDependencies()){
 const cache=new Map<string,string>();let bytes=0;
 const pending=new Map<string,Promise<string>>();let rendering=false;
 const remember=(key:string,value:string)=>{
  const size=Buffer.byteLength(value);if(size>3_000_000)throw Error('storyboard_image_too_large');
  while(cache.size>=64||bytes+size>24_000_000){const first=cache.keys().next().value;if(!first)break;bytes-=Buffer.byteLength(cache.get(first)!);cache.delete(first);}
  cache.set(key,value);bytes+=size;return value;
 };
 const image=async(key:string,work:()=>Promise<string>)=>{
  const cached=cache.get(key);if(cached){cache.delete(key);cache.set(key,cached);return cached;}
  if(pending.has(key))return pending.get(key)!;
  if(pending.size>=6)throw Error('storyboard_busy');
  const job=work().then(raw=>{if(!raw||!/^\/9j\//.test(raw))throw Error('storyboard_image_invalid');return remember(key,raw);}).finally(()=>pending.delete(key));
  pending.set(key,job);return job;
 };
 return async(doc:ProjectDoc,board:ClipMentorStoryboard,cardId:string,part:'source'|'actual',offset:number):Promise<StoryboardImages>=>{
  const card=board.cards.find(c=>c.id===cardId);if(!card)throw Error('storyboard_card_missing');
  const refs=part==='source'?card.source:card.actual;
  if(!Number.isSafeInteger(offset)||offset<0||(refs.length?offset>=refs.length:offset!==0))throw Error('storyboard_offset_invalid');
  const page=refs.slice(offset,offset+6),images:StoryboardImages['images']=[];
  const hashes=new Map<string,Promise<string>>();
  const checked=new Map<string,string>();
  const check=async(src:string,expected:string|undefined)=>{
   if(!src?.startsWith('/media/uploads/')||!expected||!/^[a-f0-9]{64}$/.test(expected))throw Error('storyboard_media_identity_missing');
   const file=deps.resolve(src.slice('/media/uploads/'.length));if(!file)throw Error('storyboard_media_missing');
   if(!hashes.has(file))hashes.set(file,deps.hash(file));
   if(await hashes.get(file)!==expected)throw Error('storyboard_media_changed');checked.set(file,expected);return file;
  };
  const stillSame=async()=>{for(const [file,expected]of checked)if(await deps.hash(file)!==expected)throw Error('storyboard_media_changed');};
  const actualKey=(r:typeof card.actual[number])=>digestValue({profile:runtimeProfile().rootDir,project:board.project_id,render:r.key});
  let actualFailure:string|undefined;
  if(part==='actual'&&page.length)try{
   const media=collectExportMediaPlan({...doc,activeTimelineId:board.timeline_id});
   if(media.issues.length)throw Error('storyboard_actual_media_unavailable');
   for(const reference of media.references){
    if(reference.source.startsWith('data:'))continue;
    const asset=doc.assets.find(a=>a.id===reference.assetId)||doc.assets.find(a=>a.src===reference.source);
    const item=doc.timelines.find(t=>t.id===reference.timelineId)?.items.find(i=>i.id===reference.itemId);
    await check(reference.source,asset?.sourceContentHash??item?.sourceContentHash);
   }
  }catch{actualFailure='storyboard_actual_media_unavailable';}
  if(part==='actual'&&!actualFailure){
   const missing=(page as typeof card.actual).filter(r=>!cache.has(actualKey(r)));
   if(missing.length){
    if(rendering)actualFailure='storyboard_busy';
    else{rendering=true;try{
     const result=await deps.actual(doc,missing.map(r=>r.frame));
     if(result.length!==missing.length||result.some((r,i)=>r.frame!==missing[i].frame||!r.base64.startsWith('/9j/')))throw Error('storyboard_actual_frame_mismatch');
     await stillSame();
     for(const [i,r]of missing.entries())remember(actualKey(r),result[i].base64);
    }catch{actualFailure='storyboard_frame_unavailable';}finally{rendering=false;}}
   }
  }
  for(const ref of page){
   try{
    let value:Image;
    if(part==='source'){
     const r=ref as typeof card.source[number],asset=doc.assets.find(a=>a.id===r.asset_id);
     if(!asset)throw Error('storyboard_media_missing');const file=await check(asset.src,asset.sourceContentHash);
     const key=digestValue({profile:runtimeProfile().rootDir,hash:asset.sourceContentHash,seconds:r.source_seconds,crop:r.crop,extractor:'source-frame-v1'});
     const base64=await image(key,async()=>{const raw=await deps.source(file,r.source_seconds,r.crop);await stillSame();return raw;});
     value={key:r.key,status:'available',media_type:'image/jpeg',base64,source_seconds:r.source_seconds,origin:r.origin};
    }else{
     if(actualFailure)throw Error(actualFailure);
     const r=ref as typeof card.actual[number],base64=cache.get(actualKey(r));if(!base64)throw Error('storyboard_frame_unavailable');
     value={key:r.key,status:'available',media_type:'image/jpeg',base64,frame:r.frame};
    }
    images.push(value);
   }catch(error){
    const allowed=['storyboard_media_identity_missing','storyboard_media_missing','storyboard_media_changed','storyboard_actual_media_unavailable','storyboard_busy'];
    const reason=error instanceof Error&&allowed.includes(error.message)?error.message:'storyboard_frame_unavailable';
    images.push({key:ref.key,status:'unavailable',reason});
   }
  }
  return{digest:board.digest,card_id:cardId,part,offset,next_offset:offset+page.length<refs.length?offset+page.length:null,images,authority:'sampled_images_not_continuous_review'};
 };
}
