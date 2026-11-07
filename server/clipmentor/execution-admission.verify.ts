import assert from 'node:assert/strict';
import {makeDraft} from '../../src/editor/store';
import {executeCodexTool} from '../../src/agent/runtime';
import {TOOL_SCHEMAS} from '../../src/agent/tools';
import {ToolActivation} from '../../src/agent/tool-activation';
import {DEFAULT_AGENT_SETTINGS} from '../../src/agent/settings/agentSettings';
import {ToolFailureTracker} from '../../src/agent/toolFailure';
import {createAcceptanceLoop} from '../agent-runs/acceptance-loop';
import {executeBrowserTool} from '../agent-runs/browser-tool';
import {eventBytes} from '../agent-runs/store-values';
import {MAX_SERVER_EVENT_BYTES,MAX_SERVER_TOOL_REQUEST_EVENT_BYTES} from '../agent-runs/store-types';
import {createRun,pushRunEvent,flushServerRunPersistence,resetServerRunStoreForTest,recoverServerRun} from '../agent-runs/store';
import {resetAgentRuntimeStoreMemory} from '../../src/persist/agentRuntimeStore';
import {projectDoc,projectId,MemoryPersistence} from '../external-agent/offline-runtime.verify-fixtures';
import {openHeadlessEditor} from './headless-editor';
const oldFetch=globalThis.fetch;let requests=0,passed=0;const failures:string[]=[];
globalThis.fetch=async()=>{requests++;throw Error('Network forbidden');};
const run=()=>createRun({projectId:'admission-fixture',sessionGeneration:'legacy',backend:'api',provider:'openai',model:'fixture'});
async function test(name:string,body:()=>Promise<void>){try{await body();passed++;console.log('PASS '+name);}catch(e){failures.push(name);console.error('FAIL '+name+': '+e);}}
function original(){const d=makeDraft(projectDoc());d.commands.addTextClip({text:'OLD',startFrame:0,durationInFrames:30,track:'track-v1'});d.commands.addTextClip({text:'SECOND',startFrame:30,durationInFrames:30,track:'track-v1'});const doc=structuredClone(d.getDoc());doc.timelines[0]!.items[0]!.id='clip-text';doc.timelines[0]!.items[1]!.id='clip-text-two';return doc;}
async function pair(args:Record<string,unknown>,reverse=false){
 const doc=original();doc.timelines[0]!.selectedId='clip-text';doc.timelines[0]!.selectedIds=['clip-text'];if(reverse)doc.timelines[0]!.items.reverse();
 const ui={...makeDraft(structuredClone(doc)),templates:[],audio:[],getCreativeMode:()=>null,getProjectId:()=>projectId};
 const p=new MemoryPersistence(doc),e=await openHeadlessEditor({projectId,runId:'fixture',origin:'http://127.0.0.1:5199',review:{provider:'openai',model:'fixture',origin:'http://127.0.0.1:5199',apiMode:'responses'},persistence:p,browserConnected:()=>false,effect:async()=>{throw Error('Provider forbidden');}});
 try{
  const a=await executeCodexTool({name:'edit_item',args,ctx:ui,activation:new ToolActivation(TOOL_SCHEMAS,[]),settings:DEFAULT_AGENT_SETTINGS,onEvent:()=>undefined});
  const b=await e.execute('edit_item',args,'fixture') as any;
  return {a,b,ui:ui.getDoc(),server:e.getDoc(),saved:p.current,commits:p.commitCount,before:doc};
 }finally{await e.close();}
}
try{
 resetAgentRuntimeStoreMemory();resetServerRunStoreForTest();
 for(const alias of ['itemId','id','targetItemId'])await test(`same ordinary text update via ${alias}`,async()=>{
  const r=await pair({updates:[{type:'text',[alias]:'clip-text',props:{text:'CHANGED'}}]});
  assert.equal(r.a.execution.success,true);assert.equal(r.b.ok,true,r.b.error);assert.equal(r.b.saved,true);assert.equal(r.commits,1);
  assert.deepEqual(r.ui,r.server);assert.equal(r.saved.timelines[0]!.items[0]!.props!.text,'CHANGED');
 });
 for(const locator of ['not-found','clip-t'])await test(`invalid/ambiguous locator ${locator} rolls back preceding update`,async()=>{
  const r=await pair({updates:[{type:'text',itemId:'clip-text',props:{text:'STAGED'}},{type:'text',targetItemId:locator,props:{text:'BAD'}}]});
  assert.equal(r.a.execution.success,false);assert.equal(r.b.ok,false);assert.deepEqual(r.ui,r.before);assert.deepEqual(r.server,r.before);assert.equal(r.commits,0);
 });
 await test('unique prefix and exact ID win without changing the other clip',async()=>{
  for(const locator of ['clip-text-t','clip-text']){const r=await pair({updates:[{type:'text',targetItemId:locator,props:{text:'ONLY TARGET'}}]});
   assert.equal(r.b.ok,true,r.b.error);assert.deepEqual(r.ui,r.server);const index=locator==='clip-text'?0:1;
   assert.equal(r.saved.timelines[0]!.items[index]!.props!.text,'ONLY TARGET');assert.equal(r.saved.timelines[0]!.items[1-index]!.props!.text,index===0?'SECOND':'OLD');}
 });
 await test('selected-clip references remain supported',async()=>{
  for(const locator of ['selected','selection']){const r=await pair({updates:[{type:'text',itemId:locator,props:{text:'SELECTED'}}]});
   assert.equal(r.a.execution.success,true,JSON.stringify(r.a.execution.result));assert.equal(r.b.ok,true,r.b.error);assert.equal(r.server.timelines[0]!.items[0]!.props!.text,'SELECTED');assert.deepEqual(r.ui,r.server);}
 });
 await test('exact ID wins even if its longer prefix match appears first',async()=>{
  const r=await pair({updates:[{type:'text',targetItemId:'clip-text',props:{text:'EXACT'}}]},true);
  assert.equal(r.b.ok,true);assert.equal(r.server.timelines[0]!.items.find(i=>i.id==='clip-text')!.props!.text,'EXACT');
  assert.equal(r.server.timelines[0]!.items.find(i=>i.id==='clip-text-two')!.props!.text,'SECOND');assert.deepEqual(r.ui,r.server);
 });
 await test('unknown field and real effects remain rejected',async()=>{
  for(const entry of [{type:'text',targetItemId:'clip-text',typo:1,props:{text:'BAD'}},{type:'effect',targetItemId:'clip-text',effectId:'missing',propertyOverrides:{opacity:0}}]){
   const r=await pair({updates:[entry]});assert.equal(r.a.execution.success,false);assert.equal(r.b.ok,false);assert.equal(r.commits,0);assert.deepEqual(r.server,r.before);
  }
 });
 await test('large UTF8 request reaches host once and survives cold ledger read',async()=>{
  const r=run(),args={updates:[{type:'text',itemId:'clip-text',props:{text:'文'.repeat(30000)}}]};let calls=0;
  const schema=TOOL_SCHEMAS.find(t=>t.name==='edit_item')!;
  await executeBrowserTool(r,schema,args,'large-utf8',{current:new ToolActivation(TOOL_SCHEMAS,[]),tail:Promise.resolve(),followupText:null,toolFailures:new ToolFailureTracker(),acceptance:createAcceptanceLoop(false,1),
   host:{maxTurns:1,deadlineAt:Date.now()+1000,beforeRequest:async()=>undefined,execute:async(_name,actual)=>{calls++;assert.deepEqual(actual,args);return {ok:true};}}});
  assert.equal(calls,1);await flushServerRunPersistence();resetServerRunStoreForTest();const restored=await recoverServerRun(r.projectId,r.id);assert(restored);
  assert.deepEqual((restored.events.find(e=>e.type==='server-tool-request')!.data as any).args,args,'large accepted request must not become omitted+digest in durable projection');
 });
 for(const type of ['tool-request','server-tool-request'])await test(`${type} exact byte boundary and overflow`,async()=>{
  for(const delta of [0,1]){const r=run(),data={toolCallId:'edge',name:'edit_item',args:{text:''},argsDigest:'d'};
   const bytes=eventBytes({id:r.eventCursor+1,type,data,at:Date.now()});data.args.text='a'.repeat(MAX_SERVER_TOOL_REQUEST_EVENT_BYTES-bytes+delta);
   if(delta)assert.throws(()=>pushRunEvent(r,type,data),/exceeds/);else{pushRunEvent(r,type,data);await flushServerRunPersistence();assert(r.events.some(e=>e.type===type));resetServerRunStoreForTest();const restored=await recoverServerRun(r.projectId,r.id);assert(restored);assert.deepEqual((restored.events.find(e=>e.type===type)!.data as any).args,data.args,'capacity boundary must survive cold persistence as well as admission');}
  }
 });
 await test('ordinary result events still have the 64KiB limit',async()=>{const r=run();assert.throws(()=>pushRunEvent(r,'server-tool-result',{result:'a'.repeat(MAX_SERVER_EVENT_BYTES)}),/exceeds/);});
 await flushServerRunPersistence();assert.equal(requests,0);console.log(`Admission contract: ${passed} passed, ${failures.length} failed; zero provider/network/media operations`);assert.deepEqual(failures,[]);
}finally{await flushServerRunPersistence();resetServerRunStoreForTest();resetAgentRuntimeStoreMemory();globalThis.fetch=oldFetch;}
