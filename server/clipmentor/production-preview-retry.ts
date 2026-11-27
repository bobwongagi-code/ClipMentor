import { randomUUID } from 'node:crypto';
import type { ProductionTask } from './production-task';
import { previewReviewRepairBlock } from './preview-review';
import { confirmedUnsubmittedGateway } from './production-recovery';
import { PREVIEW_REVIEW_PROCESS_TIMEOUT_MS } from './preview-review-deadline';
import {productionWorkDeadline} from './production-shared-clock';

// A single continuous review needs its own transport window even if production expired.
const reviewWindowMs = PREVIEW_REVIEW_PROCESS_TIMEOUT_MS + 60_000;

export function productionDeadline(task: ProductionTask) {
 const regular = productionWorkDeadline(task);
 const retry = task.previewReviewRetry;
 return retry && task.stage === 'self_check' && task.completed.export?.artifact.renderId === retry.renderId
  ? Math.max(regular, retry.authorizedAt + reviewWindowMs) : regular;
}

export function authorizePreviewRetry(task: ProductionTask, request: Record<string, unknown>, videoSha256: string, now = Date.now()) {
 const saved = task.completed.export?.artifact;
 const existing=task.previewReviewRetry?.renderId===saved?.renderId?task.previewReviewRetry:undefined;
 if(task.stage!=='self_check'||task.status!=='blocked'||task.completed.self_check
  ||existing&&(request.priorOperationId!==existing.priorOperationId
   ||Object.values(task.effects).some(effect=>effect.operationId===existing.operationId))
  ||request.confirmed!==true||!saved||saved.revision!==task.projectRevision||typeof request.renderId!=='string'||request.renderId!==saved.renderId
  ||request.sequence!==task.sequence||!/^[a-f0-9]{64}$/.test(videoSha256)||request.videoSha256!==videoSha256
  ||typeof request.reason!=='string'||!request.reason.trim()||request.reason.length>500)
  throw Error('preview_retry_authority_mismatch');
 const prefix=`self_check:${task.feedbackUsed?'feedback':'initial'}:${task.repairs}:`;
 const previous=Object.entries(task.effects).filter(([key,effect])=>
  key.startsWith(prefix)&&['preview_review','review'].includes(effect.kind)).at(-1)?.[1];
 const body=(previous?.result as {body?:Record<string,unknown>}|undefined)?.body;
 const interrupted=previous&&['reserved','failed'].includes(previous.status)&&previous.result===undefined;
 if(!previous||previous.operationId!==request.priorOperationId
  ||!interrupted&&(previous.status!=='completed'||!body||body.projectId!==task.projectId||body.operationId!==previous.operationId||body.videoSha256!==videoSha256
  ||body.scope!=='rendered_preview_continuous_review'||body.full_film_accepted!==false
  ||!(body.status==='failed'&&body.receipt_persisted===true
   ||body.status==='completed'&&(body.effective_review as {can_use_as_pass?:boolean}|undefined)?.can_use_as_pass===false
     &&previewReviewRepairBlock(body))))throw Error('preview_retry_receipt_not_reconciled');
 const mayReplace=!existing?.readOnly&&confirmedUnsubmittedGateway('preview_review',{body},previous.operationId,task.projectId);
 const next=structuredClone(task);
 next.previewReviewRetry={operationId:existing?.operationId??randomUUID(),priorOperationId:previous.operationId,renderId:request.renderId,
  videoSha256,reason:request.reason.trim(),authorizedAt:now,...(mayReplace?{}:{readOnly:true})};
 next.status='queued';delete next.error;
 return next;
}

export function previewRetryReadback(task:ProductionTask,readback:Record<string,unknown>){
 const retry=task.previewReviewRetry;
 if(!retry||readback.projectId!==task.projectId||readback.operationId!==retry.priorOperationId||readback.videoSha256!==retry.videoSha256
  ||readback.scope!=='rendered_preview_continuous_review'||readback.full_film_accepted!==false)return 'stop';
 // A local timeout or a broken response says nothing about remote completion.
 // The only replacement allowed here is an explicitly authorized, proven unsent request.
 if(readback.status==='failed'&&!retry.readOnly&&confirmedUnsubmittedGateway('preview_review',{body:readback},retry.priorOperationId,task.projectId))return 'request';
 if(readback.status!=='completed')return 'stop';
 if((readback.effective_review as {can_use_as_pass?:boolean}|undefined)?.can_use_as_pass===true||!previewReviewRepairBlock(readback))return 'reuse';
 return 'stop';
}

export function unavailablePreviewReceiptReason(receipt:Record<string,unknown>){
 const transport=receipt.transport_diagnostic as {error_kind?:string;response_boundary?:string}|undefined;
 return transport?.error_kind==='curl_timeout'&&transport.response_boundary==='no_final_response_unattributed'
  ?'preview_review_timeout_unconfirmed':'preview_review_receipt_unavailable';
}
