import {gunzipSync,brotliCompressSync,brotliDecompressSync,constants} from 'node:zlib';
import {randomUUID,createHash} from 'node:crypto';
import {archiveAgentArtifacts,loadAgentArtifact,loadAgentRuntimeSidecar,type AgentArtifactRecord} from '../../src/persist/agentRuntimeStore';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
/** The durable index appends publications. Preserve that order when timestamps
 * tie, both for current reads and for the checkpoints compaction keeps live. */
export function newestProductionCheckpoints<T extends {createdAt:number}>(records:readonly T[]):T[]{
 return [...records].reverse().sort((a,b)=>b.createdAt-a.createdAt);
}
export function unpackProductionHistory(record:AgentArtifactRecord,maxOutputLength=256*1024*1024):AgentArtifactRecord[]{
 const envelope=JSON.parse(record.body);
 if(!['clipmentor-production-history/gzip-v1','clipmentor-production-history/brotli-v1'].includes(envelope.type))throw Error('Invalid history archive');
 const decode=envelope.type.endsWith('/brotli-v1')?brotliDecompressSync:gunzipSync;
 const raw=decode(Buffer.from(envelope.data,'base64'),{maxOutputLength}).toString('utf8');
 if(sha(raw)!==envelope.sha256)throw Error('History archive hash mismatch');
 const records:AgentArtifactRecord[]=JSON.parse(raw);
 if(!Array.isArray(records)||records.length!==envelope.count||records.some(r=>r.projectId!==record.projectId||r.runId!==record.runId
  ||r.toolName!=='clipmentor-production-task'||sha(r.body)!==r.bodySha256||Buffer.byteLength(r.body)!==r.originalBytes))throw Error('Invalid archived checkpoint');
 return records;
}
export async function compactProductionTaskHistory(projectId:string,runId:string,maxExpandedBytes=128*1024*1024){
 if(!Number.isSafeInteger(maxExpandedBytes)||maxExpandedBytes<1||maxExpandedBytes>128*1024*1024)throw Error('Invalid history compaction bound');
 const sidecar=await loadAgentRuntimeSidecar(projectId);
 if(sidecar.artifacts.length<192&&sidecar.artifacts.reduce((n,a)=>n+a.originalBytes,0)<48*1024*1024)return false;
 const current=newestProductionCheckpoints(sidecar.artifacts.filter(a=>a.runId===runId&&a.toolName==='clipmentor-production-task'));
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
