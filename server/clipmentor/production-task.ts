import {isCreatorConfirmedReference,type CreatorConfirmedReference} from './production-creator-quality';
import type {BlueprintReviewRecord} from './production-panel-review';
import {compactProductionTaskHistory,newestProductionCheckpoints,orderedProductionCheckpointRecords,decodePublishedProductionCheckpoint,loadPublishedProductionCheckpoint} from './production-task-history';
import {blueprintFindingKeys,blueprintFindings,pictureRepairCoverage,pictureRepairFindings,blueprintRepairStopped,repeatedPictureRepair,productionDecisionEvent,productionEffectDecision,productionRecoveryProgress,type ProductionDecisionDetails} from './production-decisions';
import {loadedProductionGeneration,type ProductionGeneration} from './production-generation';
import type {ProjectDoc} from '../../src/editor/types';
import type {ProjectStoreRequest} from '../../shared/project-store-transport';
import {getStoredEntry,isStoredProjectDeleted} from '../plugins/project-store';
import {runProjectMigrations} from '../../src/persist/migrations';
import {revisionOf} from '../../src/agent/external-edit-session';
import {digestValue} from '../agent-runs/store-values';
export type EntryPreconditions=Extract<ProjectStoreRequest,{operation:'agent-runtime-write'}>['entryPreconditions'];
import {randomUUID,createHash} from 'node:crypto';
import {agentRuntimeKey,appendAgentRunEvent,storeAgentArtifact,loadAgentArtifact,loadAgentRuntimeSidecar} from '../../src/persist/agentRuntimeStore';
import {createRun,flushRunPersistence,setRunStatus,pushRunEvent,recoverServerRun} from '../agent-runs/store';
import {currentAgentSessionGeneration} from '../../src/persist/agentSessionGeneration';
import {LLM_PROVIDER_PRESETS} from '../../shared/llm-providers';
import {confirmedUnsubmittedGateway} from './production-recovery';
import {loadOfflineStoredProject} from '../external-agent/offline-project-store';
import type {ReviewApiConfig} from './copy-review-api';
import {openingComparisonCriterion,openingComparisonShape,parseProductionSourceCriteria,sourcePerformanceCriterion,visualDoneCriteria,type HandoffPolicy,type OpeningComparisonCriterion} from '../../shared/clipmentor-handoff';
import {frozenTeachingTopics} from './production-source-policy';
import {assertFinalPreviewEvidence} from './production-preview-facts';
import {previewAlignmentFindingKeys,previewAlignmentRepairPause,previewReviewRepairBlock} from './preview-review';
import {productionDeadline} from './production-preview-retry';
import {sharedPreviewReviewPause,matchingSharedPreviewProblem} from './production-shared-review';
import {productionDeliverables} from './production-deliverables';
import {feedbackProjectDigest,matchesExportedPreviewProject} from './production-feedback';
import {sha256File} from '../../shared/node-content-hash';
import {verifyProductionOutput} from './production-format';
import {resolveUploadFile,isSafeUploadName} from '../media-dir';
import {boundPanelSalesEvidence,declaredPanelOpening,panelSalesEvidence} from './production-panel-delivery';
import {firstSuspectedGateDefect} from './production-gate-probes';
import type {BlueprintOpinionRecord} from './production-blueprint-opinions';

/** Keep independent findings through intermediate author/structure repairs, never overwrite them with a self-check. */
export function productionRepairContext(previous:Record<string,unknown>|undefined,artifact:Record<string,unknown>){
 const pending=artifact.repair??previous?.pending_review_repair??previous?.repair;
 const history=Array.isArray(previous?.picture_repair_coverage)?previous.picture_repair_coverage as string[]:[];
 const coverage=[...new Set([...history,...pictureRepairCoverage(previous?.last_picture_repair_issue),...pictureRepairCoverage(artifact.blueprint_structure_issue)])];
 const pictureIssue=pictureRepairFindings(artifact.blueprint_structure_issue).length?artifact.blueprint_structure_issue:previous?.last_picture_repair_issue;
 const previewFindings=previewAlignmentFindingKeys(artifact.receipt);
 const priorPreviewFindings=previewFindings.length?previewFindings:previous?.preview_alignment_findings;
 return {...artifact,...(artifact.creator_quality_seen??previous?.creator_quality_seen?{
  creator_quality_seen:artifact.creator_quality_seen??previous?.creator_quality_seen,
  creator_quality_findings:artifact.creator_quality_findings??previous?.creator_quality_findings,
 }:{}),...(priorPreviewFindings?{preview_alignment_findings:priorPreviewFindings}:{}),...(coverage.length?{picture_repair_coverage:coverage}:{}),...(pictureIssue?{last_picture_repair_issue:pictureIssue}:{}),...(previous?.audio_picture_repair?{audio_picture_repair:previous.audio_picture_repair}:{}),...(pending?{pending_review_repair:pending}:{}),
  ...(artifact.teaching_rebuild??previous?.teaching_rebuild?{teaching_rebuild:artifact.teaching_rebuild??previous?.teaching_rebuild}:{}),
  ...(artifact.narration_repair_digest??previous?.narration_repair_digest?{
   narration_repair_digest:artifact.narration_repair_digest??previous?.narration_repair_digest,
   narration_repair_findings:artifact.narration_repair_findings??previous?.narration_repair_findings,
   narration_repair_scope:artifact.narration_repair_scope??previous?.narration_repair_scope,
  }:{}),
  ...(artifact.final_feedback??previous?.final_feedback?{final_feedback:artifact.final_feedback??previous?.final_feedback}:{})};
}

function clearNarrationRepair(context:ProductionTask['repairContext']){
 if(!context)return;
 delete context.narration_repair_digest;
 delete context.narration_repair_findings;
 delete context.narration_repair_scope;
}

export async function structuralRepairPause(task:ProductionTask,issue:unknown,sourceHash?:string|null){
 if(!pictureRepairFindings(issue).length)return;
 if(sourceHash){
  const defect=await firstSuspectedGateDefect(sourceHash,issue);
  if(defect)return 'blueprint_repair_no_progress suspected_gate_defect 待维护侧核对 '+defect;
 }
 const coverage=task.repairContext?.picture_repair_coverage;
 return repeatedPictureRepair(task.repairContext?.last_picture_repair_issue??task.repairContext?.blueprint_structure_issue,
  issue,Array.isArray(coverage)?coverage:[]);
}

export const PRODUCTION_STAGES=['analysis','blueprint','copy_review','audio','edit','export','self_check'] as const;
export type ProductionStage=typeof PRODUCTION_STAGES[number];
export type EffectKind='model'|'review'|'observation'|'tts'|'render'|'preview_review';
export interface EditPublication {
 baseRevision:string;outputDigest:string;requirementsDigest:string;repairEpoch:number;feedbackUsed:boolean;
 artifact:Record<string,unknown>;
}
export interface TeachingAnalysisPublication {
 baseRevision:string;revision:string;repairEpoch:number;inputDigest:string;outputDigest:string;artifact:Record<string,unknown>;
 analysis:NonNullable<ProjectDoc['clipMentorAnalysis']>;
}
export type FrozenTeachingBrief={instruction:string;objective?:string;feedback?:string;doneCriteria?:string[];sourceAdviceSeparated?:true;
 confirmedGroups?:Array<{id:string;decision?:string;firstGlance?:string;points:Array<{id:string;question:string;boundary?:string;treatment:string}>}>};
type OriginalEffectKind=Exclude<EffectKind,'preview_review'>;
type EffectCounts=Record<OriginalEffectKind,number>&Partial<Record<'preview_review',number>>;
export interface ProductionInput {
 projectId:string;sourceAssetId:string;product:{name:string;category:string};brief:string;
 openingComparison?:OpeningComparisonCriterion;
 doneCriteria?:ReturnType<typeof parseProductionSourceCriteria>;
 sourceClosingRegistration?:true;
 author:ReviewApiConfig;reviewer:ReviewApiConfig;
 voice?:{provider:string;voiceId:string};
 humanBlueprintReview?:true;
 gatewayRecovery?:'bounded'|'none';
 blueprintGeneration?:ProductionGeneration;
 panelDelivery?:{productAssetId:string;productAssetHash:string;salesAssetId:string;ctaAssetId:string;ctaAssetHash:string;
  bookends?:'layered-v1';partnerEnding?:'product_storyboard_pdf';editorialPolicy?:'exemplar-v1';selectionPolicy?:'v1';firstGlanceWriting?:true;blueprintQuality?:'v1';creatorQuality?:'v1';creatorReference?:CreatorConfirmedReference;salesAssetHash?:string;salesEvidenceId?:string;salesEvidenceSha256?:string;audience?:'new_contact'|'existing_partner'};
 authorBackend?:'codex';
 reviewerBackend?:'codex';
 budget:EffectCounts&{maxElapsedMs:number;maxRepairs:number;routine?:EffectCounts};
}
export interface ProductionTask {
 productionChild?:{projectId:string;taskId:string;audience:'new_contact'|'existing_partner'};
 productionChildren?:Array<{projectId:string;taskId:string;audience:'new_contact'|'existing_partner'}>;
 sharedProduction?:{projectId:string;taskId:string;prepared?:true;endFrame?:number;digest?:string;workStartedAt?:number};
 previewReviewRetry?:{operationId:string;priorOperationId:string;renderId:string;videoSha256:string;reason:string;authorizedAt:number;readOnly?:true};
 blueprintApproval?:{sourceProjectId:string;sourceTaskId:string;sourceRevision:string;digest:string;requirementsDigest:string;requirements?:HandoffPolicy;teachingBrief?:FrozenTeachingBrief;confirmedTeachingDigest?:string;openingPictureAdjustment?:{before:string;after:string};confirmedAt:number};
 blueprintReview?:BlueprintReviewRecord;
 finalAcceptance?:{renderId:string;watched:true;malayReviewed:true;confirmedAt:number};
 version:1;taskId:string;projectId:string;input:ProductionInput;stage:ProductionStage;
 status:'queued'|'running'|'blocked'|'awaiting_blueprint'|'awaiting_review'|'completed'|'cancelled';
 blueprintFeedback?:string;
 blueprintOpinions?:BlueprintOpinionRecord;
 blueprintOpinionNotes?:BlueprintOpinionRecord;
 blueprintFeedbackEpoch?:number;
 blueprintFeedbackRevision?:string;
 blueprintFeedbackUnitIds?:string[];
 blueprintFeedbackRepair?:number;
 blueprintFeedbackSummary?:{sourceDigest:string;points:string[]};
 previousBlueprintTeaching?:{revision:string;selection?:string;narration?:string};
 executionGenerations?:Array<ProductionGeneration&{checkpoint:number;repairEpoch:number;stage:ProductionStage;kind:'start'|'resume'}>;
 productionQueuedAt?:number;
 visualAcceptance?:{criteriaDigest:string;renderId:string;confirmedIds:string[];scope?:'whole_preview'};
 createdAt:number;updatedAt:number;sequence:number;feedback?:string;feedbackUsed:boolean;repairs:number;technicalRecoveryEpochs?:number[];focusedBlueprintIssues?:string[];deliveryDraftRecoveryUsed?:true;sourceEvidenceRecoveryOperation?:string;sourceObservationUnavailableOperation?:string;focusedAuthorChecks?:string[];authorCheckContractRevision?:number;focusedIndependentUnits?:string[];
 completed:Partial<Record<ProductionStage,{at:number;artifact:Record<string,unknown>}>>;
 effects:Record<string,{kind:EffectKind;operationId:string;status:'reserved'|'completed'|'failed';result?:unknown;error?:string;transportUnsubmitted?:true}>;
 attempts:EffectCounts;error?:string;projectRevision?:string;repairContext?:Record<string,unknown>;
 approvedSourceReadRecovered?:true;
 editPublication?:EditPublication;
 teachingAnalysisPublication?:TeachingAnalysisPublication;
}
export interface TaskStore {save(task:ProductionTask,entryPreconditions?:EntryPreconditions):Promise<void>;load(projectId:string,id:string):Promise<ProductionTask>}

export function isPanelBlueprintDraft(task:ProductionTask){
 return !!(task.input.humanBlueprintReview&&task.input.panelDelivery&&!task.input.panelDelivery.audience&&!task.blueprintApproval);
}

export function panelBlueprintRequirementsDigest(policy:HandoffPolicy|null|undefined){
 const doneCriteria=policy?.brief.doneCriteria??[];
 const references=visualDoneCriteria(doneCriteria).map(criterion=>
  policy?.assetBindings.find(asset=>asset.id===criterion.reference.assetId)??null);
 return digestValue({objective:policy?.brief.objective??null,doneCriteria,...(references.length?{references}:{})});
}

function panelAuthorCheckBound(task:ProductionTask,revision:string,requirementsDigest:string,
 artifact=task.completed.blueprint?.artifact){
 return task.projectRevision===revision&&artifact?.revision===revision
  &&typeof artifact.author_self_check_source_digest==='string'&&/^[a-f0-9]{64}$/.test(artifact.author_self_check_source_digest)
  &&typeof artifact.teaching_baseline_digest==='string'&&/^[a-f0-9]{64}$/.test(artifact.teaching_baseline_digest)
  &&artifact.requirementsDigest===requirementsDigest
  &&(!task.input.doneCriteria?.length||artifact.sourceCriteriaDigest===digestValue(task.input.doneCriteria));
}

export function panelAuthorCheckMatches(task:ProductionTask,revision:string,requirementsDigest:string,artifact=task.completed.blueprint?.artifact){
 return artifact?.authorSelfCheck==='passed'&&panelAuthorCheckBound(task,revision,requirementsDigest,artifact);
}

function incompletePanelAuthorAttachment(artifact:Record<string,unknown>|undefined){
 // Earlier checkpoints used needs_human_review for a damaged attachment even
 // when no business finding survived reference validation.
 return artifact?.authorSelfCheckFinding===undefined
  &&Array.isArray(artifact?.authorSelfCheckReferenceIssues)&&artifact.authorSelfCheckReferenceIssues.length>0;
}

export function panelAuthorNeedsHumanReview(task:ProductionTask,revision:string,requirementsDigest:string,artifact=task.completed.blueprint?.artifact){
 return artifact?.authorSelfCheck==='needs_human_review'&&typeof artifact.authorSelfCheckNotice==='string'
  &&!!artifact.authorSelfCheckNotice.trim()&&!incompletePanelAuthorAttachment(artifact)
  &&panelAuthorCheckBound(task,revision,requirementsDigest,artifact);
}

export function panelAuthorCheckPending(task:ProductionTask,revision:string,requirementsDigest:string,artifact=task.completed.blueprint?.artifact){
 return (artifact?.authorSelfCheck==='pending'||artifact?.authorSelfCheck==='needs_human_review')
  &&incompletePanelAuthorAttachment(artifact)&&panelAuthorCheckBound(task,revision,requirementsDigest,artifact);
}


/** Requalify a saved unchecked draft only when its original execution is still authorized. */
export async function requeuePanelAuthorCheck(task:ProductionTask){
 const revision=task.projectRevision;
 if(!isPanelBlueprintDraft(task)||task.productionChild||task.productionChildren?.length
  ||task.status!=='awaiting_blueprint'||task.stage!=='copy_review'||!revision||task.completed.blueprint?.artifact.revision!==revision
  ||Date.now()>=task.createdAt+task.input.budget.maxElapsedMs||task.attempts.model>=task.input.budget.model)return false;
 if((await latestPanelProductionTask(task.projectId))?.taskId!==task.taskId)return false;
 const policy=await productionReviewRequirements(task.projectId);
 const requirementsDigest=panelBlueprintRequirementsDigest(policy);
 if(panelAuthorCheckMatches(task,revision,requirementsDigest)||panelAuthorNeedsHumanReview(task,revision,requirementsDigest)
  ||panelAuthorCheckPending(task,revision,requirementsDigest))return false;
 const key='project:'+task.projectId,project=await getStoredEntry(key);
 const doc=project.found?runProjectMigrations(project.value)?.doc:undefined;
 if(!doc||revisionOf(doc)!==revision||doc.clipMentorAnalysis?.source.asset_id!==task.input.sourceAssetId)return false;
 const {handoffKey}=await import('./handoff');
 const policyKey=handoffKey(task.projectId),policyEntry=await getStoredEntry(policyKey);
 if((policyEntry.found&&digestValue(policyEntry.value)!==digestValue(policy))
  ||(await productionReviewRequirements(task.projectId))?.digest!==policy?.digest)return false;
 const guards=[{key,digest:digestValue(project.value)},{key:policyKey,digest:policyEntry.found?digestValue(policyEntry.value):null}];
 const pending=task.repairContext?.pending_blueprint_feedback as {text?:string;revision?:string;unitIds?:string[]}|undefined;
 if(pending)return pending.revision===revision&&(await queueDraftBlueprintFeedback(task,revision,pending.text,productionTaskStore,guards,pending.unitIds,task.blueprintOpinions))==='queued';
 const next={...structuredClone(task),status:'queued' as const};
 delete next.error;
 delete next.completed.copy_review;
 await saveProductionControl(task,next,productionTaskStore,guards);
 Object.assign(task,next);
 return true;
}

function clearProductionStagesFrom(task:ProductionTask,stage:ProductionStage){
 for(const invalidated of PRODUCTION_STAGES.slice(PRODUCTION_STAGES.indexOf(stage)))delete task.completed[invalidated];
 if(PRODUCTION_STAGES.indexOf(stage)<=PRODUCTION_STAGES.indexOf('edit'))delete task.editPublication;
 if(stage==='analysis')delete task.teachingAnalysisPublication;
}

export function invalidateReconciledProductionStages(task:ProductionTask,before:Pick<ProductionTask,'stage'|'repairs'>){
 const previous=PRODUCTION_STAGES.indexOf(before.stage),current=PRODUCTION_STAGES.indexOf(task.stage);
 if(current<previous||current===previous&&task.repairs>before.repairs)clearProductionStagesFrom(task,task.stage);
}

export async function saveProductionCheckpoint(store:TaskStore,task:ProductionTask,guards?:EntryPreconditions){
 const previousSequence=task.sequence;
 try{await store.save(task,guards);}
 catch(error){
  // A write can commit before the caller receives its acknowledgement.
  // Match the full new checkpoint, including the sequence assigned by the writer.
  if(task.sequence===previousSequence+1){
   const saved=await store.load(task.projectId,task.taskId).catch(()=>undefined);
   if(saved?.sequence===task.sequence&&digestValue(saved)===digestValue(JSON.parse(JSON.stringify(task))))return;
  }
  throw error;
 }
}
export async function compactProductionCheckpoints(task:ProductionTask){
 for(let batch=0;batch<64&&await compactProductionTaskHistory(task.projectId,task.taskId);batch++){ /* bounded, lossless compaction to the existing low-water mark */ }
}
export const productionTaskStore:TaskStore={
 async save(task,entryPreconditions){
  await compactProductionCheckpoints(task);
  task.updatedAt=Math.max(Date.now(),task.updatedAt+1);task.sequence++;
  const body=JSON.stringify({type:'clipmentor-production-task/v1',task});
  const ok=await storeAgentArtifact({version:1,artifactId:`p_${randomUUID().replaceAll('-','').slice(0,18)}`,projectId:task.projectId,runId:task.taskId,
   kind:'checkpoint-source',toolName:'clipmentor-production-task',body,bodySha256:createHash('sha256').update(body).digest('hex'),
   originalBytes:Buffer.byteLength(body),originalChars:body.length,createdAt:task.updatedAt,redacted:false,binaryOmitted:false},entryPreconditions);
  if(!ok)throw new Error('Production checkpoint could not be persisted');
 },
 async load(projectId,id){
  const sidecar=await loadAgentRuntimeSidecar(projectId);
  const records=orderedProductionCheckpointRecords(sidecar.artifacts.filter(a=>a.runId===id&&a.toolName==='clipmentor-production-task'));
  let latest:ProductionTask|undefined;
  for await(const record of records){
   const artifact=await loadPublishedProductionCheckpoint(record);
   // An indexed-but-unreadable checkpoint is unknown, not permission to roll
   // counters, submitted operations or human decisions back to an older body.
   const candidate=decodePublishedProductionCheckpoint(artifact,record,projectId,id);
   if(!latest){
    if(!isInterruptedReviewCheckpoint(candidate))return candidate;
    latest=candidate;
    continue;
   }
   if(candidate.sequence<latest.sequence)break;
   if(candidate.sequence!==latest.sequence)continue;
   const snapshot=await loadOfflineStoredProject(projectId);
   const saved=snapshot?.doc.clipMentorAnalysis?.production_copy_review;
   if(snapshot&&saved&&isSettledSiblingReview(latest,candidate,snapshot.revision,saved.content_digest,saved.verdict))return candidate;
  }
  if(latest)return latest;
  throw new Error('Production task not found');
 }
};
export async function latestPanelProductionTask(projectId:string){
  const rank=(value:ProductionTask)=>value.input.openingComparison?2:value.input.panelDelivery?1:0;
 const sidecar=await loadAgentRuntimeSidecar(projectId);
 const records=newestProductionCheckpoints(sidecar.artifacts.filter(a=>a.toolName==='clipmentor-production-task'));
 const seen=new Set<string>();
 let latest:ProductionTask|undefined;
 for(const record of records){
  // Older checkpoints cannot contain a newer task, but may still contain the
  // highest-ranked authority. Only use the date shortcut after finding one.
  if(latest&&rank(latest)===2&&record.createdAt<=latest.createdAt)break;
  if(seen.has(record.runId))continue;
  seen.add(record.runId);
  const task=await productionTaskStore.load(projectId,record.runId);
  if(!task.input.humanBlueprintReview)continue;
  // An auxiliary generic task cannot replace the panel's frozen delivery authority.
  if(!latest||rank(task)>rank(latest)||rank(task)===rank(latest)&&task.createdAt>latest.createdAt)latest=task;
 }
 return latest;
}
/** Host-owned requirements for a confirmed output variant, never an execution-role policy. */
export async function productionReviewRequirements(projectId:string){
 const {readHandoffPolicy}=await import('./handoff');
 return await readHandoffPolicy(projectId)??(await latestPanelProductionTask(projectId))?.blueprintApproval?.requirements??null;
}
export function confirmedGroupsFromBlueprint(doc:ProjectDoc):FrozenTeachingBrief['confirmedGroups']{
 const analysis=doc.clipMentorAnalysis,breakdown=analysis?.source_breakdown;
 if(!breakdown)return;
 const units=analysis.blueprint.map(entry=>breakdown.units.find(unit=>unit.unit_id===entry.unit_id));
 if(units.length!==breakdown.units.length||!units.every(unit=>unit!==undefined)||new Set(units).size!==units.length)return;
 return units.map(unit=>({id:unit.unit_id,
  ...(unit.teaching_selection?.decision?{decision:unit.teaching_selection.decision}:{}),
  ...(unit.teaching_selection?.first_glance?{firstGlance:unit.teaching_selection.first_glance}:{}),
  points:unit.coverage.flatMap(({point_id,treatment})=>{
   const point=breakdown.points.find(p=>p.point_id===point_id);
   return point?[{id:point_id,question:point.teaching_question,treatment,
    ...(point.teaching_basis?.claim_limit?{boundary:point.teaching_basis.claim_limit}:{})}]:[];
  })}));
}

/** A confirmed output cannot be reviewed against a fresh or partial selection. */
export function assertConfirmedReviewGroups(task:ProductionTask|undefined,approvedDoc?:ProjectDoc){
 if(!task?.blueprintApproval||!task.input.panelDelivery?.audience||
  task.input.panelDelivery.editorialPolicy!=='exemplar-v1')return;
 const groups=task.blueprintApproval.teachingBrief?.confirmedGroups;
 if(!Array.isArray(groups)||!groups.length)throw Error('production_confirmed_groups_missing');
 if(approvedDoc&&digestValue(groups)!==digestValue(confirmedGroupsFromBlueprint(approvedDoc)))
  throw Error('production_confirmed_groups_changed');
}

export async function productionCopyRequirements(projectId:string){
 const {readHandoffPolicy}=await import('./handoff');
 const saved=await readHandoffPolicy(projectId),task=await latestPanelProductionTask(projectId);
 assertConfirmedReviewGroups(task);
 if(task?.blueprintApproval?.teachingBrief?.confirmedGroups?.length){
  const original=await loadOfflineStoredProject(task.blueprintApproval.sourceProjectId);
  if(original?.revision!==task.blueprintApproval.sourceRevision)throw Error('production_confirmed_blueprint_source_stale');
  assertConfirmedReviewGroups(task,original.doc);
 }
 const policy=saved??task?.blueprintApproval?.requirements??null;
 const doc=task?.input.panelDelivery
  ?(await loadOfflineStoredProject(projectId))?.doc:undefined;
 if(task?.blueprintApproval?.teachingBrief?.confirmedGroups?.length&&!doc)
  throw Error('production_confirmed_groups_changed');
 assertConfirmedReviewGroups(task,doc);
 const opening=productionOpeningComparison(task,policy,doc);
 return {policy,opening,teachingBrief:productionTeachingBrief(task,policy,doc),
  endingPictures:task?.input.panelDelivery?.editorialPolicy==='exemplar-v1'};
}

export function productionTeachingBrief(task:ProductionTask|undefined,policy:HandoffPolicy|null,doc:ProjectDoc|undefined):FrozenTeachingBrief|undefined{
 const frozen=task?.blueprintApproval?.teachingBrief;
 if(!task||!frozen)return;
 const objective=policy?.brief.objective??frozen.objective;
 const criteria=policy?policy.brief.doneCriteria.filter((item):item is string=>typeof item==='string')
  :task.input.openingComparison?.results?[]:frozen.doneCriteria??[];
 // Preserve the identity of receipts from already approved outputs. New
 // approvals freeze the viewed teaching without importing advice as criteria.
 const historicalRequest=doc&&!frozen.sourceAdviceSeparated?frozenTeachingTopics(doc,task)?.quote:undefined;
 const doneCriteria=[...new Set(historicalRequest?[historicalRequest,...criteria]:criteria)];
 const confirmedGroups=frozen.confirmedGroups;
 return {instruction:frozen.instruction,...(objective!==undefined?{objective}:{}),
  ...(frozen.feedback!==undefined?{feedback:frozen.feedback}:{}),...(doneCriteria.length?{doneCriteria}:{}),
  ...(confirmedGroups?.length?{confirmedGroups}:{})};
}

export function productionOpeningComparison(task:ProductionTask|null|undefined,policy:HandoffPolicy|null|undefined,doc:ProjectDoc|undefined){
 const criteria=policy?.brief.doneCriteria??[],scope=task?.input.panelDelivery;
 const opening=task?.input.openingComparison,operator=openingComparisonCriterion(criteria);
 const performance=sourcePerformanceCriterion(task?.input.doneCriteria??[]);
 if(performance){
  if(!doc)throw Error('source_performance_binding_changed');
  const approved=declaredPanelOpening(doc,performance,task?.input.sourceAssetId??performance.source.assetId,
   scope?.salesAssetId??performance.evidence.assetId);
  if(scope){
   const expected=panelSalesEvidence(performance.source.assetId,performance.evidence.assetId,approved.results);
   const generic=panelSalesEvidence(performance.source.assetId,performance.evidence.assetId);
   // An earlier generic intake froze the image attribution. Its sealed receipt
   // remains intact when an editor explicitly declares results for the same bytes.
   const receipt=[expected,generic].find(candidate=>
    scope.salesEvidenceSha256===createHash('sha256').update(candidate.text).digest('hex'));
   const registered=doc.clipMentorAnalysis&&boundPanelSalesEvidence(doc,scope);
   if(scope.salesAssetHash!==performance.evidence.sha256||scope.salesEvidenceId!==expected.evidence_id
    ||!receipt||opening?.results&&panelSalesEvidence(performance.source.assetId,performance.evidence.assetId,opening.results).text!==expected.text
    ||doc.clipMentorAnalysis&&(!registered||registered.text!==receipt.text))
    throw Error('source_performance_evidence_changed');
  }
  return approved;
 }
 if(scope&&(opening?.results||operator?.results))throw Error('source_performance_declaration_required');
 return operator??opening;
}
function isInterruptedReviewCheckpoint(task:ProductionTask){
 return task.status==='blocked'&&task.stage==='copy_review'
  &&task.error==='Error: production_project_changed; reconcile the saved project before resuming';
}
/** A same-sequence stale writer cannot hide a settled outcome already bound to the saved project. */
export function isSettledSiblingReview(stale:ProductionTask,settled:ProductionTask,revision:string,digest:string,verdict:string){
 if(!isInterruptedReviewCheckpoint(stale)||settled.status!=='blocked'||settled.stage!==stale.stage
  ||settled.taskId!==stale.taskId||settled.projectId!==stale.projectId||settled.sequence!==stale.sequence
  ||settled.repairs!==stale.repairs||settled.projectRevision!==revision
  ||settled.blueprintFeedback!==stale.blueprintFeedback
  ||JSON.stringify(settled.input)!==JSON.stringify(stale.input)||JSON.stringify(settled.attempts)!==JSON.stringify(stale.attempts)
  ||JSON.stringify(settled.completed)!==JSON.stringify(stale.completed))return false;
 const changed=Object.entries(stale.effects).filter(([key,effect])=>JSON.stringify(settled.effects[key])!==JSON.stringify(effect));
 if(changed.length!==1||Object.keys(settled.effects).length!==Object.keys(stale.effects).length)return false;
 const [key,before]=changed[0],after=settled.effects[key];
 if(!key.startsWith(`copy_review:${stale.feedbackUsed?'feedback':'initial'}:${stale.repairs}:`)
  ||before.kind!=='review'||before.status!=='reserved'||after?.kind!=='review'||after.status!=='completed'||after.operationId!==before.operationId)return false;
 const result=after.result as {status?:number;body?:{operationId?:string;receipt?:{content_digest?:string;verdict?:string}}}|undefined;
 return result?.status===200&&result.body?.operationId===after.operationId
  &&result.body.receipt?.content_digest===digest&&result.body.receipt.verdict===verdict;
}
const maxTechnicalRecoveries=3;
export function remainingContentRepairs(task:ProductionTask){
 const technical=new Set(task.technicalRecoveryEpochs?.filter(epoch=>Number.isSafeInteger(epoch)&&epoch>0&&epoch<=task.repairs));
 // Panel batches spend from the saved hard cap; old explicit one-off budgets keep their contract.
 const limit=task.input.budget.routine?task.input.budget.model:task.input.budget.maxRepairs;
 return Math.max(0,limit-(task.repairs-technical.size));
}
/** After the general repair window, continue only against a concrete and shrinking defect list. */
export function grantFocusedBlueprintRepair(task:ProductionTask,issue:unknown){
 if(!task.input.humanBlueprintReview||typeof issue!=='string'||!issue.startsWith('blueprint_stage_incomplete:')
  ||task.attempts.model>=task.input.budget.model)return false;
 const rows=blueprintFindings(issue);
 if(!rows.length||rows.some(row=>!(['picture_plan_group_explanation_missing','picture_plan_revisits_mismatch','picture_plan_original_order_mismatch'].includes(row.code)
    ||task.input.panelDelivery&&row.id==='delivery'&&['opening_product_image','opening_sales_attribution_unconfirmed','new_contact_cta_image','existing_partner_storyboard','existing_partner_product_image','existing_partner_pdf_binding','existing_partner_composition_invalid'].includes(row.code))))return false;
 const keys=[...new Set(rows.flatMap(blueprintFindingKeys))].sort();
 const previous=task.focusedBlueprintIssues;
 if(previous&&(keys.length>=previous.length||keys.some(key=>!previous.includes(key))))return false;
 task.focusedBlueprintIssues=keys;
 return true;
}

export function grantFocusedAuthorRepair(task:ProductionTask,checks:unknown){
 if(!task.input.humanBlueprintReview||!task.sourceEvidenceRecoveryOperation||!Array.isArray(checks)||!checks.length
  ||task.attempts.model>=task.input.budget.model||checks.some(check=>!['S1','S2','S5','S6','S7'].includes(check?.id)
   ||!['fix','unresolved'].includes(check.status)))return false;
 const ids=[...new Set(checks.map(check=>String(check.id)))].sort();
 const previous=task.focusedAuthorChecks;
 if(previous&&(ids.length>=previous.length||ids.some(id=>!previous.includes(id))))return false;
 task.focusedAuthorChecks=ids;
 return true;
}

export function grantFocusedIndependentRepair(task:ProductionTask,repair:unknown){
 const result=repair as {status?:string;review_approved?:boolean;units?:Array<{unit_id?:string}>;delivery_checks?:Array<{verdict?:string}>}|undefined;
 if(!task.input.humanBlueprintReview||result?.status!=='bound'||result.review_approved!==false
  ||!Array.isArray(result.units)||!result.units.length||result.units.some(unit=>typeof unit.unit_id!=='string')
  ||result.delivery_checks?.some(check=>check.verdict!=='pass')
  ||task.attempts.model>=task.input.budget.model||task.attempts.review>=task.input.budget.review)return false;
 const ids=[...new Set(result.units.map(unit=>unit.unit_id!))].sort();
 const previous=task.focusedIndependentUnits;
 if(previous&&(ids.length>=previous.length||ids.some(id=>!previous.includes(id))))return false;
 task.focusedIndependentUnits=ids;
 return true;
}

export function canRecordTechnicalRecovery(task:ProductionTask){
 return (task.technicalRecoveryEpochs?.length??0)<maxTechnicalRecoveries;
}
export function recordTechnicalRecovery(task:ProductionTask){
 if(!canRecordTechnicalRecovery(task))throw new Error('制作仍需技术处理');
 task.technicalRecoveryEpochs=[...(task.technicalRecoveryEpochs??[]),++task.repairs];
}

/** The counter remains a monotonic operation namespace. Only proven legacy technical transitions receive separate accounting. */
export function legacyTechnicalRecoveryEpochs(history:ProductionTask[],task:ProductionTask){
 const ordered=history.filter(row=>row.projectId===task.projectId&&row.taskId===task.taskId&&row.sequence<=task.sequence)
  .sort((a,b)=>a.sequence-b.sequence);
 const epochs=new Set<number>();
 for(let i=1;i<ordered.length;i++){
  const before=ordered[i-1],after=ordered[i];
  if(before.sequence+1!==after.sequence||before.status!=='blocked'||after.status!=='running'||before.stage!==after.stage
   ||before.repairs+1!==after.repairs||after.repairs>task.repairs||!after.projectRevision
   ||[...new Set([...Object.keys(before.attempts),...Object.keys(after.attempts)])].some(key=>{
    const kind=key as EffectKind;
    return (before.attempts[kind]??0)!==(after.attempts[kind]??0);
   }))continue;
  if((before.stage==='analysis'&&before.repairs===0&&before.attempts.model===1
    &&before.error?.includes('view_asset_frames: Exact video asset or item ID required')
    &&before.error.includes('read_clipmentor_analysis: storyboard_current_plan_unavailable'))
   ||(before.stage==='blueprint'&&before.error==='Error: copy_scope_incomplete'
    &&after.repairContext?.blueprint_structure_issue==='copy_scope_incomplete')
   ||(before.stage==='blueprint'&&before.error?.includes('observe_clipmentor_source_video: Source observation failed; read the saved receipt, do not retry')
    &&before.attempts.observation===1&&after.repairContext?.source_observation_recovery)){
   epochs.add(after.repairs);
  }
 }
 return [...epochs].sort((a,b)=>a-b);
}

export async function reconcileLegacyTechnicalRecoveries(task:ProductionTask){
 if(!task.input.humanBlueprintReview||task.status!=='blocked'
  ||!Array.isArray(task.repairContext?.author_self_check))return;
 const stoppedForRepair=task.stage==='copy_review'&&task.error?.startsWith('Error: 已用完自动返修额度');
 const stoppedOnShape=task.stage==='blueprint'&&task.error?.startsWith('Error: picture_plan_');
 if(!stoppedForRepair&&!stoppedOnShape)return;
 const sidecar=await loadAgentRuntimeSidecar(task.projectId);
 const history:ProductionTask[]=[];
 for(const record of sidecar.artifacts){
  if(record.runId!==task.taskId||record.toolName!=='clipmentor-production-task')continue;
  const artifact=await loadAgentArtifact(task.projectId,record.artifactId);
  if(!artifact)continue;
  history.push(decodePublishedProductionCheckpoint(artifact,record,task.projectId,task.taskId));
 }
 const epochs=legacyTechnicalRecoveryEpochs(history,task);
 if(epochs.length)task.technicalRecoveryEpochs=[...new Set([...(task.technicalRecoveryEpochs??[]),...epochs])].sort((a,b)=>a-b);
}

// Vite can reload the service modules while a production request is awaiting
// a provider. Keep ownership until the original execution actually settles.
const productionProcess=process as typeof process & {clipMentorProductionExecutions?:Map<string,AbortController>};
const cancellations=productionProcess.clipMentorProductionExecutions??=new Map();
export function productionExecutionActive(projectId:string,id:string){
 return cancellations.has(`${projectId}:${id}`);
}
export function cancelActiveProductionTask(projectId:string,id:string){
 const controller=cancellations.get(`${projectId}:${id}`);if(controller)controller.abort(new Error('Production cancelled by user'));return !!controller;
}
export function validateProductionInput(v:ProductionInput){
 if(!v||!/^[A-Za-z0-9_-]{1,160}$/.test(v.projectId)||!v.sourceAssetId||!v.product?.name?.trim()||typeof v.brief!=='string'||!v.brief.trim()||v.brief.length>32000)throw new Error('Invalid production input');
 if(v.doneCriteria!==undefined){
  if(!v.panelDelivery)throw Error('source_criteria_require_panel');
  parseProductionSourceCriteria(v.doneCriteria);
 }
 if(v.openingComparison!==undefined&&(!v.panelDelivery||!openingComparisonShape(v.openingComparison)))throw Error('Invalid opening comparison requirement');
 if(v.blueprintGeneration!==undefined){
  const generation=v.blueprintGeneration;
  if(!generation||v.panelDelivery?.blueprintQuality!=='v1'||generation.qualityRules!=='v1'
   ||generation.referenceRules!==undefined&&generation.referenceRules!=='registered-v1'
   ||generation.creatorRules!==undefined&&generation.creatorRules!=='creator-teaching-v1'&&generation.creatorRules!=='creator-teaching-v2'
   ||generation.commit!==undefined&&(typeof generation.commit!=='string'||! /^[a-f0-9]{40}$/u.test(generation.commit))
   ||generation.trackedChanges!==undefined&&(!generation.commit||typeof generation.trackedChanges!=='boolean'))
   throw Error('Invalid blueprint generation metadata');
 }
 if(v.gatewayRecovery!==undefined&&!['bounded','none'].includes(v.gatewayRecovery))throw Error('Invalid gateway recovery policy');
 for(const config of [v.author,v.reviewer])if(!config?.model?.trim()||!LLM_PROVIDER_PRESETS.some(p=>p.id===config.provider)||!['responses','chat'].includes(config.apiMode))throw new Error('Explicit API author/reviewer configuration required');
 if(v.panelDelivery){
  const {productAssetId,productAssetHash,salesAssetId,ctaAssetId,ctaAssetHash}=v.panelDelivery;
  const ids=[v.sourceAssetId,productAssetId,salesAssetId,ctaAssetId];
  if(v.panelDelivery.audience!==undefined&&!['new_contact','existing_partner'].includes(v.panelDelivery.audience))throw Error('Invalid panel audience');
  if(!v.humanBlueprintReview||ids.some(id=>typeof id!=='string'||!id.trim())||new Set(ids).size!==ids.length
   ||(v.panelDelivery.bookends!==undefined&&v.panelDelivery.bookends!=='layered-v1')
   ||(v.panelDelivery.editorialPolicy!==undefined&&v.panelDelivery.editorialPolicy!=='exemplar-v1')
   ||(v.panelDelivery.selectionPolicy!==undefined&&(v.panelDelivery.selectionPolicy!=='v1'||v.panelDelivery.editorialPolicy!=='exemplar-v1'))
   ||(v.panelDelivery.firstGlanceWriting!==undefined&&(v.panelDelivery.firstGlanceWriting!==true||v.panelDelivery.selectionPolicy!=='v1'))
   ||(v.panelDelivery.blueprintQuality!==undefined&&(v.panelDelivery.blueprintQuality!=='v1'||v.panelDelivery.firstGlanceWriting!==true))
   ||(v.panelDelivery.creatorQuality!==undefined&&(v.panelDelivery.creatorQuality!=='v1'||v.panelDelivery.blueprintQuality!=='v1'))
   ||(v.panelDelivery.creatorReference!==undefined&&(v.panelDelivery.creatorQuality!=='v1'||!isCreatorConfirmedReference(v.panelDelivery.creatorReference)
    ||v.panelDelivery.creatorReference.salesSha256!==v.panelDelivery.salesAssetHash))
   ||(v.panelDelivery.partnerEnding!==undefined&&v.panelDelivery.partnerEnding!=='product_storyboard_pdf')
   ||((v.panelDelivery.salesEvidenceId!==undefined||v.panelDelivery.salesEvidenceSha256!==undefined)
    &&(v.panelDelivery.bookends!=='layered-v1'||typeof v.panelDelivery.salesEvidenceId!=='string'||!v.panelDelivery.salesEvidenceId.trim()
     ||![v.panelDelivery.salesEvidenceSha256,v.panelDelivery.salesAssetHash].every(hash=>typeof hash==='string'&&/^[a-f0-9]{64}$/.test(hash))))
   ||productAssetHash===ctaAssetHash
   ||![productAssetHash,ctaAssetHash].every(hash=>typeof hash==='string'&&/^[a-f0-9]{64}$/.test(hash)))throw new Error('Invalid panel delivery bindings');
 }
 if(!v.budget||!Number.isSafeInteger(v.budget.maxElapsedMs)||v.budget.maxElapsedMs<1||v.budget.maxElapsedMs>86400000||!Number.isSafeInteger(v.budget.maxRepairs)||v.budget.maxRepairs<0||v.budget.maxRepairs>3)throw new Error('Explicit production budget required');
 if(v.budget.routine){
  for(const kind of ['model','review','observation','tts','render','preview_review'] as const){
   const normal=v.budget.routine[kind]??0;
   if(!Number.isSafeInteger(normal)||normal<0||normal>(v.budget[kind]??0))throw new Error(`Invalid routine ${kind} budget`);
  }
 }
 if(v.budget.tts>0&&(!v.voice?.provider?.trim()||!v.voice.voiceId?.trim()))throw new Error('Confirmed voice required for a nonzero TTS budget');
 if(v.budget.preview_review!==undefined&&(!Number.isSafeInteger(v.budget.preview_review)||v.budget.preview_review<0||v.budget.preview_review>1000))throw new Error('Invalid preview_review budget');
 for(const kind of ['model','review','observation','tts','render'] as const)if(!Number.isSafeInteger(v.budget[kind])||v.budget[kind]<0||v.budget[kind]>1000)throw new Error(`Invalid ${kind} budget`);
}
/** New batches freeze recovery authority once; a resumed old task never infers it from spare calls. */
export function freezeProductionInput(input:ProductionInput):ProductionInput{
 validateProductionInput(input);
 return {...structuredClone(input),gatewayRecovery:input.gatewayRecovery
  ??(input.budget.routine&&!input.panelDelivery?.audience?'bounded':'none')};
}
export async function createProductionTask(input:ProductionInput,store?:TaskStore):Promise<ProductionTask>{
 input=freezeProductionInput(input);
 const run=createRun({projectId:input.projectId,sessionGeneration:await currentAgentSessionGeneration(input.projectId),backend:input.authorBackend??'api',provider:input.author.provider,model:input.author.model,askOnly:false});
 await flushRunPersistence(run);
 const now=Date.now(),task:ProductionTask={version:1,taskId:run.id,projectId:input.projectId,input:structuredClone(input),stage:'analysis',status:'queued',createdAt:now,updatedAt:now,sequence:0,
  feedbackUsed:false,repairs:0,completed:{},effects:{},attempts:{model:0,review:0,observation:0,tts:0,render:0}};
 // Continuations supply their own first-checkpoint publication transaction.
 // For ordinary starts, reclaim an exact committed checkpoint before dispatch.
 if(store)await store.save(task);
 else await saveProductionCheckpoint(productionTaskStore,task);
 return task;
}
export interface StageContext {
 effect<T>(kind:EffectKind,key:string,work:(operationId:string)=>Promise<T>,recover?:(operationId:string)=>Promise<T>):Promise<T>;
 signal:AbortSignal;
 assertCurrent?():Promise<void>;
 remaining?(kind:EffectKind):number;
 hasEffect?(kind:EffectKind,key:string):boolean;
 checkpointEditPublication?(publication:EditPublication):Promise<void>;
 checkpointTeachingAnalysis?(publication:TeachingAnalysisPublication):Promise<void>;
}
export interface StageResult {artifact:Record<string,unknown>;repair?:'analysis'|'blueprint'|'edit'|'copy_review';pause?:string;awaitBlueprintFeedback?:true}
export type StageWorker=(task:ProductionTask,ctx:StageContext)=>Promise<StageResult>;

async function checkedHumanBlueprint(task:ProductionTask){
 const key='project:'+task.projectId;
 const stored=await getStoredEntry(key);
 const doc=stored.found?runProjectMigrations(stored.value)?.doc:null;
 if(!doc||revisionOf(doc)!==task.projectRevision||doc.clipMentorAnalysis?.source.asset_id!==task.input.sourceAssetId)
  throw Error('human_blueprint_narration_revision_changed');
 if(task.blueprintOpinions&&!task.repairContext?.pending_blueprint_feedback){
  const {blueprintOpinionDifferences}=await import('./production-blueprint-opinions');
  task.blueprintOpinions.differences=blueprintOpinionDifferences(task.blueprintOpinions,doc);
 }
 return {doc,guard:{key,digest:digestValue(stored.value)}};
}
export class ProductionCheckpointSuperseded extends Error {}
/** Observational context in the existing bounded run log, never a checkpoint or authority.
 * It intentionally has no serverEvent envelope: terminal transport replay stays closed. */
export async function recordProductionDecision(task:ProductionTask,decision:ProductionDecisionDetails){
 try{await appendAgentRunEvent(task.projectId,task.taskId,{type:'context_projected',
  summary:JSON.stringify({productionDecision:productionDecisionEvent(task,decision)})});}
 catch{ /* Diagnostic failure cannot authorize retry, reopen transport or discard saved production. */ }
}
async function withProductionExecution(task:ProductionTask,work:(controller:AbortController)=>Promise<ProductionTask>){
 const key=`${task.projectId}:${task.taskId}`;
 if(cancellations.has(key))throw new Error('Production task already running');
 const controller=new AbortController();
 cancellations.set(key,controller);
 try{return await work(controller);}finally{cancellations.delete(key);}
}
/** Canonical business state is an immutable checkpoint in the existing run/artifact ledger. */
export async function advanceProductionTask(task:ProductionTask,worker:StageWorker,store=productionTaskStore,now=()=>Date.now()):Promise<ProductionTask>{
 return withProductionExecution(task,controller=>advanceWithinExecution(task,worker,store,now,controller));
}
type OnExportPublished=(task:ProductionTask,signal:AbortSignal)=>Promise<void>;
async function advanceWithinExecution(task:ProductionTask,worker:StageWorker,store:TaskStore,now:()=>number,abort:AbortController,onExport?:OnExportPublished){
 if(blueprintRepairStopped(task)||['completed','cancelled'].includes(task.status)
  ||['awaiting_blueprint','awaiting_review'].includes(task.status)&&!abort.signal.aborted)return task;
 const published=async()=>{
  if(task.blueprintApproval&&task.input.panelDelivery?.audience){
   const {publishedProductionParent}=await import('./production-continuation');
   await publishedProductionParent(task);
  }
 };
 let safeCheckpoint=structuredClone(task);
 const restoreSafe=()=>{for(const key of Object.keys(task))delete (task as unknown as Record<string,unknown>)[key];Object.assign(task,structuredClone(safeCheckpoint));};
 const save=async()=>{await saveProductionCheckpoint(store,task);safeCheckpoint=structuredClone(task);};
 const publishStage=async(extraGuards?:EntryPreconditions)=>{
  try{
   const {productionParentControlGuards}=await import('./production-continuation');
   if(store===productionTaskStore)await compactProductionCheckpoints(task);
   const parentGuards=task.blueprintApproval&&task.input.panelDelivery?.audience?await productionParentControlGuards(task):undefined;
   const guards=extraGuards?.length?[...parentGuards??[],...extraGuards]:parentGuards;
   check();await saveProductionCheckpoint(store,task,guards);safeCheckpoint=structuredClone(task);
  }
  catch(error){
   const saved=await store.load(task.projectId,task.taskId).catch(()=>undefined);
   if(saved)safeCheckpoint=structuredClone(saved);
   restoreSafe();throw error;
  }
 };
 const deadline=productionDeadline(task);
 const timer=setTimeout(()=>abort.abort(new Error('Production deadline exceeded')),Math.max(0,deadline-now()));
 const check=()=>{abort.signal.throwIfAborted();if(now()>=deadline)throw new Error('Production deadline exceeded');};
 // Older tasks may already have split counters while still keeping review-kind
 // preview effects. Normalize the effect kind even after the counter migration.
 const legacyPreview=Object.entries(task.effects).filter(([id,e])=>id.startsWith('self_check:')&&e.kind==='review');
 // Older panel tasks counted preview review under review. Split historical
 // effects once without restoring spent attempts or changing their receipts.
 if(task.input.humanBlueprintReview&&task.input.budget.preview_review===undefined){
  const prior=legacyPreview.filter(([,effect])=>!effect.transportUnsubmitted).length;
  task.attempts.preview_review=prior;task.attempts.review=Math.max(0,task.attempts.review-prior);
  task.input.budget.preview_review=3;
 }
 if(task.input.humanBlueprintReview&&task.input.budget.preview_review!==undefined)for(const [,effect] of legacyPreview)effect.kind='preview_review';
 const budgetKind=(kind:EffectKind)=>kind==='preview_review'&&task.input.budget.preview_review===undefined?'review':kind;
 const remaining=(kind:EffectKind)=>Math.max(0,(task.input.budget[budgetKind(kind)]??0)-(task.attempts[budgetKind(kind)]??0));
 const effectKey=(name:string)=>`${task.stage}:${task.feedbackUsed?'feedback':'initial'}:${task.repairs}:${name}`;
 const activeEffects=new Set<string>();
 const ctx:StageContext={signal:abort.signal,remaining,assertCurrent:async()=>{check();await published();check();},
 async checkpointEditPublication(publication){
  if(task.stage!=='edit'||publication.repairEpoch!==task.repairs||publication.feedbackUsed!==task.feedbackUsed
    ||task.projectRevision!==undefined&&publication.baseRevision!==task.projectRevision)
   throw Error('production_edit_publication_binding_mismatch');
  task.editPublication=structuredClone(publication);await publishStage();
 },
 async checkpointTeachingAnalysis(publication){
  if(task.stage!=='analysis'||!isPanelBlueprintDraft(task)||publication.repairEpoch!==task.repairs
   ||task.projectRevision!==undefined&&task.projectRevision!==publication.baseRevision)
   throw Error('production_teaching_analysis_publication_binding_mismatch');
  task.teachingAnalysisPublication=structuredClone(publication);await publishStage();
 },
 hasEffect:(kind,name)=>task.effects[effectKey(name)]?.kind===budgetKind(kind),async effect<T>(kind:EffectKind,name:string,work:(operationId:string)=>Promise<T>,recover?:(operationId:string)=>Promise<T>){
  check();await published();check();const id=effectKey(name);
  const old=task.effects[id];
  if(old&&old.kind!==budgetKind(kind))throw Error('production_effect_kind_mismatch');
  if(activeEffects.has(id))throw Error('production_effect_in_progress');
  activeEffects.add(id);
  try{
  const authorized=kind==='preview_review'&&task.stage==='self_check'&&name===task.previewReviewRetry?.operationId
   &&task.completed.export?.artifact.renderId===task.previewReviewRetry.renderId;
  const allowance=authorized?(task.previewReviewRetry?.readOnly?0:1):remaining(kind);
  const decision=productionEffectDecision(old,!!recover,allowance);
  if(decision.action!=='submit'){
   await recordProductionDecision(task,{scope:'effect',...decision,effectKey:id,...(old?{operationId:old.operationId}:{})});
   check();
  }
  if(decision.action==='reuse'){await published();check();return structuredClone(old!.result) as T;}
  const settle=async(effect:ProductionTask['effects'][string],result:T)=>{
   const unsubmitted=confirmedUnsubmittedGateway(kind,result,effect.operationId,task.projectId);
   task.effects[id]={...effect,status:'completed',result:structuredClone(result),...(unsubmitted?{transportUnsubmitted:true as const}:{})};
   if(unsubmitted&&!effect.transportUnsubmitted)task.attempts[effect.kind]=(task.attempts[effect.kind]??0)-1;
   await save();
   return result;
  };
  if(decision.action==='recover'){
   const result=await recover!(old!.operationId);check();return settle(old!,result);
  }
  if(decision.action==='stop'){
   if(old)throw new Error(`effect_outcome_${old.status}:${old.operationId}; read original receipt, no automatic resubmission`);
   throw new Error(`${kind} budget exhausted`);
  }
  const counter=budgetKind(kind);
  const effect={kind:counter,operationId:/^[a-f0-9-]{36}$/.test(name)?name:randomUUID(),status:'reserved' as const};task.effects[id]=effect;task.attempts[counter]=(task.attempts[counter]??0)+1;await save();
  await recordProductionDecision(task,{scope:'effect',...decision,effectKey:id,operationId:effect.operationId});
  let result:T;
  try{check();await published();check();result=await work(effect.operationId);check();}
  catch(error){task.effects[id]={...effect,status:'failed',error:String(error).slice(0,1200)};await save();throw error;}
  return await settle(effect,result);
  }finally{activeEffects.delete(id);}
 }};
 let exportNotified=false;
 const notifySavedExport=async()=>{
  if(!onExport||exportNotified||!task.completed.export)return;
  exportNotified=true;
  await onExport(task,abort.signal);
  const current=await store.load(task.projectId,task.taskId);
  const content=(v:ProductionTask)=>{
   const {sequence:_,updatedAt:__,sharedProduction:___,input,...rest}=v;
   return digestValue({...rest,input:{...input,author:{...input.author,origin:''},reviewer:{...input.reviewer,origin:''}}});
  };
  if(content(current)!==content(safeCheckpoint))throw new ProductionCheckpointSuperseded('production_checkpoint_superseded');
  // Keep local origin rebinding and pending in-memory counter migrations.
  task.sequence=current.sequence;task.updatedAt=current.updatedAt;
  if(current.sharedProduction)task.sharedProduction=structuredClone(current.sharedProduction);
  else delete task.sharedProduction;
  safeCheckpoint=structuredClone(current);
 };
 try{
  if(task.stage==='export'||task.stage==='self_check'){check();await notifySavedExport();}
  check();
  if(task.input.panelDelivery?.blueprintQuality==='v1'){
   const {creatorRules,...generation}=await loadedProductionGeneration;
   check();await published();check();
   const history=task.executionGenerations??[];
   const started=history.length||task.attempts.model>0||task.repairs>0||task.status!=='queued';
   task.executionGenerations=[...history,{...generation,...(task.input.panelDelivery.creatorQuality==='v1'?{creatorRules}:{}),checkpoint:task.sequence+1,repairEpoch:task.repairs,
    stage:task.stage,kind:started?'resume':'start'}];
  }
  task.status='running';delete task.error;await save();
  for(let index=PRODUCTION_STAGES.indexOf(task.stage);index<PRODUCTION_STAGES.length;){
   check();await published();check();task.stage=PRODUCTION_STAGES[index]!;
   if(task.completed[task.stage]){index++;continue;}
   const result=await worker(task,ctx);check();await published();check();
   if(typeof result.artifact?.revision==='string')task.projectRevision=result.artifact.revision;
   if(result.pause){task.repairContext=productionRepairContext(task.repairContext,result.artifact);throw new Error(result.pause);}
   if(result.repair){
    const issue=result.artifact.blueprint_structure_issue;
    let pause:string|undefined;
    if(result.repair==='blueprint'&&pictureRepairFindings(issue).length){
     const saved=store===productionTaskStore?await loadOfflineStoredProject(task.projectId):null;
     const source=saved?.doc.clipMentorAnalysis?.source;
     pause=await structuralRepairPause(task,issue,source?.asset_id===task.input.sourceAssetId&&saved?.revision===task.projectRevision
      ?source.sourceContentHash:undefined);
    }
    if(task.stage==='self_check'){
     const sharedPause=sharedPreviewReviewPause(task,result.artifact.receipt);
     const scope=result.artifact.final_feedback as {authority?:string}|undefined;
     const targetedEnding=sharedPause==='preview_shared_ending_requires_local_repair'&&scope?.authority==='bound_preview_ending_review';
     pause=(targetedEnding?undefined:sharedPause)??previewAlignmentRepairPause(task.repairContext?.preview_alignment_findings,result.artifact.receipt)
      ??previewReviewRepairBlock(result.artifact.receipt);
    }
    const executionError=result.artifact.execution_validation_error;
    if(task.stage==='edit'&&typeof executionError==='string'&&executionError===task.repairContext?.execution_validation_error)
     pause='execution_mapping_repair_no_progress 待维护侧核对 '+executionError;
    task.repairContext=productionRepairContext(task.repairContext,result.artifact);
    if(pause)throw new Error(pause);
    if(task.input.budget.routine){
     if(remaining('model')<=0)throw new Error('model budget exhausted');
     if(task.stage==='copy_review'&&result.artifact.repair&&remaining('review')<=0)throw new Error('review budget exhausted');
     if(result.repair==='edit'&&remaining('render')<=0)throw new Error('render budget exhausted');
    }
    if(remainingContentRepairs(task)===0
     &&(result.repair!=='blueprint'||(!grantFocusedBlueprintRepair(task,result.artifact.blueprint_structure_issue)
      &&!grantFocusedAuthorRepair(task,result.artifact.author_self_check)
      &&!grantFocusedIndependentRepair(task,result.artifact.repair)))){
     const check=(result.artifact.author_self_check as {reason?:string;teaching_units?:Array<{status:string;unit_id:string;reason:string}>}[]|undefined)?.[0];
     const teachingIssue=check?.teaching_units?.find(unit=>unit.status!=='ok');
     const selfCheck=teachingIssue?teachingIssue.unit_id+' '+teachingIssue.reason:check?.reason;
     const detail=selfCheck??result.artifact.teaching_baseline_issue??result.artifact.blueprint_structure_issue;
     throw new Error(`已用完自动返修额度${typeof detail==='string'?`。未解决：${detail.slice(0,360)}`:''}`);
    }
    task.repairs++;task.stage=result.repair;index=PRODUCTION_STAGES.indexOf(result.repair);
    clearProductionStagesFrom(task,result.repair);
    await publishStage();continue;
   }
   if(!result.artifact||Object.keys(result.artifact).length===0)throw new Error('Stage has no verified artifact');
   if(result.awaitBlueprintFeedback){
    const blueprint=task.completed.blueprint, requirementsDigest=result.artifact.requirementsDigest;
    if(task.stage!=='copy_review'||!isPanelBlueprintDraft(task)||!blueprint
     ||!task.projectRevision||blueprint.artifact.revision!==task.projectRevision||typeof requirementsDigest!=='string'
     ||!/^[a-f0-9]{64}$/.test(requirementsDigest)
     ||(!panelAuthorCheckMatches(task,task.projectRevision,requirementsDigest,result.artifact)
       &&!panelAuthorNeedsHumanReview(task,task.projectRevision,requirementsDigest,result.artifact)
       &&!(task.input.panelDelivery?.editorialPolicy==='exemplar-v1'&&panelAuthorCheckPending(task,task.projectRevision,requirementsDigest,result.artifact))))
     throw Error('human_blueprint_draft_binding_missing');
    let teachingGuards:EntryPreconditions|undefined;
    if(task.input.panelDelivery?.editorialPolicy==='exemplar-v1'||task.blueprintOpinions){
     const {doc,guard}=await checkedHumanBlueprint(task);
     teachingGuards=[guard];
     if(task.input.panelDelivery?.editorialPolicy==='exemplar-v1'){
      const {handoffKey}=await import('./handoff');
      const policyKey=handoffKey(task.projectId),policyEntry=await getStoredEntry(policyKey);
      const policy=await productionReviewRequirements(task.projectId);
      if(panelBlueprintRequirementsDigest(policy)!==requirementsDigest
       ||(policyEntry.found&&digestValue(policyEntry.value)!==digestValue(policy)))
       throw Error('human_blueprint_narration_requirements_changed');
      const {panelNarrationPublication}=await import('./production-teaching-baseline');
      const publication=panelNarrationPublication(doc,task,result.artifact.teaching_baseline_digest,requirementsDigest);
      const previous=task.previousBlueprintTeaching;
      let change=!previous?'首份送审蓝图。':!previous.selection||!previous.narration?'上一版缺少可比对的教学审核记录。'
       :[previous.selection===publication.teachingSelectionDigest?'选题保持原样':'选题或教学判断有调整',
         previous.narration===publication.teachingNarrationDigest?'已核口播保持原样':'已核口播有调整'].join('，')+'。';
      if(previous&&(previous.selection!==publication.teachingSelectionDigest||previous.narration!==publication.teachingNarrationDigest)){
       const decisions=publication.independentNarrationAnswers.flatMap(answer=>answer.decision?[answer.decision]:[]);
       if(decisions.length)change+='本版讲的拍摄决定包括'+decisions.slice(0,2).join('、').replace(/[。.!！]+$/u,'')+'。';
      }
      Object.assign(result.artifact,publication,{teachingDecisionChange:change});
      teachingGuards.push({key:policyKey,digest:policyEntry.found?digestValue(policyEntry.value):null});
     }
    }
    blueprint.artifact={...blueprint.artifact,...result.artifact};
    clearNarrationRepair(task.repairContext);
    task.status='awaiting_blueprint';await publishStage(teachingGuards);break;
   }
   if(task.stage==='copy_review'&&isPanelBlueprintDraft(task)&&task.input.panelDelivery?.editorialPolicy==='exemplar-v1')
    throw Error('human_blueprint_draft_binding_missing');
   let humanApprovalRequired=false;
   let reviewGuards:EntryPreconditions|undefined;
   if(task.input.humanBlueprintReview&&task.stage==='copy_review'){
    if(!task.projectRevision||result.artifact.revision!==task.projectRevision
     ||result.artifact.authorSelfCheck!=='passed'||(result.artifact.gate as {allowed?:boolean}|undefined)?.allowed!==true
     ||task.input.panelDelivery&&result.artifact.panelDeliveryVerified!==true)
     throw new Error('human_blueprint_verified_receipts_missing');
    humanApprovalRequired=!task.blueprintApproval||task.blueprintApproval.digest!==result.artifact.blueprint_digest
     ||typeof task.blueprintApproval.requirementsDigest!=='string'||task.blueprintApproval.requirementsDigest!==result.artifact.requirementsDigest;
    if(humanApprovalRequired&&task.blueprintApproval?.requirementsDigest===result.artifact.requirementsDigest
     &&task.blueprintApproval?.teachingBrief?.confirmedGroups?.length){
     const {doc,guard}=await checkedHumanBlueprint(task);
     const {confirmedProductionRefinement}=await import('./production-continuation');
     const approvalGuard=await confirmedProductionRefinement(task,doc);
     if(approvalGuard){humanApprovalRequired=false;reviewGuards=[guard,approvalGuard];}
    }
    if(humanApprovalRequired&&task.blueprintOpinions&&!task.repairContext?.pending_blueprint_feedback){
     const {guard}=await checkedHumanBlueprint(task);
     reviewGuards=[guard];
    }
   }
   task.completed[task.stage]={at:now(),artifact:result.artifact};
   if(task.stage==='edit')delete task.editPublication;
   if(task.stage==='analysis'){
    delete task.teachingAnalysisPublication;
    clearNarrationRepair(task.repairContext);
   }
   if(task.stage==='copy_review'&&(result.artifact.gate as {allowed?:boolean}|undefined)?.allowed===true&&task.repairContext){
    delete task.repairContext.pending_review_repair;delete task.repairContext.repair;
   }
   if(humanApprovalRequired){
    task.status='awaiting_blueprint';await publishStage(reviewGuards);break;
   }
   await publishStage(reviewGuards);
   if(task.stage==='export')await notifySavedExport();
   index++;
  }
  if(task.status==='running'){task.status='awaiting_review';await publishStage();}
  if(abort.signal.aborted&&String(abort.signal.reason).includes('cancelled by user'))abort.signal.throwIfAborted();
 }catch(error){
  if(error instanceof ProductionCheckpointSuperseded)throw error;
  task.status=abort.signal.aborted&&String(abort.signal.reason).includes('cancelled by user')?'cancelled':'blocked';
  task.error=String(error).slice(0,1600);
  try{await save();}
  catch(persistenceError){task.error=`${task.error}; checkpoint_write_failed: ${String(persistenceError).slice(0,500)}; last persisted checkpoint is authoritative, do not resubmit unknown effects`;}
 }
 finally{clearTimeout(timer);}
 const run=await recoverServerRun(task.projectId,task.taskId);
 if(run){run.error=task.error??null;pushRunEvent(run,'production-stage',{stage:task.stage,status:task.status,attempts:task.attempts,error:task.error});await setRunStatus(run,['awaiting_blueprint','awaiting_review'].includes(task.status)?'awaiting-user':task.status==='cancelled'?'cancelled':'failed');}
 return task;
}
/** Keep recoverable checkpoints within the same server job and ownership window. */
export async function runProductionWithRecovery(task:ProductionTask,worker:StageWorker,
 reconcile:(task:ProductionTask)=>Promise<void>,store=productionTaskStore,prepare?:(signal:AbortSignal)=>Promise<boolean>,onExport?:OnExportPublished){
 return withProductionExecution(task,async controller=>{
  const advance=()=>advanceWithinExecution(task,worker,store,Date.now,controller,onExport);
  let deadline=productionDeadline(task);
  const armDeadline=()=>setTimeout(()=>controller.abort(new Error('Production deadline exceeded')),Math.max(0,deadline-Date.now()));
  let timer=armDeadline();
  try{
  if(blueprintRepairStopped(task)||['completed','cancelled','awaiting_blueprint','awaiting_review'].includes(task.status))return task;
  if(prepare){
   try{
    const checkPreparation=()=>{if(Date.now()>=deadline&&!controller.signal.aborted)controller.abort(new Error('Production deadline exceeded'));controller.signal.throwIfAborted();};
    checkPreparation();
    const ready=await prepare(controller.signal);
    checkPreparation();
    if(!ready)return task;
    if(task.sharedProduction?.workStartedAt!==undefined&&productionDeadline(task)!==deadline){
     clearTimeout(timer);deadline=productionDeadline(task);timer=armDeadline();
    }
   }catch(error){
    if(!controller.signal.aborted)throw error;
    // Preparation may have failed before it replaced the dispatch snapshot.
    // A cancellation or deadline cannot use that snapshot to write a new state.
    const saved=await store.load(task.projectId,task.taskId);
    Object.assign(task,saved);
    if(['awaiting_blueprint','awaiting_review'].includes(task.status)&&!String(controller.signal.reason).includes('cancelled by user'))return task;
    return advance();
   }
  }
  await advance();
  while(task.status==='blocked'&&!blueprintRepairStopped(task)){
   const from={stage:task.stage,repairs:task.repairs};
   const stop=(reason:'cancelled_or_expired'|'checkpoint_unpersisted'|'no_verified_progress')=>recordProductionDecision(task,{scope:'recovery',action:'stop',reason,fromStage:from.stage,fromEpoch:from.repairs});
   if(controller.signal.aborted||Date.now()>=productionDeadline(task)){await stop('cancelled_or_expired');return advance();}
   if(task.error?.includes('checkpoint_write_failed:')){await stop('checkpoint_unpersisted');return task;}
   const repaired=structuredClone(task);
   try{
     if(task.blueprintApproval&&task.input.panelDelivery?.audience){
      const {publishedProductionParent}=await import('./production-continuation');await publishedProductionParent(task);
     }
     await reconcile(repaired);
    }catch(error){
    if(controller.signal.aborted)return advance();
    task.error=`${task.error??'Production blocked'}; recovery: ${String(error).slice(0,500)}`.slice(0,1600);
    await saveProductionCheckpoint(store,task);
    return controller.signal.aborted?advance():task;
   }
   if(controller.signal.aborted)return advance();
   if(blueprintRepairStopped(repaired)){
    Object.assign(task,repaired);await saveProductionCheckpoint(store,task);return task;
   }
   if(!productionRecoveryProgress(repaired,from,PRODUCTION_STAGES)){await stop('no_verified_progress');return task;}
   invalidateReconciledProductionStages(repaired,from);
   Object.assign(task,repaired);
   await advance();
  }
  return task;
  }finally{clearTimeout(timer);}
 });
}
function blueprintFeedbackBudgetExhausted(task:ProductionTask){
 return task.attempts.model>=task.input.budget.model||Date.now()>=task.createdAt+task.input.budget.maxElapsedMs;
}

async function saveBlueprintFeedback(task:ProductionTask,revision:string,text:string,dispatch:boolean,store:TaskStore,guards?:EntryPreconditions,unitIds?:string[],opinions?:BlueprintOpinionRecord){
 const next=structuredClone(task);
 next.blueprintFeedback=text;
 next.blueprintOpinions=opinions;
 next.blueprintFeedbackEpoch=(task.blueprintFeedbackEpoch??0)+1;
 // Clear optional fields explicitly so the live task matches the saved checkpoint on launch.
 next.blueprintFeedbackSummary=undefined;
 if(next.repairContext&&(dispatch||task.blueprintFeedback!==text||task.blueprintFeedbackRevision!==revision)){
  delete next.repairContext.teaching_rebuild;
  delete next.repairContext.teaching_baseline_issue;
  delete next.repairContext.blueprint_structure_issue;
  delete next.repairContext.last_picture_repair_issue;
  delete next.repairContext.picture_repair_coverage;
  clearNarrationRepair(next.repairContext);
 }
 if(dispatch){
  const previous=task.completed.blueprint?.artifact;
  if(previous?.revision===revision&&task.status==='awaiting_blueprint'){
   next.previousBlueprintTeaching={revision,
    selection:typeof previous.teachingSelectionDigest==='string'?previous.teachingSelectionDigest:undefined,
    narration:typeof previous.teachingNarrationDigest==='string'?previous.teachingNarrationDigest:undefined};
  }
  next.error=undefined;
  next.focusedBlueprintIssues=undefined;
  next.focusedAuthorChecks=undefined;
  if(next.repairContext)delete next.repairContext.pending_blueprint_feedback;
  next.projectRevision=revision;
  next.blueprintFeedbackRevision=revision;
  next.blueprintFeedbackUnitIds=unitIds;
  next.stage='blueprint';
  next.status='queued';
  next.repairs++;
  next.blueprintFeedbackRepair=next.repairs;
  clearProductionStagesFrom(next,'blueprint');
  next.editPublication=undefined;
 }else{
  next.repairContext={...next.repairContext,pending_blueprint_feedback:{text,revision,...(unitIds?{unitIds}:{})}};
 }
 if(guards)await saveProductionControl(task,next,store,guards,undefined,task.sequence);else await saveProductionCheckpoint(store,next);
 Object.assign(task,next);
}

export async function resolveHumanBlueprint(task:ProductionTask,displayedRevision:unknown,savedRevision:string|undefined,feedback:unknown,
 store=productionTaskStore,guards?:EntryPreconditions,unitIds?:string[],review?:BlueprintReviewRecord,opinions?:BlueprintOpinionRecord){
 if(!task.input.humanBlueprintReview||task.status!=='awaiting_blueprint'||task.stage!=='copy_review')throw new Error('蓝图当前不在待确认状态');
 if(typeof displayedRevision!=='string'||displayedRevision!==task.projectRevision||displayedRevision!==savedRevision
  ||task.completed.copy_review?.artifact.revision!==displayedRevision
  ||task.completed.copy_review.artifact.authorSelfCheck!=='passed'
  ||(task.completed.copy_review.artifact.gate as {allowed?:boolean}|undefined)?.allowed!==true)throw new Error('蓝图版本已变化，请重新打开审片板');
 if(feedback!==undefined){
  if(typeof feedback!=='string'||!feedback.trim()||feedback.length>8000)throw new Error('请输入有效的蓝图修改意见');
  if(blueprintFeedbackBudgetExhausted(task))throw new Error('本次制作已达到资源上限');
  await saveBlueprintFeedback(task,displayedRevision,feedback.trim(),true,store,guards,unitIds,opinions);
  return task;
 }
 if(task.input.panelDelivery&&!task.input.panelDelivery.audience)throw new Error('dual_delivery_execution_requires_variant_selection');
 const next=structuredClone(task);
 next.blueprintFeedback=undefined;
 next.blueprintOpinions=undefined;
 next.blueprintFeedbackRevision=undefined;
 next.blueprintFeedbackUnitIds=undefined;
 next.blueprintFeedbackRepair=undefined;
 next.blueprintFeedbackSummary=undefined;
 if(review)next.blueprintReview=review;
 next.stage='audio';
 next.status='queued';
 if(guards)await saveProductionControl(task,next,store,guards);else await saveProductionCheckpoint(store,next);
 Object.assign(task,next);return task;
}
/** Publish the revision request before dispatch. A cold worker can claim the same queue. */
export function acceptsDraftBlueprintFeedback(task:ProductionTask,revision:string){
 return task.input.humanBlueprintReview&&['blueprint','copy_review'].includes(task.stage)
  &&(task.status==='blocked'||task.status==='awaiting_blueprint'
    &&(revision!==task.projectRevision||!task.completed.copy_review));
}

export async function queueDraftBlueprintFeedback(task:ProductionTask,revision:string,feedback:unknown,store=productionTaskStore,
 guards?:EntryPreconditions,unitIds?:string[],opinions?:BlueprintOpinionRecord){
 if(!acceptsDraftBlueprintFeedback(task,revision)
  ||typeof revision!=='string'||!revision.trim()
  ||typeof feedback!=='string'||!feedback.trim()||feedback.length>8000)throw Error('蓝图当前不能接收修改意见');
 const text=feedback.trim(),pending=task.repairContext?.pending_blueprint_feedback;
 if(task.blueprintFeedbackRevision===revision&&task.blueprintFeedback===text
  &&digestValue(task.blueprintFeedbackUnitIds??[])===digestValue(unitIds??[])&&task.blueprintOpinions?.token===opinions?.token&&!pending)return 'already_dispatched';
 const exhausted=blueprintFeedbackBudgetExhausted(task);
 const savedOnly=exhausted||!!task.blueprintApproval;
 await saveBlueprintFeedback(task,revision,text,!savedOnly,store,guards,unitIds,opinions);
 return exhausted?'limit':savedOnly?'saved':'queued';
}

/** Control intents keep the preview they were based on, but may merge a
 * concurrently published immutable shared-body marker. Never overwrite another
 * worker's effects, counters, feedback or acceptance with an old control clone. */
export async function saveProductionControl(base:ProductionTask,next:ProductionTask,store:TaskStore,guards?:EntryPreconditions,expectedDoc?:ProjectDoc,expectedSequence?:number){
 const {productionParentControlGuards}=await import('./production-continuation');
 const bindParent=!!base.input.panelDelivery?.audience&&next.status!=='cancelled';
 let parentGuards=bindParent?await productionParentControlGuards(base):[];
 const subject=(task:ProductionTask)=>{const {updatedAt:_at,sequence:_sequence,sharedProduction:_shared,...rest}=task;return digestValue(rest);};
 let contention:unknown=new Error('agent_runtime_precondition_changed');
 for(let attempt=0;attempt<3;attempt++){
  const key=agentRuntimeKey(base.projectId,await currentAgentSessionGeneration(base.projectId)),entry=await getStoredEntry(key);
  if(!entry.found){
   if(expectedSequence!==undefined)throw Error('production_control_subject_changed');
   await saveProductionCheckpoint(store,next,[...(guards??[]),...parentGuards]);return;
  }
  const current=await productionTaskStore.load(base.projectId,base.taskId);
  if((expectedSequence!==undefined&&current.sequence!==expectedSequence)||subject(current)!==subject(base))throw Error('production_control_subject_changed');
  const a=base.sharedProduction,b=current.sharedProduction;
  if(a&&b&&(a.projectId!==b.projectId||a.taskId!==b.taskId||a.prepared&&b.prepared&&(a.endFrame!==b.endFrame||a.digest!==b.digest)))throw Error('shared_producer_binding_changed');
  const marker=b?.prepared?b:a?.prepared?a:b??a;
  if(marker)next.sharedProduction=structuredClone(marker);
  if(base.status==='awaiting_review'&&next.status==='completed'&&await sharedPreviewDeliveryHeld(current))
   throw Error('preview_shared_body_requires_reconciliation');
  const conditions=[...(guards??[]),...parentGuards,{key,digest:digestValue(entry.value)}];
  if(expectedDoc){
   const project=await getStoredEntry('project:'+base.projectId),doc=project.found?runProjectMigrations(project.value)?.doc:null;
   if(!doc||feedbackProjectDigest(doc)!==feedbackProjectDigest(expectedDoc))throw Error('feedback_project_changed');
   conditions.push({key:'project:'+base.projectId,digest:digestValue(project.value)});
  }
  next.sequence=current.sequence;next.updatedAt=current.updatedAt;
  try{await saveProductionCheckpoint(store,next,conditions);return;}
  catch(error){
   if(!(error instanceof Error)||!error.message.includes('agent_runtime_precondition_changed'))throw error;
   // Only a runtime checkpoint contest can be merged. Changed project or
   // requirements guards still reject the original control immediately.
   for(const guard of conditions.filter(guard=>guard.key!==key&&!parentGuards.some(parent=>parent.key===guard.key))){
    const current=await getStoredEntry(guard.key);
    if((current.found?digestValue(current.value):null)!==guard.digest){
     const doc=expectedDoc&&guard.key==='project:'+base.projectId&&current.found?runProjectMigrations(current.value)?.doc:null;
     if(!doc||feedbackProjectDigest(doc)!==feedbackProjectDigest(expectedDoc!))throw error;
    }
   }
   const refreshed=bindParent?await productionParentControlGuards(base):[];
   const sessions=parentGuards.filter(guard=>guard.key.startsWith('agent-session-generation:'));
   if(sessions.some(session=>refreshed.find(guard=>guard.key===session.key)?.digest!==session.digest))throw error;
   parentGuards=refreshed;
   contention=error;
  }
 }
 throw contention;
}

export async function sharedPreviewDeliveryHeld(task:ProductionTask){
 const sibling=task.sharedProduction;
 if(!task.blueprintApproval||!sibling?.prepared)return false;
 try{return matchingSharedPreviewProblem(task,await productionTaskStore.load(sibling.projectId,sibling.taskId));}
 catch(error){
  if(await isStoredProjectDeleted(sibling.projectId))return false;
  throw error;
 }
}

export async function productionFeedback(task:ProductionTask,feedback:unknown,store=productionTaskStore,doc?:ProjectDoc){
 if(task.status!=='awaiting_review'||task.feedbackUsed)throw new Error('One consolidated local feedback is allowed after preview');
 if(!doc)throw new Error('feedback_saved_project_required');
 const {bindProductionFeedback}=await import('./production-feedback');
 const bound=await bindProductionFeedback(task,doc,feedback);
 const next=structuredClone(task);
 next.feedback=bound.text;next.feedbackUsed=true;next.repairContext={final_feedback:bound};
 next.stage=bound.kind==='execution'?'edit':'blueprint';next.status='queued';next.projectRevision=bound.saved_revision;
 clearProductionStagesFrom(next,next.stage);
 await saveProductionControl(task,next,store,undefined,doc);Object.assign(task,next);return task;
}
export async function acceptProductionTask(task:ProductionTask,languageConfirmed:boolean,store=productionTaskStore,
 visual?:{digest?:unknown;confirmed?:unknown;renderId?:unknown;wholePreviewConfirmed?:unknown;watched?:unknown}){
 if(task.status!=='awaiting_review'||languageConfirmed!==true)throw new Error('Final reviewer must confirm Malay delivery suitability');
 const next=structuredClone(task);let entryPreconditions:EntryPreconditions;
 if(task.input.panelDelivery){
  const renderId=task.completed.export?.artifact.renderId;
  if(visual?.watched!==true||typeof renderId!=='string'||visual.renderId!==renderId)throw Error('preview_acceptance_binding_required');
  next.finalAcceptance={renderId,watched:true,malayReviewed:true,confirmedAt:Date.now()};
  const saved=await loadOfflineStoredProject(task.projectId),src=task.completed.self_check?.artifact.preview;
  const name=typeof src==='string'&&src.startsWith('/media/uploads/')?src.slice('/media/uploads/'.length):'';
  const file=isSafeUploadName(name)?resolveUploadFile(name):null;
  if(!saved||!file)throw Error('final_output_evidence_missing_or_stale');
  await verifyProductionOutput(file);
  if(!matchesExportedPreviewProject(task.completed.export?.artifact,saved))throw Error('final_output_evidence_missing_or_stale');
  const projectEntry=await getStoredEntry('project:'+task.projectId),normalized=projectEntry.found?runProjectMigrations(projectEntry.value)?.doc:null;
  if(!normalized||revisionOf(normalized)!==saved.revision)throw Error('final_output_evidence_missing_or_stale');
  entryPreconditions=[{key:'project:'+task.projectId,digest:digestValue(projectEntry.value)}];
  // The receipt binds the exported revision. The current document was checked
  // separately above and is fenced through the acceptance write.
  assertFinalPreviewEvidence(task,task.projectRevision??'',await sha256File(file));
  await productionDeliverables(saved.doc,undefined,task.completed.export?.at,task.input.panelDelivery);
 }
 const {readHandoffPolicy}=await import('./handoff');
 const {boundVisualCriteria}=await import('./visual-done-criteria');
 const policy=await readHandoffPolicy(task.projectId);
 const requirements=policy??task.blueprintApproval?.requirements??null;
 if(entryPreconditions){
  const entry=await getStoredEntry('clipmentor-handoff:'+task.projectId);
  if((entry.found?digestValue(entry.value):null)!==(policy?digestValue(policy):null))throw Error('final_requirements_changed');
  entryPreconditions.push({key:'clipmentor-handoff:'+task.projectId,digest:entry.found?digestValue(entry.value):null});
  if(requirements){
   const digest=digestValue(requirements.brief.doneCriteria),checked=task.completed.self_check?.artifact.requirementsDigest;
   if(task.completed.copy_review?.artifact.requirementsDigest!==digest||checked!==undefined&&checked!==digest)throw Error('final_requirements_changed');
  }
 }
 const criteria=boundVisualCriteria(requirements);
 const confirmed=visual?.wholePreviewConfirmed===true?criteria?.entries.map(({criterion})=>criterion.id):visual?.confirmed;
 if(task.completed.self_check?.artifact.visualCriteriaDigest!==criteria?.digest
  ||criteria&&(visual?.digest!==criteria.digest||!Array.isArray(confirmed)
   ||confirmed.length!==criteria.entries.length||!criteria.entries.every(({criterion})=>confirmed.includes(criterion.id))))
  throw Error('请对照成片逐项核对画面要求');
 if(criteria){
  const renderId=task.completed.export?.artifact.renderId;
  if(typeof renderId!=='string'||!renderId||visual?.renderId!==renderId)throw Error('请核对当前成片版本');
  next.visualAcceptance={criteriaDigest:criteria.digest,renderId,confirmedIds:visual?.wholePreviewConfirmed===true?[]:criteria.entries.map(({criterion})=>criterion.id),...(visual?.wholePreviewConfirmed===true?{scope:'whole_preview' as const}:{})};
 }
 next.status='completed';await saveProductionControl(task,next,store,entryPreconditions);Object.assign(task,next);return task;
}

export async function cancelProductionTask(task:ProductionTask,store=productionTaskStore){
 if(['completed','cancelled'].includes(task.status))throw new Error('Task is already terminal');
 if(cancelActiveProductionTask(task.projectId,task.taskId))return {taskId:task.taskId,status:'cancelling'};
 const next={...structuredClone(task),status:'cancelled' as const};
 await saveProductionControl(task,next,store);
 Object.assign(task,next);return task;
}
