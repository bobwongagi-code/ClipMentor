import {ExternalHttpError,readSavedExternalResponse} from '../clipmentor/external-call.ts';
import {externalFetch} from '../clipmentor/external-fetch.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { editorCredentialAuthorized } from '../editor-auth.ts';
import { getKey } from '../keystore.ts';
import { resolveUploadFile, isSafeUploadName } from '../media-dir.ts';
import { runtimeProfile } from '../runtime-profile.ts';
import { ffmpegBin, ffprobeBin } from '../media-binaries.ts';
import { spawnMediaProcess, ffmpegThreadArgs } from '../media-process.ts';
import { atomicWriteFile } from './project-store-durable.ts';
import { sha256File } from '../../shared/node-content-hash.ts';
import { ASR_AUDIO, ASR_MAX_BYTES, FUNASR_MODEL, isSourceTranscription, planAsrChunks, stitchAsrChunks } from '../../shared/clipmentor-asr.ts';
import type { SourceAsrRead, SourceTranscription, SourceWord } from '../../shared/clipmentor-asr.ts';

interface SourceRequest {
  src: string; expectedSourceHash?: string; sourceSize?: number;
  language: string; operationId: string; maxRequests: number; projectId?:string;
}
interface Dependencies {
  key(): string;
  endpoint(): string;
  resolve(name: string): string | null;
  hash(file: string): Promise<string>;
  probe(file: string): Promise<{ duration: number; fps: number; bytes: number }>;
  encode(file: string, start: number, end: number, output: string): Promise<Uint8Array>;
  fetch: typeof fetch;
  directory: string;
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function parseRequest(v: unknown): SourceRequest {
  if (!object(v) || typeof v.src !== 'string' || !/^\/media\/uploads\/[^/?#]+$/.test(v.src)
    || typeof v.operationId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v.operationId)
    || typeof v.language !== 'string' || !/^(auto|[a-z]{2,3})$/.test(v.language)
    || !Number.isSafeInteger(v.maxRequests) || Number(v.maxRequests) < 1 || Number(v.maxRequests) > 100
    || (v.projectId!==undefined&&(typeof v.projectId!=='string'||!/^[\w:-]{1,160}$/.test(v.projectId)))
    || (v.expectedSourceHash !== undefined && !sha(v.expectedSourceHash))
    || (v.sourceSize !== undefined && (!Number.isSafeInteger(v.sourceSize) || Number(v.sourceSize) <= 0))) throw new Error('Invalid source transcription request');
  const name = decodeURIComponent(v.src.slice('/media/uploads/'.length));
  if (!isSafeUploadName(name) || /\.(normalized|proxy|asr)\./i.test(name)) throw new Error('Original uploaded master required; derivatives are not source identity');
  return v as unknown as SourceRequest;
}

/** Provider words stay untouched except for ms→seconds and the declared chunk offset. */
export function parseFunAsrResponse(value: unknown, offset: number): { words: SourceWord[]; language: string | null; requestId?: string; separators: number } {
  if (!object(value) || value.code || !object(value.output)) throw new Error('Invalid Fun-ASR response');
  const output = object(value.output.output) ? value.output.output : value.output;
  const sentences = Array.isArray(output.sentence) ? output.sentence : object(output.sentence) ? [output.sentence] : [];
  const words: SourceWord[] = [];
  let separators = 0;
  for (const sentence of sentences) {
    if (!object(sentence) || !Array.isArray(sentence.words)) throw new Error('Fun-ASR word timestamps missing');
    for (const word of sentence.words) {
      if (!object(word) || typeof word.text !== 'string') throw new Error('Invalid Fun-ASR word entry');
      if (!word.text.trim()) { separators++; continue; }
      if (typeof word.begin_time !== 'number' || !Number.isFinite(word.begin_time) || word.begin_time < 0
        || typeof word.end_time !== 'number' || !Number.isFinite(word.end_time) || word.end_time < word.begin_time) throw new Error('Invalid Fun-ASR word timestamps');
      words.push({ text: word.text.trim(), start_seconds: offset + word.begin_time / 1000, end_seconds: offset + word.end_time / 1000 });
    }
  }
  if (!words.length) throw new Error('Fun-ASR word timestamps missing');
  const requestId = value.request_id ?? output.request_id;
  return { words, separators, language: typeof output.language === 'string' ? output.language : null,
    ...(typeof requestId === 'string' ? { requestId } : {}) };
}

/** One reserved operation, no automatic retries. Ambiguous prior attempts never replay. */
export async function transcribeClipMentorSource(input: unknown, deps: Dependencies, signal?: AbortSignal): Promise<SourceTranscription> {
  const request = parseRequest(input);
  const key = deps.key(), endpoint = deps.endpoint();
  if (!key) throw new Error('ClipMentor Fun-ASR server credential is not configured');
  if (!/^https:\/\/[a-z0-9-]+\.ap-southeast-1\.maas\.aliyuncs\.com\/api\/v1\/services\/aigc\/multimodal-generation\/generation$/.test(endpoint)) throw new Error('ClipMentor Fun-ASR Singapore endpoint is not configured');
  const file = deps.resolve(decodeURIComponent(request.src.slice('/media/uploads/'.length)));
  if (!file) throw new Error('Original uploaded master is unavailable');
  const sourceHash = await deps.hash(file);
  const metadata = await deps.probe(file);
  if (request.expectedSourceHash ? request.expectedSourceHash !== sourceHash
    : request.sourceSize === undefined || request.sourceSize !== metadata.bytes) throw new Error('Source identity mismatch; original master hash or matching original byte size required');
  if (!Number.isFinite(metadata.duration) || metadata.duration <= 0 || !Number.isFinite(metadata.fps) || metadata.fps <= 0) throw new Error('Valid source duration and frame rate required');
  // Keep legacy submit fingerprints while persisting only the declared, sanitized request identity.
  const fingerprintInput = { ...request, expectedSourceHash: sourceHash };
  const identity = Object.fromEntries(Object.entries(fingerprintInput).filter(([k])=>['src','expectedSourceHash','sourceSize','language','operationId','maxRequests','projectId'].includes(k)));
  const fingerprint = digest(new TextEncoder().encode(JSON.stringify(fingerprintInput)));
  await mkdir(deps.directory, { recursive: true, mode: 0o700 });
  const ledger = join(deps.directory, `${request.operationId}.json`);
  try {
    await writeFile(ledger, JSON.stringify({ fingerprint, identity, status: 'reserved', requests_attempted: 0 }), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Could not reserve transcription operation');
    const prior = JSON.parse(await readFile(ledger, 'utf8')) as { fingerprint: string; result?: SourceTranscription };
    if (prior.fingerprint !== fingerprint) throw new Error('Operation ID already belongs to another source or configuration');
    if (prior.result) return recoverSavedAsr(prior.result,ledger,fingerprint,deps.directory);
    throw new Error('Prior operation is running or outcome unknown; no automatic replay');
  }
  const result: SourceTranscription = {
    schema_version: 1, operation_id: request.operationId, provider: 'fun-asr', model: FUNASR_MODEL,
    requested_language: request.language, detected_language: null, source_hash: sourceHash,
    duration_seconds: metadata.duration, fps: metadata.fps, audio: ASR_AUDIO,
    status: 'failed', requests_attempted: 0, chunks: [], words: [], conflicts: [], issues: [],
  };
  const save = () => atomicWriteFile(ledger, JSON.stringify({ fingerprint, identity, result }));
  const temporary = await mkdtemp(join(deps.directory, 'audio-'));
  try {
    const ranges = planAsrChunks(metadata.duration);
    if (ranges.length > request.maxRequests) throw new Error('Planned chunks exceed request budget');
    // Finish extraction/size subdivision before any chargeable request.
    const encoded: Uint8Array[] = [];
    for (let i = 0; i < ranges.length; i++) {
      signal?.throwIfAborted();
      const [start, end] = ranges[i];
      const bytes = await deps.encode(file, start, end, join(temporary, `${i}.mp3`));
      if (bytes.length > ASR_MAX_BYTES) {
        if (end - start <= 4) throw new Error('Encoded audio exceeds byte limit at minimum chunk length');
        const middle = (start + end) / 2;
        ranges.splice(i, 1, [start, middle + 1], [middle - 1, end]);
        if (ranges.length > request.maxRequests) throw new Error('Size subdivision exceeds request budget');
        i--; continue;
      }
      if (!bytes.length) throw new Error('Audio extraction returned no bytes');
      encoded.push(bytes);
      result.chunks.push({ chunk_id: `chunk-${i + 1}`, offset_seconds: start, end_seconds: end,
        audio_bytes: bytes.length, audio_sha256: digest(bytes), status: 'not_requested', words: [], detected_language: null });
    }
    if (encoded.length > request.maxRequests) throw new Error('Planned chunks exceed the explicitly supplied request budget; no provider request sent');
    if (await deps.hash(file) !== sourceHash) throw new Error('Source changed during extraction');
    for (let i = 0; i < result.chunks.length; i++) {
      signal?.throwIfAborted();
      const chunk = result.chunks[i];
      result.requests_attempted++;
      // Reserve before network I/O: timeouts and crashes count as attempts too.
      await atomicWriteFile(ledger, JSON.stringify({ fingerprint, identity, status: 'request_reserved', requests_attempted: result.requests_attempted }));
      let stage: 'network' | 'http' | 'json' | 'timestamps' = 'network';
      try {
        const response = await externalFetch({directory:deps.directory,kind:'asr',purpose:'fun-asr-chunk-v1',
          scope:{model:FUNASR_MODEL,source:sourceHash,language:request.language,range:[chunk.offset_seconds,chunk.end_seconds]},requestId:`${request.operationId}:${chunk.chunk_id}`,endpoint,fetch:deps.fetch,init:{
          method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-DashScope-SSE': 'disable' },
          body: JSON.stringify({ model: FUNASR_MODEL, input: { messages: [{ role: 'user', content: [{ type: 'input_audio',
            input_audio: { data: `data:audio/mp3;base64,${Buffer.from(encoded[i]).toString('base64')}` } }] }] },
          parameters: { format: 'mp3', sample_rate: '16000', ...(request.language === 'auto' ? {} : { language_hints: [request.language] }) }, resources: [] }),
        }});
        chunk.http_status = response.status; stage = 'http';
        if (!response.ok) throw new Error('Provider HTTP failure');
        stage = 'json'; const body: unknown = await response.json();
        stage = 'timestamps'; const parsed = parseFunAsrResponse(body, chunk.offset_seconds);
        chunk.words = parsed.words; chunk.detected_language = parsed.language; chunk.request_id = parsed.requestId;
        chunk.separator_entries_skipped = parsed.separators;
        chunk.status = 'completed';
      } catch (error) {
        if(error instanceof ExternalHttpError){chunk.http_status=error.status;stage='http';}
        // Never expose upstream bodies, request headers, audio or credential-bearing exceptions.
        chunk.status = 'failed'; chunk.error = 'provider_request_failed_or_invalid_timestamps';
        chunk.failure_stage = stage;
        result.issues.push(`${chunk.chunk_id}:provider_request_failed_or_invalid_timestamps`);
        break;
      }
    }
    if (await deps.hash(file) !== sourceHash) result.issues.push('source_changed_during_transcription');
    settleAsr(result,metadata.duration);
  } catch {
    result.issues.push('extraction_budget_or_operation_failed');
    result.status = result.chunks.some((c) => c.status === 'completed') ? 'partial' : 'failed';
  } finally {
    await save();
    await rm(temporary, { recursive: true, force: true });
  }
  return result;
}

function processOutput(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnMediaProcess(binary, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Media processing timed out')); }, 120_000);
    child.stdout?.on('data', (data: Buffer) => { if (output.length < 1_000_000) output += String(data); });
    child.once('error', () => { clearTimeout(timeout); reject(new Error('Media processing unavailable')); });
    child.once('close', (code) => { clearTimeout(timeout); if (code === 0) resolve(output); else reject(new Error('Media processing failed')); });
  });
}
function settleAsr(result:SourceTranscription,duration:number){
    Object.assign(result, stitchAsrChunks(result.chunks));
    if (result.conflicts.length) result.issues.push('overlap_conflict');
    for (const chunk of result.chunks) {
      if (chunk.words.some((w) => w.end_seconds > chunk.end_seconds || w.start_seconds < chunk.offset_seconds)) result.issues.push(`${chunk.chunk_id}:word_outside_chunk`);
    }
    if (result.words.some((w) => w.end_seconds > duration)) result.issues.push('source_time_out_of_bounds');
    const languages = new Set(result.chunks.flatMap((c) => c.detected_language ? [c.detected_language] : []));
    if (languages.size === 1) result.detected_language = [...languages][0];
    else if (languages.size > 1) result.issues.push('detected_language_disagreement');
    const completed = result.chunks.filter((c) => c.status === 'completed').length;
    result.status = completed === result.chunks.length ? 'completed' : completed ? 'partial' : 'failed';
}
async function recoverSavedAsr(original:SourceTranscription,ledger:string,fingerprint:string,directory:string,readLimits?:{maxBytes:number;maxRecords:number},signal?:AbortSignal){
 if(original.status==='completed')return original;
 const result=structuredClone(original);let recovered=false;
 for(const chunk of result.chunks){
  signal?.throwIfAborted();
  if(chunk.status!=='failed')continue;
  try{
   const saved=await readSavedExternalResponse(directory,`${original.operation_id}:${chunk.chunk_id}`,readLimits);
   if(!object(saved)||saved.status!==200||typeof saved.text!=='string')continue;
   const parsed=parseFunAsrResponse(JSON.parse(saved.text),chunk.offset_seconds);
   chunk.words=parsed.words;chunk.detected_language=parsed.language;chunk.request_id=parsed.requestId;chunk.separator_entries_skipped=parsed.separators;
   chunk.status='completed';delete chunk.error;delete chunk.failure_stage;
   result.issues=result.issues.filter(i=>i!==`${chunk.chunk_id}:provider_request_failed_or_invalid_timestamps`);recovered=true;
  }catch{signal?.throwIfAborted();/* Invalid/missing original remains failed; never regenerate. */}
 }
 signal?.throwIfAborted();
 if(!recovered)return original;
 settleAsr(result,original.duration_seconds);
 if(readLimits&&!validSavedAsr(result))return original;
 const originalText=readLimits?(await readAsrLedger(ledger)).text:await readFile(ledger,'utf8');
 signal?.throwIfAborted();
 await atomicWriteFile(ledger+'.recovered-raw-v1.json',JSON.stringify({fingerprint,original_ledger_sha256:digest(Buffer.from(originalText)),provider_requests_sent:0,result}));
 return result;
}

const READ_LIMITS={maxBytes:2_000_000,maxRecords:512};
function validSavedAsr(value:unknown):value is SourceTranscription{
 if(!isSourceTranscription(value))return false;
 if(new Set(value.chunks.map(c=>c.chunk_id)).size!==value.chunks.length
  ||value.chunks.some(c=>!/^chunk-[1-9][0-9]{0,2}$/.test(c.chunk_id)||c.end_seconds>value.duration_seconds
   ||c.words.some(w=>w.start_seconds<c.offset_seconds||w.end_seconds>c.end_seconds))
  ||value.words.some(w=>w.end_seconds>value.duration_seconds)
  ||value.chunks.filter(c=>c.status!=='not_requested').length!==value.requests_attempted)return false;
 const completed=value.chunks.filter(c=>c.status==='completed').length;
 if(value.status==='completed')return completed>0&&completed===value.chunks.length&&value.words.length>0;
 return value.status==='partial'?completed>0&&completed<value.chunks.length:completed===0;
}
function safeSavedAsr(value:SourceTranscription):SourceTranscription{
 const word=(w:SourceWord)=>({text:w.text,start_seconds:w.start_seconds,end_seconds:w.end_seconds});
 return {schema_version:1,operation_id:value.operation_id,provider:value.provider,model:value.model,
  requested_language:value.requested_language,detected_language:value.detected_language,source_hash:value.source_hash,
  duration_seconds:value.duration_seconds,fps:value.fps,audio:{...ASR_AUDIO},status:value.status,requests_attempted:value.requests_attempted,
  chunks:value.chunks.map(c=>({chunk_id:c.chunk_id,offset_seconds:c.offset_seconds,end_seconds:c.end_seconds,status:c.status,
   audio_bytes:c.audio_bytes,audio_sha256:c.audio_sha256,words:c.words.map(word),detected_language:c.detected_language,
   ...(c.request_id===undefined?{}:{request_id:c.request_id}),...(c.http_status===undefined?{}:{http_status:c.http_status}),
   ...(c.failure_stage===undefined?{}:{failure_stage:c.failure_stage}),...(c.separator_entries_skipped===undefined?{}:{separator_entries_skipped:c.separator_entries_skipped}),
   ...(c.error?{error:'provider_request_failed_or_invalid_timestamps'}:{})})),words:value.words.map(word),
  conflicts:value.conflicts.map(c=>({range_seconds:[...c.range_seconds],chunk_ids:[...c.chunk_ids]})),
  issues:value.issues.map(i=>/^(?:overlap_conflict|source_time_out_of_bounds|detected_language_disagreement|extraction_budget_or_operation_failed|source_changed_during_transcription|chunk-[1-9][0-9]{0,2}:(?:word_outside_chunk|provider_request_failed_or_invalid_timestamps))$/.test(i)?i:'unrecognized_saved_issue')};
}

async function readAsrLedger(file:string){
 const handle=await open(file,'r');
 try{const info=await handle.stat();if(!info.isFile()||info.size>READ_LIMITS.maxBytes)throw Error('Invalid saved ASR');
  const bytes=Buffer.alloc(Math.min(info.size+1,READ_LIMITS.maxBytes+1));let total=0;
  while(total<bytes.length){const n=await handle.read(bytes,total,bytes.length-total,null);if(!n.bytesRead)break;total+=n.bytesRead;}
  if(total>READ_LIMITS.maxBytes||total>info.size)throw Error('Invalid saved ASR');return {text:bytes.subarray(0,total).toString('utf8'),value:JSON.parse(bytes.subarray(0,total).toString('utf8')) as unknown};
 }finally{await handle.close();}
}
/** No credential lookup, reservation, probe, encode or provider request on this path. */
export async function readClipMentorSourceAsr(input:unknown,deps:Pick<Dependencies,'directory'|'resolve'|'hash'>,signal?:AbortSignal):Promise<SourceAsrRead>{
 if(!object(input)||Object.keys(input).some(k=>!['action','operationId','src','expectedSourceHash','projectId'].includes(k))||input.action!=='read'
  ||typeof input.operationId!=='string'||!/^([a-f0-9]{8})-([a-f0-9]{4})-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.operationId)
  ||typeof input.src!=='string'||!/^\/media\/uploads\/[^/?#]+$/.test(input.src)||!sha(input.expectedSourceHash)
  ||typeof input.projectId!=='string'||!/^[\w:-]{1,160}$/.test(input.projectId))throw Error('Invalid saved ASR request');
 const name=decodeURIComponent(input.src.slice('/media/uploads/'.length));if(!isSafeUploadName(name)||/\.(normalized|proxy|asr)\./i.test(name))throw Error('Invalid saved ASR source');
 const base={operationId:input.operationId,source_hash:input.expectedSourceHash,requestsSent:0 as const,requestsAttempted:null,
  original_status:null,recovered_from_raw:false,project_mutated:false as const,production_approved:false as const,listeningVerified:false as const};
 const outcome=(state:SourceAsrRead['state']):SourceAsrRead=>({...base,state});
 signal?.throwIfAborted();
 let saved:Awaited<ReturnType<typeof readAsrLedger>>;
 try{saved=await readAsrLedger(join(deps.directory,`${input.operationId}.json`));}
 catch(e){return outcome((e as NodeJS.ErrnoException).code==='ENOENT'?'missing':'invalid');}
 const record=saved.value;
 if(!object(record)||!sha(record.fingerprint))return outcome('invalid');
 if(!object(record.identity))return outcome('unverifiable');
 let identity:SourceRequest;
 try{identity=parseRequest(record.identity);
  if(Object.keys(identity).some(k=>!['src','expectedSourceHash','sourceSize','language','operationId','maxRequests','projectId'].includes(k))
   ||digest(Buffer.from(JSON.stringify(identity)))!==record.fingerprint)throw Error();
 }catch{return outcome('invalid');}
 if(identity.operationId!==input.operationId||identity.src!==input.src||identity.expectedSourceHash!==input.expectedSourceHash||identity.projectId!==input.projectId)return outcome('stale');
 const file=deps.resolve(name);if(!file)return outcome('unavailable');
 try{if(await deps.hash(file)!==input.expectedSourceHash)return outcome('stale');}catch{return outcome('unavailable');}
 signal?.throwIfAborted();
 if(record.result===undefined){
  if(!['reserved','request_reserved'].includes(String(record.status))||!Number.isSafeInteger(record.requests_attempted)||Number(record.requests_attempted)<0||Number(record.requests_attempted)>identity.maxRequests)return outcome('invalid');
  return {...outcome('pending_or_unknown'),requestsAttempted:Number(record.requests_attempted)};
 }
 if(!validSavedAsr(record.result)||record.result.operation_id!==input.operationId||record.result.source_hash!==input.expectedSourceHash
  ||record.result.requested_language!==identity.language||record.result.requests_attempted>identity.maxRequests)return outcome('invalid');
 const original=record.result;
 let result:SourceTranscription;
 try{result=await recoverSavedAsr(original,join(deps.directory,`${input.operationId}.json`),record.fingerprint,deps.directory,READ_LIMITS,signal);}
 catch{signal?.throwIfAborted();return outcome('invalid');}
 if(!validSavedAsr(result)||result.issues.includes('source_changed_during_transcription'))return outcome('stale');
 // A read racing an operation update never returns a mixed snapshot as current.
 try{if((await readAsrLedger(join(deps.directory,`${input.operationId}.json`))).text!==saved.text||await deps.hash(file)!==input.expectedSourceHash)return outcome('stale');}
 catch{return outcome('unavailable');}
 signal?.throwIfAborted();
 return {...base,state:result.status,requestsAttempted:original.requests_attempted,original_status:original.status,
  recovered_from_raw:JSON.stringify(result)!==JSON.stringify(original),result:safeSavedAsr(result)};
}

export function clipMentorAsrDependencies(): Dependencies {
  return {
    key: () => getKey('CLIPMENTOR_FUNASR_API_KEY'), endpoint: () => getKey('CLIPMENTOR_FUNASR_ENDPOINT'),
    resolve: resolveUploadFile, hash: sha256File, fetch: (...args) => fetch(...args),
    directory: join(runtimeProfile().rootDir, 'clipmentor-asr'),
    async probe(file) {
      const { stat } = await import('node:fs/promises');
      const data = JSON.parse(await processOutput(ffprobeBin(), ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,duration,avg_frame_rate', '-of', 'json', file]));
      if (!data.streams?.some((s: { codec_type: string }) => s.codec_type === 'audio')) throw new Error('Source has no audio');
      const video = data.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
      const rate = String(video?.avg_frame_rate ?? '0/1').split('/').map(Number);
      return { duration: Number(video?.duration ?? data.format.duration), fps: rate[0] / rate[1], bytes: (await stat(file)).size };
    },
    async encode(file, start, end, output) {
      await processOutput(ffmpegBin(), [...ffmpegThreadArgs(), '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-ss', String(start), '-i', file, '-t', String(end - start), '-vn', '-map', '0:a:0',
        '-c:a', 'libmp3lame', '-b:a', '64k', '-ac', '1', '-ar', '16000', output]);
      return readFile(output);
    },
  };
}
export function clipMentorFunAsrPlugin(deps?: Dependencies): Plugin {
  return { name: 'clipmentor-funasr', configureServer(server) {
    server.middlewares.use('/api/clipmentor/transcribe-source', async (req: IncomingMessage, res: ServerResponse) => {
      const send = (status: number, body: unknown) => { if (!res.destroyed) { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)); } };
      if (req.method !== 'POST') { req.resume(); send(405, { error: 'POST required' }); return; }
      if (!editorCredentialAuthorized(req, true)) { req.resume(); send(401, { error: 'Editor origin required' }); return; }
      if (!String(req.headers['content-type']).startsWith('application/json')) { req.resume(); send(415, { error: 'JSON required' }); return; }
      const abort = new AbortController();
      const onClose = () => { if (!res.writableEnded) abort.abort(); };
      res.on('close', onClose);
      try {
        const parts: Buffer[] = []; let size = 0;
        for await (const part of req) { size += part.length; if (size > 8192) throw new Error('Body too large'); parts.push(Buffer.from(part)); }
        const input=JSON.parse(Buffer.concat(parts).toString('utf8'));
        if(object(input)&&input.action!==undefined&&input.action!=='read')throw Error('Invalid ASR action');
        const result = object(input)&&input.action==='read'
          ? await readClipMentorSourceAsr(input,deps??clipMentorAsrDependencies(),abort.signal)
          : await transcribeClipMentorSource(input,deps??clipMentorAsrDependencies(),abort.signal);
        send(200, result);
      } catch {
        send(400, { error: 'Source transcription unavailable or invalid input; check server configuration, original source and operation record. No automatic retry.' });
      } finally { res.off('close', onClose); }
    });
  } };
}
