import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourceVideoTransportDiagnostic as Diagnostic } from '../../shared/clipmentor-source-video';
import { safeSourceTransportDiagnostic } from '../../shared/clipmentor-source-video';
export { safeSourceTransportDiagnostic } from '../../shared/clipmentor-source-video';
import { PREVIEW_REVIEW_ENDPOINT } from './preview-review';

const METRICS = ['size_upload','size_download','time_namelookup','time_connect','time_appconnect','time_pretransfer','time_starttransfer','time_total'] as const;
const IDS = ['x-oneapi-request-id','x-request-id','cf-ray'] as const;
const TYPES = ['upstream_error','timeout','gateway_timeout','rate_limit_error','invalid_request_error','authentication_error','server_error'] as const;
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const status = (v: unknown): v is number => Number.isInteger(v) && Number(v) >= 100 && Number(v) <= 599;
const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

export class SourceVideoTransportError extends Error {
  readonly diagnostic: Diagnostic;
  constructor(diagnostic: Diagnostic) { super('Source transport failed; retain operation and read diagnostic, no retry'); this.diagnostic=diagnostic; }
}

async function prefix(file: string, limit: number) {
  try {
    const handle=await open(file,'r');
    try {const info=await handle.stat(),buffer=Buffer.alloc(Math.min(info.size,limit));const {bytesRead}=await handle.read(buffer,0,buffer.length,0);
      return {data:buffer.subarray(0,bytesRead),bytes:info.size,truncated:info.size>bytesRead};
    } finally {await handle.close();}
  } catch (e) {return {data:Buffer.alloc(0),bytes:0,truncated:false,unavailable:(e as NodeJS.ErrnoException).code==='ENOENT'?'missing':'unreadable'};}
}
function bodySummary(p: Awaited<ReturnType<typeof prefix>>, httpStatus:number|null): Diagnostic['response_body'] {
  const text=p.data.toString('utf8');let value:unknown;
  try {value=JSON.parse(text);} catch { /* Prose stays ephemeral. */ }
  const error=obj(value)&&obj(value.error)?value.error:null;
  const errorText=error && typeof error.message==='string'?error.message:(httpStatus!==null && httpStatus>=400?text:'');
  const result: Diagnostic['response_body']={format:p.unavailable as 'missing'|'unreadable'||(value!==undefined?'json':/^\s*</.test(text)?'html':'text'),
    bytes:p.bytes,inspected_bytes:p.data.length,truncated:p.truncated,
    message_class:!errorText?'none':/timeout|timed out|deadline exceeded/i.test(errorText)?'timeout':/rate.limit|too many requests/i.test(errorText)?'rate_limit':
      /unauthori[sz]ed|authentication|invalid.api.key/i.test(errorText)?'authentication':/invalid.argument|invalid.request/i.test(errorText)?'invalid_argument':'other'};
  if (p.data.length) result.prefix_sha256=createHash('sha256').update(p.data).digest('hex');
  if(error && status(error.code)) result.error_code=error.code;
  if(error && TYPES.includes(error.type)) result.error_type=error.type;
  return result;
}

/** Same fixed endpoint, inline request, timeouts and zero retries. Injection is for offline process tests only. */
export async function postSourceVideoTransport(body: string, key: string, signal: AbortSignal, operationId: string,
  runtimeRoot: string, launch: typeof spawn = spawn, cleanup: typeof rm = rm): Promise<{status:number;body:unknown;diagnostic:Diagnostic}> {
  signal.throwIfAborted();
  // Let curl finish reporting transfer metrics before the outer 600s deadline.
  const directory=await mkdtemp(join(runtimeRoot,'source-video-'));
  let capturedDiagnostic:Diagnostic|undefined;
  try {
    const request=join(directory,'request.json'),response=join(directory,'response.json'),headers=join(directory,'headers.txt');
    await writeFile(request,body,{mode:0o600});
    const started=new Date().toISOString();let output='',spawnFailed=false;
    const result=await new Promise<{exit:number|null}>((resolve)=>{
      let child:ReturnType<typeof spawn>;
      try {child=launch('curl',['--disable','-sS','--http1.1','--noproxy','*','--proto','=https','--max-redirs','0','--retry','0','--connect-timeout','30','--max-time','595','--max-filesize','1048576',
        '-H','@-','-H','Content-Type: application/json','-H',`Idempotency-Key: ${operationId}`,'--data-binary',`@${request}`,
        '--dump-header',headers,'--output',response,'--write-out',`{"http_code":%{http_code},${METRICS.map(k=>`"${k}":%{${k}}`).join(',')}}`,PREVIEW_REVIEW_ENDPOINT],
        {stdio:['pipe','pipe','ignore'],signal});}
      catch {spawnFailed=true;resolve({exit:null});return;}
      child.stdout?.on('data',chunk=>{if(output.length<4096) output+=String(chunk).slice(0,4096-output.length);});
      child.on('error',()=>{spawnFailed=true;});
      child.on('close',exit=>resolve({exit}));
      child.stdin?.on('error',()=>undefined);child.stdin?.end(`Authorization: Bearer ${key}\n`);
    });
    // curl emits 000 with no HTTP response; JSON numbers cannot have leading zeros.
    let parsed:any;try {parsed=JSON.parse(output.replace(/"http_code":000/, '"http_code":0'));}catch { /* Missing metrics are explicit. */ }
    const code=obj(parsed)&&status(parsed.http_code)?parsed.http_code:null;
    const metrics:Diagnostic['metrics']={};for(const name of METRICS)if(obj(parsed)&&number(parsed[name]))metrics[name]=parsed[name];
    const h=await prefix(headers,65536),r=await prefix(response,16384),ids:Diagnostic['request_ids']={};
    let finalHeaderBlock=false;
    for(const line of h.data.toString('utf8').split(/\r?\n/)) {
      const headerStatus=/^HTTP\/\S+\s+(\d{3})/.exec(line);
      if(headerStatus) {for(const name of IDS)delete ids[name];finalHeaderBlock=!h.truncated && Number(headerStatus[1])===code && Number(headerStatus[1])>=200;continue;}
      if(!line.trim()){finalHeaderBlock=false;continue;}
      if(!finalHeaderBlock)continue;
      const at=line.indexOf(':');if(at<0)continue;const name=line.slice(0,at).toLowerCase();
      if(IDS.includes(name as typeof IDS[number])) ids[name as typeof IDS[number]]=line.slice(at+1).trim();
    }
    const diagnostic=safeSourceTransportDiagnostic({version:'source-transport-v1',operation_id:operationId,started_at:started,ended_at:new Date().toISOString(),
      request_bytes:Buffer.byteLength(body),curl_exit_code:result.exit,error_kind:signal.aborted?'aborted':spawnFailed?'spawn_failed':
        result.exit===28?'curl_timeout':result.exit!==0?'curl_failed':!code?'invalid_metrics':'none',http_status:code,metrics,request_ids:ids,response_body:bodySummary(r,code)},key,operationId)!;
    capturedDiagnostic=diagnostic;
    if(result.exit!==0 || !code || signal.aborted || spawnFailed)throw new SourceVideoTransportError(diagnostic);
    let value:unknown=null;
    if(code===200) {try {const full=await prefix(response,1048576);if(!full.truncated && !full.unavailable)value=JSON.parse(full.data.toString('utf8'));}catch { /* Existing caller validates response. */ }}
    return {status:code,body:value,diagnostic};
  } finally {
    try {await cleanup(directory,{recursive:true,force:true});if(capturedDiagnostic)capturedDiagnostic.cleanup_status='completed';}
    catch {if(capturedDiagnostic)capturedDiagnostic.cleanup_status='failed';}
  }
}
