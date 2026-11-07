import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {executeRun} from './executor';
import {createRun,resetServerRunStoreForTest,flushServerRunPersistence,recoverServerRun,pushRunEvent} from './store';
import {canonicalServerRunToolCatalog,resolveServerRunToolCatalog} from './tool-policy';
import {runtimeEvent} from './store-values';
import {resetAgentRuntimeStoreMemory} from '../../src/persist/agentRuntimeStore';

const serverFrame=canonicalServerRunToolCatalog(false,true).find(t=>t.name==='save_clipmentor_source_frame')!;
assert(serverFrame,'server-owned catalog exposes the implemented tool');
assert(!canonicalServerRunToolCatalog(false).some(t=>t.name===serverFrame.name));
assert.throws(()=>resolveServerRunToolCatalog([serverFrame],false),/Non-canonical/,'browser cannot opt into a server-only capability');
assert.equal(resolveServerRunToolCatalog([serverFrame],false,true)[0].name,serverFrame.name);
assert(!canonicalServerRunToolCatalog(true,true).some(t=>t.name===serverFrame.name),'ask mode remains read-only');
resetAgentRuntimeStoreMemory();resetServerRunStoreForTest();
let requests=0,fail=false,failTool=false,throwTool=false,largeTool=false,toolCalls=0,reservations=0;
const server=createServer(async(req,res)=>{
 assert(req.url?.startsWith('/llm/'),'no real model endpoint is reachable');
 let raw='';for await(const part of req)raw+=part;
 const body=JSON.parse(raw);requests++;
 if(fail){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Injected API unavailable',type:'server_error'}}));return;}
 const hasTool=body.messages.some((m:{role:string})=>m.role==='tool');
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 const emit=(delta:unknown,finish_reason:string|null)=>res.write(`data: ${JSON.stringify({id:'fixture-chat',object:'chat.completion.chunk',created:0,model:'fixture',choices:[{index:0,delta,finish_reason}]})}\n\n`);
 if(hasTool){assert(JSON.stringify(body.messages).includes(largeTool?'read_agent_artifact':throwTool?'fixture host failure':failTool?'actual_source_binding_missing':'server-owned-read'));emit({role:'assistant',content:'Done.'},null);emit({},'stop');}
 else{emit({role:'assistant',tool_calls:[{index:0,id:'call_read',type:'function',function:{name:'read_project',arguments:'{}'}}]},null);emit({},'tool_calls');}
 res.end('data: [DONE]\n\n');
});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address==='object');
const schema=canonicalServerRunToolCatalog(false).find(t=>t.name==='read_project')!;
const input={backend:'api',provider:'openai',model:'fixture',openAiApiMode:'chat' as const,cacheMode:'short' as const,maxOutputTokens:1024,
 autonomousAcceptance:false,maxAcceptanceIterations:1,origin:`http://127.0.0.1:${address.port}`,tools:[schema],messages:[{role:'user' as const,content:'Read the current project and stop.'}],
 host:{maxTurns:3,deadlineAt:Date.now()+10000,async beforeRequest(){reservations++;},async execute(){toolCalls++;return failTool?{error:'Binding is incomplete',issues:[{code:'actual_source_binding_missing',point_id:'P1'}],production_gate:{allowed:false,code:'mapping_incomplete'}}:{summary:'server-owned-read',saved:true,projectId:'headless-api-fixture',projectRevision:'fixture-revision',apiKey:'fixture-secret',__images:[{frame:1,base64:'QUJDRA=='}],...(largeTool?{details:Array.from({length:300},(_,i)=>({id:i,text:'x'.repeat(120)}))}:{})};}}};
const run=()=>createRun({projectId:'headless-api-fixture',sessionGeneration:'legacy',backend:'api',provider:'openai',model:'fixture'});
try{
 const normal=run();await executeRun(normal,input);assert.equal(normal.status,'completed',normal.error);assert.equal(requests,2);assert.equal(toolCalls,1);assert.equal(reservations,2);
 assert(!normal.events.some(e=>e.type==='tool-request'),'no browser request is emitted');assert(normal.events.some(e=>e.type==='server-tool-request'));
 largeTool=true;const large=run();await executeRun(large,input);assert.equal(large.status,'completed',large.error);largeTool=false;
 const largeEvent=large.events.find(e=>e.type==='server-tool-result')!,largeReceipt=(largeEvent.data as any).result;
 assert.equal(largeReceipt.archived,true);assert(largeReceipt.artifactId);
 const {loadAgentArtifact}=await import('../../src/persist/agentRuntimeStore');
 const full=await loadAgentArtifact(large.projectId,largeReceipt.artifactId);assert(full);
 assert.equal(JSON.parse(full.body).details.length,300,'full receipt remains available rather than truncating into a successful summary');
 assert(!full.body.includes('fixture-secret'));assert(!full.body.includes('QUJDRA=='));
 const {execAgentRuntimeTool}=await import('../../src/agent/tools/agent-runtime-tools');
 const page=await execAgentRuntimeTool('read_agent_artifact',{artifactId:largeReceipt.artifactId,pointer:'/details/299',limit:4000},{getProjectId:()=>large.projectId} as any) as any;
 assert.equal(JSON.parse(page.content).id,299,'existing narrow reread entry accesses the omitted tail');
 const outcome=normal.events.find(e=>e.type==='server-tool-result')!;assert(outcome);
 const receipt=(outcome.data as any).result;assert.equal(receipt.projectRevision,'fixture-revision');assert.equal(receipt.saved,true);
 assert(!JSON.stringify(outcome).includes('fixture-secret'));assert(!JSON.stringify(outcome).includes('QUJDRA=='));
 assert.equal(runtimeEvent(outcome).type,'tool_outcome');assert.equal(runtimeEvent(outcome).outcome?.kind,'success');
 throwTool=true;const thrown=run();await executeRun(thrown,{...input,host:{...input.host,async execute(){throw Error('fixture host failure');}}});
 assert.equal(thrown.status,'failed');const thrownReceipt=thrown.events.find(e=>e.type==='server-tool-result')!;
 assert.match(JSON.stringify(thrownReceipt),/fixture host failure/);assert.equal(runtimeEvent(thrownReceipt).outcome?.kind,'outcome_unknown');throwTool=false;
 failTool=true;const refused=run();await executeRun(refused,input);assert.equal(refused.status,'failed');assert(refused.events.some(e=>e.type==='server-tool-diagnostic'&&JSON.stringify(e.data).includes('actual_source_binding_missing')),'machine-readable issue survives the host failure path');failTool=false;
 assert.equal(runtimeEvent(refused.events.find(e=>e.type==='server-tool-result')!).outcome?.kind,'terminal_failure');
 fail=true;requests=0;const failed=run();await executeRun(failed,input);assert.equal(failed.status,'failed');assert.equal(requests,1,'no automatic retry or desktop fallback');
 requests=0;const zero=run();await executeRun(zero,{...input,host:{...input.host,async beforeRequest(){throw Error('model budget exhausted');}}});assert.equal(zero.status,'failed');assert.equal(requests,0);
 const desktop=run();await executeRun(desktop,{...input,backend:'codex'});assert.equal(desktop.status,'failed');assert.match(desktop.error??'',/API backend/);assert.equal(requests,0);
 const wrongRun=run();await executeRun(wrongRun,{...input,backend:'codex',localProductionCodex:true});
 assert.match(wrongRun.error??'',/API backend/,'a run tagged API cannot use the local opt-in');
 const localRun=createRun({projectId:'headless-api-fixture',sessionGeneration:'legacy',backend:'codex',provider:'openai',model:'fixture'});
 let localReservations=0;
 await executeRun(localRun,{...input,backend:'codex',localProductionCodex:true,host:{...input.host,async beforeRequest(){localReservations++;throw Error('fixture stops before real Codex dispatch');}}});
 assert.equal(localReservations,1,'real run entry admits the explicit local host and reserves before dispatch');
 assert.match(localRun.error??'',/fixture stops before real Codex dispatch/);assert.equal(requests,0);
 const cancelled=run(),abort=new AbortController();abort.abort();await executeRun(cancelled,{...input,host:{...input.host,signal:abort.signal}});assert.equal(requests,0);
 const interrupted=run();pushRunEvent(interrupted,'server-tool-request',{toolCallId:'unknown-write',name:'edit_item',argsDigest:'fixture-digest'});
 await flushServerRunPersistence();resetServerRunStoreForTest();
 const restored=await recoverServerRun(normal.projectId,normal.id);assert(restored);
 const restoredOutcome=restored.events.find(e=>e.type==='server-tool-result')!;
 assert.equal((restoredOutcome.data as any).result.projectRevision,'fixture-revision','saved tool receipt survives server cold recovery');
 assert(!restored.events.some(e=>e.type==='server-tool-result'&&JSON.stringify(e.data).includes('interrupted')));
 const unknownRun=await recoverServerRun(interrupted.projectId,interrupted.id);assert(unknownRun);
 const unknownResult=unknownRun.events.find(e=>e.type==='server-tool-result')!;assert(unknownResult);
 assert.equal(runtimeEvent(unknownResult).outcome?.kind,'outcome_unknown','crash after dispatch does not prove the edit was rolled back');
 const restoredLarge=await recoverServerRun(large.projectId,large.id);assert(restoredLarge);
 assert.equal((restoredLarge.events.find(e=>e.type==='server-tool-result')!.data as any).result.artifactId,largeReceipt.artifactId);
 assert(await loadAgentArtifact(large.projectId,largeReceipt.artifactId),'large saved receipt still resolves after cold recovery');
 console.log('API author host: real SDK against local fake SSE, server-only tool round trip, per-request budget, failure without retry, zero-budget/cancel stop passed; zero provider calls');
}finally{await flushServerRunPersistence();await new Promise<void>(r=>server.close(()=>r()));resetServerRunStoreForTest();resetAgentRuntimeStoreMemory();}
