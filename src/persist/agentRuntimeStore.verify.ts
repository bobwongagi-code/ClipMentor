import assert from 'node:assert/strict';
import {configureSharedKvBackend} from './sharedKv';
import {createAgentRun,storeAgentArtifact,loadAgentArtifact,loadAgentRuntimeSidecar,subscribeAgentRuntime,sha256Text,archiveAgentArtifacts,type AgentArtifactRecord,type AgentRuntimeSidecar} from './agentRuntimeStore';

const entries=new Map<string,unknown>();
let failAfterPublication=false,unreadable=false,failReadbackAfterPublication=false,dropOld=false,failOldCleanup=false;
configureSharedKvBackend({
 get:async<T>(key:string)=>{if(unreadable&&key.startsWith('agent-runtime:'))throw Error('readback unavailable');return structuredClone(entries.get(key)) as T;},
 set:async(key,value)=>{entries.set(key,structuredClone(value));},
 delete:async key=>{if(failOldCleanup&&key.endsWith(':old'))throw Error('old cleanup unavailable');entries.delete(key);},
 keys:async()=>[...entries.keys()],updateAgentRunLease:async()=>{throw Error('unused');},
 writeAgentRuntime:async input=>{
  const incoming=structuredClone(input.value) as AgentRuntimeSidecar;
  const value=dropOld?{...incoming,artifacts:incoming.artifacts.filter(a=>a.artifactId!=='old'),runs:incoming.runs.map(r=>({...r,artifactIds:r.artifactIds.filter(id=>id!=='old')}))}:incoming;
  entries.set(input.key,value);
  if(failAfterPublication){failAfterPublication=false;unreadable=failReadbackAfterPublication;throw Error('published response lost');}
  return {accepted:true,found:true,value};
 },
});
const projectId='runtime-publication-faults',runId='run';
await createAgentRun({version:1,projectId,runId,status:'running',askOnly:false,userInputPreview:'fixture',userInputDigest:'a'.repeat(64),createdAt:1,updatedAt:1,artifactIds:[],checkpointIds:[],proposalIds:[],events:[]});
const record=async(artifactId:string):Promise<AgentArtifactRecord>=>{
 const body='immutable evidence '+artifactId;
 return {version:1,projectId,runId,artifactId,kind:'checkpoint-source',toolName:'clipmentor-production-task',body,bodySha256:await sha256Text(body),originalBytes:Buffer.byteLength(body),originalChars:body.length,createdAt:2,redacted:false,binaryOmitted:false};
};
let observed=0;
const stopBroken=subscribeAgentRuntime(projectId,()=>{throw Error('broken subscriber');});
const stopHealthy=subscribeAgentRuntime(projectId,()=>{observed++;});
const notified=await record('notified');
assert.equal(await storeAgentArtifact(notified),true);
assert.deepEqual(await loadAgentArtifact(projectId,notified.artifactId),notified);
assert.equal(observed,1,'one failed observer cannot hide the update from later observers');
stopBroken();stopHealthy();

let rejectedObservers=0;
const observeRejection=()=>{rejectedObservers++;};process.on('unhandledRejection',observeRejection);
const stopAsync=subscribeAgentRuntime(projectId,async()=>{throw Error('async observer unavailable');});
try{
 const asyncRecord=await record('async_notified');assert(await storeAgentArtifact(asyncRecord));
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(rejectedObservers,0,'an async observer cannot crash the host after a durable publication');
 assert.deepEqual(await loadAgentArtifact(projectId,asyncRecord.artifactId),asyncRecord);
}finally{stopAsync();process.off('unhandledRejection',observeRejection);}

const old=await record('old');assert(await storeAgentArtifact(old));
dropOld=true;failOldCleanup=true;
const retained=await record('retained');
assert.equal(await storeAgentArtifact(retained),true,'cleanup failure follows a successful durable publication');
assert.deepEqual(await loadAgentArtifact(projectId,retained.artifactId),retained);
dropOld=false;failOldCleanup=false;

for(const unknownReadback of [false,true]){
 const uncertain=await record(unknownReadback?'unknown_readback':'lost_response');
 failAfterPublication=true;failReadbackAfterPublication=unknownReadback;
 await assert.rejects(storeAgentArtifact(uncertain),/published response lost/);
 unreadable=false;
 assert((await loadAgentRuntimeSidecar(projectId)).artifacts.some(a=>a.artifactId===uncertain.artifactId));
 assert.deepEqual(await loadAgentArtifact(projectId,uncertain.artifactId),uncertain,'unknown publication cannot remove an already indexed body');
}
const archive={...await record('archived'),toolName:'clipmentor-production-task-history'};
failAfterPublication=true;failReadbackAfterPublication=false;
await assert.rejects(archiveAgentArtifacts(archive,[retained]),/published response lost/);
assert.deepEqual(await loadAgentArtifact(projectId,archive.artifactId),archive,'archive response loss preserves its published body');
assert.equal(await loadAgentArtifact(projectId,retained.artifactId),null,'index swap remains authoritative');
configureSharedKvBackend(undefined);
console.log('PASS runtime publication survives observer, cleanup, response-loss and unavailable-readback faults; zero providers');
