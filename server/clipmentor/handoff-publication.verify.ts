import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ProjectDoc} from '../../src/editor/types';
const root=await mkdtemp(join(tmpdir(),'clipmentor-handoff-publication-'));
process.env.OPENCHATCUT_DATA_DIR=root;
const {withSerializedProjectStore,getStoredEntry}=await import('../plugins/project-store');
const {activateOfflineAgentRuntimeBackend}=await import('../external-agent/agent-runtime-persistence');activateOfflineAgentRuntimeBackend();
const {loadOfflineStoredProject}=await import('../external-agent/offline-project-store');
const {createRun,flushRunPersistence,resetServerRunStoreForTest}=await import('../agent-runs/store');
const {registerHandoff,prepareHandoff,saveHandoffRun,readHandoffPolicy,handoffRunKey,handoffKey,assertRunHandoff}=await import('./handoff');
const {loadAgentRuntimeSidecar}=await import('../../src/persist/agentRuntimeStore');
const projectId='handoff-publication';
const doc:ProjectDoc={version:3,assets:[{id:'source',name:'fixture',kind:'video',src:'/media/test.mp4',durationInFrames:30,sourceContentHash:'a'.repeat(64)}],mediaFolders:[],activeTimelineId:'tl',
 timelines:[{id:'tl',name:'fixture',order:0,fps:30,width:576,height:1024,items:[],selectedId:null,tracks:{V1:{kind:'video'}},trackOrder:['V1']}]};
const originalFetch=globalThis.fetch;
globalThis.fetch=(async()=>{throw Error('No network permitted');}) as typeof fetch;
try{
 await withSerializedProjectStore(s=>s.writeEntry(`project:${projectId}`,doc));
 const snapshot=(await loadOfflineStoredProject(projectId))!;
 const brief={version:1,briefId:'publication',revision:1,mode:'autonomous',phase:'planning',planner:'builtin_agent',executor:'builtin_agent',projectId,timelineId:'tl',objective:'fixture',doneCriteria:['Read source'],blueprint:null,budget:{maxModelTurns:1,maxToolCalls:1,maxElapsedMs:60000,paidToolCalls:{}}};
 await registerHandoff({projectId,expectedProjectRevision:snapshot.revision,previousDigest:null,brief});
 const prepared=(await prepareHandoff(projectId,[{role:'user',content:'Exact original task'}]))!;
 const run=createRun({id:'81818181-8181-4181-8181-818181818181',projectId,backend:'codex',model:'fixture',askOnly:false,userInputDigest:'a'.repeat(64)});
 await flushRunPersistence(run);
 let writes=0;
 const failedSecondWrite:typeof withSerializedProjectStore=work=>withSerializedProjectStore(store=>work({...store,writeEntry:async(key,value)=>{
  if(++writes===2)throw Error('second publication write failed');
  await store.writeEntry(key,value);
 }}));
 await assert.rejects(saveHandoffRun(run,prepared,failedSecondWrite),/second publication write failed/);
 const interrupted=(await readHandoffPolicy(projectId))!;
 assert(interrupted.runIds.includes(run.id),'an interrupted binding cannot hide an active run from policy replacement');
 await assert.rejects(registerHandoff({projectId,expectedProjectRevision:snapshot.revision,previousDigest:interrupted.digest,brief:{...brief,briefId:'replacement'}}),/active_or_unknown_run/);
 await assert.rejects(assertRunHandoff(run),/binding_required/,'partial state cannot dispatch');
 const changed={...prepared,taskDetails:'Changed task',messages:[{role:'user' as const,content:'Changed request'}]};
 await assert.rejects(saveHandoffRun(run,changed),/already_bound/,'interrupted admission cannot rebind another payload');
 await saveHandoffRun(run,prepared);
 await assertRunHandoff(run);
 const after=(await readHandoffPolicy(projectId))!;
 assert.equal(after.startedAt,interrupted.startedAt,'recovery cannot restart the deadline');
 assert.deepEqual(after.runIds,[run.id]);
 assert.equal(after.modelTurns,0);assert.equal(after.toolCalls,0);
 const payloadCount=()=>loadAgentRuntimeSidecar(projectId).then(s=>s.artifacts.filter(a=>a.runId===run.id&&a.toolName==='clipmentor-handoff').length);
 assert.equal(await payloadCount(),1);
 const originalPayload=(await loadAgentRuntimeSidecar(projectId)).artifacts.find(a=>a.runId===run.id&&a.toolName==='clipmentor-handoff')!;
 await saveHandoffRun(run,prepared);
 assert.equal(await payloadCount(),1,'same-payload repetition reuses its original immutable artifact');

 // Recover legacy ordering too: binding exists, but the policy write was lost.
 const legacy={...(await readHandoffPolicy(projectId))!,runIds:[],startedAt:null};
 await withSerializedProjectStore(s=>s.writeEntry(handoffKey(projectId),legacy));
 assert((await getStoredEntry(handoffRunKey(projectId,run.id))).found);
 await assert.rejects(assertRunHandoff(run),/binding_required/);
 await saveHandoffRun(run,prepared);
 assert.deepEqual((await readHandoffPolicy(projectId))!.runIds,[run.id]);
 assert.equal((await readHandoffPolicy(projectId))!.startedAt,originalPayload.createdAt,'legacy recovery uses original publication time rather than granting a fresh deadline');
 await assertRunHandoff(run);
 assert.equal(await payloadCount(),1);
 console.log('PASS partial handoff publication, exact-payload recovery, legacy orphan binding, deadline/quota preservation and changed-payload refusal; zero providers');
}finally{
 resetServerRunStoreForTest();globalThis.fetch=originalFetch;await rm(root,{recursive:true,force:true});
}
