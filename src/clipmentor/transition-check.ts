/** Pure structural self-check shared by Agent QA and the CLI; never edits or approves media. */
type Scene = { start_frame: number; end_frame: number; kind: 'original' | 'video' | 'still' | 'relation'; content: number | number[]; label?: string };
type Candidate = { code: 'composition_change' | 'pause_inserts_picture' | 'audio_gap_with_picture_change'; start_seconds: number; end_seconds: number; detail: string };
const row = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const frame = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const close = (a: number, b: number) => Math.abs(a - b) <= Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b)) * 4;
const pictureClass = (s: Scene) => s.kind === 'relation' ? 'relation' : s.kind === 'original' ? 'original' : 'single_explanation';
// At a cut, compare the departing last displayed frame with the arriving first frame.
// content is an IN point for normal-speed video, but a fixed source position for stills.
function boundaryPicture(scene: Scene, edge: 'start' | 'end', fps: number): number[] {
  if (Array.isArray(scene.content)) return scene.content;
  const offset = edge === 'end' && (scene.kind === 'video' || scene.kind === 'original')
    ? (scene.end_frame - scene.start_frame - 1) / fps : 0;
  return [scene.content + offset];
}
function samePicture(a: Scene, aEdge: 'start' | 'end', b: Scene, bEdge: 'start' | 'end', fps: number) {
  if (pictureClass(a) !== pictureClass(b)) return false;
  const left = boundaryPicture(a, aEdge, fps), right = boundaryPicture(b, bEdge, fps);
  // Compare at this manifest's output-frame resolution, not exact float equality or perceptual tolerance.
  return left.length === right.length && left.every((t, i) => Math.round(t * fps) === Math.round(right[i] * fps));
}

interface AudioSpan { start: number; end: number; kind?: string; line_id?: string }
function audioFacts(value: unknown, duration: number) {
  if (value === undefined) return { audio_check: 'not_provided' as const, audio_gaps: [], audio_boundaries: [] };
  if (!Array.isArray(value)) throw new Error('Invalid audio placements');
  const spans = value.map((a): AudioSpan => {
    if (!row(a) || !finite(a.start) || !finite(a.end) || a.start < 0 || a.end <= a.start
      || (a.end > duration && !close(a.end, duration))
      || (a.kind !== undefined && typeof a.kind !== 'string') || (a.line_id !== undefined && typeof a.line_id !== 'string')) throw new Error('Invalid audio placement');
    return { start: a.start, end: a.end, ...(typeof a.kind === 'string' ? { kind: a.kind } : {}), ...(typeof a.line_id === 'string' ? { line_id: a.line_id } : {}) };
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  const audio_gaps: Array<{ start_seconds: number; end_seconds: number; duration_seconds: number; tail: boolean }> = [];
  let coveredEnd = 0;
  for (const span of spans) {
    if (span.start > coveredEnd && !close(span.start, coveredEnd)) audio_gaps.push({ start_seconds: coveredEnd, end_seconds: span.start, duration_seconds: span.start - coveredEnd, tail: false });
    coveredEnd = Math.max(coveredEnd, span.end);
  }
  if (coveredEnd < duration && !close(coveredEnd, duration)) audio_gaps.push({ start_seconds: coveredEnd, end_seconds: duration, duration_seconds: duration - coveredEnd, tail: true });
  return { audio_check: 'scheduled_coverage_only' as const, audio_gaps,
    audio_boundaries: spans.flatMap((span) => [
      { at_seconds: span.start, event: 'audio_start' as const, kind: span.kind, line_id: span.line_id },
      { at_seconds: span.end, event: 'audio_end' as const, kind: span.kind, line_id: span.line_id },
    ]).sort((a, b) => a.at_seconds - b.at_seconds) };
}

/** Merge only actual overlapping/touching evidence spans, never a perceptual time window. */
function groupCandidates(candidates: Candidate[]) {
  const groups: Array<{ start_seconds: number; end_seconds: number; signals: Candidate[]; next_action: 'agent_inspect'; quality_status: 'unverified' }> = [];
  for (const candidate of [...candidates].sort((a, b) => a.start_seconds - b.start_seconds || a.end_seconds - b.end_seconds)) {
    const last = groups.at(-1);
    if (last && (candidate.start_seconds <= last.end_seconds || close(candidate.start_seconds, last.end_seconds))) {
      last.end_seconds = Math.max(last.end_seconds, candidate.end_seconds); last.signals.push(candidate);
    } else groups.push({ start_seconds: candidate.start_seconds, end_seconds: candidate.end_seconds, signals: [candidate], next_action: 'agent_inspect', quality_status: 'unverified' });
  }
  return groups;
}

export function checkTransitionManifest(input: unknown) {
  if (!row(input) || !finite(input.fps) || input.fps <= 0 || !frame(input.total_frames) || input.total_frames === 0
    || !Array.isArray(input.scenes) || !input.scenes.length) throw new Error('Expected fps, total_frames and frame-based scenes; do not hand-fill a second Shot timeline');
  const fps = input.fps;
  let previousEnd = 0;
  const scenes = input.scenes.map((value): Scene => {
    if (!row(value) || !frame(value.start_frame) || !frame(value.end_frame) || value.end_frame <= value.start_frame
      || value.start_frame !== previousEnd || value.end_frame > Number(input.total_frames)
      || !(typeof value.kind === 'string' && ['original', 'video', 'still', 'relation'].includes(value.kind))
      || (value.label !== undefined && typeof value.label !== 'string')) throw new Error('Invalid, unsorted, overlapping or discontinuous picture range');
    const relation = value.kind === 'relation';
    if (relation ? !Array.isArray(value.content) || value.content.length !== 2 || !value.content.every((t) => finite(t) && t >= 0)
      : !finite(value.content) || value.content < 0) throw new Error('Missing or invalid source position; no inferred evidence');
    previousEnd = value.end_frame;
    return value as Scene;
  });
  if (previousEnd !== input.total_frames) throw new Error('Picture coverage does not reach total_frames');
  const candidates: Candidate[] = [];
  for (let i = 0; i < scenes.length; i++) {
    const current = scenes[i], previous = scenes[i - 1], next = scenes[i + 1];
    // Inspect the pause itself: a silent interval need not introduce a third picture.
    if (current.label === 'breath' && previous && next && !samePicture(previous, 'end', current, 'start', fps) && !samePicture(current, 'end', next, 'start', fps)) {
      candidates.push({ code: 'pause_inserts_picture', start_seconds: current.start_frame / fps, end_seconds: current.end_frame / fps,
        detail: '停顿使用了与前后不同的画面；核对是否必要，不自动删除或延长。' });
    }
    // The manifest records presentation kinds, not pixels, output geometry or perceived rhythm.
    // A relation/single change is review evidence at ANY duration, never a seconds-based failure.
    if (previous && (current.kind === 'relation' || previous.kind === 'relation') && pictureClass(current) !== pictureClass(previous)) {
      candidates.push({ code: 'composition_change', start_seconds: current.start_frame / fps, end_seconds: current.end_frame / fps,
        detail: '单幅／关系图切换；请连同前后观看确认尺度与注意转移，不能只凭时长判突兀。' });
    }
  }
  const cut_events = scenes.slice(1).map((scene, i) => ({
    at_seconds: scene.start_frame / fps, scene_index: i + 1,
    layout_before: pictureClass(scenes[i]), layout_after: pictureClass(scene),
    layout_changed: pictureClass(scenes[i]) !== pictureClass(scene),
    medium_before: scenes[i].kind, medium_after: scene.kind, medium_changed: scenes[i].kind !== scene.kind,
    duration_after_seconds: (scene.end_frame - scene.start_frame) / fps,
    // Labels identify execution segments, not proven semantic content types.
    from_label: scenes[i].label, to_label: scene.label,
    source_end_before_seconds: boundaryPicture(scenes[i], 'end', fps), source_start_after_seconds: boundaryPicture(scene, 'start', fps),
  }));
  const layouts = cut_events.filter((cut) => cut.layout_changed);
  const layout_change_pairs = layouts.slice(1).map((cut, i) => ({
    from_seconds: layouts[i].at_seconds, to_seconds: cut.at_seconds, elapsed_seconds: cut.at_seconds - layouts[i].at_seconds,
  }));
  const audio = audioFacts(input.audios, input.total_frames / fps);
  for (const gap of audio.audio_gaps) {
    // This is an interval intersection, not "nearby means simultaneous".
    const cuts = cut_events.filter((cut) => cut.layout_changed && cut.at_seconds >= gap.start_seconds && cut.at_seconds < gap.end_seconds);
    if (cuts.length && !gap.tail) candidates.push({ code: 'audio_gap_with_picture_change', start_seconds: gap.start_seconds, end_seconds: gap.end_seconds,
      detail: '无音轨安排区间内有呈现类别切换；交Agent结合蓝图检查作用，不凭间隔判卡顿。' });
  }
  const review_groups = groupCandidates(candidates).map((group, index) => ({ ...group, group_id: `transition-${index + 1}`,
    cut_events: cut_events.filter((cut) => cut.at_seconds >= group.start_seconds && cut.at_seconds <= group.end_seconds),
    audio_gaps: audio.audio_gaps.filter((gap) => gap.start_seconds < group.end_seconds && gap.end_seconds > group.start_seconds),
  }));
  const narrationSpans: Array<{ line_id: string; start_seconds: number; end_seconds: number; duration_seconds: number }> = [];
  if (input.lines !== undefined) {
    if (!Array.isArray(input.lines)) throw new Error('Invalid narration lines');
    const ids = new Set<string>();
    let lineEnd = 0;
    for (const l of input.lines) {
      if (!row(l) || typeof l.line_id !== 'string' || !l.line_id.trim() || ids.has(l.line_id)
        || !finite(l.start) || !finite(l.end) || l.start < 0
        // Ignore arithmetic round-off only, not a perceptual/sync tolerance or actual overlap.
        || l.start + Number.EPSILON * Math.max(1, l.start, lineEnd) * 4 < lineEnd
        || l.end <= l.start || l.end > input.total_frames / fps) throw new Error('Invalid narration placement');
      ids.add(l.line_id); lineEnd = l.end;
      narrationSpans.push({ line_id: l.line_id, start_seconds: l.start, end_seconds: l.end, duration_seconds: l.end - l.start });
    }
  }
  return { scope: 'execution_manifest_transition_candidates', fps, duration_seconds: input.total_frames / fps, status: candidates.length ? 'review_required' : 'no_mechanical_candidates',
    review_groups, human_review_requested: false,
    next: 'Agent先按合并区间对照蓝图自检；只修本次授权内有依据的执行偏差，未知保留。不要逐项询问用户，不自动改稿/删镜头或追加模型。最终预览只附合并后仍待核区间。',
    candidates, cut_events, layout_change_pairs, ...audio, narration_spans: narrationSpans,
    limits: ['仅支持frame-based scenes执行快照；未自动从ProjectDoc提取布局或听审句界。', 'kind只映射本执行格式的呈现类别，video/still属于同一单幅布局；实际像素、尺寸、动态与听感未检查。', '音轨间隔来自所有安排区间的并集，不是实际发声边界；缺少audios记未检查。',
      '不按3/5秒或价值占比判文案优劣；没有疑点不等于教学、自然度或成片通过。'],
    semantic_review: 'not_performed', continuous_viewing: false, listening: false, full_film_accepted: false };
}


/** Only this mode is data-only: no export lookup, frame extraction, vision or provider request. */
export function isManifestSelfCheckCall(args?: Readonly<Record<string, unknown>>) {
  return args?.executionManifest !== undefined && args.src === undefined && args.renderId === undefined;
}
export function transitionSelfCheckResult(input: unknown) {
  try {
    const report = checkTransitionManifest(input);
    return { ok: true, scope: 'local_manifest_self_check_only', transition_self_check: report,
      preview_binding: 'not_verified', human_review_requested: false, full_film_accepted: false, next: report.next };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Invalid execution manifest', scope: 'local_manifest_self_check_only',
      human_review_requested: false, full_film_accepted: false };
  }
}
