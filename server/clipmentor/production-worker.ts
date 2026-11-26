import {recoveredAnalysisWrite} from './production-analysis-recovery';
import {frozenTeachingTopics,sourceClosingPolicy,sourceTeachingAdvice} from './production-source-policy';
import {compactProductionTaskHistory,findArchivedProductionGatewayDecision} from './production-task-history';
import {blueprintFindings,pictureRepairFindings,productionAuthorDecision,repairableBlueprintIssue} from './production-decisions';
import {pictureRepairWriteError} from './production-capacity-repair';
import {teachingReplayRisks} from '../../src/clipmentor/blueprint-lint';
import {teachingSelectionGaps} from '../../src/clipmentor/teaching-selection';
import {frozenParameterEdits} from '../../src/clipmentor/execution-parameters';
import {assertLocalFeedbackPreservation,feedbackProjectDigest,captureBlueprintFeedbackSummary} from './production-feedback';
import {guardBlueprintOpinionWrite} from './production-blueprint-opinions';
import {currentExecutionPreparation,currentReviewRepair,needsVisualReviewCompletion} from './execution-view';
import {createHash} from 'node:crypto';
import {digestValue} from '../agent-runs/store-values';
import teachingPurpose from '../../src/agent/skills/clipmentor/references/teaching-purpose.json';
import {boundNarrationCriterion,checkTeachingBaseline,confirmedTeachingDigest,interruptedClosingPlanUnit,newlyChangedTeaching,qualifiedTeachingDigest,retireTeachingDrafts,staleRebuiltTeaching,teachingBaselineSource,teachingDraftPointersDigest,
 confirmedTeachingIssue,teachingPointGaps,teachingRebuild,unchangedRejectedTeaching,unchangedWholeFilmTeaching,wholeFilmIssue,type TeachingRebuild} from './production-teaching-baseline';
import {migrateProjectDoc} from '../../src/persist/projectStore';
import {revisionOf} from '../../src/agent/external-edit-session';
import {createRun,flushRunPersistence} from '../agent-runs/store';
import {executeRun} from '../agent-runs/executor';
import {canonicalServerRunToolCatalog} from '../agent-runs/tool-policy';
import {type SourceVideoReceipt,type SourceVideoTask,type SourceVideoRequest} from '../../shared/clipmentor-source-video';
import {loadAgentArtifact,storeAgentArtifact} from '../../src/persist/agentRuntimeStore';
import {currentAgentSessionGeneration} from '../../src/persist/agentSessionGeneration';
import {checkCopyProduction,copyTeachingPacketFromDoc,copyReviewSubject} from '../../src/clipmentor/production-gate';
import {handoffDigest,openingComparisonCriterion} from '../../shared/clipmentor-handoff';
import {confirmedOpeningResultsMatch,deliveryPictureBindings} from '../../src/clipmentor/delivery-sections';
import {deliverySectionsFromDoc,openingMaxLineCharacters} from '../../src/clipmentor/delivery-bindings';
import {currentPicturePhases,picturePhaseIssueCode} from '../../src/clipmentor/blueprint-picture-notices';
import {copyPreparationReady,checkSourceBreakdown} from '../../src/clipmentor/source-breakdown';
import {completedSourceEvidenceOperations,importProductionSourceEvidence,productionEvidenceInspection,productionSourceObservationAllowed,productionReviewObservation,verifiedUnansweredSourceObservation} from './production-source-evidence';
import {invalidateChangedReviews,isClipMentorAnalysis} from '../../src/clipmentor/analysis';
import {isExternalReadTool,isExternalServerDirectTool} from '../../src/agent/external-tool-policy';
import {resolveUploadFile} from '../media-dir';
import {sha256File} from '../../shared/node-content-hash';
import {setTimeout as sleep} from 'node:timers/promises';
import {readSourceVideoReceipt,recoverSourceVideoReceipt,sourceVideoDependencies} from './source-video';
import {productionLocalSpeech,registerProductionLocalSpeech} from './production-local-speech';
import {recoverProductionGateway,type GatewayRecoveryDecision} from './production-recovery';
import {blockingAuthorBlueprintChecks,checkProductionAuthorBlueprint} from './production-author-self-check';
import {preparePanelStoryboardForAuthor,panelDeliveryIssues,panelStoryboardAsset,panelSalesEvidence,panelEndingEvidence,preparePanelPartnerCard,panelPartnerPicture,partnerStoryboardRequired,panelPartnerCardIssue} from './production-panel-delivery';
import {creatorStoryboard} from './creator-storyboard';
import {assertCreatorDocumentEdit,currentCreatorDocument} from './creator-storyboard-document';
import {createProductionPreparation,productionBoardPhaseIssues,verifyProductionNarrationFiles,prepareProductionBlueprint,productionBlueprintReadiness,productionExecutionReport} from './production-readiness';
import {openHeadlessEditor,type RenderSnapshotBinding} from './headless-editor';
import {loadOfflineStoredProject} from '../external-agent/offline-project-store';
import type {ProjectDoc} from '../../src/editor/types';
import {productionPreviewFacts,previewFactsDigest,assertPreviewExportBinding,productionPreviewReviewInput} from './production-preview-facts';
import {previewBlueprintAlignmentDigest} from './preview-review';
import {productionDeliverables} from './production-deliverables';
import {collectSavedPreviewVisualEvidence} from './preview-visual-evidence';
import {productionOpeningComparison,productionReviewRequirements,productionTeachingBrief} from './production-task';
import {assertSharedProduction} from './production-continuation';
import {assertVisualCriteriaPlan,visualCriteriaPlanReceiptMatches,boundVisualCriteria,visualCriteriaPlanApproved,teachingReferenceInputs} from './visual-done-criteria';
import {assertProductionCanvas,verifyProductionOutput} from './production-format';
export {productionPreviewFacts} from './production-preview-facts';
export {reconcileBlockedBlueprint} from './production-blueprint-recovery';
export {productionBoardPhaseIssues} from './production-readiness';

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
/** Re-reading a live or losslessly archived decision is not another write.
 * Diagnostics retain the existing quota; they cannot crowd out task checkpoints. */
export async function persistProductionGatewayDecision(record:ReturnType<typeof productionGatewayDecisionArtifact>,
 deps:{store:typeof storeAgentArtifact;load:typeof loadAgentArtifact;archived?:typeof findArchivedProductionGatewayDecision;compact?:typeof compactProductionTaskHistory}=
 {store:storeAgentArtifact,load:loadAgentArtifact,archived:findArchivedProductionGatewayDecision,compact:compactProductionTaskHistory}){
 let envelope;try{envelope=JSON.parse(record.body);}catch{throw Error('gateway_recovery_decision_not_saved');}
 if(envelope?.type!=='clipmentor-gateway-recovery/v1'||envelope.taskId!==record.runId)throw Error('gateway_recovery_decision_not_saved');
 const matches=(existing:Awaited<ReturnType<typeof loadAgentArtifact>>)=>!!existing&&existing.projectId===record.projectId&&existing.runId===record.runId&&existing.kind===record.kind
  &&existing.toolName===record.toolName&&existing.bodySha256===record.bodySha256&&existing.body===record.body
  &&existing.originalBytes===record.originalBytes&&existing.originalChars===record.originalChars
  &&existing.redacted===record.redacted&&existing.binaryOmitted===record.binaryOmitted;
 const existing=await deps.load(record.projectId,record.artifactId)??await deps.archived?.(record);
 if(existing){if(!matches(existing))throw Error('gateway_recovery_decision_not_saved');return;}
 if(deps.compact)for(let batch=0;batch<64&&await deps.compact(record.projectId,record.runId);batch++){ /* existing lossless low-water mark */ }
 if(await deps.store(record))return;
 const saved=await deps.load(record.projectId,record.artifactId)??await deps.archived?.(record);
 if(!matches(saved??null))throw Error('gateway_recovery_decision_not_saved');
}
import {recordProductionDecision,isPanelBlueprintDraft,panelBlueprintRequirementsDigest,productionRepairContext,type StageWorker,type StageContext,type StageResult,type ProductionTask} from './production-task';

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
 blueprint:'先回读已保存的 source_breakdown 和 current_copy。逐个保留组用 revise_clipmentor_analysis 的 set_copy_candidate 一次登记马来语口播、同文字幕、中文与画面计划；首稿在 record 内写 source_candidate_id:null，已有稿用现行 ID。两种情况都给新的 script_candidate_ 和 picture_plan_ ID，不用 revise 手写指针。全部保留组登记后再用 observe_clipmentor_source_video 补核关键原声和动作，需要时局部修订。成绩与学习过渡缺资料时明确记录原因，不静默删掉；按完整话意和动作决定看一组讲一组或其他组织，不固定四组。按 planning.md 的 Before drafting the narration 从本组事实与回看安排起稿。对有口播的主讲，只读实际马来语，达人就能听出原作者的拍摄选择，以及观众当场得到的具体信息或想弄清的问题。原消费者促单与达人阶段邀请分开。每组用既有unit表达原声与解释，必要条件、画面承担、回看进出和视觉继承明确。未配音仅填语义锚点，不编实测秒数；先检查最终审核投影。不得自签审核或剪辑。',
 audio:'只处理已审现行稿。先找同文、同音色现有音频；仅合成缺少的句子，保留实测声长及来源。按整组核承载，缺素材或需改稿时说明冲突，不赶读、慢放、循环或长定格凑时长。',
 edit:'按当前已审蓝图和真实音频执行。edit_item 的 adds 用于从真实素材创建尚不存在的实例；fixed_native_edits 只是已有实例的差异补丁，空数组不代表禁止创建。空时间线应按已审阶段顺序创建；输出帧位由实测音频长度及有效词级锚点落实，不能把无绝对摆放位置误判成没有音频锚点，不得把估算当实测。保留已定源窗，声画无法承载时返回具体句和冲突，不把整项交回用户。读取 current_copy 的 summary/candidate/picture_plan 必须带实际 unitId。按已审逐句 evidence_source_ranges 落回看，每个所讲重点都要用到自己的证据；context_source_ranges 只补充。短标跟随本组约定的原声、回看或讲解句。完成原生实例组装后回读；宿主根据真实音频实例、原声播放和已审逐句选材核对实际摆放，不要求执行者改写蓝图或补production_rows，不自行调用revise_clipmentor_analysis登记。原声实例保留正常声音，讲解回看视频静音；源片参照图用save_clipmentor_source_frame保留来源，不用无关素材。保留教学重点和必要拍法，原片/讲解强区分、字幕实底可读且无阴影。源片对象、阶段与讲解意群对应。用实际合成帧自查，保存后停止，不自行导出。'
};

/** Author examples are loaded only while forming the teaching plan, never as
 * independent-review answers or repeated instructions for audio/edit stages. */
const exemplarReference='references/reproduction-lessons.md';
export async function loadProductionAuthorGuidance(stage:ProductionTask['stage'],load:(file:string)=>Promise<string>,
 onRead?:(file:string,body:string)=>void){
 if(!['analysis','blueprint','audio','edit'].includes(stage))throw new Error('author_guidance_stage_not_authoring');
 const files=['SKILL.md','references/planning.md'];
 if(stage==='analysis'||stage==='blueprint')files.push(exemplarReference);
 return (await Promise.all(files.map(async file=>{
  const body=await load(file);
  if(typeof body!=='string'||!body.trim())throw new Error(`author_guidance_empty:${file}`);
  onRead?.(file,body);
  return body;
 }))).join('\n');
}
/** Check delivery and picture input together before self-check or copy production review. */
export async function prepareProductionCopyReview(
 task:ProductionTask,doc:ProjectDoc,revision:string,criteria:ReturnType<typeof boundVisualCriteria>,
 openingComparison:ReturnType<typeof productionOpeningComparison>,signal:AbortSignal,
):Promise<{prepared:Awaited<ReturnType<typeof createProductionPreparation>>}|(StageResult&{repair:'blueprint'})>{
 const issues:ReturnType<typeof blueprintFindings>=task.input.panelDelivery?productionBoardPhaseIssues(doc):[];
 const add=(code:string,id='delivery',targets?:string[])=>issues.push({code,id,...(targets?.length?{targets}:{})});
 let prepared:Awaited<ReturnType<typeof createProductionPreparation>>|undefined;
 try{prepared=await createProductionPreparation(doc);}
 catch(error){
  if(!task.input.humanBlueprintReview||!(error instanceof Error))throw error;
  const findings=blueprintFindings(error.message);
  if(!findings.length||pictureRepairFindings(error.message).length!==findings.length)throw error;
  issues.push(...findings);
 }
 const sections=()=>{
  if(prepared)return prepared.rawPacket.delivery_sections;
  try{return deliverySectionsFromDoc(doc);}
  catch(error){
   if(!(error instanceof Error)||!/^delivery_[a-z_]+(?::|$)/.test(error.message))throw error;
   add('delivery_sections_invalid');
   return null;
  }
 };
 const delivery=sections();
 if(task.input.panelDelivery&&(prepared?prepared.rawPacket.units.some(unit=>unit.source_context?.scope!=='frozen_task_scope')
  :doc.clipMentorAnalysis?.source_breakdown?.review_scope?.kind!=='full_source'))
  add('source_review_scope_missing','analysis');
 if(delivery!==null){
  const openings=delivery?.filter(section=>section.kind==='performance_opening')??[];
  if(openingComparison&&openings.length!==1)add('opening_comparison_section_missing_or_duplicate');
  if(openingComparison?.results&&openings.length===1&&!confirmedOpeningResultsMatch(openings[0],openingComparison.results))
   add('opening_results_missing_or_changed');
  try{
   const units=prepared?.rawPacket.units??doc.clipMentorAnalysis?.source_breakdown?.units??[];
   assertVisualCriteriaPlan(criteria,delivery,units.map(unit=>unit.unit_id),doc.activeTimelineId);
  }catch(error){
   if(!(error instanceof Error))throw error;
   const [code,...targets]=error.message.split(':');
   add(code,'delivery',targets);
  }
  if(task.input.panelDelivery){
   const content=await currentCreatorDocument(doc);
   const deliveryIssues=panelDeliveryIssues(doc,{...task.input.panelDelivery,bookends:'layered-v1'},content);
   deliveryIssues.forEach(code=>add(code));
   if(!deliveryIssues.length){
    const partnerIssue=await panelPartnerCardIssue(doc,task.input.panelDelivery,content,undefined,signal);
    if(partnerIssue==='existing_partner_composition_verifier_unavailable')throw Error(partnerIssue);
    if(partnerIssue)add(partnerIssue);
   }
  }
 }
 if(issues.length){
  const unique=[...new Map(issues.map(issue=>[digestValue(issue),issue])).values()];
  return {artifact:{revision,blueprint_structure_issue:`blueprint_stage_incomplete:${JSON.stringify(unique)}`},repair:'blueprint'};
 }
 if(!prepared)throw Error('blueprint_execution_plan_missing');
 return {prepared};
}

async function runProductionCopyReview({
 task,stage,editor,doc,policy,criteria,prepared,teachingBriefDigest,baselinePolicyDigest,
 teachingDigest,panelScope,panelDraft,strictEditorial,executeWithRecovery,operation,
}:{
 task:ProductionTask;
 stage:StageContext;
 editor:Awaited<ReturnType<typeof openHeadlessEditor>>;
 doc:ProjectDoc;
 policy:Awaited<ReturnType<typeof productionReviewRequirements>>;
 criteria:ReturnType<typeof boundVisualCriteria>;
 prepared:Awaited<ReturnType<typeof createProductionPreparation>>;
 teachingBriefDigest:string|undefined;
 baselinePolicyDigest:string;
 teachingDigest:string|undefined;
 panelScope:ProductionTask['input']['panelDelivery'];
 panelDraft:boolean;
 strictEditorial:boolean;
 executeWithRecovery:(name:string,args:Record<string,unknown>,id:string)=>Promise<unknown>;
 operation:(scope:string)=>string;
}):Promise<StageResult>{
 const a=doc.clipMentorAnalysis!;
 const authorCriteria=productionAuthorCriteria(task,policy,doc),authorCriteriaDigest=digestValue(authorCriteria);
 const repairRequirements=()=>({artifact:{revision:editor.revision,review_contract_recheck:true,reason:'review_requirements_changed'},repair:'copy_review' as const});
 const digest=prepared.reviewed.subject.digest;
 if(task.input.humanBlueprintReview){
  const pictures=panelScope?deliveryPictureBindings(doc,prepared.rawPacket.delivery_sections):undefined;
  const hostDeliveryEvidence:Record<string,unknown>|undefined=pictures?{
   pictureBindings:pictures,
   referenceText:pictures.flatMap(binding=>{
    if(binding.status!=='ready'||!('roles' in binding)||!binding.roles)return [];
    return Object.entries(binding.roles).map(([role,{source_rect:r}])=>
     `${binding.section_id} ${role} 原图实际裁切 ${r.x}, ${r.y}, ${r.width} × ${r.height} 像素`);
   }),
  }:undefined;
  if(hostDeliveryEvidence&&partnerStoryboardRequired(panelScope)){
   const pdf=await creatorStoryboard(doc,stage.signal);
   hostDeliveryEvidence.storyboardAttachment={mediaType:'application/pdf',pages:pdf.pages,
    inputDigest:pdf.inputDigest,status:'complete_pdf_bytes_verified_for_this_source',
    note:'交付布局的 attachment 素材字段标识绑定的原片 Storyboard。独立 PDF 已由宿主读取，成片确认时经随片附件入口交付。'};
  }
  const check=await checkProductionAuthorBlueprint(task,stage,doc,prepared,await editor.loadSkill('clipmentor','references/blueprint-self-check.md'),authorCriteria,hostDeliveryEvidence,panelDraft);
  if(check.digest!==digest)throw new Error('blueprint_author_self_check_stale');
  const issues=blockingAuthorBlueprintChecks(check.checks,panelDraft&&strictEditorial);
  const incompleteAttachment=panelDraft&&strictEditorial&&!!check.referenceIssues?.length;
  const businessCheck=check.checks.find(entry=>entry.id==='S7');
  const pendingBusinessClaim=incompleteAttachment
   ?businessCheck?.status==='ok'?undefined:businessCheck
   :panelDraft&&issues.length===1&&issues[0].id==='S7'&&issues[0].status==='unresolved'?issues[0]:undefined;
  const businessNotice=pendingBusinessClaim?.reason??(incompleteAttachment&&!businessCheck?'片尾素材中的合作条款还需核实。':undefined);
  if(issues.length&&!pendingBusinessClaim&&!incompleteAttachment)return {artifact:{revision:editor.revision,blueprint_digest:digest,author_self_check_source_digest:check.sourceDigest,author_self_check:issues},repair:'blueprint'};
  if(panelDraft){
   const currentPolicy=await productionReviewRequirements(task.projectId);
   if(panelBlueprintRequirementsDigest(currentPolicy)!==baselinePolicyDigest)return repairRequirements();
   const current=await loadOfflineStoredProject(task.projectId);
   if(current?.revision!==editor.revision)throw Error('blueprint_author_self_check_stale');
   return {artifact:{revision:editor.revision,blueprint_digest:digest,
    authorSelfCheck:businessNotice?'needs_human_review':incompleteAttachment?'pending':'passed',
    ...(businessNotice?{authorSelfCheckNotice:businessNotice}:{}),
    ...(pendingBusinessClaim?{authorSelfCheckFinding:pendingBusinessClaim}:{}),
    ...(incompleteAttachment?{authorSelfCheckReferenceIssues:check.referenceIssues}:{}),
    teaching_baseline_digest:teachingDigest,
    ...(strictEditorial?{authorNarrationAnswers:check.checks.find(entry=>entry.id==='S1')?.teaching_units??[]}:{}),
    author_self_check_source_digest:check.sourceDigest,requirementsDigest:panelBlueprintRequirementsDigest(currentPolicy),
    ...(task.input.doneCriteria?.length?{sourceCriteriaDigest:digestValue(task.input.doneCriteria)}:{})},awaitBlueprintFeedback:true};
  }
 }
 const submitPolicy=await productionReviewRequirements(task.projectId);
 if(panelBlueprintRequirementsDigest(submitPolicy)!==baselinePolicyDigest
  ||digestValue(productionAuthorCriteria(task,submitPolicy,editor.getDoc()))!==authorCriteriaDigest)return repairRequirements();
 if((stage.remaining?.('review')??1)<=0&&!stage.hasEffect?.('review',operation('independent-review')))
  throw new Error('review budget exhausted');
 const result=await (task.input.budget.routine?executeWithRecovery:editor.execute)('request_clipmentor_copy_review',{operationId:operation('independent-review'),maxRequests:1,expectedRevision:a.revision},'copy-review') as Record<string,unknown>;
 if(result.error){
  const diagnostic=result.diagnostic as {code?:string;requestsAttempted?:number}|undefined;
  if(diagnostic?.code==='opening_comparison_section_missing'&&diagnostic.requestsAttempted===0)
   return {artifact:{revision:editor.revision,blueprint_structure_issue:'blueprint_stage_incomplete:[{"code":"opening_comparison_section_missing_or_duplicate","id":"delivery"}]'},repair:'blueprint'};
  if(diagnostic?.code==='review_requirements_changed')
   return {artifact:{revision:editor.revision,receipt:result,review_contract_recheck:true},repair:'copy_review'};
  if(task.input.budget.routine&&(stage.remaining?.('review')??0)<=0
   &&diagnostic?.requestsAttempted===1)throw new Error('review budget exhausted');
  throw new Error(String(result.error));
 }
 if(criteria&&!visualCriteriaPlanReceiptMatches(criteria,editor.getDoc().clipMentorAnalysis?.production_copy_review))
  throw Error('handoff_visual_criteria_review_missing_or_stale');
 const currentPolicy=await productionReviewRequirements(task.projectId);
 if(panelBlueprintRequirementsDigest(currentPolicy)!==baselinePolicyDigest
  ||digestValue(productionAuthorCriteria(task,currentPolicy,editor.getDoc()))!==authorCriteriaDigest)return repairRequirements();
 const gate=await checkCopyProduction(editor.getDoc(),'clipmentor',undefined,productionOpeningComparison(task,currentPolicy,editor.getDoc()),strictEditorial,teachingBriefDigest);
 if(!gate.allowed){
  if(gate.code==='copy_teaching_brief_review_stale')return repairRequirements();
  if('delivery_issues' in gate&&gate.delivery_issues?.some(issue=>['opening_comparison_review_missing_or_stale','ending_picture_review_missing_or_stale'].includes(issue)))
   return {artifact:{revision:editor.revision,receipt:result,review_contract_recheck:true},repair:'copy_review'};
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

async function runProductionExport(task:ProductionTask,editor:Awaited<ReturnType<typeof openHeadlessEditor>>,doc:ProjectDoc,signal:AbortSignal):Promise<StageResult>{
 await verifyProductionNarrationFiles(doc,task.input.voice);
 const packet=await copyTeachingPacketFromDoc(doc);
 const facts=productionPreviewFacts(doc,editor.context.getState(),packet);
 const alignmentDigest=previewBlueprintAlignmentDigest(productionPreviewReviewInput(doc,facts.input,packet));
 const exportedRevision=editor.revision,factsDigest=previewFactsDigest(facts);
 const result=await editor.execute('submit_render_job',{format:'video',codec:'h264',resolution:'720p',videoBitrate:3000000,name:'ClipMentor-review-preview.mp4'},'export') as RenderSnapshotBinding;
 if(!result.renderId)throw new Error('Missing render ID');
 await editor.close(); // The queued export owns its snapshot, not the editable project.
 for(;;){
  signal.throwIfAborted();const snapshot=await editor.readExport(result.renderId,result) as {status:string;result?:Record<string,unknown>;error?:string};
  if(['succeeded','completed'].includes(snapshot.status)&&snapshot.result){
   let outputDimensions:{width:number;height:number}|undefined;
   if(task.input.panelDelivery){
    const src=snapshot.result.path??snapshot.result.downloadUrl;
    const file=typeof src==='string'?resolveUploadFile(src.replace(/^\/media\/uploads\//,'')):null;
    if(!file)throw Error('Preview missing');
    outputDimensions=await verifyProductionOutput(file,signal);
   }
   return {artifact:{renderId:result.renderId,...snapshot.result,...(outputDimensions?{outputDimensions}:{}),revision:exportedRevision,facts_digest:factsDigest,blueprint_alignment_input_sha256:alignmentDigest,feedback_project_digest:feedbackProjectDigest(doc)}};
  }
  if(['failed','cancelled'].includes(snapshot.status))throw new Error(snapshot.error??'Render failed; committed editing retained');
  await new Promise<void>((resolve,reject)=>{const stop=()=>{clearTimeout(timer);reject(signal.reason);};const timer=setTimeout(()=>{signal.removeEventListener('abort',stop);resolve();},1000);signal.addEventListener('abort',stop,{once:true});});
 }
}

function productionAuthorToolExecutor({
 task,editor,panelDraft,panelScope,pictureOnlyRepair,sourceObservationAllowed,source,hasQualifiedTeaching,
 executeWithRecovery,requestObservation,preparePanelAssets,
}:{
 task:ProductionTask;
 editor:Awaited<ReturnType<typeof openHeadlessEditor>>;
 panelDraft:boolean;
 panelScope:ProductionTask['input']['panelDelivery'];
 pictureOnlyRepair:boolean;
 sourceObservationAllowed:boolean;
 source:{fps:number;duration_seconds:number};
 hasQualifiedTeaching:()=>boolean;
 executeWithRecovery:(name:string,args:Record<string,unknown>,id:string)=>Promise<unknown>;
 requestObservation:(args:Record<string,unknown>,id:string)=>Promise<unknown>;
 preparePanelAssets:()=>Promise<{issue?:string}>;
}){
 return async(name:string,args:Record<string,unknown>,id:string)=>{
  if(panelDraft&&task.stage==='analysis'&&name==='revise_clipmentor_analysis'
   &&['set_copy_candidate','select_copy_lines','set_picture_plan'].includes(String(args.action)))
   return {error:'teaching_baseline_analysis_cannot_write_copy',next_step:'先登记教学选点，不写稿。'};
  if(panelDraft&&['analysis','blueprint'].includes(task.stage)
   &&name==='revise_clipmentor_analysis'&&args.action==='set_source_breakdown'
   &&args.record&&typeof args.record==='object'&&!Array.isArray(args.record)){
   // This panel task is frozen to the complete original. Selected teaching
   // playback still belongs to the author and may use narrow source windows.
   const record=args.record as Record<string,unknown>;
   const scope=record.review_scope as {kind?:string}|undefined;
   if(scope!==undefined&&scope?.kind!=='full_source')
    return {error:'source_review_scope_must_cover_complete_panel_source'};
   const previous=editor.getDoc().clipMentorAnalysis?.source_breakdown?.review_scope;
   const frozenScope=previous?.kind==='full_source'?previous:{kind:'full_source',instruction:task.input.brief};
   args={...args,record:{...record,review_scope:frozenScope}};
  }
  if(task.input.panelDelivery&&task.stage==='blueprint'&&name==='revise_clipmentor_analysis'
   &&['set_copy_candidate','select_copy_lines','set_picture_plan'].includes(String(args.action))){
   if(panelDraft&&!hasQualifiedTeaching())
    return {error:'teaching_baseline_changed_before_copy',next_step:'先结束此轮并保留基线；宿主会重新核验后接续写稿。'};
   const plan=(args.record as {plan?:Record<string,unknown>}|undefined)?.plan;
   const phaseIssues=plan&&typeof plan==='object'
    ?currentPicturePhases(plan,undefined,args.id,source.fps,source.duration_seconds).issues:[];
   if(phaseIssues.length)
    return {error:picturePhaseIssueCode[phaseIssues[0].kind],unit_id:args.id,
     findings:phaseIssues.map(issue=>({code:picturePhaseIssueCode[issue.kind],path:issue.path})),
     next_step:'在 record.plan.phases 给出非空的原声与逐句讲解阶段。使用 mode、source_range_seconds、picture；讲解另加 line_id。保留同组现行稿件和已登记的原片回看。'};
  }
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
   if(result&&typeof result==='object'&&'error' in result)return result;
   const prepared=await preparePanelAssets(),current=editor.getDoc();
   const partner=panelScope&&panelPartnerPicture(current,panelScope,await currentCreatorDocument(current));
   return {...(typeof result==='object'&&result?result:{result}),...(prepared.issue?{creatorStoryboard:{status:'needs_revision',reason:prepared.issue}}
    :{creatorStoryboardAssetId:panelStoryboardAsset(current)?.id,
     ...(partner?{partnerEndingPicture:partner,partnerEndingEvidenceId:panelEndingEvidence('existing_partner',[partner.asset_id,partner.layout.product.asset_id,partner.layout.storyboard.asset_id]).evidence_id}:{})})};
  }
  if(task.stage==='blueprint'&&task.input.panelDelivery&&name==='read_clipmentor_analysis'&&args.view==='storyboard'){
   const result=await executeWithRecovery(name,args,id);
   if(['storyboard_current_plan_unavailable','storyboard_snapshot_changed'].includes((result as {error?:string}|undefined)?.error??'')){
    const current=editor.getDoc();
    return {status:'pending',next_read:{view:'current_copy'},production_approved:false,
     missing_picture_phases:productionBoardPhaseIssues(current),
     partnerEndingPicture:panelPartnerPicture(current,task.input.panelDelivery,await currentCreatorDocument(current))??null,
     instruction:'此查看入口读的是完整教学审片板，尚有缺项时先保存各组画面与交付段。原片 Storyboard PDF 使用现有 edit_asset 登记并由宿主生成，不能用这个查看入口代替。'};
   }
   return result;
  }
  if(task.stage==='analysis'&&task.input.panelDelivery?.selectionPolicy==='v1'
   &&(name==='read_clipmentor_analysis'&&args.view==='source_breakdown'
    ||name==='revise_clipmentor_analysis'&&args.action==='set_source_breakdown')){
   const result=await executeWithRecovery(name,args,id);
   const analysis=editor.getDoc().clipMentorAnalysis;
   if(!analysis?.source_breakdown||!result||typeof result!=='object'||'error' in result)return result;
   return {...result,teaching_selection_gaps:teachingSelectionGaps(analysis.source_breakdown,source.duration_seconds,source.fps)};
  }
  if(task.stage==='blueprint'&&task.input.panelDelivery?.selectionPolicy==='v1'
   &&name==='read_clipmentor_analysis'&&args.view==='current_copy'){
   const result=await executeWithRecovery(name,args,id);
   if(!result||typeof result!=='object'||'error' in result)return result;
   const risks=teachingReplayRisks(editor.getDoc()).filter(risk=>!args.unitId||risk.unit_id===args.unitId);
   return risks.length?{...result,teaching_replay_risks:risks}:result;
  }
  return name==='load_skill'?editor.loadSkillTool(args):name==='observe_clipmentor_source_video'?requestObservation(args,id):executeWithRecovery(name,args,id);
 };
}

/** The same service worker is used by the HTTP task and by zero-provider regression fixtures. */
export const productionStageWorker:StageWorker=async(task,stage)=>{
 let reflowBaseline:ProjectDoc|undefined;
 const panelDraft=isPanelBlueprintDraft(task);
 const savedNarrationFindings=task.repairContext?.narration_repair_findings;
 if(panelDraft&&task.stage==='blueprint'&&Array.isArray(savedNarrationFindings)
  &&savedNarrationFindings.some(finding=>!finding?.baseline_criterion))
   throw Error('teaching_final_narration_baseline_criterion_missing_in_saved_review');
 const strictEditorial=task.input.panelDelivery?.editorialPolicy==='exemplar-v1';
 const approvedOutput=strictEditorial&&task.input.panelDelivery?.audience?task.blueprintApproval:undefined;
 let frozenTeaching=approvedOutput?.confirmedTeachingDigest;
 if(approvedOutput&&!frozenTeaching){
  const source=await loadOfflineStoredProject(approvedOutput.sourceProjectId);
  if(source?.revision===approvedOutput.sourceRevision)frozenTeaching=confirmedTeachingDigest(source.doc);
 }
 const assertConfirmedTeaching=(doc:ProjectDoc)=>{
  if(approvedOutput&&(!frozenTeaching||confirmedTeachingDigest(doc)!==frozenTeaching))
   throw Error('production_confirmed_teaching_baseline_changed');
 };
 const teachingAnalysis=panelDraft&&task.stage==='analysis';
 const analysisAuthority=(policy:Awaited<ReturnType<typeof productionReviewRequirements>>)=>digestValue({brief:task.input.brief,
  feedback:task.blueprintFeedback,feedbackRevision:task.blueprintFeedbackRevision,policy:panelBlueprintRequirementsDigest(policy)});
 let analysisCopyDigest:string|undefined;
 let assertQualifiedWrite:((doc:ProjectDoc)=>void)|undefined;
 const opinions=task.repairContext?.pending_blueprint_feedback?undefined:task.blueprintOpinions;
 let opinionStop:Error|undefined;
 const editor=await openHeadlessEditor({creatorStoryboardDraft:task.stage==='blueprint'&&!!task.input.panelDelivery,projectId:task.projectId,runId:task.taskId,origin:task.input.author.origin,review:task.input.reviewer,reviewBackend:task.input.reviewerBackend,retryGateway:task.input.humanBlueprintReview,voice:task.input.voice,signal:stage.signal,finalFeedback:task.repairContext?.final_feedback as Record<string,unknown>|undefined,
  ...(task.input.panelDelivery||opinions?{assertCanvas:(next:ProjectDoc)=>{
   if(task.input.panelDelivery)assertProductionCanvas(next);
   if(reflowBaseline)assertCanvasReflowPreservation(reflowBaseline,next);
   assertConfirmedTeaching(next);
   if(opinionStop)throw opinionStop;
   if(opinions){
    try{guardBlueprintOpinionWrite(opinions,next);}
    catch(error){
     if(error instanceof Error&&error.message.startsWith('blueprint_repair_no_progress '))opinionStop=error;
     throw error;
    }
   }
   if(analysisCopyDigest&&teachingDraftPointersDigest(next)!==analysisCopyDigest)throw Error('teaching_baseline_analysis_cannot_write_copy');
   assertQualifiedWrite?.(next);
  }}:{}),
  stageEditWrites:task.stage==='edit'||teachingAnalysis,assertCurrent:stage.assertCurrent,effect:(kind,key,work,recover)=>stage.effect(kind,key,work,recover)});
 const openedRevision=editor.revision;
 if(panelDraft&&task.stage==='analysis')analysisCopyDigest=teachingDraftPointersDigest(editor.getDoc());
 editor.context.getAgentRunSignal=()=>stage.signal;
 const executeWithRecovery=(name:string,args:Record<string,unknown>,id:string)=>{
  const execute=(next:Record<string,unknown>)=>editor.execute(name,next,id);
  if(!task.input.humanBlueprintReview&&task.input.gatewayRecovery!=='bounded')return execute(args);
  const kind=name==='request_clipmentor_copy_review'?'review':name==='review_clipmentor_preview'?'preview_review':'observation';
  return recoverProductionGateway(name,args,task.projectId,next=>!stage.signal.aborted&&((stage.remaining?.(kind)??0)>0||stage.hasEffect?.(kind,next)===true),
   execute,ms=>sleep(ms,undefined,{signal:stage.signal}),task.input.budget.routine?(task.input.budget[kind]??0):2,{
    // Old explicitly bounded/no-retry batches are not migrated into automatic recovery.
    allowRetry:kind!=='observation'&&task.input.gatewayRecovery==='bounded',
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
  assertConfirmedTeaching(editor.getDoc());
  const teachingPublication=teachingAnalysis?task.teachingAnalysisPublication:undefined;
  if(teachingPublication){
   if(teachingPublication.repairEpoch!==task.repairs
    ||task.projectRevision!==undefined&&teachingPublication.baseRevision!==task.projectRevision
    ||teachingPublication.artifact.revision!==teachingPublication.revision
    ||!isClipMentorAnalysis(teachingPublication.analysis)||teachingPublication.analysis.source.asset_id!==task.input.sourceAssetId)
    throw Error('production_teaching_analysis_publication_unconfirmed');
   const stored=editor.getDoc();
   const restored=editor.revision===teachingPublication.baseRevision?{...stored,clipMentorAnalysis:teachingPublication.analysis}:stored;
   if(revisionOf(restored)!==teachingPublication.revision||digestValue(restored)!==teachingPublication.outputDigest)
    throw Error('production_teaching_analysis_publication_unconfirmed');
   if(teachingPublication.inputDigest!==analysisAuthority(await productionReviewRequirements(task.projectId)))
    return {artifact:{revision:editor.revision,reason:'review_requirements_changed'},repair:'analysis'};
   await stage.assertCurrent?.();
   if(editor.revision===teachingPublication.baseRevision&&editor.revision!==teachingPublication.revision){
    analysisCopyDigest=teachingDraftPointersDigest(restored);
    editor.context.commands.applyDoc(restored);
    await editor.commit();
    if((await loadOfflineStoredProject(task.projectId))?.revision!==teachingPublication.revision)
     throw Error('production_saved_readback_mismatch');
   }
   return {artifact:teachingPublication.artifact};
  }
  const publication=task.stage==='edit'?task.editPublication:undefined;
  if(publication){
   const saved=await loadOfflineStoredProject(task.projectId);
   const requirements=await productionReviewRequirements(task.projectId);
   if(!saved||publication.repairEpoch!==task.repairs||publication.feedbackUsed!==task.feedbackUsed
    ||task.projectRevision!==undefined&&task.projectRevision!==publication.baseRevision&&task.projectRevision!==saved.revision
    ||publication.requirementsDigest!==digestValue(requirements?.brief.doneCriteria??[])
    ||publication.artifact.revision!==saved.revision||saved.revision!==editor.revision
    ||publication.outputDigest!==feedbackProjectDigest(saved.doc)||publication.outputDigest!==feedbackProjectDigest(editor.getDoc()))
    throw Error('production_edit_publication_unconfirmed');
   await stage.assertCurrent?.();
   return {artifact:publication.artifact};
  }
  if(task.projectRevision&&editor.revision!==task.projectRevision)throw new Error('production_project_changed; reconcile the saved project before resuming');
  if(panelDraft&&task.stage==='blueprint'&&Array.isArray(savedNarrationFindings)){
   const baseline=editor.getDoc().clipMentorAnalysis?.source_breakdown;
   for(const finding of savedNarrationFindings){
    const covered=baseline?.units.find(unit=>unit.unit_id===finding.unit_id)?.coverage.some(
     item=>item.point_id===finding.point_id&&item.treatment==='explain');
    const point=covered?baseline?.points.find(item=>item.point_id===finding.point_id&&item.role==='primary'):undefined;
    if(!boundNarrationCriterion(finding.baseline_criterion,point?.teaching_basis))
     throw Error('teaching_final_narration_baseline_criterion_stale_in_saved_review');
   }
  }
  if(isBoundCanvasReflow(task,editor.getDoc()))reflowBaseline=structuredClone(editor.getDoc());
  else if(task.input.panelDelivery)assertProductionCanvas(editor.getDoc());
  const policy=await productionReviewRequirements(task.projectId),criteria=boundVisualCriteria(policy);
  if(!editor.getDoc().clipMentorAnalysis){
   const doc=editor.getDoc(),source=doc.assets.find(a=>a.id===task.input.sourceAssetId);
   if(!source||source.kind!=='video')throw new Error('Original video asset missing');
   const file=resolveUploadFile(source.src.replace(/^\/media\/uploads\//,''));if(!file)throw new Error('Original upload unavailable');
   const hash=await sha256File(file);
   if(source.sourceContentHash&&source.sourceContentHash!==hash)throw new Error('Original source changed');
   editor.context.commands.applyDoc({...doc,assets:doc.assets.map(a=>a.id===source.id?{...a,sourceContentHash:hash}:a),clipMentorAnalysis:{
    schema_version:1,analysis_id:`production:${task.taskId}`,revision:1,source:{asset_id:source.id,sourceContentHash:hash,duration_seconds:source.durationInFrames/editor.context.getState().fps,fps:editor.context.getState().fps},
    product:task.input.product,import_origin:'production_source_facts_only',evidence:task.input.panelDelivery?[
     ...(task.input.panelDelivery.salesEvidenceId?[panelSalesEvidence(source.id,task.input.panelDelivery.salesAssetId,productionOpeningComparison(task,policy,editor.getDoc())?.results)]:[]),
     panelEndingEvidence('new_contact',[task.input.panelDelivery.ctaAssetId]),
    ]:[],points:[],blueprint:[],transcripts:[],reviews:[],audit:[]}});
   if(!teachingAnalysis)await editor.commit();
  }
  // Import saved neutral source evidence before author/self-check/review, not only
  // after exhausting a repair limit. Scoped repairs keep the evidence shown to the reviewer.
  if(!opinions&&(task.stage==='blueprint'||task.stage==='copy_review')){
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
  const panelScope=task.input.panelDelivery;
  const preparePanelAssets=async():Promise<{issue?:string}>=>{
   if(panelScope?.audience==='new_contact')return {};
   const initial=editor.getDoc();
   const prepared=await preparePanelStoryboardForAuthor(initial,stage.signal,partnerStoryboardRequired(panelScope));
   if(prepared.issue)return prepared;
   const withAsset=(doc:ProjectDoc,asset:ProjectDoc['assets'][number],prefix:string)=>{
    const assets=doc.assets.filter(prior=>prior.id!==asset.id);
    const index=assets.findIndex(prior=>prior.kind==='image'&&prior.id.startsWith(prefix));
    assets.splice(index<0?assets.length:index,0,asset);
    return {...doc,assets};
   };
   const withStoryboard=prepared.asset?withAsset(initial,prepared.asset,'clipmentor-storyboard-'):initial;
   const card=panelScope?await preparePanelPartnerCard(withStoryboard,panelScope,stage.signal):undefined;
   if(card&&panelScope){
    const storyboard=panelStoryboardAsset(withStoryboard,await currentCreatorDocument(withStoryboard));
    if(!storyboard)throw Error('existing_partner_storyboard_binding_changed');
    const next=withAsset(withStoryboard,card,'clipmentor-partner-');
    const analysis=next.clipMentorAnalysis!;
    const binding=panelEndingEvidence('existing_partner',[card.id,panelScope.productAssetId,storyboard.id]);
    if(!analysis.evidence.some(entry=>entry.evidence_id===binding.evidence_id))next.clipMentorAnalysis={...analysis,evidence:[...analysis.evidence,binding]};
    editor.context.commands.applyDoc(next);
   }else if(prepared.asset)editor.context.commands.applyDoc(withStoryboard);
   if(card||prepared.asset)await editor.commit();
   return prepared;
  };
  if(task.stage==='blueprint'&&panelScope&&!panelDraft&&editor.getDoc().clipMentorAnalysis?.source_breakdown?.units.length){
   const prepared=await preparePanelAssets();
   if(prepared.issue)task.repairContext={...task.repairContext,creator_storyboard_issue:prepared.issue};
  }
  const localSpeech=panelDraft&&['analysis','blueprint'].includes(task.stage)
   ?await productionLocalSpeech(editor.getDoc(),task.taskId,stage.signal):undefined;
  if(localSpeech){
   const previous=editor.getDoc(),withSpeech=registerProductionLocalSpeech(previous.clipMentorAnalysis!,localSpeech);
   if(withSpeech){
    await invalidateChangedReviews(withSpeech);
    if(!isClipMentorAnalysis(withSpeech))throw Error('local_source_speech_invalid');
    editor.context.commands.applyDoc({...previous,clipMentorAnalysis:withSpeech});
    if(!teachingAnalysis)await editor.commit();
   }
  }
  const doc=editor.getDoc(),a=doc.clipMentorAnalysis!;
  if(a.source.asset_id!==task.input.sourceAssetId)throw new Error('Task/source binding changed');
  // A cold worker can see the settled effect before the next stage checkpoint.
  // Restore the no-dispatch fence from the original durable receipt.
  async function recoverUnavailableObservation(value:unknown,expectedOperation:unknown):Promise<string|undefined>{
   const receipt=(value as {receipt?:SourceVideoReceipt}|undefined)?.receipt;
   if(!panelDraft||!receipt||receipt.operationId!==expectedOperation||receipt.status!=='failed')return;
   const saved=await readSourceVideoReceipt(receipt.operationId,task.projectId,sourceVideoDependencies()).catch(()=>null);
   if(!verifiedUnansweredSourceObservation(receipt,saved,{projectId:task.projectId,sourceHash:a.source.sourceContentHash,revision:editor.getDoc().clipMentorAnalysis!.revision}))return;
   task.sourceObservationUnavailableOperation=receipt.operationId;
   return receipt.operationId;
  }
  if(panelDraft&&!task.sourceObservationUnavailableOperation){
   for(const effect of Object.values(task.effects)){
    if(effect.kind==='observation'&&effect.status==='completed'&&await recoverUnavailableObservation((effect.result as {body?:unknown}|undefined)?.body,effect.operationId))break;
   }
  }
  const requestObservation=async(args:Record<string,unknown>,id:string)=>{
   if(task.sourceObservationUnavailableOperation)return {status:'source_observation_unavailable',
    operationId:task.sourceObservationUnavailableOperation,observation_submitted:false,local_speech:localSpeech};
   const result=await executeWithRecovery('observe_clipmentor_source_video',args,id);
   const unavailable=await recoverUnavailableObservation(result,args.operationId);
   if(!unavailable)return result;
   return {status:'source_observation_unavailable',operationId:unavailable,local_speech:localSpeech,
    instruction:'保留原观察失败回执。继续用本地抽帧和机器听写候选完成蓝图。未知内容留空或收窄；不要再次提交连续观察。',production_approved:false};
  };
  const references=['analysis','blueprint','copy_review'].includes(task.stage)
   ?await teachingReferenceInputs(doc,criteria,{resolve:resolveUploadFile,hash:sha256File}):[];
  const openingComparison=productionOpeningComparison(task,policy,doc);
  const teachingBrief=productionTeachingBrief(task,policy,doc);
  const teachingBriefDigest=teachingBrief?await handoffDigest(teachingBrief):undefined;
  const rebuild=panelDraft?task.repairContext?.teaching_rebuild as TeachingRebuild|undefined:undefined;
  const baselineRequirements=productionAuthorCriteria(task,policy,doc);
  const baselinePolicyDigest=panelBlueprintRequirementsDigest(policy);
  const baselineSource=(next:ProjectDoc)=>teachingBaselineSource(next,task,baselineRequirements,policy?.brief.objective,
   references.length?digestValue(references):undefined);
  let teachingDigest:string|undefined;
  let teachingDefinition:string|undefined;
  if(panelDraft&&['blueprint','copy_review'].includes(task.stage)){
   const repairBaseline=(issue:string,nextRebuild=rebuild)=>({artifact:{revision:editor.revision,
    teaching_baseline_issue:issue,...(nextRebuild?{teaching_rebuild:nextRebuild}:{})},repair:'analysis' as const});
   if(!copyPreparationReady(doc)||a.source_breakdown?.review_scope?.kind!=='full_source')
    return repairBaseline('原片教学基线的范围、重点或来源引用不完整。');
   if(task.stage==='copy_review'){
    const invalidReplay=checkSourceBreakdown(doc).issues.filter(issue=>issue.code==='picture_plan_replay_outside_evidence'
     ||issue.code==='copy_picture_outside_explanation');
    if(invalidReplay.length)return {artifact:{revision:editor.revision,
     blueprint_structure_issue:`blueprint_stage_incomplete:${JSON.stringify(invalidReplay)}`},repair:'blueprint'};
   }
   const source=baselineSource(doc);
   const pointGaps=teachingPointGaps(source,doc);
   if(pointGaps.length){
    const issue=[...new Set(pointGaps)].sort().join('；');
    if(task.repairContext?.teaching_baseline_issue===issue)throw Error('teaching_baseline_repair_no_progress: '+issue);
    return repairBaseline(issue);
   }
   const interrupted=task.stage==='copy_review'?interruptedClosingPlanUnit(doc,source):undefined;
   if(interrupted)return {artifact:{revision:editor.revision,blueprint_structure_issue:`blueprint_stage_incomplete:${JSON.stringify([{
    code:'picture_plan_closing_playback_interrupted',id:interrupted}])}`},repair:'blueprint'};
   teachingDefinition=qualifiedTeachingDigest(doc);
   const unchanged=rebuild?unchangedRejectedTeaching(source,rebuild):[];
   if(unchanged.length)throw Error('teaching_baseline_repair_no_progress: '+unchanged.map(unit=>unit.unitId+' '+unit.reason).join('；'));
   if(rebuild?.wholeFilm&&unchangedWholeFilmTeaching(source,rebuild))
    throw Error('teaching_baseline_repair_no_progress: 整片选题 '+rebuild.wholeFilm.reason);
   type NarrationReview=Awaited<ReturnType<typeof checkTeachingBaseline>>['review']['narration_checks'];
   const rejectedNarrationDigest=(findings:NarrationReview)=>findings?.length&&source.narrationTargets
    ?digestValue({requirements:baselinePolicyDigest,criteria:task.input.doneCriteria,feedback:task.blueprintFeedback,
     ...(source.selection?.timingRisks?{replay:source.selection.timingRisks.filter(risk=>findings.some(finding=>
      finding.unit_id===risk.unit_id&&finding.line_id===risk.line_id))}:{}),
     targets:source.narrationTargets.flatMap(target=>{
      const finding=findings.find(entry=>entry.unit_id===target.unit_id&&entry.point_id===target.point_id);
      if(!finding)return [];
      const lines=finding.baseline_criterion?.field==='claim_limit'
       ?target.lines.filter(line=>line.line_id===finding.line_id):target.lines;
      return [[target.unit_id,target.point_id,lines.map(line=>line.narration.normalize('NFKC').trim().replace(/\s+/gu,' '))]];
     })})
    :undefined;
   const priorNarration=task.repairContext?.narration_repair_findings as NarrationReview;
   const priorNarrationDigest=rejectedNarrationDigest(priorNarration);
   const narrationScope=digestValue({purpose:source.purpose,evidence:source.evidenceBinding,requirements:baselinePolicyDigest,
    criteria:task.input.doneCriteria,brief:source.task,feedback:source.feedback});
   const sameNarrationScope=task.repairContext?.narration_repair_scope===narrationScope;
   if(priorNarrationDigest&&task.repairContext?.narration_repair_digest===priorNarrationDigest
    &&(sameNarrationScope||!task.repairContext.narration_repair_scope))
    throw Error('teaching_final_narration_repair_no_progress: 现行口播未变');
   const checked=await checkTeachingBaseline(task,stage,source,baselinePolicyDigest,teachingDefinition);
   if(panelBlueprintRequirementsDigest(await productionReviewRequirements(task.projectId))!==baselinePolicyDigest)
    return {artifact:{revision:editor.revision,review_contract_recheck:true,reason:'review_requirements_changed'},repair:task.stage as 'blueprint'|'copy_review'};
   if(source.narrationTargets?.length&&checked.review.units.some(unit=>unit.status!=='ok'&&
    !unit.point_checks?.some(point=>point.status!=='ok')))
     throw Error('teaching_final_narration_unit_finding_unbound');
   const unitIssues=checked.review.units.filter(unit=>unit.status!=='ok').map(unit=>unit.unit_id+' '+unit.reason);
   const topicIssues=[wholeFilmIssue(checked.review.whole_film),confirmedTeachingIssue(checked.review)]
    .filter(issue=>!!issue).map(issue=>'整片选题 '+issue);
   const issues=[...topicIssues,...unitIssues];
   if(issues.length)return repairBaseline(issues.join('；'),teachingRebuild(source,doc,checked.review,rebuild));
   const narrationIssues=checked.review.narration_checks?.filter(answer=>answer.status!=='ok');
   if(narrationIssues?.length){
    if(narrationIssues.some(answer=>!answer.baseline_criterion))
     throw Error('teaching_final_narration_baseline_criterion_missing_in_saved_review');
    const normalizedReason=(reason:string)=>reason.normalize('NFKC').replace(/\s+/gu,' ').trim().replace(/[。.!！]+$/u,'');
    const repeated=sameNarrationScope&&narrationIssues.find(answer=>priorNarration?.some(old=>
     old.unit_id===answer.unit_id&&old.point_id===answer.point_id&&old.status===answer.status
     &&normalizedReason(old.reason)===normalizedReason(answer.reason)));
    const artifact={revision:editor.revision,narration_repair_digest:rejectedNarrationDigest(narrationIssues),
     narration_repair_scope:narrationScope,narration_repair_findings:narrationIssues,
     teaching_baseline_issue:narrationIssues.map(answer=>answer.unit_id+' '+answer.reason).join('；'),
     instruction:'保留已成立的选题。按独立核验逐条把具体拍摄决定和买家多得到的判断依据写进现行口播，核对字幕和回看。'};
    if(repeated){
     task.repairContext=productionRepairContext(task.repairContext,artifact);
     throw Error('teaching_final_narration_repair_no_progress: 同一讲解缺口重复出现，已保留候选和回执，待维护侧核对。'+repeated.unit_id+' '+repeated.reason);
    }
    return {artifact,repair:'blueprint'};
   }
   teachingDigest=checked.digest;
   if(task.stage==='blueprint'&&panelScope){
    let qualifiedCopy=teachingDraftPointersDigest(doc);
    assertQualifiedWrite=next=>{
     const copy=teachingDraftPointersDigest(next);
     if(qualifiedTeachingDigest(next)===teachingDefinition)qualifiedCopy=copy;
     else if(copy!==qualifiedCopy)throw Error('teaching_baseline_changed_before_copy');
    };
    const prepared=await preparePanelAssets();
    if(prepared.issue)task.repairContext={...task.repairContext,creator_storyboard_issue:prepared.issue};
   }
   if(task.stage==='copy_review'&&rebuild){
    const stale=staleRebuiltTeaching(source,doc,rebuild);
    if(stale.length)return {artifact:{revision:editor.revision,teaching_baseline_issue:'教学点已纠偏，仍需成组重写口播、字幕、短标和画面：'+stale.join(', ')},repair:'blueprint'};
   }
  }
  if(task.stage==='copy_review'){
   // Keep the editor lease through review and receipt publication.
   const copyInput=await prepareProductionCopyReview(task,doc,editor.revision,criteria,openingComparison,stage.signal);
   if(!('prepared' in copyInput))return copyInput;
   return await runProductionCopyReview({task,stage,editor,doc,policy,criteria,prepared:copyInput.prepared,teachingBriefDigest,
    baselinePolicyDigest,teachingDigest,panelScope,panelDraft,strictEditorial,executeWithRecovery,operation});
  }
  if(['audio','edit','export','self_check'].includes(task.stage)){
   assertSharedProduction(task,doc);
   if(openingComparison||strictEditorial||teachingBriefDigest){
    const gate=await checkCopyProduction(doc,'clipmentor',undefined,openingComparison,strictEditorial,teachingBriefDigest);
    if(gate.code==='copy_teaching_brief_review_stale')return {artifact:{revision:editor.revision,review_contract_recheck:true,reason:gate.code},repair:'copy_review'};
    if(!gate.allowed)throw Error('handoff_opening_comparison_review_missing_or_stale');
   }
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
    await verifyProductionNarrationFiles(saved.doc,task.input.voice);
    return {artifact:{revision:saved.revision,analysisRevision:a.revision,reusedSavedAudio:true,
     blueprintReadiness:await productionBlueprintReadiness(saved.doc,task.input.voice),semantic_quality:'not_certified_by_structure'}};
   }
  }
  if(task.stage==='export')return await runProductionExport(task,editor,doc,stage.signal);
  if(task.stage==='self_check'){
   const exported=task.completed.export?.artifact,src=exported?.path??exported?.downloadUrl;
   if(typeof src!=='string')throw new Error('Exported preview path missing');
   const file=resolveUploadFile(src.replace(/^\/media\/uploads\//,''));if(!file)throw new Error('Preview missing');
   if(task.input.panelDelivery)await verifyProductionOutput(file,stage.signal);
   const packet=await copyTeachingPacketFromDoc(doc),t=editor.context.getState();
   const alignmentDigest=exported?.blueprint_alignment_input_sha256;
   const facts=productionPreviewFacts(doc,t,packet,alignmentDigest===undefined?{legacyExport:true}:undefined);
   assertPreviewExportBinding(exported,editor.revision,facts);
   const deliverables=(await productionDeliverables(doc,undefined,task.completed.export?.at,task.input.panelDelivery)).map(({bytes:_bytes,...output})=>output);
   const {executionManifest}=facts;
   const alignedInput=alignmentDigest===undefined?undefined:productionPreviewReviewInput(doc,facts.input,packet);
   if(alignedInput&&previewBlueprintAlignmentDigest(alignedInput)!==alignmentDigest)throw Error('preview_blueprint_alignment_binding_stale');
   const input=alignedInput??facts.input;
   const reviewed=await executeWithRecovery('review_clipmentor_preview',{action:'request',operationId:operation('independent-review'),maxRequests:1,src,videoSha256:await sha256File(file),input,
    executionManifest},'preview-review') as Record<string,unknown>;
   if(reviewed.error||reviewed.status!=='completed')throw new Error('连续成片复核未取得有效回执');
   if(criteria&&reviewed.visualCriteriaDigest!==criteria.digest)throw Error('handoff_visual_criteria_preview_missing_or_stale');
   const result=await collectSavedPreviewVisualEvidence(reviewed,args=>editor.execute('review_clipmentor_preview',args,'preview-visual-evidence'));
   const gate=result.effective_review as {can_use_as_pass?:boolean;blueprint_alignment_input_sha256?:string}|undefined;
   if(alignmentDigest!==undefined&&gate?.blueprint_alignment_input_sha256!==alignmentDigest)throw Error('preview_blueprint_alignment_receipt_missing_or_stale');
   if(!gate?.can_use_as_pass)return {artifact:{receipt:result,revision:editor.revision},repair:'edit'};
   return {artifact:{receipt:result,preview:src,deliverables,requirementsDigest:digestValue(policy?.brief.doneCriteria??[]),...(criteria?{visualCriteriaDigest:criteria.digest}:{}),executionReport:task.completed.edit?.artifact.executionReport??null,language_review:'final_operator_required',complete_film_accepted:false}};
  }
  // Only these author stages may call the API model; review/export have separate host paths.
  const prefix=`${task.stage}:${task.feedbackUsed?'feedback':'initial'}:${task.repairs}:`;
  if(Object.entries(task.effects).some(([id,e])=>id.startsWith(prefix+'author-')&&e.kind==='model'))throw new Error('author_stage_already_attempted; inspect saved run before explicit reconciliation, no repeat submission');
  const operatorRevision=task.stage==='blueprint'&&!!task.blueprintFeedback&&(!!rebuild||(task.blueprintFeedbackRepair??(task.blueprintFeedbackRevision===openedRevision?task.repairs:-1))===task.repairs);
  const authorDecision=productionAuthorDecision(task,!!reflowBaseline,operatorRevision);
  const {pictureOnly:pictureOnlyRepair,independent:repairingIndependent,selfCheck:fixingSelfCheck}=authorDecision;
  await recordProductionDecision(task,{scope:'author',action:'select',reason:authorDecision.mode});
  const localizedFinal=task.repairContext?.final_feedback as {kind?:string;unit_ids?:string[];item_ids?:string[]}|undefined;
  const finalScope=task.stage==='blueprint'&&localizedFinal?.kind==='content'&&localizedFinal.unit_ids?.length
   ?'只修改终审意见所列教学组的口播、字幕和回看方案。保留原有选题、其他组、已审片头片尾和现有素材。若无法局部满足，报告缺口。'
   :task.stage==='edit'&&localizedFinal?.item_ids?.length
    ?'根据终审意见只修改所选成片区间。保留区间外的实际实例、音轨、画面和字幕；不能通过扩大范围来凑足时长。'
    :undefined;
  const goal=finalScope??(operatorRevision?'按网页提交的现行原话逐项返修，并复核整套仍适用的交付要求。使用原片和当前中马稿、实际画面找对应缺口。既有审核指出的问题仍需保留及核对。用户明确要求修改的片头、片尾和教学组纳入本轮，保留其余已通过内容。先保存再回读新候选，按现有自检和审核继续。不能补写未确认事实或覆盖原审核回执。':reflowBaseline?'修复现存横版误用：先只读现有工程和已审蓝图，再用原set_aspect_ratio将活动画布设为9:16；第一笔保存起就必须满足竖版。随后逐段重新安排原生实例，不能仅裁横片或只改画布尺寸交差。保持全部现有实例ID、源窗、时间位置、原声/旁白音量、稿件、字幕原文、短标及9条音频；只调整视觉几何和排版。原片完整竖版主体、讲解参照关系、原片/讲解标识与下方实底字幕区均须在竖版清楚可读。片头仍为压暗原片铺底+成绩前景，片尾完整使用已审商品+Storyboard整卡。图片裁切参数必须在改成竖版后从现行原入口回读，不沿用横版像素换算；不修改蓝图或素材。不要新增配音/审核/观察，不自行导出。用实际组合帧检查片头、每组、片尾后保存，由宿主使用剩余渲染额度导出。':pictureOnlyRepair?'仅修复任务 audio_picture_repair 中的画面承载问题。读取现行稿、原片证据和实测音频，按整组而不是锁死单句短窗安排画面。只用 set_picture_plan 给受影响组登记新画面计划（必须沿用 current_script_candidate），保留原有交付段、结构、口播、字幕与短标文字。可读取或保存原片证据帧，不新增配音或观察。每段必须有实际信息任务，不循环、慢放或空长定格凑秒数。现行稿、音频和实测锚点随任务附带。保存后交现有审核，不自签通过。':repairingIndependent
   ? '只修独立审核回执列出的未通过项；逐项同步口播、字幕、教学重点、画面计划和证据边界。仅换候选版本、改说明或收窄口播却保留旧教学断言不算完成；补证则登记实际来源与支持关系，不把观察等同审核批准。保留原判、已通过单元、片头片尾及实际素材。旁白若在原片和明确登记的短标或关系卡之外没有独立教学损失，撤掉重复旁白和其同文字幕，保留画面承载及教学重点，回读对应计划。当前稿件和画面安排保存后交重新自检及审核。'
   : fixingSelfCheck
   ? '修订已保存的蓝图，逐项回应任务附带的作者自检。根据已有原片证据核实混色、色号、晕染及促单，证据不足就收窄或标未知；保留未受影响的教学。只修实际缺项。凡同一对象、色号或动作无法从已登记证据确认，就收窄口播和短标，避免反复补证。口播指到的动作必须在当句选材范围实际可见。字幕分卡按意群拆分且保持同文。正文 phases 使用 {mode:"original",source_range_seconds:[起,止],picture:"画面"} 或 {mode:"explanation",line_id:"单句ID",source_range_seconds:[起,止],picture:"画面"}；不用 kind、line_ids 或 source_ranges。每条讲解跟对应原声，先逐个点名现行稿件里的所有 line_id，每句均覆盖，使用本点原片证据。以画面阶段安排实际播放，宿主会同步回看。viewer_stage_cues.original 用 text/enter/exit，revisit 为逐句关联的 {line_ids,text,enter,exit} 数组。片头片尾留在各自交付段，不塞进正文 phases。字幕分卡不改口播文字。保存后用 read_clipmentor_analysis 的 current_copy/单元 ID 回读。保留现有版本和失败回执，不配音、不剪辑。'
   : task.stage==='analysis'&&rebuild?'按原始反馈及需重选的教学组，先修原片购买关注、手法、作用、证据及前后承接。用 set_source_breakdown 保存基线并逐点填写 change_reason。可重划教学组；合并时沿用已有片头或片尾绑定的组ID。现行稿件和旧回执留作历史，本阶段不得改字幕、口播或画面方案。对未影响教学的版式意见留到蓝图阶段。'
   : goals[task.stage]);
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
  const recoveryTask=task.stage==='blueprint'&&!pictureOnlyRepair&&!task.sourceObservationUnavailableOperation?(task.repairContext?.source_observation_recovery
   ??(!currentSourceOperation&&productionSourceObservationAllowed(task)?evidenceTask:undefined)):undefined;
  let recoveredSourceOperation:string|undefined=currentSourceOperation;
  if(recoveryTask){
   const observed=await requestObservation({
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
   }else if(!task.sourceObservationUnavailableOperation)throw new Error(`原片观察仍未取得有效回执（${observed.receipt?.error??observed.error??'unknown'}）`);
  }
  if(recoveredSourceOperation){
   const savedObservation=await readSourceVideoReceipt(recoveredSourceOperation,task.projectId,sourceVideoDependencies());
   if(savedObservation?.result?.validation.status!=='valid'||savedObservation.source_hash!==a.source.sourceContentHash
    ||savedObservation.subject.revision!==a.revision)throw new Error('source_observation_saved_binding_mismatch');
  }
  const outstanding=fixingSelfCheck?[...checkSourceBreakdown(doc).issues,
   ...(task.input.panelDelivery?productionBoardPhaseIssues(doc):[])]:[];
  const affected=new Set(outstanding.map(issue=>issue.id));
  const repairTargets=fixingSelfCheck&&a.source_breakdown?a.blueprint.flatMap(unit=>{
   if(!affected.has(unit.unit_id))return [];
   const review=(unit as unknown as {internal_review?:Record<string,any>}).internal_review;
   const candidate=review?.[review.current_script_candidate];
   const plan=review?.[review.current_picture_plan];
   const registered=a.source_breakdown!.units.find(row=>row.unit_id===unit.unit_id);
   return [{unit_id:unit.unit_id,issues:outstanding.filter(issue=>issue.id===unit.unit_id),
    current_lines:candidate?.lines??[],phases:plan?.phases??[],
    registered_segments:a.source_breakdown!.segments.filter(segment=>registered?.original_segment_ids.includes(segment.segment_id)
     ||registered?.explanation_segment_ids.includes(segment.segment_id)).map(({segment_id,source_range_seconds})=>({segment_id,source_range_seconds}))}];
  }):[];
  const taskData={...await productionAuthorTaskData(task,editor.getDoc(),{policy,references}),goal,
   ...(opinions?{blueprintOpinions:{
    entries:opinions.opinions.filter(entry=>entry.edits).map(({unitId,label,text,keep,change})=>({unitId,label,text,keep,change})),
    instruction:'意见指向由入口绑定。整体意见只改整体内容和片头片尾，组内意见只改对应组。句子按现行口播顺序，确认保留的句子原样收录。用户没有指定的组和整体信息原样保留。'} }:{}),
   ...(panelDraft?{objective:policy?.brief.objective??null,doneCriteria:baselineRequirements}:{}),
   ...(panelDraft&&task.stage==='analysis'?{teachingFeedback:task.blueprintFeedback??null,
    ...(rebuild?{teachingFindings:rebuild.rejected.map(({unitId,reason})=>({unitId,reason})),
     ...(rebuild.wholeFilm?{wholeFilmFinding:{reason:rebuild.wholeFilm.reason,evidenceId:rebuild.wholeFilm.evidenceId,unitIds:rebuild.wholeFilm.unitIds}}:{}),
     beforeCopy:'分析只改基线；先证明整片主线和每组的证据能回答任务，再写稿。'}:{})}:{}),
   ...(panelDraft&&task.stage==='blueprint'&&rebuild?{teachingRebuild:rebuild.affected.map(({unitId,pointIds})=>({unitId,pointIds})),
    beforeCopy:'新教学基线已核。按受影响组原子保存新口播、同文字幕、短标和画面；只换标题、说明或候选ID无法交审。保持其余组已核内容。'}:{}),
   ...(localSpeech?{localSpeech:{...localSpeech,...(localSpeech.status==='machine_transcript_candidate'?{
    source_id:`local-asr:${localSpeech.source_hash}`,instruction:'宿主已登记这条听写来源。仅将看得清、听写与上下文都支持的原话列为候选，source_ids 填此 source_id；不要把机器听写标为人工听审或用户确认。',
   }:{})}}:{}),
   ...((task.stage==='analysis'||task.stage==='blueprint')&&panelDraft?{sourceObservationPlan:'宿主将在蓝图结构校验完成后，负责提交一次原片连续观察。当前先用本地抽帧和本机听写候选还原全片表达，再选组。每组的主要点是该段实际承担、达人可复用的表达作用（coverage.role=primary）。原作者的开场或转折若承担关键教学作用，可以成为主要点。只作过渡的片段并入同一教学关系。写 phases 时同时登记 viewer_stage_cues，其 original 和 revisit 都要写 text、enter、exit，revisit 每项用 line_ids 覆盖本组对应的解释句。'}:{}),
   ...(task.stage==='blueprint'&&task.sourceObservationUnavailableOperation?{savedObservation:{operationId:task.sourceObservationUnavailableOperation,
    instruction:'用 read_clipmentor_source_video 回读这次观察。无法取得连续视听时，依靠实际上传素材与本地画面证据完成整份蓝图。无法核实的原声、色号或动作留未知或缩窄稿件，不补写原话。优先用 set_picture_plan 逐组补齐现行稿的 phases，再分别登记片头和两种片尾。沿用已准备好的 Storyboard 及正式图片绑定。'}}:{}),
   ...(pictureOnlyRepair?{measuredExecution:await currentExecutionPreparation(doc,task.input.voice)}:{}),
   ...(fixingSelfCheck?{deliveryContract:'先修复无效旧 delivery_sections：用 set_picture_plan 保存该组的新计划，去掉未成功登记的旧无效段，并保留其口播及历史。之后可用 save_clipmentor_source_frame 保存当前原片中已经核实的商品帧供片头或片尾使用，不能把视频 ID 和秒数塞入图片字段。最终用 set_copy_candidate 同时移出正文的交付句、保留其原文并绑定 plan.delivery_sections。每项是 {section_id,kind:performance_opening 或 creator_invitation,line:{line_id,narration_ms,caption_lines,meaning_zh,labels},evidence_ids:[实际业务事实ID],picture:{asset_id,src,sha256,description},voice:{provider,voiceId,speed:1}}。业务事实必须真实且 source_ids 含实际图片 ID，可登记用户已确认的限制与用途，不能把画面推断写成用户事实。没有销量归属就只做学习过渡。'}:{}),
   ...(fixingSelfCheck?{phaseSelectionContract:'在 phases 安排原声和回看，宿主会把计划投影到回看登记。同一句要用多个镜头时可接连写同一 line_id 的解释阶段。更窄的实际选材可在对应阶段写 context_source_ranges:[{segment_id,source_range_seconds:[开始,结束],purpose}]，只能引用登记的同组真实段落。逐句 source_seconds 覆盖所选子窗但不意味着播间隙。不要只把子窗写在 picture 散文里。若两句任务不同，分别写自己的选材和短标。caption_lines 拆成同文的短意群，每项一张卡，并明确分页约定。若计划用关系卡，登记要上屏的确切短标文案；没有依据的绝对说法收窄。'}:{}),
   ...(task.repairContext?.source_evidence_import?{evidenceRepair:'已从有效原片回执按现行段落登记 source-av 证据。先读 evidence 和 source_breakdown；给确有原话的 original_claim 补准确的中文意思 meaning_zh，引用现有证据，不伪造 transcript 或人工听审。逐句对照同组已登记原话和动作，无法证实的色号、动作完成或购买邀请改成有依据的说法；无法确认的保留未知。同步实际逐句画面范围与原片拆解、画面阶段、字幕分卡。保留已登记片头片尾及实际图片。'}:{}),
   ...(repairTargets.length?{repairTargets,instruction:'只处理列出的单元。片头过渡和达人行动邀请归 plan.delivery_sections，用真实素材和业务证据绑定；正文只放教学句。无法确认销量归属时省略数字。回看可以在本组现有证据内选更窄的窗。证据确实不够时再补证。保存后回读，确认列出的缺口实际消失。'}:{}),
   ...(priorSourceOperation?{sourceObservation:{operationId:priorSourceOperation,instruction:'读已保存回执，按原片时间核实原话和动作。回执对应旧稿，只可用作同一原片的证据，不能证明现行蓝图或剪辑已通过。'}}:{}),
   ...(recoveredSourceOperation?{sourceObservation:{operationId:recoveredSourceOperation,instruction:'已完成修正后的连续原片观察。用 read_clipmentor_source_video 读取这份回执，核对现有五组；只按证据修正，不重写全部稿件。'}}:{})};
  let exemplarRead:{file:string;sha256:string}|undefined;
  const guidance=await loadProductionAuthorGuidance(task.stage,file=>editor.loadSkill('clipmentor',file),(file,body)=>{
   if(file===exemplarReference)exemplarRead={file,sha256:createHash('sha256').update(body).digest('hex')};
  });
  const feedbackSource=task.stage==='blueprint'?task.blueprintFeedback:undefined;
  const run=createRun({projectId:task.projectId,sessionGeneration:await currentAgentSessionGeneration(task.projectId),backend:task.input.authorBackend??'api',provider:task.input.author.provider,model:task.input.author.model,context:{productionTaskId:task.taskId,stage:task.stage}});
  await flushRunPersistence(run);
  const sourceObservationAllowed=!panelDraft&&productionSourceObservationAllowed(task,recoveredSourceOperation);
  const tools=canonicalServerRunToolCatalog(false,true).filter(s=>(hostNames.has(s.name)||isExternalServerDirectTool(s.name))&&productionStageToolAllowed(task.stage,s.name)
   &&(sourceObservationAllowed||s.name!=='observe_clipmentor_source_video'));
  await executeRun(run,{backend:task.input.authorBackend??'api',provider:task.input.author.provider,model:task.input.author.model,openAiApiMode:task.input.author.apiMode,cacheMode:'short',maxOutputTokens:8192,
   autonomousAcceptance:false,maxAcceptanceIterations:1,origin:task.input.author.origin,tools,
   messages:[{role:'user',content:JSON.stringify(taskData)}],
   instructions:`${guidance}\n服务端制作任务；只使用可用工具。临时网关故障由系统在额度内处理；不要自行换服务或重提同一技术故障。不要等待逐阶段人工指令，不能调用本机Codex、文件脚本或自签审核。先读当前工程与现行稿，不读旧稿替代当前指针。阶段目标：${goal}${recoveredSourceOperation?' 本轮已经完成连续观察，直接使用任务所附的只读回执。':''}${feedbackSource?' 完成本轮后，在最终回复末尾附 <feedback_summary>["位置：用户希望的效果", "另一位置：另一项要求"]</feedback_summary>。用中文归并本次意见的独立修改目标，通常2至5点，每点短句；保留范围、否定和条件，不逐句照抄口语，不添加要求或声称已解决。只用于页面显示，原始意见始终是修改与审核依据。不要为摘要追加模型调用或工具。':''}`,
   ...(task.input.humanBlueprintReview&&task.input.authorBackend==='codex'?{localProductionCodex:true as const}:{}),
   host:{signal:stage.signal,maxTurns:Math.max(1,task.input.budget.model-task.attempts.model),deadlineAt:task.createdAt+task.input.budget.maxElapsedMs,
    normalizeArgs:(name,args)=>name==='load_skill'&&typeof args.limit==='number'&&Number.isSafeInteger(args.limit)&&args.limit>48000
     ?{...args,limit:48000}:args,
    beforeRequest:()=>{
     if(opinionStop)throw opinionStop;
     return stage.effect('model',`author-${task.attempts.model}`,async()=>null).then(()=>undefined);
    },
    execute:productionAuthorToolExecutor({task,editor,panelDraft,panelScope,pictureOnlyRepair,sourceObservationAllowed,
     source:a.source,hasQualifiedTeaching:()=>qualifiedTeachingDigest(editor.getDoc())===teachingDefinition,
     executeWithRecovery,requestObservation,preparePanelAssets})}});
  if(opinionStop)throw opinionStop;
  if(panelDraft&&task.stage==='blueprint'&&qualifiedTeachingDigest(editor.getDoc())!==teachingDefinition){
   const changed=newlyChangedTeaching(baselineSource(doc),baselineSource(editor.getDoc()),doc,rebuild);
   await editor.commit();
   return {artifact:{revision:editor.revision,teaching_baseline_issue:'教学选点在写稿途中改变，需重新核对后再写。',
    ...(changed?{teaching_rebuild:changed}:{})},repair:'blueprint'};
  }
  const recoveredWrite=teachingAnalysis&&run.status==='failed'&&!stage.signal.aborted
   ?recoveredAnalysisWrite(editor.getDoc(),run.events,run.error??'',baselineSource):undefined;
  if(run.status!=='completed'&&!recoveredWrite)throw new Error(run.error??'Author stage failed');
  if(recoveredWrite)await stage.assertCurrent?.();
  captureBlueprintFeedbackSummary(task,feedbackSource,run.events.filter(event=>event.type==='text-delta').map(event=>(event.data as {text?:string}).text??'').join(''));
  let next=editor.getDoc();const analysis=next.clipMentorAnalysis;
  if(!isClipMentorAnalysis(analysis)||!analysis.points.length||!analysis.blueprint.length||!analysis.evidence.length)throw new Error('analysis_stage_incomplete');
  if(task.stage==='blueprint'){
   if(panelDraft){
    const source=baselineSource(next);
    const stale=rebuild?staleRebuiltTeaching(source,next,rebuild):[];
    if(stale.length){
     await editor.commit();
     return {artifact:{revision:editor.revision,teaching_baseline_issue:'仍需成组更新讲解和画面：'+stale.join(', ')},repair:'blueprint'};
    }
   }
   if(task.input.panelDelivery){
    const document=await preparePanelAssets();
    if(document.issue){await editor.commit();return {artifact:{revision:editor.revision,blueprint_structure_issue:document.issue},repair:'blueprint'};}
    next=editor.getDoc();
   }
   try{await prepareProductionBlueprint(next);}catch(error){
    let issue=error instanceof Error?error.message:'';
    if(panelDraft&&issue==='Invalid teaching review packet'){
     const packet=await copyTeachingPacketFromDoc(next);
     const missing=packet.units.filter(unit=>!unit.points.some(point=>point.role==='primary'));
     issue=`blueprint_stage_incomplete:${JSON.stringify(missing.length
      ?missing.map(unit=>({code:'teaching_unit_primary_point_missing',id:unit.unit_id}))
      :[{code:'teaching_review_packet_invalid',id:'analysis'}])}`;
    }
    if(!task.input.humanBlueprintReview||!repairableBlueprintIssue(issue))throw error;
    await editor.commit();
    const saved=await loadOfflineStoredProject(task.projectId);
    if(saved?.revision!==editor.revision)throw new Error('production_saved_readback_mismatch');
    return {artifact:{revision:saved.revision,blueprint_structure_issue:issue},repair:'blueprint'};
   }
   // Submit the full initial source once after the structural packet is usable,
   // even when the author already completed the draft using local evidence.
   if(panelDraft&&!task.attempts.observation&&!task.sourceObservationUnavailableOperation&&productionSourceObservationAllowed(task)){
    const result=await requestObservation({operationId:operation('initial-source'),maxRequests:1,expectedRevision:analysis.revision},'initial-source') as {ok?:boolean;error?:string};
    if(result.ok!==true&&!task.sourceObservationUnavailableOperation&&task.attempts.observation>0)
     throw Error(result.error??'未取得可恢复的原片观察回执');
   }
  }
  if(task.stage==='audio')await verifyProductionNarrationFiles(next,task.input.voice);
  if(teachingAnalysis){
   if(teachingDraftPointersDigest(next)!==analysisCopyDigest)throw Error('teaching_baseline_analysis_cannot_write_copy');
   next=retireTeachingDrafts(next);
   editor.context.commands.applyDoc(next);
   analysisCopyDigest=teachingDraftPointersDigest(next);
   const revision=revisionOf(next);
   const artifact={revision,analysisRevision:analysis.revision,runId:run.id,exemplarRead,...(recoveredWrite?{recoveredAnalysisWrite:recoveredWrite}:{}),semantic_quality:'not_certified_by_structure'};
   if(panelBlueprintRequirementsDigest(await productionReviewRequirements(task.projectId))!==baselinePolicyDigest)
    return {artifact:{revision:editor.revision,reason:'review_requirements_changed'},repair:'analysis'};
   await stage.checkpointTeachingAnalysis?.({baseRevision:editor.revision,revision,repairEpoch:task.repairs,inputDigest:analysisAuthority(policy),outputDigest:digestValue(next),artifact,analysis:next.clipMentorAnalysis!});
   if(panelBlueprintRequirementsDigest(await productionReviewRequirements(task.projectId))!==baselinePolicyDigest)
    return {artifact:{revision:editor.revision,reason:'review_requirements_changed'},repair:'analysis'};
   await editor.commit();
   if((await loadOfflineStoredProject(task.projectId))?.revision!==revision)throw Error('production_saved_readback_mismatch');
   return {artifact};
  }
  let editArtifact:Record<string,unknown>|undefined;
  if(task.stage==='edit'){
   const normalized=migrateProjectDoc(next);if(!normalized)throw Error('Invalid saved project');next=normalized;
   if(task.input.panelDelivery)assertProductionCanvas(next);
   let executionReport:Awaited<ReturnType<typeof productionExecutionReport>>;
   try{executionReport=await productionExecutionReport(beforeExecution!,next,task.input.voice);}catch(error){
    const diagnostic=executionMappingDiagnostic(error);
    if(!diagnostic)throw error;
    return {artifact:{revision:editor.revision,runId:run.id,execution_validation_error:diagnostic,
     instruction:'上轮草稿未发布。先读现存工程，再针对实际摆放校验指出的差异完成本轮。保留已审计划、稿件或音频。整张已审片尾卡须原样完整显示，按实际组合帧自查。宿主验证并保存后才导出。'},repair:'edit'};
   }
   assertSharedProduction(task,next);assertLocalFeedbackPreservation(beforeExecution!,next,task.repairContext?.final_feedback as Record<string,unknown>|undefined);
   editArtifact={revision:revisionOf(next),analysisRevision:analysis.revision,runId:run.id,
    blueprintReadiness:await productionBlueprintReadiness(next,task.input.voice),executionReport,semantic_quality:'not_certified_by_structure'};
   await stage.checkpointEditPublication?.({baseRevision:editor.revision,repairEpoch:task.repairs,feedbackUsed:task.feedbackUsed,
    outputDigest:feedbackProjectDigest(next),requirementsDigest:digestValue(policy?.brief.doneCriteria??[]),artifact:editArtifact});
  }
  await editor.commit();
  const saved=await loadOfflineStoredProject(task.projectId);
  if(!saved||saved.revision!==editor.revision
   ||task.stage==='edit'&&feedbackProjectDigest(saved.doc)!==feedbackProjectDigest(editor.getDoc()))
   throw new Error('production_saved_readback_mismatch');
  if(editArtifact){
   if(editArtifact.revision!==saved.revision||feedbackProjectDigest(next)!==feedbackProjectDigest(saved.doc))
    throw Error('production_saved_readback_mismatch');
   return {artifact:editArtifact};
  }
  const blueprintReadiness=await productionBlueprintReadiness(saved.doc,task.input.voice);
  return {artifact:{revision:editor.revision,analysisRevision:analysis.revision,runId:run.id,blueprintReadiness,
   ...(exemplarRead?{exemplarRead}:{}),
   ...(teachingDigest?{teaching_baseline_digest:teachingDigest}:{}),
   semantic_quality:'not_certified_by_structure'}};
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
function productionAuthorCriteria(task:ProductionTask,policy:Awaited<ReturnType<typeof productionReviewRequirements>>,doc:ProjectDoc){
 const criteria=policy?.brief.doneCriteria??[];
 const opening=productionOpeningComparison(task,policy,doc);
 const registered=openingComparisonCriterion(criteria);
 return opening&&opening!==registered?[...criteria.filter(entry=>entry!==registered),opening]:criteria;
}
export async function productionAuthorTaskData(task:ProductionTask,doc:ProjectDoc,checked?:{
 policy:Awaited<ReturnType<typeof productionReviewRequirements>>;references:Awaited<ReturnType<typeof teachingReferenceInputs>>;
}){
 if(task.input.panelDelivery&&!isBoundCanvasReflow(task,doc))assertProductionCanvas(doc);
 const policy=checked?checked.policy:await productionReviewRequirements(task.projectId);
 const goal=goals[task.stage as keyof typeof goals];if(!goal)throw new Error('production_stage_not_authoring');
 const prepared=['audio','edit'].includes(task.stage)?await currentExecutionPreparation(doc,task.input.voice):null;
 const references=['analysis','blueprint'].includes(task.stage)
  ?checked?.references??await teachingReferenceInputs(doc,boundVisualCriteria(policy),{resolve:resolveUploadFile,hash:sha256File}):[];
 const frozenTopics=['analysis','blueprint'].includes(task.stage)?frozenTeachingTopics(doc,task):undefined;
 const doneCriteria=productionAuthorCriteria(task,policy,doc);
 const openingResults=productionOpeningComparison(task,policy,doc)?.results;
 return {evidenceInspection:productionEvidenceInspection(doc,task),task:task.input.brief,stage:task.stage,goal,feedback:task.stage==='blueprint'?task.blueprintFeedback??task.feedback??null:task.feedback??null,repairContext:task.repairContext?.repair?{repair:task.repairContext.repair,revision:task.repairContext.revision,final_feedback:task.repairContext.final_feedback??null}:task.repairContext??null,
  ...(task.stage==='blueprint'&&task.repairContext?.narration_repair_findings?{narrationRepair:{
   findings:task.repairContext.narration_repair_findings,
   instruction:'对照现行口播和独立审核，逐项修正列出的口播及其同文字幕，核对当句回看是否仍匹配。保留已核选题、未点名的教学组和片头片尾。版本号、标题和短标的改动不能代替口播修订。'} }:{}),
  ...(['analysis','blueprint'].includes(task.stage)?{teachingPurpose,sourceClosing:sourceClosingPolicy(frozenTopics,doc)}:{}),
  ...(task.input.panelDelivery?.selectionPolicy==='v1'&&['analysis','blueprint'].includes(task.stage)
   ?{teachingSelectionContract:'v1'}:{}),
  ...(frozenTopics?{selectionAdvice:sourceTeachingAdvice(frozenTopics),
   selectionAdviceInstruction:'参考已记录的用户意图。取材可以重选，旧背景可重新评估。每个教学点引用本点最能说明拍法的真实依据，分别交代各镜头能证明什么。意见登记不改变现有编辑确认。收尾按 sourceClosing 处置。'}:{}),
  ...(task.sharedProduction?.prepared?{sharedBody:{end_frame:task.sharedProduction.endFrame,
   instruction:'片头和教学主体已从同批另一版本复用，实际时间线中此前的画面、音频、字幕和样式全部保持。只为本版本补齐片尾，不能重新剪主体、重复配同文音频或改动前段。'}}:{}),
  ...(doneCriteria.length?{doneCriteria}:{}),
  ...(references.length?{teachingReferences:{references,
   instruction:'按 sectionId 定位教学组（时间线 ID 表示全部组）。用 view_asset_frames 按 reference.assetId 和 seconds 查看指定参照，再回看本片证据。先确定它改变了本组哪项选材或讲解安排，把该取舍写进现行计划和实际稿；参照只供比较。组尚未建立时按原始要求建立该组，不能改指其他组。'} }:{}),
  ...(task.input.panelDelivery?.editorialPolicy==='exemplar-v1'&&['analysis','blueprint'].includes(task.stage)?{
   teachingSelection:task.input.panelDelivery.selectionPolicy==='v1'
    ?task.stage==='analysis'
     ?'用 planning.md 的选题方法对比候选，用 source_breakdown 回读盘点提示 teaching_selection_gaps。本阶段登记选题基线。'
     :'沿核验过的决定及各自源窗写句。用 current_copy 回读 teaching_replay_risks，明确需要实测或补参照的地方。'
    :task.stage==='analysis'
    ?'先按证据盘点完整原片的表达选择和对应的买家顾虑，再从有出处的卖点里选值得达人学的单元。比较最强的另一个讲法：如果选它，达人会少学或多学哪个决定？选中这条主线后，他拍同类内容时具体会改哪一步？各组怎样一起解释这个决定，哪些只作支持？根据选中的单元概括本片可学的价值，把决定、可回读的取舍及放弃备选的损失写进现有主讲点 coverage.reason，买家多得到的具体判断依据写进 teaching_basis.connection。区分创作者给出结论和让买家根据演示判断；按 sourceClosing 处理收尾。动作观察只为判定证据能否成立；本阶段只存选题基线，不写口播、字幕或逐句选材。'
    :'先按核验通过的选题说明每组需要保住的证据：静态细节、完整动作及结果、共同参照或套装与价格。先估保留这些信息所需的最短完整时段，再找逐句窗口。设想换成最接近的另一段会少哪一项判断；实际解释画面保住这个关系。原声给事实和反应，讲解说明拍法为什么有用，短标指向判断对象。优先合理回看。画面能交代的细节让画面承担，压缩口播时保留拍法成立的条件和具体效果。仍无法承载就说明缺口。普通做法与她的差异、声画配合、同框比较、先后承接可按实际证据组织。',
   teachingExemplars:'每个 source_breakdown.points 的 teaching_question 说明为什么这个拍法帮助买家判断。teaching_basis={selling_point,evidence_ids,method,connection,must_capture,claim_limit,exemplar,difference}；证据来自本点关联的原话候选或可见动作，范例资料只供思考。exemplar 登记本片证据适用的 principle ID，difference 说明本片成立条件与范例的差异，或说明为何本片不宜套用范例做法。清楚的听写候选可以支持原话转述，但注明未听审。纯画面例外须在 coverage.reason 说明为什么成立。',
   exemplarApplication:task.stage==='analysis'
    ?'在现有 difference 里写明借用的推理、本片的原片依据和它改变的具体教学取舍。无法迁移时交代本片缺少的成立条件。'
    :'逐主讲点回读已保存的 connection 和 difference。实际马来语口播须教出改变的拍摄决定及其作用；借用范例的推理时，用本片证据来讲。同组 S1 只从现行口播引出这个决定。纯画面教学沿用它的专用承载检查。',
   ...(openingResults?{openingResultsInstruction:
    `马来语口播及同文字幕按同款前提、成绩提问、一次邀请的顺序。成绩用 ${openingResults.views} tontonan、${openingResults.units} unit terjual、Revenue ${openingResults.revenue}。不上创作者人数前提。收入不写佣金或商品 GMV。`}:{})
  }:{}),
  ...(task.stage==='blueprint'&&task.input.panelDelivery?{deliveryRequirements:{
   ...task.input.panelDelivery,
   newContactEvidenceId:panelEndingEvidence('new_contact',[task.input.panelDelivery.ctaAssetId]).evidence_id,
   ...(partnerStoryboardRequired(task.input.panelDelivery)?{partnerEndingPicture:panelPartnerPicture(doc,task.input.panelDelivery,await currentCreatorDocument(doc))??null}:{}),
   ...(task.input.panelDelivery.audience==='new_contact'?{}:{storyboardAssetId:panelStoryboardAsset(doc,await currentCreatorDocument(doc))?.id??null,
   storyboardDocument:{source_sha256:doc.clipMentorAnalysis?.source.sourceContentHash,
    instruction:'原片 Storyboard 是另一个交付文档，不是教学蓝图。用原片证据整理逐段的镜头动作说明与原片信息，按三列 PDF 组织，不交零散听写或空白动作栏。若 storyboardAssetId 缺失，先用现有 edit_asset 更新 sourceAssetId，props 仅写 clipmentorCreatorStoryboard:{source_sha256,rows:[{source_range_seconds:[起,止],source_frames:[已核原帧],shot_ms:马来语客观动作说明,information_ms:马来语原片信息整理,visible_evidence_ids:[可见证据],claim_evidence_ids:[原话证据]}]}。各行连续覆盖完整原片，每行用半开区间内的 1–2 个原帧，至少一帧须能回读为本行所用的每条本地可见证据的支撑帧。没有可回读的连续视听原话回执时，claim_evidence_ids 保持空数组，信息栏只写实际所见；本机听写候选仍可用于蓝图的原话证据。工具会返回本片文档封面资产ID，再将它绑定到已合作片尾；不新增配音或模型调用步骤。'}}),
   instructions:(task.input.panelDelivery.audience?`本次只制作 ${task.input.panelDelivery.audience}，保留一个 performance_opening 和该达人阶段的一个 creator_invitation。`:'在现行 picture_plan.delivery_sections 登记一个 performance_opening 和两个 creator_invitation，分别使用 section_id new_contact、existing_partner。')+'每段各有独立 line_id、马来语口播、同文字幕、中文、图片绑定和对应证据。'+
   '交付段与正文句字段不同。交付段用嵌套 line:{line_id,narration_ms,caption_lines,meaning_zh,labels:[]}。picture.description 必填，voice:{provider,voiceId,speed:1}。分两次保存：先逐组补正文 phases，再用现行计划增补交付段。'+
   '片头参照 NIUMO V7 和 Green Makes 定稿。picture.layout={kind:original_underlay,source:{asset_id,src,sha256},range:[原片起止秒],shade:0.63,show_sales:布尔,headline:[成绩标题各行],transition:[同款提问和邀请看拍法各行]}。用本片原片压暗铺底、同款提问、接清晰原片。浮层每行不超过 '+openingMaxLineCharacters+' 字符；口播和字幕保持完整。只有冻结 salesEvidenceId 时，绑定 salesAssetId 作成绩前景并引用该证据；否则 picture 用 productAssetId 作商品身份证据，show_sales=false，headline=[]，不上商品静图或未确认数字。新建联 picture 用 ctaAssetId，evidence_ids 引用 newContactEvidenceId，默认 layout={kind:recruitment_card,poster:{asset_id:ctaAssetId,src,sha256:ctaAssetHash}}，原海报整图等比适配，不自制替代卡。只有本项目原话明确要求分裁时才用 product_commission，保留商品与佣金同屏及素材身份。参照只比较构图，不作为上屏素材或本项目业绩事实。口播不替海报中的未核条件追加承诺，保留联系合作动作。'+
   (partnerStoryboardRequired(task.input.panelDelivery)
    ?'已合作版用 partnerEndingPicture 的 asset_id、src、sha256 和 layout 登记现成同屏图并保留独立 PDF 槽。首次未准备时，先保存本片的原片 Storyboard；根据工具返回的 partnerEndingPicture 和 partnerEndingEvidenceId 登记。证据要绑定这张合成图和实际来源，不补写未经确认的事实。'
    :task.input.panelDelivery.audience==='new_contact'?'':'制作已合作版本时，用 storyboardAssetId 展示并交本片原片拍摄参考。')+
   '邀请到货后按自己的风格开拍。将原话中文和阶段标识中文分别登记。证据只引用核实的素材及其实际用途。'+
   (task.input.panelDelivery.editorialPolicy==='exemplar-v1'?'本次新建联使用 recruitment_card，保留上传 CTA 原图整张，不得分裁；核商品和已确认佣金在完整画面可辨。':'')
  }}:{}),
  voice:task.input.voice??null,sourceAssetId:task.input.sourceAssetId,revision:doc.clipMentorAnalysis?.revision,
  frozenBlueprint:prepared?.view??null,blueprintReadiness:prepared?.readiness??await productionBlueprintReadiness(doc,task.input.voice),
  actor:{operator:'task_operator',executor:'builtin_api_agent',instruction:task.input.brief,identity:'local_declared_not_authenticated'}};
}

/** Completion probe, not an approval: missing audio falls through to normal authoring. */
export async function savedProductionAudioReady(doc:ProjectDoc,voice?:{provider:string;voiceId:string}){
 const gate=await checkCopyProduction(doc,'clipmentor');
 if(!gate.allowed)throw new Error('Current review no longer authorizes audio');
 try{return (await verifyProductionNarrationFiles(doc,voice)).length>0;}catch{return false;}
}
