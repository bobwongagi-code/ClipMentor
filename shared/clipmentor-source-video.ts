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
export interface SourceVideoReceipt {
  operationId: string; status: 'preparing' | 'reserved' | 'failed' | 'completed';
  requestsAttempted: number; requestsSent: 0 | 1 | 'unknown'; projectId: string; subject: SourceVideoRequest['subject']; source_hash: string;
  phase?: string; upstream_http_status?: number | null; error?: string; validation?: SourceVideoValidation;
  raw_observation?: unknown; result?: SourceVideoResult; raw_response_available: boolean;
  revalidation?: { version: string; parent_status: 'failed'; original_record_sha256: string; requestsSent: 0 };
  receipt_reference: string; actual_handoff_verified: false; complete_film_accepted: false;
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
}
