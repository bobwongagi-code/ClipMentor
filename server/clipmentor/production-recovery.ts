import {isCopyReviewFailure} from '../../shared/clipmentor-copy-review';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const transientGatewayStatuses = new Set([408, 429, 500, 502, 503, 504]);

/** HTTP statuses eligible for a charged retry after durable readback. */
export function retryableGatewayStatus(status:unknown) {
  return typeof status === 'number' && transientGatewayStatuses.has(status);
}

const connectionBackoff = [1500, 3500, 7000, 12000, 15000];
type GatewayKind = 'observation' | 'preview_review';
const record = (value:unknown) => value && typeof value==='object' && !Array.isArray(value)
  ? value as Record<string,unknown> : undefined;

function gatewayFailure(kind:GatewayKind,result:unknown,operationId:string,projectId:string,videoHash?:unknown) {
  const row=record(result);
  const receipt=kind==='observation'?record(row?.receipt):row;
  if(receipt?.status!=='failed'||receipt.operationId!==operationId||receipt.projectId!==projectId
    ||receipt.requestsAttempted!==1||receipt.receipt_persisted!==true)return;
  if(kind==='observation'&&receipt.phase!=='gateway_request')return;
  if(kind==='preview_review'&&(typeof receipt.videoSha256!=='string'
    ||(videoHash!==undefined&&receipt.videoSha256!==videoHash)))return;
  return receipt;
}

function transportFailure(receipt:Record<string,unknown>,operationId:string) {
  const diagnostic=record(receipt.transport_diagnostic);
  const metrics=record(diagnostic?.metrics);
  const ids=record(diagnostic?.request_ids);
  const body=record(diagnostic?.response_body);
  if(diagnostic?.operation_id!==operationId||!metrics||!ids||Object.keys(ids).length!==0
    ||body?.bytes!==0)return;
  const code=diagnostic.curl_exit_code;
  // 100 Continue is not a final response. A body upload may stall after the
  // server has received some bytes: keep the attempt charged, never refund it.
  if(receipt.upstream_http_status===100&&diagnostic.http_status===100){
    if(typeof diagnostic.request_bytes==='number'&&Number.isFinite(diagnostic.request_bytes)&&diagnostic.request_bytes>0
      &&typeof metrics.size_upload==='number'&&Number.isFinite(metrics.size_upload)
      &&metrics.size_upload>=0&&metrics.size_upload<=diagnostic.request_bytes&&metrics.size_download===0
      &&((diagnostic.error_kind==='curl_timeout'&&code===28)
        ||(diagnostic.error_kind==='curl_failed'&&(code===52||code===55||code===56))))return 'uncertain';
    return;
  }
  if(receipt.upstream_http_status!=null||diagnostic.http_status!==null)return;
  if(metrics.size_upload===0&&metrics.time_pretransfer===0&&metrics.time_starttransfer===0
    &&((diagnostic.error_kind==='curl_failed'&&(code===6||code===7))
      ||(diagnostic.error_kind==='curl_timeout'&&code===28)))return 'unsubmitted';
  if((diagnostic.error_kind==='curl_timeout'&&code===28)
    ||(diagnostic.error_kind==='curl_failed'&&(code===52||code===55||code===56)))return 'uncertain';
}

export interface GatewayRecoveryDecision {
  operation_id:string;action:'reuse_saved_result'|'retry_connection'|'retry_charged'|'stop';reason:string;
  next_operation_id?:string;delay_ms?:number;
}
export interface GatewayRecoveryOptions {
  allowRetry?:boolean;
  readOriginal?:(operationId:string)=>Promise<unknown>;
  recordDecision?:(decision:GatewayRecoveryDecision)=>Promise<void>;
}

function checkedReadback(kind:GatewayKind,value:unknown,original:unknown,operationId:string,projectId:string,videoHash:unknown){
  const row=record(value),receipt=kind==='observation'?record(row?.receipt):row;
  const prior=kind==='observation'?record(record(original)?.receipt):record(original);
  if(!receipt||receipt.operationId!==operationId||receipt.projectId!==projectId
    ||(kind==='observation'&&(row?.ok!==true||row.current_binding!=='current'
      ||receipt.actual_handoff_verified!==false||receipt.complete_film_accepted!==false
      ||typeof receipt.source_hash!=='string'||!record(receipt.subject)
      ||(prior?.source_hash!==undefined&&prior.source_hash!==receipt.source_hash)
      ||(record(prior?.subject)&&(record(prior!.subject)!.digest!==record(receipt.subject)!.digest
        ||record(prior!.subject)!.revision!==record(receipt.subject)!.revision))))
    ||(kind==='preview_review'&&(receipt.videoSha256!==videoHash||receipt.full_film_accepted!==false
      ||receipt.scope!=='rendered_preview_continuous_review')))return {reason:'original_receipt_unbound_or_stale'};
  if(receipt.status==='completed'){
    if(kind==='preview_review')return {result:value,completed:true}; // A saved negative review remains negative.
    const result=record(receipt.result);
    if(!result||result.operationId!==operationId||result.source_hash!==receipt.source_hash
      ||record(result.subject)?.digest!==record(receipt.subject)?.digest
      ||record(result.subject)?.revision!==record(receipt.subject)?.revision||record(result.validation)?.status!=='valid'
      ||result.scope!=='source_windows_and_planned_capacity_only'||result.actual_handoff_verified!==false
      ||result.complete_film_accepted!==false)return {reason:'completed_source_result_invalid'};
    return {result:{...result,ok:true,cached:true,current_binding:'current',requestsSent:0},completed:true};
  }
  if(receipt.status!=='failed')return {reason:'original_receipt_not_terminal'};
  if(receipt.receipt_persisted!==true)return {reason:'original_receipt_not_persisted'};
  return {result:kind==='observation'?{error:receipt.error,receipt}:value,completed:false};
}

export function confirmedUnsubmittedGateway(kind:string,result:unknown,operationId:string,projectId:string) {
  if(kind!=='observation'&&kind!=='preview_review')return false;
  const body=record(record(result)?.body);
  const preparation=kind==='observation'?record(body?.receipt):body;
  if(preparation?.model_retry_policy==='no_automatic_retry'&&preparation.status==='failed'
    &&preparation.operationId===operationId&&preparation.projectId===projectId&&preparation.receipt_persisted===true
    &&preparation.requestsAttempted===0&&preparation.requestsSent===0
    &&(kind!=='observation'||preparation.phase==='prepare'))return true;
  const receipt=gatewayFailure(kind,record(result)?.body,operationId,projectId);
  return !!receipt&&transportFailure(receipt,operationId)==='unsubmitted';
}

function operationForRetry(initial:string,index:number) {
  const hash=createHash('sha256').update(`clipmentor-gateway-retry:${initial}:${index}`).digest('hex');
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
}

export async function recoverProductionGateway(
  name:string,args:Record<string,unknown>,projectId:string,canRetry:(nextOperationId:string)=>boolean,
  execute:(args:Record<string,unknown>)=>Promise<unknown>,
  wait:(ms:number)=>Promise<unknown> = ms=>sleep(ms),
  chargedRetryLimit=2,
  options:GatewayRecoveryOptions={},
) {
  if((name!=='observe_clipmentor_source_video'&&name!=='review_clipmentor_preview'&&name!=='request_clipmentor_copy_review')
     ||typeof args.operationId!=='string'||(name==='review_clipmentor_preview'&&args.action!=='request')){
    return execute(args);
  }
  const kind=name==='observe_clipmentor_source_video'?'observation':'preview_review';
  const initial=args.operationId;
  const operationIds:string[]=[];
  const decisions:GatewayRecoveryDecision[]=[];
  const decide=async(decision:GatewayRecoveryDecision)=>{
    decisions.push(decision);
    // Fail closed if recovery evidence cannot be saved, before another request.
    await options.recordDecision?.(decision);
  };
  const finish=(result:unknown)=>{
    const row=record(result);
    return row?{...row,...(operationIds.length>1?{gateway_operation_ids:operationIds}:{}),
      ...(decisions.length?{gateway_recovery_decisions:decisions}:{})}:result;
  };
  let connectionRetries=0, chargedRetries=0;
  for(let index=0;;index++){
    const operationId=index===0?initial:operationForRetry(initial,index);
    operationIds.push(operationId);
    let result=await execute({...args,operationId});
    const initialRow=record(result);
    if(name!=='request_clipmentor_copy_review'
      &&(kind==='observation'?initialRow?.ok!==true:initialRow?.status!=='completed')){
      if(options.readOriginal){
        let saved:unknown;
        try{saved=await options.readOriginal(operationId);}
        catch{await decide({operation_id:operationId,action:'stop',reason:'original_receipt_unavailable'});return finish(result);}
        const checked=checkedReadback(kind,saved,result,operationId,projectId,args.videoSha256);
        if(checked.reason){await decide({operation_id:operationId,action:'stop',reason:checked.reason});return finish(result);}
        if(checked.completed){await decide({operation_id:operationId,action:'reuse_saved_result',reason:'original_operation_completed'});return finish(checked.result);}
        result=checked.result;
      }else if(gatewayFailure(kind,result,operationId,projectId,args.videoSha256)?.upstream_http_status===100){
        await decide({operation_id:operationId,action:'stop',reason:'interim_response_requires_receipt_readback'});return finish(result);
      }
    }
    const row=record(result);
    const receipt=gatewayFailure(kind,result,operationId,projectId,args.videoSha256);
    const diagnostic=row?.diagnostic;
    // A parsed/schema failure needs local repair; a timed-out review may still be
    // running remotely. Neither grants a second paid submission under a fresh ID.
    if(name==='request_clipmentor_copy_review'&&isCopyReviewFailure(diagnostic)){
      await decide({operation_id:operationId,action:'stop',reason:['response_parse','response_validation'].includes(diagnostic.stage)
        ?'saved_copy_response_requires_local_recovery':'copy_result_requires_original_receipt_lookup'});return finish(result);
    }
    const modelReceipt=kind==='observation'?record(row?.receipt):row;
    if(modelReceipt?.model_retry_policy==='no_automatic_retry') {
      await decide({operation_id:operationId,action:'stop',reason:'model_retry_disabled_by_transport_contract'});return finish(result);
    }
    const transport=receipt&&transportFailure(receipt,operationId);
    const nextOperationId=operationForRetry(initial,index+1);
    const eligible=!!receipt&&(transport!==undefined||retryableGatewayStatus(receipt.upstream_http_status));
    if(eligible&&options.allowRetry===false){
      await decide({operation_id:operationId,action:'stop',reason:'automatic_retry_not_authorized'});return finish(result);
    }
    let delay:number|undefined;
    if((receipt)&&canRetry(nextOperationId)){
      if(transport==='unsubmitted')delay=connectionBackoff[connectionRetries++];
      else if((transport==='uncertain'||retryableGatewayStatus(receipt?.upstream_http_status))
        &&chargedRetries<Math.min(chargedRetryLimit,transport==='uncertain'?2:chargedRetryLimit))
        delay=connectionBackoff[Math.min(chargedRetries++,connectionBackoff.length-1)];
    }
    if(delay===undefined){
      if(eligible||receipt||row?.error||row?.status==='failed')await decide({operation_id:operationId,action:'stop',
        reason:eligible?(canRetry(nextOperationId)?'recovery_retry_limit':'budget_or_deadline_exhausted'):'non_transient_or_unverified_failure'});
      return finish(result);
    }
    await decide({operation_id:operationId,action:transport==='unsubmitted'?'retry_connection':'retry_charged',
      reason:transport==='unsubmitted'?'confirmed_unsubmitted':transport==='uncertain'?'submission_uncertain_attempt_retained':'saved_transient_failure',
      next_operation_id:nextOperationId,delay_ms:delay});
    await wait(delay);
    if(!canRetry(nextOperationId)){
      await decide({operation_id:operationId,action:'stop',reason:'budget_or_deadline_exhausted_after_backoff'});return finish(result);
    }
  }
}
