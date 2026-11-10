import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';

const directory=await mkdtemp(join(tmpdir(),'runtime-write-boundary-')),previousData=process.env.OPENCHATCUT_DATA_DIR,previousFetch=globalThis.fetch;
process.env.OPENCHATCUT_DATA_DIR=directory;
globalThis.fetch=async()=>{throw Error('Network forbidden');};
const {runtimeProfile}=await import('../runtime-profile');assert.equal(runtimeProfile().rootDir,directory);
const {getStoredEntry,setStoredEntry,mergeStoredEntries,deleteStoredEntry,readStore,writeAgentRuntime,updateStoredAgentRunLease}=await import('./project-store');
const {activateOfflineAgentRuntimeBackend}=await import('../external-agent/agent-runtime-persistence');
const {createAgentRun,storeAgentArtifact,loadAgentArtifact}=await import('../../src/persist/agentRuntimeStore');
const {configureSharedKvBackend,resetSharedKvMemory,kvWriteAgentRuntime,kvGet}=await import('../../src/persist/sharedKv');
const {normalizeAgentRuntimeSidecar}=await import('../../src/persist/agentRuntimeCodec');
import type {AgentRuntimeSidecar,AgentArtifactRecord} from '../../src/persist/agentRuntimeTypes';
activateOfflineAgentRuntimeBackend();
let fixture=0;
const seed=async()=>{
 const projectId='runtime-cas-'+(++fixture),runId='run',key='agent-runtime:'+projectId;
 await createAgentRun({version:1,projectId,runId,status:'running',askOnly:false,userInputPreview:'offline',userInputDigest:'a'.repeat(64),createdAt:1,updatedAt:1,artifactIds:[],checkpointIds:[],proposalIds:[],events:[]});
 return {projectId,runId,key,initial:structuredClone((await getStoredEntry(key)).value) as AgentRuntimeSidecar};
};
const artifact=(projectId:string,runId:string,artifactId:string):AgentArtifactRecord=>{
 const body='immutable reserved-operation evidence '+artifactId;
 return {version:1,projectId,runId,artifactId,kind:'checkpoint-source',toolName:'offline-fixture',body,bodySha256:createHash('sha256').update(body).digest('hex'),originalBytes:Buffer.byteLength(body),originalChars:body.length,createdAt:Date.now(),redacted:false,binaryOmitted:false};
};
const next=(value:AgentRuntimeSidecar)=>({...structuredClone(value),revision:value.revision+1});
const failures:string[]=[];
async function check(name:string,run:()=>Promise<void>){try{await run();console.log('PASS '+name);}catch(error){failures.push(name);console.error('FAIL '+name,error);}}
try{
 await check('server refuses a late stale snapshot without dropping published evidence',async()=>{
  const {projectId,runId,key,initial}=await seed(),evidence=artifact(projectId,runId,'reserved');assert(await storeAgentArtifact(evidence));
  const current=await getStoredEntry(key),result=await writeAgentRuntime({key,expectedRevision:initial.revision,value:next(initial)});
  assert.equal(result.accepted,false);assert.deepEqual(result.value,current.value);assert.deepEqual(await getStoredEntry(key),current);
  assert.deepEqual(await loadAgentArtifact(projectId,evidence.artifactId),evidence);
 });
 await check('server creation requires absence, not just a fresh caller',async()=>{
  const {key,initial}=await seed(),before=await getStoredEntry(key);
  assert.equal((await writeAgentRuntime({key,expectedRevision:null,value:next(initial)})).accepted,false);
  assert.deepEqual(await getStoredEntry(key),before);
 });
 await check('server accepts current revision and advances exactly one generation',async()=>{
  const {key,initial}=await seed(),updated=next(initial);
  const result=await writeAgentRuntime({key,expectedRevision:initial.revision,value:updated});
  assert.equal(result.accepted,true);assert.equal((result.value as AgentRuntimeSidecar).revision,initial.revision+1);
 });
 await check('server rejects unchanged or jumped successor versions',async()=>{
  const {key,initial}=await seed(),before=await getStoredEntry(key);
  for(const revision of [initial.revision,initial.revision+2])
   await assert.rejects(writeAgentRuntime({key,expectedRevision:initial.revision,value:{...initial,revision}}),/runtime.*revision/i);
  assert.deepEqual(await getStoredEntry(key),before);
 });
 await check('a lease renewal cannot be overwritten by its preceding snapshot',async()=>{
  const {key,runId}=await seed();
  const claimed=await updateStoredAgentRunLease({key,runId,action:'claim',ownerInstanceId:'fixture-owner',leaseMs:10000});assert(claimed.accepted&&claimed.lease);
  const before=structuredClone((await getStoredEntry(key)).value) as AgentRuntimeSidecar;
  const renewed=await updateStoredAgentRunLease({key,runId,action:'renew',ownerInstanceId:'fixture-owner',leaseToken:claimed.lease.leaseToken,leaseMs:20000});assert(renewed.accepted);
  const canonical=await getStoredEntry(key);
  assert.equal((await writeAgentRuntime({key,expectedRevision:before.revision,value:next(before)})).accepted,false);
  assert.deepEqual(await getStoredEntry(key),canonical);
 });
 await check('existing local mutation rebases after contention and preserves both publications',async()=>{
  const {key,projectId,runId,initial}=await seed(),other=artifact(projectId,runId,'other'),own=artifact(projectId,runId,'own');
  assert(await storeAgentArtifact(other));let stale=true,writes=0;
  configureSharedKvBackend({
   get:async<T>(name:string)=>{if(name===key&&stale){stale=false;return structuredClone(initial) as T;}const entry=await getStoredEntry(name);return entry.found?entry.value as T:undefined;},
   set:setStoredEntry,delete:deleteStoredEntry,keys:async()=>Object.keys((await readStore()).entries),
   writeAgentRuntime:async input=>{writes++;return writeAgentRuntime(input);},updateAgentRunLease:updateStoredAgentRunLease,
  });
  try{
   assert(await storeAgentArtifact(own));assert.equal(writes,2,'one local conflict, then one re-read; no provider retry');
   assert.deepEqual(await loadAgentArtifact(projectId,other.artifactId),other);assert.deepEqual(await loadAgentArtifact(projectId,own.artifactId),own);
  }finally{activateOfflineAgentRuntimeBackend();}
 });
 await check('terminal run protection remains in force at the current revision',async()=>{
  const {key,initial}=await seed(),terminal={...next(initial),runs:initial.runs.map(run=>({...run,status:'completed' as const}))};
  assert((await writeAgentRuntime({key,expectedRevision:initial.revision,value:terminal})).accepted);
  const reopened={...next(terminal),runs:terminal.runs.map(run=>({...run,status:'running' as const}))};
  assert.equal((await writeAgentRuntime({key,expectedRevision:terminal.revision,value:reopened})).accepted,false);
 });
 for(const route of ['set','merge'] as const)await check('generic '+route+' advances changed content once and fences preceding ordinary writes',async()=>{
  const {key,projectId,runId,initial}=await seed(),evidence=artifact(projectId,runId,'imported');
  await setStoredEntry('agent-artifact:'+projectId+':'+evidence.artifactId,evidence);
  const {body:_body,version:_version,...index}=evidence;
  const imported={...structuredClone(initial),artifacts:[index],runs:initial.runs.map(run=>({...run,artifactIds:[evidence.artifactId]}))};
  const publish=()=>route==='set'?setStoredEntry(key,imported):mergeStoredEntries({[key]:imported});
  await publish();const merged=await getStoredEntry(key);
  assert((merged.value as AgentRuntimeSidecar).revision>initial.revision,'changed merge must be visible to a preceding reader');
  assert.deepEqual(await loadAgentArtifact(projectId,evidence.artifactId),evidence);
  await publish();assert.deepEqual(await getStoredEntry(key),merged,'replaying the same import is a no-op');
  assert.equal((await writeAgentRuntime({key,expectedRevision:initial.revision,value:next(initial)})).accepted,false);
  assert.deepEqual(await getStoredEntry(key),merged);
 });
 await check('standalone caller also refuses stale creation and stale replacement',async()=>{
  resetSharedKvMemory();
  const key='agent-runtime:standalone-cas',initial={...normalizeAgentRuntimeSidecar('standalone-cas',undefined),revision:1};
  assert((await kvWriteAgentRuntime({operation:'agent-runtime-write',key,expectedRevision:null,value:initial})).accepted);
  const changed=next(initial);assert((await kvWriteAgentRuntime({operation:'agent-runtime-write',key,expectedRevision:1,value:changed})).accepted);
  assert.equal((await kvWriteAgentRuntime({operation:'agent-runtime-write',key,expectedRevision:1,value:changed})).accepted,false);
  assert.equal((await kvWriteAgentRuntime({operation:'agent-runtime-write',key,expectedRevision:null,value:initial})).accepted,false);
  assert.deepEqual(await kvGet(key),changed);
 });
 await check('standalone caller rejects unchanged successor version',async()=>{
  const key='agent-runtime:standalone-cas',before=await kvGet<AgentRuntimeSidecar>(key);assert(before);
  await assert.rejects(kvWriteAgentRuntime({operation:'agent-runtime-write',key,expectedRevision:before.revision,value:before}),/runtime.*revision/i);
  assert.deepEqual(await kvGet(key),before);
 });
}finally{
 resetSharedKvMemory();globalThis.fetch=previousFetch;
 if(previousData===undefined)delete process.env.OPENCHATCUT_DATA_DIR;else process.env.OPENCHATCUT_DATA_DIR=previousData;
 await rm(directory,{recursive:true,force:true});
}
assert.deepEqual(failures,[]);
console.log('Runtime version fencing: real file-store and standalone paths passed; zero providers and production writes');
