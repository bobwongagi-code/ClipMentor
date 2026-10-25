import assert from 'node:assert/strict';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {once} from 'node:events';
import {createMiniConnect} from '../../desktop/mini-connect';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {productionTaskStore} from '../clipmentor/production-task';
import {resetSharedKvMemory} from '../../src/persist/sharedKv';
import {resetAgentRuntimeStoreMemory} from '../../src/persist/agentRuntimeStore';
import {resetServerRunStoreForTest,flushServerRunPersistence} from '../agent-runs/store';

const directory=await mkdtemp(join(tmpdir(),'production-task-http-'));
const previousData=process.env.OPENCHATCUT_DATA_DIR;process.env.OPENCHATCUT_DATA_DIR=directory;
const {clipMentorProductionPlugin}=await import('./clipmentor-production');
const {activateOfflineAgentRuntimeBackend}=await import('../external-agent/agent-runtime-persistence');
resetSharedKvMemory();resetAgentRuntimeStoreMemory();resetServerRunStoreForTest();activateOfflineAgentRuntimeBackend();
let release!:()=>void,started!:()=>void;
const blocked=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{started=r;});
const steps:string[]=[];
const plugin=clipMentorProductionPlugin(async(t)=>{steps.push(t.stage);if(t.stage==='analysis'){started();await blocked;}return {artifact:{verifiedFixture:true}};});
const app=createMiniConnect(e=>{throw e;});
const server=createServer((req,res)=>app.handle(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');
const address=server.address();assert(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
(plugin.configureServer as (s:unknown)=>void)({httpServer:server,config:{server:{port:address.port}},middlewares:{use:(route:string,fn:(req:IncomingMessage,res:ServerResponse)=>void)=>app.use(route,fn)}});
const input={projectId:'production-fixture',sourceAssetId:'source',product:{name:'Fixture',category:'test'},brief:'zero provider task',
 author:{provider:'openai',model:'fixture',apiMode:'responses'},reviewer:{provider:'openai',model:'fixture',apiMode:'responses'},
 budget:{model:0,review:0,observation:0,tts:0,render:0,maxElapsedMs:10000,maxRepairs:0}};
const post=(body:unknown,authorized=true)=>fetch(`${origin}/api/clipmentor/production-task`,{method:'POST',headers:{'Content-Type':'application/json',...(authorized?{Origin:origin,'Sec-Fetch-Site':'same-origin'}:{})},body:JSON.stringify(body)});
try{
 assert.equal((await post({action:'create',input},false)).status,403);
 const res=await post({action:'create',input});assert.equal(res.status,202);const created=await res.json();await entered;
 // HTTP submit has finished. No SSE consumer or browser-tool result ever exists.
 const running=await productionTaskStore.load(input.projectId,created.taskId);assert.equal(running.status,'running');
 assert.equal((await post({action:'resume',projectId:input.projectId,taskId:created.taskId})).status,409);
 release();
 let task=running;
 for(let n=0;n<200;n++){task=await productionTaskStore.load(input.projectId,created.taskId);if(task.status==='awaiting_review')break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(task.status,'awaiting_review');assert.equal(steps.length,7);assert.equal(task.attempts.model,0);
 for(let n=0;n<200;n++){const r=await fetch(`${origin}/api/clipmentor/production-task?projectId=${input.projectId}&taskId=${created.taskId}`,{headers:{Origin:origin,'Sec-Fetch-Site':'same-origin'}});if(!(await r.json()).executionActive)break;await new Promise(r=>setTimeout(r,5));}
 // Drop every in-memory run/sidecar cache; recover from the canonical persisted artifacts.
 await flushServerRunPersistence();resetServerRunStoreForTest();resetAgentRuntimeStoreMemory();activateOfflineAgentRuntimeBackend();
 const recovered=await productionTaskStore.load(input.projectId,created.taskId);assert.equal(recovered.status,'awaiting_review');assert.deepEqual(recovered.completed,task.completed);
 const get=await fetch(`${origin}/api/clipmentor/production-task?projectId=${input.projectId}&taskId=${created.taskId}`,{headers:{Origin:origin,'Sec-Fetch-Site':'same-origin'}});
 assert.equal(get.status,200);assert.equal((await get.json()).taskId,created.taskId);
 assert.equal((await post({action:'accept',projectId:input.projectId,taskId:created.taskId,malayDeliveryConfirmed:false})).status,409);
 const accepted=await post({action:'accept',projectId:input.projectId,taskId:created.taskId,malayDeliveryConfirmed:true});assert.equal(accepted.status,200,JSON.stringify(await accepted.json()));
 console.log('production HTTP: origin guard, async no-page execution, duplicate launch refusal, canonical artifact cold recovery/read and final human acceptance passed; mocked stages, zero provider calls');
}finally{release();await flushServerRunPersistence();await new Promise<void>((r,e)=>server.close(err=>err?e(err):r()));resetServerRunStoreForTest();resetAgentRuntimeStoreMemory();resetSharedKvMemory();if(previousData===undefined)delete process.env.OPENCHATCUT_DATA_DIR;else process.env.OPENCHATCUT_DATA_DIR=previousData;await rm(directory,{recursive:true,force:true});}
