import assert from 'node:assert/strict';
import{mkdtemp,mkdir,copyFile,readFile,writeFile,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{execFile}from'node:child_process';import{promisify}from'node:util';import{randomUUID,createHash}from'node:crypto';
import saved from '../../src/clipmentor/fixtures/delivery-review-inputs-20261029.json';
import type{CopyReviewRequest}from'../../shared/clipmentor-copy-review';
const dir=await mkdtemp(join(tmpdir(),'copy-review-frame-regression-')),oldDir=process.env.OPENCHATCUT_DATA_DIR,oldFetch=globalThis.fetch;process.env.OPENCHATCUT_DATA_DIR=dir;let network=0;globalThis.fetch=async()=>{network++;throw Error('Network forbidden');};
try{
 const{reviewClipMentorCopy,copyReviewDependencies,CopyReviewError}=await import('./copy-review');const{isCopyReviewFailure}=await import('../../shared/clipmentor-copy-review');const{ffmpegBin}=await import('../media-binaries');const exec=promisify(execFile),real=copyReviewDependencies(),checks:Array<{name:string;ok:boolean;error?:string}>=[];
 const test=async(name:string,fn:()=>Promise<void>)=>{try{await fn();checks.push({name,ok:true});console.log('PASS',name);}catch(e){checks.push({name,ok:false,error:String(e)});console.error('FAIL',name,String(e));}};
 const clip=join(dir,'cfr-30.mp4');await exec(ffmpegBin(),['-nostdin','-v','error','-f','lavfi','-i','testsrc2=s=96x64:r=30:d=2','-c:v','libx264','-pix_fmt','yuv420p','-y',clip]);
 for(const n of [0,2,59])await test('actual-CFR-frame-'+n,async()=>{
  const expected=join(dir,'expected-'+n+'.jpg');await exec(ffmpegBin(),['-nostdin','-v','error','-i',clip,'-vf',`select=eq(n\\,${n})`,'-frames:v','1','-q:v','4','-y',expected]);
  const image=await real.frame(clip,n/30,join(dir,'actual-'+n+'.jpg'));assert.equal(createHash('sha256').update(Buffer.from(image,'base64')).digest('hex'),createHash('sha256').update(await readFile(expected)).digest('hex'),'must inspect the requested frame, never the next one or EOF');
 });
 for(const [rate,fps,count]of [['24',24,48],['25',25,50],['30000/1001',30000/1001,60],['60000/1001',60000/1001,60]]as const){
  const source=join(dir,'cfr-'+rate.replace('/','-')+'.mp4');
  await exec(ffmpegBin(),['-nostdin','-v','error','-f','lavfi','-i',`testsrc2=s=96x64:r=${rate}`,'-frames:v',String(count),'-c:v','libx264','-pix_fmt','yuv420p','-y',source]);
  for(const n of [0,2,count-1])await test(`review-CFR-${rate}-frame-${n}`,async()=>{
   const expected=join(dir,`expected-${fps}-${n}.jpg`);
   await exec(ffmpegBin(),['-nostdin','-v','error','-i',source,'-vf',`select=eq(n\\,${n})`,'-frames:v','1','-q:v','4','-y',expected]);
   const actual=await real.frame(source,n/fps,join(dir,`actual-${fps}-${n}.jpg`));
   assert.equal(createHash('sha256').update(Buffer.from(actual,'base64')).digest('hex'),createHash('sha256').update(await readFile(expected)).digest('hex'),'seek must produce the requested pixels at ordinary and fractional frame rates');
  });
 }
 await test('review-invalid-source-times-are-refused-before-extraction',async()=>{
  for(const seconds of [NaN,Infinity,-0.1])await assert.rejects(real.frame(clip,seconds,join(dir,'invalid.jpg')),/Invalid source frame seek/);
 });
 await test('headless-source-frame-save-uses-the-last-frame-and-persists-its-identity',async()=>{
  const {openHeadlessEditor}=await import('./headless-editor'),{uploadDir}=await import('../media-dir');
  const {projectDoc,projectId,MemoryPersistence}=await import('../external-agent/offline-runtime.verify-fixtures');
  await mkdir(uploadDir(),{recursive:true});await copyFile(clip,join(uploadDir(),'saved-source.mp4'));
  const doc=projectDoc(96,64),sourceHash=await real.hash(clip);
  doc.assets.push({id:'source-cfr',name:'Synthetic source',kind:'video',src:'/media/uploads/saved-source.mp4',durationInFrames:60,width:96,height:64,sourceContentHash:sourceHash});
  const persistence=new MemoryPersistence(doc),editor=await openHeadlessEditor({projectId,runId:'frame-regression',origin:'http://127.0.0.1:5199',review:{}as never,
   persistence,browserConnected:()=>false,effect:async()=>{throw Error('No model/tts/render effect is permitted');}});
  try{
   const result=await editor.execute('save_clipmentor_source_frame',{assetId:'source-cfr',seconds:59/30},'save-last')as any;
   assert.equal(result.saved,true);assert.equal(result.asset.props.sourceSeconds,59/30);assert.equal(result.asset.props.sourceHash,sourceHash);
   const actual=join(uploadDir(),result.asset.src.split('/').at(-1)),expected=join(dir,'expected-last-save.png');
   await exec(ffmpegBin(),['-nostdin','-v','error','-i',clip,'-vf','select=eq(n\\,59)','-frames:v','1','-y',expected]);
   const pixels=async(file:string)=>(await exec(ffmpegBin(),['-nostdin','-v','error','-i',file,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{encoding:null})).stdout;
   assert.deepEqual(await pixels(actual),await pixels(expected),'the saved asset is the real last-frame pixels');
   assert.equal(await real.hash(actual),result.asset.sourceContentHash);
   assert(persistence.current.assets.some(a=>a.id===result.asset.id&&a.sourceContentHash===result.asset.sourceContentHash));
  }finally{await editor.close();}
 });
 const request=()=>({...structuredClone(saved.request),operationId:randomUUID()})as unknown as CopyReviewRequest;let fakeModel=0;
 const fake=()=>({...real,directory:join(dir,'ledger'),resolve:(name:string)=>name,hash:async(file:string)=>{
  const r=saved.request as unknown as CopyReviewRequest;return r.packet.delivery_sections?.find(s=>s.picture.src.split('/').at(-1)===file)?.picture.sha256??r.packet.delivery_sections?.find(s=>s.voice.existing_audio?.src.split('/').at(-1)===file)?.voice.existing_audio?.sha256??r.source.hash;
 },frame:async()=> 'YQ==',run:async()=>{fakeModel++;return structuredClone(saved.raw_review);}});
 await test('source-failure-is-located-persisted-and-read-without-retry',async()=>{
  const r=request(),deps={...fake(),frame:async()=>{throw Error('/private/path and raw provider errors must stay private');}};let diagnostic:any;
  await assert.rejects(reviewClipMentorCopy(r,deps),e=>{assert(e instanceof CopyReviewError);diagnostic=e.diagnostic;assert.equal(diagnostic.frameFailure?.reason,'extraction_failed');assert.equal(diagnostic.frameFailure?.unit_id,r.packet.units[0].unit_id);assert(Number.isFinite(diagnostic.frameFailure?.source_seconds));return true;});
  assert(isCopyReviewFailure(diagnostic));assert.equal(diagnostic.requestsAttempted,0);assert(!JSON.stringify(diagnostic).includes('/private'));const ledger=JSON.parse(await readFile(join(deps.directory,r.operationId+'.json'),'utf8'));assert.deepEqual(ledger.diagnostic,diagnostic);
  await assert.rejects(reviewClipMentorCopy(r,deps,undefined,true),e=>{assert(e instanceof CopyReviewError);assert.deepEqual(e.diagnostic,diagnostic);return true;});assert.equal(fakeModel,0);
  delete ledger.diagnostic.frameFailure;await writeFile(join(deps.directory,r.operationId+'.json'),JSON.stringify(ledger));await assert.rejects(reviewClipMentorCopy(r,deps,undefined,true),e=>{assert(e instanceof CopyReviewError);assert.equal(e.diagnostic.code,'frames_unavailable');assert.equal(e.diagnostic.frameFailure,undefined);return true;});
 });
 await test('missing-delivery-asset-identifies-its-section',async()=>{
  const r=request(),s=r.packet.delivery_sections![0],deps={...fake(),resolve:(name:string)=>name===s.picture.src.split('/').at(-1)?null:name};
  await assert.rejects(reviewClipMentorCopy(r,deps),e=>{assert(e instanceof CopyReviewError);const f=e.diagnostic.frameFailure;assert.equal(f?.phase,'delivery');assert.equal(f?.unit_id,s.section_id);assert.equal(f?.asset_id,s.picture.asset_id);assert.equal(f?.reason,'asset_unavailable_or_changed');assert(isCopyReviewFailure(e.diagnostic));return true;});assert.equal(fakeModel,0);
 });
 await test('crop-failure-identifies-the-planned-cropped-view',async()=>{
  const r=request(),deps={...fake(),frame:async(_f:string,_s:number,_o:string,crop?:unknown)=>{if(crop)throw Error('Synthetic crop extractor failure');return 'YQ==';}};
  await assert.rejects(reviewClipMentorCopy(r,deps),e=>{assert(e instanceof CopyReviewError);assert.equal(e.diagnostic.frameFailure?.delivery_view,'planned_crop');assert.equal(e.diagnostic.frameFailure?.reason,'extraction_failed');assert(isCopyReviewFailure(e.diagnostic));return true;});assert.equal(fakeModel,0);
 });
 await test('malformed-frame-payload-is-distinct-from-extractor-failure',async()=>{
  const r=request(),deps={...fake(),frame:async()=> 'not base64!'};
  await assert.rejects(reviewClipMentorCopy(r,deps),e=>{assert(e instanceof CopyReviewError);assert.equal(e.diagnostic.frameFailure?.reason,'image_payload_invalid');assert(isCopyReviewFailure(e.diagnostic));assert(!isCopyReviewFailure({...e.diagnostic,frameFailure:{...e.diagnostic.frameFailure,source_seconds:-1}}));return true;});assert.equal(fakeModel,0);
 });
 await test('normal-complete-input-retains-saved-verdict-and-caches',async()=>{
  const r=request(),deps=fake(),result=await reviewClipMentorCopy(r,deps);assert.equal(result.receipt.verdict,saved.saved_verdict);assert.equal(fakeModel,1);assert.equal((await reviewClipMentorCopy(r,deps,undefined,true)).cached,true);assert.equal(fakeModel,1);
 });
 assert.equal(network,0);console.log(JSON.stringify({checks,network,real_provider_calls:0,fake_model_calls:fakeModel}));assert(checks.every(c=>c.ok));
}finally{globalThis.fetch=oldFetch;if(oldDir===undefined)delete process.env.OPENCHATCUT_DATA_DIR;else process.env.OPENCHATCUT_DATA_DIR=oldDir;await rm(dir,{recursive:true,force:true});}
