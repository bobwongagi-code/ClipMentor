import assert from 'node:assert';
import type { ModelMessage } from 'ai';
import {
  claimToolRequest,
  createRunWithCapability,
  deliverToolResult,
  digestToolArgs,
  flushRunPersistence,
} from './store';
import { executeServerCodexTurn, type ServerCodexTurnDeps } from './codex-turn';
import type { ActivationState } from './executor';
import { ToolActivation } from '../../src/agent/tool-activation';
import { TOOL_SCHEMAS } from '../../src/agent/tools';
import type { AgentToolSchema } from '../../src/agent/tool-schema';
import type { CodexTurnStreamEvent } from '../../shared/codex-agent';
import type { ServerRun } from './store-types';
import { ToolFailureTracker } from '../../src/agent/toolFailure';
import { createAcceptanceLoop } from './acceptance-loop';

const searchMediaSchema = TOOL_SCHEMAS.find((schema) => schema.name === 'search_media')!;
const analyzeMusicSchema = TOOL_SCHEMAS.find((schema) => schema.name === 'analyze_music')!;

function makeRun(): ServerRun {
  return createRunWithCapability({
    projectId: 'codex-verify-project',
    sessionGeneration: 'gen-1',
    backend: 'codex',
    provider: 'openai',
    model: 'codex-mini-latest',
  }).run;
}

function makeInput(run: ServerRun) {
  const activation = {
    current: new ToolActivation(TOOL_SCHEMAS, [], [searchMediaSchema.name]),
    tail: Promise.resolve(),
    followupText: null,
    toolFailures: new ToolFailureTracker(),
    acceptance: createAcceptanceLoop(false, 3),
  };
  const messages: ModelMessage[] = [{ role: 'user', content: 'Find media.' }];
  return {
    run,
    messages,
    instructions: 'You are a video editor agent.',
    schemas: [searchMediaSchema] as readonly AgentToolSchema[],
    model: 'codex-mini-latest',
    askOnly: false,
    projectId: 'codex-verify-project',
    maxInputTokens: 1_000_000,
    maxOutputTokens: 32_768,
    contextWindowTokens: 1_000_000,
    contextWindowEstimated: false,
    signal: new AbortController().signal,
    activation,
    requestIndex: 1,
  };
}

async function deliverWhenRequested(
  run: ServerRun,
  callId: string,
  result: unknown,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      const request = run.toolRequests.get(callId);
      if (!request) return;
      clearInterval(timer);
      assert.equal(claimToolRequest(run, {
        toolCallId: callId,
        argsDigest: request.argsDigest,
        claimId: `verify-claim-${callId}`,
      }), 'claimed', 'browser claim succeeds');
      assert.equal(deliverToolResult(run, callId, result), true, 'tool result delivery is accepted');
      resolve();
    }, 5);
  });
}

function sequence(events: readonly CodexTurnStreamEvent[]): ServerCodexTurnDeps {
  return {
    runTurn: async (_request, emit) => {
      for (const event of events) emit(event);
    },
  };
}

// ── Text-only turn ────────────────────────────────────────────────────────────
{
  const run = makeRun();
  const input = makeInput(run);
  const deps = sequence([
    { type: 'text-delta', delta: 'I found ' },
    { type: 'thinking-delta', delta: 'checking clip boundaries' },
    { type: 'text-delta', delta: 'the clips.' },
    { type: 'context-usage', inputTokens: 1000, outputTokens: 10, cacheReadTokens: 200 },
    { type: 'context-usage', inputTokens: 1200, outputTokens: 20, cacheReadTokens: 300 },
    { type: 'done' },
  ]);
  const outcome = await executeServerCodexTurn(input, deps);
  assert.equal(outcome.text, 'I found the clips.', 'text is collected across deltas');
  assert.equal(run.metrics?.inputTokens, 2200, 'request inputs are summed once');
  assert.equal(run.runtimeContext.inputTokens, 1200, 'latest usage is per request');
  assert.equal(run.runtimeContext.activeToolCount, TOOL_SCHEMAS.length,
    'diagnostics count the tools actually registered with Codex');
  assert.equal(run.runtimeContext.toolSchemaChars, JSON.stringify(TOOL_SCHEMAS).length,
    'diagnostics measure the complete registered catalog');
  assert.equal(outcome.continued, false, 'no tool calls means no continuation');
  assert.deepEqual(
    outcome.messages.map((message) => message.role),
    ['user', 'assistant'],
    'messages rebuild as user + assistant text',
  );
  const assistant = outcome.messages.at(-1)!;
  assert.equal(typeof assistant.content, 'string');
  assert.equal(assistant.content, 'I found the clips.');
  await flushRunPersistence(run);
  const textEnd = run.events.find((event) => event.type === 'text-end');
  assert.ok(textEnd, 'text-end event is pushed');
  const thinking = run.events
    .filter((event) => event.type === 'thinking-delta')
    .map((event) => {
      const data = event.data;
      return data && typeof data === 'object' && 'text' in data && typeof data.text === 'string'
        ? data.text
        : '';
    })
    .join('');
  assert.equal(thinking, 'checking clip boundaries', 'codex thinking-delta reaches run events');
}

// ── Tool turn: tool-start bridges to the browser and settles back ─────────────
{
  const run = makeRun();
  const input = makeInput(run);
  let settled: Array<{ callId: string; success: boolean }> = [];
  const deps: ServerCodexTurnDeps = {
    runTurn: async (_request, emit) => {
      emit({ type: 'text-delta', delta: 'Checking the pool.' });
      emit({
        type: 'tool-start',
        callId: 'call-1',
        name: searchMediaSchema.name,
        args: { query: 'clips' },
      });
      // Browser claims and settles the tool result; the turn continues after it.
      await deliverWhenRequested(run, 'call-1', { items: [{ name: 'a.mp4' }] });
      await new Promise((resolve) => setTimeout(resolve, 20));
      emit({ type: 'text-delta', delta: ' Done.' });
      emit({ type: 'done' });
    },
  };
  // Patch the real turn manager settle so we can observe the settlement shape
  // without an active session (it returns unknown-request for missing sessions).
  const turnManagerModule = await import('../codex/turn-manager');
  const originalSettle = turnManagerModule.codexTurnManager.settleToolResult.bind(
    turnManagerModule.codexTurnManager,
  );
  turnManagerModule.codexTurnManager.settleToolResult = ((body: {
    requestId: string;
    callId: string;
    success: boolean;
    result: unknown;
  }) => {
    settled.push({ callId: body.callId, success: body.success });
    return originalSettle(body as never);
  }) as typeof turnManagerModule.codexTurnManager.settleToolResult;
  try {
    const outcome = await executeServerCodexTurn(input, deps);
    assert.equal(outcome.text, 'Checking the pool. Done.', 'text spans the tool call');
    assert.equal(outcome.continued, false,
      'Codex already resumes after the settled tool and must not replay the completed turn');
    assert.equal(settled.length, 1, 'tool result is settled back into the codex turn');
    assert.equal(settled[0]!.callId, 'call-1');
    assert.equal(settled[0]!.success, true);
    const histories = outcome.messages.filter((message) =>
      typeof message.content === 'string'
      && String(message.content).includes('[tool call: search_media]'));
    assert.equal(histories.length, 1, 'merged tool history entry is rebuilt');
  } finally {
    turnManagerModule.codexTurnManager.settleToolResult = originalSettle;
  }
}

// ── Delayed canonical tool remains registered with Codex ────────────────────
{
  const run = makeRun();
  const input = makeInput(run);
  assert.ok(!input.activation.current.schemas().some((schema) => schema.name === analyzeMusicSchema.name),
    'the delayed tool starts inactive for prompt-token routing');
  let registered = false;
  let settled = false;
  const deps: ServerCodexTurnDeps = {
    runTurn: async (request, emit) => {
      registered = request.tools.some((tool) => tool.name === analyzeMusicSchema.name);
      emit({
        type: 'tool-start',
        callId: 'delayed-call',
        name: analyzeMusicSchema.name,
        args: { assetId: 'asset-1' },
      });
      await deliverWhenRequested(run, 'delayed-call', { bpm: 120 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      emit({ type: 'done' });
    },
  };
  const turnManagerModule = await import('../codex/turn-manager');
  const originalSettle = turnManagerModule.codexTurnManager.settleToolResult.bind(
    turnManagerModule.codexTurnManager,
  );
  turnManagerModule.codexTurnManager.settleToolResult = ((body: { success: boolean }) => {
    settled = body.success;
    return originalSettle(body as never);
  }) as typeof turnManagerModule.codexTurnManager.settleToolResult;
  try {
    const outcome = await executeServerCodexTurn(input, deps);
    assert.equal(registered, true, 'Codex receives the full canonical tool catalog');
    assert.equal(settled, true, 'the delayed call remains admitted through the browser bridge');
    assert.ok(outcome.messages.some((message) => String(message.content).includes(analyzeMusicSchema.name)),
      'the delayed call is preserved in the tool history');
  } finally {
    turnManagerModule.codexTurnManager.settleToolResult = originalSettle;
  }
}

// ── Adjacent pure-tool replay ends the server loop without browser work ──────
{
  const run = makeRun();
  const input = makeInput(run);
  const activation: ActivationState = input.activation;
  const args = { assetId: 'asset-cached' };
  activation.lastSuccessfulPureTool = {
    name: analyzeMusicSchema.name,
    argsDigest: digestToolArgs(args),
    result: { bpm: 120, activatedTools: [] },
  };
  const deps: ServerCodexTurnDeps = {
    runTurn: async (_request, emit) => {
      emit({ type: 'tool-start', callId: 'cached-call', name: analyzeMusicSchema.name, args });
      await new Promise((resolve) => setTimeout(resolve, 20));
      emit({ type: 'done' });
    },
  };
  const outcome = await executeServerCodexTurn(input, deps);
  assert.equal(run.events.some((event) => event.type === 'tool-request'), false,
    'cached analyze_music replay does not request browser execution');
  assert.equal(outcome.continued, false,
    'cached replay ends the outer server turn loop');
  assert.match(activation.repeatGuardNote ?? '', /skipped duplicate browser execution/);
}

// ── Unknown tools remain rejected by the canonical host boundary ─────────────
{
  const run = makeRun();
  const input = makeInput(run);
  const outcome = await executeServerCodexTurn(input, sequence([
    { type: 'tool-start', callId: 'unknown-call', name: 'unknown_editor_tool', args: {} },
    { type: 'done' },
  ]));
  assert.equal(run.events.some((event) => event.type === 'tool-request'), false,
    'an unknown host tool never reaches the browser bridge');
  assert.equal(outcome.continued, false,
    'a terminal Codex turn is not replayed after rejecting an unknown tool');
  assert.equal(input.activation.toolFailures.hasUnresolved, true,
    'an unknown host tool blocks false completion');
}

// ── Business failure result settles Codex on its error channel ───────────────
{
  const run = makeRun();
  const input = makeInput(run);
  let settled: boolean | null = null;
  const deps: ServerCodexTurnDeps = {
    runTurn: async (_request, emit) => {
      emit({
        type: 'tool-start',
        callId: 'failed-call',
        name: searchMediaSchema.name,
        args: { query: 'missing clips' },
      });
      await deliverWhenRequested(run, 'failed-call', { ok: false, error: 'media is unavailable' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      emit({ type: 'done' });
    },
  };
  const turnManagerModule = await import('../codex/turn-manager');
  const originalSettle = turnManagerModule.codexTurnManager.settleToolResult.bind(
    turnManagerModule.codexTurnManager,
  );
  turnManagerModule.codexTurnManager.settleToolResult = ((body: { success: boolean }) => {
    settled = body.success;
    return originalSettle(body as never);
  }) as typeof turnManagerModule.codexTurnManager.settleToolResult;
  try {
    const outcome = await executeServerCodexTurn(input, deps);
    assert.equal(settled, false, 'business failure is settled as an error');
    assert.equal(input.activation.toolFailures.hasUnresolved, true,
      'the failed Codex tool blocks completion until a same-tool retry succeeds');
    assert.ok(outcome.messages.some((message) => String(message.content).includes('success=false')),
      'failure is persisted in the Codex tool history');
  } finally {
    turnManagerModule.codexTurnManager.settleToolResult = originalSettle;
  }
}

// ── Error event fails the turn ────────────────────────────────────────────────
{
  const run = makeRun();
  const input = makeInput(run);
  const deps = sequence([{ type: 'error', message: 'usage limit exceeded' }]);
  await assert.rejects(
    executeServerCodexTurn(input, deps),
    /usage limit exceeded/,
    'a codex error event fails the turn',
  );
}

// ── Missing terminal event fails the turn ─────────────────────────────────────
{
  const run = makeRun();
  const input = makeInput(run);
  const deps = sequence([{ type: 'text-delta', delta: 'half' }]);
  await assert.rejects(
    executeServerCodexTurn(input, deps),
    /without a terminal event/,
    'a turn that never emits done fails',
  );
}



// A productive native turn may run longer than 600s across many tool/model steps.
// Scale only the 600s watchdog, keeping normal async clocks real; no provider.
{
  const originalTimer = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) =>
    originalTimer(fn, ms === 600_000 ? 25 : ms, ...args)) as typeof setTimeout;
  try {
    const run = makeRun();
    await executeServerCodexTurn(makeInput(run), {runTurn: async (_request, emit) => {
      for (let i=0;i<8;i++) { await new Promise(r=>originalTimer(r,8)); emit({type:'text-delta',delta:'.'}); }
      emit({type:'done'});
    }});
    // Tool execution has its own timeout. Waiting on a healthy tool is not
    // an idle provider, and must not consume the model inactivity watchdog.
    const toolRun=makeRun();
    await executeServerCodexTurn(makeInput(toolRun), {runTurn:async (_r,emit)=>{
      emit({type:'tool-start',callId:'long-tool',name:searchMediaSchema.name,args:{query:'fixture'}});
      await new Promise(r=>originalTimer(r,60));
      await deliverWhenRequested(toolRun,'long-tool',{items:[]});
      await new Promise(r=>originalTimer(r,5));emit({type:'done'});
    }});
    let aborted = false;
    await assert.rejects(executeServerCodexTurn(makeInput(makeRun()), {runTurn: async (_r,_e,signal) => {
      signal.addEventListener('abort',()=>{aborted=true;},{once:true});
      await new Promise(r=>originalTimer(r,50));
    }}), /timed out/);
    assert.equal(aborted,true,'timeout must cancel the native producer, not leave it running');
  } finally {globalThis.setTimeout=originalTimer;}
}

// Editing checkpoints and exact executable rows share the real client code;
// fixtures use only memory storage and a local artifact transport (zero models).
{
  const {makeDraft} = await import('../../src/editor/store');
  const {migrateProjectDoc,saveProject,loadProject} = await import('../../src/persist/projectStore');
  const {startServerRun,persistToolAction,finishServerRun,abandonServerRun,checkpointAutoAppliedTurn} = await import('../../src/agent/serverRunProposalLifecycle');
  const {ServerRunTerminalHandoffs} = await import('../../src/agent/serverRunTerminalHandoff');
  const {startAgentRun} = await import('../../src/agent/runtime-ledger');
  const {storeAgentArtifact} = await import('../../src/persist/agentRuntimeStore');
  const {checkSourceBreakdown} = await import('../../src/clipmentor/source-breakdown');
  const {executeTool} = await import('../../src/agent/tools');
  type Doc = import('../../src/editor/types').ProjectDoc;
  type State = import('../../src/agent/useAgentState').AgentHookState;
  const doc = migrateProjectDoc({version:3,assets:[],mediaFolders:[],activeTimelineId:'tl',timelines:[{id:'tl',name:'fixture',order:0,width:576,height:1024,fps:30,items:[],selectedId:null}]})!;
  const previousFetch=globalThis.fetch;
  let clears=0,exportPosts=0;
  globalThis.fetch=async (url,init) => {
    if(String(url).endsWith('/draft/clear')) {clears++;return Response.json({ok:true});}
    if(String(url).endsWith('/draft')) {
      const v=JSON.parse(String(init?.body));
      assert(await storeAgentArtifact({redacted:false,binaryOmitted:false,...v.artifact,version:1,projectId:v.projectId,runId:String(url).split('/').at(-2)!,kind:'server-run-draft',createdAt:Date.now()}));
      return Response.json({ok:true});
    }
    if(String(url).endsWith('/settle'))return Response.json({ok:true});
    if(String(url)==='/export/job'){exportPosts++;return Response.json({error:'injected export failure'},{status:500});}
    throw new Error(`Unexpected fixture network: ${String(url)}`);
  };
  try {
    for(const mode of ['auto','manual'] as const) {
      const projectId=`checkpoint-fixture-${mode}`;
      const live=makeDraft(doc);
      const ctx={commands:live.commands,getDoc:live.getDoc,getState:live.getState,getCreativeMode:()=>null,
        getApprovalMode:()=>mode,getProjectId:()=>projectId, getAgentRunId:()=>`fixture-${mode}`,templates:[],audio:[]};
      const state={ctxRef:{current:ctx},llmProviderRef:{current:'openai'},abortRef:{current:null},runningRef:{current:false},
        setRunning:()=>{},setProposalStale:()=>{},setChangeLog:()=>{},setMessages:()=>{}} as unknown as State;
      const ref={current:{turn:null as import('../../src/agent/useAgentRun').AgentTurn|null,seenToolCalls:new Set<string>(),handoffs:new ServerRunTerminalHandoffs()}};
      assert((await saveProject(projectId,doc)).saved);
      const recorder=await startAgentRun({projectId,userInput:'fixture',askOnly:false});
      const input={runId:recorder.runId,text:'authorized edit',content:'authorized edit',askOnly:false,references:[],baseDoc:doc,resumed:false};
      await startServerRun(state,ctx,projectId,input,ref);
      const scratch=makeDraft(doc); scratch.commands.addTextClip({text:'saved title',durationInFrames:30});
      const action={runId:input.runId,toolCallId:'add-title',argsDigest:'fixture-digest',name:'edit_item',args:{},result:{ok:true},actions:scratch.takeActions(),baseDoc:doc};
      await persistToolAction(projectId,action,ref);
      await persistToolAction(projectId,action,ref);
      const cold=await loadProject(projectId);
      if(mode==='auto') {
        const pending=ref.current.turn!;
        const second=makeDraft(pending.draft.getDoc());second.commands.addTextClip({text:'second checkpoint'});
        pending.draft=second;
        pending.ops.push({tool:'edit_item',args:{},actions:second.takeActions(),action:'add',target:'fixture',impact:'add'});
        await assert.rejects(checkpointAutoAppliedTurn(pending,async()=>{throw new Error('injected save failure');}),/not committed/);
        assert.deepEqual(await loadProject(projectId),cold,'a refused save cannot change the last committed project');
        await assert.rejects(checkpointAutoAppliedTurn(pending,saveProject,async()=>null),/cold readback/);
        assert.equal((await loadProject(projectId))!.timelines[0].items.length,2,'a successful save survives failed readback');
        await checkpointAutoAppliedTurn(pending);
        assert.equal((await loadProject(projectId))!.timelines[0].items.length,2,'readback recovery cannot apply the edit twice');
        // Restore fixture to one committed clip before testing export failure.
        assert((await saveProject(projectId,cold!)).saved);live.commands.applyDoc(cold!);
        pending.baseDoc=live.getDoc();pending.proposalBaseDoc=live.getDoc();pending.draft=makeDraft(live.getDoc());
      }
      assert.equal(cold!.timelines[0].items.length,mode==='auto'?1:0,'auto edits must be committed before model terminal; manual edits stay proposals');
      if(mode==='auto') {
        // Business errors are values; do not confuse them with success.
        const result=await executeTool('submit_render_job',{},ctx) as {error?:string};
        assert.match(result.error??'',/injected export failure/);
        assert.equal(exportPosts,1,'one external request per explicit export test, no hidden retry');
        assert.deepEqual(await loadProject(projectId),cold,'failed export never rolls back committed editing');
        const restored=await startServerRun(state,ctx,projectId,{...input,resumed:true,baseDoc:live.getDoc()},ref);
        assert.equal(restored.draftDoc!.timelines[0].items.length,1,'reconnect does not duplicate already committed journal actions');
        // Two acknowledgements can arrive together even though editor writes
        // are ordered. Their checkpoints cannot race or drop a later action.
        await Promise.all(['A','B'].map((text,index)=>{
          const d=makeDraft(doc);d.commands.addTextClip({text});
          return persistToolAction(projectId,{...action,toolCallId:`parallel-${index}`,actions:d.takeActions()},ref);
        }));
        assert.equal((await loadProject(projectId))!.timelines[0].items.length,3,'concurrent acknowledgements retain both atomic edits');
        // Use the committed result as this fixture's preserved baseline.
        const three=await loadProject(projectId);
        assert(three);assert((await saveProject(projectId,cold!)).saved);live.commands.applyDoc(cold!);
        ref.current.turn!.baseDoc=live.getDoc();ref.current.turn!.proposalBaseDoc=live.getDoc();ref.current.turn!.draft=makeDraft(live.getDoc());
        const pending=ref.current.turn!; pending.ops.push({tool:'fixture',args:{},actions:[],action:'x',target:'x',impact:'x'});
        const before=structuredClone(await loadProject(projectId));
        live.commands.addTextClip({text:'concurrent user edit'});
        await assert.rejects(checkpointAutoAppliedTurn(pending),/Project changed/);
        assert.deepEqual(await loadProject(projectId),before,'a concurrent edit is not overwritten');
      }
      const count=clears;
      await finishServerRun(projectId,{runId:input.runId,status:'failed',assistantText:'injected timeout'},ref);
      assert.equal(clears,count,'failed terminal retains its draft journal');
      await abandonServerRun(projectId,input.runId,ref);
      assert.equal(clears,count,'navigation or stale transport must not erase edited draft journals');
      assert.equal((await loadProject(projectId))!.timelines[0].items.length,mode==='auto'?1:0);
    }
  } finally {globalThis.fetch=previousFetch;}

  // React dispatch may publish the committed document only on the next render.
  // The stored baseline must be the submitted snapshot rather than that old ref.
  {
    let live=doc,queued:Doc|undefined,saved:Doc|undefined;
    const scratch=makeDraft(doc);scratch.commands.addTextClip({text:'first'});
    const ctx={commands:{...makeDraft(doc).commands,applyDoc:(next:Doc)=>{queued=next;}},getDoc:()=>live,getState:()=>live.timelines[0],getCreativeMode:()=>null,getApprovalMode:()=> 'auto' as const,templates:[],audio:[]};
    const turn={projectId:'deferred-editor',assistantText:'fixture',askOnly:false,baseDoc:doc,proposalBaseDoc:doc,draft:scratch,ops:[{actions:scratch.takeActions()}],persistentOps:[],abortController:new AbortController(),draftInvalidated:false,persistentSnapshot:Promise.resolve(),
      state:{ctxRef:{current:ctx},llmProviderRef:{current:'openai'},setChangeLog:()=>{},setMessages:()=>{}}} as unknown as import('../../src/agent/useAgentRun').AgentTurn;
    const persist=async (_id:string,next:Doc)=>{saved=next;return {saved:true};};
    await checkpointAutoAppliedTurn(turn,persist as never,async()=>saved!);
    assert.equal(turn.baseDoc.timelines[0].items.length,1,'the committed baseline cannot be the pre-render document');
    live=queued!;
    turn.draft=makeDraft(live);turn.draft.commands.addTextClip({text:'second'});turn.ops=[{tool:'edit_item',args:{},actions:turn.draft.takeActions(),action:'add',target:'second',impact:'add'}];
    await checkpointAutoAppliedTurn(turn,persist as never,async()=>saved!);
    assert.equal(saved!.timelines[0].items.length,2,'a normal edit after React publication must not be rejected as a concurrent change');
  }
  // Cancellation/failure/navigation during the actual save must fence its late
  // completion and retain the preceding committed sequence.
  for(const terminal of ['cancelled','failed','abandon','project-switch'] as const) {
    const live=makeDraft(doc),scratch=makeDraft(doc);scratch.commands.addTextClip({text:'late edit'});
    const controller=new AbortController();let saved=doc,calls=0;
    const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
    const ctx={commands:live.commands,getDoc:live.getDoc,getState:live.getState,getCreativeMode:()=>null,getApprovalMode:()=> 'auto' as const,templates:[],audio:[]};
    const turn={projectId:`terminal-${terminal}`,runId:`run-${terminal}`,assistantText:'fixture',askOnly:false,baseDoc:doc,proposalBaseDoc:doc,draft:scratch,ops:[{actions:scratch.takeActions()}],persistentOps:[],abortController:controller,draftInvalidated:false,persistentSnapshot:Promise.resolve(),
      state:{ctxRef:{current:ctx},llmProviderRef:{current:'openai'},setChangeLog:()=>{},setMessages:()=>{},abortRef:{current:controller},runningRef:{current:true},setRunning:()=>{}}} as unknown as import('../../src/agent/useAgentRun').AgentTurn;
    const ref={current:{turn:turn as typeof turn|null,seenToolCalls:new Set<string>(),handoffs:new ServerRunTerminalHandoffs()}};
    const beforeFetch=globalThis.fetch;globalThis.fetch=async()=>Response.json({ok:true});
    try {
      const pending=checkpointAutoAppliedTurn(turn,(async(_id:string,next:Doc)=>{if(++calls===1){entered.resolve();await release.promise;}saved=next;return {saved:true};}) as never,async()=>saved).then(()=>false,()=>true);
      await entered.promise;
      if(terminal==='project-switch') {
        const other=makeDraft(doc);other.commands.renameTimeline('tl','other project');
        turn.state.ctxRef.current={...ctx,commands:other.commands,getDoc:other.getDoc,getState:other.getState,getProjectId:()=> 'other-project'};
      }
      if(terminal==='abandon' || terminal==='project-switch')await abandonServerRun(turn.projectId,turn.runId,ref);
      else await finishServerRun(turn.projectId,{runId:turn.runId,status:terminal,assistantText:'stopped'},ref);
      assert.equal(controller.signal.aborted,true,'terminal settlement must abort the checkpoint controller, not just detach the UI');
      release.resolve();assert.equal(await pending,true);
      assert.deepEqual(saved,doc,'the save finishing after termination must restore the last committed sequence');
      assert.deepEqual(live.getDoc(),doc,'no late edit may be applied after termination');
    } finally {release.resolve();globalThis.fetch=beforeFetch;}
  }

  // A user update can be published in the microtask gap after the async
  // post-save guard. The final synchronous compare/apply must preserve it.
  {
    const live=makeDraft(doc),scratch=makeDraft(doc);scratch.commands.addTextClip({text:'agent'});
    let reads=0,saved=doc;
    const ctx={commands:live.commands,getDoc:()=>{const current=live.getDoc();if(++reads===3)queueMicrotask(()=>live.commands.addTextClip({text:'user'}));return current;},getState:live.getState,getCreativeMode:()=>null,getApprovalMode:()=> 'auto' as const,templates:[],audio:[]};
    const turn={projectId:'post-save-race',assistantText:'fixture',askOnly:false,baseDoc:doc,proposalBaseDoc:doc,draft:scratch,ops:[{actions:scratch.takeActions()}],persistentOps:[],abortController:new AbortController(),draftInvalidated:false,persistentSnapshot:Promise.resolve(),
      state:{ctxRef:{current:ctx},llmProviderRef:{current:'openai'},setChangeLog:()=>{},setMessages:()=>{}}} as unknown as import('../../src/agent/useAgentRun').AgentTurn;
    await assert.rejects(checkpointAutoAppliedTurn(turn,(async(_id:string,next:Doc)=>{saved=next;return {saved:true};}) as never,async()=>saved),/not committed/);
    assert.deepEqual(live.getDoc().timelines[0].items.map(i=>i.props?.text),['user']);
    assert.deepEqual(saved.timelines[0].items.map(i=>i.props?.text),['user'],'the saved project must retain the intervening user edit');
  }

  // A NEW file adapter after dropping every cache must read the committed edit.
  // This cannot pass by reading a live draft or a cached project object.
  const fs=await import('node:fs/promises'), os=await import('node:os'), path=await import('node:path');
  const {configureSharedKvBackend}=await import('../../src/persist/sharedKv');
  const {resetProjectStoreMemory}=await import('../../src/persist/projectStore');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'editing-checkpoint-cold-'));
  const backend=()=>({
    get:async <T>(key:string)=>{try{return JSON.parse(await fs.readFile(path.join(root,encodeURIComponent(key)), 'utf8')) as T;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}},
    set:async(key:string,value:unknown)=>{await fs.writeFile(path.join(root,encodeURIComponent(key)),JSON.stringify(value));},
    delete:async(key:string)=>{await fs.rm(path.join(root,encodeURIComponent(key)),{force:true});},
    keys:async()=> (await fs.readdir(root)).map(decodeURIComponent),
    writeAgentRuntime:async()=>{throw new Error('No runtime write expected');},
    updateAgentRunLease:async()=>{throw new Error('No lease write expected');},
  });
  try {
    configureSharedKvBackend(backend());
    const live=makeDraft(doc), scratch=makeDraft(doc);scratch.commands.addTextClip({text:'survives cold load'});
    const ctx={commands:live.commands,getDoc:live.getDoc,getState:live.getState,getCreativeMode:()=>null,getApprovalMode:()=> 'auto' as const,templates:[],audio:[]};
    const turn={projectId:'file-checkpoint',assistantText:'fixture',askOnly:false,baseDoc:doc,proposalBaseDoc:doc,draft:scratch,ops:[{actions:scratch.takeActions()}],persistentOps:[],
      abortController:new AbortController(),draftInvalidated:false,persistentSnapshot:Promise.resolve(),
      state:{ctxRef:{current:ctx},llmProviderRef:{current:'openai'},setChangeLog:()=>{},setMessages:()=>{}}} as unknown as import('../../src/agent/useAgentRun').AgentTurn;
    const began=performance.now();
    await checkpointAutoAppliedTurn(turn);
    resetProjectStoreMemory();configureSharedKvBackend(backend());
    const cold=await loadProject('file-checkpoint');
    assert.equal(cold!.timelines[0].items.length,1);
    assert.equal(cold!.timelines[0].items[0].props?.text,'survives cold load');
    console.log(`file-backed checkpoint and cache-free reload: ${Math.round(performance.now()-began)}ms`);
  } finally {configureSharedKvBackend(undefined);await fs.rm(root,{recursive:true,force:true});}

  // A committed-but-unconfirmed checkpoint cannot rewind the executor's
  // private draft when the callback reports failure to the model.
  for (const durableCheckpoint of [true,false]) {
    const {ServerRunToolExecutor}=await import('../../src/agent/serverRunToolExecutor');
    const {FakeLockManager,MemoryStorage}=await import('../../src/agent/serverRunToolExecutor.verify-helpers');
    const {saveStoredServerRun}=await import('../../src/agent/serverRunSessionStorage');
    const {replayActions}=await import('../../src/editor/store');
    const descriptor=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
    const beforeFetch=globalThis.fetch, live=makeDraft(doc);
    Object.defineProperty(globalThis,'localStorage',{value:new MemoryStorage(),configurable:true});
    const responses:Record<string,unknown>[]=[];
    try {
      assert(saveStoredServerRun('host-readback-failure',{projectId:'host-readback-failure',runId:'run-readback',attempts:[]}));
      let applied=false;
      const executor=new ServerRunToolExecutor('host-readback-failure',{
        ctx:()=>({commands:live.commands,getDoc:live.getDoc,getState:live.getState,getCreativeMode:()=>null,templates:[],audio:[]}),settings:()=>({} as never),
        onToolAction:action=>{
          if(action.name!=='manage_timelines')return;
          if(!applied && durableCheckpoint){live.commands.applyDoc(replayActions(live.getDoc(),action.actions));applied=true;}
          throw Object.assign(new Error('checkpoint readback unavailable'),{code:durableCheckpoint?'editing_checkpoint_readback_failed':'editing_checkpoint_commit_failed'});
        },updateMessages:()=>{},setLiveTool:()=>{},retryStream:()=>{},abandonRecovery:()=>{},
      },new FakeLockManager());
      executor.start({capability:'fixture',baseDoc:doc,activation:new ToolActivation(TOOL_SCHEMAS,[]),runId:'run-readback',abort:new AbortController(),recovered:new Map()});
      globalThis.fetch=async (url,init)=>{
        if(String(url).endsWith('/tool-claim'))return Response.json({claimed:true,outcome:'claimed'});
        if(String(url).endsWith('/tool-result')){responses.push(JSON.parse(String(init?.body)));return Response.json({ok:true,outcome:'accepted'});}
        throw new Error(`unexpected fixture request ${String(url)}`);
      };
      await executor.handle('run-readback','edit','manage_timelines',{action:'update',timelineId:'tl',name:'durable rename'},'edit-digest',()=>true);
      assert.match(String(responses.at(-1)!.error),/readback/,'unknown readback is never success');
      await executor.handle('run-readback','read','read_project',{view:'timeline'},'read-digest',()=>true);
      const read=responses.at(-1)!.result as {timeline:{name:string}};
      assert.equal(read.timeline.name,'durable rename','a checkpoint error must keep the host and journal on the same document');
      assert.equal(live.getDoc().timelines[0].name,durableCheckpoint?'durable rename':'fixture','retained draft is not mislabeled as committed');
    } finally {globalThis.fetch=beforeFetch;if(descriptor)Object.defineProperty(globalThis,'localStorage',descriptor);else Reflect.deleteProperty(globalThis,'localStorage');}
  }

  const planned=structuredClone(doc) as Doc;
  planned.assets=[{id:'source',kind:'video',name:'source',src:'/source.mp4',durationInFrames:300,sourceContentHash:'a'.repeat(64)}];
  planned.clipMentorAnalysis={schema_version:1,analysis_id:'fixture',revision:1,source:{asset_id:'source',sourceContentHash:'a'.repeat(64),duration_seconds:10,fps:30},product:{name:'fixture',category:'fixture'},import_origin:'fixture',points:[],transcripts:[],reviews:[],audit:[],
    evidence:[{evidence_id:'E',kind:'source_frame',text:'fixture',status:'historical_unknown',supporting_evidence_ids:[],source_ids:[],time_seconds:2,source_frame:60,observation_method:'fixture',call_status:'historical_unknown'}],
    source_breakdown:{version:1,segments:[{segment_id:'S',source_range_seconds:[0,10],visible_evidence_ids:['E'],claim_evidence_ids:[],interpretation_evidence_ids:[],unknowns:[]}],points:[{point_id:'P',segment_ids:['S'],buying_concern:'detail',teaching_question:'Why a close view?',filming_conditions:['detail visible'],role:'primary',importance:'must_explain'}],units:[{unit_id:'U',original_segment_ids:['S'],explanation_segment_ids:['S'],coverage:[{point_id:'P',treatment:'explain'}],revisits:[{from_segment_id:'S',to_segment_id:'S',reason:'revisit'}]}]},
    blueprint:[{unit_id:'U',point_ids:['P'],intent_zh:'fixture',line_guidance:'',internal_review:{current_script_candidate:'copy',current_picture_plan:'plan',
      copy:{lines:[{id:'L',point_ids:['P'],narration_ms:'fixture',caption_lines:['fixture'],zh:'fixture',source_seconds:[0,10],labels:[]}]},
      plan:{script_candidate_id:'copy',phases:[{line_id:'L',source_seconds:[0,10],context_source_ranges:[]}],composition:{detail:JSON.stringify({production_rows:[
        {row_id:'original',unit_id:'U',kind:'original',source_asset_id:'source',source_frames:[0,300],output_frames_reference:[0,300],line_ids:[]},
        {row_id:'detail-a',unit_id:'U',kind:'explanation',source_asset_id:'source',source_frames:[60,90],output_frames_reference:[300,330],line_ids:['L']},
        {row_id:'detail-b',unit_id:'U',kind:'explanation',source_asset_id:'source',source_frames:[180,210],output_frames_reference:[330,360],line_ids:['L']}
      ]})}}} } as never]};
  const clip=(id:string,startFrame:number,srcInFrame:number,durationInFrames:number)=>({id,kind:'video' as const,src:'/source.mp4',sourceAssetId:'source',track:'V1',name:id,startFrame,srcInFrame,durationInFrames});
  planned.timelines[0].items=[clip('original',0,0,300),clip('a',300,60,30),clip('b',330,180,30)];
  assert.equal(checkSourceBreakdown(planned,true).status,'structurally_ready','approved selected ranges need not replay entire evidence segments or rewrite analysis placement');
  for(const [name,mutate] of [
    ['wrong-object-order',(d:Doc)=>{d.timelines[0].items[1].srcInFrame=180;d.timelines[0].items[2].srcInFrame=60;}],
    ['missing-picture',(d:Doc)=>{d.timelines[0].items.pop();}],
    ['wrong-asset',(d:Doc)=>{d.timelines[0].items[1].sourceAssetId='other';}],
    ['slow-playback',(d:Doc)=>{d.timelines[0].items[1].playbackRate=0.5;}],
    ['array-kind',(d:Doc)=>{const p=(d.clipMentorAnalysis!.blueprint[0].internal_review as any).plan;const rows=JSON.parse(p.composition.detail);rows.production_rows[2].kind=['explanation'];p.composition.detail=JSON.stringify(rows);}],
    ['duplicate-line-reference',(d:Doc)=>{const p=(d.clipMentorAnalysis!.blueprint[0].internal_review as any).plan;const rows=JSON.parse(p.composition.detail);rows.production_rows[2].line_ids=['L','L'];p.composition.detail=JSON.stringify(rows);}],
    ['legacy-without-placement',(d:Doc)=>{const i=d.clipMentorAnalysis!.blueprint[0].internal_review as Record<string,any>;delete i.plan.composition;}],
  ] as const) {const wrong=structuredClone(planned);mutate(wrong);assert.equal(checkSourceBreakdown(wrong,true).status,'review_required',name);}
  const split=structuredClone(planned);split.timelines[0].items.splice(1,1,clip('a1',300,60,15),clip('a2',315,75,15));
  assert.equal(checkSourceBreakdown(split,true).status,'structurally_ready','ordinary cuts preserve frame-to-row correspondence');
  const shared=structuredClone(planned);
  const si=shared.clipMentorAnalysis!.blueprint[0].internal_review as any;
  si.copy.lines.push({...structuredClone(si.copy.lines[0]),id:'L2'});
  si.plan.phases.push({...structuredClone(si.plan.phases[0]),line_id:'L2'});
  const sharedRows=JSON.parse(si.plan.composition.detail);sharedRows.production_rows[1].line_ids.push('L2');si.plan.composition.detail=JSON.stringify(sharedRows);
  assert.equal(checkSourceBreakdown(shared,true).status,'structurally_ready','two lines can legitimately use the same visible object');
  const separate=structuredClone(shared),sa=separate.clipMentorAnalysis!,sb=sa.source_breakdown!,sbi=sa.blueprint[0].internal_review as any;
  sb.segments[0].source_range_seconds=[0,5];sb.segments.push({...structuredClone(sb.segments[0]),segment_id:'S2',source_range_seconds:[5,10],visible_evidence_ids:['E2']});
  sa.evidence.push({...structuredClone(sa.evidence[0]),evidence_id:'E2',time_seconds:7,source_frame:210});
  sb.points.push({...structuredClone(sb.points[0]),point_id:'P2',segment_ids:['S2']});
  Object.assign(sb.units[0],{original_segment_ids:['S','S2'],original_source_ranges:[[0,10]],explanation_segment_ids:['S','S2'],revisits:[{from_segment_id:'S2',to_segment_id:'S',reason:'revisit both objects'}]});
  sb.units[0].coverage.push({point_id:'P2',treatment:'explain'});
  sbi.copy.lines[0].source_seconds=[0,5];sbi.plan.phases[0].source_seconds=[0,5];
  Object.assign(sbi.copy.lines[1],{point_ids:['P2'],source_seconds:[5,10]});sbi.plan.phases[1].source_seconds=[5,10];
  const rows=JSON.parse(sbi.plan.composition.detail);rows.production_rows.pop();sbi.plan.composition.detail=JSON.stringify(rows);separate.timelines[0].items.pop();
  assert(checkSourceBreakdown(separate,true).issues.some(i=>i.code==='timeline_plan_line_picture_missing'),'one line cannot borrow another object through the group evidence union');
  // A single continuous row containing both objects remains valid.
  rows.production_rows[1].source_frames=[0,300];rows.production_rows[1].output_frames_reference=[300,600];sbi.plan.composition.detail=JSON.stringify(rows);
  Object.assign(separate.timelines[0].items[1],{srcInFrame:0,durationInFrames:300});
  assert.equal(checkSourceBreakdown(separate,true).status,'structurally_ready','a real group view may carry several lines and objects');
  console.log('editing checkpoints / manual boundary / cold read / failed export / selected source rows passed (zero providers)');
}

// The native run has a total ceiling even when no production host is attached.
{
  const {executeRun}=await import('./executor');
  const run=makeRun();run.createdAt=Date.now()-30*60_000-1;
  await executeRun(run,{backend:'codex',model:'mock',messages:[],tools:[]} as never);
  assert.equal(run.status,'failed');assert.match(run.error??'',/deadline exceeded/i);
}
console.log('server Codex turn and execution regression suite passed');
