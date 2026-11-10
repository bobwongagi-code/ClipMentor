import {gunzipSync,brotliCompressSync,brotliDecompressSync,constants} from 'node:zlib';
import {randomUUID,createHash} from 'node:crypto';
import {archiveAgentArtifacts,loadAgentArtifact,loadAgentRuntimeSidecar,type AgentArtifactRecord,type AgentArtifactIndexEntry} from '../../src/persist/agentRuntimeStore';
import type {ProductionTask} from './production-task';
import {digestValue} from '../agent-runs/store-values';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
/** Index order is only the fallback: generic imports can append older rows. */
export function newestProductionCheckpoints<T extends {createdAt:number}>(records:readonly T[]):T[]{
 return [...records].reverse().sort((a,b)=>b.createdAt-a.createdAt);
}
export function decodePublishedProductionCheckpoint(artifact:AgentArtifactRecord|null,index:AgentArtifactIndexEntry,projectId:string,id:string):ProductionTask{
 if(!artifact)throw new Error('production_checkpoint_unavailable');
 const {body,version:_version,...published}=artifact;
 if(digestValue(published)!==digestValue(index))throw new Error('production_checkpoint_index_mismatch');
 let value;
 try{value=JSON.parse(body);}catch{throw new Error('production_checkpoint_invalid');}
 if(value?.type!=='clipmentor-production-task/v1'||!value.task||value.task.version!==1
  ||value.task.taskId!==id||value.task.projectId!==projectId)throw new Error('production_checkpoint_invalid');
 return value.task;
}
/** A reader may hold an index from just before lossless compaction. Reuse
 * that exact body only through a currently indexed, verified archive; a body
 * still indexed live but missing/corrupt remains unknown and must refuse. */
export async function loadPublishedProductionCheckpoint(index:AgentArtifactIndexEntry){
 const live=await loadAgentArtifact(index.projectId,index.artifactId);if(live)return live;
 // Only local publication churn can reopen this search. A stable unreadable
 // index is unknown; no older checkpoint, external retry or allowance is used.
 for(let attempt=0;attempt<3;attempt++){
  const current=await loadAgentRuntimeSidecar(index.projectId);
  if(current.artifacts.some(a=>a.artifactId===index.artifactId))return null;
  const archives=current.artifacts.filter(a=>a.runId===index.runId&&a.toolName==='clipmentor-production-task-history');
  for(const archivedIndex of archives){
   const archive=await loadAgentArtifact(index.projectId,archivedIndex.artifactId);if(!archive)continue;
   const {body:_body,version:_version,...published}=archive;
   if(digestValue(published)!==digestValue(archivedIndex))throw Error('production_checkpoint_index_mismatch');
   const row=unpackProductionHistory(archive,128*1024*1024).find(r=>r.artifactId===index.artifactId);
   if(row){const {body:_rowBody,version:_rowVersion,...rowIndex}=row;
    if(digestValue(rowIndex)!==digestValue(index))throw Error('production_checkpoint_index_mismatch');return row;}
  }
  const next=await loadAgentRuntimeSidecar(index.projectId);
  if(digestValue(archives)===digestValue(next.artifacts.filter(a=>a.runId===index.runId&&a.toolName==='clipmentor-production-task-history')))return null;
 }
 return null;
}
/** Resolve equal-time checkpoints by their validated per-task sequence, never
 * the arrival order of a generic sidecar import. Different runs stay independent.
 * Only tied groups need extra body reads; corrupt evidence refuses, not fallback. */
export async function* orderedProductionCheckpointRecords(records:readonly AgentArtifactIndexEntry[]){
 const ordered=newestProductionCheckpoints(records);
 // Resolve only the time group the reader actually reaches. Compaction can
 // retire older bodies while a reader already has a valid current checkpoint.
 for(let start=0;start<ordered.length;){
  let end=start+1;while(end<ordered.length&&ordered[end].createdAt===ordered[start].createdAt)end++;
  const rows=ordered.slice(start,end),groups=new Map<string,number[]>();
  for(const [i,r]of rows.entries()){const key=JSON.stringify([r.projectId,r.runId]);const slots=groups.get(key)??[];slots.push(i);groups.set(key,slots);}
  for(const slots of groups.values())if(slots.length>1){
   const ranked:Array<{index:AgentArtifactIndexEntry;sequence:number}>=[];
   for(const i of slots){const index=rows[i];const task=decodePublishedProductionCheckpoint(await loadPublishedProductionCheckpoint(index),index,index.projectId,index.runId);
    if(!Number.isSafeInteger(task.sequence)||task.sequence<0)throw Error('production_checkpoint_invalid');
    ranked.push({index,sequence:task.sequence});}
   ranked.sort((a,b)=>b.sequence-a.sequence);for(const [i,slot]of slots.entries())rows[slot]=ranked[i].index;
  }
  for(const row of rows)yield row;
  start=end;
 }
}
export function unpackProductionHistory(record:AgentArtifactRecord,maxOutputLength=256*1024*1024):AgentArtifactRecord[]{
 const envelope=JSON.parse(record.body);
 if(!['clipmentor-production-history/gzip-v1','clipmentor-production-history/brotli-v1'].includes(envelope.type))throw Error('Invalid history archive');
 const decode=envelope.type.endsWith('/brotli-v1')?brotliDecompressSync:gunzipSync;
 const raw=decode(Buffer.from(envelope.data,'base64'),{maxOutputLength}).toString('utf8');
 if(sha(raw)!==envelope.sha256)throw Error('History archive hash mismatch');
 const records:AgentArtifactRecord[]=JSON.parse(raw);
 if(!Array.isArray(records)||records.length!==envelope.count||records.some(r=>r.projectId!==record.projectId||r.runId!==record.runId
  ||!['clipmentor-production-task','clipmentor-gateway-recovery'].includes(r.toolName??'')||r.kind!=='checkpoint-source'||sha(r.body)!==r.bodySha256||Buffer.byteLength(r.body)!==r.originalBytes))throw Error('Invalid archived checkpoint');
 return records;
}
export async function compactProductionTaskHistory(projectId:string,runId:string,maxExpandedBytes=128*1024*1024){
 if(!Number.isSafeInteger(maxExpandedBytes)||maxExpandedBytes<1||maxExpandedBytes>128*1024*1024)throw Error('Invalid history compaction bound');
 const sidecar=await loadAgentRuntimeSidecar(projectId);
 if(sidecar.artifacts.length<192&&sidecar.artifacts.reduce((n,a)=>n+a.originalBytes,0)<48*1024*1024)return false;
 const current:AgentArtifactIndexEntry[]=[];
 for await(const row of orderedProductionCheckpointRecords(sidecar.artifacts.filter(a=>a.runId===runId&&a.toolName==='clipmentor-production-task'))){current.push(row);if(current.length>=18)break;}
 const archives=sidecar.artifacts.filter(a=>a.runId===runId&&a.toolName==='clipmentor-production-task-history').sort((a,b)=>a.originalBytes-b.originalBytes);
 const originals:AgentArtifactRecord[]=[],records:AgentArtifactRecord[]=[];let expandedBytes=2;
 const add=async(index:typeof sidecar.artifacts[number])=>{
  if(maxExpandedBytes-expandedBytes<=0)return false;
  const record=await loadAgentArtifact(projectId,index.artifactId);if(!record)throw Error('History source unavailable');
  let rows:AgentArtifactRecord[];
  try{rows=record.toolName==='clipmentor-production-task-history'?unpackProductionHistory(record,maxExpandedBytes-expandedBytes):[record];}
  catch(error){if((error as NodeJS.ErrnoException).code==='ERR_BUFFER_TOO_LARGE')return false;throw error;}
  const bytes=rows.reduce((n,r)=>n+Buffer.byteLength(JSON.stringify(r))+1,0);
  if(expandedBytes+bytes>maxExpandedBytes)return false;
  originals.push(record);records.push(...rows);expandedBytes+=bytes;return true;
 };
 // Preserve the two newest recovery checkpoints. An older single checkpoint
 // can join a bounded archive; waiting for a fourth checkpoint deadlocks at 256.
 for(const index of sidecar.artifacts.filter(a=>a.runId===runId&&a.toolName==='clipmentor-gateway-recovery').slice(0,16))await add(index);
 for(const index of current.slice(2,18))await add(index);
 if(originals.length<2)for(const index of archives){await add(index);if(originals.length>=2)break;}
 if(!originals.length||originals.length===1&&!(originals[0].toolName==='clipmentor-production-task-history'
  &&JSON.parse(originals[0].body).type==='clipmentor-production-history/gzip-v1'))return false;
 if(new Set(records.map(r=>r.artifactId)).size!==records.length)throw Error('Duplicate history checkpoint');
 // Leave headroom for serialization and round-trip validation; do not raise
 // the read limit or discard old records to make a new checkpoint fit.
 if(expandedBytes>maxExpandedBytes)return false;
 const raw=JSON.stringify(records),body=JSON.stringify({type:'clipmentor-production-history/brotli-v1',sha256:sha(raw),count:records.length,data:brotliCompressSync(raw,{params:{[constants.BROTLI_PARAM_QUALITY]:4,[constants.BROTLI_PARAM_LGWIN]:24}}).toString('base64')});
 const archive:AgentArtifactRecord={version:1,artifactId:'h_'+randomUUID().replaceAll('-','').slice(0,18),projectId,runId,kind:'checkpoint-source',toolName:'clipmentor-production-task-history',
 body,bodySha256:sha(body),originalBytes:Buffer.byteLength(body),originalChars:body.length,createdAt:Date.now(),redacted:false,binaryOmitted:false};
 if(originals.length===1&&archive.originalBytes>=originals[0].originalBytes)return false;
 if(JSON.stringify(unpackProductionHistory(archive))!==raw)throw Error('History roundtrip failed');
 const accepted=await archiveAgentArtifacts(archive,originals);
 if(!accepted)throw Error(`History archive rejected: records=${originals.length}, bytes=${archive.originalBytes}`);
 return true;
}

// Cache only the decision projection of immutable, hash-checked archives. Task
// bodies are never kept here. Current index membership is checked on every read;
// a matched archive is read/hash-checked again before its decision is reused.
const gatewayHistoryCache=new Map<string,{decisions:Map<string,AgentArtifactRecord>;bytes:number}>();
export async function findArchivedProductionGatewayDecision(record:AgentArtifactRecord){
 const sidecar=await loadAgentRuntimeSidecar(record.projectId);
 for(const index of sidecar.artifacts.filter(a=>a.runId===record.runId&&a.toolName==='clipmentor-production-task-history')){
  const key=JSON.stringify([record.projectId,index.runId,index.artifactId,index.bodySha256]);
  let cached=gatewayHistoryCache.get(key),archive:AgentArtifactRecord|null= null;
  if(!cached||cached.decisions.has(record.artifactId)){
   archive=await loadAgentArtifact(record.projectId,index.artifactId);
   if(!archive)throw Error('gateway_recovery_history_unavailable');
   const {body:_body,version:_version,...published}=archive;
   if(digestValue(published)!==digestValue(index))throw Error('gateway_recovery_history_mismatch');
  }
  if(!cached){
   const rows=unpackProductionHistory(archive!,128*1024*1024).filter(r=>r.toolName==='clipmentor-gateway-recovery');
   cached={decisions:new Map(rows.map(r=>[r.artifactId,r])),bytes:rows.reduce((n,r)=>n+Buffer.byteLength(r.body)+512,0)};
   if(cached.decisions.size!==rows.length)throw Error('Duplicate gateway recovery history');
   if(cached.bytes<=2*1024*1024){
    gatewayHistoryCache.set(key,cached);
    while(gatewayHistoryCache.size>128||[...gatewayHistoryCache.values()].reduce((n,v)=>n+v.bytes,0)>2*1024*1024)
     gatewayHistoryCache.delete(gatewayHistoryCache.keys().next().value!);
   }
  }
  const found=cached.decisions.get(record.artifactId);if(found)return found;
 }
 return null;
}
