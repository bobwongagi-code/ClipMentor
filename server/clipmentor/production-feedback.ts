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
 unit_ids:string[];item_ids:string[];
}
/** Selection is editor state, not a change to the rendered preview. All other saved data remain bound. */
export function feedbackProjectDigest(doc:ProjectDoc){
 return previewFactsDigest({...doc,timelines:doc.timelines.map(t=>({...t,selectedId:null,selectedIds:[]}))});
}
export async function productionFeedbackAnchor(task:ProductionTask,doc:ProjectDoc){
 const t=doc.timelines.find(t=>t.id===doc.activeTimelineId);if(!t)throw new Error('feedback_timeline_missing');
 const packet=await copyTeachingPacketFromDoc(doc),facts=productionPreviewFacts(doc,t,packet),exported=task.completed.export?.artifact;
 const revision=revisionOf(doc);
 const selectionOnly=exported?.feedback_project_digest===feedbackProjectDigest(doc)&&exported?.facts_digest===previewFactsDigest(facts);
 assertPreviewExportBinding(exported,selectionOnly?String(exported?.revision):revision,facts);
 if(typeof exported?.renderId!=='string')throw new Error('feedback_render_missing');
 return{saved_revision:revision,preview:{revision:String(exported.revision),renderId:exported.renderId,facts_digest:previewFactsDigest(facts),timelineId:t.id},blueprint:await copyReviewSubject(doc)};
}
/** Bind once against the actual exported snapshot, before a feedback checkpoint is changed. */
export async function bindProductionFeedback(task:ProductionTask,doc:ProjectDoc,input:unknown){
 if(!row(input)||Object.keys(input).some(k=>!['text','kind','preview','unit_ids','item_ids'].includes(k))||typeof input.text!=='string'||!input.text.trim()||input.text.length>8000
  ||!['content','execution'].includes(String(input.kind))||!row(input.preview)
  ||!Array.isArray(input.unit_ids)||!Array.isArray(input.item_ids)
  ||![...input.unit_ids,...input.item_ids].every(x=>typeof x==='string'&&x.trim())
  ||new Set(input.unit_ids).size!==input.unit_ids.length||new Set(input.item_ids).size!==input.item_ids.length)throw new Error('feedback_binding_required');
 const bound=await productionFeedbackAnchor(task,doc);
 const preview=input.preview;
 if(Object.keys(preview).length!==4||Object.entries(bound.preview).some(([k,v])=>preview[k]!==v))throw new Error('feedback_preview_stale');
 const t=doc.timelines.find(t=>t.id===doc.activeTimelineId)!;
 const units=doc.clipMentorAnalysis!.source_breakdown!.units;
 if(input.unit_ids.some(id=>!units.some(u=>u.unit_id===id))||input.item_ids.some(id=>!t.items.some(i=>i.id===id)))throw new Error('feedback_target_missing');
 const ids=new Set<string>(input.item_ids as string[]);
 for(const id of input.unit_ids){
  const placement=units.find(u=>u.unit_id===id)!.placement;
  if(!placement||placement.timeline_id!==t.id)throw new Error('feedback_unit_placement_missing');
  // Include only wholly contained items. A global overlay must be explicitly targeted.
  for(const i of t.items)if([placement.original_frames,placement.explanation_frames].some(r=>i.startFrame>=r[0]&&i.startFrame+i.durationInFrames<=r[1]))ids.add(i.id);
 }
 if(input.kind==='execution'&&!ids.size)throw new Error('feedback_execution_targets_required');
 return {text:input.text,kind:input.kind,preview:bound.preview,saved_revision:bound.saved_revision,blueprint:{revision:bound.blueprint.revision,digest:bound.blueprint.digest},
  unit_ids:input.unit_ids as string[],item_ids:[...ids],authority:'final_feedback_not_new_content_approval'};
}
export function assertLocalFeedbackPreservation(before:ProjectDoc,after:ProjectDoc,feedback:Row|undefined){
 if(feedback?.kind!=='execution')return;
 if(!Array.isArray(feedback.item_ids)||!feedback.item_ids.length||!row(feedback.preview)||feedback.preview.timelineId!==before.activeTimelineId)throw new Error('feedback_scope_missing');
 const allowed=new Set(feedback.item_ids);
 const envelope=(doc:ProjectDoc)=>{const {timelines:_timelines,assets:_assets,clipMentorAnalysis:_analysis,...rest}=doc;return rest;};
 if(previewFactsDigest(envelope(before))!==previewFactsDigest(envelope(after)))throw new Error('feedback_changed_project_context');
 if(previewFactsDigest(before.clipMentorAnalysis)!==previewFactsDigest(after.clipMentorAnalysis))throw new Error('feedback_execution_cannot_change_blueprint');
 const strip=(doc:ProjectDoc)=>doc.timelines.map(t=>({...t,selectedId:null,selectedIds:[],items:t.items.filter(i=>!(t.id===before.activeTimelineId&&allowed.has(i.id)))}));
 if(previewFactsDigest(strip(before))!==previewFactsDigest(strip(after)))throw new Error('feedback_changed_unaffected_timeline');
 const previous=before.timelines.find(t=>t.id===before.activeTimelineId)!,next=after.timelines.find(t=>t.id===before.activeTimelineId);
 if(!next||[...allowed].some(id=>!previous.items.some(i=>i.id===id)||!next.items.some(i=>i.id===id)))throw new Error('feedback_local_item_removed');
 const referenced=new Set(after.timelines.flatMap(t=>t.items.filter(i=>!allowed.has(i.id)).map(i=>i.sourceAssetId)));
 for(const asset of before.assets)if((asset.kind!=='motion-graphic'||referenced.has(asset.id))&&previewFactsDigest(asset)!==previewFactsDigest(after.assets.find(a=>a.id===asset.id)))throw new Error('feedback_changed_shared_asset:'+asset.id);
}
