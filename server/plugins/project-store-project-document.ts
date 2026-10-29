import type {
  ProjectDocumentMutationResponse,
  ProjectStoreRequest,
} from '../../shared/project-store-transport.ts';
import { revisionOf } from '../../src/agent/external-edit-session.ts';
import type { ProjectDoc } from '../../src/editor/types.ts';
import { runProjectMigrations } from '../../src/persist/migrations/index.ts';
import {
  projectEditOwnershipKey,
  projectEditOwnershipMatches,
  renewedProjectEditOwnership,
  type ProjectEditOwnershipClaim,
} from '../external-agent/project-edit-ownership-codec.ts';
import type { LockedProjectStore, StoredEntryValue } from './project-store.ts';
import { HANDOFF_PREFIX } from '../../shared/clipmentor-handoff';
import { assertHandoffProjectWrite } from '../../shared/clipmentor-handoff-write';
import { getRun } from '../agent-runs/store';
import { assertDeliveryPicturePreservation } from '../../src/clipmentor/delivery-bindings';

type ProjectDocumentWriteRequest = Extract<
  ProjectStoreRequest,
  { operation: 'project-document-write' }
>;
type ProjectDocumentUpdateRequest = Extract<
  ProjectDocumentWriteRequest,
  { expectedRevision: string }
>;
type WithStoreLock = <T>(
  work: (store: LockedProjectStore) => Promise<T>,
) => Promise<T>;
type ReadAgentRun = (runId: string) => { projectId: string; status: string; abort?: AbortController } | undefined;

function activeAgentWrite(request: ProjectDocumentWriteRequest, projectId: string, readRun: ReadAgentRun): boolean {
  if (!request.agentRunId) return true;
  const run = readRun(request.agentRunId);
  return run?.projectId === projectId && run.status === 'running' && !run.abort?.signal.aborted;
}

const endedRun = (current: StoredEntryValue): ProjectDocumentMutationResponse => ({
  ...mutationResponse(current, false), error: { code: 'agent_run_not_active' },
});

const normalizedProject = (value: unknown): ProjectDoc | null =>
  runProjectMigrations(value)?.doc ?? null;

function mutationResponse(
  entry: StoredEntryValue,
  accepted: boolean,
  currentRevision?: string,
  ownershipEpoch?: number,
): ProjectDocumentMutationResponse {
  return {
    accepted,
    found: entry.found,
    ...(entry.found ? { value: entry.value } : {}),
    ...(currentRevision ? { currentRevision } : {}),
    ...(ownershipEpoch === undefined ? {} : { ownershipEpoch }),
  };
}

async function restoreEntry(
  store: LockedProjectStore,
  key: string,
  original: StoredEntryValue,
): Promise<void> {
  if (original.found) await store.writeEntryExact(key, original.value);
  else await store.removeEntry(key);
}

async function createProjectDocument(
  store: LockedProjectStore,
  request: ProjectDocumentWriteRequest,
  project: ProjectDoc,
  readRun: ReadAgentRun,
): Promise<ProjectDocumentMutationResponse> {
  const projectId = request.key.slice('project:'.length);
  const ownership = await store.readEntry(projectEditOwnershipKey(projectId));
  if (ownership.found) return mutationResponse({ found: false }, false);
  if (!activeAgentWrite(request, projectId, readRun)) return endedRun({ found: false });
  try {
    await store.writeEntryExact(request.key, project);
    if (!activeAgentWrite(request, projectId, readRun)) {
      await store.removeEntry(request.key);
      return endedRun({ found: false });
    }
  } catch (error) { await store.removeEntry(request.key); throw error; }
  return mutationResponse({ found: true, value: project }, true, revisionOf(project));
}

async function updateProjectDocument(
  store: LockedProjectStore,
  request: ProjectDocumentUpdateRequest,
  current: StoredEntryValue,
  project: ProjectDoc,
  projectId: string,
  readRun: ReadAgentRun,
): Promise<ProjectDocumentMutationResponse> {
  const ownershipKey = projectEditOwnershipKey(projectId);
  const ownership = await store.readEntry(ownershipKey);
  const claim: ProjectEditOwnershipClaim = {
    projectId,
    ownerKind: 'browser',
    ownerId: request.ownerId,
    epoch: request.ownershipEpoch,
    baseRevision: request.expectedRevision,
  };
  if (!projectEditOwnershipMatches(ownership.value, claim)) {
    return mutationResponse(current, false, request.expectedRevision);
  }
  const nextRevision = revisionOf(project);
  if (!activeAgentWrite(request, projectId, readRun)) return endedRun(current);
  try {
    await store.writeEntryExact(request.key, project);
    await store.writeEntryExact(
      ownershipKey,
      renewedProjectEditOwnership(claim, nextRevision),
    );
    // Keep readers behind the same store lock until a cancellation racing the
    // filesystem writes has either committed or restored BOTH original entries.
    if (!activeAgentWrite(request, projectId, readRun)) {
      await restoreEntry(store, request.key, current);
      await restoreEntry(store, ownershipKey, ownership);
      return endedRun(current);
    }
  } catch (error) {
    await restoreEntry(store, request.key, current);
    await restoreEntry(store, ownershipKey, ownership);
    throw error;
  }
  return mutationResponse(
    { found: true, value: project },
    true,
    nextRevision,
    claim.epoch,
  );
}

export function createProjectDocumentStoreOperation(withStoreLock: WithStoreLock, readRun: ReadAgentRun = getRun) {
  return async (request: ProjectDocumentWriteRequest): Promise<ProjectDocumentMutationResponse> => (
    withStoreLock(async (store) => {
      const current = await store.readEntry(request.key);
      const currentDoc = current.found ? normalizedProject(current.value) : null;
      if (current.found && !currentDoc) {
        throw new Error('stored project document is corrupt or unsupported');
      }
      // CAS removed: writes are serialized by the store lock (single local
      // instance); the revision still increments for audit/ordering but is
      // no longer compared against the request's expected revision, so a
      // concurrent save can no longer fail with a revision mismatch.
      const project = normalizedProject(request.value);
      if (!project) throw new Error('project document CAS value is invalid or unsupported');
      const projectId = request.key.slice('project:'.length);
      if (!activeAgentWrite(request, projectId, readRun)) return endedRun(current);
      if (request.agentRunId && currentDoc) assertDeliveryPicturePreservation(currentDoc, project);
      const policy = await store.readEntry(`${HANDOFF_PREFIX}${projectId}`);
      await assertHandoffProjectWrite(policy.found ? policy.value : undefined, currentDoc, project);
      return current.found
        ? updateProjectDocument(store, request as ProjectDocumentUpdateRequest, current, project, projectId, readRun)
        : createProjectDocument(store, request, project, readRun);
    })
  );
}
