// 素材清理纯逻辑检查:引用做差、级联删的独占判定语义(经内存态 projectStore 走真流程)。
// 跑法:npx tsx src/persist/mediaCleanup.verify.ts(已挂 verify:media-persist)。
import assert from 'node:assert/strict';
import { collectAllUploadRefs, deleteUnreferencedUploads, purgeProjectCascade, scanUnreferenced, unreferencedOf } from './mediaCleanup';
import { createProject, listProjectDocIds, purgeProject } from './projectStore';
import { configureSharedKvBackend, resetSharedKvMemory, type SharedKvBackend } from './sharedKv';
import { getMediaBlob, putMediaBlob } from './mediaBlobStore';
import { deleteTemplate, saveTemplate } from './templateStore';
import type { ProjectDoc } from '../editor/types';

// ── unreferencedOf:盘面 − 引用 ──────────────────────────────────────────
{
  const files = [
    { name: 'a.mp4', bytes: 10, mtimeMs: 1 },
    { name: '李白_01_开篇.mp3', bytes: 20, mtimeMs: 2 },
    { name: 'kept.png', bytes: 30, mtimeMs: 3 },
    { name: 'installed.cube', bytes: 40, mtimeMs: 4 },
    { name: 'openchatcut-export-stage-01ab2345-6789-4abc-8def-012345678901.webm.part', bytes: 40, mtimeMs: 4 },
    { name: 'openchatcut-export-job-01ab2345-6789-4abc-8def-012345678901.mp4', bytes: 40, mtimeMs: 4 },
    { name: 'openchatcut-derived-01ab2345-6789-4abc-8def-012345678901.mp4', bytes: 40, mtimeMs: 4 },
  ];
  const refs = new Set(['/media/uploads/kept.png']);
  const orphans = unreferencedOf(files, refs);
  assert.deepEqual(orphans.map((f) => f.name), ['a.mp4', '李白_01_开篇.mp3'], '引用的不进无主清单(中文名照常)');
  console.log('unreferencedOf: OK');
}

// ── 引用并集 + 独占判定(内存态 projectStore) ────────────────────────────
{
  const doc = (src: string): ProjectDoc => ({
    version: 3,
    assets: [{ id: 'a1', name: 'x', kind: 'video', src, durationInFrames: 30 }],
    mediaFolders: [],
    timelines: [{ id: 'tl1', name: '序列 1', fps: 30, width: 1920, height: 1080, selectedId: null, items: [] } as never],
    activeTimelineId: 'tl1',
  } as never);
  const shared = '/media/uploads/shared.mp4';
  const solo = '/media/uploads/solo.mp4';
  const p1 = await createProject('甲', doc(shared));
  const p2 = await createProject('乙', doc(shared));
  const p3 = await createProject('丙', doc(solo));

  let refs = await collectAllUploadRefs();
  assert.ok(refs.has(shared) && refs.has(solo), '并集含全部引用');

  // 排除 p3 后 solo 无人引用 → 级联删应删;shared 因 p2 仍在 → 保
  refs = await collectAllUploadRefs(p3.id);
  assert.ok(!refs.has(solo) && refs.has(shared), '排除自身后:独占的裸奔,共享的仍被护住');

  // 删掉 p1 后 shared 仍被 p2 引用
  await purgeProject(p1.id);
  refs = await collectAllUploadRefs();
  assert.ok(refs.has(shared), '复制体在,共享素材引用不丢');

  for (const m of [p2, p3]) await purgeProject(m.id);
  assert.equal((await listProjectDocIds()).length, 0, 'purge 后文档清零');
  console.log('collectAllUploadRefs/级联语义: OK');
}

const fixtureDoc = (src?: string): ProjectDoc => ({
  version: 3, mediaFolders: [], activeTimelineId: 'timeline',
  assets: src ? [{ id: 'asset', kind: 'video', name: 'fixture', src, durationInFrames: 30 }] : [],
  timelines: [{ id: 'timeline', name: 'Fixture', order: 0, fps: 30, width: 1080, height: 1920, selectedId: null, items: [] }],
});

// A sibling window commits its document after the dashboard index read and
// before enumeration. Opening the cleanup dialog must never purge anything.
{
  resetSharedKvMemory();
  const entries = new Map<string, unknown>([
    ['projects', [{ id: 'existing' }]], ['project:existing', fixtureDoc()],
  ]);
  const writes: string[] = [];
  const backend: SharedKvBackend = {
    get: async <T>(key: string) => entries.get(key) as T | undefined,
    set: async (key, value) => { writes.push(key); entries.set(key, value); },
    delete: async key => { writes.push(key); entries.delete(key); },
    keys: async () => {
      entries.set('project:new-window', fixtureDoc('/media/uploads/new.mp4'));
      return [...entries.keys()];
    },
    writeAgentRuntime: async () => { throw new Error('unexpected agent write'); },
    updateAgentRunLease: async () => { throw new Error('unexpected agent lease'); },
  };
  const originalFetch = globalThis.fetch;
  let deletes = 0;
  configureSharedKvBackend(backend);
  globalThis.fetch = async (_input, options) => {
    if (options?.method === 'DELETE') deletes++;
    const files = ['new.mp4', 'candidate.mp4'].map(name => ({ name, bytes: 1, mtimeMs: 0 }));
    return Response.json({ files });
  };
  try {
    const scan = await scanUnreferenced();
    assert.deepEqual(writes, [], 'a scan may not edit or purge store entries');
    assert.equal(entries.has('project:new-window'), true);
    assert.deepEqual(scan.files.map(file => file.name), ['candidate.mp4']);
    entries.set('project:late-restore', fixtureDoc('/media/uploads/candidate.mp4'));
    assert.equal(await deleteUnreferencedUploads(['candidate.mp4']), 0);
    assert.equal(deletes, 0, 'the confirm action must recheck references changed after the scan');
    entries.delete('project:late-restore');
    entries.set('offline-edit-session:existing', {
      version: 1, sessionId: 'test', clientName: 'Fixture', baseRevision: 'v3-test',
      approvalMode: 'manual', createdAt: 0, updatedAt: 0, operations: [],
      draftDoc: fixtureDoc('/media/uploads/candidate.mp4'),
    });
    assert.equal(await deleteUnreferencedUploads(['candidate.mp4']), 0);
    assert.equal(deletes, 0, 'offline draft references are also rechecked in the client');
  } finally { globalThis.fetch = originalFetch; resetSharedKvMemory(); }
}

// A template is an independent owner even after its original project is purged.
{
  resetSharedKvMemory();
  const src = '/media/uploads/template-only.mp4';
  const original = await createProject('Original', fixtureDoc(src));
  const template = await saveTemplate('Reusable', fixtureDoc(src));
  const previousFetch = globalThis.fetch;
  let deleteCalls = 0;
  let reply = () => Response.json({ ok: true, removed: 1, r2Removed: false });
  globalThis.fetch = async (_input, options) => {
    if (options?.method === 'DELETE') { deleteCalls++; return reply(); }
    return new Response(null, {status: 404});
  };
  try {
    const ambiguous = await createProject('Encoded source', fixtureDoc('/media/uploads/old%20name.mp4?revision=1'));
    assert.deepEqual(await purgeProjectCascade(ambiguous.id), { filesDeleted: 0 },
      'a project purge cannot infer which physical filename to delete from URL aliases');
    assert.deepEqual(await purgeProjectCascade(original.id), { filesDeleted: 0 });
    assert.equal(deleteCalls, 0, 'a surviving template retains its own source after project purge');
    await deleteTemplate(template.id);
    await putMediaBlob(src, new Blob(['only cached copy']));
    for (const response of [
      () => new Response('<html>proxy fallback</html>'),
      () => Response.json({ ok: true, removed: 0, r2Removed: false }),
    ]) {
      reply = response;
      assert.equal(await deleteUnreferencedUploads(['template-only.mp4']), 0);
      assert.equal(await (await getMediaBlob(src))?.blob.text(), 'only cached copy');
    }
    reply = () => Response.json({ ok: true, removed: 1, r2Removed: false });
    assert.equal(await deleteUnreferencedUploads(['template-only.mp4']), 1);
    assert.equal(await getMediaBlob(src), undefined);
  } finally { globalThis.fetch = previousFetch; resetSharedKvMemory(); }
}

// An unreadable surviving history must not be interpreted as empty even
// after the operator explicitly removes another project's metadata.
{
  const shared = '/media/uploads/old original.mp4';
  const entries = new Map<string, unknown>([
    ['projects', [{ id: 'remove' }, { id: 'survive' }]],
    ['project:remove', fixtureDoc(shared)], ['project:survive', fixtureDoc()],
  ]);
  const backend: SharedKvBackend = {
    get: async <T>(key: string) => {
      if (key === 'versions:survive') throw new Error('fixture history read error');
      return entries.get(key) as T | undefined;
    },
    set: async (key, value) => { entries.set(key, value); },
    delete: async key => { entries.delete(key); },
    // A present history key that cannot be read, plus unrelated ordinary rows.
    keys: async () => [...entries.keys(), 'versions:survive'],
    writeAgentRuntime: async () => { throw new Error('unexpected agent write'); },
    updateAgentRunLease: async () => { throw new Error('unexpected agent lease'); },
  };
  const originalFetch = globalThis.fetch;
  let deletes = 0;
  configureSharedKvBackend(backend);
  globalThis.fetch = async (_input, options) => {
    if (options?.method === 'DELETE') deletes++;
    return new Response(null, { status: 200 });
  };
  try {
    const result = await purgeProjectCascade('remove');
    assert.equal(result.filesDeleted, 0, 'incomplete surviving history must not authorize a binary delete');
    assert.equal(deletes, 0);
    assert.equal(entries.has('project:remove'), false);
    assert.equal(entries.has('project:survive'), true);
  } finally { globalThis.fetch = originalFetch; resetSharedKvMemory(); }
}

console.log('\nmediaCleanup.verify: ALL PASSED');
