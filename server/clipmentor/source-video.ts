import {externalCall,readSavedExternalResponse} from './external-call';
import { echoesMediaSecret, videoRequestDigest, videoInput, type VideoInput, type PreparedVideo } from './video-input';
import { prepareVideoMedia, VideoMediaError } from './video-media';
import { materialRange, prepareObservationMaterial } from './observation-material';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import type { SourceVideoRequest, SourceVideoResult, SourceVideoReceipt, SourceVideoTransportDiagnostic, ObservationMaterial } from '../../shared/clipmentor-source-video';
import { validateSourceVideoTask, isObservationMaterial } from '../../shared/clipmentor-source-video';
import { buildCopyTeachingReviewRequest } from '../../src/clipmentor/production-gate';
import { isSafeUploadName, resolveUploadFile } from '../media-dir';
import { sha256File } from '../../shared/node-content-hash';
import { runtimeProfile } from '../runtime-profile';
import { atomicWriteFile } from '../plugins/project-store-durable';
import { getKey } from '../keystore';
import { ffprobeBin } from '../media-binaries';
import { INLINE_REQUEST_MAX_BYTES, PREVIEW_REVIEW_MODEL, PREVIEW_REVIEW_TIMEOUT_MS, PREVIEW_REVIEW_MAX_OUTPUT_TOKENS } from './preview-review';
import { inspectSourceObservation, SourceObservationValidationError } from './source-video-validation';
export { inspectSourceObservation, validateSourceObservation } from './source-video-validation';
import { postSourceVideoTransport, safeSourceTransportDiagnostic, SourceVideoTransportError } from './source-video-transport';
const VERSION = 'source-continuous-observation-v1';
const MATERIAL_VERSION = 'source-continuous-observation-v2';
const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
export function sourceVideoInput(request: SourceVideoRequest, legacyAllUnits = false) {
  if (!object(request) || Object.keys(request).some(k => !['operationId','maxRequests','projectId','authorRunId','source','subject','packet','observationTask'].includes(k))
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(request.operationId)
    || request.maxRequests !== 1 || !text(request.projectId) || !text(request.authorRunId) || !object(request.source)
    || !/^\/media\/uploads\/[^/?#]+\.mp4$/.test(request.source.src) || !/^[a-f0-9]{64}$/.test(request.source.hash)
    || !Number.isFinite(request.source.duration) || request.source.duration <= 0 || !Number.isFinite(request.source.fps) || request.source.fps <= 0
    || !object(request.subject) || !Number.isSafeInteger(request.subject.revision) || request.subject.revision < 1
    || !/^[a-f0-9]{64}$/.test(request.subject.digest) || !Array.isArray(request.subject.units)) throw new Error('Invalid source observation input');
  const packet = buildCopyTeachingReviewRequest([{case_id:'source',packet:request.packet}]).input.cases[0].packet;
  if (!packet.units.length || request.subject.units.length !== packet.units.length
    || new Set(request.subject.units.map(u => u.unit_id)).size !== packet.units.length) throw new Error('Invalid observation scope');
  if(request.observationTask!==undefined) validateSourceVideoTask(request.observationTask,request.source.duration,packet.units.map(u=>u.unit_id));
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
  const selected = request.observationTask && !legacyAllUnits ? new Set(request.observationTask.contexts.map(c=>c.unit_id)) : null;
  return { duration_seconds:request.source.duration, units:selected?units.filter(u=>selected.has(u.unit_id)):units,
    ...(request.observationTask===undefined?{}:{observation_task:request.observationTask}) };
}

/** Context evidence is checked against its own frozen observation range, never the production windows. */
export function inspectSourceVideoObservation(value: unknown, input: ReturnType<typeof sourceVideoInput>) {
  const base=inspectSourceObservation(value,input),task=input.observation_task;
  if(!task) return base;
  const issues=[...base.issues];
  const error=(code:string)=>issues.push({code,severity:'error'});
  const extra=object(value)?value.task_observation:null;
  if(!object(extra)||!Array.isArray(extra.boundaries)||!Array.isArray(extra.contexts)) {
    error('missing_task_observation');return {...base,status:'invalid' as const,issues};
  }
  const bounded=(v:any,c:typeof task.contexts[number])=>object(v)&&Number.isFinite(v.start_seconds)&&Number.isFinite(v.end_seconds)
    &&v.start_seconds>=0&&v.end_seconds>v.start_seconds
    &&v.start_seconds>=c.source_range_seconds[0]-0.010000001&&v.end_seconds<=c.source_range_seconds[1]+0.010000001;
  const speech=(v:any)=>object(v)&&['heard','unclear','silence'].includes(v.status)
    &&(v.status==='heard'?text(v.quote):v.quote===null);
  const expected=task.contexts.flatMap(c=>c.boundary_seconds.map(t=>({c,t})));
  const seen=new Set<number>();
  if(extra.boundaries.length!==expected.length) error('incomplete_task_boundaries');
  for(const b of extra.boundaries) {
    const index=object(b)?expected.findIndex(x=>x.c.context_id===b.context_id&&typeof b.boundary_seconds==='number'
      &&Math.abs(x.t-b.boundary_seconds)<=0.01):-1;
    if(index<0||seen.has(index)){error('invalid_task_boundary_identity');continue;}
    seen.add(index);const {c,t}=expected[index];
    if(!bounded(b,c)||b.start_seconds>t+(t===0?0.01:0)||b.end_seconds<t-(t===input.duration_seconds?0.01:0)
      ||!['sentence_boundary','inside_speech','uncertain'].includes(b.status)
      ||!speech(b.before)||!speech(b.after)||!text(b.reason)||!text(b.time_uncertainty)
      ||(b.status!=='uncertain'&&b.before.status!=='heard'&&b.after.status!=='heard')) error('invalid_task_boundary_evidence');
  }
  const contexts=task.contexts.filter(c=>c.goals.includes('material_continuity'));
  const seenContexts=new Set<string>();
  if(extra.contexts.length!==contexts.length) error('incomplete_task_contexts');
  for(const v of extra.contexts) {
    const c=object(v)?contexts.find(x=>x.context_id===v.context_id):undefined;
    if(!c||seenContexts.has(c.context_id)){error('invalid_task_context_identity');continue;}
    seenContexts.add(c.context_id);
    if(!Array.isArray(v.sequence)||v.sequence.length>64||!v.sequence.every((e:any)=>bounded(e,c)&&text(e.visible)&&text(e.audible))
      ||!Array.isArray(v.material_ranges)||v.material_ranges.length>64||!v.material_ranges.every((e:any)=>bounded(e,c)
        &&['use_process','closeup','same_frame_comparison','person_handoff','other','uncertain'].includes(e.role)&&text(e.basis)
        &&Array.isArray(e.limitations)&&e.limitations.every(text))
      ||!Array.isArray(v.limitations)||!v.limitations.every(text)
      ||((!v.sequence.length||!v.material_ranges.length)&&!v.limitations.length)) error('invalid_task_context_evidence');
  }
  return {...base,status:issues.some(i=>i.severity==='error')?'invalid' as const:'valid' as const,issues};
}
export function validateSourceVideoObservation(value: unknown, input: ReturnType<typeof sourceVideoInput>) {
  const validation=inspectSourceVideoObservation(value,input);
  if(validation.status!=='valid') throw new SourceObservationValidationError(validation);
  return value as SourceVideoResult['raw_observation'];
}
export function sourceObservationRange(input: ReturnType<typeof sourceVideoInput>): [number,number] | null {
  if(!input.observation_task)return null; // Initial understanding retains the complete source and its persuasive relationships.
  return materialRange([...input.units.flatMap(u=>u.windows.map(w=>w.source_range_seconds)),
    ...input.observation_task.contexts.map(c=>c.source_range_seconds)],input.duration_seconds);
}
/** Numeric clock conversion only; the immutable raw response, wording and model judgments are not repaired. */
export function sourceObservationToSourceClock(value: unknown, material?: ObservationMaterial): unknown {
  if(material?.kind!=='stream_copy_excerpt')return value;
  const convert=(v:unknown):unknown=>Array.isArray(v)?v.map(convert):object(v)?Object.fromEntries(Object.entries(v).map(([key,x])=>[
    key,['start_seconds','end_seconds','boundary_seconds'].includes(key)&&typeof x==='number'&&Number.isFinite(x)
      ? x+material.source_seconds_at_submitted_zero : convert(x)])):v;
  return convert(value);
}
export function buildSourceVideoRequest(video: VideoInput, request: SourceVideoRequest, material?: ObservationMaterial, legacyAllUnits = false) {
  const media = videoInput(video);
  const input = sourceVideoInput(request,legacyAllUnits);
  if(material && (!isObservationMaterial(material)||material.parent_sha256!==request.source.hash || material.submitted_sha256!==media.sha256 || material.submitted_bytes!==media.bytes
    ||material.parent_duration_seconds!==request.source.duration || material.coverage!=='submitted_range_only'||material.complete_film_accepted!==false)) throw Error('Observation media binding mismatch');
  if(material?.kind==='stream_copy_excerpt') {
    const range=sourceObservationRange(input);
    if(!range||JSON.stringify(range)!==JSON.stringify(material.requested_range_seconds)
      ||!material.stream_copy||!material.packet_payloads_verified||!Number.isFinite(material.source_seconds_at_submitted_zero)
      ||material.actual_source_range_seconds[0]>range[0]||material.actual_source_range_seconds[1]<range[1]) throw Error('Observation excerpt scope mismatch');
  }
  const mediaIntro=material?.kind==='stream_copy_excerpt'
    ? `本次实际发送连续原片片段，不是完整原片。视频时长${material.submitted_duration_seconds}秒。下列窗口和观察任务的时间已由服务端换算为本片段从0开始的本地秒；所有返回start_seconds/end_seconds/boundary_seconds也必须用片段本地秒，不需要自行加原片偏移。picture_plan里的原片坐标仅是待验证计划，不是本次证据时码。服务端会保存原始返回并另外还原原片时码。只判断收到的范围，不称看过整片。`
    : '完整视频带同步原声，时间为原片绝对秒。';
  const wireInput=structuredClone(input);
  if(material?.kind==='stream_copy_excerpt') {
    const offset=material.source_seconds_at_submitted_zero;
    wireInput.duration_seconds=material.submitted_duration_seconds;
    for(const u of wireInput.units)for(const w of u.windows)w.source_range_seconds=[w.source_range_seconds[0]-offset,w.source_range_seconds[1]-offset];
    for(const c of wireInput.observation_task?.contexts??[]) {
      c.source_range_seconds=[c.source_range_seconds[0]-offset,c.source_range_seconds[1]-offset];
      c.boundary_seconds=c.boundary_seconds.map(t=>t-offset);
    }
  }
  const instruction = `你是剪辑前源片连续视听观察者。${mediaIntro}重点正常顺序观察以下候选窗口及其前后，核对连续动作起落、出点是否切断动作或进入新内容、现有讲解与计划画面能否对应。计划是待验证假设，不是结论。先写真实看到/听到的连续过程，再判断；没有看清/听清用未知，不猜处理侧、冲洗完成、香味优劣或功效。不改稿、不建议新文案。不能只凭静帧或总秒数判声画成立，不能声称已经看过拟制作的排版或听过其旁白。你收到的是源片而非成片：实际原声→女声承接、字幕同步、停格可读性、完整片验收全部未验证。可指出计划容量的缺口，但不把源片窗时长当成最终可用时长。\n只返回JSON：{\"windows\":[{\"window_id\":\"输入ID\",\"observed_sequence\":\"具体连续动作\",\"endpoint\":\"候选出点处实际状态及限制\",\"evidence\":[{\"start_seconds\":0,\"end_seconds\":1,\"visible\":\"所见\",\"audible\":\"所听或听不清\"}]}],\"lines\":[{\"unit_id\":\"输入单元\",\"line_id\":\"输入行ID\",\"status\":\"supported或not_supported或insufficient_evidence\",\"reason\":\"源片能否支持这句和拟用画面的具体依据与限制\",\"window_ids\":[\"引用窗口\"]}],\"limitations\":[\"未核实内容\"]}。每个窗口及每句各一次，证据时间必须落在该窗口内；需要窗口外证据时写缺口。用中文说明。\n${JSON.stringify(wireInput)}`;
  const taskInstruction=input.observation_task ? `\n本次另有observation_task：这些是仅供观察的上下文，不是新增或批准的制作范围。原windows继续只写其窗口内证据。另在同一JSON增加task_observation，按照观察上下文独立返回：
{"boundaries":[{"context_id":"输入ID","boundary_seconds":0,"status":"sentence_boundary或inside_speech或uncertain","before":{"status":"heard或unclear或silence","quote":"可听原话或null"},"after":{"status":"heard或unclear或silence","quote":"可听原话或null"},"start_seconds":0,"end_seconds":1,"reason":"边界前后听证及是否跨边界延续","time_uncertainty":"时间定位的不确定性"}],"contexts":[{"context_id":"输入ID","sequence":[{"start_seconds":0,"end_seconds":1,"visible":"连续动作","audible":"原话片段或听不清"}],"material_ranges":[{"start_seconds":0,"end_seconds":1,"role":"use_process或closeup或same_frame_comparison或person_handoff或other或uncertain","basis":"可见关系，不是计划复述","limitations":["限制"]}],"limitations":["缺口"]}]}。
每个boundary_seconds各返回一次。只对goals包含material_continuity的context各返回一个contexts记录。各项证据必须落在所属观察上下文范围；句界证据须覆盖指定时刻的前后。heard必须附真正听辨的原语言短片段，不翻译冒充原话；unclear/silence的quote用null。无法根据原话判断完整句时选uncertain，不能凭静默、嘴形或动作结束断言句子结束；没有任何可听原话时不得判sentence_boundary/inside_speech。time_uncertainty如实说明，不编造逐帧精度。若上下文仍不够或听不清，记录未知及缺口，不延展或猜句界。material_ranges仅是证据支持的候选范围，不是自动可用/可剪；区分单手、托触和真实同时双手背同框，区分过程、人物与拿盒。允许sequence/material_ranges为空，但须说明证据不足。不要声称已经听过拟配旁白、验证成片承接或批准文稿。\n` : '';
  const body = {contents:[{role:'user',parts:[media.part,{text:instruction+taskInstruction}]}],
    generationConfig:{maxOutputTokens:PREVIEW_REVIEW_MAX_OUTPUT_TOKENS,temperature:0,responseMimeType:'application/json'}};
  if (Buffer.byteLength(JSON.stringify(body)) > INLINE_REQUEST_MAX_BYTES) throw new Error('Source exceeds inline bound; no implicit encoding or split');
  return {body:JSON.stringify(body), input, input_sha256:hash(JSON.stringify(input)), logical_request_sha256:videoRequestDigest(body,media), media_transfer:media.receipt};
}
export interface SourceVideoDependencies {
  directory:string; key:string; resolve(name:string):string|null; hash(file:string):Promise<string>;
  audioPresent(file:string):Promise<boolean>; read(file:string):Promise<Buffer>; size(file:string):Promise<number>;
  prepareMedia?(file:string,sha256:string,signal:AbortSignal):Promise<PreparedVideo>;
  prepareObservation?(file:string,sha256:string,duration:number,range:[number,number]|null,signal:AbortSignal):Promise<{file:string;binding:ObservationMaterial}>;
  post(body:string,key:string,signal:AbortSignal,operationId:string):Promise<{status:number;body:unknown;diagnostic?:SourceVideoTransportDiagnostic}>;
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
    return {...publicTransportRecord(old.result,request.operationId),cached:true};
  }
  const retryPolicy=deps.prepareMedia?'no_automatic_retry' as const:undefined;
  let attempts = 0;
  let phase = 'prepare';
  let httpStatus: number | null = null;
  let transportDiagnostic: SourceVideoTransportDiagnostic | undefined;
  let safeResponse: unknown = null;
  let frozenInput: ReturnType<typeof sourceVideoInput> | null = null;
  let requestHash: string | null = null;
  let videoBytes = 0;
  let logicalRequestHash: string | null = null;
  let mediaTransfer: PreparedVideo['receipt'] | undefined;
  let observationMaterial: ObservationMaterial | undefined;
  try {
    const signal = outer ? AbortSignal.any([outer,AbortSignal.timeout(PREVIEW_REVIEW_TIMEOUT_MS)]) : AbortSignal.timeout(PREVIEW_REVIEW_TIMEOUT_MS);
    const selected=deps.prepareObservation?await deps.prepareObservation(file,request.source.hash,request.source.duration,sourceObservationRange(input),signal):undefined;
    observationMaterial=selected?.binding;
    const submittedFile=selected?.file??file,submittedHash=selected?.binding.submitted_sha256??request.source.hash;
    const media = deps.prepareMedia ? await deps.prepareMedia(submittedFile,submittedHash,signal) : videoInput(await deps.read(submittedFile));
    if (media.sha256 !== submittedHash) throw new Error('Source changed');
    const prepared = buildSourceVideoRequest(media,request,observationMaterial);
    mediaTransfer=media.receipt;logicalRequestHash=prepared.logical_request_sha256;
    frozenInput = prepared.input; requestHash = hash(prepared.body); videoBytes = media.bytes;
    signal.throwIfAborted();
    attempts = 1;
    await atomicWriteFile(ledger,JSON.stringify({fingerprint,status:'reserved',requests_attempted:1,model_retry_policy:retryPolicy,projectId:request.projectId,subject:request.subject,source_hash:request.source.hash,source_src:request.source.src,input:prepared.input,request_sha256:hash(prepared.body),video_bytes:videoBytes,logical_request_sha256:logicalRequestHash,media_transfer:mediaTransfer,observation_material:observationMaterial}));
    phase = 'gateway_request';
    const response = await externalCall({directory:deps.directory,kind:'video',purpose:'source-observation-v1',requestId:request.operationId,preserveErrors:true,
      identity:{fingerprint,logicalRequestHash,account:hash(deps.key)},signal,execute:async childSignal=>{
        const response=await deps.post(prepared.body,deps.key,childSignal,request.operationId);
        httpStatus=response.status;transportDiagnostic=safeSourceTransportDiagnostic(response.diagnostic,deps.key,request.operationId);
        if(JSON.stringify(response.body)?.includes(deps.key)||echoesMediaSecret(response.body,media))throw Error('Credential echo rejected');
        safeResponse=response.body;if(response.status===200)phase='save_result';
        return {...response,fingerprint,logical_request_sha256:logicalRequestHash,request_sha256:requestHash,
          projectId:request.projectId,subject:request.subject,source_hash:request.source.hash,source_src:request.source.src,
          input_sha256:prepared.input_sha256,video_bytes:videoBytes,
          diagnostic:safeSourceTransportDiagnostic(response.diagnostic,deps.key,request.operationId)};
      }});
    phase='gateway_request';
    httpStatus = response.status;
    transportDiagnostic = safeSourceTransportDiagnostic(response.diagnostic,deps.key,request.operationId);
    signal.throwIfAborted();
    if (response.status !== 200 || !object(response.body)) throw new Error('Gateway request failed');
    const encoded = JSON.stringify(response.body);
    if (encoded.includes(deps.key) || echoesMediaSecret(response.body,media)) throw new Error('Credential echo rejected');
    safeResponse = response.body;phase='save_result';
    await atomicWriteFile(ledger,JSON.stringify({fingerprint,status:'reserved',requests_attempted:1,model_retry_policy:retryPolicy,projectId:request.projectId,subject:request.subject,source_hash:request.source.hash,
      source_src:request.source.src,input:prepared.input,request_sha256:requestHash,video_bytes:videoBytes,logical_request_sha256:logicalRequestHash,media_transfer:mediaTransfer,observation_material:observationMaterial,raw_response:safeResponse,transport_diagnostic:transportDiagnostic}));
    phase = 'validate_response';
    const candidates = response.body.candidates;
    if (!Array.isArray(candidates) || candidates.length !== 1 || candidates[0]?.finishReason !== 'STOP') throw new Error('Incomplete model response');
    const raw = candidates[0]?.content?.parts?.filter((p:any) => !p.thought && typeof p.text === 'string').map((p:any)=>p.text).join('') ?? '';
    const parsed = sourceObservationToSourceClock(normalizeTaskObservation(JSON.parse(raw.replace(/^\s*```(?:json)?\s*/,'').replace(/\s*```\s*$/,'')),input),observationMaterial);
    const observation = validateSourceVideoObservation(parsed,input);
    if (await deps.hash(file) !== request.source.hash) throw new Error('Source changed');
    if(observationMaterial && await deps.hash(submittedFile)!==observationMaterial.submitted_sha256)throw Error('Submitted excerpt changed');
    const result:SourceVideoResult = {operationId:request.operationId,requestsAttempted:1,subject:request.subject,source_hash:request.source.hash,
      requested_model:PREVIEW_REVIEW_MODEL,returned_model:typeof response.body.modelVersion==='string'?response.body.modelVersion:null,method_version:observationMaterial?MATERIAL_VERSION:VERSION,
      request_sha256:hash(prepared.body),input_sha256:prepared.input_sha256,video_bytes:videoBytes,
      validation:inspectSourceVideoObservation(parsed,input),
      ...(request.observationTask===undefined?{}:{observation_task:request.observationTask}),
      input_media:{full_original_video:observationMaterial?.kind!=='stream_copy_excerpt',audio_stream_present:true,video_fps_requested:5},raw_observation:observation,
      ...(observationMaterial?{observation_material:observationMaterial}:{}),
      finish_reasons:[candidates[0].finishReason],usage:response.body.usageMetadata??null,
      ...(transportDiagnostic?{transport_diagnostic:transportDiagnostic}:{}),
      scope:'source_windows_and_planned_capacity_only',actual_handoff_verified:false,complete_film_accepted:false};
    phase = 'save_result';
    await atomicWriteFile(ledger,JSON.stringify({fingerprint,status:'completed',requests_attempted:1,model_retry_policy:retryPolicy,projectId:request.projectId,subject:request.subject,source_hash:request.source.hash,input:prepared.input,...(transportDiagnostic?{transport_diagnostic:transportDiagnostic}:{}),logical_request_sha256:logicalRequestHash,media_transfer:mediaTransfer,observation_material:observationMaterial,raw_response:response.body,result}));
    return result;
  } catch (error) {
    if(error instanceof SourceVideoTransportError){transportDiagnostic=safeSourceTransportDiagnostic(error.diagnostic,deps.key,request.operationId);httpStatus=transportDiagnostic?.http_status??httpStatus;}
    const validation = error instanceof SourceObservationValidationError ? error.validation : undefined;
    let receiptPersisted=true;
    try {await atomicWriteFile(ledger,JSON.stringify({fingerprint,status:'failed',requests_attempted:attempts,model_retry_policy:retryPolicy,projectId:request.projectId,
      subject:request.subject,source_hash:request.source.hash,source_src:request.source.src,input:frozenInput,request_sha256:requestHash,video_bytes:videoBytes,
      phase,http_status:httpStatus,logical_request_sha256:logicalRequestHash,media_transfer:mediaTransfer,observation_material:observationMaterial,...(error instanceof VideoMediaError?{media_failure:{stage:error.stage,code:error.code,metrics:error.metrics}}:{}),raw_response:safeResponse,validation,...(transportDiagnostic?{transport_diagnostic:transportDiagnostic}:{}),error:validation ? 'source_observation_validation_failed' : phase==='save_result'?'source_receipt_persist_failed':'source_observation_failed_or_unknown'}));} catch {receiptPersisted=false;}
    throw new SourceVideoOperationError({ operationId:request.operationId, status:'failed', requestsAttempted:attempts, requestsSent:httpStatus === null && attempts > 0 ? 'unknown' : attempts > 0 ? 1 : 0,
      projectId:request.projectId, subject:request.subject,source_hash:request.source.hash,phase,model_retry_policy:retryPolicy,upstream_http_status:httpStatus,
      ...(transportDiagnostic?{transport_diagnostic:transportDiagnostic}:{}),
      receipt_persisted:receiptPersisted,
      ...(error instanceof VideoMediaError?{preparation_stage:error.stage}:{}),
      ...(observationMaterial?{observation_material:observationMaterial}:{}),
      validation, error:!receiptPersisted || phase==='save_result'?'source_receipt_persist_failed':validation ? 'source_observation_validation_failed' : 'source_observation_failed_or_unknown',
      ...(request.observationTask===undefined?{}:{observation_task:request.observationTask}),
      raw_response_available:!!safeResponse,receipt_reference:request.operationId,actual_handoff_verified:false,complete_film_accepted:false });
  }
}
export async function postSourceVideo(body:string,key:string,signal:AbortSignal,operationId:string) {
  return postSourceVideoTransport(body,key,signal,operationId,runtimeProfile().rootDir);
}
export function sourceVideoDependencies():SourceVideoDependencies {
  return {directory:join(runtimeProfile().rootDir,'clipmentor-source-video'),key:getKey('ROOTIFY_GATEWAY_API_KEY'),resolve:resolveUploadFile,hash:sha256File,
    prepareMedia:prepareVideoMedia,
    prepareObservation:(file,parentSha256,duration,range,signal)=>prepareObservationMaterial({file,parentSha256,duration,range,signal,directory:join(runtimeProfile().rootDir,'clipmentor-observation-media')}),read:readFile,size:async file=>(await stat(file)).size,post:postSourceVideo,
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

function normalizeTaskObservation(raw: unknown,input: ReturnType<typeof sourceVideoInput>) {
  if(!input.observation_task||!object(raw)||Object.hasOwn(raw,'task_observation')||!object(raw.observation_task))return raw;
  const {observation_task,...rest}=raw;
  return {...rest,task_observation:observation_task};
}

/** Project every duplicate diagnostic on read, including nested and offline-revalidated results. */
function publicTransportRecord(value:any,operationId:string):any {
  if(!object(value))return value;
  const {transport_diagnostic,...rest}=value;
  const safe=safeSourceTransportDiagnostic(transport_diagnostic,'',operationId);
  return {...rest,...(safe?{transport_diagnostic:safe}:{})};
}

/** No credential or network is required to inspect a retained operation. Legacy unbound records require explicit offline recovery. */
export async function readSourceVideoReceipt(operationId: string, projectId: string, deps: Pick<SourceVideoDependencies, 'directory'> & Partial<Pick<SourceVideoDependencies,'resolve'|'hash'>>): Promise<SourceVideoReceipt> {
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
    const safeSaved=publicTransportRecord(saved,operationId);
    return {...safeSaved,...(saved.result?{result:publicTransportRecord(saved.result,operationId)}:{})} as SourceVideoReceipt;
  }
  if (original.projectId !== projectId || !object(original.subject) || !text(original.source_hash)
    || !['preparing', 'reserved', 'failed', 'completed'].includes(original.status)) throw new Error('Receipt not bound to project; offline recovery required');
  // A cancelled caller may leave the operation failed while its noncooperative
  // transport later archives a complete response. Recover only the frozen,
  // hash-bound response; never change the original operation or submit again.
  if (original.requests_attempted === 1 && (original.status === 'reserved'
    || (original.status === 'failed' && ['gateway_request','save_result'].includes(original.phase)))) {
    try {
      const saved = await readSavedExternalResponse(deps.directory,operationId,{maxBytes:2_000_000,maxRecords:512});
      if(!object(saved)||saved.status!==200||!object(saved.body)||!deps.resolve||!deps.hash
        ||saved.fingerprint!==original.fingerprint||saved.logical_request_sha256!==original.logical_request_sha256
        ||saved.projectId!==projectId||JSON.stringify(saved.subject)!==JSON.stringify(original.subject)
        ||saved.source_hash!==original.source_hash||saved.source_src!==original.source_src
        ||saved.request_sha256!==original.request_sha256||!/^[a-f0-9]{64}$/.test(original.request_sha256)
        ||saved.input_sha256!==hash(JSON.stringify(original.input))||saved.video_bytes!==original.video_bytes
        ||!Number.isSafeInteger(original.video_bytes)||original.video_bytes<=0
        ||typeof original.source_src!=='string'||!original.source_src.startsWith('/media/uploads/'))throw Error('Saved source binding missing');
      const name=decodeURIComponent(original.source_src.slice('/media/uploads/'.length));
      if(!isSafeUploadName(name))throw Error('Saved source binding invalid');
      const file=deps.resolve(name);
      if(!file||await deps.hash(file)!==original.source_hash)throw Error('Saved source changed');
      const parsed=sourceObservationToSourceClock(normalizeTaskObservation(publicObservation(saved.body),original.input),original.observation_material);
      const observation=validateSourceVideoObservation(parsed,original.input);
      const diagnostic=safeSourceTransportDiagnostic(saved.diagnostic,'',operationId);
      const result:SourceVideoResult={operationId,requestsAttempted:1,subject:original.subject,source_hash:original.source_hash,
        requested_model:PREVIEW_REVIEW_MODEL,returned_model:typeof saved.body.modelVersion==='string'?saved.body.modelVersion:null,
        method_version:original.observation_material?MATERIAL_VERSION:VERSION,request_sha256:original.request_sha256,
        input_sha256:saved.input_sha256,video_bytes:original.video_bytes,validation:inspectSourceVideoObservation(parsed,original.input),
        input_media:{full_original_video:original.observation_material?.kind!=='stream_copy_excerpt',audio_stream_present:true,video_fps_requested:5},
        raw_observation:observation,finish_reasons:['STOP'],usage:saved.body.usageMetadata??null,
        ...(original.observation_material?{observation_material:original.observation_material}:{}),
        ...(original.input.observation_task?{observation_task:original.input.observation_task}:{}),
        ...(diagnostic?{transport_diagnostic:diagnostic}:{}),
        scope:'source_windows_and_planned_capacity_only',actual_handoff_verified:false,complete_film_accepted:false};
      if(await readFile(join(deps.directory,`${operationId}.json`),'utf8')!==originalText
        ||await deps.hash(file)!==original.source_hash)throw Error('Saved source changed during recovery');
      const recovered={operationId,projectId,status:'completed' as const,subject:original.subject,source_hash:original.source_hash,
        requestsAttempted:1,requestsSent:0 as const,receipt_persisted:true,model_retry_policy:original.model_retry_policy,
        result,raw_observation:observation,validation:result.validation,raw_response_available:true,receipt_reference:operationId,
        local_response_recovery:true,original_operation_status:original.status,
        ...(original.observation_material?{observation_material:original.observation_material}:{}),
        ...(original.input.observation_task?{observation_task:original.input.observation_task}:{}),
        ...(diagnostic?{transport_diagnostic:diagnostic}:{}),actual_handoff_verified:false as const,complete_film_accepted:false as const};
      return recovered;
    } catch { /* Missing, mismatched or invalid raw keeps the original outcome. */ }
  }
  let observed: unknown;
  try { observed = sourceObservationToSourceClock(publicObservation(original.raw_response),original.observation_material); } catch { /* Raw response remains private for diagnosis. */ }
  const transportDiagnostic=safeSourceTransportDiagnostic(original.transport_diagnostic,'',operationId);
  return { operationId,projectId,status:original.status,subject:original.subject,source_hash:original.source_hash,
    requestsAttempted:original.requests_attempted,model_retry_policy:original.model_retry_policy,requestsSent:0,receipt_persisted:true,phase:original.phase,upstream_http_status:original.http_status??transportDiagnostic?.http_status,
    error:original.error,validation:original.validation,raw_observation:observed,
    ...(original.phase==='prepare'&&['local_read','r2_upload','r2_readback','r2_sign'].includes(original.media_failure?.stage)
      ?{preparation_stage:original.media_failure.stage}:{}),
    ...(original.observation_material?{observation_material:original.observation_material}:{}),
    ...(transportDiagnostic?{transport_diagnostic:transportDiagnostic}:{}),
    ...(original.input?.observation_task===undefined?{}:{observation_task:original.input.observation_task}),
    ...(original.status === 'completed' ? {result:publicTransportRecord(original.result,operationId)} : {}),raw_response_available:!!original.raw_response,
    receipt_reference:operationId,actual_handoff_verified:false,complete_film_accepted:false };
}

/** Explicit local recovery of an unchanged saved response. The original failed ledger is never overwritten. No post() call. */
export async function recoverSourceVideoReceipt(request: SourceVideoRequest, reservedArchive: unknown, deps: SourceVideoDependencies): Promise<SourceVideoReceipt> {
  let input = sourceVideoInput(request),legacyAllUnits=false;
  if (reservedArchive!==undefined&&(!object(reservedArchive)||reservedArchive.status!=='reserved'||reservedArchive.requests_attempted!==1))
    throw new Error('Original reserved archive required');
  if (!OPERATION_ID.test(request.operationId)) throw new Error('Invalid receipt identity');
  const ledgerPath = join(deps.directory, `${request.operationId}.json`);
  const originalText = await readFile(ledgerPath, 'utf8'), failed = JSON.parse(originalText);
  const original = reservedArchive ?? failed;
  // Revalidate an old whole-file receipt against its actual frozen input, never reinterpret it as a new excerpt.
  if(!original.observation_material && JSON.stringify(original.input)!==JSON.stringify(input)) {
    const legacy=sourceVideoInput(request,true);
    if(JSON.stringify(original.input)===JSON.stringify(legacy)){input=legacy;legacyAllUnits=true;}
  }
  const rawObservation=publicObservation(failed.raw_response);
  const aliasNormalized=normalizeTaskObservation(rawObservation,input);
  const normalized=sourceObservationToSourceClock(aliasNormalized,original.observation_material);
  if(reservedArchive===undefined&&(rawObservation===aliasNormalized||failed.projectId!==request.projectId
    ||failed.validation?.status!=='invalid'||failed.validation.issues?.length!==1
    ||failed.validation.issues[0].code!=='missing_task_observation'))
   throw new Error('Saved response is not eligible for field alias recovery');
  const fingerprint = hash(VERSION + JSON.stringify(request));
  if (failed.status !== 'failed' || failed.requests_attempted !== 1 || failed.phase !== 'validate_response' || failed.http_status !== 200
    || failed.fingerprint !== fingerprint || original.fingerprint !== fingerprint
    || JSON.stringify(failed.subject) !== JSON.stringify(request.subject) || original.source_hash !== request.source.hash
    || JSON.stringify(original.input) !== JSON.stringify(input)) throw new Error('Recovery source/input binding mismatch');
  const name = decodeURIComponent(request.source.src.slice('/media/uploads/'.length));
  if (!isSafeUploadName(name)) throw new Error('Invalid source');
  const file = deps.resolve(name);
  if (!file || await deps.hash(file) !== request.source.hash) throw new Error('Recovery source unavailable or changed');
  let submittedFile=file;
  const material=original.observation_material as ObservationMaterial|undefined;
  if(material?.kind==='stream_copy_excerpt') {
    if(!deps.prepareObservation)throw Error('Recovery excerpt verifier unavailable');
    const selected=await deps.prepareObservation(file,request.source.hash,request.source.duration,sourceObservationRange(input),AbortSignal.timeout(60_000));
    if(JSON.stringify(selected.binding)!==JSON.stringify(material))throw Error('Recovery excerpt binding changed');
    submittedFile=selected.file;
  }
  const video = await deps.read(submittedFile),submittedHash=material?.submitted_sha256??request.source.hash;
  if (hash(video) !== submittedHash) throw new Error('Recovery source changed');
  const prepared = buildSourceVideoRequest(video, request, material, legacyAllUnits);
  if(original.media_transfer?.mode==='r2') {
    const media=original.media_transfer;
    if(media.scope!=='full_original_bytes'||media.verified_to!=='object_store'||media.sha256!==submittedHash||media.bytes!==video.length
      ||original.logical_request_sha256!==prepared.logical_request_sha256||failed.logical_request_sha256!==original.logical_request_sha256
      ||failed.request_sha256!==original.request_sha256||JSON.stringify(failed.media_transfer)!==JSON.stringify(media))throw new Error('Frozen R2 request identity mismatch');
  } else if (hash(prepared.body) !== original.request_sha256) throw new Error('Frozen request hash mismatch');
  const observation = validateSourceVideoObservation(normalized, input);
  const validation = inspectSourceVideoObservation(observation, input);
  const raw = failed.raw_response;
  const result: SourceVideoResult = {operationId:request.operationId,requestsAttempted:1,subject:request.subject,source_hash:request.source.hash,
    requested_model:PREVIEW_REVIEW_MODEL,returned_model:typeof raw.modelVersion === 'string' ? raw.modelVersion : null,method_version:material?MATERIAL_VERSION:VERSION,
    request_sha256:original.request_sha256,input_sha256:prepared.input_sha256,video_bytes:video.length,
    input_media:{full_original_video:material?.kind!=='stream_copy_excerpt',audio_stream_present:true,video_fps_requested:5},validation,raw_observation:observation,
    ...(material?{observation_material:material}:{}),
    ...(request.observationTask===undefined?{}:{observation_task:request.observationTask}),
    finish_reasons:['STOP'],usage:raw.usageMetadata ?? null,scope:'source_windows_and_planned_capacity_only',actual_handoff_verified:false,complete_film_accepted:false};
  const receipt: SourceVideoReceipt = {operationId:request.operationId,projectId:request.projectId,status:'failed',subject:request.subject,
    source_hash:request.source.hash,requestsAttempted:1,requestsSent:0,phase:failed.phase,upstream_http_status:200,
    validation,raw_observation:observation,result,raw_response_available:true,receipt_reference:request.operationId,
    ...(material?{observation_material:material}:{}),
    ...(request.observationTask===undefined?{}:{observation_task:request.observationTask}),
    revalidation:{version:validation.version,parent_status:'failed',original_record_sha256:hash(originalText),requestsSent:0},
    actual_handoff_verified:false,complete_film_accepted:false};
  const derivedPath = join(deps.directory, `${request.operationId}.revalidated.json`);
  try { await writeFile(derivedPath, JSON.stringify(receipt), {flag:'wx',mode:0o600}); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(derivedPath,'utf8') !== JSON.stringify(receipt)) throw new Error('Recovered receipt already exists or cannot be saved');
  }
  return receipt;
}
