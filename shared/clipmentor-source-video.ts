import type { CopyReviewRequest } from './clipmentor-copy-review';
/** Submitted bytes and their source clock; never a claim that the complete film was reviewed. */
export interface ObservationMaterial {
  version: 'observation-material-v1'; kind: 'full_file' | 'stream_copy_excerpt';
  parent_sha256: string; parent_bytes: number; parent_duration_seconds: number;
  requested_range_seconds: [number, number] | null;
  actual_source_range_seconds: [number, number];
  submitted_sha256: string; submitted_bytes: number; submitted_duration_seconds: number;
  source_seconds_at_submitted_zero: number;
  stream_copy: boolean; packet_payloads_verified: boolean;
  coverage: 'submitted_range_only'; complete_film_accepted: false;
}
export function isObservationMaterial(value: unknown): value is ObservationMaterial {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  if(Object.keys(value).some(k=>!['version','kind','parent_sha256','parent_bytes','parent_duration_seconds','requested_range_seconds',
    'actual_source_range_seconds','submitted_sha256','submitted_bytes','submitted_duration_seconds','source_seconds_at_submitted_zero',
    'stream_copy','packet_payloads_verified','coverage','complete_film_accepted'].includes(k)))return false;
  const v=value as ObservationMaterial,finite=(x:unknown):x is number=>typeof x==='number'&&Number.isFinite(x);
  const range=(r:unknown):r is [number,number]=>Array.isArray(r)&&r.length===2&&r.every(finite)&&r[0]>=0&&r[1]>r[0];
  if(v.version!=='observation-material-v1'||!['full_file','stream_copy_excerpt'].includes(v.kind)
    ||!(/^[a-f0-9]{64}$/.test(v.parent_sha256))||!(/^[a-f0-9]{64}$/.test(v.submitted_sha256))
    ||!Number.isSafeInteger(v.parent_bytes)||v.parent_bytes<=0||!Number.isSafeInteger(v.submitted_bytes)||v.submitted_bytes<=0
    ||!finite(v.parent_duration_seconds)||v.parent_duration_seconds<=0||!finite(v.submitted_duration_seconds)||v.submitted_duration_seconds<=0
    ||!finite(v.source_seconds_at_submitted_zero)||!range(v.actual_source_range_seconds)
    ||(v.requested_range_seconds!==null&&(!range(v.requested_range_seconds)||v.requested_range_seconds[1]>v.parent_duration_seconds))
    ||v.coverage!=='submitted_range_only'||v.complete_film_accepted!==false)return false;
  if(v.kind==='full_file')return v.parent_sha256===v.submitted_sha256&&v.parent_bytes===v.submitted_bytes
    &&v.source_seconds_at_submitted_zero===0&&v.submitted_duration_seconds===v.parent_duration_seconds
    &&v.actual_source_range_seconds[0]===0&&v.actual_source_range_seconds[1]===v.parent_duration_seconds
    &&v.stream_copy===false&&v.packet_payloads_verified===false
    &&(v.requested_range_seconds===null||(v.requested_range_seconds[0]===0&&v.requested_range_seconds[1]===v.parent_duration_seconds));
  return v.stream_copy===true&&v.packet_payloads_verified===true&&v.requested_range_seconds!==null
    &&v.actual_source_range_seconds[0]<=v.requested_range_seconds[0]&&v.actual_source_range_seconds[1]>=v.requested_range_seconds[1];
}
export interface SourceVideoTask {
  version: 'source-boundaries-v1';
  contexts: Array<{
    context_id: string; unit_id: string; source_range_seconds: [number, number];
    boundary_seconds: number[]; goals: Array<'speech_boundaries' | 'material_continuity'>;
  }>;
}
export type SourceVideoRequest = CopyReviewRequest & { observationTask?: SourceVideoTask };
export interface SourceTaskObservation {
  boundaries: Array<{
    context_id: string; boundary_seconds: number;
    status: 'sentence_boundary' | 'inside_speech' | 'uncertain';
    before: { status: 'heard' | 'unclear' | 'silence'; quote: string | null };
    after: { status: 'heard' | 'unclear' | 'silence'; quote: string | null };
    start_seconds: number; end_seconds: number; reason: string; time_uncertainty: string;
  }>;
  contexts: Array<{
    context_id: string;
    sequence: Array<{start_seconds:number;end_seconds:number;visible:string;audible:string}>;
    material_ranges: Array<{start_seconds:number;end_seconds:number;
      role:'use_process'|'closeup'|'same_frame_comparison'|'person_handoff'|'other'|'uncertain';
      basis:string;limitations:string[]}>;
    limitations: string[];
  }>;
}

/** Bounded, neutral observation targets only; never an alternate picture plan or an author verdict. */
export function validateSourceVideoTask(value: unknown, duration: number, unitIds: string[]): asserts value is SourceVideoTask {
  const obj=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v);
  const keys=(v:Record<string,unknown>,allowed:string[])=>Object.keys(v).every(k=>allowed.includes(k));
  const id=(v:unknown):v is string=>typeof v==='string'&&/^[\w:-]{1,80}$/.test(v);
  if(!obj(value)||!keys(value,['version','contexts'])||value.version!=='source-boundaries-v1'
    ||!Array.isArray(value.contexts)||!value.contexts.length||value.contexts.length>8) throw new Error('Invalid observation task');
  const ids=new Set<string>();
  for(const c of value.contexts) {
    if(!obj(c)||!keys(c,['context_id','unit_id','source_range_seconds','boundary_seconds','goals'])
      ||!id(c.context_id)||ids.has(c.context_id)||!unitIds.includes(c.unit_id)
      ||!Array.isArray(c.source_range_seconds)||c.source_range_seconds.length!==2
      ||!c.source_range_seconds.every((x:unknown)=>typeof x==='number'&&Number.isFinite(x))
      ||c.source_range_seconds[0]<0||c.source_range_seconds[1]>duration||c.source_range_seconds[1]<=c.source_range_seconds[0]
      ||!Array.isArray(c.goals)||!c.goals.length||c.goals.length>2||new Set(c.goals).size!==c.goals.length
      ||!c.goals.every((x:unknown)=>x==='speech_boundaries'||x==='material_continuity')
      ||!Array.isArray(c.boundary_seconds)||c.boundary_seconds.length>16||new Set(c.boundary_seconds).size!==c.boundary_seconds.length
      ||!c.boundary_seconds.every((x:unknown)=>typeof x==='number'&&Number.isFinite(x)&&x>=c.source_range_seconds[0]&&x<=c.source_range_seconds[1])
      ||(c.goals.includes('speech_boundaries') ? !c.boundary_seconds.length : c.boundary_seconds.length!==0)) throw new Error('Invalid observation context');
    ids.add(c.context_id);
  }
}
/** Expand only observation contexts whose internal cut lands exactly on a window edge. */
export function observationTaskWithBoundaryContext(task: SourceVideoTask, duration: number): SourceVideoTask {
  const paddingSeconds = 2;
  return {...task, contexts:task.contexts.map(context=>{
    const [start,end]=context.source_range_seconds;
    return {...context,source_range_seconds:[
      start>0&&context.boundary_seconds.includes(start)?Math.max(0,start-paddingSeconds):start,
      end<duration&&context.boundary_seconds.includes(end)?Math.min(duration,end+paddingSeconds):end,
    ]};
  })};
}
export interface SourceVideoObservation {
  windows: Array<{ window_id: string; observed_sequence: string; endpoint: string;
    evidence: Array<{ start_seconds: number; end_seconds: number; visible: string; audible: string }> }>;
  lines: Array<{ unit_id: string; line_id: string; status: 'supported' | 'not_supported' | 'insufficient_evidence'; reason: string; window_ids: string[] }>;
  limitations: string[];
  task_observation?: SourceTaskObservation;
}
export interface SourceVideoValidationIssue {
  code: string; severity: 'notice' | 'error'; window_id?: string; evidence_index?: number;
  field?: 'start_seconds' | 'end_seconds'; observed_seconds?: number; boundary_seconds?: number;
  window_seconds?: [number, number]; delta_ms?: number;
}
export interface SourceVideoValidation {
  version: string; status: 'valid' | 'invalid'; time_tolerance_seconds: number; issues: SourceVideoValidationIssue[];
}
/** Client transport facts only; no claim about gateway dispatch, model execution or billing. */
export interface SourceVideoTransportDiagnostic {
  version: 'source-transport-v1'; operation_id: string;
  started_at: string; ended_at: string; request_bytes: number;
  curl_exit_code: number | null;
  error_kind: 'none' | 'curl_timeout' | 'aborted' | 'spawn_failed' | 'curl_failed' | 'invalid_metrics';
  http_status: number | null;
  /** Observed transport boundary, not an inferred gateway/upstream root cause. Recomputed on read. */
  response_boundary?: 'response_received' | 'gateway_or_upstream_error_unattributed' | 'body_not_fully_sent' | 'no_final_response_unattributed' | 'local_process_failure';
  cleanup_status?: 'completed' | 'failed';
  metrics: Partial<Record<'size_upload' | 'size_download' | 'time_namelookup' | 'time_connect' | 'time_appconnect' | 'time_pretransfer' | 'time_starttransfer' | 'time_total', number>>;
  /** Sent bytes do not prove the gateway received the entire body. First byte may be HTTP 100. */
  upload_matches_request_bytes?: boolean;
  first_byte_may_be_interim: true;
  request_ids: Partial<Record<'x-oneapi-request-id' | 'x-request-id' | 'cf-ray', string>>;
  response_body: {
    format: 'json' | 'html' | 'text' | 'missing' | 'unreadable'; bytes: number;
    inspected_bytes: number; truncated: boolean; prefix_sha256?: string;
    message_class: 'timeout' | 'rate_limit' | 'authentication' | 'invalid_argument' | 'other' | 'none';
    error_code?: number; error_type?: 'upstream_error' | 'timeout' | 'gateway_timeout' | 'rate_limit_error' | 'invalid_request_error' | 'authentication_error' | 'server_error';
  };
}

export interface SourceVideoReceipt {
  preparation_stage?: 'local_read' | 'r2_upload' | 'r2_readback' | 'r2_sign';
  observation_material?: ObservationMaterial;
  model_retry_policy?: 'no_automatic_retry';
  operationId: string; status: 'preparing' | 'reserved' | 'failed' | 'completed';
  requestsAttempted: number; requestsSent: 0 | 1 | 'unknown'; projectId: string; subject: SourceVideoRequest['subject']; source_hash: string;
  phase?: string; upstream_http_status?: number | null; error?: string; validation?: SourceVideoValidation;
  raw_observation?: unknown; result?: SourceVideoResult; raw_response_available: boolean;
  revalidation?: { version: string; parent_status: 'failed'; original_record_sha256: string; requestsSent: 0 };
  receipt_reference: string; actual_handoff_verified: false; complete_film_accepted: false;
  observation_task?: SourceVideoTask;
  transport_diagnostic?: SourceVideoTransportDiagnostic;
  /** False means the returned failure is not the latest durable state; keep the operation consumed. */
  receipt_persisted?: boolean;
}
export interface SourceVideoResult {
  operationId: string; requestsAttempted: 1; cached?: true;
  subject: SourceVideoRequest['subject']; source_hash: string;
  requested_model: string; returned_model: string | null; method_version: string;
  request_sha256: string; input_sha256: string; video_bytes: number;
  input_media: { full_original_video: boolean; audio_stream_present: true; video_fps_requested: 5 };
  observation_material?: ObservationMaterial;
  validation: SourceVideoValidation;
  raw_observation: SourceVideoObservation; finish_reasons: string[]; usage: unknown;
  scope: 'source_windows_and_planned_capacity_only'; actual_handoff_verified: false; complete_film_accepted: false;
  observation_task?: SourceVideoTask;
  transport_diagnostic?: SourceVideoTransportDiagnostic;
}

// Shared closed projection also protects Agent failure settlement.
type Diagnostic = SourceVideoTransportDiagnostic;
const METRICS = ['size_upload','size_download','time_namelookup','time_connect','time_appconnect','time_pretransfer','time_starttransfer','time_total'] as const;
const IDS = ['x-oneapi-request-id','x-request-id','cf-ray'] as const;
const ERRORS = ['none','curl_timeout','aborted','spawn_failed','curl_failed','invalid_metrics'] as const;
const FORMATS = ['json','html','text','missing','unreadable'] as const;
const MESSAGES = ['timeout','rate_limit','authentication','invalid_argument','other','none'] as const;
const TYPES = ['upstream_error','timeout','gateway_timeout','rate_limit_error','invalid_request_error','authentication_error','server_error'] as const;
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const status = (v: unknown): v is number => Number.isInteger(v) && Number(v) >= 100 && Number(v) <= 599;
const obj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const date = (v: unknown): v is string => typeof v === 'string' && v.length<=32 && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v) && Number.isFinite(Date.parse(v));

/** Re-project at every persistence boundary. Never retain arbitrary headers, error prose or URLs. */
export function safeSourceTransportDiagnostic(v: unknown, key: string, operationId: string): Diagnostic | undefined {
  if (!obj(v) || v.version !== 'source-transport-v1' || v.operation_id !== operationId || !date(v.started_at) || !date(v.ended_at)
    || !number(v.request_bytes) || !ERRORS.includes(v.error_kind) || !obj(v.metrics) || !obj(v.request_ids) || !obj(v.response_body)) return;
  const metrics: Diagnostic['metrics'] = {}, ids: Diagnostic['request_ids'] = {};
  for (const name of METRICS) if (number(v.metrics[name])) metrics[name] = v.metrics[name];
  for (const name of IDS) {
    const value = v.request_ids[name];
    if (typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/.test(value) && (!key || !value.includes(key))
      && !/^(?:Bearer|Basic|sk-|__OPENCHATCUT_URI__)/i.test(value)) ids[name] = value;
  }
  const b = v.response_body;
  const response: Diagnostic['response_body'] = {format:FORMATS.includes(b.format)?b.format:'unreadable',bytes:number(b.bytes)?b.bytes:0,
    inspected_bytes:number(b.inspected_bytes)?b.inspected_bytes:0,truncated:b.truncated===true,
    message_class:MESSAGES.includes(b.message_class)?b.message_class:'other'};
  if (typeof b.prefix_sha256 === 'string' && /^[a-f0-9]{64}$/.test(b.prefix_sha256)) response.prefix_sha256=b.prefix_sha256;
  if (status(b.error_code)) response.error_code=b.error_code;
  if (TYPES.includes(b.error_type)) response.error_type=b.error_type;
  const httpStatus=status(v.http_status)?v.http_status:null;
  const boundary:Diagnostic['response_boundary']=httpStatus!==null&&httpStatus>=400?'gateway_or_upstream_error_unattributed':
    httpStatus!==null&&httpStatus>=200?'response_received':v.error_kind==='spawn_failed'?'local_process_failure':
    number(metrics.size_upload)&&metrics.size_upload<v.request_bytes?'body_not_fully_sent':'no_final_response_unattributed';
  return {version:'source-transport-v1',operation_id:operationId,started_at:v.started_at,ended_at:v.ended_at,request_bytes:v.request_bytes,
    curl_exit_code:Number.isInteger(v.curl_exit_code) && v.curl_exit_code >= 0 && v.curl_exit_code <= 255 ? v.curl_exit_code : null,
    error_kind:v.error_kind,http_status:httpStatus,response_boundary:boundary,metrics,request_ids:ids,
    ...(['completed','failed'].includes(v.cleanup_status)?{cleanup_status:v.cleanup_status}:{}),
    ...(number(metrics.size_upload)?{upload_matches_request_bytes:metrics.size_upload===v.request_bytes}:{}),
    first_byte_may_be_interim:true,response_body:response};
}
