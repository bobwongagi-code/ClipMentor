import assert from 'node:assert/strict';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createMiniConnect } from '../../desktop/mini-connect.ts';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version.ts';
import type { ProjectDoc } from '../../src/editor/types.ts';
import { migrateProjectDoc } from '../../src/persist/projectStore.ts';
import {
  loadAgentRuntimeSidecar, loadAgentArtifact, MAX_ARTIFACT_BYTES,
  resetAgentRuntimeStoreMemory,
} from '../../src/persist/agentRuntimeStore.ts';
import { saveServerRunDraftBase, saveServerRunDraftTool, loadServerRunDraft } from '../../src/agent/serverRunDraftStore.ts';
import { agentRunsPlugin } from './routes.ts';
import { flushServerRunPersistence, getRun, resetServerRunStoreForTest } from './store.ts';

// Match the measured 975,758-byte development project without shipping its
// private analysis, media paths, or scripts as a fixture. Repeated records,
// quotes, backslashes and Chinese text exercise the second JSON escaping layer.
function projectOfSize(bytes: number): ProjectDoc {
  const doc: ProjectDoc = {
    version: CURRENT_PROJECT_VERSION, assets: [], mediaFolders: [], activeTimelineId: 't',
    timelines: [{ id: 't', name: 'Size fixture', order: 0, fps: 30, width: 720, height: 1280,
      items: [], selectedId: null, markers: Array.from({ length: 1_500 }, (_, i) => ({
        id: `m${i}`, scope: 'project' as const, fromFrame: i, durationFrames: 0,
        color: 'yellow' as const, note: '核对"关系"\\源窗\n'.repeat(8),
      })) }],
  };
  const remaining = bytes - Buffer.byteLength(JSON.stringify(doc));
  assert(remaining >= 0);
  doc.timelines[0]!.markers![0]!.note += 'x'.repeat(remaining);
  assert.equal(Buffer.byteLength(JSON.stringify(doc)), bytes);
  return doc;
}

resetAgentRuntimeStoreMemory();
resetServerRunStoreForTest();
const app = createMiniConnect((error) => { throw error; });
const configure = agentRunsPlugin({ activatePersistence: () => undefined }).configureServer;
assert.equal(typeof configure, 'function');
(configure as (server: unknown) => void)({ middlewares: {
  use: (route: string, handler: (req: IncomingMessage, res: ServerResponse) => unknown) => app.use(route, handler),
} });
let modelRequests = 0;
const server = createServer((req, res) => {
  if (req.url === '/llm/chat/completions') {
    modelRequests += 1;
    req.resume();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = { id: 'local-size-test', object: 'chat.completion.chunk', created: 0,
      model: 'deepseek-chat', choices: [{ index: 0, delta: { role: 'assistant', content: 'Local startup verified.' }, finish_reason: null }] };
    res.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    return;
  }
  app.handle(req, res);
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert(address && typeof address === 'object');
const origin = `http://127.0.0.1:${address.port}`;
const auth = { Host: `127.0.0.1:${address.port}`, Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
const realFetch = globalThis.fetch;
const capability = 's'.repeat(43);
let wireBytes = 0;
let artifactBodyBytes = 0;
let draftPosts = 0;
globalThis.fetch = (async (input, init) => {
  const url = new URL(String(input), origin);
  assert.equal(url.origin, origin, 'this verifier may only contact its local mock server');
  if (url.pathname.endsWith('/draft')) {
    draftPosts += 1;
    wireBytes = Buffer.byteLength(String(init?.body));
    artifactBodyBytes = Buffer.byteLength(JSON.parse(String(init?.body)).artifact.body);
  }
  return realFetch(url, { ...init, headers: {
    ...auth, 'X-OpenChatCut-Run-Capability': capability,
    ...Object.fromEntries(new Headers(init?.headers).entries()),
  } });
}) as typeof fetch;

const projectId = 'draft-size-local-only';
const runId = randomUUID();
const path = `/api/agent-runs/${runId}`;
const post = (suffix: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${path}/${suffix}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
try {
  const create = await fetch('/api/agent-runs/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    projectId, runId, capability, provider: 'deepseek', model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'Local startup check, no tools.' }],
    tools: [], cacheMode: 'short', maxOutputTokens: 4_096, askOnly: true,
  }) });
  assert.equal(create.status, 201);
  assert.equal(modelRequests, 0, 'admission does not start a model before its recovery draft is saved');
  const baseDoc = projectOfSize(975_758);
  const text = '核对当前预览，不修改内容。'.repeat(300);
  const input = { baseDoc, text, content: text, askOnly: true, references: [] };
  await saveServerRunDraftBase(projectId, runId, input);
  assert(artifactBodyBytes < 1024 * 1024, 'the stored draft still fits in the former 1 MiB limit');
  assert(wireBytes > 1024 * 1024, 'the actual client request exceeds the old HTTP limit after escaping');
  assert(artifactBodyBytes < MAX_ARTIFACT_BYTES);
  const currentSize = { artifactBodyBytes, wireBytes };
  const draft = await loadServerRunDraft(projectId, runId);
  assert.deepEqual(draft?.base.baseDoc, migrateProjectDoc(baseDoc), 'large draft survives real HTTP persistence and recovery');
  assert.equal(draft?.base.content, text);
  assert.equal(getRun(runId)?.status, 'queued');

  // The same endpoint also stores post-tool snapshots/results, not just bases.
  await saveServerRunDraftTool(projectId, runId, {
    toolCallId: 'large-tool', argsDigest: 'size-only', name: 'read_project', args: {},
    result: { notes: '\\"核对'.repeat(240_000) }, actions: [],
  });
  assert(wireBytes > 1024 * 1024);
  assert.equal((await loadServerRunDraft(projectId, runId))?.tools.length, 1);

  const rawDraft = async (body: string, artifactId: string, headers: Record<string, string> = {}) => post('draft', {
    projectId, artifact: { artifactId, body, originalBytes: 1, bodySha256: 'forged',
      originalChars: 1, toolName: 'large-test', redacted: false, binaryOmitted: false },
  }, headers);
  const exactBody = JSON.stringify({ note: 'x'.repeat(MAX_ARTIFACT_BYTES - 11) });
  assert.equal(Buffer.byteLength(exactBody), MAX_ARTIFACT_BYTES);
  assert.equal((await rawDraft(exactBody, 'srd_exact')).status, 200, 'the existing 8 MiB artifact boundary is usable');
  const stored = await loadAgentArtifact(projectId, 'srd_exact');
  assert.equal(stored?.originalBytes, MAX_ARTIFACT_BYTES, 'server computes bytes rather than trusting the client');
  assert.equal(stored?.body, exactBody);
  const escapedBody = JSON.stringify({ note: '\\'.repeat((MAX_ARTIFACT_BYTES - 12) / 2) + 'x' });
  assert.equal(Buffer.byteLength(escapedBody), MAX_ARTIFACT_BYTES);
  assert.equal((await rawDraft(escapedBody, 'srd_escaped')).status, 200,
    'a valid artifact at the cap still fits after almost doubling through JSON escaping');
  assert.equal((await loadAgentArtifact(projectId, 'srd_escaped'))?.body, escapedBody);
  const beforeRejected = (await loadAgentRuntimeSidecar(projectId)).artifacts.length;
  assert.equal((await rawDraft(exactBody + ' ', 'srd_over')).status, 409, 'one byte beyond the artifact cap is rejected even with forged small size');
  assert.equal((await rawDraft('{}', 'srd_bad_cap', { 'X-OpenChatCut-Run-Capability': 'z'.repeat(43) })).status, 403);
  assert.equal((await loadAgentRuntimeSidecar(projectId)).artifacts.length, beforeRejected, 'rejected drafts leave no indexed artifacts');
  assert.equal(await loadAgentArtifact(projectId, 'srd_over'), null);

  // Keep HTTP memory bounded too: reject oversized envelopes with and without
  // Content-Length; do not broaden the default cap for create/start/cancel.
  const wireLimit = 2 * MAX_ARTIFACT_BYTES + 64 * 1024;
  const oversizedStatus = async (chunked: boolean) => new Promise<number>((resolve, reject) => {
    const req = request(`${origin}${path}/draft`, { method: 'POST', agent: false, headers: {
      ...auth, 'Content-Type': 'application/json', 'X-OpenChatCut-Run-Capability': capability,
      ...(!chunked ? { 'Content-Length': String(wireLimit + 1) } : {}),
    } }, (res) => { res.resume(); res.once('end', () => resolve(res.statusCode!)); });
    req.on('error', reject);
    if (chunked) {
      req.write(Buffer.alloc(wireLimit, 32));
      req.end(' ');
    } else req.end();
  });
  assert.equal(await oversizedStatus(false), 413);
  assert.equal(await oversizedStatus(true), 413);
  assert.equal((await post('start', { projectId, padding: 'x'.repeat(1024 * 1024) })).status, 413, 'other endpoints retain their original HTTP cap');
  const postsBeforeClientReject = draftPosts;
  await assert.rejects(saveServerRunDraftBase(projectId, runId, {
    ...input, text: 'x'.repeat(MAX_ARTIFACT_BYTES),
  }), /exceeds the durable artifact limit/);
  assert.equal(draftPosts, postsBeforeClientReject, 'client rejects oversized artifacts before sending');
  assert.equal(modelRequests, 0, 'size and auth failures never start execution');

  const started = await post('start', { projectId });
  assert.equal(started.status, 202, 'a task with a current-size recovery draft can enter execution');
  const terminal = await fetch(`${path}/events?projectId=${projectId}&after=0`, { signal: AbortSignal.timeout(15_000) });
  const events = await terminal.text();
  assert.match(events, /Local startup verified/);
  assert.equal(modelRequests, 1, 'execution completed against exactly one local mock response, no real provider');
  assert.equal(getRun(runId)?.status, 'completed');
  assert.equal(baseDoc.timelines[0]?.markers?.length, 1_500, 'input project was not pruned to make it fit');
  console.log('draft-size.verify: current-size HTTP save/recovery/start, large tool draft, 8 MiB boundary, forged size, auth and both wire caps passed', currentSize);
} finally {
  globalThis.fetch = realFetch;
  const run = getRun(runId);
  if (run && ['queued', 'running'].includes(run.status)) {
    await realFetch(`${origin}${path}/cancel`, { method: 'POST', headers: {
      ...auth, 'Content-Type': 'application/json', 'X-OpenChatCut-Run-Capability': capability,
    }, body: JSON.stringify({ projectId }) });
  }
  await flushServerRunPersistence();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  resetServerRunStoreForTest();
}
