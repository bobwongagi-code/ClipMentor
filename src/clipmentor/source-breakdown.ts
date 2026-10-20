import type { ProjectDoc } from '../editor/types';
import { sourceWindowForTimelineRange } from '../editor/sourceLimit';

/** One source-bound ledger, shared by analysis, copy review and execution. Not a model verdict. */
export interface SourceBreakdown {
  version: 1;
  segments: Array<{
    segment_id: string;
    source_range_seconds: [number, number];
    visible_evidence_ids: string[];
    claim_evidence_ids: string[];
    interpretation_evidence_ids: string[];
    unknowns: string[];
  }>;
  points: Array<{
    point_id: string;
    segment_ids: string[];
    buying_concern: string;
    teaching_question: string;
    filming_conditions: string[];
    role: 'primary' | 'supporting' | 'auxiliary';
    supports_point_id?: string;
    importance: 'must_explain' | 'should_explain' | 'optional';
    change_reason?: string;
  }>;
  units: Array<{
    unit_id: string;
    original_segment_ids: string[];
    /** Selected original playback; evidence indexes can be sparser than this continuous context. */
    original_source_ranges?: Array<[number, number]>;
    explanation_segment_ids: string[];
    coverage: Array<{
      point_id: string;
      treatment: 'explain' | 'merged' | 'visual_only' | 'omit';
      reason?: string;
      merged_into_point_id?: string;
    }>;
    revisits: Array<{ from_segment_id: string; to_segment_id: string; reason: string }>;
    /** Output positions, not author-supplied clip IDs or actual source ranges. */
    placement?: { timeline_id: string; original_frames: [number, number]; explanation_frames: [number, number] };
  }>;
}

type Row = Record<string, unknown>;
const row = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(text);
const rows = (v: unknown, check: (r: Row) => boolean) => Array.isArray(v) && v.every((x) => row(x) && check(x));
const range = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2
  && v.every((n) => typeof n === 'number' && Number.isFinite(n)) && v[0] >= 0 && v[1] > v[0];
const unique = (ids: string[]) => new Set(ids).size === ids.length;

export function isSourceBreakdown(v: unknown): v is SourceBreakdown {
  if (!row(v) || v.version !== 1
    || !rows(v.segments, (s) => text(s.segment_id) && range(s.source_range_seconds)
      && strings(s.visible_evidence_ids) && strings(s.claim_evidence_ids) && strings(s.interpretation_evidence_ids) && strings(s.unknowns))
    || !rows(v.points, (p) => text(p.point_id) && strings(p.segment_ids) && p.segment_ids.length > 0
      && text(p.buying_concern) && text(p.teaching_question) && strings(p.filming_conditions)
      && ['primary', 'supporting', 'auxiliary'].includes(String(p.role))
      && ['must_explain', 'should_explain', 'optional'].includes(String(p.importance))
      && (p.supports_point_id === undefined || text(p.supports_point_id)) && (p.change_reason === undefined || text(p.change_reason)))
    || !rows(v.units, (u) => text(u.unit_id) && strings(u.original_segment_ids) && strings(u.explanation_segment_ids)
      && (u.original_source_ranges === undefined || (Array.isArray(u.original_source_ranges) && u.original_source_ranges.length > 0 && u.original_source_ranges.every(range)))
      && rows(u.coverage, (c) => text(c.point_id) && ['explain', 'merged', 'visual_only', 'omit'].includes(String(c.treatment))
        && (c.reason === undefined || text(c.reason)) && (c.merged_into_point_id === undefined || text(c.merged_into_point_id)))
      && rows(u.revisits, (r) => text(r.from_segment_id) && text(r.to_segment_id) && text(r.reason))
      && (u.placement === undefined || (row(u.placement) && text(u.placement.timeline_id)
        && range(u.placement.original_frames) && range(u.placement.explanation_frames)
        && [...u.placement.original_frames, ...u.placement.explanation_frames].every(Number.isSafeInteger))))) return false;
  const b = v as unknown as SourceBreakdown;
  return b.segments.length > 0 && b.points.length > 0 && b.units.length > 0
    && unique(b.segments.map((s) => s.segment_id)) && unique(b.points.map((p) => p.point_id)) && unique(b.units.map((u) => u.unit_id))
    && b.units.every((u) => unique(u.coverage.map((c) => c.point_id)));
}

/** Keep the baseline across revisions. Corrections are explicit and invalidate the existing digest. */
export function breakdownRevisionError(previous: SourceBreakdown | undefined, next: SourceBreakdown): string | null {
  if (!previous) return null;
  if (previous.points.some((p) => !next.points.some((n) => n.point_id === p.point_id))) return 'Selected points cannot disappear; record a treatment and reason';
  if (previous.segments.some((s) => !next.segments.some((n) => n.segment_id === s.segment_id))) return 'Source segments cannot disappear; preserve their IDs';
  for (const old of previous.points) {
    const current = next.points.find((p) => p.point_id === old.point_id)!;
    if ((old.importance === 'must_explain' && current.importance !== old.importance)
      || (old.role === 'primary' && current.role !== old.role)) return 'The author cannot downgrade a required/primary task; keep it unresolved for independent scope review';
    const { change_reason: _oldReason, ...before } = old;
    const { change_reason: _newReason, ...after } = current;
    if (JSON.stringify(before) !== JSON.stringify(after) && (!current.change_reason || current.change_reason === old.change_reason)) return 'Changing a selected teaching task requires a new point change_reason';
  }
  return null;
}

export function breakdownPointEvidence(b: SourceBreakdown, pointId: string): string[] {
  const point = b.points.find((p) => p.point_id === pointId);
  return [...new Set(b.segments.filter((s) => point?.segment_ids.includes(s.segment_id))
    .flatMap((s) => [...s.visible_evidence_ids, ...s.claim_evidence_ids, ...s.interpretation_evidence_ids]))];
}

export function originalPlaybackRanges(b: SourceBreakdown, unit: SourceBreakdown['units'][number]): Array<[number, number]> {
  return unit.original_source_ranges ?? unit.original_segment_ids.flatMap((id) => {
    const s = b.segments.find((segment) => segment.segment_id === id);
    return s ? [s.source_range_seconds] : [];
  });
}

function rangesCover(ranges: Array<[number, number]>, target: [number, number], tolerance: number) {
  let end = target[0];
  for (const r of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (r[1] <= end) continue;
    if (r[0] > end + tolerance) break;
    end = r[1];
  }
  return end + tolerance >= target[1];
}

export function checkSourceBreakdown(doc: ProjectDoc, checkTimeline = false) {
  const issues: Array<{ code: string; id: string }> = [];
  const bindings: Array<{ unit_id: string; phase: string; item_id: string; source_range_seconds: [number, number]; segment_ids: string[] }> = [];
  const issue = (code: string, id: string) => issues.push({ code, id });
  const a = doc.clipMentorAnalysis;
  const b = a?.source_breakdown;
  const result = () => ({ status: issues.length ? 'review_required' as const : 'structurally_ready' as const,
    scope: checkTimeline ? 'registered_timeline_ranges_only' : 'registered_points_and_plan_only', issues, bindings,
    semantic_review_required: true as const, complete_film_accepted: false as const });
  if (!a || !b) { issue('source_breakdown_missing', 'analysis'); return result(); }
  if (!isSourceBreakdown(b)) { issue('source_breakdown_invalid', 'analysis'); return result(); }
  const asset = doc.assets.find((v) => v.id === a.source.asset_id);
  if (!a.source.sourceContentHash || asset?.sourceContentHash !== a.source.sourceContentHash) issue('source_hash_missing_or_changed', a.source.asset_id);
  const segments = new Map(b.segments.map((s) => [s.segment_id, s]));
  const evidence = new Map(a.evidence.map((e) => [e.evidence_id, e]));
  for (const s of b.segments) {
    if (s.source_range_seconds[1] > a.source.duration_seconds) issue('segment_time_out_of_bounds', s.segment_id);
    const groups = [
      [s.visible_evidence_ids, ['visible_action', 'source_frame']],
      [s.claim_evidence_ids, ['original_claim']],
      [s.interpretation_evidence_ids, ['expression_analysis_not_verified_causal_effect', 'operator_supplied']],
    ] as const;
    if (!groups.some(([ids]) => ids.length)) issue('segment_without_evidence', s.segment_id);
    for (const [ids, kinds] of groups) for (const id of ids) {
      const e = evidence.get(id);
      if (!e || !(kinds as readonly string[]).includes(e.kind)) { issue('segment_evidence_kind_or_reference', id); continue; }
      if (e.call_status === 'failed') issue('segment_observation_failed', id);
      const r = e.source_range_seconds ?? (e.time_seconds === undefined ? undefined : [e.time_seconds, e.time_seconds]);
      if (r && (r[1] < s.source_range_seconds[0] || r[0] > s.source_range_seconds[1])) issue('segment_evidence_outside_range', id);
    }
  }
  for (const p of b.points) {
    if (p.segment_ids.some((id) => !segments.has(id))) issue('point_segment_missing', p.point_id);
    if (!breakdownPointEvidence(b, p.point_id).length) issue('point_without_segment_evidence', p.point_id);
    if (p.role === 'supporting' && !b.points.some((target) => target.point_id === p.supports_point_id && target.role === 'primary')) issue('supporting_primary_missing', p.point_id);
    if (!b.units.some((u) => u.coverage.some((c) => c.point_id === p.point_id))) issue('selected_point_unaccounted', p.point_id);
  }
  for (const unit of a.blueprint) {
    const internal = (unit as unknown as Row).internal_review;
    if (row(internal) && text(internal.current_script_candidate) && !b.units.some((u) => u.unit_id === unit.unit_id)) issue('copy_unit_not_registered', unit.unit_id);
  }
  for (const u of b.units) {
    // Preserve older extra metadata on read, but never silently treat an unknown field as plan authority.
    const fields = new Set(['unit_id', 'original_segment_ids', 'original_source_ranges', 'explanation_segment_ids', 'coverage', 'revisits', 'placement']);
    for (const key of Object.keys(u)) if (!fields.has(key)) issue('unrecognized_unit_field', `${u.unit_id}:${key}`);
    const originalRanges = originalPlaybackRanges(b, u);
    if (originalRanges.some((r) => r[1] > a.source.duration_seconds)) issue('original_playback_out_of_bounds', u.unit_id);
    for (const id of u.original_segment_ids) {
      const r = segments.get(id)?.source_range_seconds;
      if (r && !rangesCover(originalRanges, r, 1 / a.source.fps + 1e-6)) issue('original_segment_outside_playback', id);
    }
    const blueprint = a.blueprint.find((v) => v.unit_id === u.unit_id);
    if (!blueprint) issue('breakdown_unit_missing', u.unit_id);
    for (const id of [...u.original_segment_ids, ...u.explanation_segment_ids]) if (!segments.has(id)) issue('unit_segment_missing', id);
    for (const c of u.coverage) {
      const p = b.points.find((v) => v.point_id === c.point_id);
      if (!p) { issue('coverage_point_missing', c.point_id); continue; }
      if (p.role === 'supporting' && !u.coverage.some((target) => target.point_id === p.supports_point_id)) issue('supporting_primary_not_in_unit', p.point_id);
      if (c.treatment !== 'explain' && !c.reason) issue('point_treatment_reason_missing', c.point_id);
      if (p.importance === 'must_explain' && (c.treatment === 'omit' || (c.treatment === 'visual_only' && !c.reason))) issue('required_point_not_explained', c.point_id);
      if (c.treatment === 'merged' && !u.coverage.some((target) => target.point_id === c.merged_into_point_id && target.point_id !== c.point_id && target.treatment === 'explain')) issue('merge_target_not_explained', c.point_id);
      if (!['omit'].includes(c.treatment) && !p.segment_ids.some((id) => [...u.original_segment_ids, ...u.explanation_segment_ids].includes(id))) issue('point_picture_not_planned', c.point_id);
    }
    // A revisit is a declared relationship, not a threshold on seconds or a mandatory phrase.
    const order = [...u.original_segment_ids, ...u.explanation_segment_ids].filter((id) => segments.has(id));
    for (let i = 1; i < order.length; i++) {
      const from = segments.get(order[i - 1])!, to = segments.get(order[i])!;
      if (to.source_range_seconds[0] < from.source_range_seconds[1] - 1 / a.source.fps
        && !u.revisits.some((r) => r.from_segment_id === from.segment_id && r.to_segment_id === to.segment_id)) issue('revisit_not_registered', u.unit_id);
    }
    for (const r of u.revisits) if (!order.includes(r.from_segment_id) || !order.includes(r.to_segment_id)) issue('revisit_segment_missing', u.unit_id);
    const internal = (blueprint as unknown as Row | undefined)?.internal_review;
    const candidate = row(internal) && typeof internal.current_script_candidate === 'string' ? internal[internal.current_script_candidate] : null;
    if (row(candidate) && Array.isArray(candidate.lines)) {
      const linePoints = new Set<string>();
      for (const line of candidate.lines) {
        if (!row(line)) continue;
        const ids = strings(line.point_ids) ? line.point_ids : text(line.point) ? [line.point] : [];
        ids.forEach((id) => linePoints.add(id));
        if (!ids.length || ids.some((id) => !u.coverage.some((c) => c.point_id === id))) issue('copy_point_not_registered', String(line.id));
        if (!range(line.source_seconds) || !u.explanation_segment_ids.some((id) => {
          const r = segments.get(id)?.source_range_seconds;
          return r && range(line.source_seconds) && line.source_seconds[0] >= r[0] && line.source_seconds[1] <= r[1];
        })) issue('copy_picture_outside_explanation', String(line.id));
      }
      for (const c of u.coverage) if (['explain', 'merged'].includes(c.treatment) && !linePoints.has(c.point_id)) issue('selected_point_missing_from_copy', c.point_id);
    }
    if (!checkTimeline) continue;
    const placement = u.placement;
    const tl = doc.timelines.find((t) => t.id === placement?.timeline_id);
    if (!placement || !tl) { issue('unit_placement_missing', u.unit_id); continue; }
    if (placement.timeline_id !== doc.activeTimelineId) issue('unit_placement_targets_other_timeline', u.unit_id);
    if (tl.fps !== a.source.fps) { issue('source_frame_clock_unverified', u.unit_id); continue; }
    if (placement.original_frames[1] > placement.explanation_frames[0]) issue('unit_output_order_invalid', u.unit_id);
    for (const [phase, window, planned] of [
      ['original', placement.original_frames, u.original_segment_ids], ['explanation', placement.explanation_frames, u.explanation_segment_ids],
    ] as const) {
      const actual: Array<[number, number]> = [];
      const expected = phase === 'original' ? originalRanges : planned.flatMap((id) => segments.has(id) ? [segments.get(id)!.source_range_seconds] : []);
      for (const item of tl.items) {
        if (item.startFrame >= window[1] || item.startFrame + item.durationInFrames <= window[0]) continue;
        if (tl.tracks?.[item.track]?.hidden || item.transform?.opacity === 0) continue;
        if (item.kind === 'sequence') { issue('nested_source_not_inspected', item.id); continue; }
        if (item.kind !== 'video') continue;
        const sameSource = item.sourceAssetId ? item.sourceAssetId === a.source.asset_id : item.src === asset?.src;
        if (!sameSource) continue;
        if (item.sourceContentHash && item.sourceContentHash !== a.source.sourceContentHash) issue('item_source_hash_mismatch', item.id);
        if (!Number.isFinite(item.playbackRate ?? 1) || (item.playbackRate ?? 1) <= 0 || !Number.isFinite(item.srcInFrame ?? 0) || (item.srcInFrame ?? 0) < 0) { issue('item_source_timing_invalid', item.id); continue; }
        if (item.deletedWordIdx?.length || item.transcriptPlayOrder?.length || item.silenceFrames !== undefined || item.gapCapsMs) { issue('nonlinear_source_not_inspected', item.id); continue; }
        const start = Math.max(window[0], item.startFrame), end = Math.min(window[1], item.startFrame + item.durationInFrames);
        const source = sourceWindowForTimelineRange(item, start - item.startFrame, end - start);
        // The editor's media source offsets use its frame clock; do not divide by the output-export FPS.
        const r: [number, number] = [source.startFrame / tl.fps, source.endFrame / tl.fps];
        actual.push(r);
        const matches = planned.filter((id) => { const s = segments.get(id)?.source_range_seconds; return s && s[0] < r[1] && s[1] > r[0]; });
        bindings.push({ unit_id: u.unit_id, phase, item_id: item.id, source_range_seconds: r, segment_ids: matches });
        if (!expected.some((plannedRange) => plannedRange[0] < r[1] && plannedRange[1] > r[0])) issue('timeline_source_unplanned', item.id);
      }
      const tolerance = 1 / tl.fps + 1e-6;
      if (!expected.length || expected.some((r) => !rangesCover(actual, r, tolerance)) || actual.some((r) => !rangesCover(expected, r, tolerance))) issue('timeline_source_range_mismatch', `${u.unit_id}:${phase}`);
    }
  }
  return result();
}
