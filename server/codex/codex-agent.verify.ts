import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { CodexTurnStreamEvent } from '../../shared/codex-agent.ts';
import { CODEX_DISABLED_FEATURES, CodexAppServerClient } from './app-server.ts';
import { codexCommand } from './command.ts';
import { CodexTurnManager, codexModelInputSchema } from './turn-manager.ts';
import { mapCodexModels, parseCodexTurnRequest } from '../plugins/codex-agent.ts';
import { KEY_NAMES, seedKeystore } from '../keystore.ts';
import { CLIPMENTOR_ANALYSIS_TOOL_SCHEMAS } from '../../src/agent/tools/schemas/clipmentor-analysis-tools.ts';
import { validateAgentToolInvocation } from '../../src/agent/execution-policy.ts';
const observeSchema = CLIPMENTOR_ANALYSIS_TOOL_SCHEMAS.find((tool) => tool.name === 'observe_clipmentor_source')!;
const visibleObserveSchema = codexModelInputSchema(observeSchema.input_schema);
assert.equal(visibleObserveSchema.oneOf, undefined);
assert.deepEqual(visibleObserveSchema.properties, observeSchema.input_schema.properties);
assert.deepEqual(visibleObserveSchema.required, observeSchema.input_schema.required);
assert(observeSchema.input_schema.oneOf, 'the authoritative host schema is not mutated');
const valueUnion = { type: 'object', properties: { value: {} }, oneOf: [{ properties: { value: { type: 'string' } } }, { properties: { value: { type: 'number' } } }] };
assert.equal(codexModelInputSchema(valueUnion), valueUnion, 'actual unions are preserved');
const nestedUnion = { type: 'object', properties: { value: { oneOf: [{ type: 'string' }, { type: 'number' }] } } };
assert.equal(codexModelInputSchema(nestedUnion), nestedUnion, 'nested unions are preserved');
const validObserve = { expectedRevision: 1, actor: { operator: 'test', executor: 'test', instruction: 'test-only', identity: 'local_declared_not_authenticated' }, reason: 'test-only', seconds: [1] };
assert(validateAgentToolInvocation(observeSchema, validObserve, [observeSchema]).ok);
for (const args of [{ seconds: [1] }, { ...validObserve, unrecognized: true }, { ...validObserve, sequence: { startSeconds: 1, endSeconds: 2, count: 3 } }, { ...validObserve, seconds: undefined }]) {
  assert(!validateAgentToolInvocation(observeSchema, args, [observeSchema]).ok, 'host retains required identity and exclusive sampling checks');
}


seedKeystore({
  ...Object.fromEntries(KEY_NAMES.map((name) => [name, ''])),
  CODEX_REASONING_EFFORT: 'high',
});
const turnBody = {
  requestId: 'reasoning-precedence',
  system: 'System',
  prompt: 'Prompt',
  projectId: 'project-1',
  tools: [],
};
assert.equal(parseCodexTurnRequest(turnBody).reasoningEffort, 'high',
  'legacy callers without an effort still use the saved setting');
assert.equal(parseCodexTurnRequest({ ...turnBody, reasoningEffort: null }).reasoningEffort, undefined,
  'an explicit model capability decision suppresses the saved effort');

const windowsShim = codexCommand(
  'C:\\Program Files\\Open&AI\\codex.cmd',
  ['--version', 'model=name&danger'],
  'win32',
);
assert.match(windowsShim.executable, /cmd\.exe$/i);
assert.equal(windowsShim.windowsVerbatimArguments, true);
assert.deepEqual(windowsShim.args.slice(0, 3), ['/d', '/s', '/c']);
assert.equal(windowsShim.args.length, 4, 'cmd.exe receives one escaped command after /c');
assert.match(windowsShim.args[3], /^"C:\\Program\^ Files\\Open\^&AI\\codex\.cmd /);
assert.match(windowsShim.args[3], /\^"model=name\^&danger\^""$/);

const FAKE_APP_SERVER = String.raw`
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';


const requiredFeatureArgs = ${JSON.stringify(CODEX_DISABLED_FEATURES.map((feature) => `features.${feature}=false`))};
if (requiredFeatureArgs.some((arg) => !process.argv.includes(arg))) process.exit(71);
if (!process.argv.includes('features.code_mode_host=true')) process.exit(71);
if (!process.argv.includes('tools.view_image=false') || !process.argv.includes('web_search=disabled')) process.exit(71);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
let activeThread = '';
let activeTurn = '';

function toolRequest() {
  send({
    id: 'dynamic-1',
    method: 'item/tool/call',
    params: {
      threadId: activeThread,
      turnId: activeTurn,
      callId: 'call-1',
      tool: 'read_project',
      arguments: { section: 'timeline' },
    },
  });
}

function connectorRequest() {
  send({
    id: 'connector-1',
    method: 'item/tool/call',
    params: {
      threadId: activeThread,
      turnId: activeTurn,
      callId: 'connector-call-1',
      tool: 'google_drive_search',
      arguments: { query: 'private files' },
    },
  });
}

lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    if (process.env.OPENAI_API_KEY || process.env.CODEX_ACCESS_TOKEN) process.exit(72);
    send({ id: message.id, result: { serverInfo: { name: 'fake-codex' } } });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'account/read') {
    send({ id: message.id, result: { account: { type: 'chatgpt', email: 'test@example.com', planType: 'pro' } } });
    return;
  }
  if (message.method === 'account/login/start') {
    const device = message.params.type === 'chatgptDeviceCode';
    const loginId = device ? 'login-2' : 'login-1';
    send({
      id: message.id,
      result: device
        ? { type: message.params.type, loginId, verificationUrl: 'https://auth.openai.com/device', userCode: 'ABCD-1234' }
        : { type: message.params.type, loginId, authUrl: 'https://auth.openai.com/test' },
    });
    if (!device) send({ method: 'account/login/completed', params: { loginId, success: true } });
    return;
  }
  if (message.method === 'account/login/cancel') {
    if (message.params.loginId !== 'login-2') process.exit(76);
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === 'test/hang') return;
  if (message.method === 'thread/start') {
    if (message.params.model !== 'gpt-5.4') process.exit(77);
    if (!message.params.dynamicTools?.some((tool) => tool.name === 'read_project')) process.exit(79);
    const observe = message.params.dynamicTools.find((tool) => tool.name === 'observe_clipmentor_source')?.inputSchema;
    if (!observe || observe.oneOf || !observe.properties?.seconds || !observe.properties?.sequence
      || !observe.required?.includes('expectedRevision') || !observe.required?.includes('actor') || !observe.required?.includes('reason')
      || observe.additionalProperties !== false) process.exit(82);

    if (!message.params.baseInstructions?.includes('without changing the project')) process.exit(80);
    const instructions = message.params.baseInstructions;
    assert(instructions.includes('structuredClone is not available in functions.exec'), 'code-mode runtime contract must reach thread/start');
    const cloneExample = instructions.match(/JSON clone example: ([^\n]+)/)?.[1];
    assert(cloneExample, 'the runtime must supply an executable JSON-only copy example');
    const value = { id: 'existing-line', captions: ['气味', 'bau sabun'], range: [59.4, 64.6], state: null };
    const scope = { value };
    assert.equal(runInNewContext('typeof structuredClone', scope), 'undefined');
    assert.throws(() => runInNewContext('structuredClone(value)', scope), /structuredClone is not defined/);
    const copy = runInNewContext(cloneExample + '; copy', scope);
    assert.equal(JSON.stringify(copy), JSON.stringify(value));
    copy.captions[0] = 'changed';
    copy.range[0] = 0;
    assert.equal(value.captions[0], '气味');
    assert.equal(value.range[0], 59.4, 'building arguments must not mutate the readback');
    if (message.params.config?.features?.code_mode !== false
      || message.params.config?.features?.code_mode_host !== true
      || message.params.config?.features?.computer_use !== false
      || message.params.config?.features?.unified_exec !== false
      || message.params.config?.web_search !== 'disabled') process.exit(81);
    activeThread = 'thread-1';
    send({ id: message.id, result: { thread: { id: activeThread } } });
    return;
  }
  if (message.method === 'turn/start') {
    if (message.params.effort !== 'high') process.exit(78);
    activeTurn = 'turn-1';
    send({ id: message.id, result: { turn: { id: activeTurn } } });
    send({
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: { threadId: activeThread, turnId: activeTurn },
    });
    return;
  }
  if (message.id === 'approval-1') {
    if (message.result?.decision !== 'decline') process.exit(73);
    connectorRequest();
    return;
  }
  if (message.id === 'connector-1') {
    if (message.result?.success !== false) process.exit(75);
    toolRequest();
    return;
  }
  if (message.id === 'dynamic-1') {
    if (message.result?.success !== true) process.exit(74);
    // Code-mode nested calls return text; images must have an explicit JSON
    // content contract that the caller can forward with image(contentBlock).
    const items = message.result.contentItems;
    if (items?.length !== 1 || items[0]?.type !== 'inputText') process.exit(82);
    const visual = JSON.parse(items[0].text);
    if (visual.metadata.note !== 'image boundary check'
      || visual.content[0]?.type !== 'image' || visual.content[0]?.data !== 'aGVsbG8='
      || visual.content[1]?.type !== 'image' || visual.content[1]?.data !== 'd29ybGQ='
      || visual.content[0]?.mimeType !== 'image/jpeg'
      || '__images' in visual.metadata) process.exit(82);
    // A total-only event must not be passed downstream as a request sample.
    send({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: activeThread,
        turnId: activeTurn,
        tokenUsage: { total: { inputTokens: 1000, outputTokens: 100 } },
      },
    });
    send({
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: activeThread,
        turnId: activeTurn,
        tokenUsage: {
          last: {
            inputTokens: 321,
            cachedInputTokens: 200,
            outputTokens: 89,
            reasoningOutputTokens: 34,
            totalTokens: 410,
          },
          total: {
            inputTokens: 1321,
            cachedInputTokens: 900,
            outputTokens: 189,
            reasoningOutputTokens: 64,
            totalTokens: 1510,
          },
          modelContextWindow: 272000,
        },
      },
    });
    send({
      method: 'item/agentMessage/delta',
      params: { threadId: activeThread, turnId: activeTurn, delta: 'Tool confirmed.' },
    });
    send({
      method: 'turn/completed',
      params: { threadId: activeThread, turn: { id: activeTurn, status: 'completed' } },
    });
    return;
  }
  if (message.method === 'thread/delete' || message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
    return;
  }
  send({ id: message.id, error: { code: -32601, message: 'unsupported' } });
});
`;

const directory = await mkdtemp(join(tmpdir(), 'openchatcut-codex-verify-'));
const scriptPath = join(directory, 'fake-app-server.mjs');
const previousOpenAiKey = process.env.OPENAI_API_KEY;
const previousAccessToken = process.env.CODEX_ACCESS_TOKEN;
process.env.OPENAI_API_KEY = 'must-not-reach-codex';
process.env.CODEX_ACCESS_TOKEN = 'must-not-reach-codex';
await writeFile(scriptPath, FAKE_APP_SERVER, 'utf8');

const client = new CodexAppServerClient(process.execPath, [scriptPath]);
assert.deepEqual(mapCodexModels({
  data: [{
    id: 'gpt-5.6-sol',
    displayName: 'GPT-5.6-Sol',
    isDefault: true,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low', description: 'Fast responses.' },
      { reasoningEffort: 'high', description: 'Deep reasoning.' },
    ],
  }],
}), [{
  id: 'gpt-5.6-sol',
  label: 'GPT-5.6-Sol',
  isDefault: true,
  defaultReasoningEffort: 'low',
  supportedReasoningEfforts: [
    { reasoningEffort: 'low', description: 'Fast responses.' },
    { reasoningEffort: 'high', description: 'Deep reasoning.' },
  ],
}]);
try {
  const account = await client.request('account/read', { refreshToken: false });
  assert.deepEqual(account, {
    account: { type: 'chatgpt', email: 'test@example.com', planType: 'pro' },
  });

  const login = await client.startLogin('chatgpt');
  assert.deepEqual(login, {
    type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.openai.com/test',
  });
  for (let attempt = 0; client.loginPending && attempt < 20; attempt += 1) await delay(5);
  assert.equal(client.loginPending, false, 'a fast completion must not leave stale pending login state');

  await client.startLogin('chatgptDeviceCode');
  assert.equal(client.loginPending, true, 'device login remains pending until cancelled');
  await client.cancelPendingLogins();
  assert.equal(client.loginPending, false, 'cancel-all clears pending login state across UI mounts');

  const controller = new AbortController();
  const hanging = client.request('test/hang', {}, { signal: controller.signal });
  controller.abort(new Error('cancelled by test'));
  await assert.rejects(hanging, /cancelled by test/);

  const manager = new CodexTurnManager();
  const events: CodexTurnStreamEvent[] = [];
  await manager.run(client, {
    requestId: 'request-1',
    system: 'Use OpenChatCut tools.',
    prompt: 'Read the current project.',
    projectId: 'project-1',
    model: 'gpt-5.4',
    reasoningEffort: 'high',
    askOnly: true,
    tools: [{
      name: 'read_project',
      description: 'Read project state',
      inputSchema: { type: 'object', properties: { section: { type: 'string' } } },
    }, { name: observeSchema.name, description: observeSchema.description, inputSchema: observeSchema.input_schema }],
  }, (event) => {
    events.push(event);
    if (event.type === 'tool-start') {
      assert.equal(manager.settleToolResult({
        requestId: 'request-1',
        callId: event.callId,
        success: true,
        result: { projectId: 'project-1', note: 'image boundary check',
          __images: [{ frame: 1, base64: 'aGVsbG8=' }, { frame: 2, base64: 'd29ybGQ=' }] },
      }), 'ok');
    }
  }, new AbortController().signal);

  assert.equal(manager.hasRequest('request-1'), false);
  assert.deepEqual(events.map((event) => event.type), [
    'tool-end', 'tool-start', 'tool-end', 'context-usage', 'text-delta', 'done',
  ]);
  assert.deepEqual(events[0], {
    type: 'tool-end',
    callId: 'rejected:request-1:1',
    name: 'google_drive_search',
    args: { query: 'private files' },
    result: { error: 'This OpenChatCut tool call is unavailable. It was not part of this request (stale tool list, duplicate call, or malformed id). Tell the user to open the project and retry; if it persists, start a new run.' },
    success: false,
  });
  assert.deepEqual(events.find((event) => event.type === 'context-usage'), {
    type: 'context-usage',
    inputTokens: 321,
    contextWindowTokens: 272_000,
    outputTokens: 89,
    reasoningTokens: 34,
    cacheReadTokens: 200,
    noCacheInputTokens: 121,
  });
} finally {
  client.stop();
  if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousOpenAiKey;
  if (previousAccessToken === undefined) delete process.env.CODEX_ACCESS_TOKEN;
  else process.env.CODEX_ACCESS_TOKEN = previousAccessToken;
  await rm(directory, { recursive: true, force: true });
}

console.log('codex agent verification passed');
