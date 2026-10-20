import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ProjectDoc, TimelineItem } from '../editor/types';
import type { AgentContext } from '../agent/context';
import type { SourceBreakdown } from './source-breakdown';
import { isSourceBreakdown, checkSourceBreakdown, breakdownRevisionError } from './source-breakdown';
import { isClipMentorAnalysis } from './analysis';
import { makeDraft } from '../editor/store';
import { executeTool } from '../agent/tools';
import { compactToolResultForModel } from '../agent/tool-result-compaction';
import { executeOfflineTool } from '../../server/external-agent/offline-executor';
import { bindCopyProductionReview, checkCopyProduction, copyReviewSubject, copyTeachingPacketFromDoc, buildCopyTeachingReviewRequest, clipMentorProductionBlock, type TeachingEnvelope } from './production-gate';
import teachingRegression from './fixtures/copy-teaching-blind-v2-20261019.json';
import regression from './fixtures/source-breakdown-v1r1.json';

let networkCalls = 0;
globalThis.fetch = (async () => { networkCalls++; throw new Error('Unexpected network'); }) as typeof fetch;
const actor = { operator: 'test-only', executor: 'test-author', instruction: 'Disposable structural regression, no production approval', identity: 'local_declared_not_authenticated' as const };
const base: ProjectDoc = {
  version: 3, assets: [{ id: 'source', kind: 'video', name: 'source', src: '/media/test.mp4', durationInFrames: 3000, sourceContentHash: 'a'.repeat(64) }], mediaFolders: [], activeTimelineId: 'tl',
  timelines: [{ id: 'tl', name: 'test', order: 0, fps: 30, width: 576, height: 1024, items: [], selectedId: null, tracks: { V1: { kind: 'video' } }, trackOrder: ['V1'] }],
  clipMentorAnalysis: {
    schema_version: 1, analysis_id: 'test-only', revision: 1, source: { asset_id: 'source', sourceContentHash: 'a'.repeat(64), duration_seconds: 100, fps: 30 },
    product: { name: 'Teashell', category: 'soap' }, import_origin: 'synthetic_verification', points: [], transcripts: [], reviews: [], audit: [],
    evidence: [{ evidence_id: 'F1', kind: 'source_frame', text: 'Synthetic source position', status: 'historical_unknown', supporting_evidence_ids: [], source_ids: [],
      time_seconds: 60, source_frame: 1800, observation_method: 'test_fixture', call_status: 'historical_unknown' }],
    blueprint: [{ unit_id: 'U1', point_ids: ['P1'], intent_zh: 'test', line_guidance: '' }],
  },
};
const b: SourceBreakdown = {
  version: 1, segments: [{ segment_id: 'S1', source_range_seconds: [59.4, 62.2], visible_evidence_ids: ['F1'], claim_evidence_ids: [], interpretation_evidence_ids: [], unknowns: ['Scent quality unverified'] }],
  points: [{ point_id: 'P1', segment_ids: ['S1'], buying_concern: 'Use experience', teaching_question: '这个使用中的动作让观众联想到哪种使用体验？', role: 'primary', importance: 'must_explain', filming_conditions: ['Near-nose gesture during use'] }],
  units: [{ unit_id: 'U1', original_segment_ids: ['S1'], explanation_segment_ids: ['S1'], coverage: [{ point_id: 'P1', treatment: 'explain' }],
    revisits: [{ from_segment_id: 'S1', to_segment_id: 'S1', reason: 'Revisit the demonstrated gesture to explain its use experience' }],
    placement: { timeline_id: 'tl', original_frames: [0, 84], explanation_frames: [90, 174] } }],
};
const oracle = teachingRegression.regression_oracles.find((o) => o.label === 'qualified_scent_excerpt_from_revision95')!;
const positive = teachingRegression.blind_input.cases.find((c) => c.case_id === oracle.case_id)!;
const raw = teachingRegression.raw_review.cases.find((c) => c.case_id === oracle.case_id)!;
const goodLine = positive.packet.units[0].lines[0];
Object.assign(base.clipMentorAnalysis!.blueprint[0], { internal_review: { current_script_candidate: 'copy', copy: { lines: [{
  id: goodLine.line_id, point_ids: ['P1'], narration_ms: goodLine.narration_ms, caption_lines: goodLine.caption_lines, zh: goodLine.meaning_zh,
  source_seconds: [59.4, 62.2], labels: goodLine.labels,
}] } } });
assert.equal(checkSourceBreakdown(base).issues[0].code, 'source_breakdown_missing');
base.clipMentorAnalysis!.source_breakdown = structuredClone(b);
const clip = (id: string, startFrame: number, srcInFrame: number, durationInFrames: number): TimelineItem => ({ id, kind: 'video', track: 'V1', name: 'source', startFrame, durationInFrames, srcInFrame, sourceAssetId: 'source', src: '/media/test.mp4' });
base.timelines[0].items = [clip('original', 0, 1782, 84), clip('explanation', 90, 1782, 84)];
assert(isClipMentorAnalysis(base.clipMentorAnalysis));
assert.equal(checkSourceBreakdown(base).status, 'structurally_ready');
assert.equal(checkSourceBreakdown(base, true).status, 'structurally_ready');
const ignoredEntry = structuredClone(base);
Object.assign(ignoredEntry.clipMentorAnalysis!.source_breakdown!.units[0], { original_playback_entry: { source_range_seconds: [59.4, 63], note: 'Must not override the typed plan' } });
assert(checkSourceBreakdown(ignoredEntry).issues.some((i) => i.code === 'unrecognized_unit_field'), 'an invented playback authority must not silently produce structurally_ready');
assert.deepEqual(checkSourceBreakdown(base, true).bindings.map((v) => v.source_range_seconds), [[59.4, 62.2], [59.4, 62.2]]);
assert(!checkSourceBreakdown(base).complete_film_accepted);
// A teaching evidence index is not the complete original playback window.
const contextTail = structuredClone(base);
contextTail.clipMentorAnalysis!.source_breakdown!.units[0].original_source_ranges = [[59.4, 63]];
contextTail.clipMentorAnalysis!.source_breakdown!.units[0].placement = { timeline_id: 'tl', original_frames: [0, 108], explanation_frames: [120, 204] };
contextTail.timelines[0].items = [clip('context-original', 0, 1782, 108), clip('context-explanation', 120, 1782, 84)];
assert.equal(checkSourceBreakdown(contextTail, true).status, 'structurally_ready', 'unindexed spoken context belongs to the explicitly selected original window');
assert.deepEqual((await copyTeachingPacketFromDoc(contextTail)).units[0].picture_plan?.original_source_ranges, [[59.4, 63]]);
const missingTail = structuredClone(contextTail);
missingTail.timelines[0].items[0].durationInFrames = 84;
assert(checkSourceBreakdown(missingTail, true).issues.some((i) => i.code === 'timeline_source_range_mismatch'));
for (const [ranges, code] of [
  [[[60, 63]], 'original_segment_outside_playback'],
  [[[59.4, 101]], 'original_playback_out_of_bounds'],
] as const) {
  const invalidPlayback = structuredClone(base);
  invalidPlayback.clipMentorAnalysis!.source_breakdown!.units[0].original_source_ranges = ranges.map((r) => [...r]);
  assert(checkSourceBreakdown(invalidPlayback).issues.some((i) => i.code === code));
}
assert(isClipMentorAnalysis(ignoredEntry.clipMentorAnalysis), 'unknown historical metadata stays readable but is not ready');

for (const invalid of [null, {}, { ...b, segments: [] }, { ...b, points: [b.points[0], b.points[0]] }, { ...b, units: [{ ...b.units[0], coverage: [{ point_id: 'P1', treatment: 'guess' }] }] }]) assert(!isSourceBreakdown(invalid));
const changed = structuredClone(b);
changed.points = [];
assert(breakdownRevisionError(b, changed));
changed.points = [{ ...b.points[0], role: 'auxiliary', change_reason: 'Author tries to waive' }];
assert(breakdownRevisionError(b, changed), 'an author cannot turn a required teaching point into a transition');
changed.points = [{ ...b.points[0], buying_concern: 'Corrected context' }];
assert(breakdownRevisionError(b, changed));
changed.points[0].change_reason = 'Explicit correction';
assert.equal(breakdownRevisionError(b, changed), null);

const codes = (doc: ProjectDoc, timeline = false) => checkSourceBreakdown(doc, timeline).issues.map((v) => v.code);
const mutate = (fn: (doc: ProjectDoc) => void) => { const d = structuredClone(base); fn(d); return d; };
assert(codes(mutate((d) => { d.clipMentorAnalysis!.source_breakdown!.units[0].coverage = []; })).includes('selected_point_unaccounted'));
assert(codes(mutate((d) => { d.clipMentorAnalysis!.source_breakdown!.units[0].coverage[0].treatment = 'visual_only'; })).includes('point_treatment_reason_missing'));
const visualOnly = mutate((d) => Object.assign(d.clipMentorAnalysis!.source_breakdown!.units[0].coverage[0], { treatment: 'visual_only', reason: 'Explicit proposal, still needs semantic evidence' }));
assert.equal(checkSourceBreakdown(visualOnly).status, 'structurally_ready', 'a reason is accounted for, not semantic approval');
assert(checkSourceBreakdown(visualOnly).semantic_review_required);
assert(codes(mutate((d) => { d.clipMentorAnalysis!.source_breakdown!.segments[0].claim_evidence_ids = ['F1']; })).includes('segment_evidence_kind_or_reference'));
assert(codes(mutate((d) => { d.clipMentorAnalysis!.source_breakdown!.segments[0].source_range_seconds = [70, 80]; })).includes('segment_evidence_outside_range'));
assert(codes(mutate((d) => { d.assets[0].sourceContentHash = 'b'.repeat(64); })).includes('source_hash_missing_or_changed'));
assert(codes(mutate((d) => { d.timelines[0].items[0].srcInFrame = 1800; }), true).includes('timeline_source_range_mismatch'));
assert(codes(mutate((d) => { d.timelines[0].tracks!.V1!.hidden = true; }), true).includes('timeline_source_range_mismatch'));
assert(codes(mutate((d) => { delete d.clipMentorAnalysis!.source_breakdown!.units[0].placement; }), true).includes('unit_placement_missing'));
assert(codes(mutate((d) => { d.timelines[0].fps = 25; }), true).includes('source_frame_clock_unverified'));
const retimed = mutate((d) => { d.timelines[0].items[0].playbackRate = 2; d.timelines[0].items[0].durationInFrames = 42; d.clipMentorAnalysis!.source_breakdown!.units[0].placement!.original_frames = [0, 42]; });
assert.equal(checkSourceBreakdown(retimed, true).status, 'structurally_ready', 'source range math honors rate; this is not approval of slow/fast playback');

// Frozen REAL v1r1 item coordinates; ledger reconstructed from the documented failure.
const old = structuredClone(base);
old.activeTimelineId = regression.provenance.timeline_id;
old.timelines[0].id = old.activeTimelineId;
old.timelines[0].items = regression.items.map((i) => ({ ...i, kind: 'video', sourceAssetId: 'source', src: '/media/test.mp4', name: 'historical source' }));
const ledger = old.clipMentorAnalysis!.source_breakdown!;
ledger.segments.push({ ...structuredClone(ledger.segments[0]), segment_id: 'late', source_range_seconds: [75.76666666666667, 86.9], visible_evidence_ids: ['F2'] },
  { ...structuredClone(ledger.segments[0]), segment_id: 'foam', source_range_seconds: [69.8, 73.3], visible_evidence_ids: ['F3'] });
old.clipMentorAnalysis!.evidence.push({ ...structuredClone(old.clipMentorAnalysis!.evidence[0]), evidence_id: 'F2', time_seconds: 80, source_frame: 2400 },
  { ...structuredClone(old.clipMentorAnalysis!.evidence[0]), evidence_id: 'F3', time_seconds: 70, source_frame: 2100 });
ledger.units[0] = { ...ledger.units[0], original_segment_ids: ['late'], explanation_segment_ids: ['foam'],
  coverage: [{ point_id: 'P1', treatment: 'visual_only' }],
  placement: { timeline_id: old.activeTimelineId, original_frames: regression.windows.U03_original as [number, number], explanation_frames: regression.windows.U03_explanation as [number, number] } };
// Planned original began with foam, but actual original starts at 75.77. The reasonless return is separately checked.
ledger.units[0].original_segment_ids = ['foam', 'late'];
const oldCodes = codes(old, true);
for (const expected of regression.expected_failures) assert(oldCodes.includes(expected), `real historical replay must report ${expected}`);
assert.equal(checkSourceBreakdown(old, true).bindings.find((v) => v.phase === 'original')!.source_range_seconds[0], 2273 / 30);

const subject = await copyReviewSubject(base);
const packet = await copyTeachingPacketFromDoc(base);
const request = buildCopyTeachingReviewRequest([{ case_id: 'anonymous', packet }]);
assert(!JSON.stringify(request).includes('change_reason'));
assert.deepEqual(request.input.cases[0].packet.units[0].points[0].filming_conditions, ['Near-nose gesture during use']);
assert.equal(request.input.cases[0].packet.units[0].points[0].buying_concern, 'Use experience');
assert.deepEqual(request.input.cases[0].packet.units[0].picture_plan?.original_source_ranges, [[59.4, 62.2]]);
assert.deepEqual(request.input.cases[0].packet.units[0].picture_plan?.line_source_ranges[0].source_range_seconds, [59.4, 62.2]);
assert(!JSON.stringify(request).includes('Revisit the demonstrated gesture'), 'author revisit justification is withheld, but the relationship is supplied');
const review = { units: [{ unit_id: 'U1', points: [{ ...structuredClone(raw.units[0].points[0]), point_id: 'P1' }] }] } as TeachingEnvelope['review'];
const receipt = await bindCopyProductionReview(base, { analysis_revision: subject.revision, content_digest: subject.digest,
  author_run_id: 'test-author', reviewer_run_id: 'test-independent', reviewed_at: 1, verdict: 'pass',
  units: [{ unit_id: 'U1', candidate_id: 'copy', verdict: 'pass', findings: [] }], teaching_review: { packet, review } });
base.clipMentorAnalysis!.production_copy_review = receipt;
assert.equal((await checkCopyProduction(base, null)).code, 'copy_and_plan_ready');
const legacy = structuredClone(base); delete legacy.clipMentorAnalysis!.source_breakdown;
const legacySubject = await copyReviewSubject(legacy);
legacy.clipMentorAnalysis!.production_copy_review = await bindCopyProductionReview(legacy, { ...receipt, analysis_revision: legacySubject.revision, content_digest: legacySubject.digest });
assert.equal((await checkCopyProduction(legacy, null)).code, 'source_breakdown_not_ready', 'a historical receipt with no ledger is not a production exemption');
const falseScope = structuredClone(base);
falseScope.clipMentorAnalysis!.production_copy_review!.teaching_review!.packet.units[0].points[0].role = 'auxiliary';
assert.equal((await checkCopyProduction(falseScope, null)).code, 'copy_review_invalid', 'a packet without any primary cannot waive the task');
falseScope.clipMentorAnalysis!.production_copy_review!.teaching_review!.packet.units[0].points[0].role = 'primary';
falseScope.clipMentorAnalysis!.production_copy_review!.teaching_review!.packet.units[0].points[0].question = 'Only check that the action exists';
assert.equal((await checkCopyProduction(falseScope, null)).code, 'copy_teaching_ledger_mismatch', 'a narrower reviewer task cannot replace the registered teaching question');

function context(doc: ProjectDoc) {
  const draft = makeDraft(structuredClone(doc));
  const ctx: AgentContext = { ...draft, getCreativeMode: () => 'clipmentor', templates: [], audio: [] };
  return { draft, ctx };
}
for (const executor of [executeTool]) {
  const receiptContext = context(base);
  const receiptBefore = structuredClone(receiptContext.draft.getDoc());
  const readReceipt = async (args: Record<string, unknown>, doc = base) => executor('read_clipmentor_analysis', { view: 'copy_review', ...args }, context(doc).ctx) as Promise<any>;
  const result = await executor('read_clipmentor_analysis', { view: 'copy_review' }, receiptContext.ctx) as any;
  assert.equal(result.analysis.copy_review.binding, 'current');
  const { teaching_review, ...receiptMetadata } = receipt;
  assert.deepEqual(result.analysis.copy_review.receipt, receiptMetadata);
  assert.deepEqual(result.analysis.copy_review.teaching_review, teaching_review!.review);
  assert.equal(result.analysis.copy_review.packet_included, false);
  assert.equal(result.analysis.copy_review.operation_id, null, 'legacy IDs must not acquire a fabricated operation ID');
  assert.deepEqual(compactToolResultForModel(result), result);
  assert.deepEqual(receiptContext.draft.getDoc(), receiptBefore);
  assert.equal(receiptContext.draft.takeActions().length, 0, 'reading must not save or refresh a receipt');
  const packetRead = await readReceipt({ reviewPart: 'packet', unitId: 'U1' });
  assert.deepEqual(packetRead.analysis.copy_review.packet, packet);
  assert.equal(packetRead.analysis.copy_review.packet_included, true);
  assert.deepEqual(compactToolResultForModel(packetRead), packetRead);
  const absent = structuredClone(base); delete absent.clipMentorAnalysis!.production_copy_review;
  assert.equal((await readReceipt({}, absent)).analysis.copy_review.binding, 'missing');
  assert.equal((await readReceipt({}, absent)).analysis.copy_review.receipt, null);
  const staleReceipt = structuredClone(base); staleReceipt.clipMentorAnalysis!.revision++;
  const staleRead = await readReceipt({}, staleReceipt);
  assert.equal(staleRead.analysis.copy_review.binding, 'stale');
  assert.deepEqual(staleRead.analysis.copy_review.receipt, receiptMetadata, 'old verdict stays readable without being re-approved');
  const changedCopy = structuredClone(base); changedCopy.clipMentorAnalysis!.product.name = 'Changed product';
  assert.equal((await readReceipt({}, changedCopy)).analysis.copy_review.binding, 'stale', 'same revision with changed content is still stale');
  const failedReceipt = structuredClone(base);
  Object.assign(failedReceipt.clipMentorAnalysis!.production_copy_review!, { reviewer_run_id: 'clipmentor-review:97d9812e-8465-46fe-bb84-470a2e3b6963', verdict: 'needs_revision' });
  failedReceipt.clipMentorAnalysis!.production_copy_review!.units[0].verdict = 'needs_revision';
  failedReceipt.clipMentorAnalysis!.production_copy_review!.units[0].findings = [{ severity: 'blocking', quote: goodLine.narration_ms, reason: 'Test: actual planned capacity is incomplete' }];
  const failedRead = await readReceipt({}, failedReceipt);
  assert.equal(failedRead.analysis.copy_review.operation_id, '97d9812e-8465-46fe-bb84-470a2e3b6963');
  assert.deepEqual(failedRead.analysis.copy_review.receipt.units, failedReceipt.clipMentorAnalysis!.production_copy_review!.units);
  assert.equal(failedRead.production_gate.allowed, false);
  for (const args of [{ reviewPart: 'invented' }, { reviewPart: 'packet' }, { unitId: 'missing' }]) assert((await readReceipt(args)).error);
  assert((await executor('read_clipmentor_analysis', { view: 'current_copy', reviewPart: 'packet' }, context(base).ctx) as any).error);
  const noLedger = structuredClone(base); delete noLedger.clipMentorAnalysis!.source_breakdown;
  const unprepared = context(noLedger);
  const unit = structuredClone(unprepared.draft.getDoc().clipMentorAnalysis!.blueprint[0]);
  (unit as unknown as { internal_review: { current_script_candidate: string } }).internal_review.current_script_candidate = 'unprepared-new-copy';
  const deniedWriting = await executor('revise_clipmentor_analysis', { action: 'revise', collection: 'blueprint', id: unit.unit_id,
    record: unit, expectedRevision: 1, actor, reason: 'Cannot write copy before source breakdown' }, unprepared.ctx) as { error?: string };
  assert(deniedWriting.error?.includes('source_breakdown'));
  assert.equal(unprepared.draft.takeActions().length, 0);
  const narrowRead = await executor('read_clipmentor_analysis', { view: 'source_breakdown' }, context(base).ctx) as { revision: number; analysis: { source_breakdown: SourceBreakdown; transcripts?: unknown } };
  assert.equal(narrowRead.revision, 1);
  assert.deepEqual(narrowRead.analysis.source_breakdown, b);
  assert.equal(narrowRead.analysis.transcripts, undefined);
  const narrowCopy = await executor('read_clipmentor_analysis', { view: 'current_copy', unitId: 'U1' }, context(base).ctx) as { analysis: { current_copy: Array<{ candidate_id: string; candidate: unknown }> } };
  assert.equal(narrowCopy.analysis.current_copy.length, 1);
  assert.equal(narrowCopy.analysis.current_copy[0].candidate_id, 'copy');
  assert.deepEqual(narrowCopy.analysis.current_copy[0].candidate, (base.clipMentorAnalysis!.blueprint[0] as unknown as { internal_review: { copy: unknown } }).internal_review.copy);
  assert((await executor('read_clipmentor_analysis', { view: 'current_copy', unitId: 'missing' }, context(base).ctx) as { error?: string }).error);
  assert((await executor('read_clipmentor_analysis', { view: 'invented' }, context(base).ctx) as { error?: string }).error);
  const pictureDraft = context(base);
  const pictureBefore = structuredClone(pictureDraft.draft.getDoc());
  const planRecord = { plan_id: 'picture_plan_test_1', script_candidate_id: 'copy', line_guidance: 'Current copy retained; current picture plan is internal_review.picture_plan_test_1',
    plan: { units: ['U1'], status: 'pass', production_allowed: true, note: 'Synthetic planning data, no actual timeline' } };
  const pictureSaved = await executor('revise_clipmentor_analysis', { action: 'set_picture_plan', id: 'U1', record: planRecord,
    expectedRevision: 1, actor, reason: 'Save a local picture plan without replacing historical copy' }, pictureDraft.ctx) as { ok?: boolean };
  assert(pictureSaved.ok, 'a unit-local picture plan must save without retransmitting the historical blueprint');
  const afterPlan = pictureDraft.draft.getDoc();
  const reviewAfter = (afterPlan.clipMentorAnalysis!.blueprint[0] as unknown as { internal_review: Record<string, unknown> }).internal_review;
  const reviewBefore = (pictureBefore.clipMentorAnalysis!.blueprint[0] as unknown as { internal_review: Record<string, unknown> }).internal_review;
  for (const [key, value] of Object.entries(reviewBefore)) assert.deepEqual(reviewAfter[key], value, 'previous manuscript/history preserved');
  assert.deepEqual(afterPlan.timelines, pictureBefore.timelines);
  assert.deepEqual(afterPlan.assets, pictureBefore.assets);
  assert.deepEqual(afterPlan.clipMentorAnalysis!.source_breakdown, b);
  assert.equal(reviewAfter.current_picture_plan, planRecord.plan_id);
  const storedPlan = reviewAfter[planRecord.plan_id] as Record<string, unknown>;
  assert.equal(storedPlan.production_allowed, false);
  assert.equal(storedPlan.review_status, 'pending');
  assert.equal(storedPlan.status, 'candidate');
  assert.equal(storedPlan.script_candidate_id, 'copy');
  assert.deepEqual(storedPlan.source_binding, base.clipMentorAnalysis!.source);
  assert.equal((await checkCopyProduction(afterPlan, null)).code, 'copy_review_stale');
  const pictureRead = await executor('read_clipmentor_analysis', { view: 'current_copy', unitId: 'U1' }, pictureDraft.ctx) as { analysis: { current_copy: Array<{ picture_plan_id: string; picture_plan: unknown }> } };
  assert.equal(pictureRead.analysis.current_copy[0].picture_plan_id, planRecord.plan_id);
  assert.deepEqual(pictureRead.analysis.current_copy[0].picture_plan, storedPlan);
  const selectionContext = context(afterPlan);
  const selectedLine = (reviewAfter.copy as any).lines[0];
  const selection = { source_candidate_id: 'copy', candidate_id: 'script_candidate_selected_test', line_ids: [selectedLine.id],
    plan_id: 'picture_plan_selected_test', plan: { selected_narration: [selectedLine], status: 'pass', production_allowed: true },
    line_guidance: 'Use selected current candidate and bound pending picture plan' };
  const selected = await executor('revise_clipmentor_analysis', { action: 'select_copy_lines', id: 'U1', record: selection,
    expectedRevision: 2, actor, reason: 'Activate existing words only, no new copy or production permission' }, selectionContext.ctx) as any;
  assert(selected.ok, 'selecting existing lines must not require retransmitting the historical blueprint');
  const selectedDoc = selectionContext.draft.getDoc();
  const selectedInternal = (selectedDoc.clipMentorAnalysis!.blueprint[0] as any).internal_review;
  for (const [key, value] of Object.entries(reviewAfter)) if (!['current_script_candidate', 'current_picture_plan'].includes(key)) assert.deepEqual(selectedInternal[key], value);
  assert.equal(selectedInternal.current_script_candidate, selection.candidate_id);
  assert.equal(selectedInternal.current_picture_plan, selection.plan_id);
  assert.deepEqual(selectedInternal[selection.candidate_id].lines, [selectedLine]);
  assert.equal(selectedInternal[selection.plan_id].script_candidate_id, selection.candidate_id);
  assert.equal(selectedInternal[selection.plan_id].production_allowed, false);
  assert.equal(selectedInternal[selection.plan_id].review_status, 'pending');
  assert.equal((await checkCopyProduction(selectedDoc, null)).code, 'copy_review_stale');
  assert.deepEqual(selectedDoc.assets, afterPlan.assets); assert.deepEqual(selectedDoc.timelines, afterPlan.timelines);
  for (const bad of [
    { ...selection, source_candidate_id: 'stale' }, { ...selection, candidate_id: 'copy' },
    { ...selection, plan_id: planRecord.plan_id }, { ...selection, line_ids: [] },
    { ...selection, line_ids: ['missing'] }, { ...selection, line_ids: [selectedLine.id, selectedLine.id] },
    { ...selection, plan: { selected_narration: [{ ...selectedLine, narration_ms: 'Altered words' }] } },
    { ...selection, narration_ms: 'New words are not accepted' },
  ]) {
    const rejectedContext = context(afterPlan);
    assert((await executor('revise_clipmentor_analysis', { action: 'select_copy_lines', id: 'U1', record: bad,
      expectedRevision: 2, actor, reason: 'Reject unsafe selection' }, rejectedContext.ctx) as any).error);
    assert.equal(rejectedContext.draft.takeActions().length, 0);
  }
  const selectionTwoPoints = structuredClone(afterPlan);
  const secondPoint = { ...structuredClone(selectionTwoPoints.clipMentorAnalysis!.source_breakdown!.points[0]), point_id: 'P2' };
  selectionTwoPoints.clipMentorAnalysis!.source_breakdown!.points.push(secondPoint);
  selectionTwoPoints.clipMentorAnalysis!.source_breakdown!.units[0].coverage.push({ point_id: 'P2', treatment: 'explain' });
  selectionTwoPoints.clipMentorAnalysis!.blueprint[0].point_ids.push('P2');
  (selectionTwoPoints.clipMentorAnalysis!.blueprint[0] as any).internal_review.copy.lines.push({ ...structuredClone(selectedLine), id: 'other-existing-line', point_ids: ['P2'] });
  const lossContext = context(selectionTwoPoints);
  const lost = await executor('revise_clipmentor_analysis', { action: 'select_copy_lines', id: 'U1', record: selection,
    expectedRevision: 2, actor, reason: 'Do not silently drop another explained point while deduplicating' }, lossContext.ctx) as any;
  assert(lost.error?.includes('teaching point'), JSON.stringify(lost));
  assert.equal(lossContext.draft.takeActions().length, 0);
  for (const [record, revision] of [[planRecord, 2], [{ ...planRecord, plan_id: 'picture_plan_new', script_candidate_id: 'stale' }, 2],
    [{ ...planRecord, plan_id: 'current_script_candidate' }, 2], [planRecord, 1]] as const) {
    const rejected = await executor('revise_clipmentor_analysis', { action: 'set_picture_plan', id: 'U1', record,
      expectedRevision: revision, actor, reason: 'Reject overwrite, stale candidate or stale revision' }, pictureDraft.ctx) as { error?: string };
    assert(rejected.error);
    assert.equal(pictureDraft.draft.getDoc().clipMentorAnalysis!.revision, 2);
  }
  const evidenceDoc = structuredClone(base);
  evidenceDoc.clipMentorAnalysis!.evidence[0].supporting_evidence_ids = ['F2'];
  evidenceDoc.clipMentorAnalysis!.evidence.push({ ...structuredClone(evidenceDoc.clipMentorAnalysis!.evidence[0]), evidence_id: 'F2', supporting_evidence_ids: [], time_seconds: 61 });
  const evidenceRead = await executor('read_clipmentor_analysis', { view: 'evidence', evidenceIds: ['F1'] }, context(evidenceDoc).ctx) as { analysis: { evidence: Array<{ evidence_id: string }>; linked_evidence: Array<{ evidence_id: string }>; transcripts?: unknown } };
  assert.deepEqual(evidenceRead.analysis.evidence.map((v) => v.evidence_id), ['F1']);
  assert.deepEqual(evidenceRead.analysis.linked_evidence.map((v) => v.evidence_id), ['F2']);
  assert.equal(evidenceRead.analysis.transcripts, undefined);
  for (const evidenceIds of [[], ['missing'], Array.from({ length: 9 }, (_, i) => 'F' + i)]) {
    assert((await executor('read_clipmentor_analysis', { view: 'evidence', evidenceIds }, context(base).ctx) as { error?: string }).error);
  }
  const unknownDraft = context(base);
  const unknownWrite = await executor('revise_clipmentor_analysis', { action: 'set_source_breakdown', expectedRevision: 1,
    record: ignoredEntry.clipMentorAnalysis!.source_breakdown, actor, reason: 'Unknown playback field must be rejected' }, unknownDraft.ctx) as { error?: string };
  assert(unknownWrite.error);
  assert.equal(unknownDraft.draft.takeActions().length, 0);
  const explicitDraft = context(base);
  const explicitPlan = structuredClone(b); explicitPlan.units[0].original_source_ranges = [[59.4, 63]];
  assert((await executor('revise_clipmentor_analysis', { action: 'set_source_breakdown', expectedRevision: 1,
    record: explicitPlan, actor, reason: 'Keep complete spoken context separate from evidence indexes' }, explicitDraft.ctx) as { ok?: boolean }).ok);
  assert.equal((await checkCopyProduction(explicitDraft.draft.getDoc(), null)).code, 'copy_review_stale', 'playback-only changes invalidate the old approval');
  const { draft, ctx } = context(base);
  const before = JSON.stringify(draft.getDoc().timelines);
  const omitted = structuredClone(b);
  omitted.units[0].coverage = [];
  const save = await executor('revise_clipmentor_analysis', { action: 'set_source_breakdown', expectedRevision: 1, record: omitted, actor, reason: 'Test incomplete candidate' }, ctx) as { ok?: boolean; breakdown_check?: { issues: Array<{ code: string }> } };
  assert(save.ok, JSON.stringify(save));
  assert(save.breakdown_check!.issues.some((i) => i.code === 'selected_point_unaccounted'));
  assert.equal((await checkCopyProduction(draft.getDoc(), null)).code, 'copy_review_stale');
  const restore = await executor('revise_clipmentor_analysis', { action: 'set_source_breakdown', expectedRevision: 2, record: b, actor, reason: 'Test restoring does not revive approval' }, ctx) as { ok?: boolean };
  assert(restore.ok);
  assert.equal((await checkCopyProduction(draft.getDoc(), null)).code, 'copy_review_stale');
  const drop = structuredClone(b); drop.points = [];
  const denied = await executor('revise_clipmentor_analysis', { action: 'set_source_breakdown', expectedRevision: 3, record: drop, actor, reason: 'Cannot erase baseline' }, ctx) as { error?: string };
  assert(denied.error);
  assert.equal(draft.getDoc().clipMentorAnalysis!.revision, 3);
  const windowChange = structuredClone(b);
  windowChange.segments[0].source_range_seconds = [59.3, 62.2];
  const windowSave = await executor('revise_clipmentor_analysis', { action: 'set_source_breakdown', expectedRevision: 3, record: windowChange, actor, reason: 'Test source range changes without changing any words' }, ctx) as { ok?: boolean };
  assert(windowSave.ok);
  assert.equal((await checkCopyProduction(draft.getDoc(), null)).code, 'copy_review_stale');
  const twoPoints = structuredClone(windowChange);
  twoPoints.points.push({ ...twoPoints.points[0], point_id: 'P2', importance: 'optional' });
  twoPoints.units[0].coverage.push({ point_id: 'P2', treatment: 'omit', reason: 'Explicit optional candidate, not a production waiver' });
  assert((await executor('revise_clipmentor_analysis', { action: 'set_source_breakdown', expectedRevision: 4, record: twoPoints, actor, reason: 'Test adding a selected task' }, ctx) as { ok?: boolean }).ok);
  const eraseFirst = structuredClone(twoPoints); eraseFirst.points.shift(); eraseFirst.units[0].coverage.shift();
  assert((await executor('revise_clipmentor_analysis', { action: 'set_source_breakdown', expectedRevision: 5, record: eraseFirst, actor, reason: 'Try to hide an earlier required task' }, ctx) as { error?: string }).error);
  assert.equal(draft.getDoc().clipMentorAnalysis!.revision, 5);
  assert.equal(JSON.stringify(draft.getDoc().timelines), before);
}
for (const executor of [executeTool, executeOfflineTool]) {
  const unregistered = context(legacy);
  const stopped = await executor('submit_voice', { text: goodLine.narration_ms }, unregistered.ctx) as { production_gate?: { code: string } };
  assert.equal(stopped.production_gate?.code, 'source_breakdown_not_ready');
  assert.equal(unregistered.draft.takeActions().length, 0);
  const mismatch = context(mutate((d) => { d.timelines[0].items[0].srcInFrame = 1800; }));
  const blocked = await executor('submit_render_job', {}, mismatch.ctx) as { production_gate?: { code: string } };
  assert.equal(blocked.production_gate?.code, 'breakdown_timeline_not_ready');
}
assert.equal(await clipMentorProductionBlock('submit_render_job', {}, context(base).ctx), null, 'matching reviewed positive can reach rendering preflight, but no render runs in this test');
assert.equal(networkCalls, 0);
// Keep the historical fixture portable and free of workstation paths or media bytes.
assert(!readFileSync(new URL('./fixtures/source-breakdown-v1r1.json', import.meta.url), 'utf8').includes('/Users/'));
console.log('Source breakdown: baseline, evidence separation, real v1r1 regression, derived ranges, review binding and both dispatchers passed; no model/TTS/render calls.');
