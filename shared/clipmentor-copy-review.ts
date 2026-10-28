import type { CopyProductionReview, TeachingPacket } from '../src/clipmentor/production-gate';

/** Host-selected policy, not an author-controlled review mode. */
export const COPY_REVIEW_INPUT_POLICY = 'independent_current_subject_v1' as const;

/** Closed diagnostic vocabulary: never send provider errors, source paths or raw output to the author. */
export const COPY_REVIEW_FAILURES = {
  request_invalid: [400, 'request'],
  source_review_scope_missing: [400, 'request'],
  picture_plan_shape_invalid: [400, 'request'],
  source_unavailable_or_changed: [409, 'source'],
  operation_unavailable: [409, 'reservation'],
  legacy_failure_details_missing: [409, 'reservation'],
  frames_unavailable: [422, 'frames'],
  runner_unavailable: [503, 'runner_start'],
  model_turn_failed: [502, 'model_turn'],
  frame_inspection_incomplete: [502, 'frame_delivery'],
  response_too_large: [502, 'response_parse'],
  response_not_json: [502, 'response_parse'],
  response_schema_invalid: [502, 'response_validation'],
  response_scope_invalid: [502, 'response_validation'],
  response_teaching_invalid: [502, 'response_validation'],
  response_copy_unit_invalid: [502, 'response_validation'],
  response_receipt_invalid: [502, 'response_validation'],
  review_cancelled_or_timed_out: [504, 'model_turn'],
  review_storage_failed: [500, 'persistence'],
} as const;
export interface CopyReviewFailure {
  code: keyof typeof COPY_REVIEW_FAILURES;
  stage: typeof COPY_REVIEW_FAILURES[keyof typeof COPY_REVIEW_FAILURES][1];
  operationId?: string;
  requestsAttempted: 0 | 1 | null;
  retryable: false;
  inspection?: { expectedBatches: number; deliveredBatches: number; invalidBatchCalls: number; outputChars: number };
}
export function isCopyReviewFailure(v: unknown): v is CopyReviewFailure {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const d = v as Record<string, unknown>;
  if (typeof d.code !== 'string' || !Object.hasOwn(COPY_REVIEW_FAILURES, d.code)
    || d.stage !== COPY_REVIEW_FAILURES[d.code as keyof typeof COPY_REVIEW_FAILURES][1]
    || ![0, 1, null].includes(d.requestsAttempted as 0 | 1 | null) || d.retryable !== false
    || (d.operationId !== undefined && (typeof d.operationId !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(d.operationId)))
    || Object.keys(d).some(k => !['code', 'stage', 'operationId', 'requestsAttempted', 'retryable', 'inspection'].includes(k))) return false;
  if (d.inspection !== undefined) {
    if (!d.inspection || typeof d.inspection !== 'object' || Array.isArray(d.inspection)) return false;
    const i = d.inspection as Record<string, unknown>;
    if (Object.keys(i).length !== 4 || ['expectedBatches', 'deliveredBatches', 'invalidBatchCalls', 'outputChars']
      .some(k => !Number.isSafeInteger(i[k]) || Number(i[k]) < 0)
      || Number(i.deliveredBatches) > Number(i.expectedBatches)) return false;
  }
  return true;
}

/** Built by the tool handler, not model-authored review material or verdicts. */
export interface CopyReviewRequest {
  operationId: string;
  maxRequests: 1;
  projectId: string;
  authorRunId: string;
  source: { src: string; hash: string; fps: number; duration: number };
  subject: { revision: number; digest: string; units: Array<{ unit_id: string; candidate_id: string }> };
  packet: TeachingPacket;
}
export interface CopyReviewResult {
  operationId: string;
  requestsAttempted: number;
  cached?: true;
  receipt: CopyProductionReview;
  inspection: { scope: 'copy_and_planned_picture_only'; sampled_frames: number; continuous_viewing: false; listening: false;
    input_policy?: typeof COPY_REVIEW_INPUT_POLICY };
}
