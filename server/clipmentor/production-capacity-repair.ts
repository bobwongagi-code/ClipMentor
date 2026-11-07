import type {ProjectDoc} from '../../src/editor/types';
import {copyTeachingPacketFromDoc} from '../../src/clipmentor/production-gate';
import {digestValue} from '../agent-runs/store-values';
import {verifyProductionNarration} from './production-readiness';

/** Group-level facts for the planner, not a sentence-duration gate or a semantic verdict. */
export async function productionCapacityFacts(doc:ProjectDoc,voice?:{provider:string;voiceId:string}){
 const packet=await copyTeachingPacketFromDoc(doc),audio=await verifyProductionNarration(doc,voice);
 return packet.units.map(unit=>{
  const ranges=unit.picture_plan?.explanation_source_ranges??[];
  let available=0,last=-Infinity;
  for(const [start,end] of [...ranges].sort((a,b)=>a[0]-b[0])){available+=Math.max(0,end-Math.max(start,last));last=Math.max(last,end);}
  const lines=unit.lines.map(line=>({line_id:line.line_id,audio:audio.find(a=>a.lineId===line.line_id)!}));
  return{unit_id:unit.unit_id,lines,measured_audio_seconds:lines.reduce((n,l)=>n+l.audio.durationSeconds,0),
   registered_dynamic_seconds:available,reference_picture_capacity:'not_included_requires_planner_judgment'};
 });
}

/** Restrict this repair to picture plans; copy/CTA and unrelated units stay frozen. */
export function pictureRepairWriteError(doc:ProjectDoc,args:Record<string,unknown>,groups:ReadonlyArray<{unit_id:string}>):string|undefined{
 if(args.action!=='set_picture_plan'||!groups.some(g=>g.unit_id===args.id))return 'picture_repair_only_set_picture_plan_for_affected_unit';
 const unit=doc.clipMentorAnalysis?.blueprint.find(u=>u.unit_id===args.id);
 const internal=(unit as unknown as {internal_review?:Record<string,unknown>})?.internal_review;
 const old=internal?.[String(internal.current_picture_plan)] as Record<string,unknown>|undefined;
 const record=args.record as {plan?:Record<string,unknown>}|undefined;
 if(!old||!record?.plan)return 'picture_repair_current_plan_missing';
 if(digestValue(record.plan.delivery_sections??null)!==digestValue(old.delivery_sections??null))return 'picture_repair_must_preserve_delivery_sections';
 return undefined;
}
