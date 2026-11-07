import {verifyCopyCandidateCheckpoint} from './copy-candidate-checkpoint.verify-suite';
import {assertDeliveryPicturePreservation} from './delivery-bindings';
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
import { projectServerRunToolResult } from '../agent/serverRunToolResult';
import { migrateProjectDoc } from '../persist/projectStore';
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
  version: 1, review_scope: { kind: 'local_ranges', source_ranges: [[59.4, 62.2]], instruction: 'Synthetic scoped teaching test' }, segments: [{ segment_id: 'S1', source_range_seconds: [59.4, 62.2], visible_evidence_ids: ['F1'], claim_evidence_ids: [], interpretation_evidence_ids: [], unknowns: ['Scent quality unverified'] }],
  points: [{ point_id: 'P1', segment_ids: ['S1'], buying_concern: 'Use experience', teaching_question: '这个使用中的动作让观众联想到哪种使用体验？', role: 'primary', importance: 'must_explain', filming_conditions: ['Near-nose gesture during use'] }],
  units: [{ unit_id: 'U1', original_segment_ids: ['S1'], explanation_segment_ids: ['S1'], coverage: [{ point_id: 'P1', treatment: 'explain' }],
    revisits: [{ from_segment_id: 'S1', to_segment_id: 'S1', reason: 'Revisit the demonstrated gesture to explain its use experience' }],
    placement: { timeline_id: 'tl', original_frames: [0, 84], explanation_frames: [90, 174] } }],
};
for (const teaching_question of ['', ' ', null, ['question']]) {
  const invalid = structuredClone(b);
  Object.assign(invalid.points[0], { teaching_question });
  assert(!isSourceBreakdown(invalid), 'a teaching goal must be nonempty text');
}
for (const [target, field, allowed] of [
  ['point', 'role', ['primary', 'supporting', 'auxiliary']],
  ['point', 'importance', ['must_explain', 'should_explain', 'optional']],
  ['coverage', 'treatment', ['explain', 'merged', 'visual_only', 'omit']],
] as const) {
  for (const scalar of allowed) {
    const valid = structuredClone(b);
    Object.assign(target === 'point' ? valid.points[0] : valid.units[0].coverage[0], { [field]: scalar });
    assert(isSourceBreakdown(valid), `valid ${field}:${scalar}`);
    for (const value of [[scalar], [[scalar]], null, {}, true, 0]) {
      const invalid = structuredClone(valid);
      Object.assign(target === 'point' ? invalid.points[0] : invalid.units[0].coverage[0], { [field]: value });
      assert(!isSourceBreakdown(invalid), `reject non-string ${field}`);
    }
  }
}

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
for (const scope of [null, [], {kind:'full_source'}, {kind:'local_ranges',source_ranges:[[2,1]],instruction:'bad'}, {kind:['full_source'],instruction:'bad'}]) {
  assert(!isSourceBreakdown({...b,review_scope:scope}));
}
assert(isClipMentorAnalysis(base.clipMentorAnalysis));
assert.equal(checkSourceBreakdown(base).status, 'structurally_ready');
assert.equal(checkSourceBreakdown(base, true).status, 'structurally_ready');

// A primary teaching point may use two selected source windows without playing
// the intervening gap. The copy range is their envelope, not a continuous clip.
const disjointCopy = structuredClone(base);
const db = disjointCopy.clipMentorAnalysis!.source_breakdown!;
db.segments.push({ ...structuredClone(db.segments[0]), segment_id: 'S2', source_range_seconds: [65, 66], visible_evidence_ids: ['F2'] });
disjointCopy.clipMentorAnalysis!.evidence.push({ ...structuredClone(disjointCopy.clipMentorAnalysis!.evidence[0]), evidence_id: 'F2', time_seconds: 65.5, source_frame: 1965 });
db.points[0].segment_ids.push('S2');
Object.assign(db.units[0], { original_segment_ids: ['S1', 'S2'], original_source_ranges: [[59.4, 66]], explanation_segment_ids: ['S1', 'S2'],
  revisits: [{ from_segment_id: 'S2', to_segment_id: 'S1', reason: 'Explain the two selected stages after the full demonstration' }],
  placement: { timeline_id: 'tl', original_frames: [0, 198], explanation_frames: [210, 324] } });
(disjointCopy.clipMentorAnalysis!.blueprint[0] as any).internal_review.copy.lines[0].source_seconds = [59.4, 66];
disjointCopy.timelines[0].items = [clip('original', 0, 1782, 198), clip('stage-one', 210, 1782, 84), clip('stage-two', 294, 1950, 30)];
assert.equal(checkSourceBreakdown(disjointCopy).status, 'structurally_ready', 'registered disjoint direct evidence does not require invented context');
assert.equal(checkSourceBreakdown(disjointCopy, true).status, 'structurally_ready');
const disjointPacket = await copyTeachingPacketFromDoc(disjointCopy);
assert.deepEqual((disjointPacket.units[0].picture_plan!.line_source_ranges[0] as any).evidence_source_ranges,
  [{ segment_id: 'S1', source_range_seconds: [59.4, 62.2] }, { segment_id: 'S2', source_range_seconds: [65, 66] }]);
for (const range of [[59, 66], [59.4, 67]]) {
  const unbound = structuredClone(disjointCopy);
  (unbound.clipMentorAnalysis!.blueprint[0] as any).internal_review.copy.lines[0].source_seconds = range;
  assert(checkSourceBreakdown(unbound).issues.some(i => i.code === 'copy_picture_outside_explanation'), 'unregistered envelope edges remain blocked');
}
const playedGap = structuredClone(disjointCopy);
playedGap.timelines[0].items[1].durationInFrames = 114;
assert(checkSourceBreakdown(playedGap, true).issues.some(i => i.code === 'timeline_source_range_mismatch'), 'an envelope never authorizes playback through its unselected gap');
assert.equal((await checkCopyProduction(disjointCopy, null)).allowed, false, 'structural binding never supplies independent teaching approval');

// One line can use a registered comparison frame as context for a different point.
// Its source_seconds is a search envelope, not permission to play unindexed gaps.
const contextualCopy = structuredClone(base);
const cb = contextualCopy.clipMentorAnalysis!.source_breakdown!;
cb.segments = [
  { ...structuredClone(b.segments[0]), segment_id: 'compare', source_range_seconds: [80, 84.2], visible_evidence_ids: ['FC'] },
  { ...structuredClone(b.segments[0]), segment_id: 'person', source_range_seconds: [84.4, 85.3], visible_evidence_ids: ['FP'] },
];
contextualCopy.clipMentorAnalysis!.evidence = [
  { ...structuredClone(base.clipMentorAnalysis!.evidence[0]), evidence_id: 'FC', time_seconds: 83.2, source_frame: 2496 },
  { ...structuredClone(base.clipMentorAnalysis!.evidence[0]), evidence_id: 'FP', time_seconds: 85, source_frame: 2550 },
];
cb.points[0].segment_ids = ['person'];
cb.units[0] = { ...cb.units[0], original_segment_ids: ['compare', 'person'], explanation_segment_ids: ['compare', 'person'],
  revisits: [{ from_segment_id: 'person', to_segment_id: 'compare', reason: 'Return to comparison context before explaining presenter expression' }] };
const ci = (contextualCopy.clipMentorAnalysis!.blueprint[0] as any).internal_review;
ci.copy.lines[0].source_seconds = [83.2, 85.3];
ci.current_picture_plan = 'context_plan';
ci.context_plan = { script_candidate_id: 'copy', phases: [{ line_id: goodLine.line_id,
  context_source_ranges: [{ segment_id: 'compare', source_range_seconds: [83.2, 83.2], purpose: 'Establish the just-seen comparison; not evidence of the facial expression' }] }] };
assert.equal(checkSourceBreakdown(contextualCopy).status, 'structurally_ready', 'explicit same-unit context may precede the point evidence');
const contextualPacket = await copyTeachingPacketFromDoc(contextualCopy);
const binding = contextualPacket.units[0].picture_plan!.line_source_ranges[0] as any;
assert.deepEqual(binding.evidence_source_ranges, [{ segment_id: 'person', source_range_seconds: [84.4, 85.3] }]);
assert.deepEqual(binding.context_source_ranges, ci.context_plan.phases[0].context_source_ranges);
const narrowedDirect=structuredClone(contextualCopy);
const narrowedPhase=(narrowedDirect.clipMentorAnalysis!.blueprint[0] as any).internal_review.context_plan.phases[0];
narrowedPhase.context_source_ranges.push(
 {segment_id:'person',source_range_seconds:[84.4,84.6],purpose:'First relevant action'},
 {segment_id:'person',source_range_seconds:[85.0,85.3],purpose:'Second relevant action'},
);
const narrowedPacket=await copyTeachingPacketFromDoc(narrowedDirect);
assert.deepEqual(narrowedPacket.units[0].picture_plan!.line_source_ranges[0].evidence_source_ranges,[
 {segment_id:'person',source_range_seconds:[84.4,84.6]},
 {segment_id:'person',source_range_seconds:[85.0,85.3]},
]);
assert.equal((await checkCopyProduction(narrowedDirect,null)).allowed,false);
const isolatedContextRequest = buildCopyTeachingReviewRequest([{ case_id: 'context-binding', packet: contextualPacket }]);
assert.deepEqual(isolatedContextRequest.input.cases[0].packet.units[0].picture_plan!.line_source_ranges[0], binding, 'the isolated-review handoff must preserve both evidence and context bindings');
assert(contextualPacket.units[0].picture_plan!.explanation_source_ranges.some((r) => r[0] === 83.2 && r[1] > r[0] && r[1] - r[0] <= 1 / 30 + 1e-9), 'the fixed server sampler must actually receive the selected context-frame window');
assert(contextualPacket.source_evidence.some((e) => e.evidence_id === 'FC'), 'context observations must be visible to the isolated reviewer without becoming point evidence');
assert.equal((await checkCopyProduction(contextualCopy, null)).allowed, false, 'structural context binding never grants semantic approval');
for (const change of [
  (v: any) => { delete v.context_plan.phases[0].context_source_ranges; },
  (v: any) => { v.context_plan.phases[0].context_source_ranges[0].purpose = ''; },
  (v: any) => { v.context_plan.phases[0].context_source_ranges[0].segment_id = 'missing'; },
  (v: any) => { v.context_plan.phases[0].context_source_ranges[0].source_range_seconds = [70, 70]; },
  (v: any) => { v.copy.lines[0].source_seconds = [83.2, 84.2]; },
  (v: any) => { v.context_plan.phases[0].context_source_ranges = 'compare'; },
]) {
  const bad = structuredClone(contextualCopy); change((bad.clipMentorAnalysis!.blueprint[0] as any).internal_review);
  assert.notEqual(checkSourceBreakdown(bad).status, 'structurally_ready', 'unbound context or context alone cannot replace direct point evidence');
}
for (const executor of [executeTool]) {
  const repairable = structuredClone(contextualCopy);
  delete (repairable.clipMentorAnalysis!.blueprint[0] as any).internal_review.context_plan.phases[0].context_source_ranges;
  assert.equal(checkSourceBreakdown(repairable).status, 'review_required');
  await assert.rejects(copyTeachingPacketFromDoc(repairable), /source_breakdown_not_ready/, 'unbound context cannot reach independent review');
  const draft = context(repairable);
  const repaired = await executor('revise_clipmentor_analysis', { action: 'set_picture_plan', id: 'U1', expectedRevision: 1, actor,
    reason: 'Bind existing comparison context without changing a word', record: { plan_id: 'picture_plan_context_repaired', script_candidate_id: 'copy',
      plan: structuredClone(ci.context_plan), line_guidance: 'Same wording; explicit context binding, still pending' } }, draft.ctx) as any;
  assert.equal(repaired.ok, true, JSON.stringify(repaired));
  assert.equal(checkSourceBreakdown(draft.draft.getDoc()).status, 'structurally_ready');
  assert.deepEqual((draft.draft.getDoc().clipMentorAnalysis!.blueprint[0] as any).internal_review.copy.lines, ci.copy.lines);
  assert.equal((await checkCopyProduction(draft.draft.getDoc(), null)).allowed, false, 'binding repair is not approval');
  const wrongSource = structuredClone(repairable); wrongSource.assets[0].sourceContentHash = 'b'.repeat(64);
  const rejected = await executor('revise_clipmentor_analysis', { action: 'set_picture_plan', id: 'U1', expectedRevision: 1, actor,
    reason: 'Must not bypass source binding', record: { plan_id: 'picture_plan_wrong_source', script_candidate_id: 'copy', plan: ci.context_plan, line_guidance: 'test' } }, context(wrongSource).ctx) as any;
  assert(rejected.error, 'preparation still blocks baseline/source errors');
}
const otherUnitContext = structuredClone(contextualCopy);
otherUnitContext.clipMentorAnalysis!.source_breakdown!.units[0].explanation_segment_ids = ['person'];
assert.notEqual(checkSourceBreakdown(otherUnitContext).status, 'structurally_ready', 'a context segment outside the current unit is not authorized');

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
  units: [{ unit_id: 'U1', candidate_id: 'copy', verdict: 'pass', findings: [],
    group_checks: { scope: 'planned_group_teaching_only',
      source_relations: [{ relation: 'Synthetic source relation', evidence_ids: [packet.units[0].source_context!.evidence_ids[0]], point_ids: ['P1'], line_ids: [goodLine.line_id], assessment: 'covered', reason: 'Synthetic protocol fixture only' }],
      L1: { verdict: 'pass', learner_takeaway: 'Synthetic group relation', reason: 'Synthetic coverage only' },
      L2: { verdict: 'pass', viewer_chain: 'Synthetic original then explanation', stage_cues: 'Synthetic visible revisit title', reason: 'Synthetic plan only' } },
    narration_checks: [{ line_id: goodLine.line_id, necessity: 'necessary', omission_loss: 'Synthetic fixture: use-experience teaching relation',
      naturalness: 'natural', reason: 'Synthetic policy positive only, not actual linguistic review' }] }], teaching_review: { packet, review } });
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

  // A frozen unit can exceed the model cap even after unitId filtering.
  const largeFrozen = structuredClone(base);
  const frozen = largeFrozen.clipMentorAnalysis!.production_copy_review!;
  frozen.teaching_review!.packet.units[0].picture_plan!.execution_plan = {
    plan_id: 'picture_plan_historical_large', script_candidate_id: 'copy',
    content: { history_shape_not_current_copy: Array.from({ length: 35 }, (_, i) => ({ id: i, text: `exact nested detail ${i} 中文 🎬 ` + 'x'.repeat(1100) })) },
  };
  frozen.teaching_review!.packet.source_evidence.push({ evidence_id: 'context-only', observation: 'Frozen shared context, not listed as point evidence', time_seconds: [83.2] });
  const largeBefore = JSON.stringify(largeFrozen);
  const firstPage = await readReceipt({ reviewPart: 'packet', unitId: 'U1' }, largeFrozen);
  assert(firstPage.analysis.copy_review.packet_page, 'oversized frozen input must return an explicit bounded page, not a truncated whole packet');
  const pages: string[] = [];
  let offset = 0, digest: string | undefined;
  do {
    const page = await readReceipt({ reviewPart: 'packet', unitId: 'U1', packetOffset: offset, packetLimit: 1000,
      ...(digest ? { packetDigest: digest } : {}) }, largeFrozen);
    assert.deepEqual(compactToolResultForModel(page), page, 'each page reaches the model without compaction');
    assert.deepEqual(projectServerRunToolResult(page), page, 'each page fits browser-server transport');
    const data = page.analysis.copy_review.packet_page;
    assert.equal(data.offset, offset);
    assert.equal(page.analysis.copy_review.packet_included, false, 'a page is not a complete packet');
    assert.equal(data.read_complete, false, 'the last page never certifies that earlier pages were actually read');
    if (digest) assert.equal(data.digest, digest); else digest = data.digest;
    pages.push(data.json_text); offset = data.next_offset;
    if (offset === null) assert.equal(data.is_last_page, true);
  } while (offset !== null);
  const rebuilt = JSON.parse(pages.join(''));
  assert.deepEqual(rebuilt.packet, frozen.teaching_review!.packet, 'every nested field and frozen observation survives paging');
  assert.equal(rebuilt.analysis_revision, frozen.analysis_revision);
  assert.equal(rebuilt.content_digest, frozen.content_digest);
  assert.equal(JSON.stringify(largeFrozen), largeBefore, 'reads cannot alter the stored receipt or current project');
  const latePage = await readReceipt({ reviewPart: 'packet', unitId: 'U1', packetOffset: 1000, packetDigest: digest }, largeFrozen);
  assert.equal(latePage.analysis.copy_review.packet_page.read_complete, false);
  const changedCurrent = structuredClone(largeFrozen); changedCurrent.clipMentorAnalysis!.revision++;
  const stalePage = await readReceipt({ reviewPart: 'packet', unitId: 'U1', packetOffset: 1000, packetDigest: digest }, changedCurrent);
  assert.equal(stalePage.analysis.copy_review.binding, 'stale');
  assert.equal(stalePage.analysis.copy_review.packet_page.digest, digest, 'the saved frozen input remains readable when current copy changes');
  assert.equal(stalePage.production_gate.allowed, false);
  const changedFrozen = structuredClone(largeFrozen);
  changedFrozen.clipMentorAnalysis!.production_copy_review!.reviewed_at++;
  assert((await readReceipt({ reviewPart: 'packet', unitId: 'U1', packetOffset: 1000, packetDigest: digest }, changedFrozen)).error, 'pages from changed receipts cannot be silently mixed');
  for (const bad of [
    { packetOffset: null }, { packetOffset: 0, packetLimit: null }, { packetOffset: -1 }, { packetOffset: 0.5 }, { packetOffset: '0' }, { packetOffset: true },
    { packetOffset: 99999999, packetDigest: digest }, { packetOffset: 1000 },
    { packetOffset: 0, packetLimit: 0 }, { packetOffset: 0, packetLimit: 6001 },
    { packetOffset: 0, packetLimit: [1000] }, { packetOffset: 0, packetDigest: '0'.repeat(64) },
    { packetLimit: 1000 },
  ]) assert((await readReceipt({ reviewPart: 'packet', unitId: 'U1', ...bad }, largeFrozen)).error, JSON.stringify(bad));
  assert((await readReceipt({ reviewPart: 'result', unitId: 'U1', packetOffset: 0 }, largeFrozen)).error);
  assert((await executor('read_clipmentor_analysis', { view: 'current_copy', unitId: 'U1', packetOffset: 0 }, context(base).ctx) as any).error);

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
  const failedPage = await readReceipt({ reviewPart: 'packet', unitId: 'U1', packetOffset: 0, packetLimit: 1000 }, failedReceipt);
  assert.equal(failedPage.analysis.copy_review.receipt.verdict, 'needs_revision');
  assert.equal(failedPage.production_gate.allowed, false, 'paging cannot upgrade a non-pass review');

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
  const bulkyDoc = structuredClone(base);
  const bulkyInternal = (bulkyDoc.clipMentorAnalysis!.blueprint[0] as any).internal_review;
  bulkyInternal.history = { text: 'HISTORY-MARKER'.repeat(100_000) };
  bulkyInternal.script_candidate_kept = structuredClone(bulkyInternal.copy);
  bulkyInternal.current_picture_plan = 'picture_plan_bulky';
  bulkyInternal.picture_plan_bulky = { script_candidate_id: 'copy', status: 'candidate', history: bulkyInternal.history };
  const local = context(bulkyDoc);
  const freshLine = { id: 'local-new-line', point_ids: ['P1'], narration_ms: 'Synthetic updated narration.',
    caption_lines: ['Synthetic updated', 'narration.'], zh: '仅供回归的合成文本。', source_seconds: [59.4, 62.2], labels: ['Synthetic label'] };
  const freshRecord = { source_candidate_id: 'copy', candidate_id: 'script_candidate_local_new', lines: [freshLine],
    plan_id: 'picture_plan_local_new', plan: { source_range: [59.4, 62.2], composition: 'Synthetic local picture plan; no media execution',
      status: 'pass', review_status: 'confirmed', production_allowed: true }, line_guidance: 'Synthetic current candidate and picture only' };
  const brokenPhaseDoc=structuredClone(bulkyDoc);
  const brokenPhaseReview=(brokenPhaseDoc.clipMentorAnalysis!.blueprint[0] as any).internal_review;
  brokenPhaseReview.picture_plan_bulky.phases=[{mode:'original',source_range_seconds:[59.4,62.2]}];
  assert(checkSourceBreakdown(brokenPhaseDoc).issues.some(issue=>issue.code==='picture_plan_group_explanation_missing'));
  const brokenPhase=context(brokenPhaseDoc);
  const fixedPhase=await executor('revise_clipmentor_analysis',{action:'set_picture_plan',id:'U1',expectedRevision:1,actor,
    reason:'Replace the invalid draft phase plan',record:{plan_id:'picture_plan_repaired',script_candidate_id:'copy',
     plan:{composition:'Existing prepared reference'},line_guidance:'Existing copy remains pending'}},brokenPhase.ctx) as any;
  assert.equal(fixedPhase.ok,true,JSON.stringify(fixedPhase));
  assert.equal((await checkCopyProduction(brokenPhase.draft.getDoc(),'clipmentor')).allowed,false);
  const damagedDelivery=structuredClone(bulkyDoc);
  for(const timeline of damagedDelivery.timelines)timeline.items=[];
  const damagedReview=(damagedDelivery.clipMentorAnalysis!.blueprint[0] as any).internal_review;
  damagedReview.picture_plan_bulky.delivery_sections=[{line_id:'bad-video-opening',source_range_seconds:[0,2]}];
  const brokenDelivery=context(damagedDelivery);
  const updateDelivery={action:'set_picture_plan',id:'U1',expectedRevision:1,actor,
   reason:'Replace the invalid draft delivery declaration',record:{plan_id:'picture_plan_delivery_repaired',script_candidate_id:'copy',
    plan:{composition:'Saved teaching plan'},line_guidance:'Pending copy remains unchanged'}};
  const invalidDelivery=await executor('revise_clipmentor_analysis',{...updateDelivery,
   record:{...updateDelivery.record,plan:{delivery_sections:[{line_id:'video-only'}]}}},brokenDelivery.ctx) as any;
  assert.equal(invalidDelivery.error,'delivery_sections_invalid');
  assert.deepEqual(brokenDelivery.draft.getDoc(),damagedDelivery);
  assert.equal((await executor('revise_clipmentor_analysis',updateDelivery,brokenDelivery.ctx) as any).ok,true);
  const repairedDelivery=brokenDelivery.draft.getDoc();
  assert.doesNotThrow(()=>assertDeliveryPicturePreservation(damagedDelivery,repairedDelivery));
  assert.throws(()=>assertDeliveryPicturePreservation(damagedDelivery,damagedDelivery),/delivery_sections_invalid/);
  const withTimeline=structuredClone(damagedDelivery);
  withTimeline.timelines[0].items.push({id:'fixture-existing-timeline-item'} as never);
  assert.throws(()=>assertDeliveryPicturePreservation(withTimeline,repairedDelivery),/delivery_sections_invalid/);
  // First-time projects start with an evidence breakdown but no current copy.
  const initialDoc = structuredClone(bulkyDoc);
  delete (initialDoc.clipMentorAnalysis!.blueprint[0] as any).internal_review;
  const initial = context(initialDoc);
  const firstArgs = { action: 'set_copy_candidate', id: 'U1', expectedRevision: 1, actor,
    reason: 'Register initial copy after source mapping', record: {...freshRecord, source_candidate_id: null} };
  const badFirst = await executor('revise_clipmentor_analysis', {
    ...firstArgs, record: {...firstArgs.record, source_candidate_id:'missing_history'},
  }, initial.ctx) as any;
  assert(badFirst.error);
  assert.deepEqual(initial.draft.getDoc(), initialDoc, 'wrong base must not leave a partial first draft');
  const first = await executor('revise_clipmentor_analysis', firstArgs, initial.ctx) as any;
  assert.equal(first.ok, true, JSON.stringify(first));
  const firstDoc = initial.draft.getDoc();
  const firstReview = (firstDoc.clipMentorAnalysis!.blueprint[0] as any).internal_review;
  assert.equal(firstReview.current_script_candidate,freshRecord.candidate_id);
  assert.equal(firstReview.current_picture_plan,freshRecord.plan_id);
  assert.equal(firstReview[freshRecord.plan_id].script_candidate_id,freshRecord.candidate_id);
  assert.equal(firstReview[freshRecord.plan_id].production_allowed,false);
  assert.equal((await checkCopyProduction(firstDoc, 'clipmentor')).allowed,false);
  const noOverwrite = await executor('revise_clipmentor_analysis', {
    ...firstArgs, expectedRevision: 2, record: {...firstArgs.record, candidate_id:'script_candidate_other',plan_id:'picture_plan_other'},
  }, initial.ctx) as any;
  assert(noOverwrite.error, 'null cannot replace an existing current draft');
  const localBefore = structuredClone(local.draft.getDoc());
  for (const copyPart of ['summary', 'candidate']) {
    const beforeRead = await executor('read_clipmentor_analysis', { view: 'current_copy', copyPart, unitId: 'U1' }, local.ctx) as any;
    assert.equal(beforeRead.analysis.current_copy[0].candidate_id, 'copy');
    assert(!JSON.stringify(beforeRead).includes('HISTORY-MARKER'), 'large old plans are not required even before local registration');
    assert.deepEqual(compactToolResultForModel(beforeRead), beforeRead);
  }
  const registered = await executor('revise_clipmentor_analysis', { action: 'set_copy_candidate', id: 'U1', record: freshRecord,
    expectedRevision: 1, actor, reason: 'Register local synthetic copy without reading or retransmitting historical blueprint' }, local.ctx) as any;
  assert(registered.ok, 'new wording and its picture plan must register atomically without a full blueprint read');
  const localDoc = local.draft.getDoc();
  const localInternal = (localDoc.clipMentorAnalysis!.blueprint[0] as any).internal_review;
  assert.equal(localDoc.clipMentorAnalysis!.revision, 2);
  assert.equal(localInternal.current_script_candidate, freshRecord.candidate_id);
  assert.equal(localInternal.current_picture_plan, freshRecord.plan_id);
  assert.deepEqual(localInternal[freshRecord.candidate_id].lines, [freshLine]);
  assert.equal(localInternal[freshRecord.candidate_id].production_allowed, false);
  assert.equal(localInternal[freshRecord.plan_id].review_status, 'pending');
  assert.equal(localInternal[freshRecord.plan_id].status, 'candidate');
  assert.equal(localInternal[freshRecord.plan_id].production_allowed, false);
  assert.equal(localInternal[freshRecord.plan_id].script_candidate_id, freshRecord.candidate_id);
  assert.deepEqual(localInternal[freshRecord.plan_id].selected_narration, [freshLine]);
  for (const [key, value] of Object.entries(bulkyInternal)) {
    if (!['current_script_candidate', 'current_picture_plan'].includes(key)) assert.deepEqual(localInternal[key], value, 'old candidates, plans and history remain unchanged');
  }
  assert.deepEqual(localDoc.assets, localBefore.assets); assert.deepEqual(localDoc.timelines, localBefore.timelines);
  assert.deepEqual(localDoc.clipMentorAnalysis!.source_breakdown, localBefore.clipMentorAnalysis!.source_breakdown);
  assert.deepEqual(localDoc.clipMentorAnalysis!.production_copy_review, localBefore.clipMentorAnalysis!.production_copy_review);
  assert.equal((await checkCopyProduction(localDoc, null)).code, 'copy_review_stale');
  for (const copyPart of ['summary', 'candidate', 'picture_plan']) {
    const read = await executor('read_clipmentor_analysis', { view: 'current_copy', copyPart, unitId: 'U1' }, local.ctx) as any;
    assert.equal(read.revision, 2);
    assert.equal(read.analysis.current_copy[0].candidate_id, freshRecord.candidate_id);
    assert.equal(read.analysis.current_copy[0].picture_plan_id, freshRecord.plan_id);
    assert(!JSON.stringify(read).includes('HISTORY-MARKER'));
    assert.deepEqual(projectServerRunToolResult(read), read, 'narrow read survives the real browser/server result projection');
    assert.deepEqual(compactToolResultForModel(read), read, 'narrow read reaches the model intact');
    if (copyPart === 'candidate') assert.deepEqual(read.analysis.current_copy[0].candidate.lines, [freshLine]);
    if (copyPart === 'picture_plan') assert.deepEqual(read.analysis.current_copy[0].picture_plan, localInternal[freshRecord.plan_id]);
  }
  assert.deepEqual(migrateProjectDoc(JSON.parse(JSON.stringify(localDoc)))!.clipMentorAnalysis, localDoc.clipMentorAnalysis, 'save/reopen keeps current pointers and history');
  for (const [record, revision, id] of [
    [freshRecord, 0, 'U1'], [freshRecord, 1, 'missing'],
    [{ ...freshRecord, source_candidate_id: 'stale' }, 1, 'U1'],
    [{ ...freshRecord, candidate_id: 'script_candidate_kept' }, 1, 'U1'],
    [{ ...freshRecord, plan_id: 'picture_plan_bulky' }, 1, 'U1'],
    [{ ...freshRecord, lines: [] }, 1, 'U1'],
    [{ ...freshRecord, lines: [freshLine, freshLine] }, 1, 'U1'],
    [{ ...freshRecord, lines: [{ ...freshLine, caption_lines: ['Different subtitle words'] }] }, 1, 'U1'],
    [{ ...freshRecord, lines: [{ ...freshLine, point_ids: ['another-unit-point'] }] }, 1, 'U1'],
    [{ ...freshRecord, lines: [{ ...freshLine, source_seconds: [59.4, 101] }] }, 1, 'U1'],
    [{ ...freshRecord, lines: [{ ...freshLine, zh: '' }] }, 1, 'U1'],
    [{ ...freshRecord, lines: [{ ...freshLine, production_allowed: true }] }, 1, 'U1'],
    [{ ...freshRecord, production_allowed: true }, 1, 'U1'],
    [{ ...freshRecord, plan: { selected_narration: [] } }, 1, 'U1'],
  ] as const) {
    const denied = context(bulkyDoc);
    assert((await executor('revise_clipmentor_analysis', { action: 'set_copy_candidate', id, record,
      expectedRevision: revision, actor, reason: 'Reject unsafe local registration atomically' }, denied.ctx) as any).error);
    assert.deepEqual(denied.draft.getDoc(), bulkyDoc);
    assert.equal(denied.draft.takeActions().length, 0);
  }
  for (const args of [{ copyPart: 'candidate' }, { copyPart: ['summary'], unitId: 'U1' },
    { view: 'source_breakdown', copyPart: 'summary', unitId: 'U1' }]) {
    assert((await executor('read_clipmentor_analysis', { view: 'current_copy', ...args }, local.ctx) as any).error);
  }
  const replayBefore = structuredClone(local.draft.getDoc());
  for (const [revision, record] of [[1, { ...freshRecord, candidate_id: 'script_candidate_next', plan_id: 'picture_plan_next', source_candidate_id: freshRecord.candidate_id }],
    [2, { ...freshRecord, source_candidate_id: freshRecord.candidate_id }]] as const) {
    assert((await executor('revise_clipmentor_analysis', { action: 'set_copy_candidate', id: 'U1', expectedRevision: revision,
      record, actor, reason: 'Reject stale writer and duplicate local registration' }, local.ctx) as any).error);
    assert.deepEqual(local.draft.getDoc(), replayBefore);
  }
  const noLocalLedger = structuredClone(bulkyDoc); delete noLocalLedger.clipMentorAnalysis!.source_breakdown;
  const changedLocalSource = structuredClone(bulkyDoc); changedLocalSource.assets[0].sourceContentHash = 'b'.repeat(64);
  for (const invalid of [noLocalLedger, changedLocalSource]) {
    const denied = context(invalid);
    assert((await executor('revise_clipmentor_analysis', { action: 'set_copy_candidate', id: 'U1', record: freshRecord,
      expectedRevision: 1, actor, reason: 'Reject missing ledger or changed source' }, denied.ctx) as any).error);
    assert.equal(denied.draft.takeActions().length, 0);
  }
  const reordered = context(bulkyDoc);
  const reorderedLine = Object.fromEntries(Object.entries(freshLine).reverse());
  assert((await executor('revise_clipmentor_analysis', { action: 'set_copy_candidate', id: 'U1', expectedRevision: 1,
    record: { ...freshRecord, plan: { ...freshRecord.plan, selected_narration: [reorderedLine] } }, actor,
    reason: 'Object key ordering is not a copy mismatch' }, reordered.ctx) as any).ok);
  const concurrent = context(bulkyDoc);
  const changedDoc = { ...bulkyDoc, clipMentorAnalysis: { ...bulkyDoc.clipMentorAnalysis!, revision: 2 } };
  let reads = 0;
  const concurrentContext = { ...concurrent.ctx, getDoc: () => ++reads === 1 ? bulkyDoc : changedDoc };
  const raced = await executor('revise_clipmentor_analysis', { action: 'set_copy_candidate', id: 'U1', expectedRevision: 1,
    record: freshRecord, actor, reason: 'Never overwrite a concurrent project change' }, concurrentContext) as any;
  assert(raced.error?.includes('Project changed'));
  assert.equal(concurrent.draft.takeActions().length, 0);
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
  const lostNewCopy = context(selectionTwoPoints);
  const newCopyLoss = await executor('revise_clipmentor_analysis', { action: 'set_copy_candidate', id: 'U1', record: freshRecord,
    expectedRevision: 2, actor, reason: 'New copy cannot silently drop another explained point' }, lostNewCopy.ctx) as any;
  assert(newCopyLoss.error?.includes('teaching point'));
  assert.equal(lostNewCopy.draft.takeActions().length, 0);
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
  const pointAudit = draft.getDoc().clipMentorAnalysis!.audit.find(e => e.action === 'selected_point_changed' && e.target_id === 'P1')!;
  assert(pointAudit);
  assert.equal(pointAudit.revision, 2);
  assert.deepEqual(pointAudit.actor, actor);
  const decision = JSON.parse(pointAudit.reason);
  assert.equal(decision.before.coverage[0].treatment, 'explain');
  assert.deepEqual(decision.after.coverage, []);
  assert.equal(decision.instruction_reason, 'Test incomplete candidate');
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
// Candidate preparation is a durable checkpoint, not a timeline proposal tied to review success.

const danglingPointer = structuredClone(base);
(danglingPointer.clipMentorAnalysis!.blueprint[0] as any).internal_review.current_script_candidate = 'missing';
assert(checkSourceBreakdown(danglingPointer).issues.some(i => i.code === 'copy_candidate_pointer_invalid'),
  'a missing current candidate must not be reported structurally ready');
for (const [pointer, expected] of [['missing-plan', 'picture_plan_pointer_invalid'], ['wrong-copy-plan', 'picture_plan_candidate_mismatch']] as const) {
  const doc = structuredClone(base), internal = (doc.clipMentorAnalysis!.blueprint[0] as any).internal_review;
  internal.current_picture_plan = pointer;
  if (pointer === 'wrong-copy-plan') internal[pointer] = { script_candidate_id: 'OTHER_COPY' };
  assert(checkSourceBreakdown(doc).issues.some(i => i.code === expected));
}
for (const executor of [executeTool]) {
  const { ctx, draft } = context(base);
  const before = JSON.stringify(draft.getDoc());
  const replacement: any = structuredClone(base.clipMentorAnalysis!.blueprint[0]);
  replacement.internal_review.script_candidate_detached = structuredClone(replacement.internal_review.copy);
  const saved = await executor('revise_clipmentor_analysis', { action: 'revise', collection: 'blueprint', id: 'U1',
    expectedRevision: 1, record: replacement, actor, reason: 'Regression: new copy must be activated atomically' }, ctx) as { error?: string };
  assert(saved.error?.includes('atomically'), 'generic writes must not save a new copy while leaving the current pointer behind');
  assert.equal(JSON.stringify(draft.getDoc()), before);
  assert.equal(draft.takeActions().length, 0);
}
// Adversarial regressions: missing state must not shrink review scope; placeholders are not old copy.
for (const executor of [executeTool]) {
  for (const missing of ['internal', 'copy', 'plan']) {
    const doc = structuredClone(base);
    const internal = (doc.clipMentorAnalysis!.blueprint[0] as any).internal_review;
    internal.current_picture_plan = 'picture_plan_bound';
    internal.picture_plan_bound = { script_candidate_id: 'copy' };
    const { ctx, draft } = context(doc), before = JSON.stringify(draft.getDoc());
    const replacement: any = structuredClone(doc.clipMentorAnalysis!.blueprint[0]);
    if (missing === 'internal') delete replacement.internal_review;
    if (missing === 'copy') delete replacement.internal_review.current_script_candidate;
    if (missing === 'plan') delete replacement.internal_review.current_picture_plan;
    const saved: any = await executor('revise_clipmentor_analysis', { action: 'revise', collection: 'blueprint', id: 'U1',
      expectedRevision: 1, record: replacement, actor, reason: 'Regression: preserve current state' }, ctx);
    assert(saved.error, 'existing active state must not be silently removed: ' + missing);
    assert.equal(JSON.stringify(draft.getDoc()), before);
  }
  const { ctx, draft } = context(base);
  const replacement: any = structuredClone(base.clipMentorAnalysis!.blueprint[0]);
  replacement.internal_review.script_candidate_reserved = { status: 'candidate' };
  const reserved: any = await executor('revise_clipmentor_analysis', { action: 'revise', collection: 'blueprint', id: 'U1',
    expectedRevision: 1, record: replacement, actor, reason: 'Reserve a draft placeholder' }, ctx);
  assert(reserved.ok, JSON.stringify(reserved));
  replacement.internal_review.script_candidate_reserved = structuredClone(replacement.internal_review.copy);
  const before = JSON.stringify(draft.getDoc());
  const filled: any = await executor('revise_clipmentor_analysis', { action: 'revise', collection: 'blueprint', id: 'U1',
    expectedRevision: 2, record: replacement, actor, reason: 'Populate without updating pointer' }, ctx);
  assert(filled.error?.includes('atomically'), 'upgrading a placeholder is new copy and requires an atomic pointer');
  assert.equal(JSON.stringify(draft.getDoc()), before);
}
const narrowedScope = structuredClone(base);
const missingUnit: any = structuredClone(narrowedScope.clipMentorAnalysis!.blueprint[0]);
missingUnit.unit_id = 'U2'; delete missingUnit.internal_review;
narrowedScope.clipMentorAnalysis!.blueprint.push(missingUnit);
narrowedScope.clipMentorAnalysis!.source_breakdown!.units.push({ ...structuredClone(b.units[0]), unit_id: 'U2' });
await assert.rejects(copyReviewSubject(narrowedScope), /copy_scope_incomplete/, 'imported incomplete units cannot disappear from an independent review');
await assert.rejects(copyTeachingPacketFromDoc(narrowedScope), /copy_scope_incomplete/);
assert.equal((await checkCopyProduction(narrowedScope, null)).allowed, false, 'a stored/imported narrowed subject cannot release production');
// A deliberately omitted optional unit is not forced to invent standalone narration.
const optionalUnit = narrowedScope.clipMentorAnalysis!.source_breakdown!.units[1];
optionalUnit.coverage = []; // no retained teaching task in this draft-only unit
assert.equal((await copyReviewSubject(narrowedScope)).units.length, 1);

// A picture plan may use lines for visual rows; it is not a disconnected copy candidate.
const visualRowsContext = context(base);
const visualRows: any = await executeTool('revise_clipmentor_analysis', { action: 'set_picture_plan', id: 'U1', expectedRevision: 1,
  actor, reason: 'Register a valid visual-row plan without changing copy', record: { plan_id: 'picture_plan_visual_rows', script_candidate_id: 'copy',
    line_guidance: 'Same copy, explicit visual rows', plan: { lines: [{ line_id: goodLine.line_id, source_seconds: [59.4, 62.2], picture: 'VALID_VISUAL_ROW' }] } } }, visualRowsContext.ctx);
assert(visualRows.ok, 'a bound current picture plan with visual lines is not new narration: ' + JSON.stringify(visualRows));
assert(JSON.stringify(await copyTeachingPacketFromDoc(visualRowsContext.draft.getDoc())).includes('VALID_VISUAL_ROW'), 'visual rows must reach independent review');
// A current picture plan cannot silently introduce a different narration.
for (const duplicateKey of ['lines', 'selected_narration']) {
  const currentLines = structuredClone((base.clipMentorAnalysis!.blueprint[0] as any).internal_review.copy.lines);
  const changedLines = structuredClone(currentLines);
  changedLines[0].narration_ms = 'New conflicting narration'; changedLines[0].caption_lines = ['New conflicting narration'];
  const conflicted = context(base), frozen = JSON.stringify(conflicted.draft.getDoc());
  const input = { action: 'set_picture_plan', id: 'U1', expectedRevision: 1, actor, reason: 'Guard duplicate narration',
    record: { plan_id: 'picture_plan_duplicate_check', script_candidate_id: 'copy', line_guidance: 'Same current copy', plan: { [duplicateKey]: changedLines } } };
  const refused: any = await executeTool('revise_clipmentor_analysis', input, conflicted.ctx);
  assert(refused.error?.includes('picture_plan_copy_mismatch'), 'a visual plan cannot save a different script: ' + duplicateKey);
  assert.equal(JSON.stringify(conflicted.draft.getDoc()), frozen);
  const valid = context(base);
  const allowed: any = await executeTool('revise_clipmentor_analysis', { ...input, record: { ...input.record, plan: { [duplicateKey]: currentLines } } }, valid.ctx);
  assert(allowed.ok, 'exact duplicate copy remains compatible');
  const imported = structuredClone(base), internal = (imported.clipMentorAnalysis!.blueprint[0] as any).internal_review;
  internal.current_picture_plan = 'picture_plan_conflicting_import';
  internal.picture_plan_conflicting_import = { script_candidate_id: 'copy', [duplicateKey]: changedLines };
  assert(checkSourceBreakdown(imported).issues.some(i => i.code === 'picture_plan_copy_mismatch'));
  await assert.rejects(copyTeachingPacketFromDoc(imported));
  const repair = context(imported);
  const repaired: any = await executeTool('revise_clipmentor_analysis', { ...input, record: { ...input.record, plan: { phases: [] } } }, repair.ctx);
  assert(repaired.ok, 'a saved/imported conflicting plan stays repairable without model calls');
}
const alternateCandidate: any = structuredClone(base.clipMentorAnalysis!.blueprint[0]);
alternateCandidate.internal_review.alternate = structuredClone(alternateCandidate.internal_review.copy);
const alternateContext = context(base);
const alternateSave: any = await executeTool('revise_clipmentor_analysis', { action: 'revise', collection: 'blueprint', id: 'U1',
  expectedRevision: 1, record: alternateCandidate, actor, reason: 'New copy under a different key' }, alternateContext.ctx);
assert(alternateSave.error?.includes('atomically'));
await verifyCopyCandidateCheckpoint(actor);

// Actual saved four-group registration must cross both the project ledger and
// reviewer projection, not just validate an already-projected review packet.
const groupedRegistration = JSON.parse(readFileSync(new URL('./fixtures/grouped-registration-v1.json', import.meta.url), 'utf8')) as ProjectDoc;
const { prepareProductionBlueprint } = await import('../../server/clipmentor/production-readiness');
assert.equal(checkSourceBreakdown(groupedRegistration).status, 'structurally_ready', 'four groups must not acquire a fictitious full-playback-first revisit');
const preparedGroup = await prepareProductionBlueprint(groupedRegistration);
assert.equal((preparedGroup.packet.units[0].picture_plan!.execution_plan!.content.phases as unknown[]).length, 9);
assert.equal(preparedGroup.packet.units[0].picture_plan!.registered_revisits.length, 5);
assert.equal((await checkCopyProduction(groupedRegistration, 'clipmentor')).allowed, false, 'valid grouped structure never replaces independent production approval');
const gInternal = (groupedRegistration.clipMentorAnalysis!.blueprint[0] as any).internal_review;
for (const change of [
  (doc: ProjectDoc) => { doc.clipMentorAnalysis!.source_breakdown!.units[0].revisits.pop(); },
  (doc: ProjectDoc) => { doc.clipMentorAnalysis!.source_breakdown!.units[0].original_source_ranges!.reverse(); },
  (doc: ProjectDoc) => { const i = (doc.clipMentorAnalysis!.blueprint[0] as any).internal_review; i[i.current_picture_plan].phases[1].line_id = 'missing'; },
  (doc: ProjectDoc) => { const i = (doc.clipMentorAnalysis!.blueprint[0] as any).internal_review; i[i.current_picture_plan].phases.splice(1, 1); },
  (doc: ProjectDoc) => { const i = (doc.clipMentorAnalysis!.blueprint[0] as any).internal_review; i[i.current_picture_plan].phases.pop(); },
  (doc: ProjectDoc) => { const i = (doc.clipMentorAnalysis!.blueprint[0] as any).internal_review; i[i.current_picture_plan].phases[0].mode = ['original']; },
  (doc: ProjectDoc) => { const i = (doc.clipMentorAnalysis!.blueprint[0] as any).internal_review; delete i[i.current_picture_plan].viewer_stage_cues; },
] ) {
  const invalid = structuredClone(groupedRegistration); change(invalid);
  await assert.rejects(prepareProductionBlueprint(invalid), 'invalid phases, cues and missing revisits must still block the actual product entry');
}
const artificialRevisit = structuredClone(groupedRegistration);
artificialRevisit.clipMentorAnalysis!.source_breakdown!.units[0].revisits.push({
  from_segment_id: 'BT-G4-original', to_segment_id: 'BT-explanation-BT-L01', reason: 'This full-first revisit is absent from the actual phases',
});
await assert.rejects(prepareProductionBlueprint(artificialRevisit), 'an extra invented revisit cannot satisfy the ledger at the expense of the real phase plan');
assert.equal(gInternal[gInternal.current_picture_plan].phases.length, 9, 'preparation does not mutate the frozen plan');

// Reproduce the actual export gate, not only the preparation projection: the
// old checker accepted grouped phases but still required every original first.
const groupedTimeline = structuredClone(groupedRegistration);
const gt = groupedTimeline.timelines.find(t => t.id === groupedTimeline.activeTimelineId)!;
const gi = (groupedTimeline.clipMentorAnalysis!.blueprint[0] as any).internal_review;
const gp = gi[gi.current_picture_plan];
const sourceId = groupedTimeline.clipMentorAnalysis!.source.asset_id;
const rows: any[] = [];
let cursor = 0;
for (const [index, phase] of gp.phases.entries()) {
  const source = phase.source_range_seconds.map((n: number) => Math.round(n * gt.fps));
  // A phase can span multiple adjacent clips (as the saved L03 does).
  const cuts = index === 5 ? [source[0], source[0] + 60, source[1]] : source;
  for (let part = 0; part < cuts.length - 1; part++) {
    const length = cuts[part + 1] - cuts[part];
    rows.push({ row_id: `phase-${index}-${part}`, unit_id: 'BT-U01', kind: phase.mode,
      source_asset_id: sourceId, source_frames: [cuts[part], cuts[part + 1]],
      output_frames_reference: [cursor, cursor + length], line_ids: phase.line_id ? [phase.line_id] : [] });
    cursor += length;
  }
}
function installRows(doc: ProjectDoc, selected: any[]) {
  const sourceId = doc.clipMentorAnalysis!.source.asset_id;
  const internal = (doc.clipMentorAnalysis!.blueprint[0] as any).internal_review;
  internal[internal.current_picture_plan].composition.detail = JSON.stringify({ production_rows: selected });
  const timeline = doc.timelines.find(t => t.id === doc.activeTimelineId)!;
  timeline.items = selected.map((r, i) => ({ id: `grouped-item-${i}`, kind: 'video', track: 'V1',
    sourceAssetId: sourceId, src: doc.assets.find(a => a.id === sourceId)!.src,
    startFrame: r.output_frames_reference[0], durationInFrames: r.output_frames_reference[1] - r.output_frames_reference[0],
    srcInFrame: r.source_frames[0], playbackRate: 1, volume: r.kind === 'original' ? 1 : 0 } as TimelineItem));
}
installRows(groupedTimeline, rows);
assert.equal(checkSourceBreakdown(groupedTimeline, true).status, 'structurally_ready',
  'the export checker must accept four original/explanation groups, including split explanation rows');
assert.equal((await checkCopyProduction(groupedTimeline, 'clipmentor')).allowed, false,
  'valid timeline order never fabricates production approval');
function reorderedRows(order: any[]) {
  let start = 0;
  return order.map(r => { const length = r.output_frames_reference[1] - r.output_frames_reference[0];
    const next = { ...structuredClone(r), output_frames_reference: [start, start + length] }; start += length; return next; });
}
for (const [label, order] of [
  ['explanation before its original', [rows[1], rows[0], ...rows.slice(2)]],
  ['all originals before all explanations', [...rows.filter(r => r.kind === 'original'), ...rows.filter(r => r.kind === 'explanation')]],
  ['explanation in another group', [rows[0], rows[3], rows[2], rows[1], ...rows.slice(4)]],
  ['G4 line order reversed', [...rows.slice(0, -2), rows.at(-1), rows.at(-2)]],
  ['original groups swapped', [rows[2], rows[1], rows[0], ...rows.slice(3)]],
] as Array<[string, any[]]>) {
  const bad = structuredClone(groupedTimeline); installRows(bad, reorderedRows(order));
  assert(checkSourceBreakdown(bad, true).issues.some(i => i.code === 'unit_output_order_invalid'), label);
}
const groupedMissing = structuredClone(groupedTimeline);
groupedMissing.timelines.find(t => t.id === gt.id)!.items.pop();
assert(checkSourceBreakdown(groupedMissing, true).issues.some(i => i.code === 'timeline_plan_picture_missing'));

// line_ids are references, not a second playback-order declaration. One clip
// can carry adjacent lines; order must follow phases and its covered intervals.
const sharedLastRow = { ...structuredClone(rows.at(-2)!), line_ids: ['BT-L04', 'BT-L06'] };
const returnedLine = structuredClone(groupedTimeline);
installRows(returnedLine, reorderedRows([...rows.slice(0, -2), sharedLastRow,
  { ...structuredClone(sharedLastRow), row_id: 'return-earlier-line', line_ids: ['BT-L04'] }]));
assert(checkSourceBreakdown(returnedLine, true).issues.some(i => i.code === 'unit_output_order_invalid'),
  'a shared row cannot conceal the earlier line continuing after the later line has finished');

for (const ids of [['BT-L04', 'BT-L06'], ['BT-L06', 'BT-L04']]) {
  const shared = structuredClone(groupedTimeline);
  installRows(shared, reorderedRows([...rows.slice(0, -2), { ...sharedLastRow, line_ids: ids }]));
  assert.equal(checkSourceBreakdown(shared, true).status, 'structurally_ready', 'shared picture reference order cannot change playback order');
}
const splitOriginal = structuredClone(groupedTimeline);
const first = rows[0];
installRows(splitOriginal, reorderedRows([
  { ...structuredClone(first), source_frames: [first.source_frames[0], 150], output_frames_reference: [0, 150] },
  { ...structuredClone(first), row_id: 'original-split-tail', source_frames: [150, first.source_frames[1]], output_frames_reference: [150, first.output_frames_reference[1]] },
  ...rows.slice(1),
]));
assert.equal(checkSourceBreakdown(splitOriginal, true).status, 'structurally_ready', 'contiguous split original clips are still one group');
for (const missing of [0, 3, 7, 9]) {
  const incomplete = structuredClone(groupedTimeline);
  installRows(incomplete, reorderedRows(rows.filter((_, i) => i !== missing)));
  assert.notEqual(checkSourceBreakdown(incomplete, true).status, 'structurally_ready', 'missing planned group/line must block: ' + missing);
}
const legacyRows = structuredClone(base);
const li = (legacyRows.clipMentorAnalysis!.blueprint[0] as any).internal_review;
li.current_picture_plan = 'picture_plan_legacy_rows';
li.picture_plan_legacy_rows = { script_candidate_id: 'copy', composition: { detail: '' } };
legacyRows.clipMentorAnalysis!.source_breakdown!.units[0].placement = { timeline_id: 'tl', original_frames: [0, 84], explanation_frames: [84, 168] };
const oldRows = ['original', 'explanation'].map((kind, i) => ({ row_id: `legacy-${kind}`, unit_id: 'U1', kind,
  source_asset_id: 'source', source_frames: [1782, 1866], output_frames_reference: [84 * i, 84 * (i + 1)],
  line_ids: i ? [goodLine.line_id] : [] }));
installRows(legacyRows, oldRows);
assert.equal(checkSourceBreakdown(legacyRows, true).status, 'structurally_ready', 'legacy all-original-then-explanation stays valid');
installRows(legacyRows, reorderedRows([...oldRows].reverse()));
assert(checkSourceBreakdown(legacyRows, true).issues.some(i => i.code === 'unit_output_order_invalid'), 'legacy reversed order still blocks');

assert.equal(networkCalls, 0);
// Keep the historical fixture portable and free of workstation paths or media bytes.
assert(!readFileSync(new URL('./fixtures/source-breakdown-v1r1.json', import.meta.url), 'utf8').includes('/Users/'));
console.log('Source breakdown: baseline, evidence separation, real v1r1 regression, derived ranges, review binding and both dispatchers passed; no model/TTS/render calls.');
