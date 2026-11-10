import assert from 'node:assert/strict';
import {configureSharedKvBackend} from './sharedKv';
import {createAgentRun,appendAgentRunEvents,patchAgentRun,agentRuntimeKey,storeAgentArtifact,loadAgentArtifact,loadAgentRuntimeSidecar,subscribeAgentRuntime,sha256Text,archiveAgentArtifacts,type AgentArtifactRecord,type AgentRuntimeSidecar} from './agentRuntimeStore';
import {rotateAgentSessionGeneration} from './agentSessionGeneration';

const entries=new Map<string,unknown>();
let failAfterPublication=false,unreadable=false,failReadbackAfterPublication=false,dropOld=false,failOldCleanup=false;
let runtimeWrites=0,failBeforePublication=false;
let beforeRuntimeWrite:(()=>Promise<void>)|undefined;
configureSharedKvBackend({
 get:async<T>(key:string)=>{if(unreadable&&key.startsWith('agent-runtime:'))throw Error('readback unavailable');return structuredClone(entries.get(key)) as T;},
 set:async(key,value)=>{entries.set(key,structuredClone(value));},
 delete:async key=>{if(failOldCleanup&&key.endsWith(':old'))throw Error('old cleanup unavailable');entries.delete(key);},
 keys:async()=>[...entries.keys()],updateAgentRunLease:async()=>{throw Error('unused');},
 writeAgentRuntime:async input=>{
  runtimeWrites++;if(failBeforePublication)throw Error('publication unavailable');
  const hook=beforeRuntimeWrite;beforeRuntimeWrite=undefined;await hook?.();
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
let batchNotifications=0;
const stopBatch=subscribeAgentRuntime(projectId,()=>{batchNotifications++;});
try{
 const batch:Array<{type:'final';summary:string}>=[{type:'final',summary:'first'},{type:'final',summary:'second'},{type:'final',summary:'last'}];
 const writesBefore=runtimeWrites;
 const pendingBatch=appendAgentRunEvents(projectId,runId,batch);batch.length=0;
 const appended=await pendingBatch;
 assert.equal(runtimeWrites-writesBefore,1,'one recovery suffix uses one existing authority write, not N per-event writes');
 assert.equal(batchNotifications,1);
 assert.deepEqual(appended.map(e=>e.summary),['first','second','last'],'caller array mutation cannot truncate a queued suffix');
 assert.deepEqual(appended.map(e=>e.sequence),[1,2,3]);assert.equal(new Set(appended.map(e=>e.eventId)).size,3);
 const emptyWrites=runtimeWrites;assert.deepEqual(await appendAgentRunEvents(projectId,runId,[]),[]);assert.equal(runtimeWrites,emptyWrites);
 const beforeFailure=(await loadAgentRuntimeSidecar(projectId)).runs.find(r=>r.runId===runId)!.events;
 failBeforePublication=true;
 await assert.rejects(appendAgentRunEvents(projectId,runId,[{type:'final',summary:'must not appear'}]),/publication unavailable/);
 failBeforePublication=false;
 assert.deepEqual((await loadAgentRuntimeSidecar(projectId)).runs.find(r=>r.runId===runId)!.events,beforeFailure);
 failAfterPublication=true;failReadbackAfterPublication=false;
 await assert.rejects(appendAgentRunEvents(projectId,runId,[{type:'final',summary:'received'},{type:'final',summary:'done'}]),/published response lost/);
 assert.deepEqual((await loadAgentRuntimeSidecar(projectId)).runs.find(r=>r.runId===runId)!.events.slice(-2).map(e=>e.summary),['received','done'],'lost acknowledgement preserves the entire published suffix');
}finally{stopBatch();failBeforePublication=false;}
// A queued old recovery must not follow the mutable write-generation pointer
// into a cleared session, even when the client deliberately reuses the run ID.
const generationProject='runtime-recovery-generation',reusedId='client-run-id';
await createAgentRun({version:1,projectId:generationProject,runId:reusedId,status:'running',askOnly:false,userInputPreview:'server:fixture',userInputDigest:'a'.repeat(64),createdAt:1,updatedAt:1,artifactIds:[],checkpointIds:[],proposalIds:[],events:[]});
const oldGeneration=await loadAgentRuntimeSidecar(generationProject);
const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
beforeRuntimeWrite=async()=>{entered.resolve();await release.promise;};
const blocking=patchAgentRun(generationProject,reusedId,{context:{requestShapeHash:'a'.repeat(64)}});
await entered.promise;
const staleAppend=appendAgentRunEvents(generationProject,reusedId,[{type:'tool_outcome',toolCallId:'old-call',outcome:{kind:'outcome_unknown',operationId:'old-call'}}],{
 sessionGeneration:'legacy',expectedSequence:0,context:{requestShapeHash:'a'.repeat(64)},
});
const refused=assert.rejects(staleAppend,/event generation changed/,'Old-generation queued recovery must be refused before touching the new session');
try{
 const generation=await rotateAgentSessionGeneration(generationProject);
 const fresh={...oldGeneration,sessionGeneration:generation,revision:0,
  runs:oldGeneration.runs.map(r=>({...r,context:{requestShapeHash:'b'.repeat(64)}})),
  approvals:[{version:1,approvalId:'new-approval',projectId:generationProject,runId:reusedId,toolCallId:'new-call',toolName:'read_timeline',argsDigest:'b'.repeat(64),status:'pending',createdAt:1}],
 };
 entries.set(agentRuntimeKey(generationProject,generation),structuredClone(fresh));
 const protectedNew=JSON.stringify(entries.get(agentRuntimeKey(generationProject,generation)));
 release.resolve();await blocking;await refused;
 assert.equal(JSON.stringify(entries.get(agentRuntimeKey(generationProject,generation))),protectedNew,'old recovery cannot append outcomes, cancel approvals or replace context in the new session');
}finally{release.resolve();beforeRuntimeWrite=undefined;}
configureSharedKvBackend(undefined);
console.log('PASS runtime publication survives observer, cleanup, response-loss and unavailable-readback faults; zero providers');
