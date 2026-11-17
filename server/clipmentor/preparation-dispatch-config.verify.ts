import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createServer,type Server,type IncomingHttpHeaders} from 'node:http';
import {mkdtemp,readFile,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createMiniConnect} from '../../desktop/mini-connect';
import {getKey,seedKeystore} from '../keystore';
import {llmProxyPlugin} from '../plugins/llm-proxy';
import {previewBridge} from '../plugins/clipmentor-preview-review';
import {apiCopyReviewDependencies} from './copy-review-api';
import {CopyReviewError,reviewClipMentorCopy,type CopyReviewDependencies} from './copy-review';
import fixture from '../../src/clipmentor/fixtures/copy-review-r171-contract.json';

Reflect.set(globalThis,'AI_SDK_LOG_WARNINGS',false);
const root=await mkdtemp(join(tmpdir(),'cm-dispatch-config-'));
const secretOld='synthetic-dispatch-old',secretNew='synthetic-dispatch-new';
const internalHeader='x-openchatcut-preparation-identity';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function request(){
  const r=structuredClone(fixture.request);r.operationId=randomUUID();
  for(const u of r.packet.units)Object.assign(u,{source_context:{scope:'frozen_task_scope',source_ranges:[[0,r.source.duration]],evidence_ids:r.packet.source_evidence.filter(e=>e.time_seconds?.length).map(e=>e.evidence_id),speech:'unavailable'}});
  return r;
}
async function listen(server:Server){await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const address=server.address();assert(address&&typeof address!=='string');return `http://127.0.0.1:${address.port}`;}
async function close(server:Server){server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
async function textFiles(directory:string):Promise<string[]>{const out:string[]=[];for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())out.push(...await textFiles(path));else if(!entry.name.includes('.sqlite'))out.push(await readFile(path,'utf8'));}return out;}
function synthetic(adapter:CopyReviewDependencies,directory:string):CopyReviewDependencies{return {...adapter,directory,resolve:()=>'/synthetic-video',hash:async()=>fixture.request.source.hash,frame:async()=> 'YQ=='};}

// Actual AI SDK -> HTTP -> production llmProxyPlugin -> local upstream. The
// drift is applied after the SDK has emitted its frozen header, at proxy ingress.
const wire:Array<{headers:IncomingHttpHeaders;body:Record<string,unknown>;url:string|undefined}>=[];
const upstream=createServer(async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
  wire.push({headers:req.headers,body:JSON.parse(Buffer.concat(chunks).toString()),url:req.url});
  res.writeHead(200,{'content-type':'application/json'});
  res.end(JSON.stringify({id:'fixture-chat',object:'chat.completion',created:1,model:'fixture-model',choices:[{index:0,message:{role:'assistant',content:JSON.stringify(fixture.raw_review)},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
});
const upstreamOrigin=await listen(upstream);
let mutate:((headers:IncomingHttpHeaders)=>void)|undefined;
let ingress=0;
const app=createMiniConnect(error=>{throw error;});
app.use('/llm',(req,_res,next)=>{
  ingress++;assert.match(String(req.headers[internalHeader]),/^[a-f0-9]{64}$/,'SDK must carry the service-captured identity');
  mutate?.(req.headers);next();
});
const plugin=llmProxyPlugin();
(plugin.configureServer as (server:unknown)=>void)({middlewares:app});
const proxy=createServer(app.handle),origin=await listen(proxy);
const baseUrl=upstreamOrigin+'/v1';
try{
  for(const variant of ['same','account','baseUrl','origin'] as const){
    seedKeystore({LLM_OPENAI_API_KEY:secretOld,LLM_OPENAI_BASE_URL:baseUrl});
    const adapter=apiCopyReviewDependencies({provider:'openai',model:'fixture-model',apiMode:'chat',origin});
    const r=request(),deps=synthetic(adapter,join(root,'wire-'+variant));
    const before=wire.length,previousIngress=ingress;
    mutate=variant==='account'?()=>seedKeystore({LLM_OPENAI_API_KEY:secretNew}):variant==='baseUrl'?()=>seedKeystore({LLM_OPENAI_BASE_URL:baseUrl+'/changed'}):variant==='origin'?headers=>{headers.origin=origin+'/changed';}:undefined;
    if(variant==='same'){
      const result=await reviewClipMentorCopy(r,deps);assert.equal(result.requestsAttempted,1);
      assert.equal(wire.length,before+1);const sent=wire.at(-1)!;
      assert.equal(sent.headers.authorization,'Bearer '+secretOld);assert.equal(sent.headers[internalHeader],undefined,'internal fence must not reach upstream');assert.equal(sent.headers['x-openchatcut-provider'],undefined);
      assert.equal(sent.url,'/v1/chat/completions');assert.equal(sent.body.model,'fixture-model');
    }else{
      await assert.rejects(reviewClipMentorCopy(r,deps),error=>error instanceof CopyReviewError&&error.diagnostic.code==='model_turn_failed');
      assert.equal(wire.length,before,variant+' drift must be stopped before upstream');
      const journal=JSON.parse(await readFile(join(deps.directory,r.operationId+'.json'),'utf8'));assert.equal(journal.requests_attempted,1,'proxy call consumed locally; no replay');
    }
    assert.equal(ingress,previousIngress+1,'one real SDK request, no retries');
  }
}finally{await close(proxy);await close(upstream);}

// Frame-stage drift is a refusal, preserving the exact original preparation.
{
  let identity='old',calls=0,original='';const r=request();
  const adapter=apiCopyReviewDependencies({provider:'openai',model:'fixture-model',apiMode:'chat',origin});
  const deps=synthetic(adapter,join(root,'copy-preparation'));
  deps.preparationIdentity=()=>identity;
  deps.frame=async()=>{original ||= await readFile(join(deps.directory,r.operationId+'.json'),'utf8');identity='new';return 'YQ==';};
  deps.run=async(_prompt,_frames,_runId,_projectId,_signal,expected)=>{assert.equal(expected,'old','service must pass its original identity through dispatch');calls++;return fixture.raw_review;};
  await assert.rejects(reviewClipMentorCopy(r,deps),error=>error instanceof CopyReviewError&&error.diagnostic.code==='operation_unavailable'&&error.diagnostic.requestsAttempted===0);
  assert.equal(calls,0);assert.equal(await readFile(join(deps.directory,r.operationId+'.json'),'utf8'),original);
  identity='old';deps.frame=async()=> 'YQ==';await reviewClipMentorCopy(r,deps,undefined,'resume_preparation');assert.equal(calls,1,'original preparation remains resumable');
}

// Preview checks both sides of its durable claim. No child launch means zero
// attempts, and a claim made by this call must not strand future resume.
const video=join(root,'preview.mp4');await writeFile(video,'synthetic-preview');
for(const driftAt of [2,3]){
  let checks=0,calls=0;const directory=join(root,'preview-'+driftAt),operationId=randomUUID();
  const body={action:'request',projectId:'fixture',operationId,maxRequests:1,src:'/media/uploads/preview.mp4',videoSha256:hash('synthetic-preview'),input:{duration_seconds:10,points:[{point_id:'P',teaching_goal_zh:'fixture',product_relevance:'fixture'}],units:[{unit_id:'U',point_ids:['P']}],reference_text:[]}};
  const deps={directory,resolve:()=>video,preparationIdentity:()=>++checks>=driftAt?'new':'old',run:async()=>{calls++;}};
  if(driftAt===2)await assert.rejects(previewBridge(body,deps),/configuration changed/);
  else{const result=await previewBridge(body,deps);assert.equal(result.requestsAttempted,0);assert.equal(result.requestsSent,0);assert.equal(result.requestOutcome,'not_submitted');assert.equal(result.status,'preparing');}
  assert.equal(calls,0);const operationDir=join(directory,'fixture',operationId);
  assert.deepEqual((await readdir(operationDir)).sort(),['binding.json','input.json']);
  const binding=await readFile(join(operationDir,'binding.json'),'utf8');assert.equal(JSON.parse(binding).preparationIdentity,'old');
  const input=await readFile(join(operationDir,'input.json'),'utf8');
  await assert.rejects(previewBridge({...body,action:'resume_preparation'},{...deps,preparationIdentity:()=> 'new'}),/configuration changed/);
  assert.equal(await readFile(join(operationDir,'binding.json'),'utf8'),binding);assert.equal(await readFile(join(operationDir,'input.json'),'utf8'),input);
  if(driftAt===3){
    const claim=join(operationDir,'launch.claim'),ledger=join(operationDir,operationId+'.operation.json');
    const childPreparation=JSON.stringify({preparation_protocol:1,status:'preparing',requests_attempted:0,account:hash('synthetic-child')});
    await writeFile(claim,'existing-child-claim');await writeFile(ledger,childPreparation);
    checks=0;const resumed=await previewBridge({...body,action:'resume_preparation'},deps);
    assert.equal(resumed.requestsAttempted,0);assert.equal(resumed.requestsSent,0);assert.equal(resumed.requestOutcome,'not_submitted');assert.equal(calls,0);
    assert.equal(await readFile(claim,'utf8'),'existing-child-claim','refusing resume must retain a pre-existing child claim');
    assert.equal(await readFile(ledger,'utf8'),childPreparation);assert.equal(await readFile(join(operationDir,'binding.json'),'utf8'),binding);
  }
}
const persisted=(await textFiles(root)).join('\n');assert(!persisted.includes(secretOld));assert(!persisted.includes(secretNew));
assert.equal(getKey('LLM_OPENAI_API_KEY'),secretOld,'last HTTP test did not mutate account');
console.log('PASS dispatch configuration: actual SDK/proxy/wire positive + account/baseUrl/origin fences; copy byte-preserving refusal/resume; preview pre/post-claim zero attempts; no synthetic credentials persisted. External services: 0. Evidence:',root);
