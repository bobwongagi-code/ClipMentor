import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { ffmpegBin } from '../media-binaries';
import { sha256File } from '../../shared/node-content-hash';
import { videoInput } from './video-input';
import { materialRange,prepareObservationMaterial,verifyCopiedPackets } from './observation-material';
import { observeSourceVideo,sourceVideoInput,sourceObservationRange,readSourceVideoReceipt,buildSourceVideoRequest,recoverSourceVideoReceipt,sourceObservationToSourceClock } from './source-video';
import type { SourceVideoRequest } from '../../shared/clipmentor-source-video';
import { isObservationMaterial } from '../../shared/clipmentor-source-video';
import fixture from '../../src/clipmentor/fixtures/copy-teaching-blind-v2-20261019.json';

const root=await mkdtemp(join(tmpdir(),'clipmentor-material-verify-')),file=join(root,'parent.mp4');
let checks=0;
try {
  await promisify(execFile)(ffmpegBin(),['-v','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=96x128:rate=30',
    '-f','lavfi','-i','sine=frequency=600:sample_rate=44100','-t','8','-c:v','libx264','-g','30','-bf','2','-pix_fmt','yuv420p','-c:a','aac',file]);
  const parentHash=await sha256File(file),signal=AbortSignal.timeout(60_000);
  const options={file,parentSha256:parentHash,duration:8,range:[2.2,4.2] as [number,number],directory:join(root,'cache'),signal};
  const selected=await prepareObservationMaterial(options);
  assert.equal(selected.binding.kind,'stream_copy_excerpt');assert.equal(selected.binding.parent_sha256,parentHash);
  assert.equal(selected.binding.submitted_sha256,await sha256File(selected.file));assert.equal(selected.binding.packet_payloads_verified,true);
  assert(selected.binding.actual_source_range_seconds[0]<=2.2&&selected.binding.actual_source_range_seconds[1]>=4.2);
  assert(selected.binding.submitted_bytes<selected.binding.parent_bytes);checks++;
  assert(isObservationMaterial(selected.binding));
  for(const change of [{packet_payloads_verified:'true'},{submitted_sha256:'missing'},{actual_source_range_seconds:[0,1]},
    {complete_film_accepted:true},{requested_range_seconds:null},{submitted_bytes:0},{author_verdict:'passed'}])assert.equal(isObservationMaterial({...selected.binding,...change}),false);checks++;
  assert.deepEqual(await prepareObservationMaterial(options),selected);checks++;
  const [a,b]=await Promise.all([prepareObservationMaterial({...options,directory:join(root,'concurrent')}),prepareObservationMaterial({...options,directory:join(root,'concurrent')})]);
  assert.deepEqual(a,b);checks++;
  const full=await prepareObservationMaterial({...options,range:null});assert.equal(full.file,file);assert.equal(full.binding.kind,'full_file');assert.equal(full.binding.submitted_sha256,parentHash);checks++;
  await assert.rejects(prepareObservationMaterial({...options,parentSha256:'f'.repeat(64)}),/changed/);checks++;
  for(const range of [[-1,2],[2,9],[4,2],[NaN,3]]) await assert.rejects(prepareObservationMaterial({...options,range:range as [number,number]}),/range/);checks++;
  const controller=new AbortController();controller.abort();await assert.rejects(prepareObservationMaterial({...options,signal:controller.signal}));checks++;
  const packet=structuredClone(fixture.blind_input.cases[0].packet) as SourceVideoRequest['packet'];packet.units=[packet.units[0]];
  packet.units[0].picture_plan={original_source_ranges:[[2.2,4.2]],explanation_source_ranges:[],line_source_ranges:[],registered_revisits:[],
    execution_plan:{plan_id:'p',script_candidate_id:'c',content:{composition:'neutral fixture'}}};
  const unit=packet.units[0];
  const request:SourceVideoRequest={operationId:randomUUID(),maxRequests:1,projectId:'p',authorRunId:'a',source:{src:'/media/uploads/parent.mp4',hash:parentHash,fps:30,duration:8},
    subject:{revision:1,digest:'a'.repeat(64),units:[{unit_id:unit.unit_id,candidate_id:'c'}]},packet,
    observationTask:{version:'source-boundaries-v1',contexts:[{context_id:'local',unit_id:unit.unit_id,source_range_seconds:[2.2,4.2],boundary_seconds:[],goals:['material_continuity']}]}};
  assert.deepEqual(sourceObservationRange(sourceVideoInput(request)),[2.2,4.2]);
  assert.equal(sourceObservationRange(sourceVideoInput({...request,observationTask:undefined})),null);checks++;
  let posts=0,lastResponse:any;
  const deps={directory:join(root,'receipts'),key:'fixture-only',resolve:()=>file,hash:sha256File,read:readFile,size:async()=>selected.binding.parent_bytes,
    audioPresent:async()=>true,prepareMedia:async(f:string)=>videoInput(await readFile(f)),
    prepareObservation:(f:string,parentSha256:string,duration:number,range:[number,number]|null,s:AbortSignal)=>prepareObservationMaterial({file:f,parentSha256,duration,range,directory:join(root,'entry-cache'),signal:s}),
    post:async(body:string)=>{posts++;const wire=JSON.parse(body),submitted=Buffer.from(wire.contents[0].parts[0].inlineData.data,'base64');
      assert.equal(submitted.length,selected.binding.submitted_bytes,'actual entry must send the excerpt, not just narrow its prompt');
      assert(wire.contents[0].parts[1].text.includes('本片段从0开始'));assert(!wire.contents[0].parts[1].text.includes('完整视频带同步原声'));
      return lastResponse={status:200,body:{candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({windows:[{window_id:unit.unit_id+':0',observed_sequence:'fixture',endpoint:'fixture',
        evidence:[{start_seconds:2.3-selected.binding.source_seconds_at_submitted_zero,end_seconds:4-selected.binding.source_seconds_at_submitted_zero,visible:'fixture',audible:'unclear'}]}],lines:unit.lines.map(l=>({unit_id:unit.unit_id,line_id:l.line_id,status:'insufficient_evidence',reason:'fixture',window_ids:[unit.unit_id+':0']})),limitations:['fixture'],
        task_observation:{boundaries:[],contexts:[{context_id:'local',sequence:[],material_ranges:[],limitations:['unknown fixture']}]}})}]}}]}};}};
  const result=await observeSourceVideo(request,deps);assert.equal(posts,1);assert.equal(result.input_media.full_original_video,false);
  assert.deepEqual(result.observation_material,selected.binding);assert.equal(result.complete_film_accepted,false);checks++;
  assert.equal(result.raw_observation.windows[0].evidence[0].start_seconds,2.3);
  const originalModel=JSON.parse(lastResponse.body.candidates[0].content.parts[0].text);
  assert.notEqual(originalModel.windows[0].evidence[0].start_seconds,2.3,'raw model times are local, not silently overwritten');
  const mapped:any=sourceObservationToSourceClock({start_seconds:0,end_seconds:100,quote:'at 0 seconds',status:'insufficient_evidence'},selected.binding);
  assert.equal(mapped.start_seconds,selected.binding.source_seconds_at_submitted_zero);assert.equal(mapped.end_seconds,100+selected.binding.source_seconds_at_submitted_zero);
  assert.equal(mapped.quote,'at 0 seconds');assert.equal(mapped.status,'insufficient_evidence');checks++;
  const back=await readSourceVideoReceipt(request.operationId,'p',deps);assert.deepEqual(back.observation_material,selected.binding);assert.equal(back.result?.complete_film_accepted,false);
  assert.equal((await observeSourceVideo(request,deps)).cached,true);assert.equal(posts,1);checks++;
  const boundaryRequest=structuredClone(request);boundaryRequest.operationId=randomUUID();
  boundaryRequest.observationTask!.contexts[0].goals=['speech_boundaries','material_continuity'];
  boundaryRequest.observationTask!.contexts[0].boundary_seconds=[3];
  const boundaryModel=structuredClone(originalModel),offset=selected.binding.source_seconds_at_submitted_zero;
  boundaryModel.task_observation.boundaries=[{context_id:'local',boundary_seconds:3-offset,status:'uncertain',
    before:{status:'unclear',quote:null},after:{status:'unclear',quote:null},start_seconds:2.8-offset,end_seconds:3.2-offset,reason:'unknown fixture',time_uncertainty:'unknown fixture'}];
  const boundaryResponse=(model:unknown)=>({status:200,body:{candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(model)}]}}]}});
  const boundaryResult=await observeSourceVideo(boundaryRequest,{...deps,post:async(body:string)=>{
    const wire=JSON.parse(body),line=wire.contents[0].parts[1].text.split('\n').find((s:string)=>s.startsWith('{"duration_seconds"'));
    const actualInput=JSON.parse(line);assert.deepEqual(actualInput.units[0].windows[0].source_range_seconds,[2.2-offset,4.2-offset]);
    assert.equal(actualInput.observation_task.contexts[0].boundary_seconds[0],3-offset);
    return boundaryResponse(boundaryModel);}});
  assert.equal(boundaryResult.raw_observation.task_observation?.boundaries[0].boundary_seconds,3);
  const boundaryBack=await readSourceVideoReceipt(boundaryRequest.operationId,'p',deps);
  assert.equal(boundaryBack.result?.raw_observation.task_observation?.boundaries[0].boundary_seconds,3);checks++;
  const outside=structuredClone(boundaryModel);outside.windows[0].evidence[0].end_seconds=100;
  await assert.rejects(observeSourceVideo({...boundaryRequest,operationId:randomUUID()},{...deps,post:async()=>boundaryResponse(outside)}),
    (error:any)=>error.receipt?.requestsAttempted===1&&error.receipt?.validation?.status==='invalid');checks++;
  assert.throws(()=>buildSourceVideoRequest(videoInput(new Uint8Array([1])),request,{...selected.binding,parent_sha256:'e'.repeat(64)}));checks++;
  const wholeResponse=structuredClone(lastResponse);wholeResponse.body.candidates[0].content.parts[0].text=JSON.stringify(sourceObservationToSourceClock(originalModel,selected.binding));
  const whole=await observeSourceVideo({...request,operationId:randomUUID(),observationTask:undefined},{...deps,post:async(body:string)=>{
    assert.equal(Buffer.from(JSON.parse(body).contents[0].parts[0].inlineData.data,'base64').length,selected.binding.parent_bytes);
    assert(JSON.parse(body).contents[0].parts[1].text.includes('完整视频带同步原声'));return wholeResponse;}});
  assert.equal(whole.input_media.full_original_video,true);assert.equal(whole.observation_material?.kind,'full_file');checks++;
  const multi=structuredClone(fixture.blind_input.cases[0].packet) as SourceVideoRequest['packet'];
  multi.units.forEach((u,i)=>{u.picture_plan={original_source_ranges:[i?[6,7]:[2.2,4.2]],explanation_source_ranges:[],line_source_ranges:[],registered_revisits:[],
    execution_plan:{plan_id:'p',script_candidate_id:'c',content:{composition:'neutral fixture'}}};});
  const legacyRequest={...request,operationId:randomUUID(),packet:multi,subject:{...request.subject,units:multi.units.map(u=>({unit_id:u.unit_id,candidate_id:'c'}))}};
  assert.equal(sourceVideoInput(legacyRequest).units.length,1);assert.deepEqual(sourceObservationRange(sourceVideoInput(legacyRequest)),[2.2,4.2]);checks++;
  const bytes=await readFile(file),legacyBuilt=buildSourceVideoRequest(bytes,legacyRequest,undefined,true);
  assert.equal(legacyBuilt.input.units.length,2);
  const raw={windows:legacyBuilt.input.units.flatMap(u=>u.windows.map(w=>({window_id:w.window_id,observed_sequence:'fixture',endpoint:'fixture',
    evidence:[{start_seconds:w.source_range_seconds[0],end_seconds:w.source_range_seconds[1],visible:'fixture',audible:'unclear'}]}))),
    lines:legacyBuilt.input.units.flatMap(u=>u.lines.map(l=>({unit_id:u.unit_id,line_id:l.line_id,status:'insufficient_evidence',reason:'fixture',window_ids:u.windows.map(w=>w.window_id)}))),limitations:['fixture'],
    observation_task:{boundaries:[],contexts:[{context_id:'local',sequence:[],material_ranges:[],limitations:['unknown fixture']}]}};
  const hash=(x:string)=>createHash('sha256').update(x).digest('hex');
  const old=JSON.stringify({status:'failed',requests_attempted:1,phase:'validate_response',http_status:200,projectId:'p',subject:legacyRequest.subject,source_hash:parentHash,
    fingerprint:hash('source-continuous-observation-v1'+JSON.stringify(legacyRequest)),input:legacyBuilt.input,request_sha256:hash(legacyBuilt.body),
    validation:{status:'invalid',issues:[{code:'missing_task_observation'}]},raw_response:{candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(raw)}]}}]}});
  const oldFile=join(deps.directory,legacyRequest.operationId+'.json');await writeFile(oldFile,old);
  const restored=await recoverSourceVideoReceipt(legacyRequest,undefined,deps);
  assert.equal(restored.result?.raw_observation.lines.length,5);assert.equal(restored.result?.input_media.full_original_video,true);
  assert.equal(await readFile(oldFile,'utf8'),old);assert.equal(posts,1);checks++;
  const failedRequest={...request,operationId:randomUUID()};let failure:any;
  try{await observeSourceVideo(failedRequest,{...deps,post:async()=>({status:504,body:null})});}catch(error){failure=error;}
  assert.equal(failure.receipt.requestsAttempted,1);assert.deepEqual(failure.receipt.observation_material,selected.binding);
  assert.deepEqual((await readSourceVideoReceipt(failedRequest.operationId,'p',deps)).observation_material,selected.binding);checks++;
  const saved=JSON.parse(await readFile(selected.file.replace('excerpt.mp4','binding.json'),'utf8'));saved.source_seconds_at_submitted_zero+=1;
  await writeFile(selected.file.replace('excerpt.mp4','binding.json'),JSON.stringify(saved));await assert.rejects(prepareObservationMaterial(options),/clock/);checks++;
  await writeFile(selected.file,new Uint8Array([1,2,3]));await assert.rejects(prepareObservationMaterial(options),/identity/);checks++;
  assert.throws(()=>materialRange([[1,2],[3,2]],8));checks++;
  const parent:any={streams:[{index:0,codec_type:'video',codec_name:'h264'},{index:1,codec_type:'audio',codec_name:'aac'}],packets:[{stream_index:0,pts_time:'2',duration_time:'1',data_hash:'v'},{stream_index:1,pts_time:'2',duration_time:'1',data_hash:'a'}],format:{duration:'4'}};
  const child=structuredClone(parent);child.packets[0].pts_time='0';child.packets[1].pts_time='0';assert.equal(verifyCopiedPackets(parent,child).offset,2);
  child.packets[1].data_hash='changed';assert.throws(()=>verifyCopiedPackets(parent,child),/identity/);checks++;
  child.packets[1].data_hash='a';child.packets[1].pts_time='1';assert.throws(()=>verifyCopiedPackets(parent,child),/clock/);checks++;
  assert.throws(()=>verifyCopiedPackets({...parent,streams:[...parent.streams,{index:2,codec_type:'audio',codec_name:'aac'}]},child),/drop tracks/);checks++;
  const missingVideo:any={streams:parent.streams,packets:[{stream_index:0,pts_time:'2',duration_time:'1',data_hash:'v2'},
    {stream_index:0,pts_time:'3',duration_time:'1',data_hash:'v3'},{stream_index:1,pts_time:'2',duration_time:'1',data_hash:'a2'},
    {stream_index:1,pts_time:'3',duration_time:'1',data_hash:'a3'}],format:{duration:'4'}};
  const cut:any={streams:parent.streams,packets:[{stream_index:0,pts_time:'1',duration_time:'1',data_hash:'v3'},
    {stream_index:1,pts_time:'0',duration_time:'1',data_hash:'a2'},{stream_index:1,pts_time:'1',duration_time:'1',data_hash:'a3'}],format:{duration:'2'}};
  assert.doesNotThrow(()=>verifyCopiedPackets(missingVideo,cut));
  assert.throws(()=>verifyCopiedPackets(missingVideo,cut,[2.2,3.5]),/both audio and video/);checks++;
  assert.equal(await sha256File(file),parentHash);
  console.log(`PASS ${checks} observation material checks: actual source entry, packet identity, clocks, cold read, initial whole file and rejection cases; zero network/model calls`);
} finally {await rm(root,{recursive:true,force:true});}
