// Server-only, shared by source observation and actual-export review. No model calls or media conversions.
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { S3Client, HeadObjectCommand, GetObjectCommand, CreateMultipartUploadCommand,
  ListPartsCommand, ListMultipartUploadsCommand, UploadPartCommand, CompleteMultipartUploadCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { outboundHttpAgent, outboundProxyUrl, proxyDispatcher } from '../outbound-proxy';
import { getKey } from '../keystore';
import { runtimeProfile } from '../runtime-profile';
import { atomicWriteFile } from '../plugins/project-store-durable';
import { sha256File } from '../../shared/node-content-hash';
import { sealVideo, videoInput, VIDEO_URL_MAX_BYTES, VIDEO_REQUEST_MAX_BYTES, type PreparedVideo, type MediaTransferReceipt } from './video-input';

const PART_BYTES = 8 * 1024 * 1024;
const MAX_ATTEMPTS = 3;
const SHA = /^[a-f0-9]{64}$/;
type Stage = 'local_read' | 'r2_upload' | 'r2_readback' | 'r2_sign';
export class VideoMediaError extends Error {
  readonly stage: Stage;
  readonly code: string;
  metrics?: Pick<MediaTransferReceipt,'storage_requests'|'attempted_part_bytes'|'confirmed_part_bytes'|'downloaded_bytes'|'elapsed_ms'>;
  constructor(stage: Stage, code: string) { super(`Video media ${stage}: ${code}; no model submitted`); this.stage=stage; this.code=code; }
}
interface Head { bytes: number; etag: string; }
interface Part { number: number; etag: string; bytes: number; }
/** Narrow S3 contract also exercised with an offline faulting store; never a second timeline. */
export interface VideoObjectStore {
  identity: string;
  head(key: string, signal: AbortSignal): Promise<Head | null>;
  pending(key: string, signal: AbortSignal): Promise<string[]>;
  create(key: string, signal: AbortSignal): Promise<string>;
  list(key: string, upload: string, signal: AbortSignal): Promise<Part[]>;
  part(key: string, upload: string, number: number, body: Readable, bytes: number, signal: AbortSignal): Promise<string>;
  complete(key: string, upload: string, parts: Part[], signal: AbortSignal): Promise<void>;
  get(key: string, etag: string, signal: AbortSignal): Promise<Readable>;
  sign(key: string): Promise<string>;
}
interface State {
  version: 1; identity: string; sha256: string; bytes: number;
  upload?: string; parts: Part[]; attempts: Record<string, number>;
  verified?: Head;
}
interface MediaOptions {
  file: string; sha256: string; directory: string; namespace: string; store: VideoObjectStore; signal: AbortSignal;
}
function transient(error: unknown) {
  const e=error as { name?: string; code?: string; $metadata?: {httpStatusCode?: number} };
  const status=e?.$metadata?.httpStatusCode;
  return status===408 || status===429 || (typeof status==='number' && status>=500)
    || ['TimeoutError','RequestTimeout','NetworkingError'].includes(e?.name??'')
    || ['ECONNRESET','ETIMEDOUT','EPIPE','EAI_AGAIN'].includes(e?.code??'');
}
function missing(error: unknown) {
  return (error as {$metadata?:{httpStatusCode?:number}})?.$metadata?.httpStatusCode===404
    || ['NotFound','NoSuchKey'].includes((error as {name?:string})?.name??'');
}
async function lock(path: string, signal: AbortSignal) {
  // A SQLite transaction is an OS-backed cross-process lock. A killed process releases it;
  // no empty lockfile window, PID reuse or stale-owner unlink can steal another writer's lock.
  const db=new DatabaseSync(path+'.sqlite');
  db.exec('PRAGMA busy_timeout=0');
  try {
    while(true) {
      signal.throwIfAborted();
      try {db.exec('BEGIN IMMEDIATE');return async()=>{try{db.exec('COMMIT');}finally{db.close();}};}
      catch(e) {
        if((e as {errcode?:number}).errcode!==5 && !String((e as Error).message).includes('database is locked'))throw e;
        await delay(50,undefined,{signal});
      }
    }
  } catch(e) {db.close();throw e;}
}

/** Deliver the selected file's exact bytes; upstream observation selection owns any declared excerpt. */
export async function prepareR2Video(options: MediaOptions): Promise<PreparedVideo> {
  const {file,sha256,directory,namespace,store,signal}=options;
  if(!SHA.test(sha256)||!namespace||namespace.length>200||!store.identity)throw new VideoMediaError('local_read','invalid_identity');
  let stage:Stage='local_read'; const started=Date.now();
  let transferReceipt: MediaTransferReceipt | undefined;
  const handle=await open(file,'r');
  let release:(()=>Promise<void>)|undefined;
  try {
    signal.throwIfAborted();
    const size=(await handle.stat()).size;
    if(!Number.isSafeInteger(size)||size<=0||size>VIDEO_URL_MAX_BYTES)throw new VideoMediaError(stage,'url_capability_unverified_above_15000000');
    // Hash the same opened inode used for all parts. Rehash before returning to catch concurrent edits.
    const rangeStream=(start:number,end:number)=>Readable.from((async function*(){
      for(let at=start;at<=end;) {signal.throwIfAborted();const chunk=Buffer.alloc(Math.min(256*1024,end-at+1));
        const {bytesRead}=await handle.read(chunk,0,chunk.length,at);if(!bytesRead)break;at+=bytesRead;yield chunk.subarray(0,bytesRead);}
    })());
    const fileHash=async()=>{
      const h=createHash('sha256');let count=0;
      for await(const chunk of rangeStream(0,size-1)) {signal.throwIfAborted();count+=chunk.length;h.update(chunk);}
      if(count!==size)throw new VideoMediaError('local_read','source_length_changed');
      return h.digest('hex');
    };
    if(await fileHash()!==sha256)throw new VideoMediaError(stage,'source_hash_mismatch');
    const scope=createHash('sha256').update(namespace).digest('hex');
    const key=`clipmentor-video-v1/${scope}/${sha256}.mp4`;
    const identity=createHash('sha256').update(JSON.stringify([store.identity,key])).digest('hex');
    await mkdir(directory,{recursive:true,mode:0o700});
    release=await lock(join(directory,`${identity}.lock`),signal);
    const stateFile=join(directory,`${identity}.json`);
    let state:State;
    try { state=JSON.parse(await readFile(stateFile,'utf8'));
      if(state.version!==1||state.identity!==identity||state.sha256!==sha256||state.bytes!==size
        ||!Array.isArray(state.parts)||!state.attempts||typeof state.attempts!=='object'||Array.isArray(state.attempts)
        ||(state.upload!==undefined&&(typeof state.upload!=='string'||!state.upload||state.upload.length>4096))
        ||Object.entries(state.attempts).some(([n,a])=>!(/^[1-9][0-9]*$/.test(n))||Number(n)>Math.ceil(size/PART_BYTES)
          ||!Number.isInteger(a)||a<0||a>MAX_ATTEMPTS)
        ||state.parts.length>Math.ceil(size/PART_BYTES)||new Set(state.parts.map(p=>p.number)).size!==state.parts.length
        ||state.parts.some(p=>!Number.isInteger(p.number)||p.number<1||p.number>Math.ceil(size/PART_BYTES)
          ||typeof p.etag!=='string'||!p.etag||p.bytes!==Math.min(PART_BYTES,size-(p.number-1)*PART_BYTES))
        ||(state.verified!==undefined&&(state.verified.bytes!==size||typeof state.verified.etag!=='string'||!state.verified.etag)))throw Error('invalid');
    } catch(e) {
      if((e as NodeJS.ErrnoException).code!=='ENOENT')throw new VideoMediaError('r2_upload','invalid_saved_transfer');
      state={version:1,identity,sha256,bytes:size,parts:[],attempts:{}};
    }
    let writes=Promise.resolve();
    const save=()=>{writes=writes.then(()=>atomicWriteFile(stateFile,JSON.stringify(state),{mode:0o600}));return writes;};
    const receipt:MediaTransferReceipt=transferReceipt={version:'original-video-transfer-v1',mode:'r2',sha256,bytes:size,scope:'full_original_bytes',
      verified_to:'object_store',reused:false,storage_requests:0,attempted_part_bytes:0,confirmed_part_bytes:0,downloaded_bytes:0,elapsed_ms:0,model_fetch_verified:false,cost:'unknown'};
    const call=async<T>(fn:()=>Promise<T>)=>{signal.throwIfAborted();receipt.storage_requests++;return fn();};
    stage='r2_upload';
    let head=await call(()=>store.head(key,signal));
    const partCount=Math.ceil(size/PART_BYTES);
    const expectedSize=(number:number)=>Math.min(PART_BYTES,size-(number-1)*PART_BYTES);
    const list=async()=>{
      const parts=await call(()=>store.list(key,state.upload!,signal));
      if(new Set(parts.map(p=>p.number)).size!==parts.length||parts.some(p=>!Number.isInteger(p.number)||p.number<1||p.number>partCount
        ||!p.etag||p.bytes!==expectedSize(p.number)))throw new VideoMediaError('r2_upload','remote_parts_invalid');
      return parts;
    };
    const startUpload=async()=>{
        // Recover a lost CreateMultipart acknowledgement before creating another upload of the same bytes.
        const pending=await call(()=>store.pending(key,signal));
        if(pending.length>1||pending.some(id=>typeof id!=='string'||!id||id.length>4096))throw new VideoMediaError('r2_upload','pending_upload_ambiguous');
        state.upload=pending[0]??await call(()=>store.create(key,signal));await save();
    };
    if(!head) {
      if(state.verified){
        state={version:1,identity,sha256,bytes:size,parts:[],attempts:{}};
        await save();
      }
      if(!state.upload)await startUpload();
      try{state.parts=await list();}
      catch(error){
        if((error as {name?:string})?.name!=='NoSuchUpload')throw error;
        head=await call(()=>store.head(key,signal));
        state={version:1,identity,sha256,bytes:size,parts:[],attempts:{}};
        await save();
        if(!head){await startUpload();state.parts=await list();}
      }
    }
    if(!head) {
      await save();
      const upload=async(number:number)=>{
        if(state.parts.some(p=>p.number===number))return;
        while((state.attempts[number]??0)<MAX_ATTEMPTS) {
          state.attempts[number]=(state.attempts[number]??0)+1;await save();
          const bytes=expectedSize(number),start=(number-1)*PART_BYTES;
          const body=rangeStream(start,start+bytes-1);
          try {
            // On uncertain acknowledgement, ListParts before retransmitting the same part.
            receipt.attempted_part_bytes+=bytes;
            const etag=await call(()=>store.part(key,state.upload!,number,body,bytes,signal));
            if(!etag)throw new VideoMediaError('r2_upload','missing_part_etag');
            receipt.confirmed_part_bytes+=bytes;
            state.parts.push({number,etag,bytes});await save();return;
          } catch(e) {
            body.destroy();signal.throwIfAborted();
            if(!transient(e))throw e;
            const remote=(await list()).find(p=>p.number===number);
            if(remote) {receipt.confirmed_part_bytes+=remote.bytes;state.parts.push(remote);await save();return;}
            if((state.attempts[number]??0)>=MAX_ATTEMPTS)break;
            await delay(100*2**(state.attempts[number]-1),undefined,{signal});
          } finally {body.destroy();}
        }
        throw new VideoMediaError('r2_upload','part_retry_limit');
      };
      for(let start=1;start<=partCount;start+=2) {
        const batch=await Promise.allSettled(Array.from({length:Math.min(2,partCount-start+1)},(_,i)=>upload(start+i)));
        const failure=batch.find(r=>r.status==='rejected');
        if(failure?.status==='rejected')throw failure.reason;
      }
      state.parts.sort((a,b)=>a.number-b.number);await save();
      try {await call(()=>store.complete(key,state.upload!,state.parts,signal));}
      catch(e) { // Completion acknowledgement can be lost: inspect the object; never create another upload blindly.
        head=await call(()=>store.head(key,signal));if(!head)throw e;
      }
      head??=await call(()=>store.head(key,signal));
    } else receipt.reused=true;
    if(!head||head.bytes!==size||!head.etag)throw new VideoMediaError('r2_readback','remote_identity_invalid');
    stage='r2_readback';
    if(state.verified && (state.verified.etag!==head.etag||state.verified.bytes!==head.bytes))throw new VideoMediaError(stage,'verified_object_changed');
    if(!state.verified) {
      const stream=await call(()=>store.get(key,head!.etag,signal));
      const digest=createHash('sha256');let bytes=0;
      try {for await(const chunk of stream) {
        signal.throwIfAborted();bytes+=chunk.length;receipt.downloaded_bytes+=chunk.length;
        if(bytes>size)throw new VideoMediaError(stage,'remote_length_mismatch');digest.update(chunk);
      }} finally {stream.destroy();}
      if(bytes!==size||digest.digest('hex')!==sha256)throw new VideoMediaError(stage,'remote_hash_mismatch');
      const after=await call(()=>store.head(key,signal));
      if(!after||after.etag!==head.etag||after.bytes!==head.bytes)throw new VideoMediaError(stage,'object_changed_during_verification');
      state.verified=head;await save();
    }
    if(await fileHash()!==sha256||await sha256File(file)!==sha256)throw new VideoMediaError('local_read','source_changed');
    stage='r2_sign';signal.throwIfAborted();
    const uri=await store.sign(key),url=new URL(uri);
    if(url.protocol!=='https:'||url.username||url.password||url.hash)throw new VideoMediaError(stage,'invalid_signed_url');
    signal.throwIfAborted();receipt.elapsed_ms=Date.now()-started;
    return sealVideo({sha256,bytes:size,part:{fileData:{mimeType:'video/mp4',fileUri:uri},videoMetadata:{fps:5}},receipt});
  } catch(e) {
    const error=e instanceof VideoMediaError?e:new VideoMediaError(stage,signal.aborted?'aborted':'transfer_failed');
    if(transferReceipt)error.metrics={storage_requests:transferReceipt.storage_requests,attempted_part_bytes:transferReceipt.attempted_part_bytes,
      confirmed_part_bytes:transferReceipt.confirmed_part_bytes,downloaded_bytes:transferReceipt.downloaded_bytes,elapsed_ms:Date.now()-started};
    throw error; // Never persist provider errors containing signatures/credentials.
  } finally {await release?.();await handle.close();}
}

type R2Credentials = {account:string;bucket:string;accessKeyId:string;secretAccessKey:string};
type CredentialVerification={identity:string;value:Promise<R2Credentials>;controller:AbortController;waiters:number;settled:boolean};
let legacyCredentials:CredentialVerification|undefined;
/** Use this product's existing video-only token without enabling generic upload synchronization. */
export async function resolveVideoR2Credentials(config:Record<string,string>,signal:AbortSignal,verify:typeof fetch=fetch):Promise<R2Credentials> {
  signal.throwIfAborted();
  const account=config.R2_ACCOUNT_ID??'',bucket=config.R2_BUCKET??'',accessKeyId=config.R2_ACCESS_KEY_ID??'',secretAccessKey=config.R2_SECRET_ACCESS_KEY??'';
  if([account,bucket,accessKeyId,secretAccessKey].some(Boolean)) {
    if(!/^[a-f0-9]{32}$/.test(account)||!bucket||!accessKeyId||!secretAccessKey)throw new VideoMediaError('r2_upload','r2_configuration_unavailable');
    return {account,bucket,accessKeyId,secretAccessKey};
  }
  const legacyAccount=config.CLIPMENTOR_R2_ACCOUNT_ID??'',legacyBucket=config.CLIPMENTOR_R2_BUCKET??'',token=config.CLIPMENTOR_R2_API_TOKEN??'';
  if(!/^[a-f0-9]{32}$/.test(legacyAccount)||!legacyBucket||!token||/[\r\n]/.test(token))throw new VideoMediaError('r2_upload','r2_configuration_unavailable');
  const identity=createHash('sha256').update(JSON.stringify([legacyAccount,legacyBucket,token])).digest('hex');
  if(legacyCredentials?.identity!==identity) {
    const dispatcher=proxyDispatcher();
    if(outboundProxyUrl()&&!dispatcher)throw new VideoMediaError('r2_upload','invalid_proxy_configuration');
    const controller=new AbortController();
    const value=(async()=>{
      try {
        const response=await verify('https://api.cloudflare.com/client/v4/user/tokens/verify',{
          headers:{Authorization:`Bearer ${token}`},redirect:'error',dispatcher,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30_000)])} as RequestInit);
        const body=await response.json() as any;
        if(!response.ok||body?.success!==true||body?.result?.status!=='active'||!/^[a-f0-9]{32}$/.test(body?.result?.id??''))throw Error('Invalid credential verification');
        return {account:legacyAccount,bucket:legacyBucket,accessKeyId:body.result.id,secretAccessKey:createHash('sha256').update(token).digest('hex')};
      }catch {throw new VideoMediaError('r2_upload','r2_credential_verification_failed');}
    })();
    const entry:CredentialVerification={identity,value,controller,waiters:0,settled:false};
    legacyCredentials=entry;
    void value.then(()=>{entry.settled=true;},()=>{entry.settled=true;if(legacyCredentials===entry)legacyCredentials=undefined;});
  }
  const entry=legacyCredentials!;entry.waiters++;
  try {
    return await new Promise<R2Credentials>((resolve,reject)=>{
      const abort=()=>{signal.removeEventListener('abort',abort);reject(new VideoMediaError('r2_upload','aborted'));};
      signal.addEventListener('abort',abort,{once:true});
      entry.value.then(value=>{signal.removeEventListener('abort',abort);if(signal.aborted)abort();else resolve(value);},
        error=>{signal.removeEventListener('abort',abort);reject(error);});
      if(signal.aborted)abort();
    });
  } finally {
    entry.waiters--;
    if(!entry.settled&&entry.waiters===0){if(legacyCredentials===entry)legacyCredentials=undefined;entry.controller.abort();}
  }
}

async function configuredStore(signal:AbortSignal):Promise<VideoObjectStore> {
  // Reuse this product's server keystore, not another repository's credentials. Unlike the generic unnamespaced
  // uploads store, this namespace includes the runtime profile and bucket; isolated profiles cannot share objects.
  if(getKey('R2_ENABLED')==='0')throw new VideoMediaError('r2_upload','r2_configuration_unavailable');
  const config=()=>({R2_ACCOUNT_ID:getKey('R2_ACCOUNT_ID'),R2_ACCESS_KEY_ID:getKey('R2_ACCESS_KEY_ID'),R2_SECRET_ACCESS_KEY:getKey('R2_SECRET_ACCESS_KEY'),R2_BUCKET:getKey('R2_BUCKET'),
    CLIPMENTOR_R2_ACCOUNT_ID:getKey('CLIPMENTOR_R2_ACCOUNT_ID'),CLIPMENTOR_R2_BUCKET:getKey('CLIPMENTOR_R2_BUCKET'),CLIPMENTOR_R2_API_TOKEN:getKey('CLIPMENTOR_R2_API_TOKEN')});
  const frozen=config(),{account,accessKeyId,secretAccessKey,bucket}=await resolveVideoR2Credentials(frozen,signal);
  if(getKey('R2_ENABLED')==='0'||JSON.stringify(config())!==JSON.stringify(frozen))throw new VideoMediaError('r2_upload','r2_configuration_changed');
  const agent=outboundHttpAgent();
  if(outboundProxyUrl()&&!agent)throw new VideoMediaError('r2_upload','invalid_proxy_configuration');
  const client=new S3Client({region:'auto',endpoint:`https://${account}.r2.cloudflarestorage.com`,credentials:{accessKeyId,secretAccessKey},
    forcePathStyle:true,maxAttempts:1,requestHandler:new NodeHttpHandler({...(agent?{httpsAgent:agent}:{}),connectionTimeout:30_000,requestTimeout:60_000})});
  const send=async(command:HeadObjectCommand|GetObjectCommand|CreateMultipartUploadCommand|ListPartsCommand|ListMultipartUploadsCommand|UploadPartCommand|CompleteMultipartUploadCommand,signal:AbortSignal):Promise<any>=>client.send(command as any,{abortSignal:signal});
  return {
    identity:JSON.stringify([account,bucket]),
    head:async(key,signal)=>{try {const h=await send(new HeadObjectCommand({Bucket:bucket,Key:key}),signal);return {bytes:h.ContentLength,etag:h.ETag};}catch(e){if(missing(e))return null;throw e;}},
    pending:async(key,signal)=>{const r=await send(new ListMultipartUploadsCommand({Bucket:bucket,Prefix:key}),signal);if(r.IsTruncated)throw Error('Pending uploads ambiguous');return (r.Uploads??[]).filter((u:any)=>u.Key===key).map((u:any)=>u.UploadId);},
    create:async(key,signal)=>{const r=await send(new CreateMultipartUploadCommand({Bucket:bucket,Key:key,ContentType:'video/mp4'}),signal);if(!r.UploadId)throw Error('Upload ID missing');return r.UploadId;},
    list:async(key,upload,signal)=>{const r=await send(new ListPartsCommand({Bucket:bucket,Key:key,UploadId:upload}),signal);if(r.IsTruncated)throw Error('Unexpected part pagination');return (r.Parts??[]).map((p:any)=>({number:p.PartNumber,etag:p.ETag,bytes:p.Size}));},
    part:async(key,upload,number,body,bytes,signal)=>{const r=await send(new UploadPartCommand({Bucket:bucket,Key:key,UploadId:upload,PartNumber:number,Body:body,ContentLength:bytes}),signal);return r.ETag;},
    complete:async(key,upload,parts,signal)=>{await send(new CompleteMultipartUploadCommand({Bucket:bucket,Key:key,UploadId:upload,MultipartUpload:{Parts:parts.map(p=>({PartNumber:p.number,ETag:p.etag}))}}),signal);},
    get:async(key,etag,signal)=>(await send(new GetObjectCommand({Bucket:bucket,Key:key,IfMatch:etag}),signal)).Body,
    sign:key=>getSignedUrl(client,new GetObjectCommand({Bucket:bucket,Key:key}),{expiresIn:3600}),
  };
}

/** Default pre-dispatch R2 selection within the tested admission; no fallback after failure. */
export async function prepareVideoMedia(file:string,sha256:string,signal:AbortSignal):Promise<PreparedVideo> {
  signal.throwIfAborted();
  const mode=getKey('CLIPMENTOR_VIDEO_TRANSPORT')||'r2-small';
  if(mode!=='inline'&&mode!=='r2-small')throw new VideoMediaError('local_read','invalid_transport_configuration');
  // Select before dispatch: large files retain the already bounded inline route. This is not a failure fallback.
  const bytesInFile=(await stat(file)).size;
  if(bytesInFile<=0||4*Math.ceil(bytesInFile/3)>VIDEO_REQUEST_MAX_BYTES)throw new VideoMediaError('local_read','inline_size_limit');
  if(mode==='r2-small'&&bytesInFile<=VIDEO_URL_MAX_BYTES)return prepareR2Video({file,sha256,signal,store:await configuredStore(signal),
    directory:join(runtimeProfile().rootDir,'clipmentor-video-media'),namespace:runtimeProfile().id});
  const bytes=await readFile(file);signal.throwIfAborted();const media=videoInput(bytes);
  if(media.sha256!==sha256)throw new VideoMediaError('local_read','source_hash_mismatch');
  return media;
}
