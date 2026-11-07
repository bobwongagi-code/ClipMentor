import {sourceFrameSeekMs} from '../../shared/source-frame-seek';
import type { AgentContext } from '../agent/context';
import { isAnalysisActor, isClipMentorAnalysis, type AnalysisObservation } from './analysis';

/** Local extraction only: returns pictures to the main Agent; no ASR or vision fallback call. */
export async function observeClipMentorSource(args: Record<string, unknown>, ctx: AgentContext): Promise<unknown> {
  const doc = ctx.getDoc();
  const current = doc.clipMentorAnalysis;
  if (!current || args.expectedRevision !== current.revision || !isAnalysisActor(args.actor)
    || typeof args.reason !== 'string' || !args.reason.trim()) return { error: 'Current analysis revision, actor and reason required' };
  const asset = doc.assets.find((a) => a.id === current.source.asset_id);
  const hash = current.source.sourceContentHash;
  if (!asset || asset.kind !== 'video' || !asset.src?.startsWith('/media/uploads/')
    || !hash || asset.sourceContentHash !== hash) return { error: 'Hash-bound original upload required' };
  if ((args.seconds === undefined) === (args.sequence === undefined)) return { error: 'Supply seconds OR sequence, not both' };
  let requested = args.seconds;
  if (args.sequence !== undefined) {
    const s = args.sequence as Record<string, unknown> | null;
    if (!s || typeof s !== 'object' || Array.isArray(s)
      || typeof s.startSeconds !== 'number' || !Number.isFinite(s.startSeconds) || s.startSeconds < 0
      || typeof s.endSeconds !== 'number' || !Number.isFinite(s.endSeconds) || s.endSeconds <= s.startSeconds
      || s.endSeconds >= current.source.duration_seconds || !Number.isSafeInteger(s.count) || Number(s.count) < 2 || Number(s.count) > 8) return { error: 'Sequence requires startSeconds < endSeconds inside source and count 2–8' };
    const start = s.startSeconds, end = s.endSeconds;
    requested = Array.from({ length: Number(s.count) }, (_, i) => start + (end - start) * i / (Number(s.count) - 1));
  }
  if (!Array.isArray(requested) || !requested.length || requested.length > 8
    || !requested.every((t) => typeof t === 'number' && Number.isFinite(t) && t >= 0 && t < current.source.duration_seconds)) return { error: 'Supply 1–8 explicit source seconds inside the original duration' };
  const fps = current.source.fps;
  const frames = [...new Set(requested.map((t) => Math.floor(t * fps)))];
  if (args.sequence !== undefined && frames.length !== requested.length) return { error: 'Sequence samples must map to distinct source frames; widen the window or reduce count' };
  const times = frames.map((f) => f / fps);
  const ms = times.map((t) => sourceFrameSeekMs(t * 1000));
  let images: Array<{ frame: number; base64: string }> = [];
  try {
    const res = await (ctx.hostFetch ?? fetch)('/api/extract-frames', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ src: asset.src, sourceTimesMs: ms, output: 'frames' }), signal: AbortSignal.timeout(60_000) });
    if (res.ok) {
      const data = await res.json();
      // A partial/reordered response must never bind a picture to a different time.
      if (data.output === 'frames' && data.sampleCount === ms.length
        && Array.isArray(data.sourceTimesMs) && JSON.stringify(data.sourceTimesMs) === JSON.stringify(ms)
        && Array.isArray(data.frames) && data.frames.length === ms.length
        && data.frames.every((f: { base64?: unknown; sourceTimeMs?: unknown; mediaType?: unknown }, i: number) =>
          typeof f?.base64 === 'string' && f.base64.length > 0 && f.sourceTimeMs === ms[i] && f.mediaType === 'image/jpeg')) {
        images = data.frames.map((f: { base64: string }, i: number) => ({ frame: frames[i], base64: f.base64 }));
      }
    }
  } catch { /* Persist an explicit failed extraction, never an invented observation. */ }
  if (ctx.getDoc() !== doc) return { error: 'Project changed during observation; no stale result applied' };
  const a = structuredClone(current);
  const now = Date.now();
  const id = `observation:${crypto.randomUUID()}`;
  const ok = images.length === frames.length;
  const ids = ok ? frames.map((f) => `${id}:f${f}`) : [];
  const observation: AnalysisObservation = { observation_id: id, source_hash: hash,
    requested_times_seconds: times, frame_evidence_ids: ids, status: ok ? 'images_returned' : 'failed',
    method: 'source_frames_for_main_agent', image_layout: 'individual_frames', sampling: args.sequence === undefined ? 'explicit_times' : 'sequence',
    at: now, ...(!ok ? { failure: 'extraction_failed_or_incomplete' as const } : {}) };
  a.observations = [...(a.observations ?? []), observation];
  if (ok) for (let i = 0; i < frames.length; i++) a.evidence.push({ evidence_id: ids[i], kind: 'source_frame',
    text: 'Source frame extracted and returned; interpretation pending', status: 'frame_extracted_not_interpreted',
    time_seconds: times[i], source_frame: frames[i], observation_id: id,
    supporting_evidence_ids: [], source_ids: [], observation_method: 'local_frame_extraction_only', call_status: 'succeeded' });
  a.revision += 1;
  a.audit.push({ revision: a.revision, action: 'observe_source', target_id: id, actor: args.actor, at: now, reason: args.reason });
  if (!isClipMentorAnalysis(a)) return { error: 'Invalid observation record; nothing saved' };
  ctx.commands.applyDoc({ ...doc, clipMentorAnalysis: a });
  return { ok, revision: a.revision, observation, interpretationVerified: false,
    note: `Revision ${a.revision}. Individual uncropped JPEGs, source aspect ratio, max long edge 1280 (no upscaling). ${ids.map((f, i) => `Image ${i + 1}: ${f} at ${times[i]}s`).join('; ')}. Inspect pictures directly. Sequence is sampled motion, not continuous viewing or listening. No efficacy verification.`,
    ...(ok ? { __images: images } : { error: 'Frame extraction failed or incomplete; failure saved, no visual evidence created' }) };
}
