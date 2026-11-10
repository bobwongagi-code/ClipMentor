// Export recovery keeps server stages authoritative while IndexedDB retains
// browser FileSystemHandle authority. This verifier covers monotonic legacy
// reconciliation, tombstones, ready contention, leases, and late rebinds.
import assert from 'node:assert/strict';
import type { TimelineState } from '../editor/types';
import {
  createExportRecoveryLeaseOperation,
  type ExportRecoveryLeaseInput,
} from '../../server/plugins/project-store-export-recovery';
import type { LockedProjectStore } from '../../server/plugins/project-store';
import type { ExportDestination } from './exportDestination';
import {
  claimServerExportDelivery,
  listServerExportJobs,
  markServerExportOutputReady,
  markServerExportDeliveryAmbiguous,
  markServerExportTargetCommitted,
  persistServerExportJob,
  releaseServerExportDelivery,
  rebindServerExportJob,
  resetServerExportRecoveryMemory,
  retireServerExportJob,
  type PersistedServerExportJob,
} from './serverExportRecovery';
import { readLocalRecord } from './serverExportRecoveryStore';

const requests: Array<{ request: unknown }> = [];
const indexedDbRows = new Map<string, unknown>();
const originalIndexedDbDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
let transportOutage = false;
let afterLocalListRead: (() => void) | undefined;
let rejectLocalMutationFor: string | undefined;

interface FakeRequest<Result> {
  result: Result;
  error: Error | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

interface FakeTransaction {
  abort(): void;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  error: Error | null;
  objectStore(): {
    put(value: unknown): void;
    delete(key: string): void;
    get(key: string): FakeRequest<unknown>;
    getAll(): FakeRequest<unknown[]>;
  };
}

function installIndexedDb(): void {
  const database = {
    close: () => undefined,
    transaction: (_name?: string, mode?: string): FakeTransaction => {
      const transaction: FakeTransaction = {
        abort: () => transaction.onabort?.(),
        oncomplete: null,
        onerror: null,
        onabort: null,
        error: null,
        objectStore: () => ({
          put: (value) => {
            if (!value || typeof value !== 'object' || !('renderId' in value)
              || typeof value.renderId !== 'string') {
              throw new Error('fake IndexedDB row requires renderId');
            }
            indexedDbRows.set(value.renderId, value);
          },
          delete: (key) => { indexedDbRows.delete(key); },
          get: (key) => {
            if (mode === 'readwrite' && rejectLocalMutationFor === key) {
              rejectLocalMutationFor = undefined;
              throw new Error('injected local transaction unavailable');
            }
            const request: FakeRequest<unknown> = {
              result: indexedDbRows.get(key),
              error: null,
              onsuccess: null,
              onerror: null,
            };
            queueMicrotask(() => request.onsuccess?.());
            return request;
          },
          getAll: () => {
            const request: FakeRequest<unknown[]> = {
              result: [...indexedDbRows.values()],
              error: null,
              onsuccess: null,
              onerror: null,
            };
            queueMicrotask(() => { const hook = afterLocalListRead; afterLocalListRead = undefined; hook?.(); request.onsuccess?.(); });
            return request;
          },
        }),
      };
      // IndexedDB completion follows request callbacks; completing immediately
      // on transaction creation cannot model an atomic get -> validate -> put.
      setTimeout(() => transaction.oncomplete?.(), 0);
      return transaction;
    },
  };
  const factory = {
    open: () => {
      const request = {
        result: database,
        error: null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onblocked: null as (() => void) | null,
        onupgradeneeded: null as (() => void) | null,
      };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  };
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: factory,
  });
}


interface FakeProjectStoreRequest {
  operation: string;
  key?: string;
  value?: unknown;
  entries?: Record<string, unknown>;
  action?: string;
  authorityEstablished?: boolean;
  ownerInstanceId?: string;
  leaseToken?: string;
  leaseMs?: number;
  renderId?: string;
}

function fakeRecoveryOperation(store: Record<string, unknown>) {
  const locked: LockedProjectStore = {
    readEntry: async (key) => Object.hasOwn(store, key)
      ? { found: true, value: store[key] }
      : { found: false },
    writeEntry: async (key, value) => { store[key] = value; },
    writeAgentRuntimeExact: async (key, value) => { store[key] = value; },
    writeEntryExact: async (key, value) => { store[key] = value; },
    removeEntry: async (key) => { delete store[key]; },
  };
  let serialized = Promise.resolve();
  return createExportRecoveryLeaseOperation(async (work) => {
    const result = serialized.then(() => work(locked));
    serialized = result.then(() => undefined, () => undefined);
    return result;
  });
}

function installTransport(store: Record<string, unknown>): void {
  requests.length = 0;
  const mutateRecovery = fakeRecoveryOperation(store);
  (globalThis as Record<string, unknown>).window = {
    openChatCutDesktop: {
      projectStore: async (request: FakeProjectStoreRequest) => {
        if (transportOutage) throw new Error('project store unavailable');
        requests.push({ request });
        if (request.operation === 'export-recovery-lease') {
          return mutateRecovery(request as ExportRecoveryLeaseInput);
        }
        if (request.operation === 'entry') {
          const key = request.key ?? '';
          return Object.hasOwn(store, key)
            ? { found: true, value: store[key] }
            : { found: false };
        }
        if (request.operation === 'set' || request.operation === 'delete') {
          throw new Error('generic export recovery mutation is forbidden');
        }
        if (request.operation === 'snapshot') {
          return { version: 1, entries: store };
        }
        return { ok: true };
      },
    },
  };
}

function uninstallTransport(): void {
  delete (globalThis as Record<string, unknown>).window;
}

function record(
  renderId: string,
  projectId: string,
  destination: ExportDestination = { type: 'downloads', label: 'downloads' },
): PersistedServerExportJob {
  return {
    version: 1,
    renderId,
    projectId,
    label: `job-${renderId}`,
    targetPath: null,
    createdAt: 1,
    updatedAt: 1,
    format: 'video',
    codec: 'h264',
    base: 'base',
    fps: 30,
    state: { fps: 30, width: 1920, height: 1080, items: [], selectedId: null } as unknown as TimelineState,
    destination,
    autoQaEnabled: false,
    stage: 'polling',
  };
}

async function verifyDurableDeliveryLeaseExclusion(): Promise<void> {
  const rows = new Map<string, unknown>();
  const retained = record('lease-render', 'lease-project');
  rows.set('export-recovery:lease-render', retained);
  const store: LockedProjectStore = {
    readEntry: async (key) => rows.has(key)
      ? { found: true, value: rows.get(key) }
      : { found: false },
    writeEntry: async (key, value) => { rows.set(key, value); },
    writeAgentRuntimeExact: async (key, value) => { rows.set(key, value); },
    writeEntryExact: async (key, value) => { rows.set(key, value); },
    removeEntry: async (key) => { rows.delete(key); },
  };
  let serialized = Promise.resolve();
  const mutate = createExportRecoveryLeaseOperation(async (work) => {
    const result = serialized.then(() => work(store));
    serialized = result.then(() => undefined, () => undefined);
    return result;
  });
  const request = (ownerInstanceId: string) => ({
    operation: 'export-recovery-lease' as const,
    key: 'export-recovery:lease-render',
    renderId: 'lease-render',
    action: 'claim' as const,
    ownerInstanceId,
    leaseMs: 60_000,
  });
  const [first, second] = await Promise.all([mutate(request('tab-a')), mutate(request('tab-b'))]);
  assert.equal(Number(first.accepted) + Number(second.accepted), 1,
    'one durable retained output can have only one delivery owner');
  const loser = first.accepted ? 'tab-b' : 'tab-a';
  assert.equal((await mutate(request(loser))).accepted, false,
    'a second tab cannot deliver while the first lease is live');
  const winner = first.accepted ? first : second;
  const ready = await mutate({
    operation: 'export-recovery-lease',
    key: 'export-recovery:lease-render',
    renderId: 'lease-render',
    action: 'ready',
    ownerInstanceId: loser,
  });
  assert.equal(ready.accepted, true, 'a competing ready observation is idempotent');
  const readyRecord = rows.get('export-recovery:lease-render') as PersistedServerExportJob;
  assert.equal(readyRecord.stage, 'output-ready');
  assert.equal(readyRecord.deliveryClaim?.leaseToken, winner.lease?.leaseToken,
    'ready must preserve the winning live claim');
  assert.equal((await mutate({
    operation: 'export-recovery-lease',
    key: 'export-recovery:lease-render',
    renderId: 'lease-render',
    action: 'ready',
    ownerInstanceId: loser,
  })).accepted, true, 'ready remains idempotent after output-ready');
  const winnerOwner = first.accepted ? 'tab-a' : 'tab-b';
  const rebound = await mutate({
    operation: 'export-recovery-lease',
    key: 'export-recovery:lease-render',
    renderId: 'lease-render',
    action: 'rebind',
    ownerInstanceId: winnerOwner,
    leaseToken: winner.lease?.leaseToken,
    value: { ...readyRecord, targetPath: 'late-rebind.mp4' },
  });
  assert.equal(rebound.accepted, true,
    'an unresolved output older than the one-hour retention window remains rebindable');
}

async function verifyLateRecoveryTransitions(): Promise<void> {
  for (const stage of ['output-ready', 'target-committed'] as const) {
    const current = { ...record(`late-${stage}`, 'late-project'), stage,
      deliveryClaim: { ownerInstanceId: 'tab', leaseToken: 'active-token', leaseExpiresAt: Date.now() + 60_000 } };
    const key = `export-recovery:${current.renderId}`, rows: Record<string, unknown> = { [key]: current };
    const mutate = fakeRecoveryOperation(rows);
    const before = JSON.stringify(rows);
    const stale = await mutate({ operation: 'export-recovery-lease', key, renderId: current.renderId,
      action: 'rebind', ownerInstanceId: 'tab', leaseToken: 'active-token',
      value: { ...current, stage: stage === 'target-committed' ? 'output-ready' : 'polling', targetPath: 'late.mp4' } });
    assert.equal(stale.accepted, false, `A late rebind must not rewind ${stage}`);
    assert.equal(JSON.stringify(rows), before, 'Rejected transitions leave the saved output untouched');
  }
  const current = { ...record('rebind-metadata', 'same-project'), stage: 'output-ready' as const,
    deliveryClaim: { ownerInstanceId: 'tab', leaseToken: 'active-token', leaseExpiresAt: Date.now() + 60_000 } };
  const key = `export-recovery:${current.renderId}`, rows: Record<string, unknown> = { [key]: current };
  const rebound = await fakeRecoveryOperation(rows)({ operation: 'export-recovery-lease', key, renderId: current.renderId,
    action: 'rebind', ownerInstanceId: 'tab', leaseToken: 'active-token',
    value: { ...current, targetPath: 'new.mp4', fps: 1, state: { items: ['stale timeline'] }, label: 'wrong-label' } });
  assert.equal(rebound.accepted, true, 'An unresolved result can still receive a valid new target');
  const canonical = rows[key] as PersistedServerExportJob;
  assert.equal(canonical.targetPath, 'new.mp4');
  assert.equal(canonical.fps, current.fps, 'Target reselection cannot rewrite the identity of the retained output');
  assert.deepEqual(canonical.state, current.state); assert.equal(canonical.label, current.label);
  for (const patch of [{ destination: undefined }, { destination: { type: 'unsupported', label: 'bad' } }, { targetPath: 42 }]) {
    const before = JSON.stringify(rows);
    const bad = await fakeRecoveryOperation(rows)({ operation: 'export-recovery-lease', key, renderId: current.renderId,
      action: 'rebind', ownerInstanceId: 'tab', leaseToken: 'active-token', value: { ...canonical, ...patch } });
    assert.equal(bad.accepted, false, 'Invalid destination must not corrupt the retained output descriptor');
    assert.equal(JSON.stringify(rows), before);
  }
}

async function verifyTransitionMatrix(): Promise<void> {
  const expected = {
    polling: { ready: 'output-ready', ambiguous: null, commit: null, rebind: 'polling' },
    'output-ready': { ready: 'output-ready', ambiguous: 'delivery-ambiguous', commit: 'target-committed', rebind: 'output-ready' },
    'delivery-ambiguous': { ready: 'delivery-ambiguous', ambiguous: null, commit: 'target-committed', rebind: 'output-ready' },
    'target-committed': { ready: 'target-committed', ambiguous: null, commit: null, rebind: null },
  } as const;
  for (const [stage, actions] of Object.entries(expected)) {
    for (const [action, nextStage] of Object.entries(actions)) {
      for (const validLease of [true, false]) {
        const current = { ...record('matrix', 'matrix-project'), stage,
          deliveryClaim: { ownerInstanceId: 'tab', leaseToken: 'active', leaseExpiresAt: Date.now() + 60_000 } };
        const key = 'export-recovery:matrix', rows = { [key]: current };
        const before = JSON.stringify(rows);
        const result = await fakeRecoveryOperation(rows)({ operation: 'export-recovery-lease', key, renderId: 'matrix',
          action: action as ExportRecoveryLeaseInput['action'], ownerInstanceId: 'tab', leaseToken: validLease ? 'active' : 'wrong',
          ...(action === 'rebind' ? { value: { ...current, stage: nextStage ?? 'output-ready', targetPath: 'selected.mp4' } } : {}) });
        const accepted = nextStage !== null && (action === 'ready' || validLease);
        assert.equal(result.accepted, accepted, `${stage}/${action}/lease=${validLease}`);
        if (!accepted) assert.equal(JSON.stringify(rows), before);
        else assert.equal(rows[key].stage, nextStage);
      }
    }
  }
}

async function verifyStandaloneStageParity(): Promise<void> {
  uninstallTransport(); resetServerExportRecoveryMemory(); indexedDbRows.clear();
  const id = 'local-stage';
  await persistServerExportJob(record(id, 'local-project'));
  const claim = await claimServerExportDelivery(id); assert(claim);
  await assert.rejects(markServerExportTargetCommitted(id, claim), /恢复阶段/, 'A polling job is not yet a delivered output');
  await markServerExportOutputReady(id);
  await markServerExportTargetCommitted(id, claim);
  const saved = await readLocalRecord(id);
  await assert.rejects(markServerExportDeliveryAmbiguous(id, claim), /恢复阶段/, 'A late error must not rewind an already committed delivery');
  assert.deepEqual(await readLocalRecord(id), saved);
}

async function main(): Promise<void> {
  const serverStore: Record<string, unknown> = {};
  installTransport(serverStore);
  resetServerExportRecoveryMemory();
  indexedDbRows.clear();
  installIndexedDb();
  await verifyDurableDeliveryLeaseExclusion();
  await verifyLateRecoveryTransitions();
  await verifyTransitionMatrix();

  // Browser handle authority is always kept in IndexedDB, while the remote
  // stage is JSON-safe and is joined to that handle after a refresh.
  const browserHandle: Extract<ExportDestination, { type: 'browser-directory' }>['handle'] = {
    kind: 'directory',
    name: 'Exports',
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    getFileHandle: async () => ({
      createWritable: async () => ({
        write: async () => undefined,
        close: async () => undefined,
      }),
    }),
  };
  await persistServerExportJob(record('render-browser', 'project-browser', {
    type: 'browser-directory',
    label: 'Exports',
    handle: browserHandle,
  }));
  const remoteBrowser = serverStore['export-recovery:render-browser'] as PersistedServerExportJob;
  assert.equal(remoteBrowser.destination.type, 'browser-directory');
  if (remoteBrowser.destination.type !== 'browser-directory') throw new Error('expected browser descriptor');
  assert.equal(remoteBrowser.destination.handle, null, 'remote stage must never serialize FileSystemHandle authority');
  assert.doesNotThrow(() => JSON.stringify(remoteBrowser), 'remote recovery stage must remain JSON-safe');

  // An old registration / a late server mirror cannot recover the old handle A
  // after the operator has explicitly selected B for this same retained render.
  const oldRegistration = record('late-browser-register', 'late-browser-project', {
    type: 'browser-directory', label: 'A', handle: browserHandle,
  });
  await persistServerExportJob(oldRegistration);
  await markServerExportOutputReady(oldRegistration.renderId);
  const snapshotA = { version: 1, entries: { ...serverStore } };
  const reboundClaim = await claimServerExportDelivery(oldRegistration.renderId); assert(reboundClaim);
  const handleB = { ...browserHandle, name: 'B' };
  await rebindServerExportJob(oldRegistration.renderId, { type: 'browser-directory', label: 'B', handle: handleB }, 'B/new.mp4', reboundClaim);
  await releaseServerExportDelivery(oldRegistration.renderId, reboundClaim);
  await persistServerExportJob(oldRegistration);
  const localB = await readLocalRecord(oldRegistration.renderId);
  assert.equal(localB?.targetPath, 'B/new.mp4');
  assert.equal(localB?.destination.type === 'browser-directory' && localB.destination.handle, handleB, 'A late registration must retain B, not combine path B with handle A');
  const desktop = (globalThis as any).window.openChatCutDesktop;
  const originalTransport = desktop.projectStore;
  desktop.projectStore = (request: FakeProjectStoreRequest) => request.operation === 'snapshot' ? Promise.resolve(snapshotA) : originalTransport(request);
  try {
    const staleObservation = (await listServerExportJobs(oldRegistration.projectId))[0]!;
    assert.equal(staleObservation.destination.type === 'browser-directory' && staleObservation.destination.handle, null, 'A snapshot for A cannot borrow authority for B');
    assert.deepEqual(await readLocalRecord(oldRegistration.renderId), localB, 'A stale remote snapshot must not erase the newer B authority');
    indexedDbRows.set(oldRegistration.renderId, oldRegistration);
    afterLocalListRead = () => { indexedDbRows.set(oldRegistration.renderId, localB); rejectLocalMutationFor = oldRegistration.renderId; };
    const failedMirror = (await listServerExportJobs(oldRegistration.projectId))[0]!;
    assert.equal(failedMirror.destination.type === 'browser-directory' && failedMirror.destination.handle, null, 'A failed current-authority read cannot fall back to the captured A handle');
    assert.equal(rejectLocalMutationFor, undefined, 'The intended target must actually reach the failing cache read');
    assert.deepEqual(await readLocalRecord(oldRegistration.renderId), localB, 'Cache failure must preserve B in storage');
  } finally { desktop.projectStore = originalTransport; afterLocalListRead = undefined; rejectLocalMutationFor = undefined; }
  const splitId = 'split-destination';
  await persistServerExportJob(record(splitId, 'split-project', { type: 'browser-directory', label: 'A', handle: browserHandle }));
  await markServerExportOutputReady(splitId);
  const splitClaim = await claimServerExportDelivery(splitId); assert(splitClaim);
  const splitKey = `export-recovery:${splitId}`, splitRemote = serverStore[splitKey] as PersistedServerExportJob;
  // Server committed B, but the process died before publishing B's local handle.
  assert.equal((await fakeRecoveryOperation(serverStore)({ operation: 'export-recovery-lease', key: splitKey, renderId: splitId,
    action: 'rebind', ownerInstanceId: splitClaim.ownerInstanceId, leaseToken: splitClaim.leaseToken,
    value: { ...splitRemote, targetPath: 'B/out.mp4', destination: { type: 'browser-directory', label: 'B', handle: null } } })).accepted, true);
  const handleC = { ...browserHandle, name: 'C' };
  await rebindServerExportJob(splitId, { type: 'browser-directory', label: 'C', handle: handleC }, 'C/out.mp4', splitClaim);
  const splitRecovered = await readLocalRecord(splitId);
  assert.equal(splitRecovered?.targetPath, 'C/out.mp4');
  assert.equal(splitRecovered?.destination.type === 'browser-directory' && splitRecovered.destination.handle, handleC, 'An explicit new authorization recovers a server/local partial commit without rerendering');
  await releaseServerExportDelivery(splitId, splitClaim);
  const fileHandle = (physical: string) => ({ kind: 'file' as const, name: 'out.mp4', physical,
    queryPermission: async () => 'granted' as const, requestPermission: async () => 'granted' as const,
    createWritable: async () => ({ write: async () => undefined, close: async () => undefined }) });
  const sameId = 'same-name-lease', handleAFile = fileHandle('folderA/out.mp4'), handleBFile = fileHandle('folderB/out.mp4');
  await persistServerExportJob(record(sameId, 'same-name-project', { type: 'browser-file', label: 'out.mp4', handle: fileHandle('original/out.mp4') }));
  await markServerExportOutputReady(sameId);
  const claimA = await claimServerExportDelivery(sameId); assert(claimA);
  const entered = Promise.withResolvers<void>(), releaseReply = Promise.withResolvers<void>();
  let holdReply = true;
  desktop.projectStore = async (request: FakeProjectStoreRequest) => {
    const response = await originalTransport(request);
    if (request.renderId === sameId && request.action === 'rebind' && holdReply) {
      holdReply = false; entered.resolve(); await releaseReply.promise;
    }
    return response;
  };
  const lateA = rebindServerExportJob(sameId, { type: 'browser-file', label: 'out.mp4', handle: handleAFile }, 'out.mp4', claimA);
  try {
    await entered.promise;
    const key = `export-recovery:${sameId}`, pending = serverStore[key] as PersistedServerExportJob;
    serverStore[key] = { ...pending, deliveryClaim: { ...pending.deliveryClaim!, leaseExpiresAt: Date.now() - 1 } };
    const claimB = await claimServerExportDelivery(sameId); assert(claimB); assert.notEqual(claimB.leaseToken, claimA.leaseToken);
    await rebindServerExportJob(sameId, { type: 'browser-file', label: 'out.mp4', handle: handleBFile }, 'out.mp4', claimB);
    releaseReply.resolve();
    await assert.rejects(lateA, /绑定已失效/);
    const bound = await readLocalRecord(sameId);
    assert.equal(bound?.destination.type === 'browser-file' && bound.destination.handle, handleBFile, 'Same basename is not the same authority: a late old lease cannot restore folderA over folderB');
    assert.equal((serverStore[key] as PersistedServerExportJob).deliveryClaim?.leaseToken, claimB.leaseToken);
    await releaseServerExportDelivery(sameId, claimB);
  } finally { releaseReply.resolve(); desktop.projectStore = originalTransport; await lateA.catch(() => undefined); }
  const localBrowser = indexedDbRows.get('render-browser') as PersistedServerExportJob;
  assert.equal(localBrowser.destination.type, 'browser-directory');
  if (localBrowser.destination.type !== 'browser-directory') throw new Error('expected local browser destination');
  assert.equal(localBrowser.destination.handle, browserHandle, 'IndexedDB must retain the live handle after remote success');
  resetServerExportRecoveryMemory();
  const refreshedBrowser = (await listServerExportJobs('project-browser'))[0]!;
  assert.equal(refreshedBrowser.destination.type, 'browser-directory');
  if (refreshedBrowser.destination.type !== 'browser-directory') throw new Error('expected refreshed browser destination');
  assert.equal(refreshedBrowser.destination.handle, browserHandle, 'refresh must join remote stage with local authority');
  indexedDbRows.delete('render-browser');
  const withoutLocalAuthority = (await listServerExportJobs('project-browser'))[0]!;
  assert.equal(withoutLocalAuthority.destination.type, 'browser-directory');
  if (withoutLocalAuthority.destination.type !== 'browser-directory') {
    throw new Error('expected browser descriptor without local authority');
  }
  assert.equal(withoutLocalAuthority.destination.handle, null,
    'a cache wipe must expose a reselection descriptor instead of dropping the recovery stage');
  requests.length = 0;


  // ── initial persistence uses the server-locked one-time reconcile operation ──
  await persistServerExportJob(record('render-1', 'project-a'));
  assert.equal(requests.length, 1);
  const reconcileRequest = requests[0]!.request as FakeProjectStoreRequest;
  assert.equal(reconcileRequest.operation, 'export-recovery-lease');
  assert.equal(reconcileRequest.action, 'reconcile');
  assert.equal(reconcileRequest.authorityEstablished, false);

  // ── ready + lease + committed are atomic server-side transitions ──
  await markServerExportOutputReady('render-1');
  const deliveryClaim = await claimServerExportDelivery('render-1');
  assert.ok(deliveryClaim);
  await markServerExportTargetCommitted('render-1', deliveryClaim);
  const updated = serverStore['export-recovery:render-1'] as PersistedServerExportJob;
  assert.equal(updated.stage, 'target-committed');
  await releaseServerExportDelivery('render-1', deliveryClaim);

  // ── a newer stale local timestamp cannot rewind server output-ready authority ──
  await persistServerExportJob(record('render-stale', 'project-stale', {
    type: 'browser-directory',
    label: 'Exports',
    handle: browserHandle,
  }));
  await markServerExportOutputReady('render-stale');
  const staleLocal = indexedDbRows.get('render-stale') as PersistedServerExportJob;
  indexedDbRows.set('render-stale', { ...staleLocal, stage: 'polling', updatedAt: Number.MAX_SAFE_INTEGER });
  const staleListed = (await listServerExportJobs('project-stale'))[0]!;
  assert.equal(staleListed.stage, 'output-ready');
  assert.equal((serverStore['export-recovery:render-stale'] as PersistedServerExportJob).stage, 'output-ready',
    'local reconciliation must never rewrite authoritative remote stage');

  // ── a genuinely local legacy row is promoted once through reconcile ──
  uninstallTransport();
  await persistServerExportJob(record('render-legacy', 'project-a'));
  installTransport(serverStore);
  const withLegacy = await listServerExportJobs('project-a');
  assert.ok(withLegacy.some((job) => job.renderId === 'render-legacy'));
  const promoted = indexedDbRows.get('render-legacy') as PersistedServerExportJob;
  assert.equal(promoted.remoteAuthorityEstablished, true);

  // ── once remote authority existed, a missing row becomes a durable tombstone ──
  await persistServerExportJob(record('render-tombstone', 'project-tombstone', {
    type: 'browser-directory',
    label: 'Exports',
    handle: browserHandle,
  }));
  delete serverStore['export-recovery:render-tombstone'];
  assert.deepEqual(await listServerExportJobs('project-tombstone'), []);
  const tombstone = serverStore['export-recovery:render-tombstone'] as Record<string, unknown>;
  assert.equal(tombstone.stage, 'retired');
  assert.equal(indexedDbRows.has('render-tombstone'), false);

  // ── explicit retirement is durable and idempotent ──
  assert.equal(await retireServerExportJob('render-1'), true);

  await verifyStandaloneStageParity();
  assert.equal((serverStore['export-recovery:render-1'] as Record<string, unknown>).stage, 'retired');
  assert.equal(await retireServerExportJob('render-1'), true);

  console.log('✓ export-recovery store verify: monotonic reconcile + claims + tombstones passed');

}

void main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    transportOutage = false;
    if (originalIndexedDbDescriptor) Object.defineProperty(globalThis, 'indexedDB', originalIndexedDbDescriptor);
    else Reflect.deleteProperty(globalThis, 'indexedDB');
  });
