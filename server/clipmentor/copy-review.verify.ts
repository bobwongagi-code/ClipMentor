import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { ProjectDoc } from '../../src/editor/types';
import type { AgentContext } from '../../src/agent/context';
import type { CopyReviewRequest } from '../../shared/clipmentor-copy-review';
import { makeDraft } from '../../src/editor/store';
import { executeTool } from '../../src/agent/tools';
import { policyForTool } from '../../src/agent/execution-policy';
import { isExternalDraftTool } from '../../src/agent/external-tool-policy';
import { copyReviewSubject, copyTeachingPacketFromDoc, checkCopyProduction } from '../../src/clipmentor/production-gate';
import { reviewClipMentorCopy, runIsolatedCodexReview, type CopyReviewDependencies } from './copy-review';
import { clipMentorCopyReviewPlugin } from '../plugins/clipmentor-copy-review';
import type { ViteDevServer } from 'vite';
import regression from '../../src/clipmentor/fixtures/copy-teaching-blind-v2-20261019.json';

const oracle = regression.regression_oracles.find((o) => o.label === 'qualified_scent_excerpt_from_revision95')!;
const positive = regression.blind_input.cases.find((c) => c.case_id === oracle.case_id)!.packet.units[0];
const rawPoint = regression.raw_review.cases.find((c) => c.case_id === oracle.case_id)!.units[0].points[0];
const line = positive.lines[0];
const base: ProjectDoc = {
  version: 3, activeTimelineId: 'tl', mediaFolders: [],
  assets: [{ id: 'source', name: 'synthetic source', kind: 'video', src: '/media/uploads/review-test.mp4', sourceContentHash: 'a'.repeat(64), durationInFrames: 3000 }],
  timelines: [{ id: 'tl', name: 'test', order: 0, fps: 30, width: 576, height: 1024, items: [], selectedId: null }],
  clipMentorAnalysis: { schema_version: 1, analysis_id: 'synthetic-review-test', revision: 1,
    source: { asset_id: 'source', sourceContentHash: 'a'.repeat(64), duration_seconds: 100, fps: 30 },
    product: { name: 'Test soap', category: 'soap' }, import_origin: 'synthetic_test', points: [], transcripts: [], reviews: [], audit: [],
    evidence: [{ evidence_id: 'F1', kind: 'source_frame', text: 'Test position; not a real observation', status: 'historical_unknown',
      supporting_evidence_ids: [], source_ids: [], time_seconds: 60 }],
    blueprint: [{ unit_id: 'U1', point_ids: ['P1'], intent_zh: 'test use experience', line_guidance: '',
      ...{ internal_review: { current_script_candidate: 'copy', current_picture_plan: 'picture_plan_test',
        copy: { lines: [{ id: line.line_id, point_ids: ['P1'], narration_ms: line.narration_ms, caption_lines: line.caption_lines,
          zh: line.meaning_zh, source_seconds: [59.4, 62.2], labels: line.labels }] },
        picture_plan_test: { script_candidate_id: 'copy', source_range: [59.4, 62.2], composition: 'CURRENT_PLAN_CONTENT',
          viewer_stage_cues: { layout: { original: 'ORIGINAL_LAYOUT', revisit: 'REVISIT_LAYOUT', safe_area: 'SAFE_AREA' },
            original: { text: 'Video asal', enter: 'ORIGINAL_ENTER', exit: 'ORIGINAL_EXIT' },
            revisit: [{ line_ids: [line.line_id], text: 'Ulang lihat', enter: 'REVISIT_ENTER', exit: 'REVISIT_EXIT' }],
            handoff: 'CURRENT_HANDOFF' },
          phases: [{ line_id: line.line_id, source_seconds: [59.4, 62.2], picture: 'CURRENT_PICTURE',
            purpose: 'CURRENT_USE', constraints: ['CURRENT_CONSTRAINT'], details: { text: 'AUTHOR_PHASE_WRAPPER' } }],
          knownIssue: 'AUTHOR_SINGULAR_MUST_NOT_LEAK', selfEvaluation: 'AUTHOR_SELF_MUST_NOT_LEAK',
          context: [{ kind: 'previous_drafts', text: 'AUTHOR_WRAPPED_MUST_NOT_LEAK' }],
          self_review: 'AUTHOR_VERDICT_MUST_NOT_LEAK', reason: 'AUTHOR_REASON_MUST_NOT_LEAK', production_allowed: true,
          known_issues: ['AUTHOR_EXPECTATION_MUST_NOT_LEAK'], previous_drafts: ['AUTHOR_HISTORY_MUST_NOT_LEAK'],
          user_feedback: 'AUTHOR_PREFERRED_ANSWER_MUST_NOT_LEAK', expected_answer: 'AUTHOR_PASS_MUST_NOT_LEAK',
          details: { knownIssues: ['AUTHOR_CAMEL_CASE_MUST_NOT_LEAK'], expectedAnswer: 'AUTHOR_NESTED_MUST_NOT_LEAK' } } } } }],
    source_breakdown: { version: 1,
      segments: [{ segment_id: 'S1', source_range_seconds: [59.4, 62.2], visible_evidence_ids: ['F1'], claim_evidence_ids: [], interpretation_evidence_ids: [], unknowns: ['Scent quality unknown'] }],
      points: [{ point_id: 'P1', segment_ids: ['S1'], buying_concern: 'Use experience', teaching_question: positive.points[0].question,
        filming_conditions: ['Near-nose gesture'], role: 'primary', importance: 'must_explain' }],
      units: [{ unit_id: 'U1', original_segment_ids: ['S1'], original_source_ranges: [[59.4, 62.2]], explanation_segment_ids: ['S1'],
        coverage: [{ point_id: 'P1', treatment: 'explain' }], revisits: [{ from_segment_id: 'S1', to_segment_id: 'S1', reason: 'AUTHOR_REVISIT_REASON_MUST_NOT_LEAK' }] }],
    },
  },
};
const goodRaw = () => ({ cases: [{ case_id: 'current', units: [{ unit_id: 'U1', points: [{ ...structuredClone(rawPoint), point_id: 'P1' }] }] }],
  copy_units: [{ unit_id: 'U1', verdict: 'pass', findings: [],
    group_checks: { scope: 'planned_group_teaching_only',
      L1: { verdict: 'pass', learner_takeaway: 'Synthetic group relationship', reason: 'Synthetic teaching coverage, not a real semantic result' },
      L2: { verdict: 'pass', viewer_chain: 'Synthetic original then revisit', stage_cues: 'Synthetic visible revisit title', reason: 'Synthetic planned handoff, not actual viewing' } },
    narration_checks: [{ line_id: line.line_id, necessity: 'necessary',
    omission_loss: 'Synthetic test: scent-use relation would be lost', naturalness: 'natural', reason: 'Synthetic reviewer only, not a real naturalness judgment' }] }] });
const root = await mkdtemp(join(tmpdir(), 'clipmentor-copy-review-test-'));
let calls = 0, extracted = 0;
let mode: 'pass' | 'fail' | 'unknown' | 'copy_block' | 'copy_unmatched' | 'throw' | 'invalid' = 'pass';
const sensitive = 'synthetic-credential-must-not-appear';
const deps: CopyReviewDependencies = {
  directory: root, resolve: (name) => name === 'review-test.mp4' ? 'mock-original' : null,
  hash: async () => 'a'.repeat(64),
  frame: async () => { extracted++; return 'aGVsbG8='; },
  async run(prompt, frames, runId, projectId) {
    calls++;
    assert(prompt.includes('CURRENT_PLAN_CONTENT'));
    for (const marker of ['CURRENT_HANDOFF', 'ORIGINAL_ENTER', 'REVISIT_ENTER', 'CURRENT_PICTURE', 'CURRENT_USE', 'CURRENT_CONSTRAINT', 'SAFE_AREA']) assert(prompt.includes(marker), 'retain current operational evidence: ' + marker);
    assert(!prompt.includes('AUTHOR_'));
    assert(prompt.includes('"omission_views"'));
    assert(prompt.includes('"target_line_id":"' + line.line_id + '"'));
    assert(prompt.includes('"remaining_line_ids":[]'), 'single-line group deletion still reaches the actual review entry');
    assert(prompt.includes('删去目标口播及其同文字幕'));
    assert(prompt.includes('重点保留不等于每个重点独占一句旁白'));
    assert(prompt.includes('有表达作用不等于值得独立占用旁白'));
    assert(prompt.includes('独立发声的必要性'), 'the server asks for deletion loss, not just expressive function');
    for (const field of ['group_checks', 'planned_group_teaching_only', 'learner_takeaway', 'viewer_chain', 'stage_cues']) assert(prompt.includes(field));
    for (const question of ['值得讲吗？', '讲得直接吗？', '说得自然吗？', '证据支持吗？']) {
      assert(prompt.includes(question), `the actual independent review request must include ${question}`);
    }
    assert.equal(frames.length, 6);
    assert.deepEqual(frames.map((f) => f.phase), ['original', 'original', 'original', 'explanation', 'explanation', 'explanation']);
    assert(runId.startsWith('clipmentor-review:')); assert.equal(projectId, 'test-project');
    if (mode === 'throw') throw new Error(sensitive);
    if (mode === 'invalid') return {};
    const raw = goodRaw();
    if (mode === 'copy_block') return { ...raw, copy_units: [{ ...raw.copy_units[0], verdict: 'pass', findings: [{ severity: 'blocking', quote: line.narration_ms, reason: 'Synthetic copy error' }] }] };
    if (mode === 'copy_unmatched') {
      raw.copy_units[0].verdict = 'needs_revision';
      (raw.copy_units[0].findings as unknown[]).push({ severity: 'blocking', quote: 'THIS QUOTE IS NOT IN THE CURRENT COPY', reason: 'Synthetic unmatched finding' });
    }
    if (mode === 'fail') raw.cases[0].units[0].points[0].connection = 'action_only';
    if (mode === 'unknown') raw.cases[0].units[0].points[0].source_support = 'uncertain';
    return raw;
  },
};
async function request(operationId = randomUUID()): Promise<CopyReviewRequest> {
  const subject = await copyReviewSubject(base);
  return { operationId, maxRequests: 1, projectId: 'test-project', authorRunId: 'host-author-run',
    source: { src: base.assets[0].src, hash: 'a'.repeat(64), fps: 30, duration: 100 },
    subject: { revision: subject.revision, digest: subject.digest, units: subject.units.map(({ unit_id, candidate_id }) => ({ unit_id, candidate_id })) },
    packet: await copyTeachingPacketFromDoc(base) };
}
const nativeFetch = globalThis.fetch;
try {
  assert.equal(policyForTool('request_clipmentor_copy_review').effect, 'irreversible_external');
  assert(isExternalDraftTool('request_clipmentor_copy_review'));
  const first = await request();
  const pass = await reviewClipMentorCopy(first, deps);
  assert.equal(pass.receipt.verdict, 'pass'); assert.equal(calls, 1);
  assert.deepEqual(pass.receipt.units[0].group_checks, goodRaw().copy_units[0].group_checks);
  assert.equal(pass.inspection.continuous_viewing, false); assert.equal(pass.inspection.listening, false);
  assert.equal(pass.inspection.input_policy, 'independent_current_subject_v1');
  assert.equal(JSON.parse(await readFile(join(root, first.operationId + '.json'), 'utf8')).input_policy, pass.inspection.input_policy);
  assert.deepEqual(await reviewClipMentorCopy(first, deps), { ...pass, cached: true });
  assert.equal(calls, 1); assert.equal(extracted, 6, 'completed replay does not repeat extraction or model turn');
  await assert.rejects(reviewClipMentorCopy({ ...first, projectId: 'different' }, deps)); assert.equal(calls, 1);
  await assert.rejects(reviewClipMentorCopy({ ...first, verdict: 'pass' }, deps));
  await assert.rejects(reviewClipMentorCopy({ ...first, mode: 'collaborative', context: { knownIssues: ['Expected answer'] } }, deps));
  await assert.rejects(reviewClipMentorCopy({ ...first, maxRequests: 2 }, deps)); assert.equal(calls, 1);
  // Known container names do not allow untyped arrays/strings to carry reviewer instructions.
  for (const malformed of [
    { phases: ['AUTHOR_ARRAY_HISTORY'] },
    { phases: [null] },
    { viewer_stage_cues: ['AUTHOR_ARRAY_SELF_EVAL'] },
    { viewer_stage_cues: { original: 'AUTHOR_OBJECT_REPLACED' } },
  ]) {
    const invalidShape = await request();
    Object.assign(invalidShape.packet.units[0].picture_plan!.execution_plan!.content, malformed);
    const beforeCalls = calls, beforeExtract = extracted;
    await assert.rejects(reviewClipMentorCopy(invalidShape, deps), /picture_plan_shape_invalid/);
    assert.equal(calls, beforeCalls, 'invalid structure must fail before the reviewer is invoked');
    assert.equal(extracted, beforeExtract, 'invalid structure must fail before frame extraction');
  }
  const objectComposition = await request();
  objectComposition.packet.units[0].picture_plan!.execution_plan!.content.composition = {
    canvas: '720x1280; 320px subtitle space', detail: 'same-frame common hand area; no cross-time hand stitching',
    check: 'AUTHOR_APPROVAL_MUST_NOT_LEAK' };
  let layoutSeen = false;
  await reviewClipMentorCopy(objectComposition, { ...deps, run: async (prompt) => {
    assert(prompt.includes('720x1280; 320px subtitle space'));
    assert(prompt.includes('same-frame common hand area; no cross-time hand stitching'));
    assert(!prompt.includes('AUTHOR_APPROVAL_MUST_NOT_LEAK'));
    layoutSeen = true; return goodRaw();
  } });
  assert(layoutSeen, 'the actual service prompt must retain object-form operational composition');
  for (const change of ['missing', 'L1_revision', 'L2_unknown'] as const) {
    const req = await request();
    const raw: any = goodRaw();
    if (change === 'missing') delete raw.copy_units[0].group_checks;
    if (change === 'L1_revision') raw.copy_units[0].group_checks.L1.verdict = 'needs_revision';
    if (change === 'L2_unknown') raw.copy_units[0].group_checks.L2.verdict = 'insufficient_evidence';
    let attempts = 0;
    const result = await reviewClipMentorCopy(req, { ...deps, run: async () => { attempts++; return raw; } });
    assert.equal(result.receipt.verdict, change === 'L1_revision' ? 'needs_revision' : 'insufficient_evidence');
    const ledger = JSON.parse(await readFile(join(root, req.operationId + '.json'), 'utf8'));
    assert.deepEqual(ledger.raw_review, raw, 'save the independent result, including missing or unresolved group answers');
    assert.deepEqual(ledger.result.receipt, result.receipt);
    const draft = makeDraft(structuredClone(base));
    const ctx: AgentContext = { ...draft, getCreativeMode: () => 'clipmentor', getProjectId: () => 'test-project',
      getAgentRunId: () => 'host-author-run', templates: [], audio: [] };
    globalThis.fetch = (async () => Response.json(result)) as typeof fetch;
    const tool = await executeTool('request_clipmentor_copy_review', { operationId: req.operationId, maxRequests: 1, expectedRevision: 1 }, ctx) as any;
    assert(tool.ok && !tool.production_gate.allowed, 'the normal review tool must persist a failed group review without releasing production');
    const read = await executeTool('read_clipmentor_analysis', { view: 'copy_review' }, ctx) as any;
    assert.equal(read.analysis.copy_review.receipt.verdict, result.receipt.verdict);
    assert.deepEqual(read.analysis.copy_review.receipt.units[0].group_checks, result.receipt.units[0].group_checks);
    assert.equal(read.production_gate.code, 'copy_group_review_not_passed');
    assert.deepEqual(draft.getDoc().assets, base.assets);
    assert.deepEqual(draft.getDoc().timelines, base.timelines);
    assert.deepEqual(await reviewClipMentorCopy(req, deps), { ...result, cached: true });
    assert.equal(attempts, 1, 'saved negative/unknown rereads never retry the model');
  }
  globalThis.fetch = nativeFetch;
  for (const [severity, expected, reason] of [
    ['suggestion', 'pass', 'Synthetic optional improvement: already clear and accurate; could sound more direct'],
    ['blocking', 'needs_revision', 'Synthetic required fix: a necessary filming condition is missing'],
    ['unknown', 'insufficient_evidence', 'Synthetic unresolved evidence affecting the current claim'],
  ] as const) {
    const classified = await reviewClipMentorCopy(await request(), { ...deps, run: async () => {
      const raw = goodRaw();
      (raw.copy_units[0].findings as unknown[]).push({ severity, quote: line.narration_ms, reason });
      return raw;
    } });
    assert.equal(classified.receipt.verdict, expected, 'keep optional improvements, required fixes and unresolved evidence distinct');
  }
  for (const severity of ['blocking', 'suggestion', 'unknown'] as const) {
    const req = await request();
    const raw = goodRaw();
    raw.copy_units[0].verdict = severity === 'blocking' ? 'needs_revision' : 'pass';
    (raw.copy_units[0].findings as unknown[]).push({ severity, quote: 'THIS QUOTE IS NOT IN THE CURRENT COPY', reason: 'Synthetic unmatched finding' });
    let attempts = 0;
    const unmatchedDeps = { ...deps, run: async () => { attempts++; return raw; } };
    const checked = await reviewClipMentorCopy(req, unmatchedDeps);
    assert.equal(checked.receipt.verdict, 'insufficient_evidence', 'an invented quote cannot establish a copy defect or a pass');
    assert.deepEqual(checked.receipt.units[0].findings, raw.copy_units[0].findings, 'preserve the raw finding, do not rewrite it');
    const saved = JSON.parse(await readFile(join(root, `${req.operationId}.json`), 'utf8'));
    assert.deepEqual(saved.raw_review, raw);
    assert.equal(saved.requests_attempted, 1);
    assert.deepEqual(await reviewClipMentorCopy(req, unmatchedDeps), { ...checked, cached: true });
    assert.equal(attempts, 1, 'invalid evidence does not authorize another model attempt');
  }
  for (const target of ['necessity', 'naturalness', 'source_support', 'unit_verdict', 'severity', 'group_verdict', 'group_cue'] as const) {
    const malformed = goodRaw();
    if (target === 'necessity') Object.assign(malformed.copy_units[0].narration_checks[0], { necessity: ['redundant'] });
    if (target === 'naturalness') Object.assign(malformed.copy_units[0].narration_checks[0], { naturalness: ['awkward'] });
    if (target === 'source_support') Object.assign(malformed.cases[0].units[0].points[0], { source_support: ['contradicted'] });
    if (target === 'unit_verdict') Object.assign(malformed.copy_units[0], { verdict: ['needs_revision'] });
    if (target === 'severity') (malformed.copy_units[0].findings as unknown[]).push({ severity: ['blocking'], quote: 'test', reason: 'test' });
    if (target === 'group_verdict') Object.assign(malformed.copy_units[0].group_checks.L1, { verdict: ['pass'] });
    if (target === 'group_cue') Object.assign(malformed.copy_units[0].group_checks.L2, { stage_cues: null });
    let attempts = 0;
    try {
      const checked = await reviewClipMentorCopy(await request(), { ...deps, run: async () => { attempts++; return malformed; } });
      assert.notEqual(checked.receipt.verdict, 'pass', `malformed ${target} must never produce a pass receipt`);
    } catch (error) {
      // Rejection is safe; do not swallow an assertion that observed a fail-open result.
      if (error instanceof assert.AssertionError) throw error;
    }
    assert.equal(attempts, 1, 'invalid structured response has no automatic retry');
  }

  // A genuine visual-only packet is reviewed and persisted, not silently dropped or
  // assigned to an unrelated spoken line. All observations/judgments here are mocks.
  const visualDoc = structuredClone(base);
  const a = visualDoc.clipMentorAnalysis!;
  a.evidence.push({ evidence_id: 'V1', kind: 'source_frame', text: 'Synthetic visible gesture; not production evidence',
    status: 'historical_unknown', supporting_evidence_ids: [], source_ids: [], time_seconds: 84.8 });
  a.source_breakdown!.segments.push({ segment_id: 'S2', source_range_seconds: [84.4, 85.3], visible_evidence_ids: ['V1'],
    claim_evidence_ids: [], interpretation_evidence_ids: [], unknowns: [] });
  a.source_breakdown!.points.push({ point_id: 'P2', segment_ids: ['S2'], role: 'auxiliary', importance: 'must_explain',
    buying_concern: 'Synthetic supporting presentation', teaching_question: 'Synthetic group handoff task', filming_conditions: ['Visible gesture in the selected picture'] });
  a.source_breakdown!.units[0].original_segment_ids.push('S2');
  // Broad playback alone would sample 59.4/middle/89.96 and miss the short visual point.
  a.source_breakdown!.units[0].original_source_ranges = [[59.4, 90]];
  a.source_breakdown!.units[0].revisits.push({ from_segment_id: 'S2', to_segment_id: 'S1', reason: 'Synthetic registered explanation revisit' });
  a.source_breakdown!.units[0].coverage.push({ point_id: 'P2', treatment: 'visual_only', reason: 'AUTHOR_VISUAL_REASON_MUST_NOT_LEAK' });
  a.blueprint[0].point_ids.push('P2');
  const visualSubject = await copyReviewSubject(visualDoc);
  const visualRequest = { ...await request(), subject: { ...visualSubject,
    units: visualSubject.units.map(({ unit_id, candidate_id }) => ({ unit_id, candidate_id })) }, packet: await copyTeachingPacketFromDoc(visualDoc) };
  const bound = visualRequest.packet.units[0].points.find(p => p.point_id === 'P2')!.visual_evidence![0];
  const visualRaw = () => {
    const raw: any = goodRaw();
    raw.cases[0].units[0].points.push({ ...structuredClone(rawPoint), point_id: 'P2', quotes: [], basis: 'within_unit', connection: 'auxiliary_transition',
      visual_check: { evidence_refs: [{ segment_id: 'S2', phase: 'original', evidence_id: 'V1', source_range_seconds: [...bound.source_range_seconds] }],
        observed_relation: 'Synthetic selected gesture', sufficiency: 'sufficient', omission_loss: 'Synthetic complete group retains its teaching without separate gesture narration' } });
    return raw;
  };
  let visualRuns = 0;
  const visualDeps = { ...deps, run: async (prompt: string, frames: Parameters<CopyReviewDependencies['run']>[1]) => {
    visualRuns++;
    assert(prompt.includes('"treatment":"visual_only"') && prompt.includes('"evidence_ids":["V1"]'));
    assert(prompt.includes('visual_check') && !prompt.includes('AUTHOR_VISUAL_REASON'));
    assert(frames.some(f => f.phase === 'original' && f.source_seconds >= 84.4 && f.source_seconds < 85.3), 'the selected visual evidence must actually be sampled');
    return visualRaw();
  } };
  const visualPass = await reviewClipMentorCopy(visualRequest, visualDeps);
  assert.equal(visualRuns, 1);
  assert.equal(visualPass.receipt.verdict, 'pass');
  assert.equal(visualPass.receipt.teaching_review!.packet.units[0].points.length, 2);
  assert(visualPass.receipt.teaching_review!.packet.units[0].points[1].treatment_reason!.includes('AUTHOR_VISUAL_REASON'));
  assert.equal(visualPass.receipt.teaching_review!.review.units[0].points[1].quotes.length, 0);
  assert.deepEqual((await reviewClipMentorCopy(visualRequest, visualDeps)).receipt, visualPass.receipt);
  assert.equal(visualRuns, 1, 'rereading a successful visual review does not invoke a model again');
  const mockApproved = structuredClone(visualDoc); mockApproved.clipMentorAnalysis!.production_copy_review = visualPass.receipt;
  assert.equal((await checkCopyProduction(mockApproved, 'clipmentor')).allowed, true);
  for (const [change, expected] of [
    ['missing', 'insufficient_evidence'], ['unknown', 'insufficient_evidence'],
    ['wrong_evidence', 'insufficient_evidence'], ['wrong_range', 'insufficient_evidence'], ['needs_explanation', 'needs_revision'],
  ] as const) {
    const req = { ...structuredClone(visualRequest), operationId: randomUUID() };
    let emitted: ReturnType<typeof visualRaw>;
    const result = await reviewClipMentorCopy(req, { ...visualDeps, run: async () => {
      const raw = visualRaw(), p = raw.cases[0].units[0].points[1]; emitted = raw;
      if (change === 'missing') delete p.visual_check;
      if (change === 'unknown') p.visual_check.sufficiency = 'uncertain';
      if (change === 'wrong_evidence') p.visual_check.evidence_refs[0].evidence_id = 'F1';
      if (change === 'wrong_range') p.visual_check.evidence_refs[0].source_range_seconds = [59.4, 62.2];
      if (change === 'needs_explanation') p.visual_check.sufficiency = 'needs_explanation';
      return raw;
    } });
    assert.equal(result.receipt.verdict, expected);
    const saved = JSON.parse(await readFile(join(root, req.operationId + '.json'), 'utf8'));
    assert.deepEqual(saved.raw_review, emitted!, 'retain the exact negative/uncertain judgment, not a rewritten pass');
    const draft = makeDraft(structuredClone(visualDoc));
    const ctx: AgentContext = { ...draft, getCreativeMode: () => 'clipmentor', getProjectId: () => 'test-project',
      getAgentRunId: () => 'host-author-run', templates: [], audio: [] };
    globalThis.fetch = (async () => Response.json(result)) as typeof fetch;
    const tool = await executeTool('request_clipmentor_copy_review', { operationId: req.operationId, maxRequests: 1, expectedRevision: 1 }, ctx) as { ok: boolean; production_gate: { allowed: boolean } };
    assert(tool.ok && !tool.production_gate.allowed, 'an insufficient/negative visual receipt is saved but never released');
    const read = await executeTool('read_clipmentor_analysis', { view: 'copy_review' }, ctx) as any;
    assert.equal(read.analysis.copy_review.receipt.verdict, expected);
    assert.deepEqual(read.analysis.copy_review.teaching_review.units[0].points[1], result.receipt.teaching_review!.review.units[0].points[1]);
    assert.deepEqual(draft.getDoc().assets, visualDoc.assets); assert.deepEqual(draft.getDoc().timelines, visualDoc.timelines);
  }
  globalThis.fetch = nativeFetch;
  const missingVisualInput = structuredClone(visualRequest);
  missingVisualInput.operationId = randomUUID();
  missingVisualInput.packet.units[0].points[1].visual_evidence = [];
  const beforeVisualRun = visualRuns;
  await assert.rejects(reviewClipMentorCopy(missingVisualInput, visualDeps));
  assert.equal(visualRuns, beforeVisualRun, 'missing visual input evidence is rejected before review');

  mode = 'fail'; assert.equal((await reviewClipMentorCopy(await request(), deps)).receipt.verdict, 'needs_revision');
  mode = 'unknown'; assert.equal((await reviewClipMentorCopy(await request(), deps)).receipt.verdict, 'insufficient_evidence');
  for (const [necessity, naturalness, expected] of [['redundant', 'natural', 'needs_revision'], ['necessary', 'awkward', 'needs_revision'], ['uncertain', 'natural', 'insufficient_evidence']] as const) {
    const checked = await reviewClipMentorCopy(await request(), { ...deps, run: async () => {
      const raw = goodRaw(); Object.assign(raw.copy_units[0].narration_checks[0], { necessity, naturalness }); return raw;
    } });
    assert.equal(checked.receipt.verdict, expected, 'a top-level pass cannot waive the per-line judgment');
  }
  const omitted = await reviewClipMentorCopy(await request(), { ...deps, run: async () => {
    const raw = goodRaw(); raw.copy_units[0].narration_checks = []; return raw;
  } });
  assert.equal(omitted.receipt.verdict, 'insufficient_evidence');
  const pointBaselineBefore = JSON.stringify(base.clipMentorAnalysis!.source_breakdown!.points);
  const unresolvedNecessity = await reviewClipMentorCopy(await request(), { ...deps, run: async () => {
    const raw = goodRaw();
    raw.copy_units[0].narration_checks[0].necessity = 'uncertain';
    raw.copy_units[0].narration_checks[0].omission_loss = 'Synthetic unresolved deletion comparison; not a semantic oracle';
    return raw;
  } });
  assert.equal(unresolvedNecessity.receipt.verdict, 'insufficient_evidence', 'a supported point does not waive unresolved narration necessity');
  assert.equal(JSON.stringify(base.clipMentorAnalysis!.source_breakdown!.points), pointBaselineBefore, 'returning narration for planner response never deletes or downgrades a selected point');
  const persistedUnresolved = JSON.parse(await readFile(join(root, `${unresolvedNecessity.operationId}.json`), 'utf8'));
  assert.equal(persistedUnresolved.raw_review.copy_units[0].narration_checks[0].necessity, 'uncertain', 'stored review preserves the declared uncertainty');


  mode = 'copy_block'; assert.equal((await reviewClipMentorCopy(await request(), deps)).receipt.verdict, 'needs_revision', 'an aggregate pass cannot hide a blocking copy finding');
  mode = 'throw'; const failure = await request();
  await assert.rejects(reviewClipMentorCopy(failure, deps), (error: Error) => !error.message.includes(sensitive));
  const ledger = await readFile(join(root, `${failure.operationId}.json`), 'utf8');
  assert(!ledger.includes(sensitive)); assert.equal(JSON.parse(ledger).requests_attempted, 1);
  const consumed = calls;
  await assert.rejects(reviewClipMentorCopy(failure, deps)); assert.equal(calls, consumed, 'failed attempt never auto-replays');
  mode = 'invalid'; await assert.rejects(reviewClipMentorCopy(await request(), deps));
  const cancelled = await request(), controller = new AbortController();
  await assert.rejects(reviewClipMentorCopy(cancelled, { ...deps, run: async () => { controller.abort(); return goodRaw(); } }, controller.signal));
  assert.equal(JSON.parse(await readFile(join(root, `${cancelled.operationId}.json`), 'utf8')).requests_attempted, 1, 'cancellation after a dispatched turn consumes its attempt and cannot approve');
  const noFrame = await request(), beforeFrames = calls;
  await assert.rejects(reviewClipMentorCopy(noFrame, { ...deps, frame: async () => { throw new Error(sensitive); } }));
  assert.equal(calls, beforeFrames); assert.equal(JSON.parse(await readFile(join(root, `${noFrame.operationId}.json`), 'utf8')).requests_attempted, 0);
  await assert.rejects(reviewClipMentorCopy(await request(), { ...deps, hash: async () => 'b'.repeat(64) })); assert.equal(calls, beforeFrames);

  mode = 'pass'; let changeDuringReview = false;
  const context = () => {
    const draft = makeDraft(structuredClone(base));
    const ctx: AgentContext = { ...draft, getCreativeMode: () => 'clipmentor', getProjectId: () => 'test-project',
      getAgentRunId: () => 'host-author-run', templates: [], audio: [] };
    return { draft, ctx };
  };
  let active = context();
  globalThis.fetch = (async (_url, init) => {
    const result = await reviewClipMentorCopy(JSON.parse(String(init?.body)), deps);
    if (changeDuringReview) active.draft.commands.applyDoc({ ...active.draft.getDoc(), clipMentorAnalysis: { ...active.draft.getDoc().clipMentorAnalysis!, revision: 2 } });
    return Response.json(result);
  }) as typeof fetch;
  const toolArgs = () => ({ operationId: randomUUID(), maxRequests: 1, expectedRevision: 1 });
  assert.equal((await checkCopyProduction(active.draft.getDoc(), 'clipmentor')).allowed, false);
  const result = await executeTool('request_clipmentor_copy_review', toolArgs(), active.ctx) as { ok: boolean; production_gate: { allowed: boolean } };
  assert(result.ok); assert(result.production_gate.allowed);
  assert.equal(active.draft.takeActions().length, 1, 'receipt uses the ordinary undoable draft');
  assert.deepEqual(active.draft.getDoc().assets, base.assets); assert.deepEqual(active.draft.getDoc().timelines, base.timelines);
  assert.equal(active.draft.getDoc().clipMentorAnalysis!.revision, 1, 'receipt does not change its own bound content revision');
  const reviewedDoc = structuredClone(active.draft.getDoc());
  active = context(); mode = 'copy_unmatched';
  const invalidEvidence = await executeTool('request_clipmentor_copy_review', toolArgs(), active.ctx) as {
    ok: boolean; verdict: string; production_gate: { code: string };
  };
  assert(invalidEvidence.ok, 'an insufficient-evidence receipt remains saveable');
  assert.equal(invalidEvidence.verdict, 'insufficient_evidence');
  assert.equal(invalidEvidence.production_gate.code, 'copy_finding_evidence_invalid');
  const invalidEvidenceDoc = structuredClone(active.draft.getDoc());
  const readBack = await executeTool('read_clipmentor_analysis', { view: 'copy_review' }, active.ctx) as {
    analysis: { copy_review: { receipt: { verdict: string; units: Array<{ findings: Array<{ quote: string }> }> } } };
    production_gate: { code: string };
  };
  assert.equal(readBack.analysis.copy_review.receipt.verdict, 'insufficient_evidence');
  assert.equal(readBack.analysis.copy_review.receipt.units[0].findings[0].quote, 'THIS QUOTE IS NOT IN THE CURRENT COPY');
  assert.equal(readBack.production_gate.code, 'copy_finding_evidence_invalid');
  assert.deepEqual(active.draft.getDoc(), invalidEvidenceDoc, 'reading the deficient receipt does not mutate it');
  assert.deepEqual(invalidEvidenceDoc.assets, base.assets); assert.deepEqual(invalidEvidenceDoc.timelines, base.timelines);
  mode = 'pass';
  const restored = structuredClone(reviewedDoc); restored.clipMentorAnalysis!.revision++;
  assert.equal((await checkCopyProduction(restored, 'clipmentor')).code, 'copy_review_stale');
  active = context(); changeDuringReview = true;
  const stale = await executeTool('request_clipmentor_copy_review', toolArgs(), active.ctx) as { error: string };
  assert(stale.error.includes('changed')); assert.equal(active.draft.getDoc().clipMentorAnalysis!.production_copy_review, undefined);
  changeDuringReview = false; active = context(); mode = 'fail';
  const rejected = await executeTool('request_clipmentor_copy_review', toolArgs(), active.ctx) as { verdict: string; production_gate: { allowed: boolean } };
  assert.equal(rejected.verdict, 'needs_revision'); assert.equal(rejected.production_gate.allowed, false);
  mode = 'pass'; active = context(); const missing = { ...active.ctx, getAgentRunId: undefined };
  const beforeMissing = calls;
  assert((await executeTool('request_clipmentor_copy_review', toolArgs(), missing) as { error: string }).error);
  assert.equal(calls, beforeMissing);
  active = context();
  const incomplete = structuredClone(base);
  const internal = (incomplete.clipMentorAnalysis!.blueprint[0] as unknown as { internal_review: Record<string, unknown> }).internal_review;
  (internal.picture_plan_test as Record<string, unknown>).script_candidate_id = 'different-copy';
  active.draft.commands.applyDoc(incomplete);
  const mismatch = await executeTool('request_clipmentor_copy_review', toolArgs(), active.ctx) as { error: string; requestsSent: number };
  assert(mismatch.error.includes('picture_plan_candidate_mismatch')); assert.equal(mismatch.requestsSent, 0); assert.equal(calls, beforeMissing);
  globalThis.fetch = nativeFetch;

  // Real local HTTP middleware, fake reviewer only. No provider/Codex process starts.
  let handler: ((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void) | undefined;
  const plugin = clipMentorCopyReviewPlugin({ ...deps,
    run: async (...args: Parameters<CopyReviewDependencies['run']>) => args[0].includes('"treatment":"visual_only"')
      ? visualDeps.run(args[0], args[1]) : deps.run(...args) });
  (plugin.configureServer as (server: ViteDevServer) => void)({ middlewares: { use: (_path: string, cb: typeof handler) => { handler = cb; } } } as unknown as ViteDevServer);
  const server = createServer((req, res) => { void handler!(req, res); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const origin = `http://127.0.0.1:${address.port}`, url = `${origin}/api/clipmentor/review-copy`;
    const req = await request();
    assert.equal((await nativeFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) })).status, 401);
    const response = await nativeFetch(url, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
    assert.equal(response.status, 200); assert.equal((await response.json()).receipt.verdict, 'pass');
    const visualResponse = await nativeFetch(url, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...visualRequest, operationId: randomUUID() }) });
    assert.equal(visualResponse.status, 200, 'the formerly rejected visual-only request passes the actual HTTP boundary');
    const visualBody = await visualResponse.json();
    assert.equal(visualBody.receipt.verdict, 'pass');
    assert.equal(visualBody.receipt.teaching_review.review.units[0].points[1].quotes.length, 0);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  // Exercise the actual isolated runner against a fake Codex RPC executable.
  // Assert fresh/read-only thread setup and real image transport, without invoking Codex/model.
  const executable = join(root, 'fake-codex');
  await writeFile(executable, `#!${process.execPath}
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('codex 0.146.0'); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const answer = ${JSON.stringify(goodRaw())};
const done = () => {
  send({method:'item/agentMessage/delta',params:{threadId:'isolated',turnId:'one',delta:JSON.stringify(answer)}});
  send({method:'turn/completed',params:{threadId:'isolated',turn:{id:'one',status:'completed'}}});
};
createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({id:m.id,result:{}});
  if (m.method === 'thread/start') {
    if (!m.params.ephemeral || m.params.cwd !== null || m.params.sandbox !== 'read-only'
      || m.params.dynamicTools.length !== 1 || m.params.dynamicTools[0].name !== 'read_review_frames'
      || m.params.config.features.unified_exec !== false) process.exit(81);
    return send({id:m.id,result:{thread:{id:'isolated'}}});
  }
  if (m.method === 'turn/start') {
    send({id:m.id,result:{turn:{id:'one'}}});
    if (m.params.input[0].text.includes('SKIP_FRAMES')) return done();
    return send({id:'frames',method:'item/tool/call',params:{threadId:'isolated',turnId:'one',callId:'read-one',tool:'read_review_frames',arguments:{batch:0}}});
  }
  if (m.id === 'frames') {
    const payload = JSON.parse(m.result.contentItems[0].text);
    if (!m.result.success || m.result.contentItems.length !== 1 || m.result.contentItems[0].type !== 'inputText'
      || !payload.metadata.note.includes('U1/original') || payload.content.length !== 1
      || payload.content[0].type !== 'image' || payload.content[0].mimeType !== 'image/jpeg'
      || payload.content[0].data !== 'aGVsbG8=') process.exit(82);
    return done();
  }
  if (m.id !== undefined) send({id:m.id,result:{}});
});
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  const priorPath = process.env.OPENCHATCUT_CODEX_PATH;
  process.env.OPENCHATCUT_CODEX_PATH = executable;
  try {
    const frames = [{ unit_id: 'U1', phase: 'original' as const, source_seconds: 60, base64: 'aGVsbG8=' }];
    assert.deepEqual(await runIsolatedCodexReview('transport test', frames, 'test-isolated', 'test-project', AbortSignal.timeout(15_000)), goodRaw());
    await assert.rejects(runIsolatedCodexReview('SKIP_FRAMES', frames, 'test-skip', 'test-project', AbortSignal.timeout(15_000)), /Incomplete/);
  } finally {
    if (priorPath === undefined) delete process.env.OPENCHATCUT_CODEX_PATH;
    else process.env.OPENCHATCUT_CODEX_PATH = priorPath;
  }
  console.log('Copy review: real tool/draft + HTTP route, isolated packet/current picture plan, pass/fail/unknown, stale race, no retry and redacted errors passed. Fake reviewer only; no model/TTS/render calls.');
} finally { globalThis.fetch = nativeFetch; await rm(root, { recursive: true, force: true }); }
