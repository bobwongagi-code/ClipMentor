import assert from 'node:assert/strict';
import type { AgentContext } from '../agent/context';
import { execClipMentorAnalysisTool } from '../agent/tools/clipmentor-analysis-tools';
import { makeDraft } from '../editor/store';
import { historyReduce, type History } from '../editor/reducerHistory';
import { buildCommands } from '../editor/storeCommandBuilder';
import { executeTool } from '../agent/tools';
import { projectServerRunToolResult } from '../agent/serverRunToolResult';
import type { ProjectDoc } from '../editor/types';
import { checkAnalysisHandoff, pointDigest, pointReviewTargetDigest, type AnalysisActor, type ClipMentorAnalysis } from './analysis';

export async function verifyAnalysisState(base: ProjectDoc, actor: AnalysisActor) {
  const failures: string[] = [];
  let passed = 0;
  async function digestForReview(analysis: ClipMentorAnalysis, projectId: string) {
    return pointReviewTargetDigest(analysis, projectId, await pointDigest(analysis, 'P1'));
  }
  async function test(name: string, run: () => Promise<void>) {
    try { await run(); passed++; }
    catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  function fixture() {
    const draft = makeDraft(structuredClone(base));
    const state = { doc: draft.getDoc(), project: 'project-a', run: 'run-a', controller: new AbortController(), mode: 'clipmentor' };
    let writes = 0;
    const ctx: AgentContext = {
      ...draft, getDoc: () => state.doc, getCreativeMode: () => state.mode,
      getProjectId: () => state.project, getAgentRunId: () => state.run, getAgentRunSignal: () => state.controller.signal,
      commands: { ...draft.commands, applyDoc: next => { writes++; draft.commands.applyDoc(next); state.doc = draft.getDoc(); } },
      templates: [], audio: [],
    };
    return { state, ctx, writes: () => writes };
  }
  async function preparePoint(f: ReturnType<typeof fixture>) {
    const a = f.state.doc.clipMentorAnalysis!;
    a.points = [{ point_id: 'P1', unit_id: 'U1', source_range_seconds: [59.4, 62.2], evidence_ids: ['F1'],
      buying_reason_or_function: 'Usage', filming_conditions: [], uncertainties: [], required: true,
      explanation_priority: 'primary', status: 'draft', review_status: 'pending', provenance: 'fixture' }];
    return { pointId: 'P1', state: 'confirmed', actor, reason: 'Disposable state check', expectedRevision: a.revision,
      expectedPointDigest: await digestForReview(a, f.state.project) };
  }
  const read = (args: Record<string, unknown>, ctx: AgentContext) => execClipMentorAnalysisTool('read_clipmentor_analysis', args, ctx) as Promise<{ error?: string; analysis?: Record<string, any>; handoff?: Awaited<ReturnType<typeof checkAnalysisHandoff>> }>;
  const review = (args: Record<string, unknown>, ctx: AgentContext) => execClipMentorAnalysisTool('review_clipmentor_analysis', args, ctx) as Promise<{ ok?: boolean; error?: string }>;

  for (const change of ['project', 'run', 'signal', 'abort', 'in-place', 'equal-clone'] as const) await test(`write during digest: ${change}`, async () => {
    const f = fixture();
    const args = await preparePoint(f);
    assert.deepEqual((await checkAnalysisHandoff(f.state.doc)).issues.map(i => i.code), ['point_pending']);
    const digest = crypto.subtle.digest;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    crypto.subtle.digest = async (algorithm, data) => {
      entered.resolve(); await release.promise;
      return digest.call(crypto.subtle, algorithm, data);
    };
    const pending = review(args, f.ctx);
    try {
      await Promise.race([entered.promise, pending.then(result => { throw new Error(`Expected point digest: ${JSON.stringify(result)}`); })]);
      if (change === 'project') f.state.project = 'project-b';
      if (change === 'run') f.state.run = 'run-b';
      if (change === 'signal') f.state.controller = new AbortController();
      if (change === 'abort') f.state.controller.abort();
      if (change === 'in-place') f.state.doc.clipMentorAnalysis!.points[0].filming_conditions.push('A newer edit');
      if (change === 'equal-clone') f.state.doc = structuredClone(f.state.doc);
      const latest = structuredClone(f.state.doc);
      release.resolve();
      const result = await pending;
      if (change === 'equal-clone') {
        assert.equal(result.ok, true);
        assert.equal(f.writes(), 1);
      } else {
        assert.ok(result.error, 'stale call must fail');
        assert.equal(f.writes(), 0);
        assert.deepEqual(f.state.doc, latest);
      }
    } finally {
      release.resolve();
      try { await pending; } finally { crypto.subtle.digest = digest; }
    }
  });

  await test('broken point segment cannot be confirmed', async () => {
    const f = fixture();
    await preparePoint(f);
    f.state.doc.clipMentorAnalysis!.source_breakdown!.points[0].segment_ids.push('missing-segment');
    const analysis = f.state.doc.clipMentorAnalysis!;
    const args = { pointId: 'P1', state: 'confirmed', actor, reason: 'Broken reference', expectedRevision: analysis.revision,
      expectedPointDigest: await digestForReview(analysis, f.state.project) };
    const issues = (await checkAnalysisHandoff(f.state.doc)).issues.map(i => i.code);
    assert.deepEqual(issues, ['point_segment_missing', 'point_pending']);
    assert.ok((await review(args, f.ctx)).error);
    assert.equal(f.writes(), 0);
    assert.equal((await review({ ...args, state: 'needs_revision' }, f.ctx)).ok, true, 'negative feedback is still recordable');
  });
  await test('refused editor write cannot report success', async () => {
    const f = fixture();
    const args = await preparePoint(f);
    f.ctx.commands.applyDoc = () => undefined;
    assert.ok((await review(args, f.ctx)).error);
    assert.equal(f.state.doc.clipMentorAnalysis!.revision, args.expectedRevision);
  });
  await test('pre-cancelled confirmation cannot edit', async () => {
    const f = fixture();
    const args = await preparePoint(f);
    f.state.controller.abort();
    assert.ok((await review(args, f.ctx)).error);
    assert.equal(f.writes(), 0);
  });
  await test('two confirmations on the same revision have one winner', async () => {
    const f = fixture();
    const args = await preparePoint(f);
    const results = await Promise.all([review(args, f.ctx), review(args, f.ctx)]);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.equal(results.filter(result => result.error).length, 1);
    assert.equal(f.writes(), 1);
  });
  await test('point revision cannot commit after source replacement', async () => {
    const f = fixture();
    const { expectedRevision, reason } = await preparePoint(f);
    const record = structuredClone(f.state.doc.clipMentorAnalysis!.points[0]);
    record.filming_conditions.push('Revised point');
    const pending = execClipMentorAnalysisTool('revise_clipmentor_analysis', {
      action: 'revise', collection: 'points', id: record.point_id, record, expectedRevision, actor, reason,
    }, f.ctx) as Promise<{ error?: string }>;
    f.state.doc.assets[0].sourceContentHash = 'b'.repeat(64);
    assert.match((await pending).error ?? '', /Project changed/);
    assert.equal(f.writes(), 0);
  });

  for (const args of [{ view: 'full' }, { view: 'current_copy', copyPart: 'candidate', unitId: 'U1' },
    { view: 'copy_review' }, { view: 'copy_review', reviewPart: 'packet', unitId: 'U1', packetOffset: 0 }]) await test(`read during edit: ${args.view}/${args.reviewPart ?? args.copyPart ?? 'default'}`, async () => {
    const f = fixture();
    const initial = await read(args, f.ctx);
    assert.ok(initial.analysis, JSON.stringify(initial));
    if (args.view === 'copy_review') assert.equal(initial.analysis.copy_review.binding, 'current');
    const pending = read(args, f.ctx);
    f.state.doc.clipMentorAnalysis!.revision++;
    assert.ok((await pending).error, 'stale read must ask for a fresh read');
    assert.equal(f.writes(), 0);
    if (args.view === 'copy_review') assert.equal((await read(args, f.ctx)).analysis?.copy_review.binding, 'stale');
  });
  await test('project change without document change invalidates a read', async () => {
    const f = fixture();
    const pending = read({ view: 'copy_review' }, f.ctx);
    f.state.project = 'project-b';
    assert.ok((await pending).error);
  });
  await test('creative mode change invalidates the returned gate', async () => {
    const f = fixture();
    delete f.state.doc.clipMentorAnalysis;
    const pending = read({ view: 'full' }, f.ctx);
    f.state.mode = 'other';
    assert.ok((await pending).error);
  });
  await test('point states come from one snapshot when the live document changes and reverts', async () => {
    const f = fixture();
    await preparePoint(f);
    const analysis = f.state.doc.clipMentorAnalysis!;
    delete analysis.production_copy_review;
    analysis.points.push({ ...structuredClone(analysis.points[0]), point_id: 'P2', required: false });
    for (const point of analysis.points) {
      analysis.reviews.push({ point_id: point.point_id, state: 'confirmed', content_digest: await pointDigest(analysis, point.point_id),
        source_hash: analysis.source.sourceContentHash, actor, at: 1, reason: 'Fixture confirmation' });
    }
    const digest = crypto.subtle.digest;
    let hashes = 0;
    crypto.subtle.digest = async (algorithm, data) => {
      if (++hashes === 1) analysis.points[1].filming_conditions.push('Temporary change');
      if (hashes === 2) analysis.points[1].filming_conditions.pop();
      return digest.call(crypto.subtle, algorithm, data);
    };
    try {
      const result = await read({ view: 'full' }, f.ctx);
      assert.equal(hashes, 2);
      assert.deepEqual(result.handoff?.point_states.map(p => p.state), ['confirmed', 'confirmed']);
    } finally { crypto.subtle.digest = digest; }
  });
  await test('run change during packet checksum invalidates the page', async () => {
    const f = fixture();
    const digest = crypto.subtle.digest;
    let matched = false;
    crypto.subtle.digest = async (algorithm, data) => {
      if (new TextDecoder().decode(data).startsWith('{"operation_id":')) {
        matched = true;
        f.state.run = 'run-b';
      }
      return digest.call(crypto.subtle, algorithm, data);
    };
    try {
      const result = await read({ view: 'copy_review', reviewPart: 'packet', unitId: 'U1', packetOffset: 0 }, f.ctx);
      assert.equal(matched, true);
      assert.ok(result.error);
    } finally { crypto.subtle.digest = digest; }
  });
  for (const request of ['stale revision', 'cancelled write', 'cancelled read', 'invalid packet page'] as const) await test(`reject ${request} before copying the project`, async () => {
    const f = fixture();
    const args = await preparePoint(f);
    const clone = globalThis.structuredClone;
    let copies = 0;
    globalThis.structuredClone = (value, options) => { copies++; return clone(value, options); };
    if (request.startsWith('cancelled')) f.state.controller.abort();
    try {
      const result = request === 'invalid packet page'
        ? await read({ view: 'copy_review', reviewPart: 'packet', unitId: 'U1', packetOffset: -1 }, f.ctx)
        : request === 'cancelled read' ? await read({ view: 'full' }, f.ctx)
          : await review({ ...args, expectedRevision: request === 'stale revision' ? 0 : args.expectedRevision }, f.ctx);
      assert.ok(result.error);
      assert.equal(copies, 0);
      assert.equal(f.writes(), 0);
    } finally { globalThis.structuredClone = clone; }
  });
  for (const [next, state] of [['different branch', 'confirmed'], ['different branch', 'needs_revision'], ['exact redo', 'confirmed']] as const) await test(`point review after undo: ${next}/${state}`, async () => {
    const f = fixture();
    const original = await preparePoint(f);
    let history: History = { past: [], present: f.state.doc, future: [] };
    const getDoc = () => history.present;
    const commands = buildCommands(action => { history = historyReduce(history, action); }, getDoc);
    const ctx = { ...f.ctx, getDoc, commands };
    const revise = async (branch: string) => {
      const a = getDoc().clipMentorAnalysis!;
      const record = { ...a.points[0], filming_conditions: [branch] };
      const result = await executeTool('revise_clipmentor_analysis', { action: 'revise', collection: 'points', id: 'P1', record,
        expectedRevision: a.revision, actor, reason: 'Switch point wording' }, ctx) as { ok?: boolean };
      assert.equal(result.ok, true);
    };
    await revise('Branch A');
    const branchA = getDoc().clipMentorAnalysis!;
    const request = { ...original, state, reason: 'Decision on branch A only', expectedRevision: branchA.revision,
      expectedPointDigest: await digestForReview(branchA, f.state.project) };
    history = historyReduce(history, { type: 'undo' });
    assert.equal(getDoc().clipMentorAnalysis!.revision, original.expectedRevision);
    if (next === 'different branch') await revise('Branch B');
    else history = historyReduce(history, { type: 'redo' });
    assert.equal(getDoc().clipMentorAnalysis!.revision, request.expectedRevision);
    const before = structuredClone(getDoc());
    const result = await executeTool('review_clipmentor_analysis', request, ctx) as { ok?: boolean; error?: string };
    if (next === 'different branch') {
      assert.match(result.error ?? '', /Point review target changed/, 'same numeric revision must not write a decision about different content');
      assert.deepEqual(getDoc(), before);
    } else {
      assert.equal(result.ok, true);
      assert.equal(getDoc().clipMentorAnalysis!.reviews[0].content_digest, await pointDigest(branchA, 'P1'));
    }
  });
  await test('point target is returned with the snapshot and revision used for review', async () => {
    const f = fixture();
    const args = await preparePoint(f);
    const result = await read({ pointId: 'P1' }, f.ctx) as { revision?: number; point_review_target?: { point_id: string; point: unknown; digest: string } };
    assert.equal(result.revision, args.expectedRevision);
    assert.deepEqual(result.point_review_target, { point_id: 'P1', point: f.state.doc.clipMentorAnalysis!.points[0], digest: args.expectedPointDigest });
    assert.equal((await review({ ...args, expectedPointDigest: result.point_review_target!.digest }, f.ctx)).ok, true);
  });
  await test('point target read discards a digest computed during a concurrent edit', async () => {
    const f = fixture();
    await preparePoint(f);
    const digest = crypto.subtle.digest;
    let mutated = false;
    crypto.subtle.digest = async (algorithm, data) => {
      if (!mutated) {
        mutated = true;
        f.state.doc.clipMentorAnalysis!.points[0].filming_conditions.push('New wording during read');
      }
      return digest.call(crypto.subtle, algorithm, data);
    };
    try {
      const result = await read({ view: 'full', pointId: 'P1' }, f.ctx);
      assert.equal(mutated, true);
      assert.ok(result.error);
      assert.equal('point_review_target' in result, false);
      assert.equal(f.writes(), 0);
    } finally { crypto.subtle.digest = digest; }
  });
  await test('unbound or malformed review cannot be written', async () => {
    const f = fixture();
    const args = await preparePoint(f);
    for (const expectedPointDigest of [undefined, null, 'bad', '0'.repeat(64)]) {
      assert.ok((await review({ ...args, expectedPointDigest }, f.ctx)).error);
    }
    assert.equal(f.writes(), 0);
  });
  for (const identity of ['project', 'analysis'] as const) await test(`a decision cannot carry across a copied ${identity}`, async () => {
    const f = fixture();
    const args = await preparePoint(f);
    f.state.doc = structuredClone(f.state.doc);
    if (identity === 'project') f.state.project = 'duplicate-project';
    else f.state.doc.clipMentorAnalysis!.analysis_id = 'another-analysis';
    assert.match((await review(args, f.ctx)).error ?? '', /Point review target changed/);
    assert.equal(f.writes(), 0);
  });
  await test('point and digest reach the browser transport in a long analysis', async () => {
    const f = fixture();
    const args = await preparePoint(f);
    f.state.doc.clipMentorAnalysis!.import_origin = 'large history '.repeat(60_000);
    const result = projectServerRunToolResult(await read({ pointId: 'P1' }, f.ctx)) as {
      revision?: number; point_review_target?: { point?: unknown; digest: string };
    };
    assert.equal(result.revision, args.expectedRevision);
    assert.equal(result.point_review_target?.digest, args.expectedPointDigest);
    assert.deepEqual(result.point_review_target?.point, f.state.doc.clipMentorAnalysis!.points[0]);
    assert.ok(JSON.stringify(result).length < 8_000);
  });
  await test('a point read cannot silently ignore a separate evidence selector', async () => {
    const f = fixture();
    await preparePoint(f);
    const result = await read({ pointId: 'P1', evidenceIds: ['F1'] }, f.ctx);
    assert.match(result.error ?? '', /evidenceIds requires the evidence view/);
    assert.equal('point_review_target' in result, false);
  });
  await test('an oversized point cannot take its digest out of the transport', async () => {
    const f = fixture();
    await preparePoint(f);
    const a = f.state.doc.clipMentorAnalysis!;
    a.points[0].filming_conditions.push('Large source note '.repeat(50_000));
    const result = projectServerRunToolResult(await read({ pointId: 'P1' }, f.ctx)) as {
      revision?: number; point_review_target?: { digest: string; point_omitted?: boolean };
    };
    assert.equal(result.revision, a.revision);
    assert.equal(result.point_review_target?.digest, await digestForReview(a, f.state.project));
    assert.equal(result.point_review_target?.point_omitted, true);
  });
  console.log(`Analysis state: ${passed} passed, ${failures.length} failed`);
  assert.deepEqual(failures, []);
}
