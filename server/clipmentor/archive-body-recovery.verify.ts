import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';

// Controlled in-memory store only: no providers, servers, media engines or persistent product writes.
const root=fileURLToPath(new URL('../..',import.meta.url));
const baseline=process.env.CM_ARCHIVE_BASELINE;
const bundle=await build({stdin:{contents:"export * from './src/persist/agentRuntimeStore';export * from './src/persist/sharedKv';",resolveDir:root},bundle:true,platform:'node',format:'esm',write:false,plugins:baseline?[{name:'baseline',setup(b){b.onLoad({filter:/\.(ts|tsx)$/},args=>({contents:execFileSync('git',['show',baseline+':'+args.path.slice(root.length)],{cwd:root,encoding:'utf8'}),loader:'ts'}));}}]:[]});
const api=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const entries=new Map<string,any>();let ack=false;
api.configureSharedKvBackend({get:async(k:string)=>structuredClone(entries.get(k)),set:async(k:string,v:any)=>{entries.set(k,structuredClone(v));if(ack){ack=false;throw Error('body-ack-lost');}},delete:async(k:string)=>{entries.delete(k);},keys:async()=>[...entries.keys()],writeAgentRuntime:async(r:any)=>{const old=entries.get(r.key);assert.equal(r.expectedRevision,old?.revision??null);entries.set(r.key,structuredClone(r.value));return {accepted:true,found:true,value:r.value};},updateAgentRunLease:async()=>{throw Error('unused');}});
const record=(projectId:string,artifactId:string,toolName:string)=>{const body='exact immutable archive fixture';return {version:1,projectId,runId:'run',artifactId,kind:'checkpoint-source',toolName,body,bodySha256:createHash('sha256').update(body).digest('hex'),originalBytes:Buffer.byteLength(body),originalChars:body.length,createdAt:1,redacted:false,binaryOmitted:false};};
async function seed(projectId:string){await api.createAgentRun({version:1,projectId,runId:'run',status:'running',askOnly:false,userInputPreview:'fixture',userInputDigest:'a'.repeat(64),createdAt:1,updatedAt:1,artifactIds:[],checkpointIds:[],proposalIds:[],events:[]});const old=record(projectId,'old','clipmentor-production-task');assert(await api.storeAgentArtifact(old));return old;}
const old=await seed('ackloss'),archive=record('ackloss','archive','clipmentor-production-task-history');ack=true;
let initial:boolean|undefined,error:string|undefined;try{initial=await api.archiveAgentArtifacts(archive,[old]);}catch(e){error=(e as Error).message;}
console.log(JSON.stringify({case:'archive body acknowledgement lost',initial,error,bodyRetained:entries.has(api.agentArtifactKey('ackloss','archive')),indexed:!!await api.loadAgentArtifact('ackloss','archive')}));
assert.equal(initial,true,'exact authoritative readback must finish initial archive publication');assert.deepEqual(await api.loadAgentArtifact('ackloss','archive'),archive);assert.equal(await api.loadAgentArtifact('ackloss','old'),null);assert.equal(await api.archiveAgentArtifacts(archive,[old]),false,'indexed duplicate remains false');
const orphanOld=await seed('orphan'),orphan=record('orphan','archive','clipmentor-production-task-history');entries.set(api.agentArtifactKey('orphan','archive'),structuredClone(orphan));assert.equal(await api.archiveAgentArtifacts(orphan,[orphanOld]),true,'same-ID exact unindexed orphan must publish');assert.deepEqual(await api.loadAgentArtifact('orphan','archive'),orphan);
const conflictOld=await seed('conflict'),conflict=record('conflict','archive','clipmentor-production-task-history'),changed={...conflict,createdAt:2};entries.set(api.agentArtifactKey('conflict','archive'),changed);assert.equal(await api.archiveAgentArtifacts(conflict,[conflictOld]),false);assert.deepEqual(entries.get(api.agentArtifactKey('conflict','archive')),changed);assert.deepEqual(await api.loadAgentArtifact('conflict','old'),conflictOld);
const newOld=await seed('newid'),stranded=record('newid','stranded','clipmentor-production-task-history');entries.set(api.agentArtifactKey('newid','stranded'),stranded);assert.equal(await api.archiveAgentArtifacts({...stranded,artifactId:'new_archive'},[newOld]),true,'fresh-ID retry remains supported');assert.deepEqual(entries.get(api.agentArtifactKey('newid','stranded')),stranded);
console.log(JSON.stringify({status:'PASS',bodyAckLostRecovered:true,sameIdOrphanRecovered:true,indexedDuplicate:false,metadataConflictRejected:true,newIdControl:true,externalCalls:0}));
