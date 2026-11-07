import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import saved from '../../src/clipmentor/fixtures/delivery-review-inputs-20261029.json';
import {assessSourceAlignment} from '../../src/clipmentor/source-alignment';
import {assessGroupReview} from '../../src/clipmentor/production-gate';
import {copyReviewDependencies,reviewClipMentorCopy,type ReviewFrame,type CopyReviewDependencies} from './copy-review';
import {apiCopyReviewDependencies} from './copy-review-api';
import {ffmpegBin,ffprobeBin} from '../media-binaries';
import type {CopyReviewRequest} from '../../shared/clipmentor-copy-review';
const exec=promisify(execFile),hash=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
const request=saved.request as unknown as CopyReviewRequest,unit=request.packet.units[0],raw=saved.raw_review;
const original=JSON.stringify(saved),pick=process.argv.find(a=>a.startsWith('--case='))?.slice(7);
const selected=(name:string)=>!pick||pick===name;
if(selected('refs')){
 const group=raw.copy_units[0].group_checks;
 const assessed=assessSourceAlignment(unit.source_context!,unit.points,unit.lines,group.source_relations) as ReturnType<typeof assessSourceAlignment>&{diagnostics?:Array<{code:string;relation_index:number;point_ids:string[];line_ids:string[];quoted_claim_refs:Array<{line_id:string;point_ids:string[];quote_matches:boolean}>}>};
 assert.equal(assessed.verdict,'insufficient_evidence');
 const details=assessed.diagnostics??[];
 assert(details.some(d=>d.relation_index===6&&d.code==='source_unknown_point_refs_missing'),'saved result must identify the empty outer point references');
 assert(details.some(d=>d.relation_index===6&&d.code==='source_unknown_line_refs_missing'),'saved result must identify the empty outer line references');
 const quoted=details.find(d=>d.relation_index===6)!.quoted_claim_refs;
 assert.deepEqual(quoted.map(c=>c.line_id),['BT-L01','BT-L02']);assert(quoted.every(c=>c.quote_matches&&c.point_ids.length));
 assert(!details.some(d=>d.relation_index===7),'a fully scoped non-impacting unknown must not be reported as missing');
 const grouped=assessGroupReview(group,unit) as ReturnType<typeof assessGroupReview>&{diagnostics?:unknown[]};assert.deepEqual(grouped.diagnostics,assessed.diagnostics);
 // Positive controls are explicit synthetic responses; never written to the saved raw result or a production receipt.
 const covered=group.source_relations.filter(r=>r.assessment==='covered');const base=structuredClone(covered[0]);
 const unknown={...base,assessment:'uncertain',relation:'Synthetic non-impacting detail',claim_impact:{status:'does_not_affect_current_claim',unknown_detail:'Synthetic unknown',reason:'Synthetic scoped positive',claims:[{line_id:'BT-L01',channel:'narration',quote:unit.lines[0].narration_ms}]}};
 assert.equal(assessSourceAlignment(unit.source_context!,unit.points,unit.lines,[base,unknown]).verdict,'pass');
 for(const change of [
  (r:any)=>{r.point_ids=[];},(r:any)=>{r.line_ids=[];},(r:any)=>{r.evidence_ids=[];},
  (r:any)=>{r.claim_impact.claims[0].quote='invented quotation';},(r:any)=>{r.claim_impact.claims[0].line_id='missing-line';},
  (r:any)=>{r.claim_impact.status='affects_current_claim';},(r:any)=>{r.claim_impact.status='unresolved';},
  (r:any)=>{r.point_ids=['BT-P02'];},(r:any)=>{r.evidence_ids=['not-real'];},
 ]){const bad=structuredClone(unknown);change(bad);assert.notEqual(assessSourceAlignment(unit.source_context!,unit.points,unit.lines,[base,bad]).verdict,'pass');}
 assert.equal(assessSourceAlignment(unit.source_context!,unit.points,unit.lines,[unknown]).verdict,'insufficient_evidence');
 assert.equal(assessSourceAlignment(unit.source_context!,unit.points,unit.lines,[base,unknown,{...base,assessment:'material_gap'}]).verdict,'needs_revision');
 assert.equal(JSON.stringify(saved),original,'diagnosis never fills missing reviewer references or changes the original verdict');
 console.log('Unknown references: frozen real failure diagnosed; scoped positive and missing/wrong/affecting/unresolved controls passed.');
}
if(selected('multi')){
 const covered=raw.copy_units[0].group_checks.source_relations.filter(r=>r.assessment==='covered').slice(0,2);
 const ids=[...new Set(covered.flatMap(r=>r.point_ids))],lineIds=[...new Set(covered.flatMap(r=>r.line_ids))];
 const unknown={relation:'Synthetic unrelated unknown checked against two supported claims',assessment:'uncertain',reason:'Synthetic regression only',evidence_ids:[...new Set(covered.flatMap(r=>r.evidence_ids))],point_ids:ids,line_ids:lineIds,
  claim_impact:{status:'does_not_affect_current_claim',unknown_detail:'Synthetic unclaimed detail',reason:'Each actual claim has its own covered evidence',claims:lineIds.map(id=>({line_id:id,channel:'narration',quote:unit.lines.find(l=>l.line_id===id)!.narration_ms}))}};
 assert.equal(assessSourceAlignment(unit.source_context!,unit.points,unit.lines,[...covered,unknown]).verdict,'pass','separate covered relations may support separate current claims');
 assert.notEqual(assessSourceAlignment(unit.source_context!,unit.points,unit.lines,[covered[0],unknown]).verdict,'pass');
 assert.notEqual(assessSourceAlignment(unit.source_context!,unit.points,unit.lines,[...covered,{...unknown,point_ids:['BT-P05']}]).verdict,'pass');
 console.log('Independent claim scopes: supported multi-claim references pass; lost evidence and unrelated IDs remain blocked.');
}
if(selected('crop')){
 const dir=await mkdtemp(join(tmpdir(),'copy-review-inputs-'));
 try{
  const picture=request.packet.delivery_sections![1].picture,crop=picture.crop!;
  // Synthetic image uses the real input dimensions, with distinct pixels so crop delivery cannot pass by relabeling the original.
  const width=1587,height=2003,bytes=Buffer.alloc(width*height*3);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*3;bytes[i]=x%256;bytes[i+1]=y%256;bytes[i+2]=(x+y)%256;}
  const input=join(dir,'poster.ppm');await writeFile(input,Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`),bytes]));
  const dependencies=copyReviewDependencies();
  const full=await dependencies.frame(input,0,join(dir,'full.jpg'));
  const cropped=await (dependencies.frame as (file:string,seconds:number,output:string,crop:typeof picture.crop)=>Promise<string>)(input,0,join(dir,'crop.jpg'),crop);
  const dimensions=async(path:string)=>JSON.parse((await exec(ffprobeBin(),['-v','error','-show_entries','stream=width,height','-of','json',path])).stdout).streams[0];
  assert.deepEqual(await dimensions(join(dir,'crop.jpg')),{width:400,height:360},'apply normalized crop to original pixels before source-image downscaling');
  assert.notEqual(hash(Buffer.from(full,'base64')),hash(Buffer.from(cropped,'base64')),'a crop label on unchanged bytes is not a cropped image');
  await exec(ffmpegBin(),['-nostdin','-v','error','-y','-i',input,'-vf','crop=400:360:432:550:exact=1','-frames:v','1','-q:v','4',join(dir,'expected.jpg')]);
  assert.equal(hash(await readFile(join(dir,'crop.jpg'))),hash(await readFile(join(dir,'expected.jpg'))),'normalized crop matches independent explicit pixel crop');
  for(const bad of [{...crop,left:NaN},{...crop,left:-0.1},{...crop,right:0.9},{...crop,bottom:1},{...crop,left:'0.2'}])await assert.rejects((dependencies.frame as any)(input,0,join(dir,'bad.jpg'),bad));
  let fakeModelCalls=0;let observed:ReviewFrame[]=[];let prompt='';
  const deps:CopyReviewDependencies={...dependencies,directory:join(dir,'ledger'),resolve:name=>name,hash:async file=>file===picture.src.split('/').at(-1)?picture.sha256:file===request.packet.delivery_sections![0].picture.src.split('/').at(-1)?request.packet.delivery_sections![0].picture.sha256:file.endsWith('.mp3')?request.packet.delivery_sections![1].voice.existing_audio!.sha256:request.source.hash,
   frame:async(file,seconds,out,c)=>file===picture.src.split('/').at(-1)?(dependencies.frame as any)(input,seconds,out,c):full,
   run:async(p,frames)=>{fakeModelCalls++;prompt=p;observed=frames;return structuredClone(raw);}};
  const result=await reviewClipMentorCopy(request,deps);
  const delivery=observed.filter(f=>f.phase==='delivery');assert.equal(delivery.length,3,'full sales image + full poster + actual planned poster crop');
  const croppedFrame=delivery.find(f=>(f as any).delivery_view==='planned_crop');assert(croppedFrame,'crop must have a distinct host-generated identity');assert.equal(croppedFrame.asset_id,picture.asset_id);assert.equal(hash(Buffer.from(croppedFrame.base64,'base64')),hash(Buffer.from(cropped,'base64')));
  assert(prompt.includes('point_ids和line_ids均须非空'));assert(prompt.includes('裁后图'));
  assert.equal(result.receipt.verdict,saved.saved_verdict);assert.deepEqual(result.receipt.delivery_checks,raw.delivery_checks);
  assert.equal((await reviewClipMentorCopy(request,deps,undefined,true)).cached,true);assert.equal(fakeModelCalls,1);
  const ledger=JSON.parse(await readFile(join(dir,'ledger',request.operationId+'.json'),'utf8'));assert.deepEqual(ledger.raw_review,raw,'saved original failure not repaired into approval');
  const inspection=(result.inspection as any).delivery_images;assert(Array.isArray(inspection)&&inspection.length===3);assert(inspection.some((i:any)=>i.view==='planned_crop'&&i.asset_id===picture.asset_id&&i.sha256===hash(Buffer.from(cropped,'base64'))));
  let apiCalls=0;let apiContent:any[]=[];
  const api=apiCopyReviewDependencies({provider:'openai',model:'fake-never-network',origin:'http://localhost',apiMode:'responses'},(async(opts:any)=>{apiCalls++;apiContent=opts.messages[0].content;return{text:JSON.stringify(raw)};}) as any,{} as any);
  await api.run(prompt,observed,randomUUID(),'synthetic',new AbortController().signal);assert.equal(apiCalls,1);assert.equal(apiContent.filter(i=>i.type==='image').length,observed.length);assert(apiContent.some(i=>i.type==='text'&&i.text.includes('planned_crop')));
  const failedRequest={...request,operationId:randomUUID()};
  await assert.rejects(reviewClipMentorCopy(failedRequest,{...deps,run:async()=>({bad:'synthetic invalid reviewer output'})}));
  const failure=JSON.parse(await readFile(join(dir,'ledger',failedRequest.operationId+'.json'),'utf8'));assert.equal(failure.status,'failed');assert.equal(failure.requests_attempted,1);assert.deepEqual(failure.image_inspection,result.inspection,'failure keeps exactly what images were sent without inventing new evidence');
  let forbiddenCalls=0;
  const unavailable={...request,operationId:randomUUID()};await assert.rejects(reviewClipMentorCopy(unavailable,{...deps,frame:async(file,s,out,c)=>{if(c)throw new Error('Synthetic crop extraction failure');return deps.frame(file,s,out);},run:async()=>{forbiddenCalls++;throw new Error('must not run');}}));
  const refused=JSON.parse(await readFile(join(dir,'ledger',unavailable.operationId+'.json'),'utf8'));assert.equal(refused.requests_attempted,0);assert.equal(refused.diagnostic.code,'frames_unavailable');assert.equal(forbiddenCalls,0,'missing crop must stop before paid provider reservation');
  console.log('Crop: real ffmpeg pixels/400x360, invalid crop controls, original service + fake API save/read, unmodified saved verdict passed; real provider calls 0.');
 }finally{await rm(dir,{recursive:true,force:true});}
}
