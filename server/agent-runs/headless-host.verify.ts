import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {executeRun} from './executor';
import {createRun,resetServerRunStoreForTest,flushServerRunPersistence} from './store';
import {canonicalServerRunToolCatalog,resolveServerRunToolCatalog} from './tool-policy';
import {resetAgentRuntimeStoreMemory} from '../../src/persist/agentRuntimeStore';

const serverFrame=canonicalServerRunToolCatalog(false,true).find(t=>t.name==='save_clipmentor_source_frame')!;
assert(serverFrame,'server-owned catalog exposes the implemented tool');
assert(!canonicalServerRunToolCatalog(false).some(t=>t.name===serverFrame.name));
assert.throws(()=>resolveServerRunToolCatalog([serverFrame],false),/Non-canonical/,'browser cannot opt into a server-only capability');
assert.equal(resolveServerRunToolCatalog([serverFrame],false,true)[0].name,serverFrame.name);
assert(!canonicalServerRunToolCatalog(true,true).some(t=>t.name===serverFrame.name),'ask mode remains read-only');
resetAgentRuntimeStoreMemory();resetServerRunStoreForTest();
let requests=0,fail=false,failTool=false,toolCalls=0,reservations=0;
const server=createServer(async(req,res)=>{
 assert(req.url?.startsWith('/llm/'),'no real model endpoint is reachable');
 let raw='';for await(const part of req)raw+=part;
 const body=JSON.parse(raw);requests++;
 if(fail){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Injected API unavailable',type:'server_error'}}));return;}
 const hasTool=body.messages.some((m:{role:string})=>m.role==='tool');
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 const emit=(delta:unknown,finish_reason:string|null)=>res.write(`data: ${JSON.stringify({id:'fixture-chat',object:'chat.completion.chunk',created:0,model:'fixture',choices:[{index:0,delta,finish_reason}]})}\n\n`);
 if(hasTool){assert(JSON.stringify(body.messages).includes(failTool?'actual_source_binding_missing':'server-owned-read'));emit({role:'assistant',content:'Done.'},null);emit({},'stop');}
 else{emit({role:'assistant',tool_calls:[{index:0,id:'call_read',type:'function',function:{name:'read_project',arguments:'{}'}}]},null);emit({},'tool_calls');}
 res.end('data: [DONE]\n\n');
});server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address==='object');
const schema=canonicalServerRunToolCatalog(false).find(t=>t.name==='read_project')!;
const input={backend:'api',provider:'openai',model:'fixture',openAiApiMode:'chat' as const,cacheMode:'short' as const,maxOutputTokens:1024,
 autonomousAcceptance:false,maxAcceptanceIterations:1,origin:`http://127.0.0.1:${address.port}`,tools:[schema],messages:[{role:'user' as const,content:'Read the current project and stop.'}],
 host:{maxTurns:3,deadlineAt:Date.now()+10000,async beforeRequest(){reservations++;},async execute(){toolCalls++;return failTool?{error:'Binding is incomplete',issues:[{code:'actual_source_binding_missing',point_id:'P1'}],production_gate:{allowed:false,code:'mapping_incomplete'}}:{summary:'server-owned-read'};}}};
const run=()=>createRun({projectId:'headless-api-fixture',sessionGeneration:'legacy',backend:'api',provider:'openai',model:'fixture'});
try{
 const normal=run();await executeRun(normal,input);assert.equal(normal.status,'completed',normal.error);assert.equal(requests,2);assert.equal(toolCalls,1);assert.equal(reservations,2);
 assert(!normal.events.some(e=>e.type==='tool-request'),'no browser request is emitted');assert(normal.events.some(e=>e.type==='server-tool-request'));
 failTool=true;const refused=run();await executeRun(refused,input);assert.equal(refused.status,'failed');assert(refused.events.some(e=>e.type==='server-tool-diagnostic'&&JSON.stringify(e.data).includes('actual_source_binding_missing')),'machine-readable issue survives the host failure path');failTool=false;
 fail=true;requests=0;const failed=run();await executeRun(failed,input);assert.equal(failed.status,'failed');assert.equal(requests,1,'no automatic retry or desktop fallback');
 requests=0;const zero=run();await executeRun(zero,{...input,host:{...input.host,async beforeRequest(){throw Error('model budget exhausted');}}});assert.equal(zero.status,'failed');assert.equal(requests,0);
 const desktop=run();await executeRun(desktop,{...input,backend:'codex'});assert.equal(desktop.status,'failed');assert.match(desktop.error??'',/API backend/);assert.equal(requests,0);
 const cancelled=run(),abort=new AbortController();abort.abort();await executeRun(cancelled,{...input,host:{...input.host,signal:abort.signal}});assert.equal(requests,0);
 console.log('API author host: real SDK against local fake SSE, server-only tool round trip, per-request budget, failure without retry, zero-budget/cancel stop passed; zero provider calls');
}finally{await flushServerRunPersistence();await new Promise<void>(r=>server.close(()=>r()));resetServerRunStoreForTest();resetAgentRuntimeStoreMemory();}
