import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promises as fs} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import saved from '../../src/clipmentor/fixtures/production-saved-projects-20261028.json';
import type {ProjectDoc} from '../../src/editor/types';

// Contract-shaped synthetic provider payloads, NOT observations of the saved production audio.
const root=await mkdtemp(join(tmpdir(),'word-anchors-'));
const previousData=process.env.OPENCHATCUT_DATA_DIR,previousFetch=globalThis.fetch;
process.env.OPENCHATCUT_DATA_DIR=root;
let network=0;globalThis.fetch=async()=>{network++;throw Error('Network forbidden');};
const failures:string[]=[];
const test=async(name:string,work:()=>Promise<void>)=>{try{await work();console.log('PASS',name);}catch(error){failures.push(name);console.error('FAIL',name,String(error));}};
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
try{
 const {currentExecutionView,currentExecutionPreparation}=await import('./execution-view');
 const {copyTeachingPacketFromDoc,buildCopyTeachingReviewRequest,checkCopyProduction}=await import('../../src/clipmentor/production-gate');
 const {registeredAudioBindings}=await import('./production-readiness');
 const {uploadDir}=await import('../media-dir');
 await mkdir(uploadDir(),{recursive:true});
 const fixture=async()=>{
  const doc=structuredClone(saved.cases[0].doc) as unknown as ProjectDoc;
  const packet=await copyTeachingPacketFromDoc(doc),line=packet.units[0].lines[0];
  const binding=registeredAudioBindings(doc).find(b=>b.lineId===line.line_id)!;
  const asset=doc.assets.find(a=>a.id===binding.assetId)!;
  const duration=Number(binding.durationSeconds),audio=Buffer.from('synthetic audio identity, not a listening fixture');
  const audioPath='/media/uploads/word-fixture.mp3',subtitlePath='/media/uploads/word-fixture.minimax-subtitles.json';
  const tokens=line.narration_ms.match(/[\p{L}\p{M}\p{N}]+(?:['’-][\p{L}\p{M}\p{N}]+)*|[^\s\p{P}]/gu)!;
  const words=tokens.map((word,i)=>({word,time_begin:(i+0.1)*duration*800/tokens.length,time_end:(i+0.8)*duration*800/tokens.length}));
  const payload=[{text:line.narration_ms,time_begin:0,time_end:duration*1000,timestamped_words:words}];
  const text=JSON.stringify(payload);
  await writeFile(join(uploadDir(),'word-fixture.mp3'),audio);
  await writeFile(join(uploadDir(),'word-fixture.minimax-subtitles.json'),text);
  asset.src=audioPath;asset.sourceContentHash=sha(audio);
  asset.props={...asset.props,generation:{text:line.narration_ms,provider:'minimax',voiceId:'fixture',speed:1,durationSeconds:duration},
   minimaxSubtitlePath:subtitlePath,minimaxSubtitleType:'word',
   minimaxSubtitleBinding:{version:1,provider:'minimax',subtitleType:'word',subtitlePath,subtitleSha256:sha(text),audioSha256:sha(audio),textSha256:sha(line.narration_ms),durationSeconds:duration}};
  for(const unit of doc.clipMentorAnalysis!.blueprint){
   const ir=unit.internal_review as any,plan=ir[ir.current_picture_plan];
   if(typeof plan.composition?.detail!=='string')continue;
   const detail=JSON.parse(plan.composition.detail);
   for(const b of detail.measured_audio_bindings??[])if(b.assetId===asset.id){b.src=audioPath;b.audioSha256=sha(audio);}
   plan.composition.detail=JSON.stringify(detail);
  }
  const anchors=async()=>((await currentExecutionView(doc)).audio.find(a=>a.line_id===line.line_id) as any)?.speech_anchors;
  const replace=async(value:unknown)=>{const raw=JSON.stringify(value);await writeFile(join(uploadDir(),'word-fixture.minimax-subtitles.json'),raw);(asset.props!.minimaxSubtitleBinding as any).subtitleSha256=sha(raw);};
  return{doc,asset,line,duration,payload,words,tokens,anchors,replace};
 };
 await test('saved audio without subtitles never acquires measured word times',async()=>{
  const doc=structuredClone(saved.cases[0].doc) as unknown as ProjectDoc,before=JSON.stringify(doc);
  const view=await currentExecutionView(doc);
  assert(view.audio.every(a=>!(a as any).speech_anchors),'legacy views remain byte-compatible; absence means unavailable');
  assert.equal(JSON.stringify(doc),before);
 });
 await test('word times reach both existing execution entry points with exact provenance',async()=>{
  const f=await fixture(),before=JSON.stringify(f.doc),a=await f.anchors();
  assert.equal(a?.status,'ready');assert.equal(a.basis,'minimax_reported_word_times');
  assert.equal(a.independently_listened,false);assert.equal(a.words.length,f.words.length);
  assert.equal(a.words[0].start_seconds,f.words[0].time_begin/1000);
  assert.equal(a.words[0].start_frame,Math.floor(f.words[0].time_begin*30/1000));
  assert.equal(a.words[0].end_frame,Math.ceil(f.words[0].time_end*30/1000));
  assert.deepEqual((await currentExecutionPreparation(f.doc)).view.audio.find(v=>v.line_id===f.line.line_id),(await currentExecutionView(f.doc)).audio.find(v=>v.line_id===f.line.line_id));
  assert.equal(JSON.stringify(f.doc),before,'derived anchors never write the project or its timeline');
 });
 await test('exact provider subword spans merge without inventing times; corrupt spans fail',async()=>{
  const f=await fixture(),text=f.line.narration_ms;
  const fragments=Array.from(text).map((word,i)=>({word,word_begin:i,word_end:i+1,pronounce_word:word,pronounce_word_begin:i,pronounce_word_end:i+1,time_begin:(i+.1)*f.duration*800/text.length,time_end:(i+.8)*f.duration*800/text.length}));
  const raw=[{text,pronounce_text:text,text_begin:0,text_end:text.length,is_final_segment:true,time_begin:0,time_end:f.duration*1000,timestamped_words:fragments}];
  await f.replace(raw);const a=await f.anchors();assert.equal(a.status,'ready');assert.equal(a.words.length,f.tokens.length);
  assert.equal(a.words[0].start_seconds,fragments[0].time_begin/1000);
  for(const mode of ['gap','wrong','overlap','unknown']){
   const broken=structuredClone(raw);if(mode==='gap')broken[0].timestamped_words.splice(1,1);
   if(mode==='wrong')broken[0].timestamped_words[1].word='!';
   if(mode==='overlap')broken[0].timestamped_words[1].time_begin=0;
   if(mode==='unknown')(broken[0] as any).estimated=true;
   await f.replace(broken);assert.equal((await f.anchors()).status,'unavailable',mode);
  }
 });
 await test('legacy path without binding and sentence-only files stay unresolved',async()=>{
  const f=await fixture();delete f.asset.props!.minimaxSubtitleBinding;
  assert.equal((await f.anchors())?.status,'unavailable');
  const g=await fixture();await g.replace([{text:g.line.narration_ms,time_begin:0,time_end:g.duration*1000}]);
  assert.equal((await g.anchors())?.status,'unavailable');
 });
 await test('wrong text, missing or inserted words cannot acquire estimated timestamps',async()=>{
  for(const mode of ['text','missing','inserted','sentence-as-word']){
   const f=await fixture();
   if(mode==='text')f.payload[0].text+=' changed';
   if(mode==='missing')f.payload[0].timestamped_words.pop();
   if(mode==='inserted')f.payload[0].timestamped_words.push({word:'extra',time_begin:0,time_end:1});
   if(mode==='sentence-as-word')f.payload[0].timestamped_words=[{word:f.line.narration_ms,time_begin:0,time_end:f.duration*1000}];
   await f.replace(f.payload);assert.equal((await f.anchors())?.status,'unavailable',mode);
  }
 });
 await test('bad, reversed, overlapping, zero, estimated and out-of-audio times are refused',async()=>{
  for(const mode of ['negative','reversed','overlap','zero','outside','string','estimated']){
   const f=await fixture(),w=f.payload[0].timestamped_words[1] as any;
   if(mode==='negative')w.time_begin=-1;
   if(mode==='reversed')w.time_end=w.time_begin-1;
   if(mode==='overlap')w.time_begin=0;
   if(mode==='zero')w.time_end=w.time_begin;
   if(mode==='outside')w.time_end=f.duration*1000+1;
   if(mode==='string')w.time_begin=String(w.time_begin);
   if(mode==='estimated')w.estimated=true;
   await f.replace(f.payload);assert.equal((await f.anchors())?.status,'unavailable',mode);
  }
 });
 await test('audio or subtitle replacement is detected on the next read, never cached globally',async()=>{
  const f=await fixture();assert.equal((await f.anchors())?.status,'ready');
  await writeFile(join(uploadDir(),'word-fixture.mp3'),'changed bytes');
  assert.equal((await f.anchors())?.status,'conflict');
  const g=await fixture();assert.equal((await g.anchors())?.status,'ready');
  await writeFile(join(uploadDir(),'word-fixture.minimax-subtitles.json'),'[]');
  assert.equal((await g.anchors())?.status,'conflict');
 });
 await test('wrong text/duration/granularity binding and external or traversal paths cannot pass',async()=>{
  for(const patch of [{textSha256:'f'.repeat(64)},{audioSha256:'f'.repeat(64)},{durationSeconds:999},{subtitleType:'sentence'},{subtitlePath:'https://example.com/timestamps.json'},{subtitlePath:'/media/uploads/../secret.json'}]){
   const f=await fixture();Object.assign(f.asset.props!.minimaxSubtitleBinding as object,patch);
   assert.equal((await f.anchors())?.status,'conflict',JSON.stringify(patch));
  }
 });
 await test('absolute frames derive only from audible, full, normal-speed instances',async()=>{
  const f=await fixture(),timeline=f.doc.timelines.find(t=>t.id===f.doc.activeTimelineId)!;
  const item=timeline.items.find(i=>i.kind==='audio'&&i.sourceAssetId===f.asset.id)!;
  assert(item);item.src=f.asset.src;item.startFrame=300;
  const a=await f.anchors(),placement=a?.placements.find((p:any)=>p.item_id===item.id);
  assert.equal(placement?.status,'ready');assert.equal(placement.words[0].start_frame,300+a.words[0].start_frame);
  item.playbackRate=1.2;assert.notEqual((await f.anchors())?.placements.find((p:any)=>p.item_id===item.id)?.status,'ready');
  item.playbackRate=1;item.srcInFrame=1;assert.notEqual((await f.anchors())?.placements.find((p:any)=>p.item_id===item.id)?.status,'ready');
  item.srcInFrame=0;item.volume=0;assert.equal((await f.anchors())?.placements.find((p:any)=>p.item_id===item.id)?.status,'unavailable');
  item.volume=1;item.durationInFrames=1;assert.equal((await f.anchors())?.placements.find((p:any)=>p.item_id===item.id)?.status,'unavailable');
  timeline.items=timeline.items.filter(i=>i.id!==item.id);assert.deepEqual((await f.anchors())?.placements,[]);
 });
 await test('missing, malformed and oversized sidecars are unavailable without fallback or network',async()=>{
  const f=await fixture();await unlink(join(uploadDir(),'word-fixture.minimax-subtitles.json'));
  assert.equal((await f.anchors())?.reason,'timing_file_missing');
  const g=await fixture(),path=join(uploadDir(),'word-fixture.minimax-subtitles.json');
  await writeFile(path,'invalid json');(g.asset.props!.minimaxSubtitleBinding as any).subtitleSha256=sha('invalid json');
  assert.equal((await g.anchors())?.status,'unavailable');
  await writeFile(path,Buffer.alloc(5_000_001));assert.equal((await g.anchors())?.reason,'timing_file_size_invalid');
 });
 await test('valid offsets and multi-segment pauses survive; wrong offsets do not',async()=>{
  const f=await fixture(),cut=3;
  const first=f.words.slice(0,cut),second=f.words.slice(cut);
  const payload=[{text:f.tokens.slice(0,cut).join(' '),time_begin:0,time_end:first.at(-1)!.time_end,timestamped_words:first},
   {text:f.tokens.slice(cut).join(' '),time_begin:second[0].time_begin,time_end:f.duration*1000,timestamped_words:second}];
  await f.replace(payload);assert.equal((await f.anchors())?.status,'ready');
  (payload[1].timestamped_words[0] as any).word_begin=0;(payload[1].timestamped_words[0] as any).word_end=f.tokens[0].length;
  await f.replace(payload);assert.equal((await f.anchors())?.reason,'subtitle_character_offset_conflict');
 });
 await test('review: a repeated suffix inside the previous word is not a valid character offset',async()=>{
  const {createSpeechAnchorReader}=await import('./word-anchors'),f=await fixture(),text='lama a.';
  (f.asset.props!.generation as any).text=text;(f.asset.props!.minimaxSubtitleBinding as any).textSha256=sha(text);
  const payload=[{text,time_begin:0,time_end:f.duration*1000,timestamped_words:[
   {word:'lama',word_begin:0,word_end:4,time_begin:0,time_end:200},
   {word:'a.',word_begin:3,word_end:4,time_begin:250,time_end:500}]}];
  await f.replace(payload);
  const read=()=>createSpeechAnchorReader()(f.asset,text,f.duration,f.doc.timelines[0],[text]);
  assert.equal((await read())?.status,'unavailable','the a inside lama cannot stand for the second spoken a');
  payload[0].timestamped_words[1].word_begin=5;payload[0].timestamped_words[1].word_end=7;
  await f.replace(payload);assert.equal((await read())?.status,'ready','punctuation included in valid provider offsets is allowed');
 });
 await test('unknown provenance keys never become execution instructions',async()=>{
  const f=await fixture();(f.asset.props!.minimaxSubtitleBinding as any).reason='AUTHOR_APPROVAL_SENTINEL';
  const anchors=await f.anchors();assert.equal(anchors?.status,'conflict');assert(!JSON.stringify(anchors).includes('AUTHOR_APPROVAL_SENTINEL'));
 });
 await test('adversarial: transcript edits, replacement sound and detached hashes invalidate absolute anchors',async()=>{
  for(const patch of [{deletedWordIdx:[1]},{silenceFrames:1},{gapCapsMs:{'1':0}},{transcriptPlayOrder:[1,0]},
   {denoisedSrc:'/media/uploads/different.mp3'},{sourceContentHash:'f'.repeat(64)},{keyframes:{volume:[{frame:0,value:0}]}}]){
   const f=await fixture(),t=f.doc.timelines.find(t=>t.id===f.doc.activeTimelineId)!,item=t.items.find(i=>i.kind==='audio'&&i.sourceAssetId===f.asset.id)!;
   item.src=f.asset.src;Object.assign(item,patch);
   const a=await f.anchors();assert.equal(a.status,'ready','source-local words remain valid');
   assert.equal(a.placements.find((p:any)=>p.item_id===item.id)?.status,'unavailable',JSON.stringify(patch));
  }
 });
 await test('adversarial: unsafe frame arithmetic cannot become a real frame anchor',async()=>{
  const f=await fixture(),t=f.doc.timelines.find(t=>t.id===f.doc.activeTimelineId)!,item=t.items.find(i=>i.kind==='audio'&&i.sourceAssetId===f.asset.id)!;
  item.src=f.asset.src;item.startFrame=Number.MAX_SAFE_INTEGER;
  assert.equal((await f.anchors())?.placements.find((p:any)=>p.item_id===item.id)?.status,'unavailable');
 });
 await test('independent review and production gate are unaffected by timing success or failure',async()=>{
  const f=await fixture();
  const request=()=>copyTeachingPacketFromDoc(f.doc).then(packet=>buildCopyTeachingReviewRequest([{case_id:'isolation',packet}]));
  const before=await request(),gate=await checkCopyProduction(f.doc,'clipmentor');
  assert.equal((await f.anchors())?.status,'ready');assert.deepEqual(await request(),before);
  assert(!JSON.stringify(before).includes('minimaxSubtitleBinding'));
  assert(!JSON.stringify(before).includes('minimax_reported_word_times'));
  f.asset.props!.minimaxSubtitleBinding={AUTHOR_APPROVAL_SENTINEL:true};
  assert.notEqual((await f.anchors())?.status,'ready');assert.deepEqual(await request(),before);
  assert.deepEqual(await checkCopyProduction(f.doc,'clipmentor'),gate);
 });
 await test('missing word evidence does not revoke a genuinely approved saved copy',async()=>{
  const doc=structuredClone(saved.cases[0].doc) as unknown as ProjectDoc;
  const gate=await checkCopyProduction(doc,'clipmentor');assert.equal(gate.allowed,true);
  const packet=await copyTeachingPacketFromDoc(doc),binding=registeredAudioBindings(doc).find(b=>b.lineId===packet.units[0].lines[0].line_id)!;
  const asset=doc.assets.find(a=>a.id===binding.assetId)!;
  asset.props={...asset.props,minimaxSubtitlePath:'/media/uploads/missing.minimax-subtitles.json',minimaxSubtitleType:'word'};
  const view=await currentExecutionView(doc),sound=view.audio.find(a=>a.line_id===packet.units[0].lines[0].line_id) as any;
  assert.equal(sound.status,'reusable');assert.equal(sound.speech_anchors.status,'unavailable');
  assert.deepEqual(await checkCopyProduction(doc,'clipmentor'),gate);
 });
 await test('durable subtitle binding survives the original voice asset path',async()=>{
  const {submitVoice}=await import('../../src/generate/voice');
  const doc=structuredClone(saved.cases[0].doc) as unknown as ProjectDoc;
  const response={path:'/media/uploads/synthetic.mp3',durationSeconds:1,sha256:'a'.repeat(64),subtitlePath:'/media/uploads/synthetic.minimax-subtitles.json',
   subtitleBinding:{version:1,provider:'minimax',subtitleType:'word',subtitlePath:'/media/uploads/synthetic.minimax-subtitles.json',subtitleSha256:'b'.repeat(64),audioSha256:'a'.repeat(64),textSha256:sha('Satu dua.'),durationSeconds:1}};
  globalThis.fetch=async()=>new Response(JSON.stringify(response),{status:200});
  try{
   const asset=await submitVoice({provider:'minimax',voiceId:'fixture',text:'Satu dua.',subtitleEnable:true,subtitleType:'word'},doc.timelines[0] as never);
   assert.equal(asset.sourceContentHash,response.sha256);assert.deepEqual(asset.props?.minimaxSubtitleBinding,response.subtitleBinding);
  }finally{globalThis.fetch=async()=>{network++;throw Error('Network forbidden');};}
 });
 await test('actual saved audio bytes and sidecar produce the persisted binding without a provider call',async()=>{
  const {saveVoiceAudio}=await import('../plugins/voice-media');
  const {bindMinimaxWordSubtitle}=await import('../plugins/voice-word-timing');
  const samples=16000,wav=Buffer.alloc(44+samples*2);
  wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);
  wav.writeUInt16LE(1,22);wav.writeUInt32LE(32000,24);wav.writeUInt32LE(64000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(samples*2,40);
  const path=join(uploadDir(),`voice-${sha(wav)}.wav`);
  await writeFile(path,wav.subarray(0,50));
  const {assertProductionAudioFile}=await import('./production-readiness');
  const asset={id:'fixture-wave',kind:'audio',src:`/media/uploads/voice-${sha(wav)}.wav`,sourceContentHash:sha(wav)} as ProjectDoc['assets'][number];
  await assert.rejects(assertProductionAudioFile(asset),/production_audio_file_changed/);
  const [result,concurrent]=await Promise.all([saveVoiceAudio(wav,'wav',32000),saveVoiceAudio(wav,'wav',32000)]);
  assert.deepEqual(concurrent,result);
  await assertProductionAudioFile(asset);
  assert.deepEqual(await readFile(path),wav);
  await assert.rejects(assertProductionAudioFile({...asset,src:'/media/uploads/missing-wave.wav'}),/production_audio_file_missing/);
  assert.equal(result.sha256,sha(await readFile(join(uploadDir(),result.path.split('/').pop()!))));assert.equal(result.durationSeconds,0.5);
  const f=await fixture();
  const binding=await bindMinimaxWordSubtitle(f.line.narration_ms,result,String(f.asset.props!.minimaxSubtitlePath));
  assert.equal(binding.audioSha256,result.sha256);assert.equal(binding.textSha256,sha(f.line.narration_ms));
 });
 await test('original saved-store cold read retains anchors and cannot turn a stale gate into approval',async()=>{
  const f=await fixture(),{withSerializedProjectStore}=await import('../plugins/project-store');
  const {loadOfflineStoredProject}=await import('../external-agent/offline-project-store');
  const gate=await checkCopyProduction(f.doc,'clipmentor');
  await withSerializedProjectStore(s=>s.writeEntry('project:word-anchor-cold-read',f.doc));
  const loaded=await loadOfflineStoredProject('word-anchor-cold-read');assert(loaded);
  assert.deepEqual(((await currentExecutionView(loaded.doc)).audio.find(a=>a.line_id===f.line.line_id) as any)?.speech_anchors,
   await f.anchors(),'store normalization of asset sourceRevision does not change the bound speech evidence');
  assert.deepEqual(await checkCopyProduction(loaded.doc,'clipmentor'),gate);
 });
 await test('original collaborative handoff transmits the exact derived anchors without new approval',async()=>{
  const f=await fixture(),{withSerializedProjectStore}=await import('../plugins/project-store');
  const {loadOfflineStoredProject}=await import('../external-agent/offline-project-store');
  const {copyReviewSubject}=await import('../../src/clipmentor/production-gate');
  const {revisionOf}=await import('../../src/agent/external-edit-session');
  const {registerHandoff,prepareHandoff}=await import('./handoff');
  const projectId='word-anchor-handoff';
  await withSerializedProjectStore(s=>s.writeEntry('project:'+projectId,f.doc));
  const loaded=(await loadOfflineStoredProject(projectId))!,subject=await copyReviewSubject(loaded.doc);
  await registerHandoff({projectId,expectedProjectRevision:revisionOf(loaded.doc),previousDigest:null,
   brief:{version:1,briefId:'word-anchor-zero-call',revision:1,mode:'collaborative',phase:'execution',planner:'external_codex',executor:'builtin_agent',
    projectId,timelineId:loaded.doc.activeTimelineId,objective:'Execute frozen fixture only',doneCriteria:['Preserve original copy and all gates'],
    blueprint:{revision:subject.revision,digest:subject.digest},budget:{maxModelTurns:1,maxToolCalls:1,maxElapsedMs:10000,paidToolCalls:{}}}});
  const prepared=(await prepareHandoff(projectId,[{role:'user',content:'Execute frozen fixture'}]))!;
  const actual=JSON.parse(prepared.messages[0].content as string).blueprint;
  const sent=actual.audio.find((a:any)=>a.line_id===f.line.line_id).speech_anchors;
  assert.equal(sent?.status,'ready');assert.deepEqual(sent,await f.anchors());
  assert.equal(actual.authority,'current_execution_facts_not_review_approval');
  console.log('handoff bytes with one timed line',Buffer.byteLength(prepared.messages[0].content as string));
 });
 await test('repeated caption phrases are not silently assigned to the first occurrence',async()=>{
  const {createSpeechAnchorReader}=await import('./word-anchors');
  const f=await fixture();
  const repeated=Array.from(new Set(f.tokens)).find(w=>f.tokens.filter(x=>x===w).length>1);
  assert(repeated,'saved text supplies a real repeated word for this synthetic timing fixture');
  const result=await createSpeechAnchorReader()(f.asset,f.line.narration_ms,f.duration,f.doc.timelines[0],[repeated]);
  assert.equal(result?.status,'ready');if(result?.status==='ready')assert.equal(result.caption_anchors[0].status,'unavailable');
 });
 await test('one preparation reads each shared file once; the next preparation rechecks it',async()=>{
  const {createSpeechAnchorReader}=await import('./word-anchors'),f=await fixture(),original=fs.open;
  let reads=0;const start=performance.now();
  fs.open=(async(...args:Parameters<typeof fs.open>)=>{reads++;return original(...args);}) as typeof fs.open;
  syncBuiltinESMExports();
  try{
   const reader=createSpeechAnchorReader();
   const results=await Promise.all(Array.from({length:20},()=>reader(f.asset,f.line.narration_ms,f.duration,f.doc.timelines[0],f.line.caption_lines)));
   assert(results.every(r=>r?.status==='ready'));assert.equal(reads,2,'one audio read + one subtitle read, not forty reads');
   await createSpeechAnchorReader()(f.asset,f.line.narration_ms,f.duration,f.doc.timelines[0],f.line.caption_lines);
   assert.equal(reads,4,'fresh preparations must not use old file hashes');
   console.log('timing preparation sample',{shared_references:20,file_reads:2,elapsed_ms:Math.round((performance.now()-start)*100)/100,anchor_bytes:Buffer.byteLength(JSON.stringify(results[0]))});
  }finally{fs.open=original;syncBuiltinESMExports();}
 });
 await test('both voice hosts share provenance mapping; subtitle requests do not invalidate audio reuse',async()=>{
  const {voiceAssetProvenance}=await import('../../shared/voice-word-timing');
  const {reusableVoiceForRequest}=await import('./audio-reuse');
  const f=await fixture(),args={provider:'minimax',voiceId:'fixture',text:f.line.narration_ms,speed:1,pitch:0,volume:1,languageBoost:'Malay',sampleRate:32000,channel:1,audioFormat:'mp3',subtitleEnable:true,subtitleType:'word'};
  const response={sha256:f.asset.sourceContentHash,subtitlePath:String(f.asset.props!.minimaxSubtitlePath),subtitleBinding:f.asset.props!.minimaxSubtitleBinding as any};
  const provenance=voiceAssetProvenance(response,'word');
  assert.equal(provenance.sourceContentHash,f.asset.sourceContentHash);
  assert.deepEqual(provenance.props.minimaxSubtitleBinding,f.asset.props!.minimaxSubtitleBinding);
  f.asset.props!.generation={...args,durationSeconds:f.duration};
  assert.equal(reusableVoiceForRequest(f.doc,args).status,'reusable');
  delete f.asset.props!.minimaxSubtitleBinding;delete f.asset.props!.minimaxSubtitlePath;
  assert.equal(reusableVoiceForRequest(f.doc,args).status,'reusable','missing timing does not authorize another synthesis');
  assert.notEqual(reusableVoiceForRequest(f.doc,{...args,speed:1.2}).status,'reusable');
  assert.notEqual(reusableVoiceForRequest(f.doc,{...args,voiceId:'another'}).status,'reusable');
 });
 assert.equal(network,0);
}finally{
 globalThis.fetch=previousFetch;if(previousData===undefined)delete process.env.OPENCHATCUT_DATA_DIR;else process.env.OPENCHATCUT_DATA_DIR=previousData;
 await rm(root,{recursive:true,force:true});
}
if(failures.length)throw Error(`${failures.length} failed groups: ${failures.join(', ')}`);
console.log('word anchors: all zero-provider groups passed');

const {optionalVoiceSubtitle}=await import('../plugins/voice-word-timing');
const timingFailure=await optionalVoiceSubtitle(async()=>{throw Error('subtitle CDN failure');});
assert.equal(timingFailure.subtitlePath,undefined);
assert.equal(timingFailure.subtitleBinding,undefined);
assert('subtitleWarning' in timingFailure);
const timingSuccess=await optionalVoiceSubtitle(async()=>({subtitlePath:'/media/uploads/fixture.json'}));
assert.equal(timingSuccess.subtitlePath,'/media/uploads/fixture.json');
