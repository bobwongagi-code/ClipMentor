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
          self_review: 'AUTHOR_VERDICT_MUST_NOT_LEAK', reason: 'AUTHOR_REASON_MUST_NOT_LEAK', production_allowed: true } } } }],
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
  copy_units: [{ unit_id: 'U1', verdict: 'pass', findings: [] }] });
const root = await mkdtemp(join(tmpdir(), 'clipmentor-copy-review-test-'));
let calls = 0, extracted = 0;
let mode: 'pass' | 'fail' | 'unknown' | 'copy_block' | 'throw' | 'invalid' = 'pass';
const sensitive = 'synthetic-credential-must-not-appear';
const deps: CopyReviewDependencies = {
  directory: root, resolve: (name) => name === 'review-test.mp4' ? 'mock-original' : null,
  hash: async () => 'a'.repeat(64),
  frame: async () => { extracted++; return 'aGVsbG8='; },
  async run(prompt, frames, runId, projectId) {
    calls++;
    assert(prompt.includes('CURRENT_PLAN_CONTENT'));
    assert(!prompt.includes('AUTHOR_'));
    assert.equal(frames.length, 6);
    assert.deepEqual(frames.map((f) => f.phase), ['original', 'original', 'original', 'explanation', 'explanation', 'explanation']);
    assert(runId.startsWith('clipmentor-review:')); assert.equal(projectId, 'test-project');
    if (mode === 'throw') throw new Error(sensitive);
    if (mode === 'invalid') return {};
    const raw = goodRaw();
    if (mode === 'copy_block') return { ...raw, copy_units: [{ unit_id: 'U1', verdict: 'pass', findings: [{ severity: 'blocking', quote: line.narration_ms, reason: 'Synthetic copy error' }] }] };
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
  assert.equal(pass.inspection.continuous_viewing, false); assert.equal(pass.inspection.listening, false);
  assert.deepEqual(await reviewClipMentorCopy(first, deps), { ...pass, cached: true });
  assert.equal(calls, 1); assert.equal(extracted, 6, 'completed replay does not repeat extraction or model turn');
  await assert.rejects(reviewClipMentorCopy({ ...first, projectId: 'different' }, deps)); assert.equal(calls, 1);
  await assert.rejects(reviewClipMentorCopy({ ...first, verdict: 'pass' }, deps));
  await assert.rejects(reviewClipMentorCopy({ ...first, maxRequests: 2 }, deps)); assert.equal(calls, 1);
  mode = 'fail'; assert.equal((await reviewClipMentorCopy(await request(), deps)).receipt.verdict, 'needs_revision');
  mode = 'unknown'; assert.equal((await reviewClipMentorCopy(await request(), deps)).receipt.verdict, 'insufficient_evidence');
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
  const restored = structuredClone(active.draft.getDoc()); restored.clipMentorAnalysis!.revision++;
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
  const plugin = clipMentorCopyReviewPlugin(deps);
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
    if (!m.result.success || m.result.contentItems[0].type !== 'inputText'
      || !m.result.contentItems[0].text.includes('U1/original')
      || m.result.contentItems[1].type !== 'inputImage') process.exit(82);
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
