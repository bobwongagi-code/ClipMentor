import type {ProductionTask} from './production-task';
import {createHash} from 'node:crypto';
import {productionReferenceStop} from './production-references';

/** Decisions over existing facts only. These routes are candidates, never permissions:
 * the worker must still verify current source, receipts, ownership and budgets. */
export type RecoveryRoute='picture_capacity'|'review_source_observation'|'visual_review_contract'|'continuation_brief'
 |'source_evidence_import'|'focused_author'|'focused_independent'|'focused_structure'|'author_checkpoint'|'approved_source_receipt'|'first_glance_receipt';

export const firstGlanceReceiptError='Error: teaching_first_glance_checks_invalid';

export function failedFirstGlanceReceipt(task:ProductionTask,epoch:number){
 const prefix=`copy_review:${task.feedbackUsed?'feedback':'initial'}:`;
 const failed=Object.entries(task.effects).filter(([id,effect])=>id.startsWith(prefix)&&id.includes(':teaching-baseline:')
  &&effect.kind==='model'&&effect.status==='failed'&&effect.error===firstGlanceReceiptError);
 const expected=`${prefix}${epoch}:teaching-baseline:`;
 const id=failed[0]?.[0];
 return failed.length===1&&id?.startsWith(expected)&&/^[a-f0-9]{64}$/u.test(id.slice(expected.length))?failed[0]:undefined;
}

export const savedSourceReceiptUnavailable='Saved source receipt unavailable or not bound to this project; no model request sent';
export type AuthorMode='ordinary'|'canvas_reflow'|'picture_capacity'|'independent_review'|'author_self_check'|'operator_revision';
export function productionAuthorDecision(task:Pick<ProductionTask,'stage'|'repairContext'>,boundCanvasReflow:boolean,operatorRevision=false){
 if(operatorRevision&&task.stage==='blueprint')return {mode:'operator_revision' as const,pictureOnly:false,independent:false,selfCheck:false};
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
type BlueprintFinding={code:string;id:string;targets?:string[]};
const incompleteBlueprint='blueprint_stage_incomplete:';

export function blueprintFindings(issue:unknown):BlueprintFinding[]{
 if(typeof issue!=='string')return [];
 if(!issue.startsWith(incompleteBlueprint)){
  const [code,id,...target]=issue.split(':');
  return code?[{code,id:id??'',...(target.length?{targets:[target.join(':')]}:{})}]:[];
 }
 try{
  const items:unknown=JSON.parse(issue.slice(incompleteBlueprint.length));
  return Array.isArray(items)&&items.every((item):item is BlueprintFinding=>
   !!item&&typeof item.id==='string'&&typeof item.code==='string'&&
   (item.targets===undefined||Array.isArray(item.targets)&&item.targets.every((value:unknown)=>typeof value==='string')))?items:[];
 }catch{return [];}
}

export const blueprintFindingKeys=({id,code,targets}:BlueprintFinding)=>targets?.length
 ?[...new Set(targets)].sort().map(target=>JSON.stringify([id,code,target])):[`${id}:${code}`];

export function pictureRepairFindings(issue:unknown){
 const findings=blueprintFindings(issue).filter(({code})=>/^(picture_plan_|copy_(picture_outside_explanation|point_not_registered|candidate_pointer_invalid)$|selected_point_missing_from_copy$|blueprint_execution_plan_missing$|existing_partner_|new_contact_|opening_|delivery_audience_scope_mismatch$|source_review_scope_missing$|storyboard_document_|storyboard_pdf_|storyboard_original_excerpt_changed$|handoff_visual_criterion_|delivery_sections_invalid$|creator_storyboard_delivery_binding_missing$)/.test(code));
 return findings;
}

const repairStopped='blueprint_repair_no_progress';
function pictureRepairCategory(code:string){
 if(/unsupported|_verifier_unavailable$/.test(code))return '门禁问题（需维护侧排查）';
 if(/^picture_plan_(group_explanation_missing|phase_content_missing|phase_original_missing|stage_cues_missing)$|^selected_point_missing_from_copy$|^blueprint_execution_plan_missing$|_missing$|^storyboard_document_authoring_required$/.test(code))return '缺内容';
 if(code==='picture_plan_replay_outside_evidence')return '回看窗口超出已登记证据';
 if(/^picture_plan_(candidate_mismatch|original_order_mismatch|revisits_mismatch|phase_binding_invalid|phase_line_invalid|phase_range_invalid|closing_playback_interrupted|pointer_invalid)$|^copy_(picture_outside_explanation|point_not_registered|candidate_pointer_invalid)$|^existing_partner_|^new_contact_|^opening_|^delivery_audience_scope_mismatch$/.test(code))return '绑定错';
 return '门禁问题（需核对校验与当前计划）';
}
export function pictureRepairCoverage(issue:unknown){
 const byUnit=new Map<string,Set<string>>();
 for(const finding of pictureRepairFindings(issue)){
  const keys=byUnit.get(finding.id)??new Set<string>();
  for(const key of blueprintFindingKeys(finding))keys.add(key);
  byUnit.set(finding.id,keys);
 }
 return [...byUnit].map(([unit,keys])=>JSON.stringify([unit,[...keys].sort()]));
}
export function repeatedPictureRepair(previous:unknown,current:unknown,history:readonly string[]=[]){
 const seen=new Set([...history,...pictureRepairCoverage(previous)]);
 const next=pictureRepairCoverage(current);
 const strictKeys=new Set(pictureRepairFindings(current).filter(({code})=>
  /^(picture_plan_(?:required_demonstration_|demonstration_views_wrong_group)|opening_performance_card_)/u.test(code))
  .flatMap(blueprintFindingKeys));
 const stalled=new Set(next.flatMap(signature=>{
  const [unit,keys]=JSON.parse(signature) as [string,string[]];
  const remaining=new Set(keys);
  for(const prior of seen){
   const [before,missing]=JSON.parse(prior) as [string,string[]];
   if(unit===before&&(missing.every(key=>remaining.has(key))
    ||missing.some(key=>strictKeys.has(key)&&remaining.has(key))))return [unit];
  }
  return [];
 }));
 if(!stalled.size)return;
 const detail=pictureRepairFindings(current).filter(({id})=>stalled.has(id))
  .map(({code,id,targets})=>[pictureRepairCategory(code),id,code,targets?.join(', ')].filter(Boolean).join(' ')).join('；');
 return `${repairStopped} 同一回看或交付绑定缺口重复出现，自动返修已暂停。未解决：${detail}`;
}
export function pictureRepairStopped(task:Pick<ProductionTask,'status'|'error'>){
 return task.status==='blocked'&&task.error?.startsWith('Error: '+repairStopped+' ');
}
const narrationRepairStopped=(task:Pick<ProductionTask,'status'|'error'>)=>
 task.status==='blocked'&&task.error?.startsWith('Error: teaching_final_narration_repair_no_progress:');
const sourceAnalysisStopped=(task:Pick<ProductionTask,'status'|'error'>)=>
 task.status==='blocked'&&(task.error==='Error: production_source_breakdown_no_progress'||task.error==='Error: '+productionReferenceStop);

const creatorQualityStopped=(task:Pick<ProductionTask,'status'|'error'>)=>
 task.status==='blocked'&&/^Error: (?:creator_quality_repair_no_progress |creator_opening_metrics_unconfirmed:|creator_incomplete_review_with_rejection$)/u.test(task.error??'');

export function blueprintRepairStopped(task:Pick<ProductionTask,'status'|'error'>){
 return pictureRepairStopped(task)||narrationRepairStopped(task)||sourceAnalysisStopped(task)||creatorQualityStopped(task);
}
export function blueprintRepairNotice(task:Pick<ProductionTask,'status'|'error'|'repairContext'>){
 if(creatorQualityStopped(task))return task.error?.includes('creator_opening_metrics_unconfirmed')
  ?'片头成绩待维护侧核实。进度已保存。':'同一教学缺口再次出现。已保留候选和审核记录，待维护侧核对。';
 if(sourceAnalysisStopped(task))return '制作已暂停，同一个引用或填写问题再次出现。已保留素材和回执，待维护侧核对。';
 return narrationRepairStopped(task)?'讲解返修已暂停。候选与审核记录已保存，待核对同一缺口。':pictureRepairNotice(task);
}
export function pictureRepairNotice(task:Pick<ProductionTask,'status'|'error'|'repairContext'>){
 if(!pictureRepairStopped(task))return;
 if(task.error?.includes('suspected_gate_defect'))return '两份已认可的方案遇到同一门禁拒绝，待维护侧核对。';
 const categories=[...new Set(pictureRepairFindings(task.repairContext?.last_picture_repair_issue).map(({code})=>pictureRepairCategory(code)))];
 return categories.length?`回看方案返修已暂停。仍有${categories.join('、')}。`:'回看方案返修已暂停，同一缺口重复出现。';
}

export interface AuthorCheckpointFailure {
 failedObservation:boolean;gatewayObservationUnavailable:boolean;failedStoryboardDraftRead:boolean;failedSourceRead:boolean;failedDeliveryWrite:boolean;failedPlanWrite:boolean;savedShapeIssue?:string;
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
 if(task.blueprintApproval&&task.input.panelDelivery?.audience&&moreModel&&!task.approvedSourceReadRecovered
  &&error.includes(`(read_clipmentor_source_video: ${savedSourceReceiptUnavailable}).`)){
  routes.push('approved_source_receipt');return {routes};
 }
 if(error.startsWith('Error: 已用完自动返修额度')&&task.repairContext?.revision===task.projectRevision){routes.push('focused_structure');return {routes};}
 // Historical message decoding lives here; it selects inspection, not authority.
 const failedObservation=error.includes('observe_clipmentor_source_video: Source observation failed; read the saved receipt, do not retry');
 const gatewayObservationUnavailable=!task.sourceObservationUnavailableOperation&&error.includes('observe_clipmentor_source_video: source_observation_failed_or_unknown');
 const failedStoryboardDraftRead=!!task.input.panelDelivery&&!!task.sourceObservationUnavailableOperation
  &&error.includes('(read_clipmentor_analysis: storyboard_current_plan_unavailable).');
 const failedSourceRead=(task.deliveryDraftRecoveryUsed===true&&error.includes('(read_clipmentor_source_video: Cannot read/bind saved source receipt; no model request sent).'))
  ||(task.authorCheckContractRevision===2&&error.includes('(read_clipmentor_analysis: storyboard_current_plan_unavailable).'));
 const failedDeliveryWrite=error.includes('revise_clipmentor_analysis: delivery_sections_invalid');
 const failedPlanWrite=error.includes('revise_clipmentor_analysis: Resolve source breakdown before saving a picture plan')||failedDeliveryWrite;
 const savedShapeIssue=error.match(/^Error: (picture_plan_[^\n]+)$/)?.[1];
 if(failedDeliveryWrite&&task.deliveryDraftRecoveryUsed)return {routes};
 if(error!=='Error: copy_scope_incomplete'&&!failedObservation&&!gatewayObservationUnavailable&&!failedStoryboardDraftRead&&!savedShapeIssue&&!failedPlanWrite&&!failedSourceRead)return {routes};
 if((savedShapeIssue||failedPlanWrite)&&!failedDeliveryWrite&&contentRepairsRemaining===0)return {routes};
 if(savedShapeIssue&&!repairableBlueprintIssue(savedShapeIssue))return {routes};
 routes.push('author_checkpoint');return {routes,authorCheckpoint:{failedObservation,gatewayObservationUnavailable,failedStoryboardDraftRead,failedSourceRead,failedDeliveryWrite,failedPlanWrite,savedShapeIssue}};
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
  ||task.input.panelDelivery?.partnerEnding!==parent.input.panelDelivery?.partnerEnding
  ||task.input.openingComparison?.quote!==parent.input.openingComparison?.quote
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
