import type { CopyProductionReview, TeachingPacket } from '../src/clipmentor/production-gate';

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
  inspection: { scope: 'copy_and_planned_picture_only'; sampled_frames: number; continuous_viewing: false; listening: false };
}
