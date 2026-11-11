import assert from 'node:assert/strict';
import type { ProjectDoc } from '../../src/editor/types';
import { createAgentRun, type AgentRunContext, type AgentRunRecord } from '../../src/persist/agentRuntimeStore';
import { digestValue, runtimeEvent } from '../agent-runs/store-values';
import { checkProductionAuthorBlueprint, productionAuthorSelfCheckSource, productionRepairTargets, selectAuthorSelfCheckReceipt } from './production-author-self-check';
import type { createProductionPreparation } from './production-readiness';
import type { EffectKind, ProductionTask, StageContext } from './production-task';

export async function verifyAuthorSelfCheckRecovery(doc: ProjectDoc, prepared: Awaited<ReturnType<typeof createProductionPreparation>>) {
  const guide = 'Fixture self-check guide';
  const brief = 'Check the current fixture wording';
  const checks = Array.from({ length: 7 }, (_, index) => ({ id: `S${index + 1}`, status: index === 0 ? 'fix' : 'ok', reference: brief, reason: 'Fixture finding' }));
  const text = JSON.stringify(checks);
  const source = { ...productionAuthorSelfCheckSource(doc, prepared, [brief]), repairReview: [], unchangedReviewedDelivery: [] };
  const sourceDigest = digestValue({ source, guide });
  const currentName = `blueprint-author-self-check:${sourceDigest}`;
  const legacyName = 'blueprint-author-self-check';
  const outcome = { digest: prepared.reviewed.subject.digest, sourceDigest, runId: 'saved-format-retry', checks };
  const failures: string[] = [];
  let passed = 0;
  let sequence = 0;
  async function test(name: string, verify: () => Promise<void>) {
    try { await verify(); passed++; }
    catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  function fixture(allowFormatRetry = false) {
    const projectId = `author-self-check-recovery-fixture-${++sequence}`;
    const task = { taskId: 'fixture-task', projectId, stage: 'copy_review', projectRevision: 'saved-revision', repairs: 0,
      feedbackUsed: false, updatedAt: 150, completed: { blueprint: { at: 100, artifact: { revision: 'saved-revision' } } }, effects: {},
      input: { brief, author: { provider: 'fixture-provider', model: 'fixture-model' } } } as unknown as ProductionTask;
    const names: string[] = [];
    const key = (name: string) => `copy_review:initial:0:${name}`;
    const stage: StageContext = {
      signal: new AbortController().signal,
      hasEffect: (kind, name) => task.effects[key(name)]?.kind === kind,
      async effect<T>(_kind: EffectKind, name: string, _work: (id: string) => Promise<T>, recover?: (id: string) => Promise<T>) {
        names.push(name);
        const prior = task.effects[key(name)];
        if (!prior && allowFormatRetry && name === `${currentName}:format-retry`) return structuredClone(outcome) as T;
        assert.ok(prior, 'Recovery must not dispatch a new model call');
        if (prior.status === 'completed') return structuredClone(prior.result) as T;
        assert.ok(recover);
        return recover(prior.operationId);
      },
    };
    function receipt(runId: string, userInputDigest: string, chunks: Array<[string, unknown]>): AgentRunRecord {
      return { version: 1, runId, projectId, status: 'running', askOnly: true, userInputPreview: '', userInputDigest,
        createdAt: 105, updatedAt: 140, backend: 'api', provider: 'fixture-provider', modelId: 'fixture-model',
        context: { requestShapeHash: 'd'.repeat(64), transportStatus: 'completed' } as AgentRunContext,
        artifactIds: [], checkpointIds: [], proposalIds: [], events: chunks.map(([type, data], i) => ({
          ...runtimeEvent({ id: i + 1, type, data, at: 110 + i }), eventId: `event-${i}`, projectId, runId,
          sequence: i + 1, createdAt: 110 + i,
        })),
      };
    }
    return { task, key, names, receipt, run: () => checkProductionAuthorBlueprint(task, stage, doc, prepared, guide, []) };
  }
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Unexpected network in self-check recovery fixture'); };
  try {
    const completed: Array<[string, unknown]> = [['text-delta', { text }], ['done', { status: 'completed' }]];
    await test('an explicitly different request digest cannot qualify as legacy', async () => {
      const f = fixture();
      const other = f.receipt('other-operation', 'b'.repeat(64), completed);
      assert.equal(selectAuthorSelfCheckReceipt([other], f.task, 'expected-operation', sourceDigest, 100, true), undefined);
    });
    for (const withDigest of [true, false]) await test(`an exact completed receipt can recover with text digest=${withDigest}`, async () => {
      const f = fixture();
      f.task.effects[f.key(currentName)] = { kind: 'model', operationId: 'exact-operation', status: 'reserved' };
      const run = f.receipt('exact-operation', sourceDigest, completed);
      const events = withDigest ? run.events : run.events.map(event => {
        const saved = JSON.parse(event.summary!);
        delete saved.serverEvent.rawTextDigest;
        return { ...event, summary: JSON.stringify(saved) };
      });
      await createAgentRun({ ...run, events });
      assert.deepEqual((await f.run()).checks, checks);
      assert.deepEqual(f.names, [currentName]);
    });
    await test('text after terminal completion cannot complete a malformed receipt', async () => {
      const f = fixture();
      f.task.effects[f.key(currentName)] = { kind: 'model', operationId: 'late-text-operation', status: 'reserved' };
      await createAgentRun(f.receipt('late-text-operation', sourceDigest, [
        ['text-delta', { text: text.slice(0, -1) }], ['done', { status: 'completed' }], ['text-delta', { text: ']' }],
      ]));
      await assert.rejects(f.run(), /recovery_incomplete/);
      assert.deepEqual(f.names, [currentName]);
    });
    await test('historical failed slot reads its original receipt instead of making a new reservation', async () => {
      const f = fixture();
      f.task.effects[f.key(legacyName)] = { kind: 'model', operationId: 'legacy-reservation', status: 'failed', error: 'Error: blueprint_author_self_check_invalid:S1' };
      await createAgentRun(f.receipt('legacy-run-without-explicit-source-digest', 'd'.repeat(64), completed));
      assert.deepEqual((await f.run()).checks, checks);
      assert.deepEqual(f.names, [legacyName]);
    });
    for (const status of ['failed', 'reserved'] as const) await test(`a saved format repair is reusable after the ${status} primary run is gone`, async () => {
      const f = fixture();
      f.task.effects[f.key(currentName)] = { kind: 'model', operationId: 'removed-original-run', status,
        ...(status === 'failed' ? { error: 'Error: blueprint_author_self_check_invalid_json' } : {}) };
      f.task.effects[f.key(`${currentName}:format-retry`)] = { kind: 'model', operationId: 'saved-format-retry', status: 'completed', result: outcome };
      assert.deepEqual(await f.run(), outcome);
      assert.deepEqual(f.names, [`${currentName}:format-retry`]);
    });
    await test('a receipt missing its earlier events cannot supply a passing result', async () => {
      const f = fixture();
      const run = f.receipt('truncated-run', sourceDigest, [['text-delta', { text: 'Missing prefix' }], ...completed]);
      f.task.effects[f.key(currentName)] = { kind: 'model', operationId: run.runId, status: 'reserved' };
      await createAgentRun({ ...run, events: run.events.slice(1) });
      await assert.rejects(f.run(), /recovery_incomplete/);
      assert.deepEqual(f.names, [currentName]);
    });
    await test('a cached format repair must match its reserved operation', async () => {
      const f = fixture();
      f.task.effects[f.key(currentName)] = { kind: 'model', operationId: 'missing-first-run', status: 'failed', error: 'Error: blueprint_author_self_check_invalid_json' };
      f.task.effects[f.key(`${currentName}:format-retry`)] = { kind: 'model', operationId: 'format-reservation', status: 'completed', result: outcome };
      await assert.rejects(f.run(), /recovery_binding_mismatch/);
    });
    await test('a format slot without a primary reservation never submits a primary call', async () => {
      const f = fixture();
      f.task.effects[f.key(`${currentName}:format-retry`)] = { kind: 'model', operationId: 'saved-format-retry', status: 'completed', result: outcome };
      await assert.rejects(f.run(), /recovery_binding_mismatch/);
      assert.deepEqual(f.names, []);
    });
    await test('a legacy malformed receipt does not authorize a format retry', async () => {
      const f = fixture();
      f.task.effects[f.key(currentName)] = { kind: 'model', operationId: 'old-slot', status: 'failed', error: 'Error: blueprint_author_self_check_invalid:S1' };
      await createAgentRun(f.receipt('legacy-malformed', 'd'.repeat(64), [['text-delta', { text: '[]' }], ['done', { status: 'completed' }]]));
      await assert.rejects(f.run(), /recovery_run_unverified/);
      assert.deepEqual(f.names, [currentName]);
    });
    await test('a cached repair with an unresolved finding cannot report all checks passed', async () => {
      const f = fixture();
      const unit = prepared.rawPacket.units[0];
      const quote = unit.lines[0].narration_ms;
      f.task.repairContext = { pending_review_repair: { status: 'bound', units: [{ unit_id: unit.unit_id,
        findings: [{ finding_id: 'pending-finding', quote, reason: 'Fixture original finding' }] }] } };
      const repairSource = { ...source, repairReview: productionRepairTargets(f.task, prepared.rawPacket) };
      const repairDigest = digestValue({ source: repairSource, guide });
      const repairName = `${legacyName}:${repairDigest}`;
      const cached = checks.map(check => ({ ...check, status: 'ok', ...(check.id === 'S2' ? {
        repair_resolutions: [{ finding_id: 'pending-finding', status: 'unresolved', reference: [quote], reason: 'Still unresolved' }],
      } : {}) }));
      f.task.effects[f.key(repairName)] = { kind: 'model', operationId: 'missing-original', status: 'failed', error: 'Error: blueprint_author_self_check_invalid_json' };
      f.task.effects[f.key(`${repairName}:format-retry`)] = { kind: 'model', operationId: outcome.runId, status: 'completed',
        result: { ...outcome, sourceDigest: repairDigest, checks: cached } };
      assert.equal((await f.run()).checks.find(check => check.id === 'S2')?.status, 'fix');
      assert.equal(cached.find(check => check.id === 'S2')?.status, 'ok', 'recovery leaves stored evidence intact');
    });
    for (const rawText of ['', 'invalid JSON']) await test(`an exactly bound complete response qualifies for format repair: ${rawText || 'empty'}`, async () => {
      const f = fixture(true);
      f.task.effects[f.key(currentName)] = { kind: 'model', operationId: 'empty-completed-run', status: 'reserved' };
      await createAgentRun(f.receipt('empty-completed-run', sourceDigest, [
        ...(rawText ? [['text-delta', { text: rawText }] as [string, unknown]] : []),
        ['text-end', { characterCount: rawText.length, utf8Bytes: rawText.length }], ['done', { status: 'completed' }],
      ]));
      assert.deepEqual(await f.run(), outcome);
      assert.deepEqual(f.names, [currentName, `${currentName}:format-retry`]);
    });
    for (const reference of ['https://example.com', 'https://EXAMPLE.com/a']) await test(`persisted text projection is not a format failure: ${reference}`, async () => {
      const f = fixture();
      f.task.input.brief = `Read ${reference}`;
      const projectedSource = { ...source, originalRequirements: [f.task.input.brief] };
      const digest = digestValue({ source: projectedSource, guide });
      const name = `${legacyName}:${digest}`;
      const rawText = JSON.stringify(checks.map(check => ({ ...check, reference })));
      const run = f.receipt('projected-url-run', digest, [['text-delta', { text: rawText }], ['done', { status: 'completed' }]]);
      assert.notEqual(JSON.parse(run.events[0].summary!).serverEvent.data.text, rawText);
      const persistedEvent = JSON.parse(run.events[0].summary!).serverEvent;
      assert.equal(persistedEvent.rawTextChanged, true);
      assert.equal(persistedEvent.rawTextDigest, undefined);
      f.task.effects[f.key(name)] = { kind: 'model', operationId: run.runId, status: 'reserved' };
      await createAgentRun(run);
      await assert.rejects(f.run(), /recovery_text_changed/);
      assert.deepEqual(f.names, [name]);
    });
    await test('persisted redaction leaves no raw text fingerprint', async () => {
      const fixtureValue = 'synthetic-short-value';
      const text = `password: ${fixtureValue}`;
      const saved = runtimeEvent({ id: 1, type: 'text-delta', data: { text }, at: 1 });
      const persistedEvent = JSON.parse(saved.summary!).serverEvent;
      assert.equal(persistedEvent.data.text, 'password: [REDACTED]');
      assert.equal(persistedEvent.rawTextChanged, true);
      assert.equal(persistedEvent.rawTextDigest, undefined);
      assert.ok(!saved.summary!.includes(fixtureValue));
    });
    await test('an invalid older receipt without raw text proof does not authorize a new retry', async () => {
      const f = fixture();
      const run = f.receipt('older-unverified-run', sourceDigest, [['text-delta', { text: 'invalid JSON' }], ['done', { status: 'completed' }]]);
      const events = run.events.map(event => {
        const saved = JSON.parse(event.summary!);
        delete saved.serverEvent.rawTextDigest;
        return { ...event, summary: JSON.stringify(saved) };
      });
      f.task.effects[f.key(currentName)] = { kind: 'model', operationId: run.runId, status: 'reserved' };
      await createAgentRun({ ...run, events });
      await assert.rejects(f.run(), /recovery_run_unverified/);
      assert.deepEqual(f.names, [currentName]);
    });
  } finally { globalThis.fetch = fetchBefore; }
  console.log(`Author self-check recovery: ${passed} passed, ${failures.length} failed`);
  assert.deepEqual(failures, []);
}
