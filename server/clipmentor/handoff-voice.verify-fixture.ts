import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {MediaAsset,ProjectDoc} from '../../src/editor/types';
import {checkCopyProduction,copyReviewSubject,copyTeachingPacketFromDoc} from '../../src/clipmentor/production-gate';

/** Replace historical audio references only in a cloned, offline fixture. */
export async function materializeHandoffVoice(doc:ProjectDoc,asset:MediaAsset,mediaDir:string){
 const bytes=Buffer.from('fixture voice bytes');
 const name=`handoff-voice-${randomUUID()}.mp3`,file=join(mediaDir,name);
 const oldSrc=asset.src;
 asset.src=`/media/uploads/${name}`;
 asset.sourceContentHash=createHash('sha256').update(bytes).digest('hex');
 for(const timeline of doc.timelines)for(const item of timeline.items){
  if(item.kind==='audio'&&item.src===oldSrc)item.src=asset.src;
 }
 for(const unit of doc.clipMentorAnalysis!.blueprint){
  const internal=unit.internal_review as Record<string,unknown>;
  const plan=internal[String(internal.current_picture_plan)] as {composition?:{detail?:string}};
  if(typeof plan?.composition?.detail!=='string')continue;
  const detail=JSON.parse(plan.composition.detail);
  for(const binding of detail.measured_audio_bindings??[]){
   if(binding.assetId!==asset.id)continue;
   binding.src=asset.src;
   binding.audioSha256=asset.sourceContentHash;
  }
  plan.composition.detail=JSON.stringify(detail);
 }
 const receipt=doc.clipMentorAnalysis!.production_copy_review!;
 receipt.content_digest=(await copyReviewSubject(doc)).digest;
 receipt.teaching_review!.packet=await copyTeachingPacketFromDoc(doc);
 assert.equal((await checkCopyProduction(doc,'clipmentor')).allowed,true);
 await mkdir(mediaDir,{recursive:true});
 await writeFile(file,bytes);
 return {file,bytes};
}
