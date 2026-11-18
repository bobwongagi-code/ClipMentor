import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version.ts';
import {
  checkpointExternalEditSession,
  createExternalEditSession,
} from '../../src/agent/external-edit-session.ts';
import { historyReduce } from '../../src/editor/reducerHistory.ts';
import type { ProjectDoc } from '../../src/editor/types.ts';
import type { BrowserOwnershipClaimResult, ProjectEditOwnershipClaim } from './project-edit-ownership.ts';

function projectDoc(width = 1920, height = 1080): ProjectDoc {
  return {
    version: CURRENT_PROJECT_VERSION,
    assets: [],
    mediaFolders: [],
    activeTimelineId: 'timeline-1',
    timelines: [{
      id: 'timeline-1',
      name: 'Timeline 1',
      order: 0,
      fps: 30,
      width,
      height,
      items: [],
      selectedId: null,
      trackOrder: ['track-v1'],
      tracks: { 'track-v1': { kind: 'video' } },
    }],
  };
}

function entryArray(value: unknown): unknown[] {
  assert(Array.isArray(value));
  return value;
}

const root = await mkdtemp(join(tmpdir(), 'occ-offline-store-'));
const previousHome = process.env.HOME;
process.env.HOME = root;

// Store paths are captured at module evaluation, so known modules load only
// after HOME points at an isolated directory.

try {
  const { getStoredEntry, setStoredEntry, writeProjectDocument } = await import('../plugins/project-store.ts');
  const {
    commitOfflineStoredProject,
    deleteOfflineEditCheckpoint,
    loadOfflineEditCheckpoint,
    loadOfflineStoredProject,
    saveOfflineEditCheckpoint,
    writeCommitEntries,
  } = await import('./offline-project-store.ts');
  for (const failedKey of ['project', 'ownership', 'checkpoint']) {
    const initial = { project: 'old document', versions: 'old versions', checkpoint: 'saved draft' };
    const storage = new Map(Object.entries(initial));
    const keys = ['versions', 'project', 'ownership', 'checkpoint'];
    const originals = Object.fromEntries(keys.map((key) => [
      key, storage.has(key) ? { found: true, value: storage.get(key) } : { found: false },
    ]));
    const next = Object.fromEntries(keys.map((key) => [
      key, key === 'checkpoint' ? { found: false } : { found: true, value: `new ${key}` },
    ]));
    let failed = false;
    function failAfterPublish(key: string) {
      if (key === failedKey && !failed) {
        failed = true;
        throw new Error('directory fsync failed after publish');
      }
    }
    await assert.rejects(writeCommitEntries({
      writeEntry: async (key, value) => {
        storage.set(key, String(value));
        failAfterPublish(key);
      },
      removeEntry: async (key) => {
        storage.delete(key);
        failAfterPublish(key);
      },
    }, next, originals, () => true), /directory fsync failed/);
    assert.deepEqual(Object.fromEntries(storage), initial,
      'failure after replacing or removing a row must roll back that row and earlier writes');
  }
  const {
    claimBrowserProjectOwnership,
    claimOfflineProjectOwnership,
    releaseProjectEditOwnership,
  } = await import('./project-edit-ownership.ts');
  const projectId = 'stored-project';
  const base = projectDoc();
  await setStoredEntry(`project:${projectId}`, base);
  await setStoredEntry('projects', [{ id: projectId, name: 'Stored project', updatedAt: 10 }]);
  await setStoredEntry(`versions:${projectId}`, [{
    id: 'manual-version',
    name: 'Manual',
    createdAt: 1,
    automatic: false,
    doc: projectDoc(640, 360),
  }]);

  const initialClaim = await claimOfflineProjectOwnership(projectId, 'offline-owner-1');
  assert.equal(initialClaim.status, 'claimed');
  if (initialClaim.status !== 'claimed') throw new Error('offline ownership claim failed');
  let ownership = initialClaim.claim;
  const snapshot = await loadOfflineStoredProject(projectId);
  assert(snapshot);
  const draftSession = createExternalEditSession(snapshot.doc, 'checkpoint test', 'auto');
  const checkpoint = checkpointExternalEditSession(draftSession);
  assert.equal(await saveOfflineEditCheckpoint({
    projectId,
    expectedRevision: snapshot.revision,
    checkpoint,
    ownership,
    canSave: () => true,
  }), 'saved');
  assert.deepEqual(
    await loadOfflineEditCheckpoint(projectId, snapshot.revision),
    checkpoint,
  );
  await deleteOfflineEditCheckpoint(projectId, checkpoint.sessionId, ownership);
  assert.equal(await loadOfflineEditCheckpoint(projectId, snapshot.revision), null);
  const futureCheckpoint = {
    version: 2,
    projectId,
    opaqueFutureState: { mustSurvive: true },
  };
  await setStoredEntry(`offline-edit-session:${projectId}`, futureCheckpoint);
  await assert.rejects(
    loadOfflineEditCheckpoint(projectId, snapshot.revision),
    /version 2 is not supported/,
  );
  await assert.rejects(
    saveOfflineEditCheckpoint({
      projectId,
      expectedRevision: snapshot.revision,
      checkpoint,
      ownership,
      canSave: () => true,
    }),
    /version 2 is not supported/,
  );
  await assert.rejects(
    deleteOfflineEditCheckpoint(projectId, checkpoint.sessionId, ownership),
    /corrupt or unsupported/,
  );
  assert.deepEqual(
    (await getStoredEntry(`offline-edit-session:${projectId}`)).value,
    futureCheckpoint,
    'an old offline client cannot downgrade a future checkpoint',
  );
  const committed = await commitOfflineStoredProject({
    projectId,
    expectedRevision: snapshot.revision,
    doc: projectDoc(1080, 1920),
    ownership,
    canCommit: () => true,
  });
  assert.equal(committed.status, 'applied');
  assert(committed.ownership);
  ownership = committed.ownership;
  const saved = await getStoredEntry(`project:${projectId}`);
  assert.deepEqual(saved.value, projectDoc(1080, 1920));
  const versions = entryArray((await getStoredEntry(`versions:${projectId}`)).value);
  assert.equal(versions.length, 2);
  assert(versions[0] && typeof versions[0] === 'object' && 'automatic' in versions[0]);
  assert.equal(versions[0].automatic, true);
  assert(versions[0] && typeof versions[0] === 'object' && 'doc' in versions[0]);
  assert.deepEqual(versions[0].doc, base);
  assert(versions.some((entry) => entry !== null && typeof entry === 'object' && 'id' in entry && entry.id === 'manual-version'));
  const projects = entryArray((await getStoredEntry('projects')).value);
  const meta = projects.find((entry) => entry !== null && typeof entry === 'object' && 'id' in entry && entry.id === projectId);
  assert(meta && typeof meta === 'object' && 'updatedAt' in meta && typeof meta.updatedAt === 'number');
  assert(meta.updatedAt > 10);

  const concurrent = projectDoc(1280, 720);
  await setStoredEntry(`project:${projectId}`, concurrent);
  const beforeStaleVersions = (await getStoredEntry(`versions:${projectId}`)).value;
  const stale = await commitOfflineStoredProject({
    projectId,
    expectedRevision: snapshot.revision,
    doc: projectDoc(720, 1280),
    ownership,
    canCommit: () => true,
  });
  assert.equal(stale.status, 'stale');
  assert.deepEqual((await getStoredEntry(`project:${projectId}`)).value, concurrent);
  assert.deepEqual((await getStoredEntry(`versions:${projectId}`)).value, beforeStaleVersions);

  await releaseProjectEditOwnership(ownership);
  await setStoredEntry(`project:${projectId}`, base);
  const automatic = {
    id: 'automatic-base',
    name: 'Automatic',
    createdAt: 100,
    automatic: true,
    doc: base,
  };
  const manual = {
    id: 'manual-preserved',
    name: 'Manual',
    createdAt: 50,
    automatic: false,
    doc: projectDoc(640, 360),
  };
  await setStoredEntry(`versions:${projectId}`, [automatic, manual]);
  const dedupeClaim = await claimOfflineProjectOwnership(projectId, 'offline-owner-2');
  assert.equal(dedupeClaim.status, 'claimed');
  if (dedupeClaim.status !== 'claimed') throw new Error('dedupe ownership claim failed');
  ownership = dedupeClaim.claim;
  const dedupeSnapshot = await loadOfflineStoredProject(projectId);
  assert(dedupeSnapshot);
  const deduped = await commitOfflineStoredProject({
    projectId,
    expectedRevision: dedupeSnapshot.revision,
    doc: projectDoc(1080, 1920),
    ownership,
    canCommit: () => true,
  });
  assert.equal(deduped.status, 'applied');
  assert(deduped.ownership);
  ownership = deduped.ownership;
  assert.equal(deduped.automaticVersionCreated, false);
  assert.deepEqual((await getStoredEntry(`versions:${projectId}`)).value, [automatic, manual]);

  await releaseProjectEditOwnership(ownership);
  await setStoredEntry(`project:${projectId}`, base);
  const rollbackSnapshot = await loadOfflineStoredProject(projectId);
  assert(rollbackSnapshot);
  const beforeRollbackProjects = (await getStoredEntry('projects')).value;
  const beforeRollbackVersions = (await getStoredEntry(`versions:${projectId}`)).value;
  const rollbackClaim = await claimOfflineProjectOwnership(projectId, 'offline-owner-3');
  assert.equal(rollbackClaim.status, 'claimed');
  if (rollbackClaim.status !== 'claimed') throw new Error('rollback ownership claim failed');
  ownership = rollbackClaim.claim;
  let guardChecks = 0;
  const takeover = await commitOfflineStoredProject({
    projectId,
    expectedRevision: rollbackSnapshot.revision,
    doc: projectDoc(1080, 1920),
    ownership,
    canCommit: () => {
      guardChecks += 1;
      return guardChecks < 4;
    },
  });
  assert.equal(takeover.status, 'browser-takeover');
  assert.deepEqual((await getStoredEntry(`project:${projectId}`)).value, base);
  assert.deepEqual((await getStoredEntry('projects')).value, beforeRollbackProjects);
  assert.deepEqual((await getStoredEntry(`versions:${projectId}`)).value, beforeRollbackVersions);

  await releaseProjectEditOwnership(ownership);
  await setStoredEntry(`project:${projectId}`, base);
  const raceClaim = await claimOfflineProjectOwnership(projectId, 'offline-race-owner');
  assert.equal(raceClaim.status, 'claimed');
  if (raceClaim.status !== 'claimed') throw new Error('race ownership claim failed');
  let browserClaim: Promise<BrowserOwnershipClaimResult> | undefined;
  const serializedCommit = await commitOfflineStoredProject({
    projectId,
    expectedRevision: raceClaim.revision,
    doc: projectDoc(1000, 1000),
    ownership: raceClaim.claim,
    canCommit: () => {
      browserClaim ??= claimBrowserProjectOwnership(
        projectId,
        'browser-race-owner',
        raceClaim.revision,
      );
      return true;
    },
  });
  assert.equal(serializedCommit.status, 'applied');
  assert.equal((await browserClaim)?.status, 'stale',
    'browser registration queued behind an offline commit must reload the committed revision');
  assert(serializedCommit.ownership);
  await releaseProjectEditOwnership(serializedCommit.ownership);

  const browserTakeover = await claimBrowserProjectOwnership(
    projectId,
    'browser-takeover-owner',
    serializedCommit.revision!,
  );
  assert.equal(browserTakeover.status, 'claimed');
  // A browser window re-claiming its OWN project (same ownerId, same revision)
  // recovers (claimed) even without a capability, because the route-level
  // capability check (broker capabilityMatches) already rejects forged/mismatched
  // renewals before this claim runs. Blocking same-owner recovery produced a
  // spurious 409 that flashed "close the other window" when the bridge
  // tear-down/reconnect path re-registered the same editor without its in-memory
  // capability.
  const reconnect = await claimBrowserProjectOwnership(
    projectId,
    'browser-takeover-owner',
    serializedCommit.revision!,
  );
  assert.equal(reconnect.status, 'claimed',
    'a same-window reconnect must recover its own persisted ownership');
  const renewed = await claimBrowserProjectOwnership(
    projectId,
    'browser-takeover-owner',
    serializedCommit.revision!,
    true,
  );
  assert.equal(renewed.status, 'claimed',
    'the live renderer can renew its persisted ownership');
  const fencedCommit = await commitOfflineStoredProject({
    projectId,
    expectedRevision: serializedCommit.revision!,
    doc: projectDoc(720, 720),
    ownership: serializedCommit.ownership,
    canCommit: () => true,
  });
  assert.equal(fencedCommit.status, 'browser-takeover');
  assert.deepEqual((await getStoredEntry(`project:${projectId}`)).value, projectDoc(1000, 1000),
    'browser ownership claimed first fences the stale offline writer');

  const { OfflineExternalEditRuntime } = await import('./offline-runtime.ts');
  const { DEFAULT_PERSISTENCE } = await import('./offline-runtime-support.ts');
  const { editSessionId } = await import('./offline-runtime.verify-fixtures.ts');
  const discardProject = 'offline-discard-takeover';
  const discardKey = `project:${discardProject}`;
  const discardCheckpoint = `offline-edit-session:${discardProject}`;
  const editorUrl = 'http://localhost:5173';
  function saveBrowserDocument(claim: ProjectEditOwnershipClaim, doc: ProjectDoc) {
    return writeProjectDocument({
      operation: 'project-document-write',
      key: `project:${claim.projectId}`,
      expectedRevision: claim.baseRevision,
      ownerId: claim.ownerId,
      ownershipEpoch: claim.epoch,
      value: doc,
    });
  }
  await setStoredEntry(discardKey, base);
  let browserTakeoverClaim: BrowserOwnershipClaimResult | undefined;
  const old = await OfflineExternalEditRuntime.create(discardProject, editorUrl, {
    persistence: {
      ...DEFAULT_PERSISTENCE,
      async deleteCheckpoint(...args) {
        // The original lease ends after the request's validation, before deletion.
        await releaseProjectEditOwnership(args[2]);
        browserTakeoverClaim = await claimBrowserProjectOwnership(
          discardProject, 'browser-discard-race', args[2].baseRevision,
        );
        assert.equal(browserTakeoverClaim.status, 'claimed');
        return deleteOfflineEditCheckpoint(...args);
      },
    },
  });
  try {
    const oldId = editSessionId(await old.execute('begin_edit_session', { approvalMode: 'auto' }));
    await old.execute('set_aspect_ratio', { editSessionId: oldId, ratio: '9:16' });
    const savedCheckpoint = await getStoredEntry(discardCheckpoint);
    await assert.rejects(
      old.execute('discard_edit_session', { editSessionId: oldId }),
      { outcome: 'stale' },
      'a request that lost the lease cannot acknowledge draft deletion',
    );
    assert.deepEqual(await getStoredEntry(discardCheckpoint), savedCheckpoint);
    assert.deepEqual((await getStoredEntry(discardKey)).value, base);
    assert.equal((await claimOfflineProjectOwnership(discardProject, 'late-offline-editor')).status, 'busy');
    assert(browserTakeoverClaim?.status === 'claimed');
    const changed = projectDoc(1280, 720);
    const saved = await saveBrowserDocument(browserTakeoverClaim.claim, changed);
    assert(saved.accepted && saved.currentRevision);
    await releaseProjectEditOwnership(browserTakeoverClaim.claim);
    await old.dispose();

    const differentBase = await OfflineExternalEditRuntime.create(discardProject, editorUrl);
    try {
      const begin = await differentBase.execute('begin_edit_session', { approvalMode: 'auto' });
      const differentId = editSessionId(begin);
      assert.notEqual(differentId, oldId, 'the old checkpoint must not be loaded for the browser revision');
      const discarded = await differentBase.execute('discard_edit_session', { editSessionId: differentId });
      assert(discarded && typeof discarded === 'object' && 'status' in discarded);
      assert.equal(discarded.status, 'cancelled', 'an empty draft can be discarded while another base has a saved checkpoint');
      assert.deepEqual(await getStoredEntry(discardCheckpoint), savedCheckpoint);
    } finally {
      await differentBase.dispose();
    }
    const undoOwner = await claimBrowserProjectOwnership(discardProject, 'browser-discard-race', saved.currentRevision);
    assert(undoOwner.status === 'claimed');
    const reverted = historyReduce({ past: [base], present: changed, future: [] }, { type: 'undo' });
    assert.equal((await saveBrowserDocument(undoOwner.claim, reverted.present)).accepted, true);
    await releaseProjectEditOwnership(undoOwner.claim);

    const newOwner = await OfflineExternalEditRuntime.create(discardProject, editorUrl);
    try {
      const resumed = await newOwner.execute('begin_edit_session', { approvalMode: 'auto' });
      assert.equal(editSessionId(resumed), oldId);
      assert(resumed && typeof resumed === 'object' && 'operationCount' in resumed);
      assert.equal(resumed.operationCount, 1);
      assert.deepEqual((await getStoredEntry(discardKey)).value, base);
      await newOwner.execute('discard_edit_session', { editSessionId: oldId });
      assert.equal((await getStoredEntry(discardCheckpoint)).found, false);
    } finally {
      await newOwner.dispose();
    }
    const freshOwner = await OfflineExternalEditRuntime.create(discardProject, editorUrl);
    try {
      const freshId = editSessionId(await freshOwner.execute('begin_edit_session', { approvalMode: 'auto' }));
      assert.notEqual(freshId, oldId);
      await freshOwner.execute('set_aspect_ratio', { editSessionId: freshId, ratio: '1:1' });
      assert.deepEqual((await getStoredEntry(discardKey)).value, base);
    } finally {
      await freshOwner.dispose();
    }
  } finally {
    await old.dispose();
  }
  const undoProject = 'offline-apply-undo';
  const undoKey = `project:${undoProject}`;
  const undoCheckpoint = `offline-edit-session:${undoProject}`;
  await setStoredEntry(undoKey, base);
  const edit = await OfflineExternalEditRuntime.create(undoProject, editorUrl);
  let originalId: string;
  let legacyCheckpoint: unknown;
  let applyingRuntime = edit;
  try {
    originalId = editSessionId(await edit.execute('begin_edit_session', { approvalMode: 'auto' }));
    await edit.execute('set_aspect_ratio', { editSessionId: originalId, ratio: '9:16' });
    const checkpointBeforeCommit = await getStoredEntry(undoCheckpoint);
    assert.equal(checkpointBeforeCommit.found, true);
    legacyCheckpoint = checkpointBeforeCommit.value;
    const { sqliteStoreEnabled } = await import('../storage/sqlite-store.ts');
    if (!sqliteStoreEnabled()) {
      const versionKey = `versions:${undoProject}`;
      const beforeVersions = await getStoredEntry(versionKey);
      const originalRemove = fs.rm;
      let injected = false;
      fs.rm = async (path, options) => {
        await originalRemove(path, options);
        if (typeof path === 'string' && basename(path) === `${encodeURIComponent(undoCheckpoint)}.json` && !injected) {
          injected = true;
          throw new Error('injected error after checkpoint removal');
        }
      };
      syncBuiltinESMExports();
      try {
        await assert.rejects(edit.execute('review_edit_session', { editSessionId: originalId }), { outcome: 'failed' });
        assert.equal(injected, true);
      } finally {
        fs.rm = originalRemove;
        syncBuiltinESMExports();
      }
      assert.deepEqual((await getStoredEntry(undoKey)).value, base);
      assert.deepEqual(await getStoredEntry(versionKey), beforeVersions);
      assert.deepEqual(await getStoredEntry(undoCheckpoint), checkpointBeforeCommit);
      await edit.dispose();
      applyingRuntime = await OfflineExternalEditRuntime.create(undoProject, editorUrl);
      const resumed = await applyingRuntime.execute('begin_edit_session', { approvalMode: 'auto' });
      assert.equal(editSessionId(resumed), originalId);
    }
    const applied = await applyingRuntime.execute('review_edit_session', { editSessionId: originalId });
    const vertical = projectDoc(1080, 1920);
    vertical.timelines[0].fit = 'contain';
    assert.deepEqual((await getStoredEntry(undoKey)).value, vertical);
    assert(applied && typeof applied === 'object' && 'status' in applied && applied.status === 'applied');
    assert.equal((await getStoredEntry(undoCheckpoint)).found, false, 'commit consumes the checkpoint before replying');
  } finally {
    await applyingRuntime.dispose();
    await edit.dispose();
  }
  const afterEdit = await loadOfflineStoredProject(undoProject);
  assert(afterEdit);
  const browser = await claimBrowserProjectOwnership(undoProject, 'browser-undo', afterEdit.revision);
  assert(browser.status === 'claimed');
  const undo = historyReduce({ past: [base], present: afterEdit.doc, future: [] }, { type: 'undo' });
  assert.deepEqual(undo.present, base);
  assert.equal((await saveBrowserDocument(browser.claim, undo.present)).accepted, true);
  await releaseProjectEditOwnership(browser.claim);
  // Simulate an old installation which published B but could not clean up the draft.
  await setStoredEntry(undoCheckpoint, legacyCheckpoint);
  const reopen = await OfflineExternalEditRuntime.create(undoProject, editorUrl);
  try {
    const fresh = await reopen.execute('begin_edit_session', { approvalMode: 'auto' });
    assert(fresh && typeof fresh === 'object' && 'resumed' in fresh && 'operationCount' in fresh);
    assert.equal(fresh.resumed, false, 'undo must not revive the checkpoint of an already applied edit');
    assert.equal(fresh.operationCount, 0);
    assert.notEqual(editSessionId(fresh), originalId);
    assert.equal((await getStoredEntry(undoCheckpoint)).found, false);
    assert.deepEqual((await getStoredEntry(undoKey)).value, base);
  } finally {
    await reopen.dispose();
  }
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
}

console.log('offline-project-store.verify: ok');
