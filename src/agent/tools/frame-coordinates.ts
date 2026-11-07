import {sourceFrameSeekMs}from'../../../shared/source-frame-seek';
import type {SourceFrameWindow} from '../../editor/sourceLimit';
type Args=Record<string,unknown>;
const MAX_FRAMES = 8;
/** Default sample count for a broad media scan. */



/** Normalize explicit source coordinates once so every renderer honors the same cap. */
export function explicitSourceTimesMs(args: Args, fps: number): number[] | undefined {
  const values = Array.isArray(args.sourceTimesMs) && args.sourceTimesMs.length
    ? args.sourceTimesMs.map(Number)
    : Array.isArray(args.seconds) && args.seconds.length
      ? args.seconds.map((seconds) => Number(seconds) * 1000)
      : Array.isArray(args.frames) && args.frames.length
        ? args.frames.map((frame) => (Number(frame) / fps) * 1000)
        : undefined;
  const normalized = values
    ?.filter((value) => Number.isFinite(value) && value >= 0)
    .slice(0, MAX_FRAMES)
    .map(sourceFrameSeekMs);
  return normalized?.length ? normalized : undefined;
}

/** Midpoints of n equal blocks in [0, total). */
function evenMidpoints(total: number, count: number): number[] {
  const n = Math.max(1, Math.min(MAX_FRAMES, Math.round(count)));
  const t = Math.max(1, total);
  return Array.from({ length: n }, (_, i) => Math.round(((i + 0.5) / n) * t));
}

/** Resolve which frames to render: sourceTimesMs → frames → seconds → range midpoints → full midpoints. */
export function pickFrames(
  args: Args,
  total: number,
  fps: number,
  defaultCount: number,
): number[] {
  let frames: number[];
  if (Array.isArray(args.sourceTimesMs) && args.sourceTimesMs.length) {
    frames = args.sourceTimesMs.map((ms) => Math.round((Number(ms) / 1000) * fps));
  } else if (Array.isArray(args.frames) && args.frames.length) {
    frames = args.frames.map(Number);
  } else if (Array.isArray(args.seconds) && args.seconds.length) {
    frames = args.seconds.map((s) => Math.round(Number(s) * fps));
  } else {
    const fromS = typeof args.fromSeconds === 'number' ? args.fromSeconds : null;
    const toS = typeof args.toSeconds === 'number' ? args.toSeconds : null;
    const count = Math.max(1, Math.min(MAX_FRAMES, Math.round(Number(args.count) || defaultCount)));
    if (fromS != null && toS != null && toS > fromS) {
      const fromF = Math.max(0, Math.round(fromS * fps));
      const toF = Math.min(total, Math.round(toS * fps));
      const span = Math.max(1, toF - fromF);
      frames = evenMidpoints(span, count).map((f) => fromF + f);
    } else {
      frames = evenMidpoints(total, count);
    }
  }
  return [...new Set(
    frames.map((f) => Math.max(0, Math.min(Math.max(0, total - 1), Math.round(f)))),
  )].slice(0, MAX_FRAMES);
}
/** Clamp source-coordinate arguments to a half-open visible source window. */
export function constrainSourceFrameArgs(
  args: Args,
  window: SourceFrameWindow,
  fps: number,
): Args {
  const firstFrame = Math.max(0, Math.ceil(window.startFrame));
  const lastFrame = Math.max(firstFrame, Math.ceil(window.endFrame) - 1);
  const clampFrame = (value: number) => Math.max(firstFrame, Math.min(lastFrame, value));
  const constrained = { ...args };
  if (Array.isArray(args.sourceTimesMs) && args.sourceTimesMs.length) {
    constrained.sourceTimesMs = args.sourceTimesMs.map((value) =>
      sourceFrameSeekMs((clampFrame((Number(value) / 1000) * fps) / fps) * 1000));
  } else if (Array.isArray(args.frames) && args.frames.length) {
    constrained.frames = args.frames.map((value) => clampFrame(Number(value)));
  } else if (Array.isArray(args.seconds) && args.seconds.length) {
    constrained.seconds = args.seconds.map((value) => clampFrame(Number(value) * fps) / fps);
  } else {
    const requestedFrom = typeof args.fromSeconds === 'number'
      ? args.fromSeconds * fps
      : window.startFrame;
    const requestedTo = typeof args.toSeconds === 'number'
      ? args.toSeconds * fps
      : window.endFrame;
    constrained.fromSeconds = Math.max(window.startFrame, requestedFrom) / fps;
    constrained.toSeconds = Math.max(
      Math.max(window.startFrame, requestedFrom) + 1,
      Math.min(window.endFrame, requestedTo),
    ) / fps;
  }
  return constrained;
}
