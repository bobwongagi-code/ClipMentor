import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import saved from './fixtures/production-saved-projects-20261028.json';
import type {ProjectDoc} from '../editor/types';
import type {AgentContext} from '../agent/context';
import {copyReviewSubject,copyTeachingPacketFromDoc} from './production-gate';
import {requestClipMentorCopyReview} from './request-copy-review';
import {transcribeClipMentorAsset} from './transcribe-source';
import {readClipMentorSourceAsr} from './read-source-asr';
import {requestSourceVideo,readSourceVideo} from './request-source-video';
import {ASR_AUDIO,FUNASR_MODEL} from '../../shared/clipmentor-asr';

const names=['copy','asr-init','observe','observe-read','asr-read'] as const;
type Name=typeof names[number];
const invoke={copy:requestClipMentorCopyReview,'asr-init':transcribeClipMentorAsset,observe:requestSourceVideo,'observe-read':readSourceVideo,'asr-read':readClipMentorSourceAsr};
const originalFetch=globalThis.fetch,originalTimeout=AbortSignal.timeout;
let external=0;globalThis.fetch=async()=>{external++;throw Error('No external requests allowed');};
const failures:string[]=[],passed:string[]=[];
const record=async(name:string,work:()=>Promise<void>)=>{try{await work();passed.push(name);}catch(e){failures.push(name+': '+String(e));console.error('FAIL',name,String(e));}finally{AbortSignal.timeout=originalTimeout;}};
async function fixture(name:Name){
 const doc=structuredClone(saved.cases[0].doc) as unknown as ProjectDoc,source=doc.clipMentorAnalysis!.source;
 const subject=await copyReviewSubject(doc),operationId=randomUUID();
 const receipt=structuredClone(doc.clipMentorAnalysis!.production_copy_review!);
 receipt.reviewer_run_id=`clipmentor-review:${operationId}`;
 const run=receipt.author_run_id,assetId=source.asset_id,sha=source.sourceContentHash!;
 const transcription={schema_version:1,operation_id:operationId,provider:'fun-asr',model:FUNASR_MODEL,requested_language:'auto',detected_language:null,
  source_hash:sha,duration_seconds:source.duration_seconds,fps:source.fps,audio:ASR_AUDIO,status:'completed',requests_attempted:1,
  chunks:[{chunk_id:'one',offset_seconds:0,end_seconds:source.duration_seconds,status:'completed',audio_bytes:3,audio_sha256:sha,words:[{text:'Asal',start_seconds:0,end_seconds:1}],detected_language:null}],
  words:[{text:'Asal',start_seconds:0,end_seconds:1}],conflicts:[],issues:[]};
 const sourceResult={operationId,requestsAttempted:1,subject:{revision:subject.revision,digest:subject.digest,units:subject.units.map(({unit_id,candidate_id})=>({unit_id,candidate_id}))},source_hash:sha,
  requested_model:'fixture',returned_model:'fixture',method_version:'fixture',request_sha256:'a'.repeat(64),input_sha256:'b'.repeat(64),video_bytes:1,
  input_media:{full_original_video:true,audio_stream_present:true,video_fps_requested:5},validation:{status:'valid',issues:[]},raw_observation:{windows:[]},finish_reasons:[],usage:null,
  scope:'source_windows_and_planned_capacity_only',actual_handoff_verified:false,complete_film_accepted:false};
 const sourceReceipt={operationId,status:'completed',requestsAttempted:1,requestsSent:0,projectId:'source-context',subject:sourceResult.subject,source_hash:sha,
  result:sourceResult,raw_response_available:true,receipt_reference:'fixture',actual_handoff_verified:false,complete_film_accepted:false};
 const args:Record<Name,Record<string,unknown>>={copy:{operationId,maxRequests:1,expectedRevision:subject.revision},
  'asr-init':{assetId,operationId,maxRequests:1,expectedRevision:0,actor:{operator:'test',executor:'fixture',instruction:'ASR only',identity:'local_declared_not_authenticated'},reason:'offline test'},
  observe:{operationId,maxRequests:1,expectedRevision:subject.revision},'observe-read':{operationId},'asr-read':{view:'source_asr',assetId,operationId}};
 const response:Record<Name,unknown>={copy:{operationId,requestsAttempted:1,receipt},'asr-init':transcription,observe:sourceResult,'observe-read':sourceReceipt,
  'asr-read':{operationId,source_hash:sha,state:'completed',requestsSent:0,requestsAttempted:1,original_status:'completed',recovered_from_raw:false,result:transcription,project_mutated:false,production_approved:false,listeningVerified:false}};
 if(name==='asr-init')delete doc.clipMentorAnalysis;
 return{doc,run,assetId,args:args[name],response:structuredClone(response[name])};
}
try{
 for(const name of names)for(const change of ['stable','clone','keys','in-place','new-doc','source','project','run','signal','abort','pre-abort','deadline','new-analysis']){
  if(change==='deadline'&&name==='asr-init'||change==='new-analysis'&&name!=='asr-init')continue;
  await record(`${name}/json/${change}`,async()=>{
   const f=await fixture(name);let doc=f.doc,project='source-context',run=f.run,controller=new AbortController(),dispatches=0,writes=0;
   const deadline=new AbortController();AbortSignal.timeout=()=>deadline.signal;
   let release!:()=>void,enter!:()=>void;
   const waiting=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{enter=r;});
   const ctx={getDoc:()=>doc,getProjectId:()=>project,getAgentRunId:()=>run,getAgentRunSignal:()=>controller.signal,getCreativeMode:()=> 'clipmentor',
    commands:{applyDoc:(next:ProjectDoc)=>{writes++;doc=next;}},templates:[],audio:[],
    hostFetch:async(_url:unknown,init?:RequestInit)=>{dispatches++;assert(init?.signal);return{ok:true,json:async()=>{enter();await waiting;return f.response;}} as Response;}} as unknown as AgentContext;
   if(change==='pre-abort')controller.abort();
   const pending=invoke[name](f.args,ctx);
   if(change==='pre-abort')release();else{
    await Promise.race([entered,pending.then(value=>{throw Error('did not reach JSON: '+JSON.stringify(value));})]);
    if(change==='clone')doc=structuredClone(doc);
    if(change==='keys')doc=JSON.parse(JSON.stringify(doc,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).reverse()):v));
    if(change==='in-place')doc.timelines[0].width+=2;
    if(change==='new-doc'){doc=structuredClone(doc);doc.timelines[0].width+=2;}
    if(change==='source')doc.assets.find(a=>a.id===f.assetId)!.src='/media/uploads/changed.mp4';
    if(change==='project')project='another-project';
    if(change==='run')run='another-run';
    if(change==='signal')controller=new AbortController();
    if(change==='abort')controller.abort();
    if(change==='deadline')deadline.abort();
    if(change==='new-analysis')doc.clipMentorAnalysis=structuredClone(saved.cases[0].doc.clipMentorAnalysis) as never;
    release();
   }
   const before=JSON.stringify(doc),result=await pending as any;
   const valid=['stable','clone','keys'].includes(change)||name==='asr-read'&&['in-place','new-doc'].includes(change);
   const writing=name==='copy'||name==='asr-init';
   assert.equal(dispatches,change==='pre-abort'?0:1,'no duplicate submission');
   if(valid){assert.equal(result.ok,true,JSON.stringify(result));assert.equal(writes,writing?1:0,'positive controls must really bind/init');if(name==='observe'||name==='observe-read')assert.equal(result.current_binding,'current');}
   else{
    assert.equal(writes,0,'stale results must not write a draft');assert.equal(JSON.stringify(doc),before,'the newer draft must survive unchanged');
    if((name==='observe'||name==='observe-read')&&!['abort','pre-abort','deadline'].includes(change)){
     assert.equal(result.ok,true,'historical observation remains readable');assert.equal(result.current_binding,'stale');
    }else{assert(result.error,'stale/cancelled result must be refused');assert.notEqual(result.ok,true);}
   }
   console.log('SOURCE_CONTEXT',name,change,{dispatches,writes,binding:result.current_binding,ok:result.ok});
  });
 }
 // Progress callbacks are host code and may synchronously cancel or navigate.
 for(const name of ['copy','observe'] as const)for(const change of ['abort','project','run','signal','in-place'])await record(`${name}/progress/${change}`,async()=>{
  const f=await fixture(name);let project='source-context',run=f.run,controller=new AbortController(),dispatches=0,writes=0;
  const ctx={getDoc:()=>f.doc,getProjectId:()=>project,getAgentRunId:()=>run,getAgentRunSignal:()=>controller.signal,getCreativeMode:()=> 'clipmentor',templates:[],audio:[],
   commands:{applyDoc:()=>{writes++;}},onToolProgress:()=>{if(change==='abort')controller.abort();if(change==='project')project='other';if(change==='run')run='other';if(change==='signal')controller=new AbortController();if(change==='in-place')f.doc.timelines[0].width+=2;},
   hostFetch:async()=>{dispatches++;return Response.json(f.response);}} as unknown as AgentContext;
  const value=await invoke[name](f.args,ctx) as any;assert.equal(dispatches,0,'no paid dispatch after progress callback invalidated authorization');assert.equal(writes,0);assert(value.error);assert.equal(value.requestsSent,0);
 });
 // Pause real subject hashing before dispatch, during receipt binding and in
 // the final gate; every independent await must retain the same authority.
 const originalDigest=crypto.subtle.digest;
 try{
  for(const [name,phase,nth]of [['copy','preflight',1],['observe','preflight',1],['copy','binding',1],['copy','gate',2],['observe-read','binding',1]] as const)
   for(const change of ['stable','clone','in-place','signal','abort','deadline']){
    await record(`${name}/${phase}/${change}`,async()=>{
     const f=await fixture(name);let doc=f.doc,controller=new AbortController(),dispatches=0,writes=0,seen=0,heldCount=0;
     const deadline=new AbortController();AbortSignal.timeout=()=>deadline.signal;
     let release!:()=>void,enter!:()=>void;
     const waiting=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{enter=r;});
     crypto.subtle.digest=async function(...args){
      if((phase==='preflight'?dispatches===0:dispatches===1)&&++seen===nth){heldCount++;enter();await waiting;}
      return originalDigest.apply(this,args);
     };
     const ctx={getDoc:()=>doc,getProjectId:()=> 'source-context',getAgentRunId:()=>f.run,getAgentRunSignal:()=>controller.signal,getCreativeMode:()=> 'clipmentor',templates:[],audio:[],
      commands:{applyDoc:(next:ProjectDoc)=>{writes++;doc=next;}},hostFetch:async()=>{dispatches++;return Response.json(f.response);}} as unknown as AgentContext;
     const pending=invoke[name](f.args,ctx);
     await Promise.race([entered,pending.then(v=>{throw Error('did not reach real hash: '+JSON.stringify(v));})]);
     if(change==='clone')doc=structuredClone(doc);
     if(change==='in-place')doc.timelines[0].width+=2;
     if(change==='signal')controller=new AbortController();
     if(change==='abort')controller.abort();
     if(change==='deadline')deadline.abort();
     release();const result=await pending as any,valid=change==='stable'||change==='clone';
     assert.equal(heldCount,1,'the actual digest must have been paused');
     if(valid){assert.equal(result.ok,true,JSON.stringify(result));assert.equal(writes,name==='copy'?1:0);if(name==='observe-read')assert.equal(result.current_binding,'current');}
     else{
      assert.equal(writes,0);
      if(name==='observe-read'&&!['abort','deadline'].includes(change)){assert.equal(result.ok,true);assert.equal(result.current_binding,'stale');}
      else assert(result.error,'hash-time drift cannot apply or dispatch');
      assert.equal(dispatches,phase==='preflight'?0:1);
     }
     console.log('SOURCE_HASH',name,phase,change,{seen,heldCount,dispatches,writes});
    });
    crypto.subtle.digest=originalDigest;
   }
 }finally{crypto.subtle.digest=originalDigest;}
 // Returning A→B→A can pass a final equality check while two async
 // derivations accidentally mix A's subject with B's unapproved narration.
 for(const name of ['copy','observe'] as const)await record(`${name}/aba-request-snapshot`,async()=>{
  const f=await fixture(name),initial=JSON.stringify(f.doc),expected=JSON.parse(JSON.stringify(await copyTeachingPacketFromDoc(f.doc)));
  const unit=f.doc.clipMentorAnalysis!.blueprint[0],internal=(unit as any).internal_review,line=internal[internal.current_script_candidate].lines[0],originalLine=structuredClone(line);
  const digest=crypto.subtle.digest;let hashes=0,dispatches=0,wire:any;
  try{
   crypto.subtle.digest=async function(...args){
    hashes++;
    if(hashes===1)Object.assign(line,{narration_ms:'UNAUTHORIZED TEMPORARY NARRATION',caption_lines:['UNAUTHORIZED TEMPORARY NARRATION']});
    if(hashes===2)Object.assign(line,originalLine);
    return digest.apply(this,args);
   };
   const ctx={getDoc:()=>f.doc,getProjectId:()=> 'source-context',getAgentRunId:()=>f.run,getCreativeMode:()=> 'clipmentor',templates:[],audio:[],
    commands:{applyDoc:()=>{}},hostFetch:async(_url:unknown,init?:RequestInit)=>{dispatches++;wire=JSON.parse(String(init?.body));return Response.json(f.response);}} as unknown as AgentContext;
   const value=await invoke[name](f.args,ctx) as any;
   assert(hashes>=2,'both real asynchronous derivations must be reached');assert.equal(JSON.stringify(f.doc),initial,'live document really returned to A');
   assert.equal(dispatches,1);assert.equal(value.ok,true,JSON.stringify(value));
   assert(!JSON.stringify(wire.packet).includes('UNAUTHORIZED TEMPORARY NARRATION'),'wire input must never mix restored A with transient B');
   assert.deepEqual(wire.packet,expected,'all packet fields derive from the initial saved facts');
   assert.equal(wire.subject.digest,name==='copy'?(f.response as any).receipt.content_digest:(f.response as any).subject.digest);
  }finally{crypto.subtle.digest=digest;Object.assign(line,originalLine);}
 });
 await record('observe-read/aba-historical-receipt',async()=>{
  const f=await fixture('observe-read'),initial=JSON.stringify(f.doc),unit=f.doc.clipMentorAnalysis!.blueprint[0],internal=(unit as any).internal_review;
  const line=internal[internal.current_script_candidate].lines[0],originalLine=structuredClone(line),historical=structuredClone(f.doc);
  const h=(historical.clipMentorAnalysis!.blueprint[0] as any).internal_review;
  Object.assign(h[h.current_script_candidate].lines[0],{narration_ms:'HISTORICAL B',caption_lines:['HISTORICAL B']});
  const bSubject=await copyReviewSubject(historical),receipt=structuredClone(f.response) as any;
  assert.notEqual(bSubject.digest,receipt.subject.digest,'historical B differs from current A');
  receipt.subject={revision:bSubject.revision,digest:bSubject.digest,units:bSubject.units.map(({unit_id,candidate_id})=>({unit_id,candidate_id}))};
  receipt.result.subject=structuredClone(receipt.subject);const raw=JSON.stringify(receipt),digest=crypto.subtle.digest;let hashes=0,dispatches=0;
  try{
   crypto.subtle.digest=async function(...args){hashes++;Object.assign(line,originalLine);return digest.apply(this,args);};
   const ctx={getDoc:()=>f.doc,getProjectId:()=> 'source-context',getAgentRunId:()=>f.run,
    hostFetch:async()=>{dispatches++;return{ok:true,json:async()=>{Object.assign(line,{narration_ms:'HISTORICAL B',caption_lines:['HISTORICAL B']});return receipt;}} as Response;}} as unknown as AgentContext;
   const value=await readSourceVideo(f.args,ctx) as any;
   assert.equal(hashes,1);assert.equal(dispatches,1);assert.equal(JSON.stringify(f.doc),initial);
   assert.equal(value.ok,true);assert.equal(value.current_binding,'stale','a transient B must not promote its historical receipt as current A');
   assert.equal(JSON.stringify(value.receipt),raw,'the saved historical judgment remains unchanged');
  }finally{crypto.subtle.digest=digest;Object.assign(line,originalLine);}
 });
 // ASR handoff is async even with no teaching points: cancel/drift in its
 // continuation must not replace analysis created after the JSON check.
 for(const change of ['stable','new-analysis','abort'])await record(`asr-init/final-write/${change}`,async()=>{
  const f=await fixture('asr-init');let doc=f.doc,writes=0,dispatches=0,mutations=0;const controller=new AbortController(),reads:string[]=[];
  const ctx={getDoc:()=>{reads.push(doc.clipMentorAnalysis?'analysis':'fresh');return doc;},getProjectId:()=> 'source-context',getAgentRunId:()=>f.run,getAgentRunSignal:()=>controller.signal,
   commands:{applyDoc:(next:ProjectDoc)=>{writes++;doc=next;}},hostFetch:async()=>{dispatches++;return{ok:true,json:async()=>{
    queueMicrotask(()=>queueMicrotask(()=>{mutations++;if(change==='new-analysis')doc.clipMentorAnalysis=structuredClone(saved.cases[0].doc.clipMentorAnalysis) as never;if(change==='abort')controller.abort();}));
    return f.response;
   }} as Response;}} as unknown as AgentContext;
  const value=await transcribeClipMentorAsset(f.args,ctx) as any;
  assert.equal(mutations,1);assert.equal(dispatches,1);assert.equal(writes,change==='stable'?1:0);
  if(change==='stable')assert.equal(value.ok,true);else assert(value.error);
  if(change==='new-analysis'){assert(reads.slice(0,-1).includes('fresh')&&reads.includes('analysis'),'both sides of the handoff continuation are observed');assert.equal(doc.clipMentorAnalysis!.analysis_id,(saved.cases[0].doc.clipMentorAnalysis as any).analysis_id);}
 });
 for(const name of ['asr-read','observe-read'] as const)await record(`${name}/optional-run`,async()=>{
  const f=await fixture(name),ctx={getDoc:()=>f.doc,getProjectId:()=> 'source-context',hostFetch:async()=>Response.json(f.response)} as unknown as AgentContext;
  assert.equal((await invoke[name](f.args,ctx) as any).ok,true,'saved read does not require a new run identity');
 });
 assert.equal(external,0);
 assert.deepEqual(failures,[]);
 console.log(`source-context: ${passed.length} independent-boundary cases passed; no external requests`);
}finally{globalThis.fetch=originalFetch;AbortSignal.timeout=originalTimeout;}
