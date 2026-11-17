import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createMiniConnect} from '../../desktop/mini-connect';
import type {ProductionTask,ProductionInput} from './production-task';

// No provider, renderer, media read or installer is invoked. Only stores and HTTP are real.
await mkdir(tmpdir(),{recursive:true});
const directory=await mkdtemp(join(tmpdir(),'production-session-'));
const previousData=process.env.OPENCHATCUT_DATA_DIR;
process.env.OPENCHATCUT_DATA_DIR=directory;
const {resetSharedKvMemory}=await import('../../src/persist/sharedKv');
const {resetAgentRuntimeStoreMemory,patchAgentRun}=await import('../../src/persist/agentRuntimeStore');
const {activateOfflineAgentRuntimeBackend}=await import('../external-agent/agent-runtime-persistence');
const {createProductionTask,productionTaskStore}=await import('./production-task');
const {recoverServerRun,setRunStatus,flushServerRunPersistence,resetServerRunStoreForTest}=await import('../agent-runs/store');
const {getStoredEntry,setStoredEntry,readStore}=await import('../plugins/project-store');
const {agentSessionRuntimeKey}=await import('../../shared/agent-session-generation');
const {currentAgentSessionGeneration}=await import('../../src/persist/agentSessionGeneration');
const {loadOfflineStoredProject}=await import('../external-agent/offline-project-store');
const {feedbackProjectDigest,productionFeedbackAnchor}=await import('./production-feedback');
const {clipMentorProductionPlugin}=await import('../plugins/clipmentor-production');
const {projectStorePlugin}=await import('../plugins/project-store-plugin');
const {default:fixtures}=await import('../../src/clipmentor/fixtures/production-saved-projects-20261028.json');
resetSharedKvMemory();resetAgentRuntimeStoreMemory();resetServerRunStoreForTest();activateOfflineAgentRuntimeBackend();
const app=createMiniConnect(error=>{throw error;});
const server=createServer((req,res)=>app.handle(req,res));
let dispatch=0;
const plugins=[projectStorePlugin(),clipMentorProductionPlugin(async()=>{dispatch++;throw Error('session_fixture_worker_stop');})];
server.listen(0,'127.0.0.1');await once(server,'listening');
const address=server.address();assert(address&&typeof address==='object');
const origin=`http://127.0.0.1:${address.port}`;
for(const plugin of plugins)(plugin.configureServer as (s:unknown)=>void)({httpServer:server,config:{server:{port:address.port},logger:{error:()=>{}}},middlewares:{use:(route:string,fn:never)=>app.use(route,fn)}});
const headers={Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json'};
const post=(path:string,body:unknown)=>fetch(origin+path,{method:'POST',headers,body:JSON.stringify(body)});
const rotate=(projectId:string)=>post('/api/project-store/agent-session/rotate',{operation:'agent-session-rotate',projectId});
const control=(task:ProductionTask,action:string,extra:object={})=>post('/api/clipmentor/production-task',{action,projectId:task.projectId,taskId:task.taskId,...extra});
const evidence:unknown[]=[];const failures:string[]=[];
const rawSave=productionTaskStore.save;
let saves=0;
const input=(projectId:string):ProductionInput=>({projectId,sourceAssetId:'source',product:{name:'Session fixture',category:'test'},brief:'No external work',humanBlueprintReview:true,
 author:{provider:'openai',model:'fixture',apiMode:'responses',origin},reviewer:{provider:'openai',model:'fixture',apiMode:'responses',origin},budget:{model:0,review:0,observation:0,tts:0,render:0,maxElapsedMs:10000,maxRepairs:0}});
async function terminal(task:ProductionTask){const run=await recoverServerRun(task.projectId,task.taskId);assert(run);await setRunStatus(run,'completed');await flushServerRunPersistence();await patchAgentRun(task.projectId,task.taskId,{status:'completed'});}
async function fixture(label:string,single=false){
 // Start from a real non-legacy marker so the race covers generation-to-generation rotation.
 for(const projectId of [label+'-parent',label+'-first',...(single?[]:[label+'-second'])])assert.equal((await rotate(projectId)).status,200);
 const parent=await createProductionTask(input(label+'-parent'));
 const children=await Promise.all([createProductionTask(input(label+'-first')),...(single?[]:[createProductionTask(input(label+'-second'))])]);
 for(const [i,child] of children.entries()){
  child.input.panelDelivery={productAssetId:'product',productAssetHash:'a'.repeat(64),salesAssetId:'sales',ctaAssetId:'cta',ctaAssetHash:'b'.repeat(64),audience:i===0?'existing_partner':'new_contact'};
  child.blueprintApproval={sourceProjectId:parent.projectId,sourceTaskId:parent.taskId,sourceRevision:'fixture-revision',digest:'fixture',requirementsDigest:'fixture',confirmedAt:1};
  if(i===1)child.sharedProduction={projectId:children[0].projectId,taskId:children[0].taskId};
  const doc=structuredClone(fixtures.cases[0].doc);
  await setStoredEntry('project:'+child.projectId,doc);
  const snapshot=await loadOfflineStoredProject(child.projectId);assert(snapshot);
  child.status='awaiting_review';child.stage='self_check';child.projectRevision=snapshot.revision;
  child.completed.export={at:1,artifact:{revision:snapshot.revision,renderId:'fixture-export',facts_digest:'c'.repeat(64),feedback_project_digest:feedbackProjectDigest(snapshot.doc)}};
  await rawSave(child);await terminal(child);
 }
 parent.status='awaiting_blueprint';parent.stage='copy_review';
 const entries=children.map(t=>({projectId:t.projectId,taskId:t.taskId,audience:t.input.panelDelivery!.audience!}));
 if(single)parent.productionChild=entries[0];else parent.productionChildren=entries;
 await rawSave(parent);if(!label.startsWith('active-'))await terminal(parent);
 return {parent,child:children[0],children};
}
async function snapshot(projectId:string){const generation=await currentAgentSessionGeneration(projectId);const entry=await getStoredEntry(agentSessionRuntimeKey(projectId,generation));return {generation,found:entry.found,value:entry.value};}
async function feedback(task:ProductionTask){const doc=await loadOfflineStoredProject(task.projectId);assert(doc);const anchor=await productionFeedbackAnchor(task,doc.doc);return {feedback:{kind:'content',text:'session race feedback',preview:anchor.preview,unit_ids:[],item_ids:[]}};}
async function runCase(label:string,drift:'none'|'parent'|'child'|'both'|'active',action='feedback',single=false){
 const {parent,child}=await fixture(label,single);const before=await productionTaskStore.load(child.projectId,child.taskId);
 const beforeParent=await snapshot(parent.projectId),beforeChild=await snapshot(child.projectId);
 if(drift==='active'){const run=await recoverServerRun(parent.projectId,parent.taskId);assert(run);await setRunStatus(run,'running');await flushServerRunPersistence();}
 let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{enter=r;}),held=new Promise<void>(r=>{release=r;});
 let heldOnce=false,saveAttempts=0,commits=0;const dispatchBefore=dispatch;
 productionTaskStore.save=async(next,guards)=>{saveAttempts++;saves++;if(next.taskId===child.taskId&&!heldOnce){heldOnce=true;enter();await held;}await rawSave(next,guards);commits++;};
 let request:Promise<Response>|undefined;
 try{
  request=control(child,action,action==='feedback'?await feedback(child):{});
  await Promise.race([entered,request.then(async r=>{throw Error('control did not reach save: '+r.status+' '+await r.clone().text());}),new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('save boundary timeout')),10000);timer.unref();})]);
  const rotations=[];
  for(const task of drift==='both'?[parent,child]:drift==='parent'||drift==='active'?[parent]:drift==='child'?[child]:[]){const response=await rotate(task.projectId);rotations.push({projectId:task.projectId,status:response.status,body:await response.json()});}
  release();const response=await request;const body=await response.json();
  // Wait only for this local fixture worker and its final checkpoint, never for external work.
  for(let i=0;i<200;i++){const r=await fetch(`${origin}/api/clipmentor/production-task?projectId=${child.projectId}&taskId=${child.taskId}`,{headers});if(!(await r.json()).executionActive)break;await new Promise(r=>setTimeout(r,2));}
  const afterChild=await snapshot(child.projectId),afterParent=await snapshot(parent.projectId);
  const loaded=await productionTaskStore.load(child.projectId,child.taskId).catch(()=>undefined);
  const artifacts=Object.entries((await readStore()).entries).filter(([key])=>key.includes(child.projectId)&&key.includes('artifact'));
  const record={label,classification:drift==='active'?'API-blocked rotation':drift==='none'?'same-generation positive':'reachable terminal-run rotation',action,rotations,http:{status:response.status,body},saveAttempts,commits,dispatch:dispatch-dispatchBefore,before:{parent:beforeParent,child:beforeChild,task:before},after:{parent:afterParent,child:afterChild,task:loaded,artifacts}};
  evidence.push(record);
  if(drift==='none'||drift==='active'){
   assert.equal(response.status,202,label);assert(loaded);assert.deepEqual({...loaded.attempts,preview_review:loaded.attempts.preview_review??0},{...before.attempts,preview_review:before.attempts.preview_review??0});
   if(action==='feedback'){assert.equal(loaded.feedbackUsed,true);assert.equal(dispatch-dispatchBefore,1);}
   else assert.equal(loaded.status,'cancelled');
   if(drift==='active'){assert.equal(rotations[0].status,400);assert.equal(rotations[0].body.code,'agent_session_clear_blocked');assert.equal(afterParent.generation,beforeParent.generation);}
  }else{
   assert(rotations.every(r=>r.status===200),label+' must use accepted HTTP rotations');
   if(drift==='parent'||drift==='both')assert.notEqual(afterParent.generation,beforeParent.generation);
   if(drift==='child'||drift==='both'){assert.notEqual(afterChild.generation,beforeChild.generation);assert.equal(artifacts.length,0,'rotation reclaims old artifacts; control must not recreate them');}
   if(response.status!==409||commits!==0||dispatch!==dispatchBefore||((drift==='child'||drift==='both')&&afterChild.found))failures.push(label+': old control crossed rotation; HTTP '+response.status+', commits '+commits+', new runtime '+afterChild.found);
   if(drift==='parent')assert.deepEqual(loaded,before,'parent rotation must preserve child counters and checkpoint');
  }
 }finally{release();if(request)await request.catch(()=>undefined);productionTaskStore.save=rawSave;}
}
try{
 for(const [label,drift] of [['same-generation','none'],['active-parent-boundary','active'],['parent-rotate','parent'],['child-rotate','child'],['both-rotate','both']] as const)await runCase(label,drift);
 await runCase('legacy-single-positive','none','feedback',true);
 await runCase('cancel-positive','none','cancel');
 await runCase('cancel-child-rotate','child','cancel');
 console.log(JSON.stringify({suite:'production-session',cases:evidence.map((v:any)=>({label:v.label,classification:v.classification,http:v.http.status,rotations:v.rotations.map((r:any)=>r.status),saveAttempts:v.saveAttempts,commits:v.commits,dispatch:v.dispatch,newRuntime:v.after.child.found})),failures,saves},null,2));
 assert.deepEqual(failures,[],'old controls must never publish into a rotated session');
}finally{
 productionTaskStore.save=rawSave;
 await writeFile(resolve(directory,'evidence.json'),JSON.stringify({evidence,failures},null,2));
 if(process.env.CM_SESSION_EVIDENCE)await writeFile(resolve(process.env.CM_SESSION_EVIDENCE),JSON.stringify({evidence,failures},null,2));
 await flushServerRunPersistence();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
 resetServerRunStoreForTest();resetSharedKvMemory();resetAgentRuntimeStoreMemory();
 if(previousData===undefined)delete process.env.OPENCHATCUT_DATA_DIR;else process.env.OPENCHATCUT_DATA_DIR=previousData;
 const target=resolve(directory);assert(target.startsWith(resolve(tmpdir())+'/production-session-'),'only delete this verifier temp store');await rm(target,{recursive:true,force:true});
}
