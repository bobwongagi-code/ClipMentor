import {waitDistribution} from './external-call-statistics.ts';
import {createHash, randomUUID} from 'node:crypto';
import {appendFile, mkdir, open, readFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {atomicWriteFile, syncDirectory} from '../plugins/project-store-durable.ts';

/** Internal transport facts, never production approval. Identity must include scope,
 * question/configuration/schema, not just a media hash. Unknown submissions are not replayed. */
export const EXTERNAL_DEADLINES = {text:120_000, voice:120_000, asr:120_000, review:600_000, video:600_000, export:600_000, download:120_000} as const;
export type ExternalKind = keyof typeof EXTERNAL_DEADLINES;
export type FailureClass = 'configuration'|'rate_limit'|'remote'|'transport_unknown'|'deadline_unknown'|'cancelled_unknown'|'local_validation'|'local_storage'|'local_preflight';
export class ExternalHttpError extends Error {
  readonly status:number;
  constructor(status:number) {super(`external_http_${status}`);this.status=status;}
}
export class ExternalCallError extends Error {
  readonly code:string;readonly classification:FailureClass;readonly record:string;
  constructor(code:string,classification:FailureClass,record:string) {super(code);this.code=code;this.classification=classification;this.record=record;}
}
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function decodeEnvelope(raw:string,inputHash:string,responseHash?:string):unknown{
 if(responseHash&&hash(raw)!==responseHash)throw Error('external_saved_result_invalid');
 const value=JSON.parse(raw);
 if(!object(value)||value.input_sha256!==inputHash||!Object.hasOwn(value,'value')||value.value_sha256!==hash(JSON.stringify(value.value)))throw Error('external_saved_result_invalid');
 return value.value;
}

export function externalFailure(error:unknown, aborted?:'deadline'|'cancelled'):FailureClass {
  if(aborted)return aborted==='deadline'?'deadline_unknown':'cancelled_unknown';
  if(error instanceof ExternalHttpError)return error.status===429?'rate_limit':error.status>=500?'remote':'configuration';
  return 'transport_unknown';
}
export function externalRecovery(kind:FailureClass):'repair_local'|'stop_configuration'|'lookup_result' {
  return kind==='local_validation'||kind==='local_storage'||kind==='local_preflight'?'repair_local':kind==='configuration'?'stop_configuration':'lookup_result';
}
interface RecordRow {
  version:1; request_id:string; input_sha256:string; kind:ExternalKind; purpose:string;
  started_at:string; deadline_at:string; status:'pending'|'returned'|'used'|'failed'|'unknown';
  attempts:number; response_sha256?:string; ended_at?:string; elapsed_ms?:number; response_elapsed_ms?:number; late_response?:boolean;
  failure?:FailureClass; recovery?:ReturnType<typeof externalRecovery>; http_status?:number;
  capability_key?:string;
}
interface CallOptions<T,R> {
  directory:string; kind:ExternalKind; purpose:string; identity:unknown;
  requestId?:string; capability?:unknown; signal?:AbortSignal; readOnly?:boolean; preserveErrors?:boolean; preflight?:()=>Promise<void>;
  execute:(signal:AbortSignal)=>Promise<T>; consume?:(value:T)=>Promise<R>|R;
  /** Offline verification only: production uses the per-kind policy. */
  timeoutMs?:number; maxResponseBytes?:number;
}
/** A received response is committed before the adapter parses or validates it.
 * Cross-process exclusive reservation prevents a second submission after a crash.
 * There is deliberately no provider retry or route fallback in this primitive. */
export async function externalCall<T,R=T>(o:CallOptions<T,R>):Promise<R> {
  const inputHash=hash(JSON.stringify({version:1,kind:o.kind,purpose:o.purpose,identity:o.identity}));
  const directory=join(o.directory,'external-calls');
  const file=join(directory,`${inputHash}.json`), rawFile=join(directory,`${inputHash}.response`);
  const timeout=o.timeoutMs??EXTERNAL_DEADLINES[o.kind];
  if(!Number.isFinite(timeout)||timeout<=0||timeout>EXTERNAL_DEADLINES[o.kind])throw Error('external_deadline_invalid');
  o.signal?.throwIfAborted();
  await mkdir(directory,{recursive:true,mode:0o700});await syncDirectory(o.directory);
  let row:RecordRow={version:1,request_id:o.requestId??randomUUID(),input_sha256:inputHash,kind:o.kind,purpose:o.purpose,
    started_at:new Date().toISOString(),deadline_at:new Date(Date.now()+timeout).toISOString(),status:'pending',attempts:1,
    ...(o.capability?{capability_key:hash(JSON.stringify(o.capability))}:{})};
  const checkPreflight=()=>{o.signal?.throwIfAborted();if(Date.now()>=Date.parse(row.deadline_at))throw new ExternalCallError('external_deadline_before_submission','local_preflight',file);};
  const event=(event:string)=>appendFile(join(directory,`${inputHash}.events`),JSON.stringify({event,at:Date.now()})+'\n',{mode:0o600}).catch(()=>{console.warn('[clipmentor] external call telemetry unavailable');});
  const bindAlias=async()=>{if(!o.requestId)return;
    const alias=join(directory,`request-${hash(o.requestId)}.json`);
    try{
      const h=await open(alias,'wx',0o600);
      try{await h.writeFile(JSON.stringify({version:1,request_id:o.requestId,input_sha256:inputHash}));await h.sync();}finally{await h.close();}
      await syncDirectory(directory);
    }catch(e){
      if((e as NodeJS.ErrnoException).code!=='EEXIST')throw new ExternalCallError('external_alias_write_failed','local_storage',file);
      const v=JSON.parse(await readFile(alias,'utf8'));
      if(v.version!==1||v.request_id!==o.requestId||v.input_sha256!==inputHash)throw new ExternalCallError('external_request_id_conflict','local_validation',file);
    }
  };
  let reused=false, value:T;
  try {
    // Read existing reservations before capability preflight; a cached remote outage
    // must not hide an already-paid result. wx below remains the cross-process claim.
    const existing=await readFile(file,'utf8').then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
    if(existing)throw Object.assign(new Error(),{code:'EEXIST'});
    if(o.readOnly)throw new ExternalCallError('external_saved_result_missing','local_storage',file);
    await o.preflight?.();checkPreflight();
    await bindAlias();checkPreflight();
    const handle=await open(file,'wx',0o600);
    try{await handle.writeFile(JSON.stringify(row));await handle.sync();}finally{await handle.close();}
    await syncDirectory(directory);
  }
  catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST'){if(error instanceof ExternalCallError)throw error;if(o.signal?.aborted)throw new ExternalCallError('external_cancelled_before_submission','cancelled_unknown',file);throw new ExternalCallError('external_record_unavailable','local_storage',file);}
    let raw:string;
    try {
      row=JSON.parse(await readFile(file,'utf8'));
      if(row.version!==1||row.input_sha256!==inputHash)throw Error();
      try{raw=await readFile(rawFile,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT'){await event('duplicate_prevented');throw new ExternalCallError('external_result_pending_or_unknown',row.failure??'transport_unknown',file);}throw e;}
      value=decodeEnvelope(raw,inputHash,row.response_sha256) as T;
      // Crash after response commit but before its ledger link: recover locally.
      row={...row,response_sha256:hash(raw),status:'returned'};
      await atomicWriteFile(file,JSON.stringify(row));
    }catch(e){if(e instanceof ExternalCallError)throw e;throw new ExternalCallError('external_saved_result_invalid','local_storage',file);}
    reused=true;await event('raw_reused');
  }
  if(reused)await bindAlias();
  if(!reused){
    let writes=Promise.resolve();
    const persist=(update:(v:RecordRow)=>RecordRow)=>{writes=writes.then(async()=>{row=update(row);await atomicWriteFile(file,JSON.stringify(row));});return writes;};
    let stopElapsed:number|undefined;
    const controller=new AbortController();let reason:'deadline'|'cancelled'|undefined;
    let rejectBoundary!:(e:unknown)=>void;
    const boundary=new Promise<never>((_,reject)=>{rejectBoundary=reject;});
    const abort=(why:'deadline'|'cancelled')=>{if(reason)return;reason=why;stopElapsed=Date.now()-Date.parse(row.started_at);controller.abort();rejectBoundary(new ExternalCallError(`external_${why}`,externalFailure(null,why),file));};
    const onAbort=()=>abort('cancelled');o.signal?.addEventListener('abort',onAbort,{once:true});
    const remaining=Math.max(0,Date.parse(row.deadline_at)-Date.now());
    const timer=setTimeout(()=>abort('deadline'),remaining);
    if(remaining===0)abort('deadline');
    if(o.signal?.aborted)onAbort();
    // The deadline also bounds non-cooperative transports. A late reply is archived,
    // but never delivered to the timed-out caller or used to write its project.
    const work=(async()=>{
      controller.signal.throwIfAborted();
      const result=await o.execute(controller.signal);
      const raw=JSON.stringify({input_sha256:inputHash,value_sha256:hash(JSON.stringify(result)),value:result});
      if(typeof raw!=='string'||Buffer.byteLength(raw)>(o.maxResponseBytes??2_000_000))throw new ExternalCallError('external_response_size_invalid','local_validation',file);
      try{await atomicWriteFile(rawFile,raw);}catch{throw new ExternalCallError('external_archive_write_failed','local_storage',file);}
      await persist(current=>({...current,status:'returned',response_sha256:hash(raw),ended_at:new Date().toISOString(),elapsed_ms:stopElapsed??Date.now()-Date.parse(current.started_at),response_elapsed_ms:Date.now()-Date.parse(current.started_at),
        ...(reason?{late_response:true,failure:externalFailure(null,reason),recovery:'lookup_result' as const}:{})}));
      return result;
    })();
    try {value=await Promise.race([work,boundary]);if(Date.now()>=Date.parse(row.deadline_at))abort('deadline');if(reason)throw new ExternalCallError(`external_${reason}`,externalFailure(null,reason),file);}
    catch(error){
      // Never overwrite a received raw response with a generic failure.
      const failure=error instanceof ExternalCallError?error.classification:externalFailure(error,reason);
      const saving=persist(current=>current.response_sha256?current:{...current,status:reason||failure==='transport_unknown'?'unknown':'failed',failure,recovery:externalRecovery(failure),
        ended_at:new Date().toISOString(),elapsed_ms:stopElapsed??Date.now()-Date.parse(current.started_at)});
      if(reason)void saving.catch(()=>undefined);else await saving;
      // An already-expired boundary can abort before work starts; its immediate
      // AbortError may win Promise.race. Preserve the authoritative stop reason.
      if(reason)throw new ExternalCallError(`external_${reason}`,failure,file);
      throw error instanceof ExternalCallError||o.preserveErrors?error:new ExternalCallError('external_request_failed',failure,file);
    }finally{clearTimeout(timer);o.signal?.removeEventListener('abort',onAbort);}
  }
  let result:R;
  try {
    o.signal?.throwIfAborted();
    result=o.consume?await o.consume(value!):value! as unknown as R;
  }catch(error){
    const failure=error instanceof ExternalHttpError?externalFailure(error):'local_validation';
    row={...row,failure,recovery:externalRecovery(failure),...(error instanceof ExternalHttpError?{http_status:error.status}:{})};
    await atomicWriteFile(file,JSON.stringify(row));
    throw error;
  }
  row={...row,status:'used'};
  try{await atomicWriteFile(file,JSON.stringify(row));}catch{throw new ExternalCallError('external_consumption_record_failed','local_storage',file);}
  return result;
}

/** No paid probes: learn endpoint/protocol capability only from actual responses.
 * 5xx/latency is not evidence that a model or protocol is unsupported. */
export async function recordExternalCapability(directory:string,identity:unknown,status:number) {
  if(status!==200&&![404,405,415,501].includes(status))return;
  const dir=join(directory,'external-capabilities');await mkdir(dir,{recursive:true,mode:0o700});
  await atomicWriteFile(join(dir,`${hash(JSON.stringify(identity))}.json`),JSON.stringify({version:1,
    transport_status:status===200?'responded':'unsupported',http_status:status,checked_at:Date.now(),expires_at:Date.now()+600_000}));
}
export async function readExternalCapability(directory:string,identity:unknown,now=Date.now()) {
  try{const v=JSON.parse(await readFile(join(directory,'external-capabilities',`${hash(JSON.stringify(identity))}.json`),'utf8'));
    return object(v)&&v.version===1&&v.expires_at>now?v:undefined;
  }catch{return undefined;}
}
export async function summarizeExternalCalls(directory:string) {
  const rows:RecordRow[]=[];let unreadable=0,reused=0,prevented=0;const dir=join(directory,'external-calls');
  const files=await readdir(dir).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
  for(const name of files.filter(n=>/^[a-f0-9]{64}\.json$/.test(n))){try{const r=JSON.parse(await readFile(join(dir,name),'utf8'));if(r.version===1&&/^[a-f0-9]{64}$/.test(r.input_sha256)&&r.kind in EXTERNAL_DEADLINES&&r.attempts===1&&['pending','returned','used','failed','unknown'].includes(r.status))rows.push(r);else unreadable++;}catch{unreadable++;}}
  for(const name of files.filter(n=>/^[a-f0-9]{64}\.events$/.test(n))){let body:string;try{body=await readFile(join(dir,name),'utf8');}catch{unreadable++;continue;}for(const line of body.trim().split('\n')){try{const e=JSON.parse(line);if(e.event==='raw_reused')reused++;if(e.event==='duplicate_prevented')prevented++;}catch{unreadable++;}}}
  return {records:rows.length,raw_reuses:reused,duplicate_submissions_prevented:prevented,unreadable_records:unreadable,attempts:rows.reduce((n,r)=>n+r.attempts,0),unknown:rows.filter(r=>r.status==='unknown').length,pending:rows.filter(r=>r.status==='pending').length,overdue_pending:rows.filter(r=>r.status==='pending'&&Date.parse(r.deadline_at)<Date.now()).length,
    late_responses:rows.filter(r=>r.late_response).length,local_failures:rows.filter(r=>r.failure==='local_validation'||r.failure==='local_storage').length,
    waiting_distribution:waitDistribution(rows.map(r=>r.elapsed_ms)),
    waiting_ms:rows.reduce((n,r)=>n+(Number.isFinite(r.elapsed_ms)?r.elapsed_ms!:0),0),
    by_kind:Object.fromEntries(Object.keys(EXTERNAL_DEADLINES).map(kind=>[kind,{records:rows.filter(r=>r.kind===kind).length,waiting_distribution:waitDistribution(rows.filter(r=>r.kind===kind).map(r=>r.elapsed_ms)),waiting_ms:rows.filter(r=>r.kind===kind).reduce((n,r)=>n+(Number.isFinite(r.elapsed_ms)?r.elapsed_ms!:0),0)}])),
    failures:Object.fromEntries([...new Set(rows.flatMap(r=>r.failure?[r.failure]:[]))].map(k=>[k,rows.filter(r=>r.failure===k).length])),
    note:'Waiting is measured, not all avoidable waste; used means adapter consumed, never content approval.'};
}

/** Read one saved response by its original request ID. No reservation, execution or approval. */
export async function readSavedExternalResponse(directory:string,requestId:string,limits?:{maxBytes:number;maxRecords:number}):Promise<unknown|undefined>{
  const dir=join(directory,'external-calls');let found:unknown,matched=false;
  if(limits&&(!Number.isSafeInteger(limits.maxBytes)||limits.maxBytes<1||!Number.isSafeInteger(limits.maxRecords)||limits.maxRecords<1))throw Error('external_read_limit_invalid');
  const read=async(file:string)=>{
    if(!limits)return readFile(file,'utf8');
    const handle=await open(file,'r');
    try{const info=await handle.stat();if(!info.isFile()||info.size>limits.maxBytes)throw Error('external_saved_result_oversized');
      const bytes=Buffer.alloc(Math.min(info.size+1,limits.maxBytes+1));let total=0;
      while(total<bytes.length){const n=await handle.read(bytes,total,bytes.length-total,null);if(!n.bytesRead)break;total+=n.bytesRead;}
      if(total>limits.maxBytes||total>info.size)throw Error('external_saved_result_oversized');return bytes.subarray(0,total).toString('utf8');
    }finally{await handle.close();}
  };
  const alias=await read(join(dir,`request-${hash(requestId)}.json`)).catch(e=>{if(e.code==='ENOENT')return undefined;throw e;});
  if(alias!==undefined){
    const binding=JSON.parse(alias);
    if(binding.version!==1||binding.request_id!==requestId||!/^[a-f0-9]{64}$/.test(binding.input_sha256))throw Error('external_saved_result_invalid');
    const row=JSON.parse(await read(join(dir,`${binding.input_sha256}.json`)));
    const raw=await read(join(dir,`${binding.input_sha256}.response`)).catch(e=>{if(e.code==='ENOENT')return undefined;throw e;});
    if(raw===undefined)return undefined;
    if(row.version!==1||row.input_sha256!==binding.input_sha256)throw Error('external_saved_result_invalid');
    return decodeEnvelope(raw,binding.input_sha256,row.response_sha256);
  }

  const names=await readdir(dir).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
  if(limits&&names.length>limits.maxRecords)throw Error('external_saved_records_overflow');
  for(const name of names){
    if(!/^[a-f0-9]{64}\.json$/.test(name))continue;
    let row;try{row=JSON.parse(await read(join(dir,name)));}catch{continue;}
    if(!row||row.request_id!==requestId)continue;
    if(matched)throw Error('external_saved_identity_ambiguous');matched=true;
    const raw=await read(join(dir,name.replace('.json','.response'))).catch(e=>{if(e.code==='ENOENT')return undefined;throw e;});
    if(raw===undefined)continue;
    if(row.version!==1||row.input_sha256!==name.slice(0,-5))throw Error('external_saved_result_invalid');
    found=decodeEnvelope(raw,row.input_sha256,row.response_sha256);
  }
  return found;
}
