import {blockedProductionDecision,failedFirstGlanceReceipt,firstGlanceReceiptError,productionRecoveryProgress,repairableBlueprintIssue,type AuthorCheckpointFailure,type RecoveryRoute} from './production-decisions';
import {authorSelfCheckReceiptText,selectAuthorSelfCheckReceipt} from './production-author-self-check';
import {productionCapacityFacts} from './production-capacity-repair';
import {currentReviewRepair,needsVisualReviewCompletion} from './execution-view';
import {digestValue} from '../agent-runs/store-values';
import {observationTaskWithBoundaryContext,validateSourceVideoTask,type SourceVideoReceipt,type SourceVideoTask} from '../../shared/clipmentor-source-video';
import {loadAgentRuntimeSidecar} from '../../src/persist/agentRuntimeStore';
import {checkCopyProduction,copyReviewSubject} from '../../src/clipmentor/production-gate';
import {checkSourceBreakdown,originalPlaybackRanges} from '../../src/clipmentor/source-breakdown';
import {importProductionSourceEvidence,productionReviewObservation} from './production-source-evidence';
import {readSourceVideoReceipt,sourceVideoDependencies} from './source-video';
import {verifyCreatorStoryboardEvidence} from './creator-storyboard';
import {createProductionPreparation,productionBlueprintReadiness,productionBoardPhaseIssues} from './production-readiness';
import {loadOfflineStoredProject} from '../external-agent/offline-project-store';
import type {ProjectDoc} from '../../src/editor/types';
import {upgradeContinuationBrief} from './production-continuation';
import {recoverApprovedOutputSourceRead} from './production-approved-source';
import {productionWorkDeadline} from './production-shared-clock';
import {PRODUCTION_STAGES,recordProductionDecision,recordTechnicalRecovery,reconcileLegacyTechnicalRecoveries,remainingContentRepairs,productionRepairContext,structuralRepairPause,
 canRecordTechnicalRecovery,grantFocusedBlueprintRepair,grantFocusedAuthorRepair,grantFocusedIndependentRepair,invalidateReconciledProductionStages,type ProductionTask} from './production-task';

export function canResumeFirstGlanceReview(task:ProductionTask){
 if(task.stage!=='copy_review'||task.status!=='blocked'||task.error!==firstGlanceReceiptError
  ||!task.input.humanBlueprintReview||!task.input.panelDelivery?.firstGlanceWriting||task.blueprintApproval
  ||task.input.panelDelivery.audience||!task.projectRevision
  ||task.completed.blueprint?.artifact.revision!==task.projectRevision||task.completed.copy_review
  ||task.attempts.model>=task.input.budget.model||!canRecordTechnicalRecovery(task)||Date.now()>=productionWorkDeadline(task))return false;
 return failedFirstGlanceReceipt(task,task.repairs)!==undefined;
}

/** Format failures stay inspectable until the operator explicitly retries. */
export async function resumeFirstGlanceReview(task:ProductionTask){
 await reconcileLegacyTechnicalRecoveries(task);
 if(!canResumeFirstGlanceReview(task))return false;
 const [id,effect]=failedFirstGlanceReceipt(task,task.repairs)!;
 const digest=id.split(':').at(-1)!;
 const [saved,sidecar]=await Promise.all([loadOfflineStoredProject(task.projectId),loadAgentRuntimeSidecar(task.projectId)]);
 const receipt=selectAuthorSelfCheckReceipt(sidecar.runs,task,effect.operationId,digest,task.completed.blueprint!.at,false)?.run;
 if(!saved||saved.revision!==task.projectRevision||saved.doc.clipMentorAnalysis?.source.asset_id!==task.input.sourceAssetId
  ||!receipt||!authorSelfCheckReceiptText(receipt).verified||!canResumeFirstGlanceReview(task))return false;
 const before={stage:task.stage,repairs:task.repairs};
 recordTechnicalRecovery(task);
 invalidateReconciledProductionStages(task,before);
 await recordProductionDecision(task,{scope:'recovery',action:'resume',reason:'first_glance_receipt',fromStage:before.stage,fromEpoch:before.repairs});
 return true;
}

export async function reconcileBlockedBlueprint(task:ProductionTask){
 const before={stage:task.stage,repairs:task.repairs};let route:RecoveryRoute|'no_matching_route'='no_matching_route';
 try{
  await reconcileBlockedBlueprintState(task,value=>{route=value;});
  invalidateReconciledProductionStages(task,before);
  await recordProductionDecision(task,{scope:'recovery',action:productionRecoveryProgress(task,before,PRODUCTION_STAGES)?'resume':'stop',
   reason:route,fromStage:before.stage,fromEpoch:before.repairs});
 }catch(error){await recordProductionDecision(task,{scope:'recovery',action:'stop',reason:'reconciliation_failed',fromStage:before.stage,fromEpoch:before.repairs});throw error;}
}

/** Reconcile pre-fix checkpoints only when their saved evidence authorizes recovery. */
async function reconcileBlockedBlueprintState(task:ProductionTask,choose:(route:RecoveryRoute)=>void){
 await reconcileLegacyTechnicalRecoveries(task);
 const decision=blockedProductionDecision(task,remainingContentRepairs(task));
 const selected=(route:RecoveryRoute)=>{if(!decision.routes.includes(route))return false;choose(route);return true;};
 if(selected('approved_source_receipt')){
  await recoverApprovedOutputSourceRead(task);
  return;
 }
 if(await reconcileBlueprintWithCurrentPlan(task,selected))return;
 if(await reconcileFocusedBlueprintRepair(task,selected))return;
 if(selected('author_checkpoint')&&decision.authorCheckpoint)await reconcileBlueprintAuthorCheckpoint(task,decision.authorCheckpoint);
}

type SelectRecoveryRoute=(route:RecoveryRoute)=>boolean;
async function reconcileBlueprintWithCurrentPlan(task:ProductionTask,selected:SelectRecoveryRoute){
 // A no-op edit with measured capacity conflicts returns to internal picture planning,
 // not to the operator and not to another identical edit request.
 if(selected('picture_capacity')){
  const saved=await loadOfflineStoredProject(task.projectId);
  if(saved&&saved.revision===task.projectRevision&&saved.doc.timelines.every(t=>t.items.length===0)
   &&(await checkCopyProduction(saved.doc,'clipmentor')).allowed){
   const facts=await productionCapacityFacts(saved.doc,task.input.voice);
   const affected=facts.filter(f=>f.measured_audio_seconds>f.registered_dynamic_seconds);
   if(affected.length){
    task.repairContext={...task.repairContext,revision:saved.revision,audio_picture_repair:{groups:affected,
     instruction:'实测音频已齐全；组级动态秒数不含参照图阅读容量，不能按单句不足直接判失败。按整组意群和原片证据核画面分工，必要时登记有教学作用的参照图/关系卡，不用空长定格、循环、慢放填时长。只修画面计划，不改口播、字幕、短标文字或交付片头片尾，不重新配音。'}};
    task.stage='blueprint';task.repairs++;return true;
   }
  }
 }

 // A renewed batch must consume the saved negative receipt before another paid review.
 if(selected('review_source_observation')){
  const saved=await loadOfflineStoredProject(task.projectId);
  const repair=saved&&await currentReviewRepair(saved.doc);
  if(saved&&saved.revision===task.projectRevision&&repair?.status==='bound'){
   const repairContext={...task.repairContext,revision:saved.revision,blueprint_digest:repair.subject.digest,repair};
   const route=productionReviewObservation(saved.doc,{...task,stage:'blueprint',repairContext});
   if(route){
    task.repairContext=repairContext;task.stage='blueprint';task.repairs++;
    return true;
   }
  }
 }

 if(selected('visual_review_contract')){
  const saved=await loadOfflineStoredProject(task.projectId);
  const repair=saved&&await currentReviewRepair(saved.doc);
  if(saved?.revision===task.projectRevision&&repair?.status==='bound'
   &&repair.subject?.digest===task.repairContext?.blueprint_digest&&needsVisualReviewCompletion(repair)){
   task.repairContext={...task.repairContext,review_contract_recheck:true};
   task.repairs++;return true;
  }
 }
 if(selected('continuation_brief')){
  const updated=structuredClone(task),saved=await loadOfflineStoredProject(task.projectId);
  if(saved&&saved.revision===task.projectRevision&&await upgradeContinuationBrief(updated)){
   const repair=await currentReviewRepair(saved.doc);
   if(repair.status==='bound'&&repair.subject?.digest===task.repairContext?.blueprint_digest){
    recordTechnicalRecovery(updated);updated.stage='blueprint';
    Object.assign(task,updated);return true;
   }
  }
 }
 return false;
}

async function reconcileFocusedBlueprintRepair(task:ProductionTask,selected:SelectRecoveryRoute){
 if(selected('source_evidence_import')){
  const checks=task.repairContext?.author_self_check;
  if(Array.isArray(checks)&&checks.some(check=>check?.id==='S2'&&check.status==='fix')){
   const saved=await loadOfflineStoredProject(task.projectId);
   const analysis=saved?.doc.clipMentorAnalysis;
   if(saved&&saved.revision===task.projectRevision&&analysis?.source.asset_id===task.input.sourceAssetId){
    const deps=sourceVideoDependencies();
    for(const effect of Object.values(task.effects).reverse()){
     if(effect.kind!=='observation'||effect.status!=='completed')continue;
     const receipt=await readSourceVideoReceipt(effect.operationId,task.projectId,deps).catch(()=>null);
     if(!receipt||!importProductionSourceEvidence(analysis,receipt,task.projectId))continue;
     task.sourceEvidenceRecoveryOperation=effect.operationId;
     task.repairContext={...task.repairContext,source_evidence_import:effect.operationId};
     task.repairs++;
     task.stage='blueprint';
     return true;
    }
   }
  }
 }
 if(selected('focused_author')){
  const snapshot=await loadOfflineStoredProject(task.projectId);
  if(snapshot&&snapshot.revision===task.projectRevision&&snapshot.doc.clipMentorAnalysis?.source.asset_id===task.input.sourceAssetId
   &&(await createProductionPreparation(snapshot.doc)).reviewed.subject.digest===task.repairContext?.blueprint_digest
   ){
   const issues=task.repairContext?.author_self_check;
   const contractUpgrade=task.authorCheckContractRevision===undefined&&Array.isArray(issues)
    &&issues.some(issue=>issue?.id==='S5')&&issues.some(issue=>issue?.id==='S6'||issue?.id==='S7');
   const previous=task.focusedAuthorChecks;
   if(contractUpgrade)delete task.focusedAuthorChecks;
   if(!grantFocusedAuthorRepair(task,issues)){
    task.focusedAuthorChecks=previous;
    // A verified author finding that cannot earn another repair ends this recovery.
    return true;
   }
   if(contractUpgrade)task.authorCheckContractRevision=2;
   task.stage='blueprint';task.repairs++;
   return true;
  }
 }
 if(selected('focused_independent')){
  const snapshot=await loadOfflineStoredProject(task.projectId);
  const checked=snapshot&&await currentReviewRepair(snapshot.doc);
  if(snapshot&&snapshot.revision===task.projectRevision&&snapshot.doc.clipMentorAnalysis?.source.asset_id===task.input.sourceAssetId
   &&checked?.status==='bound'&&checked.subject?.digest===task.repairContext?.blueprint_digest&&grantFocusedIndependentRepair(task,checked)){
   task.stage='blueprint';task.repairs++;
   return true;
  }
 }
 if(selected('focused_structure')){
  const issue=task.repairContext?.blueprint_structure_issue;
  if(typeof issue!=='string')return true;
  const saved=await loadOfflineStoredProject(task.projectId);
  if(saved&&saved.revision===task.projectRevision&&saved.doc.clipMentorAnalysis?.source.asset_id===task.input.sourceAssetId
   &&(await productionBlueprintReadiness(saved.doc,task.input.voice)).code===issue&&grantFocusedBlueprintRepair(task,issue)){
   task.repairs++;
  }
  return true;
 }
 return false;
}

async function verifyBlueprintRecoveryObservation(task:ProductionTask,gatewayObservationUnavailable:boolean,
 effects:Array<ProductionTask['effects'][string]>,doc:ProjectDoc,
 savedAnalysis:NonNullable<ProjectDoc['clipMentorAnalysis']>):Promise<{
 previousObservation:SourceVideoReceipt;recoveredObservation?:SourceVideoTask;
}>{
 if(gatewayObservationUnavailable){
  const observations=effects.filter(effect=>effect.kind==='observation');
  const effect=observations[0];
  const observed=(effect?.result as {body?:{receipt?:SourceVideoReceipt}}|undefined)?.body?.receipt;
  const receipt=observations.length===1&&effect
   ?await readSourceVideoReceipt(effect.operationId,task.projectId,sourceVideoDependencies()).catch(()=>null):null;
  const match=receipt&&observed&&observed.operationId===receipt.operationId
   &&observed.projectId===task.projectId&&observed.status==='failed'&&observed.phase==='gateway_request'
   &&observed.receipt_persisted===true&&observed.requestsAttempted===1&&observed.upstream_http_status==null
   &&observed.source_hash===receipt.source_hash&&receipt.source_hash===savedAnalysis.source.sourceContentHash
   &&doc.assets.some(asset=>asset.id===task.input.sourceAssetId&&asset.sourceContentHash===receipt.source_hash)
   &&digestValue(observed.subject)===digestValue(receipt.subject)&&receipt.subject.revision<=savedAnalysis.revision;
  if(!match||!receipt||receipt.receipt_persisted!==true||receipt.requestsAttempted!==1
   ||!(receipt.status==='failed'&&receipt.phase==='gateway_request'&&receipt.upstream_http_status==null&&!receipt.raw_response_available
    ||receipt.status==='completed'&&receipt.result?.validation.status==='valid'))
   throw new Error('blueprint_recovery_observation_receipt_unverified');
  return {previousObservation:receipt};
 }

 const observations=effects.filter(effect=>effect.kind==='observation');
 const effect=observations[0];
 const receipt=(effect?.result as {body?:{receipt?:SourceVideoReceipt}}|undefined)?.body?.receipt;
 const subject=await copyReviewSubject(doc);
 if(observations.length!==1||!receipt||receipt.operationId!==effect.operationId||receipt.projectId!==task.projectId
   ||receipt.status!=='failed'||receipt.receipt_persisted!==true||receipt.requestsAttempted!==1
   ||receipt.phase!=='validate_response'||receipt.upstream_http_status!==200
   ||receipt.subject.revision>subject.revision
   ||receipt.source_hash!==savedAnalysis.source.sourceContentHash
   ||receipt.validation?.status!=='invalid'||!receipt.validation.issues.some(issue=>issue.severity==='error')
   ||receipt.validation.issues.some(issue=>issue.severity==='error'&&issue.code!=='invalid_task_boundary_evidence')
   ||task.attempts.observation>=task.input.budget.observation)
  throw new Error('blueprint_recovery_observation_receipt_unverified');
 const requested=receipt.observation_task;
 validateSourceVideoTask(requested,savedAnalysis.source.duration_seconds,subject.units.map(unit=>unit.unit_id));
 const breakdown=savedAnalysis.source_breakdown;
 if(!breakdown||requested.contexts.some(context=>{
  const unit=breakdown.units.find(entry=>entry.unit_id===context.unit_id);
  return !unit||context.boundary_seconds.some(time=>context.source_range_seconds.includes(time)
   &&!originalPlaybackRanges(breakdown,unit).some(range=>range.includes(time)));
 }))throw new Error('blueprint_recovery_observation_boundaries_changed');
 const recoveredObservation=observationTaskWithBoundaryContext(requested,savedAnalysis.source.duration_seconds);
 if(JSON.stringify(requested)===JSON.stringify(recoveredObservation))
  throw new Error('blueprint_recovery_observation_context_already_corrected');
 return {previousObservation:receipt,recoveredObservation};
}

/** The finished author run must prove the exact saved revision before publication. */
async function reconcileBlueprintAuthorCheckpoint(task:ProductionTask,failure:AuthorCheckpointFailure){
 const {failedObservation,gatewayObservationUnavailable,failedStoryboardDraftRead,failedSourceRead,failedDeliveryWrite,failedPlanWrite}=failure;
 const recoveringDeliveryWrite=failedDeliveryWrite&&!gatewayObservationUnavailable&&!failedObservation&&!failedStoryboardDraftRead&&!failedSourceRead;
 let {savedShapeIssue}=failure;
 const analysis=task.completed.analysis;
 const prefix=`blueprint:${task.feedbackUsed?'feedback':'initial'}:${task.repairs}:`;
 const effects=Object.entries(task.effects).filter(([key])=>key.startsWith(prefix)).map(([,effect])=>effect);
 if(!analysis||task.completed.blueprint
   ||task.attempts.model>=task.input.budget.model
   ||!effects.length||effects.some(effect=>effect.status!=='completed'
    ||(effect.kind!=='model'&&!((failedObservation||gatewayObservationUnavailable)&&effect.kind==='observation'))))
  throw new Error('blueprint_recovery_budget_or_effect_unverified');
 const [saved,sidecar]=await Promise.all([loadOfflineStoredProject(task.projectId),loadAgentRuntimeSidecar(task.projectId)]);
 const savedAnalysis=saved?.doc.clipMentorAnalysis;
 if(!saved||!savedAnalysis||savedAnalysis.source.asset_id!==task.input.sourceAssetId)
  throw new Error('blueprint_recovery_saved_scope_changed');
 let recoveredObservation:SourceVideoTask|undefined;
 let previousObservation:SourceVideoReceipt|undefined;
 if(gatewayObservationUnavailable||failedObservation){
  ({previousObservation,recoveredObservation}=await verifyBlueprintRecoveryObservation(task,gatewayObservationUnavailable,effects,saved.doc,savedAnalysis));
 }else if(failedStoryboardDraftRead){
  if(productionBoardPhaseIssues(saved.doc).length)throw new Error('blueprint_recovery_saved_scope_changed');
  await verifyCreatorStoryboardEvidence(saved.doc);
 }else{
  const code=(await productionBlueprintReadiness(saved.doc,task.input.voice)).code;
  if(failedSourceRead){
   if(code!=='copy_review_missing')throw new Error('blueprint_recovery_saved_scope_changed');
  }else if(failedPlanWrite){
   const check=checkSourceBreakdown(saved.doc);
   if(failedDeliveryWrite&&task.input.panelDelivery&&savedAnalysis.source_breakdown
    &&check.issues.every(issue=>repairableBlueprintIssue(issue.code)||issue.code==='delivery_sections_invalid')){
    // The rejected delivery write was atomic. The saved subject can be sound
    // even when the proposed section was invalid; retry only the local draft.
    savedShapeIssue='blueprint_stage_incomplete:[{"code":"delivery_sections_invalid","id":"delivery"}]';
   }else{
    if(!check.issues.length||check.issues.some(issue=>!repairableBlueprintIssue(issue.code)&&!(failedDeliveryWrite&&issue.code==='delivery_sections_invalid'))
     ||(failedDeliveryWrite&&!check.issues.some(issue=>issue.code==='delivery_sections_invalid'))
     ||!code.startsWith('blueprint_stage_incomplete:'))throw new Error('blueprint_recovery_saved_scope_changed');
    savedShapeIssue=code;
   }
  }else if(code!==(savedShapeIssue??'copy_scope_incomplete'))throw new Error('blueprint_recovery_saved_scope_changed');
 }
 const runs=sidecar.runs.filter(run=>run.projectId===task.projectId&&run.backend===(task.input.authorBackend??'api')
  &&run.modelId===task.input.author.model&&run.createdAt>=analysis.at&&run.updatedAt<=task.updatedAt);
 const bound=runs.filter(run=>{
  const events=run.events.flatMap(event=>{
   try{return event.summary?[JSON.parse(event.summary).serverEvent]:[];}catch{return [];}
  }).filter(Boolean);
  const terminal=events.findLast(event=>event.type==='done');
  const write=events.findLast(event=>event.type==='server-tool-result'&&event.data?.name==='revise_clipmentor_analysis'
   &&event.data?.success===true&&event.data.result?.saved===true);
  if(recoveringDeliveryWrite&&!events.some(event=>event.type==='server-tool-result'&&event.data?.name==='revise_clipmentor_analysis'
   &&event.data?.success===false&&event.data.result?.error==='delivery_sections_invalid'))return false;
  const lastWrite=gatewayObservationUnavailable||recoveringDeliveryWrite?events.findLast(event=>event.type==='server-tool-result'
   &&['revise_clipmentor_analysis','edit_asset','save_clipmentor_source_frame'].includes(event.data?.name)
   &&event.data?.success===true&&event.data.result?.saved===true):write;
  if(terminal?.data?.status!==((failedObservation||gatewayObservationUnavailable||failedStoryboardDraftRead||failedPlanWrite||failedSourceRead)?'failed':'completed')
   ||write?.data.result.projectId!==task.projectId||lastWrite?.data.result.projectId!==task.projectId
   ||lastWrite.data.result.projectRevision!==saved.revision
   ||gatewayObservationUnavailable&&write.data.result.revision!==savedAnalysis.revision)return false;
  if(!previousObservation)return true;
  const receiptIndex=events.findIndex(event=>event.type==='server-tool-result'&&event.data?.name==='observe_clipmentor_source_video'
   &&event.data.result?.receipt?.operationId===previousObservation?.operationId);
  return receiptIndex>=0&&events.slice(0,receiptIndex).some(event=>event.type==='server-tool-result'
   &&event.data?.name==='revise_clipmentor_analysis'&&event.data.success===true&&event.data.result?.saved===true
   &&event.data.result?.revision===previousObservation?.subject.revision);

 });
 if(bound.length!==1)throw new Error('blueprint_recovery_author_receipt_unverified');
 const structuralIssue=failedStoryboardDraftRead?'blueprint_stage_incomplete:[{"code":"creator_storyboard_delivery_binding_missing","id":"delivery"}]':savedShapeIssue;
 if(structuralIssue){
  const pause=await structuralRepairPause(task,structuralIssue,savedAnalysis.source.sourceContentHash);
  task.repairContext=productionRepairContext(task.repairContext,{revision:saved.revision,blueprint_structure_issue:structuralIssue});
  if(pause){task.error='Error: '+pause;return;}
 }
 if(failedStoryboardDraftRead){
  task.projectRevision=saved.revision;
  task.repairContext={...task.repairContext,revision:saved.revision,blueprint_structure_issue:'blueprint_stage_incomplete:[{"code":"creator_storyboard_delivery_binding_missing","id":"delivery"}]'};
  recordTechnicalRecovery(task);
  return;
 }
 if(gatewayObservationUnavailable&&previousObservation){
  task.projectRevision=saved.revision;
  task.sourceObservationUnavailableOperation=previousObservation.operationId;
  task.repairContext={...task.repairContext,revision:saved.revision,blueprint_structure_issue:'picture_plan_phase_board_unreadable'};
  recordTechnicalRecovery(task);
  return;
 }
 if(failedSourceRead){
  const dependencies=sourceVideoDependencies();
  const observations=await Promise.all(Object.values(task.effects).filter(effect=>effect.kind==='observation'&&effect.status==='completed')
   .map(effect=>readSourceVideoReceipt(effect.operationId,task.projectId,dependencies).catch(()=>null)));
  if(!observations.some(receipt=>receipt?.source_hash===savedAnalysis.source.sourceContentHash&&receipt?.result?.validation.status==='valid'))
   throw new Error('blueprint_recovery_source_receipt_unverified');
  task.projectRevision=saved.revision;
  task.completed.blueprint={at:Date.now(),artifact:{revision:saved.revision,analysisRevision:savedAnalysis.revision,
   runId:bound[0].runId,recoveredReadOnlyFailure:true}};
  task.stage='copy_review';
  return;
 }
 task.projectRevision=saved.revision;
 task.repairContext={...task.repairContext,revision:saved.revision,
  ...(recoveredObservation?{source_observation_recovery:recoveredObservation}:{blueprint_structure_issue:savedShapeIssue??'copy_scope_incomplete'})};
 if(failedDeliveryWrite)task.deliveryDraftRecoveryUsed=true;
 if(savedShapeIssue)task.repairs++;else recordTechnicalRecovery(task);
}
