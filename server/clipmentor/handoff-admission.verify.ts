import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
const root=await mkdtemp(join(tmpdir(),'clipmentor-handoff-admission-'));
process.env.OPENCHATCUT_DATA_DIR=root;
const {withSerializedProjectStore}=await import('../plugins/project-store');
const {digestValue}=await import('../agent-runs/store-values');
const {agentRunsPlugin}=await import('../agent-runs/routes');
const {createMiniConnect}=await import('../../desktop/mini-connect');
const brief={version:1,briefId:'supplied-plan-test',revision:1,mode:'collaborative',phase:'planning',planner:'external_codex',executor:'builtin_agent',
 projectId:'handoff-admission-test',timelineId:'tl',objective:'Synthetic supplied-plan execution',doneCriteria:['Read the supplied plan'],blueprint:null,
 budget:{maxModelTurns:1,maxToolCalls:1,maxElapsedMs:60000,paidToolCalls:{}}};
const assetBindings=[{id:'source',kind:'video',src:'/media/test.mp4',sourceContentHash:'a'.repeat(64),sourceRevision:null,durationInFrames:30,width:null,height:null}];
await withSerializedProjectStore(s=>s.writeEntry('clipmentor-handoff:handoff-admission-test',{version:1,brief,digest:digestValue({templateVersion:'clipmentor-handoff-v1',brief,assetBindings}),assetBindings,runIds:[],startedAt:null,modelTurns:0,toolCalls:0,paidCalls:{},callIds:[]}));
const app=createMiniConnect(error=>{throw error;});const plugin=agentRunsPlugin();
assert.equal(typeof plugin.configureServer,'function');
(plugin.configureServer as (s:unknown)=>void)({middlewares:{use:(route:string,handler:never)=>app.use(route,handler)}});
const server=createServer((req,res)=>app.handle(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');
const address=server.address();assert(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
try{
 const response=await fetch(`${origin}/api/agent-runs/`,{method:'POST',headers:{Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json'},
 body:JSON.stringify({projectId:brief.projectId,runId:'34343434-3434-4434-8434-343434343434',capability:'h'.repeat(43),backend:'codex',model:'mock',
 messages:[{role:'user',content:'Please make the entire video and decide the teaching points.'}],cacheMode:'short',maxOutputTokens:1000,tools:[]})});
 const body=await response.json() as {error?:string};
 assert.equal(response.status,400,'A registered collaborative project without an execution blueprint must reject ordinary admission, before /start or any provider call');
 assert.match(body.error??'',/handoff_waiting_for_external_planner/);
 console.log('handoff admission regression: registered collaborative preparation cannot silently dispatch a whole-task model run; zero provider calls');
}finally{await fetch(`${origin}/api/agent-runs/34343434-3434-4434-8434-343434343434/cancel`,{method:'POST',headers:{Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json','x-openchatcut-run-capability':'h'.repeat(43)},body:JSON.stringify({projectId:brief.projectId})});server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
