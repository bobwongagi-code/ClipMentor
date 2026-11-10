import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {configureSharedKvBackend} from '../../src/persist/sharedKv';
import {agentArtifactKey,createAgentRun,loadAgentRuntimeSidecar,storeAgentArtifact,type AgentArtifactRecord} from '../../src/persist/agentRuntimeStore';
import type {ProductionTask} from './production-task';
import {compactProductionTaskHistory} from './production-task-history';

// The index is the publication authority. A missing current body is not evidence
// that the preceding checkpoint (with fewer spent attempts) is current again.
const directory=await mkdtemp(join(tmpdir(),'checkpoint-boundary-')),previousData=process.env.OPENCHATCUT_DATA_DIR;
process.env.OPENCHATCUT_DATA_DIR=directory;
const {productionTaskStore,latestPanelProductionTask,reconcileLegacyTechnicalRecoveries}=await import('./production-task');
const {runtimeProfile}=await import('../runtime-profile');assert.equal(runtimeProfile().rootDir,directory);
const entries=new Map<string,unknown>();
configureSharedKvBackend({
 get:async<T>(key:string)=>structuredClone(entries.get(key)) as T,
 set:async(key,value)=>{entries.set(key,structuredClone(value));},
 delete:async key=>{entries.delete(key);},keys:async()=>[...entries.keys()],
 writeAgentRuntime:async input=>{entries.set(input.key,structuredClone(input.value));return {accepted:true,found:true,value:input.value};},
 updateAgentRunLease:async()=>{throw Error('unused');},
});
let fixtures=0;
const seed=async()=>{
 const projectId='checkpoint-'+(++fixtures),taskId='task';
 await createAgentRun({version:1,projectId,runId:taskId,status:'running',askOnly:false,userInputPreview:'offline',userInputDigest:'a'.repeat(64),createdAt:1,updatedAt:1,artifactIds:[],checkpointIds:[],proposalIds:[],events:[]});
 const task:ProductionTask={version:1,taskId,projectId,stage:'analysis',status:'queued',createdAt:1,updatedAt:1,sequence:0,
  input:{projectId,sourceAssetId:'source',product:{name:'fixture',category:'fixture'},brief:'offline',humanBlueprintReview:true,
   author:{provider:'openai',model:'fixture',origin:'http://fixture.invalid',apiMode:'responses'},reviewer:{provider:'openai',model:'fixture',origin:'http://fixture.invalid',apiMode:'responses'},
   budget:{model:0,observation:1,review:0,tts:0,render:0,maxElapsedMs:1000,maxRepairs:0}},
  completed:{},effects:{},attempts:{model:0,observation:0,review:0,tts:0,render:0},repairs:0,feedbackUsed:false};
 await productionTaskStore.save(task);
 task.status='running';task.attempts.observation=1;
 task.effects['analysis:initial:0:observe']={kind:'observation',status:'reserved',operationId:crypto.randomUUID()};
 await productionTaskStore.save(task);
 const sidecar=await loadAgentRuntimeSidecar(projectId),index=sidecar.artifacts.at(-1)!;
 const key=agentArtifactKey(projectId,index.artifactId,sidecar.sessionGeneration??'legacy');
 return {task,sidecar,index,key,body:structuredClone(entries.get(key)) as AgentArtifactRecord};
};
const failures:string[]=[];
async function check(name:string,run:()=>Promise<void>){try{await run();console.log('PASS '+name);}catch(error){failures.push(name);console.error('FAIL '+name,error);}}
const publish=async(task:ProductionTask,body:string,createdAt:number,toolName='clipmentor-production-task')=>{
 const record:AgentArtifactRecord={version:1,projectId:task.projectId,runId:task.taskId,artifactId:'p_'+crypto.randomUUID().replaceAll('-','').slice(0,18),kind:'checkpoint-source',toolName,
  body,bodySha256:createHash('sha256').update(body).digest('hex'),originalBytes:Buffer.byteLength(body),originalChars:body.length,createdAt,redacted:false,binaryOmitted:false};
 assert(await storeAgentArtifact(record));return record;
};
try{
 await check('ordinary cold load preserves the spent count and unknown reservation',async()=>{
  const {task}=await seed();assert.deepEqual(await productionTaskStore.load(task.projectId,task.taskId),task);
 });
 for(const fault of ['missing','corrupt'] as const)await check('current '+fault+' body cannot roll back to a cheaper checkpoint',async()=>{
  const {task,key,body}=await seed();
  if(fault==='missing')entries.delete(key);else entries.set(key,{...body,body:body.body+'!'});
  await assert.rejects(productionTaskStore.load(task.projectId,task.taskId),/production_checkpoint_unavailable/);
  await assert.rejects(latestPanelProductionTask(task.projectId),/production_checkpoint_unavailable/);
  assert.equal(task.attempts.observation,1);assert.equal(task.effects['analysis:initial:0:observe'].status,'reserved');
 });
 await check('a self-consistent replacement body must still match its published index',async()=>{
  const {task,key,body}=await seed(),changed=structuredClone(task);changed.attempts.observation=0;changed.effects={};
  const text=JSON.stringify({type:'clipmentor-production-task/v1',task:changed});
  entries.set(key,{...body,body:text,bodySha256:createHash('sha256').update(text).digest('hex'),originalBytes:Buffer.byteLength(text),originalChars:text.length});
  await assert.rejects(productionTaskStore.load(task.projectId,task.taskId),/production_checkpoint_index_mismatch/);
 });
 for(const fault of ['envelope','identity','json'] as const)await check('current '+fault+' error refuses instead of selecting history',async()=>{
  const {task}=await seed();
  const text=fault==='json'?'{broken':JSON.stringify({type:fault==='envelope'?'another-protocol':'clipmentor-production-task/v1',task:{...task,taskId:fault==='identity'?'another-task':task.taskId}});
  await publish(task,text,task.updatedAt+10);
  await assert.rejects(productionTaskStore.load(task.projectId,task.taskId),/production_checkpoint_invalid/);
 });
 await check('a corrupt old checkpoint does not prevent reading the valid latest checkpoint',async()=>{
  const {task,sidecar}=await seed();entries.delete(agentArtifactKey(task.projectId,sidecar.artifacts[0].artifactId,sidecar.sessionGeneration??'legacy'));
  assert.deepEqual(await productionTaskStore.load(task.projectId,task.taskId),task);
 });
 await check('equal timestamps use latest publication, including the latest panel task',async()=>{
  const {task}=await seed(),timestamp=task.updatedAt+100;
  const earlier={...task,status:'queued',sequence:20},later={...task,status:'cancelled',sequence:21};
  await publish(task,JSON.stringify({type:'clipmentor-production-task/v1',task:earlier}),timestamp);
  await publish(task,JSON.stringify({type:'clipmentor-production-task/v1',task:later}),timestamp);
  assert.equal((await productionTaskStore.load(task.projectId,task.taskId)).status,'cancelled');
  const newer={...later,taskId:'second-task'};
  await createAgentRun({version:1,projectId:task.projectId,runId:newer.taskId,status:'running',askOnly:false,userInputPreview:'offline',userInputDigest:'b'.repeat(64),createdAt:1,updatedAt:1,artifactIds:[],checkpointIds:[],proposalIds:[],events:[]});
  await publish(newer,JSON.stringify({type:'clipmentor-production-task/v1',task:newer}),timestamp);
  assert.equal((await latestPanelProductionTask(task.projectId))?.taskId,newer.taskId);
 });
 await check('compaction keeps the two latest publications when their timestamps tie',async()=>{
  const {task}=await seed(),timestamp=task.updatedAt+100;
  for(const [offset,status] of (['queued','running','blocked','cancelled'] as const).entries())
   await publish(task,JSON.stringify({type:'clipmentor-production-task/v1',task:{...task,status,sequence:10+offset}}),timestamp);
  for(let i=0;i<188;i++)await publish(task,'unrelated local evidence',1,'other-evidence');
  assert(await compactProductionTaskHistory(task.projectId,task.taskId));
  const loaded=await productionTaskStore.load(task.projectId,task.taskId);
  assert.equal(loaded.status,'cancelled');assert.equal(loaded.sequence,13);assert.equal(loaded.attempts.observation,1);
 });
 const legacySubject=(task:ProductionTask)=>{task.stage='copy_review';task.status='blocked';task.repairs=1;task.error='Error: 已用完自动返修额度';task.repairContext={author_self_check:[]};};
 const legacyPair=(task:ProductionTask,sequence:number)=>{
  const before={...structuredClone(task),sequence,stage:'blueprint' as const,status:'blocked' as const,repairs:0,error:'Error: copy_scope_incomplete',projectRevision:'historical-revision'};
  const after={...structuredClone(before),sequence:sequence+1,status:'running' as const,repairs:1,repairContext:{blueprint_structure_issue:'copy_scope_incomplete'}};
  return [before,after];
 };
 await check('legacy accounting cannot consume a self-consistent replacement history body',async()=>{
  const {task,sidecar}=await seed();legacySubject(task);await productionTaskStore.save(task);
  for(const [i,row] of legacyPair(task,1).entries()){
   const key=agentArtifactKey(task.projectId,sidecar.artifacts[i].artifactId,sidecar.sessionGeneration??'legacy'),stored=entries.get(key) as AgentArtifactRecord;
   const body=JSON.stringify({type:'clipmentor-production-task/v1',task:row});
   entries.set(key,{...stored,body,bodySha256:createHash('sha256').update(body).digest('hex'),originalBytes:Buffer.byteLength(body),originalChars:body.length});
  }
  const unchanged=structuredClone(task);
  await assert.rejects(reconcileLegacyTechnicalRecoveries(task),/production_checkpoint_index_mismatch/);
  assert.deepEqual(task,unchanged);
 });
 await check('valid published legacy transitions retain their existing accounting',async()=>{
  const {task}=await seed();legacySubject(task);task.sequence=12;
  for(const row of legacyPair(task,10))await publish(task,JSON.stringify({type:'clipmentor-production-task/v1',task:row}),row.sequence);
  const attempts=structuredClone(task.attempts);await reconcileLegacyTechnicalRecoveries(task);
  assert.deepEqual(task.technicalRecoveryEpochs,[1]);assert.deepEqual(task.attempts,attempts);assert.equal(task.repairs,1);
 });
 await check('missing older legacy evidence grants no extra accounting',async()=>{
  const {task,sidecar}=await seed();legacySubject(task);
  entries.delete(agentArtifactKey(task.projectId,sidecar.artifacts[0].artifactId,sidecar.sessionGeneration??'legacy'));
  await reconcileLegacyTechnicalRecoveries(task);assert.equal(task.technicalRecoveryEpochs,undefined);
 });
 await check('same-sequence settled review survives a later stale writer and compaction',async()=>{
   assert.equal(runtimeProfile().rootDir,directory);
   const {projectDoc}=await import('../external-agent/offline-runtime.verify-fixtures');
   const {setStoredEntry}=await import('../plugins/project-store');
   const {loadOfflineStoredProject}=await import('../external-agent/offline-project-store');
   const {task}=await seed(),doc=projectDoc(),digest='d'.repeat(64);
   doc.clipMentorAnalysis={schema_version:1,analysis_id:'analysis',revision:1,source:{asset_id:'source',sourceContentHash:null,duration_seconds:1,fps:30},
    product:{name:'fixture',category:'fixture'},import_origin:'offline-test',evidence:[],points:[],blueprint:[],transcripts:[],reviews:[],audit:[],
    production_copy_review:{scope:'copy_and_planned_picture_only',protocol:'test',analysis_revision:1,content_digest:digest,author_run_id:'author',reviewer_run_id:'reviewer',reviewed_at:1,
     verdict:'insufficient_evidence',units:[{unit_id:'unit',candidate_id:'candidate',verdict:'insufficient_evidence',findings:[]}]}};
   await setStoredEntry('project:'+task.projectId,doc);
   const snapshot=await loadOfflineStoredProject(task.projectId);assert(snapshot);
   const stale={...structuredClone(task),stage:'copy_review' as const,status:'blocked' as const,sequence:12,
    error:'Error: production_project_changed; reconcile the saved project before resuming',completed:{},effects:{'copy_review:initial:0:operation':{kind:'review' as const,status:'reserved' as const,operationId:'operation'}}};
   stale.attempts.review=1;
   const settled={...structuredClone(stale),projectRevision:snapshot.revision,error:'Error: 已用完自动返修额度',effects:{'copy_review:initial:0:operation':{
    kind:'review' as const,status:'completed' as const,operationId:'operation',result:{status:200,body:{operationId:'operation',receipt:{content_digest:digest,verdict:'insufficient_evidence'}}}}}};
   const timestamp=task.updatedAt+100;
   for(const row of [settled,stale])await publish(task,JSON.stringify({type:'clipmentor-production-task/v1',task:row}),timestamp);
   assert.deepEqual(await productionTaskStore.load(task.projectId,task.taskId),settled);
   for(let i=0;i<188;i++)await publish(task,'unrelated local evidence',1,'other-evidence');
   assert(await compactProductionTaskHistory(task.projectId,task.taskId));
   assert.deepEqual(await productionTaskStore.load(task.projectId,task.taskId),settled);
   // A negative receipt must never be reinterpreted as pass by this arbitration.
   doc.clipMentorAnalysis.production_copy_review!.verdict='pass';
   await setStoredEntry('project:'+task.projectId,doc);
   assert.deepEqual(await productionTaskStore.load(task.projectId,task.taskId),stale);
 });
}finally{
 configureSharedKvBackend(undefined);
 if(previousData===undefined)delete process.env.OPENCHATCUT_DATA_DIR;else process.env.OPENCHATCUT_DATA_DIR=previousData;
 await rm(directory,{recursive:true,force:true});
}
assert.deepEqual(failures,[]);
console.log('Production checkpoint read authority: all offline cases passed; zero providers and production writes');
