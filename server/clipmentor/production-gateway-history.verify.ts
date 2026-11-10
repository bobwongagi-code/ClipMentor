import assert from 'node:assert/strict';
import {configureSharedKvBackend} from '../../src/persist/sharedKv';
import {agentArtifactKey,agentRuntimeKey,createAgentRun,loadAgentRuntimeSidecar,loadAgentArtifact,archiveAgentArtifacts,type AgentArtifactRecord} from '../../src/persist/agentRuntimeStore';
import {recoverProductionGateway} from './production-recovery';
import {productionGatewayDecisionArtifact,persistProductionGatewayDecision} from './production-worker';
import {productionTaskStore,type ProductionTask} from './production-task';
import {unpackProductionHistory} from './production-task-history';
const entries=new Map<string,unknown>();
let cleanupKey:string|undefined,cleanupFaults=0,cleanupAfterPublish=false;
configureSharedKvBackend({get:async<T>(k:string)=>structuredClone(entries.get(k)) as T,set:async(k,v)=>{entries.set(k,structuredClone(v));},delete:async k=>{if(k===cleanupKey&&!cleanupFaults){cleanupFaults++;const sidecar=entries.get(agentRuntimeKey('gateway-history')) as any;cleanupAfterPublish=!!sidecar?.artifacts.some((a:any)=>a.toolName==='clipmentor-production-task-history')&&!sidecar.artifacts.some((a:any)=>agentArtifactKey('gateway-history',a.artifactId)===k);throw Error('fixture cleanup failure');}entries.delete(k);},keys:async()=>[...entries.keys()],writeAgentRuntime:async r=>{entries.set(r.key,structuredClone(r.value));return {accepted:true,found:true,value:r.value};},updateAgentRunLease:async()=>{throw Error('unused');}});
const fetch=globalThis.fetch;let external=0;globalThis.fetch=async()=>{external++;throw Error('external forbidden');};
try{
 const projectId='gateway-history',taskId='gateway-run';
 const task={version:1,projectId,taskId,stage:'analysis',status:'running',createdAt:1,updatedAt:1,sequence:0,input:{budget:{observation:1000}},completed:{},effects:{reserved:{kind:'observation',status:'reserved',operationId:'original'}},attempts:{model:0,review:0,observation:0,tts:0,render:0},feedbackUsed:false,repairs:0} as unknown as ProductionTask;
 await createAgentRun({version:1,projectId,runId:taskId,status:'running',askOnly:false,userInputPreview:'fixture',userInputDigest:'a'.repeat(64),createdAt:1,updatedAt:1,artifactIds:[],checkpointIds:[],proposalIds:[],events:[]});
 const originals:AgentArtifactRecord[]=[];let calls=0,last:any;
 const started=performance.now();
 await recoverProductionGateway('observe_clipmentor_source_video',{operationId:crypto.randomUUID(),maxRequests:1},projectId,()=>calls<1000,async args=>{
  calls++;task.attempts.observation++;
  last={error:'transient fixture',receipt:{status:'failed',operationId:args.operationId,projectId,requestsAttempted:1,receipt_persisted:true,phase:'gateway_request',upstream_http_status:500,actual_handoff_verified:false,complete_film_accepted:false,source_hash:'a'.repeat(64),subject:{digest:'b'.repeat(64),revision:1}}};return last;
 },async()=>{},1000,{allowRetry:true,readOriginal:async()=>({ok:true,current_binding:'current',receipt:last.receipt}),recordDecision:async d=>{
  const record=productionGatewayDecisionArtifact(task,'r1','observation',d,1000-calls);originals.push(record);cleanupKey??=agentArtifactKey(projectId,record.artifactId);await persistProductionGatewayDecision(record);
 }});
 assert.equal(calls,1000);await productionTaskStore.save(task);
 const loaded=await productionTaskStore.load(projectId,taskId);assert.equal(loaded.attempts.observation,1000);assert.deepEqual(loaded.effects,task.effects);
 const all:AgentArtifactRecord[]=[],sidecar=await loadAgentRuntimeSidecar(projectId);
 for(const index of sidecar.artifacts){const row=await loadAgentArtifact(projectId,index.artifactId);assert(row);if(row.toolName==='clipmentor-production-task-history')all.push(...unpackProductionHistory(row));else all.push(row);}
 const decisions=all.filter(r=>r.toolName==='clipmentor-gateway-recovery');assert.equal(decisions.length,originals.length);assert.equal(new Set(decisions.map(r=>r.artifactId)).size,decisions.length);
 for(const record of originals)assert.deepEqual(decisions.find(r=>r.artifactId===record.artifactId),record,'all decisions retained exactly');
 assert.equal(cleanupFaults,1);assert(cleanupAfterPublish,'cleanup failure injected after durable archive publication');assert(entries.has(cleanupKey!));assert.equal(await loadAgentArtifact(projectId,originals[0].artifactId),null,'unindexed leftover bytes are not independently authorized');
 const archived=originals.find(r=>!sidecar.artifacts.some(i=>i.artifactId===r.artifactId));assert(archived);
 const before=structuredClone(await loadAgentRuntimeSidecar(projectId));
 await persistProductionGatewayDecision({...archived,createdAt:archived.createdAt+1});assert.deepEqual(await loadAgentRuntimeSidecar(projectId),before,'archived decision replay must write nothing');
 await assert.rejects(persistProductionGatewayDecision({...archived,body:'changed'}),/not_saved/);
 await assert.rejects(persistProductionGatewayDecision({...archived,runId:'wrong-owner'}),/not_saved/);
 const archiveIndex=sidecar.artifacts.find(r=>r.toolName==='clipmentor-production-task-history');assert(archiveIndex);const archive=await loadAgentArtifact(projectId,archiveIndex.artifactId);assert(archive);
 const freshRun='healthy-new-run';await createAgentRun({version:1,projectId,runId:freshRun,status:'running',askOnly:false,userInputPreview:'fixture',userInputDigest:'b'.repeat(64),createdAt:1,updatedAt:1,artifactIds:[],checkpointIds:[],proposalIds:[],events:[]});
 await assert.rejects(persistProductionGatewayDecision({...archived,runId:freshRun}),/not_saved/,'an existing different owner cannot borrow the archived ID');
 const archiveKey=agentArtifactKey(projectId,archiveIndex.artifactId),savedArchive=entries.get(archiveKey);entries.delete(archiveKey);
 try{
  await assert.rejects(persistProductionGatewayDecision(archived),/history_unavailable/,'a cached matching decision must reverify its current archive body');
  const healthy=productionGatewayDecisionArtifact({...task,taskId:freshRun},'r2','observation',{operation_id:'healthy',action:'stop',reason:'budget_or_deadline_exhausted'},0);
  await persistProductionGatewayDecision(healthy);assert(await loadAgentArtifact(projectId,healthy.artifactId),'unrelated old-run corruption cannot block a healthy run');
 }finally{entries.set(archiveKey,savedArchive);}
 const other={...originals.at(-1)!,toolName:'unrelated-tool'};
 assert.equal(await archiveAgentArtifacts({...archive,artifactId:'h_forbidden'},[other]),false,'no blanket archive permission');
 assert.equal(external,0);console.log(`PASS 1000 fake gateway responses, ${decisions.length} exact decisions, bounded ${sidecar.artifacts.length} slots, checkpoint/counters preserved; archived replay and wrong-owner/content controls; ${Math.round(performance.now()-started)}ms; zero external calls`);
}finally{globalThis.fetch=fetch;configureSharedKvBackend(undefined);}
