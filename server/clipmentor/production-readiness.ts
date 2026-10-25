import type {ProjectDoc,MediaAsset} from '../../src/editor/types';
import {copyTeachingPacketFromDoc,checkCopyProduction} from '../../src/clipmentor/production-gate';
import {checkSourceBreakdown} from '../../src/clipmentor/source-breakdown';

/** Structural binding only. Neither this nor a successful render certifies teaching quality. */
export async function verifyProductionNarration(doc:ProjectDoc,voice?:{provider:string;voiceId:string}){
 const packet=await copyTeachingPacketFromDoc(doc);
 return matchMeasuredNarration(packet.units.flatMap(u=>u.lines),doc.assets,voice);
}
export function matchMeasuredNarration(lines:Array<{line_id:string;narration_ms:string}>,assets:MediaAsset[],voice?:{provider:string;voiceId:string}){
 return lines.map(line=>{
  const asset=assets.find(a=>{
   const g=a.props?.generation as Record<string,unknown>|undefined;
   return a.kind==='audio'&&g?.text===line.narration_ms&&typeof g.durationSeconds==='number'&&Number.isFinite(g.durationSeconds)&&g.durationSeconds>0
    &&g.speed===1&&(!voice||(g.provider===voice.provider&&g.voiceId===voice.voiceId));
  });
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
  if(!item||(item.volume??1)<=0||(item.playbackRate??1)!==1||(item.srcInFrame??0)!==0||item.durationInFrames/timeline.fps<audio.durationSeconds-1/timeline.fps)
   throw new Error(`Narration missing, muted, accelerated or truncated: ${audio.lineId}`);
 }
 return {narration,binding};
}
