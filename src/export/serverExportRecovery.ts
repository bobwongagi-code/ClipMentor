import { exportRecoveryNextStage, type ExportRecoveryTransition } from '../../shared/export-recovery';
import type { ExportDestination } from './exportDestination';
import {
  browserDestination,
  hasServerExportDestinationAuthority,
  readLocalRecord,
  readLocalRecords,
  remoteSafeRecord,
  removeLocalRecord,
  resetServerExportRecoveryMemory,
  validRecord,
  mutateLocalRecord,
} from './serverExportRecoveryStore';
import type {
  PersistedServerExportJob,
  ServerExportDeliveryClaim,
  ServerExportRecoveryDestination,
  ServerExportRecoveryStage,
} from './serverExportRecoveryStore';
import {
  projectStoreRemoteAvailable,
  projectStoreWriteCredential,
  requestProjectStore,
} from '../persist/projectStoreTransport';

export {
  hasServerExportDestinationAuthority,
  resetServerExportRecoveryMemory,
};
export type {
  PersistedServerExportJob,
  ServerExportDeliveryClaim,
  ServerExportRecoveryDestination,
  ServerExportRecoveryStage,
};

/** Server-side kv prefix (phase B: recovery state survives cache wipes). */
const REMOTE_PREFIX = 'export-recovery:';
const DELIVERY_LEASE_MS = 120_000;
const deliveryOwnerId = globalThis.crypto?.randomUUID?.()
  ?? `export-delivery-${Date.now()}-${Math.random().toString(36).slice(2)}`;


class RetiredExportRecoveryError extends Error {}

async function registerLocalRecord(record: PersistedServerExportJob): Promise<void> {
  await mutateLocalRecord(record.renderId, (current) => {
    if (current && current.projectId !== record.projectId) throw new Error('导出恢复记录不属于当前工程');
    // Reopening an old registration is not a stage transition or destination rebind.
    return { result: undefined, ...(!current ? { next: record } : {}) };
  });
}

function joinRemoteRecord(
  remote: PersistedServerExportJob,
  local?: PersistedServerExportJob | null,
): PersistedServerExportJob {
  const destination = browserDestination(remote.destination)
    && local && browserDestination(local.destination)
    && sameDestinationBinding(remote, local)
    && hasServerExportDestinationAuthority(local.destination)
    ? local.destination
    : remote.destination;
  return { ...remote, destination, remoteAuthorityEstablished: true };
}

function sameDestinationBinding(a: PersistedServerExportJob, b: PersistedServerExportJob): boolean {
  if (a.renderId !== b.renderId || a.projectId !== b.projectId || a.targetPath !== b.targetPath
    || a.destination.type !== b.destination.type || a.destination.label !== b.destination.label) return false;
  if (a.destination.type === 'desktop-directory' && b.destination.type === 'desktop-directory') return a.destination.grantId === b.destination.grantId;
  if (a.destination.type === 'desktop-file' && b.destination.type === 'desktop-file') return a.destination.grantId === b.destination.grantId && a.destination.filename === b.destination.filename;
  return true;
}

async function cacheRemoteRecord(remote: PersistedServerExportJob): Promise<PersistedServerExportJob> {
  return mutateLocalRecord(remote.renderId, (local) => {
    const joined = joinRemoteRecord(remote, local);
    // A stale observation may be returned without a usable handle, but must not
    // erase authority that has since been rebound to another destination.
    const compatible = local && sameDestinationBinding(remote, local);
    const terminal = local?.stage === 'target-committed' && remote.stage !== 'target-committed';
    return { result: joined, ...(compatible && !terminal ? { next: joined } : {}) };
  });
}

async function reconcileRemoteRecord(
  record: PersistedServerExportJob,
): Promise<PersistedServerExportJob | null> {
  const result = leaseResponse(await requestProjectStore({
    operation: 'export-recovery-lease',
    key: `${REMOTE_PREFIX}${record.renderId}`,
    renderId: record.renderId,
    action: 'reconcile',
    ownerInstanceId: deliveryOwnerId,
    authorityEstablished: record.remoteAuthorityEstablished === true,
    value: remoteSafeRecord(record),
  }));
  return result.accepted && validRecord(result.value) ? result.value : null;
}

export async function persistServerExportJob(record: PersistedServerExportJob): Promise<void> {
  const requiresLocalAuthority = browserDestination(record.destination);
  let localSaved = false;
  let localError: unknown;
  if (requiresLocalAuthority) {
    try {
      await registerLocalRecord(record);
      localSaved = true;
    } catch (error) {
      localError = error;
    }
  }
  let remoteSaved = false;
  if (projectStoreWriteCredential()) {
    try {
      const canonical = await reconcileRemoteRecord(record);
      if (!canonical) throw new RetiredExportRecoveryError('导出恢复记录已退役');
      remoteSaved = true;
      if (localSaved) await cacheRemoteRecord(canonical);
    } catch (error) {
      if (error instanceof RetiredExportRecoveryError) {
        if (localSaved) await removeLocalRecord(record.renderId);
        throw error;
      }
    }
  }
  if (!localSaved && !remoteSaved) {
    await registerLocalRecord(record);
    localSaved = true;
  }
  if (requiresLocalAuthority && !localSaved) {
    throw localError instanceof Error ? localError : new Error('无法保存浏览器导出目标授权');
  }
}

type RecoveryTransitionAction = Exclude<ExportRecoveryTransition, 'rebind'>;

async function updateLocalStage(
  renderId: string,
  action: RecoveryTransitionAction,
  claim?: ServerExportDeliveryClaim,
): Promise<boolean> {
  return mutateLocalRecord(renderId, (local) => {
    if (!local) return { result: false };
    const stage = exportRecoveryNextStage(local.stage, action);
    if (!stage) return { result: false };
    if (action === 'ready' && stage === local.stage) return { result: true };
    if (action !== 'ready') {
      const active = local.deliveryClaim;
      if (!claim || active?.ownerInstanceId !== deliveryOwnerId || active.leaseToken !== claim.leaseToken
        || active.leaseExpiresAt <= Date.now()) return { result: false };
    }
    return { result: true, next: { ...local, stage, updatedAt: Date.now() } };
  });
}

async function transitionServerExportStage(
  renderId: string,
  action: RecoveryTransitionAction,
  claim?: ServerExportDeliveryClaim,
): Promise<void> {
  if (projectStoreRemoteAvailable()) {
    const result = leaseResponse(await requestProjectStore({
      operation: 'export-recovery-lease',
      key: `${REMOTE_PREFIX}${renderId}`,
      renderId,
      action,
      ownerInstanceId: deliveryOwnerId,
      ...(claim ? { leaseToken: claim.leaseToken } : {}),
    }));
    if (!result.accepted) throw new Error('导出恢复阶段已变更');
    if (await readLocalRecord(renderId) && validRecord(result.value)) {
      await cacheRemoteRecord(result.value);
    }
    return;
  }
  if (!await updateLocalStage(renderId, action, claim)) throw new Error('无法持久化导出恢复阶段');
}

export const markServerExportOutputReady = (
  renderId: string,
  claim?: ServerExportDeliveryClaim,
) => transitionServerExportStage(renderId, 'ready', claim);

export const markServerExportDeliveryAmbiguous = (
  renderId: string,
  claim: ServerExportDeliveryClaim,
) => transitionServerExportStage(renderId, 'ambiguous', claim);

export const markServerExportTargetCommitted = (
  renderId: string,
  claim: ServerExportDeliveryClaim,
) => transitionServerExportStage(renderId, 'commit', claim);


function leaseResponse(value: unknown): {
  accepted: boolean;
  lease?: ServerExportDeliveryClaim;
  value?: unknown;
} {
  return value as { accepted: boolean; lease?: ServerExportDeliveryClaim; value?: unknown };
}

async function localDeliveryLease(
  renderId: string,
  action: 'claim' | 'renew' | 'release' | 'check',
  claim?: ServerExportDeliveryClaim,
): Promise<ServerExportDeliveryClaim | null> {
  return mutateLocalRecord<ServerExportDeliveryClaim | null>(renderId, (record) => {
    if (!record) return { result: null };
    const recoverable = record.stage !== 'target-committed';
    if (action !== 'release' && !recoverable) return { result: null };
    const current = record.deliveryClaim;
    const now = Date.now();
    const exact = current?.ownerInstanceId === deliveryOwnerId
      && !!claim && current.leaseToken === claim.leaseToken;
    if (action === 'check') return { result: exact && current!.leaseExpiresAt > now ? current! : null };
    if (action === 'renew') {
      if (!exact || current!.leaseExpiresAt <= now) return { result: null };
      const renewed = { ...current!, leaseExpiresAt: now + DELIVERY_LEASE_MS };
      return { result: renewed, next: { ...record, deliveryClaim: renewed, updatedAt: now } };
    }
    if (action === 'release') {
      if (!exact) return { result: null };
      const { deliveryClaim: _deliveryClaim, ...released } = record;
      return { result: current!, next: { ...released, updatedAt: now } };
    }
    if (current && current.leaseExpiresAt > now && !exact) return { result: null };
    const acquired = {
      ownerInstanceId: deliveryOwnerId,
      leaseToken: globalThis.crypto?.randomUUID?.() ?? `delivery-${now}-${Math.random().toString(36).slice(2)}`,
      leaseExpiresAt: now + DELIVERY_LEASE_MS,
    };
    return { result: acquired, next: { ...record, deliveryClaim: acquired, updatedAt: now } };
  });
}

async function updateRemoteDeliveryLease(
  renderId: string,
  action: 'claim' | 'renew' | 'release' | 'check',
  claim?: ServerExportDeliveryClaim,
): Promise<ServerExportDeliveryClaim | null> {
  const response = leaseResponse(await requestProjectStore({
    operation: 'export-recovery-lease',
    key: `${REMOTE_PREFIX}${renderId}`,
    renderId,
    action,
    ownerInstanceId: deliveryOwnerId,
    ...(claim ? { leaseToken: claim.leaseToken } : {}),
    ...(action === 'claim' || action === 'renew' ? { leaseMs: DELIVERY_LEASE_MS } : {}),
  }));
  return response.accepted && response.lease ? response.lease : null;
}

export async function claimServerExportDelivery(
  renderId: string,
): Promise<ServerExportDeliveryClaim | null> {
  return projectStoreRemoteAvailable()
    ? updateRemoteDeliveryLease(renderId, 'claim')
    : localDeliveryLease(renderId, 'claim');
}

export async function renewServerExportDelivery(
  renderId: string,
  claim: ServerExportDeliveryClaim,
): Promise<ServerExportDeliveryClaim | null> {
  return projectStoreRemoteAvailable()
    ? updateRemoteDeliveryLease(renderId, 'renew', claim)
    : localDeliveryLease(renderId, 'renew', claim);
}

export async function checkServerExportDelivery(
  renderId: string,
  claim: ServerExportDeliveryClaim,
): Promise<boolean> {
  const active = projectStoreRemoteAvailable()
    ? await updateRemoteDeliveryLease(renderId, 'check', claim)
    : await localDeliveryLease(renderId, 'check', claim);
  return active !== null;
}

export async function releaseServerExportDelivery(
  renderId: string,
  claim: ServerExportDeliveryClaim,
): Promise<void> {
  if (projectStoreRemoteAvailable()) {
    await updateRemoteDeliveryLease(renderId, 'release', claim);
  } else {
    await localDeliveryLease(renderId, 'release', claim);
  }
}

async function recoveryRecordById(renderId: string): Promise<PersistedServerExportJob | null> {
  if (projectStoreRemoteAvailable()) {
    const response = await requestProjectStore({ operation: 'entry', key: `${REMOTE_PREFIX}${renderId}` });
    const row = response as { found: boolean; value?: unknown };
    if (!row.found || !validRecord(row.value)) return null;
    return joinRemoteRecord(row.value, await readLocalRecord(renderId));
  }
  return readLocalRecord(renderId);
}

export async function rebindServerExportJob(
  renderId: string,
  destination: ExportDestination,
  targetPath: string,
  claim: ServerExportDeliveryClaim,
): Promise<PersistedServerExportJob> {
  if (!await checkServerExportDelivery(renderId, claim)) throw new Error('导出恢复目标绑定已失效');
  const current = await recoveryRecordById(renderId);
  if (!current || (current.stage !== 'polling' && current.stage !== 'output-ready'
    && current.stage !== 'delivery-ambiguous')) {
    throw new Error('保留的导出结果已不可恢复');
  }
  const next: PersistedServerExportJob = {
    ...current,
    destination,
    targetPath,
    stage: current.stage === 'delivery-ambiguous' ? 'output-ready' : current.stage,
    deliveryClaim: claim,
    updatedAt: Date.now(),
  };
  if (projectStoreRemoteAvailable()) {
    const localBefore = await readLocalRecord(renderId);
    const result = leaseResponse(await requestProjectStore({
      operation: 'export-recovery-lease',
      key: `${REMOTE_PREFIX}${renderId}`,
      renderId,
      action: 'rebind',
      ownerInstanceId: deliveryOwnerId,
      leaseToken: claim.leaseToken,
      value: remoteSafeRecord(next),
    }));
    if (!result.accepted || !validRecord(result.value)) {
      throw new Error('导出恢复目标绑定已失效');
    }
    const canonical = joinRemoteRecord(result.value, next);
    if (browserDestination(destination) || await readLocalRecord(renderId)) {
      const saved = await mutateLocalRecord(renderId, (live) => {
        const lease = canonical.deliveryClaim, active = live?.deliveryClaim;
        if (!lease || lease.ownerInstanceId !== claim.ownerInstanceId || lease.leaseToken !== claim.leaseToken
          || lease.leaseExpiresAt <= Date.now()
          || (active && active.leaseExpiresAt > Date.now()
            && (active.ownerInstanceId !== lease.ownerInstanceId || active.leaseToken !== lease.leaseToken))
          || live?.stage === 'target-committed'
          || (live && !(localBefore && sameDestinationBinding(live, localBefore)) && !sameDestinationBinding(live, canonical))) return { result: false };
        return { result: true, next: canonical };
      });
      if (!saved) throw new Error('导出恢复目标绑定已失效');
    }
    if (!await checkServerExportDelivery(renderId, claim)) throw new Error('导出恢复目标绑定已失效');
    return canonical;
  }
  const rebound = await mutateLocalRecord<PersistedServerExportJob | null>(renderId, (live) => {
    const stage = live && exportRecoveryNextStage(live.stage, 'rebind');
    const active = live?.deliveryClaim;
    if (!live || !stage || active?.ownerInstanceId !== deliveryOwnerId || active.leaseToken !== claim.leaseToken
      || active.leaseExpiresAt <= Date.now()) return { result: null };
    const next = { ...live, destination, targetPath, stage, updatedAt: Date.now() };
    return { result: next, next };
  });
  if (!rebound) throw new Error('导出恢复目标绑定已失效');
  return rebound;
}

export async function retireServerExportJob(renderId: string): Promise<boolean> {
  if (!projectStoreRemoteAvailable()) {
    return mutateLocalRecord(renderId, (local) => {
      if (local?.deliveryClaim && local.deliveryClaim.leaseExpiresAt > Date.now()) return { result: false };
      return { result: true, next: null };
    });
  }
  const result = leaseResponse(await requestProjectStore({
    operation: 'export-recovery-lease',
    key: `${REMOTE_PREFIX}${renderId}`,
    renderId,
    action: 'retire',
    ownerInstanceId: deliveryOwnerId,
  }));
  if (!result.accepted) return false;
  await removeLocalRecord(renderId);
  return true;
}

interface RemoteRecoverySnapshot {
  active: Map<string, PersistedServerExportJob>;
  known: Set<string>;
  reachable: boolean;
}

function legacyDeletePending(record: PersistedServerExportJob): boolean {
  return (record as PersistedServerExportJob & { pendingRemoteDelete?: true }).pendingRemoteDelete === true;
}

async function readRemoteRecoverySnapshot(): Promise<RemoteRecoverySnapshot> {
  if (!projectStoreRemoteAvailable()) return { active: new Map(), known: new Set(), reachable: false };
  try {
    const response = await requestProjectStore({ operation: 'snapshot' });
    const snapshot = response as { version: 1; entries: Record<string, unknown> };
    const active = new Map<string, PersistedServerExportJob>();
    const known = new Set<string>();
    for (const [key, value] of Object.entries(snapshot.entries)) {
      if (!key.startsWith(REMOTE_PREFIX)) continue;
      const renderId = key.slice(REMOTE_PREFIX.length);
      known.add(renderId);
      if (validRecord(value)) active.set(renderId, value);
    }
    return { active, known, reachable: true };
  } catch {
    return { active: new Map(), known: new Set(), reachable: false };
  }
}

async function joinedRemoteRecords(
  snapshot: RemoteRecoverySnapshot,
  localByRenderId: Map<string, PersistedServerExportJob>,
): Promise<PersistedServerExportJob[]> {
  const records: PersistedServerExportJob[] = [];
  for (const [renderId, remote] of snapshot.active) {
    const local = localByRenderId.get(renderId);
    if (local && legacyDeletePending(local)) {
      if (projectStoreWriteCredential()) await retireServerExportJob(renderId).catch(() => false);
      continue;
    }
    const joined = local ? await cacheRemoteRecord(remote).catch(() => joinRemoteRecord(remote)) : joinRemoteRecord(remote);
    records.push(joined);
  }
  return records;
}

async function reconciledLocalRecords(
  snapshot: RemoteRecoverySnapshot,
  localRecords: PersistedServerExportJob[],
): Promise<PersistedServerExportJob[]> {
  const records: PersistedServerExportJob[] = [];
  for (const local of localRecords) {
    if (snapshot.active.has(local.renderId)) continue;
    if (snapshot.known.has(local.renderId)) {
      await removeLocalRecord(local.renderId).catch(() => undefined);
      continue;
    }
    if (!snapshot.reachable) {
      records.push(local);
      continue;
    }
    if (legacyDeletePending(local) || (!projectStoreWriteCredential() && local.remoteAuthorityEstablished)) {
      await removeLocalRecord(local.renderId).catch(() => undefined);
      continue;
    }
    if (!projectStoreWriteCredential()) {
      records.push(local);
      continue;
    }
    try {
      const canonical = await reconcileRemoteRecord(local);
      if (!canonical) {
        await removeLocalRecord(local.renderId);
        continue;
      }
      const joined = await cacheRemoteRecord(canonical);
      records.push(joined);
    } catch {
      records.push(remoteSafeRecord(local));
    }
  }
  return records;
}

export async function listServerExportJobs(projectId: string): Promise<PersistedServerExportJob[]> {
  const snapshot = await readRemoteRecoverySnapshot();
  const localRecords = await readLocalRecords();
  const localByRenderId = new Map(localRecords.map((record) => [record.renderId, record]));
  const records = [
    ...await joinedRemoteRecords(snapshot, localByRenderId),
    ...await reconciledLocalRecords(snapshot, localRecords),
  ];
  return records
    .filter((record) => record.projectId === projectId)
    .sort((left, right) => left.createdAt - right.createdAt);
}
