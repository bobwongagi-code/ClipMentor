import {productionWorkDeadline} from './production-shared-clock';
import {failedInitialBreakdownWrite} from './production-analysis-recovery';
import {panelProductionBudget} from './production-budget';
import { open, readFile, stat } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {sha256File} from '../../shared/node-content-hash';
import {ffmpegBin} from '../media-binaries';
import {digestValue} from '../agent-runs/store-values';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { registeredAssets, intactAsset } from './material-intake';
import { getKey, previewReviewCredential } from '../keystore';
import { codexModels, codexStatus } from '../plugins/codex-agent';
import { getStoredEntry } from '../plugins/project-store';
import { isProjectConnected } from '../external-agent/broker';
import { loadOfflineStoredProject } from '../external-agent/offline-project-store';
import { isSafeUploadName, resolveUploadFile, serveDiskFile } from '../media-dir';
import { loadReviewBoardInput, renderReviewBoards } from './blueprint-review-board';
import { reviewBoardArtifactRoot } from './blueprint-review-board-artifacts';
import {representativeTeachingExcerpt,renderTeachingExcerpt,verifyTeachingExcerptAsset,TEACHING_EXCERPT_MAX_BYTES} from './blueprint-teaching-excerpt';
import { productionFeedbackAnchor,matchesExportedPreviewProject } from './production-feedback';
import {blueprintNotices,opinionClarificationText,reviewMessages} from '../../shared/clipmentor-review-feedback';
import { panelDeliveryIssues,panelDeliveryFindings,declaredPanelOpening,panelSalesEvidence,panelPartnerCardIssue,assertPanelDeliveryReady } from './production-panel-delivery';
import { createBlueprintContinuations,publishedProductionParent,queueBlueprintContinuations,readProductionOutput,readProductionOutputs } from './production-continuation';
import { assertVisualCriteriaPlan,boundVisualCriteria,visualCriteriaPlanApproved,visualReferenceFrames } from './visual-done-criteria';
import {checkCopyProduction} from '../../src/clipmentor/production-gate';
import {handoffDigest,sourcePerformanceCriterion,type HandoffPolicy} from '../../shared/clipmentor-handoff';
import {revisionOf} from '../../src/agent/external-edit-session';
import {runProjectMigrations} from '../../src/persist/migrations';
import {handoffKey,readHandoffPolicy} from './handoff';
import {deliverySectionsFromDoc} from '../../src/clipmentor/delivery-bindings';
import {productionDeliverables,productionAttachmentSlots} from './production-deliverables';
import {verifyProductionOutput} from './production-format';
import {pendingProductionPreview,openPendingProductionPreview} from './production-playable-preview';
import {isProductionCapacityFull} from './production-capacity';
import {productionPreviewChapters} from './production-preview-chapters';
import {previewHasBoundContentIssue} from './production-shared-review';
import {assertFinalPreviewEvidence} from './production-preview-facts';
import {deliveryFileName,attachmentDisposition} from './delivery-filename';
import {currentCreatorDocument} from './creator-storyboard-document';
import { copyReviewDependencies } from './copy-review';
import {frozenTeachingTopics} from './production-source-policy';
import {readPanelSourceCriteria} from './production-panel-source-requirements';
import {canResumeFirstGlanceReview,resumeFirstGlanceReview} from './production-blueprint-recovery';
import type {PublishedNarrationDecision} from './production-teaching-baseline';
import {assertWholeBlueprintConfirmation,bindBlueprintReview,blueprintReviewEndings,blueprintReviewGroups,panelFeedbackTarget,panelReviewIssue,PanelReviewIssue} from './production-panel-review';
import {prepareBlueprintOpinions,type BlueprintOpinionRecord} from './production-blueprint-opinions';
import {
  acceptProductionTask, createProductionTask, productionFeedback, productionTaskStore, resolveHumanBlueprint, recordTechnicalRecovery,productionOpeningComparison,
  acceptsDraftBlueprintFeedback, queueDraftBlueprintFeedback,
  isPanelBlueprintDraft, panelAuthorCheckMatches,panelAuthorCheckPending,panelAuthorNeedsHumanReview,panelBlueprintRequirementsDigest,
  latestPanelProductionTask,productionReviewRequirements,productionTeachingBrief,saveProductionControl,sharedPreviewDeliveryHeld,
  type ProductionTask,
} from './production-task';

function needsSourceRequirementsMaintenance(task:ProductionTask){
 return !!task.input.panelDelivery&&!!task.input.openingComparison?.results
  &&!sourcePerformanceCriterion(task.input.doneCriteria??[]);
}

type PanelSettings = { unavailable: string } | { provider:'openai'; model:string; apiMode:'chat'|'responses'; backend:'api'|'codex' };

export const panelServiceUnavailable = '制作服务暂时不可用。';
const boardPresentationVersion='panel-opinions-v9';
function boardPresentation(doc:import('../../src/editor/types').ProjectDoc){
  return doc.clipMentorAnalysis?.source_breakdown?.units?.some(unit=>unit.teaching_selection?.first_glance?.trim())
    ?boardPresentationVersion:undefined;
}
export const panelMaterialsUnavailable = '所需素材不齐全或无法读取，请重新核对上传素材。';

const missingPreviewReviewCredential = '服务端尚未配置成片复核凭据。';

async function readSettings(): Promise<PanelSettings> {
  if (!previewReviewCredential()) return { unavailable: missingPreviewReviewCredential };
  if (!getKey('MINIMAX_API_KEY')) return { unavailable: '服务端尚未配置 MiniMax 配音。' };
  const apiModel = getKey('LLM_OPENAI_MODEL').trim();
  const apiMode = getKey('LLM_OPENAI_API_MODE') === 'chat' ? 'chat' : 'responses';
  if (apiModel && getKey('LLM_OPENAI_API_KEY')) return { provider:'openai', model:apiModel, apiMode, backend:'api' };
  const status = await codexStatus();
  if (!status.account || status.loginPending) return { unavailable: '请先登录本机 Codex，或配置 OpenAI 制作模型。' };
  const { models } = await codexModels();
  const pinned = getKey('CODEX_MODEL').trim();
  const model = pinned ? models.find(row=>row.id===pinned) : models.find(row=>row.isDefault) ?? models[0];
  if (!model) return { unavailable: '未找到可用的本机 Codex 制作模型。' };
  return { provider:'openai', model:model.id, apiMode, backend:'codex' };
}

export async function currentPanelTask(projectId:string) {
  return latestPanelProductionTask(projectId);
}

function panelBlueprintProductionAvailable(task:ProductionTask,revision:string,requirementsDigest:string){
  if(task.attempts.model>=task.input.budget.model)return false;
  const deadline=productionWorkDeadline(task);
  // Human review of a settled draft starts separate output tasks on confirmation.
  return Date.now()<deadline||(task.completed.blueprint?.at??Infinity)<deadline
    &&(panelAuthorCheckMatches(task,revision,requirementsDigest)||panelAuthorCheckPending(task,revision,requirementsDigest));
}

export function canResumeUndispatchedAnalysis(task:ProductionTask) {
  return task.input.humanBlueprintReview===true && task.input.authorBackend==='codex'
    && task.stage==='analysis' && task.status==='blocked'
    && task.error==='Error: Server production requires API backend; desktop fallback is forbidden'
    && !Object.keys(task.completed).length && !Object.keys(task.effects).length
    && Object.values(task.attempts).every(attempts=>attempts===0);
}

function canResumeSavedAnalysis(task:ProductionTask) {
  return task.input.humanBlueprintReview===true && task.input.authorBackend==='codex'
    && task.stage==='analysis' && task.status==='blocked' && task.repairs===0
    && task.error?.includes('view_asset_frames: Exact video asset or item ID required')
    && task.error.includes('read_clipmentor_analysis: storyboard_current_plan_unavailable')
    && !Object.keys(task.completed).length && task.attempts.model===1
    && Object.entries(task.attempts).every(([kind,count])=>kind==='model'||count===0)
    && Object.entries(task.effects).length===1 && task.effects['analysis:initial:0:author-0']?.status==='completed';
}

function previewFile(task:ProductionTask) {
  if (task.status !== 'awaiting_review' && task.status !== 'completed') return null;
  const src = task.completed.self_check?.artifact.preview;
  if (typeof src !== 'string' || !src.startsWith('/media/uploads/')) return null;
  const name = src.slice('/media/uploads/'.length);
  return isSafeUploadName(name) ? resolveUploadFile(name) : null;
}


/** Presentation-only union: never import the sibling's stale common body. */
export function combinePanelBlueprintEndings(primary:import('../../src/editor/types').ProjectDoc,sibling:import('../../src/editor/types').ProjectDoc){
 if(primary.clipMentorAnalysis?.source?.sourceContentHash!==sibling.clipMentorAnalysis?.source?.sourceContentHash)throw Error('片尾原片不一致');
 const ending=deliverySectionsFromDoc(sibling).find(section=>section.kind==='creator_invitation'&&section.section_id==='new_contact');
 if(!ending)throw Error('新建联片尾方案缺失');
 const result=structuredClone(primary);
 for(const asset of sibling.assets){
  const prior=result.assets.find(a=>a.id===asset.id);
  if(prior){if(prior.src!==asset.src||prior.sourceContentHash!==asset.sourceContentHash)throw Error('片尾素材冲突');}
  else result.assets.push(structuredClone(asset));
 }
 const plans=result.clipMentorAnalysis!.blueprint.map(unit=>{
  const review=(unit as unknown as {internal_review:Record<string,unknown>}).internal_review;
  return review?.[String(review.current_picture_plan)] as {delivery_sections?:import('../../src/clipmentor/delivery-sections').DeliverySection[]}|undefined;
 });
 const owner=plans.find(plan=>plan?.delivery_sections?.some(section=>section.kind==='creator_invitation'&&section.section_id==='existing_partner'));
 if(!owner)throw Error('已合作片尾方案缺失');
 if(plans.some(plan=>plan?.delivery_sections?.some(section=>section.section_id==='new_contact')))throw Error('片尾方案重复');
 owner.delivery_sections!.push(ending);
 deliverySectionsFromDoc(result); // Validate real material bindings without approving them.
 return result;
}

/** Fixed-project local frontend adapter, using the existing task ledger and worker. */
export function createProductionPanel(launch:(task:ProductionTask)=>void, active:(id:string,projectId:string)=>boolean, controls = new Set<string>(), renderExcerpt=renderTeachingExcerpt, reserveSlot: (projectId:string)=>()=>void = ()=>()=>{}, deferred: (taskId:string)=>boolean = ()=>false) {
  const launchQueuedOutputs=(children:ProductionTask[],origin:string)=>{
    for(const child of children)if(child.status==='queued'&&!active(child.taskId,child.projectId)){
      child.input.author.origin=origin;child.input.reviewer.origin=origin;
      launch(child);
    }
  };
  let preflight: { until:number; result:Promise<PanelSettings> } | undefined;
  const settings = (fresh=false) => {
    if (fresh || !preflight || Date.now() >= preflight.until) {
      preflight = { until:Date.now()+15_000, result:readSettings() };
    }
    return preflight.result;
  };
  const boards = new Map<string,{ identity:string; artifactIdentity:string; revision:string; criteriaDigest?:string; requirementsDigest?:string; siblingRevision?:string; assertUnchanged?:()=>Promise<void>; file:Promise<string> }>();
  const pendingExcerpts=new Map<string,Promise<Buffer>>();
  let excerptTail=Promise.resolve();
  const cachedExcerpts=new Map<string,Buffer>();
  const verifiedPreviews = new Map<string,Promise<void>>();
  const posters=new Map<string,Promise<Buffer>>();
  let posterTail=Promise.resolve();
  const fileStamp=(info:BigIntStats)=>[info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':');
  const verifiedMaterials=new Map<string,Promise<boolean>>();
  async function openPanelMaterial(asset:Parameters<typeof intactAsset>[0]){
    const prefix='/media/uploads/';
    const name=asset.src.startsWith(prefix)?asset.src.slice(prefix.length):'';
    const file=isSafeUploadName(name)?resolveUploadFile(name):undefined;
    if(!file||!asset.sourceContentHash)throw Error('随片资料暂不可用');
    const handle=await open(file,'r');
    try{
      const before=await handle.stat({bigint:true});
      if(!before.isFile()||!before.size)throw Error('随片资料暂不可用');
      const stamp=fileStamp(before);
      const unchanged=async()=>fileStamp(await handle.stat({bigint:true}))===stamp;
      const key=JSON.stringify([file,stamp,asset.sourceContentHash]);
      let verified=verifiedMaterials.get(key);
      if(!verified){
        verified=sha256File(file,()=>handle.createReadStream({start:0,autoClose:false}))
          .then(hash=>hash===asset.sourceContentHash&&unchanged());
        verifiedMaterials.set(key,verified);
        if(verifiedMaterials.size>12)verifiedMaterials.delete(verifiedMaterials.keys().next().value!);
        void verified.catch(()=>{if(verifiedMaterials.get(key)===verified)verifiedMaterials.delete(key);});
      }
      if(!await verified||!await unchanged())throw Error('随片资料暂不可用');
      return {file,handle,unchanged};
    }catch(error){await handle.close();throw error;}
  }
  async function previewPoster(file:string,signature:string){
    const key=JSON.stringify([file,signature]);
    let poster=posters.get(key);
    if(!poster){
      poster=posterTail.then(async()=>{
        if(fileStamp(await stat(file,{bigint:true}))!==signature)throw Error('预览已变化，请刷新');
        const result=await promisify(execFile)(ffmpegBin(),[
          '-nostdin','-loglevel','error','-threads','1','-i',file,'-an','-frames:v','1',
          '-vf','scale=144:-2','-threads','1','-vcodec','mjpeg','-f','image2pipe','pipe:1',
        ],{timeout:5000,maxBuffer:128*1024,encoding:'buffer'});
        if(!result.stdout.length||fileStamp(await stat(file,{bigint:true}))!==signature)throw Error('成片缩略图暂不可用');
        return result.stdout;
      });
      posters.set(key,poster);
      if(posters.size>12)posters.delete(posters.keys().next().value!);
      posterTail=poster.then(()=>{},()=>{if(posters.get(key)===poster)posters.delete(key);});
    }
    return poster;
  }
  async function openVerifiedPreview(task:ProductionTask,file:string){
    const receipt=task.completed.self_check?.artifact.receipt as {videoSha256?:string}|undefined;
    const legacyPreview=receipt===undefined&&task.status==='awaiting_review';
    const expected=receipt?.videoSha256??'';
    if(!legacyPreview)assertFinalPreviewEvidence(task,task.projectRevision??'',expected);
    const handle=await open(file,'r');
    try{
      const identity=(info:BigIntStats)=>{
        if(!info.isFile()||!info.size)throw Error('final_output_file_unavailable');
        return [info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':');
      };
      const signature=identity(await handle.stat({bigint:true})),key=JSON.stringify([file,signature,expected]);
      let verified=verifiedPreviews.get(key);
      if(!verified){
        verified=(async()=>{
          if(!legacyPreview){
            const hash=createHash('sha256');
            for await(const chunk of handle.createReadStream({start:0,autoClose:false}))hash.update(chunk);
            if(hash.digest('hex')!==expected)throw Error('final_output_evidence_missing_or_stale');
          }
          await verifyProductionOutput(file);
          if(identity(await stat(file,{bigint:true}))!==signature)throw Error('final_output_file_changed');
        })();
        verifiedPreviews.set(key,verified);
        if(verifiedPreviews.size>32)verifiedPreviews.delete(verifiedPreviews.keys().next().value!);
        void verified.catch(()=>{if(verifiedPreviews.get(key)===verified)verifiedPreviews.delete(key);});
      }
      await verified;
      if(identity(await handle.stat({bigint:true}))!==signature)throw Error('final_output_file_changed');
      return handle;
    }catch(error){await handle.close();throw error;}
  }
  const handler=async (projectId:string, origin:string, query:URLSearchParams, req:IncomingMessage, res:ServerResponse, readBody:()=>Promise<Record<string,unknown>>,manifestTask?:ProductionTask):Promise<void> => {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(projectId)) throw new Error('制作工程无效');
    const task = manifestTask??await currentPanelTask(projectId);
    const serveOutput=async(parent:ProductionTask,entry:NonNullable<ProductionTask['productionChild']>)=>{
      let child:ProductionTask;
      try{child=await readProductionOutput(parent,entry);}catch(error){
        if(req.method!=='GET'||query.get('view')!=='panel')throw error;
        console.error('ClipMentor selected output unavailable',error);
        res.writeHead(409,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'})
          .end(JSON.stringify({reason:'output_unavailable',error:reviewMessages.previewUnavailable}));
        return;
      }
      await handler(child.projectId,origin,query,req,res,readBody,child);
    };
    if(task?.productionChildren?.length){
      const audience=query.get('audience');
      if(!audience&&req.method==='GET'&&query.get('view')==='panel'){
        res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
        res.end(JSON.stringify({task:null,outputOwner:{taskId:task.taskId,sequence:task.sequence},
          outputs:task.productionChildren.map(child=>({audience:child.audience}))}));return;
      }
      if(!audience&&req.method==='POST'){
        const body=await readBody();
        if(body.action!=='produce_versions'||task.blueprintReview&&task.blueprintReview.boardIdentity!==body.boardIdentity)
          throw Error('蓝图版本已变化，请刷新');
        assertWholeBlueprintConfirmation(body.blueprintReview);
        let children=await readProductionOutputs(task);
        if(children.some(child=>child.blueprintApproval?.sourceRevision!==body.revision))
          throw Error('蓝图版本已变化，请刷新');
        if(!previewReviewCredential())throw Error(missingPreviewReviewCredential);
        const release=reserveSlot(projectId);
        try{
          children=await queueBlueprintContinuations(task);
          launchQueuedOutputs(children,origin);
        }finally{release();}
        res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
        res.end(JSON.stringify({accepted:true}));return;
      }
      const entry=task.productionChildren.find(child=>child.audience===audience);
      if(!entry)throw Error('制作输出不存在');
      return serveOutput(task,entry);
    }
    if(task?.productionChild){
      const audience=query.get('audience');
      if(audience!==null&&audience!==task.productionChild.audience)throw Error('制作输出不存在');
      return serveOutput(task,task.productionChild);
    }
    const snapshot = async () => {
      const saved = await loadOfflineStoredProject(projectId);
      if (!saved) throw new Error('制作工程不存在');
      return saved;
    };
    const send = (data:unknown) => {
      res.setHeader('Content-Type','application/json; charset=utf-8');
      res.setHeader('Cache-Control','no-store');
      res.end(JSON.stringify(data));
    };
    const view = query.get('view');
    const readRequirements=async()=>manifestTask
      ? await readHandoffPolicy(projectId)??manifestTask.blueprintApproval?.requirements??null
      : productionReviewRequirements(projectId);
    const policy=task?await readRequirements():null;
    const criteria=boundVisualCriteria(policy);
    const requirementsDigest=policy?digestValue(policy.brief.doneCriteria):undefined;
    const draftChecked=(current:ProductionTask,revision:string,currentPolicy:HandoffPolicy|null)=>
      !isPanelBlueprintDraft(current)||panelAuthorCheckMatches(current,revision,panelBlueprintRequirementsDigest(currentPolicy))
        ||panelAuthorNeedsHumanReview(current,revision,panelBlueprintRequirementsDigest(currentPolicy))
        ||current.status==='awaiting_blueprint'&&panelAuthorCheckPending(current,revision,panelBlueprintRequirementsDigest(currentPolicy));
    // This identity belongs to the HTTP review surface, never to the authored blueprint.
    const boardSubject=async(revision:string,currentTask=task,currentPolicy=policy)=>{
      const parent=currentTask?.blueprintApproval?await productionTaskStore.load(currentTask.blueprintApproval.sourceProjectId,currentTask.blueprintApproval.sourceTaskId):undefined;
      const siblingEntry=currentTask?.input.panelDelivery?.audience==='existing_partner'
        ?parent?.productionChildren?.find(entry=>entry.audience==='new_contact'):undefined;
      const sibling=siblingEntry?await loadOfflineStoredProject(siblingEntry.projectId):undefined;
      const artifact=currentTask?.completed.blueprint?.artifact;
      const narrationDecisions=artifact?.revision===revision&&Array.isArray(artifact.independentNarrationAnswers)
        ?artifact.independentNarrationAnswers as PublishedNarrationDecision[]:undefined;
      const artifactIdentity=digestValue({version:2,projectId,taskId:currentTask?.taskId,revision,
        criteriaDigest:boundVisualCriteria(currentPolicy)?.digest,
        requirementsDigest:currentPolicy?panelBlueprintRequirementsDigest(currentPolicy):undefined,
        sourceCriteriaDigest:currentTask?.input.doneCriteria?.length?digestValue(currentTask.input.doneCriteria):undefined,
        ...(narrationDecisions?.length?{narrationReview:digestValue(narrationDecisions)}:{}),
        siblingProjectId:siblingEntry?.projectId,siblingRevision:sibling?.revision,siblingMissing:!!siblingEntry&&!sibling});
      // Saving review notes does not change what the reviewer saw.
      const identity=digestValue({artifactIdentity,feedback:currentTask?.blueprintFeedback,feedbackRepair:currentTask?.blueprintFeedbackRepair,
        feedbackUnits:currentTask?.blueprintFeedbackUnitIds,pending:currentTask?.repairContext?.pending_blueprint_feedback,
        feedbackEpoch:currentTask?.blueprintFeedbackEpoch});
      return {identity,artifactIdentity,siblingEntry,sibling,siblingRevision:sibling?.revision,narrationDecisions};
    };
    if (req.method === 'GET') {
      const preview=task&&previewFile(task);
      const pendingPreview=task&&pendingProductionPreview(task);
      const boundPreviewProject=async()=>{
        const saved=await snapshot(),exported=task?.completed.export?.artifact;
        if(task?.status==='awaiting_review'&&task.completed.self_check?.artifact.receipt===undefined&&exported?.revision===undefined)
          return saved; // A legacy portrait preview may still be watched, but cannot be accepted without the receipt.
        if(!matchesExportedPreviewProject(exported,saved))
          throw Error('预览已变化，请刷新');
        return saved;
      };
      const currentPreviewTask=async()=>{
        if(!task)throw Error('预览已变化，请刷新');
        return manifestTask?productionTaskStore.load(task.projectId,task.taskId):currentPanelTask(projectId);
      };
      const assertCurrentPendingPreview=async(playbackOnly=true)=>{
        const current=await currentPreviewTask();
        const currentBinding=current&&pendingProductionPreview(current);
        if(!current||current.taskId!==task?.taskId||!currentBinding||!pendingPreview||digestValue(currentBinding)!==digestValue(pendingPreview))
          throw Error('预览已变化，请刷新');
        if(current.blueprintApproval)await publishedProductionParent(current,playbackOnly?{playbackOnly:true}:undefined);
        return current;
      };
      const verifyPreview=async()=>{
        if(!task||!preview)throw Error('这个预览已过期或文件缺失');
        if(!task.input.panelDelivery)return;
        const saved=await boundPreviewProject();
        await (await openVerifiedPreview(task,preview)).close();
        return saved;
      };
      const deliveryOutputs=async()=>{
        if(!task||!preview||query.get('renderId')!==task.completed.export?.artifact.renderId)throw Error('这个预览已过期或文件缺失');
        const saved=(await verifyPreview())??await snapshot();
        if(!task.input.panelDelivery&&(saved.revision!==task.projectRevision||saved.revision!==task.completed.export?.artifact.revision))
          throw Error('预览已变化，请刷新');
        return productionDeliverables(saved.doc,undefined,task.completed.export!.at,task.input.panelDelivery);
      };
      if(view==='panel_poster'){
        if(!task||query.get('renderId')!==task.completed.export?.artifact.renderId)throw Error('预览已变化，请刷新');
        await boundPreviewProject();
        const media=pendingPreview?await openPendingProductionPreview(pendingPreview)
          :preview?{file:preview,handle:await openVerifiedPreview(task,preview)}:undefined;
        if(!media)throw Error('预览暂不可用');
        try{
          const stamp=fileStamp(await media.handle.stat({bigint:true}));
          const bytes=await previewPoster(media.file,stamp);
          const current=await currentPreviewTask();
          if(!current||current.taskId!==task.taskId||current.sequence!==task.sequence||current.updatedAt!==task.updatedAt
            ||fileStamp(await media.handle.stat({bigint:true}))!==stamp)throw Error('预览已变化，请刷新');
          await boundPreviewProject();
          res.setHeader('Content-Type','image/jpeg');
          res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
          res.end(bytes);return;
        }finally{await media.handle.close();}
      }
      if(view==='panel_attachment'){
        const output=(await deliveryOutputs()).find(o=>o.assetId===query.get('assetId'));
        if(!output)throw Error('随片资料不存在');
        if(task?.blueprintApproval)await publishedProductionParent(task,{playbackOnly:true});
        res.setHeader('Content-Type','application/pdf');
        res.setHeader('Content-Disposition',attachmentDisposition(output.fileName));
        res.setHeader('X-Content-Type-Options','nosniff');
        res.setHeader('Cache-Control','no-store');res.end(output.bytes);return;
      }
      if(view==='panel_material'){
        const delivery=task?.input.panelDelivery;
        const role=delivery?.audience;
        if(!task||!delivery||!role||query.get('renderId')!==task.completed.export?.artifact.renderId
          ||!preview&&!pendingPreview)throw Error('随片资料暂不可用');
        const id=role==='new_contact'?delivery.ctaAssetId:delivery.productAssetId;
        const hash=role==='new_contact'?delivery.ctaAssetHash:delivery.productAssetHash;
        const saved=await boundPreviewProject();
        const asset=saved.doc.assets.find(item=>item.id===id&&item.kind==='image'&&item.sourceContentHash===hash);
        if(!asset||query.get('assetId')!==id)throw Error('随片资料暂不可用');
        const {file,handle,unchanged}=await openPanelMaterial(asset);
        try{
          const current=await currentPreviewTask();
          if(!current||current.taskId!==task.taskId||current.sequence!==task.sequence
            ||current.updatedAt!==task.updatedAt||!await unchanged())throw Error('预览已变化，请刷新');
          await boundPreviewProject();
          const extension=file.match(/\.(?:png|jpe?g|webp)$/i)?.[0]??'.png';
          res.setHeader('Content-Disposition',attachmentDisposition((role==='new_contact'?'合作海报':'商品图')+extension));
          await serveDiskFile(req,res,file,handle);
        }finally{await handle.close();}
        return;
      }
      if (view === 'panel_board') {
        if (!task || active(task.taskId,projectId)||!['awaiting_blueprint','blocked'].includes(task.status)
          ||!['blueprint','copy_review'].includes(task.stage)) throw new Error('审片板尚未就绪');
        const revision = query.get('revision');
        const saved=await snapshot();
        if (!revision || saved.revision !== revision) throw new Error('蓝图版本已变化，请刷新');
        if(!draftChecked(task,revision,policy))throw Error('蓝图尚未完成教学自检');
        // A shared-body task owns the current teaching plan; its sibling owns only
        // the other ending. Join read-only presentation, never execution documents.
        const subject=await boardSubject(revision);
        const {identity,artifactIdentity,siblingEntry,sibling,siblingRevision,narrationDecisions}=subject;
        if(siblingEntry&&!sibling)throw Error('新建联片尾工程缺失');
        if(query.has('boardIdentity')&&query.get('boardIdentity')!==identity)throw Error('审片板已变化，请刷新');
        if(query.has('boardPresentation')&&query.get('boardPresentation')!==boardPresentation(saved.doc))
          throw Error('审片板已变化，请刷新');
        const assertBoardCurrent=async()=>{
          const currentTask=manifestTask?await productionTaskStore.load(projectId,task.taskId):await currentPanelTask(projectId);
          const currentPolicy=await readRequirements();
          if((await snapshot()).revision!==revision||!currentTask||currentTask.taskId!==task.taskId||active(currentTask.taskId,projectId)
            ||!['awaiting_blueprint','blocked'].includes(currentTask.status)||!['blueprint','copy_review'].includes(currentTask.stage)
            ||!draftChecked(currentTask,revision,currentPolicy)
            ||(await boardSubject(revision,currentTask,currentPolicy)).identity!==identity)throw Error('审片板已变化，请刷新');
        };
        if(query.has('excerpt')){
          if(query.get('excerpt')!=='1'||query.get('boardIdentity')!==identity||!isPanelBlueprintDraft(task))
            throw Error('当前蓝图不能播放代表预览');
          const excerpt=representativeTeachingExcerpt(saved.doc);
          if(!excerpt)throw Error('当前蓝图没有可播放的回看选段');
          await assertBoardCurrent();
          const cacheKey=JSON.stringify([projectId,identity]);
          let bytes=cachedExcerpts.get(cacheKey);
          if(!bytes){
            let pending=pendingExcerpts.get(cacheKey);
            if(!pending){
              pending=excerptTail.then(async()=>{
                await assertBoardCurrent();
                const rendered=await renderExcerpt(excerpt,AbortSignal.timeout(45_000));
                if(!rendered.length||rendered.length>TEACHING_EXCERPT_MAX_BYTES)throw Error('代表预览文件无效');
                await verifyTeachingExcerptAsset(excerpt.asset);
                await assertBoardCurrent();
                cachedExcerpts.set(cacheKey,rendered);
                if(cachedExcerpts.size>2)cachedExcerpts.delete(cachedExcerpts.keys().next().value!);
                return rendered;
              });
              pendingExcerpts.set(cacheKey,pending);
              const clear=()=>{pendingExcerpts.delete(cacheKey);};
              excerptTail=pending.then(clear,clear);
            }
            bytes=await pending;
          }
          await verifyTeachingExcerptAsset(excerpt.asset);
          await assertBoardCurrent();
          res.setHeader('Content-Type','video/mp4');
          res.setHeader('Content-Length',bytes.length);
          res.setHeader('X-Content-Type-Options','nosniff');
          res.setHeader('X-ClipMentor-Board-Identity',identity);
          res.setHeader('Cache-Control','no-store');
          res.end(bytes);return;
        }
        let board = boards.get(projectId);
        if (board?.identity !== identity) {
          const reusable=board?.artifactIdentity===artifactIdentity?board:undefined;
          const file = reusable?.file??(async () => {
            const input = await loadReviewBoardInput(projectId);
            if(sibling){
              const primary=input.value as import('../../src/editor/types').ProjectDoc;
              input.value=combinePanelBlueprintEndings(primary,sibling.doc);
              input.sha256=digestValue(input.value);
              const checkPrimary=input.assertUnchanged;
              input.assertUnchanged=async()=>{
                await checkPrimary();
                const current=await loadOfflineStoredProject(siblingEntry!.projectId);
                if(current?.revision!==siblingRevision)throw Error('片尾方案已变化，请刷新蓝图');
              };
            }
            if(task.input.panelDelivery){
              const doc=input.value as import('../../src/editor/types').ProjectDoc;
              const scope=task.input.panelDelivery;
              input.deliveryFindings=panelDeliveryFindings(doc,sibling?{...scope,audience:undefined}:scope,await currentCreatorDocument(doc));
            }
            const cached=boards.get(projectId);
            if(cached?.identity===identity)cached.assertUnchanged=input.assertUnchanged;
            // Raw requirements and cross-project reference frames remain internal.
            // Human product review shows this project's storyboard and actual preview.
            if ((await snapshot()).revision !== revision) throw new Error('蓝图版本已变化，请刷新');
            input.embedded=true;
            input.narrationDecisions=narrationDecisions;
            if(isPanelBlueprintDraft(task))input.teachingExcerptUnit=representativeTeachingExcerpt(saved.doc)?.unitId;
            const result = await renderReviewBoards(input, join(reviewBoardArtifactRoot(projectId), boardPresentationVersion, artifactIdentity), undefined, 'human');
            if ((await snapshot()).revision !== revision || (await boardSubject(revision,task,await readRequirements())).identity!==identity || !result.artifacts[0]) throw new Error('审片板生成后蓝图已变化');
            return result.artifacts[0].path;
          })();
          board = { identity, artifactIdentity, revision, criteriaDigest:criteria?.digest,requirementsDigest,siblingRevision,
            assertUnchanged:reusable?.assertUnchanged,file };
          boards.set(projectId,board);
          void file.catch(() => { if (boards.get(projectId)?.file === file) boards.delete(projectId); });
        }
        const bytes = await readFile(await board.file);
        await board.assertUnchanged?.();
        await assertBoardCurrent();
        res.setHeader('X-ClipMentor-Board-Identity',identity);
        res.setHeader('Content-Type','text/html; charset=utf-8');
        res.setHeader('Content-Security-Policy',"default-src 'none'; img-src data:; media-src blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'");
        res.setHeader('Cache-Control','no-store');
        res.end(bytes);return;
      }
      if(view==='panel_reference'){
        if(!task||!preview||query.get('renderId')!==task.completed.export?.artifact.renderId
          ||!criteria||criteria.digest!==task.completed.self_check?.artifact.visualCriteriaDigest)throw Error('此预览的参照已变化');
        await verifyPreview();
        const entry=criteria.entries.find(e=>e.criterion.id===query.get('criterion'));
        if(!entry)throw Error('参照不存在');
        const [frame]=await visualReferenceFrames({...criteria,entries:[entry]},copyReviewDependencies());
        res.setHeader('Content-Type','image/jpeg');res.setHeader('Cache-Control','no-store');
        res.end(Buffer.from(frame.base64,'base64'));return;
      }
      if (view === 'panel_video' || view === 'panel_download' || view === 'panel_draft_download') {
        if (view === 'panel_download' && task?.status !== 'completed') throw new Error('请先完成终审');
        if(view!=='panel_download'&&task&&pendingPreview){
          if(query.get('renderId')!==pendingPreview.renderId)throw Error('这个预览已过期或文件缺失');
          await boundPreviewProject();
          const {file,handle}=await openPendingProductionPreview(pendingPreview);
          try{
            await boundPreviewProject();
            const current=await assertCurrentPendingPreview(view==='panel_video');
            if(view==='panel_draft_download'){
              if(previewHasBoundContentIssue(current)||await sharedPreviewDeliveryHeld(current))throw Error('当前预览暂不可下载');
              const latest=await assertCurrentPendingPreview(false);
              if(latest.sequence!==current.sequence||latest.updatedAt!==current.updatedAt)throw Error('预览已变化，请刷新');
              res.setHeader('Content-Disposition',attachmentDisposition('未复核_'+deliveryFileName(task.input.product.name,
                task.input.panelDelivery?.audience,'video',task.completed.export!.at)));
            }
            await serveDiskFile(req,res,file,handle);
          }finally{await handle.close();}
          return;
        }
        if(view==='panel_draft_download')throw Error('当前预览暂不可下载');
        const file = preview;
        if (!file || query.get('renderId') !== task?.completed.export?.artifact.renderId) throw new Error('这个预览已过期或文件缺失');
        if(task.input.panelDelivery){
          const saved=await boundPreviewProject();
          if(view==='panel_download')await productionAttachmentSlots(saved.doc,undefined,task.completed.export!.at,task.input.panelDelivery);
        }
        const handle=task.input.panelDelivery?await openVerifiedPreview(task,file):undefined;
        try{
          if (view === 'panel_download'){
            const current=await currentPreviewTask();
            if(!current||current.taskId!==task.taskId||current.status!=='completed'
              ||!current.completed.export||!current.completed.self_check
              ||digestValue(current.completed.export)!==digestValue(task.completed.export)
              ||digestValue(current.completed.self_check)!==digestValue(task.completed.self_check))throw Error('预览已变化，请刷新');
            if(current.blueprintApproval)await publishedProductionParent(current);
            if(await sharedPreviewDeliveryHeld(current))throw Error('preview_shared_body_requires_reconciliation');
            if(task.input.panelDelivery)await boundPreviewProject();
            res.setHeader('Content-Disposition',attachmentDisposition(deliveryFileName(task.input.product.name,task.input.panelDelivery?.audience,'video',task.completed.export!.at)));
          }
          await serveDiskFile(req,res,file,handle);
        }
        finally{await handle?.close();}
        return;
      }
      const config = task ? null : await settings();
      const running = !!task && active(task.taskId,projectId);
      const queued=!!task&&!running&&deferred(task.taskId);
      const waiting=!!task?.sharedProduction&&!task.sharedProduction.prepared&&task.status==='queued';
      const stopped = task && !running && !waiting && !queued && ['blocked','running','queued'].includes(task.status);
      const draft=task&&!running&&['blocked','awaiting_blueprint'].includes(task.status)&&['blueprint','copy_review'].includes(task.stage)
        ?await loadOfflineStoredProject(projectId):null;
      const draftRevision=draft?.doc.clipMentorAnalysis?.blueprint.length?draft.revision:undefined;
      const uncheckedDraft=!!task&&!!draftRevision&&!draftChecked(task,draftRevision,policy);
      const blueprintRevision=uncheckedDraft?undefined:draftRevision;
      const checked=task?.completed.copy_review?.artifact;
      const teachingBrief=blueprintRevision?productionTeachingBrief(task,policy,draft?.doc):undefined;
      const teachingDigest=teachingBrief?await handoffDigest(teachingBrief):undefined;
      const needsHuman=!!blueprintRevision&&!!task&&panelAuthorNeedsHumanReview(task,blueprintRevision,panelBlueprintRequirementsDigest(policy));
      const previewReviewAvailable=!blueprintRevision||!!previewReviewCredential();
      const dualBlueprint=!!task?.input.panelDelivery&&!task.input.panelDelivery.audience;
      const subject=blueprintRevision?await boardSubject(blueprintRevision):undefined;
      const groups=draft?blueprintReviewGroups(draft.doc):[];
      let endings:ReturnType<typeof blueprintReviewEndings>=[];
      let reviewIssue=task?.status==='blocked'?panelReviewIssue(task.error):undefined;
      if(dualBlueprint&&draft&&blueprintRevision){
        try{endings=blueprintReviewEndings(draft.doc);}catch{
          reviewIssue={kind:'binding',message:reviewMessages.endingMissing};
        }
        if(endings.length!==2)reviewIssue??={kind:'binding',message:reviewMessages.endingMissing};
      }
      const canApproveBlueprint=!!blueprintRevision&&!needsHuman&&previewReviewAvailable
        &&task?.status==='awaiting_blueprint'&&task.stage==='copy_review'&&blueprintRevision===task.projectRevision
        &&checked?.revision===blueprintRevision&&checked.authorSelfCheck==='passed'
        &&(checked.gate as {allowed?:boolean}|undefined)?.allowed===true
        &&(!policy||checked.requirementsDigest===requirementsDigest)
        &&(!teachingDigest||draft?.doc.clipMentorAnalysis?.production_copy_review?.teaching_brief_digest===teachingDigest)
        &&(!criteria||visualCriteriaPlanApproved(criteria,draft?.doc.clipMentorAnalysis?.production_copy_review));
      const canConfirmBlueprint=!!blueprintRevision&&endings.length===2&&previewReviewAvailable&&task?.status==='awaiting_blueprint'&&task.stage==='copy_review'
        &&blueprintRevision===task.projectRevision&&!!task.input.panelDelivery&&!task.input.panelDelivery.audience
        &&!task.blueprintApproval&&!task.repairContext?.pending_blueprint_feedback&&!running
        &&panelBlueprintProductionAvailable(task,blueprintRevision,panelBlueprintRequirementsDigest(policy))
        &&!needsHuman&&!needsSourceRequirementsMaintenance(task);
      const atLimit=!!task&&(
        /^(?:Error: )?(?:Production deadline exceeded|(?:model|review|observation|tts|render|preview_review) budget exhausted)$/.test(task.error??'')
        ||task.error?.startsWith('Error: 已用完自动返修额度')
          &&(isPanelBlueprintDraft(task)||task.stage==='copy_review'&&task.attempts.review>=task.input.budget.review)
        ||Date.now()>=productionWorkDeadline(task)
        ||uncheckedDraft&&task.attempts.model>=task.input.budget.model);
      const stopReason=stopped||uncheckedDraft
        ? /^(?:Error: )?(?:Original video asset missing|Original upload unavailable|Original source changed)$/.test(task?.error??'')?'materials'
          :atLimit?'limit':'maintenance'
        :undefined;
      const blueprintMessage=!blueprintRevision||canConfirmBlueprint||!dualBlueprint&&canApproveBlueprint?undefined
        :task?.repairContext?.pending_blueprint_feedback?(running||queued?blueprintNotices.saved:blueprintNotices.paused)
        :atLimit||dualBlueprint&&!canConfirmBlueprint&&!!task&&task.attempts.model>=task.input.budget.model?blueprintNotices.checkStopped
        :!previewReviewAvailable?blueprintNotices.service
        :needsHuman?undefined
        :stopReason||task&&needsSourceRequirementsMaintenance(task)?blueprintNotices.checkStopped
        :blueprintNotices.checking;
      let attachments:Array<{assetId:string;fileName:string}>=[],deliveryUnavailable=false;
      let playablePreview=preview;
      let verifiedProject:Awaited<ReturnType<typeof verifyPreview>>;
      const needPreview=!!task?.input.panelDelivery&&['awaiting_review','completed'].includes(task.status);
      if(needPreview)try{verifiedProject=await verifyPreview();}catch{playablePreview=null;}
      let pendingPreviewRenderId:string|undefined;
      let pendingProject:Awaited<ReturnType<typeof boundPreviewProject>>|undefined;
      if(pendingPreview)try{
        await boundPreviewProject();
        const {handle}=await openPendingProductionPreview(pendingPreview);
        await handle.close();
        const saved=await boundPreviewProject();
        await assertCurrentPendingPreview();
        pendingProject=saved;
        pendingPreviewRenderId=pendingPreview.renderId;
        if(reviewIssue?.kind==='binding')reviewIssue=undefined;
      }catch{/* Missing or stale media stays outside the playable preview. */}
      let previewProject=verifiedProject;
      if(task&&playablePreview){
        try{
          const saved=previewProject??await snapshot();
          if((!verifiedProject||!task.completed.self_check?.artifact.receipt)
            &&(saved.revision!==task.projectRevision||saved.revision!==task.completed.export?.artifact.revision))
            throw Error('Preview changed');
          previewProject=saved;
          attachments=(await productionAttachmentSlots(saved.doc,undefined,task.completed.export!.at,task.input.panelDelivery)).map(({assetId,fileName})=>({assetId,fileName}));
        }catch{deliveryUnavailable=true;}
      }
      const outputUnavailable=needPreview&&(!playablePreview||task?.status==='completed'&&deliveryUnavailable);
      let sharedDeliveryHeld=false;
      let previewFeedbackUnavailable=false;
      if((pendingPreviewRenderId||needPreview&&playablePreview&&!outputUnavailable)&&task)try{
        if(task.blueprintApproval)await publishedProductionParent(task);
        sharedDeliveryHeld=await sharedPreviewDeliveryHeld(task);
      }catch(error){
        // The export is bound and playable. An unreadable sibling gives no
        // assurance that the shared body is cleared for either download.
        console.error('ClipMentor shared preview delivery status unavailable',error);
        deliveryUnavailable=true;
        previewFeedbackUnavailable=true;
        reviewIssue={kind:'binding',message:reviewMessages.deliveryCheckUnavailable};
      }
      if(sharedDeliveryHeld)reviewIssue=panelReviewIssue('preview_shared_body_requires_reconciliation');
      const canAcceptPreview=task?.status==='awaiting_review'&&!!playablePreview&&!deliveryUnavailable&&!sharedDeliveryHeld
        &&(!task.input.panelDelivery||!!task.completed.self_check?.artifact.receipt);
      const currentPreviewProject=pendingProject??(!outputUnavailable&&playablePreview?previewProject:undefined);
      const exportedDuration=task?.completed.export?.artifact.durationSeconds;
      const previewDuration=typeof exportedDuration==='number'&&Number.isFinite(exportedDuration)&&exportedDuration>0?exportedDuration:undefined;
      let previewChapters:ReturnType<typeof productionPreviewChapters>=[];
      // Navigation is optional. A maintenance problem in older placement
      // data need not hide otherwise verified playable media.
      if(currentPreviewProject&&matchesExportedPreviewProject(task?.completed.export?.artifact,currentPreviewProject)){
        try{previewChapters=productionPreviewChapters(currentPreviewProject.doc,previewDuration);}catch{}
      }
      if(needPreview&&task?.status==='awaiting_review'&&!canAcceptPreview)
        reviewIssue??={kind:'binding',message:reviewMessages.previewUnavailable};
      const delivery=task?.input.panelDelivery;
      const audience=delivery?.audience;
      const materialId=audience==='new_contact'?delivery?.ctaAssetId:audience==='existing_partner'?delivery?.productAssetId:undefined;
      const materialHash=audience==='new_contact'?delivery?.ctaAssetHash:audience==='existing_partner'?delivery?.productAssetHash:undefined;
      const attachment=currentPreviewProject?.doc.assets.find(asset=>asset.kind==='image'&&asset.id===materialId&&asset.sourceContentHash===materialHash);
      const material=attachment&&await openPanelMaterial(attachment).catch(()=>undefined);
      if(material)await material.handle.close();
      send({ task:task ? {
        taskId:task.taskId,...(task.blueprintApproval?{sourceTaskId:task.blueprintApproval.sourceTaskId}:{}),
        status: outputUnavailable||!running&&!queued&&uncheckedDraft?'blocked':queued?'queued':waiting?'waiting':running && task.status === 'blocked' ? 'running' : stopped ? 'blocked' : task.status,
        stage: task.stage, revision: task.projectRevision, sequence: task.sequence,
        active: running,stopReason:outputUnavailable?'service':stopReason,feedbackUsed: task.feedbackUsed,
        ...(!running&&task.status==='blocked'&&(canResumeUndispatchedAnalysis(task)||canResumeSavedAnalysis(task)||failedInitialBreakdownWrite(task))
          ?{canContinueAnalysis:true}:{}),
        ...(!running&&canResumeFirstGlanceReview(task)?{canContinueBlueprintReview:true}:{}),
        hasBlueprintFeedback:!!task.blueprintFeedback,
        ...(task.blueprintOpinions?.differences?{blueprintOpinionDifferences:task.blueprintOpinions.differences}:{}),
        ...(task.blueprintApproval&&task.completed.copy_review?.artifact.productionDifferences
          ?{productionDifferences:task.completed.copy_review.artifact.productionDifferences}:{}),
        ...(task.blueprintApproval?{blueprintConfirmed:true}:{}),
        ...(blueprintRevision?{blueprintRevision,boardIdentity:subject?.identity,boardPresentation:draft&&boardPresentation(draft.doc),canApproveBlueprint,reviewGroups:groups,
          canConfirmBlueprint,...(blueprintMessage?{blueprintMessage}:{})}:{}),
        ...(task.input.panelDelivery?{dualBlueprint,
          ...(task.input.panelDelivery.audience?{audience:task.input.panelDelivery.audience}:{})}:{}),
        ...(reviewIssue?{reviewIssue}:{}),
        ...(previewFeedbackUnavailable?{previewFeedbackUnavailable:true}:{}),
        ...(task.status==='awaiting_review'?{canAcceptPreview}:{}),
        ...(task.finalAcceptance&&task.status==='completed'?{confirmedAt:task.finalAcceptance.confirmedAt}:{}),
        ...(currentPreviewProject?{reviewGroups:blueprintReviewGroups(currentPreviewProject.doc),previewChapters,previewDuration,
          previewReviewed:!!task.completed.self_check?.artifact.receipt&&!!verifiedProject}:{}),
        ...(task.status==='awaiting_review'&&criteria?{visualCriteria:{digest:criteria.digest}}:{}),
        ...(playablePreview&&!outputUnavailable?{downloadName:deliveryFileName(task.input.product.name,task.input.panelDelivery?.audience,'video',task.completed.export!.at),
          renderId:task.completed.export?.artifact.renderId}:{}),
        ...(pendingPreviewRenderId?{renderId:pendingPreviewRenderId,previewPending:true,canAcceptPreview:false,
          ...(previewHasBoundContentIssue(task)?{previewNeedsChanges:true}:{})}:{}),
        ...(sharedDeliveryHeld?{deliveryHeld:true}:{}),
        ...(material&&attachment?{materialAttachment:{assetId:attachment.id,label:audience==='new_contact'?'合作海报':'商品图'}}
          :materialId&&currentPreviewProject?{materialAttachmentUnavailable:true}:{}),
        ...(attachments.length?{attachments}:{}),...(deliveryUnavailable?{deliveryUnavailable:true}:{}),
      } : null,
        unavailable: (config && 'unavailable' in config) || (!task && isProjectConnected(projectId)) ? panelServiceUnavailable : undefined,
      });
      return;
    }
    if (req.method !== 'POST' || view !== 'panel') throw new Error('不支持的制作操作');
    if (controls.has(projectId)) throw new Error('该工程正在处理上一次操作');
    controls.add(projectId);
    let releaseSlot:(()=>void)|undefined;
    try {
      const body = await readBody();
      const existing = manifestTask?await productionTaskStore.load(projectId,manifestTask.taskId):await currentPanelTask(projectId);
      const saved = await snapshot();
      if (body.action === 'start') {
        if (existing) throw new Error('该工程已有制作任务，请刷新查看');
        const config = await settings(true);
        if ('unavailable' in config) throw new Error(config.unavailable);
        if (isProjectConnected(projectId)) throw new Error('请先关闭该工程的 OpenChatCut 编辑器');
        const materials = registeredAssets(saved.doc.assets);
        if (!materials || !(await Promise.all(materials.map(asset => intactAsset(asset)))).every(Boolean)) {
          res.statusCode = 409;
          send({ error:panelMaterialsUnavailable, reason:'materials' });
          return;
        }
        const [source, product, sales, cta] = materials;
        if (saved.doc.clipMentorAnalysis || saved.doc.timelines.some(t => t.items.length)) throw new Error('该工程已有制作记录');
        const api = { provider:config.provider, model:config.model, apiMode:config.apiMode, origin };
        const index = (await getStoredEntry('projects')).value;
        const entry = Array.isArray(index) ? index.find(row => row?.id === projectId) : undefined;
        const name = entry?.clipMentorTask ? undefined : entry?.name;
        if(body.doneCriteria!==undefined)throw Error('source_requirements_maintenance_only');
        const doneCriteria=await readPanelSourceCriteria(projectId,source,sales);
        const openingComparison=declaredPanelOpening(saved.doc,sourcePerformanceCriterion(doneCriteria??[]),source.id,sales.id);
        if(doneCriteria)frozenTeachingTopics(saved.doc,{input:{sourceAssetId:source.id,doneCriteria}});
        const salesFact=panelSalesEvidence(source.id,sales.id,openingComparison.results);
        releaseSlot=reserveSlot(projectId);
        const next = await createProductionTask({
          projectId, sourceAssetId:source.id, product:{name:typeof name === 'string' && name.trim() ? name.trim() : '当前商品',category:'待核实'},
          openingComparison,...(doneCriteria?{doneCriteria}:{}),
          brief:'以工程完整原片和商品资料制作马来西亚达人拆解蓝图。教学主体说明原作者怎样让购买理由可见，让达人能借鉴拍法。共用片头和教学主体，分别登记新建联与已合作的行动结尾。片头保留用户原话“'+openingComparison.quote+'”的同款成绩提问意图。按本片上传成绩图填写，不写只有本片做到或断言其他视频差，不承诺拍法解释成交原因。用本片原片压暗作底、成绩图作前景。新建联用上传CTA原图，已合作用本商品的原片Storyboard。先交人审版。',
          panelDelivery:{productAssetId:product.id,productAssetHash:product.sourceContentHash!,salesAssetId:sales.id,salesAssetHash:sales.sourceContentHash!,ctaAssetId:cta.id,ctaAssetHash:cta.sourceContentHash!,bookends:'layered-v1',partnerEnding:'product_storyboard_pdf',editorialPolicy:'exemplar-v1',selectionPolicy:'v1',firstGlanceWriting:true,
            salesEvidenceId:salesFact.evidence_id,salesEvidenceSha256:createHash('sha256').update(salesFact.text).digest('hex')},
          author:api, reviewer:api, ...(config.backend==='codex'?{authorBackend:'codex' as const,reviewerBackend:'codex' as const}:{}),
          voice:{provider:'minimax',voiceId:'Malay_female_1_v1'},
          budget:panelProductionBudget(),humanBlueprintReview:true,sourceClosingRegistration:true,
        });
        launch(next);
      } else {
        if (!existing || active(existing.taskId,projectId)) throw new Error('制作任务尚未到达可操作阶段');
        await publishedProductionParent(existing);
        if (body.action === 'continue_blueprint_review') {
          if(body.taskId!==existing.taskId||body.sequence!==existing.sequence){
            res.statusCode=409;
            send({reason:'review_board_changed'});return;
          }
          if(!canResumeFirstGlanceReview(existing)||saved.revision!==existing.projectRevision)
            throw new Error('当前蓝图检查无法接续');
          releaseSlot=reserveSlot(projectId);
          if(isProjectConnected(projectId))throw new Error('请先关闭该工程的 OpenChatCut 编辑器');
          const next=structuredClone(existing);
          if(!await resumeFirstGlanceReview(next))throw new Error('蓝图检查回执无法核实');
          if(Date.now()>=productionWorkDeadline(existing))throw new Error('当前蓝图检查无法接续');
          next.input.author.origin=origin;next.input.reviewer.origin=origin;
          next.status='queued';
          delete next.error;
          await saveProductionControl(existing,next,productionTaskStore,undefined,saved.doc,existing.sequence);
          launch(next);
        } else if (body.action === 'continue_analysis') {
          const reuseAnalysis=canResumeSavedAnalysis(existing);
          const restartUnpublished=failedInitialBreakdownWrite(existing);
          if (!canResumeUndispatchedAnalysis(existing)&&!reuseAnalysis&&!restartUnpublished) throw new Error('这次暂停不能从分析入口继续');
          releaseSlot=reserveSlot(existing.blueprintApproval?.sourceProjectId??projectId);
          if (isProjectConnected(projectId)) throw new Error('请先关闭该工程的 OpenChatCut 编辑器');
          if (restartUnpublished) {
            const materials = registeredAssets(saved.doc.assets);
            const delivery = existing.input.panelDelivery!;
            if (saved.doc.clipMentorAnalysis || !materials || materials[0].id !== existing.input.sourceAssetId
              || materials[1].id !== delivery.productAssetId || materials[1].sourceContentHash !== delivery.productAssetHash
              || materials[2].id !== delivery.salesAssetId || materials[2].sourceContentHash !== delivery.salesAssetHash
              || materials[3].id !== delivery.ctaAssetId || materials[3].sourceContentHash !== delivery.ctaAssetHash
              || !(await Promise.all(materials.map(asset => intactAsset(asset)))).every(Boolean))
              throw Error('已上传的原素材已变化，不能接续分析');
            await readPanelSourceCriteria(projectId,materials[0],materials[2]);
            existing.projectRevision=saved.revision;
            recordTechnicalRecovery(existing);
          }
          if ((!restartUnpublished && saved.doc.clipMentorAnalysis?.source.asset_id!==existing.input.sourceAssetId)
            || saved.doc.timelines.some(timeline=>timeline.items.length)) throw new Error('工程已有新改动，请先核对');
          const config=await settings(true);
          if ('unavailable' in config) throw new Error(config.unavailable);
          if (config.backend!=='codex' || config.model!==existing.input.author.model) throw new Error('原任务的 Codex 模型配置已变化');
          if(reuseAnalysis){
            const analysis=saved.doc.clipMentorAnalysis;
            if(!analysis?.source_breakdown||!analysis.evidence.length)throw new Error('已保存的分析记录缺失');
            existing.projectRevision=saved.revision;
            recordTechnicalRecovery(existing);
          }
          launch(existing);
        } else if (['approve_blueprint','revise_blueprint','produce_versions'].includes(String(body.action))) {
          const approving=body.action==='approve_blueprint'||body.action==='produce_versions';
          const dual=!!existing.input.panelDelivery&&!existing.input.panelDelivery.audience;
          if(body.action==='approve_blueprint'&&dual)
            throw new PanelReviewIssue('binding',reviewMessages.refreshBoard);
          if (body.action === 'revise_blueprint' && typeof body.text !== 'string' && body.blueprintOpinions===undefined) throw new Error('请填写修改意见');
          if (approving && !previewReviewCredential()) throw Error(missingPreviewReviewCredential);
          const draftFeedback=body.action==='revise_blueprint'&&acceptsDraftBlueprintFeedback(existing,saved.revision)
            &&!!saved.doc.clipMentorAnalysis?.blueprint.length;
          const productionConfirmation=body.action==='produce_versions'&&dual
            &&!existing.blueprintApproval&&existing.status==='awaiting_blueprint'&&existing.stage==='copy_review'
            &&saved.revision===existing.projectRevision;
          if(body.action==='produce_versions'&&!productionConfirmation)throw Error('当前版本尚不能开始制作');
          if ((!draftFeedback&&!productionConfirmation&&(existing.status !== 'awaiting_blueprint'||body.revision !== existing.projectRevision)) || body.revision !== saved.revision) throw new Error('蓝图版本已变化，请重新打开审片板');
          const actionPolicy=await readRequirements();
          if(approving&&panelAuthorNeedsHumanReview(existing,saved.revision,panelBlueprintRequirementsDigest(actionPolicy)))
            throw new PanelReviewIssue('content',reviewMessages.commission);
          if(!draftChecked(existing,saved.revision,actionPolicy)||productionConfirmation&&existing.repairContext?.pending_blueprint_feedback)
            throw Error('蓝图尚未完成教学自检');
          const subject=await boardSubject(saved.revision,existing,actionPolicy);
          const presentation=boardPresentation(saved.doc);
          if(body.boardIdentity!==subject.identity||presentation&&body.boardPresentation!==presentation){
            res.statusCode=409;send({reason:'review_board_changed'});return;
          }
          const board = boards.get(projectId);
          if (!board || board.identity!==subject.identity || board.revision !== body.revision || board.criteriaDigest!==criteria?.digest||board.requirementsDigest!==requirementsDigest) {
            res.statusCode = 409;
            send({ reason:'review_board_reload' });
            return;
          }
          await board.file;
          await board.assertUnchanged?.();
          const latest=await snapshot();
          const latestPolicy=await readRequirements(),latestCriteria=boundVisualCriteria(latestPolicy);
          const latestRequirements=latestPolicy?digestValue(latestPolicy.brief.doneCriteria):undefined;
          if(latest.revision!==body.revision||!draftChecked(existing,latest.revision,latestPolicy)||(await boardSubject(latest.revision,existing,latestPolicy)).identity!==body.boardIdentity||latestCriteria?.digest!==board.criteriaDigest||latestRequirements!==board.requirementsDigest)
            throw new Error('蓝图版本已变化，请重新打开审片板');
          if(productionConfirmation&&!panelBlueprintProductionAvailable(existing,latest.revision,panelBlueprintRequirementsDigest(latestPolicy)))
            throw Error('当前版本尚不能开始制作');
          const projectKey='project:'+projectId,policyKey=handoffKey(projectId);
          const projectEntry=await getStoredEntry(projectKey),policyEntry=await getStoredEntry(policyKey);
          const guardedDoc=projectEntry.found?runProjectMigrations(projectEntry.value)?.doc:null;
          if(!guardedDoc||revisionOf(guardedDoc)!==latest.revision
            ||(policyEntry.found&&digestValue(policyEntry.value)!==digestValue(latestPolicy))
            ||(await readRequirements())?.digest!==latestPolicy?.digest)
            throw Error('蓝图版本已变化，请重新打开审片板');
          const guards=[{key:projectKey,digest:digestValue(projectEntry.value)},{key:policyKey,digest:policyEntry.found?digestValue(policyEntry.value):null}];
          const reviewDoc=subject.sibling?combinePanelBlueprintEndings(latest.doc,subject.sibling.doc):latest.doc;
          const reviewGroups=blueprintReviewGroups(reviewDoc);
          const reviewEndings=dual&&approving?blueprintReviewEndings(reviewDoc):[];
          if(approving&&dual&&reviewEndings.length!==2)
            throw new PanelReviewIssue('binding',reviewMessages.endingMissing);
          const review=approving?bindBlueprintReview(body.blueprintReview,{
            revision:latest.revision,boardIdentity:subject.identity,groups:reviewGroups,endings:reviewEndings,
          }):undefined;
          if(productionConfirmation){
            releaseSlot=reserveSlot(projectId);
            productionOpeningComparison(existing,latestPolicy,latest.doc);
            const children=await createBlueprintContinuations(existing,latest,latestPolicy,origin,guards,review);
            launchQueuedOutputs(children,origin);
            send({accepted:true});return;
          }
          let feedback:string|undefined;
          let unitIds:string[]|undefined;
          let opinions:BlueprintOpinionRecord|undefined;
          if(body.action==='revise_blueprint'&&body.blueprintOpinions!==undefined){
            let prepared:ReturnType<typeof prepareBlueprintOpinions>;
            // The board may append a read-only sibling ending for display. Bind repairs to the editable document.
            try{prepared=prepareBlueprintOpinions(latest.doc,body.blueprintOpinions,latest.revision,subject.identity);}
            catch(error){
              const message=error instanceof Error?error.message:'';
              if(message==='blueprint_opinion_total_too_long')throw new PanelReviewIssue('content',reviewMessages.feedbackLength);
              if(message==='意见提到的组号不在当前蓝图。')throw new PanelReviewIssue('content',reviewMessages.invalidGroup);
              if(opinionClarificationText.test(message))throw new PanelReviewIssue('content',message);
              throw new PanelReviewIssue('content',reviewMessages.checkBoard);
            }
            if(!prepared.record){send({opinionPlacements:prepared.placements});return;}
            if(prepared.confirmation&&body.opinionConfirmation!==prepared.confirmation.token){
              send({opinionConfirmation:prepared.confirmation});return;
            }
            opinions=prepared.record;
            opinions.confirmed=!!prepared.confirmation;
            const changes=opinions.opinions.filter(entry=>entry.edits);
            if(!changes.length){
              await saveProductionControl(existing,{...structuredClone(existing),blueprintOpinionNotes:opinions},productionTaskStore,guards,undefined,existing.sequence);
              send({accepted:true,notesSaved:true});return;
            }
            feedback=changes.length===1&&changes[0].unitId===null?changes[0].text:changes.map(entry=>{
              const label=entry.unitId===null?'整体意见':reviewGroups.find(group=>group.id===entry.unitId)?.label??'本组意见';
              return `［${label}］${entry.text}`;
            }).join('\n');
            unitIds=changes.some(entry=>entry.unitId===null)?undefined:changes.flatMap(entry=>entry.unitId?[entry.unitId]:[]);
          }else if(body.action==='revise_blueprint'&&typeof body.text==='string'){
            feedback=body.text;
            unitIds=panelFeedbackTarget(body.feedbackTarget,reviewGroups,false).unitIds;
          }
          releaseSlot=reserveSlot(existing.blueprintApproval?.sourceProjectId??projectId);
          if(draftFeedback){
            if(latest.doc.clipMentorAnalysis?.source.asset_id!==existing.input.sourceAssetId)
              throw Error('蓝图对应的原片已变化，请重新打开审片板');
            const result=await queueDraftBlueprintFeedback(existing,latest.revision,feedback,productionTaskStore,guards,unitIds,opinions);
            if(result==='queued')launch(existing);
            send({accepted:true,saved:true,dispatched:result==='queued'||result==='already_dispatched',...(result==='limit'?{reason:'limit'}:{})});
            return;
          }
          if(body.action==='approve_blueprint'){
            assertVisualCriteriaPlan(latestCriteria,deliverySectionsFromDoc(latest.doc),latest.doc.clipMentorAnalysis?.source_breakdown?.units.map(u=>u.unit_id),latest.doc.activeTimelineId);
            const teachingBrief=productionTeachingBrief(existing,latestPolicy,latest.doc);
            const gate=await checkCopyProduction(latest.doc,'clipmentor',undefined,productionOpeningComparison(existing,latestPolicy,latest.doc),
              existing.input.panelDelivery?.editorialPolicy==='exemplar-v1',teachingBrief?await handoffDigest(teachingBrief):undefined);
            if(!gate.allowed||latestPolicy&&existing.completed.copy_review?.artifact.requirementsDigest!==latestRequirements
              ||latestCriteria&&!visualCriteriaPlanApproved(latestCriteria,latest.doc.clipMentorAnalysis?.production_copy_review))
              throw new Error('当前蓝图待独立审核，暂不能进入制作。');
          }
          if(body.action==='approve_blueprint'&&existing.input.panelDelivery){
            const content=await currentCreatorDocument(latest.doc);
            const issues=panelDeliveryIssues(latest.doc,{...existing.input.panelDelivery,bookends:'layered-v1'},content);
            assertPanelDeliveryReady(issues,issues.length?undefined:await panelPartnerCardIssue(latest.doc,existing.input.panelDelivery,content));
          }
          await resolveHumanBlueprint(existing,body.revision,saved.revision,feedback,productionTaskStore,guards,unitIds,review,opinions);
          launch(existing);
        } else if (body.action === 'revise_preview' || body.action === 'accept') {
          if (existing.status !== 'awaiting_review' || body.renderId !== existing.completed.export?.artifact.renderId) throw new Error('预览已变化，请重新核对');
          if (body.action === 'accept') {
            if(body.previewWatched!==true||body.languageConfirmed!==true)
              throw new PanelReviewIssue('content',reviewMessages.finalChecks);
            await acceptProductionTask(existing,true,productionTaskStore,
              {digest:body.visualCriteriaDigest,renderId:body.renderId,wholePreviewConfirmed:body.previewWatched,watched:body.previewWatched});
          }
          else {
            if(existing.feedbackUsed)throw new PanelReviewIssue('content',reviewMessages.feedbackUsed);
            if (!previewReviewCredential()) throw Error(missingPreviewReviewCredential);
            const target=panelFeedbackTarget(body.feedbackTarget,blueprintReviewGroups(saved.doc),true);
            const anchor=await productionFeedbackAnchor(existing,saved.doc);
            releaseSlot=reserveSlot(existing.blueprintApproval?.sourceProjectId??projectId);
            await productionFeedback(existing,{kind:target.kind,text:body.text,preview:anchor.preview,unit_ids:target.unitIds??[],item_ids:[],
              ...(target.range?{output_range_seconds:target.range}:{})},productionTaskStore,saved.doc);
            launch(existing);
          }
        } else throw new Error('不支持的制作操作');
      }
      send({ accepted:true });
    } catch(error){
      if(isProductionCapacityFull(error)){
        res.statusCode=409;send({reason:'capacity',error:error.message});return;
      }
      const issue=panelReviewIssue(error);
      if(!issue)throw error;
      if(!(error instanceof PanelReviewIssue))console.error('ClipMentor panel action failed',projectId,error);
      res.statusCode=409;
      send({error:issue.message,issue});
    } finally {
      releaseSlot?.();
      controls.delete(projectId);
    }
  };
  return handler;
}
