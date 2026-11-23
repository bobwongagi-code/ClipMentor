import type { H264EncoderProfile } from '../media-acceleration.ts';
import { exportAttemptIdFromFilename } from '../../shared/export-media-names.ts';

export type GenerationJobStatus = 'queued' | 'running' | 'succeeded' | 'failed';
export type GenerationRetryClass = 'none' | 'provider-retryable' | 'provider-terminal' | 'download-retryable' | 'restart-recoverable';
export type GenerationCleanupPolicy = 'server-export';

export interface GenerationResult {
  assetId: string;
  kind: 'audio' | 'video' | 'image';
  name: string;
  path: string;
  durationSeconds: number;
  width?: number;
  height?: number;
  fps?: number;
  /** Offset of a ranged export within the source timeline. */
  sourceStartSeconds?: number;
  /** Provider license record id for the generated track (also archived as a
   * `.license.json` sidecar beside the audio file). */
  licenseId?: string;
  sizeBytes?: number;
  codec?: string;
  encoder?: H264EncoderProfile;
  encoderFallbackReason?: string;
}

export class IncompleteGenerationResultError extends Error {
  readonly code = 'generation_result_incomplete';
  readonly retryable = true;
  readonly expected: number;
  readonly actual: number;

  constructor(expected: number, actual: number) {
    super(`generation result checkpoint is incomplete (${actual}/${expected})`);
    this.name = 'IncompleteGenerationResultError';
    this.expected = expected;
    this.actual = actual;
  }
}

export function mergeGenerationResultUrls(
  stored: readonly string[],
  incoming: readonly string[],
): string[] {
  return [...new Set([...stored, ...incoming].filter((url) => Boolean(url)))];
}

export function setGenerationResultUrlAt(
  stored: readonly string[],
  resultIndex: number,
  url: string,
): string[] {
  if (!Number.isSafeInteger(resultIndex) || resultIndex < 0 || resultIndex > stored.length || !url) {
    throw new Error('generation result URL checkpoint index is invalid');
  }
  const next = [...stored];
  next[resultIndex] = url;
  return next;
}

export function requireGenerationResultUrls(urls: readonly string[], expected: number): string[] {
  const merged = mergeGenerationResultUrls([], urls);
  if (merged.length < expected) throw new IncompleteGenerationResultError(expected, merged.length);
  return merged.slice(0, expected);
}

export interface GenerationResultCheckpoint {
  urls: string[];
  complete: boolean;
}

export function generationResultCheckpoint(
  stored: readonly string[],
  expected: number,
  providerTaskId?: string,
): GenerationResultCheckpoint {
  const urls = mergeGenerationResultUrls([], stored);
  if (urls.length > 0 && urls.length < expected && !providerTaskId) {
    throw new IncompleteGenerationResultError(expected, urls.length);
  }
  return {
    urls: urls.slice(0, expected),
    complete: urls.length >= expected,
  };
}

export interface GenerationOperationTimestamps {
  createdAt: number;
  submittedAt: number;
  acceptedAt?: number;
  startedAt?: number;
  succeededAt?: number;
  failedAt?: number;
  updatedAt: number;
}

export interface AcceptanceWaiter {
  promise: Promise<GenerationAcceptance>;
  resolve: (acceptance: GenerationAcceptance) => void;
  reject: (error: Error) => void;
  settled: boolean;
}

export interface GenerationJob {
  id: string;
  status: GenerationJobStatus;
  progress: number;
  phase?: string;
  processedFrames?: number;
  totalFrames?: number;
  params: Record<string, unknown>;
  submitArgs?: Record<string, unknown>;
  toolName?: string;
  label?: string;
  provider?: string;
  providerTaskId?: string;
  sourceRevisions?: string[];
  resultUrls?: string[];
  expectedResultCount?: number;
  retryClass: GenerationRetryClass;
  timestamps: GenerationOperationTimestamps;
  createdAt: number;
  updatedAt: number;
  result?: GenerationResult;
  results?: GenerationResult[];
  error?: string;
  code?: string;
  retryable?: boolean;
  pendingDownloadUrl?: string;
  resumeDownload?: () => Promise<GenerationResult | GenerationResult[]>;
  resumeDownloadUrl?: string;
  cleanupResult?: (result: GenerationResult) => Promise<void> | void;
  cleanupPolicy?: string;
  retentionMs: number;
  expiryTimer?: NodeJS.Timeout;
  acceptance?: AcceptanceWaiter;
  restored?: boolean;
  resuming?: boolean;
}

export interface GenerationJobSnapshot {
  id: string;
  operationId: string;
  status: GenerationJobStatus;
  progress: number;
  phase?: string;
  processedFrames?: number;
  totalFrames?: number;
  params: Record<string, unknown>;
  submitArgs?: Record<string, unknown>;
  toolName?: string;
  label?: string;
  provider?: string;
  providerTaskId?: string;
  sourceRevisions?: string[];
  resultUrls?: string[];
  expectedResultCount?: number;
  retryClass: GenerationRetryClass;
  timestamps: GenerationOperationTimestamps;
  createdAt: number;
  updatedAt: number;
  result?: GenerationResult;
  results?: GenerationResult[];
  error?: string;
  code?: string;
  retryable?: boolean;
  cleanupPolicy?: string;
  pendingDownloadUrl?: string;
  cancellationRequested?: boolean;
}

export interface GenerationJobProgress {
  progress?: number;
  phase?: string;
  processedFrames?: number;
  totalFrames?: number;
}

export type UpdateGenerationJob = (progress: GenerationJobProgress) => Promise<void>;
export type RegisterGenerationDownload = (
  url: string,
  resume: () => Promise<GenerationResult | GenerationResult[]>,
  resultIndex?: number,
) => Promise<void>;
export type RegisterGenerationProviderTask = (provider: string, providerTaskId: string) => Promise<void>;
export type GenerationJobTask = (
  operationId: string,
  update: UpdateGenerationJob,
  registerDownload: RegisterGenerationDownload,
  registerProviderTask: RegisterGenerationProviderTask,
) => Promise<GenerationResult | GenerationResult[]>;

export interface GenerationJobOptions {
  operationId?: string;
  provider?: string;
  toolName?: string;
  label?: string;
  submitArgs?: Record<string, unknown>;
  sourceRevisions?: string[];
  expectedResultCount?: number;
  acquire?: () => Promise<() => void>;
  cleanupResult?: (result: GenerationResult) => Promise<void> | void;
  cleanupPolicy?: GenerationCleanupPolicy;
  retentionMs?: number;
  publishResult?: (result: GenerationResult) => Promise<void>;
  onCancelled?: () => Promise<void>;
  onSettled?: (jobId: string) => void;
}

export interface GenerationJobSubmission {
  operationId: string;
  jobId: string;
  status: 'queued';
}

export interface GenerationAcceptance extends GenerationJobSubmission {
  provider?: string;
  providerTaskId?: string;
  acceptedAt: number;
  sourceRevisions?: string[];
}

export type GenerationJobResumer = (
  snapshot: GenerationJobSnapshot,

  update: UpdateGenerationJob,
  registerDownload: RegisterGenerationDownload,
  registerProviderTask: RegisterGenerationProviderTask,
) => Promise<GenerationResult | GenerationResult[]>;

export type GenerationCleanupPolicyHandler = (result: GenerationResult) => Promise<void> | void;
export type GenerationRetentionGuard = (jobId: string) => Promise<boolean> | boolean;


export const TERMINAL = new Set<GenerationJobStatus>(['succeeded', 'failed']);

export function isGenerationExecutionAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** Directory moves copy media as well as the ledger. A running export can
 * still be writing its output outside the directory lock. */
export function assertNoActiveExportForRelocation(ledger: unknown): void {
  if (!ledger || typeof ledger !== 'object' || !('jobs' in ledger) || !Array.isArray(ledger.jobs)) return;
  for (const row of ledger.jobs) {
    if (row?.params?.kind !== 'export' || (row.status !== 'queued' && row.status !== 'running')) continue;
    throw new Error('an export is still active or awaiting recovery; finish it before moving the data directory');
  }
}


export function committedExportSizes(rows: Iterable<Partial<GenerationJobSnapshot>>) {
  const files = new Map<string, number | undefined>();
  const prefix = '/media/uploads/';
  for (const row of rows) {
    if (row?.status !== 'succeeded' || row.params?.kind !== 'export') continue;
    const result = row.result;
    if (typeof result?.path !== 'string' || typeof result.assetId !== 'string' || !result.path.startsWith(prefix)) continue;
    const name = result.path.slice(prefix.length);
    const attempt = exportAttemptIdFromFilename(name);
    if (!attempt || attempt !== result.assetId.toLowerCase()
      || (row.params.exportAttemptId !== undefined
        && (row.params.exportAttemptId !== attempt || result.sizeBytes === undefined))
      || (result.sizeBytes !== undefined && (!Number.isSafeInteger(result.sizeBytes) || result.sizeBytes <= 0))) continue;
    files.set(name, result.sizeBytes);
  }
  return files;
}

export function exportSizeMatches(actual: number, expected: number | undefined): boolean {
  return actual > 0 && (expected === undefined || actual === expected);
}

export function snapshotOf(job: GenerationJob): GenerationJobSnapshot {
  return {
    id: job.id,
    operationId: job.id,
    status: job.status,
    progress: job.progress,
    phase: job.phase,
    processedFrames: job.processedFrames,
    totalFrames: job.totalFrames,
    params: job.params,
    submitArgs: job.submitArgs,
    toolName: job.toolName,
    label: job.label,
    provider: job.provider,
    providerTaskId: job.providerTaskId,
    sourceRevisions: job.sourceRevisions,
    resultUrls: job.resultUrls,
    expectedResultCount: job.expectedResultCount,
    retryClass: job.retryClass,
    timestamps: job.timestamps,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: job.result,
    results: job.results,
    error: job.error,
    code: job.code,
    retryable: job.retryable,
    cleanupPolicy: job.cleanupPolicy,
    pendingDownloadUrl: job.pendingDownloadUrl,
  };
}

export function acceptanceOf(job: GenerationJob): GenerationAcceptance {
  return {
    operationId: job.id,
    jobId: job.id,
    status: 'queued',
    provider: job.provider,
    providerTaskId: job.providerTaskId,
    acceptedAt: job.timestamps.acceptedAt ?? job.updatedAt,
    sourceRevisions: job.sourceRevisions,
  };
}

export function makeAcceptanceWaiter(): AcceptanceWaiter {
  let resolvePromise!: (acceptance: GenerationAcceptance) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<GenerationAcceptance>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  // Some non-provider jobs never await acceptance; mark rejection as observed.
  void promise.catch(() => undefined);
  return {
    promise,
    settled: false,
    resolve(acceptance) {
      if (this.settled) return;
      this.settled = true;
      resolvePromise(acceptance);
    },
    reject(error) {
      if (this.settled) return;
      this.settled = true;
      rejectPromise(error);
    },
  };
}
