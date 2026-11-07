import assert from 'node:assert/strict';
import {Script} from 'node:vm';
import {mkdtemp,rm,writeFile,mkdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createServer} from 'node:http';import {once} from 'node:events';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';
const output=process.env.STORYBOARD_TEST_OUTPUT;
import saved from '../../src/clipmentor/fixtures/production-saved-projects-20261028.json';
import phased from '../../src/agent/tools/fixtures/barely-there-mg-replacement-20261030.json';
import type {ProjectDoc} from '../../src/editor/types';
import {createMiniConnect} from '../../desktop/mini-connect';

const root=await mkdtemp(join(tmpdir(),'storyboard-regression-')),oldData=process.env.OPENCHATCUT_DATA_DIR,oldFetch=globalThis.fetch;
process.env.OPENCHATCUT_DATA_DIR=root;
let network=0;globalThis.fetch=async()=>{network++;throw Error('External network forbidden');};
const tests:Array<{name:string;ok:boolean;error?:string}>=[];
const test=async(name:string,work:()=>Promise<void>)=>{try{await work();tests.push({name,ok:true});console.log('PASS',name);}catch(e){tests.push({name,ok:false,error:String(e)});console.error('FAIL',name,String(e));}};
try{
 const {productionStoryboard}=await import('./storyboard'),{createStoryboardImages}=await import('./storyboard-images');
 const {copyTeachingPacketFromDoc,buildCopyTeachingReviewRequest,checkCopyProduction}=await import('../../src/clipmentor/production-gate');
 const {execClipMentorAnalysisTool}=await import('../../src/agent/tools/clipmentor-analysis-tools');
 const {makeDraft}=await import('../../src/editor/store');
 const fixture=()=>structuredClone(saved.cases[0].doc) as unknown as ProjectDoc;
 const placed=()=>{
  const doc=fixture(),t=doc.timelines.find(t=>t.id===doc.activeTimelineId)!,end=Math.max(...t.items.map(i=>i.startFrame+i.durationInFrames));
  // Explicitly synthetic native placement/provenance, not a claim about the old saved case.
  doc.clipMentorAnalysis!.source_breakdown!.units[0].placement={timeline_id:t.id,original_frames:[0,100],explanation_frames:[100,end]};
  for(const asset of doc.assets)asset.sourceContentHash??='a'.repeat(64);
  return doc;
 };
 const jpg='/9j/'+Buffer.from('synthetic image payload, not a production observation').toString('base64');
 const fake=(doc:ProjectDoc)=>{
  let source=0,actual=0;const files=new Map(doc.assets.map(a=>[a.src.split('/').at(-1)!,a.sourceContentHash??'a'.repeat(64)]));
  const read=createStoryboardImages({resolve:n=>files.has(n)?n:null,hash:async f=>files.get(f)!,source:async()=>{source++;return jpg;},actual:async(_d,frames)=>{actual++;return frames.map(frame=>({frame,base64:jpg}));}});
  return{read,files,counts:()=>({source,actual})};
 };
 await test('saved cases: current lines, meanings, source ranges and immutable gate',async()=>{
  for(const entry of saved.cases){const d=structuredClone(entry.doc) as unknown as ProjectDoc,before=JSON.stringify(d),packet=await copyTeachingPacketFromDoc(d),gate=await checkCopyProduction(d,'clipmentor');
   const b=await productionStoryboard(d,'fixture');assert.equal(b.cards.filter(c=>c.kind==='unit').length,packet.units.length);
   for(const unit of packet.units){const card=b.cards.find(c=>(c.subject_id??c.id)===unit.unit_id)!;assert.deepEqual(card.lines.map(l=>l.ms),unit.lines.map(l=>l.narration_ms));assert.deepEqual(card.lines.map(l=>l.zh),unit.lines.map(l=>l.meaning_zh));assert(card.source.length);assert(card.source.every(r=>r.source_seconds<=Math.floor((d.clipMentorAnalysis!.source.duration_seconds-1/d.clipMentorAnalysis!.source.fps)*d.clipMentorAnalysis!.source.fps)/d.clipMentorAnalysis!.source.fps));}
   assert.equal(b.authority,'read_only_reference_and_saved_layout_not_approval');assert.equal(b.listening,false);assert.equal(JSON.stringify(d),before);assert.deepEqual(await checkCopyProduction(d,'clipmentor'),gate);
  }
 });
 await test('full plan includes supplied opening and selected creator closing before any new audio',async()=>{
  const doc=structuredClone(phased.before) as unknown as ProjectDoc,packet=await copyTeachingPacketFromDoc(doc),board=await productionStoryboard(doc,'phased');
  for(const section of packet.delivery_sections??[]){const card=board.cards.find(c=>(c.subject_id??c.id)===section.section_id)!;assert(card);assert.equal(card.source[0].asset_id,section.picture.asset_id);assert.equal(card.lines[0].ms,section.line.narration_ms);}
  assert.equal(board.cards[0].kind,'opening');assert.equal(board.cards.at(-1)!.kind,'closing');
  for(const unit of doc.clipMentorAnalysis!.blueprint){const internal=unit.internal_review as any,plan=internal?.[internal.current_picture_plan];for(const section of plan?.delivery_sections??[])delete section.voice.existing_audio;}
  const noAudio=await productionStoryboard(doc,'phased');assert.equal(noAudio.cards.length,board.cards.length);assert.deepEqual(noAudio.cards.map(c=>c.source),board.cards.map(c=>c.source));
 });
 await test('unplaced timeline has no invented actual shots and can show source without approval',async()=>{
  const d=fixture();d.timelines.find(t=>t.id===d.activeTimelineId)!.items=[];
  const b=await productionStoryboard(d,'empty');assert(b.cards.every(c=>!c.actual.length&&c.actual_status==='not_placed'));
  const f=fake(d),page=await f.read(d,b,b.cards[0].id,'source',0);assert(page.images.length);assert(page.images.every(i=>i.status==='available'));assert.equal(f.counts().actual,0);
 });
 await test('adversarial: legal cross-kind IDs address their own reference images',async()=>{
  const d=structuredClone(phased.before) as unknown as ProjectDoc,a=d.clipMentorAnalysis!,id=a.blueprint[0].unit_id;
  const internal=a.blueprint[0].internal_review as any,sections=internal[internal.current_picture_plan].delivery_sections;
  const opening=sections.find((x:any)=>x.kind==='performance_opening');assert(opening);opening.section_id=id;
  const b=await productionStoryboard(d,'colliding'),unit=b.cards.find(c=>c.kind==='unit')!,section=b.cards.find(c=>c.kind==='opening')!;
  const before=JSON.stringify(d),subject=await(await import('../../src/clipmentor/production-gate')).copyReviewSubject(d);
  assert.equal(b.cards.length,new Set(b.cards.map(c=>c.id)).size,'card locators must be unique even when legal unit/section IDs coincide');
  const f=fake(d),page=await f.read(d,b,unit.id,'source',0);assert(page.images.length);assert(page.images.every(i=>i.status==='available'&&i.origin==='source'));
  const openingPage=await f.read(d,b,section.id,'source',0);assert(openingPage.images.some(i=>i.status==='available'&&i.origin==='supplied_full'));assert.equal(unit.subject_id,section.subject_id);assert.equal(JSON.stringify(d),before);assert.deepEqual(await(await import('../../src/clipmentor/production-gate')).copyReviewSubject(d),subject);
  assert.notEqual(unit.id,section.id);assert.equal(JSON.stringify(d.clipMentorAnalysis!.blueprint[0].unit_id),JSON.stringify(id));
 });
 await test('adversarial: exact selected stills retain their frame once, including fractional clocks',async()=>{
  for(const [fps,frame]of [[25,58],[30,246],[30000/1001,246],[60000/1001,492]]){
   const d=fixture(),a=d.clipMentorAnalysis!,at=frame/fps; a.source.fps=fps;
   const internal=a.blueprint[0].internal_review as any,candidate=internal[internal.current_script_candidate],plan=internal[internal.current_picture_plan];
   const line=candidate.lines.find((x:any)=>x.id==='BT-L05'),phase=plan.phases.find((x:any)=>x.line_id==='BT-L05');
   line.source_seconds[0]=at;phase.source_seconds[0]=at;phase.context_source_ranges[0].source_range_seconds=[at,at];
   const packet=await copyTeachingPacketFromDoc(d);assert(packet.units[0].picture_plan!.line_source_ranges.some(l=>l.context_source_ranges?.some(c=>c.source_range_seconds[0]===at)));
   const b=await productionStoryboard(d,'exact-frame');assert(b.cards[0].source.some(r=>r.line_ids.includes('BT-L05')&&r.source_seconds===at),`selected frame ${frame} at ${fps}fps must remain ${at}`);
  }
  const d=fixture(),a=d.clipMentorAnalysis!,internal=a.blueprint[0].internal_review as any,at=8.1999;
  internal[internal.current_script_candidate].lines.find((x:any)=>x.id==='BT-L05').source_seconds[0]=at;
  const phase=internal[internal.current_picture_plan].phases.find((x:any)=>x.line_id==='BT-L05');phase.source_seconds[0]=at;phase.context_source_ranges[0].source_range_seconds=[at,at];
  const board=await productionStoryboard(d,'between-frames');assert(board.cards[0].source.some(r=>r.line_ids.includes('BT-L05')&&r.source_seconds===245/30));
  const draft=makeDraft(d),digest='b'.repeat(64),ctx={...draft,templates:[],audio:[],getProjectId:()=> 'frame-tag',hostFetch:async()=>Response.json({digest,card_id:'unit:sample',part:'source',offset:0,next_offset:null,images:[{key:'selected',status:'available',base64:jpg,media_type:'image/jpeg',source_seconds:8.2,origin:'source'}],authority:'sampled_images_not_continuous_review'})} as never;
  const result=await execClipMentorAnalysisTool('read_clipmentor_analysis',{view:'storyboard',boardPart:'source',unitId:'unit:sample',boardDigest:digest},ctx) as any;assert.equal(result.__images[0].frame,246,'transport file tag must preserve the selected source frame too');
 });
 await test('adversarial: malformed mounted GET cannot kill the real Vite host',async()=>{
  const repo=process.cwd(),entry=join(root,'vite-read-guard.mts');
  await writeFile(entry,`import assert from 'node:assert/strict';import{createServer}from'vite';import{request}from'node:http';import{clipMentorProductionPlugin}from ${JSON.stringify(repo+'/server/plugins/clipmentor-production.ts')};
const server=await createServer({configFile:false,root:${JSON.stringify(root)},logLevel:'silent',server:{host:'127.0.0.1',port:0,hmr:false},plugins:[clipMentorProductionPlugin(async()=>{throw Error('worker forbidden')})]});await server.listen();const port=server.httpServer.address().port;
const get=(path,headers={})=>new Promise((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port,path,headers},res=>{res.resume();res.on('end',()=>resolve(res.statusCode))});req.on('error',reject);req.end()});
try{assert.equal(await get('/api/clipmentor/production-task'),403);for(const suffix of ['//[','//[?view=storyboard']){const status=await get('/api/clipmentor/production-task'+suffix,{Origin:'https://evil.example','Sec-Fetch-Site':'cross-site'});assert.equal(status,403);}assert.equal(await get('/api/clipmentor/production-task'),403);console.log('VITE_HOST_ALIVE');}finally{await server.close();}`);
  const run=await promisify(execFile)(process.execPath,['scripts/run-check.mjs',entry],{cwd:repo,timeout:30_000,maxBuffer:2_000_000});assert.match(run.stdout,/VITE_HOST_ALIVE/);
 });
 await test('source images are paged, preserve IDs, deduplicate extraction and never silently truncate',async()=>{
  const d=fixture(),b=await productionStoryboard(d,'paged'),f=fake(d),card=b.cards.find(c=>c.kind==='unit')!;
  let offset:number|null=0,total=0;do{const p=await f.read(d,b,card.id,'source',offset);assert(p.images.length<=6);assert.deepEqual(p.images.map(i=>i.key),card.source.slice(offset,offset+6).map(r=>r.key));total+=p.images.length;offset=p.next_offset;}while(offset!==null);
  assert.equal(total,card.source.length);const count=f.counts().source;await f.read(d,b,card.id,'source',0);assert.equal(f.counts().source,count);
  await assert.rejects(f.read(d,b,card.id,'source',99999),/offset/);
 });
 await test('missing/changed sources remain unavailable even after a cache hit',async()=>{
  const d=fixture(),b=await productionStoryboard(d,'missing'),f=fake(d),card=b.cards[0],ref=card.source[0],asset=d.assets.find(a=>a.id===ref.asset_id)!;
  await f.read(d,b,card.id,'source',0);f.files.set(asset.src.split('/').at(-1)!,'f'.repeat(64));
  const changed=await f.read(d,b,card.id,'source',0);assert(changed.images.every(i=>i.status==='unavailable'));
  f.files.clear();assert((await f.read(d,b,card.id,'source',0)).images.every(i=>i.status==='unavailable'));
 });
 await test('adversarial: re-bound pool media cannot masquerade as the old blueprint source',async()=>{
  const d=fixture(),asset=d.assets.find(a=>a.id===d.clipMentorAnalysis!.source.asset_id)!;
  asset.sourceContentHash='f'.repeat(64);
  await assert.rejects(productionStoryboard(d,'wrong-original'),/source_breakdown_not_ready/,'the original projection already rejects rebound source identity');
 });
 await test('adversarial: active plan context ranges are not lost behind the narrower line range',async()=>{
  const d=fixture(),a=d.clipMentorAnalysis!;
  const packet=await copyTeachingPacketFromDoc(d),contexts=packet.units[0].picture_plan!.line_source_ranges.flatMap(r=>r.context_source_ranges??[]);
  assert(contexts.length,'the existing projection must actually carry this declared context');
  const b=await productionStoryboard(d,'context');for(const c of contexts)assert(b.cards[0].source.some(r=>r.source_seconds===Math.floor(c.source_range_seconds[0]*a.source.fps)/a.source.fps));
 });
 await test('adversarial: a file changed during extraction is never cached as a valid source',async()=>{
  const d=fixture(),b=await productionStoryboard(d,'racing'),card=b.cards[0];let hash=d.assets.find(a=>a.id===card.source[0].asset_id)!.sourceContentHash!;
  const read=createStoryboardImages({resolve:n=>n,hash:async()=>hash,source:async()=>{hash='f'.repeat(64);return jpg;},actual:async()=>[]});
  assert((await read(d,b,card.id,'source',0)).images.every(i=>i.status==='unavailable'));
 });
 await test('actual images use exact saved positions, one batch per page and invalidate after native edits',async()=>{
  const d=placed(),b=await productionStoryboard(d,'actual'),f=fake(d),card=b.cards.find(c=>c.actual.length)!;assert(card);
  const page=await f.read(d,b,card.id,'actual',0);assert(page.images.every(i=>i.status==='available'));assert.equal(f.counts().actual,1,'one Chrome batch, not one browser per frame');
  await f.read(d,b,card.id,'actual',0);assert.equal(f.counts().actual,1);
  d.timelines[0].items[0].transform={x:9};const changed=await productionStoryboard(d,'actual');assert.notEqual(changed.digest,b.digest);assert.notEqual(changed.cards.find(c=>c.id===card.id)!.actual[0].key,card.actual[0].key);
 });
 await test('failed or mismatched native images are never reclassified as source or layout success',async()=>{
  const d=placed(),b=await productionStoryboard(d,'failure'),card=b.cards.find(c=>c.actual.length)!;const f=fake(d);
  const bad=createStoryboardImages({resolve:n=>n,hash:async file=>d.assets.find(a=>a.src.split('/').at(-1)===file)?.sourceContentHash??'a'.repeat(64),source:async()=>jpg,actual:async()=>[{frame:99999,base64:jpg}]});
  assert((await bad(d,b,card.id,'actual',0)).images.every(i=>i.status==='unavailable'));assert.equal(f.counts().actual,0);
 });
 await test('adversarial: concurrent native readers do not multiply rendering or return success while busy',async()=>{
  const d=placed(),b=await productionStoryboard(d,'parallel'),card=b.cards.find(c=>c.actual.length)!;let start!:()=>void,release!:()=>void,calls=0;
  const entered=new Promise<void>(r=>{start=r;}),blocked=new Promise<void>(r=>{release=r;});
  const read=createStoryboardImages({resolve:n=>n,hash:async f=>d.assets.find(a=>a.src.split('/').at(-1)===f)?.sourceContentHash??'a'.repeat(64),source:async()=>jpg,actual:async(_d,frames)=>{calls++;start();await blocked;return frames.map(frame=>({frame,base64:jpg}));}});
  const first=read(d,b,card.id,'actual',0);await entered;
  try{const second=await read(d,b,card.id,'actual',0);assert(second.images.length);assert(second.images.every(i=>i.status==='unavailable'&&i.reason==='storyboard_busy'));assert.equal(calls,1);}finally{release();}
  assert((await first).images.every(i=>i.status==='available'));assert((await read(d,b,card.id,'actual',0)).images.every(i=>i.status==='available'));assert.equal(calls,1);
 });
 await test('adversarial: thumbnail cache stays bounded and rechecks identity after eviction',async()=>{
  const d=fixture(),b=await productionStoryboard(d,'bounded'),card=b.cards[0],source=card.source[0];card.source=Array.from({length:75},(_,i)=>({...source,key:'cache-test-'+i,source_seconds:i/30}));
  const large='/9j/'+Buffer.alloc(400_000,1).toString('base64');let calls=0,hash=d.assets.find(a=>a.id===source.asset_id)!.sourceContentHash!;
  const read=createStoryboardImages({resolve:n=>n,hash:async()=>hash,source:async()=>{calls++;return large;},actual:async()=>[]});
  for(let offset=0;offset<card.source.length;offset+=6)assert((await read(d,b,card.id,'source',offset)).images.every(i=>i.status==='available'));
  assert.equal(calls,75);await read(d,b,card.id,'source',0);assert(calls>75,'least-recent thumbnails must have been evicted instead of retaining all 40MB');
  hash='f'.repeat(64);assert((await read(d,b,card.id,'source',0)).images.every(i=>i.status==='unavailable'));
 });
 await test('board is excluded from independent reviewer input and cannot change approval',async()=>{
  const d=fixture(),request=buildCopyTeachingReviewRequest([{case_id:'same',packet:await copyTeachingPacketFromDoc(d)}]),gate=await checkCopyProduction(d,'clipmentor');
  const b=await productionStoryboard(d,'isolation'),f=fake(d);await f.read(d,b,b.cards[0].id,'source',0);
  assert.deepEqual(buildCopyTeachingReviewRequest([{case_id:'same',packet:await copyTeachingPacketFromDoc(d)}]),request);assert.deepEqual(await checkCopyProduction(d,'clipmentor'),gate);
 });
 await test('existing read tool receives indexed metadata and images without writing the draft',async()=>{
  const d=fixture(),b=await productionStoryboard(d,'tool'),draft=makeDraft(d);let calls=0;
  const ctx={...draft,templates:[],audio:[],getProjectId:()=> 'tool',getCreativeMode:()=> 'clipmentor',hostFetch:async()=>{calls++;return Response.json({...b,board_url:'/board'});}} as never;
  const before=JSON.stringify(draft.getDoc()),result=await execClipMentorAnalysisTool('read_clipmentor_analysis',{view:'storyboard'},ctx) as any;
  assert(!result.error,JSON.stringify(result));assert.equal(result.storyboard.digest,b.digest);assert.equal(result.review_approved,false);assert.equal(JSON.stringify(draft.getDoc()),before);assert.equal(calls,1);
 });
 await test('adversarial: board arguments cannot be confused with review/evidence reads',async()=>{
  const d=fixture(),draft=makeDraft(d);let calls=0;const ctx={...draft,templates:[],audio:[],getProjectId:()=> 'mixed',hostFetch:async()=>{calls++;throw Error('must not fetch');}} as never;
  for(const args of [{view:'storyboard',reviewPart:'packet'},{view:'current_copy',boardDigest:'a'.repeat(64)},{view:'storyboard',packetOffset:0}]){
   const r=await execClipMentorAnalysisTool('read_clipmentor_analysis',args,ctx) as any;assert(r.error);
  }assert.equal(calls,0);
 });
 await test('adversarial: author strings cannot break out of the board script or become HTML',async()=>{
  const {storyboardPage}=await import('./storyboard-page');const b=await productionStoryboard(fixture(),'xss');b.title='</script><script>alert(1)</script>';b.cards[0].lines[0].ms='<img src=x onerror=alert(1)>';
  const html=storyboardPage(b,'fixed');new Script(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1]);assert(!html.includes(b.title));assert(!html.includes(b.cards[0].lines[0].ms));assert.match(html,/textContent/);assert.equal(html.match(/<script /g)?.length,1);
 });
 await test('real local source extraction and native saved-layout rendering are distinct, read-only and cached',async()=>{
  const {ffmpegBin}=await import('../media-binaries'),{sha256File}=await import('../../shared/node-content-hash'),{setUploadsDirProvider}=await import('../plugins/export-rendering');
  const media=join(root,'media/uploads');await mkdir(media,{recursive:true});const file=join(media,'synthetic-source.mp4');
  await promisify(execFile)(ffmpegBin(),['-v','error','-y','-f','lavfi','-i','testsrc2=size=96x160:rate=30:duration=37.266667','-c:v','libx264','-pix_fmt','yuv420p',file]);
  const hash=await sha256File(file),old=fixture().clipMentorAnalysis!.source.sourceContentHash;
  const d=JSON.parse(JSON.stringify(fixture()).replaceAll(old,hash)) as ProjectDoc,source=d.assets.find(a=>a.id===d.clipMentorAnalysis!.source.asset_id)!;
  Object.assign(source,{src:'/media/uploads/synthetic-source.mp4',width:96,height:160});
  const timeline=d.timelines.find(t=>t.id===d.activeTimelineId)!;Object.assign(timeline,{width:192,height:320,trackOrder:['video','background'],tracks:{background:{kind:'video'},video:{kind:'video'}}});
  timeline.items=[{id:'bg',name:'test yellow panel',kind:'solid',track:'background',startFrame:0,durationInFrames:60,width:192,height:320,props:{color:'#FFD83D'}},
   {id:'source',name:'synthetic pattern',kind:'video',track:'video',startFrame:0,durationInFrames:60,srcInFrame:0,volume:0,sourceAssetId:source.id,sourceContentHash:hash,src:source.src,width:96,height:160,transform:{scale:.65}}];
  d.timelines=[timeline];d.clipMentorAnalysis!.source_breakdown!.units[0].placement={timeline_id:timeline.id,original_frames:[0,30],explanation_frames:[30,60]};
  setUploadsDirProvider(()=>media);const b=await productionStoryboard(d,'synthetic-board'),reader=createStoryboardImages(),before=JSON.stringify(d),start=performance.now();
  const refs=await reader(d,b,b.cards[0].id,'source',0),native=await reader(d,b,b.cards[0].id,'actual',0);
  assert(refs.images.every(i=>i.status==='available'),JSON.stringify(refs.images.map(i=>i.status)));assert(native.images.every(i=>i.status==='available'),JSON.stringify(native.images));
  const sourceImage=refs.images[0],layoutImage=native.images[0];assert(sourceImage.status==='available'&&layoutImage.status==='available');assert.notEqual(sourceImage.base64,layoutImage.base64);
  const layoutFile=join(root,'layout.jpg');await writeFile(layoutFile,Buffer.from(layoutImage.base64,'base64'));const pixels=(await promisify(execFile)(ffmpegBin(),['-v','error','-i',layoutFile,'-f','rawvideo','-pix_fmt','rgb24','-'],{encoding:'buffer',maxBuffer:8_000_000})).stdout;assert(new Set(pixels).size>100,'native test video must remain visible above its yellow background');
  const firstMs=Math.round(performance.now()-start),warm=performance.now();assert.deepEqual(await reader(d,b,b.cards[0].id,'actual',0),native);const warmMs=Math.round(performance.now()-warm);
  assert.equal(JSON.stringify(d),before);assert.equal(await sha256File(file),hash);
  console.log('REAL_LOCAL_BOARD',JSON.stringify({firstMs,warmMs,sourceSamples:refs.images.length,nativeSamples:native.images.length,providerCalls:0}));
  // Compose the real host and original read endpoint, not only the isolated
  // helper/mocked fetch. Provider effects are forbidden throughout this read.
  const {withSerializedProjectStore}=await import('../plugins/project-store'),{loadOfflineStoredProject}=await import('../external-agent/offline-project-store'),{clipMentorProductionPlugin}=await import('../plugins/clipmentor-production');
  const {openHeadlessEditor}=await import('./headless-editor'),{projectServerRunToolResult}=await import('../../src/agent/serverRunToolResult'),{toolResultModelOutput}=await import('../../src/agent/tool-result-output');
  await withSerializedProjectStore(store=>store.writeEntry('project:board-host',d));
  const stored=await loadOfflineStoredProject('board-host'),app=createMiniConnect(e=>{throw e;}),server=createServer((req,res)=>app.handle(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address() as {port:number},origin='http://127.0.0.1:'+address.port;
  let effects=0;const plugin=clipMentorProductionPlugin(async()=>{throw Error('worker forbidden');});(plugin.configureServer as (s:any)=>void)({httpServer:server,config:{server:{}},middlewares:{use:(route:string,handler:any)=>app.use(route,handler)}});
  let host:Awaited<ReturnType<typeof openHeadlessEditor>>|undefined;
  try{
   host=await openHeadlessEditor({projectId:'board-host',runId:'read-only-test',origin,review:{provider:'openai',model:'forbidden',origin,apiMode:'responses'},browserConnected:()=>false,
    fetch:async(input,init)=>{const url=new URL(String(input));assert.equal(url.origin,origin);assert.equal(url.pathname,'/api/clipmentor/production-task');assert.equal(init?.method,'GET');assert.equal(url.searchParams.get('view'),'storyboard');return oldFetch(input,init);},
    effect:async()=>{effects++;throw Error('No provider effect allowed');}});
   const summary=await host.execute('read_clipmentor_analysis',{view:'storyboard'},'summary') as any;assert(!summary.error,JSON.stringify(summary));assert(summary.storyboard.cards.length);
   for(const part of ['source','actual']){
    const page=await host.execute('read_clipmentor_analysis',{view:'storyboard',boardPart:part,unitId:summary.storyboard.cards[0].id,boardDigest:summary.storyboard.digest},part) as any;assert(!page.error,JSON.stringify(page));assert.equal(page.__images.length,6);
    const model=toolResultModelOutput(projectServerRunToolResult(page));assert.equal(model.type,'content');if(model.type!=='content')throw Error('visual result missing');assert.equal(model.value.filter(p=>p.type==='file').length,6);
    const metadata=model.value.find(p=>p.type==='text');assert(metadata&&metadata.type==='text');assert.match(metadata.text,new RegExp(summary.storyboard.digest));assert.match(metadata.text,new RegExp(summary.storyboard.cards[0].id));
   }
   assert.equal(effects,0);assert.deepEqual(await loadOfflineStoredProject('board-host'),stored);console.log('HOST_CHAIN source=6 actual=6 JPEG file parts, original read/HTTP/headless/output, provider effects=0, saved doc unchanged');
  }finally{await host?.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  if(output){await mkdir(output,{recursive:true});await writeFile(join(output,'source.jpg'),Buffer.from(sourceImage.base64,'base64'));await writeFile(join(output,'actual.jpg'),Buffer.from(layoutImage.base64,'base64'));await writeFile(join(output,'board.json'),JSON.stringify(b));await writeFile(join(output,'source-page.json'),JSON.stringify(refs));await writeFile(join(output,'actual-page.json'),JSON.stringify(native));await writeFile(join(output,'synthetic-project.json'),JSON.stringify(d));await writeFile(join(output,'synthetic-source.mp4'),await readFile(file));await writeFile(join(output,'performance.json'),JSON.stringify({firstMs,warmMs,sourceSamples:refs.images.length,nativeSamples:native.images.length,providerCalls:0},null,2));}
 });
 await test('original HTTP entry is read-only, guarded, digest-bound and rejects mixed-version pages',async()=>{
  const {withSerializedProjectStore}=await import('../plugins/project-store'),{clipMentorProductionPlugin}=await import('../plugins/clipmentor-production');
  const d=fixture();await withSerializedProjectStore(s=>s.writeEntry('project:board-http',d));
  const app=createMiniConnect(e=>{throw e;}),server=createServer((req,res)=>app.handle(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');const addr=server.address() as {port:number},origin='http://127.0.0.1:'+addr.port;
  let workers=0;const plugin=clipMentorProductionPlugin(async()=>{workers++;throw Error('No production worker allowed');});
  (plugin.configureServer as (s:any)=>void)({httpServer:server,config:{server:{port:addr.port}},middlewares:{use:(route:string,handler:any)=>app.use(route,handler)}});
  const url=origin+'/api/clipmentor/production-task?view=storyboard&projectId=board-http';
  try{
   const fetch=oldFetch;
   assert.equal((await fetch(url)).status,403);
   assert.equal((await fetch(url,{headers:{Origin:'https://evil.example','Sec-Fetch-Site':'cross-site'}})).status,403);
   const headers={Origin:origin};const response=await fetch(url,{headers});assert.equal(response.status,200);const b=await response.json();assert(b.board_url.startsWith(origin+'/api/'));
   const html=await fetch(url+'&format=html',{headers});assert.equal(html.status,200);assert.match(html.headers.get('Content-Security-Policy')!,/default-src 'none'/);assert.match(await html.text(),/素材参考/);
   assert.equal((await fetch(url+'&part=source&cardId='+b.cards[0].id,{headers})).status,409);
   assert.equal((await fetch(url+'&part=source&cardId='+b.cards[0].id+'&expectedDigest='+'f'.repeat(64),{headers})).status,409);
   const edited=structuredClone(d);edited.timelines[0].items[0].transform={x:13};await withSerializedProjectStore(s=>s.writeEntry('project:board-http',edited));
   assert.equal((await fetch(url+'&expectedDigest='+b.digest,{headers})).status,409);await withSerializedProjectStore(s=>s.writeEntry('project:board-http',d));
   const huge=structuredClone(d);huge.clipMentorAnalysis!.product.name='x'.repeat(300_000);await withSerializedProjectStore(s=>s.writeEntry('project:board-http',huge));
   for(const suffix of ['', '&format=html']){const large=await fetch(url+suffix,{headers});assert.equal(large.status,409);assert.equal((await large.json()).error,'storyboard_metadata_too_large');}
   await withSerializedProjectStore(s=>s.writeEntry('project:board-http',d));
   const {loadOfflineStoredProject}=await import('../external-agent/offline-project-store'),before=await loadOfflineStoredProject('board-http');
   await fetch(url,{headers});assert.deepEqual(await loadOfflineStoredProject('board-http'),before);assert.equal(workers,0);
  }finally{await new Promise<void>(r=>server.close(()=>r()));}
 });
 assert.equal(network,0);
}finally{globalThis.fetch=oldFetch;if(oldData===undefined)delete process.env.OPENCHATCUT_DATA_DIR;else process.env.OPENCHATCUT_DATA_DIR=oldData;await rm(root,{recursive:true,force:true});}
if(tests.some(t=>!t.ok))throw Error(JSON.stringify(tests.filter(t=>!t.ok)));
console.log('storyboard zero-provider checks passed',tests.length);
