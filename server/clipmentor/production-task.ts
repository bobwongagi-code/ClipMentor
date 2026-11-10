import {compactProductionTaskHistory} from './production-task-history';
import {productionDecisionEvent,productionEffectDecision,productionRecoveryProgress,type ProductionDecisionDetails} from './production-decisions';
import type {ProjectDoc} from '../../src/editor/types';
import type {ProjectStoreRequest} from '../../shared/project-store-transport';
import {getStoredEntry} from '../plugins/project-store';
import {runProjectMigrations} from '../../src/persist/migrations';
import {revisionOf} from '../../src/agent/external-edit-session';
import {digestValue} from '../agent-runs/store-values';
type EntryPreconditions=Extract<ProjectStoreRequest,{operation:'agent-runtime-write'}>['entryPreconditions'];
import {randomUUID,createHash} from 'node:crypto';
import {appendAgentRunEvent,storeAgentArtifact,loadAgentArtifact,loadAgentRuntimeSidecar} from '../../src/persist/agentRuntimeStore';
import {createRun,flushRunPersistence,setRunStatus,pushRunEvent,recoverServerRun} from '../agent-runs/store';
import {currentAgentSessionGeneration} from '../../src/persist/agentSessionGeneration';
import {LLM_PROVIDER_PRESETS} from '../../shared/llm-providers';
import {confirmedUnsubmittedGateway} from './production-recovery';
import {loadOfflineStoredProject} from '../external-agent/offline-project-store';
import type {ReviewApiConfig} from './copy-review-api';
import type {HandoffPolicy} from '../../shared/clipmentor-handoff';
import {assertFinalPreviewEvidence} from './production-preview-facts';
import {productionDeliverables} from './production-deliverables';
import {sha256File} from '../../shared/node-content-hash';
import {verifyProductionOutput} from './production-format';
import {resolveUploadFile,isSafeUploadName} from '../media-dir';

/** Keep independent findings through intermediate author/structure repairs, never overwrite them with a self-check. */
export function productionRepairContext(previous:Record<string,unknown>|undefined,artifact:Record<string,unknown>){
 const pending=artifact.repair??previous?.pending_review_repair??previous?.repair;
 return {...artifact,...(previous?.audio_picture_repair?{audio_picture_repair:previous.audio_picture_repair}:{}),...(pending?{pending_review_repair:pending}:{}),
  ...(previous?.final_feedback?{final_feedback:previous.final_feedback}:{})};
}

export const PRODUCTION_STAGES=['analysis','blueprint','copy_review','audio','edit','export','self_check'] as const;
export type ProductionStage=typeof PRODUCTION_STAGES[number];
export type EffectKind='model'|'review'|'observation'|'tts'|'render'|'preview_review';
type OriginalEffectKind=Exclude<EffectKind,'preview_review'>;
type EffectCounts=Record<OriginalEffectKind,number>&Partial<Record<'preview_review',number>>;
export interface ProductionInput {
 projectId:string;sourceAssetId:string;product:{name:string;category:string};brief:string;
 author:ReviewApiConfig;reviewer:ReviewApiConfig;
 voice?:{provider:string;voiceId:string};
 humanBlueprintReview?:true;
 gatewayRecovery?:'bounded'|'none';
 panelDelivery?:{productAssetId:string;productAssetHash:string;salesAssetId:string;ctaAssetId:string;ctaAssetHash:string;
  bookends?:'layered-v1';salesAssetHash?:string;salesEvidenceId?:string;salesEvidenceSha256?:string;audience?:'new_contact'|'existing_partner'};
 authorBackend?:'codex';
 reviewerBackend?:'codex';
 budget:EffectCounts&{maxElapsedMs:number;maxRepairs:number;routine?:EffectCounts};
}
export interface ProductionTask {
 productionChild?:{projectId:string;taskId:string;audience:'new_contact'|'existing_partner'};
 productionChildren?:Array<{projectId:string;taskId:string;audience:'new_contact'|'existing_partner'}>;
 sharedProduction?:{projectId:string;taskId:string;prepared?:true;endFrame?:number;digest?:string};
 blueprintApproval?:{sourceProjectId:string;sourceTaskId:string;sourceRevision:string;digest:string;requirementsDigest:string;requirements?:HandoffPolicy;confirmedAt:number};
 version:1;taskId:string;projectId:string;input:ProductionInput;stage:ProductionStage;
 status:'queued'|'running'|'blocked'|'awaiting_blueprint'|'awaiting_review'|'completed'|'cancelled';
 blueprintFeedback?:string;
 blueprintFeedbackSummary?:{sourceDigest:string;points:string[]};
 visualAcceptance?:{criteriaDigest:string;renderId:string;confirmedIds:string[];scope?:'whole_preview'};
 createdAt:number;updatedAt:number;sequence:number;feedback?:string;feedbackUsed:boolean;repairs:number;technicalRecoveryEpochs?:number[];focusedBlueprintIssues?:string[];deliveryDraftRecoveryUsed?:true;sourceEvidenceRecoveryOperation?:string;focusedAuthorChecks?:string[];authorCheckContractRevision?:number;focusedIndependentUnits?:string[];
 completed:Partial<Record<ProductionStage,{at:number;artifact:Record<string,unknown>}>>;
 effects:Record<string,{kind:EffectKind;operationId:string;status:'reserved'|'completed'|'failed';result?:unknown;error?:string;transportUnsubmitted?:true}>;
 attempts:EffectCounts;error?:string;projectRevision?:string;repairContext?:Record<string,unknown>;
}
export interface TaskStore {save(task:ProductionTask,entryPreconditions?:EntryPreconditions):Promise<void>;load(projectId:string,id:string):Promise<ProductionTask>}
export const productionTaskStore:TaskStore={
 async save(task,entryPreconditions){
  for(let batch=0;batch<64&&await compactProductionTaskHistory(task.projectId,task.taskId);batch++){ /* bounded, lossless compaction to the existing low-water mark */ }
  task.updatedAt=Math.max(Date.now(),task.updatedAt+1);task.sequence++;
  const body=JSON.stringify({type:'clipmentor-production-task/v1',task});
  const ok=await storeAgentArtifact({version:1,artifactId:`p_${randomUUID().replaceAll('-','').slice(0,18)}`,projectId:task.projectId,runId:task.taskId,
   kind:'checkpoint-source',toolName:'clipmentor-production-task',body,bodySha256:createHash('sha256').update(body).digest('hex'),
   originalBytes:Buffer.byteLength(body),originalChars:body.length,createdAt:task.updatedAt,redacted:false,binaryOmitted:false},entryPreconditions);
  if(!ok)throw new Error('Production checkpoint could not be persisted');
 },
 async load(projectId,id){
  const sidecar=await loadAgentRuntimeSidecar(projectId);
  const records=sidecar.artifacts.filter(a=>a.runId===id&&a.toolName==='clipmentor-production-task').sort((a,b)=>b.createdAt-a.createdAt);
  let latest:ProductionTask|undefined;
  for(const record of records){const artifact=await loadAgentArtifact(projectId,record.artifactId);if(!artifact)continue;
   const value=JSON.parse(artifact.body);if(value.type!=='clipmentor-production-task/v1'||value.task.taskId!==id||value.task.projectId!==projectId)continue;
   const candidate=value.task as ProductionTask;
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
 const sidecar=await loadAgentRuntimeSidecar(projectId);
 const ids=[...new Set(sidecar.artifacts.filter(a=>a.toolName==='clipmentor-production-task').sort((a,b)=>b.createdAt-a.createdAt).map(a=>a.runId))];
 for(const id of ids){const task=await productionTaskStore.load(projectId,id);if(task.input.humanBlueprintReview)return task;}
}
/** Host-owned requirements for a confirmed output variant, never an execution-role policy. */
export async function productionReviewRequirements(projectId:string){
 const {readHandoffPolicy}=await import('./handoff');
 return await readHandoffPolicy(projectId)??(await latestPanelProductionTask(projectId))?.blueprintApproval?.requirements??null;
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
 let rows:unknown;
 try{rows=JSON.parse(issue.slice('blueprint_stage_incomplete:'.length));}catch{return false;}
 if(!Array.isArray(rows)||!rows.length||rows.some(row=>!row||typeof row.id!=='string'
  ||!(['picture_plan_group_explanation_missing','picture_plan_revisits_mismatch','picture_plan_original_order_mismatch'].includes(row.code)
    ||task.input.panelDelivery&&row.id==='delivery'&&['opening_product_image','opening_sales_attribution_unconfirmed','new_contact_cta_image','existing_partner_storyboard'].includes(row.code))))return false;
 const keys=[...new Set(rows.map(row=>`${row.id}:${row.code}`))].sort();
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

export function recordTechnicalRecovery(task:ProductionTask){
 if((task.technicalRecoveryEpochs?.length??0)>=maxTechnicalRecoveries)throw new Error('制作仍需技术处理');
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
  const value=JSON.parse(artifact.body);
  if(value.type==='clipmentor-production-task/v1'&&value.task)history.push(value.task);
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
 if(v.gatewayRecovery!==undefined&&!['bounded','none'].includes(v.gatewayRecovery))throw Error('Invalid gateway recovery policy');
 for(const config of [v.author,v.reviewer])if(!config?.model?.trim()||!LLM_PROVIDER_PRESETS.some(p=>p.id===config.provider)||!['responses','chat'].includes(config.apiMode))throw new Error('Explicit API author/reviewer configuration required');
 if(v.panelDelivery){
  const {productAssetId,productAssetHash,salesAssetId,ctaAssetId,ctaAssetHash}=v.panelDelivery;
  const ids=[v.sourceAssetId,productAssetId,salesAssetId,ctaAssetId];
  if(v.panelDelivery.audience!==undefined&&!['new_contact','existing_partner'].includes(v.panelDelivery.audience))throw Error('Invalid panel audience');
  if(!v.humanBlueprintReview||ids.some(id=>typeof id!=='string'||!id.trim())||new Set(ids).size!==ids.length
   ||(v.panelDelivery.bookends!==undefined&&v.panelDelivery.bookends!=='layered-v1')
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
export async function createProductionTask(input:ProductionInput,store=productionTaskStore):Promise<ProductionTask>{
 input=freezeProductionInput(input);
 const run=createRun({projectId:input.projectId,sessionGeneration:await currentAgentSessionGeneration(input.projectId),backend:input.authorBackend??'api',provider:input.author.provider,model:input.author.model,askOnly:false});
 await flushRunPersistence(run);
 const now=Date.now(),task:ProductionTask={version:1,taskId:run.id,projectId:input.projectId,input:structuredClone(input),stage:'analysis',status:'queued',createdAt:now,updatedAt:now,sequence:0,
  feedbackUsed:false,repairs:0,completed:{},effects:{},attempts:{model:0,review:0,observation:0,tts:0,render:0}};
 await store.save(task);return task;
}
export interface StageContext {
 effect<T>(kind:EffectKind,key:string,work:(operationId:string)=>Promise<T>,recover?:(operationId:string)=>Promise<T>):Promise<T>;
 signal:AbortSignal;
 remaining?(kind:EffectKind):number;
 hasEffect?(kind:EffectKind,key:string):boolean;
}
export interface StageResult {artifact:Record<string,unknown>;repair?:'blueprint'|'edit'|'copy_review'}
export type StageWorker=(task:ProductionTask,ctx:StageContext)=>Promise<StageResult>;
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
async function advanceWithinExecution(task:ProductionTask,worker:StageWorker,store:TaskStore,now:()=>number,abort:AbortController){
 if(['completed','cancelled','awaiting_blueprint','awaiting_review'].includes(task.status))return task;
 const deadline=task.createdAt+task.input.budget.maxElapsedMs;
 const timer=setTimeout(()=>abort.abort(new Error('Production deadline exceeded')),Math.max(0,deadline-now()));
 const check=()=>{abort.signal.throwIfAborted();if(now()>=deadline)throw new Error('Production deadline exceeded');};
 // Older panel tasks counted preview review under review. Split historical
 // effects once without restoring spent attempts or changing their receipts.
 if(task.input.humanBlueprintReview&&task.input.budget.preview_review===undefined){
  const prior=Object.entries(task.effects).filter(([id,e])=>id.startsWith('self_check:')&&e.kind==='review').length;
  task.attempts.preview_review=prior;task.attempts.review-=prior;
  task.input.budget.preview_review=3;
 }
 const budgetKind=(kind:EffectKind)=>kind==='preview_review'&&task.input.budget.preview_review===undefined?'review':kind;
 const remaining=(kind:EffectKind)=>Math.max(0,(task.input.budget[budgetKind(kind)]??0)-(task.attempts[budgetKind(kind)]??0));
 const effectKey=(name:string)=>`${task.stage}:${task.feedbackUsed?'feedback':'initial'}:${task.repairs}:${name}`;
 const ctx:StageContext={signal:abort.signal,remaining,
 hasEffect:(kind,name)=>task.effects[effectKey(name)]?.kind===budgetKind(kind),async effect<T>(kind:EffectKind,name:string,work:(operationId:string)=>Promise<T>,recover?:(operationId:string)=>Promise<T>){
  check();const id=effectKey(name);
  const old=task.effects[id];
  const decision=productionEffectDecision(old,!!recover,remaining(kind));
  if(decision.action!=='submit'){
   await recordProductionDecision(task,{scope:'effect',...decision,effectKey:id,...(old?{operationId:old.operationId}:{})});
   check();
  }
  if(decision.action==='reuse')return structuredClone(old!.result) as T;
  const settle=async(effect:ProductionTask['effects'][string],result:T)=>{
   const unsubmitted=confirmedUnsubmittedGateway(kind,result,effect.operationId,task.projectId);
   task.effects[id]={...effect,status:'completed',result:structuredClone(result),...(unsubmitted?{transportUnsubmitted:true as const}:{})};
   if(unsubmitted&&!effect.transportUnsubmitted)task.attempts[effect.kind]=(task.attempts[effect.kind]??0)-1;
   await store.save(task);
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
  const effect={kind:counter,operationId:/^[a-f0-9-]{36}$/.test(name)?name:randomUUID(),status:'reserved' as const};task.effects[id]=effect;task.attempts[counter]=(task.attempts[counter]??0)+1;await store.save(task);
  await recordProductionDecision(task,{scope:'effect',...decision,effectKey:id,operationId:effect.operationId});
  let result:T;
  try{check();result=await work(effect.operationId);check();}
  catch(error){task.effects[id]={...effect,status:'failed',error:String(error).slice(0,1200)};await store.save(task);throw error;}
  return settle(effect,result);
 }};
 try{
  check();task.status='running';delete task.error;await store.save(task);
  for(let index=PRODUCTION_STAGES.indexOf(task.stage);index<PRODUCTION_STAGES.length;){
   check();task.stage=PRODUCTION_STAGES[index]!;
   if(task.completed[task.stage]){index++;continue;}
   const result=await worker(task,ctx);check();
   if(typeof result.artifact?.revision==='string')task.projectRevision=result.artifact.revision;
   if(result.repair){
    task.repairContext=productionRepairContext(task.repairContext,result.artifact);
    if(task.input.budget.routine){
     if(remaining('model')<=0)throw new Error('model budget exhausted');
     if(task.stage==='copy_review'&&result.artifact.repair&&remaining('review')<=0)throw new Error('review budget exhausted');
     if(result.repair==='edit'&&remaining('render')<=0)throw new Error('render budget exhausted');
    }
    if(remainingContentRepairs(task)===0
     &&(result.repair!=='blueprint'||(!grantFocusedBlueprintRepair(task,result.artifact.blueprint_structure_issue)
      &&!grantFocusedAuthorRepair(task,result.artifact.author_self_check)
      &&!grantFocusedIndependentRepair(task,result.artifact.repair)))){
     const selfCheck=(result.artifact.author_self_check as {reason?:string}[]|undefined)?.[0]?.reason;
     const detail=selfCheck??result.artifact.blueprint_structure_issue;
     throw new Error(`已用完自动返修额度${typeof detail==='string'?`。未解决：${detail.slice(0,360)}`:''}`);
    }
    task.repairs++;index=PRODUCTION_STAGES.indexOf(result.repair);
    for(const stage of PRODUCTION_STAGES.slice(index))delete task.completed[stage];
    await store.save(task);continue;
   }
   if(!result.artifact||Object.keys(result.artifact).length===0)throw new Error('Stage has no verified artifact');
   task.completed[task.stage]={at:now(),artifact:result.artifact};
   if(task.stage==='copy_review'&&(result.artifact.gate as {allowed?:boolean}|undefined)?.allowed===true&&task.repairContext){
    delete task.repairContext.pending_review_repair;delete task.repairContext.repair;
   }
   if(task.input.humanBlueprintReview&&task.stage==='copy_review'){
    if(!task.projectRevision||result.artifact.revision!==task.projectRevision
     ||result.artifact.authorSelfCheck!=='passed'||(result.artifact.gate as {allowed?:boolean}|undefined)?.allowed!==true
     ||task.input.panelDelivery&&result.artifact.panelDeliveryVerified!==true){
     delete task.completed.copy_review;
     throw new Error('human_blueprint_verified_receipts_missing');
    }
    if(!task.blueprintApproval||task.blueprintApproval.digest!==result.artifact.blueprint_digest
      ||typeof task.blueprintApproval.requirementsDigest!=='string'||task.blueprintApproval.requirementsDigest!==result.artifact.requirementsDigest){
     task.status='awaiting_blueprint';await store.save(task);break;
    }
   }
   await store.save(task);index++;
  }
  if(task.status==='running'){task.status='awaiting_review';await store.save(task);}
  if(abort.signal.aborted&&String(abort.signal.reason).includes('cancelled by user'))abort.signal.throwIfAborted();
 }catch(error){task.status=abort.signal.aborted&&String(abort.signal.reason).includes('cancelled by user')?'cancelled':'blocked';task.error=String(error).slice(0,1600);try{await store.save(task);}catch(persistenceError){task.error=`${task.error}; checkpoint_write_failed: ${String(persistenceError).slice(0,500)}; last persisted checkpoint is authoritative, do not resubmit unknown effects`;}}
 finally{clearTimeout(timer);}
 const run=await recoverServerRun(task.projectId,task.taskId);
 if(run){run.error=task.error??null;pushRunEvent(run,'production-stage',{stage:task.stage,status:task.status,attempts:task.attempts,error:task.error});await setRunStatus(run,['awaiting_blueprint','awaiting_review'].includes(task.status)?'awaiting-user':task.status==='cancelled'?'cancelled':'failed');}
 return task;
}
/** Keep recoverable checkpoints within the same server job and ownership window. */
export async function runProductionWithRecovery(task:ProductionTask,worker:StageWorker,
 reconcile:(task:ProductionTask)=>Promise<void>,store=productionTaskStore,prepare?:(signal:AbortSignal)=>Promise<boolean>){
 return withProductionExecution(task,async controller=>{
  const advance=()=>advanceWithinExecution(task,worker,store,Date.now,controller);
  const deadline=task.createdAt+task.input.budget.maxElapsedMs;
  const timer=setTimeout(()=>controller.abort(new Error('Production deadline exceeded')),Math.max(0,deadline-Date.now()));
  try{
  if(['completed','cancelled','awaiting_blueprint','awaiting_review'].includes(task.status))return task;
  if(prepare){
   try{
    const checkPreparation=()=>{if(Date.now()>=deadline&&!controller.signal.aborted)controller.abort(new Error('Production deadline exceeded'));controller.signal.throwIfAborted();};
    checkPreparation();
    const ready=await prepare(controller.signal);
    checkPreparation();
    if(!ready)return task;
   }catch(error){if(controller.signal.aborted)return advance();throw error;}
  }
  await advance();
  while(task.status==='blocked'){
   const from={stage:task.stage,repairs:task.repairs};
   const stop=(reason:'cancelled_or_expired'|'checkpoint_unpersisted'|'no_verified_progress')=>recordProductionDecision(task,{scope:'recovery',action:'stop',reason,fromStage:from.stage,fromEpoch:from.repairs});
   if(controller.signal.aborted||Date.now()>=task.createdAt+task.input.budget.maxElapsedMs){await stop('cancelled_or_expired');return advance();}
   if(task.error?.includes('checkpoint_write_failed:')){await stop('checkpoint_unpersisted');return task;}
   const previousStage=task.stage,previousEpoch=task.repairs;
   try{await reconcile(task);}catch(error){
    if(controller.signal.aborted)return advance();
    task.error=`${task.error??'Production blocked'}; recovery: ${String(error).slice(0,500)}`.slice(0,1600);
    await store.save(task);
    return controller.signal.aborted?advance():task;
   }
   if(controller.signal.aborted)return advance();
   if(!productionRecoveryProgress(task,{stage:previousStage,repairs:previousEpoch},PRODUCTION_STAGES)){await stop('no_verified_progress');return task;}
   await advance();
  }
  return task;
  }finally{clearTimeout(timer);}
 });
}
export async function resolveHumanBlueprint(task:ProductionTask,displayedRevision:unknown,savedRevision:string|undefined,feedback:unknown,store=productionTaskStore){
 if(!task.input.humanBlueprintReview||task.status!=='awaiting_blueprint'||task.stage!=='copy_review')throw new Error('蓝图当前不在待确认状态');
 if(typeof displayedRevision!=='string'||displayedRevision!==task.projectRevision||displayedRevision!==savedRevision
  ||task.completed.copy_review?.artifact.revision!==displayedRevision
  ||task.completed.copy_review.artifact.authorSelfCheck!=='passed'
  ||(task.completed.copy_review.artifact.gate as {allowed?:boolean}|undefined)?.allowed!==true)throw new Error('蓝图版本已变化，请重新打开审片板');
 const next=structuredClone(task);
 if(feedback===undefined&&next.input.panelDelivery&&!next.input.panelDelivery.audience)throw new Error('dual_delivery_execution_requires_variant_selection');
 if(feedback!==undefined){
  if(typeof feedback!=='string'||!feedback.trim()||feedback.length>8000)throw new Error('请输入有效的蓝图修改意见');
  if(next.attempts.model>=next.input.budget.model)throw new Error('本次制作已达到资源上限');
  delete next.focusedBlueprintIssues;
  delete next.focusedAuthorChecks;
  next.blueprintFeedback=feedback.trim();delete next.blueprintFeedbackSummary;next.repairs++;next.stage='blueprint';
  for(const stage of PRODUCTION_STAGES.slice(1))delete next.completed[stage];
 }else{
  delete next.blueprintFeedback;
  delete next.blueprintFeedbackSummary;
  next.stage='audio';
 }
 next.status='queued';await store.save(next);Object.assign(task,next);return task;
}
/** Accept business feedback while a saved draft waits for review, without spending effects or changing approval state. */
export async function savePendingBlueprintFeedback(task:ProductionTask,revision:string,feedback:unknown,store=productionTaskStore){
 if(!task.input.humanBlueprintReview||!(task.status==='blocked'
  ||task.status==='awaiting_blueprint'&&revision!==task.projectRevision)||!['blueprint','copy_review'].includes(task.stage)
  ||typeof revision!=='string'||!revision.trim()
  ||typeof feedback!=='string'||!feedback.trim()||feedback.length>8000)throw Error('蓝图当前不能接收修改意见');
 const next=structuredClone(task);
 next.blueprintFeedback=feedback.trim();
 delete next.blueprintFeedbackSummary;
 next.repairContext={...next.repairContext,pending_blueprint_feedback:{text:feedback.trim(),revision}};
 await store.save(next);Object.assign(task,next);
}

export async function productionFeedback(task:ProductionTask,feedback:unknown,store=productionTaskStore,doc?:ProjectDoc){
 if(task.status!=='awaiting_review'||task.feedbackUsed)throw new Error('One consolidated local feedback is allowed after preview');
 if(!doc)throw new Error('feedback_saved_project_required');
 const {bindProductionFeedback}=await import('./production-feedback');
 const bound=await bindProductionFeedback(task,doc,feedback);
 const next=structuredClone(task);
 next.feedback=bound.text;next.feedbackUsed=true;next.repairContext={final_feedback:bound};
 next.stage=bound.kind==='execution'?'edit':'blueprint';next.status='queued';next.projectRevision=bound.saved_revision;
 for(const stage of PRODUCTION_STAGES.slice(PRODUCTION_STAGES.indexOf(next.stage)))delete next.completed[stage];
 await store.save(next);Object.assign(task,next);return task;
}
export async function acceptProductionTask(task:ProductionTask,languageConfirmed:boolean,store=productionTaskStore,
 visual?:{digest?:unknown;confirmed?:unknown;renderId?:unknown;wholePreviewConfirmed?:unknown}){
 if(task.status!=='awaiting_review'||languageConfirmed!==true)throw new Error('Final reviewer must confirm Malay delivery suitability');
 const next=structuredClone(task);let entryPreconditions:EntryPreconditions;
 if(task.input.panelDelivery){
  const saved=await loadOfflineStoredProject(task.projectId),src=task.completed.self_check?.artifact.preview;
  const name=typeof src==='string'&&src.startsWith('/media/uploads/')?src.slice('/media/uploads/'.length):'';
  const file=isSafeUploadName(name)?resolveUploadFile(name):null;
  if(!saved||!file)throw Error('final_output_evidence_missing_or_stale');
  await verifyProductionOutput(file);
  const projectEntry=await getStoredEntry('project:'+task.projectId),normalized=projectEntry.found?runProjectMigrations(projectEntry.value)?.doc:null;
  if(!normalized||revisionOf(normalized)!==saved.revision)throw Error('final_output_evidence_missing_or_stale');
  entryPreconditions=[{key:'project:'+task.projectId,digest:digestValue(projectEntry.value)}];
  assertFinalPreviewEvidence(task,saved.revision,await sha256File(file));
  await productionDeliverables(saved.doc);
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
 next.status='completed';await store.save(next,entryPreconditions);Object.assign(task,next);return task;
}

export async function cancelProductionTask(task:ProductionTask,store=productionTaskStore){
 if(['completed','cancelled'].includes(task.status))throw new Error('Task is already terminal');
 if(cancelActiveProductionTask(task.projectId,task.taskId))return {taskId:task.taskId,status:'cancelling'};
 task.status='cancelled';await store.save(task);return task;
}
