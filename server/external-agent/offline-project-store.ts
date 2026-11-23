import { assertDeliveryPicturePreservation } from '../../src/clipmentor/delivery-bindings';
import { randomUUID } from 'node:crypto';
import {
  getStoredEntry,
  withSerializedProjectStore,
  type StoredEntryValue,
} from '../plugins/project-store.ts';
import { commitProjectEditRows } from '../plugins/project-store-edit-journal.ts';
import { runProjectMigrations } from '../../src/persist/migrations/index.ts';
import {
  revisionOf,
  type ExternalDraftCheckpoint,
} from '../../src/agent/external-edit-session.ts';
import type { Operation } from '../../src/agent/proposal.ts';
import type { ProjectDoc } from '../../src/editor/types.ts';
import {
  projectEditOwnershipKey,
  projectEditOwnershipMatches,
  renewedProjectEditOwnership,
  type ProjectEditOwnershipClaim,
} from './project-edit-ownership.ts';

const VALID_PROJECT_ID = /^[a-zA-Z0-9_-]{1,160}$/;
const MAX_AUTOMATIC_VERSIONS = 30;
const MAX_METADATA_RETRIES = 4;
const CHECKPOINT_PREFIX = 'offline-edit-session:';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedOperation(value: unknown): Operation | null {
  if (!isRecord(value) || typeof value.tool !== 'string' || !isRecord(value.args)
    || typeof value.action !== 'string' || typeof value.target !== 'string'
    || typeof value.impact !== 'string' || !Array.isArray(value.actions)) return null;
  const actions = value.actions.filter((action) => isRecord(action) && typeof action.type === 'string');
  if (actions.length !== value.actions.length) return null;
  return {
    tool: value.tool,
    args: value.args,
    actions: actions as Operation['actions'],
    action: value.action,
    target: value.target,
    impact: value.impact,
    ...(typeof value.callCount === 'number' ? { callCount: value.callCount } : {}),
    ...(typeof value.rationale === 'string' ? { rationale: value.rationale } : {}),
  };
}

function normalizedCheckpoint(
  value: unknown,
  expectedRevision: string,
): ExternalDraftCheckpoint | null {
  if (!isRecord(value) || value.version !== 1 || value.baseRevision !== expectedRevision
    || typeof value.sessionId !== 'string' || typeof value.clientName !== 'string'
    || (value.approvalMode !== 'auto' && value.approvalMode !== 'manual')
    || typeof value.createdAt !== 'number' || typeof value.updatedAt !== 'number'
    || !Array.isArray(value.operations)) return null;
  const draftDoc = normalizedProject(value.draftDoc);
  const operations = value.operations.map(normalizedOperation);
  if (!draftDoc || operations.some((operation) => operation === null)) return null;
  return {
    version: 1,
    sessionId: value.sessionId,
    clientName: value.clientName,
    approvalMode: value.approvalMode,
    baseRevision: expectedRevision,
    draftDoc,
    operations: operations as Operation[],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export interface OfflineStoredProject {
  projectId: string;
  doc: ProjectDoc;
  revision: string;
}

export type OfflineProjectCommitStatus =
  | 'applied'
  | 'stale'
  | 'browser-takeover'
  | 'metadata-conflict';

export interface OfflineProjectCommitResult {
  status: OfflineProjectCommitStatus;
  revision?: string;
  automaticVersionCreated?: boolean;
  ownership?: ProjectEditOwnershipClaim;
}

export interface OfflineProjectCommitInput {
  projectId: string;
  expectedRevision: string;
  checkpointSessionId?: string;
  doc: ProjectDoc;
  ownership: ProjectEditOwnershipClaim;
  canCommit: () => boolean;
  /** Publish staged local files under the same lock as the references to them. */
  publishMedia?: () => Promise<void>;
}

interface CommitMetadata {
  projects: StoredEntryValue;
  versions: StoredEntryValue;
}

interface CommitAttemptInput extends OfflineProjectCommitInput {
  metadata: CommitMetadata;
  normalizedDoc: ProjectDoc;
}

function normalizedProject(value: unknown): ProjectDoc | null {
  return runProjectMigrations(value)?.doc ?? null;
}

function entryToken(entry: StoredEntryValue): string {
  return JSON.stringify([entry.found, entry.value]);
}

function automaticVersionEntries(value: unknown, before: ProjectDoc, now: number): {
  entries: unknown[];
  created: boolean;
} {
  const current = Array.isArray(value) ? value : [];
  let latest: unknown = null;
  let latestAt = -1;
  for (const entry of current) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const createdAt = 'createdAt' in entry && typeof entry.createdAt === 'number'
      ? entry.createdAt
      : -1;
    if (createdAt > latestAt) {
      latest = entry;
      latestAt = createdAt;
    }
  }
  const latestDoc = latest && typeof latest === 'object' && 'doc' in latest
    ? normalizedProject(latest.doc)
    : null;
  if (latestDoc && JSON.stringify(latestDoc) === JSON.stringify(before)) {
    return { entries: current, created: false };
  }
  const added = [{
    id: randomUUID(),
    name: '离线编辑前自动版本',
    createdAt: now,
    automatic: true,
    doc: before,
  }, ...current];
  let automaticCount = 0;
  return {
    entries: added.filter((entry) => {
      const automatic = entry !== null
        && typeof entry === 'object'
        && !Array.isArray(entry)
        && 'automatic' in entry
        && entry.automatic === true;
      if (!automatic) return true;
      automaticCount += 1;
      return automaticCount <= MAX_AUTOMATIC_VERSIONS;
    }),
    created: true,
  };
}

function updatedProjectIndex(value: unknown, projectId: string, now: number): unknown[] {
  const current = Array.isArray(value) ? value : [];
  let found = false;
  const updated = current.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    if (!('id' in entry) || entry.id !== projectId) return entry;
    found = true;
    return { ...entry, updatedAt: now };
  });
  if (!found) updated.push({ id: projectId, name: projectId, updatedAt: now });
  return updated.sort((left, right) => {
    const time = (entry: unknown): number => {
      if (!entry || typeof entry !== 'object' || !('updatedAt' in entry)) return 0;
      return typeof entry.updatedAt === 'number' ? entry.updatedAt : 0;
    };
    return time(right) - time(left);
  });
}

async function readCommitMetadata(projectId: string): Promise<CommitMetadata> {
  const [projects, versions] = await Promise.all([
    getStoredEntry('projects'),
    getStoredEntry(`versions:${projectId}`),
  ]);
  return { projects, versions };
}

function metadataMatches(current: CommitMetadata, expected: CommitMetadata): boolean {
  return entryToken(current.projects) === entryToken(expected.projects)
    && entryToken(current.versions) === entryToken(expected.versions);
}

async function attemptCommit(input: CommitAttemptInput): Promise<OfflineProjectCommitResult> {
  const projectKey = `project:${input.projectId}`;
  const versionsKey = `versions:${input.projectId}`;
  const checkpointKey = `${CHECKPOINT_PREFIX}${input.projectId}`;
  return withSerializedProjectStore<OfflineProjectCommitResult>(async (store) => {
    const project = await store.readEntry(projectKey);
    const before = project.found ? normalizedProject(project.value) : null;
    if (!before || revisionOf(before) !== input.expectedRevision) return { status: 'stale' };
    const policy = await store.readEntry(`${HANDOFF_PREFIX}${input.projectId}`);
    await assertHandoffProjectWrite(policy.found ? policy.value : undefined, before, input.normalizedDoc);
    assertDeliveryPicturePreservation(before, input.normalizedDoc);
    const currentMetadata = {
      projects: await store.readEntry('projects'),
      versions: await store.readEntry(versionsKey),
    };
    if (!metadataMatches(currentMetadata, input.metadata)) return { status: 'metadata-conflict' };
    if (!input.canCommit()) return { status: 'browser-takeover' };
    const ownershipKey = projectEditOwnershipKey(input.projectId);
    const ownership = await store.readEntry(ownershipKey);
    if (!projectEditOwnershipMatches(ownership.value, input.ownership)) {
      return { status: 'browser-takeover' };
    }
    const now = Date.now();
    const nextRevision = revisionOf(input.normalizedDoc);
    const versions = automaticVersionEntries(currentMetadata.versions.value, before, now);
    const changes: Record<string, StoredEntryValue> = {
      [versionsKey]: { found: true, value: versions.entries },
      projects: { found: true, value: updatedProjectIndex(currentMetadata.projects.value, input.projectId, now) },
      [projectKey]: { found: true, value: input.normalizedDoc },
      [ownershipKey]: { found: true, value: renewedProjectEditOwnership(input.ownership, nextRevision, now) },
    };
    const originals = {
      [versionsKey]: currentMetadata.versions,
      projects: currentMetadata.projects,
      [projectKey]: project,
      [ownershipKey]: ownership,
    };
    if (input.checkpointSessionId) {
      const checkpoint = await store.readEntry(checkpointKey);
      if (checkpoint.found && isRecord(checkpoint.value)
        && checkpoint.value.sessionId === input.checkpointSessionId) {
        if (!normalizedCheckpoint(checkpoint.value, input.expectedRevision)) {
          throw new Error('offline edit checkpoint does not match the reviewed draft base');
        }
        changes[checkpointKey] = { found: false };
        originals[checkpointKey] = checkpoint;
      }
    }
    await input.publishMedia?.();
    if (!await commitProjectEditRows(store, changes, originals, input.canCommit)) {
      return { status: 'browser-takeover' };
    }
    const appliedOwnership = { ...input.ownership, baseRevision: nextRevision };
    return {
      status: 'applied',
      revision: nextRevision,
      automaticVersionCreated: versions.created,
      ownership: appliedOwnership,
    };
  });
}

export async function loadOfflineStoredProject(projectId: string): Promise<OfflineStoredProject | null> {
  if (!VALID_PROJECT_ID.test(projectId)) throw new Error('invalid project id');
  const entry = await getStoredEntry(`project:${projectId}`);
  const doc = entry.found ? normalizedProject(entry.value) : null;
  return doc ? { projectId, doc, revision: revisionOf(doc) } : null;
}
export type OfflineCheckpointSaveStatus = 'saved' | 'stale' | 'browser-takeover';
export interface OfflineCheckpointSaveInput {
  projectId: string;
  expectedRevision: string;
  checkpoint: ExternalDraftCheckpoint;
  ownership: ProjectEditOwnershipClaim;
  canSave: () => boolean;
}


export async function loadOfflineEditCheckpoint(
  projectId: string,
  expectedRevision: string,
): Promise<ExternalDraftCheckpoint | null> {
  if (!VALID_PROJECT_ID.test(projectId)) throw new Error('invalid project id');
  const entry = await getStoredEntry(`${CHECKPOINT_PREFIX}${projectId}`);
  if (!entry.found) return null;
  if (isRecord(entry.value) && typeof entry.value.version === 'number' && entry.value.version > 1) {
    throw new Error(`offline edit checkpoint version ${entry.value.version} is not supported`);
  }
  const checkpoint = normalizedCheckpoint(entry.value, expectedRevision);
  if (checkpoint) return checkpoint;
  if (isRecord(entry.value) && entry.value.version === 1
    && entry.value.baseRevision !== expectedRevision) return null;
  throw new Error('offline edit checkpoint is corrupt');
}

export async function saveOfflineEditCheckpoint(
  input: OfflineCheckpointSaveInput,
): Promise<OfflineCheckpointSaveStatus> {
  if (!VALID_PROJECT_ID.test(input.projectId)) throw new Error('invalid project id');
  const checkpoint = normalizedCheckpoint(input.checkpoint, input.expectedRevision);
  if (!checkpoint) throw new Error('invalid offline edit checkpoint');
  return withSerializedProjectStore(async (store) => {
    const project = await store.readEntry(`project:${input.projectId}`);
    const doc = project.found ? normalizedProject(project.value) : null;
    if (!doc || revisionOf(doc) !== input.expectedRevision) return 'stale';
    const ownershipKey = projectEditOwnershipKey(input.projectId);
    const ownership = await store.readEntry(ownershipKey);
    if (!projectEditOwnershipMatches(ownership.value, input.ownership)) return 'browser-takeover';
    if (!input.canSave()) return 'browser-takeover';
    const key = `${CHECKPOINT_PREFIX}${input.projectId}`;
    const previous = await store.readEntry(key);
    if (previous.found) {
      if (isRecord(previous.value)
        && typeof previous.value.version === 'number'
        && previous.value.version > 1) {
        throw new Error(`offline edit checkpoint version ${previous.value.version} is not supported`);
      }
      if (!isRecord(previous.value)
        || previous.value.version !== 1
        || typeof previous.value.baseRevision !== 'string'
        || !normalizedCheckpoint(previous.value, previous.value.baseRevision)) {
        throw new Error('offline edit checkpoint is corrupt');
      }
    }
    const saved = await commitProjectEditRows(store, {
      [key]: { found: true, value: checkpoint },
      [ownershipKey]: { found: true, value: renewedProjectEditOwnership(input.ownership, input.expectedRevision) },
    }, { [key]: previous, [ownershipKey]: ownership }, input.canSave);
    return saved ? 'saved' : 'browser-takeover';
  });
}

export async function deleteOfflineEditCheckpoint(
  projectId: string,
  sessionId: string,
  ownership: ProjectEditOwnershipClaim,
): Promise<boolean> {
  if (!VALID_PROJECT_ID.test(projectId)) throw new Error('invalid project id');
  return withSerializedProjectStore(async (store) => {
    const owned = await store.readEntry(projectEditOwnershipKey(projectId));
    if (ownership.projectId !== projectId || !projectEditOwnershipMatches(owned.value, ownership)
      || !isRecord(owned.value) || owned.value.baseRevision !== ownership.baseRevision) return false;
    const key = `${CHECKPOINT_PREFIX}${projectId}`;
    const current = await store.readEntry(key);
    if (!current.found) return true;
    if (!isRecord(current.value)
      || typeof current.value.version !== 'number'
      || current.value.version !== 1
      || typeof current.value.baseRevision !== 'string'
      || !normalizedCheckpoint(current.value, current.value.baseRevision)) {
      throw new Error('offline edit checkpoint is corrupt or unsupported');
    }
    // An empty draft on another revision has no checkpoint of its own to clear.
    // Keep the older draft available if its base is restored later.
    if (current.value.baseRevision !== ownership.baseRevision) return current.value.sessionId !== sessionId;
    if (current.value.sessionId !== sessionId) return false;
    await store.removeEntry(key);
    return true;
  });
}

export async function commitOfflineStoredProject(
  input: OfflineProjectCommitInput,
): Promise<OfflineProjectCommitResult> {
  if (!VALID_PROJECT_ID.test(input.projectId)) throw new Error('invalid project id');
  const normalizedDoc = normalizedProject(input.doc);
  if (!normalizedDoc) throw new Error('invalid edited project document');
  for (let attempt = 0; attempt < MAX_METADATA_RETRIES; attempt += 1) {
    const metadata = await readCommitMetadata(input.projectId);
    const result = await attemptCommit({ ...input, normalizedDoc, metadata });
    if (result.status !== 'metadata-conflict') return result;
  }
  return { status: 'metadata-conflict' };
}
import { HANDOFF_PREFIX } from '../../shared/clipmentor-handoff';
import { assertHandoffProjectWrite } from '../../shared/clipmentor-handoff-write';
