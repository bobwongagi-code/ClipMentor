// Real coordinator/worker entries; isolated store and a refusing local author host only.
import assert from 'node:assert/strict';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import saved from '../../src/clipmentor/fixtures/production-saved-projects-20261028.json';
import type {ProjectDoc} from '../../src/editor/types';
import type {AgentRunRecord} from '../../src/persist/agentRuntimeTypes';
import type {ProductionTask,StageContext} from './production-task';

const root=await mkdtemp(join(tmpdir(),'production-coordinator-'));
const previousData=process.env.OPENCHATCUT_DATA_DIR,previousFetch=globalThis.fetch;
process.env.OPENCHATCUT_DATA_DIR=root;
let requests=0;
const wires:Array<{path:string;model:string}>=[];
const host=createServer(async(req,res)=>{
 const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
 const body=JSON.parse(Buffer.concat(chunks).toString());
 wires.push({path:req.url!,model:body.model});requests++;
 res.writeHead(400,{'content-type':'application/json'});
 res.end(JSON.stringify({error:{message:'coordinator_probe_first_author_request_captured'}}));
});
try{
 await new Promise<void>((ok,fail)=>{host.once('error',fail);host.listen(0,'127.0.0.1',ok);});
 const address=host.address();assert(address&&typeof address!=='string');
 const origin=`http://127.0.0.1:${address.port}`;
 globalThis.fetch=async(input,init)=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  assert.equal(url.origin,origin,'no actual service/provider traffic');
  assert.equal(url.pathname,'/llm/chat/completions','only the first author transport is allowed');
  return previousFetch(input,init);
 };
 const {setStoredEntry,getStoredEntry}=await import('../plugins/project-store');
 const {loadOfflineStoredProject}=await import('../external-agent/offline-project-store');
 const {createAgentRun,appendAgentRunEvents,loadAgentRuntimeSidecar}=await import('../../src/persist/agentRuntimeStore');
 const {productionBlueprintReadiness}=await import('./production-readiness');
 const {reconcileBlockedBlueprint,productionStageWorker}=await import('./production-worker');
 const fixture=structuredClone(saved.cases[0]!.doc) as unknown as ProjectDoc;
 // Legal draft registration: keep the retained unit and its source plan, but no
 // current copy yet. Same draft boundary as source-breakdown.verify narrowedScope.
 delete (fixture.clipMentorAnalysis!.blueprint[0] as unknown as Record<string,unknown>).internal_review;
 assert.equal((await productionBlueprintReadiness(fixture)).code,'copy_scope_incomplete',
  'fixture must reach the real recoverable readiness condition, not a shape refusal');
 const input=(projectId:string):ProductionTask['input']=>({projectId,sourceAssetId:fixture.clipMentorAnalysis!.source.asset_id,
  product:{name:'Coordinator fixture',category:'local'},brief:'Local coordinator first-call verification',
  author:{provider:'openai',model:'coordinator-fixture-model',origin,apiMode:'chat'},
  reviewer:{provider:'openai',model:'coordinator-fixture-review',origin,apiMode:'chat'},humanBlueprintReview:true,
  budget:{model:4,review:2,observation:0,tts:0,render:0,preview_review:0,maxElapsedMs:120_000,maxRepairs:2}});
 const taskFor=(id:string,revision:string):ProductionTask=>({version:1,projectId:id,taskId:randomUUID(),input:input(id),
  stage:'blueprint',status:'blocked',createdAt:Date.now()-10_000,updatedAt:Date.now()+10_000,sequence:0,
  feedbackUsed:false,repairs:0,projectRevision:revision,error:'Error: copy_scope_incomplete',
  completed:{analysis:{at:Date.now()-9_000,artifact:{revision}}},
  attempts:{model:1,review:0,observation:0,tts:0,render:0,preview_review:0},
  effects:{'blueprint:initial:0:author-0':{kind:'model',status:'completed',operationId:randomUUID(),result:null}}});
 async function saveAuthor(task:ProductionTask,revision:string){
  const run:AgentRunRecord={version:1,runId:randomUUID(),projectId:task.projectId,status:'completed',askOnly:false,
   backend:'api',modelId:task.input.author.model,userInputDigest:'a'.repeat(64),userInputPreview:'fixture',
   createdAt:task.createdAt+2_000,updatedAt:task.createdAt+3_000,artifactIds:[],checkpointIds:[],proposalIds:[],events:[]};
  await createAgentRun(run);
  await appendAgentRunEvents(task.projectId,run.runId,[
   {type:'tool_outcome',summary:JSON.stringify({serverEvent:{type:'server-tool-result',data:{name:'revise_clipmentor_analysis',success:true,result:{saved:true,projectId:task.projectId,projectRevision:revision}}}})},
   {type:'final',summary:JSON.stringify({serverEvent:{type:'done',data:{status:'completed'}}})},
  ]);
  const persisted=(await loadAgentRuntimeSidecar(task.projectId)).runs.find(row=>row.runId===run.runId)!;
  assert.equal(persisted.events.length,2);assert.equal(persisted.status,'completed');
  assert(persisted.createdAt>=task.completed.analysis!.at&&persisted.updatedAt<=task.updatedAt,'matching author time window');
 }
 const authority=(t:ProductionTask)=>structuredClone({attempts:t.attempts,budget:t.input.budget,effects:t.effects,completed:t.completed});
 for(const mode of ['matching','wrong-write-revision','multiple-authors'] as const){
  const id='coordinator-'+mode;
  await setStoredEntry(`project:${id}`,structuredClone(fixture));
  await setStoredEntry(`versions:${id}`,[]);
  const snapshot=(await loadOfflineStoredProject(id))!;
  const task=taskFor(id,snapshot.revision),before=authority(task),projectBefore=JSON.stringify((await getStoredEntry(`project:${id}`)).value);
  await saveAuthor(task,mode==='wrong-write-revision'?'different-saved-revision':snapshot.revision);
  if(mode==='multiple-authors')await saveAuthor(task,snapshot.revision);
  if(mode==='matching'){
   await reconcileBlockedBlueprint(task);
   assert.equal(task.repairs,1);assert.deepEqual(task.technicalRecoveryEpochs,[1]);
   assert.equal(task.repairContext?.blueprint_structure_issue,'copy_scope_incomplete');
   assert.equal(task.projectRevision,snapshot.revision);
   const afterFirst=structuredClone(task);
   await assert.rejects(reconcileBlockedBlueprint(task),/blueprint_recovery_budget_or_effect_unverified/);
   assert.deepEqual(task,afterFirst,'old effect cannot grant a second epoch');
  }else{
   await assert.rejects(reconcileBlockedBlueprint(task),/blueprint_recovery_author_receipt_unverified/);
   assert.equal(task.repairs,0);assert.equal(task.technicalRecoveryEpochs,undefined);
   assert.equal(task.repairContext,undefined);
  }
  assert.deepEqual(authority(task),before,'reconcile does not replenish or spend original counters/effects');
  assert.equal(JSON.stringify((await getStoredEntry(`project:${id}`)).value),projectBefore);
  assert.deepEqual((await getStoredEntry(`versions:${id}`)).value,[]);
  console.log(`PASS real reconcile ${mode}: epoch=${task.repairs}; counters/effects/project unchanged`);
 }
 // Worker control uses the original saved complete project. No media file is
 // opened by blueprint authoring before the first local request.
 const workerId='coordinator-worker';
 await setStoredEntry(`project:${workerId}`,structuredClone(saved.cases[0]!.doc));
 await setStoredEntry(`versions:${workerId}`,[]);
 const workerSnapshot=(await loadOfflineStoredProject(workerId))!;
 const workerTask=taskFor(workerId,workerSnapshot.revision);workerTask.status='running';delete workerTask.error;
 const workerBefore=JSON.stringify((await getStoredEntry(`project:${workerId}`)).value);
 let modelReservations=0;
 const stage:StageContext={signal:new AbortController().signal,effect:async(kind,_key,work)=>{
  assert.equal(kind,'model','no media/review/render effects allowed');modelReservations++;
  return work(randomUUID());
 }};
 await assert.rejects(productionStageWorker(workerTask,stage),/author_stage_already_attempted/);
 assert.equal(requests,0);assert.equal(modelReservations,0);
 assert.equal((await loadAgentRuntimeSidecar(workerId)).runs.length,0,'duplicate guard precedes author run creation');
 const positive=structuredClone(workerTask);positive.effects={};
 // AI SDK turns the deliberate nonretryable HTTP 400 into its empty-stream error.
 // The strict wire count/model/path below is the first-call oracle.
 await assert.rejects(productionStageWorker(positive,stage),/No output generated\. Check the stream for errors\./);
 assert.equal(requests,1);assert.equal(modelReservations,1);
 assert.deepEqual(wires,[{path:'/llm/chat/completions',model:'coordinator-fixture-model'}]);
 assert.equal(JSON.stringify((await getStoredEntry(`project:${workerId}`)).value),workerBefore);
 assert.deepEqual((await getStoredEntry(`versions:${workerId}`)).value,[]);
 console.log('PASS real productionStageWorker: same-epoch model effect -> 0 author requests/0 reservations; same task with only prior effect removed -> exactly 1 local fake author request/1 reservation; project unchanged');
 console.log('PASS SM07/08 coordinator probe: isolated real store; zero actual provider/Codex/media/render/install');
}finally{
 globalThis.fetch=previousFetch;
 await new Promise<void>((ok,fail)=>{host.closeAllConnections();host.close(error=>error?fail(error):ok());});
 if(previousData===undefined)delete process.env.OPENCHATCUT_DATA_DIR;else process.env.OPENCHATCUT_DATA_DIR=previousData;
 const absolute=await realpath(root);
 assert.equal(absolute,join(await realpath(tmpdir()),root.slice(root.lastIndexOf('/')+1)));
 assert(root.startsWith(join(tmpdir(),'production-coordinator-')));
 await rm(absolute,{recursive:true,force:true});
}
