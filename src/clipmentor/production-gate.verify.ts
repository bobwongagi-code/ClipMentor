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
import { bindCopyProductionReview, checkCopyProduction, copyReviewCalibration, copyReviewSubject, isCopyProductionReview, isReviewedNarrationText, COPY_REVIEW_PROTOCOL, assessTeachingReview, buildCopyTeachingReviewRequest, legacyCopyReviewCalibration, clipMentorProductionBlock, copyTeachingPacketFromDoc, type TeachingPacket, type TeachingEnvelope } from './production-gate';

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
  version: 1,
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
const receipt = await bindCopyProductionReview(base, {
  teaching_review: teaching,
  analysis_revision: subject.revision, content_digest: subject.digest,
  author_run_id: 'test-author', reviewer_run_id: 'test-independent-reviewer', reviewed_at: 1, verdict: 'pass',
  units: subject.units.map((u) => ({ unit_id: u.unit_id, candidate_id: u.candidate_id, verdict: 'pass', findings: [] })),
});
const approved = structuredClone(base);
approved.clipMentorAnalysis!.production_copy_review = receipt;
assert(isClipMentorAnalysis(approved.clipMentorAnalysis));
assert.deepEqual(migrateProjectDoc(JSON.parse(JSON.stringify(approved)))?.clipMentorAnalysis?.production_copy_review, receipt, 'save/reopen migration preserves a typed receipt');
assert.equal((await checkCopyProduction(base, null)).code, 'copy_review_missing', 'changing creative mode does not bypass project-owned analysis');
assert.equal((await checkCopyProduction(approved, null)).code, 'copy_and_plan_ready', 'a complete reviewed positive must not be blanket-blocked');
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
// The production request builder reproduces exactly what the independent reviewer
// saw; labels/oracles/author arguments are not model inputs.
const requestCases = teachingRegression.blind_input.cases as unknown as Array<{ case_id: string; packet: TeachingPacket }>;
const request = buildCopyTeachingReviewRequest(requestCases.map((c) => ({ ...c, expected: 'pass', author_self_review: 'pass' })));
assert.deepEqual(request.input, teachingRegression.blind_input);
assert.equal(request.instructions, teachingRegression.instructions);
assert.equal(createHash('sha256').update(request.instructions).digest('hex'), teachingRegression.pre_registration['protocol.txt']);
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
