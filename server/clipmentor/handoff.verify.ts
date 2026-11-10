import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createServer} from 'node:http';import {once} from 'node:events';
import type {ProjectDoc} from '../../src/editor/types';
const root=await mkdtemp(join(tmpdir(),'clipmentor-handoff-'));process.env.OPENCHATCUT_DATA_DIR=root;
const {withSerializedProjectStore,getStoredEntry,setStoredEntry,deleteStoredEntry,mergeStoredEntries}=await import('../plugins/project-store');
const {loadOfflineStoredProject}=await import('../external-agent/offline-project-store');
const {activateOfflineAgentRuntimeBackend}=await import('../external-agent/agent-runtime-persistence');activateOfflineAgentRuntimeBackend();
const {agentRunsPlugin}=await import('../agent-runs/routes');const {createMiniConnect}=await import('../../desktop/mini-connect');
const {parseHandoffBrief,handoffToolAccess,HANDOFF_TEMPLATE_VERSION}=await import('../../shared/clipmentor-handoff');
const {copyReviewSubject,clipMentorProductionBlock}=await import('../../src/clipmentor/production-gate');
const {checkSourceBreakdown}=await import('../../src/clipmentor/source-breakdown');
const {assertRunHandoff,assertHandoffInput,reserveHandoff,readHandoffPolicy,handoffRunKey,recordHandoffDispatch}=await import('./handoff');
const {getRun,cancelRun,flushRunPersistence}=await import('../agent-runs/store');
const {loadAgentArtifact}=await import('../../src/persist/agentRuntimeStore');
const {makeDraft}=await import('../../src/editor/store');const {clipMentorHandoffBlock}=await import('../../src/clipmentor/handoff-guard');
const {isProjectStoreRequest,projectIdFromProjectStoreKey}=await import('../../shared/project-store-validation');
let modelNetworkCalls=0;const originalFetch=globalThis.fetch;
const fixture:ProjectDoc={version:3,assets:[{id:'source',name:'Synthetic source',kind:'video',src:'/media/test.mp4',durationInFrames:300,sourceContentHash:'a'.repeat(64)}],mediaFolders:[],activeTimelineId:'tl',
 timelines:[{id:'tl',name:'test',order:0,fps:30,width:576,height:1024,items:[],selectedId:null,tracks:{V1:{kind:'video'}},trackOrder:['V1']}],
 clipMentorAnalysis:{schema_version:1,analysis_id:'fixture',revision:1,source:{asset_id:'source',sourceContentHash:'a'.repeat(64),duration_seconds:10,fps:30},product:{name:'Synthetic product',category:'test'},import_origin:'synthetic_test',points:[],transcripts:[],reviews:[],audit:[],
  evidence:[{evidence_id:'F1',kind:'source_frame',text:'Synthetic example',status:'historical_unknown',supporting_evidence_ids:[],source_ids:[],time_seconds:1,source_frame:30,observation_method:'fixture',call_status:'historical_unknown'}],
  blueprint:[{unit_id:'U1',point_ids:['P1'],intent_zh:'Synthetic teaching relationship',line_guidance:'',internal_review:{current_script_candidate:'copy',current_picture_plan:'picture',
   copy:{lines:[{id:'L1',point_ids:['P1'],narration_ms:'Dekat untuk melihat butiran.',caption_lines:['Dekat untuk melihat butiran.'],zh:'近看细节。',source_seconds:[0,2],labels:[]}]},
   picture:{script_candidate_id:'copy',source_range:[0,2],composition:'Synthetic close-up',viewer_stage_cues:{layout:{original:'full',revisit:'close-up',safe_area:'bottom'},original:{text:'Video asal',enter:'start',exit:'end'},revisit:[{line_ids:['L1'],text:'Ulang lihat',enter:'start explanation',exit:'end explanation'}],handoff:'Clearly labeled revisit'},phases:[{line_id:'L1',source_seconds:[0,2],picture:'Synthetic close-up',purpose:'Detail'}]}}} as never],
  source_breakdown:{version:1,segments:[{segment_id:'S1',source_range_seconds:[0,2],visible_evidence_ids:['F1'],claim_evidence_ids:[],interpretation_evidence_ids:[],unknowns:[]}],
   points:[{point_id:'P1',segment_ids:['S1'],buying_concern:'Synthetic detail',teaching_question:'What detail becomes visible?',role:'primary',importance:'must_explain',filming_conditions:['Close-up']}],
   units:[{unit_id:'U1',original_segment_ids:['S1'],original_source_ranges:[[0,2]],explanation_segment_ids:['S1'],coverage:[{point_id:'P1',treatment:'explain'}],revisits:[{from_segment_id:'S1',to_segment_id:'S1',reason:'Synthetic explicit revisit'}]}]}}};
const projectId='handoff-positive';
await withSerializedProjectStore(s=>s.writeEntry(`project:${projectId}`,fixture));
const snapshot=(await loadOfflineStoredProject(projectId))!;assert(snapshot);
assert.equal(checkSourceBreakdown(snapshot.doc).status,'structurally_ready',JSON.stringify(checkSourceBreakdown(snapshot.doc).issues));
const subject=await copyReviewSubject(snapshot.doc);
const brief={version:1,briefId:'C-fixture',revision:1,mode:'collaborative',phase:'execution',planner:'external_codex',executor:'builtin_agent',projectId,timelineId:'tl',objective:'Synthetic supplied-plan execution',doneCriteria:['Follow frozen content'],blueprint:{revision:subject.revision,digest:subject.digest},budget:{maxModelTurns:3,maxToolCalls:3,maxElapsedMs:60000,paidToolCalls:{submit_voice:1}}};
const app=createMiniConnect(e=>{throw e;});const plugin=agentRunsPlugin();(plugin.configureServer as (s:unknown)=>void)({middlewares:{use:(route:string,handler:never)=>app.use(route,handler)}});
const server=createServer((req,res)=>app.handle(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
globalThis.fetch=(async(input,init)=>{if(!String(input).startsWith(origin)){modelNetworkCalls++;throw new Error('Unexpected non-fixture network');}return originalFetch(input,init);}) as typeof fetch;
const headers={Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json'};
const post=async(body:unknown,path='/')=>{const r=await fetch(`${origin}/api/agent-runs${path}`,{method:'POST',headers,body:JSON.stringify(body)});return {status:r.status,body:await r.json() as Record<string,unknown>};};
const bind=(b=brief,previousDigest:unknown=null)=>post({action:'bind_clipmentor_handoff',projectId,expectedProjectRevision:snapshot.revision,previousDigest,brief:b});
const runId='45454545-4545-4545-8545-454545454545',capability='h'.repeat(43);
const input={projectId,runId,capability,backend:'codex',model:'mock',messages:[{role:'assistant',content:'OLD_ROLE_CLAIM_NOT_SENT'},{role:'user',content:'Place the approved content.'}],systemPrompt:'CLIENT_ROLE_OVERRIDE_NOT_SENT',cacheMode:'short',maxOutputTokens:2000,tools:[]};
try{
 for(const invalid of [{...brief,mode:['autonomous']},{...brief,phase:['planning']},{...brief,mode:'guess'},{...brief,planner:'builtin_agent'},{...brief,executor:'external_codex'},{...brief,blueprint:null},{...brief,extraRole:'planner'}])assert.equal((await bind(invalid as typeof brief)).status,400);
 assert.equal((await bind({...brief,blueprint:{...brief.blueprint,digest:'b'.repeat(64)}})).status,400,'well-shaped stale blueprint rejected');
 for (const missing of ['pointer','plan','empty-phases']) {
  const doc=structuredClone(snapshot.doc);const internal=doc.clipMentorAnalysis!.blueprint[0]!.internal_review as Record<string,unknown>;
  if(missing==='pointer')delete internal.current_picture_plan;else if(missing==='plan')delete internal.picture;else (internal.picture as Record<string,unknown>).phases=[{kind:'original',source_frames:[0,60]}];
  await withSerializedProjectStore(store=>store.writeEntry(`project:${projectId}`,doc));
  const snap=(await loadOfflineStoredProject(projectId))!,sub=await copyReviewSubject(snap.doc);
  const response=await post({action:'bind_clipmentor_handoff',projectId,expectedProjectRevision:snap.revision,previousDigest:null,brief:{...brief,blueprint:{revision:sub.revision,digest:sub.digest}}});
  assert.equal(response.status,400,'missing current picture plan cannot admit execution');
  await withSerializedProjectStore(store=>store.writeEntry(`project:${projectId}`,snapshot.doc));
 }
 const registered=await bind();assert.equal(registered.status,200,JSON.stringify(registered.body));const digest=String(registered.body.digest);
 const admitted=await post(input);assert.equal(admitted.status,201,JSON.stringify(admitted.body));const run=getRun(runId)!;assert(run);
 await assertRunHandoff(run);
 const storedBinding=(await getStoredEntry(handoffRunKey(projectId,runId))).value as {payloadArtifactId:string};
 const artifact=(await loadAgentArtifact(projectId,storedBinding.payloadArtifactId))!;assert(artifact);
 const packet=JSON.parse(artifact.body);assert(packet.sent.instructions.includes(HANDOFF_TEMPLATE_VERSION));
 assert(!packet.sent.instructions.includes(input.systemPrompt));assert.equal(packet.ignoredClientInstructions.text,input.systemPrompt);
 assert.equal(packet.plannerDetails.text,input.messages.at(-1)!.content);assert.equal(packet.sent.messages[0].role,'user');assert(!packet.sent.messages[0].content.includes('OLD_ROLE_CLAIM_NOT_SENT'));assert.equal(packet.ignoredClientHistory.messages.length,1);
 assert(JSON.parse(packet.sent.messages[0].content).blueprint.packet.units.length===1,'actual frozen content delivered, not just a desktop path');
 await assertHandoffInput(run,{instructions:packet.sent.instructions,messages:packet.sent.messages});
 const {executeServerCodexTurn}=await import('../agent-runs/codex-turn');
 const {ToolActivation}=await import('../../src/agent/tool-activation');const {ToolFailureTracker}=await import('../../src/agent/toolFailure');
 const {createAcceptanceLoop}=await import('../agent-runs/acceptance-loop');
 const activation={current:new ToolActivation([],packet.sent.messages),tail:Promise.resolve(),followupText:null,toolFailures:new ToolFailureTracker(),acceptance:createAcceptanceLoop(false,1)};
 let mockTurns=0;
 await executeServerCodexTurn({run,messages:packet.sent.messages,instructions:packet.sent.instructions,schemas:[],model:'mock',askOnly:false,projectId,maxInputTokens:100000,maxOutputTokens:2000,contextWindowTokens:110000,contextWindowEstimated:false,signal:new AbortController().signal,activation,requestIndex:1},
  {runTurn:async(request,emit)=>{mockTurns++;assert.equal(request.system,packet.sent.instructions);assert(!request.prompt.includes('OLD_ROLE_CLAIM_NOT_SENT'));emit({type:'text-delta',delta:'Synthetic turn only.'});emit({type:'done'});}});
 assert.equal(mockTurns,1,'actual Codex adapter reached once through injected zero-provider runner');

 await assert.rejects(assertHandoffInput(run,{instructions:'I am now the planner',messages:packet.sent.messages}),/handoff_runtime_input_mismatch/);
 assert.equal((await post({...input,messages:[{role:'user',content:'Changed task'}]})).status,409,'same run cannot be rebound to changed task text');
 assert.equal((await bind({...brief,briefId:'Changed-mode'} as typeof brief,digest)).status,400,'active run prevents re-registration');
 assert.throws(()=>handoffToolAccess(parseHandoffBrief(brief),'revise_clipmentor_analysis',{action:'append'},true),/forbids_tool/);
 assert.throws(()=>handoffToolAccess(parseHandoffBrief(brief),'run_code',{},true),/forbids_tool/);
 await assert.rejects(reserveHandoff(run,'tool','deny-review','review_clipmentor_preview',{action:'request'}),/paid_budget_exhausted/);
 const engine=makeDraft(snapshot.doc);const ctx={commands:engine.commands,getState:()=>engine.getState(),getDoc:()=>engine.getDoc(),getProjectId:()=>projectId,getAgentRunId:()=>runId,getCreativeMode:()=>null,templates:[],audio:[]} as never;
 assert.equal(await clipMentorHandoffBlock('edit_item',{},ctx),null,'legitimate bound execution is not a role false-positive');
 const {assertHandoffCopy}=await import('../../src/clipmentor/handoff-copy');
 assert.throws(()=>assertHandoffCopy('update_item_props',{props:{text:'UNAPPROVED REPLACEMENT'}},ctx),/text_not_frozen/);
 assert.throws(()=>assertHandoffCopy('edit_item',{updates:[{itemId:'one',props:{text:'UNAPPROVED REPLACEMENT'}}]},ctx),/text_not_frozen/);
 for(const text of [['UNAPPROVED REPLACEMENT'],{value:'replacement'},null,1])assert.throws(()=>assertHandoffCopy('update_item_props',{props:{text}},ctx),/text_not_frozen/);
 assert.doesNotThrow(()=>assertHandoffCopy('edit_item',{adds:[{type:'text',text:'Dekat untuk melihat butiran.'}]},ctx));
 assert.doesNotThrow(()=>assertHandoffCopy('update_item_props',{props:{fontSize:24,color:'#fff'}},ctx));
 { // Replay layered-opening exact text through the same copy guard. These are
 // structured frozen visual strings, not caption rewrites or author notes.
 const {default:bookends}=await import('../../src/agent/tools/fixtures/barely-there-bookend-replacement-20261029.json');
 const visualDoc=structuredClone(bookends.before) as unknown as ProjectDoc;
 const ir=(visualDoc.clipMentorAnalysis!.blueprint[0] as any).internal_review;
 const section=ir[ir.current_picture_plan].delivery_sections.find((s:any)=>s.kind==='performance_opening');
 const video=visualDoc.assets.find(a=>a.kind==='video')!;
 section.picture.layout={kind:'original_underlay',source:{asset_id:video.id,src:video.src,sha256:video.sourceContentHash},range:[0,10],shade:0.63,show_sales:true,
  headline:['JUDYDOLL','339.32k tontonan','≈ RM5,310 jualan'],transition:['Produk yang sama.','Kenapa video ini?','Jom tengok cara dia rakam.']};
 const visualCtx={...ctx as object,getDoc:()=>visualDoc} as never;
 for(const text of [...section.picture.layout.headline,...section.picture.layout.transition,
  section.picture.layout.headline.join('\n'),section.picture.layout.transition.join('\n')])
  assert.doesNotThrow(()=>assertHandoffCopy('edit_item',{adds:[{type:'text',text}]},visualCtx),'frozen visual text is executable');
 for(const text of ['339.33k tontonan','JUDYDOLL\nUNAPPROVED REPLACEMENT',section.picture.layout.headline.slice().reverse().join('\n'),
  section.picture.layout.headline.concat(section.picture.layout.transition).join('\n')])
  assert.throws(()=>assertHandoffCopy('edit_item',{adds:[{type:'text',text}]},visualCtx),/text_not_frozen/,'no arbitrary recombination or new claims');
 const replaced=structuredClone(visualDoc),nextIR=(replaced.clipMentorAnalysis!.blueprint[0] as any).internal_review;
 nextIR.current_picture_plan='picture_replacement';nextIR.picture_replacement={...nextIR[ir.current_picture_plan]};delete nextIR.picture_replacement.delivery_sections;
 assert.throws(()=>assertHandoffCopy('edit_item',{adds:[{type:'text',text:'339.32k tontonan'}]},{...visualCtx as object,getDoc:()=>replaced} as never),/text_not_frozen/,'old plan strings do not remain executable');

 }
 const captionDoc=structuredClone(snapshot.doc);captionDoc.timelines[0]!.captions={enabled:true,template:'plain',pacing:'phrase',words:[{text:'Dekat',start:0,end:100},{text:'untuk',start:100,end:200},{text:'melihat',start:200,end:300},{text:'butiran.',start:300,end:400}]};
 const captionEngine=makeDraft(captionDoc);
 const captionCtx={...ctx as object,commands:captionEngine.commands,getState:()=>captionEngine.getState(),getDoc:()=>captionEngine.getDoc()} as never;
 assert.throws(()=>assertHandoffCopy('edit_captions',{action:'display_text',json:JSON.stringify({overrides:[{wordIndex:0,text:'UNAPPROVED REPLACEMENT'}]})},captionCtx),/text_not_frozen/);
 assert.doesNotThrow(()=>assertHandoffCopy('edit_captions',{action:'display_text',json:JSON.stringify({overrides:[{wordIndex:0,forceBreak:true}]})},captionCtx));
 const {allowImplicitVision}=await import('../../src/agent/vision');assert.equal(await allowImplicitVision(projectId),false);assert.equal(await allowImplicitVision('ordinary-project'),true);
 const {executeServerTurn}=await import('../agent-runs/executor'); const {APICallError}=await import('ai');
 let attempts=0; const overflow=new APICallError({message:'overflow',url:'https://fixture.invalid',requestBodyValues:{},statusCode:400,responseBody:'maximum context length exceeded'});
 const turnInput={run,signal:new AbortController().signal,requestIndex:1} as Parameters<typeof executeServerTurn>[0];
 await assert.rejects(executeServerTurn(turnInput,async()=>{attempts++;throw overflow;}),/overflow/);assert.equal(attempts,1,'protected inner context overflow cannot retry');
 const ordinaryRun={...run,projectId:'ordinary-overflow'};attempts=0;
 await executeServerTurn({...turnInput,run:ordinaryRun},async()=>{attempts++;if(attempts===1)throw overflow;return {messages:[],text:'ok',continued:false,followupText:null,hitMaxTokens:false};});
 assert.equal(attempts,2,'ordinary context compaction recovery unchanged');
 const {createProjectDocumentStoreOperation}=await import('../plugins/project-store-project-document');
 const mutation=structuredClone(snapshot.doc);mutation.clipMentorAnalysis!.revision++;
 const writer=createProjectDocumentStoreOperation(work=>withSerializedProjectStore(work));
 await assert.rejects(writer({operation:'project-document-write',key:`project:${projectId}`,value:mutation,expectedRevision:snapshot.revision,ownerId:'fixture',ownershipEpoch:1}),/execution_cannot_change_blueprint/,'late planner persistence rechecks current policy inside store lock');
 assert.equal((await copyReviewSubject((await loadOfflineStoredProject(projectId))!.doc)).digest,subject.digest,'denied concurrent save leaves frozen project unchanged');

 assert((await clipMentorProductionBlock('edit_item',{},ctx))?.production_gate.allowed===false,'handoff admission does not bypass the existing independent review gate');
 assert((await clipMentorHandoffBlock('revise_clipmentor_analysis',{action:'append'},ctx))?.error.includes('forbids_tool'));
 const externalCtx={...ctx as object,getAgentRunId:()=>''} as never;
 assert((await clipMentorHandoffBlock('edit_item',{},externalCtx))?.error,'unbound external/browser mutation cannot bypass role restriction');
 assert.equal(await clipMentorHandoffBlock('read_project',{},externalCtx),null,'read-only diagnosis remains available');
 assert((await clipMentorHandoffBlock('edit_item',{timelineId:'another'},ctx))?.error.includes('timeline_mismatch'));
 await assert.rejects(reserveHandoff(run,'tool',undefined,'submit_voice',{}),/tool_call_id_required/);
 await reserveHandoff(run,'tool','x'.repeat(301),'edit_item',{});assert((await readHandoffPolicy(projectId))!.callIds.every(id=>id.length<=300),'upstream IDs never poison persisted policy');
 await assert.rejects(reserveHandoff(run,'tool','x'.repeat(301),'edit_item',{}),/already_attempted/);
 await reserveHandoff(run,'tool','voice-1','submit_voice',{});
 await assert.rejects(reserveHandoff(run,'tool','voice-1','submit_voice',{}),/already_attempted/);
 await assert.rejects(reserveHandoff(run,'tool','voice-2','submit_voice',{}),/paid_budget_exhausted/);
 await reserveHandoff(run,'tool','edit-1','edit_item',{});
 await assert.rejects(reserveHandoff(run,'tool','edit-2','edit_item',{}),/tool_budget_exhausted/);
 await recordHandoffDispatch(run,'author',{system:packet.sent.instructions,prompt:packet.sent.messages});
 const used=(await readHandoffPolicy(projectId))!;assert.equal(used.modelTurns,2);assert.equal(used.paidCalls.submit_voice,1);
 for(const key of [`clipmentor-handoff:${projectId}`,handoffRunKey(projectId,runId)]){
  await assert.rejects(setStoredEntry(key,{}),/server-managed/);await assert.rejects(deleteStoredEntry(key),/server-managed/);
  assert(!isProjectStoreRequest({operation:'set',key,value:{}}));assert(!isProjectStoreRequest({operation:'delete',key}));
  assert.equal(projectIdFromProjectStoreKey(key),projectId);
 }
 const before=JSON.stringify((await getStoredEntry(`clipmentor-handoff:${projectId}`)).value);
 await mergeStoredEntries({[`clipmentor-handoff:${projectId}`]:{bypass:true}});
 assert.equal(JSON.stringify((await getStoredEntry(`clipmentor-handoff:${projectId}`)).value),before,'generic merge cannot replace server policy');
 const changed=structuredClone(snapshot.doc);changed.clipMentorAnalysis!.revision++;
 await withSerializedProjectStore(s=>s.writeEntry(`project:${projectId}`,changed));
 await assert.rejects(assertRunHandoff(run),/blueprint_changed/);
 const start=await fetch(`${origin}/api/agent-runs/${runId}/start`,{method:'POST',headers:{...headers,'x-openchatcut-run-capability':capability},body:JSON.stringify({projectId})});
 assert.equal(start.status,400,'change after admission is blocked before /start');
 await cancelRun(run);await flushRunPersistence(run);
 await withSerializedProjectStore(s=>s.writeEntry(`project:${projectId}`,snapshot.doc));
 const readmitted=await post({...input,runId:'46464646-4646-4646-8646-464646464646'});assert.equal(readmitted.status,201,'new run uses same binding and remaining quota');
 const run2=getRun('46464646-4646-4646-8646-464646464646')!;
 await assert.rejects(reserveHandoff(run2,'tool','new-voice','submit_voice',{}),/tool_budget_exhausted|paid_budget_exhausted/,'new run cannot reset task quota');
 await cancelRun(run2);await flushRunPersistence(run2);

 const terminal=(await getStoredEntry(handoffRunKey(projectId,run2.id))).value as {terminalStatus:string};assert.equal(terminal.terminalStatus,'cancelled');
 const {rotateAgentSession}=await import('../plugins/project-store');const {resetServerRunStoreForTest}=await import('../agent-runs/store');
 const {patchAgentRun}=await import('../../src/persist/agentRuntimeStore');
 for(const id of [runId,run2.id]){await originalFetch(`${origin}/api/agent-runs/${id}/cancel`,{method:'POST',headers:{...headers,'x-openchatcut-run-capability':capability},body:JSON.stringify({projectId})});await patchAgentRun(projectId,id,{status:'aborted'});}
 await rotateAgentSession(projectId);resetServerRunStoreForTest();
 const rebound=await bind({...brief,briefId:'C-after-chat-clear'},digest);assert.equal(rebound.status,200,JSON.stringify(rebound.body));
 const ordinary=await post({...input,projectId:'ordinary-non-clipmentor',runId:'47474747-4747-4747-8747-474747474747'});assert.equal(ordinary.status,201,'ordinary unregistered tasks retain their behavior');
 await cancelRun(getRun('47474747-4747-4747-8747-474747474747')!);
 const visualProject='visual-fixture',visualDoc=structuredClone(snapshot.doc);
 visualDoc.assets[0].src='/media/uploads/synthetic-source.mp4';
 await setStoredEntry(`project:${visualProject}`,visualDoc);
 const visualSnapshot=(await loadOfflineStoredProject(visualProject))!;
 const visualSubject=await copyReviewSubject(visualSnapshot.doc);
 const criterion={id:'opening',quote:'  原片画面铺底。\n  ',question:'同屏能看到成绩吗？',layout:'unrepresented',pictureStage:'成绩截图',
  sectionId:'opening',reference:{assetId:'source',fileName:'NIUMO V7.mp4',seconds:1}};
 const planning={...brief,projectId:visualProject,phase:'planning',blueprint:null,doneCriteria:[criterion]};
 const visualBind=(b:unknown,previousDigest:unknown=null)=>post({action:'bind_clipmentor_handoff',projectId:visualProject,
  expectedProjectRevision:visualSnapshot.revision,previousDigest,brief:b});
 assert.equal((await visualBind({...planning,doneCriteria:[criterion,criterion]})).status,400);
 assert.equal((await visualBind({...planning,doneCriteria:[{...criterion,reference:{...criterion.reference,assetId:'missing'}}]})).status,400);
 const visualRegistered=await visualBind(planning);assert.equal(visualRegistered.status,200);
 const visualPolicy=await readHandoffPolicy(visualProject);assert.deepEqual(visualPolicy?.brief.doneCriteria,[criterion]);
 const visualDispatch=await visualBind({...planning,phase:'execution',revision:2,
  blueprint:{revision:visualSubject.revision,digest:visualSubject.digest}},visualRegistered.body.digest);
 assert.equal(visualDispatch.status,400);assert.match(JSON.stringify(visualDispatch.body),/criterion_unresolved/);
 const {boundVisualCriteria}=await import('./visual-done-criteria');
 const {acceptProductionTask}=await import('./production-task');
 const bound=boundVisualCriteria(visualPolicy)!;
 let accepted=0;
 const humanTask={input:{},projectId:visualProject,status:'awaiting_review',completed:{export:{artifact:{renderId:'fixture-render'}},self_check:{artifact:{visualCriteriaDigest:bound.digest}}}} as import('./production-task').ProductionTask;
 const acceptanceStore={save:async()=>{accepted++;},load:async()=>humanTask};
 await assert.rejects(acceptProductionTask(humanTask,true,acceptanceStore),/逐项/);
 await assert.rejects(acceptProductionTask(humanTask,true,acceptanceStore,{digest:'0'.repeat(64),confirmed:['opening']}),/逐项/);
 await assert.rejects(acceptProductionTask(humanTask,true,acceptanceStore,{digest:bound.digest,confirmed:['opening','opening']}),/逐项/);
 assert.equal(accepted,0);
 await assert.rejects(acceptProductionTask(humanTask,true,acceptanceStore,{digest:bound.digest,confirmed:['opening'],renderId:'old-render'}),/当前成片版本/);
 await acceptProductionTask(humanTask,true,acceptanceStore,{digest:bound.digest,confirmed:['opening'],renderId:'fixture-render'});
 assert.equal(accepted,1);
 assert.deepEqual(humanTask.visualAcceptance,{criteriaDigest:bound.digest,renderId:'fixture-render',confirmedIds:['opening']});
 assert.equal(modelNetworkCalls,0);
 console.log('handoff: real HTTP admission, mode/role/type/stale binding refusals, fixed generated control + separated planner data, immutable readback, role/old-review gates, cross-run budget, store protection, no ordinary-task false positive; zero provider calls');
}finally{
 globalThis.fetch=originalFetch;for(const id of [runId,'46464646-4646-4646-8646-464646464646','47474747-4747-4747-8747-474747474747']){const run=getRun(id);if(run){await originalFetch(`${origin}/api/agent-runs/${id}/cancel`,{method:'POST',headers:{...headers,'x-openchatcut-run-capability':capability},body:JSON.stringify({projectId:run.projectId})});await flushRunPersistence(run);}}
 server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});
}
