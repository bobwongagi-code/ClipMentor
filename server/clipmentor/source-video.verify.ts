import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir, rename, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { waitForToolResult, claimToolRequest, settleToolResult } from '../agent-runs/store-tools';
import type { ServerRun } from '../agent-runs/store-types';
import { structuredToolFailure } from '../../src/agent/toolFailure';
import { postSourceVideoTransport, SourceVideoTransportError, safeSourceTransportDiagnostic } from './source-video-transport';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer,request as nodeRequest } from 'node:http';
import type { AgentContext } from '../../src/agent/context';
import type { ProjectDoc } from '../../src/editor/types';
import { executeTool } from '../../src/agent/tools';
import { copyReviewSubject } from '../../src/clipmentor/production-gate';
import {requestSourceVideo} from '../../src/clipmentor/request-source-video';
import type { ViteDevServer } from 'vite';
import type { SourceVideoRequest, SourceVideoTask, SourceVideoTransportDiagnostic } from '../../shared/clipmentor-source-video';
import { observationTaskWithBoundaryContext } from '../../shared/clipmentor-source-video';
import { sourceVideoInput, buildSourceVideoRequest, validateSourceObservation, inspectSourceObservation, inspectSourceVideoObservation, observeSourceVideo, recoverSourceVideoReceipt, readSourceVideoReceipt, type SourceVideoDependencies } from './source-video';
import { clipMentorSourceVideoPlugin } from '../plugins/clipmentor-source-video';
import { policyForTool } from '../../src/agent/execution-policy';
import { isExternalDraftTool } from '../../src/agent/external-tool-policy';
import regression from '../../src/clipmentor/fixtures/copy-teaching-blind-v2-20261019.json';
import savedProjects from '../../src/clipmentor/fixtures/production-saved-projects-20261028.json';
import savedTransportBoundaries from '../../src/clipmentor/fixtures/video-transport-boundaries-20261108.json';
const video=Buffer.from('synthetic-video-with-audio'), digest=createHash('sha256').update(video).digest('hex');
const packet=structuredClone(regression.blind_input.cases[0].packet) as SourceVideoRequest['packet'];
packet.units=[packet.units[0]];
packet.units[0].picture_plan={original_source_ranges:[[0,2]],explanation_source_ranges:[[2,4]],line_source_ranges:packet.units[0].lines.map(l=>({line_id:l.line_id,source_range_seconds:[2,4]})),registered_revisits:[],
  execution_plan:{plan_id:'plan',script_candidate_id:'copy',content:{composition:'CURRENT_PLAN',self_review:'DO_NOT_SEND_AUTHOR_VERDICT'}}};
packet.source_evidence[0].observation='DO_NOT_SEND_HISTORICAL_ANSWER';
const request:SourceVideoRequest={operationId:randomUUID(),maxRequests:1,projectId:'project',authorRunId:'author',source:{src:'/media/uploads/test.mp4',hash:digest,fps:30,duration:5},subject:{revision:145,digest:'a'.repeat(64),units:[{unit_id:packet.units[0].unit_id,candidate_id:'copy'}]},packet};
const observationTask:SourceVideoTask={version:'source-boundaries-v1',contexts:[{context_id:'context',unit_id:packet.units[0].unit_id,source_range_seconds:[1,4.8],boundary_seconds:[1.5,3],goals:['speech_boundaries','material_continuity']}]};
// The saved failure had the cut at the end of one context and start of the next.
const edgeTask:SourceVideoTask={version:'source-boundaries-v1',contexts:[
 {context_id:'left',unit_id:packet.units[0].unit_id,source_range_seconds:[0,2],boundary_seconds:[0,2],goals:['speech_boundaries']},
 {context_id:'right',unit_id:packet.units[0].unit_id,source_range_seconds:[2,5],boundary_seconds:[2,5],goals:['speech_boundaries']},
]};
const padded=observationTaskWithBoundaryContext(edgeTask,5);
assert.deepEqual(padded.contexts.map(c=>c.source_range_seconds),[[0,4],[0,5]]);
assert.deepEqual(padded.contexts.map(c=>c.boundary_seconds),[[0,2],[2,5]]);
assert.deepEqual(edgeTask.contexts.map(c=>c.source_range_seconds),[[0,2],[2,5]]);
assert.deepEqual(observationTaskWithBoundaryContext(padded,5),padded);
assert.deepEqual(observationTaskWithBoundaryContext(observationTask,5),observationTask);
const taskRequest={...request,operationId:randomUUID(),observationTask};
const taskInput=sourceVideoInput(taskRequest);
assert.deepEqual(taskInput.observation_task,observationTask,'neutral observation context must survive without modifying production windows');
const input=sourceVideoInput(request);
assert.deepEqual(taskInput.units,input.units,'observation context never extends production windows');
for(const mutate of [
 (t:any)=>{t.contexts[0].unit_id='unknown';},
 (t:any)=>{t.contexts[0].source_range_seconds=[-1,4.8];},
 (t:any)=>{t.contexts[0].source_range_seconds=[1,6];},
 (t:any)=>{t.contexts[0].boundary_seconds=[0];},
 (t:any)=>{t.contexts[0].boundary_seconds=[1.5,1.5];},
 (t:any)=>{t.contexts[0].goals=[];},
 (t:any)=>{t.contexts[0].goals=[['speech_boundaries']];},
 (t:any)=>{t.contexts[0].expected_verdict='pass';},
 (t:any)=>{t.contexts.push(t.contexts[0]);},
]) {const t=structuredClone(observationTask);mutate(t);assert.throws(()=>sourceVideoInput({...request,observationTask:t}));}
const good=()=>({windows:input.units.flatMap(u=>u.windows.map(w=>({window_id:w.window_id,observed_sequence:'Continuous candidate action',endpoint:'Action incomplete at endpoint',evidence:[{start_seconds:w.source_range_seconds[0],end_seconds:w.source_range_seconds[1],visible:'Action in motion',audible:'Unclear; unknown'}]}))),
  lines:input.units.flatMap(u=>u.lines.map(l=>({unit_id:u.unit_id,line_id:l.line_id,status:'insufficient_evidence',reason:'Source cannot establish edited narration sync',window_ids:[u.windows[1].window_id]}))),limitations:['No assembled handoff observed']});
const root=await mkdtemp(join(tmpdir(),'clipmentor-source-video-test-'));let calls=0;
const key='test-only-sensitive-sentinel';
const deps:SourceVideoDependencies={directory:root,key,resolve:()=>'/synthetic',hash:async()=>digest,audioPresent:async()=>true,size:async()=>video.length,read:async()=>video,
 post:async(body,credential,_signal,operation)=>{calls++;assert.equal(credential,key);assert.equal(operation,request.operationId);const b=JSON.parse(body);assert.deepEqual(Buffer.from(b.contents[0].parts[0].inlineData.data,'base64'),video);assert.equal(b.contents[0].parts[0].videoMetadata.fps,5);return {status:200,body:{modelVersion:'mock-returned-model',candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(good())}]}}]}}}};
try {
 // A second storage failure must not erase already captured transport facts.
 const persistDirectory=join(root,'blocked-persist'),persistBackup=persistDirectory+'.reserved';await mkdir(persistDirectory);
 const persistRequest={...request,operationId:randomUUID()};let persistPosts=0,persistFailure:any;
 const persistDiagnostic:SourceVideoTransportDiagnostic={version:'source-transport-v1',operation_id:persistRequest.operationId,
  started_at:'2026-01-01T00:00:00.000Z',ended_at:'2026-01-01T00:00:01.000Z',request_bytes:100,curl_exit_code:0,error_kind:'none',http_status:504,
  metrics:{size_upload:100},first_byte_may_be_interim:true,request_ids:{'x-request-id':'persistence-fixture'},response_body:{format:'html',bytes:0,inspected_bytes:0,truncated:false,message_class:'timeout'}};
 try {
  const persistDeps={...deps,directory:persistDirectory,post:async()=>{persistPosts++;await rename(persistDirectory,persistBackup);await writeFile(persistDirectory,'simulate unavailable directory');return {status:504,body:null,diagnostic:persistDiagnostic};}};
  try{await observeSourceVideo(persistRequest,persistDeps);}catch(e){persistFailure=e;}
  assert.equal(persistFailure?.receipt?.transport_diagnostic?.http_status,504,'failed receipt write must not erase captured transport facts');
  assert.equal(persistFailure.receipt.receipt_persisted,false,'do not claim a failed receipt was persisted');
  const unsettled=structuredToolFailure({error:'Source observation failed; read the saved receipt, do not retry',receipt:persistFailure.receipt}) as any;
  assert.equal(unsettled.receipt_persisted,false);assert.equal(unsettled.source_error_code,'source_receipt_persist_failed');assert.equal(unsettled.source_phase,'gateway_request');assert.equal(unsettled.requestsSent,1);

 } finally {await rm(persistDirectory,{force:true});await rename(persistBackup,persistDirectory);}
 assert.equal(persistPosts,1);assert.equal((await readSourceVideoReceipt(persistRequest.operationId,'project',{directory:persistDirectory})).status,'reserved','original reservation survives; no fabricated durable failure');
 const saveDirectory=join(root,'blocked-success-save'),saveBackup=saveDirectory+'.reserved';await mkdir(saveDirectory);
 const saveRequest={...request,operationId:randomUUID()};let saveFailure:any,savePosts=0;
 try {
  try{await observeSourceVideo(saveRequest,{...deps,directory:saveDirectory,post:async()=>{savePosts++;await rename(saveDirectory,saveBackup);await writeFile(saveDirectory,'storage unavailable');return {status:200,body:{modelVersion:'mock',candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(good())}]}}]},diagnostic:{...persistDiagnostic,operation_id:saveRequest.operationId,http_status:200}};}});}catch(e){saveFailure=e;}
  assert.equal(saveFailure.receipt.phase,'save_result','successful model response followed by disk failure is not a model validation failure');
  assert.equal(saveFailure.receipt.receipt_persisted,false);assert.equal(saveFailure.receipt.error,'source_receipt_persist_failed');assert.equal(saveFailure.receipt.transport_diagnostic.http_status,200);
  const saveEnvelope=structuredToolFailure({error:'Source observation failed; read the saved receipt, do not retry',receipt:saveFailure.receipt}) as any;
  assert.equal(saveEnvelope.source_phase,'save_result');assert.equal(saveEnvelope.source_error_code,'source_receipt_persist_failed');assert.equal(saveEnvelope.receipt_persisted,false);
 } finally {await rm(saveDirectory,{force:true});await rename(saveBackup,saveDirectory);}
 assert.equal(savePosts,1);
 const taskBody=JSON.parse(buildSourceVideoRequest(video,taskRequest).body);
 assert(taskBody.contents[0].parts[1].text.includes('task_observation'));
 assert(taskBody.contents[0].parts[1].text.includes('source-boundaries-v1'));
 const taskGood=()=>({...good(),task_observation:{
  boundaries:observationTask.contexts[0].boundary_seconds.map(t=>({context_id:'context',boundary_seconds:t,status:'uncertain',
   before:{status:'unclear',quote:null},after:{status:'unclear',quote:null},start_seconds:t-0.2,end_seconds:t+0.2,reason:'Unintelligible fixture, no sentence claim',time_uncertainty:'unknown'})),
  contexts:[{context_id:'context',sequence:[{start_seconds:4,end_seconds:4.8,visible:'fixture outside production but inside observation',audible:'unclear'}],
   material_ranges:[{start_seconds:4,end_seconds:4.8,role:'uncertain',basis:'fixture only',limitations:['No valid material established']}],limitations:['Unknown source meaning']}],
 }});
 assert.equal(inspectSourceVideoObservation(taskGood(),taskInput).status,'valid','unknown speech is a valid result, never approval');
 const aliasRequest={...taskRequest,operationId:randomUUID()};
 const {task_observation,...mainObservation}=taskGood();
 const alias={...mainObservation,observation_task:task_observation};
 const aliasBody={candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(alias)}]}}]};
 const aliasResult=await observeSourceVideo(aliasRequest,{...deps,post:async()=>({status:200,body:aliasBody})});
 assert.deepEqual(aliasResult.raw_observation,taskGood());
 const frozenAlias={...aliasRequest,operationId:randomUUID()};
 const frozen=buildSourceVideoRequest(video,frozenAlias);
 const failedAlias={status:'failed',requests_attempted:1,projectId:frozenAlias.projectId,subject:frozenAlias.subject,
  source_hash:digest,phase:'validate_response',http_status:200,input:frozen.input,raw_response:aliasBody,
  fingerprint:createHash('sha256').update('source-continuous-observation-v1'+JSON.stringify(frozenAlias)).digest('hex'),
  request_sha256:createHash('sha256').update(frozen.body).digest('hex'),
  validation:{status:'invalid',issues:[{code:'missing_task_observation',severity:'error'}]}};
 const frozenPath=join(root,`${frozenAlias.operationId}.json`);
 await writeFile(frozenPath,JSON.stringify(failedAlias));
 const offline={...deps,post:async()=>{throw new Error('Must never resend an alias response');}};
 await assert.rejects(recoverSourceVideoReceipt({...frozenAlias,projectId:'foreign'},undefined,offline));
 const aliasRecovered=await recoverSourceVideoReceipt(frozenAlias,undefined,offline);
 assert.equal(aliasRecovered.requestsSent,0);
 assert.equal(aliasRecovered.status,'failed');
 assert.deepEqual(aliasRecovered.result?.raw_observation,taskGood());
 assert.equal(await readFile(frozenPath,'utf8'),JSON.stringify(failedAlias));
 assert.equal((await readSourceVideoReceipt(frozenAlias.operationId,'project',offline)).validation?.status,'valid');
 await assert.rejects(observeSourceVideo({...taskRequest,operationId:randomUUID()},{...deps,post:async()=>({
  status:200,body:{candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({...alias,task_observation:null})}]}}]},
 })}));
 const heard=taskGood();Object.assign(heard.task_observation.boundaries[0],{status:'inside_speech',before:{status:'heard',quote:'fixture quote'}});
 assert.equal(inspectSourceVideoObservation(heard,taskInput).status,'valid');
 for(const mutate of [
  (v:any)=>{delete v.task_observation;},
  (v:any)=>{v.task_observation.boundaries.pop();},
  (v:any)=>{v.task_observation.boundaries[0].context_id='unknown';},
  (v:any)=>{v.task_observation.boundaries[0].boundary_seconds=2;},
  (v:any)=>{v.task_observation.boundaries[0].status='sentence_boundary';},
  (v:any)=>{v.task_observation.boundaries[0].status=['uncertain'];},
  (v:any)=>{v.task_observation.boundaries[0].before={status:'heard',quote:null};},
  (v:any)=>{v.task_observation.boundaries[0].start_seconds=0;},
  (v:any)=>{v.task_observation.contexts[0].sequence[0].end_seconds=5;},
  (v:any)=>{v.task_observation.contexts.push(v.task_observation.contexts[0]);},
  (v:any)=>{v.windows[0].evidence[0].end_seconds=4.8;},
 ]) {const v=taskGood();mutate(v);assert.equal(inspectSourceVideoObservation(v,taskInput).status,'invalid');}
 let taskPosts=0;
 const taskDeps={...deps,post:async()=>{taskPosts++;return {status:200,body:{modelVersion:'mock',candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(taskGood())}]}}]}};}};
 const taskResult=await observeSourceVideo(taskRequest,taskDeps);assert.equal(taskPosts,1);
 assert.deepEqual(taskResult.observation_task,observationTask);assert.deepEqual(taskResult.raw_observation,taskGood());
 const taskRead=await readSourceVideoReceipt(taskRequest.operationId,'project',{directory:root});assert.equal(taskRead.requestsSent,0);
 assert.deepEqual(taskRead.observation_task,observationTask);assert.deepEqual(taskRead.result?.raw_observation,taskGood());
 assert.equal((await observeSourceVideo(taskRequest,taskDeps)).cached,true);assert.equal(taskPosts,1);
 const changedTask=structuredClone(observationTask);changedTask.contexts[0].boundary_seconds=[2];
 await assert.rejects(observeSourceVideo({...taskRequest,observationTask:changedTask},taskDeps));assert.equal(taskPosts,1);
 const missingTask={...taskRequest,operationId:randomUUID()};let missingPosts=0;
 const missingDeps={...deps,post:async()=>{missingPosts++;return {status:200,body:{candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(good())}]}}]}};}};
 await assert.rejects(observeSourceVideo(missingTask,missingDeps));assert.equal(missingPosts,1);
 const missingRead=await readSourceVideoReceipt(missingTask.operationId,'project',{directory:root});assert.equal(missingRead.status,'failed');
 assert(missingRead.validation?.issues.some(x=>x.code==='missing_task_observation'));assert.deepEqual(missingRead.observation_task,observationTask);
 assert.deepEqual(missingRead.raw_observation,good());await assert.rejects(observeSourceVideo(missingTask,missingDeps));assert.equal(missingPosts,1);
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
 // Hermetic process tests exercise the real curl adapter. The injected launcher NEVER starts curl/network.
 const cli=join(root,'transport-fixture.cjs');
 await writeFile(cli,String.raw`const fs=require('node:fs'),assert=require('node:assert/strict');
const config=JSON.parse(process.env.SOURCE_TRANSPORT_FIXTURE);const args=process.argv.slice(2);
const arg=n=>args[args.indexOf(n)+1];assert.equal(arg('--retry'),'0');assert.equal(arg('--max-time'),'595');assert.equal(arg('--connect-timeout'),'30');
assert.equal(arg('--proto'),'=https');assert.equal(arg('--max-redirs'),'0');assert.equal(arg('--noproxy'),'*');
assert.equal(args.at(-1),'https://rootifyaiapi.rootifyglobal.com/v1beta/models/gemini-3.8-flash:generateContent');
let auth='';process.stdin.on('data',b=>auth+=b);process.stdin.on('end',()=>{
assert.equal(auth,'Authorization: Bearer '+config.key+'\n');assert(!args.some(x=>x.includes(config.key)));
if(config.mode==='abort'){setTimeout(()=>{},10000);return;}
const body=fs.readFileSync(arg('--data-binary').slice(1));const metrics={http_code:config.status,size_upload:config.partial?body.length/2:body.length,size_download:100,time_namelookup:0.001,time_connect:0.01,time_appconnect:0.02,time_pretransfer:0.021,time_starttransfer:0.03,time_total:190.8};
fs.writeFileSync(arg('--dump-header'),'HTTP/1.1 100 Continue\r\nx-request-id: interim-only\r\n\r\nHTTP/1.1 '+config.status+' Result\r\nx-oneapi-request-id: final-gateway-id\r\nx-request-id: '+config.key+'\r\nSet-Cookie: cookie-sensitive\r\nLocation: https://private.invalid/key=hidden\r\n\r\n');
if(config.response!==undefined)fs.writeFileSync(arg('--output'),config.response);
process.stdout.write(config.malformed?'not metrics':JSON.stringify(metrics).replace('\"http_code\":0','\"http_code\":000'));process.exit(config.exit||0);
});`);
 let launched=0;
 const launcher=(config:Record<string,unknown>)=>((command:any,args:any,options:any)=>{
  assert.equal(command,'curl');launched++;assert.equal(options.stdio[2],'ignore');
  return spawn(process.execPath,[cli,...args],{...options,env:{...process.env,SOURCE_TRANSPORT_FIXTURE:JSON.stringify({...config,key})}});
 }) as typeof spawn;
 const upstreamHtml='<html>504 Gateway Timeout '+key+' https://private.invalid/token=hidden /private/secret.txt</html>';
 const original=buildSourceVideoRequest(video,request).body;
 const failedTransport=await postSourceVideoTransport(original,key,new AbortController().signal,randomUUID(),root,launcher({status:504,response:upstreamHtml}));
 assert.equal(failedTransport.status,504);assert.equal(failedTransport.body,null);
 assert.equal(failedTransport.diagnostic.response_body.message_class,'timeout');assert.equal(failedTransport.diagnostic.upload_matches_request_bytes,true);
 assert.deepEqual(failedTransport.diagnostic.request_ids,{'x-oneapi-request-id':'final-gateway-id'});
 assert.equal(failedTransport.diagnostic.metrics.time_starttransfer,0.03);assert.equal(failedTransport.diagnostic.first_byte_may_be_interim,true);
 for(const bad of [key,'cookie-sensitive','private.invalid','/private/secret.txt','interim-only'])assert(!JSON.stringify(failedTransport.diagnostic).includes(bad));
 const okTransport=await postSourceVideoTransport(original,key,new AbortController().signal,randomUUID(),root,launcher({status:200,response:JSON.stringify({candidates:[]})}));
 assert.deepEqual(okTransport.body,{candidates:[]});assert.equal(okTransport.diagnostic.http_status,200);
 for(const partial of [true,false]) {
  const op=randomUUID();let caught:any;
  try{await postSourceVideoTransport(original,key,new AbortController().signal,op,root,launcher({status:0,exit:28,partial}));}catch(e){caught=e;}
  assert(caught instanceof SourceVideoTransportError);assert.equal(caught.diagnostic.error_kind,'curl_timeout');assert.equal(caught.diagnostic.curl_exit_code,28);
  assert.equal(caught.diagnostic.http_status,null);assert.equal(caught.diagnostic.upload_matches_request_bytes,!partial);
 }
 let abortError:any;try{await postSourceVideoTransport(original,key,AbortSignal.timeout(100),randomUUID(),root,launcher({mode:'abort'}));}catch(e){abortError=e;}
 assert(abortError instanceof SourceVideoTransportError);assert.equal(abortError.diagnostic.error_kind,'aborted');
 assert.equal(abortError.diagnostic.http_status,null);
 const countBeforeAbort=launched;await assert.rejects(postSourceVideoTransport(original,key,AbortSignal.abort(),randomUUID(),root,launcher({status:200})));assert.equal(launched,countBeforeAbort);
 let spawnError:any;try{await postSourceVideoTransport(original,key,new AbortController().signal,randomUUID(),root,(()=>{throw new Error(key);}) as unknown as typeof spawn);}catch(e){spawnError=e;}
 assert(spawnError instanceof SourceVideoTransportError);assert.equal(spawnError.diagnostic.error_kind,'spawn_failed');assert(!String(spawnError).includes(key));
 const big=await postSourceVideoTransport(original,key,new AbortController().signal,randomUUID(),root,launcher({status:504,response:'timeout '+key+'x'.repeat(20000)}));
 assert.equal(big.diagnostic.response_body.truncated,true);assert.equal(big.diagnostic.response_body.inspected_bytes,16384);assert(!JSON.stringify(big.diagnostic).includes(key));
 let malformedError:any;try{await postSourceVideoTransport(original,key,new AbortController().signal,randomUUID(),root,launcher({status:200,malformed:true}));}catch(e){malformedError=e;}
 assert(malformedError instanceof SourceVideoTransportError);assert.equal(malformedError.diagnostic.error_kind,'invalid_metrics');
 let oversizedError:any;try{await postSourceVideoTransport(original,key,new AbortController().signal,randomUUID(),root,launcher({status:200,exit:63,response:'x'.repeat(20000)}));}catch(e){oversizedError=e;}
 assert(oversizedError instanceof SourceVideoTransportError);assert.equal(oversizedError.diagnostic.curl_exit_code,63);assert.equal(oversizedError.diagnostic.error_kind,'curl_failed');
 let cleanupCalls=0,cleanupResult:any,cleanupError:any;
 try {cleanupResult=await postSourceVideoTransport(original,key,new AbortController().signal,randomUUID(),root,
  launcher({status:200,response:JSON.stringify({candidates:[]})}),async()=>{cleanupCalls++;throw new Error('synthetic cleanup failure');});}catch(e){cleanupError=e;}
 assert.equal(cleanupCalls,1,'cleanup failure seam was actually reached');
 try {assert.equal(cleanupError,undefined,'temporary cleanup failure must not replace a valid remote result');assert.equal(cleanupResult.status,200);assert.equal(cleanupResult.diagnostic.cleanup_status,'failed');}
 finally {for(const name of await readdir(root))if(name.startsWith('source-video-'))await rm(join(root,name),{recursive:true,force:true});}
 const warningBefore=await readdir(root);
 const cleanup504=await postSourceVideoTransport(original,key,new AbortController().signal,randomUUID(),root,launcher({status:504,response:upstreamHtml}),async()=>{throw new Error('cleanup');});
 assert.equal(cleanup504.status,504);assert.equal(cleanup504.diagnostic.cleanup_status,'failed');assert.equal(cleanup504.diagnostic.response_body.message_class,'timeout');
 for(const name of await readdir(root))if(name.startsWith('source-video-')&&!warningBefore.includes(name))await rm(join(root,name),{recursive:true,force:true});
 const structured200Error=await postSourceVideoTransport(original,key,new AbortController().signal,randomUUID(),root,launcher({status:200,response:JSON.stringify({error:{code:504,type:'upstream_error',message:'upstream timed out'}})}));
 assert.equal(structured200Error.diagnostic.response_body.message_class,'timeout','a genuine error object is not exempt merely because HTTP says 200');
 const harmless=await postSourceVideoTransport(original,key,new AbortController().signal,randomUUID(),root,launcher({status:200,response:JSON.stringify({candidates:[{content:{parts:[{text:'The clip mentions timeout and authentication as visible words, not a transport failure.'}]}}]})}));
 assert.equal(harmless.diagnostic.response_body.message_class,'none','valid 200 model content must not be classified as a transport error');
 const normalTransportOp={...request,operationId:randomUUID()};
 const normalResult=await observeSourceVideo(normalTransportOp,{...deps,post:async(...args)=>postSourceVideoTransport(...args,root,launcher({status:200,response:JSON.stringify({modelVersion:'mock',candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(good())}]}}]})}))});
 assert.equal(normalResult.transport_diagnostic?.http_status,200);assert.equal(normalResult.actual_handoff_verified,false);
 const normalRead=await readSourceVideoReceipt(normalTransportOp.operationId,'project',{directory:root});assert.equal(normalRead.status,'completed');assert.equal(normalRead.transport_diagnostic?.http_status,200);
 // Diagnostics are duplicated in completed results and recovered receipts: all copies must be projected.
 const normalFile=join(root,normalTransportOp.operationId+'.json'),normalBefore=await readFile(normalFile,'utf8');
 const recoveredFile=join(root,legacy.operationId+'.revalidated.json'),recoveredBefore=await readFile(recoveredFile,'utf8');
 const leaked=[];
 try {
  const record=JSON.parse(normalBefore);record.result.transport_diagnostic={...record.transport_diagnostic,extra:'diagnostic-extra-must-not-leak',request_ids:{'x-request-id':'https://private.invalid/token=hidden'}};
  await writeFile(normalFile,JSON.stringify(record));
  const reread=await readSourceVideoReceipt(normalTransportOp.operationId,'project',{directory:root});
  if(JSON.stringify(reread.result?.transport_diagnostic).includes('diagnostic-extra-must-not-leak'))leaked.push('completed_nested_diagnostic');
  const cachedAgain=await observeSourceVideo(normalTransportOp,{...deps,post:async()=>assert.fail('cache read must not make another request')});assert.equal(cachedAgain.cached,true);
  if(JSON.stringify(cachedAgain.transport_diagnostic).includes('diagnostic-extra-must-not-leak'))leaked.push('completed_cache_diagnostic');

  const derived=JSON.parse(recoveredBefore);derived.transport_diagnostic={...record.result.transport_diagnostic,operation_id:legacy.operationId};derived.result.transport_diagnostic=derived.transport_diagnostic;
  await writeFile(recoveredFile,JSON.stringify(derived));
  const derivedRead=await readSourceVideoReceipt(legacy.operationId,'project',{directory:root});
  if(JSON.stringify(derivedRead.transport_diagnostic).includes('diagnostic-extra-must-not-leak')||JSON.stringify(derivedRead.result?.transport_diagnostic).includes('diagnostic-extra-must-not-leak'))leaked.push('revalidated_diagnostics');
 } finally {await writeFile(normalFile,normalBefore);await writeFile(recoveredFile,recoveredBefore);}
 assert.deepEqual(leaked,[],'all diagnostic read paths must retain only the closed safe fields');
 const timedOutOp={...request,operationId:randomUUID()};let timedOutFailure:any;
 try{await observeSourceVideo(timedOutOp,{...deps,post:async(...args)=>postSourceVideoTransport(...args,root,launcher({status:0,exit:28,partial:true}))});}catch(e){timedOutFailure=e;}
 assert.equal(timedOutFailure.receipt.requestsSent,'unknown');const timeoutEnvelope=structuredToolFailure({error:'Source observation failed; read the saved receipt, do not retry',receipt:timedOutFailure.receipt}) as any;assert.equal(timeoutEnvelope.requestsSent,'unknown');assert.equal(timedOutFailure.receipt.transport_diagnostic.error_kind,'curl_timeout');
 assert.equal((await readSourceVideoReceipt(timedOutOp.operationId,'project',{directory:root})).transport_diagnostic?.upload_matches_request_bytes,false);
 const jsonError=await postSourceVideoTransport(original,key,new AbortController().signal,randomUUID(),root,launcher({status:502,response:JSON.stringify({error:{code:504,type:'upstream_error',message:'timed out '+key}})}));
 assert.equal(jsonError.diagnostic.response_body.error_code,504);assert.equal(jsonError.diagnostic.response_body.error_type,'upstream_error');assert(!JSON.stringify(jsonError.diagnostic).includes(key));
 assert.equal(safeSourceTransportDiagnostic({...failedTransport.diagnostic,operation_id:'other'},key,request.operationId),undefined);
 // A raw dependency cannot smuggle arbitrary diagnostics through the persistence boundary.
 const projected=safeSourceTransportDiagnostic({...failedTransport.diagnostic,extra:key,request_ids:{Authorization:key,'x-request-id':'https://private.invalid'},response_body:{...failedTransport.diagnostic.response_body,message:key}},key,failedTransport.diagnostic.operation_id)!;
 assert.deepEqual(projected.request_ids,{});assert(!JSON.stringify(projected).includes(key));
 // Real 595s/400 records preserve uncertainty; a caller cannot inject a more specific root cause.
 for(const record of savedTransportBoundaries) {
  const before=JSON.stringify(record.diagnostic),d=record.diagnostic;
  const p=safeSourceTransportDiagnostic({...d,response_boundary:'upstream_rejected'},'',d.operation_id)!;
  assert.equal(p.response_boundary,record.expected_boundary);assert.equal(JSON.stringify(d),before);
 }
 const fullTimeout=savedTransportBoundaries[0].diagnostic;
 assert.equal(safeSourceTransportDiagnostic({...fullTimeout,metrics:{size_upload:1}},'',fullTimeout.operation_id)?.response_boundary,'body_not_fully_sent');
 assert.equal(safeSourceTransportDiagnostic({...fullTimeout,metrics:{}},'',fullTimeout.operation_id)?.response_boundary,'no_final_response_unattributed');
 assert.equal(safeSourceTransportDiagnostic({...fullTimeout,http_status:400,metrics:{size_upload:0}},'',fullTimeout.operation_id)?.response_boundary,'gateway_or_upstream_error_unattributed');
 assert.equal(okTransport.diagnostic.response_boundary,'response_received');
 const entries=await import('node:fs/promises');assert(!(await entries.readdir(root)).some(x=>x.startsWith('source-video-')),'private temporary request/response files must be cleaned');
 // Regression: a non-200 transport receipt must survive durable failure and same-op readback.
 const diagnosticOp={...request,operationId:randomUUID()};let diagnosticPosts=0;
 const diagnostic:SourceVideoTransportDiagnostic={version:'source-transport-v1',operation_id:diagnosticOp.operationId,started_at:'2026-10-24T05:56:57.654Z',ended_at:'2026-10-24T06:00:08.546Z',
  request_bytes:32830285,curl_exit_code:0,error_kind:'none',http_status:504,
  metrics:{size_upload:32830285,time_total:190.8},request_ids:{'x-oneapi-request-id':'saved-gateway-id'},
  first_byte_may_be_interim:true,response_body:{format:'html',bytes:100,inspected_bytes:100,truncated:false,message_class:'timeout'}};
 const diagnosticDeps={...deps,post:async()=>{diagnosticPosts++;return {status:504,body:null,diagnostic};}};
 let diagnosticFailure:any;try{await observeSourceVideo(diagnosticOp,diagnosticDeps);}catch(e){diagnosticFailure=e;}
 assert.equal(diagnosticFailure.receipt.transport_diagnostic?.http_status,504,'HTTP failure must retain transport diagnosis');
 const sourceEnvelope=structuredToolFailure({error:'Source observation failed; read the saved receipt, do not retry',receipt:diagnosticFailure.receipt});
 assert.equal((sourceEnvelope as any)?.source_diagnostic?.http_status,504,'Agent failure settlement must not erase safe source transport diagnostic');
 const diagnosticRead=await readSourceVideoReceipt(diagnosticOp.operationId,'project',{directory:root});
 assert.equal((diagnosticRead as any).transport_diagnostic?.request_ids['x-oneapi-request-id'],'saved-gateway-id');
 assert.equal(structuredToolFailure({...sourceEnvelope,ok:true}),undefined,'successful tools cannot acquire failure metadata');
 assert.equal(structuredToolFailure({...sourceEnvelope,operationId:randomUUID()}),undefined,'cross-operation failure metadata is rejected');
 assert.deepEqual(structuredToolFailure(sourceEnvelope),sourceEnvelope,'repeated runtime settlement preserves the safe envelope');
 // The real shared failed-settlement function must reject (not resolve) while retaining safe metadata in events and reload.
 const settlementEvents:unknown[]=[];const settlementRun={toolRequests:new Map()} as unknown as ServerRun;
 const settlementDeps={isRunTerminal:()=>false,mirrorTool:async()=>undefined,pushRunEvent:(_run:ServerRun,_type:string,data:unknown)=>{settlementEvents.push(data);}};
 const pendingFailure=waitForToolResult(settlementDeps,settlementRun,'source-call','observe_clipmentor_source_video','args',2000).then(()=>assert.fail('failure became success'),e=>e);
 assert.equal(claimToolRequest(settlementDeps,settlementRun,{toolCallId:'source-call',argsDigest:'args',claimId:'claim'}),'claimed');
 assert.equal(settleToolResult(settlementDeps,settlementRun,{toolCallId:'source-call',argsDigest:'args',claimId:'claim',result:{error:'Source observation failed; read the saved receipt, do not retry',receipt:diagnosticFailure.receipt}}),'accepted');
 const settledFailure=await pendingFailure;assert.deepEqual(structuredToolFailure(settledFailure),sourceEnvelope);
 assert.deepEqual(structuredToolFailure(JSON.parse(JSON.stringify(settlementEvents[0])).result),sourceEnvelope);

 assert.equal(diagnosticRead.status,'failed');assert.equal(diagnosticRead.requestsSent,0);assert.equal(diagnosticRead.actual_handoff_verified,false);
 await assert.rejects(observeSourceVideo(diagnosticOp,diagnosticDeps));assert.equal(diagnosticPosts,1);
 // Real endpoint wrapper, with mock upstream: same-origin guard and one-result cache.
 let routePosts=0;const gatewayRouteOp=randomUUID(),delayedRouteOp=randomUUID();
 const routeDeps={...deps,post:async(...args:Parameters<SourceVideoDependencies['post']>)=>{
   if(args[3]===request.operationId)return deps.post(...args);
   if(args[3]===delayedRouteOp){routePosts++;await new Promise(r=>setTimeout(r,700));
    return {status:200,body:{candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(good())}]}}]}};}
   if(args[3]===gatewayRouteOp){routePosts++;return postSourceVideoTransport(...args,root,launcher({status:504,response:upstreamHtml}));}
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
  const gatewayHeaders={'Content-Type':'application/json',Origin:`http://127.0.0.1:${port}`,'Sec-Fetch-Site':'same-origin'};
  const gatewayResponse=await fetch(url,{method:'POST',headers:gatewayHeaders,body:JSON.stringify({...request,operationId:gatewayRouteOp})});
  assert.equal(gatewayResponse.status,200);const gatewayFailure=await gatewayResponse.json();
  assert.equal(gatewayFailure.receipt.status,'failed','HTTP keepalive success must preserve the failed terminal operation');
  assert.equal(gatewayFailure.receipt.transport_diagnostic.http_status,504,'keepalive HTTP 200 must retain the remote HTTP 504 failure');
  assert.equal((structuredToolFailure({error:'Source observation failed; read the saved receipt, do not retry',receipt:gatewayFailure.receipt}) as any).source_diagnostic.request_ids['x-oneapi-request-id'],'final-gateway-id');
  const gatewayRead=await fetch(url,{method:'POST',headers:gatewayHeaders,body:JSON.stringify({action:'read_receipt',operationId:gatewayRouteOp,projectId:'project'})});
  assert.equal(gatewayRead.status,200);const gatewaySaved=await gatewayRead.json();
  assert.deepEqual(gatewaySaved.transport_diagnostic,gatewayFailure.receipt.transport_diagnostic);assert.equal(gatewaySaved.status,'failed');assert.equal(gatewaySaved.requestsSent,0);
  const fakePostsBefore=routePosts;assert.equal((await fetch(url,{method:'POST',headers:gatewayHeaders,body:JSON.stringify({...request,operationId:gatewayRouteOp})})).status,400);
  assert.equal(routePosts,fakePostsBefore,'a consumed failed operation must not reach the transport again');
  assert(!JSON.stringify(gatewaySaved).includes(key));
  const failedOp=randomUUID(),headers={'Content-Type':'application/json',Origin:`http://127.0.0.1:${port}`,'Sec-Fetch-Site':'same-origin'};
  const invalidResponse=await fetch(url,{method:'POST',headers,body:JSON.stringify({...request,operationId:failedOp})});assert.equal(invalidResponse.status,200);
  const invalidReceipt=(await invalidResponse.json()).receipt;assert.equal(invalidReceipt.upstream_http_status,200);assert.equal(invalidReceipt.phase,'validate_response');
  assert.equal(invalidReceipt.validation.status,'invalid');assert.ok(Math.abs(invalidReceipt.validation.issues[0].delta_ms-100)<1e-7);assert.equal(invalidReceipt.requestsAttempted,1);assert.equal(invalidReceipt.requestsSent,1);
  const failureRead=await fetch(url,{method:'POST',headers,body:JSON.stringify({action:'read_receipt',operationId:failedOp,projectId:'project'})});assert.equal(failureRead.status,200);
  const fullFailure=await failureRead.json();assert.equal(fullFailure.validation.status,'invalid');assert.equal(fullFailure.raw_observation.windows[1].evidence[0].end_seconds,4.1);assert.equal(fullFailure.requestsSent,0);assert.equal(routePosts,2);
  const retry=await fetch(url,{method:'POST',headers,body:JSON.stringify({...request,operationId:failedOp})});assert.equal(retry.status,400);assert.equal(routePosts,2);

  const beforeDelayed=routePosts;
  const delayed=await new Promise<{status:number;body:string}>((resolve,reject)=>{
   const req=nodeRequest(url,{method:'POST',headers:gatewayHeaders},res=>{
    clearTimeout(timer);let body='';res.setEncoding('utf8');res.on('data',chunk=>{body+=chunk;});
    res.on('end',()=>resolve({status:res.statusCode!,body}));res.on('error',reject);
   });
   const timer=setTimeout(()=>req.destroy(Error('local_headers_timeout')),200);
   req.on('error',error=>{clearTimeout(timer);reject(error);});req.end(JSON.stringify({...request,operationId:delayedRouteOp}));
  });
  assert.equal(delayed.status,200);assert.equal(JSON.parse(delayed.body).operationId,delayedRouteOp);
  assert.equal(JSON.parse(delayed.body).validation.status,'valid');assert.equal(routePosts,beforeDelayed+1,
   'a long original source request must outlive the local headers deadline without another upstream request');


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
 const requestDoc=structuredClone(savedProjects.cases[0].doc) as unknown as ProjectDoc;
 requestDoc.clipMentorAnalysis!.source.sourceContentHash=digest;
 requestDoc.assets.find(a=>a.id===requestDoc.clipMentorAnalysis!.source.asset_id)!.sourceContentHash=digest;
 const requestCtx={...readCtx,getDoc:()=>requestDoc,getAgentRunId:()=> 'author',hostFetch:async(_url:unknown,init:any)=>{
  const sent=JSON.parse(init.body);
  return Response.json({error:'retained source failure',receipt:{...recovered,operationId:sent.operationId,
   subject:sent.subject,projectId:sent.projectId,status:'failed'}});
 }} as unknown as AgentContext;
 const keptFailure=await requestSourceVideo({operationId:randomUUID(),maxRequests:1,expectedRevision:requestDoc.clipMentorAnalysis!.revision},requestCtx) as any;
 assert.equal(keptFailure.local_http_status,200);assert.equal(keptFailure.receipt.status,'failed');
 assert(keptFailure.error);assert.equal(keptFailure.ok,undefined,'HTTP keepalive must not become source approval');
 try {
  globalThis.fetch=(async(_url,init)=>{reads++;assert.equal(JSON.parse(String(init?.body)).action,'read_receipt');
   return Response.json({...recovered,subject:{...recovered.subject,revision:subject.revision,digest:subject.digest}});
  }) as typeof fetch;
  const read=await executeTool('read_clipmentor_source_video',{operationId:legacy.operationId},readCtx) as any;
  assert.equal(read.ok,true);assert.equal(read.current_binding,'current');assert.equal(read.requestsSent,0);assert.equal(read.receipt.status,'failed');
  globalThis.fetch=(async(_url,init)=>{reads++;assert.equal(JSON.parse(String(init?.body)).action,'read_receipt');
   return Response.json(await readSourceVideoReceipt(gatewayRouteOp,'project',{directory:root}));
  }) as typeof fetch;
  const gatewayToolRead=await executeTool('read_clipmentor_source_video',{operationId:gatewayRouteOp},readCtx) as any;
  assert.equal(gatewayToolRead.ok,true);assert.equal(gatewayToolRead.receipt.transport_diagnostic.http_status,504);
  assert.equal(gatewayToolRead.receipt.transport_diagnostic.response_body.message_class,'timeout');
  assert.equal(gatewayToolRead.receipt.status,'failed');assert.equal(gatewayToolRead.requestsSent,0);
  globalThis.fetch=(async(_url,init)=>{reads++;assert.equal(JSON.parse(String(init?.body)).action,'read_receipt');
   return Response.json({...recovered,subject:{...recovered.subject,revision:subject.revision,digest:subject.digest}});
  }) as typeof fetch;
  activeDoc={...doc,clipMentorAnalysis:{...doc.clipMentorAnalysis!,revision:146}};
  assert.equal((await executeTool('read_clipmentor_source_video',{operationId:legacy.operationId},readCtx) as any).current_binding,'stale');
  activeDoc={...doc,assets:doc.assets.map(a=>({...a,sourceContentHash:'b'.repeat(64)}))};
  assert.equal((await executeTool('read_clipmentor_source_video',{operationId:legacy.operationId},readCtx) as any).current_binding,'stale');
  assert.equal(JSON.stringify(doc),beforeDoc);assert.equal(reads,4);assert.equal(calls,beforeOfflineCalls);
 } finally {globalThis.fetch=savedFetch;}
 assert.equal(policyForTool('observe_clipmentor_source_video').effect,'irreversible_external');assert.equal(policyForTool('observe_clipmentor_source_video').recovery,'outcome_unknown');assert.equal(isExternalDraftTool('observe_clipmentor_source_video'),true);
 assert.equal(policyForTool('read_clipmentor_source_video').effect,'read');
 console.log('source video: offline curl-process 200/504/timeout/abort/spawn/privacy, durable diagnostics through HTTP/Agent settlement/registered read, no retry; neutral context tasks, boundary/unknown evidence, adjacent ranges without production mutation, complete task readback, failures/no retry; legacy timestamp/recovery/route/isolation checks passed');
} finally {await rm(root,{recursive:true,force:true});}
