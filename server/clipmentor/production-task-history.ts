import {gunzipSync,brotliCompressSync,brotliDecompressSync,constants} from 'node:zlib';
import {randomUUID,createHash} from 'node:crypto';
import {archiveAgentArtifacts,loadAgentArtifact,loadAgentRuntimeSidecar,type AgentArtifactRecord} from '../../src/persist/agentRuntimeStore';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
export function unpackProductionHistory(record:AgentArtifactRecord):AgentArtifactRecord[]{
 const envelope=JSON.parse(record.body);
 if(!['clipmentor-production-history/gzip-v1','clipmentor-production-history/brotli-v1'].includes(envelope.type))throw Error('Invalid history archive');
 const decode=envelope.type.endsWith('/brotli-v1')?brotliDecompressSync:gunzipSync;
 const raw=decode(Buffer.from(envelope.data,'base64'),{maxOutputLength:256*1024*1024}).toString('utf8');
 if(sha(raw)!==envelope.sha256)throw Error('History archive hash mismatch');
 const records:AgentArtifactRecord[]=JSON.parse(raw);
 if(!Array.isArray(records)||records.length!==envelope.count||records.some(r=>r.projectId!==record.projectId||r.runId!==record.runId
  ||r.toolName!=='clipmentor-production-task'||sha(r.body)!==r.bodySha256||Buffer.byteLength(r.body)!==r.originalBytes))throw Error('Invalid archived checkpoint');
 return records;
}
export async function compactProductionTaskHistory(projectId:string,runId:string){
 const sidecar=await loadAgentRuntimeSidecar(projectId);
 if(sidecar.artifacts.length<192&&sidecar.artifacts.reduce((n,a)=>n+a.originalBytes,0)<48*1024*1024)return false;
 const current=sidecar.artifacts.filter(a=>a.runId===runId&&a.toolName==='clipmentor-production-task').sort((a,b)=>b.createdAt-a.createdAt);
 // Small batches respect the existing 8 MiB per-artifact limit; prior archives stay immutable.
 const archives=sidecar.artifacts.filter(a=>a.runId===runId&&a.toolName==='clipmentor-production-task-history').sort((a,b)=>a.originalBytes-b.originalBytes);
 // Long runs can fill the quota with compressed batches alone. Repack two
 // small batches losslessly instead of dropping history or raising the quota.
 const candidates=current.length>=4?current.slice(2,18):archives.slice(0,2);
 if(candidates.length<2)return false;
 const originals:AgentArtifactRecord[]=[];const records:AgentArtifactRecord[]=[];
 for(const index of candidates){const record=await loadAgentArtifact(projectId,index.artifactId);if(!record)throw Error('History source unavailable');originals.push(record);
  records.push(...(record.toolName==='clipmentor-production-task-history'?unpackProductionHistory(record):[record]));}
 if(new Set(records.map(r=>r.artifactId)).size!==records.length)throw Error('Duplicate history checkpoint');
 const raw=JSON.stringify(records),body=JSON.stringify({type:'clipmentor-production-history/brotli-v1',sha256:sha(raw),count:records.length,data:brotliCompressSync(raw,{params:{[constants.BROTLI_PARAM_QUALITY]:4,[constants.BROTLI_PARAM_LGWIN]:24}}).toString('base64')});
 const archive:AgentArtifactRecord={version:1,artifactId:'h_'+randomUUID().replaceAll('-','').slice(0,18),projectId,runId,kind:'checkpoint-source',toolName:'clipmentor-production-task-history',
 body,bodySha256:sha(body),originalBytes:Buffer.byteLength(body),originalChars:body.length,createdAt:Date.now(),redacted:false,binaryOmitted:false};
 if(JSON.stringify(unpackProductionHistory(archive))!==raw)throw Error('History roundtrip failed');
 const accepted=await archiveAgentArtifacts(archive,originals);
 if(!accepted)throw Error(`History archive rejected: records=${originals.length}, bytes=${archive.originalBytes}`);
 return true;
}
