import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createMiniConnect } from '../../desktop/mini-connect.ts';
import { clipMentorPreviewReviewPlugin, previewBridge } from './clipmentor-preview-review.ts';
import { policyForTool, validateAgentToolInvocation } from '../../src/agent/execution-policy.ts';
import { CLIPMENTOR_ANALYSIS_TOOL_SCHEMAS } from '../../src/agent/tools/schemas/clipmentor-analysis-tools.ts';
import { clipMentorProductionBlock } from '../../src/clipmentor/production-gate.ts';
import { execClipMentorAnalysisTool } from '../../src/agent/tools/clipmentor-analysis-tools.ts';
import { confirmedUnsubmittedGateway } from '../clipmentor/production-recovery';
import type { AgentContext } from '../../src/agent/context.ts';
import sharp from 'sharp';

const directory = await mkdtemp(join(tmpdir(),'preview-bridge-verify-'));
const video = join(directory,'preview.mp4');
const bytes = Buffer.from('mock-MP4-not-a-real-model-call');
await writeFile(video,bytes);
const videoSha256 = createHash('sha256').update(bytes).digest('hex');
const input = { duration_seconds:10, points:[{point_id:'P',teaching_goal_zh:'观察原声到讲解的连续承接',product_relevance:'产品使用展示'}],
  units:[{unit_id:'U',point_ids:['P']}],reference_text:[{channel:'narration',start_seconds:5,end_seconds:8,text:'Rakaman dekat.'}] };
const body = () => ({action:'request',operationId:randomUUID(),projectId:'project-a',maxRequests:1,
  src:'/media/uploads/preview.mp4',videoSha256,input});
let calls = 0;
const deps = {directory:join(directory,'receipts'),resolve:(name:string)=>name==='preview.mp4'?video:null,
  run:async (args:string[])=>{
    calls++;
    const clean = JSON.parse(await readFile(args[args.indexOf('--input')+1],'utf8'));
    assert.deepEqual(clean,input,'server sends clean goals and actual reference text, no prior verdict');
    await writeFile(args[args.indexOf('--out')+1],JSON.stringify({video_sha256:videoSha256,
      input_sha256:createHash('sha256').update(JSON.stringify(clean)).digest('hex'),full_film_accepted:false,
      status:'review_required',judgment:{continuity:[{unit_id:'U',narrative:{status:'insufficient_evidence'}}]}}));
  }};
const app=createMiniConnect((e)=>{throw e;});
const configure=clipMentorPreviewReviewPlugin(deps).configureServer;
assert.equal(typeof configure,'function');
(configure as (s:unknown)=>void)({middlewares:{use:(route:string,handler:(req:IncomingMessage,res:ServerResponse)=>unknown)=>app.use(route,handler)}});
const server=createServer((req,res)=>app.handle(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');
const address=server.address();assert(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
const originalFetch=globalThis.fetch;
globalThis.fetch=(async (url,init)=>{
  const target=new URL(String(url),origin);assert.equal(target.origin,origin,'no external model permitted in this verifier');
  return originalFetch(target,{...init,headers:{Host:`127.0.0.1:${address.port}`,Origin:origin,'Sec-Fetch-Site':'same-origin',...Object.fromEntries(new Headers(init?.headers).entries())}});
}) as typeof fetch;
const ctx={getProjectId:()=> 'project-a',getAgentRunId:()=> 'agent-run-test'} as AgentContext;
try {
  const b=body();
  assert.equal((await previewBridge(b,deps)).status,'completed');assert.equal(calls,1);
  assert.equal((await previewBridge(b,deps)).requestsSent,0);assert.equal(calls,1,'same operation cannot send a second call');
  assert.equal((await previewBridge({action:'read',operationId:b.operationId,projectId:'project-a'},deps)).status,'completed');
  await assert.rejects(previewBridge({...b,input:{...input,duration_seconds:11}},deps));assert.equal(calls,1);
  await assert.rejects(previewBridge({...b,operationId:randomUUID(),src:'/media/uploads/../private.mp4'},deps));
  await assert.rejects(previewBridge({...b,operationId:randomUUID(),videoSha256:'0'.repeat(64)},deps));
  await assert.rejects(previewBridge({...b,operationId:randomUUID(),maxRequests:2},deps));
  for (const action of [['request'],['read'],null,{},true]) {
    await assert.rejects(previewBridge({...b,operationId:randomUUID(),action},deps));
  }
  await assert.rejects(previewBridge({...b,operationId:randomUUID(),input:{...input,expectedVerdict:'pass'}},deps));
  await assert.rejects(previewBridge({action:'read',projectId:'project-b',operationId:b.operationId},deps));
  const failed=body();const failedDeps={...deps,run:async()=>{calls++;throw new Error('credential=do-not-echo');}};
  const failure=await previewBridge(failed,failedDeps);assert('error' in failure);assert.match(failure.error,/consumed/);assert(!JSON.stringify(failure).includes('do-not-echo'));
  assert.equal(failure.requestsSent,null,'a failed child process cannot prove zero upstream requests');
  assert.equal(failure.requestsAttempted,1);
  assert.equal(failure.requestOutcome,'unknown');
  assert.equal((await previewBridge({action:'read',projectId:failed.projectId,operationId:failed.operationId},failedDeps)).requestsSent,0,'receipt reads send no new request');
  const attempts=calls;await previewBridge(failed,failedDeps);assert.equal(calls,attempts,'unknown failure cannot relaunch');
  await writeFile(join(deps.directory,String(failed.projectId),String(failed.operationId),`${failed.operationId}.operation.json`),
    JSON.stringify({status:'failed',requests_attempted:1,error:'Preview review HTTP 504; attempt consumed, no automatic retry'}));
  const knownFailure=await previewBridge({action:'read',projectId:failed.projectId,operationId:failed.operationId},failedDeps);
  assert.equal(knownFailure.upstream_http_status,504);
  assert.equal(knownFailure.requestsSent,0);
  assert.equal(calls,attempts,'typed failure comes from the saved ledger, with no new request');

  const transportLedger = join(deps.directory,failed.projectId,failed.operationId,`${failed.operationId}.operation.json`);
  const diagnostic = {version:'source-transport-v1',operation_id:failed.operationId,
    started_at:new Date().toISOString(),ended_at:new Date().toISOString(),request_bytes:100,
    curl_exit_code:7,error_kind:'curl_failed',http_status:null,
    metrics:{size_upload:0,time_pretransfer:0,time_starttransfer:0},request_ids:{},response_body:{bytes:0}};
  for(const op of [failed.operationId,randomUUID()]){
    await writeFile(transportLedger,JSON.stringify({status:'failed',requests_attempted:1,
      transport_diagnostic:{...diagnostic,operation_id:op}}));
    const reply=await previewBridge({action:'read',projectId:failed.projectId,operationId:failed.operationId,videoSha256},failedDeps);
    assert.equal(confirmedUnsubmittedGateway('preview_review',{body:reply},failed.operationId,failed.projectId),op===failed.operationId);
  }
  assert.equal(calls,attempts,'reading transport diagnostics never launches a process');

  assert.deepEqual(policyForTool('review_clipmentor_preview',{action:'request'}),{effect:'irreversible_external',recovery:'outcome_unknown'});
  assert.deepEqual(policyForTool('review_clipmentor_preview',{action:'read'}),{effect:'read',recovery:'pure'});
  assert.equal(await clipMentorProductionBlock('review_clipmentor_preview',{},ctx),null,'pending copy gate permits review, never production');
  const tool=CLIPMENTOR_ANALYSIS_TOOL_SCHEMAS.find(s=>s.name==='review_clipmentor_preview');assert(tool);
  const validation=validateAgentToolInvocation(tool,{action:'request',operationId:randomUUID(),maxRequests:2},[tool]);
  assert(!validation.ok,'schema rejects expanded paid budget');
  const requested=body();const {projectId:_p,...args}=requested;
  const result=await execClipMentorAnalysisTool('review_clipmentor_preview',args,ctx) as Record<string,unknown>;
  assert.equal(result.ok,true);assert.equal(result.full_film_accepted,false);
  const readback=await execClipMentorAnalysisTool('review_clipmentor_preview',{action:'read',operationId:requested.operationId},ctx) as Record<string,unknown>;
  assert.equal(readback.requestsSent,0);assert.deepEqual(readback.result,result.result);
  assert.equal((readback.effective_review as any).can_use_as_pass,false,'retrieval success never means quality pass');

  const manifest={fps:30,total_frames:300,scenes:[
    {start_frame:0,end_frame:60,kind:'original',content:0},
    {start_frame:60,end_frame:66,kind:'still',content:4,label:'breath'},
    {start_frame:66,end_frame:180,kind:'video',content:2},
    {start_frame:180,end_frame:300,kind:'still',content:5},
  ]};
  const cleanInput={...input,units:[{unit_id:'transition-1',point_ids:['P']}],reference_text:[]};
  const evidence=(start_seconds:number,end_seconds:number,observed:string)=>({start_seconds,end_seconds,channel:'visual_organization',observed});
  const finding=(rows:unknown[],status='supported')=>({status,reasoning:'只读测试意见',evidence:rows});
  const judgment={coverage:[{point_id:'P',depiction:[evidence(2.2,10,'动态视频与静帧混合')],teaching:finding([evidence(2.2,10,'动态与静态交替')])}],
    continuity:[{unit_id:'transition-1',point_ids:['P'],previous:[evidence(0,2,'原片')],current:[evidence(2.2,10,'解释性回看')],relation:'recap',
      narrative:finding([evidence(2,2.3,'气口保留原片画面，接着进入动态视频')]),teaching:finding([evidence(2.2,10,'动态视频与静帧配合讲解')])}]};
  const makeResult=(j:unknown)=>({video_sha256:videoSha256,input_sha256:createHash('sha256').update(JSON.stringify(cleanInput)).digest('hex'),
    raw_public_judgment:JSON.stringify(j),judgment:j,status:'pass',full_film_accepted:false});
  const passDeps={...deps,run:async(args:string[])=>{calls++;await writeFile(args[args.indexOf('--out')+1],JSON.stringify(makeResult(judgment)));}};
  const approved={...body(),input:cleanInput,executionManifest:manifest};
  const good=await previewBridge(approved,passDeps);
  assert.equal(good.effective_review.status,'pass','accurate complete control is not universally blocked');
  assert.equal(good.effective_review.can_use_as_pass,true);assert.equal(good.full_film_accepted,false);
  const ref=join(directory,'reference.jpg');
  await sharp({create:{width:40,height:60,channels:3,background:'#976349'}}).jpeg().toFile(ref);
  const refHash=createHash('sha256').update(await readFile(ref)).digest('hex'),criteriaDigest='a'.repeat(64);
  const quote='  原片画面铺底。\n  ';
  const visualInput={...cleanInput,points:[{point_id:'delivery/intro',teaching_goal_zh:'原画面',product_relevance:'片头'}],
    units:[{unit_id:'delivery/intro',point_ids:['delivery/intro'],output_range_seconds:[0,2]}]};
  const visualDeps={...deps,resolve:(name:string)=>name==='reference.jpg'?ref:deps.resolve(name),
    visualCriteria:async()=>({digest:criteriaDigest,entries:[{src:'/media/uploads/reference.jpg',sha:refHash,
      criterion:{id:'intro',quote,question:'能看到原片吗？',sectionId:'intro',pictureStage:'成绩截图',layout:'original_underlay' as const,
        reference:{assetId:'ref',fileName:'reference.jpg',seconds:0}}}]}),
    run:async(args:string[])=>{
      const clean=JSON.parse(await readFile(args[args.indexOf('--input')+1],'utf8'));
      assert.equal(clean.visual_criteria[0].quote,quote);
      assert.equal(clean.visual_criteria[0].fileName,'reference.jpg');
      assert.equal(clean.visual_criteria[0].base64.slice(0,4),'/9j/');
      assert.deepEqual(clean.units.at(-1).output_range_seconds,[0,2]);
      const visualJudgment={coverage:clean.points.map((p:{point_id:string})=>({point_id:p.point_id,depiction:[evidence(.1,1,'原片')],
        teaching:finding([evidence(.1,1,'原片可见')])})),
        continuity:clean.units.map((u:{unit_id:string;point_ids:string[]})=>({unit_id:u.unit_id,point_ids:u.point_ids,
          previous:[evidence(0,.1,'过渡')],current:[evidence(.1,1,'原片')],relation:'continuation',
          narrative:finding([evidence(.1,1,'原片')]),teaching:finding([evidence(.1,1,'原片')])}))};
      await writeFile(args[args.indexOf('--out')+1],JSON.stringify({...makeResult(visualJudgment),
        input_sha256:createHash('sha256').update(JSON.stringify(clean)).digest('hex')}));
    }};
  const visualRun={...body(),input:visualInput,executionManifest:manifest};
  const visualResult=await previewBridge(visualRun,visualDeps);
  assert.equal(visualResult.effective_review.can_use_as_pass,true);
  assert.equal(visualResult.visualCriteriaDigest,criteriaDigest);
  await assert.rejects(previewBridge({...visualRun,operationId:randomUUID(),input:{...visualInput,visual_criteria:[]}},visualDeps));
  await assert.rejects(previewBridge({...visualRun,operationId:randomUUID(),input:cleanInput},visualDeps),/section missing/);
  const rawPath=join(deps.directory,'project-a',approved.operationId,'result.json');
  const rawBytes=await readFile(rawPath,'utf8');
  const formalRead={action:'read',operationId:approved.operationId};
  const goodRead=await execClipMentorAnalysisTool('review_clipmentor_preview',formalRead,ctx) as any;
  assert.equal(goodRead.effective_review.status,'pass');assert.equal(goodRead.requestsSent,0);
  const countBeforeRead=calls;
  const bad=structuredClone(judgment);
  bad.continuity[0].teaching.evidence=[evidence(2.2,10,'全程只有两张静图')];
  await writeFile(rawPath,JSON.stringify(makeResult(bad)));
  const rejected=await execClipMentorAnalysisTool('review_clipmentor_preview',formalRead,ctx) as any;
  assert.equal(rejected.ok,true,'operation succeeded, independently of review gate');
  assert.equal(rejected.result.status,'pass','original result is preserved');
  assert.equal(rejected.result.judgment.continuity[0].teaching.status,'supported');
  assert.equal(rejected.effective_review.status,'review_required');assert.equal(rejected.effective_review.can_use_as_pass,false);
  assert(rejected.effective_review.blockers.includes('transition-1:static_description_over_video'));
  const unknown=structuredClone(judgment);unknown.continuity[0].teaching.status='insufficient_evidence';
  await writeFile(rawPath,JSON.stringify(makeResult(unknown)));
  assert.equal(((await execClipMentorAnalysisTool('review_clipmentor_preview',formalRead,ctx)) as any).effective_review.can_use_as_pass,false,'model unknown cannot inherit old pass');
  await writeFile(rawPath,JSON.stringify({...makeResult(judgment),raw_public_judgment:'{}'}));
  assert.equal((await previewBridge({...formalRead,projectId:'project-a'},deps)).effective_review.can_use_as_pass,false,'raw-vs-parsed mismatch is blocked');
  await writeFile(rawPath,rawBytes);
  const swapped=structuredClone(manifest);swapped.scenes[2].content=9;
  const swapRead=await previewBridge({...formalRead,projectId:'project-a',executionManifest:swapped},deps);
  assert.equal(swapRead.effective_review.can_use_as_pass,false,'cannot override frozen execution record at read');
  const manifestPath=join(deps.directory,'project-a',approved.operationId,'execution-manifest.json');
  await writeFile(manifestPath,JSON.stringify(swapped));
  assert.equal((await previewBridge({...formalRead,projectId:'project-a'},deps)).effective_review.can_use_as_pass,false,'changed stored manifest invalidates derived pass');
  await writeFile(manifestPath,JSON.stringify(manifest));
  assert.equal(await readFile(rawPath,'utf8'),rawBytes,'checks never modify the saved result');
  const legacy={...body(),input:cleanInput};
  await previewBridge(legacy,passDeps);
  const legacyRead={action:'read',projectId:'project-a',operationId:legacy.operationId};
  assert.equal((await previewBridge(legacyRead,deps)).effective_review.can_use_as_pass,false,'missing manifest blocks a raw pass');
  const diagnosed=await previewBridge({...legacyRead,videoSha256,executionManifest:manifest},deps);
  assert.equal(diagnosed.timeline_check?.status,'no_detected_conflict');
  assert.equal(diagnosed.effective_review.can_use_as_pass,false,'late manifest cannot grant old approval');
  assert(diagnosed.effective_review.blockers.includes('execution_manifest_not_frozen_at_request'));
  assert.equal((await previewBridge(legacyRead,deps)).effective_review.manifest_binding,'missing','read did not persist or rewrite binding');
  assert.equal(calls,countBeforeRead+1,'only the explicitly mocked legacy request ran; reads send none');
  const beforeInvalid=calls;
  await assert.rejects(previewBridge({...body(),input:cleanInput,executionManifest:{...manifest,total_frames:301}},passDeps));
  assert.equal(calls,beforeInvalid,'invalid manifest is rejected before any paid invocation');
  // Whole-film teaching units use actual output ranges, independently of mechanical candidates.
  const filmManifest={fps:30,total_frames:300,scenes:[{start_frame:0,end_frame:300,kind:'video',content:0}]};
  const filmInput={...cleanInput,units:[{unit_id:'U02',point_ids:['P'],output_range_seconds:[0,10]}]};
  const filmJudgment=structuredClone(judgment);filmJudgment.continuity[0].unit_id='U02';
  for(const r of [...filmJudgment.continuity[0].previous,...filmJudgment.continuity[0].current,...filmJudgment.continuity[0].narrative.evidence,...filmJudgment.continuity[0].teaching.evidence])r.observed='连续动态视频';
  const filmDeps={...deps,run:async(args:string[])=>{calls++;
    const clean=JSON.parse(await readFile(args[args.indexOf('--input')+1],'utf8'));
    assert.deepEqual(clean,filmInput,'actual unit ranges survive neutral input projection');
    await writeFile(args[args.indexOf('--out')+1],JSON.stringify({video_sha256:videoSha256,input_sha256:createHash('sha256').update(JSON.stringify(clean)).digest('hex'),raw_public_judgment:JSON.stringify(filmJudgment),judgment:filmJudgment,status:'pass',full_film_accepted:false}));}};
  const film={...body(),input:filmInput,executionManifest:filmManifest};
  const filmResult=await previewBridge(film,filmDeps);
  assert.equal(filmResult.effective_review.can_use_as_pass,true,'no mechanical candidate does not prevent genuine teaching review');
  assert.equal((await previewBridge({action:'read',projectId:'project-a',operationId:film.operationId},filmDeps)).effective_review.can_use_as_pass,true);
  const beforeBadFilm=calls;
  for(const range of [[0,11],[5,4],[0],[0,null]])await assert.rejects(previewBridge({...film,operationId:randomUUID(),input:{...filmInput,units:[{...filmInput.units[0],output_range_seconds:range}]}},filmDeps));
  await assert.rejects(previewBridge({...film,operationId:randomUUID(),input:{...filmInput,units:[{unit_id:'U02',point_ids:['P']}]}},filmDeps),'unmapped teaching units remain refused');
  assert.equal(calls,beforeBadFilm,'invalid ranges rejected before invocation');
  // The browser must not accept a legacy server response that omits the new evidence gate.
  const localFetch=globalThis.fetch;
  globalThis.fetch=(async()=>new Response(JSON.stringify({operationId:approved.operationId,projectId:'project-a',status:'completed',
    full_film_accepted:false,scope:'rendered_preview_continuous_review',result:makeResult(judgment)}),{status:200})) as typeof fetch;
  assert.equal(((await execClipMentorAnalysisTool('review_clipmentor_preview',formalRead,ctx)) as any).can_use_as_pass,false);
  globalThis.fetch=(async()=>new Response(JSON.stringify({...goodRead,effective_review:{...goodRead.effective_review,
    status:'review_required',can_use_as_pass:true}}),{status:200})) as typeof fetch;
  assert.equal(((await execClipMentorAnalysisTool('review_clipmentor_preview',formalRead,ctx)) as any).can_use_as_pass,false,'inconsistent gate cannot be promoted by browser');
  globalThis.fetch=localFetch;
  // A legitimate long review must expose headers and JSON whitespace while
  // the ONE original operation is still pending, rather than losing its result
  // to the local client's shorter silent-header timeout.
  const originalRun=deps.run;let release!:()=>void,started!:()=>void;
  const held=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{started=r;});
  deps.run=async args=>{started();await held;await originalRun(args);};
  const beforeWaiting=calls;
  try{
   const waiting=fetch(`${origin}/api/clipmentor/review-preview`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body()),signal:AbortSignal.timeout(1000)});
   await entered;
   const response=await waiting;assert.equal(response.status,200);
   const reader=response.body!.getReader(),first=await reader.read();
   assert.equal(new TextDecoder().decode(first.value).trim(),'','pending response carries no fabricated verdict');
   assert.equal(calls,beforeWaiting,'headers arrive before the held original operation finishes');
   release();let text=new TextDecoder().decode(first.value);
   for(;;){const part=await reader.read();if(part.done)break;text+=new TextDecoder().decode(part.value);}
   assert.equal(JSON.parse(text).status,'completed');assert.equal(calls,beforeWaiting+1,'keepalive does not submit another operation');
  }finally{release();deps.run=originalRun;}
  const unauth=await originalFetch(`${origin}/api/clipmentor/review-preview`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body())});
  assert.equal(unauth.status,401);
  assert.equal(await readFile(video,'utf8'),bytes.toString(),'review does not modify media');
  console.log('clipmentor-preview-review.verify: real local route/tool dispatch, receipt read, exact binding, one-call/failure budget, auth, policy/gate and no edits passed');
} finally {globalThis.fetch=originalFetch;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(directory,{recursive:true,force:true});}
