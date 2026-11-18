import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertCurrentStorageProfile, runtimeProfile } from '../runtime-profile.ts';
import { assertDataDirRelocationReady } from '../data-dir.ts';
import {
  initializeSqliteProjectStore,
  registerStorageMigrationBarrier,
  sqliteReadEntry,
  sqliteStoreEnabled,
  sqliteWriteEntry,
} from '../storage/sqlite-store.ts';
import { GENERATION_JOBS_KV_KEY } from '../storage/sqlite-migration.ts';
import { withProjectStoreProcessLock } from './project-store-process-lock.ts';
import { atomicWriteJson } from './project-store-durable.ts';
import {
  TERMINAL,
  acceptanceOf,
  isGenerationExecutionAlive,
  makeAcceptanceWaiter,
  mergeGenerationResultUrls,
  snapshotOf,
} from './generation-job-types.ts';
import type {
  GenerationCleanupPolicy,
  GenerationCleanupPolicyHandler,
  GenerationJob,
  GenerationJobResumer,
  GenerationJobSnapshot,
  GenerationOperationTimestamps,
  GenerationRetentionGuard,
} from './generation-job-types.ts';

export const jobs = new Map<string, GenerationJob>();
export const resumers = new Map<string, GenerationJobResumer>();
const cleanupPolicyHandlers = new Map<string, GenerationCleanupPolicyHandler>();
const retentionGuards = new Map<string, GenerationRetentionGuard>();
const MAX_JOB_AGE_MS = 60 * 60_000;
const profile = runtimeProfile();
const STORE_PATH = profile.generationJobStore;
let persistenceQueue: Promise<void> = Promise.resolve();
let persistenceMigrationGate: Promise<void> | null = null;
const pendingReservations = new Map<string, Promise<void>>();
type LedgerRow = GenerationJobSnapshot & { executionPid?: number; reservationId?: string };
const committed = new WeakMap<GenerationJob, LedgerRow>();

registerStorageMigrationBarrier(async () => {
  // Drain actual mutations before moving authority to SQLite.
  let observed: Promise<void>;
  do {
    observed = persistenceQueue;
    await observed;
  } while (observed !== persistenceQueue);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  persistenceMigrationGate = gate;
  return () => {
    if (persistenceMigrationGate === gate) persistenceMigrationGate = null;
    release();
  };
});

export function resumerKey(toolName?: string, provider?: string): string {
  return `${toolName ?? ''}:${provider ?? ''}`;
}

export function registerGenerationJobResumer(toolName: string, provider: string, resumer: GenerationJobResumer): void {
  resumers.set(resumerKey(toolName, provider), resumer);
}

export function registerGenerationCleanupPolicy(
  policy: GenerationCleanupPolicy,
  handler: GenerationCleanupPolicyHandler,
): void {
  cleanupPolicyHandlers.set(policy, handler);
}

export function registerGenerationRetentionGuard(
  policy: GenerationCleanupPolicy,
  guard: GenerationRetentionGuard,
): void {
  retentionGuards.set(policy, guard);
}


export async function persistJobs(): Promise<void> {
  await persistenceQueue;
  await withLedgerDirectory(async () => undefined);
}

async function readLedger(): Promise<Map<string, LedgerRow>> {
  let parsed: unknown;
  if (sqliteStoreEnabled()) {
    const row = await sqliteReadEntry(GENERATION_JOBS_KV_KEY);
    if (!row.found) return new Map();
    parsed = row.value;
  } else {
    try { parsed = JSON.parse(await readFile(STORE_PATH, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw error;
    }
  }
  const ledger = parsed as { version?: unknown; jobs?: unknown } | null | undefined;
  if (!ledger || ledger.version !== 1 || !Array.isArray(ledger.jobs)) {
    throw new Error('generation job ledger format is unsupported or invalid');
  }
  const rows = new Map<string, LedgerRow>();
  for (const value of ledger.jobs) {
    if (!normalizePersistedJob(value) || rows.has(value.id)
      || (value.executionPid !== undefined && (!Number.isSafeInteger(value.executionPid) || value.executionPid <= 0))
      || (value.reservationId !== undefined && typeof value.reservationId !== 'string')) {
      throw new Error('generation job ledger contains unsupported or duplicate records');
    }
    rows.set(value.id, value as LedgerRow);
  }
  return rows;
}

async function saveLedger(rows: Map<string, LedgerRow>): Promise<void> {
  const ledger = { version: 1, jobs: [...rows.values()] };
  if (sqliteStoreEnabled()) {
    await sqliteWriteEntry(GENERATION_JOBS_KV_KEY, ledger);
    return;
  }
  await mkdir(dirname(STORE_PATH), { recursive: true });
  await atomicWriteJson(STORE_PATH, ledger);
}

async function commitLedgerRow(rows: Map<string, LedgerRow>, id: string): Promise<void> {
  try { await saveLedger(rows); }
  catch (error) {
    // A reported write error does not prove the row was not committed.
    const saved = await readLedger().catch(() => undefined);
    if (!saved || !isDeepStrictEqual(saved.get(id), rows.get(id))) throw error;
  }
}

function queueLedgerMutation<T>(work: (rows: Map<string, LedgerRow>) => Promise<T>): Promise<T> {
  const write = persistenceQueue.then(async () => {
    const migrationGate = persistenceMigrationGate;
    if (migrationGate) await migrationGate;
    return withLedgerDirectory(async () => work(await readLedger()));
  });
  persistenceQueue = write.then(() => undefined, () => undefined);
  return write;
}

function snapshotRow(job: GenerationJob, reservationId?: string): LedgerRow {
  // Freeze nested values before a later progress callback can change them.
  return JSON.parse(JSON.stringify({
    ...snapshotOf(job),
    reservationId,
    executionPid: TERMINAL.has(job.status) ? undefined : process.pid,
  })) as LedgerRow;
}

function exposeRow(row: LedgerRow): void {
  const previous = jobs.get(row.id);
  if (previous && isDeepStrictEqual(committed.get(previous), row)) return;
  clearTimeout(previous?.expiryTimer);
  const job = normalizePersistedJob(row)!;
  committed.set(job, row);
  jobs.set(job.id, job);
  if (job.timestamps.acceptedAt) {
    const accepted = acceptanceOf(job);
    previous?.acceptance?.resolve(accepted);
    job.acceptance?.resolve(accepted);
  } else if (job.status === 'failed') {
    previous?.acceptance?.reject(new Error(job.error ?? 'generation did not start'));
  }
  if (TERMINAL.has(job.status)) scheduleExpiry(job);
}

export function hasLiveGenerationOwner(job: GenerationJob): boolean {
  const pid = committed.get(job)?.executionPid;
  return pid !== undefined && isGenerationExecutionAlive(pid);
}

export function committedGenerationSnapshot(job: GenerationJob): GenerationJobSnapshot | undefined {
  const row = committed.get(job);
  if (!row) return undefined;
  const { executionPid: _pid, reservationId: _reservation, ...snapshot } = row;
  return {
    ...snapshot,
    operationId: job.id,
    retryClass: snapshot.retryClass ?? job.retryClass,
    timestamps: snapshot.timestamps ?? job.timestamps,
  };
}

/** Only the process that inserts the missing row may dispatch the task. */
export async function persistGenerationJobReservation(job: GenerationJob): Promise<boolean> {
  const pending = pendingReservations.get(job.id);
  if (pending) { await pending; return false; }
  const write = queueLedgerMutation(async (rows) => {
    const current = rows.get(job.id);
    if (current) { exposeRow(current); return false; }
    const row = snapshotRow(job, randomUUID());
    rows.set(job.id, row);
    await commitLedgerRow(rows, job.id);
    committed.set(job, row);
    jobs.set(job.id, job);
    return true;
  });
  const settled = write.then(() => undefined);
  // The leader awaits write. Other callers waiting on the same key see its failure.
  void settled.catch(() => undefined);
  pendingReservations.set(job.id, settled);
  try { return await write; }
  finally { pendingReservations.delete(job.id); }
}

/** Compare only the intended row and preserve all other processes' writes. */
export function persistGenerationJob(job: GenerationJob, next = job): Promise<boolean> {
  return queueLedgerMutation(async (rows) => {
    const expected = committed.get(job);
    if (!expected || !isDeepStrictEqual(rows.get(job.id), expected)) return false;
    const row = snapshotRow(next, expected.reservationId ?? randomUUID());
    rows.set(job.id, row);
    await commitLedgerRow(rows, job.id);
    committed.set(job, row);
    if (next !== job) Object.assign(job, next);
    return true;
  });
}

function withLedgerDirectory<T>(work: () => Promise<T>): Promise<T> {
  return withProjectStoreProcessLock(profile.rootDir, async () => {
    assertCurrentStorageProfile(profile);
    await assertDataDirRelocationReady(profile.rootDir);
    return work();
  });
}

function normalizePersistedJob(value: unknown): GenerationJob | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Partial<LedgerRow>;
  if (typeof row.id !== 'string'
    || (row.status !== 'queued' && row.status !== 'running' && row.status !== 'succeeded' && row.status !== 'failed')
    || typeof row.progress !== 'number'
    || !row.params || typeof row.params !== 'object' || Array.isArray(row.params)
    || typeof row.createdAt !== 'number'
    || typeof row.updatedAt !== 'number') return null;
  const timestamps = row.timestamps && typeof row.timestamps === 'object' && !Array.isArray(row.timestamps)
    ? row.timestamps as GenerationOperationTimestamps
    : { createdAt: row.createdAt, submittedAt: row.createdAt, updatedAt: row.updatedAt };
  const restored = !TERMINAL.has(row.status);
  return {
    id: row.id,
    status: row.status,
    progress: row.progress,
    phase: restored && row.executionPid === undefined ? 'recovering' : row.phase,
    processedFrames: row.processedFrames,
    totalFrames: row.totalFrames,
    params: row.params as Record<string, unknown>,
    submitArgs: row.submitArgs,
    toolName: row.toolName,
    label: row.label,
    provider: row.provider,
    providerTaskId: row.providerTaskId,
    sourceRevisions: row.sourceRevisions,
    resultUrls: mergeGenerationResultUrls([], Array.isArray(row.resultUrls) ? row.resultUrls : []),
    expectedResultCount: Number.isSafeInteger(row.expectedResultCount) && Number(row.expectedResultCount) > 0
      ? Number(row.expectedResultCount)
      : undefined,
    retryClass: restored ? 'restart-recoverable' : row.retryClass ?? 'none',
    timestamps,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    result: row.result,
    results: row.results,
    error: row.error,
    code: row.code,
    retryable: row.retryable,
    cleanupPolicy: typeof row.cleanupPolicy === 'string' ? row.cleanupPolicy : undefined,
    pendingDownloadUrl: row.pendingDownloadUrl,
    retentionMs: MAX_JOB_AGE_MS,
    acceptance: makeAcceptanceWaiter(),
    restored,
  };
}

export async function loadPersistedJobs(): Promise<void> {
  await initializeSqliteProjectStore();
  await refreshGenerationJobs();
}

export function refreshGenerationJobs(): Promise<void> {
  return withLedgerDirectory(async () => {
    const rows = await readLedger();
    for (const job of jobs.values()) {
      if (!rows.has(job.id)) {
        clearTimeout(job.expiryTimer);
        jobs.delete(job.id);
      }
    }
    for (const row of rows.values()) exposeRow(row);
  });
}

export function normalizeRetentionMs(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : MAX_JOB_AGE_MS;
}

export function scheduleExpiry(job: GenerationJob, retryMs?: number): void {
  if (jobs.get(job.id)!==job||!TERMINAL.has(job.status)) return;
  clearTimeout(job.expiryTimer);
  const remaining = retryMs ?? Math.max(0, job.retentionMs - (Date.now() - job.updatedAt));
  const timer=setTimeout(() => {
    if(jobs.get(job.id)!==job||job.expiryTimer!==timer)return;
    void evictTerminalJob(job.id,true).catch(()=>console.warn(`[generation-job] scheduled cleanup failed for ${job.id}`));
  },remaining);
  job.expiryTimer=timer;
  timer.unref?.();
}

async function retentionBlocked(job: GenerationJob): Promise<boolean> {
  const guard = job.cleanupPolicy ? retentionGuards.get(job.cleanupPolicy) : undefined;
  if (!guard) return false;
  try {
    return await guard(job.id);
  } catch (error) {
    console.warn(`[generation-job] retention guard failed for ${job.id}: ${error instanceof Error ? error.message : String(error)}`);
    return true;
  }
}

const evictions=new Map<string,Promise<boolean>>();
export function isGenerationJobEvicting(jobId:string):boolean{return evictions.has(jobId);}

/** The claim covers guard, durable removal and cleanup. A failed commit must
 * leave actual result bytes intact; cleanup never precedes that commit. */
async function evictClaimedJob(jobId:string,job:GenerationJob,retentionExpiry:boolean):Promise<boolean>{
  const current=()=>jobs.get(jobId)===job&&TERMINAL.has(job.status);
  if(!current())return false;
  const cleanup=job.cleanupPolicy?cleanupPolicyHandlers.get(job.cleanupPolicy):job.cleanupResult;
  if(job.cleanupPolicy&&!cleanup){console.warn(`[generation-job] refusing to evict ${jobId}: unknown cleanup policy ${job.cleanupPolicy}`);return false;}
  if(await retentionBlocked(job)){
    if(retentionExpiry&&current())scheduleExpiry(job,60_000);
    return false;
  }
  if(!current())return false;
  let removed: boolean;
  try {
    removed = await queueLedgerMutation(async (rows) => {
      const expected = committed.get(job);
      if (!current() || !expected || !isDeepStrictEqual(rows.get(jobId), expected)) return false;
      rows.delete(jobId);
      await commitLedgerRow(rows, jobId);
      jobs.delete(jobId);
      clearTimeout(job.expiryTimer);
      job.expiryTimer = undefined;
      return true;
    });
  } catch (error) {
    if (current()) scheduleExpiry(job, 60_000);
    throw error;
  }
  if (!removed || jobs.has(jobId)) return false;
  if(job.results?.length&&cleanup)try{await Promise.all(job.results.map(result=>cleanup(result)));}
  catch{console.warn(`[generation-job] result cleanup failed after durable removal for ${jobId}`);}
  return true;
}

export function evictTerminalJob(jobId:string,retentionExpiry=false):Promise<boolean>{
  const pending=evictions.get(jobId);if(pending)return pending;
  const job=jobs.get(jobId);if(!job||!TERMINAL.has(job.status))return Promise.resolve(false);
  // Publish ownership before calling a possibly reentrant async guard.
  const attempt=Promise.resolve().then(()=>evictClaimedJob(jobId,job,retentionExpiry));
  evictions.set(jobId,attempt);
  const release=()=>{if(evictions.get(jobId)===attempt)evictions.delete(jobId);};
  void attempt.then(release,release);
  return attempt;
}

export async function cleanOldJobs(): Promise<void> {
  const cutoff = Date.now() - MAX_JOB_AGE_MS;
  const expired = [...jobs.values()].filter((job) => TERMINAL.has(job.status) && job.updatedAt < cutoff && !isGenerationJobEvicting(job.id));
  await Promise.all(expired.map((job) => evictTerminalJob(job.id, true)));
}
