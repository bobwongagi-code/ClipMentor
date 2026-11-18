import { constants as fsConstants } from 'node:fs';
import { copyFile, link, lstat, open, readdir, stat, unlink } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { ffmpegBin } from '../media-binaries.ts';
import { ffmpegThreadArgs, spawnMediaProcess } from '../media-process.ts';
import { exportAttemptIdFromFilename } from '../media-dir.ts';
import {
  h264EncoderAttempts,
  h264EncoderFallbackReason,
  h264EncoderProfile,
  h264EncodingArgs,
  h264FilterChain,
  h264GlobalArgs,
  shouldFallbackH264Encoder,
  resolveH264Encoder,
  type H264Encoder,
  type H264EncoderOutcome,
} from '../media-acceleration.ts';
import {
  deleteGenerationJob,
  readGenerationJobSnapshot,
  type UpdateGenerationJob,
} from './generation-jobs.ts';
import { TaskLimiter, type ReleaseTaskPermit } from '../task-limiter.ts';
import { sha256File } from '../../shared/node-content-hash.ts';
import { withProjectStoreProcessLock } from './project-store-process-lock.ts';
import { durableRename, syncDirectory } from './project-store-durable.ts';
import { assertCurrentStorageProfile, type RuntimeProfile } from '../runtime-profile.ts';

const DEFAULT_MAX_ACTIVE_EXPORTS = 1;
const MAX_ACTIVE_EXPORTS = 4;
const FFMPEG_TIMEOUT_MS = 60 * 60_000;
export const EXPORT_JOB_RETENTION_MS = 60 * 60_000;
const EXPORT_CANCEL_TIMEOUT_MS = 15_000;
const EXPORT_JOB_FILE_PREFIX = 'openchatcut-export-job-';
const EXPORT_JOB_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'mp3', 'wav']);
const EXPORT_JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXPORT_PROMOTION_STAGE = /^\.openchatcut-derived-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:mp4|webm|mov|mp3|wav)\.pending$/i;

interface CleanupStaleExportOptions {
  now?: number;
  retentionMs?: number;
  onError?: (path: string, error: unknown) => void;
  shouldRetain?: (renderId: string) => Promise<boolean> | boolean;
  profile?: RuntimeProfile;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}


export function exportJobFilename(id: string, extension: string): string {
  if (!EXPORT_JOB_ID.test(id) || !EXPORT_JOB_EXTENSIONS.has(extension)) {
    throw new Error('invalid export job filename');
  }
  return `${EXPORT_JOB_FILE_PREFIX}${id}.${extension}`;
}

export function assertNonEmptyExportBytes(size: number): void {
  if (size <= 0) throw new Error('export renderer produced an empty file');
}

export function exportJobResultName(path: string, assetId: string): string | null {
  const prefix = '/media/uploads/';
  if (!path.startsWith(prefix)) return null;
  const name = path.slice(prefix.length);
  if (exportAttemptIdFromFilename(name) !== assetId.toLowerCase()) return null;
  return name;
}

interface PromotableExportResult {
  assetId: string;
  path: string;
  sizeBytes?: number;
}

export async function readExportJobResultFile(result: PromotableExportResult, directory: string) {
  const name = exportJobResultName(result.path, result.assetId);
  if (!name) throw new Error('export result is not promotable');
  const path = join(directory, name);
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0 || (result.sizeBytes !== undefined && info.size !== result.sizeBytes)) {
    throw new Error('original render output is missing or incomplete');
  }
  return { name, path, info };
}

/** Publish a completed job output as ordinary managed media so job cleanup can
 * remove its temporary name without removing the user's saved asset. */
export async function promoteExportResult<T extends PromotableExportResult>(
  result: T,
  directory: string,
  profile?: RuntimeProfile,
): Promise<T> {
  return withProjectStoreProcessLock(profile?.rootDir ?? directory, async () => {
    if (profile) assertCurrentStorageProfile(profile);
    return promoteLockedExportResult(result, directory);
  });
}

async function promoteLockedExportResult<T extends PromotableExportResult>(result: T, directory: string): Promise<T> {
  const { name: sourceName, path: source, info: sourceInfo } = await readExportJobResultFile(result, directory);
  const publishedName = `openchatcut-derived-${result.assetId}${extname(sourceName).toLowerCase()}`;
  const destination = join(directory, publishedName);
  const staging = join(directory, `.${publishedName}.pending`);
  const targetExists = async () => !!await lstat(destination).catch((error) => {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  });
  let verifiedCopy = false;
  await unlinkWithRetry(staging);
  try {
    await link(source, destination);
  } catch (error) {
    const code = errorCode(error);
    if (code !== 'EEXIST') {
      if (!['EPERM', 'EXDEV', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(code ?? '')) throw error;
      try {
        if (!await targetExists()) {
          await copyFile(source, staging, fsConstants.COPYFILE_EXCL);
          const file = await open(staging, 'r+');
          try {
            if ((await file.stat()).size !== sourceInfo.size) throw new Error('promoted export size mismatch');
            await file.sync();
          } finally { await file.close(); }
          if (await sha256File(staging) !== await sha256File(source)) throw new Error('promoted export content mismatch');
          if (!await targetExists()) {
            await durableRename(staging, destination);
            verifiedCopy = true;
          }
        }
      } finally {
        await unlinkWithRetry(staging);
      }
    }
  }
  const publishedInfo = await stat(destination);
  if (publishedInfo.size !== sourceInfo.size) throw new Error('promoted export size mismatch');
  // An existing path may be a prior copy or corrupt media of the same length.
  // Hardlinks already share bytes; copies must prove the exact rendered content.
  if (!verifiedCopy && (publishedInfo.dev !== sourceInfo.dev || publishedInfo.ino !== sourceInfo.ino)
    && await sha256File(destination) !== await sha256File(source)) {
    throw new Error('promoted export content mismatch');
  }
  await syncDirectory(directory);
  return {
    ...result,
    path: `/media/uploads/${publishedName}`,
    sizeBytes: publishedInfo.size,
  };
}

export async function unlinkWithRetry(path: string, attempts = 3, delayMs = 100): Promise<void> {
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    try {
      await unlink(path);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') return;
      const retryable = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
      if (!retryable || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}

/** Remove only expired async-export artifacts; ordinary user media is never matched. */
export async function cleanupStaleExportFiles(
  directory: string,
  options: CleanupStaleExportOptions = {},
): Promise<number> {
  const now = options.now ?? Date.now();
  const retentionMs = Math.max(0, options.retentionMs ?? EXPORT_JOB_RETENTION_MS);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 0;
    throw error;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const attemptId = exportAttemptIdFromFilename(entry.name);
    const staging = EXPORT_PROMOTION_STAGE.test(entry.name);
    if (!attemptId && !staging) continue;
    const path = join(directory, entry.name);
    try {
      const info = await stat(path);
      if (now - info.mtimeMs < retentionMs) continue;
      if (attemptId) {
        if (await options.shouldRetain?.(attemptId)) continue;
        await unlinkWithRetry(path);
        removed += 1;
      } else {
        const profile = options.profile;
        await withProjectStoreProcessLock(profile?.rootDir ?? directory, async () => {
          if (profile) assertCurrentStorageProfile(profile);
          if (now - (await stat(path)).mtimeMs < retentionMs) return;
          await unlinkWithRetry(path);
          removed += 1;
        });
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      options.onError?.(path, error);
    }
  }
  return removed;
}

export function resolveMaxActiveExports(value = process.env.OPENCHATCUT_MAX_ACTIVE_EXPORTS): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return DEFAULT_MAX_ACTIVE_EXPORTS;
  return Math.max(1, Math.min(MAX_ACTIVE_EXPORTS, Number(value.trim())));
}

const exportLimiter = new TaskLimiter(resolveMaxActiveExports());
const exportJobControllers = new Map<string, AbortController>();

function acquireExportPermitWithSignal(signal: AbortSignal): Promise<ReleaseTaskPermit> {
  signal.throwIfAborted();
  const pending = exportLimiter.acquire();
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      void pending.then((release) => release());
      reject(signal.reason ?? new DOMException('Export cancelled', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void pending.then((release) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(release);
    });
  });
}

export function acquireExportPermit(signal?: AbortSignal): Promise<ReleaseTaskPermit> {
  return signal ? acquireExportPermitWithSignal(signal) : exportLimiter.acquire();
}
export function trackExportJobController(jobId: string, controller: AbortController): void {
  exportJobControllers.set(jobId, controller);
}

export function forgetExportJobController(jobId: string): void {
  exportJobControllers.delete(jobId);
}

export async function cancelActiveExportJob(jobId: string): Promise<boolean> {
  const controller = exportJobControllers.get(jobId);
  if (!controller) return false;
  controller.abort();
  const deadline = Date.now() + EXPORT_CANCEL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const snapshot = await readGenerationJobSnapshot(jobId);
    if (!snapshot) return true;
    if (snapshot.status === 'succeeded') return false;
    if (snapshot.status === 'failed') {
      return deleteGenerationJob(jobId);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}


export async function withExportPermit<T>(
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const release = await acquireExportPermit(signal);
  try {
    signal?.throwIfAborted();
    return await task();
  } finally {
    release();
  }
}

function runFfmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnMediaProcess(ffmpegBin(), [...ffmpegThreadArgs(), ...args], { stdio: ['ignore', 'ignore', 'pipe'], signal });
    let stderr = '';
    let settled = false;
    let timeoutError: Error | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => {
      timeoutError = new Error('ffmpeg fps retime timed out');
      child.kill('SIGKILL');
    }, FFMPEG_TIMEOUT_MS);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk);
      if (stderr.length > 16_000) stderr = stderr.slice(-8_000);
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => finish(timeoutError ?? (code === 0
      ? undefined
      : new Error(`ffmpeg fps retime failed (${code}): ${stderr.slice(-600)}`))));
  });
}

export function retimeVideoEncodingArgs(
  codec: 'h264' | 'vp8',
  encoder: H264Encoder,
  targetBitrate: number,
): string[] {
  if (codec === 'vp8') {
    return ['-c:v', 'libvpx', ...ffmpegThreadArgs(), '-b:v', String(targetBitrate)];
  }
  return h264EncodingArgs({ encoder, targetBitrate, softwarePreset: 'medium' });
}

/** Re-sample presentation FPS; temporal interpolation intentionally stays off. */
export async function retimeFps(
  input: string,
  output: string,
  targetFps: number,
  codec: 'h264' | 'vp8',
  targetBitrate: number,
  signal?: AbortSignal,
): Promise<H264EncoderOutcome | undefined> {
  await unlink(output).catch(() => {});
  const base = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];
  try {
    if (codec === 'vp8') {
      await runFfmpeg([
        ...base,
        '-i', input,
        '-vf', `fps=${targetFps}`,
        ...retimeVideoEncodingArgs('vp8', 'libx264', targetBitrate),
        '-c:a', 'copy',
        output,
      ], signal);
      return undefined;
    }
    return await retimeH264(base, input, output, targetFps, targetBitrate, signal);
  } catch (error) {
    await unlink(output).catch(() => {});
    throw error;
  }
}

async function retimeH264(
  base: string[],
  input: string,
  output: string,
  targetFps: number,
  targetBitrate: number,
  signal?: AbortSignal,
): Promise<H264EncoderOutcome> {
  const preferred = await resolveH264Encoder(ffmpegBin());
  let fallbackReason: string | undefined;
  let lastError: unknown;
  for (const encoder of h264EncoderAttempts(preferred)) {
    try {
      const args = [
        ...base,
        ...h264GlobalArgs(encoder),
        '-i', input,
        '-vf', h264FilterChain(encoder, [`fps=${targetFps}`]),
        ...retimeVideoEncodingArgs('h264', encoder, targetBitrate),
        '-c:a', 'copy',
        output,
      ];
      await runFfmpeg(args, signal);
      return {
        encoder: h264EncoderProfile(encoder),
        ...(fallbackReason ? { encoderFallbackReason: fallbackReason } : {}),
      };
    } catch (error) {
      lastError = error;
      if (!shouldFallbackH264Encoder(encoder, error)) throw error;
      fallbackReason = h264EncoderFallbackReason(encoder, error);
      await unlink(output).catch(() => {});
      console.warn(`[export] ${encoder} failed during FPS conversion; falling back to libx264`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('ffmpeg fps retime failed');
}

export function finalH264EncoderOutcome(
  rendered: H264EncoderOutcome | undefined,
  retimed: H264EncoderOutcome | undefined,
): H264EncoderOutcome | undefined {
  if (!retimed) return rendered;
  if (retimed.encoder.hardware || retimed.encoderFallbackReason || !rendered?.encoderFallbackReason) {
    return retimed;
  }
  return { ...retimed, encoderFallbackReason: rendered.encoderFallbackReason };
}

export function createRenderProgress(
  update: UpdateGenerationJob,
  totalFrames: number,
  span: number,
): (value: number) => void {
  return (value) => {
    const normalized = Math.min(1, Math.max(0, Number(value) || 0));
    update({
      phase: 'rendering',
      progress: 8 + normalized * span,
      processedFrames: Math.min(totalFrames, Math.floor(normalized * totalFrames)),
      totalFrames,
    });
  };
}

export function exportOutputSize(state: unknown, scale: number): { width: number; height: number } {
  const timeline = state as { width?: unknown; height?: unknown };
  return {
    width: Math.max(2, Math.round((Number(timeline.width) || 1920) * scale)),
    height: Math.max(2, Math.round((Number(timeline.height) || 1080) * scale)),
  };
}
