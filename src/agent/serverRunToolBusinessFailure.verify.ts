import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version.ts';
import { makeDraft } from '../editor/store.ts';
import type { ProjectDoc } from '../editor/types.ts';
import { ToolActivation } from './tool-activation.ts';
import { TOOL_SCHEMAS } from './tools.ts';
import { ServerRunToolExecutor } from './serverRunToolExecutor.ts';
import { FakeLockManager, MemoryStorage } from './serverRunToolExecutor.verify-helpers.ts';
import { saveStoredServerRun } from './serverRunSessionStorage.ts';

const projectId = 'project-business-failure';
const runId = 'run-business-failure';
const toolCallId = 'call-business-failure';
const argsDigest = 'digest-business-failure';
const doc: ProjectDoc = {
  version: CURRENT_PROJECT_VERSION,
  assets: [],
  mediaFolders: [],
  activeTimelineId: 'timeline-business-failure',
  timelines: [{
    id: 'timeline-business-failure',
    name: 'Business failure',
    order: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    items: [],
    selectedId: null,
  }],
};
const draft = makeDraft(doc);
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalFetch = globalThis.fetch;
Object.defineProperty(globalThis, 'localStorage', {
  value: new MemoryStorage(),
  configurable: true,
});

try {
  assert(saveStoredServerRun(projectId, { projectId, runId, attempts: [] }));
  const actions: Array<{ error?: string; result?: unknown }> = [];
  const executor = new ServerRunToolExecutor(projectId, {
    ctx: () => ({
      commands: draft.commands,
      getState: draft.getState,
      getDoc: draft.getDoc,
      getCreativeMode: () => null,
      templates: [],
      audio: [],
    }),
    settings: () => ({} as never),
    onToolAction: (action) => { actions.push(action); },
    updateMessages: () => undefined,
    setLiveTool: () => undefined,
    retryStream: () => undefined,
    abandonRecovery: () => undefined,
  }, new FakeLockManager());
  executor.start({
    capability: 'test-run-capability',
    baseDoc: doc,
    activation: new ToolActivation(TOOL_SCHEMAS, []),
    runId,
    abort: new AbortController(),
    recovered: new Map(),
  });
  let resultBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/tool-claim')) {
      return Response.json({ claimed: true, outcome: 'claimed' });
    }
    if (url.endsWith('/tool-result')) {
      resultBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ ok: true, outcome: 'accepted' });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  assert.equal(await executor.handle(
    runId,
    toolCallId,
    'add_audio',
    {},
    argsDigest,
    () => true,
  ), true);
  const posted = resultBody as unknown as Record<string, unknown>;
  assert.match(String(posted.error), /audioName/);
  assert.equal(posted.result, undefined,
    'browser settlement omits the success result field for business failures');
  assert.match(String(actions[0]?.error), /audioName/,
    'durable recovery stores the business failure on its error channel');
  assert.equal(actions[0]?.result, undefined);

  // A local tool may succeed before the proposal/checkpoint callback refuses
  // its actions. A later read must retain prior accepted edits, not that refusal.
  const rejectedRunId = 'run-callback-rejection';
  assert(saveStoredServerRun(projectId, { projectId, runId: rejectedRunId, attempts: [] }));
  let rejectedCallbacks = 0;
  const rejectingExecutor = new ServerRunToolExecutor(projectId, {
    ctx: () => ({
      commands: draft.commands,
      getState: draft.getState,
      getDoc: draft.getDoc,
      getCreativeMode: () => null,
      templates: [],
      audio: [],
    }),
    settings: () => ({} as never),
    onToolAction: (action) => {
      if (action.args.name !== 'Rejected candidate edit') return;
      assert(action.actions.some((item) => item.type === 'tl.rename'
        && item.name === 'Rejected candidate edit'), 'the tool mutated its local draft before callback rejection');
      rejectedCallbacks += 1;
      throw new Error('Save the copy candidate in a preparation-only step, without pending project edits.');
    },
    updateMessages: () => undefined,
    setLiveTool: () => undefined,
    retryStream: () => undefined,
    abandonRecovery: () => undefined,
  }, new FakeLockManager());
  rejectingExecutor.start({
    capability: 'test-rejection-capability',
    baseDoc: doc,
    activation: new ToolActivation(TOOL_SCHEMAS, []),
    runId: rejectedRunId,
    abort: new AbortController(),
    recovered: new Map(),
  });
  assert.equal(await rejectingExecutor.handle(rejectedRunId, 'accepted-edit', 'manage_timelines', {
    action: 'update', timelineId: doc.activeTimelineId, name: 'Accepted prior edit',
  }, 'accepted-digest', () => true), true);
  assert.equal(await rejectingExecutor.handle(rejectedRunId, 'rejected-edit', 'manage_timelines', {
    action: 'update', timelineId: doc.activeTimelineId, name: 'Rejected candidate edit',
  }, 'rejected-digest', () => true), true);
  assert.equal(rejectedCallbacks, 2, 'both durable callback attempts reached the refusal');
  assert.match(String((resultBody as unknown as Record<string, unknown>).error), /preparation-only/);
  assert.equal(await rejectingExecutor.handle(rejectedRunId, 'read-after-refusal', 'manage_timelines', {
    action: 'list',
  }, 'read-digest', () => true), true);
  const afterRefusal = (resultBody as unknown as { result: Array<{ name: string }> }).result;
  assert.equal(afterRefusal[0]?.name, 'Accepted prior edit',
    'reads after callback rejection must roll back only the refused local mutation');
  assert.equal(draft.getDoc().timelines[0]?.name, 'Business failure', 'executor drafts never mutate the live project');
} finally {
  globalThis.fetch = originalFetch;
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
  else Reflect.deleteProperty(globalThis, 'localStorage');
}

console.log('server run browser business-failure verification passed');
