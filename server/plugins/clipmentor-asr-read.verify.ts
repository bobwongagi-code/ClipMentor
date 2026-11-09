import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {once} from 'node:events';
import {transcribeClipMentorSource,readClipMentorSourceAsr,clipMentorFunAsrPlugin} from './clipmentor-funasr';
import {execClipMentorAnalysisTool} from '../../src/agent/tools/clipmentor-analysis-tools';
import {isSourceAsrRead} from '../../shared/clipmentor-asr';
import type {AgentContext} from '../../src/agent/context';
import type {ProjectDoc} from '../../src/editor/types';

const directory=await mkdtemp(join(tmpdir(),'clipmentor-asr-read-'));
const hash='a'.repeat(64),projectId='asr-read-project',endpoint='https://test-workspace.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
let providers=0,hashes=0,currentHash=hash;
const fail=()=>{throw Error('read reached a submission dependency');};
const submitDeps={directory,key:()=> 'test-key',endpoint:()=>endpoint,resolve:()=> '/test/master.mp4',hash:async()=>hash,
 probe:async()=>({duration:3,fps:30,bytes:123}),encode:async()=>new Uint8Array([1,2,3]),fetch:(async()=>{providers++;return Response.json({output:{sentence:{words:[{text:'hello',begin_time:10,end_time:500}]}}});}) as typeof fetch};
const request={src:'/media/uploads/master.mp4',expectedSourceHash:hash,language:'auto',operationId:randomUUID(),maxRequests:1,projectId};
const readRequest=(id=request.operationId)=>({action:'read',src:request.src,expectedSourceHash:hash,projectId,operationId:id});
const readDeps={directory,key:fail,endpoint:fail,probe:fail,encode:fail,fetch:fail as unknown as typeof fetch,
 resolve:()=> '/test/master.mp4',hash:async()=>{hashes++;return currentHash;}};
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
try{
 await transcribeClipMentorSource(request,submitDeps);assert.equal(providers,1);
 const original=await readFile(join(directory,request.operationId+'.json'),'utf8');
 const cancelled=new AbortController();cancelled.abort();await assert.rejects(readClipMentorSourceAsr(readRequest(),readDeps,cancelled.signal),{name:'AbortError'});
 const hashCancelled=new AbortController();await assert.rejects(readClipMentorSourceAsr(readRequest(),{...readDeps,hash:async()=>{hashCancelled.abort();return hash;}},hashCancelled.signal),{name:'AbortError'});
 const normal=await readClipMentorSourceAsr(readRequest(),readDeps);assert(isSourceAsrRead(normal));assert.equal(normal.state,'completed');assert.equal(normal.requestsSent,0);assert.equal(normal.requestsAttempted,1);assert.equal(normal.result?.words[0].text,'hello');assert.equal(providers,1);
 assert.equal(await readFile(join(directory,request.operationId+'.json'),'utf8'),original);
 const extraRequest={...request,operationId:randomUUID(),unexpected_secret:'never-persist-me'};
 await transcribeClipMentorSource(extraRequest,{...submitDeps,encode:async()=>{throw Error('local extraction fixture');}});
 assert(!(await readFile(join(directory,extraRequest.operationId+'.json'),'utf8')).includes('never-persist-me'));
 assert.equal((await readClipMentorSourceAsr(readRequest(extraRequest.operationId),readDeps)).state,'invalid');
 const missing=randomUUID(),beforeMissing=await readdir(directory);assert.equal((await readClipMentorSourceAsr(readRequest(missing),readDeps)).state,'missing');assert.deepEqual(await readdir(directory),beforeMissing);
 const missingDirectory=join(directory,'not-created');assert.equal((await readClipMentorSourceAsr(readRequest(missing),{...readDeps,directory:missingDirectory})).state,'missing');await assert.rejects(readdir(missingDirectory),{code:'ENOENT'});
 for(const change of [{operationId:'../private'},{src:'/media/uploads/../master.mp4'},{src:'/media/uploads/master.mp4?token=x'},{expectedSourceHash:'bad'},{maxRequests:1}])await assert.rejects(readClipMentorSourceAsr({...readRequest(),...change},readDeps));
 assert.equal((await readClipMentorSourceAsr({...readRequest(),projectId:'other'},readDeps)).state,'stale');
 assert.equal((await readClipMentorSourceAsr({...readRequest(),src:'/media/uploads/other.mp4'},readDeps)).state,'stale');
 currentHash='b'.repeat(64);assert.equal((await readClipMentorSourceAsr(readRequest(),readDeps)).state,'stale');currentHash=hash;
 const changeRecord=async(change:(value:any)=>void)=>{const value=JSON.parse(original);change(value);await writeFile(join(directory,request.operationId+'.json'),JSON.stringify(value));};
 await changeRecord(v=>{delete v.result;v.status='request_reserved';v.requests_attempted=1;});const reserved=await readClipMentorSourceAsr(readRequest(),readDeps);assert.equal(reserved.state,'pending_or_unknown');assert.equal(reserved.requestsAttempted,1);
 await changeRecord(v=>{delete v.identity;});assert.equal((await readClipMentorSourceAsr(readRequest(),readDeps)).state,'unverifiable');
 await changeRecord(v=>{v.identity.language='ms';});assert.equal((await readClipMentorSourceAsr(readRequest(),readDeps)).state,'invalid');
 await changeRecord(v=>{v.result.source_hash='b'.repeat(64);});assert.equal((await readClipMentorSourceAsr(readRequest(),readDeps)).state,'invalid');
 await changeRecord(v=>{v.result.words[0].end_seconds=100;});assert.equal((await readClipMentorSourceAsr(readRequest(),readDeps)).state,'invalid');
 await changeRecord(v=>{v.result.requests_attempted=0;});assert.equal((await readClipMentorSourceAsr(readRequest(),readDeps)).state,'invalid');
 await changeRecord(v=>{v.identity.maxRequests=2;v.fingerprint=sha(JSON.stringify(v.identity));v.result.status='partial';v.result.requests_attempted=2;v.result.chunks.push({...v.result.chunks[0],chunk_id:'chunk-2',offset_seconds:1,status:'failed',words:[],error:'provider_request_failed_or_invalid_timestamps'});});
 const partialOriginal=await readFile(join(directory,request.operationId+'.json'),'utf8'),partial=await readClipMentorSourceAsr(readRequest(),readDeps);assert.equal(partial.state,'partial');assert.equal(partial.original_status,'partial');assert.equal(partial.requestsAttempted,2);assert.equal(partial.recovered_from_raw,false);assert.equal(await readFile(join(directory,request.operationId+'.json'),'utf8'),partialOriginal);
 await changeRecord(v=>{v.result.secret='must-not-escape';v.result.audio.internal='must-not-escape';});assert(!JSON.stringify(await readClipMentorSourceAsr(readRequest(),readDeps)).includes('must-not-escape'));
 await writeFile(join(directory,request.operationId+'.json'),'broken');assert.equal((await readClipMentorSourceAsr(readRequest(),readDeps)).state,'invalid');
 await writeFile(join(directory,request.operationId+'.json'),' '.repeat(2_000_001));assert.equal((await readClipMentorSourceAsr(readRequest(),readDeps)).state,'invalid');
 await changeRecord(v=>{v.result.status='failed';v.result.words=[];v.result.chunks[0].status='failed';v.result.chunks[0].words=[];v.result.chunks[0].failure_stage='timestamps';v.result.issues=['chunk-1:provider_request_failed_or_invalid_timestamps'];});
 const failedOriginal=await readFile(join(directory,request.operationId+'.json'),'utf8');
 const recoveryCancelled=new AbortController();let cancelChecks=0;const originalThrow=AbortSignal.prototype.throwIfAborted;Object.defineProperty(recoveryCancelled.signal,'throwIfAborted',{value(){if(++cancelChecks===3)recoveryCancelled.abort();originalThrow.call(this);}});
 await assert.rejects(readClipMentorSourceAsr(readRequest(),readDeps,recoveryCancelled.signal),{name:'AbortError'});assert.equal(await readFile(join(directory,request.operationId+'.json'),'utf8'),failedOriginal);await assert.rejects(readFile(join(directory,request.operationId+'.json.recovered-raw-v1.json')),{code:'ENOENT'});
 const recovered=await readClipMentorSourceAsr(readRequest(),readDeps);
 assert.equal(recovered.state,'completed');assert.equal(recovered.original_status,'failed');assert.equal(recovered.recovered_from_raw,true);assert.equal(recovered.requestsAttempted,1);assert.equal(providers,1);assert.equal(await readFile(join(directory,request.operationId+'.json'),'utf8'),failedOriginal);
 // Oversized raw cannot be parsed or substituted for a valid result.
 const alias=JSON.parse(await readFile(join(directory,'external-calls','request-'+sha(request.operationId+':chunk-1')+'.json'),'utf8'));
 const rawFile=join(directory,'external-calls',alias.input_sha256+'.response'),raw=await readFile(rawFile);
 await writeFile(rawFile,' '.repeat(2_000_001));const rawBad=await readClipMentorSourceAsr(readRequest(),readDeps);assert.equal(rawBad.state,'failed');assert.equal(rawBad.recovered_from_raw,false);assert.equal(rawBad.requestsAttempted,1);await writeFile(rawFile,raw);
 await writeFile(join(directory,request.operationId+'.json'),original);
 const changedDuringHash={...readDeps,hash:async()=>{const value=JSON.parse(original);value.result.words[0].text='changed during read';await writeFile(join(directory,request.operationId+'.json'),JSON.stringify(value));return hash;}};
 assert.equal((await readClipMentorSourceAsr(readRequest(),changedDuringHash)).state,'stale');await writeFile(join(directory,request.operationId+'.json'),original);

 let handler:((req:IncomingMessage,res:ServerResponse)=>void)|undefined;
 const configure=clipMentorFunAsrPlugin(readDeps).configureServer!;assert.equal(typeof configure,'function');if(typeof configure!=='function')throw Error();
 configure.call({} as never,{middlewares:{use:(_path:string,fn:typeof handler)=>{handler=fn;}}} as never);
 const server=createServer((req,res)=>handler!(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
 try{
  const post=(body:unknown,authorized=true)=>fetch(origin,{method:'POST',headers:{'Content-Type':'application/json',...(authorized?{Origin:origin}:{})},body:JSON.stringify(body)});
  assert.equal((await post(readRequest(),false)).status,401);const response=await post(readRequest());assert.equal(response.status,200);assert.equal((await response.json()).state,'completed');
  const invalid=await post({...readRequest(),operationId:'../test-key'});assert.equal(invalid.status,400);assert(!(await invalid.text()).includes('test-key'));
  const typo=await post({...readRequest(),action:'status'});assert.equal(typo.status,400);assert.equal(providers,1);
  let doc={assets:[{id:'source',kind:'video',src:request.src,sourceContentHash:hash}]} as unknown as ProjectDoc;
  let requests=0;const ctx={getDoc:()=>doc,getProjectId:()=>projectId,commands:{applyDoc:fail},hostFetch:async(_url:unknown,init:RequestInit)=>{requests++;assert.equal(JSON.parse(String(init.body)).action,'read');return post(JSON.parse(String(init.body)));}} as unknown as AgentContext;
  const before=JSON.stringify(doc);const read=await execClipMentorAnalysisTool('read_clipmentor_analysis',{view:'source_asr',assetId:'source',operationId:request.operationId},ctx) as any;
  assert.equal(read.ok,true);assert.equal(read.state,'completed');assert.equal(JSON.stringify(doc),before);assert.equal(requests,1);
  doc.clipMentorAnalysis={source:{asset_id:'source',sourceContentHash:hash}} as never;
  const existing=JSON.stringify(doc),existingRead=await execClipMentorAnalysisTool('read_clipmentor_analysis',{view:'source_asr',assetId:'source',operationId:request.operationId},ctx) as any;assert.equal(existingRead.state,'completed');assert.equal(JSON.stringify(doc),existing);assert.equal(requests,2);
  doc.clipMentorAnalysis={source:{asset_id:'different-source',sourceContentHash:hash}} as never;
  assert((await execClipMentorAnalysisTool('read_clipmentor_analysis',{view:'source_asr',assetId:'source',operationId:request.operationId},ctx) as any).error);assert.equal(requests,2);delete doc.clipMentorAnalysis;
  for(const view of ['full','storyboard','current_copy','evidence','copy_review','source_breakdown']){const no=await execClipMentorAnalysisTool('read_clipmentor_analysis',{view,assetId:'source',operationId:request.operationId},ctx) as any;assert(no.error);}
  const extra=await execClipMentorAnalysisTool('read_clipmentor_analysis',{view:'source_asr',assetId:'source',operationId:request.operationId,unitId:'wrong'},ctx) as any;assert(extra.error);assert.equal(requests,2);
  const mutateCtx={...ctx,hostFetch:async()=>{doc=structuredClone(doc);doc.assets[0].sourceContentHash='b'.repeat(64);return Response.json(normal);}} as AgentContext;
  const stale=await execClipMentorAnalysisTool('read_clipmentor_analysis',{view:'source_asr',assetId:'source',operationId:request.operationId},mutateCtx) as any;assert(stale.error);assert.equal(stale.requestsSent,0);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 assert(providers===1&&hashes>0);
 console.log('ASR saved-read: fresh-analysis context, actual tool/HTTP route, bound result/raw recovery, missing/legacy/unknown/stale/malformed/oversized/wrong source+owner, immutable ledger/counters, context drift, strict view args and zero provider submissions passed.');
}finally{await rm(directory,{recursive:true,force:true});}
