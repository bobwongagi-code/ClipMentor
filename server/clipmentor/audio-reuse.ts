import type {ProjectDoc,MediaAsset} from '../../src/editor/types';
import {registeredAudioBindings} from './production-readiness';
import {deliveryAudio,deliverySectionsFromDoc} from '../../src/clipmentor/delivery-sections';

type Row=Record<string,unknown>;
type ReuseResult={status:'reusable';asset:MediaAsset;durationSeconds:number;reused:true}
 |{status:'missing'|'unverified'|'conflict';reason:string;asset_ids:string[]};
const defaults={speed:1,pitch:0,volume:1,languageBoost:'auto',sampleRate:32000,channel:1,audioFormat:'mp3'};
/** Missing files and unknown/conflicting selected provenance are different outcomes.
 * Only `missing` permits the caller to spend a new synthesis effect. */
export function reusableVoiceForRequest(doc:ProjectDoc,args:Row):ReuseResult{
 const requested:Row={...defaults,...args,speed:args.speedRatio??args.speed??1};
 const keys=['provider','voiceId',...Object.keys(defaults)];
 // Subtitle requests do not change speech. Reuse same audio even if its word timing is unavailable;
 // never spend another synthesis merely to obtain missing timing metadata.
 const extra=Object.keys(args).some(k=>!keys.includes(k)&&!['text','name','projectId','operationId','speedRatio','subtitleEnable','subtitleType'].includes(k));
 const bound=registeredAudioBindings(doc).filter(b=>b.text===args.text&&typeof b.assetId==='string');
 const sections=deliverySectionsFromDoc(doc).filter(s=>s.line.narration_ms===args.text);
 const selected=new Set(bound.map(b=>String(b.assetId)));
 for(const section of sections){
  // Only an explicit selection is required to exist. Unbound delivery lines
  // may be awaiting their first synthesis; generated candidates are checked below.
  if(!section.voice.existing_audio)continue;
  try{selected.add(deliveryAudio(doc,section).asset.id);}catch{return{status:'conflict',reason:'selected_delivery_audio_missing_or_invalid',asset_ids:[]};}
 }
 if(selected.size>1)return{status:'conflict',reason:'selected_audio_ambiguous',asset_ids:[...selected]};
 const candidates:Array<{asset:MediaAsset;meta:Row;bound?:Row}>=[];
 for(const asset of doc.assets){
  if(asset.kind!=='audio'||selected.size&&!selected.has(asset.id))continue;
  const registered=bound.find(b=>b.assetId===asset.id),section=sections.find(s=>s.voice.existing_audio?.assetId===asset.id);
  const generation=asset.props?.generation as Row|undefined;
  if(registered){
   const sha=registered.audioSha256;
   if(registered.src!==asset.src||registered.playback_rate!==1||registered.full_file_untrimmed!==true
    ||typeof sha!=='string'||!/^[a-f0-9]{64}$/.test(sha)||asset.sourceContentHash&&asset.sourceContentHash!==sha)
    return{status:'conflict',reason:'selected_audio_binding_invalid',asset_ids:[asset.id]};
  }
  if(section?.voice.existing_audio&&asset.sourceContentHash&&asset.sourceContentHash!==section.voice.existing_audio.sha256)return{status:'conflict',reason:'selected_delivery_audio_hash_conflict',asset_ids:[asset.id]};
  const meta=generation??registered??(section?{...section.voice,...section.voice.existing_audio}:undefined);
  if(meta&&(meta.text===args.text||selected.has(asset.id)))candidates.push({asset,meta,bound:registered});
 }
 if(selected.size&&!candidates.length)return{status:'conflict',reason:'selected_audio_missing_or_provenance_invalid',asset_ids:[...selected]};
 const unknown:string[]=[];
 for(const {asset,meta,bound:binding} of candidates){
  if(meta.text!==args.text){if(selected.size)return{status:'conflict',reason:'selected_audio_text_conflict',asset_ids:[asset.id]};continue;}
  const mismatch=keys.find(k=>meta[k]!==undefined&&meta[k]!==requested[k]);
  if(mismatch){if(selected.size)return{status:'conflict',reason:`selected_audio_configuration_conflict:${mismatch}`,asset_ids:[asset.id]};continue;}
  const fps=doc.timelines.find(t=>t.id===doc.activeTimelineId)?.fps;
  const duration=meta.durationSeconds;
  if(!fps||typeof duration!=='number'||!Number.isFinite(duration)||duration<=0||Math.abs(asset.durationInFrames-duration*fps)>1
   ||binding&&(typeof binding.durationSeconds!=='number'||Math.abs(asset.durationInFrames-binding.durationSeconds*fps)>1)){
   if(selected.size)return{status:'conflict',reason:'selected_audio_measurement_invalid',asset_ids:[asset.id]};unknown.push(asset.id);continue;
  }
  if(extra||keys.some(k=>meta[k]===undefined)){unknown.push(asset.id);continue;}
  return{status:'reusable',asset,durationSeconds:duration,reused:true};
 }
 return unknown.length?{status:'unverified',reason:'existing_audio_configuration_unverified',asset_ids:unknown}
  :{status:'missing',reason:'no_matching_audio',asset_ids:[]};
}
