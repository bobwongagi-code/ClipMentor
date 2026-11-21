import type { EditorCommands } from '../editor/store';
import type { MediaAsset, ProjectDoc } from '../editor/types';
import { sourceWindowForTimelineRange } from '../editor/sourceLimit';
import { readStoredServerRun } from '../agent/serverRunSessionStorage';
import type { BackgroundExportExecution, ExportJobStore } from './backgroundExportStore';
import { cancelExportJob, isServerRenderError, pollExport } from './serverExportRenderOperation';
import { createExportFailure, ExportFailureError, exportFailureFrom } from './exportFailure';
import type { ExportJobResult, Translate } from './exportWorkflowTypes';

export interface AgentExportSourceItem {
  id: string;
  sourceAssetId: string;
  startFrame: number;
  durationInFrames: number;
  srcInFrame?: number;
  playbackRate?: number;
}

export interface AgentExportMediaPoolPlan {
  format: 'video' | 'audio';
  timelineId: string;
  timelineName: string;
  timelineFps: number;
  items: AgentExportSourceItem[];
}

export interface AgentExportSubmission {
  renderId: string;
  attemptId?: string;
  projectId: string;
  label: string;
  createdAt: number;
  saveToMediaPool?: AgentExportMediaPoolPlan;
}

export type AgentExportMediaPoolState =
  | { status: 'pending' }
  | { status: 'saved'; mediaAssetId: string; path: string; draftOnly?: true }
  | { status: 'failed'; error: string };

export interface MediaPoolTarget {
  commands: Pick<EditorCommands, 'addAsset'>;
  getDoc: () => ProjectDoc;
  canRegister?: () => boolean;
  draft?: boolean;
}

interface PromotedResult extends ExportJobResult {
  assetId: string;
  path: string;
  name?: string;
}

type SubmissionListener = (submission: AgentExportSubmission) => void;
const PROMOTION_TIMEOUT_MS = 60_000;
const listeners = new Set<SubmissionListener>();
const mediaPoolStates = new Map<string, AgentExportMediaPoolState>();
const submissions = new Map<string, { submission: AgentExportSubmission; stopped: boolean }>();
const editorTargets = new WeakMap<ExportJobStore, { projectId: string; target?: MediaPoolTarget }>();
interface Promotion {
  result: Promise<PromotedResult>;
  controller: AbortController;
}
const promotions = new Map<string, Promotion>();

export function agentExportAttemptKey(renderId: string, attemptId?: string): string {
  return JSON.stringify([renderId, attemptId]);
}

export function notifyAgentExportSubmitted(submission: AgentExportSubmission): void {
  if (submission.saveToMediaPool) {
    const key = agentExportAttemptKey(submission.renderId, submission.attemptId);
    if (!submissions.has(key)) {
      submissions.set(key, { submission, stopped: false });
      mediaPoolStates.set(key, { status: 'pending' });
    }
  }
  for (const listener of listeners) listener(submission);
}

export function subscribeAgentExportSubmissions(listener: SubmissionListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function agentExportMediaPoolState(renderId: string, attemptId?: string): AgentExportMediaPoolState | undefined {
  return mediaPoolStates.get(agentExportAttemptKey(renderId, attemptId));
}

export function resetAgentExportTrackingState(): void {
  mediaPoolStates.clear();
  submissions.clear();
  for (const promotion of promotions.values()) promotion.controller.abort();
  promotions.clear();
}

function sourceRanges(plan: AgentExportMediaPoolPlan, completed: ExportJobResult) {
  const from = Math.max(0, Math.round((completed.sourceStartSeconds ?? 0) * plan.timelineFps));
  const duration = Math.max(1, Math.round((completed.durationSeconds ?? 0) * plan.timelineFps));
  const to = from + duration;
  return plan.items.flatMap((item) => {
    const start = Math.max(from, item.startFrame);
    const end = Math.min(to, item.startFrame + item.durationInFrames);
    if (end <= start) return [];
    const window = sourceWindowForTimelineRange(item, start - item.startFrame, end - start);
    return [{
      itemId: item.id,
      sourceAssetId: item.sourceAssetId,
      timelineStartFrame: start,
      timelineEndFrameExclusive: end,
      sourceStartFrame: window.startFrame,
      sourceEndFrameExclusive: window.endFrame,
    }];
  });
}

function mediaAssetFor(
  submission: AgentExportSubmission,
  completed: ExportJobResult,
  promoted: PromotedResult,
  doc: ProjectDoc,
): MediaAsset {
  const plan = submission.saveToMediaPool!;
  const ranges = sourceRanges(plan, completed);
  const name = promoted.name?.trim() || submission.label;
  return {
    id: doc.assets.some((asset) => asset.id === promoted.assetId)
      ? globalThis.crypto.randomUUID()
      : promoted.assetId,
    name,
    sourceFilename: name,
    kind: plan.format,
    src: promoted.path,
    durationInFrames: Math.max(1, Math.round((promoted.durationSeconds ?? completed.durationSeconds ?? 0) * plan.timelineFps)),
    width: promoted.width,
    height: promoted.height,
    props: {
      openchatcutDerivedFrom: {
        kind: 'sequence-export',
        timelineId: plan.timelineId,
        timelineName: plan.timelineName,
        renderId: submission.renderId,
        sourceAssetIds: [...new Set(ranges.map((range) => range.sourceAssetId))],
        sourceRanges: ranges,
      },
    },
  };
}

async function requestPromotion(
  submission: AgentExportSubmission,
  assetId: string,
  signal: AbortSignal,
): Promise<PromotedResult> {
  const query = new URLSearchParams({ attemptId: submission.attemptId ?? '', assetId });
  const response = await fetch(`/export/job/${encodeURIComponent(submission.renderId)}/promote?${query}`, {
    method: 'POST', signal,
  });
  const promoted = (await response.json().catch(() => null)) as PromotedResult | { error?: string } | null;
  signal.throwIfAborted();
  if (!response.ok || !promoted || !('path' in promoted) || typeof promoted.path !== 'string' || !promoted.path
    || !('assetId' in promoted) || promoted.assetId !== assetId) {
    const message = promoted && 'error' in promoted ? promoted.error : undefined;
    throw new Error(message ?? `export media promotion failed (${response.status})`);
  }
  return promoted;
}

async function promoteCompletedExport(
  submission: AgentExportSubmission,
  completed: ExportJobResult,
  signal: AbortSignal,
): Promise<PromotedResult> {
  signal.throwIfAborted();
  if (!completed.path || typeof completed.assetId !== 'string' || !completed.assetId) {
    throw new Error('completed export is missing its output identity');
  }
  const key = JSON.stringify([submission.renderId, submission.attemptId, completed.assetId]);
  let pending = promotions.get(key);
  if (!pending) {
    const controller = new AbortController();
    const transport = AbortSignal.any([controller.signal, AbortSignal.timeout(PROMOTION_TIMEOUT_MS)]);
    const entry = { controller, result: requestPromotion(submission, completed.assetId, transport) };
    promotions.set(key, entry);
    void entry.result.catch(() => { if (promotions.get(key) === entry) promotions.delete(key); });
    pending = entry;
  }
  let abort: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    return await Promise.race([pending.result, cancelled]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

function registerPromotedExport(
  submission: AgentExportSubmission,
  completed: ExportJobResult,
  promoted: PromotedResult,
  target: MediaPoolTarget,
): void {
  if (target.canRegister?.() === false) return;
  const key = agentExportAttemptKey(submission.renderId, submission.attemptId);
  const doc = target.getDoc();
  const existing = doc.assets.find((asset) => asset.src === promoted.path);
  const asset = existing ?? mediaAssetFor(submission, completed, promoted, doc);
  if (!existing) target.commands.addAsset(asset);
  const previous = mediaPoolStates.get(key);
  const draftOnly = target.draft && (previous?.status !== 'saved' || previous.draftOnly);
  mediaPoolStates.set(key, { status: 'saved', mediaAssetId: asset.id, path: asset.src, ...(draftOnly ? { draftOnly: true } : {}) });
}

function markMediaPoolFailure(key: string, error: unknown): void {
  const state = mediaPoolStates.get(key);
  if (state?.status === 'saved' && !state.draftOnly) return;
  mediaPoolStates.set(key, {
    status: 'failed',
    error: error instanceof Error ? error.message : String(error),
  });
}

export async function saveTrackedAgentExport(
  job: { renderId: string; attemptId?: string; projectId?: string },
  completed: ExportJobResult,
  target: MediaPoolTarget,
  signal: AbortSignal,
): Promise<void> {
  const key = agentExportAttemptKey(job.renderId, job.attemptId);
  const tracked = submissions.get(key);
  const submission = tracked?.submission;
  if (!tracked || tracked.stopped || !submission?.saveToMediaPool || submission.projectId !== job.projectId) return;
  try {
    const promoted = await promoteCompletedExport(submission, completed, signal);
    signal.throwIfAborted();
    if (!tracked.stopped) registerPromotedExport(submission, completed, promoted, target);
  } catch (error) {
    signal.throwIfAborted();
    markMediaPoolFailure(key, error);
    throw error;
  }
}

async function monitorAgentExport(
  submission: AgentExportSubmission,
  execution: BackgroundExportExecution,
  t: Translate,
  currentTarget: () => MediaPoolTarget | undefined,
): Promise<void> {
  const { signal, setters } = execution;
  const key = agentExportAttemptKey(submission.renderId, submission.attemptId);
  const recordStop = () => {
    const tracked = submissions.get(key);
    if (tracked) {
      tracked.stopped = true;
      markMediaPoolFailure(key, t('已取消导出'));
    }
  };
  let outputObserved = false;
  if (signal.aborted) recordStop();
  signal.addEventListener('abort', recordStop, { once: true });
  setters.setRenderEngine('server');
  try {
    const completed = await pollExport({ setProgress: setters.setProgress, t }, submission.renderId, signal, {
      attemptId: submission.attemptId,
    });
    outputObserved = true;
    if (submission.saveToMediaPool && !submissions.get(key)?.stopped && currentTarget()) {
      try {
        const promoted = await promoteCompletedExport(submission, completed, signal);
        while (
          readStoredServerRun(submission.projectId)
          && currentTarget()
          && !signal.aborted
        ) await new Promise((resolve) => setTimeout(resolve, 100));
        const target = currentTarget();
        if (target && !signal.aborted && !submissions.get(key)?.stopped) {
          registerPromotedExport(submission, completed, promoted, target);
        }
      } catch (error) {
        signal.throwIfAborted();
        // Detached work can recover. A live workspace must see a delivery
        // failure without mistaking it for a failed render.
        if (currentTarget() && !submissions.get(key)?.stopped) {
          markMediaPoolFailure(key, error);
          throw new ExportFailureError(createExportFailure({
            stage: 'destination', code: 'export_media_pool_save_failed', retryable: true,
            message: error instanceof Error ? error.message : String(error),
          }), { cause: error });
        }
      }
    }
    if (completed.encoder) setters.setEngineInfo(completed.encoder);
    if (completed.encoderFallbackReason) setters.setEngineReason(completed.encoderFallbackReason);
    setters.setProgress((current) => current ? {
      ...current,
      phase: 'completed',
      percent: 100,
      finishedAt: Date.now(),
      outputSize: completed.sizeBytes,
    } : current);
  } catch (error) {
    if (submission.saveToMediaPool && (isServerRenderError(error) || exportFailureFrom(error)?.stage === 'cancel')) {
      markMediaPoolFailure(key, error);
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', recordStop);
    setters.setBusy(null);
    if (signal.aborted && !outputObserved) await cancelExportJob(submission.renderId, submission.attemptId);
  }
}

export function subscribeAgentExportJobs(
  projectId: string,
  exportJobs: ExportJobStore,
  t: Translate,
  target?: MediaPoolTarget,
): () => void {
  const editor = { projectId, target };
  editorTargets.set(exportJobs, editor);
  const currentTarget = () => {
    const attached = editorTargets.get(exportJobs);
    return attached?.projectId === projectId ? attached.target : undefined;
  };
  const launch = (submission: AgentExportSubmission) => {
    if (submission.projectId !== projectId) return;
    exportJobs.recover({
      id: `agent-export-${agentExportAttemptKey(submission.renderId, submission.attemptId)}`,
      label: submission.label,
      targetPath: null,
      createdAt: submission.createdAt,
      execute: (execution) => monitorAgentExport(submission, execution, t, currentTarget),
    });
  };
  const unsub = subscribeAgentExportSubmissions(launch);
  for (const [key, tracked] of submissions) {
    const state = mediaPoolStates.get(key);
    if (!tracked.stopped && (state?.status === 'pending' || (state?.status === 'saved' && state.draftOnly))) {
      launch(tracked.submission);
    }
  }
  return () => {
    if (editorTargets.get(exportJobs) === editor) editorTargets.delete(exportJobs);
    unsub();
  };
}
