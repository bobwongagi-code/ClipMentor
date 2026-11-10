import {blockedProductionDecision,productionAuthorDecision,productionRecoveryProgress,repairableBlueprintIssue,type RecoveryRoute} from './production-decisions';
import {productionCapacityFacts,pictureRepairWriteError} from './production-capacity-repair';
import {frozenParameterEdits} from '../../src/clipmentor/execution-parameters';
import {assertLocalFeedbackPreservation,feedbackProjectDigest,captureBlueprintFeedbackSummary} from './production-feedback';
import {currentExecutionPreparation,currentReviewRepair,needsVisualReviewCompletion} from './execution-view';
import {createHash} from 'node:crypto';
import {digestValue} from '../agent-runs/store-values';
import {createRun,flushRunPersistence} from '../agent-runs/store';
import {executeRun} from '../agent-runs/executor';
import {canonicalServerRunToolCatalog} from '../agent-runs/tool-policy';
import {observationTaskWithBoundaryContext,validateSourceVideoTask,type SourceVideoReceipt,type SourceVideoTask,type SourceVideoRequest} from '../../shared/clipmentor-source-video';
import {loadAgentRuntimeSidecar,loadAgentArtifact,storeAgentArtifact} from '../../src/persist/agentRuntimeStore';
import {currentAgentSessionGeneration} from '../../src/persist/agentSessionGeneration';
import {checkCopyProduction,copyTeachingPacketFromDoc,copyReviewSubject} from '../../src/clipmentor/production-gate';
import {copyPreparationReady,checkSourceBreakdown,originalPlaybackRanges} from '../../src/clipmentor/source-breakdown';
import {completedSourceEvidenceOperations,importProductionSourceEvidence,productionEvidenceInspection,productionSourceObservationAllowed,productionReviewObservation} from './production-source-evidence';
import {invalidateChangedReviews,isClipMentorAnalysis} from '../../src/clipmentor/analysis';
import {isExternalReadTool,isExternalServerDirectTool} from '../../src/agent/external-tool-policy';
import {resolveUploadFile} from '../media-dir';
import {sha256File} from '../../shared/node-content-hash';
import {setTimeout as sleep} from 'node:timers/promises';
import {readSourceVideoReceipt,recoverSourceVideoReceipt,sourceVideoDependencies} from './source-video';
import {recoverProductionGateway,type GatewayRecoveryDecision} from './production-recovery';
import {checkProductionAuthorBlueprint} from './production-author-self-check';
import {preparePanelStoryboardForAuthor,panelDeliveryIssues,panelStoryboardAsset,panelSalesEvidence} from './production-panel-delivery';
import {assertCreatorDocumentEdit,currentCreatorDocument} from './creator-storyboard-document';
import {createProductionPreparation,verifyProductionNarration,verifyProductionEditing,prepareProductionBlueprint,productionBlueprintReadiness,productionExecutionReport} from './production-readiness';
import {openHeadlessEditor} from './headless-editor';
import {loadOfflineStoredProject} from '../external-agent/offline-project-store';
import type {ProjectDoc} from '../../src/editor/types';
import {productionPreviewFacts,previewFactsDigest,assertPreviewExportBinding} from './production-preview-facts';
import {productionDeliverables} from './production-deliverables';
import {collectSavedPreviewVisualEvidence} from './preview-visual-evidence';
import {productionReviewRequirements} from './production-task';
import {assertSharedProduction,upgradeContinuationBrief} from './production-continuation';
import {assertVisualCriteriaPlan,visualCriteriaPlanReceiptMatches,boundVisualCriteria,visualCriteriaPlanApproved} from './visual-done-criteria';
import {assertProductionCanvas,verifyProductionOutput} from './production-format';
export {productionPreviewFacts} from './production-preview-facts';

/** Use the existing artifact contract, including its 20-character ID bound. */
export function productionGatewayDecisionArtifact(task:ProductionTask,revision:string,kind:'review'|'preview_review'|'observation',
 decision:GatewayRecoveryDecision,remaining:number){
 const body=JSON.stringify({type:'clipmentor-gateway-recovery/v1',taskId:task.taskId,stage:task.stage,
  revision,decision,remaining,hardLimit:task.input.budget[kind]??0});
 const sha=createHash('sha256').update(body).digest('hex');
 return {version:1 as const,artifactId:'g_'+sha.slice(0,18),projectId:task.projectId,runId:task.taskId,
  kind:'checkpoint-source' as const,toolName:'clipmentor-gateway-recovery',body,bodySha256:sha,
  originalBytes:Buffer.byteLength(body),originalChars:body.length,createdAt:Date.now(),redacted:false,binaryOmitted:false};
}
/** Re-reading an immutable recovery decision is not a second write or a new request. */
export async function persistProductionGatewayDecision(record:ReturnType<typeof productionGatewayDecisionArtifact>,
 deps={store:storeAgentArtifact,load:loadAgentArtifact}){
 if(await deps.store(record))return;
 const existing=await deps.load(record.projectId,record.artifactId);
 if(!existing||existing.projectId!==record.projectId||existing.runId!==record.runId||existing.kind!==record.kind
  ||existing.toolName!==record.toolName||existing.bodySha256!==record.bodySha256||existing.body!==record.body
  ||existing.originalBytes!==record.originalBytes||existing.originalChars!==record.originalChars
  ||existing.redacted!==record.redacted||existing.binaryOmitted!==record.binaryOmitted)throw Error('gateway_recovery_decision_not_saved');
}
import {PRODUCTION_STAGES,recordProductionDecision,recordTechnicalRecovery,reconcileLegacyTechnicalRecoveries,remainingContentRepairs,grantFocusedBlueprintRepair,grantFocusedAuthorRepair,grantFocusedIndependentRepair,type StageWorker,type ProductionTask} from './production-task';

const hostNames=new Set(['load_skill','edit_item','edit_asset','read_clipmentor_analysis','revise_clipmentor_analysis','observe_clipmentor_source',
 'observe_clipmentor_source_video','read_clipmentor_source_video','view_asset_frames','view_timeline_frames','save_clipmentor_source_frame','submit_voice']);
const editForbiddenTools=new Set(['revise_clipmentor_analysis','submit_voice','observe_clipmentor_source','observe_clipmentor_source_video']);
export function productionStageToolAllowed(stage:ProductionTask['stage'],name:string){
 if(stage==='edit')return !editForbiddenTools.has(name);
 if(name==='load_skill'||isExternalReadTool(name)||name==='revise_clipmentor_analysis')return true;
 if(stage==='audio')return name==='submit_voice';
 if(stage==='blueprint'&&name==='save_clipmentor_source_frame')return true;
 if(stage==='blueprint'&&name==='edit_asset')return true;
 return (stage==='analysis'||stage==='blueprint')&&['observe_clipmentor_source','observe_clipmentor_source_video'].includes(name);
}
const goals={
 analysis:'完整观察原片，理解商品购买理由及结构，登记证据、重点与蓝图基线。登记完整分析基线供下阶段连续视听；抽帧只证明可见画面。读取当前项目中的商品图和销量截图。不能听清的留未知。用 source_breakdown 回读登记；人审版由后续蓝图阶段处理。不得配音或剪辑。',
 blueprint:'先回读已保存的 source_breakdown 和 current_copy。逐个保留组用 revise_clipmentor_analysis 的 set_copy_candidate 一次登记马来语口播、同文字幕、中文与画面计划；首稿在 record 内写 source_candidate_id:null，已有稿用现行 ID。两种情况都给新的 script_candidate_ 和 picture_plan_ ID，不用 revise 手写指针。全部保留组登记后再用 observe_clipmentor_source_video 补核关键原声和动作，需要时局部修订。成绩与学习过渡缺资料时明确记录原因，不静默删掉；按完整话意和动作决定看一组讲一组或其他组织，不固定四组。把卖点、怎么拍、为什么这样拍讲清，原消费者促单与达人阶段邀请分开。每组用既有unit表达原声与解释，必要条件、画面承担、回看进出和视觉继承明确。未配音仅填语义锚点，不编实测秒数；先检查最终审核投影。不得自签审核或剪辑。',
 audio:'只处理已审现行稿。先找同文、同音色现有音频；仅合成缺少的句子，保留实测声长及来源。按整组核承载，缺素材或需改稿时说明冲突，不赶读、慢放、循环或长定格凑时长。',
 edit:'按当前已审蓝图和真实音频执行。edit_item 的 adds 用于从真实素材创建尚不存在的实例；fixed_native_edits 只是已有实例的差异补丁，空数组不代表禁止创建。空时间线应按已审阶段顺序创建；输出帧位由实测音频长度及有效词级锚点落实，不能把无绝对摆放位置误判成没有音频锚点，不得把估算当实测。保留已定源窗，声画无法承载时返回具体句和冲突，不把整项交回用户。读取 current_copy 的 summary/candidate/picture_plan 必须带实际 unitId。完成原生实例组装后回读；宿主根据真实音频实例、原声播放和已审逐句选材核对实际摆放，不要求执行者改写蓝图或补production_rows，不自行调用revise_clipmentor_analysis登记。原声实例保留正常声音，讲解回看视频静音；源片参照图用save_clipmentor_source_frame保留来源，不用无关素材。保留教学重点和必要拍法，原片/讲解强区分、字幕实底可读且无阴影。源片对象、阶段与讲解意群对应。用实际合成帧自查，保存后停止，不自行导出。'
};

/** Author examples are loaded only while forming the teaching plan, never as
 * independent-review answers or repeated instructions for audio/edit stages. */
export async function loadProductionAuthorGuidance(stage:ProductionTask['stage'],load:(file:string)=>Promise<string>){
 if(!['analysis','blueprint','audio','edit'].includes(stage))throw new Error('author_guidance_stage_not_authoring');
 const files=['SKILL.md','references/planning.md'];
 if(stage==='analysis'||stage==='blueprint')files.push('references/reproduction-lessons.md');
 return (await Promise.all(files.map(async file=>{
  const body=await load(file);
  if(typeof body!=='string'||!body.trim())throw new Error(`author_guidance_empty:${file}`);
  return body;
 }))).join('\n');
}
export async function reconcileBlockedBlueprint(task:ProductionTask){
 const before={stage:task.stage,repairs:task.repairs};let route:RecoveryRoute|'no_matching_route'='no_matching_route';
 try{
  await reconcileBlockedBlueprintState(task,value=>{route=value;});
  await recordProductionDecision(task,{scope:'recovery',action:productionRecoveryProgress(task,before,PRODUCTION_STAGES)?'resume':'stop',
   reason:route,fromStage:before.stage,fromEpoch:before.repairs});
 }catch(error){await recordProductionDecision(task,{scope:'recovery',action:'stop',reason:'reconciliation_failed',fromStage:before.stage,fromEpoch:before.repairs});throw error;}
}

/** Reconcile pre-fix checkpoints only when the finished author run proves the exact saved revision. */
async function reconcileBlockedBlueprintState(task:ProductionTask,choose:(route:RecoveryRoute)=>void){
 await reconcileLegacyTechnicalRecoveries(task);
 const decision=blockedProductionDecision(task,remainingContentRepairs(task));
 const selected=(route:RecoveryRoute)=>{if(!decision.routes.includes(route))return false;choose(route);return true;};
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
    for(const stage of ['blueprint','copy_review','audio','edit','export','self_check'] as const)delete task.completed[stage];
    task.stage='blueprint';task.repairs++;return;
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
    delete task.completed.blueprint;delete task.completed.copy_review;return;
   }
  }
 }

 if(selected('visual_review_contract')){
  const saved=await loadOfflineStoredProject(task.projectId);
  const repair=saved&&await currentReviewRepair(saved.doc);
  if(saved?.revision===task.projectRevision&&repair?.status==='bound'
   &&repair.subject?.digest===task.repairContext?.blueprint_digest&&needsVisualReviewCompletion(repair)){
   task.repairContext={...task.repairContext,review_contract_recheck:true};
   task.repairs++;delete task.completed.copy_review;return;
  }
 }
 if(selected('continuation_brief')){
  const updated=structuredClone(task),saved=await loadOfflineStoredProject(task.projectId);
  if(saved&&saved.revision===task.projectRevision&&await upgradeContinuationBrief(updated)){
   const repair=await currentReviewRepair(saved.doc);
   if(repair.status==='bound'&&repair.subject?.digest===task.repairContext?.blueprint_digest){
    recordTechnicalRecovery(updated);updated.stage='blueprint';delete updated.completed.blueprint;
    Object.assign(task,updated);return;
   }
  }
 }
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
     delete task.completed.blueprint;
     return;
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
    return;
   }
   if(contractUpgrade)task.authorCheckContractRevision=2;
   task.stage='blueprint';task.repairs++;delete task.completed.blueprint;
   return;
  }
 }
 if(selected('focused_independent')){
  const snapshot=await loadOfflineStoredProject(task.projectId);
  const checked=snapshot&&await currentReviewRepair(snapshot.doc);
  if(snapshot&&snapshot.revision===task.projectRevision&&snapshot.doc.clipMentorAnalysis?.source.asset_id===task.input.sourceAssetId
   &&checked?.status==='bound'&&checked.subject?.digest===task.repairContext?.blueprint_digest&&grantFocusedIndependentRepair(task,checked)){
   task.stage='blueprint';task.repairs++;delete task.completed.blueprint;
   return;
  }
 }
 if(selected('focused_structure')){
  const issue=task.repairContext?.blueprint_structure_issue;
  if(typeof issue!=='string')return;
  const saved=await loadOfflineStoredProject(task.projectId);
  if(saved&&saved.revision===task.projectRevision&&saved.doc.clipMentorAnalysis?.source.asset_id===task.input.sourceAssetId
   &&(await productionBlueprintReadiness(saved.doc,task.input.voice)).code===issue&&grantFocusedBlueprintRepair(task,issue)){
   task.repairs++;
  }
  return;
 }
 if(!selected('author_checkpoint')||!decision.authorCheckpoint)return;
 const {failedObservation,failedSourceRead,failedDeliveryWrite,failedPlanWrite}=decision.authorCheckpoint;
 let {savedShapeIssue}=decision.authorCheckpoint;
 const analysis=task.completed.analysis;
 const prefix=`blueprint:${task.feedbackUsed?'feedback':'initial'}:${task.repairs}:`;
 const effects=Object.entries(task.effects).filter(([key])=>key.startsWith(prefix)).map(([,effect])=>effect);
 if(!analysis||task.completed.blueprint
   ||task.attempts.model>=task.input.budget.model
   ||!effects.length||effects.some(effect=>effect.status!=='completed'
    ||(effect.kind!=='model'&&!(failedObservation&&effect.kind==='observation'))))
  throw new Error('blueprint_recovery_budget_or_effect_unverified');
 const [saved,sidecar]=await Promise.all([loadOfflineStoredProject(task.projectId),loadAgentRuntimeSidecar(task.projectId)]);
 const savedAnalysis=saved?.doc.clipMentorAnalysis;
 if(!saved||!savedAnalysis||savedAnalysis.source.asset_id!==task.input.sourceAssetId)
  throw new Error('blueprint_recovery_saved_scope_changed');
 let recoveredObservation:SourceVideoTask|undefined;
 let previousObservation:SourceVideoReceipt|undefined;
 if(failedObservation){
  const observations=effects.filter(effect=>effect.kind==='observation');
  const effect=observations[0];
  const receipt=(effect?.result as {body?:{receipt?:SourceVideoReceipt}}|undefined)?.body?.receipt;
  const subject=await copyReviewSubject(saved.doc);
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
  previousObservation=receipt;
  recoveredObservation=observationTaskWithBoundaryContext(requested,savedAnalysis.source.duration_seconds);
  if(JSON.stringify(requested)===JSON.stringify(recoveredObservation))
   throw new Error('blueprint_recovery_observation_context_already_corrected');
 }else{
  const code=(await productionBlueprintReadiness(saved.doc,task.input.voice)).code;
  if(failedSourceRead){
   if(code!=='copy_review_missing')throw new Error('blueprint_recovery_saved_scope_changed');
  }else if(failedPlanWrite){
   const check=checkSourceBreakdown(saved.doc);
   if(!check.issues.length||check.issues.some(issue=>!repairableBlueprintIssue(issue.code)&&!(failedDeliveryWrite&&issue.code==='delivery_sections_invalid'))
    ||(failedDeliveryWrite&&!check.issues.some(issue=>issue.code==='delivery_sections_invalid'))
    ||!code.startsWith('blueprint_stage_incomplete:'))throw new Error('blueprint_recovery_saved_scope_changed');
   savedShapeIssue=code;
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
  if(terminal?.data?.status!==((failedObservation||failedPlanWrite||failedSourceRead)?'failed':'completed')||write?.data.result.projectId!==task.projectId
   ||write.data.result.projectRevision!==saved.revision)return false;
  if(!previousObservation)return true;
  const receiptIndex=events.findIndex(event=>event.type==='server-tool-result'&&event.data?.name==='observe_clipmentor_source_video'
   &&event.data.result?.receipt?.operationId===previousObservation?.operationId);
  return receiptIndex>=0&&events.slice(0,receiptIndex).some(event=>event.type==='server-tool-result'
   &&event.data?.name==='revise_clipmentor_analysis'&&event.data.success===true&&event.data.result?.saved===true
   &&event.data.result?.revision===previousObservation?.subject.revision);

 });
 if(bound.length!==1)throw new Error('blueprint_recovery_author_receipt_unverified');
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

/** The same service worker is used by the HTTP task and by zero-provider regression fixtures. */
export const productionStageWorker:StageWorker=async(task,stage)=>{
 let reflowBaseline:ProjectDoc|undefined;
 const editor=await openHeadlessEditor({projectId:task.projectId,runId:task.taskId,origin:task.input.author.origin,review:task.input.reviewer,reviewBackend:task.input.reviewerBackend,retryGateway:task.input.humanBlueprintReview,voice:task.input.voice,signal:stage.signal,finalFeedback:task.repairContext?.final_feedback as Record<string,unknown>|undefined,
  ...(task.input.panelDelivery?{assertCanvas:(next:ProjectDoc)=>{assertProductionCanvas(next);if(reflowBaseline)assertCanvasReflowPreservation(reflowBaseline,next);}}:{}),
  effect:(kind,key,work,recover)=>stage.effect(kind,key,work,recover)});
 const openedRevision=editor.revision;
 editor.context.getAgentRunSignal=()=>stage.signal;
 const executeWithRecovery=(name:string,args:Record<string,unknown>,id:string)=>{
  const execute=(next:Record<string,unknown>)=>editor.execute(name,next,id);
  if(!task.input.humanBlueprintReview&&task.input.gatewayRecovery!=='bounded')return execute(args);
  const kind=name==='request_clipmentor_copy_review'?'review':name==='review_clipmentor_preview'?'preview_review':'observation';
  return recoverProductionGateway(name,args,task.projectId,next=>!stage.signal.aborted&&((stage.remaining?.(kind)??0)>0||stage.hasEffect?.(kind,next)===true),
   execute,ms=>sleep(ms,undefined,{signal:stage.signal}),task.input.budget.routine?(task.input.budget[kind]??0):2,{
    // Old explicitly bounded/no-retry batches are not migrated into automatic recovery.
    allowRetry:task.input.gatewayRecovery==='bounded',
    ...(name==='request_clipmentor_copy_review'?{}:{readOriginal:(operationId:string)=>
     name==='observe_clipmentor_source_video'
      ?editor.execute('read_clipmentor_source_video',{operationId},'gateway-read:'+operationId)
      :editor.execute('review_clipmentor_preview',{action:'read',operationId,videoSha256:args.videoSha256},'gateway-read:'+operationId)}),
    recordDecision:async decision=>{
     await persistProductionGatewayDecision(productionGatewayDecisionArtifact(task,editor.revision,kind,decision,stage.remaining?.(kind)??0));
    },
   });
 };
 const operation=(scope:string)=>{const h=createHash('sha256').update(`${task.taskId}:${task.stage}:${task.repairs}:${task.feedbackUsed}:${scope}`).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
 try{
  if(task.projectRevision&&editor.revision!==task.projectRevision)throw new Error('production_project_changed; reconcile the saved project before resuming');
  if(isBoundCanvasReflow(task,editor.getDoc()))reflowBaseline=structuredClone(editor.getDoc());
  else if(task.input.panelDelivery)assertProductionCanvas(editor.getDoc());
  if(!editor.getDoc().clipMentorAnalysis){
   const doc=editor.getDoc(),source=doc.assets.find(a=>a.id===task.input.sourceAssetId);
   if(!source||source.kind!=='video')throw new Error('Original video asset missing');
   const file=resolveUploadFile(source.src.replace(/^\/media\/uploads\//,''));if(!file)throw new Error('Original upload unavailable');
   const hash=await sha256File(file);
   if(source.sourceContentHash&&source.sourceContentHash!==hash)throw new Error('Original source changed');
   editor.context.commands.applyDoc({...doc,assets:doc.assets.map(a=>a.id===source.id?{...a,sourceContentHash:hash}:a),clipMentorAnalysis:{
    schema_version:1,analysis_id:`production:${task.taskId}`,revision:1,source:{asset_id:source.id,sourceContentHash:hash,duration_seconds:source.durationInFrames/editor.context.getState().fps,fps:editor.context.getState().fps},
    product:task.input.product,import_origin:'production_source_facts_only',evidence:task.input.panelDelivery?.salesEvidenceId
     ?[panelSalesEvidence(source.id,task.input.panelDelivery.salesAssetId)]:[],points:[],blueprint:[],transcripts:[],reviews:[],audit:[]}});
   await editor.commit();
  }
  // Import saved neutral source evidence before author/self-check/review, not only
  // after exhausting a repair limit. Never import observer verdicts or approvals.
  if(task.stage==='blueprint'||task.stage==='copy_review'){
   const operations=completedSourceEvidenceOperations(task);
   let changed=false;
   for(const id of operations){
    const receipt=await readSourceVideoReceipt(id,task.projectId,sourceVideoDependencies());
    const before=editor.getDoc(),next=importProductionSourceEvidence(before.clipMentorAnalysis!,receipt,task.projectId);
    if(!next)continue;
    await invalidateChangedReviews(next);
    const withEvidence={...before,clipMentorAnalysis:next};
    if(!isClipMentorAnalysis(next)||!copyPreparationReady(withEvidence))
     throw new Error('source_evidence_import_did_not_validate');
    editor.context.commands.applyDoc(withEvidence);
    await editor.commit();
    task.projectRevision=editor.revision;changed=true;
   }
   if(changed&&task.stage==='copy_review')return {artifact:{revision:editor.revision,source_evidence_import:'saved_receipts'},repair:'blueprint'};
  }
  if(task.stage==='blueprint'&&task.input.panelDelivery&&editor.getDoc().clipMentorAnalysis?.source_breakdown?.units.length){
   const current=editor.getDoc();
   const prepared=await preparePanelStoryboardForAuthor(current,stage.signal),storyboard=prepared.asset;
   if(prepared.issue)task.repairContext={...task.repairContext,creator_storyboard_issue:prepared.issue};
   if(storyboard){
    editor.context.commands.applyDoc({...current,assets:[...current.assets,storyboard]});
   }
  }
  const doc=editor.getDoc(),a=doc.clipMentorAnalysis!;
  if(a.source.asset_id!==task.input.sourceAssetId)throw new Error('Task/source binding changed');
  const policy=await productionReviewRequirements(task.projectId),criteria=boundVisualCriteria(policy);
  if(task.stage==='copy_review'){
   const prepared=await createProductionPreparation(doc);
   try{assertVisualCriteriaPlan(criteria,prepared.rawPacket.delivery_sections,prepared.rawPacket.units.map(u=>u.unit_id),doc.activeTimelineId);}catch(e){
    return {artifact:{revision:editor.revision,blueprint_structure_issue:`blueprint_stage_incomplete:${JSON.stringify([{code:String((e as Error).message),id:'delivery'}])}`},repair:'blueprint'};
   }
   if(task.input.panelDelivery){
    const issues=panelDeliveryIssues(doc,{...task.input.panelDelivery,bookends:'layered-v1'},await currentCreatorDocument(doc));
    if(issues.length)return {artifact:{revision:editor.revision,blueprint_structure_issue:`blueprint_stage_incomplete:${JSON.stringify(issues.map(code=>({code,id:'delivery'})))}`},repair:'blueprint'};
   }
   const digest=prepared.reviewed.subject.digest;
   if(task.input.humanBlueprintReview){
    const check=await checkProductionAuthorBlueprint(task,stage,doc,prepared,await editor.loadSkill('clipmentor','references/blueprint-self-check.md'),policy?.brief.doneCriteria??[]);
    if(check.digest!==digest)throw new Error('blueprint_author_self_check_stale');
    const issues=check.checks.filter(entry=>entry.status!=='ok');
    if(issues.length)return {artifact:{revision:editor.revision,blueprint_digest:digest,author_self_check_source_digest:check.sourceDigest,author_self_check:issues},repair:'blueprint'};
   }
   if((stage.remaining?.('review')??1)<=0&&!stage.hasEffect?.('review',operation('independent-review')))
    throw new Error('review budget exhausted');
   const result=await (task.input.budget.routine?executeWithRecovery:editor.execute)('request_clipmentor_copy_review',{operationId:operation('independent-review'),maxRequests:1,expectedRevision:a.revision},'copy-review') as Record<string,unknown>;
   if(result.error){
    if(task.input.budget.routine&&(stage.remaining?.('review')??0)<=0
     &&(result.diagnostic as {requestsAttempted?:number}|undefined)?.requestsAttempted===1)throw new Error('review budget exhausted');
    throw new Error(String(result.error));
   }
   if(criteria&&!visualCriteriaPlanReceiptMatches(criteria,editor.getDoc().clipMentorAnalysis?.production_copy_review))
    throw Error('handoff_visual_criteria_review_missing_or_stale');
   const gate=await checkCopyProduction(editor.getDoc(),'clipmentor');
   if(!gate.allowed){
    const repair=await currentReviewRepair(editor.getDoc());
    if(task.input.humanBlueprintReview&&(repair.status!=='bound'||
     !/^copy_(?:(?:group|teaching|narration|delivery)_)?review_not_passed$/.test(gate.code))){
     throw new Error(`独立审核门禁无法推进：${gate.code}`);
    }
    if(task.input.budget.routine&&needsVisualReviewCompletion(repair))
     return {artifact:{receipt:result,revision:editor.revision,blueprint_digest:digest,repair,review_contract_recheck:true},repair:'copy_review'};
    return {artifact:{receipt:result,revision:editor.revision,blueprint_digest:digest,repair},repair:'blueprint'};
   }
   return {artifact:{revision:editor.revision,gate,receipt:result,blueprint_digest:digest,requirementsDigest:digestValue(policy?.brief.doneCriteria??[]),...(task.input.humanBlueprintReview?{authorSelfCheck:'passed'}:{}),
    ...(task.input.panelDelivery?{panelDeliveryVerified:true}:{})}};
  }
  if(['audio','edit','export','self_check'].includes(task.stage)){
   assertSharedProduction(task,doc);
   if(policy&&task.input.humanBlueprintReview&&task.completed.copy_review?.artifact.requirementsDigest!==digestValue(policy.brief.doneCriteria))
    throw Error('handoff_original_requirements_review_missing_or_stale');
   if(criteria){
    const packet=await copyTeachingPacketFromDoc(doc);
    assertVisualCriteriaPlan(criteria,packet.delivery_sections,packet.units.map(u=>u.unit_id),doc.activeTimelineId);
    if(!visualCriteriaPlanApproved(criteria,a.production_copy_review))
     throw Error('handoff_visual_criteria_review_missing_or_stale');
   }
  }
  if(task.stage==='audio'){
   // A recovered stage may already have durably saved every voice file.
   // Reuse the same verifier used after author execution; never infer completion
   // from a tool receipt or a successful provider request alone.
   const ready=await savedProductionAudioReady(doc,task.input.voice);
   if(ready){
    const saved=await loadOfflineStoredProject(task.projectId);
    if(!saved||saved.revision!==editor.revision)throw new Error('production_saved_readback_mismatch');
    await verifyProductionNarration(saved.doc,task.input.voice);
    return {artifact:{revision:saved.revision,analysisRevision:a.revision,reusedSavedAudio:true,
     blueprintReadiness:await productionBlueprintReadiness(saved.doc,task.input.voice),semantic_quality:'not_certified_by_structure'}};
   }
  }
  if(task.stage==='export'){
   const facts=productionPreviewFacts(doc,editor.context.getState(),await copyTeachingPacketFromDoc(doc));
   const exportedRevision=editor.revision,factsDigest=previewFactsDigest(facts);
   const result=await editor.execute('submit_render_job',{format:'video',codec:'h264',resolution:'720p',videoBitrate:3000000,name:'ClipMentor-review-preview.mp4'},'export') as {renderId:string};
   if(!result.renderId)throw new Error('Missing render ID');
   await editor.close(); // The queued export owns its snapshot, not the editable project.
   for(;;){
    stage.signal.throwIfAborted();const snapshot=await editor.readExport(result.renderId) as {status:string;result?:Record<string,unknown>;error?:string};
    if(['succeeded','completed'].includes(snapshot.status)&&snapshot.result){
     let outputDimensions:{width:number;height:number}|undefined;
     if(task.input.panelDelivery){
      const src=snapshot.result.path??snapshot.result.downloadUrl;
      const file=typeof src==='string'?resolveUploadFile(src.replace(/^\/media\/uploads\//,'')):null;
      if(!file)throw Error('Preview missing');
      outputDimensions=await verifyProductionOutput(file,stage.signal);
     }
     return {artifact:{renderId:result.renderId,...snapshot.result,...(outputDimensions?{outputDimensions}:{}),revision:exportedRevision,facts_digest:factsDigest,feedback_project_digest:feedbackProjectDigest(doc)}};
    }
    if(['failed','cancelled'].includes(snapshot.status))throw new Error(snapshot.error??'Render failed; committed editing retained');
    await new Promise<void>((resolve,reject)=>{const stop=()=>{clearTimeout(timer);reject(stage.signal.reason);};const timer=setTimeout(()=>{stage.signal.removeEventListener('abort',stop);resolve();},1000);stage.signal.addEventListener('abort',stop,{once:true});});
   }
  }
  if(task.stage==='self_check'){
   const exported=task.completed.export?.artifact,src=exported?.path??exported?.downloadUrl;
   if(typeof src!=='string')throw new Error('Exported preview path missing');
   const file=resolveUploadFile(src.replace(/^\/media\/uploads\//,''));if(!file)throw new Error('Preview missing');
   if(task.input.panelDelivery)await verifyProductionOutput(file,stage.signal);
   const packet=await copyTeachingPacketFromDoc(doc),t=editor.context.getState();
   const facts=productionPreviewFacts(doc,t,packet);
   assertPreviewExportBinding(exported,editor.revision,facts);
   const deliverables=(await productionDeliverables(doc)).map(({bytes:_bytes,...output})=>output);
   const {input,executionManifest}=facts;
   const reviewed=await executeWithRecovery('review_clipmentor_preview',{action:'request',operationId:operation('independent-review'),maxRequests:1,src,videoSha256:await sha256File(file),input,
    executionManifest},'preview-review') as Record<string,unknown>;
   if(reviewed.error||reviewed.status!=='completed')throw new Error('连续成片复核未取得有效回执');
   if(criteria&&reviewed.visualCriteriaDigest!==criteria.digest)throw Error('handoff_visual_criteria_preview_missing_or_stale');
   const result=await collectSavedPreviewVisualEvidence(reviewed,args=>editor.execute('review_clipmentor_preview',args,'preview-visual-evidence'));
   if(!(result.effective_review as {can_use_as_pass?:boolean})?.can_use_as_pass)return {artifact:{receipt:result,revision:editor.revision},repair:'edit'};
   return {artifact:{receipt:result,preview:src,deliverables,requirementsDigest:digestValue(policy?.brief.doneCriteria??[]),...(criteria?{visualCriteriaDigest:criteria.digest}:{}),executionReport:task.completed.edit?.artifact.executionReport??null,language_review:'final_operator_required',complete_film_accepted:false}};
  }
  // Only these author stages may call the API model; review/export have separate host paths.
  const prefix=`${task.stage}:${task.feedbackUsed?'feedback':'initial'}:${task.repairs}:`;
  if(Object.entries(task.effects).some(([id,e])=>id.startsWith(prefix)&&e.kind==='model'))throw new Error('author_stage_already_attempted; inspect saved run before explicit reconciliation, no repeat submission');
  const authorDecision=productionAuthorDecision(task,!!reflowBaseline);
  const {pictureOnly:pictureOnlyRepair,independent:repairingIndependent,selfCheck:fixingSelfCheck}=authorDecision;
  await recordProductionDecision(task,{scope:'author',action:'select',reason:authorDecision.mode});
  const goal=reflowBaseline?'修复现存横版误用：先只读现有工程和已审蓝图，再用原set_aspect_ratio将活动画布设为9:16；第一笔保存起就必须满足竖版。随后逐段重新安排原生实例，不能仅裁横片或只改画布尺寸交差。保持全部现有实例ID、源窗、时间位置、原声/旁白音量、稿件、字幕原文、短标及9条音频；只调整视觉几何和排版。原片完整竖版主体、讲解参照关系、原片/讲解标识与下方实底字幕区均须在竖版清楚可读。片头仍为压暗原片铺底+成绩前景，片尾完整使用已审商品+Storyboard整卡。图片裁切参数必须在改成竖版后从现行原入口回读，不沿用横版像素换算；不修改蓝图或素材。不要新增配音/审核/观察，不自行导出。用实际组合帧检查片头、每组、片尾后保存，由宿主使用剩余渲染额度导出。':pictureOnlyRepair?'仅修复任务 audio_picture_repair 中的画面承载问题。读取现行稿、原片证据和实测音频，按整组而不是锁死单句短窗安排画面。只用 set_picture_plan 给受影响组登记新画面计划（必须沿用 current_script_candidate），保留原有交付段、结构、口播、字幕与短标文字。可读取或保存原片证据帧，不新增配音或观察。每段必须有实际信息任务，不循环、慢放或空长定格凑秒数。现行稿、音频和实测锚点随任务附带。保存后交现有审核，不自签通过。':repairingIndependent
   ? '只修独立审核回执列出的未通过项；逐项同步口播、字幕、教学重点、画面计划和证据边界。仅换候选版本、改说明或收窄口播却保留旧教学断言不算完成；补证则登记实际来源与支持关系，不把观察等同审核批准。保留原判、已通过单元、片头片尾及实际素材。旁白若在原片和明确登记的短标或关系卡之外没有独立教学损失，撤掉重复旁白和其同文字幕，保留画面承载及教学重点，回读对应计划。当前稿件和画面安排保存后交重新自检及审核。'
   : fixingSelfCheck
   ? '修订已保存的蓝图，逐项回应任务附带的作者自检。根据已有原片证据核实混色、色号、晕染及促单，证据不足就收窄或标未知；保留未受影响的教学。只修实际缺项。凡同一对象、色号或动作无法从已登记证据确认，就收窄口播和短标，避免反复补证。口播指到的动作必须在当句选材范围实际可见。字幕分卡按意群拆分且保持同文。正文 phases 使用 {mode:"original",source_range_seconds:[起,止],picture:"画面"} 或 {mode:"explanation",line_id:"单句ID",source_range_seconds:[起,止],picture:"画面"}；不用 kind、line_ids 或 source_ranges。每条讲解跟对应原声，先逐个点名现行稿件里的所有 line_id，每句均覆盖，匹配 source_breakdown 已登记的播放窗和回看。viewer_stage_cues.original 用 text/enter/exit，revisit 为逐句关联的 {line_ids,text,enter,exit} 数组。片头片尾留在各自交付段，不塞进正文 phases。字幕分卡不改口播文字。保存后用 read_clipmentor_analysis 的 current_copy/单元 ID 回读。保留现有版本和失败回执，不配音、不剪辑。'
   : goals[task.stage];
  const beforeExecution=task.stage==='edit'?structuredClone(doc):undefined;

  if(task.stage==='edit'){
   const readiness=await productionBlueprintReadiness(doc,task.input.voice);
   if(!readiness.ready)throw new Error(`production_edit_not_ready:${readiness.code}`);
   const fixed=reflowBaseline?{updates:[]}:frozenParameterEdits(doc);
   const feedback=task.repairContext?.final_feedback as {kind?:string;item_ids?:string[]}|undefined;
   if(feedback?.kind==='execution')fixed.updates=(fixed.updates as Array<Record<string,unknown>>).filter(e=>feedback.item_ids?.includes(String(e.itemId)));
   if((fixed.updates as unknown[]).length){const applied=await editor.execute('edit_item',fixed,'frozen-native-parameters') as Record<string,unknown>;if(applied.error)throw new Error(`frozen_native_parameters_conflict:${applied.error}`);}
  }
  const evidenceTask=productionReviewObservation(doc,task);
  let priorSourceOperation:string|undefined;
  let currentSourceOperation:string|undefined;
  if(fixingSelfCheck){
   const dependencies=sourceVideoDependencies();
   for(const effect of Object.values(task.effects).reverse()){
    if(effect.kind!=='observation'||effect.status!=='completed')continue;
    const receipt=await readSourceVideoReceipt(effect.operationId,task.projectId,dependencies).catch(()=>null);
    if(receipt?.result?.validation.status==='valid'&&receipt.source_hash===a.source.sourceContentHash){
     priorSourceOperation??=receipt.operationId;
     if(evidenceTask&&receipt.subject.revision===a.revision&&receipt.subject.digest===a.production_copy_review?.content_digest
      &&digestValue(receipt.observation_task??null)===digestValue(evidenceTask)){
      currentSourceOperation=receipt.operationId;break;
     }
    }
   }
  }
  const recoveryTask=task.stage==='blueprint'&&!pictureOnlyRepair?(task.repairContext?.source_observation_recovery
   ??(!currentSourceOperation&&productionSourceObservationAllowed(task)?evidenceTask:undefined)):undefined;
  let recoveredSourceOperation:string|undefined=currentSourceOperation;
  if(recoveryTask){
   const observed=await executeWithRecovery('observe_clipmentor_source_video',{
    operationId:operation('source-boundary-context-recovery'),maxRequests:1,expectedRevision:a.revision,
    observationTask:recoveryTask,
   },'source-boundary-context-recovery') as {ok?:boolean;operationId?:string;current_binding?:string;error?:string;receipt?:SourceVideoReceipt};
   if(observed.ok===true&&observed.current_binding==='current'&&observed.operationId){
    recoveredSourceOperation=observed.operationId;
   }else if(observed.receipt?.validation?.issues.length===1
    &&observed.receipt.validation.issues[0]?.code==='missing_task_observation'){
    const asset=doc.assets.find(item=>item.id===a.source.asset_id);
    const subject=await copyReviewSubject(doc);
    if(!asset||!a.source.sourceContentHash||asset.sourceContentHash!==a.source.sourceContentHash)
     throw new Error('source_recovery_asset_binding_mismatch');
    const request:SourceVideoRequest={operationId:observed.receipt.operationId,maxRequests:1,projectId:task.projectId,authorRunId:task.taskId,
     source:{src:asset.src,hash:a.source.sourceContentHash,fps:a.source.fps,duration:a.source.duration_seconds},
     subject:{revision:subject.revision,digest:subject.digest,units:subject.units.map(({unit_id,candidate_id})=>({unit_id,candidate_id}))},
     packet:await copyTeachingPacketFromDoc(doc),observationTask:recoveryTask as SourceVideoTask};
    const revalidated=await recoverSourceVideoReceipt(request,undefined,sourceVideoDependencies());
    if(revalidated.validation?.status!=='valid'||!revalidated.result)throw new Error('source_recovery_validation_failed');
    recoveredSourceOperation=revalidated.operationId;
   }else throw new Error(`原片观察仍未取得有效回执（${observed.receipt?.error??observed.error??'unknown'}）`);
  }
  if(recoveredSourceOperation){
   const savedObservation=await readSourceVideoReceipt(recoveredSourceOperation,task.projectId,sourceVideoDependencies());
   if(savedObservation?.result?.validation.status!=='valid'||savedObservation.source_hash!==a.source.sourceContentHash
    ||savedObservation.subject.revision!==a.revision)throw new Error('source_observation_saved_binding_mismatch');
  }
  const outstanding=fixingSelfCheck?checkSourceBreakdown(doc).issues:[];
  const affected=new Set(outstanding.map(issue=>issue.id));
  const repairTargets=fixingSelfCheck&&a.source_breakdown?a.blueprint.flatMap(unit=>{
   if(!affected.has(unit.unit_id))return [];
   const review=(unit as unknown as {internal_review?:Record<string,any>}).internal_review;
   const candidate=review?.[review.current_script_candidate];
   const plan=review?.[review.current_picture_plan];
   const registered=a.source_breakdown!.units.find(row=>row.unit_id===unit.unit_id);
   return [{unit_id:unit.unit_id,issues:outstanding.filter(issue=>issue.id===unit.unit_id),
    current_lines:candidate?.lines??[],phases:plan?.phases??[],registered_revisits:registered?.revisits??[],
    registered_segments:a.source_breakdown!.segments.filter(segment=>registered?.original_segment_ids.includes(segment.segment_id)
     ||registered?.explanation_segment_ids.includes(segment.segment_id)).map(({segment_id,source_range_seconds})=>({segment_id,source_range_seconds}))}];
  }):[];
  const taskData={...await productionAuthorTaskData(task,editor.getDoc()),goal,
   ...(pictureOnlyRepair?{measuredExecution:await currentExecutionPreparation(doc,task.input.voice)}:{}),
   ...(fixingSelfCheck?{deliveryContract:'先修复无效旧 delivery_sections：用 set_picture_plan 保存该组的新计划，去掉未成功登记的旧无效段，并保留其口播及历史。之后可用 save_clipmentor_source_frame 保存当前原片中已经核实的商品帧供片头或片尾使用，不能把视频 ID 和秒数塞入图片字段。最终用 set_copy_candidate 同时移出正文的交付句、保留其原文并绑定 plan.delivery_sections。每项是 {section_id,kind:performance_opening 或 creator_invitation,line:{line_id,narration_ms,caption_lines,meaning_zh,labels},evidence_ids:[实际业务事实ID],picture:{asset_id,src,sha256,description},voice:{provider,voiceId,speed:1}}。业务事实必须真实且 source_ids 含实际图片 ID，可登记用户已确认的限制与用途，不能把画面推断写成用户事实。没有销量归属就只做学习过渡。'}:{}),
   ...(fixingSelfCheck?{phaseSelectionContract:'原声组的 source_range_seconds 与正式回看登记保留；逐句更窄或不相邻的实际选材请在对应解释 phase 写 context_source_ranges:[{segment_id,source_range_seconds:[开始,结束],purpose}]，只能引用登记的同组真实段落。逐句 source_seconds 覆盖所选子窗但不意味着播间隙。不要只把子窗写在 picture 散文里。若两句任务不同，分别写自己的选材和短标。caption_lines 拆成同文的短意群，每项一张卡，并明确分页约定。若计划用关系卡，登记要上屏的确切短标文案；没有依据的绝对说法收窄。'}:{}),
   ...(task.repairContext?.source_evidence_import?{evidenceRepair:'已从有效原片回执按现行段落登记 source-av 证据。先读 evidence 和 source_breakdown；给确有原话的 original_claim 补准确的中文意思 meaning_zh，引用现有证据，不伪造 transcript 或人工听审。逐句对照同组已登记原话和动作，无法证实的色号、动作完成或购买邀请改成有依据的说法；无法确认的保留未知。同步实际逐句画面范围与原片拆解、画面阶段、字幕分卡。保留已登记片头片尾及实际图片。'}:{}),
   ...(repairTargets.length?{repairTargets,instruction:'只处理列出的单元。片头过渡和达人行动邀请归 plan.delivery_sections，用真实素材和业务证据绑定；正文只放教学句。无法确认销量归属时省略数字。回看范围与已登记段落一致；若教学确需更窄窗口，先把真实范围与证据登记进源片拆解，再同步 phases。保存后回读，确认列出的缺口实际消失。'}:{}),
   ...(priorSourceOperation?{sourceObservation:{operationId:priorSourceOperation,instruction:'读已保存回执，按原片时间核实原话和动作。回执对应旧稿，只可用作同一原片的证据，不能证明现行蓝图或剪辑已通过。'}}:{}),
   ...(recoveredSourceOperation?{sourceObservation:{operationId:recoveredSourceOperation,instruction:'已完成修正后的连续原片观察。用 read_clipmentor_source_video 读取这份回执，核对现有五组；只按证据修正，不重写全部稿件。'}}:{})};
  const guidance=await loadProductionAuthorGuidance(task.stage,file=>editor.loadSkill('clipmentor',file));
  const feedbackSource=task.stage==='blueprint'?task.blueprintFeedback:undefined;
  const run=createRun({projectId:task.projectId,sessionGeneration:await currentAgentSessionGeneration(task.projectId),backend:task.input.authorBackend??'api',provider:task.input.author.provider,model:task.input.author.model,context:{productionTaskId:task.taskId,stage:task.stage}});
  await flushRunPersistence(run);
  const sourceObservationAllowed=productionSourceObservationAllowed(task,recoveredSourceOperation);
  const tools=canonicalServerRunToolCatalog(false,true).filter(s=>(hostNames.has(s.name)||isExternalServerDirectTool(s.name))&&productionStageToolAllowed(task.stage,s.name)
   &&(sourceObservationAllowed||s.name!=='observe_clipmentor_source_video'));
  await executeRun(run,{backend:task.input.authorBackend??'api',provider:task.input.author.provider,model:task.input.author.model,openAiApiMode:task.input.author.apiMode,cacheMode:'short',maxOutputTokens:8192,
   autonomousAcceptance:false,maxAcceptanceIterations:1,origin:task.input.author.origin,tools,
   messages:[{role:'user',content:JSON.stringify(taskData)}],
   instructions:`${guidance}\n服务端制作任务；只使用可用工具。临时网关故障由系统在额度内处理；不要自行换服务或重提同一技术故障。不要等待逐阶段人工指令，不能调用本机Codex、文件脚本或自签审核。先读当前工程与现行稿，不读旧稿替代当前指针。阶段目标：${goal}${recoveredSourceOperation?' 本轮已经完成连续观察，直接使用任务所附的只读回执。':''}${feedbackSource?' 完成本轮后，在最终回复末尾附 <feedback_summary>["位置：用户希望的效果", "另一位置：另一项要求"]</feedback_summary>。用中文归并本次意见的独立修改目标，通常2至5点，每点短句；保留范围、否定和条件，不逐句照抄口语，不添加要求或声称已解决。只用于页面显示，原始意见始终是修改与审核依据。不要为摘要追加模型调用或工具。':''}`,
   ...(task.input.humanBlueprintReview&&task.input.authorBackend==='codex'?{localProductionCodex:true as const}:{}),
   host:{signal:stage.signal,maxTurns:Math.max(1,task.input.budget.model-task.attempts.model),deadlineAt:task.createdAt+task.input.budget.maxElapsedMs,
    beforeRequest:()=>stage.effect('model',`author-${task.attempts.model}`,async()=>null).then(()=>undefined),
    execute:async(name,args,id)=>{
     if(pictureOnlyRepair&&name==='revise_clipmentor_analysis'){
      const groups=(task.repairContext!.audio_picture_repair as {groups:Array<{unit_id:string}>}).groups;
      const error=pictureRepairWriteError(editor.getDoc(),args,groups);
      if(error)return{error};
     }
     if(pictureOnlyRepair&&['observe_clipmentor_source','observe_clipmentor_source_video','submit_voice'].includes(name))return{error:'picture_repair_reuses_existing_evidence_and_audio'};
     if(!productionStageToolAllowed(task.stage,name)||(!sourceObservationAllowed&&name==='observe_clipmentor_source_video'))throw new Error(`production_execution_role_forbids:${name}`);
     if(task.stage==='blueprint'&&name==='save_clipmentor_source_frame'&&args.assetId!==task.input.sourceAssetId)
      throw new Error('Source still must use the production task original video');
     if(task.stage==='analysis'&&name==='read_clipmentor_analysis'&&args.view==='storyboard'){
      return {status:'deferred_to_blueprint',next_read:{view:'source_breakdown'},production_approved:false};
     }
     if(task.stage==='blueprint'&&name==='edit_asset'){
      assertCreatorDocumentEdit(editor.getDoc(),args);
      const result=await executeWithRecovery(name,args,id);
      const prepared=await preparePanelStoryboardForAuthor(editor.getDoc(),stage.signal),storyboard=prepared.asset;
      if(storyboard)editor.context.commands.applyDoc({...editor.getDoc(),assets:[...editor.getDoc().assets,storyboard]});
      return {...(typeof result==='object'&&result?result:{result}),...(prepared.issue?{creatorStoryboard:{status:'needs_revision',reason:prepared.issue}}
       :{creatorStoryboardAssetId:storyboard?.id??panelStoryboardAsset(editor.getDoc())?.id})};
     }
     return name==='load_skill'?editor.loadSkillTool(args):executeWithRecovery(name,args,id);
    }}});
  if(run.status!=='completed')throw new Error(run.error??'Author stage failed');
  captureBlueprintFeedbackSummary(task,feedbackSource,run.events.filter(event=>event.type==='text-delta').map(event=>(event.data as {text?:string}).text??'').join(''));
  let next=editor.getDoc();const analysis=next.clipMentorAnalysis;
  if(!isClipMentorAnalysis(analysis)||!analysis.points.length||!analysis.blueprint.length||!analysis.evidence.length)throw new Error('analysis_stage_incomplete');
  if(task.stage==='blueprint'){
   if(task.input.panelDelivery){
    const document=await preparePanelStoryboardForAuthor(next,stage.signal);
    if(document.issue){await editor.commit();return {artifact:{revision:editor.revision,blueprint_structure_issue:document.issue},repair:'blueprint'};}
    if(document.asset){editor.context.commands.applyDoc({...next,assets:[...next.assets,document.asset]});next=editor.getDoc();}
   }
   try{await prepareProductionBlueprint(next);}catch(error){
    const issue=error instanceof Error?error.message:'';
    if(!task.input.humanBlueprintReview||!repairableBlueprintIssue(issue))throw error;
    await editor.commit();
    const saved=await loadOfflineStoredProject(task.projectId);
    if(saved?.revision!==editor.revision)throw new Error('production_saved_readback_mismatch');
    return {artifact:{revision:saved.revision,blueprint_structure_issue:issue},repair:'blueprint'};
   }
  }
  if(task.stage==='audio')await verifyProductionNarration(next,task.input.voice);
  if(task.stage==='edit'){
   if(task.input.panelDelivery)assertProductionCanvas(next);
   try{await verifyProductionEditing(next,task.input.voice);}catch(error){
    const diagnostic=executionMappingDiagnostic(error);
    if(!diagnostic)throw error;
    await editor.commit();
    return {artifact:{revision:editor.revision,runId:run.id,execution_validation_error:diagnostic,
     instruction:'只修实际摆放校验列出的执行差异；先读现存工程，不重做主体，不改已审计划、稿件或音频。整张已审片尾卡须原样完整显示，不能放大裁掉、上移或拆解替代。保存并按实际组合帧自查。原回执仍有效；宿主复核通过才导出。'},repair:'edit'};
   }
   assertSharedProduction(task,next);assertLocalFeedbackPreservation(beforeExecution!,next,task.repairContext?.final_feedback as Record<string,unknown>|undefined);
  }
  await editor.commit();
  const saved=await loadOfflineStoredProject(task.projectId);
  if(!saved||saved.revision!==editor.revision)throw new Error('production_saved_readback_mismatch');
  const blueprintReadiness=await productionBlueprintReadiness(saved.doc,task.input.voice);
  const executionReport=beforeExecution?await productionExecutionReport(beforeExecution,saved.doc,task.input.voice):undefined;
  return {artifact:{revision:editor.revision,analysisRevision:analysis.revision,runId:run.id,blueprintReadiness,
   ...(executionReport?{executionReport}:{}),semantic_quality:'not_certified_by_structure'}};
 }catch(error){
  // Tool commits are durable even when the subsequent audio verifier fails.
  // Never reconcile an already-stale opening snapshot or someone else's write.
  if((task.stage==='audio'||task.stage==='edit')&&task.projectRevision===openedRevision&&editor.revision!==openedRevision){
   const committed=await loadOfflineStoredProject(task.projectId);
   if(committed?.revision===editor.revision)task.projectRevision=editor.revision;
  }
  throw error;
 }finally{await editor.close();}
};

/** Only a host's located native-mapping failure is an execution repair. Review,
 * protected-media and general tool failures cannot be recast as permission. */
export function executionMappingDiagnostic(error:unknown):string|undefined{
 return error instanceof Error&&error.message.startsWith('Actual sequence mapping incomplete: ')?error.message:undefined;
}

/** A host-recorded recovery may READ one exact legacy snapshot. Every write and
 * render still uses the normal portrait guard; this is not a format exemption. */
export function isBoundCanvasReflow(task:ProductionTask,doc:ProjectDoc):boolean{
 const recovery=task.repairContext?.canvas_reflow as Record<string,unknown>|undefined;
 return task.stage==='edit'&&!!task.input.panelDelivery&&!!recovery
  &&recovery.project_revision===task.projectRevision&&recovery.project_digest===digestValue(doc)
  &&recovery.target_width===720&&recovery.target_height===1280;
}

export function assertCanvasReflowPreservation(before:ProjectDoc,after:ProjectDoc){
 const project=(doc:ProjectDoc)=>{const {timelines:_timelines,...rest}=doc;return rest;};
 if(digestValue(project(before))!==digestValue(project(after)))throw Error('canvas_reflow_changed_content_or_assets');
 const strip=(doc:ProjectDoc)=>doc.timelines.map(t=>{
  if(t.id!==before.activeTimelineId)return t;
  const {width:_width,height:_height,fit:_fit,selectedId:_selection,selectedIds:_selections,items,...rest}=t;
  return {...rest,items:items.map(i=>{
   if(i.kind==='audio')return i;
   const {width:_w,height:_h,transform:_transform,props,...fixed}=i;
   const layout=new Set(['fontSize','lineHeight','letterSpacing','textAlign','verticalAlign','width','height','maxWidth','maxHeight',
    'paddingLeft','paddingRight','paddingTop','paddingBottom','padding','paddingX','paddingY','x','y']);
   return {...fixed,...(props?{props:Object.fromEntries(Object.entries(props).filter(([key])=>!layout.has(key)))}:{})};
  })};
 });
 if(digestValue(strip(before))!==digestValue(strip(after)))throw Error('canvas_reflow_changed_timing_copy_or_audio');
}

/** The actual model message is generated from the saved plan, never from a path-only handoff. */
export async function productionAuthorTaskData(task:ProductionTask,doc:ProjectDoc){
 if(task.input.panelDelivery&&!isBoundCanvasReflow(task,doc))assertProductionCanvas(doc);
 const policy=await productionReviewRequirements(task.projectId);
 const goal=goals[task.stage as keyof typeof goals];if(!goal)throw new Error('production_stage_not_authoring');
 const prepared=['audio','edit'].includes(task.stage)?await currentExecutionPreparation(doc,task.input.voice):null;
 return {evidenceInspection:productionEvidenceInspection(doc,task),task:task.input.brief,stage:task.stage,goal,feedback:task.stage==='blueprint'?task.blueprintFeedback??task.feedback??null:task.feedback??null,repairContext:task.repairContext?.repair?{repair:task.repairContext.repair,revision:task.repairContext.revision,final_feedback:task.repairContext.final_feedback??null}:task.repairContext??null,
  ...(task.sharedProduction?.prepared?{sharedBody:{end_frame:task.sharedProduction.endFrame,
   instruction:'片头和教学主体已从同批另一版本复用，实际时间线中此前的画面、音频、字幕和样式全部保持。只为本版本补齐片尾，不能重新剪主体、重复配同文音频或改动前段。'}}:{}),
  ...(policy?{doneCriteria:policy.brief.doneCriteria}:{}),
  ...(task.stage==='blueprint'&&task.input.panelDelivery?{deliveryRequirements:{
   ...task.input.panelDelivery,storyboardAssetId:panelStoryboardAsset(doc,await currentCreatorDocument(doc))?.id??null,
   storyboardDocument:{source_sha256:doc.clipMentorAnalysis?.source.sourceContentHash,
    instruction:'原片 Storyboard 是另一个交付文档，不是教学蓝图。用原片证据整理逐段的镜头动作说明与原片信息，按三列 PDF 组织，不交零散听写或空白动作栏。若 storyboardAssetId 缺失，先用现有 edit_asset 更新 sourceAssetId，props 仅写 clipmentorCreatorStoryboard:{source_sha256,rows:[{source_range_seconds:[起,止],source_frames:[已核原帧],shot_ms:马来语客观动作说明,information_ms:马来语原片信息整理,visible_evidence_ids:[可见证据],claim_evidence_ids:[原话证据]}]}。覆盖完整原片，不把说明写成拍摄指令或因果点评。工具会返回本片文档封面资产ID，再将它绑定到已合作片尾；不新增配音或模型调用步骤。'},
   instructions:(task.input.panelDelivery.audience?`本次只制作 ${task.input.panelDelivery.audience}，保留一个 performance_opening 和该达人阶段的一个 creator_invitation。`:'在现行 picture_plan.delivery_sections 登记一个 performance_opening 和两个 creator_invitation，分别使用 section_id new_contact、existing_partner。')+'每段各有独立 line_id、马来语口播、同文字幕、中文、图片绑定和对应证据。'+
   '片头参照 NIUMO V7 和 Green Makes 定稿。picture.layout={kind:original_underlay,source:{asset_id,src,sha256},range:[原片起止秒],shade:0.63,show_sales:布尔,headline:[成绩标题各行],transition:[同款提问和邀请看拍法各行]}。用本片原片压暗铺底、同款提问、接清晰原片。只有冻结 salesEvidenceId 时，绑定 salesAssetId 作成绩前景并引用该证据；否则 picture 用 productAssetId 作商品身份证据，show_sales=false，headline=[]，不上商品静图或未确认数字。新建联 picture 用 ctaAssetId，默认 layout={kind:recruitment_card,poster:{asset_id:ctaAssetId,src,sha256:ctaAssetHash}}，原海报整图等比适配，不自制替代卡。只有本项目原话明确要求分裁时才用 product_commission，保留商品与佣金同屏及素材身份。参照只比较构图，不作为上屏素材或本项目业绩事实。口播不替海报中的未核条件追加承诺，保留联系合作动作。'+
   '制作已合作版本时，用 storyboardAssetId 展示并交本片原片拍摄参考，邀请到货后按自己的风格开拍。蓝图默认登记两种结尾；执行子任务按自身输出范围落实。将原话中文和阶段标识中文分别登记。证据只引用核实的素材及其实际用途。'
  }}:{}),
  voice:task.input.voice??null,sourceAssetId:task.input.sourceAssetId,revision:doc.clipMentorAnalysis?.revision,
  frozenBlueprint:prepared?.view??null,blueprintReadiness:prepared?.readiness??await productionBlueprintReadiness(doc,task.input.voice),
  actor:{operator:'task_operator',executor:'builtin_api_agent',instruction:task.input.brief,identity:'local_declared_not_authenticated'}};
}

/** Completion probe, not an approval: missing audio falls through to normal authoring. */
export async function savedProductionAudioReady(doc:ProjectDoc,voice?:{provider:string;voiceId:string}){
 const gate=await checkCopyProduction(doc,'clipmentor');
 if(!gate.allowed)throw new Error('Current review no longer authorizes audio');
 try{return (await verifyProductionNarration(doc,voice)).length>0;}catch{return false;}
}
