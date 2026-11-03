import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fixture from './fixtures/blueprint-review-board-20261031.json';
import baseline from './fixtures/blueprint-review-board-human-v2-baseline.json';
import {planReviewBoards} from './blueprint-review-board';
import {humanReviewBoardPage} from './blueprint-review-board-human';
import {blueprintReviewBoardPage} from './blueprint-review-board-page';
import {sourceSpeech,translatedLabels,unitUnknowns} from './blueprint-review-board-human-context';
import {copyTeachingPacketFromDoc,buildCopyTeachingReviewRequest} from '../../src/clipmentor/production-gate';
import {isClipMentorAnalysis} from '../../src/clipmentor/analysis';
import {deliverySectionsShape} from '../../src/clipmentor/delivery-bindings';
import type {ProjectDoc} from '../../src/editor/types';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex'),clone=structuredClone;
let network=0;const fetchBefore=globalThis.fetch;globalThis.fetch=async()=>{network++;throw Error('Network forbidden');};
const c=fixture.cases,materials=[c.newBinding,c.existingBinding] as unknown as ProjectDoc[];
const prepare=(v:unknown)=>planReviewBoards({value:v,sha256:'a'.repeat(64),hashMode:'file',assertUnchanged:async()=>{},bindings:materials});
const original=JSON.stringify(c),tests:string[]=[];
async function test(name:string,fn:()=>unknown|Promise<unknown>){await fn();tests.push(name);console.log('PASS '+name);}
try{
 const regressions:Array<{name:string;error:string}>=[];
 const scoped=(value:unknown,bindings:ProjectDoc[])=>planReviewBoards({value,bindings,sha256:'a'.repeat(64),hashMode:'file',assertUnchanged:async()=>{}});
 const endings=(doc:ProjectDoc)=>{const ir=(doc.clipMentorAnalysis!.blueprint[0] as any).internal_review;return ir[ir.current_picture_plan].delivery_sections as any[];};
 const ending=(doc:ProjectDoc)=>endings(doc).find(s=>s.kind==='creator_invitation')!;
 async function regression(name:string,fn:()=>unknown){try{fn();console.log('PASS '+name);tests.push(name);}catch(error){regressions.push({name,error:String(error)});console.log('FAIL '+name+' '+String(error));}}
 await regression('F2 delivery Chinese conflicts are rejected before a misleading board can be generated',()=>{
  const value=clone(c.green) as any,bindings=clone(materials),line=value.delivery_sections.creator_endings.new_contact,bound=ending(bindings[0]).line;
  line.labels_zh=line.labels.map(()=> 'STALE_AUTHOR_TRANSLATION');bound.labels_zh=bound.labels.map(()=> 'CURRENT_BOUND_TRANSLATION');
  assert.throws(()=>scoped(value,bindings),/INPUT.*文稿/);
 });
 await regression('F2 body Chinese conflicts are reported by the shared reader',()=>{
  const value=clone(c.green) as any,ir=value.clipMentorAnalysis.blueprint[0].internal_review,current=ir[ir.current_script_candidate].lines[0],mirror=value.narration_and_captions.find((l:any)=>l.id===current.id);
  current.labels_zh=current.labels.map(()=> 'CURRENT_BODY');mirror.labels_zh=mirror.labels.map(()=> 'STALE_BODY');
  assert.throws(()=>scoped(value,clone(materials)),/INPUT.*冲突/);
 });
 await regression('F2 legacy absent optional Chinese is compatible with a newly translated candidate',()=>{
  const value=clone(c.green) as any,bindings=clone(materials),line=value.delivery_sections.creator_endings.new_contact;
  line.labels_zh=line.labels.map(()=> '策划新译文');delete ending(bindings[0]).line.labels_zh;
  const result=scoped(value,bindings),html=humanReviewBoardPage(result.plans[0],result.data,result.lint,bindings);assert(html.includes('策划新译文'));
 });
 await regression('F3 old external bindings cannot replace a currently registered picture',()=>{
  const value=clone(materials[0]),old=clone(value);ending(value).picture.crop={left:0,top:0,right:0,bottom:0};ending(value).picture.description='CURRENT_FULL_PICTURE';
  assert.throws(()=>scoped(value,[old]),/INPUT.*当前候选.*绑定/);
 });
 await regression('F3 consistent current bindings remain valid without external materials',()=>{
  const value=clone(materials[0]);ending(value).picture.crop={left:0,top:0,right:0,bottom:0};ending(value).picture.description='CURRENT_FULL_PICTURE';
  const result=planReviewBoards({value,sha256:'a'.repeat(64),hashMode:'project',assertUnchanged:async()=>{}}),row=result.plans[0].rows.find(r=>r.stage==='closing')!;
  assert.equal(row.picture,'CURRENT_FULL_PICTURE');assert.deepEqual(row.crop,{left:0,top:0,right:0,bottom:0});
 });
 await regression('F4 repeated section IDs in independent projects keep their own exact crop',()=>{
  const bindings=clone(materials);for(const doc of bindings)ending(doc).section_id='shared-invitation';ending(bindings[1]).picture.crop={left:0,top:0,right:0,bottom:0};
  const result=scoped(clone(c.green),bindings),first=result.plans[0].rows.find(r=>r.stage==='closing')!,second=result.plans[1].rows.find(r=>r.stage==='closing')!;
  assert.deepEqual(second.crop,{left:0,top:0,right:0,bottom:0});assert.notDeepEqual(first.crop,second.crop);
 });
 await regression('F5 blank original labels cannot shift Chinese or evade the INPUT notice',()=>{
  const value=clone(c.green) as any;const rewrite=(v:any)=>{if(!v||typeof v!=='object')return;if(v.id==='GM-L01'||v.line_id==='GM-L01'){v.labels=['','Contoh asli'];v.labels_zh=['SHIFTED_TRANSLATION'];}for(const item of Object.values(v))if(item&&typeof item==='object')rewrite(item);};rewrite(value);
  const result=scoped(value,clone(materials)),labels=translatedLabels(result.data,'GM-L01');assert(labels.invalid);assert(labels.pairs.every(p=>p.zh===''));
  const html=humanReviewBoardPage(result.plans[0],result.data,result.lint,clone(materials));assert(html.includes('data-input-code="INPUT"'));assert(!html.includes('→ SHIFTED_TRANSLATION'));
 });
 await regression('F3 stale current business evidence cannot borrow an unchanged picture binding',()=>{
  const value=clone(materials[0]),old=clone(value),section=ending(value),e=value.clipMentorAnalysis!.evidence.find(e=>section.evidence_ids.includes(e.evidence_id))!;e.text='UPDATED_CURRENT_TERMS';
  assert.throws(()=>scoped(value,[old]),/INPUT.*当前候选.*绑定/);
 });
 await regression('Shared opening facts in two material copies must agree',()=>{
  const bindings=clone(materials),open=endings(bindings[1]).find(s=>s.kind==='performance_opening'),e=bindings[1].clipMentorAnalysis!.evidence.find(e=>open.evidence_ids.includes(e.evidence_id))!;e.text='CONFLICTING_CURRENT_PERFORMANCE';
  assert.throws(()=>scoped(clone(c.green),bindings),/INPUT.*副本冲突/);
 });
 await regression('F2 a legacy first material cannot hide two later conflicting translations',()=>{
  const value=clone(c.green) as any,bindings=[clone(materials[0]),clone(materials[0]),clone(materials[0]),clone(materials[1])],line=value.delivery_sections.creator_endings.new_contact;
  delete ending(bindings[0]).line.labels_zh;ending(bindings[1]).line.labels_zh=line.labels.map(()=> 'AUTHOR_A');ending(bindings[2]).line.labels_zh=line.labels.map(()=> 'AUTHOR_B');line.labels_zh=line.labels.map(()=> 'AUTHOR_A');
  assert.throws(()=>scoped(value,bindings),/INPUT.*副本冲突/);
 });
 await regression('F2 a legacy first mirror cannot hide a later explicit Chinese conflict',()=>{
  const value=clone(c.green) as any,ir=value.clipMentorAnalysis.blueprint[0].internal_review,current=ir[ir.current_script_candidate].lines[0],index=value.narration_and_captions.findIndex((l:any)=>l.id===current.id),legacy=clone(value.narration_and_captions[index]),provided=clone(legacy);
  delete legacy.labels_zh;provided.labels_zh=provided.labels.map(()=> 'AUTHOR_A');current.labels_zh=current.labels.map(()=> 'AUTHOR_B');value.narration_and_captions.splice(index,1,legacy,provided);
  assert.throws(()=>scoped(value,clone(materials)),/INPUT.*冲突/);
 });
 await regression('Human board cannot claim unreviewed when supplied projects contain review history',()=>{
  const value=clone(c.green) as any,bindings=clone(materials);value.release_status={copy_review:'not_requested',audio_measurement:'not_done'};
  (bindings[0].clipMentorAnalysis as any).production_copy_review={verdict:'needs_revision'};
  const result=scoped(value,bindings),html=humanReviewBoardPage(result.plans[0],result.data,result.lint,bindings),header=html.match(/<header>[\s\S]*?<\/header>/)![0];
  assert(header.includes('审核状态未在本板核验'));assert(!header.includes('未送审'),'a candidate flag must not overwrite supplied project history');assert(!header.includes('已审核通过'));
 });
 assert.deepEqual(regressions,[],'Adversarial reader/binding regressions must all pass');
 await test('Read-only boards remain available in frozen handoffs without widening mutation access',async()=>{
  const {handoffToolAccess,parseHandoffBrief}=await import('../../shared/clipmentor-handoff');
  for(const mode of ['collaborative','autonomous'] as const)for(const phase of ['planning','execution'] as const)for(const bound of [false,true]){
   const brief=parseHandoffBrief({version:1,briefId:'board-read-only',revision:1,mode,phase,planner:mode==='collaborative'?'external_codex':'builtin_agent',executor:'builtin_agent',projectId:'board-project',timelineId:'board-timeline',objective:'Read the saved plan only',doneCriteria:['Return an internal board'],blueprint:phase==='execution'?{revision:1,digest:'a'.repeat(64)}:null,budget:{maxModelTurns:0,maxToolCalls:2,maxElapsedMs:1000,paidToolCalls:{}}});
   assert.equal(handoffToolAccess(brief,'render_clipmentor_review_board',{},bound),'read');
   if(!bound)assert.throws(()=>handoffToolAccess(brief,'edit_item',{action:'update'},false));
  }
 });
 await test('P6 planner frozen bytes, before any human-only enrichment',()=>{
  const p=prepare(c.green).plans[0];p.generated_at='2026-01-01T00:00:00.000Z';p.elapsed_ms=0;
  assert.equal(hash(JSON.stringify(c.green)),baseline.fixture_sha256);assert.equal(hash(blueprintReviewBoardPage(p)),baseline.planner_sha256);
 });
 const data=clone(c.green) as any;
 for(const e of data.clipMentorAnalysis.evidence)if(e.kind==='original_claim')e.meaning_zh='策划译文 '+e.evidence_id;
 const add=(l:any)=>{l.labels_zh=(l.labels??[]).map((_:string,i:number)=>'短标译文 '+i);};
 for(const l of data.narration_and_captions)add(l);
 for(const u of data.clipMentorAnalysis.blueprint){const ir=u.internal_review;for(const l of ir[ir.current_script_candidate].lines)add(l);for(const l of ir[ir.current_picture_plan].selected_narration??[])add(l);}
 for(const l of [data.delivery_sections.opening,...Object.values(data.delivery_sections.creator_endings)])add(l);
 const p=prepare(data),board=p.plans[0],page=humanReviewBoardPage(board,p.data,p.lint,materials);
 await test('P2 interval overlap oracle includes every original claim, sorts by time and excludes touching endpoints',()=>{
  for(const id of ['GM-G1','GM-G2','GM-G3','GM-G4','GM-G5']){
   const rows=board.rows.filter(r=>r.unit_id===id&&r.stage==='original');
   const expected=data.clipMentorAnalysis.evidence.filter((e:any)=>e.kind==='original_claim'&&rows.some(r=>r.range&&Math.max(r.range[0],e.source_range_seconds[0])<Math.min(r.range[1],e.source_range_seconds[1]))).map((e:any)=>e.evidence_id);
   assert.deepEqual(sourceSpeech(p.data,rows).map(e=>e.id),expected);
  }
  const exact=clone(p.data) as any;exact.analysis.evidence=[{evidence_id:'left',kind:'original_claim',text:'outside',source_range_seconds:[0,1]},{evidence_id:'inside',kind:'original_claim',text:'actual',source_range_seconds:[1,2]},{evidence_id:'right',kind:'original_claim',text:'outside',source_range_seconds:[2,3]}];
  assert.deepEqual(sourceSpeech(exact,[{...board.rows[1],range:[1,2]}]).map(e=>e.id),['inside']);
  assert(page.includes('模型听写，未经人工听审；中文为策划译文'));
  assert(/class="source-ms"><summary>马来语原话<\/summary>/.test(page));assert(!/class="source-ms" open/.test(page));
  assert(page.indexOf('class="speech-meaning"')<page.indexOf('class="source-ms"'));assert(page.includes('原片 5.2秒'));
 });
 await test('P3 missing Chinese is explicit, wrong count and wrong type never guess pairings',()=>{
  const legacy=prepare(c.green),html=humanReviewBoardPage(legacy.plans[0],legacy.data,legacy.lint,materials);assert(html.includes('缺中文'));assert(html.includes('Transferproof.'));
  for(const value of [[],['only one','too','many'],7]){
   const v=clone(data),u=v.clipMentorAnalysis.blueprint[0],ir=u.internal_review,l=ir[ir.current_script_candidate].lines[0];l.labels_zh=value;
   v.narration_and_captions.find((q:any)=>q.id===l.id).labels_zh=value;
   const plan=ir[ir.current_picture_plan];for(const key of ['selected_narration','lines'])for(const q of plan[key]??[])if(q.id===l.id)q.labels_zh=value;
   const prepared=prepare(v);const labels=translatedLabels(prepared.data,l.id);assert(labels.invalid);assert(labels.pairs.every(p=>p.zh===''));
   const bad=humanReviewBoardPage(prepared.plans[0],prepared.data,prepared.lint,materials);assert(bad.includes('data-input-code="INPUT"'));assert(!bad.includes('→ only one'));
  }
 });
 await test('P4 R1 links resolve, R2 uses exact group unknowns, R3/R4 retain bound facts verbatim',()=>{
  const ids=new Set([...page.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]));const links=[...page.matchAll(/href="#((?:speech|source-group)-[^"]+)"/g)].map(m=>m[1]);assert.equal(links.length,6);assert(links.every(id=>ids.has(id)));assert(page.includes('回看原片 41–51.5秒'));
  for(const unknown of unitUnknowns(p.data,'GM-G4'))assert(page.includes(unknown.replace(/&/g,'&amp;')));
  for(const doc of materials)for(const e of doc.clipMentorAnalysis!.evidence.filter(e=>e.kind==='operator_supplied'))if(['GM-OP-metrics','GM-OP-terms'].includes(e.evidence_id))assert(page.includes(e.text),'bound business fact must stay verbatim');
  assert(page.includes('登记口径，核对左侧截图'));assert(page.includes('画面安排与合作条件'));assert(page.includes('口播说法（原文）'));
  assert(page.includes('Ulasan semula → 回看讲解'));assert(page.includes('Video asal → 原片'));
  const reused=clone(board);reused.rows.find(r=>r.line_ids.includes('GM-L05'))!.range=[0,1];
  const reusedPage=humanReviewBoardPage(reused,p.data,p.lint,materials),section=reusedPage.split('data-card="group-5"')[1].split('data-card="endings"')[0];assert(section.includes('href="#speech-1-0"'),'cross-group reuse links to the source group, not a false missing claim');

 });
 await test('P5 translation fields survive native import/read and never enter actual review projection',async()=>{
  const {makeDraft}=await import('../../src/editor/store');const {execClipMentorAnalysisTool}=await import('../../src/agent/tools/clipmentor-analysis-tools');
  const source=clone(c.barelyFour) as unknown as ProjectDoc;const before=JSON.stringify(await copyTeachingPacketFromDoc(source));
  const marker='SYNTHETIC_AUTHOR_TRANSLATION_NOT_REVIEW';
  for(const e of source.clipMentorAnalysis!.evidence)e.meaning_zh=marker;
  for(const u of source.clipMentorAnalysis!.blueprint){const ir=(u as any).internal_review;for(const l of ir[ir.current_script_candidate].lines)l.labels_zh=(l.labels??[]).map(()=>marker);for(const l of ir[ir.current_picture_plan].selected_narration??[])l.labels_zh=(l.labels??[]).map(()=>marker);for(const s of ir[ir.current_picture_plan].delivery_sections??[])s.line.labels_zh=s.line.labels.map(()=>marker);}
  assert(isClipMentorAnalysis(source.clipMentorAnalysis));const bad=clone(source);bad.clipMentorAnalysis!.evidence[0].meaning_zh=7 as any;assert(!isClipMentorAnalysis(bad.clipMentorAnalysis));
  const context=clone(source);delete context.clipMentorAnalysis;const draft=makeDraft(context);
  const actor={operator:'test',executor:'test',instruction:'Synthetic human translations',identity:'local_declared_not_authenticated'};
  const result=await execClipMentorAnalysisTool('revise_clipmentor_analysis',{action:'import',input:source.clipMentorAnalysis,assetId:source.clipMentorAnalysis!.source.asset_id,expectedRevision:0,actor,reason:'Translation persistence regression only'},{...draft,getCreativeMode:()=> 'clipmentor',templates:[],audio:[]}) as any;
  assert(result.ok,JSON.stringify(result));const cold=JSON.parse(JSON.stringify(draft.getDoc())) as ProjectDoc;
  assert(cold.clipMentorAnalysis!.evidence.every(e=>e.meaning_zh===marker));assert(!(cold.clipMentorAnalysis as any).production_copy_review);
  const packet=await copyTeachingPacketFromDoc(source);assert.equal(JSON.stringify(packet),before,'author translations do not alter the neutral material projection');
  const request=buildCopyTeachingReviewRequest([{case_id:'neutral',packet}]);assert(!JSON.stringify(request).includes(marker));
  const u=cold.clipMentorAnalysis!.blueprint[0] as any,ir=u.internal_review,lines=clone(ir[ir.current_script_candidate].lines),plan=clone(ir[ir.current_picture_plan]);
  for(const l of lines)l.labels_zh=(l.labels??[]).map(()=>marker);
  if(plan.selected_narration)plan.selected_narration=clone(lines);
  const r=await execClipMentorAnalysisTool('revise_clipmentor_analysis',{action:'set_copy_candidate',id:u.unit_id,expectedRevision:cold.clipMentorAnalysis!.revision,actor,reason:'Optional translations registration',record:{source_candidate_id:ir.current_script_candidate,candidate_id:'script_candidate_human_translation',plan_id:'picture_plan_human_translation',lines,plan,line_guidance:u.line_guidance}},{...draft,getCreativeMode:()=> 'clipmentor',templates:[],audio:[]})as any;assert(r.ok,JSON.stringify(r));
  const now=(JSON.parse(JSON.stringify(draft.getDoc())) as ProjectDoc).clipMentorAnalysis!.blueprint[0] as any;assert.deepEqual(now.internal_review[now.internal_review.current_script_candidate].lines.map((l:any)=>l.labels_zh),lines.map((l:any)=>l.labels_zh));
  const readContext={...draft,getCreativeMode:()=> 'clipmentor',templates:[],audio:[]};
  const readCopy=await execClipMentorAnalysisTool('read_clipmentor_analysis',{view:'current_copy',copyPart:'candidate',unitId:u.unit_id},readContext) as any;
  assert.deepEqual(readCopy.analysis.current_copy[0].candidate.lines.map((l:any)=>l.labels_zh),lines.map((l:any)=>l.labels_zh),'narrow current-copy whitelist keeps optional label Chinese');
  const eid=draft.getDoc().clipMentorAnalysis!.evidence[0].evidence_id;
  const readEvidence=await execClipMentorAnalysisTool('read_clipmentor_analysis',{view:'evidence',evidenceIds:[eid]},readContext) as any;
  assert.equal(readEvidence.analysis.evidence[0].meaning_zh,marker,'original evidence read returns the optional planner translation');
  const beforeBad=JSON.stringify(draft.getDoc()),badLines=clone(lines);badLines[0].labels_zh=[...(badLines[0].labels??[]).map(()=>marker),'extra'];
  const denied=await execClipMentorAnalysisTool('revise_clipmentor_analysis',{action:'set_copy_candidate',id:u.unit_id,expectedRevision:draft.getDoc().clipMentorAnalysis!.revision,actor,reason:'Mismatched optional Chinese',record:{source_candidate_id:now.internal_review.current_script_candidate,candidate_id:'script_candidate_bad_translation',plan_id:'picture_plan_bad_translation',lines:badLines,plan,line_guidance:u.line_guidance}},{...draft,getCreativeMode:()=> 'clipmentor',templates:[],audio:[]}) as any;
  assert.match(denied.error,/Copy lines require/);assert.equal(JSON.stringify(draft.getDoc()),beforeBad,'invalid translation cannot partially commit');
 });
 await test('P5 delivery optional translations validate without exposing them to review',async()=>{
  const source=clone(materials[0]);const clean=buildCopyTeachingReviewRequest([{case_id:'neutral',packet:await copyTeachingPacketFromDoc(source)}]);
  for(const u of source.clipMentorAnalysis!.blueprint){const ir=(u as any).internal_review;for(const s of ir[ir.current_picture_plan].delivery_sections??[])s.line.labels_zh=s.line.labels.map(()=> 'SYNTHETIC_TRANSLATION');}
  assert.deepEqual(buildCopyTeachingReviewRequest([{case_id:'neutral',packet:await copyTeachingPacketFromDoc(source)}]),clean);
  const ir=(source.clipMentorAnalysis!.blueprint[0] as any).internal_review,sections=ir[ir.current_picture_plan].delivery_sections;assert(deliverySectionsShape(sections));sections[0].line.labels_zh=['bad length'];assert(!deliverySectionsShape(sections));
 });
 await test('No automatic semantic verdict or translation, no caller mutation or network',()=>{assert.equal(JSON.stringify(c),original);assert.equal(network,0);assert(!/已匹配|讲解已覆盖|语义通过/.test(page));assert(!page.includes('>通过<'));});
 console.log(JSON.stringify({tests:tests.length,network,real_model_calls:0,passed:true}));
}finally{globalThis.fetch=fetchBefore;}
