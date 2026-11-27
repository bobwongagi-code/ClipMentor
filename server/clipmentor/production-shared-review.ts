import type {ProductionTask} from './production-task';
import type {ProjectDoc} from '../../src/editor/types';
import {bindProductionFeedback,productionFeedbackAnchor} from './production-feedback';
import {productionPreviewBinding} from './production-playable-preview';
import {previewReviewRepairBlock} from './preview-review';

function boundNegativeIssues(task:ProductionTask,value:unknown){
 if(!value||typeof value!=='object'||previewReviewRepairBlock(value))return;
 const receipt=value as {projectId?:unknown;videoSha256?:unknown;scope?:unknown;full_film_accepted?:unknown;result:{issues:string[]}};
 const preview=productionPreviewBinding(task);
 if(!preview||receipt.projectId!==task.projectId||receipt.videoSha256!==preview.hash
  ||receipt.scope!=='rendered_preview_continuous_review'||receipt.full_film_accepted!==false)return;
 return receipt.result.issues;
}

export function previewHasBoundContentIssue(task:ProductionTask){
 return !!boundNegativeIssues(task,task.repairContext?.receipt);
}

export function sharedPreviewReviewPause(task:ProductionTask,value:unknown){
 if(!task.sharedProduction?.prepared||previewReviewRepairBlock(value))return;
 const issues=boundNegativeIssues(task,value);
 if(!issues)return 'preview_review_evidence_unverified';
 const ending='delivery/'+task.input.panelDelivery?.audience;
 const endingOnly=issues.every(issue=>[ending,ending+':teaching'].some(id=>issue===id+':not_supported'));
 return endingOnly?'preview_shared_ending_requires_local_repair':'preview_shared_body_requires_reconciliation';
}

export async function localSharedEndingRepair(task:ProductionTask,doc:ProjectDoc,value:unknown){
 if(sharedPreviewReviewPause(task,value)!=='preview_shared_ending_requires_local_repair')return;
 const issues=boundNegativeIssues(task,value)!;
 const previous=task.repairContext?.final_feedback as {preview_ending_findings?:string[]}|undefined;
 if(issues.some(issue=>previous?.preview_ending_findings?.includes(issue)))return;
 const t=doc.timelines.find(t=>t.id===doc.activeTimelineId);
 const start=task.sharedProduction?.endFrame;
 if(!t||typeof start!=='number'||!Number.isSafeInteger(start)||start<=0)return;
 const end=t.items.reduce((last,item)=>Math.max(last,item.startFrame+item.durationInFrames),0);
 if(start>=end)return;
 const id='delivery/'+task.input.panelDelivery?.audience;
 const judgment=(value as {result:{judgment?:{coverage?:Array<{point_id:string;teaching:unknown}>;
  continuity?:Array<{unit_id:string;teaching:unknown}>}}}).result.judgment;
 const findings=issues.map(issue=>issue===id+':not_supported'?
  judgment?.coverage?.find(row=>row.point_id===id)?.teaching:judgment?.continuity?.find(row=>row.unit_id===id)?.teaching);
 const local=findings.every(value=>{
  const finding=value as {status?:string;evidence?:Array<{start_seconds:number;end_seconds:number}>}|undefined;
  return finding?.status==='not_supported'&&Array.isArray(finding.evidence)&&finding.evidence.length>0&&finding.evidence.every(e=>
   e.start_seconds>=start/t.fps&&e.end_seconds<=end/t.fps+.005&&e.end_seconds>e.start_seconds);
 });
 if(!local)return;
 try{
  const {preview}=await productionFeedbackAnchor(task,doc);
  const scope=await bindProductionFeedback(task,doc,{kind:'execution',preview,
   text:'只修复本版片尾在独立成片复核中指出的问题。共用主体、已审片尾口播和素材保持不变。',
   unit_ids:[],item_ids:[],output_range_seconds:[start/t.fps,end/t.fps]});
  return {...scope,authority:'bound_preview_ending_review',preview_ending_findings:issues};
 }catch{return undefined;}
}

export function matchingSharedPreviewProblem(task:ProductionTask,sibling:ProductionTask){
 const ours=task.sharedProduction,theirs=sibling.sharedProduction;
 return !!(ours?.prepared&&theirs?.prepared&&ours.digest&&ours.digest===theirs.digest&&ours.endFrame===theirs.endFrame
  &&ours.projectId===sibling.projectId&&ours.taskId===sibling.taskId&&theirs.projectId===task.projectId&&theirs.taskId===task.taskId
  &&sharedPreviewReviewPause(sibling,sibling.repairContext?.receipt)==='preview_shared_body_requires_reconciliation');
}
