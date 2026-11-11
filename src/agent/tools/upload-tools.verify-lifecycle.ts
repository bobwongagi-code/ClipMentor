import assert from 'node:assert/strict';
import { makeDraft } from '../../editor/store';
import type { MediaAsset } from '../../editor/types';
import { createMediaSourceRevision } from '../../editor/mediaSourceRevision';
import { saveUploadFinalizeJournal, loadUploadFinalizeJournal, type UploadFinalizeMutation } from '../../persist/uploadFinalizeStore';
import type { AgentContext } from '../context';
import { execUploadTool } from './upload-tools';
import { createFinalizeJournal, withReceiptCommitLock, receiptCommitKey } from './upload-finalize-journal';
import { installUploadVerifierFixture, type UploadVerifierFixture, type ReceiptRecord } from './upload-tools.verify-fixture';
import { configureSharedKvBackend } from '../../persist/sharedKv';

function receipt(f: UploadVerifierFixture, id: string, type: 'image' | 'video' = 'image') {
  const value = { projectId: 'project-test', sessionId: `sess_${id}`, assetId: id,
    filename: `${id}.${type === 'video' ? 'mp4' : 'png'}`, fileKey: `uploads/${id}.png`,
    readUrl: `/media/uploads/${id}.png`, size: 512, type, contentType: `${type}/test`, contentHash: 'ab'.repeat(32) };
  const record: ReceiptRecord = { value, claimId: 'c'.repeat(32), claimExpiresAt: Date.now() + 60_000 };
  f.state.receipts.set(id, record);
  return record;
}
async function stored(f: UploadVerifierFixture, id: string, type: UploadFinalizeMutation['type'], previousAsset?: MediaAsset | null) {
  const r = receipt(f, id);
  const asset = { id, name: r.value.filename, sourceFilename: r.value.filename, kind: 'image' as const,
    src: r.value.readUrl, durationInFrames: 1, sourceContentHash: r.value.contentHash, sourceSize: r.value.size,
    sourceRevision: createMediaSourceRevision({ src: r.value.readUrl, sourceContentHash: r.value.contentHash }) };
  const journal = await createFinalizeJournal({ receipt: id, claimId: r.claimId!,
    claimExpiresAt: r.claimExpiresAt!, ...r.value, sourceContentHash: r.value.contentHash }, {
    mutation: { type, asset, ...(previousAsset !== undefined ? { previousAsset } : {}) },
    result: { ok: true, sessionId: r.value.sessionId, assetId: id, name: asset.name, type: asset.kind,
      src: asset.src, fileKey: r.value.fileKey, size: asset.sourceSize, contentHash: asset.sourceContentHash,
      sourceRevision: asset.sourceRevision, sourceContentHash: asset.sourceContentHash, durationInFrames: 1 },
  });
  await saveUploadFinalizeJournal(journal);
  return { r, asset, journal };
}

export async function verifyUploadFinalizeLifecycle(): Promise<void> {
  const failures: string[] = [];
  let passed = 0;
  async function test(name: string, work: (f: UploadVerifierFixture, flush: () => Promise<void>) => Promise<void>) {
    const f = installUploadVerifierFixture();
    const originalSetTimeout = globalThis.setTimeout;
    const scheduled: Array<() => void> = [];
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay !== 100) return originalSetTimeout(callback, delay, ...args);
      scheduled.push(() => callback(...args));
      return {} as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    const flush = async () => {
      while (scheduled.length) {
        scheduled.shift()!();
        // Enqueue behind the actual reconciliation closure, then join its real
        // receipt lock. No guessed wall-clock sleep stands in for completion.
        await Promise.resolve();
        await Promise.all([...f.state.receipts.keys()].map(id => withReceiptCommitLock(
          receiptCommitKey({ projectId: 'project-test', receipt: id }), async () => undefined)));
      }
    };
    try { await work(f, flush); passed++; }
    catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); }
    finally { await flush(); globalThis.setTimeout = originalSetTimeout; f.restore(); configureSharedKvBackend(undefined); }
  }
  for (const change of ['project', 'run', 'abort'] as const) await test(`stale ${change} during normalization`, async f => {
    receipt(f, `normal-${change}`, 'video').claimId = undefined;
    const other = makeDraft(structuredClone(f.draft.getDoc()));
    let projectId = 'project-test', runId = 'run-a', active = f.draft;
    const controller = new AbortController();
    const baseFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const result = await baseFetch(input, init);
      if (String(input) === '/api/normalize-media') {
        if (change === 'project') { projectId = 'other-project'; active = other; }
        if (change === 'run') runId = 'run-b';
        if (change === 'abort') controller.abort();
      }
      return result;
    };
    const ctx: AgentContext = { ...f.context, getProjectId: () => projectId, getAgentRunId: () => runId,
      getAgentRunSignal: () => controller.signal, getDoc: () => active.getDoc(), getState: () => active.getState(),
      commands: new Proxy(f.context.commands, { get: (_target, key) => Reflect.get(active.commands, key) }) };
    const result = await execUploadTool('finalize_uploaded_asset', { receipt: `normal-${change}`, assetType: 'video', durationInSeconds: 2 }, ctx) as { error?: string };
    assert.ok(result.error, 'stale invocation must report an error');
    assert.equal(f.draft.getDoc().assets.length + other.getDoc().assets.length, 0, 'stale operation must not mutate either project');
    assert.notEqual(f.state.receipts.get(`normal-${change}`)?.committed, true);
  });
  await test('queued invocation cannot change projects', async f => {
    const r = receipt(f, 'queued'); r.claimId = undefined;
    let release!: () => void;
    const entered = Promise.withResolvers<void>();
    const held = withReceiptCommitLock(receiptCommitKey({ projectId: 'project-test', receipt: 'queued' }), () => new Promise<void>(resolve => { release = resolve; entered.resolve(); }));
    await entered.promise;
    let projectId = 'project-test';
    const pending = execUploadTool('finalize_uploaded_asset', { receipt: 'queued', assetType: 'image' }, { ...f.context, getProjectId: () => projectId });
    projectId = 'other-project'; release(); await held;
    const result = await pending as { error?: string };
    assert.ok(result.error); assert.equal(f.state.receiptClaims, 0); assert.equal(f.draft.getDoc().assets.length, 0);
  });
  await test('prepared relink cannot overwrite a newer target', async f => {
    const prior: MediaAsset = { id: 'relink-conflict', name: 'old', kind: 'image', src: '/media/uploads/old.png', durationInFrames: 1 };
    f.draft.commands.addAsset(prior);
    await stored(f, prior.id, 'relink', structuredClone(f.draft.getDoc().assets[0]!));
    f.draft.commands.relinkMediaAsset(prior.id, { src: '/media/uploads/newer.png' });
    const result = await execUploadTool('finalize_uploaded_asset', { receipt: prior.id, assetType: 'image' }, f.context) as { error?: string };
    assert.ok(result.error); assert.equal(f.draft.getDoc().assets[0]?.src, '/media/uploads/newer.png');
    assert.ok(await loadUploadFinalizeJournal('project-test', prior.id));
  });
  await test('no-op recovery requires the actual matching asset', async f => {
    const { r } = await stored(f, 'none-missing', 'none');
    const result = await execUploadTool('finalize_uploaded_asset', { receipt: 'none-missing', assetType: 'image' }, f.context) as { error?: string };
    assert.ok(result.error); assert.notEqual(r.committed, true); assert.ok(await loadUploadFinalizeJournal('project-test', 'none-missing'));
  });
  await test('silent editor refusal cannot consume the receipt', async f => {
    const r = receipt(f, 'silent-command'); r.claimId = undefined;
    const ctx = { ...f.context, commands: new Proxy(f.context.commands, { get: (target, key) => key === 'addAsset' ? () => undefined : Reflect.get(target, key) }) };
    const result = await execUploadTool('finalize_uploaded_asset', { receipt: 'silent-command', assetType: 'image' }, ctx) as { error?: string };
    assert.ok(result.error); assert.notEqual(r.committed, true); assert.equal(f.draft.getDoc().assets.length, 0);
  });
  await test('expired stolen claim cannot replay a mutation', async f => {
    const { r } = await stored(f, 'expired', 'add');
    r.claimExpiresAt = Date.now() - 1; r.claimId = 'z'.repeat(32);
    r.receiptExpiresAt = Date.now() - 1;
    const result = await execUploadTool('finalize_uploaded_asset', { receipt: 'expired', assetType: 'image' }, f.context) as { error?: string };
    assert.ok(result.error); assert.equal(f.draft.getDoc().assets.length, 0); assert.notEqual(r.committed, true);
  });
  await test('background reconciliation cannot write the next project', async (f, flush) => {
    const r = receipt(f, 'background'); r.claimId = undefined;
    let active = f.draft, projectId = 'project-test';
    const ctx: AgentContext = { ...f.context, getProjectId: () => projectId, getDoc: () => active.getDoc(), getState: () => active.getState(),
      commands: new Proxy(f.context.commands, { get: (_t, key) => Reflect.get(active.commands, key) }) };
    f.state.commitRequestsToDrop = 2;
    const result = await execUploadTool('finalize_uploaded_asset', { receipt: 'background', assetType: 'image' }, ctx) as { receiptCommit?: string };
    assert.equal(result.receiptCommit, 'reconciliation_pending');
    active = makeDraft({ ...structuredClone(f.draft.getDoc()), assets: [] }); projectId = 'other-project';
    await flush();
    assert.equal(active.getDoc().assets.length, 0); assert.notEqual(r.committed, true);
    assert.ok(await loadUploadFinalizeJournal('project-test', 'background'));
  });
  await test('background confirmation cannot undo a deliberate removal', async (f, flush) => {
    const r = receipt(f, 'background-removed'); r.claimId = undefined;
    f.state.commitRequestsToDrop = 2;
    await execUploadTool('finalize_uploaded_asset', { receipt: 'background-removed', assetType: 'image' }, f.context);
    f.draft.commands.applyDoc({ ...f.draft.getDoc(), assets: [] });
    await flush();
    assert.equal(f.draft.getDoc().assets.length, 0, 'confirmation must not silently replay an edit');
    assert.notEqual(r.committed, true); assert.ok(await loadUploadFinalizeJournal('project-test', 'background-removed'));
  });
  await test('applied relink journal can recover an unsaved draft after reload', async f => {
    const id = 'applied-relink';
    f.draft.commands.addAsset({ id, name: 'old', kind: 'image', src: '/media/uploads/old.png', durationInFrames: 1 });
    const { r, asset, journal } = await stored(f, id, 'relink', structuredClone(f.draft.getDoc().assets[0]!));
    await saveUploadFinalizeJournal({ ...journal, status: 'mutation_applied' });
    const result = await execUploadTool('finalize_uploaded_asset', { receipt: id, assetType: 'image' }, f.context) as { error?: string; receiptCommit?: string };
    assert.equal(result.error, undefined); assert.equal(result.receiptCommit, 'committed'); assert.equal(r.committed, true);
    assert.equal(f.draft.getDoc().assets[0]?.src, asset.src);
  });
  await test('lost successful commit response can recover into an older saved document', async f => {
    const r = receipt(f, 'lost-ack'); r.claimId = undefined;
    const oldDoc = structuredClone(f.draft.getDoc());
    const baseFetch = globalThis.fetch;
    let dropped = 0;
    globalThis.fetch = async (input, init) => {
      const response = await baseFetch(input, init);
      if (String(input) === '/api/external-agent/upload-receipt'
        && JSON.parse(String(init?.body)).action === 'commit' && dropped++ < 2) throw new Error('ack lost after server commit');
      return response;
    };
    const pending = await execUploadTool('finalize_uploaded_asset', { receipt: 'lost-ack', assetType: 'image' }, f.context) as { receiptCommit?: string };
    assert.equal(pending.receiptCommit, 'reconciliation_pending'); assert.equal(r.committed, true);
    const reloaded = makeDraft(oldDoc);
    const result = await execUploadTool('finalize_uploaded_asset', { receipt: 'lost-ack', assetType: 'image' }, { ...f.context, ...reloaded }) as { error?: string; receiptCommit?: string };
    assert.equal(result.error, undefined); assert.equal(result.receiptCommit, 'committed');
    assert.equal(reloaded.getDoc().assets.filter(a => a.id === 'lost-ack').length, 1);
    assert.equal(await loadUploadFinalizeJournal('project-test', 'lost-ack'), null);
  });
  await test('unrelated media organization does not block relink recovery', async f => {
    const id = 'metadata-only';
    f.draft.commands.addAsset({ id, name: 'old', kind: 'image', src: '/media/uploads/old.png', durationInFrames: 1 });
    const { r } = await stored(f, id, 'relink', structuredClone(f.draft.getDoc().assets[0]!));
    f.draft.commands.setMediaAssetFavorite(id, true);
    assert.equal(JSON.stringify((await loadUploadFinalizeJournal('project-test', id))?.mutation).includes('favorite'), false);
    const result = await execUploadTool('finalize_uploaded_asset', { receipt: id, assetType: 'image' }, f.context) as { error?: string };
    assert.equal(result.error, undefined); assert.equal(r.committed, true); assert.equal(f.draft.getDoc().assets[0]?.favorite, true);
  });
  await test('a target removed while the applied journal saves cannot be confirmed', async f => {
    const entries = new Map<string, unknown>();
    configureSharedKvBackend({ get: async <T>(key: string) => entries.get(key) as T | undefined,
      set: async (key, value) => {
        entries.set(key, structuredClone(value));
        if ((value as { status?: string }).status === 'mutation_applied') f.draft.commands.applyDoc({ ...f.draft.getDoc(), assets: [] });
      }, delete: async key => { entries.delete(key); }, keys: async () => [...entries.keys()],
      writeAgentRuntime: async () => { throw new Error('unexpected runtime write'); },
      updateAgentRunLease: async () => { throw new Error('unexpected lease write'); } });
    const r = receipt(f, 'save-race'); r.claimId = undefined;
    const result = await execUploadTool('finalize_uploaded_asset', { receipt: 'save-race', assetType: 'image' }, f.context) as { error?: string };
    assert.ok(result.error); assert.notEqual(r.committed, true); assert.equal(f.draft.getDoc().assets.length, 0);
    assert.ok(await loadUploadFinalizeJournal('project-test', 'save-race'));
  });
  await test('legacy divergent relink retains evidence rather than guessing its old target', async f => {
    const id = 'legacy-relink';
    f.draft.commands.addAsset({ id, name: 'unknown prior', kind: 'image', src: '/media/uploads/unknown.png', durationInFrames: 1 });
    const { r } = await stored(f, id, 'relink');
    const result = await execUploadTool('finalize_uploaded_asset', { receipt: id, assetType: 'image' }, f.context) as { error?: string };
    assert.ok(result.error); assert.notEqual(r.committed, true); assert.equal(f.draft.getDoc().assets[0]?.src, '/media/uploads/unknown.png');
    assert.ok(await loadUploadFinalizeJournal('project-test', id));
  });
  await test('an exact completed legacy relink is reusable', async f => {
    const { r, asset } = await stored(f, 'legacy-exact', 'relink');
    f.draft.commands.addAsset(asset);
    const result = await execUploadTool('finalize_uploaded_asset', { receipt: 'legacy-exact', assetType: 'image' }, f.context) as { error?: string };
    assert.equal(result.error, undefined); assert.equal(r.committed, true);
  });
  await test('exact receipt ids do not relink a prefix match', async f => {
    f.draft.commands.addAsset({ id: 'prefix-longer', name: 'other', kind: 'image', src: '/media/uploads/other.png', durationInFrames: 1 });
    const r = receipt(f, 'prefix'); r.claimId = undefined;
    const result = await execUploadTool('finalize_uploaded_asset', { receipt: 'prefix', assetType: 'image' }, f.context) as { error?: string };
    assert.equal(result.error, undefined); assert.equal(r.committed, true);
    assert.equal(f.draft.getDoc().assets.find(a => a.id === 'prefix-longer')?.src, '/media/uploads/other.png');
    assert.ok(f.draft.getDoc().assets.find(a => a.id === 'prefix'));
  });
  await test('an active claim with mismatched renewed content is not commit authority', async f => {
    const { r } = await stored(f, 'bad-renewed-content', 'add');
    const baseFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const response = await baseFetch(input, init);
      if (String(input) === '/api/external-agent/upload-receipt' && JSON.parse(String(init?.body)).action === 'claim') {
        const value = await response.json(); return Response.json({ ...value, contentHash: 'cd'.repeat(32) });
      }
      return response;
    };
    const result = await execUploadTool('finalize_uploaded_asset', { receipt: 'bad-renewed-content', assetType: 'image' }, f.context) as { error?: string };
    assert.ok(result.error); assert.notEqual(r.committed, true); assert.equal(f.draft.getDoc().assets.length, 0);
  });
  await test('another claim tombstone cannot authorize replay', async f => {
    const { r } = await stored(f, 'wrong-tombstone', 'add');
    r.committed = true; r.committedClaimId = 'x'.repeat(32); r.claimId = undefined;
    const result = await execUploadTool('finalize_uploaded_asset', { receipt: 'wrong-tombstone', assetType: 'image' }, f.context) as { error?: string };
    assert.ok(result.error); assert.equal(f.draft.getDoc().assets.length, 0);
    assert.ok(await loadUploadFinalizeJournal('project-test', 'wrong-tombstone'));
  });
  await test('same claim tombstone survives a rejected local edit until successful recovery', async f => {
    const { r } = await stored(f, 'retained-tombstone', 'add');
    r.committed = true; r.committedClaimId = r.claimId; r.claimId = undefined;
    const refusing = { ...f.context, commands: new Proxy(f.context.commands, { get: (target, key) => key === 'addAsset' ? () => undefined : Reflect.get(target, key) }) };
    const rejected = await execUploadTool('finalize_uploaded_asset', { receipt: 'retained-tombstone', assetType: 'image' }, refusing) as { error?: string };
    assert.ok(rejected.error); assert.equal(f.draft.getDoc().assets.length, 0);
    assert.ok(await loadUploadFinalizeJournal('project-test', 'retained-tombstone'));
    const recovered = await execUploadTool('finalize_uploaded_asset', { receipt: 'retained-tombstone', assetType: 'image' }, f.context) as { error?: string };
    assert.equal(recovered.error, undefined); assert.equal(f.draft.getDoc().assets.length, 1);
    assert.equal(await loadUploadFinalizeJournal('project-test', 'retained-tombstone'), null);
  });
  await test('run switch during tombstone confirmation cannot write a stale edit', async f => {
    const { r } = await stored(f, 'tombstone-switch', 'add');
    r.committed = true; r.committedClaimId = r.claimId; r.claimId = undefined;
    let runId = 'run-a';
    const baseFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const response = await baseFetch(input, init);
      if (JSON.parse(String(init?.body)).action === 'commit') runId = 'run-b';
      return response;
    };
    const result = await execUploadTool('finalize_uploaded_asset', { receipt: 'tombstone-switch', assetType: 'image' }, { ...f.context, getAgentRunId: () => runId }) as { error?: string };
    assert.ok(result.error); assert.equal(f.draft.getDoc().assets.length, 0);
    assert.ok(await loadUploadFinalizeJournal('project-test', 'tombstone-switch'));
  });
  await test('a cancelled confirmation cannot suppress its successor run', async (f, flush) => {
    const r = receipt(f, 'successor-confirmation'); r.claimId = undefined;
    const first = new AbortController(), second = new AbortController();
    f.state.commitRequestsToDrop = 4;
    const args = { receipt: 'successor-confirmation', assetType: 'image' };
    const a = await execUploadTool('finalize_uploaded_asset', args, { ...f.context, getAgentRunId: () => 'run-a', getAgentRunSignal: () => first.signal }) as { receiptCommit?: string };
    assert.equal(a.receiptCommit, 'reconciliation_pending'); first.abort();
    const b = await execUploadTool('finalize_uploaded_asset', args, { ...f.context, getAgentRunId: () => 'run-b', getAgentRunSignal: () => second.signal }) as { receiptCommit?: string };
    assert.equal(b.receiptCommit, 'reconciliation_pending');
    await flush();
    assert.equal(r.committed, true, 'the active successor must receive its own confirmation callback');
    assert.equal(f.state.commitClaimIds.length, 5, 'a superseded callback cannot submit or remove its successor');
    assert.equal(await loadUploadFinalizeJournal('project-test', 'successor-confirmation'), null);
  });
  for (const stage of ['saved', 'renewing', 'edited', 'stale-delete'] as const) await test(`cancel at ${stage} preserves only necessary recovery state`, async f => {
    const id = `cancel-${stage}`, controller = new AbortController();
    const entries = new Map<string, unknown>();
    configureSharedKvBackend({ get: async <T>(key: string) => entries.get(key) as T | undefined,
      set: async (key, value) => {
        entries.set(key, structuredClone(value));
        if ((stage === 'saved' || stage === 'stale-delete') && (value as { status?: string }).status === 'prepared') controller.abort();
      }, delete: async key => {
        if (stage !== 'stale-delete') entries.delete(key);
      }, keys: async () => [...entries.keys()],
      writeAgentRuntime: async () => { throw new Error('unexpected runtime write'); },
      updateAgentRunLease: async () => { throw new Error('unexpected lease write'); } });
    const r = receipt(f, id); r.claimId = undefined;
    const baseFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const response = await baseFetch(input, init);
      if (stage === 'renewing' && JSON.parse(String(init?.body)).action === 'claim' && f.state.receiptClaims === 3) controller.abort();
      return response;
    };
    const commands = new Proxy(f.context.commands, { get: (target, key) => {
      if (key === 'addAsset' && stage === 'edited') return (asset: MediaAsset) => { target.addAsset(asset); controller.abort(); };
      return Reflect.get(target, key);
    } });
    const result = await execUploadTool('finalize_uploaded_asset', { receipt: id, assetType: 'image', width: 320 }, { ...f.context, commands, getAgentRunSignal: () => controller.signal }) as { error?: string };
    assert.ok(result.error); assert.notEqual(r.committed, true);
    assert.equal(f.draft.getDoc().assets.length, stage === 'edited' ? 1 : 0);
    const journal = await loadUploadFinalizeJournal('project-test', id);
    if (stage === 'edited') {
      assert.ok(journal, 'a possibly applied edit must retain recovery evidence');
      const live = new AbortController();
      const recovered = await execUploadTool('finalize_uploaded_asset', { receipt: id, assetType: 'image' }, { ...f.context, getAgentRunSignal: () => live.signal }) as { error?: string };
      assert.equal(recovered.error, undefined); assert.equal(r.committed, true);
      assert.equal(f.draft.getDoc().assets.length, 1);
    } else if (stage === 'stale-delete') {
      assert.equal(journal?.result.width, 320, 'shared storage can still return the canceled journal');
      const recovered = await execUploadTool('finalize_uploaded_asset',
        { receipt: id, assetType: 'image', width: 999 }, f.context) as { error?: string; width?: number };
      assert.equal(recovered.error, undefined);
      assert.equal(recovered.width, 999);
      assert.equal(f.draft.getDoc().assets[0]?.width, 999);
      assert.equal(r.committed, true);
      assert.notEqual(r.committedClaimId, journal?.identity.claimId);
    } else {
      assert.equal(journal, null, 'a confirmed pre-edit abort must release its private journal');
      assert.equal(r.claimId, undefined);
    }
  });
  await test('a command that wrote before a project switch retains the original journal', async f => {
    const id = 'edited-then-switch';
    const r = receipt(f, id); r.claimId = undefined;
    const other = makeDraft(structuredClone(f.draft.getDoc()));
    let active = f.draft, projectId = 'project-test';
    const commands = new Proxy(f.context.commands, { get: (target, key) => {
      if (key === 'addAsset') return (asset: MediaAsset) => { target.addAsset(asset); active = other; projectId = 'other-project'; };
      return Reflect.get(target, key);
    } });
    const result = await execUploadTool('finalize_uploaded_asset', { receipt: id, assetType: 'image' }, {
      ...f.context, commands, getProjectId: () => projectId, getDoc: () => active.getDoc(), getState: () => active.getState(),
    }) as { error?: string };
    assert.ok(result.error); assert.equal(f.draft.getDoc().assets.length, 1); assert.equal(other.getDoc().assets.length, 0);
    assert.notEqual(r.committed, true); assert.ok(r.claimId);
    assert.ok(await loadUploadFinalizeJournal('project-test', id), 'never judge the old write using the newly opened project');
    const recovered = await execUploadTool('finalize_uploaded_asset', { receipt: id, assetType: 'image' }, f.context) as { error?: string };
    assert.equal(recovered.error, undefined); assert.equal(r.committed, true); assert.equal(f.draft.getDoc().assets.length, 1);
  });
  for (const type of ['add', 'relink', 'none'] as const) await test(`valid ${type} recovery`, async f => {
    const id = `valid-${type}`;
    const prior: MediaAsset = { id, name: 'old', kind: 'image', src: '/media/uploads/old.png', durationInFrames: 1 };
    if (type === 'relink') f.draft.commands.addAsset(prior);
    const { r, asset } = await stored(f, id, type, type === 'relink' ? structuredClone(f.draft.getDoc().assets[0]!) : null);
    if (type === 'none') f.draft.commands.addAsset(asset);
    const result = await execUploadTool('finalize_uploaded_asset', { receipt: id, assetType: 'image' }, f.context) as { error?: string; receiptCommit?: string };
    assert.equal(result.error, undefined); assert.equal(result.receiptCommit, 'committed'); assert.equal(r.committed, true);
    assert.equal(f.draft.getDoc().assets.filter(a => a.id === id).length, 1); assert.equal(f.draft.getDoc().assets.find(a => a.id === id)?.src, asset.src);
  });
  console.log(`upload finalize lifecycle: ${passed} passed, ${failures.length} failed`);
  assert.deepEqual(failures, []);
}
