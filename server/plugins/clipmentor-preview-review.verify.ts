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
import {reviewBoardArtifactRoot} from '../clipmentor/blueprint-review-board-artifacts';
import {collectSavedPreviewVisualEvidence} from '../clipmentor/preview-visual-evidence';

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
  const comparisonProject='comparison-'+randomUUID(),comparisonRun={...visualRun,operationId:randomUUID(),projectId:comparisonProject};
  let extractions=0;
  const comparisonDeps={...visualDeps,visualEvidenceIO:{hash:async(file:string)=>createHash('sha256').update(await readFile(file)).digest('hex'),
    frame:async()=>{extractions++;return (await readFile(ref)).toString('base64');}}};
  try{
    const original=await previewBridge(comparisonRun,comparisonDeps);
    assert.equal((original.visual_comparison as any).status,'deferred','model result returns without waiting for local collection');
    assert.equal(extractions,0,'paid request cannot add another ninety seconds of local work');
    const requestPath=join(deps.directory,comparisonProject,comparisonRun.operationId),rawBefore=await readFile(join(requestPath,'result.json'),'utf8');
    const lightweight=await previewBridge({action:'read',projectId:comparisonProject,operationId:comparisonRun.operationId},comparisonDeps);
    assert.equal(lightweight.requestsSent,0);assert.equal(extractions,0,'ten-second result recovery must never start frame extraction');
    const comparisonRead={action:'read',projectId:comparisonProject,operationId:comparisonRun.operationId,includeVisualEvidence:true};
    const collected=await previewBridge(comparisonRead,comparisonDeps);
    assert.equal((collected.visual_comparison as any).status,'collected');assert.equal(extractions,3);
    let clientCalls=0;
    const localContext={...ctx,getProjectId:()=>comparisonProject,hostFetch:async(_url:unknown,init?:RequestInit)=>{clientCalls++;return Response.json(await previewBridge(JSON.parse(String(init?.body)),comparisonDeps));}} as AgentContext;
    const throughClient=await execClipMentorAnalysisTool('review_clipmentor_preview',{action:'read',operationId:comparisonRun.operationId,includeVisualEvidence:true},localContext) as any;
    assert.equal(throughClient.visual_comparison.status,'collected');assert.equal(throughClient.requestsSent,0,'same read flag survives the actual Agent client and server whitelist');
    const invalidClient=await execClipMentorAnalysisTool('review_clipmentor_preview',{action:'request',operationId:comparisonRun.operationId,maxRequests:1,src:comparisonRun.src,videoSha256,input:comparisonRun.input,executionManifest:comparisonRun.executionManifest,includeVisualEvidence:true},localContext) as any;
    assert(invalidClient.error,'local collection flag cannot be used to extend a paid request');
    assert.equal(clientCalls,1,'invalid paid flag is rejected before dispatch');
    await assert.rejects(previewBridge({...comparisonRead,includeVisualEvidence:'yes'},comparisonDeps),/Invalid receipt read/);
    const reread=await previewBridge(comparisonRead,comparisonDeps);
    assert.equal((reread.visual_comparison as any).cached,true);assert.equal(extractions,3);
    assert.deepEqual(reread.result,original.result);assert.equal(reread.requestsSent,0);
    const manifestPath=join(requestPath,'execution-manifest.json'),originalManifest=await readFile(manifestPath,'utf8');
    const tamperedManifest=JSON.parse(originalManifest);tamperedManifest.scenes[0].content=1;
    await writeFile(manifestPath,JSON.stringify(tamperedManifest));
    const downgraded=await collectSavedPreviewVisualEvidence(original,args=>previewBridge({...args,projectId:comparisonProject},comparisonDeps));
    assert.equal((downgraded.effective_review as any).can_use_as_pass,false,'actual read invalidation cannot be hidden behind original pass');
    assert.deepEqual(downgraded.result,original.result,'original model judgment survives a derived gate downgrade');
    assert((downgraded.effective_review as any).blockers.includes('saved_evidence_invalid_or_binding_mismatch'));
    await writeFile(manifestPath,originalManifest);
    await writeFile(video,'changed video');
    const changed=await previewBridge(comparisonRead,comparisonDeps);
    assert.equal((changed.visual_comparison as any).status,'not_collected','stale export cannot inherit cached screenshots');
    assert.equal(changed.effective_review.can_use_as_pass,false,'known changed bytes cannot keep a current derived pass');
    const changedFast=await previewBridge({action:'read',projectId:comparisonProject,operationId:comparisonRun.operationId},comparisonDeps);
    assert.equal(changedFast.effective_review.can_use_as_pass,false,'lightweight recovery also preserves media identity checks without image work');
    assert.deepEqual(changed.result,original.result,'local extraction never rewrites original review');
    await writeFile(video,bytes);
    assert.equal(await readFile(join(requestPath,'result.json'),'utf8'),rawBefore);
    const bindingPath=join(requestPath,'binding.json'),bindingBefore=await readFile(bindingPath,'utf8'),oldBinding=JSON.parse(bindingBefore);
    delete oldBinding.src;await writeFile(bindingPath,JSON.stringify(oldBinding));
    const legacyComparison=await previewBridge(comparisonRead,comparisonDeps);
    assert.equal((legacyComparison.visual_comparison as any).code,'binding_missing');assert.equal(legacyComparison.requestsSent,0);
    assert.deepEqual(legacyComparison.result,original.result,'legacy missing locator does not rewrite historical review');
    await writeFile(bindingPath,bindingBefore);
    const cancelledProject='comparison-cancel-'+randomUUID(),cancel=new AbortController();let cancelledExtractions=0,sawAbort=false;
    try{
      const cancelledRun={...comparisonRun,projectId:cancelledProject,operationId:randomUUID()};
      await previewBridge(cancelledRun,comparisonDeps);
      const cancelled=await previewBridge({action:'read',projectId:cancelledProject,operationId:cancelledRun.operationId,includeVisualEvidence:true},
        {...comparisonDeps,visualEvidenceIO:{...comparisonDeps.visualEvidenceIO,frame:async(_p:string,_s:number,_out:string,signal?:AbortSignal)=>{
          cancelledExtractions++;cancel.abort();sawAbort=signal!.aborted;return(await readFile(ref)).toString('base64');
        }}},cancel.signal);
      assert.equal((cancelled.visual_comparison as any).code,'cancelled');assert.equal(cancelledExtractions,1);assert(sawAbort);
      assert.equal(cancelled.result.status,'pass','cancelled local evidence cannot rewrite the model original');
    }finally{await rm(reviewBoardArtifactRoot(cancelledProject),{recursive:true,force:true});}
  }finally{await writeFile(video,bytes);await rm(reviewBoardArtifactRoot(comparisonProject),{recursive:true,force:true});}

  const nativeDeps={...visualDeps,visualCriteria:async()=>({digest:criteriaDigest,entries:[{src:'/media/uploads/reference.jpg',sha:refHash,
   criterion:{id:'intro',quote,question:'实际原片标识是否沿用认可版式？',sectionId:'U',pictureStage:'原片',layout:'native_composition' as const,reference:{assetId:'ref',fileName:'reference.jpg',seconds:0}}}]})};
  const nativeRun={...visualRun,operationId:randomUUID(),input:{...visualInput,points:input.points,units:[{unit_id:'U',point_ids:['P'],output_range_seconds:[0,2]}]}};
  assert.equal((await previewBridge(nativeRun,nativeDeps)).effective_review.can_use_as_pass,true,'teaching-unit requirement reaches the actual preview window');
  const allDeps={...nativeDeps,visualCriteria:async()=>({...await nativeDeps.visualCriteria(),timelineId:'tl',entries:[{...(await nativeDeps.visualCriteria())!.entries[0],criterion:{...(await nativeDeps.visualCriteria())!.entries[0].criterion,sectionId:'tl'}}]}),run:async(args:string[])=>{
   const clean=JSON.parse(await readFile(args[args.indexOf('--input')+1],'utf8'));
   assert.equal(clean.visual_criteria[0].quote,quote);assert.equal(clean.visual_criteria[0].pictureStage,'原片');
   assert.equal(clean.units.filter((u:any)=>u.unit_id.startsWith('delivery/criterion/intro/')).length,5,'all five native groups require a separate answer with one shared reference');
   const ev=(u:any)=>evidence(u.output_range_seconds[0]+.1,u.output_range_seconds[0]+1,'实际对象');
   const judgment={coverage:clean.points.map((p:any)=>{const receipts=clean.units.filter((u:any)=>u.point_ids.includes(p.point_id)).map(ev);return {point_id:p.point_id,depiction:receipts,teaching:finding(receipts)};}),continuity:clean.units.map((u:any)=>({unit_id:u.unit_id,point_ids:u.point_ids,previous:[evidence(Math.max(0,u.output_range_seconds[0]-.1),u.output_range_seconds[0]+.05,'前接')],current:[ev(u)],relation:'continuation',narrative:finding([ev(u)]),teaching:finding([ev(u)])}))};
   await writeFile(args[args.indexOf('--out')+1],JSON.stringify({...makeResult(judgment),input_sha256:createHash('sha256').update(JSON.stringify(clean)).digest('hex')}));
  }};
  const allRun={...nativeRun,operationId:randomUUID(),executionManifest:{fps:30,total_frames:300,scenes:[{start_frame:0,end_frame:300,kind:'original',content:0}],timeline_id:'tl'},input:{...nativeRun.input,units:[...Array.from({length:5},(_,i)=>({unit_id:'U'+i,point_ids:['P'],output_range_seconds:[i*2,i*2+2]})),{unit_id:'delivery/ending',point_ids:['P'],output_range_seconds:[0,2]}]}};
  const allResult=await previewBridge(allRun,allDeps);assert.equal(allResult.effective_review.can_use_as_pass,true,JSON.stringify(allResult.effective_review));
  const genericEvidence={...allDeps,run:async(args:string[])=>{await allDeps.run(args);const file=args[args.indexOf('--out')+1],r=JSON.parse(await readFile(file,'utf8'));const broad=evidence(0,10,'全片都有');r.judgment.coverage.find((c:any)=>c.point_id==='delivery/criterion/intro').teaching.evidence=[broad];for(const c of r.judgment.continuity.filter((c:any)=>c.unit_id.startsWith('delivery/criterion/intro/'))){c.current=[broad];c.teaching.evidence=[broad];}r.raw_public_judgment=JSON.stringify(r.judgment);await writeFile(file,JSON.stringify(r));}};
  assert.equal((await previewBridge({...allRun,operationId:randomUUID()},genericEvidence)).effective_review.can_use_as_pass,false,'one whole-film observation cannot stand in for each actual group');
  const missingGroup={...allDeps,run:async(args:string[])=>{await allDeps.run(args);const file=args[args.indexOf('--out')+1],r=JSON.parse(await readFile(file,'utf8'));r.judgment.continuity=r.judgment.continuity.filter((c:any)=>c.unit_id!=='delivery/criterion/intro/4');r.raw_public_judgment=JSON.stringify(r.judgment);await writeFile(file,JSON.stringify(r));}};
  assert.equal((await previewBridge({...allRun,operationId:randomUUID()},missingGroup)).effective_review.can_use_as_pass,false,'four groups cannot certify the fifth');
  await assert.rejects(previewBridge({...allRun,operationId:randomUUID(),executionManifest:{...manifest,timeline_id:'wrong'}},allDeps),/timeline missing/);
  const omittedNative={...nativeDeps,run:async(args:string[])=>{await visualDeps.run(args);const path=args[args.indexOf('--out')+1],r=JSON.parse(await readFile(path,'utf8'));
   r.judgment.coverage=r.judgment.coverage.filter((c:any)=>c.point_id!=='delivery/criterion/intro');r.raw_public_judgment=JSON.stringify(r.judgment);await writeFile(path,JSON.stringify(r));}};
  assert.equal((await previewBridge({...nativeRun,operationId:randomUUID()},omittedNative)).effective_review.can_use_as_pass,false,'a source/plan pass cannot cover a missing actual-screen answer');

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

  // A full native composition manifest can exceed the former 256 KiB wire cap.
  // Whitespace preserves the exact valid request semantics while testing the HTTP envelope.
  const beforeLarge=calls;
  const large=await fetch(`${origin}/api/clipmentor/review-preview`,{method:'POST',headers:{'Content-Type':'application/json'},body:' '.repeat(270_000)+JSON.stringify(body())});
  assert.equal(large.status,200,'valid >256 KiB JSON reaches the same single operation');
  assert.equal((await large.json() as any).effective_review.can_use_as_pass,false,'transport acceptance never supplies approval');assert.equal(calls,beforeLarge+1);
  const oversized=await fetch(`${origin}/api/clipmentor/review-preview`,{method:'POST',headers:{'Content-Type':'application/json'},body:' '.repeat(2*1024*1024)+JSON.stringify(body())});
  assert.equal(oversized.status,413);const limitReply=await oversized.json() as any;assert.equal(limitReply.requestsAttempted,0);assert.equal(calls,beforeLarge+1,'oversized requests never enter the provider');
  const {requestPreviewReview}=await import('../../src/clipmentor/request-preview-review');
  const rawRound='{"coverage":[],"continuity":[]}';
  const roundReceipt={operationId:randomUUID(),projectId:'project-a',full_film_accepted:false,scope:'rendered_preview_continuous_review',status:'completed',
    result:{status:'review_required',issues:['invalid_coverage_row'],raw_public_judgment:rawRound},timeline_check:{status:'no_detected_conflict'},
    effective_review:{status:'pass',can_use_as_pass:true,blockers:[],full_film_accepted:false,manifest_binding:'frozen_at_request',contract_revalidation:{method:'observation-centisecond-eof-v1',original_status:'review_required',original_issues:['invalid_coverage_row'],raw_judgment_sha256:createHash('sha256').update(rawRound).digest('hex')}}};
  const roundCtx={...ctx,hostFetch:async()=>Response.json(roundReceipt)} as AgentContext;
  assert.equal((await requestPreviewReview({action:'read',operationId:roundReceipt.operationId},roundCtx) as any).ok,true,'canonical server rounding revalidation preserves raw status and is accepted');
  roundReceipt.effective_review.contract_revalidation.method='film-origin-continuity-v1';
  assert.equal((await requestPreviewReview({action:'read',operationId:roundReceipt.operationId},roundCtx) as any).ok,true,'canonical first-segment revalidation is accepted without rewriting raw result');
  roundReceipt.effective_review.contract_revalidation.raw_judgment_sha256='0'.repeat(64);
  assert((await requestPreviewReview({action:'read',operationId:roundReceipt.operationId},roundCtx) as any).error,'raw-bound revalidation cannot be a bare pass flag');
  const unauth=await originalFetch(`${origin}/api/clipmentor/review-preview`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body())});
  assert.equal(unauth.status,401);
  assert.equal(await readFile(video,'utf8'),bytes.toString(),'review does not modify media');
  console.log('clipmentor-preview-review.verify: real local route/tool dispatch, lightweight paid/recovery result, separate zero-call evidence read, exact binding, one-call/failure budget, auth, policy/gate and no edits passed');
} finally {globalThis.fetch=originalFetch;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(directory,{recursive:true,force:true});}
