import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ResultDownloadError } from './result-download.ts';
import {
  TERMINAL,
  acceptanceOf,
  makeAcceptanceWaiter,
  mergeGenerationResultUrls,
  requireGenerationResultUrls,
  setGenerationResultUrlAt,
  snapshotOf,
} from './generation-job-types.ts';
import type {
  GenerationAcceptance,
  GenerationJob,
  GenerationJobOptions,
  GenerationJobProgress,
  GenerationJobSnapshot,
  GenerationJobSubmission,
  GenerationJobTask,
  GenerationResult,
} from './generation-job-types.ts';
import {
  cleanOldJobs,
  committedGenerationSnapshot,
  evictTerminalJob,
  jobs,
  isGenerationJobEvicting,
  loadPersistedJobs,
  normalizeRetentionMs,
  persistGenerationJobReservation,
  persistGenerationJob,
  refreshGenerationJobs,
  hasLiveGenerationOwner,
  resumerKey,
  resumers,
  scheduleExpiry,
} from './generation-job-store.ts';

let loadPromise: Promise<void> | undefined;

export function initializeGenerationJobs(): Promise<void> {
  if (!loadPromise) {
    let loaded=false;
    const attempt=loadPersistedJobs().then(()=>{loaded=true;return resumeRestoredJobs();});
    loadPromise=attempt;
    // Retry only failed local hydration; never replay a failed resumer attempt.
    void attempt.catch(()=>{if(!loaded&&loadPromise===attempt)loadPromise=undefined;});
  }
  return loadPromise;
}

function applyProgress(job: GenerationJob, next: GenerationJobProgress): void {
  if (TERMINAL.has(job.status)) return;
  if (next.progress !== undefined && Number.isFinite(next.progress)) {
    job.progress = Math.max(job.progress, Math.min(99, Math.max(0, next.progress)));
  }
  if (next.phase !== undefined) job.phase = next.phase;
  if (next.totalFrames !== undefined && Number.isFinite(next.totalFrames)) job.totalFrames = Math.max(0, Math.floor(next.totalFrames));
  if (next.processedFrames !== undefined && Number.isFinite(next.processedFrames)) {
    const processed = Math.max(0, Math.floor(next.processedFrames));
    job.processedFrames = job.totalFrames === undefined ? processed : Math.min(job.totalFrames, processed);
  }
  job.updatedAt = Date.now();
  job.timestamps.updatedAt = job.updatedAt;
}


function completeGenerationJob(job: GenerationJob, returned: GenerationResult | GenerationResult[]): void {
  if (job.expectedResultCount !== undefined) {
    requireGenerationResultUrls(job.resultUrls ?? [], job.expectedResultCount);
  }
  job.results = Array.isArray(returned) ? returned : [returned];
  job.result = job.results[0];
  job.status = 'succeeded';
  job.progress = 100;
  job.phase = 'completed';
  job.error = undefined;
  job.code = undefined;
  job.retryable = undefined;
  job.pendingDownloadUrl = undefined;
  job.resumeDownload = undefined;
  job.resumeDownloadUrl = undefined;
  job.retryClass = 'none';
  job.timestamps.succeededAt = Date.now();
  if (!job.timestamps.acceptedAt) job.timestamps.acceptedAt = job.timestamps.succeededAt;
  if (job.totalFrames !== undefined) job.processedFrames = job.totalFrames;
}

function failGenerationJob(job: GenerationJob, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const rawCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const rawRetryable = error && typeof error === 'object' && 'retryable' in error ? error.retryable : undefined;
  const code = rawCode === undefined ? undefined : String(rawCode);
  const retryable = typeof rawRetryable === 'boolean' ? rawRetryable : undefined;
  job.status = 'failed';
  job.error = message;
  job.code = code;
  job.retryable = retryable;
  if (error instanceof ResultDownloadError) job.pendingDownloadUrl = error.retryable ? error.url : undefined;
  else job.pendingDownloadUrl = job.resumeDownloadUrl;
  job.progress = 100;
  job.phase = 'failed';
  job.timestamps.failedAt = Date.now();
  if (job.pendingDownloadUrl) job.retryClass = 'download-retryable';
  else if (retryable === false) job.retryClass = 'provider-terminal';
  else if (retryable === true) job.retryClass = 'provider-retryable';
  else if (job.providerTaskId && !/(?:failed|cancelled|expired|invalid)/i.test(message)) job.retryClass = 'provider-retryable';
  else job.retryClass = 'provider-terminal';
}

const pendingSettlements = new WeakMap<GenerationJob, GenerationJob>();
const settlementWrites = new WeakMap<GenerationJob, Promise<void>>();

function saveSettlement(job: GenerationJob): Promise<void> {
  const writing = settlementWrites.get(job);
  if (writing) return writing;
  const next = pendingSettlements.get(job);
  if (!next) return Promise.resolve();
  const write = applySettlement(job, next).finally(() => settlementWrites.delete(job));
  settlementWrites.set(job, write);
  return write;
}

async function applySettlement(job: GenerationJob, next: GenerationJob): Promise<void> {
  if (!await persistGenerationJob(job, next)) {
    pendingSettlements.delete(job);
    return;
  }
  pendingSettlements.delete(job);
  if (job.timestamps.acceptedAt) job.acceptance?.resolve(acceptanceOf(job));
  else job.acceptance?.reject(Object.assign(new Error(job.error ?? 'generation did not start'), {
    code: job.code, retryable: job.retryable,
  }));
  scheduleExpiry(job);
}

function settleGenerationJob(job: GenerationJob, settle: (next: GenerationJob) => void): Promise<void> {
  const next = { ...job, timestamps: { ...job.timestamps }, resuming: false };
  settle(next);
  next.updatedAt = Date.now();
  next.timestamps.updatedAt = next.updatedAt;
  pendingSettlements.set(job, next);
  return saveSettlement(job);
}

async function saveProgress(job: GenerationJob): Promise<void> {
  if (!await persistGenerationJob(job)) throw new Error('generation job changed in another process');
}

async function runGenerationJob(job: GenerationJob, task: GenerationJobTask, options: GenerationJobOptions): Promise<void> {
  let release: (() => void) | undefined,active=true;
  const current=()=>active&&jobs.get(job.id)===job&&job.status==='running'&&!isGenerationJobEvicting(job.id);
  let finish: (next: GenerationJob) => void;
  try {
    release = await options.acquire?.();
    job.status = 'running';
    job.progress = Math.max(job.progress, 10);
    job.phase = 'starting';
    job.error = undefined;
    job.code = undefined;
    job.retryable = undefined;
    job.restored = false;
    job.retryClass = 'none';
    job.updatedAt = Date.now();
    job.timestamps.startedAt ??= job.updatedAt;
    job.timestamps.updatedAt = job.updatedAt;
    await saveProgress(job);
    const returned = await task(
      job.id,
      async (next) => {
        if(!current())return;
        applyProgress(job, next);
        await saveProgress(job);
      },
      async (url, resume, resultIndex) => {
        if(!current())return;
        job.resumeDownloadUrl = url;
        job.resumeDownload = resume;
        job.resultUrls = resultIndex === undefined
          ? mergeGenerationResultUrls(job.resultUrls ?? [], [url])
          : setGenerationResultUrlAt(job.resultUrls ?? [], resultIndex, url);
        job.timestamps.acceptedAt ??= Date.now();
        job.updatedAt = Date.now();
        job.timestamps.updatedAt = job.updatedAt;
        await saveProgress(job);
        if(current())job.acceptance?.resolve(acceptanceOf(job));
      },
      async (provider, providerTaskId) => {
        if(!current())return;
        if (!providerTaskId.trim()) throw new Error(`${provider} did not return a provider task id`);
        job.provider = provider;
        job.providerTaskId = providerTaskId;
        job.timestamps.acceptedAt ??= Date.now();
        job.updatedAt = Date.now();
        job.timestamps.updatedAt = job.updatedAt;
        await saveProgress(job);
        if(current())job.acceptance?.resolve(acceptanceOf(job));
      },
    );
    finish = (next) => {
      try { completeGenerationJob(next, returned); }
      catch (error) { failGenerationJob(next, error); }
    };
  } catch (error) {
    finish = (next) => failGenerationJob(next, error);
  } finally {
    active = false;
  }
  try {
    await settleGenerationJob(job, finish);
  } catch (error) {
    console.warn(`[generation-job] failed to persist ${job.id}: ${error instanceof Error ? error.message : String(error)}`);
    job.acceptance?.reject(new Error('generation result was not confirmed; query the same operation ID', { cause: error }));
  } finally {
    try { release?.(); }
    catch { console.warn(`[generation-job] release callback failed for ${job.id}`); }
    try { options.onSettled?.(job.id); }
    catch { console.warn(`[generation-job] settlement observer failed for ${job.id}`); }
  }
}

export async function createGenerationJob(
  params: Record<string, unknown>,
  task: GenerationJobTask,
  options: GenerationJobOptions = {},
): Promise<GenerationJobSubmission> {
  await initializeGenerationJobs();
  const id=options.operationId?.trim()||randomUUID();
  if(isGenerationJobEvicting(id))throw Error('generation operation cleanup in progress');
  await cleanOldJobs();
  if(isGenerationJobEvicting(id))throw Error('generation operation cleanup in progress');
  const now = Date.now();
  const job: GenerationJob = {
    id,
    status: 'queued',
    progress: 0,
    phase: 'queued',
    params,
    submitArgs: options.submitArgs,
    toolName: options.toolName,
    label: options.label,
    provider: options.provider,
    sourceRevisions: options.sourceRevisions,
    expectedResultCount: Number.isSafeInteger(options.expectedResultCount) && Number(options.expectedResultCount) > 0
      ? Number(options.expectedResultCount)
      : undefined,
    retryClass: 'none',
    timestamps: { createdAt: now, submittedAt: now, updatedAt: now },
    createdAt: now,
    updatedAt: now,
    cleanupResult: options.cleanupResult,
    cleanupPolicy: options.cleanupPolicy,
    retentionMs: normalizeRetentionMs(options.retentionMs),
    acceptance: makeAcceptanceWaiter(),
  };
  if (await persistGenerationJobReservation(job)) {
    queueMicrotask(() => {
      void runGenerationJob(job, task, options);
    });
  }
  return { operationId: id, jobId: id, status: 'queued' };
}

export async function waitForGenerationAcceptance(operationId: string): Promise<GenerationAcceptance> {
  for (;;) {
    await refreshGenerationJobStatus();
    const job = jobs.get(operationId);
    if (!job) throw new Error(`generation operation not found: ${operationId}`);
    await saveSettlement(job);
    const saved = committedGenerationSnapshot(job);
    if (saved?.timestamps?.acceptedAt) return acceptanceOf({ ...job, ...saved });
    if (saved?.status === 'failed') throw new Error(saved.error ?? 'generation provider rejected the request');
    if (!job.restored) {
      job.acceptance ??= makeAcceptanceWaiter();
      return job.acceptance.promise;
    }
    await resumeRestoredJobs([operationId]);
    await delay(250);
  }
}

const recoveryClaims = new Set<string>();

async function persistRecoveryStart(job: GenerationJob, changes: Partial<GenerationJob>): Promise<boolean> {
  if (recoveryClaims.has(job.id)) return false;
  recoveryClaims.add(job.id);
  try {
    const previousTimer = job.expiryTimer;
    const persisted = await persistGenerationJob(job, { ...job, ...changes, expiryTimer: undefined });
    if (persisted) clearTimeout(previousTimer);
    return persisted;
  } finally {
    recoveryClaims.delete(job.id);
  }
}

function registeredResumer(job: GenerationJob) {
  return job.timestamps.acceptedAt === undefined ? undefined : resumers.get(resumerKey(job.toolName, job.provider));
}

async function resumeWithRegisteredHandler(job: GenerationJob, resumer = registeredResumer(job)): Promise<boolean> {
  if (!resumer || job.resuming) return false;
  if (!await persistRecoveryStart(job, {
    resuming: true, status: 'queued', progress: Math.min(job.progress, 99),
    phase: 'recovering', retryClass: 'restart-recoverable',
  })) return false;
  void runGenerationJob(job, (_id, update, registerDownload, registerProviderTask) => (
    resumer(snapshotOf(job), update, registerDownload, registerProviderTask)
  ), {});
  return true;
}

function restoredFailure(job: GenerationJob, code: string, message: string): void {
  if (TERMINAL.has(job.status)) return;
  const now = Date.now();
  job.status = 'failed';
  job.progress = 100;
  job.phase = 'failed';
  job.error = message;
  job.code = code;
  job.retryable = true;
  job.retryClass = code === 'submission_unknown' ? 'provider-terminal' : 'provider-retryable';
  job.restored = false;
  job.resuming = false;
  job.updatedAt = now;
  job.timestamps.failedAt = now;
  job.timestamps.updatedAt = now;
}

export async function resumeRestoredJobs(ids: readonly string[] = [...jobs.keys()]): Promise<void> {
  const candidates = ids.map((id) => jobs.get(id)).filter((job): job is GenerationJob => (
    !!job && !!job.restored && !job.resuming && !TERMINAL.has(job.status) && !hasLiveGenerationOwner(job)
  ));
  await Promise.all(candidates.map(async (job) => {
    const resumer = registeredResumer(job);
    if (resumer) {
      await resumeWithRegisteredHandler(job, resumer);
      return;
    }
    if (recoveryClaims.has(job.id)) return;
    recoveryClaims.add(job.id);
    try {
      const accepted = job.timestamps.acceptedAt !== undefined;
      await settleGenerationJob(job, (next) => restoredFailure(
        next,
        accepted ? 'resumer_unavailable' : 'submission_unknown',
        accepted
          ? 'Generation operation cannot be resumed after server restart because no resumer is registered; explicitly rerun the operation.'
          : 'Generation submission outcome is unknown after server restart; explicitly rerun the operation.',
      ));
    } finally {
      recoveryClaims.delete(job.id);
    }
  }));
}

export async function refreshGenerationJobStatus(): Promise<void> {
  // Recovery is a one-shot startup action. A failed claim for another
  // operation does not keep healthy rows unreadable after disk recovers.
  await initializeGenerationJobs().catch(() => undefined);
  await refreshGenerationJobs();
}

export async function readGenerationJobSnapshot(jobId: string, refresh = true): Promise<GenerationJobSnapshot | undefined> {
  if (refresh) await refreshGenerationJobStatus();
  const job = jobs.get(jobId);
  if (job) await saveSettlement(job);
  const current = jobs.get(jobId);
  return current && committedGenerationSnapshot(current);
}

export async function resumeGenerationJobDownload(jobId: string): Promise<boolean> {
  await refreshGenerationJobStatus();
  if (isGenerationJobEvicting(jobId)) return false;
  const job = jobs.get(jobId);
  if (!job || job.status !== 'failed') return false;
  if (!job.resumeDownload || !job.pendingDownloadUrl) return resumeWithRegisteredHandler(job);
  const updatedAt = Date.now();
  if (!await persistRecoveryStart(job, {
    status: 'running', progress: 99, phase: 'downloading', error: undefined,
    updatedAt, timestamps: { ...job.timestamps, updatedAt },
  })) return false;
  let finish: (next: GenerationJob) => void;
  try {
    const returned = await job.resumeDownload();
    finish = (next) => {
      try { completeGenerationJob(next, returned); }
      catch (error) { failGenerationJob(next, error); }
    };
  } catch (error) {
    finish = (next) => failGenerationJob(next, error);
  }
  await settleGenerationJob(job, finish);
  return getGenerationJobSnapshot(job.id)?.status === 'succeeded';
}

export function getGenerationJobSnapshot(jobId: string): GenerationJobSnapshot | undefined {
  const job = jobs.get(jobId);
  return job ? snapshotOf(job) : undefined;
}

export function deleteGenerationJob(jobId: string): Promise<boolean> {
  return evictTerminalJob(jobId);
}
