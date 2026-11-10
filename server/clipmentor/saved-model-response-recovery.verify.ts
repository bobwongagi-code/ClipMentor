import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import fixture from '../../src/clipmentor/fixtures/copy-review-r171-contract.json';
import { observeSourceVideo, readSourceVideoReceipt, sourceVideoInput, type SourceVideoDependencies } from './source-video.ts';
import { reviewClipMentorCopy, type CopyReviewDependencies } from './copy-review.ts';
import { readSavedExternalResponse } from './external-call.ts';
import type { CopyReviewRequest } from '../../shared/clipmentor-copy-review.ts';

type Kind = 'source' | 'copy';
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const video = Buffer.from('local-source-video-fixture');
function requestFor(kind: Kind): CopyReviewRequest {
  const request = structuredClone(fixture.request) as CopyReviewRequest;
  request.operationId = kind === 'source' ? 'ac981860-1614-4c3e-a665-f2427522e43c' : '6490827e-74bc-4cf0-a93e-8066b85a6f74';
  if (kind === 'source') request.source.hash = hash(video);
  for (const unit of request.packet.units) unit.source_context = {
    scope: 'frozen_task_scope', source_ranges: [[0, request.source.duration]],
    evidence_ids: request.packet.source_evidence.filter(e => e.time_seconds?.length).map(e => e.evidence_id), speech: 'unavailable',
  };
  return request;
}
function sourceResponse(request: CopyReviewRequest) {
  const input = sourceVideoInput(request);
  return { status: 200, body: { modelVersion: 'local-fixture-model', candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({
    windows: input.units.flatMap(unit => unit.windows.map(window => ({ window_id: window.window_id,
      observed_sequence: 'Fixture continuous action; no production judgment', endpoint: 'Fixture endpoint unknown',
      evidence: [{ start_seconds: window.source_range_seconds[0], end_seconds: window.source_range_seconds[1], visible: 'Fixture visible action', audible: 'Unclear fixture audio' }],
    }))),
    lines: input.units.flatMap(unit => unit.lines.map(line => ({ unit_id: unit.unit_id, line_id: line.line_id,
      status: 'insufficient_evidence', reason: 'Fixture cannot establish edited narration sync', window_ids: [unit.windows[0].window_id] }))),
    limitations: ['Fixture only; semantic and production approval unverified'],
  }) }] } }] } };
}
function dependencies(directory: string, request: CopyReviewRequest, dispatch: () => Promise<void>, verifyHash?: () => void) {
  let frames = 0;
  const shared = { directory, resolve: () => '/local-fixture-master', hash: async () => { verifyHash?.(); return request.source.hash; } };
  const source: SourceVideoDependencies = { ...shared, key: 'local-fixture-only', read: async () => video,
    size: async () => video.length, audioPresent: async () => true,
    post: async () => { await dispatch(); return sourceResponse(request); } };
  const copy: CopyReviewDependencies = { ...shared, frame: async () => { frames++; return Buffer.from('fixture-image').toString('base64'); },
    run: async () => { await dispatch(); return structuredClone(fixture.raw_review); } };
  return { source, copy, frames: () => frames };
}
async function read(kind: Kind, request: CopyReviewRequest, deps: ReturnType<typeof dependencies>) {
  return kind === 'source' ? readSourceVideoReceipt(request.operationId, request.projectId, deps.source)
    : reviewClipMentorCopy(request, deps.copy, undefined, true);
}
async function assertBlocked(kind: Kind, request: CopyReviewRequest, deps: ReturnType<typeof dependencies>) {
  if (kind === 'source') {
    const result = await readSourceVideoReceipt(request.operationId, request.projectId, deps.source);
    assert.equal(result.status, 'failed'); assert.equal(result.result, undefined); assert.equal(result.requestsAttempted, 1);
  } else await assert.rejects(reviewClipMentorCopy(request, deps.copy, undefined, true), /review_cancelled_or_timed_out/);
}

const workerKind = process.argv[2];
if (workerKind === 'source-crash-worker' || workerKind === 'copy-crash-worker') {
  const kind: Kind = workerKind === 'source-crash-worker' ? 'source' : 'copy';
  const directory = process.argv[3], request = requestFor(kind);
  await mkdir(directory, { recursive: true });
  let hashReads = 0;
  const deps = dependencies(directory, request, async () => { await appendFile(join(directory, 'dispatch.ndjson'), 'local-fixture\n'); }, () => {
    hashReads++;
    // The raw envelope and reserved parent have been saved, but no completed
    // receipt exists. Exit bypasses catch/finally in the real adapter.
    if (hashReads === (kind === 'source' ? 2 : 3)) process.exit(73);
  });
  if (kind === 'source') await observeSourceVideo(request, deps.source);
  else await reviewClipMentorCopy(request, deps.copy);
  process.exit(74);
}

const root = await mkdtemp(join(tmpdir(), 'clipmentor-saved-model-read-'));
try {
  for (const kind of ['source', 'copy'] as const) {
    const request = requestFor(kind), directory = join(root, `${kind}-late`);
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let calls = 0;
    const deps = dependencies(directory, request, async () => { calls++; started.resolve(); await release.promise; });
    const controller = new AbortController();
    const pending = kind === 'source' ? observeSourceVideo(request, deps.source, controller.signal)
      : reviewClipMentorCopy(request, deps.copy, controller.signal);
    const rejected = assert.rejects(pending);
    await started.promise; controller.abort(); await rejected;
    const parent = join(directory, `${request.operationId}.json`), frozen = await readFile(parent, 'utf8');
    await assertBlocked(kind, request, deps);
    release.resolve();
    for (let at = 0; at < 100; at++) {
      if (await readSavedExternalResponse(directory, request.operationId)) break;
      await delay(5);
    }
    assert(await readSavedExternalResponse(directory, request.operationId), 'complete late raw must actually be durable');
    const frameCount = deps.frames();
    const result = await read(kind, request, deps) as any;
    if (kind === 'source') {
      assert.equal(result.status, 'completed'); assert.equal(result.local_response_recovery, true);
      assert.equal(result.original_operation_status, 'failed'); assert.equal(result.requestsSent, 0);
      assert.equal(result.result.validation.status, 'valid'); assert.equal(result.complete_film_accepted, false);
      assert.equal(result.result.raw_observation.lines[0].status, 'insufficient_evidence');
    } else {
      assert.equal(result.cached, true); assert.equal(result.receipt.verdict, 'insufficient_evidence');
      assert.deepEqual(result.receipt.units.map((unit: any) => unit.group_checks), fixture.raw_review.copy_units.map(unit => unit.group_checks),
        'original negative/unknown reviewer judgments stay intact');
    }
    assert.equal(result.requestsAttempted, 1); assert.equal(calls, 1); assert.equal(deps.frames(), frameCount);
    assert.equal(await readFile(parent, 'utf8'), frozen, 'read recovery must preserve the original cancelled operation');
    await read(kind, request, deps); assert.equal(calls, 1); assert.equal(deps.frames(), frameCount);
    const changed = { ...deps, source: { ...deps.source, hash: async () => 'b'.repeat(64) }, copy: { ...deps.copy, hash: async () => 'b'.repeat(64) } };
    await assertBlocked(kind, request, changed);
    if (kind === 'source') await assert.rejects(readSourceVideoReceipt(request.operationId, 'foreign-project', deps.source));
    else await assert.rejects(reviewClipMentorCopy({ ...request, projectId: 'foreign-project' }, deps.copy, undefined, true));

    const externalDirectory = join(directory, 'external-calls');
    const name = (await readdir(externalDirectory)).find(name => /^[a-f0-9]{64}\.response$/.test(name))!;
    const rawPath = join(externalDirectory, name), rawText = await readFile(rawPath, 'utf8');
    const rowPath = rawPath.replace('.response', '.json'), rowText = await readFile(rowPath, 'utf8');
    await rm(rawPath); await assertBlocked(kind, request, deps); await writeFile(rawPath, rawText);
    await writeFile(rawPath, '{}'); await assertBlocked(kind, request, deps); await writeFile(rawPath, rawText);
    // A self-consistent archive for a different semantic identity cannot stand in
    // for the exact reserved operation merely because its raw JSON is parseable.
    const envelope = JSON.parse(rawText); envelope.value.fingerprint = 'f'.repeat(64);
    envelope.value_sha256 = hash(JSON.stringify(envelope.value));
    const wrongRaw = JSON.stringify(envelope), row = JSON.parse(rowText); row.response_sha256 = hash(wrongRaw);
    await writeFile(rawPath, wrongRaw); await writeFile(rowPath, JSON.stringify(row));
    await assertBlocked(kind, request, deps);
    await writeFile(rawPath, rawText); await writeFile(rowPath, rowText);
    const invalid = JSON.parse(rawText);
    if (kind === 'source') invalid.value.body.candidates[0].finishReason = 'MAX_TOKENS';
    else invalid.value.raw_review = {};
    invalid.value_sha256 = hash(JSON.stringify(invalid.value));
    const invalidRaw = JSON.stringify(invalid), invalidRow = JSON.parse(rowText); invalidRow.response_sha256 = hash(invalidRaw);
    await writeFile(rawPath, invalidRaw); await writeFile(rowPath, JSON.stringify(invalidRow));
    await assertBlocked(kind, request, deps);
    await writeFile(rawPath, rawText); await writeFile(rowPath, rowText);
    const legacy = JSON.parse(frozen);
    delete legacy[kind === 'source' ? 'source_src' : 'prompt_sha256'];
    await writeFile(parent, JSON.stringify(legacy)); await assertBlocked(kind, request, deps); await writeFile(parent, frozen);
    const drifting = { ...deps, source: { ...deps.source, hash: async () => { await writeFile(parent, frozen + '\n'); return request.source.hash; } },
      copy: { ...deps.copy, hash: async () => { await writeFile(parent, frozen + '\n'); return request.source.hash; } } };
    await assertBlocked(kind, request, drifting); await writeFile(parent, frozen);
    assert.equal(calls, 1); assert.equal(deps.frames(), frameCount); assert.equal(await readFile(parent, 'utf8'), frozen);

    const crashDirectory = join(root, `${kind}-crash`);
    const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), `${kind}-crash-worker`, crashDirectory],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000 });
    assert.equal(child.status, 73, child.stderr);
    const crashParent = join(crashDirectory, `${request.operationId}.json`), crashed = await readFile(crashParent, 'utf8');
    assert.equal(JSON.parse(crashed).status, 'reserved');
    const crashDeps = dependencies(crashDirectory, request, async () => { throw Error('No second dispatch allowed'); });
    const recovered = await read(kind, request, crashDeps) as any;
    assert.equal(kind === 'source' ? recovered.status : recovered.receipt.verdict, kind === 'source' ? 'completed' : 'insufficient_evidence');
    assert.equal(recovered.requestsAttempted, 1); assert.equal(crashDeps.frames(), 0);
    assert.equal(await readFile(crashParent, 'utf8'), crashed);
    assert.equal((await readFile(join(crashDirectory, 'dispatch.ndjson'), 'utf8')).trim().split('\n').length, 1);
  }
  console.log('Saved source/copy response recovery: cancelled late raw, real subprocess crash, immutable original attempts/judgments, missing/corrupt/wrong-identity/source-drift/refused reads and zero repeated dispatch/extraction passed');
} finally { await rm(root, { recursive: true, force: true }); }
