import type {ProjectDoc} from '../../src/editor/types';
import type {SourceVideoResult} from '../../shared/clipmentor-source-video';
import {loadAgentRuntimeSidecar} from '../../src/persist/agentRuntimeStore';
import {loadOfflineStoredProject} from '../external-agent/offline-project-store';
import {digestValue} from '../agent-runs/store-values';
import {publishedProductionParent} from './production-continuation';
import {savedSourceReceiptUnavailable} from './production-decisions';
import type {ProductionTask} from './production-task';
import {prepareProductionBlueprint} from './production-readiness';
import {confirmedTeachingDigest} from './production-teaching-baseline';
import {readSourceVideoReceipt,sourceVideoDependencies} from './source-video';

type SavedAuthorEvent={type:string;data?:{name?:string;toolCallId?:string;status?:string;success?:boolean;
 args?:{action?:string;operationId?:string};
 result?:{saved?:boolean;projectId?:string;projectRevision?:string;revision?:number;error?:string;requestsSent?:number}}};

/** Read the parent's saved observation only for a published output of that same original. */
export async function readApprovedOutputSource(task:ProductionTask,doc:ProjectDoc,operationId:string){
 const approval=task.blueprintApproval;
 if(!approval||!task.input.panelDelivery?.audience)return;
 const parent=await publishedProductionParent(task);
 const snapshot=await loadOfflineStoredProject(approval.sourceProjectId);
 const source=doc.clipMentorAnalysis?.source;
 const asset=doc.assets.find(item=>item.id===task.input.sourceAssetId);
 const parentAsset=snapshot?.doc.assets.find(item=>item.id===parent?.input.sourceAssetId);
 const srcPrefix='/media/uploads/';
 if(!parent||snapshot?.revision!==approval.sourceRevision||!source?.sourceContentHash||source.asset_id!==task.input.sourceAssetId
  ||digestValue(source)!==digestValue(snapshot.doc.clipMentorAnalysis?.source)
  ||asset?.kind!=='video'||parentAsset?.kind!=='video'||asset.src!==parentAsset.src||!asset.src.startsWith(srcPrefix)
  ||asset.sourceContentHash!==source.sourceContentHash||parentAsset.sourceContentHash!==source.sourceContentHash)return;
 const observation=Object.values(parent.effects).find(effect=>
  effect.kind==='observation'&&effect.status==='completed'&&effect.operationId===operationId);
 const bound=(observation?.result as {body?:SourceVideoResult}|undefined)?.body;
 if(bound?.operationId!==operationId||bound.source_hash!==source.sourceContentHash||bound.validation?.status!=='valid')return;
 const deps=sourceVideoDependencies();
 const receipt=await readSourceVideoReceipt(operationId,parent.projectId,deps).catch(()=>null);
 if(receipt?.status!=='completed'||receipt.requestsSent!==0||receipt.source_hash!==source.sourceContentHash
  ||!receipt.result?.raw_observation||!bound.raw_observation||receipt.result.request_sha256!==bound.request_sha256
  ||digestValue(receipt.subject)!==digestValue(bound.subject)||digestValue(receipt.result.raw_observation)!==digestValue(bound.raw_observation)
  ||receipt.result.actual_handoff_verified!==false||receipt.result.complete_film_accepted!==false)return;
 const file=deps.resolve(decodeURIComponent(asset.src.slice(srcPrefix.length)));
 if(!file||await deps.hash(file)!==source.sourceContentHash)return;
 return {ok:true,receipt,current_binding:'stale' as const,requestsSent:0,
  note:'原工程已保存的同份原片观察，只作原片证据。它不代表本制作副本的蓝图或成片已审核。'};
}

/** A failed read can leave a valid picture write. Publish its checkpoint without repeating the author. */
export async function recoverApprovedOutputSourceRead(task:ProductionTask){
 const prefix=`blueprint:${task.feedbackUsed?'feedback':'initial'}:${task.repairs}:author-`;
 const snapshot=await loadOfflineStoredProject(task.projectId);
 const attempts=Object.entries(task.effects).filter(([key,effect])=>key.startsWith(prefix)&&effect.kind==='model');
 if(!snapshot||!task.projectRevision||task.repairContext?.revision!==task.projectRevision
  ||task.completed.blueprint||task.approvedSourceReadRecovered
  ||!attempts.length||attempts.some(([,effect])=>effect.status!=='completed'))
  throw Error('approved_source_receipt_checkpoint_unverified');
 const sidecar=await loadAgentRuntimeSidecar(task.projectId);
 const decisions=sidecar.runs.find(item=>item.runId===task.taskId)?.events.flatMap(event=>{
  try{
   const decision=JSON.parse(event.summary??'{}').productionDecision;
   return decision?.taskId===task.taskId&&decision.stage==='blueprint'&&decision.revision===task.projectRevision
    &&decision.repairEpoch===task.repairs?[{...decision,at:event.createdAt}]:[];
  }catch{return [];}
 })??[];
 const selected=decisions.findLast(decision=>decision.scope==='author'&&decision.action==='select');
 const submission=decisions.find(decision=>decision.scope==='effect'&&decision.action==='submit'
  &&attempts.some(([,effect])=>effect.operationId===decision.operationId));
 const run=selected&&submission?sidecar.runs.find(item=>item.projectId===task.projectId&&item.runId!==task.taskId
  &&item.backend===(task.input.authorBackend??'api')&&item.modelId===task.input.author.model
  &&item.createdAt>=selected.at&&item.createdAt<=submission.at&&item.updatedAt<=task.updatedAt):undefined;
 const events:SavedAuthorEvent[]=run?.events.flatMap(event=>{
  try{const value=JSON.parse(event.summary??'{}').serverEvent;return value?[value]:[];}
  catch{return [];}
 })??[];
 const failed=events.findLast(event=>event.type==='server-tool-result'&&event.data?.success===false);
 const request=failed&&events.find(event=>event.type==='server-tool-request'&&event.data?.name==='read_clipmentor_source_video'
  &&event.data?.toolCallId===failed.data?.toolCallId&&typeof event.data?.toolCallId==='string');
 const result=events.findLast(event=>event.type==='server-tool-result'&&event.data?.result?.saved===true);
 const savedWrite=result?.data?.result;
 const write=result&&events.find(event=>event.type==='server-tool-request'&&event.data?.name==='revise_clipmentor_analysis'
  &&event.data?.toolCallId===result.data?.toolCallId&&typeof event.data?.toolCallId==='string');
 if(!run||events.findLast(event=>event.type==='done')?.data?.status!=='failed'||failed?.data?.name!=='read_clipmentor_source_video'
  ||failed.data.result?.error!==savedSourceReceiptUnavailable||failed.data.result?.requestsSent!==0
  ||typeof request?.data?.args?.operationId!=='string'||write?.data?.args?.action!=='set_picture_plan'
  ||result?.data?.success!==true||savedWrite?.projectId!==task.projectId
  ||savedWrite.projectRevision!==snapshot.revision||snapshot.revision===task.projectRevision
  ||savedWrite.revision!==snapshot.doc.clipMentorAnalysis?.revision
  ||!task.blueprintApproval?.confirmedTeachingDigest
  ||confirmedTeachingDigest(snapshot.doc)!==task.blueprintApproval.confirmedTeachingDigest
  ||!await readApprovedOutputSource(task,snapshot.doc,request.data.args.operationId))
  throw Error('approved_source_receipt_read_unverified');
 await prepareProductionBlueprint(snapshot.doc);
 task.projectRevision=snapshot.revision;
 task.completed.blueprint={at:Date.now(),artifact:{revision:snapshot.revision,runId:run.runId,recoveredReadOnlyFailure:true}};
 task.stage='copy_review';
 task.approvedSourceReadRecovered=true;
}
