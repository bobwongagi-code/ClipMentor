// Test-only desktop transport: real document/runtime handlers, no disk/network/model.
import { createProjectDocumentStoreOperation } from '../../server/plugins/project-store-project-document';
import { createAgentRuntimeStoreOperations } from '../../server/plugins/project-store-agent-runtime';
import { projectEditOwnershipKey, renewedProjectEditOwnership } from '../../server/external-agent/project-edit-ownership-codec';
import type { LockedProjectStore } from '../../server/plugins/project-store';
import type { ProjectStoreRequest } from '../../shared/project-store-transport';
import { revisionOf } from '../agent/external-edit-session';
import { installBrowserProjectOwnership } from './projectStoreTransport';
import { resetProjectStoreMemory } from './projectStore';

export function installCheckpointStoreFixture() {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const values = new Map<string, unknown>();
  const activeRuns = new Map<string, {projectId:string;status:string}>();
  const writes: Extract<ProjectStoreRequest,{operation:"project-document-write"}>[] = [];
  const put = async (key: string, value: unknown) => { values.set(key, structuredClone(value)); };
  const store: LockedProjectStore = {
    readEntry: async key => values.has(key) ? { found: true, value: values.get(key) } : { found: false },
    writeEntry: put, writeEntryExact: put, writeAgentRuntimeExact: put,
    removeEntry: async key => { values.delete(key); },
  };
  let tail = Promise.resolve();
  const lock = <T,>(work: (s: LockedProjectStore) => Promise<T>): Promise<T> => {
    const result = tail.then(() => work(store));
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  const write = createProjectDocumentStoreOperation(lock, runId => activeRuns.get(runId));
  const runtime = createAgentRuntimeStoreOperations(lock);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    openChatCutDesktop: { projectStore: async (r: ProjectStoreRequest) => {
      if (r.operation === 'project-document-write') {
        writes.push(structuredClone(r));
        const result = await write(r);
        if (result.accepted && r.expectedRevision === null) {
          const projectId = r.key.slice(8), baseRevision = revisionOf(r.value as Parameters<typeof revisionOf>[0]);
          const claim = { projectId, ownerKind: 'browser' as const, ownerId: 'checkpoint-fixture', epoch: 1, baseRevision };
          values.set(projectEditOwnershipKey(projectId), renewedProjectEditOwnership(claim, baseRevision));
          installBrowserProjectOwnership({ ...claim, registrationCapability: 'fixture' });
        }
        return result;
      }
      if (r.operation === 'agent-runtime-write') return runtime.writeAgentRuntime(r);
      if (r.operation === 'agent-run-lease') return runtime.updateStoredAgentRunLease(r);
      if (r.operation === 'entry') return store.readEntry(r.key);
      if (r.operation === 'set') { await put(r.key, r.value); return { found: true, value: r.value }; }
      if (r.operation === 'delete') { await store.removeEntry(r.key); return { found: false }; }
      if (r.operation === 'merge') {
        for (const [k, v] of Object.entries(r.entries)) if (!values.has(k)) await put(k, v);
      } else if (r.operation !== 'snapshot') throw new Error(`Unexpected fixture operation: ${r.operation}`);
      return { version: 1, entries: Object.fromEntries(values) };
    } },
  } });
  resetProjectStoreMemory();
  return {
    writes,
    activate: (runId: string, projectId: string) => { activeRuns.set(runId, {projectId,status:'running'}); },
    finish: (runId: string) => { const run=activeRuns.get(runId);if(run)run.status='failed'; },
    restore: () => {
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else Reflect.deleteProperty(globalThis, 'window');
      resetProjectStoreMemory();
    },
  };
}
