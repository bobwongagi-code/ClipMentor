import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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
import {
  TERMINAL,
  acceptanceOf,
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
let persistenceHydrated = false;
let persistenceQueue: Promise<void> = Promise.resolve();
let persistenceMigrationGate: Promise<void> | null = null;
const pendingReservations = new Map<string, Promise<void>>();
registerStorageMigrationBarrier(async () => {
  // Before hydration, only drain existing writes: writing the empty in-memory
  // map would destroy the configured legacy ledger before it is imported.
  // Once hydrated, persist the current in-memory snapshot as the migration
  // boundary, then wait until no later queued write exists.
  if (persistenceHydrated) await persistJobs();
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


function persistedRows(): GenerationJobSnapshot[] {
  return [...jobs.values()].map(snapshotOf);
}

export function persistJobs(): Promise<void> {
  return queueLedgerWrite();
}

/** Publish a newly admitted job only after the ledger containing it is durable. */
export async function persistGenerationJobReservation(job: GenerationJob): Promise<boolean> {
  if (jobs.has(job.id)) return false;
  const pending = pendingReservations.get(job.id);
  if (pending) {
    await pending;
    return false;
  }
  const write = queueLedgerWrite(job);
  pendingReservations.set(job.id, write);
  try { await write; }
  finally { pendingReservations.delete(job.id); }
  return true;
}

function queueLedgerWrite(reservation?: GenerationJob): Promise<void> {
  const write = persistenceQueue.catch(() => undefined).then(async () => {
    const migrationGate = persistenceMigrationGate;
    if (migrationGate) await migrationGate;
    const rows = persistedRows();
    if (reservation) rows.push(snapshotOf(reservation));
    const ledger = { version: 1, jobs: rows };
    await withLedgerDirectory(async () => {
      if (sqliteStoreEnabled()) {
        await sqliteWriteEntry(GENERATION_JOBS_KV_KEY, ledger);
        return;
      }
      await mkdir(dirname(STORE_PATH), { recursive: true });
      const temporary = `${STORE_PATH}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(ledger), 'utf8');
        await rename(temporary, STORE_PATH);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
    });
    if (reservation) jobs.set(reservation.id, reservation);
  });
  persistenceQueue = write.then(() => undefined, () => undefined);
  return write;
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
  const row = value as Partial<GenerationJobSnapshot>;
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
    phase: restored ? 'recovering' : row.phase,
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
  type Ledger = { version?: unknown; jobs?: unknown } | null | undefined;
  const parsed = await withLedgerDirectory<Ledger>(async () => {
    if (sqliteStoreEnabled()) {
      const row = await sqliteReadEntry(GENERATION_JOBS_KV_KEY);
      return row.found ? row.value as Ledger : undefined;
    }
    try {
      return JSON.parse(await readFile(STORE_PATH, 'utf8')) as Ledger;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  });
  if (parsed === undefined) {
    persistenceHydrated = true;
    return;
  }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || !Array.isArray(parsed.jobs)) {
    throw new Error('generation job ledger format is unsupported or invalid');
  }
  // Validate the whole ledger before publishing jobs or arming expiry timers.
  // Unknown rows must not disappear when the next ordinary write occurs.
  const incoming: GenerationJob[] = [], ids = new Set<string>();
  for (const value of parsed.jobs) {
    const job = normalizePersistedJob(value);
    if (!job || ids.has(job.id)) throw new Error('generation job ledger contains unsupported or duplicate records');
    ids.add(job.id); incoming.push(job);
  }
  for (const job of incoming) {
    if (jobs.has(job.id)) continue;
    jobs.set(job.id, job);
    if (job.timestamps.acceptedAt) job.acceptance?.resolve(acceptanceOf(job));
    if (TERMINAL.has(job.status)) scheduleExpiry(job);
  }
  persistenceHydrated = true;
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
  jobs.delete(jobId);clearTimeout(job.expiryTimer);job.expiryTimer=undefined;
  try{await persistJobs();}
  catch(error){
    if(!jobs.has(jobId))jobs.set(jobId,job);
    if(jobs.get(jobId)===job)scheduleExpiry(job,60_000);
    throw error;
  }
  if(jobs.has(jobId))return false;
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
