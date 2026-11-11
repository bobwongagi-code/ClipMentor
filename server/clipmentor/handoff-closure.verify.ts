import saved from '../../src/clipmentor/fixtures/production-saved-projects-20261028.json';
import assert from 'node:assert/strict';
import {mkdtemp,rm,unlink,writeFile} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import type {ProjectDoc} from '../../src/editor/types';
import type {AgentContext} from '../../src/agent/context';
const root=await mkdtemp(join(tmpdir(),'handoff-closure-')),prior=process.env.OPENCHATCUT_DATA_DIR,priorFetch=globalThis.fetch;
process.env.OPENCHATCUT_DATA_DIR=root;let network=0;globalThis.fetch=async()=>{network++;throw Error('Network forbidden');};
const {makeDraft}=await import('../../src/editor/store');
const {openHeadlessEditor}=await import('./headless-editor');
const {MemoryPersistence,projectId,projectDoc}=await import('../external-agent/offline-runtime.verify-fixtures');
const {executeTool}=await import('../../src/agent/tools');
const {copyTeachingPacketFromDoc,checkCopyProduction,buildCopyTeachingReviewRequest}=await import('../../src/clipmentor/production-gate');
const {materializeHandoffVoice}=await import('./handoff-voice.verify-fixture');
const {currentReviewRepair}=await import('./execution-view');
const {productionAuthorTaskData}=await import('./production-worker');
const {reusableVoiceForRequest}=await import('./audio-reuse');
const {deliverySectionsFromDoc,deliveryAudio}=await import('../../src/clipmentor/delivery-bindings');
const {default:deliveryFixture}=await import('./fixtures/blueprint-review-board-20261031.json');
const profile=(await import('../runtime-profile')).runtimeProfile();
assert.equal(profile.rootDir,root);
const doc=()=>structuredClone(saved.cases[0].doc) as ProjectDoc;
const settings={provider:'minimax',voiceId:'fixture-voice',speed:1,pitch:0,volume:1,languageBoost:'Malay',sampleRate:32000,channel:1,audioFormat:'mp3'};
const opts=(p:InstanceType<typeof MemoryPersistence>,extra:Record<string,unknown>={})=>({projectId,runId:'fixture-run',origin:'http://127.0.0.1:5199',review:{provider:'openai' as const,model:'fixture',origin:'http://127.0.0.1:5199',apiMode:'responses' as const},persistence:p,browserConnected:()=>false,effect:async()=>{throw Error('No provider effects');},...extra});
const cases:Array<{name:string;passed:boolean;error?:string}>=[];
async function test(name:string,work:()=>Promise<void>){try{await work();cases.push({name,passed:true});console.log('PASS',name);}catch(error){cases.push({name,passed:false,error:String(error).slice(0,300)});console.log('FAIL',name,String(error).slice(0,300));}}
function captionDoc(d:ProjectDoc,text:string){const draft=makeDraft(d);const id=draft.commands.addTextClip({text,fontSize:28,color:'#FFFFFF',startFrame:10000,durationInFrames:30,track:'track-v1'});return{doc:draft.getDoc(),id};}
try{
 for(const surface of ['server','browser','browser-null-mode'] as const)for(const route of ['typed','untyped','direct'] as const){
  await test(`${surface} ${route}: conflicting frozen style refuses without publication`,async()=>{
   const d=doc(),line=(await copyTeachingPacketFromDoc(d)).units[0].lines[0],seed=captionDoc(d,line.caption_lines[0]);
   const name=route==='direct'?'update_item_props':'edit_item';
   const args=route==='direct'?{itemId:seed.id,props:{fontSize:52,color:'#ff0000'}}:{updates:[{...(route==='typed'?{type:'text'}:{}),itemId:seed.id,props:{fontSize:52,color:'#ff0000'}}]};
   if(surface==='server'){
    const p=new MemoryPersistence(seed.doc),e=await openHeadlessEditor(opts(p));try{const before=JSON.stringify(p.current),r=await e.execute(name,args,'style') as {error?:string};assert.match(String(r.error),/frozen_parameter_conflict/);assert.equal(JSON.stringify(p.current),before);assert.equal(p.commitCount,0);}finally{await e.close();}
   }else{
    const draft=makeDraft(seed.doc),ctx={...draft,templates:[],audio:[],getCreativeMode:()=>surface==='browser-null-mode'?null:'clipmentor',getAgentRunId:()=> 'fixture-run',getProjectId:()=>projectId} as AgentContext;
    const before=JSON.stringify(draft.getDoc()),r=await executeTool(name,args,ctx) as {error?:string};assert.match(String(r.error),/frozen_parameter_conflict/);assert.equal(JSON.stringify(draft.getDoc()),before);
   }
  });
 }
 await test('same batch selected update cannot bypass after a new caption add; entire batch rolls back',async()=>{
  const d=doc(),line=(await copyTeachingPacketFromDoc(d)).units[0].lines[0],p=new MemoryPersistence(d),e=await openHeadlessEditor(opts(p));
  try{const before=JSON.stringify(p.current);const result=await e.execute('edit_item',{adds:[{type:'text',text:line.caption_lines[0],fromFrame:10000,durationInFrames:30}],updates:[{itemId:'selected',props:{fontSize:52}}]},'selected') as {error?:string};assert(result.error);assert.equal(JSON.stringify(p.current),before);}finally{await e.close();}
 });
 await test('normal same frozen style and placement edits pass; ordinary editor remains unrestricted',async()=>{
  const d=doc(),line=(await copyTeachingPacketFromDoc(d)).units[0].lines[0],seed=captionDoc(d,line.caption_lines[0]),e=await openHeadlessEditor(opts(new MemoryPersistence(seed.doc)));
  try{const a=await e.execute('update_item_props',{itemId:seed.id,props:{fontSize:28,color:'#FFFFFF'}},'same') as {error?:string};assert(!a.error);const b=await e.execute('edit_item',{updates:[{itemId:seed.id,transform:{x:2}}]},'move') as {error?:string};assert(!b.error);}finally{await e.close();}
  const other=captionDoc(projectDoc(),'ordinary text'),plain=await openHeadlessEditor(opts(new MemoryPersistence(other.doc)));
  try{const r=await plain.execute('update_item_props',{itemId:other.id,props:{fontSize:52}},'ordinary') as {error?:string};assert(!r.error);}finally{await plain.close();}
 });
 await test('changing a plain label to approved caption fills its frozen style rather than rejecting an omitted style',async()=>{
  const d=doc(),line=(await copyTeachingPacketFromDoc(d)).units[0].lines[0],seed=captionDoc(d,'Existing label');seed.doc.timelines[0].items.find(i=>i.id===seed.id)!.props!.fontSize=40;
  const e=await openHeadlessEditor(opts(new MemoryPersistence(seed.doc)));
  try{const r=await e.execute('update_item_props',{itemId:seed.id,props:{text:line.caption_lines[0]}},'fill-style') as {error?:string};assert(!r.error);assert.equal(e.getDoc().timelines[0].items.find(i=>i.id===seed.id)!.props!.fontSize,28);}finally{await e.close();}
 });
 await test('untyped audio trim and direct timing cannot truncate frozen narration',async()=>{
  for(const route of ['edit_item','set_item_timing']){const d=doc(),asset=d.assets.find(a=>a.kind==='audio')!,item=d.timelines[0].items.find(i=>i.kind==='audio'&&i.sourceAssetId===asset.id)!;
   const p=new MemoryPersistence(d),e=await openHeadlessEditor(opts(p));try{const before=JSON.stringify(p.current);const args=route==='edit_item'?{updates:[{itemId:item.id,durationInFrames:2}]}:{itemId:item.id,durationInFrames:2};const r=await e.execute(route,args,'trim') as {error?:string};assert(r.error);assert.equal(JSON.stringify(p.current),before);}finally{await e.close();}
  }
 });
 await test('point-only teaching failure reaches actual author message unchanged; reviewer remains isolated',async()=>{
  const d=doc(),receipt=d.clipMentorAnalysis!.production_copy_review!,packet=await copyTeachingPacketFromDoc(d);
  const originalInput=buildCopyTeachingReviewRequest([{case_id:'isolation',packet}]);
  const point=receipt.teaching_review!.review.units[0].points[0];point.source_support='contradicted';point.reason='POINT_ONLY_REPAIR_SENTINEL';receipt.verdict='needs_revision';receipt.units[0].verdict='needs_revision';receipt.units[0].findings=[];
  const raw=JSON.stringify(receipt),gate=await checkCopyProduction(d,'clipmentor');assert.equal(gate.allowed,false);assert.equal(gate.code,'copy_teaching_review_not_passed');
  const repair=await currentReviewRepair(d),message=await productionAuthorTaskData({stage:'blueprint',input:{brief:'repair',sourceAssetId:d.clipMentorAnalysis!.source.asset_id},repairContext:{receipt,repair}} as never,d);
  assert(JSON.stringify(message).includes('POINT_ONLY_REPAIR_SENTINEL'),'must deliver point-level reason, not only the aggregate verdict');
  assert.equal(JSON.stringify(receipt),raw,'original verdict is immutable');assert.deepEqual(buildCopyTeachingReviewRequest([{case_id:'isolation',packet:await copyTeachingPacketFromDoc(d)}]),originalInput);
 });
 await test('selected legacy audio with unknown config stops before synthesis effect',async()=>{
  const d=doc(),line=(await copyTeachingPacketFromDoc(d)).units[0].lines[0];let effects=0;
  const e=await openHeadlessEditor(opts(new MemoryPersistence(d),{voice:{provider:settings.provider,voiceId:settings.voiceId},effect:async()=>{effects++;throw Error('Unexpected synthesis effect');}}));
  try{let r:unknown;try{r=await e.execute('submit_voice',{...settings,text:line.narration_ms},'unknown');}catch(error){r={error:String(error)};}assert.equal(effects,0,'unknown is not permission to synthesize');assert.match(String((r as {error?:string}).error),/voice_reuse_unverified/);}finally{await e.close();}
 });
 await test('exact selected audio reuses; changed, missing or conflicting audio never synthesizes',async()=>{
  const d=doc(),line=(await copyTeachingPacketFromDoc(d)).units[0].lines[0],asset=d.assets.find(a=>a.kind==='audio')!;
  asset.props={...asset.props,generation:{...settings,text:line.narration_ms,durationSeconds:asset.durationInFrames/30}};
  const {file,bytes}=await materializeHandoffVoice(d,asset,profile.mediaDir);
  let effects=0;const e=await openHeadlessEditor(opts(new MemoryPersistence(d),{voice:{provider:settings.provider,voiceId:settings.voiceId},effect:async()=>{effects++;throw Error('Unexpected synthesis effect');}}));
  try{const request={...settings,text:line.narration_ms};
   const r=await e.execute('submit_voice',request,'exact') as {reused?:boolean;error?:string};assert.equal(r.reused,true,r.error);
   const conflict=await e.execute('submit_voice',{...request,pitch:1},'conflict') as {error?:string};assert.match(String(conflict.error),/voice_reuse_conflict/);
   await writeFile(file,Buffer.alloc(bytes.length));
   await assert.rejects(e.execute('submit_voice',request,'changed'),/production_audio_file_changed/);
   await unlink(file);
   await assert.rejects(e.execute('submit_voice',request,'missing'),/production_audio_file_missing/);
   assert.equal(effects,0);
  }finally{await e.close();}
 });
 await test('first delivery synthesis is missing, explicit broken selection remains conflict',async()=>{
  const d=structuredClone(deliveryFixture.cases.newBinding) as unknown as ProjectDoc;
  d.assets=d.assets.filter(a=>a.kind!=='audio');
  for(const unit of d.clipMentorAnalysis!.blueprint){
   const review=(unit as unknown as {internal_review:Record<string,unknown>}).internal_review;
   const plan=review[String(review.current_picture_plan)] as {delivery_sections:Array<{voice:Record<string,unknown>}>};
   for(const section of plan.delivery_sections??[])delete section.voice.existing_audio;
  }
  const section=deliverySectionsFromDoc(d)[0],args={...settings,provider:section.voice.provider,voiceId:section.voice.voiceId,text:section.line.narration_ms};
  assert.equal(reusableVoiceForRequest(d,args).status,'missing','no previous audio must permit first authorized synthesis');
  const review=(d.clipMentorAnalysis!.blueprint[0] as unknown as {internal_review:Record<string,unknown>}).internal_review;
  const plan=review[String(review.current_picture_plan)] as {delivery_sections:Array<{voice:Record<string,unknown>}>};
  plan.delivery_sections[0].voice.existing_audio={assetId:'missing-selected',src:'/media/uploads/missing.mp3',sha256:'a'.repeat(64),durationSeconds:2,text:section.line.narration_ms};
  assert.throws(()=>reusableVoiceForRequest(d,args),/delivery_audio_binding_invalid/,'explicit missing selection remains blocked');
  d.assets.push({id:'missing-selected',kind:'audio',name:'broken',src:'/media/uploads/missing.mp3',durationInFrames:1} as ProjectDoc['assets'][number]);
  assert.equal(reusableVoiceForRequest(d,args).status,'conflict','invalid selected duration remains blocked');
 });
 await test('delivery audio accepts producer ceil and legacy round, rejects real duration mismatch',async()=>{
  const d=structuredClone(deliveryFixture.cases.newBinding) as unknown as ProjectDoc;
  const section=deliverySectionsFromDoc(d)[0];
  delete section.voice.existing_audio;
  d.assets=d.assets.filter(a=>a.kind!=='audio');
  const fps=d.timelines.find(t=>t.id===d.activeTimelineId)!.fps,seconds=13.479188;
  const asset={id:'measured-opening',kind:'audio',name:'measured',src:'/media/uploads/measured.mp3',durationInFrames:Math.ceil(seconds*fps),props:{generation:{text:section.line.narration_ms,...section.voice,durationSeconds:seconds}}} as ProjectDoc['assets'][number];
  d.assets.push(asset);
  assert.equal(deliveryAudio(d,section).frames,Math.ceil(seconds*fps));
  asset.durationInFrames=Math.round(seconds*fps);assert.equal(deliveryAudio(d,section).frames,Math.round(seconds*fps));
  asset.durationInFrames=Math.ceil(seconds*fps)+1;assert.throws(()=>deliveryAudio(d,section),/delivery_audio_missing/);
  asset.durationInFrames=Math.round(seconds*fps)-1;assert.throws(()=>deliveryAudio(d,section),/delivery_audio_missing/);
 });
 await test('truly absent audio is distinguished from unverified existing audio',async()=>{
  const d=projectDoc();const state=reusableVoiceForRequest(d,{...settings,text:'No previous voice exists'});
  assert(state===null||(state as unknown as {status?:string})?.status==='missing','a truly missing file remains eligible for authorized synthesis');
 });
 assert.equal(network,0);console.log(JSON.stringify({passed:cases.filter(c=>c.passed).length,failed:cases.filter(c=>!c.passed).length,cases,network}));if(cases.some(c=>!c.passed))process.exitCode=1;
}finally{globalThis.fetch=priorFetch;if(prior===undefined)delete process.env.OPENCHATCUT_DATA_DIR;else process.env.OPENCHATCUT_DATA_DIR=prior;await rm(root,{recursive:true,force:true});}
