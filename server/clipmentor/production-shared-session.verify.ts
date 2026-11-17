import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import {watch} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createMiniConnect} from '../../desktop/mini-connect';
import type {ProductionInput,ProductionTask} from './production-task';
import type {ProjectDoc} from '../../src/editor/types';

// Only this verifier is added. HTTP, task persistence and project commits are real.
await fs.mkdir(tmpdir(),{recursive:true});
const directory=await fs.mkdtemp(join(tmpdir(),'production-shared-session-'));
const previousData=process.env.OPENCHATCUT_DATA_DIR;process.env.OPENCHATCUT_DATA_DIR=directory;
const {resetSharedKvMemory}=await import('../../src/persist/sharedKv');
const {resetAgentRuntimeStoreMemory,patchAgentRun}=await import('../../src/persist/agentRuntimeStore');
const {activateOfflineAgentRuntimeBackend}=await import('../external-agent/agent-runtime-persistence');
const {createProductionTask,productionTaskStore}=await import('./production-task');
const {recoverServerRun,setRunStatus,flushServerRunPersistence,resetServerRunStoreForTest}=await import('../agent-runs/store');
const {getStoredEntry,setStoredEntry,readStore}=await import('../plugins/project-store');
const {agentSessionRuntimeKey}=await import('../../shared/agent-session-generation');
const {currentAgentSessionGeneration}=await import('../../src/persist/agentSessionGeneration');
const {loadOfflineStoredProject}=await import('../external-agent/offline-project-store');
const {feedbackProjectDigest}=await import('./production-feedback');
const {digestValue}=await import('../agent-runs/store-values');
const {clipMentorProductionPlugin}=await import('../plugins/clipmentor-production');
const {projectStorePlugin}=await import('../plugins/project-store-plugin');
const {continuationBrief,selectProductionAudience}=await import('./production-continuation');
const {copyReviewSubject}=await import('../../src/clipmentor/production-gate');
const {deliverySectionsFromDoc}=await import('../../src/clipmentor/delivery-bindings');
const {default:board}=await import('./fixtures/blueprint-review-board-20261031.json');
resetSharedKvMemory();resetAgentRuntimeStoreMemory();resetServerRunStoreForTest();activateOfflineAgentRuntimeBackend();
const app=createMiniConnect(error=>{throw error;}),server=createServer((req,res)=>app.handle(req,res));
let workers=0;const workerErrors:string[]=[];
const originalError=console.error;console.error=(...args)=>{workerErrors.push(args.map(String).join(' '));};
const plugins=[projectStorePlugin(),clipMentorProductionPlugin(async()=>{workers++;throw Error('shared_session_fixture_worker_stop');})];
server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address==='object');
const origin=`http://127.0.0.1:${address.port}`;
for(const plugin of plugins)(plugin.configureServer as (s:unknown)=>void)({httpServer:server,config:{server:{port:address.port},logger:{error:()=>{}}},middlewares:{use:(route:string,fn:never)=>app.use(route,fn)}});
const headers={Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json'};
const post=(path:string,body:unknown)=>fetch(origin+path,{method:'POST',headers,body:JSON.stringify(body)});
const rotate=(projectId:string)=>post('/api/project-store/agent-session/rotate',{operation:'agent-session-rotate',projectId});
const input=(projectId:string):ProductionInput=>({projectId,sourceAssetId:'source',product:{name:'Shared session fixture',category:'test'},brief:'No external effects',humanBlueprintReview:true,author:{provider:'openai',model:'fixture',apiMode:'responses',origin},reviewer:{provider:'openai',model:'fixture',apiMode:'responses',origin},budget:{model:10,review:10,observation:0,tts:0,render:0,maxElapsedMs:60000,maxRepairs:0}});
async function terminal(task:ProductionTask){const run=await recoverServerRun(task.projectId,task.taskId);assert(run);await setRunStatus(run,'completed');await flushServerRunPersistence();await patchAgentRun(task.projectId,task.taskId,{status:'completed'});}
const rawSave=productionTaskStore.save,rawLoad=productionTaskStore.load;
const evidence:any[]=[],failures:string[]=[];
async function state(projectId:string){const generation=await currentAgentSessionGeneration(projectId),runtime=await getStoredEntry(agentSessionRuntimeKey(projectId,generation));const entries=(await readStore()).entries;return {generation,runtime,artifacts:Object.keys(entries).filter(k=>k.includes(projectId)&&k.includes('artifact')),project:await loadOfflineStoredProject(projectId)};}
async function fixture(label:string,activeParent:boolean){
 const ids=['parent','producer','follower'].map(s=>label+'-'+s);for(const id of ids)assert.equal((await rotate(id)).status,200);
 const [parent,producer,follower]=await Promise.all(ids.map(id=>createProductionTask(input(id))));
 const full=structuredClone(board.cases.newBinding) as unknown as ProjectDoc,partner=structuredClone(board.cases.existingBinding) as unknown as ProjectDoc;
 const sections=deliverySectionsFromDoc(full),ending=deliverySectionsFromDoc(partner).find(s=>s.kind==='creator_invitation')!;
 sections.find(s=>s.kind==='creator_invitation')!.section_id='new_contact';ending.section_id='existing_partner';sections.push(ending);
 for(const asset of partner.assets)if(!full.assets.some(a=>a.id===asset.id))full.assets.push(asset);
 for(const fact of partner.clipMentorAnalysis!.evidence){const old=full.clipMentorAnalysis!.evidence.find(e=>e.evidence_id===fact.evidence_id);if(old)old.source_ids=[...new Set([...old.source_ids,...fact.source_ids])];else full.clipMentorAnalysis!.evidence.push(fact);}
 const ir=full.clipMentorAnalysis!.blueprint[0].internal_review as Record<string,any>;ir[String(ir.current_picture_plan)].delivery_sections=sections;
 const first=selectProductionAudience(full,'existing_partner'),next=selectProductionAudience(full,'new_contact');
 const section=deliverySectionsFromDoc(first).find(s=>s.kind==='creator_invitation')!,timeline=first.timelines[0],fps=timeline.fps;
 const audio={id:'fixture-ending',kind:'audio',name:'ending',src:'/media/uploads/never-read.mp3',durationInFrames:fps,props:{generation:{text:section.line.narration_ms,provider:section.voice.provider,voiceId:section.voice.voiceId,speed:1,durationSeconds:1}}};
 first.assets.push(audio as any);const video=first.assets.find(a=>a.kind==='video')!;
 timeline.items=[{id:'fixture-common',name:'common',kind:'video',track:timeline.trackOrder![0],startFrame:0,durationInFrames:100,src:video.src,sourceAssetId:video.id},{id:'fixture-ending',name:'ending',kind:'audio',track:timeline.trackOrder![2],startFrame:100,durationInFrames:fps,src:audio.src,sourceAssetId:audio.id}] as any;
 for(const [task,doc,audience] of [[producer,first,'existing_partner'],[follower,next,'new_contact']] as const){
  await setStoredEntry('project:'+task.projectId,doc);const saved=await loadOfflineStoredProject(task.projectId);assert(saved);
  task.input.sourceAssetId=parent.input.sourceAssetId;task.input.brief=continuationBrief(task.input.product.name,audience);
  task.input.panelDelivery={productAssetId:'product',productAssetHash:'a'.repeat(64),salesAssetId:'sales',ctaAssetId:'cta',ctaAssetHash:'b'.repeat(64),audience};
  task.blueprintApproval={sourceProjectId:parent.projectId,sourceTaskId:parent.taskId,sourceRevision:'fixture',digest:(await copyReviewSubject(saved.doc)).digest,requirementsDigest:'fixture',confirmedAt:1};
  task.status=task===producer?'awaiting_review':'queued';task.stage='copy_review';task.projectRevision=saved.revision;task.completed.blueprint={at:1,artifact:{revision:saved.revision}};
  if(task===producer){task.attempts.model=3;task.attempts.review=2;task.completed.self_check={at:1,artifact:{fixtureOnly:true}};task.completed.export={at:1,artifact:{revision:saved.revision,renderId:'synthetic-export',facts_digest:'c'.repeat(64),feedback_project_digest:feedbackProjectDigest(saved.doc)}};}
  else task.sharedProduction={projectId:producer.projectId,taskId:producer.taskId};
  await rawSave(task);
 }
 parent.status='awaiting_blueprint';parent.stage='copy_review';parent.attempts.model=4;parent.productionChildren=[producer,follower].map(t=>({projectId:t.projectId,taskId:t.taskId,audience:t.input.panelDelivery!.audience!}));await rawSave(parent);
 await terminal(producer);if(!activeParent)await terminal(parent);
 return {parent,producer,follower};
}
async function runCase(boundary:'before-commit'|'after-readback',drift:'none'|'parent'|'child'|'active-parent'){
 const label=boundary+'-'+drift,{parent,producer,follower}=await fixture(label,drift==='active-parent');
 const before={parent:await state(parent.projectId),producer:await state(producer.projectId),child:await state(follower.projectId),tasks:{parent:await rawLoad(parent.projectId,parent.taskId),producer:await rawLoad(producer.projectId,producer.taskId),child:await rawLoad(follower.projectId,follower.taskId)}};
 let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{enter=r;}),held=new Promise<void>(r=>{release=r;});let heldOnce=false,commits=0;const workerBefore=workers;
 const projectPath=join(directory,'project-store-v1',encodeURIComponent('project:'+follower.projectId)+'.json');
 const initialInode=(await fs.stat(projectPath)).ino,commitInodes=new Set<number>(),observations:Promise<void>[]=[];
 const watcher=watch(join(directory,'project-store-v1'),(event,name)=>{if(event==='rename'&&String(name)===encodeURIComponent('project:'+follower.projectId)+'.json')observations.push(fs.stat(projectPath).then(s=>{if(s.ino!==initialInode)commitInodes.add(s.ino);commits=commitInodes.size;}).catch(()=>{}));});
 productionTaskStore.save=async(task,guards)=>{await rawSave(task,guards);if(boundary==='before-commit'&&!heldOnce&&task.taskId===follower.taskId&&task.completed.blueprint?.artifact.shared_preparation&&!task.sharedProduction?.prepared){heldOnce=true;enter();await held;}};
 productionTaskStore.load=async(project,id)=>{const stack=new Error().stack??'',result=await rawLoad(project,id);if(boundary==='after-readback'&&!heldOnce&&id===producer.taskId&&stack.includes('markSharedProducer')){heldOnce=true;enter();await held;}return result;};
 try{
  const response=await post('/api/clipmentor/production-task',{action:'resume',projectId:follower.projectId,taskId:follower.taskId});assert.equal(response.status,202,await response.text());
  let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([entered,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('boundary timeout '+label+' '+workerErrors.join('\n'))),10000);})]);}finally{clearTimeout(timer);}
  await Promise.all(observations);const boundaryInode=(await fs.stat(projectPath)).ino;if(boundaryInode!==initialInode)commitInodes.add(boundaryInode);commits=commitInodes.size;
  const atBoundary={commits,workers:workers-workerBefore,child:await state(follower.projectId),parent:await state(parent.projectId)};
  const target=drift==='child'?follower:parent;let rotation:any;
  if(drift!=='none'){const r=await rotate(target.projectId);rotation={status:r.status,body:await r.json()};}
  const afterRotate={parent:await state(parent.projectId),child:await state(follower.projectId)};
  release();let settled=false;
  for(let i=0;i<500;i++){const r=await fetch(origin+`/api/clipmentor/production-task?projectId=${follower.projectId}&taskId=${follower.taskId}`,{headers});if(!(await r.json()).executionActive){settled=true;break;}await new Promise(r=>setTimeout(r,2));}assert(settled,'local execution must settle');
  await Promise.all(observations);const finalInode=(await fs.stat(projectPath)).ino;if(finalInode!==initialInode)commitInodes.add(finalInode);commits=commitInodes.size;
  const after={parent:await state(parent.projectId),producer:await state(producer.projectId),child:await state(follower.projectId),tasks:{parent:await rawLoad(parent.projectId,parent.taskId).catch(()=>null),producer:await rawLoad(producer.projectId,producer.taskId).catch(()=>null),child:await rawLoad(follower.projectId,follower.taskId).catch(()=>null)}};
  const accepted=rotation?.status===200,classification=drift==='none'?'same-generation positive':accepted?'reachable terminal rotation':'API-blocked rotation';
  const record={label,classification,rotation,before,atBoundary,afterRotate,after,commits,postBoundaryCommits:commits-atBoundary.commits,workers:workers-workerBefore};evidence.push(record);
  if(drift==='parent')assert.equal(rotation.status,200,'terminal parent must rotate through HTTP');
  if(drift==='active-parent'){assert.equal(rotation.status,400);assert.equal(rotation.body.code,'agent_session_clear_blocked');assert.equal(after.parent.generation,before.parent.generation);}
  if(drift==='child'&&!accepted){assert.equal(rotation.status,400);assert.equal(rotation.body.code,'agent_session_clear_blocked');assert.equal(after.child.generation,before.child.generation);}
  if(accepted){
   assert.notEqual(afterRotate[drift==='child'?'child':'parent'].generation,before[drift==='child'?'child':'parent'].generation);
   const rotated=drift==='child'?after.child:after.parent;assert.equal(rotated.runtime.found,false,'rotated namespace must stay empty');assert.equal(rotated.artifacts.length,0);
   if(commits!==atBoundary.commits||workers!==workerBefore)failures.push(label+': post-boundary commits='+String(commits-atBoundary.commits)+', workers='+String(workers-workerBefore));
   if(after.tasks.child&&digestValue(after.tasks.child.input.budget)!==digestValue(before.tasks.child.input.budget))failures.push(label+': original follower budget changed '+before.tasks.child.input.budget.model+' -> '+after.tasks.child.input.budget.model);
   if(after.tasks.producer?.sharedProduction?.prepared&&!before.tasks.producer.sharedProduction?.prepared)failures.push(label+': old preparation published producer marker after rotation');
   if(after.tasks.child?.sharedProduction?.prepared&&!before.tasks.child.sharedProduction?.prepared)failures.push(label+': old preparation published follower marker after rotation');
   for(const key of ['parent','producer','child'] as const)if(after.tasks[key])assert.deepEqual({...after.tasks[key].attempts,preview_review:after.tasks[key].attempts.preview_review??0},{...before.tasks[key].attempts,preview_review:before.tasks[key].attempts.preview_review??0},'old attempts preserved');
  }else{assert.equal(commits,1,'legal preparation commits once');assert.equal(workers-workerBefore,1,'legal preparation reaches exactly one fake worker');assert.equal(after.tasks.child?.sharedProduction?.prepared,true);}
 }finally{release();productionTaskStore.save=rawSave;productionTaskStore.load=rawLoad;watcher.close();}
}
try{
 for(const boundary of ['before-commit','after-readback'] as const)for(const drift of ['none','parent','child','active-parent'] as const)await runCase(boundary,drift);
 console.log(JSON.stringify({suite:'production-shared-session',cases:evidence.map(({label,classification,rotation,commits,postBoundaryCommits,workers,after})=>({label,classification,rotate:rotation?.status,commits,postBoundaryCommits,workers,parentRuntime:after.parent.runtime.found,childRuntime:after.child.runtime.found})),failures},null,2));
 assert.deepEqual(failures,[],'terminal rotation must stop old shared preparation');
}finally{
 productionTaskStore.save=rawSave;productionTaskStore.load=rawLoad;console.error=originalError;
 const report=JSON.stringify({evidence,failures,workerErrors},null,2);await fs.writeFile(resolve(process.env.CM_SHARED_SESSION_EVIDENCE??'../shared-session-evidence.json'),report);
 await flushServerRunPersistence();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));resetServerRunStoreForTest();resetSharedKvMemory();resetAgentRuntimeStoreMemory();
 if(previousData===undefined)delete process.env.OPENCHATCUT_DATA_DIR;else process.env.OPENCHATCUT_DATA_DIR=previousData;
 const target=resolve(directory);assert(target.startsWith(resolve(tmpdir())+'/production-shared-session-'));await fs.rm(target,{recursive:true,force:true});
}
