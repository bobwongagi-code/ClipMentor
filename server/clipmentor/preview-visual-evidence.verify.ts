import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {previewVisualEvidence,visualEvidenceSamples,visualEvidenceFailure,collectSavedPreviewVisualEvidence} from './preview-visual-evidence';

const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const root=await mkdtemp(join(tmpdir(),'clipmentor-visual-verify-'));
try{
 const originalReceipt={status:'completed',operationId:'op',projectId:'project',videoSha256:'a'.repeat(64),full_film_accepted:false,
  result:{status:'review_required',original_judgment:'unchanged'},effective_review:{can_use_as_pass:false},visual_comparison:{status:'deferred'}};
 const originalReceiptBytes=JSON.stringify(originalReceipt);let reads=0;
 const supplemented=await collectSavedPreviewVisualEvidence(originalReceipt,async args=>{
  reads++;assert.deepEqual(args,{action:'read',operationId:'op',videoSha256:'a'.repeat(64),includeVisualEvidence:true});
  return {...originalReceipt,result:{status:'pass',original_judgment:'not allowed to overwrite'},effective_review:{can_use_as_pass:true},
   visual_comparison:{status:'collected',full_film_accepted:false}};
 });
 assert.equal(reads,1);assert.deepEqual(supplemented.result,originalReceipt.result);assert.deepEqual(supplemented.effective_review,originalReceipt.effective_review,'local collection cannot upgrade an independent negative judgment');
 assert.equal(JSON.stringify(originalReceipt),originalReceiptBytes,'supplementing does not mutate the paid receipt');
 const passedReceipt={...originalReceipt,result:{status:'pass',original_judgment:'saved pass'},effective_review:{status:'pass',can_use_as_pass:true,blockers:[]}};
 const invalidated=await collectSavedPreviewVisualEvidence(passedReceipt,async()=>({...passedReceipt,
  effective_review:{status:'review_required',can_use_as_pass:false,blockers:['saved_evidence_invalid_or_binding_mismatch']},
  visual_comparison:{status:'not_collected',code:'manifest_changed',full_film_accepted:false}}));
 assert.equal((invalidated.effective_review as any).can_use_as_pass,false,'new evidence invalidation must downgrade an old derived pass');
 assert.deepEqual(invalidated.result,passedReceipt.result,'downgrade keeps the original model judgment');
 for(const read of [async()=>{throw Error('local timeout');},async()=>({...originalReceipt,projectId:'other',visual_comparison:{status:'collected',full_film_accepted:false}})]){
  const incomplete=await collectSavedPreviewVisualEvidence(originalReceipt,read);
  assert.equal((incomplete.visual_comparison as any).status,'not_collected');assert.deepEqual(incomplete.result,originalReceipt.result);
 }
 let unnecessaryReads=0;
 const unexpectedRead=async()=>{unnecessaryReads++;throw Error('must not read');};
 await collectSavedPreviewVisualEvidence({...originalReceipt,visual_comparison:undefined},unexpectedRead);
 await collectSavedPreviewVisualEvidence({...originalReceipt,status:'pending'},unexpectedRead);
 assert.equal(unnecessaryReads,0,'legacy or incomplete receipts must not silently trigger supplemental work');
 const bytes=Buffer.from('immutable export fixture'),file=join(root,'preview.mp4');await writeFile(file,bytes);
 const ref=await sharp({create:{width:90,height:160,channels:3,background:'#0d5ea6'}}).jpeg().toBuffer();
 const actual=await sharp({create:{width:90,height:160,channels:3,background:'#ffd83d'}}).jpeg().toBuffer();
 const input={duration_seconds:10,points:[{point_id:'delivery/criterion/style',teaching_goal_zh:'核对标识',product_relevance:'交付要求'}],
  units:[{unit_id:'U1',point_ids:['delivery/criterion/style'],output_range_seconds:[0,5]},
   {unit_id:'U2',point_ids:['delivery/criterion/style'],output_range_seconds:[5,10]}],reference_text:[],
  visual_criteria:[{point_id:'delivery/criterion/style',quote:'蓝底白字 <script>bad()</script>',question:'原片是否蓝底白字？',pictureStage:'原片',fileName:'认可参照.jpg',seconds:0,base64:ref.toString('base64')}]};
 const manifest={fps:30,total_frames:300,scenes:[{kind:'original',start_frame:0,end_frame:300,content:0}]};
 const frozen=JSON.stringify({input,manifest});let calls=0;
 const io={hash:async(p:string)=>hash(await readFile(p)),frame:async(_p:string,seconds:number,_out:string,signal?:AbortSignal)=>{
  assert(signal&&!signal.aborted);assert(seconds>=0&&seconds<10);calls++;return actual.toString('base64');
 }};
 const first=await previewVisualEvidence('fixture',file,hash(bytes),input,manifest,io,join(root,'artifacts'));
 assert.equal(first.status,'collected');assert.equal(first.frame_count,6);assert.equal(first.unit_count,2);assert.equal(first.full_film_accepted,false);
 const html=await readFile(first.path!,'utf8');assert(html.includes('U1')&&html.includes('U2'));
 assert(html.includes('&lt;script&gt;bad()&lt;/script&gt;'));assert(!html.includes('<script>'));
 assert(html.includes('实际导出')&&html.includes('90×160'));assert(!html.includes('已匹配'));
 const images=[...html.matchAll(/src="data:image\/jpeg;base64,([^"]+)"/g)].map(m=>Buffer.from(m[1],'base64'));
 const colors=await Promise.all(images.slice(0,2).map(async b=>(await sharp(b).stats()).dominant));
 assert(colors[0].b>colors[0].r,'left really contains reference pixels');assert(colors[1].r>colors[1].b,'right really contains exported pixels, not reference duplicated');
 assert.equal((await previewVisualEvidence('fixture',file,hash(bytes),input,manifest,io,join(root,'artifacts'))).cached,true);
 assert.equal(calls,6,'cached read does not extract frames again');
 let parallelExtractions=0;
 const parallelIO={...io,frame:async()=>{parallelExtractions++;return actual.toString('base64');}};
 const parallel=await Promise.all([0,1].map(()=>previewVisualEvidence('fixture',file,hash(bytes),input,manifest,parallelIO,join(root,'parallel'))));
 assert.equal(parallelExtractions,6,'concurrent cold reads share the six actual frame extractions');
 assert.equal(parallel[0].identity,parallel[1].identity);
 let unblock!:()=>void,entered!:()=>void,sharedFrames=0;
 const blocked=new Promise<void>(resolve=>{unblock=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
 const sharedIO={...io,frame:async()=>{if(sharedFrames++===0){entered();await blocked;}return actual.toString('base64');}};
 const owner=previewVisualEvidence('fixture',file,hash(bytes),input,manifest,sharedIO,join(root,'waiter'));
 await started;const waiterCancel=new AbortController();
 const waiter=previewVisualEvidence('fixture',file,hash(bytes),input,manifest,sharedIO,join(root,'waiter'),waiterCancel.signal);
 waiterCancel.abort();await assert.rejects(waiter,/abort/i);unblock();
 assert.equal((await owner).status,'collected');assert.equal(sharedFrames,6,'waiter cancellation does not cancel or duplicate shared owner work');
 let releaseOwner!:()=>void,ownerEntered!:()=>void,ownerFrames=0;
 const ownerBlocked=new Promise<void>(resolve=>{releaseOwner=resolve;}),ownerStarted=new Promise<void>(resolve=>{ownerEntered=resolve;});
 const ownerCancel=new AbortController();
 const ownerIO={...io,frame:async()=>{if(ownerFrames++===0){ownerEntered();await ownerBlocked;}return actual.toString('base64');}};
 const firstOwner=previewVisualEvidence('fixture',file,hash(bytes),input,manifest,ownerIO,join(root,'owner-cancel'),ownerCancel.signal).then(value=>({value}),error=>({error}));
 await ownerStarted;
 const survivor=previewVisualEvidence('fixture',file,hash(bytes),input,manifest,ownerIO,join(root,'owner-cancel')).then(value=>({value}),error=>({error}));
 ownerCancel.abort();releaseOwner();
 const [ownerOutcome,survivorOutcome]=await Promise.all([firstOwner,survivor]);
 assert('error' in ownerOutcome,'cancelled requester stops waiting');
 assert('value' in survivorOutcome&&survivorOutcome.value.status==='collected','owner cancellation must not cancel another active subscriber');
 assert.equal(ownerFrames,6,'survivor reuses rather than restarts the shared extraction');
 let failures=0;
 const failingIO={...io,frame:async()=>{failures++;throw Error('secret must not escape');}};
 for(let i=0;i<2;i++)await assert.rejects(previewVisualEvidence('fixture',file,hash(bytes),input,manifest,failingIO,join(root,'negative-cache')));
 assert.equal(failures,1,'repeated receipt polls do not repeat known local failure');
 assert(!JSON.stringify(visualEvidenceFailure(Error('secret must not escape'))).includes('secret'));
 assert.deepEqual(visualEvidenceFailure(Error('visual_comparison_frame_limit:90/64')),{status:'not_collected',code:'frame_limit',reason:'本地对照超出取样上限，未截断生成。',frame_count:90,frame_limit:64,full_film_accepted:false});
 const cancel=new AbortController();let cancelledFrames=0,sawSignal=false;
 await assert.rejects(previewVisualEvidence('fixture',file,hash(bytes),input,manifest,{...io,frame:async(_p,_s,_out,signal)=>{
  cancelledFrames++;cancel.abort();sawSignal=signal!.aborted;return actual.toString('base64');
 }},join(root,'cancelled'),cancel.signal),/abort/i);
 assert.equal(cancelledFrames,1);assert(sawSignal);
 assert.equal(await access(join(root,'cancelled')).then(()=>true,()=>false),false,'cancelled extraction cannot publish a comparison');
 assert.equal(JSON.stringify({input,manifest}),frozen,'no author fields or plan changes');assert.deepEqual(await readFile(file),bytes);
 await writeFile(first.path!,'corrupt');
 assert.equal((await previewVisualEvidence('fixture',file,hash(bytes),input,manifest,io,join(root,'artifacts'))).cached,false);
 assert.equal(calls,12,'corrupt evidence is rebuilt locally, not trusted');
 const edited=structuredClone(input);edited.visual_criteria[0].base64=actual.toString('base64');
 assert.notEqual((await previewVisualEvidence('fixture',file,hash(bytes),edited,manifest,io,join(root,'artifacts'))).identity,first.identity,'reference changes invalidate cache');
 await writeFile(file,'different export');
 await assert.rejects(previewVisualEvidence('fixture',file,hash(bytes),input,manifest,io,join(root,'artifacts')),/export_changed/);
 await writeFile(file,bytes);
 const during={...io,frame:async()=>{await writeFile(file,'changed during extraction');return actual.toString('base64');}};
 await assert.rejects(previewVisualEvidence('fixture',file,hash(bytes),input,manifest,during,join(root,'during')),/export_changed/);
 await writeFile(file,bytes);
 await assert.rejects(previewVisualEvidence('fixture',file,hash(bytes),input,manifest,{...io,frame:async()=>''},join(root,'empty')),/frame_invalid/);
 await assert.rejects(previewVisualEvidence('fixture',file,hash(bytes),input,manifest,{...io,frame:async()=>{throw Error('failed extraction');}},join(root,'failed')),/failed extraction/);
 const missing=structuredClone(input);missing.units=[];
 assert.throws(()=>visualEvidenceSamples(missing,manifest));
 const unmapped={...input,points:[...input.points,{point_id:'other',teaching_goal_zh:'其他',product_relevance:'其他'}],units:input.units.map(u=>({...u,point_ids:['other']}))};
 assert.throws(()=>visualEvidenceSamples(unmapped,manifest),/unmapped_reference/);
 const overflow={...input,units:Array.from({length:30},(_,i)=>({unit_id:'U'+i,point_ids:input.units[0].point_ids,output_range_seconds:[i/3,(i+1)/3]}))};
 assert.throws(()=>visualEvidenceSamples(overflow,manifest),/frame_limit/,'do not silently omit later units');
 const frameInput={...input,duration_seconds:31/30,units:[{...input.units[0],output_range_seconds:[0,31/30]}]};
 const frameManifest={fps:30,total_frames:31,scenes:[{kind:'original',start_frame:0,end_frame:31,content:0}]};
 assert.deepEqual(visualEvidenceSamples(frameInput,frameManifest).frames,[0,15,30],'integer frame roundoff cannot advance the last sample to EOF');
 assert.equal(visualEvidenceSamples({...input,units:[{...input.units[0],output_range_seconds:[31/30,2]}]},manifest).frames[0],31,'integer start does not skip a frame');
 assert.equal(visualEvidenceSamples({...input,units:[{...input.units[0],output_range_seconds:[(31+1e-7)/30,2]}]},manifest).frames[0],32,'real subframe offsets are not rounded away');
 const layer={item_id:'brief-label',track:'text',kind:'text',origin:'authored',item_start_frame:30,item_end_frame:32,layout_digest:'a'.repeat(64),render_digest:'b'.repeat(64),render_state:{props:{text:'Video asal'}}};
 const textManifest={...manifest,scenes:[{kind:'composition',start_frame:0,end_frame:30,layers:[]},{kind:'composition',start_frame:30,end_frame:32,layers:[layer]},{kind:'composition',start_frame:32,end_frame:300,layers:[]}]};
 assert(visualEvidenceSamples(input,textManifest).frames.includes(30),'short-lived text missed by first/middle/last remains sampled');
 assert.deepEqual(await previewVisualEvidence('fixture',file,hash(bytes),{...input,visual_criteria:undefined},manifest,io,join(root,'none')),{status:'not_applicable',full_film_accepted:false},'legacy plans need no new reference');
 console.log('Visual comparison: actual/reference pixels, all units, native text sampling, immutable input, warm cache, stale/corrupt media, malformed/empty/failed extraction, escaping, overflow and legacy compatibility passed; zero external calls.');
}finally{await rm(root,{recursive:true,force:true});}
