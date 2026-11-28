import {checkSourceBreakdown,contiguousPlaybackRuns,nativeExecutionMapping} from '../../src/clipmentor/source-breakdown';
import {deliverySectionsFromDoc} from '../../src/clipmentor/delivery-bindings';
import type {ProjectDoc} from '../../src/editor/types';
import type {ProductionTask} from './production-task';
import {copyTeachingPacketFromDoc,copyReviewSubject} from '../../src/clipmentor/production-gate';
import {revisionOf} from '../../src/agent/external-edit-session';
import {productionPreviewFacts,previewFactsDigest,assertPreviewExportBinding} from './production-preview-facts';

type Row=Record<string,unknown>;
const row=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v);

/** Display-only author summary. Never replace the operator's raw task/review requirements. */
export function bindBlueprintFeedbackSummary(task:ProductionTask,source:string,points:unknown){
 if(!source.trim()||source!==task.blueprintFeedback||!Array.isArray(points)||!points.length||points.length>6
  ||!points.every((point):point is string=>typeof point==='string'&&!!point.trim()&&point.trim().length<=150&&!/[\r\n]/.test(point))
  ||new Set(points.map(point=>point.trim())).size!==points.length||points.join('').length>600)return false;
 task.blueprintFeedbackSummary={sourceDigest:previewFactsDigest(source),points:points.map(point=>point.trim())};return true;
}
export function blueprintFeedbackPoints(task:ProductionTask){
 const raw=task.blueprintFeedback,summary=task.blueprintFeedbackSummary;if(!raw)return [];
 if(summary?.sourceDigest===previewFactsDigest(raw)){
  const check={...task};if(bindBlueprintFeedbackSummary(check,raw,summary.points))return [...summary.points];
 }
 // Already concise feedback needs no model rewriting. Long speech is never truncated into a fake summary.
 return raw.length<=100&&!/[\r\n]/.test(raw)?[raw]:[];
}
export function captureBlueprintFeedbackSummary(task:ProductionTask,source:string|undefined,reply:string){
 if(!source)return false;
 const blocks=[...reply.matchAll(/<feedback_summary>\s*([\s\S]*?)\s*<\/feedback_summary>/g)];
 if(!blocks.length)return false;
 try{return bindBlueprintFeedbackSummary(task,source,JSON.parse(blocks.at(-1)![1]));}catch{return false;}
}
export interface ProductionFeedbackInput {
 text:string;kind:'content'|'execution';
 preview:{revision:string;renderId:string;facts_digest:string;timelineId:string};
 unit_ids:string[];item_ids:string[];output_range_seconds?:[number,number];
}
/** Selection is editor state, not a change to the rendered preview. All other saved data remain bound. */
export function feedbackProjectDigest(doc:ProjectDoc){
 return previewFactsDigest({...doc,timelines:doc.timelines.map(t=>({...t,selectedId:null,selectedIds:[]}))});
}
export function matchesExportedPreviewProject(exported:Record<string,unknown>|undefined,saved:{revision:string;doc:ProjectDoc}){
 return !!exported && (typeof exported.feedback_project_digest==='string'
  ? feedbackProjectDigest(saved.doc)===exported.feedback_project_digest : saved.revision===exported.revision);
}
export async function productionFeedbackAnchor(task:ProductionTask,doc:ProjectDoc){
 const t=doc.timelines.find(t=>t.id===doc.activeTimelineId);if(!t)throw new Error('feedback_timeline_missing');
 const exported=task.completed.export?.artifact;
 const revision=revisionOf(doc);
 const unchanged=exported?.feedback_project_digest===feedbackProjectDigest(doc);
 let factsDigest:string;
 if(unchanged&&typeof exported?.revision==='string'&&typeof exported.facts_digest==='string'&&/^[a-f0-9]{64}$/.test(exported.facts_digest)){
  // The complete saved project (apart from editor selection) is stronger than a
  // freshly derived projection. Algorithm upgrades must not stale an unchanged preview.
  factsDigest=exported.facts_digest;
 }else{
  const packet=await copyTeachingPacketFromDoc(doc),facts=productionPreviewFacts(doc,t,packet);
  assertPreviewExportBinding(exported,revision,facts);factsDigest=previewFactsDigest(facts);
 }
 if(typeof exported?.renderId!=='string')throw new Error('feedback_render_missing');
 return{saved_revision:revision,preview:{revision:String(exported.revision),renderId:exported.renderId,facts_digest:factsDigest,timelineId:t.id},blueprint:await copyReviewSubject(doc)};
}
type FrameRange=[number,number];
const contained=(ranges:FrameRange[],item:{startFrame:number;durationInFrames:number})=>
 ranges.some(([start,end])=>item.startFrame>=start&&item.startFrame+item.durationInFrames<=end);

/** Bind once against the actual exported snapshot, before a feedback checkpoint is changed. */
export async function bindProductionFeedback(task:ProductionTask,doc:ProjectDoc,input:unknown){
 if(!row(input)||Object.keys(input).some(k=>!['text','kind','preview','unit_ids','item_ids','output_range_seconds'].includes(k))||typeof input.text!=='string'||!input.text.trim()||input.text.length>8000
  ||!['content','execution'].includes(String(input.kind))||!row(input.preview)
  ||!Array.isArray(input.unit_ids)||!Array.isArray(input.item_ids)
  ||![...input.unit_ids,...input.item_ids].every(x=>typeof x==='string'&&x.trim())
  ||new Set(input.unit_ids).size!==input.unit_ids.length||new Set(input.item_ids).size!==input.item_ids.length)throw new Error('feedback_binding_required');
 const bound=await productionFeedbackAnchor(task,doc);
 const preview=input.preview;
 if(Object.keys(preview).length!==4||Object.entries(bound.preview).some(([k,v])=>preview[k]!==v))throw new Error('feedback_preview_stale');
 const t=doc.timelines.find(t=>t.id===doc.activeTimelineId)!;
 const units=doc.clipMentorAnalysis!.source_breakdown!.units;
 const unitIds=input.unit_ids as string[];
 if(unitIds.some(id=>!units.some(u=>u.unit_id===id))||input.item_ids.some(id=>!t.items.some(i=>i.id===id)))throw new Error('feedback_target_missing');
 const ids=new Set<string>(input.item_ids as string[]);
 const ranges:FrameRange[]=[];
 const requested=input.output_range_seconds;
 if(requested!==undefined){
  const frames=t.items.reduce((end,item)=>Math.max(end,item.startFrame+item.durationInFrames),0);
  if(input.kind!=='execution'||input.unit_ids.length||input.item_ids.length||!Array.isArray(requested)||requested.length!==2
   ||!requested.every(n=>typeof n==='number'&&Number.isFinite(n))||requested[0]<0||requested[1]>frames/t.fps||requested[1]<=requested[0])
   throw new Error('feedback_range_binding_invalid');
  ranges.push([Math.ceil(requested[0]*t.fps-1e-6),Math.floor(requested[1]*t.fps+1e-6)]);
 }
 const mapping=units.some(unit=>!unit.placement)&&unitIds.length?nativeExecutionMapping(doc):undefined;
 const exact=new Map<string,FrameRange[]>();
 if(mapping&&units.some(unit=>!unit.placement&&!mapping.teachingPhases[unit.unit_id])){
  if(checkSourceBreakdown(doc,true,exact).issues.length)exact.clear();
 }
 const windowsFor=(unit:typeof units[number]):FrameRange[]=>{
  if(unit.placement?.timeline_id===t.id)return [unit.placement.original_frames,unit.placement.explanation_frames];
  const native=mapping?.teachingPhases[unit.unit_id];
  return native&&!mapping?.issues.length?[...native.original,...native.explanation]:exact.get(unit.unit_id)??[];
 };
 for(const id of unitIds){
  const windows=windowsFor(units.find(unit=>unit.unit_id===id)!);
  if(!windows.length)throw new Error('feedback_unit_placement_missing');
  ranges.push(...contiguousPlaybackRuns(windows,0));
 }
 if(unitIds.length&&units.filter(unit=>!unitIds.includes(unit.unit_id)).some(unit=>
  windowsFor(unit).some(([start,end])=>ranges.some(([a,b])=>start<b&&end>a))))
  throw new Error('feedback_scope_group_overlap');
 // Shared overlays can span several groups. Do not widen the user's selection.
 for(const item of t.items)if(contained(ranges,item))ids.add(item.id);
 if(input.kind==='execution'&&!ids.size)
  throw new Error(requested===undefined?'feedback_execution_targets_required':'feedback_range_targets_required');
 return {text:input.text,kind:input.kind,preview:bound.preview,saved_revision:bound.saved_revision,blueprint:{revision:bound.blueprint.revision,digest:bound.blueprint.digest},
  unit_ids:unitIds,item_ids:[...ids],output_frames:ranges,authority:'final_feedback_not_new_content_approval'};
}
export function assertLocalFeedbackPreservation(before:ProjectDoc,after:ProjectDoc,feedback:Row|undefined){
 if(!feedback)return;
 const execution=feedback.kind==='execution',groups=Array.isArray(feedback.unit_ids)?feedback.unit_ids:[];
 if(!execution&&!groups.length)return;
 if(!Array.isArray(feedback.item_ids)||!row(feedback.preview)||feedback.preview.timelineId!==before.activeTimelineId
  ||(execution?!feedback.item_ids.length:!Array.isArray(feedback.output_frames)||!feedback.output_frames.length))throw new Error('feedback_scope_missing');
 const allowed=new Set(feedback.item_ids),ranges=(feedback.output_frames??[]) as FrameRange[];
 const envelope=(doc:ProjectDoc)=>{const {timelines:_timelines,assets:_assets,clipMentorAnalysis:_analysis,...rest}=doc;return rest;};
 const same=(a:unknown,b:unknown)=>previewFactsDigest(a)===previewFactsDigest(b);
 if(!same(envelope(before),envelope(after)))throw new Error('feedback_changed_project_context');
 if(execution){
  if(!same(before.clipMentorAnalysis,after.clipMentorAnalysis))throw new Error('feedback_execution_cannot_change_blueprint');
 }else{
  const prior=before.clipMentorAnalysis,current=after.clipMentorAnalysis;
  const protectedUnits=(analysis:typeof prior)=>analysis?.blueprint.filter(unit=>!groups.includes(unit.unit_id));
  if(!same(prior?.blueprint.map(unit=>unit.unit_id),current?.blueprint.map(unit=>unit.unit_id))
   ||!same(protectedUnits(prior),protectedUnits(current))
   ||!same(prior?.source_breakdown,current?.source_breakdown)
   ||!same(deliverySectionsFromDoc(before),deliverySectionsFromDoc(after)))
   throw new Error('feedback_changed_unaffected_blueprint');
  if(prior?.evidence.some(e=>!same(e,current?.evidence.find(other=>other.evidence_id===e.evidence_id))))
   throw new Error('feedback_changed_source_evidence');
 }
 const scoped=(i:ProjectDoc['timelines'][number]['items'][number])=>execution?allowed.has(i.id):contained(ranges,i);
 const strip=(doc:ProjectDoc)=>doc.timelines.map(t=>({...t,selectedId:null,selectedIds:[],items:t.items.filter(i=>!(t.id===before.activeTimelineId&&scoped(i)))}));
 if(!same(strip(before),strip(after)))throw new Error('feedback_changed_unaffected_timeline');
 const next=after.timelines.find(t=>t.id===before.activeTimelineId);
 if(execution&&(!next||[...allowed].some(id=>!next.items.some(i=>i.id===id))))throw new Error('feedback_local_item_removed');
 if(execution&&ranges.length&&next?.items.some(item=>allowed.has(item.id)&&!contained(ranges,item)))
  throw new Error('feedback_scope_item_moved_outside');
 const referenced=new Set(strip(after).flatMap(t=>t.items.map(i=>i.sourceAssetId)));
 for(const asset of before.assets)if((referenced.has(asset.id)||execution&&asset.kind!=='motion-graphic')
   &&!same(asset,after.assets.find(a=>a.id===asset.id)))throw new Error('feedback_changed_shared_asset:'+asset.id);
}
