import {panelProductionBudget} from './production-budget';
import { readFile } from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {digestValue} from '../agent-runs/store-values';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { getKey } from '../keystore';
import { codexModels, codexStatus } from '../plugins/codex-agent';
import { getStoredEntry } from '../plugins/project-store';
import { isProjectConnected } from '../external-agent/broker';
import { loadOfflineStoredProject } from '../external-agent/offline-project-store';
import { isSafeUploadName, resolveUploadFile, serveDiskFile } from '../media-dir';
import { loadReviewBoardInput, renderReviewBoards } from './blueprint-review-board';
import { reviewBoardArtifactRoot } from './blueprint-review-board-artifacts';
import { productionFeedbackAnchor,blueprintFeedbackPoints } from './production-feedback';
import { panelDeliveryIssues,panelSalesEvidence } from './production-panel-delivery';
import { createBlueprintContinuations,queueBlueprintContinuations } from './production-continuation';
import { assertVisualCriteriaPlan,boundVisualCriteria,visualCriteriaPlanApproved,visualReferenceFrames } from './visual-done-criteria';
import {checkCopyProduction} from '../../src/clipmentor/production-gate';
import {deliverySectionsFromDoc} from '../../src/clipmentor/delivery-bindings';
import {productionDeliverables,productionAttachmentSlots} from './production-deliverables';
import {verifyProductionOutput} from './production-format';
import {deliveryFileName,attachmentDisposition} from './delivery-filename';
import {currentCreatorDocument} from './creator-storyboard-document';
import { copyReviewDependencies } from './copy-review';
import {
  acceptProductionTask, createProductionTask, productionFeedback, productionTaskStore, resolveHumanBlueprint, recordTechnicalRecovery,
  savePendingBlueprintFeedback,
  latestPanelProductionTask,productionReviewRequirements,
  type ProductionTask,
} from './production-task';

type PanelSettings = { unavailable: string } | { provider:'openai'; model:string; apiMode:'chat'|'responses'; backend:'api'|'codex' };

export const panelServiceUnavailable = '制作服务暂时不可用。';
export const panelMaterialsUnavailable = '所需素材不齐全或无法读取，请重新核对上传素材。';

async function readSettings(): Promise<PanelSettings> {
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
export function createProductionPanel(launch:(task:ProductionTask)=>void, active:(id:string,projectId:string)=>boolean, controls = new Set<string>()) {
  let preflight: { until:number; result:Promise<PanelSettings> } | undefined;
  const settings = (fresh=false) => {
    if (fresh || !preflight || Date.now() >= preflight.until) {
      preflight = { until:Date.now()+15_000, result:readSettings() };
    }
    return preflight.result;
  };
  const boards = new Map<string,{ identity:string; revision:string; criteriaDigest?:string; requirementsDigest?:string; siblingRevision?:string; assertUnchanged?:()=>Promise<void>; file:Promise<string> }>();
  const handler=async (projectId:string, origin:string, query:URLSearchParams, req:IncomingMessage, res:ServerResponse, readBody:()=>Promise<Record<string,unknown>>):Promise<void> => {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(projectId)) throw new Error('制作工程无效');
    const task = await currentPanelTask(projectId);
    if(task?.productionChildren?.length){
      const audience=query.get('audience');
      if(!audience&&req.method==='GET'&&query.get('view')==='panel'){
        res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
        res.end(JSON.stringify({task:null,outputs:task.productionChildren.map(child=>({audience:child.audience}))}));return;
      }
      if(!audience&&req.method==='POST'){
        const body=await readBody();
        let children=await Promise.all(task.productionChildren.map(entry=>productionTaskStore.load(entry.projectId,entry.taskId)));
        if(body.action!=='produce_versions'||children.some(child=>child.blueprintApproval?.sourceRevision!==body.revision))
          throw Error('蓝图版本已变化，请刷新');
        children=await queueBlueprintContinuations(task);
        for(const child of children)if(child.status==='queued'&&!active(child.taskId,child.projectId))launch(child);
        res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
        res.end(JSON.stringify({accepted:true}));return;
      }
      const entry=task.productionChildren.find(child=>child.audience===audience);
      if(!entry)throw Error('制作输出不存在');
      const child=await productionTaskStore.load(entry.projectId,entry.taskId);
      if(child.projectId===projectId||child.blueprintApproval?.sourceProjectId!==projectId||child.blueprintApproval.sourceTaskId!==task.taskId)
        throw Error('制作版本记录不匹配');
      return handler(child.projectId,origin,query,req,res,readBody);
    }
    if(task?.productionChild){
      const child=await productionTaskStore.load(task.productionChild.projectId,task.productionChild.taskId);
      if(child.projectId===projectId||child.blueprintApproval?.sourceProjectId!==projectId||child.blueprintApproval.sourceTaskId!==task.taskId)
        throw Error('制作版本记录不匹配');
      return handler(child.projectId,origin,query,req,res,readBody);
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
    // Legacy completed tasks do not re-enter worker export/self_check. Never
    // advertise, accept or serve their old preview solely on a saved status.
    const preview=task&&previewFile(task);
    if(req.method==='GET'&&preview&&task.input.panelDelivery)await verifyProductionOutput(preview);
    const policy=task?await productionReviewRequirements(projectId):null;
    const criteria=boundVisualCriteria(policy);
    const requirementsDigest=policy?digestValue(policy.brief.doneCriteria):undefined;
    // This identity belongs to the HTTP review surface, never to the authored blueprint.
    const boardSubject=async(revision:string,currentTask=task,currentPolicy=policy)=>{
      const parent=currentTask?.blueprintApproval?await productionTaskStore.load(currentTask.blueprintApproval.sourceProjectId,currentTask.blueprintApproval.sourceTaskId):undefined;
      const siblingEntry=currentTask?.input.panelDelivery?.audience==='existing_partner'
        ?parent?.productionChildren?.find(entry=>entry.audience==='new_contact'):undefined;
      const sibling=siblingEntry?await loadOfflineStoredProject(siblingEntry.projectId):undefined;
      const identity=digestValue({version:1,projectId,taskId:currentTask?.taskId,revision,
        criteriaDigest:boundVisualCriteria(currentPolicy)?.digest,
        requirementsDigest:currentPolicy?digestValue(currentPolicy.brief.doneCriteria):undefined,
        siblingProjectId:siblingEntry?.projectId,siblingRevision:sibling?.revision,siblingMissing:!!siblingEntry&&!sibling});
      return {identity,siblingEntry,sibling,siblingRevision:sibling?.revision};
    };
    if (req.method === 'GET') {
      const deliveryOutputs=async()=>{
        if(!task||!previewFile(task)||query.get('renderId')!==task.completed.export?.artifact.renderId)throw Error('这个预览已过期或文件缺失');
        const saved=await snapshot();
        if(saved.revision!==task.projectRevision||saved.revision!==task.completed.export?.artifact.revision)throw Error('预览已变化，请刷新');
        return productionDeliverables(saved.doc,undefined,task.completed.export!.at);
      };
      if(view==='panel_attachment'){
        const output=(await deliveryOutputs()).find(o=>o.assetId===query.get('assetId'));
        if(!output)throw Error('随片资料不存在');
        res.setHeader('Content-Type','application/pdf');
        res.setHeader('Content-Disposition',attachmentDisposition(output.fileName));
        res.setHeader('X-Content-Type-Options','nosniff');
        res.setHeader('Cache-Control','no-store');res.end(output.bytes);return;
      }
      if (view === 'panel_board') {
        if (!task || active(task.taskId,projectId)||!['awaiting_blueprint','blocked'].includes(task.status)
          ||!['blueprint','copy_review'].includes(task.stage)) throw new Error('审片板尚未就绪');
        const revision = query.get('revision');
        if (!revision || (await snapshot()).revision !== revision) throw new Error('蓝图版本已变化，请刷新');
        // A shared-body task owns the current teaching plan; its sibling owns only
        // the other ending. Join read-only presentation, never execution documents.
        const subject=await boardSubject(revision);
        const {identity,siblingEntry,sibling,siblingRevision}=subject;
        if(siblingEntry&&!sibling)throw Error('新建联片尾工程缺失');
        if(query.has('boardIdentity')&&query.get('boardIdentity')!==identity)throw Error('审片板已变化，请刷新');
        let board = boards.get(projectId);
        if (board?.identity !== identity) {
          const file = (async () => {
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
            const cached=boards.get(projectId);
            if(cached?.identity===identity)cached.assertUnchanged=input.assertUnchanged;
            // Raw requirements and cross-project reference frames remain internal.
            // Human product review shows this project's storyboard and actual preview.
            if ((await snapshot()).revision !== revision) throw new Error('蓝图版本已变化，请刷新');
            const result = await renderReviewBoards(input, join(reviewBoardArtifactRoot(projectId), 'panel', identity), undefined, 'human');
            if ((await snapshot()).revision !== revision || (await boardSubject(revision,task,await productionReviewRequirements(projectId))).identity!==identity || !result.artifacts[0]) throw new Error('审片板生成后蓝图已变化');
            return result.artifacts[0].path;
          })();
          board = { identity, revision, criteriaDigest:criteria?.digest,requirementsDigest,siblingRevision,file };
          boards.set(projectId,board);
          void file.catch(() => { if (boards.get(projectId)?.file === file) boards.delete(projectId); });
        }
        const bytes = await readFile(await board.file);
        await board.assertUnchanged?.();
        if((await boardSubject(revision,task,await productionReviewRequirements(projectId))).identity!==identity)throw Error('审片板已变化，请刷新');
        res.setHeader('X-ClipMentor-Board-Identity',identity);
        res.setHeader('Content-Type','text/html; charset=utf-8');
        res.setHeader('Content-Security-Policy',"default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'");
        res.setHeader('Cache-Control','no-store');
        res.end(bytes);return;
      }
      if(view==='panel_reference'){
        if(!task||!previewFile(task)||query.get('renderId')!==task.completed.export?.artifact.renderId
          ||!criteria||criteria.digest!==task.completed.self_check?.artifact.visualCriteriaDigest)throw Error('此预览的参照已变化');
        const entry=criteria.entries.find(e=>e.criterion.id===query.get('criterion'));
        if(!entry)throw Error('参照不存在');
        const [frame]=await visualReferenceFrames({...criteria,entries:[entry]},copyReviewDependencies());
        res.setHeader('Content-Type','image/jpeg');res.setHeader('Cache-Control','no-store');
        res.end(Buffer.from(frame.base64,'base64'));return;
      }
      if (view === 'panel_video' || view === 'panel_download') {
        const file = task && previewFile(task);
        if (!file || query.get('renderId') !== task?.completed.export?.artifact.renderId) throw new Error('这个预览已过期或文件缺失');
        if (view === 'panel_download' && task.status !== 'completed') throw new Error('请先完成终审');
        if (view === 'panel_download') res.setHeader('Content-Disposition',attachmentDisposition(deliveryFileName(task!.input.product.name,task!.input.panelDelivery?.audience,'video',task!.completed.export!.at)));
        await serveDiskFile(req,res,file);return;
      }
      const config = task ? null : await settings();
      const running = !!task && active(task.taskId,projectId);
      const waiting=!!task?.sharedProduction&&!task.sharedProduction.prepared&&task.status==='queued';
      const stopped = task && !running && !waiting && ['blocked','running','queued'].includes(task.status);
      const draft=task&&!running&&['blocked','awaiting_blueprint'].includes(task.status)&&['blueprint','copy_review'].includes(task.stage)
        ?await loadOfflineStoredProject(projectId):null;
      const draftRevision=draft?.doc.clipMentorAnalysis?.blueprint.length?draft.revision:undefined;
      const blueprintRevision=draftRevision;
      const approvalUnavailable=blueprintRevision
        ? task?.status!=='awaiting_blueprint'||blueprintRevision!==task.projectRevision
          ||policy&&task.completed.copy_review?.artifact.requirementsDigest!==requirementsDigest
          ||criteria&&!visualCriteriaPlanApproved(criteria,draft?.doc.clipMentorAnalysis?.production_copy_review)
          ?'当前蓝图待独立审核，暂不能进入制作。'
          :undefined
        :undefined;
      const canConfirmBlueprint=!!blueprintRevision&&!!task?.input.panelDelivery&&!task.input.panelDelivery.audience
        &&!task.blueprintApproval&&!running&&task.attempts.model<task.input.budget.model;
      const stopReason = stopped
        ? /^(?:Error: )?(?:Original video asset missing|Original upload unavailable|Original source changed)$/.test(task.error ?? '') ? 'materials'
          : /^(?:Error: )?(?:Production deadline exceeded|(?:model|review|observation|tts|render|preview_review) budget exhausted)$/.test(task.error ?? '')
            || task.stage==='copy_review'&&task.attempts.review>=task.input.budget.review&&task.error?.startsWith('Error: 已用完自动返修额度') ? 'limit'
          : 'service'
        : undefined;
      let attachments:Array<{assetId:string;fileName:string}>=[],deliveryUnavailable=false;
      if(task&&previewFile(task)){
        try{
          const saved=await snapshot();
          if(saved.revision!==task.projectRevision||saved.revision!==task.completed.export?.artifact.revision)throw Error('Preview changed');
          attachments=(await productionAttachmentSlots(saved.doc,undefined,task.completed.export!.at)).map(({assetId,fileName})=>({assetId,fileName}));
        }catch{deliveryUnavailable=true;}
      }
      send({ task:task ? {
        taskId:task.taskId,...(task.blueprintApproval?{sourceTaskId:task.blueprintApproval.sourceTaskId}:{}),
        status: waiting?'waiting':running && task.status === 'blocked' ? 'running' : stopped ? 'blocked' : task.status,
        stage: task.stage, revision: task.projectRevision, sequence: task.sequence,
        active: running, stopReason, feedbackUsed: task.feedbackUsed,
        hasBlueprintFeedback:!!task.blueprintFeedback,blueprintFeedbackSummary:blueprintFeedbackPoints(task),
        ...(task.blueprintApproval?{blueprintConfirmed:true}:{}),
        ...(blueprintRevision?{blueprintRevision,boardIdentity:(await boardSubject(blueprintRevision)).identity,canApproveBlueprint:!approvalUnavailable,
          canConfirmBlueprint,...(approvalUnavailable?{approvalUnavailable}:{})}:{}),
        ...(task.input.panelDelivery?{dualBlueprint:!task.input.panelDelivery.audience,
          ...(task.input.panelDelivery.audience?{audience:task.input.panelDelivery.audience}:{})}:{}),
        ...(task.status==='awaiting_review'&&criteria?{visualCriteria:{digest:criteria.digest}}:{}),
        ...(previewFile(task)?{downloadName:deliveryFileName(task.input.product.name,task.input.panelDelivery?.audience,'video',task.completed.export!.at)}:{}),
        renderId: previewFile(task) ? task.completed.export?.artifact.renderId : undefined,
        ...(attachments.length?{attachments}:{}),...(deliveryUnavailable?{deliveryUnavailable:true}:{}),
      } : null,
        unavailable: (config && 'unavailable' in config) || (!task && isProjectConnected(projectId)) ? panelServiceUnavailable : undefined,
      });
      return;
    }
    if (req.method !== 'POST' || view !== 'panel') throw new Error('不支持的制作操作');
    if (controls.has(projectId)) throw new Error('该工程正在处理上一次操作');
    controls.add(projectId);
    try {
      const body = await readBody();
      const existing = await currentPanelTask(projectId);
      const saved = await snapshot();
      if (body.action === 'start') {
        if (existing) throw new Error('该工程已有制作任务，请刷新查看');
        const config = await settings(true);
        if ('unavailable' in config) throw new Error(config.unavailable);
        if (isProjectConnected(projectId)) throw new Error('请先关闭该工程的 OpenChatCut 编辑器');
        const [source, product, sales, cta] = saved.doc.assets;
        if (source?.kind !== 'video' || [product,sales,cta].some(asset => asset?.kind !== 'image')
          || [source,product,sales,cta].some(asset => !asset?.sourceContentHash || !asset.src.startsWith('/media/uploads/')
            || !resolveUploadFile(asset.src.slice('/media/uploads/'.length)))) {
          res.statusCode = 409;
          send({ error:panelMaterialsUnavailable, reason:'materials' });
          return;
        }
        if (saved.doc.clipMentorAnalysis || saved.doc.timelines.some(t => t.items.length)) throw new Error('该工程已有制作记录');
        const api = { provider:config.provider, model:config.model, apiMode:config.apiMode, origin };
        const index = (await getStoredEntry('projects')).value;
        const name = Array.isArray(index) ? index.find(row => row?.id === projectId)?.name : undefined;
        const salesFact=panelSalesEvidence(source.id,sales.id);
        const next = await createProductionTask({
          projectId, sourceAssetId:source.id, product:{name:typeof name === 'string' && name.trim() ? name.trim() : '当前商品',category:'待核实'},
          brief:'以工程完整原片和商品资料制作马来西亚达人拆解蓝图。共用片头和教学主体，分别登记新建联与已合作的行动结尾。片头保留用户原话“这么多人拍这个品，为什么这支视频可以拿到多少播放量，多少多少这个GA的成绩，我们一起来看看他是怎怎么拍的”的同款成绩提问意图。按本片上传成绩图填写，不写只有本片做到或断言其他视频差，不承诺拍法解释成交原因。用本片原片压暗作底、成绩图作前景。新建联用上传CTA原图，已合作用本商品的原片Storyboard。先交人审版。',
          panelDelivery:{productAssetId:product.id,productAssetHash:product.sourceContentHash!,salesAssetId:sales.id,salesAssetHash:sales.sourceContentHash!,ctaAssetId:cta.id,ctaAssetHash:cta.sourceContentHash!,bookends:'layered-v1',
            salesEvidenceId:salesFact.evidence_id,salesEvidenceSha256:createHash('sha256').update(salesFact.text).digest('hex')},
          author:api, reviewer:api, ...(config.backend==='codex'?{authorBackend:'codex' as const,reviewerBackend:'codex' as const}:{}),
          voice:{provider:'minimax',voiceId:'Malay_female_1_v1'},
          budget:panelProductionBudget(),humanBlueprintReview:true,
        });
        launch(next);
      } else {
        if (!existing || active(existing.taskId,projectId)) throw new Error('制作任务尚未到达可操作阶段');
        if (body.action === 'continue_analysis') {
          const reuseAnalysis=canResumeSavedAnalysis(existing);
          if (!canResumeUndispatchedAnalysis(existing)&&!reuseAnalysis) throw new Error('这次暂停不能从分析入口继续');
          if (isProjectConnected(projectId)) throw new Error('请先关闭该工程的 OpenChatCut 编辑器');
          if (saved.doc.clipMentorAnalysis?.source.asset_id!==existing.input.sourceAssetId
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
        } else if (body.action === 'approve_blueprint' || body.action === 'revise_blueprint' || body.action==='produce_versions') {
          if (body.action === 'revise_blueprint' && typeof body.text !== 'string') throw new Error('请填写修改意见');
          const draftFeedback=body.action==='revise_blueprint'&&(existing.status==='blocked'
            ||existing.status==='awaiting_blueprint'&&saved.revision!==existing.projectRevision)
            &&['blueprint','copy_review'].includes(existing.stage)&&!!saved.doc.clipMentorAnalysis?.blueprint.length;
          const productionConfirmation=body.action==='produce_versions'&&!!existing.input.panelDelivery&&!existing.input.panelDelivery.audience
            &&!existing.blueprintApproval&&['blocked','awaiting_blueprint'].includes(existing.status)&&['blueprint','copy_review'].includes(existing.stage);
          if(body.action==='produce_versions'&&!productionConfirmation)throw Error('当前版本尚不能开始制作');
          if ((!draftFeedback&&!productionConfirmation&&(existing.status !== 'awaiting_blueprint'||body.revision !== existing.projectRevision)) || body.revision !== saved.revision) throw new Error('蓝图版本已变化，请重新打开审片板');
          const subject=await boardSubject(saved.revision,existing,await productionReviewRequirements(projectId));
          if(body.boardIdentity!==subject.identity){res.statusCode=409;send({reason:'review_board_changed'});return;}
          const board = boards.get(projectId);
          if (!board || board.identity!==subject.identity || board.revision !== body.revision || board.criteriaDigest!==criteria?.digest||board.requirementsDigest!==requirementsDigest) {
            res.statusCode = 409;
            send({ reason:'review_board_reload' });
            return;
          }
          await board.file;
          await board.assertUnchanged?.();
          const latest=await snapshot();
          const latestPolicy=await productionReviewRequirements(projectId),latestCriteria=boundVisualCriteria(latestPolicy);
          const latestRequirements=latestPolicy?digestValue(latestPolicy.brief.doneCriteria):undefined;
          if(latest.revision!==body.revision||(await boardSubject(latest.revision,existing,latestPolicy)).identity!==body.boardIdentity||latestCriteria?.digest!==board.criteriaDigest||latestRequirements!==board.requirementsDigest)
            throw new Error('蓝图版本已变化，请重新打开审片板');
          if(productionConfirmation){
            const children=await createBlueprintContinuations(existing,latest,latestPolicy,origin);
            for(const child of children)if(child.status==='queued')launch(child);
            send({accepted:true});return;
          }
          if(draftFeedback){
            await savePendingBlueprintFeedback(existing,saved.revision,body.text);
            send({accepted:true,saved:true,dispatched:false});
            return;
          }
          if(body.action==='approve_blueprint'){
            assertVisualCriteriaPlan(latestCriteria,deliverySectionsFromDoc(latest.doc),latest.doc.clipMentorAnalysis?.source_breakdown?.units.map(u=>u.unit_id),latest.doc.activeTimelineId);
            const gate=await checkCopyProduction(latest.doc,'clipmentor');
            if(!gate.allowed||latestPolicy&&existing.completed.copy_review?.artifact.requirementsDigest!==latestRequirements
              ||latestCriteria&&!visualCriteriaPlanApproved(latestCriteria,latest.doc.clipMentorAnalysis?.production_copy_review))
              throw new Error('当前蓝图待独立审核，暂不能进入制作。');
          }
          if(body.action==='approve_blueprint'&&existing.input.panelDelivery&&
           panelDeliveryIssues(saved.doc,{...existing.input.panelDelivery,bookends:'layered-v1'},await currentCreatorDocument(saved.doc)).length)
            throw new Error('片头或片尾的画面安排尚未齐备，请提交修改意见');
          await resolveHumanBlueprint(existing,body.revision,saved.revision,body.action === 'revise_blueprint' ? body.text : undefined);
          launch(existing);
        } else if (body.action === 'revise_preview' || body.action === 'accept') {
          if (existing.status !== 'awaiting_review' || body.renderId !== existing.completed.export?.artifact.renderId) throw new Error('预览已变化，请重新核对');
          const anchor = await productionFeedbackAnchor(existing,saved.doc);
          if (body.action === 'accept') {
            await acceptProductionTask(existing,body.languageConfirmed === true,productionTaskStore,
              {digest:body.visualCriteriaDigest,confirmed:body.confirmedVisualCriteria,renderId:body.renderId,wholePreviewConfirmed:body.wholePreviewConfirmed});
          }
          else {
            await productionFeedback(existing,{kind:'content',text:body.text,preview:anchor.preview,unit_ids:[],item_ids:[]},productionTaskStore,saved.doc);
            launch(existing);
          }
        } else throw new Error('不支持的制作操作');
      }
      send({ accepted:true });
    } finally {
      controls.delete(projectId);
    }
  };
  return handler;
}
