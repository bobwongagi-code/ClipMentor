import type {ProductionTask} from './production-task';
import {createHash} from 'node:crypto';

/** Decisions over existing facts only. These routes are candidates, never permissions:
 * the worker must still verify current source, receipts, ownership and budgets. */
export type RecoveryRoute='picture_capacity'|'review_source_observation'|'visual_review_contract'|'continuation_brief'
 |'source_evidence_import'|'focused_author'|'focused_independent'|'focused_structure'|'author_checkpoint';
export type AuthorMode='ordinary'|'canvas_reflow'|'picture_capacity'|'independent_review'|'author_self_check';
export function productionAuthorDecision(task:Pick<ProductionTask,'stage'|'repairContext'>,boundCanvasReflow:boolean){
 const pictureOnly=task.stage==='blueprint'&&!!task.repairContext?.audio_picture_repair;
 const independent=task.stage==='blueprint'&&!!(task.repairContext?.repair??task.repairContext?.pending_review_repair);
 // Obligations may overlap even though the selected instruction has one priority.
 const selfCheck=task.stage==='blueprint'&&(independent||Array.isArray(task.repairContext?.author_self_check)
  ||/^(picture_plan_|blueprint_stage_incomplete:)/.test(String(task.repairContext?.blueprint_structure_issue??'')));
 const mode:AuthorMode=boundCanvasReflow?'canvas_reflow':pictureOnly?'picture_capacity':independent?'independent_review':selfCheck?'author_self_check':'ordinary';
 return {mode,pictureOnly,independent,selfCheck};
}
export function repairableBlueprintIssue(issue:string){
 return /^blueprint_(stage_incomplete:|execution_plan_missing$)/.test(issue)
  ||/^picture_plan_(?:shape_invalid|candidate_mismatch|phase_|group_explanation_missing|original_order_mismatch|revisits_mismatch|stage_cues_missing)/.test(issue)
  ||['copy_scope_incomplete','copy_candidate_missing','copy_candidate_incomplete'].includes(issue);
}
export interface AuthorCheckpointFailure {
 failedObservation:boolean;failedSourceRead:boolean;failedDeliveryWrite:boolean;failedPlanWrite:boolean;savedShapeIssue?:string;
}
export function blockedProductionDecision(task:ProductionTask,contentRepairsRemaining:number):{routes:RecoveryRoute[];authorCheckpoint?:AuthorCheckpointFailure}{
 const routes:RecoveryRoute[]=[];
 if(task.status!=='blocked')return {routes};
 const error=task.error??'',moreModel=task.attempts.model<task.input.budget.model,moreReview=task.attempts.review<task.input.budget.review;
 if(task.stage==='edit'&&task.input.humanBlueprintReview&&error.startsWith('Error: Actual sequence mapping incomplete:')
  &&!task.repairContext?.audio_picture_repair&&moreModel&&moreReview)routes.push('picture_capacity');
 if(task.stage==='copy_review'){
  if(task.input.budget.routine&&['Error: review budget exhausted','Error: 蓝图返修未改变送审内容'].includes(error)
   &&moreReview&&moreModel&&task.attempts.observation<task.input.budget.observation)routes.push('review_source_observation');
  if(task.input.budget.routine&&error==='Error: 蓝图返修未改变送审内容'&&moreReview)routes.push('visual_review_contract');
  if(error==='Error: 蓝图返修未改变送审内容'&&task.blueprintApproval&&moreModel)routes.push('continuation_brief');
  if(error.startsWith('Error: 已用完自动返修额度')&&task.repairContext?.revision===task.projectRevision){
   if(task.input.humanBlueprintReview&&!task.sourceEvidenceRecoveryOperation&&moreModel&&Array.isArray(task.repairContext?.author_self_check)
    &&task.repairContext.author_self_check.some(c=>c?.id==='S2'&&c.status==='fix'))routes.push('source_evidence_import');
   if(task.sourceEvidenceRecoveryOperation)routes.push('focused_author');
   if(task.repairContext?.repair)routes.push('focused_independent');
  }
 }
 if(!task.input.humanBlueprintReview||task.stage!=='blueprint')return {routes};
 if(error.startsWith('Error: 已用完自动返修额度')&&task.repairContext?.revision===task.projectRevision){routes.push('focused_structure');return {routes};}
 // Historical message decoding lives here; it selects inspection, not authority.
 const failedObservation=error.includes('observe_clipmentor_source_video: Source observation failed; read the saved receipt, do not retry');
 const failedSourceRead=(task.deliveryDraftRecoveryUsed===true&&error.includes('(read_clipmentor_source_video: Cannot read/bind saved source receipt; no model request sent).'))
  ||(task.authorCheckContractRevision===2&&error.includes('(read_clipmentor_analysis: storyboard_current_plan_unavailable).'));
 const failedDeliveryWrite=error.includes('revise_clipmentor_analysis: delivery_sections_invalid');
 const failedPlanWrite=error.includes('revise_clipmentor_analysis: Resolve source breakdown before saving a picture plan')||failedDeliveryWrite;
 const savedShapeIssue=error.match(/^Error: (picture_plan_[^\n]+)$/)?.[1];
 if(failedDeliveryWrite&&task.deliveryDraftRecoveryUsed)return {routes};
 if(error!=='Error: copy_scope_incomplete'&&!failedObservation&&!savedShapeIssue&&!failedPlanWrite&&!failedSourceRead)return {routes};
 if((savedShapeIssue||failedPlanWrite)&&!failedDeliveryWrite&&contentRepairsRemaining===0)return {routes};
 if(savedShapeIssue&&!repairableBlueprintIssue(savedShapeIssue))return {routes};
 routes.push('author_checkpoint');return {routes,authorCheckpoint:{failedObservation,failedSourceRead,failedDeliveryWrite,failedPlanWrite,savedShapeIssue}};
}

type Effect=ProductionTask['effects'][string];
export function productionEffectDecision(old:Effect|undefined,hasRecovery:boolean,remaining:number){
 if(old?.status==='completed')return {action:'reuse' as const,reason:'effect_result_saved' as const};
 if(old&&hasRecovery)return {action:'recover' as const,reason:'existing_operation_lookup' as const};
 if(old)return {action:'stop' as const,reason:'existing_operation_unresolved' as const};
 if(remaining<=0)return {action:'stop' as const,reason:'effect_budget_exhausted' as const};
 return {action:'submit' as const,reason:'new_effect_with_allowance' as const};
}
export function productionRecoveryProgress(task:ProductionTask,from:{stage:ProductionTask['stage'];repairs:number},stageOrder:readonly string[]){
 return task.repairs>from.repairs||stageOrder.indexOf(task.stage)>stageOrder.indexOf(from.stage);
}

/** Confirmed children can advance revisions independently. Their original batch
 * confirmation and dependency identity must still agree before either is queued. */
export function productionOutputsMatch(parent:ProductionTask,children:ProductionTask[]){
 const entries=parent.productionChildren;
 if(entries?.length!==2||children.length!==2||new Set(children.map(t=>t.taskId)).size!==2
  ||new Set(children.map(t=>t.projectId)).size!==2)return false;
 if(children.some((task,index)=>{const entry=entries[index];return entry.projectId!==task.projectId||entry.taskId!==task.taskId
  ||entry.audience!==task.input.panelDelivery?.audience||task.input.sourceAssetId!==parent.input.sourceAssetId
  ||task.blueprintApproval?.sourceProjectId!==parent.projectId||task.blueprintApproval.sourceTaskId!==parent.taskId;}))return false;
 const first=children.find(t=>t.input.panelDelivery?.audience==='existing_partner'),second=children.find(t=>t.input.panelDelivery?.audience==='new_contact');
 if(!first||!second||!first.blueprintApproval?.sourceRevision||first.blueprintApproval.sourceRevision!==second.blueprintApproval?.sourceRevision)return false;
 if(second.sharedProduction?.projectId!==first.projectId||second.sharedProduction.taskId!==first.taskId)return false;
 return !first.sharedProduction||(first.sharedProduction.prepared===true
  &&first.sharedProduction.projectId===second.projectId&&first.sharedProduction.taskId===second.taskId);
}

export type ProductionDecisionDetails=
 |{scope:'effect';action:ReturnType<typeof productionEffectDecision>['action'];reason:ReturnType<typeof productionEffectDecision>['reason'];effectKey:string;operationId?:string}
 |{scope:'author';action:'select';reason:AuthorMode}
 |{scope:'recovery';action:'resume'|'stop';reason:RecoveryRoute|'no_matching_route'|'cancelled_or_expired'|'checkpoint_unpersisted'|'no_verified_progress'|'reconciliation_failed';fromStage:ProductionTask['stage'];fromEpoch:number};
/** Safe event projection. No raw result, prompt, free-form error, credentials or author arguments. */
export function productionDecisionEvent(task:ProductionTask,decision:ProductionDecisionDetails){
 const common={version:1,taskId:task.taskId,projectId:task.projectId,revision:task.projectRevision??null,
  stage:task.stage,repairEpoch:task.repairs,attempts:{model:task.attempts.model,review:task.attempts.review,
   observation:task.attempts.observation,tts:task.attempts.tts,render:task.attempts.render,preview_review:task.attempts.preview_review??0},
  scope:decision.scope,action:decision.action,reason:decision.reason};
 if(decision.scope==='effect')return {...common,effectKeySha256:createHash('sha256').update(decision.effectKey).digest('hex'),
  ...(decision.operationId?{operationId:decision.operationId}:{})};
 if(decision.scope==='recovery')return {...common,fromStage:decision.fromStage,fromEpoch:decision.fromEpoch};
 return common;
}
