export { EXPORT_QA_TOOL_SCHEMAS, EXPORT_QA_TOOL_NAMES } from './schemas/export-qa-tools';
import { checkTransitionManifest, isManifestSelfCheckCall, transitionSelfCheckResult } from '../../clipmentor/transition-check';
import { captionFaceQaIssues } from '../../geometry/caption-qa';
import type { AgentContext } from '../context';
import {
  captionLayoutQaIssues,
  exportQaExpectations,
  mergeExportQaIssues,
  timelineCutTimesSeconds,
  type ExportQaExpectations,
  type ExportQaReport,
} from '../../export/quality';
import { fetchRenderJob } from './export-tools';
import { maybeDescribeFramesResult, allowImplicitVision } from '../vision';

type Args = Record<string, unknown>;

interface ExportQaResponse {
  ok?: boolean;
  error?: string;
  src?: string;
  report?: ExportQaReport;
  evidence?: {
    mediaType?: string;
    base64?: string;
    samples?: { cutSeconds: number; sampleSeconds: number; side: 'before' | 'after' }[];
  };
}

interface ResolvedExport {
  src: string;
  expected?: Partial<Pick<ExportQaExpectations, 'durationSeconds' | 'width' | 'height' | 'fps'>>;
  sourceStartSeconds?: number;
}

async function resolveExportSrc(args: Args): Promise<ResolvedExport | { error: string }> {
  const direct = typeof args.src === 'string' ? args.src.trim() : '';
  if (direct) return direct.startsWith('/media/uploads/')
    ? { src: direct }
    : { error: 'src must be a completed export under /media/uploads/' };

  const renderId = typeof args.renderId === 'string' ? args.renderId.trim() : '';
  if (!renderId) return { error: 'renderId or src is required' };
  const job = await fetchRenderJob(renderId);
  if (!('ok' in job)) return job;
  if (job.status !== 'completed') {
    return { error: `render job ${job.renderId} is ${job.status}; wait for completion before QA` };
  }
  if (!job.downloadUrl) return { error: `render job ${job.renderId} has no output path` };
  return {
    src: job.downloadUrl,
    expected: {
      ...(job.durationSeconds !== undefined ? { durationSeconds: job.durationSeconds } : {}),
      ...(job.width !== undefined ? { width: job.width } : {}),
      ...(job.height !== undefined ? { height: job.height } : {}),
      ...(job.fps !== undefined ? { fps: job.fps } : {}),
    },
    sourceStartSeconds: job.sourceStartSeconds,
  };
}

async function verifyExport(args: Args, ctx: AgentContext): Promise<unknown> {
  try {
    if (isManifestSelfCheckCall(args)) return transitionSelfCheckResult(args.executionManifest);
    const transitions = args.executionManifest === undefined ? undefined : checkTransitionManifest(args.executionManifest);
    const resolved = await resolveExportSrc(args);
    if ('error' in resolved) return resolved;

    const state = ctx.getState();
    const expected = { ...exportQaExpectations(state), ...resolved.expected };
    const maxCuts = Math.max(1, Math.min(8, Math.round(Number(args.maxCuts) || 8)));
    const sourceStartSeconds = resolved.sourceStartSeconds ?? 0;
    const cutTimesSeconds = timelineCutTimesSeconds(state, 24)
      .map((seconds) => Number((seconds - sourceStartSeconds).toFixed(4)))
      .filter((seconds) => seconds > 0 && seconds < expected.durationSeconds)
      .slice(0, maxCuts);
    const response = await fetch('/api/export-qa', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        src: resolved.src,
        ...expected,
        cutTimesSeconds,
        maxEvidenceCuts: maxCuts,
      }),
    });
    const result = (await response.json().catch(() => null)) as ExportQaResponse | null;
    if (!response.ok || !result?.report) {
      return { error: result?.error ?? `export QA failed (${response.status})` };
    }

    const report = mergeExportQaIssues(result.report, captionLayoutQaIssues(state));
    // Geometry-aware caption check: warns when a caption band covers the
    // speaker's face (visual geometry cache; first use analyzes the source).
    const faceIssues = await captionFaceQaIssues(ctx.getDoc(), state);
    const merged = faceIssues.length ? mergeExportQaIssues(report, faceIssues) : report;
    const evidence = result.evidence;
    const manifestTimingMismatch = transitions && (!Number.isFinite(merged.durationSeconds) || !Number.isFinite(merged.fps)
      || Math.abs(transitions.duration_seconds - merged.durationSeconds) > 1 / transitions.fps
      || Math.abs(transitions.fps - merged.fps) > Number.EPSILON * Math.max(transitions.fps, merged.fps) * 4);
    return {
      ok: merged.ok && !manifestTimingMismatch,
      ...(transitions ? { transition_self_check: transitions, preview_binding: manifestTimingMismatch ? 'timing_mismatch' : 'timing_only_not_content_verified',
        human_review_requested: false, full_film_accepted: false } : {}),
      src: resolved.src,
      report: merged,
      cutCount: cutTimesSeconds.length,
      evidenceSamples: evidence?.samples ?? [],
      ...(evidence?.base64 ? { __images: [{ frame: 0, base64: evidence.base64 }] } : {}),
      note: evidence?.base64
        ? 'Cut evidence is a two-column sheet: each row shows the frame immediately before and after one edit boundary.'
        : 'No adjacent edit boundaries were available for visual evidence; stream-level QA still completed.',
      next: transitions ? manifestTimingMismatch
        ? 'Agent读取本次导出的实际执行清单再自检；时基不符不能当已检查，不询问用户逐条核对。'
        : transitions.next
        : merged.ok && merged.summary.warnings === 0
        ? 'Export passed automated QA.'
        : 'Inspect every issue and evidence row. Fix confirmed problems, export again, and rerun verify_export. Stop after three attempts and report any remaining issue to the user.',
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export async function execExportQaTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'verify_export') return { error: `export QA tool not implemented: ${name}` };
  const result = await verifyExport(args, ctx);
  return await allowImplicitVision(ctx.getProjectId?.()) ? maybeDescribeFramesResult(result, 'qa-evidence') : result;
}
