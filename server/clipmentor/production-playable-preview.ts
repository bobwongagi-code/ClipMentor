import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {open,stat} from 'node:fs/promises';
import type {BigIntStats} from 'node:fs';
import {promisify} from 'node:util';
import {ffmpegBin} from '../media-binaries';
import {isSafeUploadName,resolveUploadFile} from '../media-dir';
import {parseFrameRate,probeVideo} from '../media-normalization';
import {assertProductionDimensions} from './production-format';
import type {ProductionTask} from './production-task';

const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const positive=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>0;

/** A technically playable export is independent of the content verdict. */
export function pendingProductionPreview(task:ProductionTask){
 if(!['export','self_check'].includes(task.stage)||!['blocked','queued','running'].includes(task.status)||task.completed.self_check)return;
 return productionPreviewBinding(task);
}

export function productionPreviewBinding(task:ProductionTask){
 const exportRecord=task.completed.export?.artifact;
 if(!task.input.panelDelivery||!exportRecord||typeof exportRecord.path!=='string'||!exportRecord.path.startsWith('/media/uploads/')
  ||typeof exportRecord.renderId!=='string'||!exportRecord.renderId||!task.projectRevision
  ||exportRecord.revision!==task.projectRevision||!sha(exportRecord.facts_digest)
  ||!positive(exportRecord.durationSeconds)||!positive(exportRecord.sizeBytes)||!Number.isSafeInteger(exportRecord.sizeBytes))return;
 const name=exportRecord.path.slice('/media/uploads/'.length);
 if(!isSafeUploadName(name))return;

 let hash=exportRecord.videoSha256;
 if(hash===undefined){
  // Older exports did not save a file hash. Only use the durable effect from
  // this export's review epoch, never a receipt from a prior edit.
  const prefix=`self_check:${task.feedbackUsed?'feedback':'initial'}:${task.repairs}:`;
  const hashes=new Set<string>();
  for(const [key,effect] of Object.entries(task.effects)){
   if(!key.startsWith(prefix)||effect.kind!=='preview_review'||effect.status!=='completed')continue;
   const body=(effect.result as {body?:Record<string,unknown>}|undefined)?.body;
   if(body?.projectId===task.projectId&&body.operationId===effect.operationId
    &&body.scope==='rendered_preview_continuous_review'&&body.full_film_accepted===false&&sha(body.videoSha256)
    &&(body.status==='completed'||body.status==='failed'&&body.receipt_persisted===true))hashes.add(body.videoSha256);
  }
  if(hashes.size===1)hash=hashes.values().next().value;
 }
 if(!sha(hash))return;
 return {name,hash,renderId:exportRecord.renderId,duration:exportRecord.durationSeconds,size:exportRecord.sizeBytes,
  width:exportRecord.width,height:exportRecord.height,fps:exportRecord.fps};
}

const verification=new Map<string,Promise<void>>();
const run=promisify(execFile);
const signature=(info:BigIntStats)=>[info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':');

export async function openPendingProductionPreview(binding:NonNullable<ReturnType<typeof pendingProductionPreview>>){
 const file=resolveUploadFile(binding.name);
 if(!file)throw Error('Preview missing');
 const handle=await open(file,'r');
 try{
  const info=await handle.stat({bigint:true}),identity=signature(info);
  if(!info.isFile()||info.size!==BigInt(binding.size))throw Error('pending_preview_file_changed');
  const key=JSON.stringify([file,identity,binding]);
  let inspected=verification.get(key);
  if(!inspected){
   inspected=(async()=>{
    const hash=createHash('sha256');
    for await(const chunk of handle.createReadStream({start:0,autoClose:false}))hash.update(chunk);
    if(hash.digest('hex')!==binding.hash)throw Error('pending_preview_hash_mismatch');
    const media=await probeVideo(file);
    assertProductionDimensions(media,'exported_file');
    const fps=positive(binding.fps)?binding.fps:30;
    const measuredFps=parseFrameRate(media.avgFrameRate)??parseFrameRate(media.nominalFrameRate);
    if(!media.hasAudio||Math.abs(media.duration-binding.duration)>1/fps+0.022
     ||positive(binding.fps)&&(measuredFps===undefined||Math.abs(measuredFps-fps)>.05)
     ||media.width!==binding.width||media.height!==binding.height
     ||(parseFrameRate(media.sampleAspectRatio?.replace(':','/'))??1)!==1)throw Error('pending_preview_media_mismatch');
    await run(ffmpegBin(),['-nostdin','-v','error','-xerror','-threads','2','-i',file,
     '-map','0:v:0','-map','0:a:0','-f','null','-'],{timeout:Math.max(30_000,binding.duration*2000),maxBuffer:128_000});
    if(signature(await stat(file,{bigint:true}))!==identity)throw Error('pending_preview_file_changed');
   })();
   verification.set(key,inspected);
   if(verification.size>32)verification.delete(verification.keys().next().value!);
   const entry=inspected;
   void entry.catch(()=>{if(verification.get(key)===entry)verification.delete(key);});
  }
  await inspected;
  if(signature(await handle.stat({bigint:true}))!==identity)throw Error('pending_preview_file_changed');
  return {file,handle};
 }catch(error){await handle.close();throw error;}
}
