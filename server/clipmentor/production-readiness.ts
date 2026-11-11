import {deliverySectionsFromDoc,deliveryAudio} from '../../src/clipmentor/delivery-sections';
import type {ProjectDoc,MediaAsset} from '../../src/editor/types';
import {copyTeachingPacketFromDoc,copyReviewSubject,buildCopyTeachingReviewRequest,checkCopyProduction} from '../../src/clipmentor/production-gate';
import {checkSourceBreakdown} from '../../src/clipmentor/source-breakdown';
import {diffDeliveryCheck} from '../../src/clipmentor/delivery-diff';
import {digestValue} from '../agent-runs/store-values';
import { stat } from 'node:fs/promises';
import { isSafeUploadName, resolveUploadFile } from '../media-dir';
import { sha256File } from '../../shared/node-content-hash';

/** Structural binding only. Neither this nor a successful render certifies teaching quality. */
export async function verifyProductionNarration(doc:ProjectDoc,voice?:{provider:string;voiceId:string}){
 const packet=await copyTeachingPacketFromDoc(doc);
 return [...matchMeasuredNarration(packet.units.flatMap(u=>u.lines),doc.assets,voice,registeredAudioBindings(doc)),...deliverySectionsFromDoc(doc).map(s=>{const a=deliveryAudio(doc,s);return{lineId:s.line.line_id,assetId:a.asset.id,durationSeconds:a.frames/doc.timelines.find(t=>t.id===doc.activeTimelineId)!.fps};})];
}
export async function assertProductionAudioFile(asset:MediaAsset,expectedHash=asset.sourceContentHash){
 const prefix='/media/uploads/';
 const name=asset.src.startsWith(prefix)?asset.src.slice(prefix.length):'';
 const file=isSafeUploadName(name)?resolveUploadFile(name):null;
 if(!file)throw Error('production_audio_file_missing:'+asset.id);
 const info=await stat(file);
 if(!info.isFile()||info.size<=0)throw Error('production_audio_file_invalid:'+asset.id);
 if(expectedHash&&await sha256File(file)!==expectedHash)throw Error('production_audio_file_changed:'+asset.id);
}
export async function verifyProductionNarrationFiles(doc:ProjectDoc,voice?:{provider:string;voiceId:string}){
 const narration=await verifyProductionNarration(doc,voice);
 const bindings=registeredAudioBindings(doc),sections=deliverySectionsFromDoc(doc);
 const checked=new Set<string>();
 for(const {assetId,lineId} of narration){
  const asset=doc.assets.find(a=>a.id===assetId)!;
  const binding=bindings.find(b=>b.lineId===lineId&&b.assetId===assetId);
  const section=sections.find(s=>s.line.line_id===lineId);
  const hash=section?.voice.existing_audio?.sha256??(typeof binding?.audioSha256==='string'?binding.audioSha256:asset.sourceContentHash);
  const identity=JSON.stringify([assetId,hash]);
  if(checked.has(identity))continue;
  await assertProductionAudioFile(asset,hash);
  checked.add(identity);
 }
 return narration;
}
export function registeredAudioBindings(doc:ProjectDoc):Record<string,unknown>[] {
 const bindings:Record<string,unknown>[]=[];
 for(const unit of doc.clipMentorAnalysis?.blueprint??[]){
  const internal=(unit as unknown as Record<string,unknown>).internal_review as Record<string,unknown>|undefined;
  const plan=internal?.[String(internal.current_picture_plan)] as {composition?:{detail?:unknown}}|undefined;
  try{const detail=typeof plan?.composition?.detail==='string'?JSON.parse(plan.composition.detail):null;
   if(Array.isArray(detail?.measured_audio_bindings))bindings.push(...detail.measured_audio_bindings.filter((v:unknown)=>!!v&&typeof v==='object'&&!Array.isArray(v)));
  }catch{/* Malformed or legacy plans do not create an audio binding. */}
 }
 return bindings;
}
export function matchMeasuredNarration(lines:Array<{line_id:string;narration_ms:string}>,assets:MediaAsset[],voice?:{provider:string;voiceId:string},bindings:Record<string,unknown>[]=[]){
 return lines.map(line=>{
  const generated=(a:MediaAsset)=>{
   const g=a.props?.generation as Record<string,unknown>|undefined;
   return a.kind==='audio'&&g?.text===line.narration_ms&&typeof g.durationSeconds==='number'&&Number.isFinite(g.durationSeconds)&&g.durationSeconds>0
    &&g.speed===1&&(!voice||(g.provider===voice.provider&&g.voiceId===voice.voiceId));
  };
  const selected=bindings.filter(b=>b.lineId===line.line_id&&b.text===line.narration_ms);
  if(selected.length){
   const valid=selected.filter(b=>b.playback_rate===1&&b.full_file_untrimmed===true
    &&typeof b.durationSeconds==='number'&&Number.isFinite(b.durationSeconds)&&b.durationSeconds>0
    &&typeof b.audioSha256==='string'&&/^[a-f0-9]{64}$/.test(b.audioSha256)
    &&assets.some(a=>a.kind==='audio'&&a.id===b.assetId&&a.src===b.src&&Number.isSafeInteger(a.durationInFrames)&&a.durationInFrames>0
     &&(!a.sourceContentHash||a.sourceContentHash===b.audioSha256)
     &&(a.props?.generation?generated(a)&&Math.abs(Number((a.props.generation as Record<string,unknown>).durationSeconds)-Number(b.durationSeconds))<0.000001
      :!voice||(b.provider===voice.provider&&b.voiceId===voice.voiceId))));
   if(!valid.length)throw new Error(`Current line has no matching measured normal-speed audio: ${line.line_id}`);
   if(new Set(valid.map(b=>b.assetId)).size>1)throw new Error(`Current line has ambiguous selected audio: ${line.line_id}`);
   return {lineId:line.line_id,assetId:String(valid[0].assetId),durationSeconds:Number(valid[0].durationSeconds)};
  }
  const asset=assets.find(generated);
  if(!asset)throw new Error(`Current line has no matching measured normal-speed audio: ${line.line_id}`);
  return {lineId:line.line_id,assetId:asset.id,durationSeconds:(asset.props!.generation as {durationSeconds:number}).durationSeconds};
 });
}
export async function verifyProductionEditing(doc:ProjectDoc,voice?:{provider:string;voiceId:string}){
 const gate=await checkCopyProduction(doc,'clipmentor');if(!gate.allowed)throw new Error('Current review no longer authorizes editing');
 const binding=checkSourceBreakdown(doc,true);if(binding.status!=='structurally_ready')throw new Error(`Actual sequence mapping incomplete: ${JSON.stringify(binding.issues).slice(0,1600)}`);
 const narration=await verifyProductionNarration(doc,voice),timeline=doc.timelines.find(t=>t.id===doc.activeTimelineId);
 if(!timeline?.items.some(i=>i.kind==='video'))throw new Error('No editable source picture');
 for(const audio of narration){
  const item=timeline.items.find(i=>i.kind==='audio'&&i.sourceAssetId===audio.assetId);
  if(!item||timeline.tracks?.[item.track]?.muted||timeline.tracks?.[item.track]?.hidden||!Number.isFinite(item.volume??1)||(item.volume??1)<=0||(item.playbackRate??1)!==1||(item.srcInFrame??0)!==0||item.durationInFrames/timeline.fps<audio.durationSeconds-1/timeline.fps)
   throw new Error(`Narration missing, muted, accelerated or truncated: ${audio.lineId}`);
 }
 return {narration,binding};
}

/** Operation-local preparation, never retained by document identity or used as an approval.
 * Keep the full executor packet separate from the independently filtered reviewer packet. */
export async function createProductionPreparation(doc:ProjectDoc){
 const check=checkSourceBreakdown(doc);
 if(check.status!=='structurally_ready')throw new Error(`blueprint_stage_incomplete:${JSON.stringify(check.issues).slice(0,1600)}`);
 const subject=await copyReviewSubject(doc),packet=await copyTeachingPacketFromDoc(doc);
 if(packet.units.some(u=>!u.picture_plan?.execution_plan))throw new Error('blueprint_execution_plan_missing');
 // Validate the exact reviewer projection BEFORE any review/model effect is reserved.
 const request=buildCopyTeachingReviewRequest([{case_id:'current',packet}]);
 const reviewed={subject:{revision:subject.revision,digest:subject.digest},packet:request.input.cases[0].packet};
 let bindings:ReturnType<typeof registeredAudioBindings>|undefined;
 const audioBindings=()=>bindings??=registeredAudioBindings(doc);
 return {rawPacket:packet,reviewed,audioBindings,
  readiness:(voice?:{provider:string;voiceId:string})=>preparedBlueprintReadiness(doc,reviewed,voice,audioBindings)};
}

/** Existing public result remains the reviewer projection, not a production approval. */
export async function prepareProductionBlueprint(doc:ProjectDoc){
 return (await createProductionPreparation(doc)).reviewed;
}

/** Structural maturity is not teaching approval, audio capacity or final viewing. */
export async function productionBlueprintReadiness(doc:ProjectDoc|null|undefined,voice?:{provider:string;voiceId:string}){
 const base={complete_film_accepted:false,actual_audio_visual_capacity_verified:false};
 if(!doc)return {...base,next:'blueprint' as const,code:'project_missing',ready:false};
 let prepared:Awaited<ReturnType<typeof createProductionPreparation>>;
 try{prepared=await createProductionPreparation(doc);}catch(error){return {...base,next:'blueprint' as const,code:error instanceof Error?error.message:'blueprint_invalid',ready:false};}
 return prepared.readiness(voice);
}

async function preparedBlueprintReadiness(doc:ProjectDoc,prepared:Awaited<ReturnType<typeof prepareProductionBlueprint>>,voice:{provider:string;voiceId:string}|undefined,audioBindings:()=>ReturnType<typeof registeredAudioBindings>){
 const base={complete_film_accepted:false,actual_audio_visual_capacity_verified:false};
 // Gate evaluation stays live: operation-local derived facts are not approval receipts.
 const gate=await checkCopyProduction(doc,'clipmentor');
 if(!gate.allowed)return {...base,next:'copy_review' as const,code:gate.code,ready:false,subject:prepared.subject};
 const lines=prepared.packet.units.flatMap(u=>u.lines),missing:string[]=[],voiceUnknown:string[]=[],bindings=audioBindings();
 for(const line of lines)try{matchMeasuredNarration([line],doc.assets,voice,bindings);}catch{
  let uncertain=false;
  if(voice)try{const reusable=matchMeasuredNarration([line],doc.assets,undefined,bindings)[0];
   uncertain=bindings.some(b=>b.lineId===line.line_id&&b.assetId===reusable.assetId&&b.provider===undefined&&b.voiceId===undefined);
  }catch{/* No reusable measured audio at all. */}
  (uncertain?voiceUnknown:missing).push(line.line_id);
 }
 for(const section of prepared.packet.delivery_sections??[])try{deliveryAudio(doc,section);}catch{missing.push(section.line.line_id);}
 if(missing.length||voiceUnknown.length)return {...base,next:'audio' as const,code:missing.length?'measured_audio_missing':'audio_voice_provenance_missing',ready:false,subject:prepared.subject,missing_line_ids:missing,unverified_voice_line_ids:voiceUnknown};
 return {...base,next:'edit' as const,code:'reviewed_plan_and_measured_audio_available',ready:true,subject:prepared.subject};
}

function executionCaptionCheck(doc:ProjectDoc,expected:string){
 const timeline=doc.timelines.find(t=>t.id===doc.activeTimelineId);
 const cards:Array<{start:number;text:string}>=[];
 for(const item of timeline?.items??[]){
  if(item.kind!=='motion-graphic'||timeline?.tracks?.[item.track]?.hidden||item.transform?.opacity===0)continue;
  if((item.srcInFrame??0)!==0||(item.playbackRate??1)!==1)return {status:'unverified' as const,reason:'caption_card_clock_unverified'};
  const asset=doc.assets.find(a=>a.id===item.sourceAssetId),props={...asset?.props,...item.props};
  let values:unknown=props.cards;
  try{if(typeof values==='string')values=JSON.parse(values);}catch{return {status:'unverified' as const,reason:'caption_cards_unreadable'};}
  if(!Array.isArray(values))continue;
  for(const card of values){
   const start=Array.isArray(card)?card[0]:card?.start;
   const end=Array.isArray(card)?card[1]:card?.end;
   const text=Array.isArray(card)&&Array.isArray(card[2])?card[2].join(' '):card?.text;
   if(typeof start!=='number'||!Number.isFinite(start)||typeof end!=='number'||!Number.isFinite(end)||start<0||end<=start||end>item.durationInFrames||typeof text!=='string')return {status:'unverified' as const,reason:'caption_card_shape_unknown'};
   cards.push({start:item.startFrame+start,text});
  }
 }
 if(!cards.length)return {status:'unverified' as const,reason:'no_structured_caption_cards'};
 const normalized=(text:string)=>text.replace(/\s+/gu,' ').trim();
 const actual=cards.sort((a,b)=>a.start-b.start).map(c=>c.text).join(' ');
 return {status:normalized(actual)===normalized(expected)?'matches' as const:'mismatch' as const,scope:'structured_card_text_only',card_count:cards.length};
}

/** Saved execution facts, not a self-reported checklist or rendered quality verdict. */
export async function productionExecutionReport(before:ProjectDoc,saved:ProjectDoc,voice?:{provider:string;voiceId:string}){
 const expected=await prepareProductionBlueprint(before),actual=await prepareProductionBlueprint(saved);
 if(expected.subject.digest!==actual.subject.digest)throw new Error('execution_blueprint_changed');
 const audio=await verifyProductionNarration(before,voice);
 const protectedIds=[before.clipMentorAnalysis!.source.asset_id,...audio.map(a=>a.assetId)];
 const identity=(asset:MediaAsset|undefined)=>asset?{id:asset.id,kind:asset.kind,src:asset.src,durationInFrames:asset.durationInFrames,
  sourceContentHash:asset.sourceContentHash,sourceRevision:asset.sourceRevision,generation:asset.props?.generation}:null;
 for(const id of protectedIds)if(digestValue(identity(before.assets.find(a=>a.id===id)))!==digestValue(identity(saved.assets.find(a=>a.id===id))))throw new Error(`execution_media_changed:${id}`);
 const verification=await verifyProductionEditing(saved,voice);
 const diff=await diffDeliveryCheck(before,saved);
 const delivery=expected.packet.delivery_sections??[];
 const expectedCaptions=[...delivery.filter(s=>s.kind==='performance_opening').flatMap(s=>s.line.caption_lines),...expected.packet.units.flatMap(u=>u.lines.flatMap(l=>l.caption_lines)),...delivery.filter(s=>s.kind==='creator_invitation').flatMap(s=>s.line.caption_lines)].join(' ');
 const captions=executionCaptionCheck(saved,expectedCaptions);
 if(captions.status==='mismatch')throw new Error('execution_caption_text_mismatch');
 return {blueprint:expected.subject,narration:verification.narration,actual_source_bindings:verification.binding.bindings,
  differences:diff,captions,remaining_checks:['normal_speed_continuous_viewing','visual_readability','teaching_value','native_language_final_acceptance',...(captions.status==='unverified'?['caption_text_not_mechanically_verified']:[])],complete_film_accepted:false};
}
