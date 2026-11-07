// Exercise browser execution, durable local outcome, server settlement and
// model-visible ledger with in-memory storage and fake HTTP only.
import assert from 'node:assert/strict';
import { makeDraft } from '../../editor/store';
import { docFromTimeline } from '../../persist/projectStore';
import { ServerRunToolExecutor } from '../serverRunToolExecutor';
import { FakeLockManager, MemoryStorage } from '../serverRunToolExecutor.verify-helpers';
import { saveStoredServerRun } from '../serverRunSessionStorage';
import { ToolActivation } from '../tool-activation';
import { TOOL_SCHEMAS } from '../tools';
import { claimToolRequest, settleToolResult, waitForToolResult } from '../../../server/agent-runs/store-tools';
import type { ServerRun } from '../../../server/agent-runs/store-types';

const doc = docFromTimeline({ fps: 30, width: 576, height: 1024, selectedId: null, items: [] });
const draft = makeDraft(doc);
const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalFetch = globalThis.fetch;
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
let checked = 0;
try {
  for (const mode of ['pass', 'warning', 'qa-rejected', 'malformed', 'transport-failed']) {
    const runId = 'synthetic-qa-' + mode, projectId = 'synthetic-qa-project', toolCallId = 'call-' + mode;
    const actions: Array<{ error?: string; result?: unknown }> = [];
    let posted: any;
    let qaCalls = 0;
    const hasIssue = mode === 'warning' || mode === 'qa-rejected';
    const report = { ok: mode !== 'qa-rejected', durationSeconds: 1, width: 576, height: 1024, fps: 30,
      hasVideo: true, hasAudio: false, blackFrames: [], frozenFrames: [], silence: [],
      issues: hasIssue ? [{ code: 'synthetic_issue', severity: mode === 'warning' ? 'warning' : 'error', message: 'synthetic control' }] : [],
      summary: { errors: mode === 'qa-rejected' ? 1 : 0, warnings: mode === 'warning' ? 1 : 0 } };
    globalThis.fetch = async (url, init) => {
      if (String(url).endsWith('/tool-claim')) return Response.json({ claimed: true, outcome: 'claimed' });
      if (String(url).endsWith('/tool-result')) { posted = JSON.parse(String(init?.body)); return Response.json({ ok: true, outcome: 'accepted' }); }
      if (url === '/api/export-qa') {
        qaCalls++;
        if (mode === 'transport-failed') throw new Error('synthetic connection failure');
        return Response.json({ report: mode === 'malformed' ? {} : report, evidence: { base64: 'ZmFrZS1qcGVn' } });
      }
      throw new Error('Unexpected fake request: ' + url);
    };
    assert(saveStoredServerRun(projectId, { projectId, runId, attempts: [] }));
    const executor = new ServerRunToolExecutor(projectId, {
      ctx: () => ({ ...draft, templates: [], audio: [], getCreativeMode: () => null }),
      settings: () => ({} as never), onToolAction: action => { actions.push(action); },
      updateMessages: () => undefined, setLiveTool: () => undefined, retryStream: () => undefined, abandonRecovery: () => undefined,
    }, new FakeLockManager());
    executor.start({ capability: 'fake', baseDoc: doc, activation: new ToolActivation(TOOL_SCHEMAS, []),
      runId, abort: new AbortController(), recovered: new Map() });
    await executor.handle(runId, toolCallId, 'verify_export', { src: '/media/uploads/synthetic.mp4' }, 'digest', () => true);
    const events: any[] = [];
    const dependencies = { isRunTerminal: () => false, mirrorTool: async () => undefined,
      pushRunEvent: (_run: ServerRun, _type: string, data: unknown) => { events.push(data); } };
    const run = { toolRequests: new Map() } as unknown as ServerRun;
    const result = waitForToolResult(dependencies, run, toolCallId, 'verify_export', 'digest');
    // Attach before settlement so a deliberate rejection cannot be unhandled.
    const settled = result.then(value => ({ value }), error => ({ error: String(error) }));
    assert.equal(claimToolRequest(dependencies, run, { toolCallId, argsDigest: 'digest', claimId: 'browser' }), 'claimed');
    assert.equal(settleToolResult(dependencies, run, { ...posted, toolCallId, argsDigest: 'digest', claimId: 'browser' }), 'accepted');
    const outcome = await settled;
    if (mode === 'malformed' || mode === 'transport-failed') {
      assert('error' in outcome); assert(posted.error); assert.equal(posted.result, undefined); assert(actions[0]?.error);
    } else {
      assert('value' in outcome);
      assert.equal(posted.error, undefined); assert.equal(posted.result.qa_passed, mode !== 'qa-rejected');
      assert.deepEqual(posted.result.report, report); assert.equal(posted.result.full_film_accepted, false);
      assert.deepEqual((actions[0]!.result as any).report, report);
      assert.deepEqual(events[0].result.report, report, 'server/model ledger retains the negative verdict and issues');
      assert.equal((outcome.value as any).__images[0].base64, 'ZmFrZS1qcGVn');
    }
    assert.deepEqual(draft.getDoc(), doc); assert.equal(qaCalls, 1, 'no automatic retry'); checked++;
  }
  console.log(`qa-readback-transport.verify: ${checked} end-to-end fake cases passed`);
} finally {
  globalThis.fetch = originalFetch;
  if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
}
