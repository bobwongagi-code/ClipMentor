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
  if(receipt.upstream_http_status!=null||diagnostic?.operation_id!==operationId
    ||diagnostic.http_status!==null||!metrics||!ids||Object.keys(ids).length!==0
    ||body?.bytes!==0)return;
  const code=diagnostic.curl_exit_code;
  if(metrics.size_upload===0&&metrics.time_pretransfer===0&&metrics.time_starttransfer===0
    &&((diagnostic.error_kind==='curl_failed'&&(code===6||code===7))
      ||(diagnostic.error_kind==='curl_timeout'&&code===28)))return 'unsubmitted';
  if((diagnostic.error_kind==='curl_timeout'&&code===28)
    ||(diagnostic.error_kind==='curl_failed'&&(code===52||code===55||code===56)))return 'uncertain';
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
) {
  if((name!=='observe_clipmentor_source_video'&&name!=='review_clipmentor_preview'&&name!=='request_clipmentor_copy_review')
     ||typeof args.operationId!=='string'||(name==='review_clipmentor_preview'&&args.action!=='request')){
    return execute(args);
  }
  const kind=name==='observe_clipmentor_source_video'?'observation':'preview_review';
  const initial=args.operationId;
  const operationIds:string[]=[];
  let connectionRetries=0, chargedRetries=0;
  for(let index=0;;index++){
    const operationId=index===0?initial:operationForRetry(initial,index);
    operationIds.push(operationId);
    const result=await execute({...args,operationId});
    const row=record(result);
    const receipt=gatewayFailure(kind,result,operationId,projectId,args.videoSha256);
    const diagnostic=row?.diagnostic;
    // Schema errors require local recovery; unknown model outcomes do not grant another paid submission.
    if(name==='request_clipmentor_copy_review'&&isCopyReviewFailure(diagnostic))return result;
    const modelReceipt=kind==='observation'?record(row?.receipt):row;
    if(modelReceipt?.model_retry_policy==='no_automatic_retry')return result;
    const transport=receipt&&transportFailure(receipt,operationId);
    let delay:number|undefined;
    if(receipt&&canRetry(operationForRetry(initial,index+1))){
      if(transport==='unsubmitted')delay=connectionBackoff[connectionRetries++];
      else if((transport==='uncertain'||retryableGatewayStatus(receipt?.upstream_http_status))&&chargedRetries<chargedRetryLimit)
        delay=connectionBackoff[Math.min(chargedRetries++,connectionBackoff.length-1)];
    }
    if(delay===undefined)return index&&row?{...row,gateway_operation_ids:operationIds}:result;
    await wait(delay);
  }
}
