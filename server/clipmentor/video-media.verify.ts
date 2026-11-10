import { seedKeystore } from '../keystore';
import { recoverProductionGateway, confirmedUnsubmittedGateway } from './production-recovery';
import { prepareVideoMedia } from './video-media';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { prepareR2Video, resolveVideoR2Credentials, VideoMediaError, type VideoObjectStore } from './video-media';
import { echoesMediaSecret, videoInput } from './video-input';
import { buildPreviewReviewRequest, reviewClipMentorPreview } from './preview-review';
import { buildSourceVideoRequest, observeSourceVideo, recoverSourceVideoReceipt, readSourceVideoReceipt } from './source-video';
import type { SourceVideoRequest } from '../../shared/clipmentor-source-video';
import fixture from '../../src/clipmentor/fixtures/copy-teaching-blind-v2-20261019.json';
const hash=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
const temporary=await mkdtemp(join(tmpdir(),'clipmentor-media-'));
const data=Buffer.alloc(9*1024*1024,71),sha256=hash(data),file=join(temporary,'original.mp4');
await writeFile(file,data);
function fake() {
  const objects=new Map<string,{data:Buffer;etag:string}>();
  const uploads=new Map<string,Map<number,Buffer>>();
  const uploadKeys=new Map<string,string>();
  const calls={create:0,part:0,get:0,complete:0,sign:0};
  let failure:'none'|'part_before'|'part_after'|'part_always'|'complete_after'|'auth'|'corrupt'|'truncate'|'create_after'='none';
  const store:VideoObjectStore={identity:'bucket-A',
    head:async key=>{const v=objects.get(key);return v?{bytes:v.data.length,etag:v.etag}:null;},
    pending:async key=>[...uploadKeys].filter(([,k])=>k===key).map(([id])=>id),
    create:async(key)=>{calls.create++;const id=randomUUID();uploads.set(id,new Map());uploadKeys.set(id,key);if(failure==='create_after'){failure='none';throw {code:'ECONNRESET'};}return id;},
    list:async(_key,id)=>[...uploads.get(id)!].map(([number,data])=>({number,etag:hash(data),bytes:data.length})),
    part:async(_key,id,n,body)=>{
      calls.part++;
      const b:Buffer[]=[];for await(const chunk of body)b.push(chunk);const bytes=Buffer.concat(b);
      if(failure==='auth')throw {$metadata:{httpStatusCode:403},message:'secret-provider-url'};
      if(failure==='part_before'){failure='none';throw {code:'ECONNRESET'};}
      if(failure==='part_always')throw {code:'ECONNRESET'};
      uploads.get(id)!.set(n,bytes);
      if(failure==='part_after'){failure='none';throw {code:'ECONNRESET'};}
      return hash(bytes);
    },
    complete:async(key,id,parts)=>{calls.complete++;objects.set(key,{data:Buffer.concat(parts.map(p=>uploads.get(id)!.get(p.number)!)),etag:'immutable-etag'});uploadKeys.delete(id);
      if(failure==='complete_after'){failure='none';throw {code:'ECONNRESET'};}},
    get:async key=>{calls.get++;const data=objects.get(key)!.data;
      return Readable.from([failure==='corrupt'?Buffer.alloc(data.length,33):failure==='truncate'?data.subarray(0,-1):data]);},
    sign:async key=>{calls.sign++;return `https://account.r2.cloudflarestorage.com/bucket/${key}?signature=${calls.sign}`;},
  };
  return {store,calls,objects,uploads,set failure(v:typeof failure){failure=v;}};
}
let cases=0;
const run=async(name:string,check:()=>Promise<void>)=>{await check();cases++;console.log(`PASS ${name}`);};
const options=(f:ReturnType<typeof fake>,id:string)=>({file,sha256,directory:join(temporary,id),namespace:'tenant-A/profile-A',store:f.store,signal:AbortSignal.timeout(10_000)});
const preview={duration_seconds:10,points:[{point_id:'P',teaching_goal_zh:'动作',product_relevance:'商品'}],units:[{unit_id:'U',point_ids:['P']}],reference_text:[]};
const packet=structuredClone(fixture.blind_input.cases[0].packet) as SourceVideoRequest['packet'];
packet.units=[packet.units[0]];
packet.units[0].picture_plan={original_source_ranges:[[0,2]],explanation_source_ranges:[[2,4]],line_source_ranges:packet.units[0].lines.map(l=>({line_id:l.line_id,source_range_seconds:[2,4]})),registered_revisits:[],execution_plan:{plan_id:'plan',script_candidate_id:'copy',content:{composition:'current'}}};
const request:SourceVideoRequest={operationId:randomUUID(),maxRequests:1,projectId:'project',authorRunId:'author',source:{src:'/media/uploads/original.mp4',hash:sha256,fps:30,duration:5},subject:{revision:1,digest:'a'.repeat(64),units:[{unit_id:packet.units[0].unit_id,candidate_id:'copy'}]},packet};
try {
 await run('whole bytes SHA, streaming readback, signed link renewal and restart reuse',async()=>{
  const f=fake(),o=options(f,'reuse'),m=await prepareR2Video(o),second=await prepareR2Video(o);
  assert.equal(m.sha256,sha256);assert.equal(m.bytes,data.length);assert.equal(m.receipt.verified_to,'object_store');assert.equal(m.receipt.model_fetch_verified,false);
  assert.equal(f.calls.create,1);assert.equal(f.calls.part,2);assert.equal(f.calls.get,1);assert.equal(second.receipt.reused,true);
  assert.notDeepEqual(m.part,second.part);assert.equal(second.receipt.confirmed_part_bytes,0);assert.equal(second.receipt.downloaded_bytes,0);
  assert.deepEqual([...f.objects.values()][0].data,data);
  assert.ok(!JSON.stringify((await readdir(o.directory)).filter(n=>n.endsWith('.json')).map(n=>n)).includes('signature'));
  for(const n of (await readdir(o.directory)).filter(n=>n.endsWith('.json'))) assert.ok(!(await readFile(join(o.directory,n),'utf8')).includes('signature='));
  const a=JSON.parse(buildPreviewReviewRequest(data,preview).body),b=JSON.parse(buildPreviewReviewRequest(m,preview).body);
  assert.equal(b.contents[0].parts[0].inlineData,undefined);assert.equal(b.contents[0].parts[0].fileData.mimeType,'video/mp4');
  assert.deepEqual(a.contents[0].parts.slice(1),b.contents[0].parts.slice(1));assert.deepEqual(a.generationConfig,b.generationConfig);
  const sa=buildSourceVideoRequest(data,request),sb=buildSourceVideoRequest(m,request);
  assert.equal(sa.input_sha256,sb.input_sha256);assert.deepEqual(JSON.parse(sa.body).contents[0].parts.slice(1),JSON.parse(sb.body).contents[0].parts.slice(1));
  assert.ok(Buffer.byteLength(sb.body)<50_000,'no video base64 in R2 request');
 });
 await run('concurrent same-source callers produce one object',async()=>{
  const f=fake(),o=options(f,'concurrent');await Promise.all([prepareR2Video(o),prepareR2Video(o)]);assert.equal(f.calls.create,1);assert.equal(f.calls.part,2);
 });
 for(const failure of ['part_before','part_after','complete_after'] as const)await run(`bounded recovery ${failure}`,async()=>{
  const f=fake();f.failure=failure;await prepareR2Video(options(f,failure));assert.equal(f.calls.create,1);assert.equal(f.calls.part,failure==='part_before'?3:2);
 });
 await run('part retries bounded across restarts; successful sibling retained',async()=>{
  const f=fake();f.failure='part_always';const o=options(f,'bounded');await assert.rejects(prepareR2Video(o),/part_retry_limit/);
  assert.equal(f.calls.part,6);f.failure='none';await assert.rejects(prepareR2Video(o),/part_retry_limit/);assert.equal(f.calls.part,6);assert.equal(f.calls.create,1);
 });
 for(const failure of ['corrupt','truncate'] as const)await run(`reject remote ${failure}`,async()=>{
  const f=fake();f.failure=failure;await assert.rejects(prepareR2Video(options(f,failure)),/remote_hash_mismatch/);assert.equal(f.calls.sign,0);
 });
 await run('changed verified object rejected, not silently repaired or reuploaded',async()=>{
  const f=fake(),o=options(f,'changed');await prepareR2Video(o);for(const v of f.objects.values())v.etag='changed';
  await assert.rejects(prepareR2Video(o),/verified_object_changed/);assert.equal(f.calls.sign,1);assert.equal(f.calls.create,1);
 });
 await run('wrong source hash / aborted / oversized / unverified reference rejected before dispatch',async()=>{
  const f=fake();await assert.rejects(prepareR2Video({...options(f,'wrong'),sha256:'b'.repeat(64)}),/source_hash_mismatch/);
  await assert.rejects(prepareR2Video({...options(f,'abort'),signal:AbortSignal.abort()}),/aborted/);
  const large=join(temporary,'large.mp4');await writeFile(large,Buffer.alloc(15_000_001));
  await assert.rejects(prepareR2Video({...options(f,'large'),file:large}),/url_capability/);assert.equal(f.calls.create,0);
  assert.throws(()=>videoInput({sha256,bytes:data.length,part:{fileData:{fileUri:'https://evil',mimeType:'video/mp4'}}} as any),/Unverified/);
 });
 await run('authorization errors not retried and do not echo provider credentials',async()=>{
  const f=fake();f.failure='auth';let error:unknown;try {await prepareR2Video(options(f,'auth'));}catch(e){error=e;}
  assert.ok(error instanceof VideoMediaError);assert.ok(!String(error).includes('secret-provider'));assert.ok(f.calls.part<=2);assert.equal(f.calls.sign,0);
 });
 await run('tenant and bucket isolate object/verification reuse',async()=>{
  const f=fake(),o=options(f,'scope');await prepareR2Video(o);await prepareR2Video({...o,namespace:'tenant-B'});assert.equal(f.calls.create,2);
  f.store.identity='bucket-B';await prepareR2Video(o);assert.equal(f.calls.get,3);
 });
 await run('model failure counts once; R2 reuse does not resubmit or grant approval',async()=>{
  const f=fake(),o=options(f,'model'),media=await prepareR2Video(o);let posts=0;
  const deps={directory:join(temporary,'source-operations'),key:'test-secret',resolve:()=>file,hash:async()=>sha256,audioPresent:async()=>true,size:async()=>data.length,read:async()=>data,
    prepareMedia:async()=>media,post:async()=>{posts++;return {status:504,body:null};}};
  await assert.rejects(observeSourceVideo(request,deps));assert.equal(posts,1);
  const saved=JSON.parse(await readFile(join(deps.directory,request.operationId+'.json'),'utf8'));
  assert.equal(saved.requests_attempted,1);assert.equal(saved.status,'failed');assert.equal(saved.media_transfer.sha256,sha256);
  assert.ok(!JSON.stringify(saved).includes('signature='));await assert.rejects(observeSourceVideo(request,deps));assert.equal(posts,1);
  let previewPosts=0;await assert.rejects(reviewClipMentorPreview(media,preview,{key:'test-secret',post:async()=>{previewPosts++;return {status:504,body:null};}}));assert.equal(previewPosts,1);
 });
 await run('media preparation failure sends no model request and persists zero attempts',async()=>{
  const id=randomUUID(),directory=join(temporary,'preflight-fail');let posts=0;
  await assert.rejects(observeSourceVideo({...request,operationId:id},{directory,key:'test-secret',resolve:()=>file,hash:async()=>sha256,audioPresent:async()=>true,size:async()=>data.length,read:async()=>data,
    prepareMedia:async()=>{throw new VideoMediaError('r2_readback','remote_hash_mismatch');},post:async()=>{posts++;return {status:200,body:{}};}}),
    (e:any)=>e.receipt?.phase==='prepare'&&e.receipt?.preparation_stage==='r2_readback'&&e.receipt?.requestsAttempted===0);
  assert.equal(posts,0);assert.equal(JSON.parse(await readFile(join(directory,id+'.json'),'utf8')).requests_attempted,0);
  const read=await readSourceVideoReceipt(id,'project',{directory});assert.equal(read.preparation_stage,'r2_readback');
  assert.equal(confirmedUnsubmittedGateway('observation',{body:{receipt:read}},id,'project'),true);
 });
 await run('lost create acknowledgement resumes the pending upload across restart',async()=>{
  const f=fake(),o=options(f,'lost-create');f.failure='create_after';await assert.rejects(prepareR2Video(o));
  await prepareR2Video(o);assert.equal(f.calls.create,1);assert.equal(f.calls.part,2);
 });
 await run('R2 frozen response revalidation is zero-call, immutable and rejects altered identity',async()=>{
  const f=fake(),media=await prepareR2Video(options(f,'revalidate-media')),r={...request,operationId:randomUUID()};
  const prepared=buildSourceVideoRequest(media,r),input=prepared.input;
  const observation={windows:input.units.flatMap(u=>u.windows.map(w=>({window_id:w.window_id,observed_sequence:'continuous fixture action',endpoint:'unknown completion',evidence:[{start_seconds:w.source_range_seconds[0],end_seconds:w.source_range_seconds[1],visible:'fixture visible',audible:'unclear'}]}))),
    lines:input.units.flatMap(u=>u.lines.map(l=>({unit_id:u.unit_id,line_id:l.line_id,status:'insufficient_evidence',reason:'unknown',window_ids:[u.windows[0].window_id]}))),limitations:['No final film acceptance']};
  const archive={status:'reserved',requests_attempted:1,fingerprint:hash(Buffer.from('source-continuous-observation-v1'+JSON.stringify(r))),projectId:r.projectId,subject:r.subject,source_hash:sha256,
    input,request_sha256:hash(Buffer.from(prepared.body)),logical_request_sha256:prepared.logical_request_sha256,media_transfer:media.receipt};
  const failed={...archive,status:'failed',phase:'validate_response',http_status:200,raw_response:{candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(observation)}]}}]}};
  const directory=join(temporary,'revalidate-operations');await mkdir(directory);const path=join(directory,r.operationId+'.json'),original=JSON.stringify(failed);await writeFile(path,original);
  let external=0;const deps={directory,key:'',resolve:()=>file,hash:async()=>sha256,read:async()=>data,size:async()=>data.length,audioPresent:async()=>true,
    prepareMedia:async()=>{external++;throw Error('No storage');},post:async()=>{external++;throw Error('No model');}};
  const recovered=await recoverSourceVideoReceipt(r,archive,deps);assert.equal(recovered.requestsSent,0);assert.equal(recovered.status,'failed');assert.equal(recovered.validation?.status,'valid');
  assert.equal(await readFile(path,'utf8'),original);assert.equal(external,0);
  await assert.rejects(recoverSourceVideoReceipt(r,{...archive,logical_request_sha256:'b'.repeat(64)},deps),/identity mismatch/);
 });
 await run('damaged persisted retry counters rejected before storage',async()=>{
  const f=fake(),o=options(f,'damaged');f.failure='part_always';await assert.rejects(prepareR2Video(o));
  const path=join(o.directory,(await readdir(o.directory)).find(n=>n.endsWith('.json'))!);
  const saved=JSON.parse(await readFile(path,'utf8'));saved.attempts['1']=-2;await writeFile(path,JSON.stringify(saved));const before=f.calls.part;
  await assert.rejects(prepareR2Video(o),/invalid_saved_transfer/);assert.equal(f.calls.part,before);
 });
 await run('failed readback keeps transfer accounting without claiming verification',async()=>{
  const f=fake();f.failure='corrupt';let caught:VideoMediaError|undefined;
  try {await prepareR2Video(options(f,'accounting'));}catch(e){caught=e as VideoMediaError;}
  assert.ok(caught!.metrics!.storage_requests>=5);assert.equal(caught!.metrics!.confirmed_part_bytes,data.length);assert.equal(caught!.metrics!.downloaded_bytes,data.length);
 });
 await run('production bounded recovery cannot resubmit a model with no-retry contract',async()=>{
  let posts=0;const op=randomUUID(),receipt={operationId:op,projectId:'project',status:'failed',requestsAttempted:1,receipt_persisted:true,
   phase:'gateway_request',source_hash:sha256,subject:request.subject,actual_handoff_verified:false,complete_film_accepted:false,
   upstream_http_status:504,model_retry_policy:'no_automatic_retry'};
  const result=await recoverProductionGateway('observe_clipmentor_source_video',{operationId:op},'project',()=>true,async()=>{posts++;return {receipt};},async()=>{},2);
  assert.equal(posts,1);assert.deepEqual(result.receipt,receipt,'retain original failed receipt without a new paid operation');
  assert.deepEqual(result.gateway_recovery_decisions,[{operation_id:op,action:'stop',reason:'model_retry_disabled_by_transport_contract'}],
   'the existing host decision explains the stop without rewriting the model receipt');
  const noPost={...receipt,requestsAttempted:0,requestsSent:0,phase:'prepare'};
  assert.equal(confirmedUnsubmittedGateway('observation',{body:{receipt:noPost}},op,'project'),true);
  assert.equal(confirmedUnsubmittedGateway('observation',{body:{receipt:{...noPost,projectId:'foreign'}}},op,'project'),false);
 });
 await run('expired overall deadline sends zero preview requests',async()=>{
  let posts=0;await assert.rejects(reviewClipMentorPreview(Buffer.from('video'),preview,{key:'test-key',signal:AbortSignal.abort(),post:async()=>{posts++;return {status:200,body:{}};}}));assert.equal(posts,0);
 });
 await run('cleared live configuration does not revive stale startup environment',async()=>{
  const old=process.env.CLIPMENTOR_VIDEO_TRANSPORT;process.env.CLIPMENTOR_VIDEO_TRANSPORT='r2-small';
  try {await assert.rejects(prepareVideoMedia(file,sha256,AbortSignal.timeout(3000)),(e:any)=>e.code==='r2_configuration_unavailable');}
  finally {if(old===undefined)delete process.env.CLIPMENTOR_VIDEO_TRANSPORT;else process.env.CLIPMENTOR_VIDEO_TRANSPORT=old;}
 });
 await run('video-only legacy credential verification is cached, private and rejects partial standard configuration',async()=>{
  let verifies=0;const signal=AbortSignal.timeout(3000),config={CLIPMENTOR_R2_ACCOUNT_ID:'a'.repeat(32),CLIPMENTOR_R2_BUCKET:'fixture-video-only',CLIPMENTOR_R2_API_TOKEN:'fixture-video-token'};
  const verify:typeof fetch=async(url,init)=>{verifies++;assert.equal(url,'https://api.cloudflare.com/client/v4/user/tokens/verify');assert.equal((init?.headers as any).Authorization,'Bearer fixture-video-token');
    return new Response(JSON.stringify({success:true,result:{status:'active',id:'b'.repeat(32)}}),{status:200});};
  const first=await resolveVideoR2Credentials(config,signal,verify);assert.equal(first.accessKeyId,'b'.repeat(32));assert.equal(first.secretAccessKey,hash(Buffer.from(config.CLIPMENTOR_R2_API_TOKEN)));
  assert.deepEqual(await resolveVideoR2Credentials(config,signal,verify),first);assert.equal(verifies,1);
  await assert.rejects(resolveVideoR2Credentials({...config,R2_ACCOUNT_ID:'c'.repeat(32)},signal,verify),/configuration_unavailable/);assert.equal(verifies,1);
  await assert.rejects(resolveVideoR2Credentials(config,AbortSignal.abort(),verify));assert.equal(verifies,1);
  await assert.rejects(resolveVideoR2Credentials({...config,CLIPMENTOR_R2_API_TOKEN:'rejected-token'},signal,async()=>new Response('secret-provider-error',{status:403})),
    (e:any)=>e.code==='r2_credential_verification_failed'&&!String(e).includes('secret-provider-error'));
  const standard={R2_ACCOUNT_ID:'d'.repeat(32),R2_BUCKET:'standard',R2_ACCESS_KEY_ID:'standard-id',R2_SECRET_ACCESS_KEY:'standard-secret'};
  assert.equal((await resolveVideoR2Credentials(standard,signal,async()=>assert.fail('Standard credentials require no verification request'))).bucket,'standard');
 });
 await run('exact 15MB admission requires R2 configuration rather than silently using inline',async()=>{
  const path=join(temporary,'at-url-bound.mp4'),bytes=Buffer.alloc(15_000_000,2);await writeFile(path,bytes);
  await assert.rejects(prepareVideoMedia(path,hash(bytes),AbortSignal.timeout(3000)),(e:any)=>e.code==='r2_configuration_unavailable');
 });
 await run('r2-small preselects old bounded inline for a file above the verified URL size',async()=>{
  const path=join(temporary,'large-route.mp4'),bytes=Buffer.alloc(15_000_001,2);await writeFile(path,bytes);
  const old=process.env.CLIPMENTOR_VIDEO_TRANSPORT;process.env.CLIPMENTOR_VIDEO_TRANSPORT='r2-small';
  seedKeystore({CLIPMENTOR_VIDEO_TRANSPORT:'r2-small'});
  try {const media=await prepareVideoMedia(path,hash(bytes),AbortSignal.timeout(3000));assert.equal(media.receipt.mode,'inline');assert.equal(media.sha256,hash(bytes));}
  finally {if(old===undefined)delete process.env.CLIPMENTOR_VIDEO_TRANSPORT;else process.env.CLIPMENTOR_VIDEO_TRANSPORT=old;}
 });
 await run('signature echo is rejected; plan revision changes identity while upload stays reusable',async()=>{
  const f=fake(),media=await prepareR2Video(options(f,'echo'));
  assert.ok(echoesMediaSecret({text:('fileData' in media.part)?media.part.fileData.fileUri:''},media));
  let posts=0;await assert.rejects(reviewClipMentorPreview(media,preview,{key:'test-key',post:async()=>{posts++;return {status:200,body:{candidates:[],echo:('fileData' in media.part)?media.part.fileData.fileUri:''}};}}),/credential echo/);assert.equal(posts,1);
  const changed=structuredClone(request);changed.packet.units[0].picture_plan!.execution_plan!.content.composition='different observation question';
  assert.notEqual(buildSourceVideoRequest(media,request).input_sha256,buildSourceVideoRequest(media,changed).input_sha256);
 });
 console.log(`Video media: ${cases} zero-network cases passed; model/gateway/R2 actual calls = 0.`);
} finally {await rm(temporary,{recursive:true,force:true});}
