import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { prepareR2Video, type VideoObjectStore } from './video-media';
import { observeSourceVideo, readSourceVideoReceipt } from './source-video';
import { previewBridge } from '../plugins/clipmentor-preview-review';
import { reviewClipMentorPreview } from './preview-review';
import { externalCall } from './external-call';
import { openHeadlessEditor } from './headless-editor';
import { projectDoc, projectId, MemoryPersistence } from '../external-agent/offline-runtime.verify-fixtures';
import fixture from '../../src/clipmentor/fixtures/copy-teaching-blind-v2-20261019.json';
import type { SourceVideoRequest } from '../../shared/clipmentor-source-video';

// Deliberately no HTTP listener, real SDK, renderer or provider. The host transport
// is in-process; the source operation uses its real journal/model boundary. The
// preview child seam uses the existing real review + externalCall boundary.
const root = await mkdtemp(join(tmpdir(), 'clipmentor-recovery-composition-'));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw Error('Real network forbidden'); };
const hash = (v: Uint8Array | string) => createHash('sha256').update(v).digest('hex');
const bytes = Buffer.alloc(9 * 1024 * 1024, 71), sha256 = hash(bytes), file = join(root, 'video.mp4');
await writeFile(file, bytes);
const input = { duration_seconds: 10, points: [{ point_id: 'P', teaching_goal_zh: '动作', product_relevance: '商品' }], units: [{ unit_id: 'U', point_ids: ['P'] }], reference_text: [] };
const packet = structuredClone(fixture.blind_input.cases[0].packet) as SourceVideoRequest['packet'];
packet.units = [packet.units[0]];
packet.units[0].picture_plan = { original_source_ranges: [[0, 2]], explanation_source_ranges: [[2, 4]], line_source_ranges: packet.units[0].lines.map(l => ({ line_id: l.line_id, source_range_seconds: [2, 4] })), registered_revisits: [], execution_plan: { plan_id: 'plan', script_candidate_id: 'copy', content: { composition: 'current' } } };
function fake() {
  const objects = new Map<string, Buffer>(), uploads = new Map<string, Map<number, Buffer>>(), keys = new Map<string, string>();
  let blocked = false;
  const calls = { create: 0, part: 0, model: 0, prepare: 0, child: 0 };
  const store: VideoObjectStore = {
    identity: 'composition-store',
    head: async key => { const b = objects.get(key); return b ? { bytes: b.length, etag: hash(b) } : null; },
    pending: async key => [...keys].filter(([, k]) => k === key).map(([id]) => id),
    create: async key => { calls.create++; const id = randomUUID(); keys.set(id, key); uploads.set(id, new Map()); return id; },
    list: async (_key, id) => { const p = uploads.get(id); if (!p) throw { name: 'NoSuchUpload' }; return [...p].map(([number, data]) => ({ number, bytes: data.length, etag: hash(data) })); },
    part: async (_key, id, n, stream) => { calls.part++; if (blocked) throw { $metadata: { httpStatusCode: 403 } }; const chunks: Buffer[] = []; for await (const c of stream) chunks.push(c); const data = Buffer.concat(chunks); uploads.get(id)!.set(n, data); return hash(data); },
    complete: async (key, id, parts) => { objects.set(key, Buffer.concat(parts.map(p => uploads.get(id)!.get(p.number)!))); uploads.delete(id); keys.delete(id); },
    get: async key => Readable.from([objects.get(key)!]),
    sign: async () => 'https://offline.invalid/video.mp4?signature=fixture',
  };
  return { store, calls, objects, uploads, keys, set blocked(v: boolean) { blocked = v; } };
}
async function snapshot(directory: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) { for (const [name, value] of Object.entries(await snapshot(join(directory, entry.name)))) out[entry.name + '/' + name] = value; }
    else if (!entry.name.includes('.owner') && !entry.name.endsWith('.events')) out[entry.name] = hash(await readFile(join(directory, entry.name)));
  }
  return out;
}
let cases = 0;
try {
  for (const kind of ['source', 'preview'] as const) for (const loss of ['object', 'multipart'] as const) {
    const f = fake(), directory = join(root, kind + '-' + loss), operationId = randomUUID();
    const storage = { file, sha256, directory: join(directory, 'storage'), namespace: 'same-tenant', store: f.store, signal: AbortSignal.timeout(20_000) };
    const prepare = async () => { f.calls.prepare++; return prepareR2Video(storage); };
    const operations = join(directory, 'operations');
    const source: SourceVideoRequest = { operationId, maxRequests: 1, projectId, authorRunId: 'author', source: { src: '/media/uploads/video.mp4', hash: sha256, fps: 30, duration: 5 }, subject: { revision: 1, digest: 'a'.repeat(64), units: [{ unit_id: packet.units[0].unit_id, candidate_id: 'copy' }] }, packet };
    const preview = { action: 'request', operationId, projectId, maxRequests: 1, src: '/media/uploads/video.mp4', videoSha256: sha256, input };
    const unknown = async () => { f.calls.model++; throw Error('offline model response lost after dispatch'); };
    const sourceDeps = { directory: operations, key: 'fixture-model', resolve: () => file, hash: async () => sha256, audioPresent: async () => true, size: async () => bytes.length, read: async () => bytes, prepareMedia: prepare, post: unknown };
    const previewDeps = { directory: operations, resolve: () => file, run: async (args: string[]) => {
      f.calls.child++;
      const out = args[args.indexOf('--out') + 1], childDirectory = join(out, '..'), ledger = join(childDirectory, operationId + '.operation.json');
      const media = await prepare();
      // Same fake child seam as existing bridge verifier, but cross the actual
      // preview model function and durable unknown-result reservation as well.
      try { await reviewClipMentorPreview(media, input, { key: 'fixture-model', post: async () => {
        await writeFile(ledger, JSON.stringify({ status: 'reserved', requests_attempted: 1, model_retry_policy: 'no_automatic_retry', media_transfer: media.receipt }));
        return externalCall({ directory: childDirectory, kind: 'video', purpose: 'preview-continuous-review-v1', requestId: operationId, identity: { operationId, sha256 }, preserveErrors: true, execute: unknown });
      } }); } catch (error) {
        await writeFile(ledger, JSON.stringify({ status: 'failed', requests_attempted: 1, model_retry_policy: 'no_automatic_retry', media_transfer: media.receipt, error: 'unknown model outcome' })); throw error;
      }
    } };
    let recovering = false, effects = 0;
    const actions: string[] = [];
    const editor = await openHeadlessEditor({ projectId, runId: 'composition-' + operationId, origin: 'http://127.0.0.1:1', review: { provider: 'openai', model: 'fixture', origin: 'http://127.0.0.1:1', apiMode: 'responses' }, persistence: new MemoryPersistence(projectDoc()), browserConnected: () => false, retryGateway: true,
      effect: async (_kind, key, work, recover) => { assert.equal(key, operationId); effects++; return recovering ? recover!(key) : work(key); },
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)); actions.push(body.action ?? 'request');
        if (kind === 'preview') return Response.json(await previewBridge(body, previewDeps));
        if (body.action === 'read_receipt') return Response.json(await readSourceVideoReceipt(operationId, projectId, sourceDeps));
        if (body.action === 'resume_preparation') delete body.action;
        try { return Response.json(await observeSourceVideo(body, sourceDeps)); } catch (e: any) { if (!e.receipt) return Response.json({ error: e.message }, { status: 400 }); return Response.json({ error: e.message, receipt: e.receipt }, { status: 502 }); }
      },
    });
    try {
      const path = kind === 'source' ? '/api/clipmentor/observe-video' : '/api/clipmentor/review-preview';
      const send = () => editor.context.hostFetch!(path, { method: 'POST', body: JSON.stringify(kind === 'source' ? source : preview) });
      const initial = await (await send()).json() as any;
      assert.equal(f.calls.model, 1, 'positive control: actual model dispatch boundary reached once');
      assert.equal(kind === 'source' ? initial.receipt.requestsSent : initial.requestOutcome, kind === 'source' ? 'unknown' : 'unknown');
      const before = await snapshot(operations);
      assert.equal(f.calls.create, 1);
      f.objects.clear(); // Confirmed deletion, never a changed object.
      if (loss === 'multipart') {
        f.blocked = true; await assert.rejects(prepare(), /transfer_failed/); f.blocked = false;
        assert(f.uploads.size > 0, 'positive control: replacement multipart exists');
        f.uploads.clear(); f.keys.clear(); // Server confirms NoSuchUpload on recovery.
      }
      const recovered = await prepare();
      assert.equal(recovered.receipt.reused, false);
      assert.equal(recovered.receipt.model_fetch_verified, false);
      assert.deepEqual([...f.objects.values()][0], bytes, 'positive control: restored exact bytes');
      assert.equal(f.calls.create, loss === 'object' ? 2 : 3);
      assert.equal(f.calls.model, 1);
      assert.deepEqual(await snapshot(operations), before, 'storage restoration cannot reset operation or model journal');
      const prepares = f.calls.prepare;
      recovering = true;
      const resumed = await (await send()).json() as any;
      assert.equal(kind === 'source' ? resumed.receipt.requestsAttempted : resumed.requestsAttempted, 1);
      if (kind === 'source') { assert.equal(resumed.receipt.status, 'failed'); assert.equal(resumed.receipt.complete_film_accepted, false); }
      else { assert.equal(resumed.status, 'failed'); assert.equal(resumed.effective_review.can_use_as_pass, false); }
      if (kind === 'source') await assert.rejects(observeSourceVideo(source, sourceDeps), /consumed or unknown/);
      else { await previewBridge(preview, previewDeps); await previewBridge({ ...preview, action: 'resume_preparation' }, previewDeps); }
      assert.equal(f.calls.prepare, prepares, 'consumed operation never re-enters media preparation');
      assert.equal(f.calls.model, 1, 'unknown outcome cannot grant a second model dispatch');
      assert.equal(f.calls.child, kind === 'preview' ? 1 : 0);
      assert.deepEqual(await snapshot(operations), before, 'original request identity, attempts and journal remain byte-identical');
      assert.equal(effects, 2); assert(!actions.includes('resume_preparation'));
      console.log(JSON.stringify({ PASS: kind + '/' + loss, calls: f.calls, host_actions: actions, model_attempts_preserved: 1, operation_and_journal_unchanged: true, restored_sha256: recovered.sha256 })); cases++;
    } finally { await editor.close(); }
  }
  console.log(`Recovery storage composition: ${cases} host/model-boundary cases passed; real network/model/R2/render calls 0.`);
} finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }
