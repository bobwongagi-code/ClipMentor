import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { executeTool } from '../agent/tools';
import { executeOfflineTool } from '../../server/external-agent/offline-executor';
import type { AgentContext } from '../agent/context';
import type { ProjectDoc } from '../editor/types';
import { makeDraft } from '../editor/store';
import { migrateProjectDoc } from '../persist/projectStore';
import { importTeashellAnalysis } from './import-teashell';
import { isClipMentorAnalysis } from './analysis';
import blindRegression from './fixtures/copy-review-blind-20261019.json';
import teachingRegression from './fixtures/copy-teaching-blind-v2-20261019.json';
import { bindCopyProductionReview, checkCopyProduction, copyReviewCalibration, copyReviewSubject, isCopyProductionReview, isReviewedNarrationText, COPY_REVIEW_PROTOCOL, assessTeachingReview, buildCopyTeachingReviewRequest, legacyCopyReviewCalibration, clipMentorProductionBlock, copyTeachingPacketFromDoc, type TeachingPacket, type TeachingEnvelope, assessNarrationChecks, checkCopyFindingQuotes } from './production-gate';

const calibration = copyReviewCalibration();
assert.equal(calibration.protocol, COPY_REVIEW_PROTOCOL);
if (process.argv.includes('--calibration')) {
  console.log(JSON.stringify(calibration, null, 2));
  assert(calibration.qualified, 'Teaching review qualification requires both negative cases and positive controls to match.');
  process.exit(0);
}
let networkCalls = 0;
globalThis.fetch = (async () => { networkCalls++; throw new Error('Unexpected network in gate test'); }) as typeof fetch;
const fixture = JSON.parse(readFileSync(new URL('./fixtures/teashell-historical.json', import.meta.url), 'utf8'));
const actor = { operator: 'synthetic-test-only', executor: 'test-author', instruction: 'No production approval', identity: 'local_declared_not_authenticated' as const };
const analysis = importTeashellAnalysis(fixture, 'source', actor, 1);
const positiveOracle = teachingRegression.regression_oracles.find((o) => o.label === 'qualified_scent_excerpt_from_revision95')!;
const positiveCase = teachingRegression.blind_input.cases.find((c) => c.case_id === positiveOracle.case_id)!;
const positiveRaw = teachingRegression.raw_review.cases.find((c) => c.case_id === positiveOracle.case_id)!;
const goodLine = positiveCase.packet.units[0].lines[0];
for (const b of analysis.blueprint) Object.assign(b, { internal_review: {
  current_script_candidate: 'test-candidate',
  'test-candidate': { lines: [{ id: goodLine.line_id, point_ids: [b.point_ids[0]],
    narration_ms: goodLine.narration_ms, caption_lines: goodLine.caption_lines,
    zh: goodLine.meaning_zh, labels: goodLine.labels, source_seconds: [59.4, 62.2] }] },
} });
// Synthetic plan uses the same scoped positive in each unit to test policy, not analysis quality.
analysis.source_breakdown = {
  version: 1, review_scope: { kind: 'local_ranges', source_ranges: [[59.4, 62.2]], instruction: 'Synthetic scoped teaching test' },
  segments: [{ segment_id: 'smell', source_range_seconds: [59.4, 62.2], visible_evidence_ids: ['TS-F1800'], claim_evidence_ids: [], interpretation_evidence_ids: [], unknowns: ['Actual scent evaluation is unverified'] }],
  points: analysis.blueprint.map((u) => ({ point_id: u.point_ids[0], segment_ids: ['smell'], buying_concern: 'Use experience',
    teaching_question: positiveCase.packet.units[0].points[0].question, filming_conditions: ['Near-nose gesture in use'], role: 'primary', importance: 'must_explain' })),
  units: analysis.blueprint.map((u) => ({ unit_id: u.unit_id, original_segment_ids: ['smell'], explanation_segment_ids: ['smell'],
    coverage: [{ point_id: u.point_ids[0], treatment: 'explain' }], revisits: [{ from_segment_id: 'smell', to_segment_id: 'smell', reason: 'Revisit gesture for explanation' }] })),
};
const base: ProjectDoc = {
  version: 3, assets: [{ id: 'source', name: 'test', kind: 'video', src: '/media/test.mp4', durationInFrames: 2996, sourceContentHash: analysis.source.sourceContentHash! }], mediaFolders: [],
  timelines: [{ id: 'tl', name: 'test', order: 0, fps: 30, width: 576, height: 1024, items: [], selectedId: null,
    tracks: { track_v1: { kind: 'video' } }, trackOrder: ['track_v1'] }], activeTimelineId: 'tl', clipMentorAnalysis: analysis,
};
function context(doc: ProjectDoc, mode: string | null = 'clipmentor') {
  const draft = makeDraft(structuredClone(doc));
  const ctx: AgentContext = { ...draft, getCreativeMode: () => mode, templates: [], audio: [] };
  return { ctx, draft };
}
// Run this assertion against the old entry points first: it MUST fail because the
// real set_aspect_ratio handler used to mutate the draft without any copy gate.
for (const executor of [executeOfflineTool, executeTool]) {
  const { ctx, draft } = context(base);
  const before = JSON.stringify(draft.getDoc());
  const result = await executor('set_aspect_ratio', { ratio: '1:1' }, ctx) as { error?: string; production_gate?: { code: string } };
  assert.equal(result.production_gate?.code, 'copy_review_missing', 'unreviewed REAL dispatcher must refuse before the edit handler');
  assert.equal(JSON.stringify(draft.getDoc()), before);
  assert.equal(draft.takeActions().length, 0);
}

assert.equal(await clipMentorProductionBlock('manage_timelines', { action: 'list' }, context(base).ctx), null, 'valid read-only action remains preparation');
assert.equal((await clipMentorProductionBlock('manage_timelines', { action: ['list'] }, context(base).ctx))?.production_gate.code,
  'copy_review_missing', 'coerced read action must not bypass production validation');

const subject = await copyReviewSubject(base);
assert(isReviewedNarrationText(subject, subject.units[0].narration[0]));
assert(isReviewedNarrationText(subject, `  ${subject.units[0].narration[0].replaceAll(' ', '\n')}  `));
assert(!isReviewedNarrationText(subject, 'Dia dekatkan'));
assert(!isReviewedNarrationText(subject, `${subject.units[0].narration[0]} Extra promise.`));
assert(!isReviewedNarrationText(subject, ''));
const teaching: TeachingEnvelope = {
  packet: await copyTeachingPacketFromDoc(base),
  review: { units: subject.units.map((u, i) => ({ unit_id: u.unit_id, points: [{
    ...structuredClone(positiveRaw.units[0].points[0]), point_id: analysis.blueprint[i].point_ids[0],
  }] })) } as TeachingEnvelope['review'],
};
assert.equal(assessTeachingReview(teaching.packet, teaching.review).verdict, 'pass');
const criteriaRequest = buildCopyTeachingReviewRequest([{ case_id: 'criteria-wiring-test', packet: teaching.packet }]);
for (const question of ['', '  ', null, ['question']]) {
  const invalid = structuredClone(teaching.packet);
  Object.assign(invalid.units[0].points[0], { question });
  assert.throws(() => buildCopyTeachingReviewRequest([{ case_id: 'missing-goal', packet: invalid }]));
}
const absentEvidence = structuredClone(teaching.packet);
absentEvidence.units[0].points[0].evidence_ids = ['NOT_REGISTERED'];
assert.throws(() => buildCopyTeachingReviewRequest([{ case_id: 'missing-evidence', packet: absentEvidence }]));
assert(criteriaRequest.instructions.includes('planned_group_teaching_only'));
assert(criteriaRequest.instructions.includes('逐句结合整组检验旁白必要性'));
assert(criteriaRequest.instructions.includes('分类不是旁白必要性的豁免'));
assert(criteriaRequest.instructions.includes('固定3/5秒或40%/60%占比'));
assert.equal(criteriaRequest.input.cases[0].packet.units[0].points[0].question,
  teaching.packet.units[0].points[0].question, 'registered teaching goal/question is carried unchanged, not supplied by the host');

// Handoff projection is tested before any paid review: synthetic four-group controls.
const phasePacket = structuredClone(teaching.packet);
const phaseUnit = phasePacket.units[0];
phaseUnit.lines = [phaseUnit.lines[0]];
const phaseLine = phaseUnit.lines[0].line_id;
const groupRanges: Array<[number, number]> = [[0, 10], [10, 19], [19, 28], [28, 37]];
phaseUnit.picture_plan = {
  original_source_ranges: groupRanges, explanation_source_ranges: groupRanges,
  line_source_ranges: [{ line_id: phaseLine, source_range_seconds: [0, 37] }],
  registered_revisits: groupRanges.map(range => ({ from_source_range: range, to_source_range: range })),
  execution_plan: { plan_id: 'synthetic-group-plan', script_candidate_id: 'test-candidate', content: {
    phases: groupRanges.flatMap(range => [
      { mode: 'original', source_range_seconds: range, picture: 'Original demonstration', purpose: 'Show this group' },
      { mode: 'explanation', line_id: phaseLine, source_range_seconds: range, picture: 'Revisit this group' },
    ]),
    viewer_stage_cues: {
      original: { text: 'Video asal', enter: 'each original start', exit: 'before its explanation' },
      revisit: [{ line_ids: [phaseLine], text: 'Ulasan semula', enter: 'each explanation start', exit: 'before next original' }],
      handoff: 'Original then explanation, four groups in phase order',
    },
  } },
};
const phaseRequest = () => buildCopyTeachingReviewRequest([{ case_id: 'group-projection', packet: phasePacket }]);
const phaseProjection = phaseRequest().input.cases[0].packet.units[0].picture_plan!;
assert.deepEqual(phaseProjection.execution_plan!.content, phaseUnit.picture_plan.execution_plan!.content);
assert.deepEqual(phaseProjection.registered_revisits, phaseUnit.picture_plan.registered_revisits);
// Metadata must still be stripped; retaining operational data must not leak author judgments.
Object.assign((phaseUnit.picture_plan.execution_plan!.content.phases as any[])[0], { self_review: 'AUTHOR_PHASE_VERDICT' });
assert(!JSON.stringify(phaseRequest()).includes('AUTHOR_PHASE_VERDICT'));
for (const [name, change, code] of [
  ['empty projected phase', (v: any) => { v.execution_plan.content.phases[0] = { kind: 'original', group: 'G1', source_frames: [0, 300] }; }, /picture_plan_phase_empty/],
  ['partly lost phase', (v: any) => { v.execution_plan.content.phases[0].source_frames = [0, 300]; }, /picture_plan_phase_field_unsupported/],
  ['old full-playback revisit', (v: any) => { v.registered_revisits = [{ from_source_range: [0, 37], to_source_range: [0, 10] }]; }, /picture_plan_revisits_mismatch/],
  ['reordered original ranges', (v: any) => { v.original_source_ranges.reverse(); }, /picture_plan_original_order_mismatch/],
  ['missing stage cue', (v: any) => { delete v.execution_plan.content.viewer_stage_cues; }, /picture_plan_stage_cues_missing/],
  ['coerced phase mode', (v: any) => { v.execution_plan.content.phases[0].mode = ['original']; }, /picture_plan_phase_mode_invalid/],
  ['unknown line binding', (v: any) => { v.execution_plan.content.phases[1].line_id = 'missing-line'; }, /picture_plan_phase_line_invalid/],
  ['all modes coerced', (v: any) => { for (const p of v.execution_plan.content.phases) p.mode = [p.mode]; }, /picture_plan_phase_mode_invalid/],
  ['missing group explanation', (v: any) => { v.execution_plan.content.phases.splice(1, 1); }, /picture_plan_group_explanation_missing/],
  ['missing last explanation', (v: any) => { v.execution_plan.content.phases.pop(); }, /picture_plan_group_explanation_missing/],
  ['wrong phase range type', (v: any) => { v.execution_plan.content.phases[0].source_range_seconds = ['0', 10]; }, /picture_plan_phase_range_invalid/],
] as const) {
  const bad = structuredClone(phasePacket); change(bad.units[0].picture_plan);
  assert.throws(() => buildCopyTeachingReviewRequest([{ case_id: name, packet: bad }]), code, name);
}
// Existing non-group layouts remain valid and do not acquire new timing obligations.
assert.doesNotThrow(() => buildCopyTeachingReviewRequest([{case_id:'existing-control',packet:teaching.packet}]));

// Counterfactual inputs are derived from actual group IDs, never authored loss claims.
const multiLinePacket = structuredClone(teaching.packet);
const firstUnit = multiLinePacket.units[0];
firstUnit.lines.push({ ...structuredClone(firstUnit.lines[0]), line_id: 'second-line',
  labels: ['independent-visible-label'] });
(firstUnit as unknown as Record<string, unknown>).omission_views = [{ target_line_id: 'FORGED', remaining_line_ids: [] }];
const packetBeforeOmission = JSON.stringify(multiLinePacket);
const omissionRequest = buildCopyTeachingReviewRequest([{ case_id: 'omission-test', packet: multiLinePacket }]);
const omissionUnit = omissionRequest.input.cases[0].packet.units[0];
assert.deepEqual(omissionUnit.omission_views, firstUnit.lines.map((line) => ({
  target_line_id: line.line_id, remaining_line_ids: firstUnit.lines.filter((other) => other.line_id !== line.line_id).map((other) => other.line_id),
})), 'remove exactly the target narration/captions, retain the other lines of THIS unit');
assert.deepEqual(omissionUnit.points, criteriaRequest.input.cases[0].packet.units[0].points, 'counterfactual deletion does not delete or downgrade selected points');
for (const unit of omissionRequest.input.cases[0].packet.units.slice(1)) {
  assert.deepEqual(unit.omission_views, unit.lines.map((line) => ({ target_line_id: line.line_id,
    remaining_line_ids: unit.lines.filter((other) => other.line_id !== line.line_id).map((other) => other.line_id) })), "a deletion in one unit never leaks another unit's lines, even when line IDs repeat across units");
  assert(!unit.omission_views.some((view) => view.remaining_line_ids.includes('second-line')));
}

assert.deepEqual(omissionUnit.lines.map((line) => line.labels), firstUnit.lines.map((line) => line.labels), 'independent visible labels remain');
assert.equal(JSON.stringify(multiLinePacket), packetBeforeOmission, 'request generation must not edit a draft or supplied material');
assert.deepEqual(omissionUnit.picture_plan, criteriaRequest.input.cases[0].packet.units[0].picture_plan, 'original/explanation ranges and planned pictures do not disappear with a voiceover line');
const sharedPointDoc = structuredClone(base);
const sharedAnalysis = sharedPointDoc.clipMentorAnalysis!;
const sharedUnit = sharedAnalysis.source_breakdown!.units[0];
const sharedPoint = { ...structuredClone(sharedAnalysis.source_breakdown!.points[0]), point_id: 'shared-auxiliary', role: 'auxiliary' as const };
sharedAnalysis.source_breakdown!.points.push(sharedPoint);
sharedUnit.coverage.push({ point_id: sharedPoint.point_id, treatment: 'merged', merged_into_point_id: sharedUnit.coverage[0].point_id,
  reason: 'Synthetic mapping test only: retain both points without requiring a second independent voiceover line' });
const sharedBlueprint = sharedAnalysis.blueprint[0] as unknown as Record<string, any>;
sharedBlueprint.point_ids.push(sharedPoint.point_id);
sharedBlueprint.internal_review['test-candidate'].lines[0].point_ids.push(sharedPoint.point_id);
const sharedPacket = await copyTeachingPacketFromDoc(sharedPointDoc);
const sharedRequest = buildCopyTeachingReviewRequest([{ case_id: 'shared-point-mapping-test', packet: sharedPacket }]);
assert.equal(sharedRequest.input.cases[0].packet.units[0].points.length, 2);
assert.equal(sharedRequest.input.cases[0].packet.units[0].lines.length, 1, 'retained required points can share a spoken line; this is not semantic approval of the merge');
assert(sharedAnalysis.source_breakdown!.points.every((point) => point.importance === 'must_explain'));

// A selected visual-only point stays in the review without inventing a spoken reference.
// Synthetic policy fixtures only: these checks do not establish real teaching quality.
const visualDoc = structuredClone(base);
const va = visualDoc.clipMentorAnalysis!;
const visualPointId = 'visual-auxiliary';
va.source_breakdown!.points.push({ ...structuredClone(va.source_breakdown!.points[0]),
  point_id: visualPointId, role: 'auxiliary' });
va.source_breakdown!.units[0].coverage.push({ point_id: visualPointId, treatment: 'visual_only',
  reason: 'AUTHOR_VISUAL_REASON: selected gesture remains visible; its standalone narration is not established' });
va.blueprint[0].point_ids.push(visualPointId);
const visualPacket = await copyTeachingPacketFromDoc(visualDoc);
assert.doesNotThrow(() => buildCopyTeachingReviewRequest([{ case_id: 'visual-only', packet: visualPacket }]),
  'a registered picture-only point must reach review without a fabricated narration link');
const visualPoint = visualPacket.units[0].points.find(p => p.point_id === visualPointId)!;
assert.equal(visualPoint.treatment, 'visual_only');
assert(visualPoint.treatment_reason!.includes('AUTHOR_VISUAL_REASON'), 'retain the actual author decision for provenance');
assert(visualPoint.visual_evidence!.length > 0, 'source ranges and visible evidence must remain bound');
const visualRequest = buildCopyTeachingReviewRequest([{ case_id: 'visual-only', packet: visualPacket }]);
assert(!JSON.stringify(visualRequest).includes('AUTHOR_VISUAL_REASON'), 'author reasons must not become the independent reviewer verdict');
assert.equal(visualRequest.input.cases[0].packet.units[0].points.length, 2, 'never drop the picture-only task from the review');
const slot = visualPoint.visual_evidence![0];
const visualReview = structuredClone(teaching.review);
visualReview.units[0].points.push({ ...structuredClone(visualReview.units[0].points[0]),
  point_id: visualPointId, connection: 'auxiliary_transition', basis: 'within_unit', quotes: [],
  visual_check: { evidence_refs: [{ segment_id: slot.segment_id, phase: slot.phase,
    evidence_id: slot.evidence_ids[0], source_range_seconds: [...slot.source_range_seconds] }],
    observed_relation: 'Synthetic selected gesture in the mapped source window', sufficiency: 'sufficient',
    omission_loss: 'Synthetic control: the group retains its instruction and this visual relation without a separate spoken line' } });
assert.equal(assessTeachingReview(visualPacket, visualReview).verdict, 'pass', 'supported visual coverage is not blanket-rejected');
for (const mutate of [
  (p: any) => { delete p.visual_check; },
  (p: any) => { p.visual_check.evidence_refs = []; },
  (p: any) => { p.visual_check.evidence_refs[0].evidence_id = 'unrelated-or-missing'; },
  (p: any) => { p.visual_check.evidence_refs[0].source_range_seconds = [0, 1]; },
  (p: any) => { p.visual_check.evidence_refs[0].phase = 'not-a-phase'; },
  (p: any) => { p.visual_check.omission_loss = ''; },
  (p: any) => { p.visual_check.sufficiency = 'uncertain'; },
  (p: any) => { p.source_support = 'uncertain'; },
]) {
  const bad = structuredClone(visualReview); mutate(bad.units[0].points.at(-1));
  assert.equal(assessTeachingReview(visualPacket, bad).verdict, 'insufficient_evidence');
}
const needsWords = structuredClone(visualReview);
needsWords.units[0].points.at(-1)!.visual_check!.sufficiency = 'needs_explanation';
assert.equal(assessTeachingReview(visualPacket, needsWords).verdict, 'needs_revision');
for (const invalid of [['sufficient'], [['sufficient']], null, {}, 0, true]) {
  const bad = structuredClone(visualReview);
  Object.assign(bad.units[0].points.at(-1)!.visual_check!, { sufficiency: invalid });
  assert.equal(assessTeachingReview(visualPacket, bad).verdict, 'insufficient_evidence', 'no enum coercion');
}
for (const mutate of [
  (p: any) => { p.visual_evidence = []; },
  (p: any) => { p.treatment_reason = ''; },
  (p: any) => { p.visual_evidence[0].evidence_ids = ['unrelated-or-missing']; },
  (p: any) => { p.visual_evidence[0].source_range_seconds = [0, 1]; },
  (p: any) => { p.treatment = ['visual_only']; },
]) {
  const bad = structuredClone(visualPacket); mutate(bad.units[0].points.at(-1));
  assert.throws(() => buildCopyTeachingReviewRequest([{ case_id: 'bad-visual', packet: bad }]));
}
const forgedNarrationOnly = structuredClone(teaching.review);
forgedNarrationOnly.units[0].points[0].quotes = [];
Object.assign(forgedNarrationOnly.units[0].points[0], { visual_check: visualReview.units[0].points.at(-1)!.visual_check });
assert.equal(assessTeachingReview(teaching.packet, forgedNarrationOnly).verdict, 'insufficient_evidence',
  'visual support cannot waive a spoken point quote');

for (const unit of criteriaRequest.input.cases[0].packet.units) {
  assert.deepEqual(unit.omission_views, [{ target_line_id: unit.lines[0].line_id, remaining_line_ids: [] }], 'single-line groups still retain evidence, points and picture; zero remaining narration is not invalid');
}
assert(omissionRequest.instructions.includes('删去目标口播及其同文字幕'));
assert(omissionRequest.instructions.includes('重点保留不等于每个重点独占一句旁白'));
assert(omissionRequest.instructions.includes('有表达作用不等于值得独立占用旁白'));

const receipt = await bindCopyProductionReview(base, {
  teaching_review: teaching,
  analysis_revision: subject.revision, content_digest: subject.digest,
  author_run_id: 'test-author', reviewer_run_id: 'test-independent-reviewer', reviewed_at: 1, verdict: 'pass',
  units: subject.units.map((u) => ({ unit_id: u.unit_id, candidate_id: u.candidate_id, verdict: 'pass', findings: [],
    group_checks: { scope: 'planned_group_teaching_only',
      source_relations: [{ relation: 'Synthetic source relation', evidence_ids: [teaching.packet.units.find(v => v.unit_id === u.unit_id)!.source_context!.evidence_ids[0]], point_ids: u.lines[0].point_ids, line_ids: [u.lines[0].line_id], assessment: 'covered', reason: 'Synthetic protocol fixture only' }],
      L1: { verdict: 'pass', learner_takeaway: 'Synthetic group teaching relation', reason: 'Synthetic complete selected-point coverage, not a quality oracle' },
      L2: { verdict: 'pass', viewer_chain: 'Synthetic original then explanation', stage_cues: 'Synthetic visible revisit label', reason: 'Synthetic planned handoff, not rendered viewing' } },
    narration_checks: u.lines.map((l) => ({ line_id: l.line_id, necessity: 'necessary', omission_loss: 'Synthetic test: use-experience relation',
      naturalness: 'natural', reason: 'Synthetic policy positive, not a naturalness certification' })) })),
});
const approved = structuredClone(base);
approved.clipMentorAnalysis!.production_copy_review = receipt;
assert(isClipMentorAnalysis(approved.clipMentorAnalysis));
assert.deepEqual(migrateProjectDoc(JSON.parse(JSON.stringify(approved)))?.clipMentorAnalysis?.production_copy_review, receipt, 'save/reopen migration preserves a typed receipt');
assert.equal((await checkCopyProduction(base, null)).code, 'copy_review_missing', 'changing creative mode does not bypass project-owned analysis');
assert.equal((await checkCopyProduction(approved, null)).code, 'copy_and_plan_ready', 'a complete reviewed positive must not be blanket-blocked');
const historicalGroupMissing = structuredClone(approved);
delete historicalGroupMissing.clipMentorAnalysis!.production_copy_review!.units[0].group_checks;
assert(isCopyProductionReview(historicalGroupMissing.clipMentorAnalysis!.production_copy_review), 'old receipts stay readable without fabricated group checks');
assert.equal((await checkCopyProduction(historicalGroupMissing, null)).code, 'copy_group_review_not_passed',
  'per-point and per-line passes cannot substitute for missing whole-group review');
for (const layer of ['L1', 'L2'] as const) {
  for (const verdict of ['needs_revision', 'insufficient_evidence'] as const) {
    const failedGroup = structuredClone(approved);
    const saved = failedGroup.clipMentorAnalysis!.production_copy_review!;
    saved.units[0].group_checks![layer].verdict = verdict;
    const checked = await checkCopyProduction(failedGroup, null);
    assert.equal(checked.code, 'copy_group_review_not_passed');
    assert('group_layer' in checked && 'group_verdict' in checked);
    assert.equal(checked.group_layer, layer);
    assert.equal(checked.group_verdict, verdict);
    for (const executor of [executeTool, executeOfflineTool]) {
      const { ctx, draft } = context(failedGroup);
      const before = JSON.stringify(draft.getDoc());
      for (const tool of ['submit_voice', 'set_aspect_ratio']) {
        const blocked = await executor(tool, { text: goodLine.narration_ms, ratio: '1:1' }, ctx) as { production_gate?: { code: string } };
        assert.equal(blocked.production_gate?.code, 'copy_group_review_not_passed');
      }
      assert.equal(JSON.stringify(draft.getDoc()), before);
      assert.equal(draft.takeActions().length, 0);
    }
    const read = await executeTool('read_clipmentor_analysis', { view: 'copy_review' }, context(failedGroup).ctx) as any;
    assert.deepEqual(read.analysis.copy_review.receipt.units[0].group_checks, saved.units[0].group_checks);
    assert.equal(read.production_gate.allowed, false);
  }
}
for (const change of [
  (g: any) => { g.scope = 'rendered_preview'; },
  (g: any) => { g.L1.verdict = ['pass']; },
  (g: any) => { g.L2.verdict = null; },
  (g: any) => { g.L1.learner_takeaway = ' '; },
  (g: any) => { g.L1.reason = []; },
  (g: any) => { g.L2.viewer_chain = ''; },
  (g: any) => { g.L2.stage_cues = null; },
  (g: any) => { delete g.L2.reason; },
]) {
  const invalid = structuredClone(approved);
  change(invalid.clipMentorAnalysis!.production_copy_review!.units[0].group_checks);
  assert(!isCopyProductionReview(invalid.clipMentorAnalysis!.production_copy_review));
  assert.equal((await checkCopyProduction(invalid, null)).code, 'copy_review_invalid');
}
const visualSubject = await copyReviewSubject(visualDoc);
const visualReceipt = await bindCopyProductionReview(visualDoc, { ...structuredClone(receipt),
  analysis_revision: visualSubject.revision, content_digest: visualSubject.digest,
  teaching_review: { packet: visualPacket, review: visualReview } });
const visualApproved = structuredClone(visualDoc);
visualApproved.clipMentorAnalysis!.production_copy_review = visualReceipt;
assert.equal((await checkCopyProduction(visualApproved, null)).code, 'copy_and_plan_ready');
for (const sufficiency of ['uncertain', 'needs_explanation'] as const) {
  const blockedVisual = structuredClone(visualApproved);
  blockedVisual.clipMentorAnalysis!.production_copy_review!.teaching_review!.review.units[0].points.at(-1)!.visual_check!.sufficiency = sufficiency;
  assert.equal((await checkCopyProduction(blockedVisual, null)).code, 'copy_teaching_review_not_passed');
  for (const executor of [executeTool, executeOfflineTool]) {
    const { ctx, draft } = context(blockedVisual);
    for (const tool of ['submit_voice', 'set_aspect_ratio']) {
      const result = await executor(tool, { ratio: '1:1', text: goodLine.narration_ms }, ctx) as { production_gate?: { code: string } };
      assert.equal(result.production_gate?.code, 'copy_teaching_review_not_passed');
    }
    assert.equal(draft.takeActions().length, 0);
  }
}
const missingVisualPoint = structuredClone(visualApproved);
missingVisualPoint.clipMentorAnalysis!.production_copy_review!.teaching_review!.packet.units[0].points.pop();
assert.equal((await checkCopyProduction(missingVisualPoint, null)).code, 'copy_teaching_ledger_mismatch',
  'removing a retained visual task from the receipt cannot authorize production');

const quoteLines = [
  { ...goodLine, narration_ms: 'Dia tunjuk contoh ini.', caption_lines: ['Lihat tangan', 'dalam bingkai.'], meaning_zh: '她展示这个例子。', labels: ['Dalam satu bingkai'] },
  { ...goodLine, line_id: 'quote-line-2', narration_ms: 'Kemudian dia sambung.', caption_lines: ['Teruskan pemerhatian.'], labels: [] },
];
for (const quote of ['Dia tunjuk contoh ini.', 'tunjuk contoh', '\nDia  tunjuk\tcontoh ini. ',
  'tangan dalam bingkai.', 'Dalam satu bingkai', 'contoh ini. Kemudian dia sambung.']) {
  assert(checkCopyFindingQuotes(quoteLines, [{ severity: 'suggestion', quote, reason: 'Synthetic exact source text' }]).valid,
    'exact fragments, whitespace, caption wrapping, labels and consecutive lines remain quotable');
}
for (const quote of ['她展示这个例子。', 'OTHER UNIT COPY', 'OLD DRAFT COPY', 'ini. Lihat tangan', '', '  ', ['Dia tunjuk contoh ini.'], null]) {
  assert(!checkCopyFindingQuotes(quoteLines, [{ severity: 'suggestion', quote, reason: 'Synthetic invalid quote' }]).valid,
    'Chinese meaning, other units, history, cross-channel splicing and non-text quotes cannot substantiate a finding');
}
assert(checkCopyFindingQuotes(quoteLines, []).valid, 'no findings remains a valid positive control');
assert(!checkCopyFindingQuotes(quoteLines, null).valid);
for (const severity of ['blocking', 'suggestion', 'unknown'] as const) {
  const unanchored = structuredClone(approved);
  unanchored.clipMentorAnalysis!.production_copy_review!.units[0].findings = [
    { severity, quote: 'THIS QUOTE IS NOT IN THE CURRENT COPY', reason: 'Synthetic unmatched finding in a stored receipt' },
  ];
  const checked = await checkCopyProduction(unanchored, null);
  assert.equal(checked.code, 'copy_finding_evidence_invalid', 'stored receipts must revalidate their finding quotes, not trust the old pass');
  assert.equal(checked.allowed, false);
  const reopened = migrateProjectDoc(JSON.parse(JSON.stringify(unanchored)))!;
  assert.equal((await checkCopyProduction(reopened, null)).code, 'copy_finding_evidence_invalid', 'save/reopen cannot rehabilitate the quote');
  const read = await executeTool('read_clipmentor_analysis', { view: 'copy_review' }, context(unanchored).ctx) as {
    analysis: { copy_review: { receipt: { verdict: string } } }; production_gate: { code: string };
  };
  assert.equal(read.analysis.copy_review.receipt.verdict, 'pass', 'historical raw verdict remains readable');
  assert.equal(read.production_gate.code, 'copy_finding_evidence_invalid');
  for (const executor of [executeTool, executeOfflineTool]) {
    const { ctx, draft } = context(unanchored);
    const before = JSON.stringify(draft.getDoc());
    for (const tool of ['submit_voice', 'set_aspect_ratio']) {
      const blocked = await executor(tool, { text: goodLine.narration_ms, ratio: '1:1' }, ctx) as { production_gate?: { code: string } };
      assert.equal(blocked.production_gate?.code, 'copy_finding_evidence_invalid');
    }
    assert.equal(JSON.stringify(draft.getDoc()), before, 'invalid evidence blocks before any media or timeline mutation');
  }
}
for (const kind of ['missing', 'duplicate', 'redundant', 'awkward', 'uncertain', 'missing_loss', 'null_necessity'] as const) {
  const deficient = structuredClone(approved);
  const u = deficient.clipMentorAnalysis!.production_copy_review!.units[0];
  if (kind === 'missing') delete u.narration_checks;
  else if (kind === 'duplicate') u.narration_checks!.push(u.narration_checks![0]);
  else if (kind === 'redundant') u.narration_checks![0].necessity = 'redundant';
  else if (kind === 'awkward') u.narration_checks![0].naturalness = 'awkward';
  else if (kind === 'missing_loss') u.narration_checks![0].omission_loss = ' ';
  else if (kind === 'null_necessity') Object.assign(u.narration_checks![0], { necessity: null });
  else u.narration_checks![0].naturalness = 'uncertain';
  assert.equal((await checkCopyProduction(deficient, null)).code,
    kind === 'missing_loss' || kind === 'null_necessity' ? 'copy_review_invalid' : 'copy_narration_review_not_passed');
}
assert.equal(assessNarrationChecks(subject.units[0].lines, receipt.units[0].narration_checks).verdict, 'pass');

// JSON enum fields must be scalar strings, never coercible arrays or other values.
for (const field of ['necessity', 'naturalness'] as const) {
  for (const scalar of field === 'necessity' ? ['necessary', 'redundant', 'uncertain'] : ['natural', 'awkward', 'uncertain']) {
    const valid = structuredClone(receipt.units[0].narration_checks!);
    Object.assign(valid[0], { [field]: scalar });
    assert.equal(assessNarrationChecks(subject.units[0].lines, valid).verdict,
      scalar === 'redundant' || scalar === 'awkward' ? 'needs_revision' : scalar === 'uncertain' ? 'insufficient_evidence' : 'pass');
    for (const invalid of [[scalar], [[scalar]], null, {}, true, 0]) {
      const checks = structuredClone(valid); Object.assign(checks[0], { [field]: invalid });
      assert.equal(assessNarrationChecks(subject.units[0].lines, checks).verdict, 'insufficient_evidence', `${field} cannot coerce ${JSON.stringify(invalid)}`);
      const malformed = structuredClone(approved);
      malformed.clipMentorAnalysis!.production_copy_review!.units[0].narration_checks = checks;
      assert(!isCopyProductionReview(malformed.clipMentorAnalysis!.production_copy_review));
      assert.equal((await checkCopyProduction(malformed, null)).code, 'copy_review_invalid');
      const blocked = await executeTool('submit_voice', {}, context(malformed).ctx) as { production_gate?: { code: string } };
      assert.equal(blocked.production_gate?.code, 'copy_review_invalid', 'invalid enum cannot reach production tools');
    }
  }
}
for (const [field, allowed] of [
  ['connection', ['purchase_connected', 'function_only', 'action_only', 'supporting_context', 'auxiliary_transition', 'not_explained']],
  ['basis', ['in_copy', 'within_unit', 'background_only', 'none']],
  ['source_support', ['supported', 'uncertain', 'contradicted']],
  ['meaning_alignment', ['aligned', 'uncertain', 'misaligned']],
] as const) {
  for (const invalid of [...allowed.map(v => [v]), ...allowed.map(v => [[v]]), null, {}, true, 0]) {
    const raw = structuredClone(teaching.review); Object.assign(raw.units[0].points[0], { [field]: invalid });
    assert.equal(assessTeachingReview(teaching.packet, raw).verdict, 'insufficient_evidence', `invalid teaching ${field}`);
  }
}
for (const target of ['root_verdict', 'unit_verdict', 'severity', 'channel', 'role'] as const) {
  const malformed = structuredClone(receipt);
  if (target === 'root_verdict') Object.assign(malformed, { verdict: ['pass'] });
  if (target === 'unit_verdict') Object.assign(malformed.units[0], { verdict: ['pass'] });
  if (target === 'severity') malformed.units[0].findings.push({ severity: ['blocking'] as unknown as 'blocking', quote: 'test', reason: 'test' });
  if (target === 'channel') Object.assign(malformed.teaching_review!.review.units[0].points[0].quotes[0], { channel: ['narration'] });
  if (target === 'role') Object.assign(malformed.teaching_review!.packet.units[0].points[0], { role: ['primary'] });
  assert(!isCopyProductionReview(malformed), `invalid receipt ${target}`);
}

assert.equal((await checkCopyProduction(approved, null, { ...calibration, qualified: false })).code, 'copy_review_method_unqualified');
// Synthetic qualified method tests ONLY the policy's positive branch. It is never
// passed to either real dispatcher and is not a production review qualification.
const syntheticQualified = { ...calibration, qualified: true };
assert.equal((await checkCopyProduction(approved, null, syntheticQualified)).code, 'copy_and_plan_ready');
assert.equal((await checkCopyProduction(approved, null, syntheticQualified)).complete_film_accepted, false);
const stale = structuredClone(approved);
const b = stale.clipMentorAnalysis!.blueprint[0] as unknown as Record<string, any>;
const original = b.internal_review['test-candidate'].lines[0].narration_ms;
b.internal_review['test-candidate'].lines[0].narration_ms += ' Berubah.';
assert.equal((await checkCopyProduction(stale, null, syntheticQualified)).code, 'copy_review_stale', 'even a direct edit without revision increment invalidates the digest');
await assert.rejects(bindCopyProductionReview(stale, receipt), /review_subject_changed/, 'a delayed old review cannot be rebound to the latest draft');
b.internal_review['test-candidate'].lines[0].narration_ms = original;
stale.clipMentorAnalysis!.revision += 2;
assert.equal((await checkCopyProduction(stale, null, syntheticQualified)).code, 'copy_review_stale', 'edit then restore through revision tools cannot revive the old approval');
// Repeat with the REAL revision tool rather than trusting a simulated counter.
const revised = context(approved);
const originalUnit = structuredClone(revised.draft.getDoc().clipMentorAnalysis!.blueprint[0]);
const changedUnit = structuredClone(originalUnit) as unknown as Record<string, any>;
changedUnit.internal_review['test-candidate'].lines[0].narration_ms += ' Berubah.';
for (const record of [changedUnit, originalUnit]) {
  const written = await executeTool('revise_clipmentor_analysis', { action: 'revise', collection: 'blueprint',
    id: originalUnit.unit_id, record, expectedRevision: revised.draft.getDoc().clipMentorAnalysis!.revision,
    actor, reason: 'Disposable test: revise then restore; never production copy' }, revised.ctx) as { ok?: boolean };
  assert(written.ok);
  assert.equal((await checkCopyProduction(revised.draft.getDoc(), null, syntheticQualified)).code, 'copy_review_stale');
  assert.equal(await clipMentorProductionBlock('observe_clipmentor_source_video', {}, revised.ctx), null, 'continuous source observation is preparation even when copy approval is stale; it never grants production permission');
  for (const tool of ['submit_voice', 'set_aspect_ratio']) {
    const blocked = await executeTool(tool, { provider: 'minimax', text: original, ratio: '1:1' }, revised.ctx) as { production_gate?: { code: string } };
    assert.equal(blocked.production_gate?.code, 'copy_review_stale');
  }
}
assert.deepEqual(revised.draft.getDoc().timelines, approved.timelines, 'revision test does not edit the test timeline');
const changedSource = structuredClone(approved);
changedSource.assets[0].sourceContentHash = '0'.repeat(64);
assert.equal((await checkCopyProduction(changedSource, null, syntheticQualified)).code, 'source_hash_missing_or_changed');
const wrongScope = structuredClone(approved);
wrongScope.clipMentorAnalysis!.production_copy_review!.units.pop();
assert.equal((await checkCopyProduction(wrongScope, null, syntheticQualified)).code, 'copy_review_scope_incomplete');
const selfApproved = structuredClone(approved);
selfApproved.clipMentorAnalysis!.production_copy_review!.reviewer_run_id = 'test-author';
assert(!isCopyProductionReview(selfApproved.clipMentorAnalysis!.production_copy_review));
assert.equal((await checkCopyProduction(selfApproved, null, syntheticQualified)).code, 'copy_review_invalid');
const oldFreeform = structuredClone(base);
Object.assign(oldFreeform.clipMentorAnalysis!.blueprint[0], { internal_review: { lead_text_review: { status: 'pass' }, production_allowed: true } });
assert.equal((await checkCopyProduction(oldFreeform, null)).code, 'copy_review_missing', 'author/freeform pass flags are not receipts');

const noEvidence = structuredClone(approved);
noEvidence.clipMentorAnalysis!.production_copy_review!.verdict = 'insufficient_evidence';
const failed = structuredClone(approved);
failed.clipMentorAnalysis!.production_copy_review!.verdict = 'needs_revision';
const contradictory = structuredClone(approved);
contradictory.clipMentorAnalysis!.production_copy_review!.units[0].findings.push({ severity: 'blocking', quote: original, reason: 'Synthetic blocker' });
for (const doc of [noEvidence, failed, contradictory]) assert.equal((await checkCopyProduction(doc, null, syntheticQualified)).code, 'copy_review_not_passed');

  for (const [doc, code] of [
    [base, 'copy_review_missing'], [failed, 'copy_review_not_passed'], [noEvidence, 'copy_review_not_passed'],
    [stale, 'copy_review_stale'], [selfApproved, 'copy_review_invalid'],
  ] as const) {
    for (const executor of [executeTool, executeOfflineTool]) {
      const { ctx, draft } = context(doc);
      const before = JSON.stringify(draft.getDoc());
      for (const name of ['submit_voice', 'submit_voice_generation', 'generate_voice', 'rerun_generation',
        'set_aspect_ratio', 'apply_script', 'edit_captions', 'import_timeline', 'run_skill_script', 'run_code', 'submit_render_job']) {
        const result = await executor(name, { provider: 'minimax', text: original }, ctx) as { production_gate?: { code: string } };
        assert.equal(result.production_gate?.code, code, `${name} must refuse ${code} at dispatch`);
      }
      assert.equal(JSON.stringify(draft.getDoc()), before);
      assert.equal(draft.takeActions().length, 0);
    }
  }
assert.equal(networkCalls, 0, 'no voice generation/import/render/network started');
// Paired positive control: the same actual editing handlers work for ordinary projects.
const ordinary = structuredClone(base);
delete ordinary.clipMentorAnalysis;
for (const executor of [executeTool, executeOfflineTool]) {
  const { ctx, draft } = context(ordinary, null);
  await executor('set_aspect_ratio', { ratio: '1:1' }, ctx);
  assert.equal(draft.getState().width, draft.getState().height);
  assert(draft.takeActions().length > 0, 'positive control reaches the actual edit handler');
}
const { ctx } = context(base);
assert((await executeTool('read_clipmentor_analysis', {}, ctx) as { analysis?: unknown }).analysis);
assert((await executeOfflineTool('read_timeline', {}, ctx) as { fps?: number }).fps);
assert.equal((await checkCopyProduction(ordinary, 'clipmentor')).code, 'analysis_missing');
const changedDuringCheck = context(approved);
let reads = 0;
changedDuringCheck.ctx.getDoc = () => ++reads === 1 ? approved : stale;
const concurrent = await executeOfflineTool('set_aspect_ratio', { ratio: '1:1' }, changedDuringCheck.ctx) as { production_gate?: { code: string } };
assert.equal(concurrent.production_gate?.code, 'project_changed_during_gate');
const oldCalibration = legacyCopyReviewCalibration();
assert.equal(oldCalibration.cases.find((c) => c.revision === 90)?.caught, true);
assert.equal(oldCalibration.cases.find((c) => c.revision === 95)?.caught, false);
assert.equal(oldCalibration.qualified, false, 'preserve the V1 miss; do not rewrite history');
assert.equal(calibration.cases.find((c) => c.label === 'revision95')?.actual, 'needs_revision');
assert.equal(calibration.cases.filter((c) => c.kind === 'positive' && c.actual === 'pass').length, 3);
assert.equal(calibration.qualified, true);
// Preserve the recorded historical input/hash. Current review adds new criteria;
// it must not be presented as the same independently validated prompt.
const requestCases = teachingRegression.blind_input.cases as unknown as Array<{ case_id: string; packet: TeachingPacket }>;
const request = buildCopyTeachingReviewRequest(requestCases.map((c) => ({ ...c, expected: 'pass', author_self_review: 'pass' })));
const originalContentOnly = { cases: request.input.cases.map((c) => ({ case_id: c.case_id, packet: { ...c.packet,
  units: c.packet.units.map(({ omission_views: _views, ...unit }) => unit),
} })) };
assert.deepEqual(originalContentOnly, teachingRegression.blind_input, 'new omission references do not rewrite historical copy, context or evidence');
assert(request.instructions.includes(teachingRegression.instructions));
assert(request.instructions.indexOf('先读取每单元source_context') < request.instructions.indexOf(teachingRegression.instructions), 'source reconstruction precedes point-by-point evaluation');
assert.equal(createHash('sha256').update(teachingRegression.instructions).digest('hex'), teachingRegression.pre_registration['protocol.txt']);
assert.notEqual(createHash('sha256').update(request.instructions).digest('hex'), teachingRegression.pre_registration['protocol.txt'], 'new criteria are not the historical calibrated prompt');
assert.equal(createHash('sha256').update(`${JSON.stringify(teachingRegression.blind_input, null, 2)}\n`).digest('hex'), teachingRegression.pre_registration['input.json']);
assert(!JSON.stringify(request.input).includes('author_self_review'));
assert(!JSON.stringify(request.input).includes('"expected"'));
for (const oracle of teachingRegression.regression_oracles) {
  const c = requestCases.find((c) => c.case_id === oracle.case_id)!;
  const raw = teachingRegression.raw_review.cases.find((r) => r.case_id === oracle.case_id)!;
  assert.equal(assessTeachingReview(c.packet, raw).verdict, oracle.expected);
}
const negative95 = teachingRegression.regression_oracles.find((o) => o.label === 'revision95')!;
const packet95 = requestCases.find((c) => c.case_id === negative95.case_id)!.packet;
const raw95 = teachingRegression.raw_review.cases.find((r) => r.case_id === negative95.case_id)!;
const result95 = assessTeachingReview(packet95, { ...raw95, verdict: 'pass' });
assert(result95.issues.some((i) => i.unit_id === 'U1' && i.point_id === 'P1' && i.code === 'primary_point_value_not_explained'));
assert(!result95.issues.some((i) => i.unit_id === 'U1' && i.point_id === 'P2'), 'the useful scent explanation cannot be blanket-rejected');
assert.equal(result95.units.find((u) => u.unit_id === 'U2')!.verdict, 'pass', 'preserve the independent comparison verdict');
const missingPrimary = structuredClone(raw95);
missingPrimary.units[0].points.shift();
assert.equal(assessTeachingReview(packet95, missingPrimary).verdict, 'insufficient_evidence');
const backgroundFill = structuredClone(teaching.review);
backgroundFill.units[0].points[0].basis = 'background_only';
assert.equal(assessTeachingReview(teaching.packet, backgroundFill).verdict, 'needs_revision');
const fabricatedQuote = structuredClone(teaching.review);
fabricatedQuote.units[0].points[0].quotes[0].text = 'This quote is not in the manuscript';
assert.equal(assessTeachingReview(teaching.packet, fabricatedQuote).verdict, 'insufficient_evidence');
const uncertain = structuredClone(teaching.review);
uncertain.units[0].points[0].source_support = 'uncertain';
assert.equal(assessTeachingReview(teaching.packet, uncertain).verdict, 'insufficient_evidence');
const noTeaching = structuredClone(approved);
delete noTeaching.clipMentorAnalysis!.production_copy_review!.teaching_review;
const valueGap = structuredClone(approved);
valueGap.clipMentorAnalysis!.production_copy_review!.teaching_review!.review.units[0].points[0].connection = 'action_only';
const copyMismatch = structuredClone(approved);
copyMismatch.clipMentorAnalysis!.production_copy_review!.teaching_review!.packet.units[0].lines[0].narration_ms += ' Unreviewed change.';
for (const [doc, code] of [[noTeaching, 'copy_teaching_review_missing'], [valueGap, 'copy_teaching_review_not_passed'], [copyMismatch, 'copy_teaching_scope_mismatch']] as const) {
  assert.equal((await checkCopyProduction(doc, null)).code, code, 'aggregate pass cannot bypass missing/weak/mismatched teaching evidence');
  for (const executor of [executeTool, executeOfflineTool]) {
    const blocked = context(doc);
    for (const name of ['submit_voice', 'set_aspect_ratio']) {
      const r = await executor(name, { provider: 'minimax', text: goodLine.narration_ms, ratio: '1:1' }, blocked.ctx) as { production_gate?: { code: string } };
      assert.equal(r.production_gate?.code, code);
    }
    assert.equal(blocked.draft.takeActions().length, 0);
  }
}
// Paired positive: the same ClipMentor gate permits reviewed text/preflight and
// a disposable local edit, without invoking a voice provider.
const goodContext = context(approved);
assert.equal(await clipMentorProductionBlock('submit_voice', { text: goodLine.narration_ms }, goodContext.ctx), null);
assert.equal((await clipMentorProductionBlock('submit_voice', { text: 'Unreviewed narration' }, goodContext.ctx))!.production_gate.code, 'tts_text_not_reviewed');
for (const executor of [executeTool, executeOfflineTool]) {
  const positive = context(approved);
  await executor('set_aspect_ratio', { ratio: '1:1' }, positive.ctx);
  assert(positive.draft.takeActions().length > 0);
}
// Replay the exact blind manuscripts and untouched independent verdicts through
// receipt binding and both production dispatchers. No model or media call.
for (const packet of blindRegression.blind_input.cases) {
  const doc = structuredClone(base);
  packet.units.forEach((unit, i) => Object.assign(doc.clipMentorAnalysis!.blueprint[i], { internal_review: {
    current_script_candidate: packet.case_id,
    [packet.case_id]: { lines: unit.lines.map((l) => ({ id: l.line_id, narration_ms: l.narration_ms,
      caption_lines: l.captions, zh: l.meaning_zh, source_seconds: l.source_seconds })) },
  } }));
  const reviewedSubject = await copyReviewSubject(doc);
  const raw = blindRegression.raw_review.cases.find((r) => r.case_id === packet.case_id)!;
  doc.clipMentorAnalysis!.production_copy_review = {
    scope: 'copy_and_planned_picture_only', protocol: 'creator-copy-v1',
    analysis_revision: reviewedSubject.revision, content_digest: reviewedSubject.digest,
    author_run_id: 'historical-author', reviewer_run_id: 'blind-review-20261019', reviewed_at: 1,
    verdict: raw.verdict as 'pass' | 'needs_revision', units: raw.units.map((u, i) => ({
      unit_id: reviewedSubject.units[i].unit_id, candidate_id: packet.case_id,
      verdict: u.verdict as 'pass' | 'needs_revision', findings: u.findings.map((f) => ({
        severity: f.severity as 'blocking' | 'suggestion', quote: f.quote, reason: f.reason_zh,
      })),
    })),
  };
  const expectedCode = 'copy_review_stale';
  for (const executor of [executeTool, executeOfflineTool]) {
    const replay = context(doc);
    for (const name of ['submit_voice', 'set_aspect_ratio']) {
      const result = await executor(name, { provider: 'minimax', text: packet.units[0].lines[0].narration_ms, ratio: '1:1' }, replay.ctx) as { production_gate?: { code: string } };
      assert.equal(result.production_gate?.code, expectedCode);
    }
    assert.equal(replay.draft.takeActions().length, 0);
  }
}
assert.equal(networkCalls, 0, 'all dispatcher, revision and blind replay checks stayed offline');
console.log('Production gate: runtime guards, V1 history, V2 per-point review, positive controls and blind regression verified. No network or production-project edits.');
