import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {mkdtemp,readFile,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMiniConnect} from '../../desktop/mini-connect';
import {seedKeystore} from '../keystore';
import {llmProxyPlugin} from '../plugins/llm-proxy';
import {apiCopyReviewDependencies} from './copy-review-api';
import {CopyReviewError,reviewClipMentorCopy,type CopyReviewDependencies} from './copy-review';
import fixture from '../../src/clipmentor/fixtures/copy-review-r171-contract.json';

Reflect.set(globalThis,'AI_SDK_LOG_WARNINGS',false);
const root=await mkdtemp(join(tmpdir(),'cm-copy-cross-'));
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const rows:unknown[]=[];
function request(){const r=structuredClone(fixture.request);r.operationId=randomUUID();for(const u of r.packet.units)Object.assign(u,{source_context:{scope:'frozen_task_scope',source_ranges:[[0,r.source.duration]],evidence_ids:r.packet.source_evidence.filter(e=>e.time_seconds?.length).map(e=>e.evidence_id),speech:'unavailable'}});return r;}
async function listen(s:Server){await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const a=s.address();assert(a&&typeof a!=='string');return `http://127.0.0.1:${a.port}`;}
async function close(s:Server){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()));}
function gate(){let release!:()=>void;return {promise:new Promise<void>(r=>release=r),release:()=>release()};}
function synthetic(adapter:CopyReviewDependencies,name:string){return {...adapter,directory:join(root,name),resolve:()=>'/synthetic-video',hash:async()=>fixture.request.source.hash,frame:async()=> 'YQ=='};}
function diagnostic(e:unknown){assert(e instanceof CopyReviewError);return e.diagnostic;}
async function external(directory:string){const names=(await readdir(join(directory,'external-calls'))).filter(n=>/^[a-f0-9]{64}\.json$/.test(n));assert.equal(names.length,1);return JSON.parse(await readFile(join(directory,'external-calls',names[0]),'utf8'));}
function record(row:unknown){rows.push(row);console.log(JSON.stringify(row));}
let upstreamCalls=0,ingress=0,mutate=false,preparation='',reserved='';let ledger='';let directory='';
const upstream=createServer(async(req,res)=>{for await(const _chunk of req){}upstreamCalls++;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:'fixture',choices:[{index:0,message:{role:'assistant',content:JSON.stringify(fixture.raw_review)},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));});
const baseUrl=await listen(upstream);
const app=createMiniConnect(e=>{throw e;});
app.use('/llm',(req,_res,next)=>{ingress++;void(async()=>{reserved=await readFile(ledger,'utf8');const row=await external(directory);assert.equal(row.status,'pending','proxy ingress follows external reservation');if(mutate)seedKeystore({LLM_OPENAI_API_KEY:'synthetic-rotated-token'});next();})().catch(next);});
(llmProxyPlugin().configureServer as (s:unknown)=>void)({middlewares:app});
const proxy=createServer(app.handle),origin=await listen(proxy);
try{
 seedKeystore({LLM_OPENAI_API_KEY:'synthetic-original-token',LLM_OPENAI_BASE_URL:baseUrl+'/v1'});
 const adapter=apiCopyReviewDependencies({provider:'openai',model:'fixture',apiMode:'chat',origin});
 const r=request(),deps=synthetic(adapter,'proxy-409');directory=deps.directory;ledger=join(directory,r.operationId+'.json');
 deps.frame=async()=>{preparation ||= await readFile(ledger,'utf8');return 'YQ==';};mutate=true;
 const err=await reviewClipMentorCopy(r,deps).catch(e=>e);const after=await readFile(ledger,'utf8'),ext=await external(directory);
 assert.equal(diagnostic(err).code,'model_turn_failed');assert.equal(ingress,1);assert.equal(upstreamCalls,0);assert.notEqual(after,preparation);assert.equal(JSON.parse(reserved).status,'reserved');
 seedKeystore({LLM_OPENAI_API_KEY:'synthetic-original-token'});mutate=false;
 for(const mode of [true,'resume_preparation',false] as const){await assert.rejects(reviewClipMentorCopy(r,deps,undefined,mode),e=>diagnostic(e).code==='model_turn_failed');assert.equal(await readFile(ledger,'utf8'),after);}
 assert.equal(ingress,1);assert.equal(upstreamCalls,0);
 record({case:'actual-sdk-proxy-409-after-reservation',operationId:r.operationId,ingress,upstreamCalls,diagnostic:diagnostic(err),external:ext,preparation,preparationSha256:sha(preparation),after,afterSha256:sha(after),restoredConfigSameOperationExtraRequests:0});
 // Noncooperative response after cancellation: original paid response remains
 // readable with new account identity and the parent failure stays byte exact.
 {
  let calls=0;const entered=gate(),release=gate(),returned=gate();const controller=new AbortController();const rr=request();const dd=synthetic(adapter,'cancel-late-raw');
  dd.run=async()=>{calls++;entered.release();await release.promise;returned.release();return fixture.raw_review;};
  const first=reviewClipMentorCopy(rr,dd,controller.signal).catch(e=>e);await entered.promise;
  await assert.rejects(reviewClipMentorCopy(rr,dd),e=>diagnostic(e).code==='operation_unavailable');controller.abort();const error=await first;
  assert.equal(diagnostic(error).code,'review_cancelled_or_timed_out');const original=await readFile(join(dd.directory,rr.operationId+'.json'),'utf8');
  release.release();await returned.promise;
  // Wait on actual archive publication via bounded event-loop turns, no sleeps.
  const {readSavedExternalResponse}=await import('./external-call');let saved:unknown;
  for(let i=0;i<1000&&saved===undefined;i++){saved=await readSavedExternalResponse(dd.directory,rr.operationId);if(saved===undefined)await new Promise<void>(r=>setImmediate(r));}
  assert(saved,'late raw must be durably archived');seedKeystore({LLM_OPENAI_API_KEY:'synthetic-new-account'});
  for(const mode of [true,'resume_preparation',false] as const){const result=await reviewClipMentorCopy(rr,dd,undefined,mode);assert.equal(result.cached,true);assert.equal(result.requestsAttempted,1);assert.equal(await readFile(join(dd.directory,rr.operationId+'.json'),'utf8'),original);}
  assert.equal(calls,1);record({case:'cancel-concurrent-late-raw-new-account',operationId:rr.operationId,calls,diagnostic:diagnostic(error),parentBytes:original,parentSha256:sha(original),rawRecovered:true,parentUnchanged:true});
 }
 // An asynchronous identity hook is intentionally injected to check whether its
 // resolved identity is bound or an unresolved Promise gets persisted instead.
 {
  let calls=0;const rr=request(),dd=synthetic(adapter,'async-identity');dd.preparationIdentity=(async()=> 'same-account') as unknown as ()=>string;dd.run=async()=>{calls++;return fixture.raw_review;};
  const error=await reviewClipMentorCopy(rr,dd).catch(e=>e);const original=await readFile(join(dd.directory,rr.operationId+'.json'),'utf8');
  const second=await reviewClipMentorCopy(rr,dd,undefined,'resume_preparation').catch(e=>e);
  assert.equal(calls,0);assert.equal(diagnostic(error).code,'operation_unavailable');assert.equal(diagnostic(second).code,'operation_unavailable');assert.equal(await readFile(join(dd.directory,rr.operationId+'.json'),'utf8'),original);
  record({case:'async-hook-outside-declared-sync-contract',calls,first:diagnostic(error),resume:diagnostic(second),parentBytes:original,parentSha256:sha(original)});
 }
}finally{await close(proxy);await close(upstream);}
await writeFile(join(root,'results.json'),JSON.stringify(rows,null,2));
console.log('PASS copy cross probe; actual SDK/proxy/local HTTP + synthetic late raw; external services/render/install: 0; evidence:',root);
