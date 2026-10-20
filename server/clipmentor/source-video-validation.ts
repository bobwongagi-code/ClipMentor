import type { SourceVideoObservation, SourceVideoValidation, SourceVideoValidationIssue } from '../../shared/clipmentor-source-video';

export const SOURCE_VIDEO_TIME_TOLERANCE_SECONDS = 0.01;
export const SOURCE_VIDEO_VALIDATION_VERSION = 'source-observation-validation-v2';
interface ObservationInput {
  duration_seconds: number;
  units: Array<{ unit_id: string; windows: Array<{ window_id: string; source_range_seconds: number[] }>; lines: Array<{ line_id: string }> }>;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Observation timestamps are estimates, not source cut points. Never round or clamp the returned evidence. */
export function inspectSourceObservation(value: unknown, input: ObservationInput): SourceVideoValidation {
  const issues: SourceVideoValidationIssue[] = [];
  const error = (code: string, window_id?: string) => issues.push({ code, severity: 'error', ...(window_id ? { window_id } : {}) });
  const finish = (): SourceVideoValidation => ({ version: SOURCE_VIDEO_VALIDATION_VERSION,
    status: issues.some(i => i.severity === 'error') ? 'invalid' : 'valid',
    time_tolerance_seconds: SOURCE_VIDEO_TIME_TOLERANCE_SECONDS, issues });
  if (!object(value) || !Array.isArray(value.windows) || !Array.isArray(value.lines)
    || !Array.isArray(value.limitations) || !value.limitations.every(text)) { error('invalid_observation_schema'); return finish(); }
  const expectedWindows = input.units.flatMap(u => u.windows);
  const expectedLines = input.units.flatMap(u => u.lines.map(l => ({ unit_id: u.unit_id, line_id: l.line_id })));
  if (value.windows.length !== expectedWindows.length || !value.windows.every(object)
    || new Set(value.windows.map(w => object(w) ? w.window_id : null)).size !== expectedWindows.length) error('incomplete_or_duplicate_windows');
  if (value.lines.length !== expectedLines.length || !value.lines.every(object)
    || new Set(value.lines.map(l => object(l) ? `${l.unit_id}:${l.line_id}` : null)).size !== expectedLines.length) error('incomplete_or_duplicate_lines');
  for (const w of value.windows) {
    if (!object(w)) { error('invalid_window'); continue; }
    const id = typeof w.window_id === 'string' ? w.window_id : undefined;
    const expected = expectedWindows.find(e => e.window_id === id);
    if (!expected || !text(w.observed_sequence) || !text(w.endpoint) || !Array.isArray(w.evidence) || !w.evidence.length) { error('invalid_window', id); continue; }
    const [start, end] = expected.source_range_seconds;
    for (const [index, e] of w.evidence.entries()) {
      if (!object(e) || !finite(e.start_seconds) || !finite(e.end_seconds) || e.start_seconds < 0
        || e.end_seconds <= e.start_seconds || e.start_seconds >= end || e.end_seconds <= start || !text(e.visible) || !text(e.audible)) {
        error('invalid_window_evidence', id); continue;
      }
      for (const [field, boundary, observed, delta] of [
        ['start_seconds', start, e.start_seconds, Math.max(0, start - e.start_seconds)],
        ['end_seconds', end, e.end_seconds, Math.max(0, e.end_seconds - end)],
      ] as const) {
        if (!delta) continue;
        // Account only for binary float representation at the tolerance boundary, not a second tolerance.
        const epsilon = Number.EPSILON * Math.max(1, Math.abs(boundary), Math.abs(observed)) * 4;
        const tolerated = delta <= SOURCE_VIDEO_TIME_TOLERANCE_SECONDS + epsilon;
        issues.push({ code: tolerated ? 'timestamp_rounding_within_tolerance' : 'evidence_outside_window', severity: tolerated ? 'notice' : 'error',
          window_id: id, evidence_index: index, field, observed_seconds: observed, boundary_seconds: boundary,
          window_seconds: [start, end], delta_ms: delta * 1000 });
      }
    }
  }
  for (const l of value.lines) {
    if (!object(l) || !expectedLines.some(e => e.unit_id === l.unit_id && e.line_id === l.line_id)
      || !['supported', 'not_supported', 'insufficient_evidence'].includes(String(l.status)) || !text(l.reason)
      || !Array.isArray(l.window_ids) || !l.window_ids.length || new Set(l.window_ids).size !== l.window_ids.length
      || !l.window_ids.every(id => input.units.find(u => u.unit_id === l.unit_id)?.windows.some(w => w.window_id === id))) error('invalid_line_finding');
  }
  return finish();
}
export class SourceObservationValidationError extends Error {
  readonly validation: SourceVideoValidation;
  constructor(validation: SourceVideoValidation) { super('Source observation validation failed'); this.validation = validation; }
}
export function validateSourceObservation(value: unknown, input: ObservationInput): SourceVideoObservation {
  const assessment = inspectSourceObservation(value, input);
  if (assessment.status !== 'valid') throw new SourceObservationValidationError(assessment);
  return value as SourceVideoObservation;
}
