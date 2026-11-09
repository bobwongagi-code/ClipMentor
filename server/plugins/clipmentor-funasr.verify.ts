import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { transcribeClipMentorSource, parseFunAsrResponse, clipMentorFunAsrPlugin } from './clipmentor-funasr.ts';
import { ASR_AUDIO, isSourceTranscription, planAsrChunks, stitchAsrChunks, type AsrChunk } from '../../shared/clipmentor-asr.ts';
import { keyStatus, seedKeystore } from '../keystore.ts';

const directory = await mkdtemp(join(tmpdir(), 'cc-funasr-verify-'));
const secret = 'test-secret-never-echo';
const hash = 'a'.repeat(64);
const endpoint = 'https://test-workspace.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
let calls = 0, duration = 100, failAt = -1, oversized = false, missingTimes = false;
let submitted: Record<string, unknown>[] = [];
const deps = {
  directory, key: () => secret, endpoint: () => endpoint, resolve: () => '/test/master.mp4', hash: async () => hash,
  probe: async () => ({ duration, fps: 30, bytes: 123 }),
  encode: async (_file: string, start: number, end: number) => oversized && end - start > 130 ? new Uint8Array(8_000_001) : new Uint8Array([Math.round(start) % 255, 1, 2]),
  fetch: (async (_input, init) => {
    calls++; submitted.push(JSON.parse(String(init?.body)));
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${secret}`);
    if (calls === failAt) throw new Error(`Sensitive upstream failure ${secret}`);
    return Response.json({ request_id: 'request-test', output: { sentence: { text: 'hello',
      ...(missingTimes ? {} : { words: [{ text: 'hello', begin_time: 640, end_time: 900 }] }) } } });
  }) as typeof fetch,
};
const args = () => ({ src: '/media/uploads/master.mp4', expectedSourceHash: hash, language: 'auto', operationId: randomUUID(), maxRequests: 10 });
try {
  assert.equal(parseFunAsrResponse({ output: { sentence: { words: [
    { text: 'hello', begin_time: 0, end_time: 200 }, { text: ' ', begin_time: 200, end_time: 250 },
  ] } } }, 0).words.length, 1, 'provider whitespace separators are not spoken words');
  assert.deepEqual(planAsrChunks(601), [[0, 240], [238, 478], [476, 601]]);
  assert.deepEqual(planAsrChunks(240), [[0, 240]]);
  const first = args(); const result = await transcribeClipMentorSource(first, deps);
  assert(isSourceTranscription(result)); assert.equal(calls, 1);
  assert.deepEqual(result.audio, ASR_AUDIO); assert.equal(result.words[0].start_seconds, 0.64);
  assert.equal(result.requested_language, 'auto'); assert.equal(result.detected_language, null);
  assert(!('language_hints' in (submitted[0].parameters as Record<string, unknown>)));
  assert.equal(result.status, 'completed');
  assert.deepEqual(await transcribeClipMentorSource(first, deps), result); assert.equal(calls, 1, 'same operation never charges again');
  const firstLedger=join(directory,`${first.operationId}.json`),savedFirst=JSON.parse(await readFile(firstLedger,'utf8'));
  savedFirst.result.status='failed';savedFirst.result.words=[];savedFirst.result.chunks[0].status='failed';savedFirst.result.chunks[0].words=[];savedFirst.result.chunks[0].failure_stage='timestamps';
  savedFirst.result.issues=['chunk-1:provider_request_failed_or_invalid_timestamps'];
  const frozenFailure=JSON.stringify(savedFirst);await writeFile(firstLedger,frozenFailure);
  const recovered=await transcribeClipMentorSource(first,deps);assert.equal(recovered.status,'completed');assert.equal(recovered.words[0].text,'hello');assert.equal(calls,1);
  assert.equal(await readFile(firstLedger,'utf8'),frozenFailure,'local raw recovery preserves the original failure');
  await assert.rejects(transcribeClipMentorSource({ ...first, language: 'vi' }, deps), /another source or configuration/);
  assert.equal(calls, 1);
  const vi = await transcribeClipMentorSource({ ...args(), language: 'vi' }, deps);
  assert.equal(vi.requested_language, 'vi');
  assert.deepEqual((submitted.at(-1)!.parameters as Record<string, unknown>).language_hints, ['vi']);

  duration = 601; const beforeLong = calls;
  const long = await transcribeClipMentorSource(args(), deps);
  assert.equal(calls - beforeLong, 3); assert.equal(long.requests_attempted, 3);
  assert.deepEqual(long.chunks.map((c) => c.offset_seconds), [0, 238, 476]);
  assert.equal(long.chunks[1].words[0].start_seconds, 238.64);
  assert(long.conflicts.length > 0, 'disagreeing overlap is explicit, never fuzzy-merged');
  const beforeBudget = calls;
  const budget = await transcribeClipMentorSource({ ...args(), maxRequests: 1 }, deps);
  assert.equal(budget.requests_attempted, 0); assert.equal(calls, beforeBudget);
  assert.equal(budget.status, 'failed');

  const reuseCount=calls;await transcribeClipMentorSource(args(),deps);assert.equal(calls,reuseCount,'same complete source/chunks with a new operation reuse raw results');
  deps.directory=join(directory,'partial-case');
  failAt = calls + 2;
  const partialArgs = args(); const partial = await transcribeClipMentorSource(partialArgs, deps);
  assert.equal(partial.status, 'partial'); assert.equal(partial.requests_attempted, 2);
  assert.deepEqual(partial.chunks.map((c) => c.status), ['completed', 'failed', 'not_requested']);
  assert(!JSON.stringify(partial).includes(secret));
  const afterPartial = calls;
  await transcribeClipMentorSource(partialArgs, deps); assert.equal(calls, afterPartial);
  failAt = -1; duration = 240; oversized = true;deps.directory=join(directory,'split-case');
  const split = await transcribeClipMentorSource(args(), deps);
  assert.equal(split.chunks.length, 2); assert(split.chunks.every((c) => c.audio_bytes <= 8_000_000));
  assert.equal(split.chunks[1].offset_seconds, 119); oversized = false;

  duration = 100; missingTimes = true;deps.directory=join(directory,'missing-times-case');
  const missing = await transcribeClipMentorSource(args(), deps);
  assert.equal(missing.status, 'failed'); assert.equal(missing.requests_attempted, 1);
  assert.equal(missing.words.length, 0, 'never fabricate timing from plain text'); missingTimes = false;
  await assert.rejects(transcribeClipMentorSource({ ...args(), src: '/media/uploads/master.normalized.mp4' }, deps), /Original uploaded master/);
  await assert.rejects(transcribeClipMentorSource({ ...args(), expectedSourceHash: 'b'.repeat(64) }, deps), /identity mismatch/);
  const unhashed = await transcribeClipMentorSource({ ...args(), expectedSourceHash: undefined, sourceSize: 123 }, deps);
  assert.equal(unhashed.source_hash, hash);
  await assert.rejects(transcribeClipMentorSource({ ...args(), expectedSourceHash: undefined, sourceSize: undefined }, deps), /identity mismatch/);
  assert.throws(() => parseFunAsrResponse({ output: { sentence: { words: [{ text: 'bad', begin_time: 10, end_time: 2 }] } } }, 0));
  const chunk = (id: string, start: number, end: number, text: string): AsrChunk => ({ chunk_id: id, offset_seconds: start, end_seconds: end,
    status: 'completed', audio_bytes: 3, audio_sha256: hash, detected_language: null,
    words: [{ text, start_seconds: 239, end_seconds: 239.2 }] });
  const same = stitchAsrChunks([chunk('a', 0, 240, 'same'), chunk('b', 238, 300, 'same')]);
  assert.equal(same.words.length, 1); assert.equal(same.conflicts.length, 0);
  const conflict = stitchAsrChunks([chunk('a', 0, 240, 'left'), chunk('b', 238, 300, 'right')]);
  assert.equal(conflict.words.length, 0); assert.equal(conflict.conflicts.length, 1);

  seedKeystore({ CLIPMENTOR_FUNASR_API_KEY: secret, CLIPMENTOR_FUNASR_ENDPOINT: endpoint });
  assert.equal(keyStatus().keys.CLIPMENTOR_FUNASR_API_KEY.configured, true);
  assert(!JSON.stringify(keyStatus()).includes(secret), 'key status exposes presence only');
  const saved = await readFile(join(directory,'partial-case', `${partialArgs.operationId}.json`), 'utf8');
  assert(!saved.includes(secret));

  let handler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;
  const configure = clipMentorFunAsrPlugin(deps).configureServer;
  assert.equal(typeof configure, 'function');
  if (typeof configure !== 'function') throw new Error('Missing route');
  configure({ middlewares: { use: (_path: string, fn: typeof handler) => { handler = fn; } } } as never);
  const server = createServer((req, res) => handler!(req, res));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const noOrigin = await fetch(origin, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args()) });
    assert.equal(noOrigin.status, 401);
    const configured = await fetch(origin, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(args()) });
    assert.equal(configured.status, 200); assert(isSourceTranscription(await configured.json()));
    const invalid = await fetch(origin, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...args(), src: `https://${secret}.test` }) });
    assert.equal(invalid.status, 400); assert(!(await invalid.text()).includes(secret));
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  console.log('ClipMentor Fun-ASR: long audio, byte subdivision, overlap, timestamps, budgets, no replay, provenance, auth and secret redaction passed');
} finally { await rm(directory, { recursive: true, force: true }); }
