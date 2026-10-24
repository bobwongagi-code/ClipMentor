import type { CopyReviewRequest } from './clipmentor-copy-review';
export type SourceVideoRequest = CopyReviewRequest;
export interface SourceVideoObservation {
  windows: Array<{ window_id: string; observed_sequence: string; endpoint: string;
    evidence: Array<{ start_seconds: number; end_seconds: number; visible: string; audible: string }> }>;
  lines: Array<{ unit_id: string; line_id: string; status: 'supported' | 'not_supported' | 'insufficient_evidence'; reason: string; window_ids: string[] }>;
  limitations: string[];
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
  operationId: string; status: 'preparing' | 'reserved' | 'failed' | 'completed';
  requestsAttempted: number; requestsSent: 0 | 1 | 'unknown'; projectId: string; subject: SourceVideoRequest['subject']; source_hash: string;
  phase?: string; upstream_http_status?: number | null; error?: string; validation?: SourceVideoValidation;
  raw_observation?: unknown; result?: SourceVideoResult; raw_response_available: boolean;
  revalidation?: { version: string; parent_status: 'failed'; original_record_sha256: string; requestsSent: 0 };
  receipt_reference: string; actual_handoff_verified: false; complete_film_accepted: false;
  transport_diagnostic?: SourceVideoTransportDiagnostic;
  /** False means the returned failure is not the latest durable state; keep the operation consumed. */
  receipt_persisted?: boolean;
}
export interface SourceVideoResult {
  operationId: string; requestsAttempted: 1; cached?: true;
  subject: SourceVideoRequest['subject']; source_hash: string;
  requested_model: string; returned_model: string | null; method_version: string;
  request_sha256: string; input_sha256: string; video_bytes: number;
  input_media: { full_original_video: true; audio_stream_present: true; video_fps_requested: 5 };
  validation: SourceVideoValidation;
  raw_observation: SourceVideoObservation; finish_reasons: string[]; usage: unknown;
  scope: 'source_windows_and_planned_capacity_only'; actual_handoff_verified: false; complete_film_accepted: false;
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
  return {version:'source-transport-v1',operation_id:operationId,started_at:v.started_at,ended_at:v.ended_at,request_bytes:v.request_bytes,
    curl_exit_code:Number.isInteger(v.curl_exit_code) && v.curl_exit_code >= 0 && v.curl_exit_code <= 255 ? v.curl_exit_code : null,
    error_kind:v.error_kind,http_status:status(v.http_status)?v.http_status:null,metrics,request_ids:ids,
    ...(['completed','failed'].includes(v.cleanup_status)?{cleanup_status:v.cleanup_status}:{}),
    ...(number(metrics.size_upload)?{upload_matches_request_bytes:metrics.size_upload===v.request_bytes}:{}),
    first_byte_may_be_interim:true,response_body:response};
}
