// Real file-store read isolation; no production profile or provider calls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkpointExternalEditSession, createExternalEditSession } from '../../src/agent/external-edit-session';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';

const root = await mkdtemp(join(tmpdir(), 'checkpoint-read-isolation-'));
const previousDataDir = process.env.OPENCHATCUT_DATA_DIR;
const previousStoreMode = process.env.OPENCHATCUT_SQLITE_STORE;
const previousFetch = globalThis.fetch;
const useSqlite = process.argv.includes('--sqlite');
process.env.OPENCHATCUT_DATA_DIR = root;
process.env.OPENCHATCUT_SQLITE_STORE = useSqlite ? '1' : '0';
globalThis.fetch = async () => { throw new Error('Network forbidden'); };
try {
  const { deleteStoredEntry, setStoredEntry, getStoredEntry, withSerializedProjectStore } = await import('./project-store');
  const { initializeSqliteProjectStore, sqliteStoreEnabled } = await import('../storage/sqlite-store');
  // An environment request alone does not promote SQLite to authority.
  if (useSqlite) await initializeSqliteProjectStore();
  assert.equal(sqliteStoreEnabled(), useSqlite, 'exercise the selected storage authority');
  const key = 'project:read-isolation';
  const committed = { marker: 'previously-committed' };
  await setStoredEntry(key, committed);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const writing = withSerializedProjectStore(async store => {
    await store.writeEntryExact(key, { marker: 'not-committed' });
    entered.resolve();
    try { await release.promise; }
    finally { await store.writeEntryExact(key, committed); }
  });
  await entered.promise;
  const reading = getStoredEntry(key);
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    // A bounded assertion that a reader is blocked, never a product wait/retry.
    const outcome = await Promise.race([
      reading.then(value => ({ state: 'read' as const, value })),
      new Promise<{ state: 'blocked' }>(resolve => { watchdog = setTimeout(() => resolve({ state: 'blocked' }), 100); }),
    ]);
    assert.equal(outcome.state, 'blocked', 'single-entry reads must not expose an in-flight write before rollback');
  } finally {
    clearTimeout(watchdog);
    release.resolve();
    await writing;
  }
  assert.deepEqual(await reading, { found: true, value: committed });
  assert.deepEqual(await getStoredEntry(key), { found: true, value: committed }, 'ordinary reads still work after the transaction');
  console.log(`project-store-read-isolation (${sqliteStoreEnabled() ? 'SQLite' : 'JSON'}): blocked during write, old committed value after rollback; zero providers`);

  await deleteStoredEntry(key);
  const { uploadDir } = await import('../media-dir');
  const { handleDeleteUpload } = await import('./upload-route-storage');
  const directory = uploadDir();
  assert.ok(directory.startsWith(root), 'isolated media root required');
  await mkdir(directory, { recursive: true });
  const shared = 'source with spaces.mp4';
  const orphan = 'unreferenced.mp4';
  const broken = 'unknown-owner.mp4';
  const draftOnly = 'draft-only.mp4';
  const stage = 'openchatcut-export-stage-01ab2345-6789-4abc-8def-012345678901.mp4';
  const committedExport = 'openchatcut-export-job-01ab2345-6789-4abc-8def-012345678901.mp4';
  const publishedPreview = 'openchatcut-derived-01ab2345-6789-4abc-8def-012345678901.mp4';
  const ordinary = 'openchatcut-export-stage-rough-cut.mp4';
  for (const name of [shared, orphan, broken, draftOnly, stage, `${stage}.part`, committedExport, ordinary]) {
    await writeFile(join(directory, name), name);
  }
  const started = Promise.withResolvers<void>();
  const server = createServer((req, res) => {
    if (req.url?.includes('source%20with%20spaces')) started.resolve();
    void handleDeleteUpload(req, res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const remove = (name: string) => previousFetch(
    `http://127.0.0.1:${address.port}/upload?name=${encodeURIComponent(name)}&cleanup=1`,
    { method: 'DELETE' },
  );
  try {
    const referencePublished = Promise.withResolvers<void>();
    const releaseReference = Promise.withResolvers<void>();
    // Browser selected the file before the concurrent history was committed.
    const publishing = withSerializedProjectStore(async store => {
      await store.writeEntry('project:survivor', { version: 3, assets: [], timelines: [] });
      await store.writeEntry('versions:survivor', [{
        doc: { version: 99, timelines: [], timelineMetadata: { original: '/media/uploads/source%20with%20spaces.mp4' } },
      }]);
      referencePublished.resolve();
      await releaseReference.promise;
    });
    await referencePublished.promise;
    const deleting = remove(shared);
    try {
      await started.promise;
      assert.equal(await readFile(join(directory, shared), 'utf8'), shared);
    } finally {
      releaseReference.resolve();
      await publishing;
    }
    assert.equal((await deleting).status, 409, 'guard rechecks the newly committed opaque history');
    assert.equal(await readFile(join(directory, shared), 'utf8'), shared);

    await setStoredEntry('versions:survivor', { kind: 'quarantined-project-store-entry' });
    assert.equal((await remove(broken)).status, 500);
    assert.equal(await readFile(join(directory, broken), 'utf8'), broken);
    await setStoredEntry('versions:survivor', [{ doc: { version: 3 } }]);
    assert.equal((await remove(broken)).status, 500);
    assert.equal(await readFile(join(directory, broken), 'utf8'), broken);

    await setStoredEntry('versions:survivor', []);

    // A draft reachable after an editor process restart can own bytes that the
    // current project and all versions have yet to reference.
    const {
      deleteOfflineEditCheckpoint, loadOfflineEditCheckpoint, saveOfflineEditCheckpoint,
    } = await import('../external-agent/offline-project-store');
    const { claimOfflineProjectOwnership, releaseProjectEditOwnership } = await import('../external-agent/project-edit-ownership');
    const projectId = 'draft-recovery';
    const checkpointKey = `offline-edit-session:${projectId}`;
    await setStoredEntry(`project:${projectId}`, {
      version: CURRENT_PROJECT_VERSION, assets: [], mediaFolders: [], activeTimelineId: 'timeline',
      timelines: [{ id: 'timeline', name: 'Fixture', order: 0, fps: 30, width: 1080, height: 1920, selectedId: null, items: [] }],
    });
    const ownership = await claimOfflineProjectOwnership(projectId, 'cleanup-fixture');
    assert.equal(ownership.status, 'claimed');
    if (ownership.status !== 'claimed') throw new Error('expected fixture edit lease');
    try {
      const checkpoint = checkpointExternalEditSession(createExternalEditSession(ownership.doc, 'Cleanup fixture'));
      checkpoint.draftDoc = {
        ...checkpoint.draftDoc,
        assets: [{ id: 'draft-asset', kind: 'video', src: `/media/uploads/${draftOnly}`, name: draftOnly, durationInFrames: 30 }],
      };
      assert.equal(await saveOfflineEditCheckpoint({
        projectId, expectedRevision: ownership.revision, ownership: ownership.claim, checkpoint, canSave: () => true,
      }), 'saved');
      assert.equal((await loadOfflineEditCheckpoint(projectId, ownership.revision))?.draftDoc.assets[0]?.src, `/media/uploads/${draftOnly}`);
      assert.equal((await remove(draftOnly)).status, 409, 'recoverable drafts retain their source bytes');
      assert.equal(await readFile(join(directory, draftOnly), 'utf8'), draftOnly);
      await deleteOfflineEditCheckpoint(projectId, checkpoint.sessionId, ownership.claim);
      assert.equal((await remove(draftOnly)).status, 200, 'discarding the only draft releases its reference');
      await assert.rejects(readFile(join(directory, draftOnly)), { code: 'ENOENT' });
    } finally { await releaseProjectEditOwnership(ownership.claim); }
    await setStoredEntry(checkpointKey, { kind: 'quarantined-project-store-entry' });
    assert.equal((await remove(broken)).status, 500);
    assert.equal(await readFile(join(directory, broken), 'utf8'), broken);
    await deleteStoredEntry(checkpointKey);

    // A portable template can outlive its originating project. Drafts,
    // proposals and upload journals can own an asset before a project save.
    const retainedName = 'retained-by-saved-work.mp4';
    const retainedPath = join(directory, retainedName);
    const src = '/media/uploads/' + retainedName;
    const savedDoc = { ...ownership.doc, assets: [{ id: 'ref', kind: 'video', src, name: retainedName, durationInFrames: 30 }] };
    const proposal = { options: [{ operations: [{ actions: [{ type: 'ADD_ASSET', asset: savedDoc.assets[0] }] }] }],
      baseDoc: ownership.doc, resultState: savedDoc.timelines[0] };
    const body = JSON.stringify({ version: 1, kind: 'base', baseDoc: savedDoc });
    const artifact = { version: 1, artifactId: 'srd_base', projectId: 'survivor', runId: 'test', kind: 'server-run-draft',
      body, bodySha256: createHash('sha256').update(body).digest('hex'), originalBytes: Buffer.byteLength(body),
      originalChars: body.length, createdAt: 1, redacted: false, binaryOmitted: false };
    const owners: [string, unknown][] = [
      ['templates:all', [{ id: 'template', name: 'Reusable', createdAt: 1, doc: savedDoc, assetIds: ['ref'] }]],
      ['external-proposal:survivor', { status: 'drafting', draftCheckpoint: { draftDoc: savedDoc } }],
      ['proposal:survivor', proposal],
      ['agent-session-proposal:survivor:session1', { version: 1, phase: 'prepared', proposal }],
      ['upload-finalize:survivor:' + 'a'.repeat(64), { version: 1, status: 'prepared', mutation: { asset: savedDoc.assets[0] } }],
      ['agent-artifact:survivor:srd_base', artifact],
      ['agent-session-artifact:survivor:session1:srd_base', artifact],
    ];
    await writeFile(retainedPath, 'retained bytes');
    for (const [ownerKey, row] of owners) {
      await setStoredEntry(ownerKey, row);
      assert.ok((await getStoredEntry(ownerKey)).found, ownerKey + ' must actually be persisted');
      assert.equal((await remove(retainedName)).status, 409, ownerKey + ' keeps its unique media');
      assert.equal(await readFile(retainedPath, 'utf8'), 'retained bytes');
      await deleteStoredEntry(ownerKey);
    }
    assert.equal((await remove(retainedName)).status, 200, 'discarding the final owner releases media');
    await assert.rejects(readFile(retainedPath), { code: 'ENOENT' });

    const { createGenerationJob } = await import('./generation-job-lifecycle');
    const { resolveCommittedExport } = await import('./export-delivery');
    const { promoteExportResult } = await import('./export-runtime');
    const { runtimeProfile } = await import('../runtime-profile');
    const attemptId = '01ab2345-6789-4abc-8def-012345678901';
    const exportSettled = Promise.withResolvers<void>();
    const renderResult = {
      assetId: attemptId, name: 'Fixture export', kind: 'video',
      path: `/media/uploads/${committedExport}`, sizeBytes: Buffer.byteLength(committedExport), durationSeconds: 1,
    } as const;
    await createGenerationJob({ kind: 'export', exportAttemptId: attemptId }, async () => renderResult, {
      operationId: attemptId, onSettled: () => exportSettled.resolve(),
    });
    const settlementTimeout = setTimeout(() => exportSettled.reject(new Error('fixture export failed to settle')), 5000);
    try { await exportSettled.promise; } finally { clearTimeout(settlementTimeout); }
    assert.equal((await resolveCommittedExport(committedExport))?.bytes, Buffer.byteLength(committedExport),
      'the ledger-backed export is reachable before cleanup');
    // This is the same durable promotion the production worker performs
    // before saving a preview receipt. No project document owns this path.
    assert.equal((await promoteExportResult(renderResult, directory, runtimeProfile())).path, `/media/uploads/${publishedPreview}`);
    assert.equal((await remove(publishedPreview)).status, 409);
    assert.equal(await readFile(join(directory, publishedPreview), 'utf8'), committedExport);
    for (const name of [stage, `${stage}.part`, committedExport]) {
      assert.equal((await remove(name)).status, 409, 'export stage and result lifetimes belong to export services');
      assert.equal(await readFile(join(directory, name), 'utf8'), name);
    }
    assert.equal((await resolveCommittedExport(committedExport))?.bytes, Buffer.byteLength(committedExport),
      'the ledger-backed export remains reachable after cleanup');
    assert.equal((await remove(ordinary)).status, 200, 'a similar user file remains eligible for cleanup');
    await assert.rejects(readFile(join(directory, ordinary)), { code: 'ENOENT' });
    assert.equal((await remove(orphan)).status, 200);
    await assert.rejects(readFile(join(directory, orphan)), { code: 'ENOENT' });
    console.log('guarded upload cleanup: concurrent history, draft recovery, export service files, unreadable rows and safe orphan removal');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
} finally {
  globalThis.fetch = previousFetch;
  if (previousDataDir === undefined) delete process.env.OPENCHATCUT_DATA_DIR;
  else process.env.OPENCHATCUT_DATA_DIR = previousDataDir;
  if (previousStoreMode === undefined) delete process.env.OPENCHATCUT_SQLITE_STORE;
  else process.env.OPENCHATCUT_SQLITE_STORE = previousStoreMode;
  await rm(root, { recursive: true, force: true });
}
