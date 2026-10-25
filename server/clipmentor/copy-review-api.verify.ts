import assert from 'node:assert/strict';
import {apiCopyReviewDependencies} from './copy-review-api';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {reviewClipMentorCopy} from './copy-review';
import contract from '../../src/clipmentor/fixtures/copy-review-r171-contract.json';
import type {generateText} from 'ai';
let requests=0;let captured:Record<string,unknown>={};
const config={provider:'openai' as const,model:'fixture-api',origin:'http://127.0.0.1:5199',apiMode:'responses' as const};
const runner=apiCopyReviewDependencies(config,(async(options:Record<string,unknown>)=>{requests++;captured=options;return {text:'{"case":"raw"}'};}) as unknown as typeof generateText,{} as never);
const value=await runner.run('frozen independent packet',[{unit_id:'u',phase:'original',source_seconds:2,base64:'YQ=='}],'review','p',new AbortController().signal);
assert.deepEqual(value,{case:'raw'});assert.equal(requests,1);assert.equal(captured.maxRetries,0);assert.equal(captured.tools,undefined);
const messages=captured.messages as Array<{content:unknown[]}>;assert.equal(messages.length,1);assert.equal(messages[0].content.length,3);
assert.equal(runner.runtime?.method,'isolated-api-copy-and-picture-v1');assert.equal(runner.runtime?.model,'fixture-api');
const failing=apiCopyReviewDependencies(config,(async()=>{requests++;throw Error('Injected gateway error');}) as unknown as typeof generateText,{} as never);
await assert.rejects(failing.run('packet',[],'r','p',new AbortController().signal),/Injected gateway/);assert.equal(requests,2,'one failed API call, no retry or desktop fallback');
console.log('copy-review-api: isolated single request, inline fixed frames, model provenance, no tools/history/retry/desktop fallback passed; mocked provider only');

const directory=await mkdtemp(join(tmpdir(),'api-copy-review-'));
try{
 let calls=0;
 const adapter=apiCopyReviewDependencies(config,(async()=>{calls++;return {text:JSON.stringify(contract.raw_review)};}) as unknown as typeof generateText,{} as never);
 const deps={...adapter,directory,resolve:()=>join(directory,'fixture.mp4'),hash:async()=>contract.request.source.hash,frame:async()=> 'YQ=='};
 const request={...structuredClone(contract.request),operationId:randomUUID()};
 const result=await reviewClipMentorCopy(request,deps);assert.equal(calls,1);assert.equal(result.operationId,request.operationId);
 const receipt=JSON.parse(await readFile(join(directory,`${request.operationId}.json`),'utf8'));
 assert.equal(receipt.method,'isolated-api-copy-and-picture-v1');assert.equal(receipt.model,config.model);assert.equal(receipt.provider,config.provider);assert.equal(receipt.apiMode,config.apiMode);assert.deepEqual(receipt.raw_review,contract.raw_review);
 const reread=await reviewClipMentorCopy(request,deps,undefined,true);
 await assert.rejects(reviewClipMentorCopy({...request,operationId:randomUUID()},deps,undefined,true),/operation_unavailable/);assert.equal(calls,1,'readonly recovery never creates a missing review');assert.equal(reread.cached,true);assert.equal(calls,1,'saved API result is read without another model call');
 await assert.rejects(reviewClipMentorCopy(request,{...deps,runtime:{...deps.runtime!,provider:'gemini'}}),/operation_unavailable/);assert.equal(calls,1,'changing reviewer backend cannot reuse the same operation');
 console.log('API review full service: saved raw judgment/result/method/model, immutable readback and no repeat request passed using frozen historical response in temp storage');
}finally{await rm(directory,{recursive:true,force:true});}
