import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AgentContext } from '../../src/agent/context';
import type { ProjectDoc } from '../../src/editor/types';
import { executeTool } from '../../src/agent/tools';
import { copyReviewSubject } from '../../src/clipmentor/production-gate';
import type { ViteDevServer } from 'vite';
import type { SourceVideoRequest } from '../../shared/clipmentor-source-video';
import { sourceVideoInput, buildSourceVideoRequest, validateSourceObservation, inspectSourceObservation, observeSourceVideo, recoverSourceVideoReceipt, readSourceVideoReceipt, type SourceVideoDependencies } from './source-video';
import { clipMentorSourceVideoPlugin } from '../plugins/clipmentor-source-video';
import { policyForTool } from '../../src/agent/execution-policy';
import { isExternalDraftTool } from '../../src/agent/external-tool-policy';
import regression from '../../src/clipmentor/fixtures/copy-teaching-blind-v2-20261019.json';
const video=Buffer.from('synthetic-video-with-audio'), digest=createHash('sha256').update(video).digest('hex');
const packet=structuredClone(regression.blind_input.cases[0].packet) as SourceVideoRequest['packet'];
packet.units=[packet.units[0]];
packet.units[0].picture_plan={original_source_ranges:[[0,2]],explanation_source_ranges:[[2,4]],line_source_ranges:packet.units[0].lines.map(l=>({line_id:l.line_id,source_range_seconds:[2,4]})),registered_revisits:[],
  execution_plan:{plan_id:'plan',script_candidate_id:'copy',content:{composition:'CURRENT_PLAN',self_review:'DO_NOT_SEND_AUTHOR_VERDICT'}}};
packet.source_evidence[0].observation='DO_NOT_SEND_HISTORICAL_ANSWER';
const request:SourceVideoRequest={operationId:randomUUID(),maxRequests:1,projectId:'project',authorRunId:'author',source:{src:'/media/uploads/test.mp4',hash:digest,fps:30,duration:5},subject:{revision:145,digest:'a'.repeat(64),units:[{unit_id:packet.units[0].unit_id,candidate_id:'copy'}]},packet};
const input=sourceVideoInput(request);
const good=()=>({windows:input.units.flatMap(u=>u.windows.map(w=>({window_id:w.window_id,observed_sequence:'Continuous candidate action',endpoint:'Action incomplete at endpoint',evidence:[{start_seconds:w.source_range_seconds[0],end_seconds:w.source_range_seconds[1],visible:'Action in motion',audible:'Unclear; unknown'}]}))),
  lines:input.units.flatMap(u=>u.lines.map(l=>({unit_id:u.unit_id,line_id:l.line_id,status:'insufficient_evidence',reason:'Source cannot establish edited narration sync',window_ids:[u.windows[1].window_id]}))),limitations:['No assembled handoff observed']});
const root=await mkdtemp(join(tmpdir(),'clipmentor-source-video-test-'));let calls=0;
const key='test-only-sensitive-sentinel';
const deps:SourceVideoDependencies={directory:root,key,resolve:()=>'/synthetic',hash:async()=>digest,audioPresent:async()=>true,size:async()=>video.length,read:async()=>video,
 post:async(body,credential,_signal,operation)=>{calls++;assert.equal(credential,key);assert.equal(operation,request.operationId);const b=JSON.parse(body);assert.deepEqual(Buffer.from(b.contents[0].parts[0].inlineData.data,'base64'),video);assert.equal(b.contents[0].parts[0].videoMetadata.fps,5);return {status:200,body:{modelVersion:'mock-returned-model',candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(good())}]}}]}}}};
try {
 const prepared=buildSourceVideoRequest(video,request);
 assert.ok(!prepared.body.includes('DO_NOT_SEND_HISTORICAL_ANSWER'));assert.ok(!prepared.body.includes('DO_NOT_SEND_AUTHOR_VERDICT'));assert.ok(prepared.body.includes('CURRENT_PLAN'));
 const result=await observeSourceVideo(request,deps);assert.equal(calls,1);assert.equal(result.returned_model,'mock-returned-model');assert.equal(result.actual_handoff_verified,false);assert.equal(result.complete_film_accepted,false);assert.equal(result.raw_observation.lines[0].status,'insufficient_evidence');
 assert.equal((await observeSourceVideo(request,deps)).cached,true);assert.equal(calls,1);
 await assert.rejects(observeSourceVideo({...request,subject:{...request.subject,revision:146}},deps));assert.equal(calls,1);
 const bad=good();bad.windows[0].evidence[0].end_seconds=99;assert.throws(()=>validateSourceObservation(bad,input));
 // 10ms is solely a bound for estimated observation timestamps; no timestamp is modified.
 for(const delta of [0.002875,0.01]) {
  const rounded=good();rounded.windows[1].evidence[0].end_seconds=4+delta;
  assert.equal(validateSourceObservation(rounded,input),rounded);
  const v=inspectSourceObservation(rounded,input);assert.equal(v.status,'valid');assert.equal(v.issues[0].severity,'notice');
  assert.ok(Math.abs(v.issues[0].delta_ms!-delta*1000)<1e-8);assert.equal(rounded.windows[1].evidence[0].end_seconds,4+delta);
 }
 const tooFar=good();tooFar.windows[1].evidence[0].end_seconds=4.010001;
 assert.throws(()=>validateSourceObservation(tooFar,input));assert.equal(inspectSourceObservation(tooFar,input).issues[0].code,'evidence_outside_window');
 for(const mutate of [
  (x:any)=>{x.windows[0].evidence[0].start_seconds=-0.001;},
  (x:any)=>{x.windows[1].evidence[0].start_seconds=4.001;x.windows[1].evidence[0].end_seconds=4.002;},
  (x:any)=>{x.windows[1].evidence[0].end_seconds=x.windows[1].evidence[0].start_seconds;},
  (x:any)=>{x.windows[0].window_id='unknown';},
  (x:any)=>{x.windows[0]=null;},
  (x:any)=>{x.lines[0].window_ids=['unknown'];},
  (x:any)=>{x.lines[0].line_id='unknown';},
  (x:any)=>{x.windows[0].evidence[0].start_seconds=NaN;},
 ]) {const invalid=good();mutate(invalid);assert.equal(inspectSourceObservation(invalid,input).status,'invalid');}
 for (const scalar of ['supported', 'not_supported', 'insufficient_evidence']) {
  const valid=good();valid.lines[0].status=scalar;
  assert.equal(inspectSourceObservation(valid,input).status,'valid');
  for (const value of [[scalar],[[scalar]],null,{},true,0]) {
   const invalid=good();Object.assign(invalid.lines[0],{status:value});
   assert.equal(inspectSourceObservation(invalid,input).status,'invalid','line status must be a scalar enum');
  }
 }

 const negative=good();negative.lines[0].status='not_supported';assert.equal(inspectSourceObservation(negative,input).status,'valid','valid structure does not upgrade a negative semantic result');
 // Offline recovery uses the frozen request and unchanged original response, not another post().
 const legacy={...request,operationId:randomUUID()},originalBody=buildSourceVideoRequest(video,legacy);
 const fingerprint=createHash('sha256').update('source-continuous-observation-v1'+JSON.stringify(legacy)).digest('hex');
 const archive={status:'reserved',requests_attempted:1,fingerprint,subject:legacy.subject,source_hash:digest,input:originalBody.input,request_sha256:createHash('sha256').update(originalBody.body).digest('hex')};
 const rounded=good();rounded.windows[1].evidence[0].end_seconds=4.002875;
 const originalLedger=JSON.stringify({fingerprint,status:'failed',requests_attempted:1,subject:legacy.subject,phase:'validate_response',http_status:200,
  raw_response:{modelVersion:'mock',candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(rounded)}]}}]}});
 await writeFile(join(root,`${legacy.operationId}.json`),originalLedger);
 const beforeOfflineCalls=calls;
 const recovered=await recoverSourceVideoReceipt(legacy,archive,{...deps,key:'',post:async()=>{throw new Error('Must not request in recovery');}});
 assert.equal(recovered.status,'failed');assert.equal(recovered.revalidation?.parent_status,'failed');assert.equal(recovered.validation?.status,'valid');
 assert.equal(recovered.result?.raw_observation.windows[1].evidence[0].end_seconds,4.002875);assert.equal(recovered.requestsSent,0);assert.equal(recovered.actual_handoff_verified,false);
 assert.equal(await readFile(join(root,`${legacy.operationId}.json`),'utf8'),originalLedger);assert.equal(calls,beforeOfflineCalls);
 assert.equal((await readSourceVideoReceipt(legacy.operationId,'project',{directory:root})).result?.validation.status,'valid');
 await assert.rejects(readSourceVideoReceipt(legacy.operationId,'another-project',{directory:root}));
 await assert.rejects(readSourceVideoReceipt('../escape','project',{directory:root}));
 await assert.rejects(recoverSourceVideoReceipt(legacy,{...archive,request_sha256:'b'.repeat(64)},deps));

 assert.throws(()=>validateSourceObservation({...good(),windows:[]},input));
 assert.throws(()=>buildSourceVideoRequest(Buffer.alloc(75_000_000),request));
 let callsBefore=calls;await assert.rejects(observeSourceVideo({...request,operationId:randomUUID()},{...deps,audioPresent:async()=>false}));assert.equal(calls,callsBefore);
 for(const failure of ['throw','http','truncated','echo','schema'] as const){
  const r={...request,operationId:randomUUID()};let attempts=0;
  const broken={...deps,post:async()=>{attempts++;
   if(failure==='throw')throw new Error(key);
   if(failure==='http')return {status:400,body:{error:key}};
   return {status:200,body:{modelVersion:'mock',candidates:[{finishReason:failure==='truncated'?'MAX_TOKENS':'STOP',content:{parts:[{text:failure==='echo'?key:JSON.stringify({})}]}}]}};
  }};
  await assert.rejects(observeSourceVideo(r,broken),e=>!String(e).includes(key));
  const saved=await readFile(join(root,`${r.operationId}.json`),'utf8');assert.ok(!saved.includes(key));assert.equal(JSON.parse(saved).requests_attempted,1);
  await assert.rejects(observeSourceVideo(r,broken));assert.equal(attempts,1);
 }
 // Real endpoint wrapper, with mock upstream: same-origin guard and one-result cache.
 let routePosts=0;
 const routeDeps={...deps,post:async(...args:Parameters<SourceVideoDependencies['post']>)=>{
   if(args[3]===request.operationId)return deps.post(...args);
   routePosts++;const invalid=good();invalid.windows[1].evidence[0].end_seconds=4.1;
   return {status:200,body:{modelVersion:'mock',candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(invalid)}]}}]}};
 }};
 let handler:any;clipMentorSourceVideoPlugin(routeDeps).configureServer!.call({} as never,{middlewares:{use:(_path:string,h:any)=>{handler=h;}}} as ViteDevServer);
 const server=createServer((req,res)=>handler(req,res));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try {const port=(server.address() as {port:number}).port;const url=`http://127.0.0.1:${port}/api/clipmentor/observe-video`;
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Origin:`http://127.0.0.1:${port}`,'Sec-Fetch-Site':'same-origin'},body:JSON.stringify(request)});
  assert.equal(response.status,200);assert.equal((await response.json()).cached,true);assert.equal(calls,1);
  const savedResponse=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Origin:`http://127.0.0.1:${port}`,'Sec-Fetch-Site':'same-origin'},body:JSON.stringify({action:'read_receipt',operationId:legacy.operationId,projectId:'project'})});
  assert.equal(savedResponse.status,200);const saved=await savedResponse.json();assert.equal(saved.requestsSent,0);assert.equal(saved.validation.status,'valid');assert.equal(saved.status,'failed');assert.equal(calls,1);
  const denied=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Origin:`http://127.0.0.1:${port}`,'Sec-Fetch-Site':'same-origin'},body:JSON.stringify({action:'read_receipt',operationId:legacy.operationId,projectId:'other'})});assert.equal(denied.status,400);
  const failedOp=randomUUID(),headers={'Content-Type':'application/json',Origin:`http://127.0.0.1:${port}`,'Sec-Fetch-Site':'same-origin'};
  const invalidResponse=await fetch(url,{method:'POST',headers,body:JSON.stringify({...request,operationId:failedOp})});assert.equal(invalidResponse.status,422);
  const invalidReceipt=(await invalidResponse.json()).receipt;assert.equal(invalidReceipt.upstream_http_status,200);assert.equal(invalidReceipt.phase,'validate_response');
  assert.equal(invalidReceipt.validation.status,'invalid');assert.ok(Math.abs(invalidReceipt.validation.issues[0].delta_ms-100)<1e-7);assert.equal(invalidReceipt.requestsAttempted,1);assert.equal(invalidReceipt.requestsSent,1);
  const failureRead=await fetch(url,{method:'POST',headers,body:JSON.stringify({action:'read_receipt',operationId:failedOp,projectId:'project'})});assert.equal(failureRead.status,200);
  const fullFailure=await failureRead.json();assert.equal(fullFailure.validation.status,'invalid');assert.equal(fullFailure.raw_observation.windows[1].evidence[0].end_seconds,4.1);assert.equal(fullFailure.requestsSent,0);assert.equal(routePosts,1);
  const retry=await fetch(url,{method:'POST',headers,body:JSON.stringify({...request,operationId:failedOp})});assert.equal(retry.status,400);assert.equal(routePosts,1);


 } finally {await new Promise<void>(r=>server.close(()=>r()));}
 // Actual editor tool dispatch, using a retained receipt only: current/stale binding and immutable project.
 const doc={version:3,activeTimelineId:'tl',mediaFolders:[],timelines:[],assets:[{id:'source',kind:'video',name:'synthetic',src:request.source.src,sourceContentHash:digest}],
  clipMentorAnalysis:{schema_version:1,analysis_id:'test',revision:145,source:{asset_id:'source',sourceContentHash:digest,duration_seconds:5,fps:30},
   product:{name:'test'},import_origin:'synthetic',evidence:[],points:[],transcripts:[],reviews:[],audit:[],
   blueprint:[{unit_id:packet.units[0].unit_id,point_ids:packet.units[0].lines[0].point_ids,intent_zh:'test',line_guidance:'',internal_review:{current_script_candidate:'copy',
    copy:{lines:packet.units[0].lines.map(l=>({id:l.line_id,point_ids:l.point_ids,narration_ms:l.narration_ms,caption_lines:l.caption_lines,zh:l.meaning_zh,source_seconds:[2,4],labels:l.labels}))}}}]}} as unknown as ProjectDoc;
 const subject=await copyReviewSubject(doc),beforeDoc=JSON.stringify(doc);let activeDoc=doc,reads=0;
 const readCtx={getDoc:()=>activeDoc,getProjectId:()=> 'project',getCreativeMode:()=> 'clipmentor',commands:{applyDoc:()=>{throw new Error('Read must not mutate');}},templates:[],audio:[]} as unknown as AgentContext;
 const savedFetch=globalThis.fetch;
 try {
  globalThis.fetch=(async(_url,init)=>{reads++;assert.equal(JSON.parse(String(init?.body)).action,'read_receipt');
   return Response.json({...recovered,subject:{...recovered.subject,revision:subject.revision,digest:subject.digest}});
  }) as typeof fetch;
  const read=await executeTool('read_clipmentor_source_video',{operationId:legacy.operationId},readCtx) as any;
  assert.equal(read.ok,true);assert.equal(read.current_binding,'current');assert.equal(read.requestsSent,0);assert.equal(read.receipt.status,'failed');
  activeDoc={...doc,clipMentorAnalysis:{...doc.clipMentorAnalysis!,revision:146}};
  assert.equal((await executeTool('read_clipmentor_source_video',{operationId:legacy.operationId},readCtx) as any).current_binding,'stale');
  activeDoc={...doc,assets:doc.assets.map(a=>({...a,sourceContentHash:'b'.repeat(64)}))};
  assert.equal((await executeTool('read_clipmentor_source_video',{operationId:legacy.operationId},readCtx) as any).current_binding,'stale');
  assert.equal(JSON.stringify(doc),beforeDoc);assert.equal(reads,3);assert.equal(calls,beforeOfflineCalls);
 } finally {globalThis.fetch=savedFetch;}
 assert.equal(policyForTool('observe_clipmentor_source_video').effect,'irreversible_external');assert.equal(policyForTool('observe_clipmentor_source_video').recovery,'outcome_unknown');assert.equal(isExternalDraftTool('observe_clipmentor_source_video'),true);
 assert.equal(policyForTool('read_clipmentor_source_video').effect,'read');
 console.log('source video: timestamp tolerance/negative bounds, immutable offline recovery, project-bound readback, full bytes/audio preflight, current input, bounded size, typed windows, once-only ledger, failures, secret redaction, route and no approval passed');
} finally {await rm(root,{recursive:true,force:true});}
