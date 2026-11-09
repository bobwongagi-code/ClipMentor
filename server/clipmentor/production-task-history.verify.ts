import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync,brotliCompressSync} from 'node:zlib';
import {configureSharedKvBackend} from '../../src/persist/sharedKv';
import {createAgentRun,storeAgentArtifact,loadAgentArtifact,loadAgentRuntimeSidecar,archiveAgentArtifacts,type AgentArtifactRecord} from '../../src/persist/agentRuntimeStore';
import {compactProductionTaskHistory,unpackProductionHistory} from './production-task-history';
const memory=new Map<string,unknown>();configureSharedKvBackend({writeAgentRuntime:async r=>{memory.set(r.key,structuredClone(r.value));return {accepted:true,found:true,value:r.value};},updateAgentRunLease:async()=>{throw Error('unused');},get:async<T>(k:string)=>structuredClone(memory.get(k)) as T,set:async(k,v)=>{memory.set(k,structuredClone(v));},delete:async k=>{memory.delete(k);},keys:async()=>[...memory.keys()]});
const projectId='history-test',runId='history-run';
await createAgentRun({version:1,projectId,runId,status:'running',askOnly:false,userInputPreview:'test',userInputDigest:'a'.repeat(64),createdAt:1,updatedAt:1,artifactIds:[],checkpointIds:[],proposalIds:[],events:[]});
const original:AgentArtifactRecord[]=[];
for(let i=0;i<194;i++){
 const body=JSON.stringify({type:'clipmentor-production-task/v1',task:{sequence:i,attempts:{review:9},error:'original failure',payload:'repeated'.repeat(40)}});
 const r:AgentArtifactRecord={version:1,projectId,runId,artifactId:'p_'+i,kind:'checkpoint-source',toolName:'clipmentor-production-task',body,bodySha256:createHash('sha256').update(body).digest('hex'),originalBytes:Buffer.byteLength(body),originalChars:body.length,createdAt:i+1,redacted:false,binaryOmitted:false};
 assert(await storeAgentArtifact(r));original.push(r);
}
assert(await compactProductionTaskHistory(projectId,runId));
const sidecar=await loadAgentRuntimeSidecar(projectId);assert.equal(sidecar.artifacts.length,179);
for(const r of original.slice(-2))assert.deepEqual(await loadAgentArtifact(projectId,r.artifactId),r);
const archive=await loadAgentArtifact(projectId,sidecar.artifacts.find(a=>a.toolName==='clipmentor-production-task-history')!.artifactId);assert(archive);
assert.deepEqual(unpackProductionHistory(archive).sort((a,b)=>a.createdAt-b.createdAt),original.slice(-18,-2));
const legacyRaw=JSON.stringify(unpackProductionHistory(archive));
const legacy={...archive,body:JSON.stringify({type:'clipmentor-production-history/gzip-v1',sha256:createHash('sha256').update(legacyRaw).digest('hex'),count:16,data:gzipSync(legacyRaw).toString('base64')})};
assert.deepEqual(unpackProductionHistory(legacy),unpackProductionHistory(archive),'existing gzip archives remain readable');
assert.equal(await compactProductionTaskHistory(projectId,runId),false);
const changed={...original[193],bodySha256:'wrong'};
assert.equal(await archiveAgentArtifacts({...archive,artifactId:'h_bad'},[changed]),false);
assert.deepEqual(await loadAgentArtifact(projectId,original[193].artifactId),original[193]);
assert.throws(()=>unpackProductionHistory({...archive,body:archive.body.replace('brotli-v1','bad')}));
assert.equal(await archiveAgentArtifacts({...archive,artifactId:'h_foreign',runId:'foreign'},[original[193]]),false);
console.log('PASS lossless history archive, exact failures/counters, latest recovery points, stale/cross-run rejection and idempotence; zero providers');

// Closed Brotli batches must not be recursively unpacked and merged on every save.
// In the real run each old batch was readable but their combined raw JSON exceeded
// the decoder bound, preventing every new checkpoint (including the failure state).
const sealedProject='sealed-history-test';
await createAgentRun({version:1,projectId:sealedProject,runId,status:'running',askOnly:false,userInputPreview:'test',userInputDigest:'a'.repeat(64),createdAt:1,updatedAt:1,artifactIds:[],checkpointIds:[],proposalIds:[],events:[]});
const closed:AgentArtifactRecord[]=[];
for(let i=0;i<2;i++){
 const checkpoint={...original[i],projectId:sealedProject};
 const raw=JSON.stringify([checkpoint]);
 const body=JSON.stringify({type:'clipmentor-production-history/brotli-v1',sha256:createHash('sha256').update(raw).digest('hex'),count:1,data:brotliCompressSync(raw).toString('base64')});
 const record={...checkpoint,artifactId:'h_sealed_'+i,toolName:'clipmentor-production-task-history',body,bodySha256:createHash('sha256').update(body).digest('hex'),originalBytes:Buffer.byteLength(body),originalChars:body.length};
 assert(await storeAgentArtifact(record));closed.push(record);
}
for(let i=0;i<190;i++)assert(await storeAgentArtifact({...original[0],projectId:sealedProject,artifactId:'e_'+i,toolName:'other-evidence'}));
assert(await compactProductionTaskHistory(sealedProject,runId),'small sealed archives must free index slots without loss');
const packedIndex=(await loadAgentRuntimeSidecar(sealedProject)).artifacts.find(a=>a.toolName==='clipmentor-production-task-history')!;
assert.deepEqual(unpackProductionHistory((await loadAgentArtifact(sealedProject,packedIndex.artifactId))!),closed.flatMap(r=>unpackProductionHistory(r)));
assert(await storeAgentArtifact({...original[0],projectId:sealedProject,artifactId:'p_after_sealed'}),'closed archives cannot prevent a new recovery checkpoint');
const gzipProject='legacy-gzip-history-test';
await createAgentRun({version:1,projectId:gzipProject,runId,status:'running',askOnly:false,userInputPreview:'test',userInputDigest:'a'.repeat(64),createdAt:1,updatedAt:1,artifactIds:[],checkpointIds:[],proposalIds:[],events:[]});
const legacyRecords=original.slice(0,16).map(r=>({...r,projectId:gzipProject}));
const gzipRaw=JSON.stringify(legacyRecords),gzipBody=JSON.stringify({type:'clipmentor-production-history/gzip-v1',sha256:createHash('sha256').update(gzipRaw).digest('hex'),count:legacyRecords.length,data:gzipSync(gzipRaw).toString('base64')});
const gzipRecord={...legacyRecords[0],artifactId:'h_legacy',toolName:'clipmentor-production-task-history',body:gzipBody,bodySha256:createHash('sha256').update(gzipBody).digest('hex'),originalBytes:Buffer.byteLength(gzipBody),originalChars:gzipBody.length};
assert(await storeAgentArtifact(gzipRecord));
for(let i=0;i<191;i++)assert(await storeAgentArtifact({...original[0],projectId:gzipProject,artifactId:'e_'+i,toolName:'other-evidence'}));
assert(await compactProductionTaskHistory(gzipProject,runId),'legacy gzip can be recompressed as one bounded batch');
const recompressed=(await loadAgentRuntimeSidecar(gzipProject)).artifacts.find(a=>a.toolName==='clipmentor-production-task-history')!;
assert.deepEqual(unpackProductionHistory((await loadAgentArtifact(gzipProject,recompressed.artifactId))!),legacyRecords);
assert.equal(await compactProductionTaskHistory(gzipProject,runId),false,'recompression terminates without repeatedly merging closed batches');
console.log('PASS sealed history permits future checkpoints; legacy gzip recompression remains exact and bounded');

const largeProject='large-bounded-history';
await createAgentRun({version:1,projectId:largeProject,runId,status:'running',askOnly:false,userInputPreview:'test',userInputDigest:'a'.repeat(64),createdAt:1,updatedAt:1,artifactIds:[],checkpointIds:[],proposalIds:[],events:[]});
const largeArchives:AgentArtifactRecord[]=[];
for(let a=0;a<2;a++){
 const rows=Array.from({length:3},(_,i)=>{const body='x'.repeat(3*1024*1024);return {...original[0],projectId:largeProject,artifactId:'big_'+a+'_'+i,body,bodySha256:createHash('sha256').update(body).digest('hex'),originalBytes:Buffer.byteLength(body),originalChars:body.length};});
 const raw=JSON.stringify(rows),body=JSON.stringify({type:'clipmentor-production-history/brotli-v1',sha256:createHash('sha256').update(raw).digest('hex'),count:rows.length,data:brotliCompressSync(raw,{params:{1:0}}).toString('base64')});
 const record={...original[0],projectId:largeProject,artifactId:'h_large_'+a,toolName:'clipmentor-production-task-history',body,bodySha256:createHash('sha256').update(body).digest('hex'),originalBytes:Buffer.byteLength(body),originalChars:body.length};assert(await storeAgentArtifact(record));largeArchives.push(record);
}
for(let i=0;i<190;i++)assert(await storeAgentArtifact({...original[0],projectId:largeProject,artifactId:'e_'+i,toolName:'other-evidence'}));
assert.equal(await compactProductionTaskHistory(largeProject,runId,8*1024*1024),false,'compressed-small but expanded-large archives are not merged');
for(const record of largeArchives)assert.deepEqual(await loadAgentArtifact(largeProject,record.artifactId),record);
console.log('PASS bounded archive merging frees slots; expanded-large archives remain unchanged');

// Exactly three live checkpoints at a full index must still permit the next save.
const full='full-index-three-checkpoints';await createAgentRun({version:1,projectId:full,runId,status:'running',askOnly:false,userInputPreview:'test',userInputDigest:'a'.repeat(64),createdAt:1,updatedAt:1,artifactIds:[],checkpointIds:[],proposalIds:[],events:[]});
const oldRows=original.slice(0,2).map(r=>({...r,projectId:full})),rawFull=JSON.stringify(oldRows),bodyFull=JSON.stringify({type:'clipmentor-production-history/brotli-v1',sha256:createHash('sha256').update(rawFull).digest('hex'),count:oldRows.length,data:brotliCompressSync(rawFull).toString('base64')});
assert(await storeAgentArtifact({...oldRows[0],artifactId:'h_existing',toolName:'clipmentor-production-task-history',body:bodyFull,bodySha256:createHash('sha256').update(bodyFull).digest('hex'),originalBytes:Buffer.byteLength(bodyFull),originalChars:bodyFull.length}));
for(let i=0;i<3;i++)assert(await storeAgentArtifact({...original[i],projectId:full,artifactId:'live_'+i,createdAt:100+i}));
for(let i=0;i<252;i++)assert(await storeAgentArtifact({...original[0],projectId:full,artifactId:'other_'+i,toolName:'other-evidence'}));
assert.equal((await loadAgentRuntimeSidecar(full)).artifacts.length,256);assert(await compactProductionTaskHistory(full,runId));
assert.equal((await loadAgentRuntimeSidecar(full)).artifacts.length,255);for(let i=1;i<3;i++)assert(await loadAgentArtifact(full,'live_'+i));
assert(await storeAgentArtifact({...original[0],projectId:full,artifactId:'next_saved'}));
console.log('PASS full 256-entry index with three live checkpoints admits next save without losing the latest two');

assert.equal(await compactProductionTaskHistory(full,runId,1),false,'tiny bounded budgets must refuse safely, not throw in decompression');
