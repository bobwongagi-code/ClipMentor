import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import type { SourceVideoRequest, SourceVideoResult, SourceVideoReceipt } from '../../shared/clipmentor-source-video';
import { buildCopyTeachingReviewRequest } from '../../src/clipmentor/production-gate';
import { isSafeUploadName, resolveUploadFile } from '../media-dir';
import { sha256File } from '../../shared/node-content-hash';
import { runtimeProfile } from '../runtime-profile';
import { atomicWriteFile } from '../plugins/project-store-durable';
import { getKey } from '../keystore';
import { ffprobeBin } from '../media-binaries';
import { INLINE_REQUEST_MAX_BYTES, PREVIEW_REVIEW_ENDPOINT, PREVIEW_REVIEW_MODEL, PREVIEW_REVIEW_TIMEOUT_MS, PREVIEW_REVIEW_MAX_OUTPUT_TOKENS } from './preview-review';
import { inspectSourceObservation, validateSourceObservation, SourceObservationValidationError } from './source-video-validation';
export { inspectSourceObservation, validateSourceObservation } from './source-video-validation';
const VERSION = 'source-continuous-observation-v1';
const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
export function sourceVideoInput(request: SourceVideoRequest) {
  if (!object(request) || Object.keys(request).some(k => !['operationId','maxRequests','projectId','authorRunId','source','subject','packet'].includes(k))
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(request.operationId)
    || request.maxRequests !== 1 || !text(request.projectId) || !text(request.authorRunId) || !object(request.source)
    || !/^\/media\/uploads\/[^/?#]+\.mp4$/.test(request.source.src) || !/^[a-f0-9]{64}$/.test(request.source.hash)
    || !Number.isFinite(request.source.duration) || request.source.duration <= 0 || !Number.isFinite(request.source.fps) || request.source.fps <= 0
    || !object(request.subject) || !Number.isSafeInteger(request.subject.revision) || request.subject.revision < 1
    || !/^[a-f0-9]{64}$/.test(request.subject.digest) || !Array.isArray(request.subject.units)) throw new Error('Invalid source observation input');
  const packet = buildCopyTeachingReviewRequest([{case_id:'source',packet:request.packet}]).input.cases[0].packet;
  if (!packet.units.length || request.subject.units.length !== packet.units.length
    || new Set(request.subject.units.map(u => u.unit_id)).size !== packet.units.length) throw new Error('Invalid observation scope');
  const units = packet.units.map(unit => {
    const p = unit.picture_plan;
    if (!p?.execution_plan || !request.subject.units.some(u => u.unit_id === unit.unit_id && u.candidate_id === p.execution_plan!.script_candidate_id)) throw new Error('Current plan required');
    const ranges = [...p.original_source_ranges, ...p.explanation_source_ranges];
    if (!ranges.length || ranges.some(r => r[0] < 0 || r[1] > request.source.duration || r[1] <= r[0])) throw new Error('Invalid source window');
    return { unit_id:unit.unit_id, windows:ranges.map((range,i) => ({window_id:`${unit.unit_id}:${i}`, source_range_seconds:range,
      purpose:i < p.original_source_ranges.length ? 'original_playback_candidate' : 'explanation_candidate'})),
      lines:unit.lines, picture_plan:p.execution_plan };
  });
  // Do not prime observations with historical evidence, author verdicts or prior model opinions.
  return { duration_seconds:request.source.duration, units };
}
export function buildSourceVideoRequest(video: Uint8Array, request: SourceVideoRequest) {
  const input = sourceVideoInput(request);
  const instruction = `你是剪辑前源片连续视听观察者。完整视频带同步原声，时间为原片绝对秒。重点正常顺序观察以下候选窗口及其前后，核对连续动作起落、出点是否切断动作或进入新内容、现有讲解与计划画面能否对应。计划是待验证假设，不是结论。先写真实看到/听到的连续过程，再判断；没有看清/听清用未知，不猜处理侧、冲洗完成、香味优劣或功效。不改稿、不建议新文案。不能只凭静帧或总秒数判声画成立，不能声称已经看过拟制作的排版或听过其旁白。你收到的是源片而非成片：实际原声→女声承接、字幕同步、停格可读性、完整片验收全部未验证。可指出计划容量的缺口，但不把源片窗时长当成最终可用时长。\n只返回JSON：{\"windows\":[{\"window_id\":\"输入ID\",\"observed_sequence\":\"具体连续动作\",\"endpoint\":\"候选出点处实际状态及限制\",\"evidence\":[{\"start_seconds\":0,\"end_seconds\":1,\"visible\":\"所见\",\"audible\":\"所听或听不清\"}]}],\"lines\":[{\"unit_id\":\"输入单元\",\"line_id\":\"输入行ID\",\"status\":\"supported或not_supported或insufficient_evidence\",\"reason\":\"源片能否支持这句和拟用画面的具体依据与限制\",\"window_ids\":[\"引用窗口\"]}],\"limitations\":[\"未核实内容\"]}。每个窗口及每句各一次，证据时间必须落在该窗口内；需要窗口外证据时写缺口。用中文说明。\n${JSON.stringify(input)}`;
  const body = {contents:[{role:'user',parts:[{inlineData:{mimeType:'video/mp4',data:''},videoMetadata:{fps:5}},{text:instruction}]}],
    generationConfig:{maxOutputTokens:PREVIEW_REVIEW_MAX_OUTPUT_TOKENS,temperature:0,responseMimeType:'application/json'}};
  if (!video.byteLength || Buffer.byteLength(JSON.stringify(body)) + 4 * Math.ceil(video.byteLength/3) > INLINE_REQUEST_MAX_BYTES) throw new Error('Source exceeds inline bound; no implicit encoding or split');
  body.contents[0].parts[0].inlineData!.data = Buffer.from(video).toString('base64');
  return {body:JSON.stringify(body), input, input_sha256:hash(JSON.stringify(input))};
}
export interface SourceVideoDependencies {
  directory:string; key:string; resolve(name:string):string|null; hash(file:string):Promise<string>;
  audioPresent(file:string):Promise<boolean>; read(file:string):Promise<Buffer>; size(file:string):Promise<number>;
  post(body:string,key:string,signal:AbortSignal,operationId:string):Promise<{status:number;body:unknown}>;
}
export async function observeSourceVideo(value: unknown, deps: SourceVideoDependencies, outer?: AbortSignal): Promise<SourceVideoResult> {
  const request = value as SourceVideoRequest, input = sourceVideoInput(request);
  const name = decodeURIComponent(request.source.src.slice('/media/uploads/'.length));
  if (!isSafeUploadName(name)) throw new Error('Invalid source');
  const file = deps.resolve(name);
  if (!file || !deps.key.trim() || /[\r\n]/.test(deps.key) || await deps.hash(file) !== request.source.hash
    || !await deps.audioPresent(file) || await deps.size(file) > 74_000_000) throw new Error('Source or server credential unavailable');
  const fingerprint = hash(VERSION + JSON.stringify(request));
  await mkdir(deps.directory,{recursive:true,mode:0o700});
  const ledger = join(deps.directory,`${request.operationId}.json`);
  try { await writeFile(ledger,JSON.stringify({fingerprint,status:'preparing',requests_attempted:0,projectId:request.projectId,subject:request.subject,source_hash:request.source.hash}),{flag:'wx',mode:0o600}); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('Reservation failed');
    const old = JSON.parse(await readFile(ledger,'utf8'));
    if (old.fingerprint !== fingerprint || old.status !== 'completed') throw new Error('Operation consumed or unknown; no retry');
    return {...old.result,cached:true};
  }
  let attempts = 0;
  let phase = 'prepare';
  let httpStatus: number | null = null;
  let safeResponse: unknown = null;
  let frozenInput: ReturnType<typeof sourceVideoInput> | null = null;
  let requestHash: string | null = null;
  let videoBytes = 0;
  try {
    const video = await deps.read(file);
    if (hash(video) !== request.source.hash) throw new Error('Source changed');
    const prepared = buildSourceVideoRequest(video,request);
    frozenInput = prepared.input; requestHash = hash(prepared.body); videoBytes = video.length;
    const signal = outer ? AbortSignal.any([outer,AbortSignal.timeout(PREVIEW_REVIEW_TIMEOUT_MS)]) : AbortSignal.timeout(PREVIEW_REVIEW_TIMEOUT_MS);
    signal.throwIfAborted();
    attempts = 1;
    await atomicWriteFile(ledger,JSON.stringify({fingerprint,status:'reserved',requests_attempted:1,projectId:request.projectId,subject:request.subject,source_hash:request.source.hash,input:prepared.input,request_sha256:hash(prepared.body)}));
    phase = 'gateway_request';
    const response = await deps.post(prepared.body,deps.key,signal,request.operationId);
    httpStatus = response.status;
    signal.throwIfAborted();
    if (response.status !== 200 || !object(response.body)) throw new Error('Gateway request failed');
    const encoded = JSON.stringify(response.body);
    if (encoded.includes(deps.key)) throw new Error('Credential echo rejected');
    safeResponse = response.body;
    phase = 'validate_response';
    const candidates = response.body.candidates;
    if (!Array.isArray(candidates) || candidates.length !== 1 || candidates[0]?.finishReason !== 'STOP') throw new Error('Incomplete model response');
    const raw = candidates[0]?.content?.parts?.filter((p:any) => !p.thought && typeof p.text === 'string').map((p:any)=>p.text).join('') ?? '';
    const parsed = JSON.parse(raw.replace(/^\s*```(?:json)?\s*/,'').replace(/\s*```\s*$/,''));
    const observation = validateSourceObservation(parsed,input);
    if (await deps.hash(file) !== request.source.hash) throw new Error('Source changed');
    const result:SourceVideoResult = {operationId:request.operationId,requestsAttempted:1,subject:request.subject,source_hash:request.source.hash,
      requested_model:PREVIEW_REVIEW_MODEL,returned_model:typeof response.body.modelVersion==='string'?response.body.modelVersion:null,method_version:VERSION,
      request_sha256:hash(prepared.body),input_sha256:prepared.input_sha256,video_bytes:video.length,
      validation:inspectSourceObservation(parsed,input),
      input_media:{full_original_video:true,audio_stream_present:true,video_fps_requested:5},raw_observation:observation,
      finish_reasons:[candidates[0].finishReason],usage:response.body.usageMetadata??null,
      scope:'source_windows_and_planned_capacity_only',actual_handoff_verified:false,complete_film_accepted:false};
    await atomicWriteFile(ledger,JSON.stringify({fingerprint,status:'completed',requests_attempted:1,projectId:request.projectId,subject:request.subject,source_hash:request.source.hash,input:prepared.input,raw_response:response.body,result}));
    return result;
  } catch (error) {
    const validation = error instanceof SourceObservationValidationError ? error.validation : undefined;
    await atomicWriteFile(ledger,JSON.stringify({fingerprint,status:'failed',requests_attempted:attempts,projectId:request.projectId,
      subject:request.subject,source_hash:request.source.hash,input:frozenInput,request_sha256:requestHash,video_bytes:videoBytes,
      phase,http_status:httpStatus,raw_response:safeResponse,validation,error:validation ? 'source_observation_validation_failed' : 'source_observation_failed_or_unknown'}));
    throw new SourceVideoOperationError({ operationId:request.operationId, status:'failed', requestsAttempted:attempts, requestsSent:httpStatus === null && attempts > 0 ? 'unknown' : attempts > 0 ? 1 : 0,
      projectId:request.projectId, subject:request.subject,source_hash:request.source.hash,phase,upstream_http_status:httpStatus,
      validation, error:validation ? 'source_observation_validation_failed' : 'source_observation_failed_or_unknown',
      raw_response_available:!!safeResponse,receipt_reference:request.operationId,actual_handoff_verified:false,complete_film_accepted:false });
  }
}
export async function postSourceVideo(body:string,key:string,signal:AbortSignal,operationId:string) {
  const directory = await mkdtemp(join(runtimeProfile().rootDir,'source-video-'));
  try {
    const request = join(directory,'request.json'), response = join(directory,'response.json');
    await writeFile(request,body,{mode:0o600});
    const status = await new Promise<number>((accept,reject) => {
      const c = spawn('curl',['--disable','-sS','--http1.1','--noproxy','*','--proto','=https','--max-redirs','0','--retry','0','--connect-timeout','30','--max-time','600','--max-filesize','1048576',
        '-H','@-','-H','Content-Type: application/json','-H',`Idempotency-Key: ${operationId}`,'--data-binary',`@${request}`,'--output',response,'--write-out','%{http_code}',PREVIEW_REVIEW_ENDPOINT],{stdio:['pipe','pipe','ignore'],signal});
      let code=''; c.stdout.on('data',chunk=>{if(code.length<16)code+=String(chunk);});
      c.on('error',()=>reject(new Error('Source transport failed')));c.on('close',exit=>exit===0&&/^\d{3}$/.test(code)?accept(Number(code)):reject(new Error('Source transport failed')));
      c.stdin.on('error',()=>undefined);c.stdin.end(`Authorization: Bearer ${key}\n`);
    });
    let result:unknown=null;
    if(status===200) {try {result=JSON.parse(await readFile(response,'utf8'));} catch {/* rejected by caller */}}
    return {status,body:result};
  } finally {await rm(directory,{recursive:true,force:true});}
}
export function sourceVideoDependencies():SourceVideoDependencies {
  return {directory:join(runtimeProfile().rootDir,'clipmentor-source-video'),key:getKey('ROOTIFY_GATEWAY_API_KEY'),resolve:resolveUploadFile,hash:sha256File,
    read:readFile,size:async file=>(await stat(file)).size,post:postSourceVideo,
    audioPresent:async file=>{const {stdout}=await promisify(execFile)(ffprobeBin(),['-v','error','-select_streams','a','-show_entries','stream=index','-of','json',file],{timeout:30000,maxBuffer:65536});return JSON.parse(stdout).streams?.length>0;} };
}

const OPERATION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export class SourceVideoOperationError extends Error {
  readonly receipt: SourceVideoReceipt;
  constructor(receipt: SourceVideoReceipt) { super(receipt.error ?? 'Source observation failed; read saved receipt, no retry'); this.receipt = receipt; }
}
function publicObservation(raw: unknown): unknown {
  if (!object(raw) || !Array.isArray(raw.candidates) || raw.candidates.length !== 1 || raw.candidates[0]?.finishReason !== 'STOP') throw new Error('Incomplete saved response');
  const parts = raw.candidates[0]?.content?.parts;
  if (!Array.isArray(parts)) throw new Error('Invalid saved response');
  const content = parts.filter(p => object(p) && !p.thought && typeof p.text === 'string').map(p => p.text).join('');
  return JSON.parse(content.replace(/^\s*```(?:json)?\s*/, '').replace(/\s*```\s*$/, ''));
}

/** No credential or network is required to inspect a retained operation. Legacy unbound records require explicit offline recovery. */
export async function readSourceVideoReceipt(operationId: string, projectId: string, deps: Pick<SourceVideoDependencies, 'directory'>): Promise<SourceVideoReceipt> {
  if (!OPERATION_ID.test(operationId) || !text(projectId)) throw new Error('Invalid receipt identity');
  const originalText = await readFile(join(deps.directory, `${operationId}.json`), 'utf8');
  const original = JSON.parse(originalText);
  const derived = await readFile(join(deps.directory, `${operationId}.revalidated.json`), 'utf8').catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return null;
    throw new Error('Receipt unavailable');
  });
  if (derived) {
    const saved = JSON.parse(derived);
    if (saved.operationId !== operationId || saved.projectId !== projectId || saved.revalidation?.original_record_sha256 !== hash(originalText)
      || saved.revalidation?.requestsSent !== 0 || saved.result?.actual_handoff_verified !== false || saved.result?.complete_film_accepted !== false) throw new Error('Invalid recovered receipt binding');
    return saved as SourceVideoReceipt;
  }
  if (original.projectId !== projectId || !object(original.subject) || !text(original.source_hash)
    || !['preparing', 'reserved', 'failed', 'completed'].includes(original.status)) throw new Error('Receipt not bound to project; offline recovery required');
  let observed: unknown;
  try { observed = publicObservation(original.raw_response); } catch { /* Raw response remains private for diagnosis. */ }
  return { operationId,projectId,status:original.status,subject:original.subject,source_hash:original.source_hash,
    requestsAttempted:original.requests_attempted,requestsSent:0,phase:original.phase,upstream_http_status:original.http_status,
    error:original.error,validation:original.validation,raw_observation:observed,
    ...(original.status === 'completed' ? {result:original.result} : {}),raw_response_available:!!original.raw_response,
    receipt_reference:operationId,actual_handoff_verified:false,complete_film_accepted:false };
}

/** Explicit local recovery of an unchanged saved response. The original failed ledger is never overwritten. No post() call. */
export async function recoverSourceVideoReceipt(request: SourceVideoRequest, reservedArchive: unknown, deps: SourceVideoDependencies): Promise<SourceVideoReceipt> {
  const input = sourceVideoInput(request);
  if (!object(reservedArchive) || reservedArchive.status !== 'reserved' || reservedArchive.requests_attempted !== 1) throw new Error('Original reserved archive required');
  const ledgerPath = join(deps.directory, `${request.operationId}.json`);
  const originalText = await readFile(ledgerPath, 'utf8'), failed = JSON.parse(originalText);
  const fingerprint = hash(VERSION + JSON.stringify(request));
  if (failed.status !== 'failed' || failed.requests_attempted !== 1 || failed.phase !== 'validate_response' || failed.http_status !== 200
    || failed.fingerprint !== fingerprint || reservedArchive.fingerprint !== fingerprint
    || JSON.stringify(failed.subject) !== JSON.stringify(request.subject) || reservedArchive.source_hash !== request.source.hash
    || JSON.stringify(reservedArchive.input) !== JSON.stringify(input)) throw new Error('Recovery source/input binding mismatch');
  const name = decodeURIComponent(request.source.src.slice('/media/uploads/'.length));
  if (!isSafeUploadName(name)) throw new Error('Invalid source');
  const file = deps.resolve(name);
  if (!file || await deps.hash(file) !== request.source.hash) throw new Error('Recovery source unavailable or changed');
  const video = await deps.read(file);
  if (hash(video) !== request.source.hash) throw new Error('Recovery source changed');
  const prepared = buildSourceVideoRequest(video, request);
  if (hash(prepared.body) !== reservedArchive.request_sha256) throw new Error('Frozen request hash mismatch');
  const observation = validateSourceObservation(publicObservation(failed.raw_response), input);
  const validation = inspectSourceObservation(observation, input);
  const raw = failed.raw_response;
  const result: SourceVideoResult = {operationId:request.operationId,requestsAttempted:1,subject:request.subject,source_hash:request.source.hash,
    requested_model:PREVIEW_REVIEW_MODEL,returned_model:typeof raw.modelVersion === 'string' ? raw.modelVersion : null,method_version:VERSION,
    request_sha256:reservedArchive.request_sha256,input_sha256:prepared.input_sha256,video_bytes:video.length,
    input_media:{full_original_video:true,audio_stream_present:true,video_fps_requested:5},validation,raw_observation:observation,
    finish_reasons:['STOP'],usage:raw.usageMetadata ?? null,scope:'source_windows_and_planned_capacity_only',actual_handoff_verified:false,complete_film_accepted:false};
  const receipt: SourceVideoReceipt = {operationId:request.operationId,projectId:request.projectId,status:'failed',subject:request.subject,
    source_hash:request.source.hash,requestsAttempted:1,requestsSent:0,phase:failed.phase,upstream_http_status:200,
    validation,raw_observation:observation,result,raw_response_available:true,receipt_reference:request.operationId,
    revalidation:{version:validation.version,parent_status:'failed',original_record_sha256:hash(originalText),requestsSent:0},
    actual_handoff_verified:false,complete_film_accepted:false};
  const derivedPath = join(deps.directory, `${request.operationId}.revalidated.json`);
  try { await writeFile(derivedPath, JSON.stringify(receipt), {flag:'wx',mode:0o600}); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(derivedPath,'utf8') !== JSON.stringify(receipt)) throw new Error('Recovered receipt already exists or cannot be saved');
  }
  return receipt;
}
