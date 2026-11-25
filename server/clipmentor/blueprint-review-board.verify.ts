import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,mkdir,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash,webcrypto} from 'node:crypto';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {runInNewContext,Script} from 'node:vm';
import {createServer} from 'node:http';import {once} from 'node:events';
import fixture from './fixtures/blueprint-review-board-20261031.json';
import type {BoardInput} from './blueprint-review-board';
import type {ProjectDoc} from '../../src/editor/types';
import {createMiniConnect} from '../../desktop/mini-connect';
const root=await mkdtemp(join(tmpdir(),'review-board-check-')),priorData=process.env.OPENCHATCUT_DATA_DIR,realFetch=globalThis.fetch;
process.env.OPENCHATCUT_DATA_DIR=root;let networks=0;globalThis.fetch=async()=>{networks++;throw Error('Network forbidden');};
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex'),clone=<T>(v:T):T=>structuredClone(v),exec=promisify(execFile);
const tests:Array<{name:string;pass:boolean;error?:string}>=[];
const test=async(name:string,fn:()=>Promise<void>)=>{try{await fn();tests.push({name,pass:true});console.log('PASS',name);}catch(e){tests.push({name,pass:false,error:String(e)});console.error('FAIL',name,String(e));}};
const c=fixture.cases;
const input=(value:unknown,bindings?:ProjectDoc[]):BoardInput=>({value,sha256:hash(JSON.stringify(value)),hashMode:'file',assertUnchanged:async()=>{},bindings});
try{
 const {loadReviewBoardInput,planReviewBoards,renderReviewBoards,REVIEW_BOARD_FRAME_LIMIT}=await import('./blueprint-review-board');
 assert.equal((await import('../runtime-profile')).runtimeProfile().rootDir,root,'all server imports must bind to temporary storage');
 const {deliveryPictureBindings,deliverySectionsFromDoc}=await import('../../src/clipmentor/delivery-sections');
 const {extractOneFrame}=await import('../plugins/extract-frames'),{ffmpegBin}=await import('../media-binaries');
 await test('Saved blueprint opinions preserve untouched scopes and name the exact confirmed sentence',async()=>{
  const {prepareBlueprintOpinions,blueprintOpinionDifferences,guardBlueprintOpinionWrite}=await import('./production-blueprint-opinions');
  const {panelReviewIssue}=await import('./production-panel-review');
  const doc=clone(c.newBinding) as unknown as ProjectDoc;
  const units=doc.clipMentorAnalysis!.blueprint;
  const line=(current:ProjectDoc,index:number)=>{
   const review=current.clipMentorAnalysis!.blueprint[index].internal_review as Record<string,any>;
   return review[review.current_script_candidate].lines[0];
  };
  Object.assign(line(doc,1),{narration_ms:'Kod kekal. Ayat ini agak panjang.',zh:'编号保留。这句略长。'});
  const prepare=(entry:{unitId:string|null;text:string;keepPlacement?:true})=>prepareBlueprintOpinions(doc,[entry],'revision','board');
  const praise=prepare({unitId:units[1].unit_id,text:'这组很好'});
  assert.equal(praise.confirmation,undefined);
  assert.equal(praise.record?.opinions[0].edits,false);
  assert.deepEqual(praise.record?.opinions[0].keep,[]);
  for(const text of ['好极了','👍','这组挺好']){
   const note=prepare({unitId:units[1].unit_id,text});
   assert.equal(note.record?.opinions[0].edits,false,text);
   assert.equal(note.confirmation,undefined);
  }
  assert(prepare({unitId:units[1].unit_id,text:'第一句不要改，第二句再短点'}).confirmation);
  assert.throws(()=>prepare({unitId:units[1].unit_id,text:'很好，图有点糊'}),/请写清/);
  assert.throws(()=>prepareBlueprintOpinions(doc,[{unitId:units[1].unit_id,text:'很好',remove:[1]}],'revision','board'),
   /blueprint_opinion_binding_invalid/);
  const reversed=clone(doc),last=reversed.clipMentorAnalysis!.blueprint.at(-1)!;
  const review=last.internal_review as Record<string,any>;
  const plan=review[review.current_picture_plan];
  const [original,firstPhase,secondPhase]=plan.phases;
  plan.phases=[original,secondPhase,firstPhase];
  const reversedOpinion=prepareBlueprintOpinions(reversed,[{unitId:last.unit_id,text:'第一句保留，第二句改短'}],'revision','board');
  assert.match(reversedOpinion.confirmation!.rows[0].keep[0],/^第 1 句 Selepas membandingkan warna/u);
  plan.phases=[original,firstPhase,secondPhase];
  assert.throws(()=>blueprintOpinionDifferences({...reversedOpinion.record!,confirmed:true},reversed),/第 1 句已确认保留/);

  const bilingual=prepare({unitId:units.at(-1)!.unit_id,text:'第二句保留，第一句改短'});
  const changedMeaning=clone(doc);
  const lastReview=changedMeaning.clipMentorAnalysis!.blueprint.at(-1)!.internal_review as Record<string,any>;
  lastReview[lastReview.current_script_candidate].lines[1].zh='不应改动的整段译文。';
  assert.throws(()=>blueprintOpinionDifferences({...bilingual.record!,confirmed:true},changedMeaning),/第 2 句已确认保留/);
  const legacy=clone(c.barelyV5);
  const legacyOpinion=prepareBlueprintOpinions(legacy as unknown as ProjectDoc,[{unitId:null,text:'标题改短'}],'revision','board').record!;
  const legacyRow=legacy.estimated_picture_timeline.rows.find(row=>row.kind==='explanation')!;
  legacyRow.picture='Unrequested legacy picture change.';
  assert.throws(()=>blueprintOpinionDifferences(legacyOpinion,legacy as unknown as ProjectDoc),/未收到修改意见/);
  assert.equal(prepare({unitId:units[1].unit_id,text:'第 1 组改短'}).placements[0].unitId,units[0].unit_id);
  assert.equal(prepare({unitId:null,text:'第 2 组改短'}).placements[0].unitId,units[1].unit_id);
  assert.equal(prepare({unitId:units[1].unit_id,text:'整体改短'}).placements[0].unitId,null);
  assert(prepare({unitId:units[1].unit_id,text:'整体改短',keepPlacement:true}).record);

  const group=prepare({unitId:units[1].unit_id,text:'第一句保留，第二句改短'});
  assert.deepEqual(group.confirmation?.rows[0].keep,['第 1 句 Kod kekal.（编号保留。）']);
  const next=clone(doc);
  Object.assign(line(next,1),{narration_ms:'Kod kekal. Ayat pendek.',zh:'编号保留。这句短。'});
  assert.throws(()=>blueprintOpinionDifferences(group.record!,next),/blueprint_opinion_confirmation_required/);
  const confirmed={...group.record!,confirmed:true};
  const differences=blueprintOpinionDifferences(confirmed,next);
  assert.equal(differences.overall,undefined);
  assert.deepEqual(differences.groups[0].kept.slice(0,1),['Kod kekal.（编号保留。）']);
  assert.deepEqual(differences.groups[0].changes,[{before:'Ayat ini agak panjang.（这句略长。）',after:'Ayat pendek.（这句短。）'}]);
  const lockBroken=clone(next);
  line(lockBroken,1).zh='保留号码。这句短。';
  assert.throws(()=>blueprintOpinionDifferences(confirmed,lockBroken),/第 1 句已确认保留/);
  line(lockBroken,1).narration_ms='Kod berubah. Ayat pendek.';
  assert.throws(()=>blueprintOpinionDifferences(confirmed,lockBroken),/第 1 句已确认保留/);
  assert.throws(()=>guardBlueprintOpinionWrite(confirmed,lockBroken),/^Error: blueprint_opinion_scope_locked/);
  assert.throws(()=>guardBlueprintOpinionWrite(clone(confirmed),lockBroken),error=>{
   assert.match(String(error),/blueprint_repair_no_progress/);
   assert.match(panelReviewIssue(error)?.message??'',/第 1 句已确认保留.*待维护侧/);
   return true;
  });
  const otherGroup=clone(next);
  line(otherGroup,0).narration_ms='Unrequested edit.';
  assert.throws(()=>blueprintOpinionDifferences(confirmed,otherGroup),/第 1 组未收到修改意见/);
  const otherPicture=clone(next);
  const third=otherPicture.clipMentorAnalysis!.blueprint[2].internal_review as Record<string,any>;
  third[third.current_picture_plan].phases[0].picture='Unrequested picture edit.';
  assert.throws(()=>blueprintOpinionDifferences(confirmed,otherPicture),/第 3 组未收到修改意见/);
  const changedSpeech=clone(next);
  changedSpeech.clipMentorAnalysis!.evidence.push({evidence_id:'fixture-unlinked-claim',kind:'original_claim',text:'New wording in group one.',
   source_ids:[changedSpeech.clipMentorAnalysis!.source.asset_id],supporting_evidence_ids:[],status:'candidate',source_range_seconds:[1,2]});
  assert.throws(()=>blueprintOpinionDifferences(confirmed,changedSpeech),/第 1 组未收到修改意见/);
  assert.throws(()=>prepare({unitId:units[1].unit_id,text:'第一句保留第二句改短'}),/请写清/);
  assert.equal(prepare({unitId:units[1].unit_id,text:'第一句不要删'}).record?.opinions[0].edits,false);
  const overall=prepare({unitId:null,text:'改一下标题'}).record!;
  assert.throws(()=>blueprintOpinionDifferences(overall,next),/第 2 组未收到修改意见/);
  const titleOnly=clone(doc);
  titleOnly.clipMentorAnalysis!.product.name='New fixture title';
  assert.throws(()=>blueprintOpinionDifferences(confirmed,titleOnly),/整体、片头或片尾未收到修改意见/);
  const global=blueprintOpinionDifferences(overall,titleOnly);
  assert.equal(global.overall?.label,'整体意见');
  assert.deepEqual(global.groups,[]);
  const removal=prepare({unitId:units[1].unit_id,text:'第二句保留，删掉第一句'});
  const shorter=clone(doc);
  Object.assign(line(shorter,1),{narration_ms:'Ayat ini agak panjang.',zh:'这句略长。'});
  assert.deepEqual(blueprintOpinionDifferences({...removal.record!,confirmed:true},shorter).groups[0].changes,
   [{before:'Kod kekal.（编号保留。）',after:''}]);
 });
 await test('Legacy review never checkpoints a rejected scoped revision as complete',async()=>{
  const {prepareBlueprintOpinions}=await import('./production-blueprint-opinions');
  const {advanceProductionTask,createProductionTask,productionTaskStore}=await import('./production-task');
  const {loadOfflineStoredProject}=await import('../external-agent/offline-project-store');
  const {setStoredEntry}=await import('../plugins/project-store');
  const projectId='scoped-opinion-publication',doc=clone(c.newBinding) as unknown as ProjectDoc;
  await setStoredEntry('project:'+projectId,doc);
  const base=(await loadOfflineStoredProject(projectId))!;
  const sourceAssetId=base.doc.clipMentorAnalysis!.source.asset_id;
  const api={provider:'openai' as const,model:'fixture',apiMode:'responses' as const};
  const task=await createProductionTask({projectId,sourceAssetId,product:{name:'Fixture',category:'test'},
   author:api,reviewer:api,brief:'Fixture',humanBlueprintReview:true,
   budget:{model:1,observation:0,review:0,tts:0,render:0,maxElapsedMs:60000,maxRepairs:0}});
  const unitId=base.doc.clipMentorAnalysis!.blueprint[1].unit_id;
  const prepared=prepareBlueprintOpinions(base.doc,[{unitId,text:'第二句改短'}],base.revision,'fixture-board');
  task.blueprintOpinions=prepared.record;
  const bad=clone(base.doc);
  bad.clipMentorAnalysis!.product.name='Unrequested overall change';
  await setStoredEntry('project:'+projectId,bad);
  const changed=(await loadOfflineStoredProject(projectId))!;
  task.stage='copy_review';task.projectRevision=changed.revision;
  await productionTaskStore.save(task);
  await advanceProductionTask(task,async current=>{
   assert.equal(current.stage,'copy_review');
   return {artifact:{revision:changed.revision,authorSelfCheck:'passed',gate:{allowed:true}}};
  });
  const blocked=await productionTaskStore.load(projectId,task.taskId);
  assert.equal(blocked.status,'blocked');
  assert.match(blocked.error??'',/blueprint_opinion_scope_overall/);
  assert.equal(blocked.completed.copy_review,undefined);
 });
 await test('A2/A3 real v3 current pointers, exact phases and prose-only frame conflict',async()=>{
  const v=clone(c.green),before=JSON.stringify(v),result=planReviewBoards(input(v,[c.newBinding,c.existingBinding] as unknown as ProjectDoc[]));assert.equal(result.plans.length,2);
  for(const plan of result.plans){assert.equal(plan.rows.length,13);assert.deepEqual(plan.rows.map(r=>r.stage),['opening','original','explanation','original','explanation','original','explanation','original','explanation','original','explanation','explanation','closing']);assert.equal(plan.rows.flatMap(r=>r.lines).length,8);assert.equal(plan.frame_count,35);const g1=plan.rows.find(r=>r.line_ids.includes('GM-L01'))!;assert.deepEqual(g1.range,[0,10.5]);assert.deepEqual(g1.frames.map(f=>f.frame),[0,157,314]);assert(g1.picture.includes('源帧21')&&g1.picture.includes('195'));assert(g1.notices.some(s=>/散文提到具体帧|画面说明提到指定画面/u.test(s)));assert(!g1.frames.some(f=>f.frame===21||f.frame===195));assert.deepEqual(g1.colors,['#FFD83D','#111111']);}
  const {blueprintPictureNotices}=await import('../../src/clipmentor/blueprint-picture-notices');
  const prepared=planReviewBoards(input(v,[c.newBinding,c.existingBinding] as unknown as ProjectDoc[])),{humanBoardQuestions}=await import('./blueprint-review-board-human');
  for(const plan of prepared.plans){const notices=blueprintPictureNotices(plan.rows.map(r=>({...r,location:r.key}))),reported=prepared.lint.findings.filter(f=>f.rule_id==='B10'||f.rule_id==='B11');assert(notices.length>0);assert.deepEqual(notices.map(n=>n.message),reported.map(n=>n.message));const questions=humanBoardQuestions(plan);for(const notice of notices)for(const key of notice.row_keys){const row=plan.rows.find(r=>r.key===key)!;assert(!questions.get(row.unit_id)?.has(notice.message));assert(row.notices.includes(notice.message));}}
  assert.equal(JSON.stringify(v),before);
 });
 await test('Shared notices remain identical for current and legacy saved plans',async()=>{
  const {blueprintPictureNotices}=await import('../../src/clipmentor/blueprint-picture-notices'),{humanBoardQuestions}=await import('./blueprint-review-board-human');
  for(const [value,materials]of [[c.green,[c.newBinding,c.existingBinding]],[c.barelyFour,undefined],[c.barelyV5,[c.barelyFour]]] as const){
   const result=planReviewBoards(input(value,materials as unknown as ProjectDoc[]));
   for(const plan of result.plans){
    const notices=blueprintPictureNotices(plan.rows.map(r=>({...r,location:r.key}))),findings=result.lint.findings.filter(f=>f.rule_id==='B10'||f.rule_id==='B11'),questions=humanBoardQuestions(plan);
    assert.deepEqual(notices.map(n=>n.message),findings.map(f=>f.message));
    for(const notice of notices)for(const key of notice.row_keys){const row=plan.rows.find(r=>r.key===key)!;assert(!questions.get(row.unit_id)?.has(notice.message));}
   }
  }
 });
 await test('Human board keeps capacity estimates and binding repairs out of business decisions',async()=>{
  const {humanReviewBoardPage}=await import('./blueprint-review-board-human');
  const {plans,data,lint}=planReviewBoards(input(c.green,[c.newBinding,c.existingBinding] as unknown as ProjectDoc[]));
  const group=lint.groups.find(g=>g.line_ids.includes('GM-L02'))!;
  const report={...lint,groups:[{...group,complete:true,estimated_seconds:13.73,picture_seconds:2.9,empirical_lower_seconds:12.1}],
   findings:[...lint.findings,{rule_id:'DELIVERY_BINDING',level:'warn' as const,location:'delivery_sections.fixture',excerpt:'fixture',message:'existing_partner_pdf_binding'}]};
  const html=humanReviewBoardPage(plans[0],data,report);
  assert.doesNotMatch(html,/估算可能偏长|是否偏紧|缺独立 Storyboard PDF 交付绑定|画面说明相同，是否/);
  assert.match(html,/模型听写，未经人工听审/);
 });
 await test('A4 actual four-group middle and historical full v5 reuse retain separate source facts',async()=>{
  const four=planReviewBoards(input(c.barelyFour)).plans[0];assert.equal(four.rows.filter(r=>r.stage==='original').length,4);assert(four.reuse.some(r=>r.row_keys.some(k=>four.rows.find(v=>v.key===k)?.line_ids.includes('BT-L04'))&&r.row_keys.some(k=>four.rows.find(v=>v.key===k)?.line_ids.includes('BT-L06'))));
  // Historical v5 has a source-video invitation; the saved four-group middle
  // contains no invitation. Never fabricate one in the four-group record.
  const old=planReviewBoards(input(c.barelyV5,[c.barelyFour as unknown as ProjectDoc])).plans[0];assert(old.reuse.some(r=>{const rows=r.row_keys.map(k=>old.rows.find(v=>v.key===k)!);return rows.some(v=>v.stage==='original')&&rows.some(v=>v.line_ids.includes('BT-L01'))&&rows.some(v=>v.line_ids.includes('BT-L05'));}));
 });
 await test('Declared point ranges retain a single frame and show repeated still reuse',async()=>{
  const value=clone(c.green),i=value.clipMentorAnalysis.blueprint[0].internal_review as any;i[i.current_picture_plan].phases[1].source_range_seconds=[0.7,0.7];
  const board=planReviewBoards(input(value,[c.newBinding,c.existingBinding] as unknown as ProjectDoc[])).plans[0],still=board.rows.find(r=>r.line_ids.includes('GM-L01'))!;assert.deepEqual(still.frames.map(f=>f.frame),[21]);assert(board.reuse.some(r=>r.range[0]===0.7&&r.range[1]===0.7&&r.row_keys.includes(still.key)));
 });
 await test('R1 current candidate wins and conflicting convenience copies are rejected',async()=>{
  const v=clone(c.green);v.narration_and_captions.find(l=>l.id==='GM-L01')!.narration_ms='A stale convenience copy';assert.throws(()=>planReviewBoards(input(v,[c.newBinding,c.existingBinding] as unknown as ProjectDoc[])),/INPUT.*冲突/);
 });
 await test('A6 exact original binding geometry is reused before new audio or approval',async()=>{
  const d=c.newBinding as unknown as ProjectDoc,binding=deliveryPictureBindings(d,deliverySectionsFromDoc(d)),board=planReviewBoards(input(c.green,[d,c.existingBinding as unknown as ProjectDoc])).plans[0];
  for(const row of board.rows.filter(r=>r.crop)){const expected=binding.find(b=>'asset_id'in b&&b.asset_id===row.asset_id&&'tool_crop_px'in b)!;assert('tool_crop_px'in expected);assert.deepEqual(row.tool_crop_px,expected.tool_crop_px);}
 });
 await test('A7 missing pointers and excessive frame requests refuse before extraction/publication',async()=>{
  const v=clone(c.green),i=v.clipMentorAnalysis.blueprint[0].internal_review as any;i.current_script_candidate='missing';assert.throws(()=>planReviewBoards(input(v,[c.newBinding,c.existingBinding] as unknown as ProjectDoc[])),/INPUT/);
  const many=clone(c.green),j=many.clipMentorAnalysis.blueprint[0].internal_review as any,p=j[j.current_picture_plan];p.phases=Array.from({length:REVIEW_BOARD_FRAME_LIMIT},()=>p.phases[0]);assert.throws(()=>planReviewBoards(input(many,[c.newBinding,c.existingBinding] as unknown as ProjectDoc[])),/INPUT/);
 });
 await test('A7 malformed bindings, wrong source references and unknown variant reject',async()=>{
  assert.throws(()=>planReviewBoards(input(c.green,[c.newBinding,null] as unknown as ProjectDoc[])),/INPUT/);
  const wrong=clone(c.green),internal=wrong.clipMentorAnalysis.blueprint[0].internal_review as any;internal[internal.current_picture_plan].phases[0].source_asset_id='wrong-video';assert.throws(()=>planReviewBoards(input(wrong,[c.newBinding,c.existingBinding] as unknown as ProjectDoc[])),/INPUT/);
  assert.throws(()=>planReviewBoards(input(c.green,[c.newBinding,c.existingBinding] as unknown as ProjectDoc[]),'missing-variant'),/INPUT/);
  const broken=join(root,'broken.json');await writeFile(broken,'{not JSON');await assert.rejects(loadReviewBoardInput(broken),/INPUT/);
 });
 // Real extraction only on temporary, explicitly synthetic source/media.
 const media=join(root,'media/uploads');await mkdir(media,{recursive:true});
 const bindings=[clone(c.newBinding),clone(c.existingBinding)] as unknown as ProjectDoc[];
 let green=clone(c.green) as unknown as Record<string,unknown>;
 for(const asset of bindings[0].assets){const path=join(media,asset.src.split('/').at(-1)!);if(asset.kind==='video')await exec(ffmpegBin(),['-v','error','-y','-f','lavfi','-i','testsrc2=size=96x160:rate=30:duration=69.2','-c:v','libx264','-pix_fmt','yuv420p',path]);else await exec(ffmpegBin(),['-v','error','-y','-f','lavfi','-i',`testsrc=size=${asset.width}x${asset.height}:rate=1`,'-frames:v','1',path]);const original=asset.sourceContentHash!,replacement=hash(await readFile(path));green=JSON.parse(JSON.stringify(green).replaceAll(original,replacement));for(let k=0;k<bindings.length;k++)bindings[k]=JSON.parse(JSON.stringify(bindings[k]).replaceAll(original,replacement));}
 const source=bindings[0].assets.find(a=>a.kind==='video')!,sourceFile=join(media,source.src.split('/').at(-1)!);
 await test('Panel Storyboard creates a reusable local image from the bound original',async()=>{
  const {createPanelStoryboard}=await import('./production-panel-delivery');
  const project=clone(bindings[0]),signal=new AbortController().signal;
  const a=project.clipMentorAnalysis!,duration=a.source.duration_seconds;
  a.evidence.push({evidence_id:'source-quote',kind:'original_claim',text:'Ini contoh warna.',source_ids:[a.source.asset_id],supporting_evidence_ids:[],status:'candidate',source_range_seconds:[0,duration]});
  a.source_breakdown!.segments=[{segment_id:'whole',source_range_seconds:[0,duration],claim_evidence_ids:['source-quote'],visible_evidence_ids:[],interpretation_evidence_ids:[],unknowns:[]}];
  a.source_breakdown!.units.forEach(u=>{u.original_segment_ids=['whole'];u.original_source_ranges=[[0,duration]];});
  await (await import('./creator-storyboard.verify-fixtures')).writeStoryboardFixtureReceipt(project,root);
  const asset=await createPanelStoryboard(project,signal);assert(asset);
  assert.equal(asset.props?.clipmentorStoryboardSource,source.id);
  assert.equal(asset.props?.clipmentorStoryboardHash,source.sourceContentHash);
  const times=asset.props?.clipmentorStoryboardTimes as number[];
  assert.equal(times.length,1);assert(times.every((time,index)=>index===0||time>times[index-1]));
  const bytes=await readFile(join(media,asset.src.split('/').at(-1)!));
  assert(bytes.length>1000);assert.equal(hash(bytes),asset.sourceContentHash);
  project.assets.push(asset);
  assert.equal(await createPanelStoryboard(project,signal),undefined,'identical valid assets are reused');
  await assert.rejects(createPanelStoryboard(bindings[0],AbortSignal.abort(Error('fixture abort'))),/fixture abort/);
 });
 await test('A5 source request decodes exact known 30fps frame and full resolution',async()=>{
  for(const frame of [0,21,195,2075]){const actual=join(root,'actual.jpg'),reference=join(root,'reference.jpg');await extractOneFrame(sourceFile,Math.floor(frame/30*1000),actual,false);await exec(ffmpegBin(),['-v','error','-y','-i',sourceFile,'-vf','select=eq(n\\,'+frame+')','-frames:v','1','-q:v','4',reference]);assert.deepEqual(await readFile(actual),await readFile(reference));}
 });
 await test('A6 actual cropped pixels match the original-image approved margins',async()=>{
  const board=planReviewBoards(input(green,bindings)).plans[0];
  for(const [index,row]of board.rows.filter(r=>r.crop).entries()){
   const asset=bindings[0].assets.find(a=>a.id===row.asset_id)!,section=deliverySectionsFromDoc(bindings[0]).find(s=>s.picture.asset_id===row.asset_id)!,crop=section.picture.crop!;
   const width=asset.width!,height=asset.height!,expected={x:Math.round(width*crop.left),y:Math.round(height*crop.top),w:Math.round(width*(1-crop.left-crop.right)),h:Math.round(height*(1-crop.top-crop.bottom))};
   const actual=join(root,'crop-'+index+'.jpg'),reference=join(root,'reference-crop-'+index+'.jpg'),source=join(media,asset.src.split('/').at(-1)!);
   await extractOneFrame(source,0,actual,false,row.crop);await exec(ffmpegBin(),['-v','error','-y','-i',source,'-vf',`crop=${expected.w}:${expected.h}:${expected.x}:${expected.y}:exact=1`,'-frames:v','1','-q:v','4',reference]);assert.deepEqual(await readFile(actual),await readFile(reference));
  }
 });
 await test('F4 actual human-board pixels keep a second full picture with a repeated section ID',async()=>{
  const copies=clone(bindings);const ending=(doc:ProjectDoc)=>deliverySectionsFromDoc(doc).find(s=>s.kind==='creator_invitation')!;
  for(const doc of copies){const ir=(doc.clipMentorAnalysis!.blueprint[0] as any).internal_review;ir[ir.current_picture_plan].delivery_sections.find((s:any)=>s.kind==='creator_invitation').section_id='shared-invitation';}
  const ir=(copies[1].clipMentorAnalysis!.blueprint[0] as any).internal_review;ir[ir.current_picture_plan].delivery_sections.find((s:any)=>s.kind==='creator_invitation').picture.crop={left:0,top:0,right:0,bottom:0};
  const result=await renderReviewBoards({...input(green,copies),mediaDir:media},join(root,'repeated-id-human'),undefined,'human');
  assert.equal(result.artifacts.length,1);const page=await readFile(result.artifacts[0].path,'utf8'),pictures=JSON.parse(page.match(/const pictures=([\s\S]*?);let selection/)![1]);
  const section=ending(copies[1]),source=join(media,section.picture.src.split('/').at(-1)!),reference=join(root,'second-ending-full.jpg');
  await exec(ffmpegBin(),['-v','error','-y','-i',source,'-frames:v','1','-q:v','4',reference]);
  assert.deepEqual(Buffer.from(pictures.at(-1)[0].jpeg,'base64'),await readFile(reference));
  assert.notDeepEqual(Buffer.from(pictures.at(-2)[0].jpeg,'base64'),Buffer.from(pictures.at(-1)[0].jpeg,'base64'));
 });
 const candidate=join(root,'candidate.json'),materialPaths:string[]=[];await writeFile(candidate,JSON.stringify(green));for(const [index,doc]of bindings.entries()){const p=join(root,`bindings-${index}.json`);await writeFile(p,JSON.stringify(doc));materialPaths.push(p);}
 const generateInput=()=>loadReviewBoardInput(candidate,{bindings:materialPaths,mediaDir:media});let html='';
 await test('A1/A2 real generation is offline, atomic and leaves all inputs identical',async()=>{
  const before=await Promise.all([candidate,...materialPaths,sourceFile].map(async p=>hash(await readFile(p))));const result=await renderReviewBoards(await generateInput(),join(root,'boards'));assert.equal(result.artifacts.length,2);assert(result.artifacts.every(a=>a.frame_count===35));html=await readFile(result.artifacts[0].path,'utf8');assert(html.includes('data:image/jpeg;base64,'));assert(!/src=["']https?:/i.test(html));assert(html.includes('connect-src &#39;none&#39;')||html.includes("connect-src 'none'"));assert.deepEqual(await Promise.all([candidate,...materialPaths,sourceFile].map(async p=>hash(await readFile(p)))),before);assert.equal(networks,0);
 });
 await test('A7 absent or changed original refuses without any half board',async()=>{
  const empty=join(root,'refused');await assert.rejects(renderReviewBoards({...await generateInput(),mediaDir:join(root,'absent')},empty),/INPUT/);await assert.rejects(readdir(empty));const bytes=await readFile(sourceFile);await writeFile(sourceFile,'wrong bytes');try{await assert.rejects(renderReviewBoards(await generateInput(),empty),/INPUT/);await assert.rejects(readdir(empty));}finally{await writeFile(sourceFile,bytes);}
 });
 await test('A7 invalid dimensions and changed inputs leave no partial artifact',async()=>{
  const invalid=clone(bindings);invalid.forEach(d=>d.assets.forEach(a=>{if(a.kind==='video')a.width=0;}));
  const out=join(root,'invalid-dimensions');await assert.rejects(renderReviewBoards({...input(green,invalid),mediaDir:media},out),/INPUT.*尺寸/);await assert.rejects(readdir(out));
  const changed=join(root,'changed-input');await assert.rejects(renderReviewBoards({...await generateInput(),assertUnchanged:async()=>{throw Error('INPUT: changed');}},changed),/INPUT.*changed/);await assert.rejects(readdir(changed));
 });
 await test('A8 local selected file checks SHA without network, expired file is explicit',async()=>{
  const script=html.match(/<script>([\s\S]*?)<\/script>/)![1];new Script(script);let listener:(e:any)=>Promise<void>=async()=>{};const nodes=new Map<string,any>();const document={getElementById:(id:string)=>{if(!nodes.has(id))nodes.set(id,{textContent:'',className:'',addEventListener:(_n:string,fn:any)=>{listener=fn;}});return nodes.get(id);},querySelectorAll:()=>[]};runInNewContext(script,{document,crypto:webcrypto,TextDecoder,TextEncoder,Uint8Array});
  const send=async(bytes:Buffer)=>listener({target:{files:[{arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)}]}});
  await send(await readFile(candidate));assert.match(nodes.get('freshness').textContent,/与此候选一致/);await send(Buffer.from(JSON.stringify({...green,status:'changed'})));assert.match(nodes.get('freshness').textContent,/已过期/);
  let release!:(v:ArrayBuffer)=>void;const slow=listener({target:{files:[{arrayBuffer:()=>new Promise<ArrayBuffer>(r=>{release=r;})}]}});await send(Buffer.from(JSON.stringify({...green,status:'newer'})));const bytes=await readFile(candidate);release(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer);await slow;assert.match(nodes.get('freshness').textContent,/已过期/,'older selection must never overwrite newer result');assert.equal(networks,0);
 });
 await test('A9 generator preparation never adds board data to independent review input',async()=>{
  const {copyTeachingPacketFromDoc,buildCopyTeachingReviewRequest}=await import('../../src/clipmentor/production-gate');const d=bindings[0];const before=buildCopyTeachingReviewRequest([{case_id:'unchanged',packet:await copyTeachingPacketFromDoc(d)}]);planReviewBoards(input(d));(d as any).author_self_check={remaining_gaps:'BOARD_AUTHOR_SENTINEL'};assert.deepEqual(buildCopyTeachingReviewRequest([{case_id:'unchanged',packet:await copyTeachingPacketFromDoc(d)}]),before);
 });
 await test('H2-H6 human has one body, Chinese first, illustration boundaries and neutral warnings',async()=>{
  const {humanBoardQuestions}=await import('./blueprint-review-board-human');const prepared=planReviewBoards(input(green,bindings)),questions=humanBoardQuestions(prepared.plans[0]);
  assert(![...questions.get('GM-G1')??[]].some(q=>q.includes('指定画面')));assert(![...questions.get('GM-G5')??[]].some(q=>q.includes('画面说明相同')));for(const id of ['GM-G2','GM-G3','GM-G4'])assert(!questions.has(id));
  const result=await renderReviewBoards(await generateInput(),join(root,'human'),undefined,'human');assert.equal(result.artifacts.length,1);assert.equal(result.artifacts[0].frame_count,38);const page=await readFile(result.artifacts[0].path,'utf8');
  assert.equal((page.match(/data-card="group-/g)??[]).length,5);assert.equal((page.match(/class="explanation"/g)??[]).length,6);assert.equal((page.match(/class="ending"/g)??[]).length,2);assert(page.includes('<h2>片头</h2>'));assert(page.includes('版式示意，非渲染'));assert(page.includes('示意模板'));assert(!page.includes('text-shadow'));
  const visible=page.split('<footer>')[0].replace(/<style>[\s\S]*?<\/style>/g,'').replace(/<details[\s\S]*?<\/details>/g,'').replace(/<[^>]+>/g,'');assert(!/[a-f0-9]{64}|#[a-f0-9]{6}|\bf\d+\b|Reference only|tool_crop_px|asset_id|B05/iu.test(visible));assert(!/画面已匹配|审核通过|验收通过/.test(visible));assert(!/data-verdict=/.test(page));assert(!page.includes('<details id="technical"')&&!page.includes('候选业务登记'));
  for(const line of prepared.data.lines){const escaped=(t:string)=>t.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));assert(page.includes(escaped(line.text)));assert(page.includes(escaped(line.zh)));const found=page.indexOf('data-line-id="'+line.id+'"');assert(found>=0);const segment=page.slice(found,page.indexOf('</div>',found));assert(segment.indexOf('class="meaning"')<segment.indexOf('class="narration"'));}
  assert(page.includes('核对现行稿件')&&page.includes('class="version-note"'));
  assert.equal(networks,0);
 });
 await test('Creator endings expose the same crop and actual uncropped evidence before freeze',async()=>{
  const {humanReviewBoardPage}=await import('./blueprint-review-board-human');
  const prepared=planReviewBoards(input(green,bindings));
  const first=prepared.plans[0].rows.find(r=>r.stage==='closing')!;
  const second=structuredClone(first);
  first.key='ending/new';first.ending_variant='new_contact';first.unit_id='new_contact';
  second.key='ending/existing';second.ending_variant='existing_partner';second.unit_id='existing_partner';second.asset_id='separate-upload-same-bytes';
  const board={...prepared.plans[0],rows:[...prepared.plans[0].rows,second]};
  const page=()=>humanReviewBoardPage(board,prepared.data,prepared.lint);
  assert(page().includes('同一张原图与同一裁切'));
  assert(page().includes('活动价、佣金等合作条件'));
  assert(page().includes('本商品的原片 Storyboard'));
  second.asset_hash='a'.repeat(64);
  assert(!page().includes('同一张原图与同一裁切'));
  second.asset_hash=first.asset_hash;
  second.crop={left:0,top:0,right:0,bottom:0};
  assert(!page().includes('同一张原图与同一裁切'));
  board.rows.pop();
  assert(!page().includes('同一张原图与同一裁切'));
  first.unit_id='unclassified';
  assert(!page().includes('活动价、佣金等合作条件'));
  assert(!page().includes('本商品的原片 Storyboard'));
  const output=await renderReviewBoards(await generateInput(),join(root,'ending-source-proof'),undefined,'human');
  const html=await readFile(output.artifacts[0].path,'utf8');
  const reference=join(root,'original-closing-proof.jpg');
  const asset=bindings.flatMap(doc=>doc.assets).find(a=>a.id===first.asset_id)!;
  await extractOneFrame(join(media,asset.src.split('/').at(-1)!),0,reference,false);
  assert(html.includes('核对未裁原图'));
  assert(html.includes('data:image/jpeg;base64,'+(await readFile(reference)).toString('base64')));
  assert.equal(networks,0);
 });
 await test('H6 visible quantities remain reviewable while picture diagnostics stay with the planner',async()=>{
  const {humanBoardQuestions}=await import('./blueprint-review-board-human');
  const board=clone(planReviewBoards(input(green,bindings)).plans[0]);
  const last=board.rows.find(r=>r.line_ids.includes('GM-L06'))!;
  last.range=[53,56];
  last.lint.push({rule_id:'B04',level:'warn',location:'GM-L06',excerpt:'RM20,000',message:'visible amount'});
  last.lint.push({rule_id:'B04',level:'warn',location:'GM-L060',excerpt:'RM99,999',message:'different sentence'});
  const q=[...humanBoardQuestions(board).get('GM-G5')??[]];
  assert.equal(q.length,1);
  assert.match(q[0],/RM20,000/);
  assert(last.notices.some(n=>n.includes('B05')),'the planner retains the estimate');
 });
 await test('Adversarial H6 includes opening and ending visible-quantity questions',async()=>{
  const {humanBoardQuestions,humanReviewBoardPage}=await import('./blueprint-review-board-human');const p=planReviewBoards(input(green,bindings)),board=clone(p.plans[0]);
  for(const stage of ['opening','closing']){const row=board.rows.find(r=>r.stage===stage)!;row.lint.push({rule_id:'B04',level:'warn',location:row.line_ids[0],excerpt:'RM20,000',message:'Visible quantity absent'});const questions=humanBoardQuestions(board);assert([...questions.get(row.key)??[]].some(q=>q.includes('RM20,000')),stage+' must retain its warning');}
  const page=humanReviewBoardPage(board,p.data,p.lint);const opening=page.slice(page.indexOf('data-card="opening"'),page.indexOf('data-card="group-1"')),ending=page.slice(page.indexOf('data-card="endings"'),page.indexOf('<footer>'));assert(opening.includes('计划上屏有RM20,000'));assert(ending.includes('计划上屏有RM20,000'));
  const first=board.rows.find(r=>r.stage==='closing')!,second=clone(p.plans[1].rows.find(r=>r.stage==='closing')!);first.unit_id=second.unit_id='shared-closing-section';first.key='closing/new';second.key='closing/existing';second.lint=[];board.rows.push(second);const scoped=humanBoardQuestions(board);assert([...scoped.get(first.key)??[]].some(q=>q.includes('RM20,000')));assert(![...scoped.get(second.key)??[]].some(q=>q.includes('RM20,000')),'one ending warning must not leak into the other with same section ID');
 });
 await test('Adversarial H5 every line sharing a phase has its own illustration and zoom source',async()=>{
  const {humanReviewBoardPage}=await import('./blueprint-review-board-human');const p=planReviewBoards(input(green,bindings)),board=clone(p.plans[0]),rows=board.rows.filter(r=>r.stage==='explanation'),lastUnit=rows.at(-1)!.unit_id,sameUnit=rows.filter(r=>r.unit_id===lastUnit),first=sameUnit[0],second=sameUnit[1];first.lines.push(...second.lines);first.line_ids.push(...second.line_ids);board.rows=board.rows.filter(r=>r!==second);
  const page=humanReviewBoardPage(board,p.data,p.lint);assert.equal((page.match(/class="explanation"/g)??[]).length,6,'one illustration per sentence, not per phase');const group=page.slice(page.indexOf('data-card="group-5"'),page.indexOf('data-card="endings"'));assert.equal((group.match(/class="mock-caption"/g)??[]).length,2);assert(!/data-zoom="-1"/.test(page));assert(group.includes(second.lines[0].cards[0][0].replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))));
 });
 await test('Human source observations retain their exact timed excerpt, not a whole-group assertion',async()=>{
  const {humanReviewBoardPage}=await import('./blueprint-review-board-human');const p=planReviewBoards(input(green,bindings)),before=JSON.stringify(p.data),page=humanReviewBoardPage(p.plans[0],p.data,p.lint),card=(s:string,id:string)=>s.split('data-card="'+id+'"')[1].split('</section>')[0];
  for(const [group,time]of [['group-4','41–48.5秒'],['group-5','51.5–55.5秒']]){const section=card(page,group);assert(section.includes('原片观察摘录'));assert(section.includes(time));assert(section.includes('只描述其中'+time));}
  const e=(p.data.analysis.evidence as any[]).find(e=>e.evidence_id==='GM-E09-V');assert(card(page,'group-4').includes(e.text));assert.equal(JSON.stringify(p.data),before);
  const full=clone(p.data),fullEvidence=(full.analysis.evidence as any[]).find(e=>e.evidence_id==='GM-E09-V');fullEvidence.source_range_seconds=[41,51.5];const whole=card(humanReviewBoardPage(p.plans[0],full,p.lint),'group-4');assert(whole.includes('原片观察摘录'));assert(!whole.includes('只描述其中'));
 });
 await test('Human source observations without valid evidence timestamps stay hidden',async()=>{
  const {humanReviewBoardPage}=await import('./blueprint-review-board-human');const p=planReviewBoards(input(green,bindings));for(const time of [undefined,null,[-1,3],[48,41],[41,'48.5'],[NaN,48.5],[41]]){const data=clone(p.data),e=(data.analysis.evidence as any[]).find(e=>e.evidence_id==='GM-E09-V');e.text='NO_TIME_OBSERVATION_SENTINEL';if(time===undefined)delete e.source_range_seconds;else e.source_range_seconds=time;const page=humanReviewBoardPage(p.plans[0],data,p.lint),group=page.split('data-card="group-4"')[1].split('</section>')[0];assert(!group.includes('NO_TIME_OBSERVATION_SENTINEL'));assert(!group.includes('原片观察摘录'));assert(group.includes('source-strip'),'the raw pictures must remain');}
 });
 await test('H8 planner HTML is byte-identical apart from the authorized board name',async()=>{
  const {transformSync}=await import('esbuild'),{blueprintReviewBoardPage}=await import('./blueprint-review-board-page');const original=await readFile(join(process.cwd(),'server/clipmentor/fixtures/planner-page-before-human-20261102.txt'),'utf8');const module={exports:{}};runInNewContext(transformSync(original,{loader:'ts',format:'cjs'}).code,{module,exports:module.exports});const render=(module.exports as any).blueprintReviewBoardPage;for(const board of planReviewBoards(input(green,bindings)).plans){board.generated_at='2026-11-02T00:00:00Z';assert.equal(blueprintReviewBoardPage(board),render(board).replaceAll('蓝图审片板','策划自查板'));}
 });
 await test('H1 human CLI publishes the exact immutable artifact via the existing product cache',async()=>{
  const {runReviewBoardCli}=await import('./blueprint-review-board-cli.mts'),{reviewBoardArtifactRoot}=await import('./blueprint-review-board-artifacts');const before=await readFile(candidate),r=await runReviewBoardCli([candidate,'--out',join(root,'human-cli'),'--view','human',...materialPaths.flatMap(p=>['--bindings',p]),'--media-dir',media]);const a=r.artifacts[0] as any;assert.equal(r.artifacts.length,1);assert(a.url);const url=new URL(a.url,'http://localhost'),cache=join(reviewBoardArtifactRoot(url.searchParams.get('projectId')!),url.searchParams.get('artifact')!);assert.deepEqual(await readFile(cache),await readFile(a.path));assert.equal(hash(await readFile(cache)),a.cached_sha256);assert(url.searchParams.get('projectId')!.endsWith(a.cached_sha256));assert.deepEqual(await readFile(candidate),before);assert.equal(networks,0);
 });
 await test('H7 human reuses the actual local SHA checking script',async()=>{
  const {humanReviewBoardPage}=await import('./blueprint-review-board-human');const p=planReviewBoards(input(green,bindings)),h=humanReviewBoardPage(p.plans[0],p.data,p.lint);let listener:(e:any)=>Promise<void>=async()=>{};const nodes=new Map<string,any>();const document={getElementById:(id:string)=>{if(!nodes.has(id))nodes.set(id,{textContent:'',className:'',addEventListener:(_n:string,fn:any)=>{listener=fn;}});return nodes.get(id);},querySelectorAll:()=>[]};runInNewContext(h.match(/<script>([\s\S]*?)<\/script>/)![1],{document,crypto:webcrypto,TextDecoder,TextEncoder,Uint8Array});const send=async(v:unknown)=>{const b=Buffer.from(JSON.stringify(v));await listener({target:{files:[{arrayBuffer:async()=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)}]}});};await send(green);assert.match(nodes.get('freshness').textContent,/与此候选一致/);await send({...green,status:'different'});assert.match(nodes.get('freshness').textContent,/已过期/);
 });
 await test('Human view and CLI reject unknown views or quietly omitted endings',async()=>{
  const {runReviewBoardCli}=await import('./blueprint-review-board-cli.mts');await assert.rejects(runReviewBoardCli([candidate,'--out',join(root,'bad-view'),'--view','typo']),/INPUT/);await assert.rejects(renderReviewBoards(await generateInput(),join(root,'bad-view'),'new_contact','human'),/INPUT/);await assert.rejects(readdir(join(root,'bad-view')));
 });
 await test('A10 original read-only tool/HTTP saves artifact, cold project stays unchanged',async()=>{
  const {withSerializedProjectStore}=await import('../plugins/project-store'),{loadOfflineStoredProject}=await import('../external-agent/offline-project-store'),{clipMentorProductionPlugin}=await import('../plugins/clipmentor-production'),{executeTool}=await import('../../src/agent/tools'),{makeDraft}=await import('../../src/editor/store');
  const doc=bindings[0];await withSerializedProjectStore(s=>s.writeEntry('project:review-board-test',doc));const before=await loadOfflineStoredProject('review-board-test');assert(before,'test fixture must actually be a valid saved project');const app=createMiniConnect(e=>{throw e;}),server=createServer((req,res)=>app.handle(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address() as {port:number},origin='http://127.0.0.1:'+address.port;
  (clipMentorProductionPlugin(async()=>{throw Error('No worker permitted');}).configureServer as any)({httpServer:server,config:{server:{}},middlewares:{use:(route:string,fn:any)=>app.use(route,fn)}});
  try{const draft=makeDraft(doc),ctx={...draft,templates:[],audio:[],getProjectId:()=> 'review-board-test',getCreativeMode:()=> 'clipmentor',hostFetch:async(path:string,init:RequestInit)=>realFetch(new URL(path,origin),{...init,headers:{Origin:origin}})} as never;const result=await executeTool('render_clipmentor_review_board',{},ctx) as any;assert(!result.error,JSON.stringify(result));assert(result.artifacts.length);const beforeDraft=JSON.stringify(draft.getDoc());const blocked=await executeTool('set_aspect_ratio',{ratio:'1:1'},ctx) as any;assert(blocked.production_gate?.code,'read preparation must not permit editing without current approval');assert.equal(JSON.stringify(draft.getDoc()),beforeDraft);assert.equal(result.review_approved,false);const human=await executeTool('render_clipmentor_review_board',{view:'human'},ctx) as any;assert(!human.error,JSON.stringify(human));assert.equal(human.artifacts.length,1);const humanPage=await realFetch(new URL(human.artifacts[0].url,origin),{headers:{Origin:origin}});const humanBytes=await humanPage.text();assert.match(humanBytes,/人审版/);const changed=clone(doc);(changed.clipMentorAnalysis!.product as any).name='QA later board only';await withSerializedProjectStore(s=>s.writeEntry('project:review-board-test',changed));try{const next=await executeTool('render_clipmentor_review_board',{view:'human'},{...ctx,getDoc:()=>changed}) as any;assert(!next.error,JSON.stringify(next));assert.notEqual(next.artifacts[0].url,human.artifacts[0].url,'human links must bind inspected HTML bytes, not mutable project filenames');const retained=await realFetch(new URL(human.artifacts[0].url,origin),{headers:{Origin:origin}});assert.equal(await retained.text(),humanBytes,'a later board cannot replace an already inspected link');}finally{await withSerializedProjectStore(s=>s.writeEntry('project:review-board-test',doc));}const wrongView=await executeTool('render_clipmentor_review_board',{view:'typo'},ctx) as any;assert.match(wrongView.error,/INPUT/);const stale=await realFetch(origin+'/api/clipmentor/production-task?'+new URLSearchParams({view:'review_board',projectId:'review-board-test',expectedRevision:'stale'}),{headers:{Origin:origin}});assert.equal(stale.status,409);const page=await realFetch(new URL(result.artifacts[0].url,origin),{headers:{Origin:origin}});assert.equal(page.status,200);assert.match(await page.text(),/策划自查板/);assert.deepEqual(await loadOfflineStoredProject('review-board-test'),before);assert.equal((await realFetch(origin+'/api/clipmentor/production-task?view=review_board&projectId=review-board-test')).status,403);}finally{await new Promise<void>(r=>server.close(()=>r()));}
 });
 await test('Representative video is local, lazy, coalesced and scoped to the checked blueprint',async()=>{
  const {createProductionPanel}=await import('./production-panel');
  const {representativeTeachingExcerpt}=await import('./blueprint-teaching-excerpt');
  const {withSerializedProjectStore}=await import('../plugins/project-store');
  const {loadOfflineStoredProject}=await import('../external-agent/offline-project-store');
  const {createProductionTask,productionTaskStore,panelBlueprintRequirementsDigest}=await import('./production-task');
  const doc=clone(bindings[0]),projectId='excerpt-panel-fixture';
  const first=doc.clipMentorAnalysis!.blueprint[0] as any;
  const plan=first.internal_review[first.internal_review.current_picture_plan];
  plan.phases[1].context_source_ranges=[{segment_id:'GM-S01',source_range_seconds:[0,1],purpose:'first object'},
   {segment_id:'GM-S01',source_range_seconds:[9,10.5],purpose:'second object'}];
  const before=JSON.stringify(doc);
  const selected=representativeTeachingExcerpt(doc);
  assert(selected);
  assert.equal(JSON.stringify(doc),before);
  assert.deepEqual(selected.state.items.filter(i=>i.kind==='video').map(i=>[i.startFrame,i.srcInFrame,i.durationInFrames,i.volume]),
   [[0,270,45,1],[45,0,30,0],[75,270,45,0]],'preview does not play gaps or choose the arbitrary tail');
  assert.equal(selected.state.items.find(i=>i.id==='stage-0')?.props?.backgroundColor,'#0D5EA6');
  const mismatch=clone(doc);
  const mismatchReview=(mismatch.clipMentorAnalysis!.blueprint[0] as any).internal_review;
  mismatchReview[mismatchReview.current_picture_plan].phases[1].context_source_ranges[0].segment_id='GM-S00';
  assert.equal(representativeTeachingExcerpt(mismatch),null,'same window in another segment is not sufficient');
  assert.equal(representativeTeachingExcerpt(bindings[0]),null,'legacy unregistered motion keeps its stills');
  await withSerializedProjectStore(s=>s.writeEntry('project:'+projectId,doc));
  const saved=(await loadOfflineStoredProject(projectId))!;
  let renders=0,launches=0,release:()=>void=()=>{};
  let entered:()=>void=()=>{};
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const hold=new Promise<void>(resolve=>{release=resolve;});
  const payload=Buffer.from('fixture-preview');
  const panel=createProductionPanel(()=>{launches++;},()=>false,new Set(),async exact=>{
   assert.equal(exact.unitId,selected.unitId);renders++;entered();await hold;return payload;
  });
  const origin='http://127.0.0.1';
  const server=createServer((req,res)=>{void panel(projectId,origin,new URL(req.url!,origin).searchParams,req,res,async()=>({}))
   .catch(()=>{res.statusCode=409;res.end();});});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
  try{
   const api={provider:'openai' as const,model:'fixture',apiMode:'responses' as const,origin:base};
   const task=await createProductionTask({projectId,sourceAssetId:doc.clipMentorAnalysis!.source.asset_id,product:{name:'Fixture',category:'test'},
    author:api,reviewer:api,brief:'Fixture',humanBlueprintReview:true,
    budget:{model:10,observation:0,review:0,tts:0,render:0,preview_review:0,maxElapsedMs:120_000,maxRepairs:2}});
   task.input.panelDelivery={productAssetId:'product',productAssetHash:'a'.repeat(64),salesAssetId:'sales',ctaAssetId:'cta',ctaAssetHash:'b'.repeat(64)};
   task.status='awaiting_blueprint';task.stage='copy_review';task.projectRevision=saved.revision;
   task.completed.blueprint={at:Date.now(),artifact:{revision:saved.revision,authorSelfCheck:'passed',
    author_self_check_source_digest:'c'.repeat(64),teaching_baseline_digest:'d'.repeat(64),requirementsDigest:panelBlueprintRequirementsDigest(null)}};
   await productionTaskStore.save(task);
   const checked=(await (await realFetch(base+'/?view=panel')).json()).task;
   const url=base+'/?'+new URLSearchParams({view:'panel_board',revision:saved.revision,boardIdentity:checked.boardIdentity});
   const html=await (await realFetch(url)).text();
   assert.equal((html.match(/看回看示意/g)??[]).length,1);
   assert(!html.includes('data:video')&&!html.includes('fixture-preview'));
   assert.equal(renders,0);
   assert.equal((await realFetch(url.replace(checked.boardIdentity,'wrong')+'&excerpt=1')).status,409);
   assert.equal(renders,0);
   const interrupted=realFetch(url+'&excerpt=1',{signal:AbortSignal.timeout(10_000)});
   await Promise.race([started,interrupted.then(()=>{throw Error('The current preview did not start');})]);
   const currentDigest=task.completed.blueprint.artifact.requirementsDigest;
   task.completed.blueprint.artifact.requirementsDigest='f'.repeat(64);
   await productionTaskStore.save(task);
   release();
   assert.equal((await interrupted).status,409,'late render bytes cannot cross a changed review receipt');
   task.completed.blueprint.artifact.requirementsDigest=currentDigest;
   await productionTaskStore.save(task);
   const requests=Array.from({length:2},()=>realFetch(url+'&excerpt=1',{signal:AbortSignal.timeout(10_000)}));
   for(const response of await Promise.all(requests)){
    assert.equal(response.status,200);
    assert.equal(response.headers.get('X-ClipMentor-Board-Identity'),checked.boardIdentity);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),payload);
   }
   assert.equal(renders,2);
   const assetFile=join(media,selected.asset.src.split('/').at(-1)!);
   const original=await readFile(assetFile);await writeFile(assetFile,'changed fixture bytes');
   try{assert.equal((await realFetch(url+'&excerpt=1')).status,409,'warm cache cannot serve mismatched media');}
   finally{await writeFile(assetFile,original);}
   task.completed.blueprint.artifact.requirementsDigest='f'.repeat(64);
   await productionTaskStore.save(task);
   assert.equal((await realFetch(url+'&excerpt=1')).status,409,'warm cache cannot bypass the current check receipt');
   assert.equal(launches,0);assert.equal(networks,0);
  }finally{release();await new Promise<void>(r=>server.close(()=>r()));}
 });
 await test('Shared panel admits only the checked current blueprint across all browser actions',async()=>{
  const {seedKeystore}=await import('../keystore');
  seedKeystore({ROOTIFY_GATEWAY_API_KEY:'local-fixture-only'});
  const {withSerializedProjectStore}=await import('../plugins/project-store');
  const {loadOfflineStoredProject}=await import('../external-agent/offline-project-store');
  const {clipMentorProductionPlugin}=await import('../plugins/clipmentor-production');
  const {createProductionTask,productionTaskStore,requeuePanelAuthorCheck}=await import('./production-task');
  const {digestValue}=await import('../agent-runs/store-values');
  const projectId='checked-panel-board',doc=clone(bindings[0]);
  const planOf=(value:ProjectDoc)=>{
   const ir=value.clipMentorAnalysis!.blueprint[0].internal_review as Record<string,any>;
   return ir[ir.current_picture_plan];
  };
  const firstEnding=planOf(doc).delivery_sections.find((section:{kind:string})=>section.kind==='creator_invitation');
  firstEnding.section_id='new_contact';
  const secondEnding=clone(planOf(bindings[1]).delivery_sections.find((section:{kind:string})=>section.kind==='creator_invitation'));
  secondEnding.section_id='existing_partner';
  planOf(doc).delivery_sections.push(secondEnding);
  const sibling=bindings[1];
  for(const asset of sibling.assets)if(!doc.assets.some(candidate=>candidate.id===asset.id))doc.assets.push(clone(asset));
  for(const evidence of sibling.clipMentorAnalysis!.evidence){
   const prior=doc.clipMentorAnalysis!.evidence.find(candidate=>candidate.evidence_id===evidence.evidence_id);
   if(prior)prior.source_ids=[...new Set([...prior.source_ids,...evidence.source_ids])];
   else doc.clipMentorAnalysis!.evidence.push(clone(evidence));
  }
  await withSerializedProjectStore(s=>s.writeEntry('project:'+projectId,doc));
  const snapshot=(await loadOfflineStoredProject(projectId))!;
  const app=createMiniConnect(e=>{throw e;}),server=createServer((req,res)=>app.handle(req,res));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  let launched=0;
  const dispatched=Promise.withResolvers<void>();
  (clipMentorProductionPlugin(async()=>{launched++;dispatched.resolve();throw Error('Fixture stops before review');}).configureServer as any)({httpServer:server,config:{server:{}},middlewares:{use:(route:string,fn:any)=>app.use(route,fn)}});
  const api={provider:'openai' as const,model:'fixture',apiMode:'responses' as const,origin};
  try{
   const task=await createProductionTask({projectId,sourceAssetId:doc.clipMentorAnalysis!.source.asset_id,product:{name:'Fixture',category:'test'},
    author:api,reviewer:api,brief:'Fixture',humanBlueprintReview:true,
    budget:{model:10,observation:0,review:0,tts:0,render:0,preview_review:0,maxElapsedMs:120_000,maxRepairs:2}});
   task.input.voice={provider:'minimax',voiceId:'fixture-voice'};
   const originalCreatedAt=task.createdAt;
   task.input.panelDelivery={productAssetId:'product',productAssetHash:'a'.repeat(64),salesAssetId:'sales',ctaAssetId:'cta',ctaAssetHash:'b'.repeat(64)};
   task.status='awaiting_blueprint';task.stage='copy_review';task.projectRevision=snapshot.revision;
   task.completed.blueprint={at:Date.now(),artifact:{revision:snapshot.revision}};
   const panel=origin+'/api/clipmentor/production-task?view=panel&projectId='+projectId;
   const headers={Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json'};
   const status=async()=>(await (await realFetch(panel,{headers})).json()).task;
   const board=(identity?:string)=>realFetch(origin+'/api/clipmentor/production-task?'+new URLSearchParams({
    view:'panel_board',projectId,revision:snapshot.revision,...(identity?{boardIdentity:identity}:{})}),{headers});
   const action=(action:string,boardIdentity:string,text='核对本组卖点',blueprintReview?:unknown)=>realFetch(panel,{method:'POST',headers,body:JSON.stringify({
    action,revision:snapshot.revision,boardIdentity,text,feedbackTarget:{scope:'whole',confirmed:true},blueprintReview})});
   await productionTaskStore.save(task);
   assert.equal((await status()).blueprintRevision,undefined,'legacy structure-only checkpoint is not presented for review');
   assert.equal((await board()).status,409,'direct HTML access cannot bypass the check');
   assert.equal((await action('produce_versions','stale')).status,409);
   assert.equal((await action('revise_blueprint','stale')).status,409);
   const originalAttempts=structuredClone(task.attempts);
   const staleCheckpoint=clone(task);
   assert.equal(await requeuePanelAuthorCheck(task),true);
   await assert.rejects(requeuePanelAuthorCheck(staleCheckpoint),/production_control_subject_changed/);
   assert.equal((await status()).blueprintRevision,undefined);
   assert.deepEqual(task.attempts,originalAttempts);
   task.status='awaiting_blueprint'; // Simulate the worker's publication.
   Object.assign(task.completed.blueprint.artifact,{authorSelfCheck:'passed',author_self_check_source_digest:'c'.repeat(64),teaching_baseline_digest:'d'.repeat(64),requirementsDigest:digestValue({objective:null,doneCriteria:[]})});
   await productionTaskStore.save(task);
   const checked=await status();
   assert.equal(checked.blueprintRevision,snapshot.revision);
   assert.equal(checked.canConfirmBlueprint,true);
   assert.equal(checked.canApproveBlueprint,false,'an author check cannot count as independent approval');
   const opened=await board(checked.boardIdentity);
   assert.equal(opened.status,200,await (opened.ok?Promise.resolve(''):opened.text()));
   assert.match(await opened.text(),/data-card="group-1"/);
   assert.deepEqual(checked.reviewEndings.map((ending:{id:string})=>ending.id).sort(),['existing_partner','new_contact']);
   const suppliedReview={groups:checked.reviewGroups.map((group:{id:string})=>({id:group.id,decision:'先展示上嘴效果',stance:'accepted'})),endingIds:['new_contact']};
   const partialEnding=await action('produce_versions',checked.boardIdentity,undefined,suppliedReview);
   assert.equal(partialEnding.status,409);
   assert.match((await partialEnding.json()).issue.message,/两个片尾/);
   assert.equal((await productionTaskStore.load(projectId,task.taskId)).productionChildren,undefined);
   const pass=structuredClone(task.completed.blueprint.artifact);
   task.completed.blueprint.artifact={...pass,authorSelfCheck:'needs_human_review',
    authorSelfCheckNotice:'PRIVATE_S7_SENTINEL：片头成绩与字幕信息待核对'};
   await productionTaskStore.save(task);
   const needsBusiness=await status();
   assert.equal(needsBusiness.canConfirmBlueprint,false);
   assert.match(needsBusiness.blueprintMessage,/核对计划上屏的承诺/);
   assert.doesNotMatch(JSON.stringify(needsBusiness),/PRIVATE_S7_SENTINEL|片尾有待确认|authorSelfCheckNotice/);
   assert.equal((await action('produce_versions',needsBusiness.boardIdentity)).status,409);
   assert.equal(task.completed.blueprint.artifact.authorSelfCheckNotice,'PRIVATE_S7_SENTINEL：片头成绩与字幕信息待核对');
   task.completed.blueprint.artifact=structuredClone(pass);
   // A saved but unprocessed edit invalidates confirmation even at the same revision.
   task.repairContext={pending_blueprint_feedback:{text:'核对本组卖点',revision:snapshot.revision}};
   await productionTaskStore.save(task);
   assert.equal((await status()).canConfirmBlueprint,false);
   assert.equal((await action('produce_versions',checked.boardIdentity)).status,409);
   task.completed.blueprint.artifact.requirementsDigest='d'.repeat(64);
   await productionTaskStore.save(task);
   assert.equal((await status()).blueprintRevision,undefined);
   assert.equal((await board(checked.boardIdentity)).status,409,'a warm HTML cache cannot resurrect a stale receipt');
   assert.equal(await requeuePanelAuthorCheck(task),true,'a missing current policy receipt can be rechecked under the original authority');
   assert.equal(task.status,'queued');assert.equal(task.stage,'blueprint');
   assert.equal(task.blueprintFeedback,'核对本组卖点','a pending business correction goes to the author before rechecking');
   assert.deepEqual(task.attempts,originalAttempts);
   task.status='awaiting_blueprint';task.stage='copy_review';task.createdAt=Date.now()-task.input.budget.maxElapsedMs-1;
   task.completed.blueprint={at:Date.now(),artifact:{revision:snapshot.revision}};
   await productionTaskStore.save(task);
   assert.equal(await requeuePanelAuthorCheck(task),false,'expired authority is never silently extended');
   task.completed.blueprint.artifact={...pass,authorSelfCheck:'needs_human_review',
    authorSelfCheckNotice:'PRIVATE_S7_SENTINEL：有待核实的上屏事实'};
   delete task.repairContext;
   await productionTaskStore.save(task);
   const feedbackBoard=await status();
   const feedbackHtml=await board(feedbackBoard.boardIdentity);
   assert.equal(feedbackHtml.status,200,await (feedbackHtml.ok?Promise.resolve(''):feedbackHtml.text()));
   const feedbackText='核对片头上屏事实';
   const feedbackResponse=await action('revise_blueprint',feedbackBoard.boardIdentity,feedbackText);
   assert.equal(feedbackResponse.status,200,await feedbackResponse.clone().text());
   assert.deepEqual(await feedbackResponse.json(),{accepted:true,saved:true,dispatched:false,reason:'limit'});
   const savedFeedback=await productionTaskStore.load(projectId,task.taskId);
   assert.equal(savedFeedback.blueprintFeedback,feedbackText);
   assert.deepEqual(savedFeedback.repairContext?.pending_blueprint_feedback,{text:feedbackText,revision:snapshot.revision});
   assert.equal(savedFeedback.productionChildren,undefined);
   assert.deepEqual(savedFeedback.attempts,originalAttempts);
   assert.equal(launched,0);
   savedFeedback.createdAt=originalCreatedAt;
   savedFeedback.completed.blueprint!.artifact=pass;
   delete savedFeedback.repairContext;
   await productionTaskStore.save(savedFeedback);
   const ready=await status();
   const readyBoard=await board(ready.boardIdentity);
   assert.equal(readyBoard.status,200);await readyBoard.arrayBuffer();
   assert.equal((await action('produce_versions','stale',undefined,{scope:'whole_blueprint'})).status,409);
   assert.equal((await action('produce_versions',ready.boardIdentity,undefined,{scope:'whole_blueprint',endingIds:['new_contact']})).status,409);
   const firstGroup=ready.reviewGroups[0];
   const stance=(value:'changes'|'accepted')=>({groups:[{id:firstGroup.id,decision:'Fixture decision',stance:value}],endingIds:[]});
   assert.equal((await action('save_blueprint_review',ready.boardIdentity,undefined,stance('changes'))).status,200);
   const unchangedBoard=await status();
   assert.equal(unchangedBoard.boardIdentity,ready.boardIdentity);
   assert.equal(unchangedBoard.savedReview.groups[0].stance,'changes');
   assert.equal((await action('produce_versions',ready.boardIdentity,undefined,{scope:'whole_blueprint'})).status,409);
   assert.equal(launched,0);
   assert.equal((await action('save_blueprint_review',ready.boardIdentity,undefined,stance('accepted'))).status,200);
   const approved=await action('produce_versions',ready.boardIdentity,undefined,{scope:'whole_blueprint'});
   assert.equal(approved.status,200,await approved.clone().text());
   const {setTimeout:timeout}=await import('node:timers/promises');
   assert.equal(await Promise.race([dispatched.promise.then(()=>true),timeout(5000,false,{ref:false})]),true,'the approved batch reaches the worker');
   const published=await productionTaskStore.load(projectId,task.taskId);
   assert.equal(published.blueprintReview?.scope,'whole_blueprint');
   assert.deepEqual(published.blueprintReview?.groups,stance('accepted').groups,'whole-board confirmation keeps saved stances');
   assert.deepEqual(published.blueprintReview?.endings,ready.reviewEndings);
   assert.deepEqual(published.productionChildren?.map(child=>child.audience),['existing_partner','new_contact']);
   assert.equal(launched,1,'common body starts once and the second ending waits');
  }finally{await new Promise<void>(r=>server.close(()=>r()));}
 });
 await test('Blocked panel blueprint feedback starts the saved revision without a resume request',async()=>{
  const {withSerializedProjectStore}=await import('../plugins/project-store');
  const {loadOfflineStoredProject}=await import('../external-agent/offline-project-store');
  const {clipMentorProductionPlugin}=await import('../plugins/clipmentor-production');
  const {createProductionTask,productionTaskStore}=await import('./production-task');
  const projectId='feedback-board-recovery',doc=clone(bindings[0]);
  const {default:savedProjects}=await import('../../src/clipmentor/fixtures/production-saved-projects-20261028.json');
  const priorDoc=savedProjects.cases[0].doc as unknown as ProjectDoc;
  const priorReview=clone(priorDoc.clipMentorAnalysis!.production_copy_review!);
  assert(priorReview);
  doc.clipMentorAnalysis!.production_copy_review={...priorReview,verdict:'needs_revision'};
  await withSerializedProjectStore(s=>s.writeEntry('project:'+projectId,doc));
  const snapshot=(await loadOfflineStoredProject(projectId))!;
  const {assertBlueprintOpinionScope}=await import('./production-blueprint-opinions');
  const secondUnit=doc.clipMentorAnalysis!.blueprint[1];
  const secondLine=(current:ProjectDoc)=>{
   const review=current.clipMentorAnalysis!.blueprint[1].internal_review as Record<string,any>;
   return review[review.current_script_candidate].lines[0];
  };
  const app=createMiniConnect(e=>{throw e;}),server=createServer((req,res)=>app.handle(req,res));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const address=server.address() as {port:number},origin='http://127.0.0.1:'+address.port;
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const received:Array<{stage:string;feedback?:string;revision?:string}>=[];
  (clipMentorProductionPlugin(async item=>{
   if(item.stage==='copy_review')throw Error('fixture: stop at the new draft checkpoint');
   received.push({stage:item.stage,feedback:item.blueprintFeedback,revision:item.projectRevision});
   entered.resolve();await release.promise;
   const {openHeadlessEditor}=await import('./headless-editor');
   const editor=await openHeadlessEditor({projectId:item.projectId,runId:item.taskId,origin,review:api,
    assertCanvas:candidate=>{assert(item.blueprintOpinions);assertBlueprintOpinionScope(item.blueprintOpinions,candidate);},
    fetch:async()=>{throw Error('unexpected request');},effect:async()=>{throw Error('unexpected effect');}});
   try{
    const wrong=clone(editor.getDoc());
    secondLine(wrong).narration_ms='Baris ini tidak patut diubah. Ayat pendek.';
    editor.context.commands.applyDoc(wrong);
    await assert.rejects(editor.commit(),/第 1 句已确认保留/);
    assert.equal((await loadOfflineStoredProject(projectId))!.revision,snapshot.revision);
    const next=clone(editor.getDoc()),line=secondLine(next);
    const first=line.caption_lines[0];
    Object.assign(line,{narration_ms:`${first} Hasil itu memperkenalkan produk.`,caption_lines:[first,'Hasil itu memperkenalkan produk.']});
    next.clipMentorAnalysis!.revision++;
    editor.context.commands.applyDoc(next);
    return {artifact:await editor.commit()};
   }finally{await editor.close();}
  }).configureServer as any)({httpServer:server,config:{server:{}},middlewares:{use:(route:string,fn:any)=>app.use(route,fn)}});
  const api={provider:'openai' as const,model:'fixture',apiMode:'responses' as const,origin};
  try{
   const task=await createProductionTask({projectId,sourceAssetId:doc.clipMentorAnalysis!.source.asset_id,product:{name:'Fixture',category:'test'},
    author:api,reviewer:api,brief:'Fixture',humanBlueprintReview:true,
    budget:{model:10,observation:0,review:0,tts:0,render:0,preview_review:0,maxElapsedMs:60_000,maxRepairs:2}});
   task.status='blocked';task.stage='copy_review';task.projectRevision=snapshot.revision;task.error='fixture old block';
   await productionTaskStore.save(task);
   const panel=origin+'/api/clipmentor/production-task?view=panel&projectId='+projectId;
   const headers={Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json'};
   const {task:visible}=await (await realFetch(panel,{headers})).json();
   const boardUrl=origin+'/api/clipmentor/production-task?'+new URLSearchParams({view:'panel_board',projectId,revision:snapshot.revision,boardIdentity:visible.boardIdentity});
   const board=await realFetch(boardUrl,{headers});
   assert.equal(board.status,200,await (board.ok?Promise.resolve(''):board.text()));
   const panelHtml=await board.text();
   assert(!panelHtml.includes('id="candidate-file"')&&!panelHtml.includes('id="freshness"')&&!panelHtml.includes('class="version-note"'));
   assert(panelHtml.includes('data-card="group-1"')&&panelHtml.includes("querySelectorAll('[data-zoom]')")&&!panelHtml.includes("getElementById('candidate-file')"));
   const text='第一句保留，第二句改短';
   const submit=(boardIdentity:string,opinionConfirmation?:string)=>realFetch(panel,{method:'POST',headers,body:JSON.stringify({
    action:'revise_blueprint',revision:snapshot.revision,boardIdentity,blueprintOpinions:[{unitId:secondUnit.unit_id,text}],opinionConfirmation,
   })});
   const stale=await submit('wrong');assert.equal(stale.status,409);assert.equal(received.length,0);
   assert.equal((await productionTaskStore.load(projectId,task.taskId)).blueprintFeedback,undefined);
   const proposal=await (await submit(visible.boardIdentity)).json();
   assert.match(proposal.opinionConfirmation.rows[0].keep[0],/第 1 句 Dia bercerita/);
   const wrongToken=await (await submit(visible.boardIdentity,'old-confirmation')).json();
   assert.deepEqual(wrongToken,proposal);
   assert.equal(received.length,0);
   assert.equal((await productionTaskStore.load(projectId,task.taskId)).sequence,task.sequence);
   const action=await submit(visible.boardIdentity,proposal.opinionConfirmation.token);
   assert.equal(action.status,200);
   assert.deepEqual(await action.json(),{accepted:true,saved:true,dispatched:true});
   await entered.promise;
   const running=await productionTaskStore.load(projectId,task.taskId);
   assert.deepEqual(received,[{stage:'blueprint',feedback:`［${proposal.opinionConfirmation.rows[0].label}］${text}`,revision:snapshot.revision}]);
   assert.deepEqual(running.blueprintFeedbackUnitIds,[secondUnit.unit_id]);
   assert.equal(running.blueprintOpinions?.confirmed,true);
   assert.equal(running.status,'running');assert.equal(running.repairs,task.repairs+1);
   assert.deepEqual(running.attempts,task.attempts);assert.deepEqual(running.effects,task.effects);
   assert.equal(running.blueprintApproval,undefined);
   assert.equal((await submit(visible.boardIdentity)).status,409,'a duplicate POST cannot start a parallel author');
   assert.equal(received.length,1);
   const {task:panelStatus}=await (await realFetch(panel,{headers})).json();
   assert.equal(panelStatus.status,'running');assert.equal(panelStatus.hasBlueprintFeedback,true);
   release.resolve();
   let final=running;
   for(let i=0;final.status!=='blocked'&&i<200;i++){
    await new Promise(resolve=>setTimeout(resolve,5));
    final=await productionTaskStore.load(projectId,task.taskId);
   }
   const revised=(await loadOfflineStoredProject(projectId))!;
   assert.equal(final.stage,'copy_review');assert.equal(final.status,'blocked');
   assert.equal(final.projectRevision,revised.revision);
   assert.notEqual(revised.revision,snapshot.revision);
   assert.equal(secondLine(revised.doc).narration_ms,`${secondLine(snapshot.doc).caption_lines[0]} Hasil itu memperkenalkan produk.`);
   assert.deepEqual(revised.doc.clipMentorAnalysis!.blueprint[0],snapshot.doc.clipMentorAnalysis!.blueprint[0]);
   assert.deepEqual(revised.doc.clipMentorAnalysis!.product,snapshot.doc.clipMentorAnalysis!.product);
   assert.equal(revised.doc.clipMentorAnalysis!.production_copy_review?.verdict,'needs_revision');
   assert.deepEqual(revised.doc.clipMentorAnalysis!.production_copy_review,snapshot.doc.clipMentorAnalysis!.production_copy_review);
   assert.deepEqual(final.attempts,task.attempts);

   // Saved-only feedback still changes the subject even when the project revision cannot advance.
   final.attempts.model=final.input.budget.model;
   await productionTaskStore.save(final);
   const currentBoard=async()=>{
    const {task:current}=await (await realFetch(panel,{headers})).json();
    const link=origin+'/api/clipmentor/production-task?'+new URLSearchParams({view:'panel_board',projectId,revision:revised.revision,boardIdentity:current.boardIdentity});
    const response=await realFetch(link,{headers});assert.equal(response.status,200);await response.arrayBuffer();
    return current.boardIdentity as string;
   };
   const reviseCurrent=(boardIdentity:string,text:string)=>realFetch(panel,{method:'POST',headers,body:JSON.stringify({action:'revise_blueprint',revision:revised.revision,boardIdentity,text,feedbackTarget:{scope:'whole',confirmed:true}})});
   const first=await currentBoard();
   assert.deepEqual(await (await reviseCurrent(first,'旧意见')).json(),{accepted:true,saved:true,dispatched:false,reason:'limit'});
  const checkedBeforeOtherWrites=await productionTaskStore.load(projectId,task.taskId);
   const second=await currentBoard();
   assert.notEqual(first,second);
   assert.deepEqual(await (await reviseCurrent(second,'新意见')).json(),{accepted:true,saved:true,dispatched:false,reason:'limit'});
   assert.equal((await reviseCurrent(first,'旧意见')).status,409,'late A cannot overwrite B on the same project revision');
   assert.equal((await productionTaskStore.load(projectId,task.taskId)).blueprintFeedback,'新意见');
   const third=await currentBoard();
   assert.equal((await reviseCurrent(third,'旧意见')).status,200,'a deliberate repeat on the fresh board is a new submission');
   assert.notEqual(await currentBoard(),second,'repeating the text cannot revive an older board control token');
   assert.equal((await reviseCurrent(second,'新意见')).status,409,'the previous middle request stays stale after A-B-A');
  const {queueDraftBlueprintFeedback}=await import('./production-task');
  await assert.rejects(queueDraftBlueprintFeedback(checkedBeforeOtherWrites,revised.revision,'跨进程迟到的意见',productionTaskStore,[]),
   /production_control_subject_changed/,'a request that already validated the first A cannot commit after A-B-A');
  assert.equal((await productionTaskStore.load(projectId,task.taskId)).blueprintFeedback,'旧意见');
   assert.equal(received.length,1);

  }finally{
   release.resolve();
   await new Promise<void>(r=>server.close(()=>r()));
   const {productionExecutionActive,latestPanelProductionTask}=await import('./production-task');
   const task=await latestPanelProductionTask(projectId);
   for(let i=0;task&&productionExecutionActive(projectId,task.taskId)&&i<200;i++)await new Promise(resolve=>setTimeout(resolve,5));
  }
 });
 await test('P5 optional Chinese persists through the original temporary project store and cold read',async()=>{
  const {withSerializedProjectStore}=await import('../plugins/project-store'),{loadOfflineStoredProject}=await import('../external-agent/offline-project-store');
  const doc=clone(bindings[0]);for(const e of doc.clipMentorAnalysis!.evidence)if(e.kind==='original_claim')e.meaning_zh='测试策划译文';
  for(const u of doc.clipMentorAnalysis!.blueprint){const ir=(u as any).internal_review;for(const l of ir[ir.current_script_candidate].lines)l.labels_zh=(l.labels??[]).map(()=> '测试短标译文');for(const l of ir[ir.current_picture_plan].selected_narration??[])l.labels_zh=(l.labels??[]).map(()=> '测试短标译文');for(const section of ir[ir.current_picture_plan].delivery_sections??[])section.line.labels_zh=section.line.labels.map(()=> '测试短标译文');}
  await withSerializedProjectStore(s=>s.writeEntry('project:human-translation-cold',doc));
  const cold=await loadOfflineStoredProject('human-translation-cold');assert(cold);assert.deepEqual(cold.doc,doc);
  const loaded=await loadReviewBoardInput('human-translation-cold');const ready=planReviewBoards(loaded);const claims=ready.data.analysis.evidence.filter(e=>e.kind==='original_claim');assert(claims.length>0&&claims.every(e=>e.meaning_zh==='测试策划译文'));
 });
 assert.equal(networks,0);
}finally{globalThis.fetch=realFetch;if(priorData===undefined)delete process.env.OPENCHATCUT_DATA_DIR;else process.env.OPENCHATCUT_DATA_DIR=priorData;await rm(root,{recursive:true,force:true});}
if(tests.some(t=>!t.pass))throw Error(JSON.stringify(tests.filter(t=>!t.pass)));console.log('Blueprint review board:',tests.length,'checks passed, external/provider calls=0');
