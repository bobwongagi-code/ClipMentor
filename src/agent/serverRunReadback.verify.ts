// Zero provider calls: production startup, tool host, and bridge HTTP boundaries.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { makeDraft } from '../editor/store';
import type { ProjectDoc } from '../editor/types';
import { ToolActivation } from './tool-activation';
import { TOOL_SCHEMAS } from './tools';
import { ServerRunToolExecutor } from './serverRunToolExecutor';
import { FakeLockManager, MemoryStorage } from './serverRunToolExecutor.verify-helpers';
import { saveStoredServerRun, readStoredServerRun, beginStoredToolAttempt, captureStoredToolResult } from './serverRunSessionStorage';
import { admitServerRun } from './serverRunSend';
import { startRecoveredBrowserRun } from './serverRunRecoveryLifecycle';
import { registerEditorBridge } from './external-bridge-registration';
import { configureSharedKvBackend } from '../persist/sharedKv';
import { createMiniConnect } from '../../desktop/mini-connect';
import { externalAgentPlugin, type BridgeOperations } from '../../server/plugins/external-agent';
import { ExternalEditorCallError } from '../../server/external-agent/broker-types';

const doc = JSON.parse(await readFile(new URL('./tools/fixtures/barely-there-bookend-replacement-20261029.json', import.meta.url), 'utf8')).before as ProjectDoc;
const originalFetch = globalThis.fetch;
const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
configureSharedKvBackend({ get: async () => undefined, set: async () => {}, delete: async () => {}, keys: async () => [], writeAgentRuntime: async () => { throw Error('no writes'); }, updateAgentRunLease: async () => { throw Error('no writes'); } });
const failures: string[] = [];
async function check(name: string, work: () => Promise<void>) {
  if (process.env.READBACK_CASE && process.env.READBACK_CASE !== name) return;
  try { await work(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${(error as Error).message}`); }
}

try {
  for (const recovered of [false, true]) {
    await check(recovered ? 'recovery-host-before-model' : 'startup-host-before-model', async () => {
      const id = `startup-${recovered}`; const runId = 'run-startup';
      saveStoredServerRun(id, { projectId: id, runId, attempts: [], admissionPending: true });
      const ready = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>(); const order: string[] = [];
      globalThis.fetch = async (url) => { assert(String(url).endsWith('/start')); order.push('model-start'); return Response.json({ ok: true }); };
      const options = { onRunPrepare: async () => { order.push('prepare'); }, onRunStart: async () => { entered.resolve(); await ready.promise; order.push('host-ready'); } };
      const executor = { start: () => { order.push('executor-ready'); }, reconcileStoredAttempts: async () => {} };
      const abort = new AbortController();
      const pending = recovered
        ? startRecoveredBrowserRun({ projectId: id, stored: { projectId: id, runId, admissionPending: true, text: 'read', content: 'read' }, state: { refs: { context: { current: { getDoc: () => doc } }, options: { current: options }, abort: { current: abort } }, toolExecutor: executor } } as never, { capability: 'c', activation: new ToolActivation([], []) } as never)
        : admitServerRun({ projectId: id, toolExecutor: executor, subscribe: () => { order.push('subscribed'); } } as never, { payload: { projectId: id, runId, capability: 'c', tools: [], messages: [] }, abort, options, text: 'read', trimmed: 'read', content: 'read', baseDoc: doc } as never);
      await entered.promise;
      const startedTooSoon = order.includes('model-start');
      ready.resolve(); await pending;
      assert.equal(startedTooSoon, false, 'model cannot request read_project while host initialization is still pending');
      assert(order.indexOf('executor-ready') < order.indexOf('model-start'), 'executor must exist before a model can emit tools');
      assert.equal(order.filter(x => x === 'model-start').length, 1);
    });
  }
  await check('host-init-failure-no-model', async () => {
    saveStoredServerRun('failure', { projectId: 'failure', runId: 'r', attempts: [] });
    let starts = 0;
    globalThis.fetch = async () => { starts++; return Response.json({ ok: true }); };
    await assert.rejects(admitServerRun({ projectId: 'failure' } as never, { payload: { runId: 'r', capability: 'c' }, abort: new AbortController(), options: { onRunStart: async () => { throw Error('host unavailable'); } } } as never), /host unavailable/);
    assert.equal(starts, 0, 'a failed host must not start a paid model');
  });
  for (const recovered of [false, true]) {
    await check(recovered ? 'recovery-cancel-before-ready' : 'startup-cancel-before-ready', async () => {
      const id = `cancel-${recovered}`, runId = 'cancel-before-ready';
      saveStoredServerRun(id, { projectId: id, runId, attempts: [], admissionPending: true });
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      const abortRef = { current: new AbortController() }; let starts = 0, activated = 0;
      globalThis.fetch = async () => { starts++; return Response.json({ ok: true }); };
      const options = { onRunStart: async () => { entered.resolve(); await release.promise; } };
      const executor = { start: () => { activated++; }, reconcileStoredAttempts: async () => {} };
      const pending = recovered
        ? startRecoveredBrowserRun({ projectId: id, stored: { projectId: id, runId, admissionPending: true, text: 'read', content: 'read' }, state: { refs: { context: { current: { getDoc: () => doc } }, options: { current: options }, abort: abortRef }, toolExecutor: executor } } as never, { capability: 'c', activation: new ToolActivation([], []) } as never)
        : admitServerRun({ projectId: id, toolExecutor: executor, subscribe: () => {} } as never, { payload: { runId, capability: 'c' }, abort: abortRef.current, options } as never);
      const rejected = assert.rejects(pending, /cancelled/);
      await entered.promise; abortRef.current.abort(Error('cancelled')); release.resolve(); await rejected;
      assert.equal(starts, 0); assert.equal(activated, 0, 'late initialization cannot activate tools after cancellation');
    });
  }
  await check('running-recovery-never-restarts-model', async () => {
    let starts = 0, activated = 0;
    globalThis.fetch = async () => { starts++; throw Error('must not restart'); };
    await startRecoveredBrowserRun({ projectId: 'running', stored: { projectId: 'running', runId: 'running', admissionPending: false, text: 'read', content: 'read' }, state: { refs: { context: { current: { getDoc: () => doc } }, options: { current: {} }, abort: { current: null } }, toolExecutor: { start: () => { activated++; }, reconcileStoredAttempts: async () => {} } } } as never, { capability: 'c', activation: new ToolActivation([], []) } as never);
    assert.equal(starts, 0); assert.equal(activated, 1);
  });
  for (const kind of ['normal', 'claim400', 'claim503', 'foreign-claim', 'no-lock', 'broken-lock'] as const) {
    await check(`tool-${kind}`, async () => {
      const id = `readback-${kind}`, runId = `run-${kind}`; const draft = makeDraft(doc);
      saveStoredServerRun(id, { projectId: id, runId, attempts: [] });
      const abandoned: string[] = [], retries: string[] = [], results: unknown[] = []; let actions = 0, executed = 0;
      globalThis.fetch = async (input, init) => {
        if (String(input).endsWith('/tool-claim')) {
          if (kind === 'claim400') return Response.json({ error: 'toolCallId is invalid' }, { status: 400 });
          if (kind === 'claim503') return Response.json({ error: 'temporarily unavailable' }, { status: 503 });
          if (kind === 'foreign-claim') return Response.json({ claimed: false, outcome: 'already-claimed' }, { status: 409 });
          return Response.json({ claimed: true, outcome: 'claimed' });
        }
        assert(String(input).endsWith('/tool-result')); results.push(JSON.parse(String(init?.body))); return Response.json({ ok: true });
      };
      const locks = kind === 'no-lock' ? null : kind === 'broken-lock' ? { request: async () => { throw Error('lock unavailable'); } } : new FakeLockManager();
      const executor = new ServerRunToolExecutor(id, { ctx: () => ({ commands: draft.commands, getDoc: draft.getDoc, getState: draft.getState, getCreativeMode: () => null, templates: [], audio: [] }), settings: () => ({} as never), onToolAction: action => { executed++; actions += action.actions.length; }, updateMessages: () => {}, setLiveTool: () => {}, retryStream: r => { retries.push(r); }, abandonRecovery: (_r, e) => { abandoned.push(String(e)); } }, locks);
      executor.start({ capability: 'test', baseDoc: doc, activation: new ToolActivation(TOOL_SCHEMAS, []), runId, abort: new AbortController(), recovered: new Map() });
      const handled = await executor.handle(runId, 'call-read', 'read_project', {}, 'd', () => true);
      if (kind === 'normal') {
        assert.equal(handled, true); assert.equal((results[0] as {result:{timeline:{items:unknown[]}}}).result.timeline.items.length, doc.timelines[0].items.length); assert.equal(executed, 1); assert.equal(actions, 0); assert.deepEqual(abandoned, []); assert.deepEqual(draft.getDoc(), doc);
      } else if (kind === 'claim503' || kind === 'foreign-claim') {
        assert.equal(handled, false); assert.equal(executed, 0); assert.equal(results.length, 0); assert.deepEqual(abandoned, []);
        assert.equal(retries.length, kind === 'claim503' ? 1 : 0, 'temporary transport recovery and another owner must not be classified as permanent failure');
      } else {
        assert.equal(handled, false); assert.equal(abandoned.length, 1, 'permanent host/claim failure must settle instead of leaving read_project pending'); assert.equal(executed, 0); assert.equal(results.length, 0); assert.deepEqual(retries, []);
        assert.match(abandoned[0], kind === 'claim400' ? /400.*toolCallId is invalid/ : /lock/i);
      }
      executor.stop();
    });
  }
  for (const kind of ['mismatch', 'unknown-call', 'malformed', 'contradictory'] as const) {
    await check(`claim-protocol-${kind}`, async () => {
      const id = `protocol-${kind}`, runId = id;
      saveStoredServerRun(id, { projectId: id, runId, attempts: [] });
      const abandoned: string[] = []; let executed = 0, retries = 0;
      const abort = new AbortController();
      globalThis.fetch = async () => kind === 'malformed'
        ? Response.json({})
        : Response.json({ claimed: kind === 'contradictory', outcome: kind === 'contradictory' ? 'mismatch' : kind }, { status: 409 });
      const executor = new ServerRunToolExecutor(id, {
        ctx: () => ({} as never), settings: () => ({} as never),
        onToolAction: () => { executed++; }, updateMessages: () => {}, setLiveTool: () => {},
        retryStream: () => { retries++; }, abandonRecovery: (_r, e) => { abandoned.push(String(e)); },
      }, new FakeLockManager());
      executor.start({ capability: 'test', baseDoc: doc, activation: new ToolActivation(TOOL_SCHEMAS, []), runId, abort, recovered: new Map() });
      assert.equal(await executor.handle(runId, 'c', 'read_project', {}, 'd', () => true), false);
      assert.equal(abandoned.length, 1, 'invalid claim must produce a specific terminal diagnostic');
      assert.equal(abort.signal.aborted, true); assert.equal(executed, 0); assert.equal(retries, 0);
      assert.match(abandoned[0], /claim/i);
      executor.stop();
    });
  }
  for (const kind of ['result400', 'result409', 'result503', 'settled', 'mismatch', 'no-lock', 'broken-lock'] as const) {
    for (const recovering of [false, true]) {
      if (!recovering && (kind === 'settled' || kind === 'mismatch' || kind === 'no-lock' || kind === 'broken-lock')) continue;
      await check(`${recovering ? 'recovered' : 'live'}-receipt-${kind}`, async () => {
        const id = `${recovering}-${kind}`, runId = id, call = 'receipt';
        const draft = makeDraft(doc), abort = new AbortController();
        saveStoredServerRun(id, { projectId: id, runId, attempts: [] });
        if (recovering) {
          assert(beginStoredToolAttempt(id, call, 'd'));
          assert(captureStoredToolResult(id, call, { name: 'read_project', argsDigest: 'd', result: { saved: true } }));
        }
        const abandoned: string[] = []; let posted = 0, executed = 0, claimed = 0;
        globalThis.fetch = async url => {
          if (String(url).endsWith('/tool-claim')) {
            claimed++;
            return kind === 'settled' || kind === 'mismatch'
              ? Response.json({ claimed: false, outcome: kind === 'settled' ? 'run-settled' : 'mismatch' }, { status: 409 })
              : Response.json({ claimed: true, outcome: recovering ? 'duplicate' : 'claimed' });
          }
          posted++;
          return Response.json({ error: 'receipt binding rejected' }, { status: kind === 'result503' ? 503 : kind === 'result409' ? 409 : 400 });
        };
        const executor = new ServerRunToolExecutor(id, {
          ctx: () => ({ commands: draft.commands, getDoc: draft.getDoc, getState: draft.getState, getCreativeMode: () => null, templates: [], audio: [] }),
          settings: () => ({} as never), onToolAction: () => { executed++; }, updateMessages: () => {}, setLiveTool: () => {},
          retryStream: () => assert.fail('must not reexecute saved work'), abandonRecovery: (_r, e) => { abandoned.push(String(e)); },
        }, kind === 'no-lock' ? null : kind === 'broken-lock' ? { request: async () => { throw Error('lock failed'); } } : new FakeLockManager());
        executor.start({ capability: 'test', baseDoc: doc, activation: new ToolActivation(TOOL_SCHEMAS, []), runId, abort, recovered: new Map() });
        try {
          if (recovering) await executor.reconcileStoredAttempts(runId, readStoredServerRun(id)!.attempts!);
          else assert.equal(await executor.handle(runId, call, 'read_project', {}, 'd', () => true), false, 'a rejected result is not accepted');
          assert.equal(readStoredServerRun(id)?.attempts?.length, 1, 'rejection must retain the durable receipt');
          assert.equal(executed, recovering ? 0 : 1);
          const permanent = kind !== 'settled' && kind !== 'result503';
          assert.equal(abandoned.length, permanent ? 1 : 0);
          assert.equal(abort.signal.aborted, permanent);
          if (kind.startsWith('result') && permanent) assert.match(abandoned[0], /receipt binding rejected/);
          await new Promise(resolve => setTimeout(resolve, 300));
          assert.equal(posted, kind === 'result503' ? 2 : kind.startsWith('result') ? 1 : 0, 'only temporary transport failure may retry');
          if (kind === 'settled') assert.equal(claimed, 1, 'settled calls are neither reexecuted nor polled forever');
          assert.deepEqual(draft.getDoc(), doc);
        } finally { executor.stop(); }
      });
    }
  }
  for (const status of [200, 400]) await check(`stale-result-${status}-cannot-affect-new-run`, async () => {
    const id = `stale-result-${status}`, old = 'old', next = 'next', release = Promise.withResolvers<Response>();
    saveStoredServerRun(id, { projectId: id, runId: old, attempts: [] });
    const abandoned: string[] = [], posting = Promise.withResolvers<void>();
    const executor = new ServerRunToolExecutor(id, { ctx: () => ({} as never), settings: () => ({} as never), onToolAction: () => {}, updateMessages: () => {}, setLiveTool: () => {}, retryStream: () => {}, abandonRecovery: r => { abandoned.push(r); } }, new FakeLockManager());
    globalThis.fetch = async url => {
      if (String(url).endsWith('/tool-claim')) return Response.json({ claimed: true, outcome: 'duplicate' });
      posting.resolve(); return release.promise;
    };
    const start = (runId: string, abort: AbortController) => executor.start({ capability: 'test', baseDoc: doc, activation: new ToolActivation(TOOL_SCHEMAS, []), runId, abort, recovered: new Map([['c', { argsDigest: 'd', result: {} }]]) });
    start(old, new AbortController());
    const pending = executor.handle(old, 'c', 'read_project', {}, 'd', () => true);
    await posting.promise;
    saveStoredServerRun(id, { projectId: id, runId: next, attempts: [] });
    assert(beginStoredToolAttempt(id, 'c', 'new-digest'));
    const nextAbort = new AbortController(); start(next, nextAbort);
    release.resolve(Response.json(status === 400 ? { error: 'old run rejected' } : { ok: true }, { status }));
    await pending;
    assert.deepEqual(abandoned, []); assert.equal(nextAbort.signal.aborted, false);
    assert.equal(readStoredServerRun(id)?.attempts?.[0]?.argsDigest, 'new-digest');
    executor.stop();
  });
  await check('bridge-400-body-preserved', async () => {
    globalThis.fetch = async () => Response.json({ error: 'projectId, editorId, and baseRevision are required' }, { status: 400 });
    await assert.rejects(registerEditorBridge('p', 'e', 'v', new AbortController().signal), /HTTP 400.*baseRevision are required/);
    globalThis.fetch = async () => Response.json({ error: 'Authorization: Bearer private-token ' + 'x'.repeat(900) }, { status: 400 });
    await assert.rejects(registerEditorBridge('p', 'e', 'v', new AbortController().signal), error => {
      const e = error as Error & { detail: string };
      assert(!e.message.includes('private-token')); assert(e.detail.length <= 600); return true;
    });
    for (const response of [new Response('not JSON', { status: 400, headers: { 'Content-Type': 'application/json' } }), new Response('<html>private upstream page</html>', { status: 502 })]) {
      globalThis.fetch = async () => response;
      await assert.rejects(registerEditorBridge('p', 'e', 'v', new AbortController().signal), error => {
        assert.match(String(error), /HTTP (400|502)/); assert(!String(error).includes('private upstream page')); return true;
      });
    }
  });
  await check('bridge-stale-is409-malformed-still400', async () => {
    let stale = true;
    const operations = { editorRegistrationMatches: () => true, nextEditorCall: async () => { throw stale ? new ExternalEditorCallError('stale', 'browser ownership is stale') : Error('invalid poll request'); } } as unknown as BridgeOperations;
    const app = createMiniConnect(e => { throw e; });
    const configure = externalAgentPlugin(operations).configureServer;
    assert.equal(typeof configure, 'function');
    (configure as (server: unknown) => void)({ middlewares: { use: (route: string, handler: never) => app.use(route, handler) } });
    const server = createServer((req, res) => app.handle(req, res)); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const a = server.address(); assert(a && typeof a === 'object');
    const origin = `http://127.0.0.1:${a.port}`; const query = '/api/external-agent/poll?projectId=p&editorId=e&baseRevision=v'; const headers = { Origin: origin, 'Sec-Fetch-Site': 'same-origin', 'X-OpenChatCut-Editor-Registration': 'r'.repeat(43) };
    try {
      const conflict = await originalFetch(origin + query, { headers }); assert.equal(conflict.status, 409); assert.match(String((await conflict.json()).error), /stale/);
      stale = false; const malformed = await originalFetch(origin + query, { headers }); assert.equal(malformed.status, 400); assert.match(String((await malformed.json()).error), /invalid poll/);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
} finally {
  globalThis.fetch = originalFetch; configureSharedKvBackend(undefined);
  if (storage) Object.defineProperty(globalThis, 'localStorage', storage); else Reflect.deleteProperty(globalThis, 'localStorage');
}
assert.deepEqual(failures, [], `readback regressions: ${failures.join(', ')}`);
