/** Synthetic adversarial inputs, never edits to saved cases or new semantic approvals. */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintBlueprint, readBlueprint } from './blueprint-lint';
import boardFixture from './fixtures/blueprint-picture-inputs-20261103.json';
import { blueprintPictureNotices, pictureNoticeRows, verifyPictureNoticeSources } from './blueprint-picture-notices';
import { checkBlueprintFiles } from '../../server/clipmentor/blueprint-check.mts';
import corpus from './fixtures/blueprint-self-check-cases.json';
import { copyTeachingPacketFromDoc, buildCopyTeachingReviewRequest } from './production-gate';
import type { ProjectDoc } from '../editor/types';
import { checkSourceBreakdown } from './source-breakdown';
const pick = process.argv.find(x => x.startsWith('--case='))?.slice(7);
const cases: Array<[string, () => unknown | Promise<unknown>]> = [];
const test = (name: string, run: () => unknown | Promise<unknown>) => cases.push([name, run]);
const findings = (input: unknown, id: string) => lintBlueprint(input).findings.filter(f => f.rule_id === id);
const simple = (spoken: string, label: string) => ({ narration_and_captions: [{ id: 'l', narration_ms: spoken, labels: [label] }] });
test('active-candidate-not-old-mirror', () => {
 const d: any = structuredClone(corpus.cases[0].input), u = d.clipMentorAnalysis.blueprint[0], ir = u.internal_review;
 ir[ir.current_script_candidate].lines[0].narration_ms = 'Komisen 20%.';
 assert(findings(d, 'B02').some(f => f.location === 'GM-L01'));
 assert(findings(d, 'INPUT').some(f => f.message.includes('conflict')));
 assert.equal(lintBlueprint(d).line_estimates.filter(l => l.line_id === 'GM-L01').length, 1);
});
test('registered-delivery-sections-not-omitted', () => {
 const d: any = structuredClone(corpus.cases[1].input), ir = d.clipMentorAnalysis.blueprint[0].internal_review;
 const sections = ir[ir.current_picture_plan].delivery_sections;
 const opening = sections.find((s: any) => s.kind === 'performance_opening');
 opening.line.narration_ms = 'Video 256 ribu tontonan.';
 assert(findings(d, 'B02').some(f => f.location === opening.line.line_id));
 const result = lintBlueprint(d);
 assert(result.durations.every(v => v.opening_seconds > 0 && v.ending_seconds! > 0));
 const bodyIds=new Set(ir[ir.current_script_candidate].lines.map((l:any)=>l.id));
 const bodySeconds=result.line_estimates.filter(l=>bodyIds.has(l.line_id)).reduce((n,l)=>n+l.estimated_seconds!,0);
 assert(result.durations.every(v=>Math.abs(v.explanation_seconds-bodySeconds)<1e-8));
});
test('enumerated-numbers-are-not-addition', () => {
 assert.equal(findings(simple('Pilih dua, tiga warna.', '2 warna'), 'B04').length, 0);
 assert.equal(findings(simple('Pilih dua tiga warna.', '3 warna'), 'B04').length, 0);
 assert.equal(findings(simple('Pilih dua dan tiga warna.', '3 warna'), 'B04').length, 0);
 assert(findings(simple('Pilih dua, tiga warna.', '5 warna'), 'B04').length > 0);
 for(const [spoken,label] of [['Dua puluh tiga warna.','23 warna'],['Dua ratus tiga puluh empat ringgit.','RM234'],['Lima perpuluhan tujuh tujuh juta.','5.77 juta']]) assert.equal(findings(simple(spoken,label),'B04').length,0);
});
test('names-in-visual-fields-not-masked-by-working-id', () => {
 const d: any = simple('Lihat produk ini.', 'OWEN JAMES'); d.title='Green Makes'; d.product={name:'OWEN JAMES'};
 const r=lintBlueprint(d);assert(r.name_inventory.visible_text.some(x=>x.text==='OWEN JAMES'));
 const onlyWorking: any = simple('Lihat produk ini.','Produk'); onlyWorking.candidate_id='Run-17';onlyWorking.product={name:'Brand'};
 assert(!findings(onlyWorking,'B03').length, 'working ID is not evidence of inconsistent branding');
});
test('declared-current-plan-with-deleted-phases-is-not-a-legacy-plan', () => {
 const d: any = structuredClone(corpus.cases[0].input),ir=d.clipMentorAnalysis.blueprint[1].internal_review;delete ir[ir.current_picture_plan].phases;
 const r=lintBlueprint(d);assert(r.findings.some(f=>f.rule_id==='INPUT'));assert.equal(r.groups.length,4);assert(r.durations.every(x=>x.estimated_total_seconds===null));
});
test('mixed-current-and-unregistered-legacy-units-remain-readable', () => {
 const d: any = structuredClone(corpus.cases[0].input),ir=d.clipMentorAnalysis.blueprint[1].internal_review;delete ir.current_picture_plan;
 const r=lintBlueprint(d);assert.equal(r.findings.filter(f=>f.rule_id==='INPUT').length,0);assert.equal(r.groups.length,5);
});
test('unreadable-candidate-not-zero-length-success', () => {
 const r=lintBlueprint({notes:'not a blueprint'});assert(r.findings.some(f=>f.rule_id==='INPUT'));
 assert(r.durations.every(d=>d.estimated_total_seconds===null));
 assert(lintBlueprint(simple('Ayat.','Label')).durations.every(d=>d.estimated_total_seconds===null));
});
test('lower-bound-not-inflated-by-slow-outlier', () => {
 const samples=[{id:'fast2',text:'satu dua tiga empat',seconds:1,product:'s',group_id:'g'}, {id:'fast',text:'satu dua tiga empat',seconds:1,product:'s',group_id:'g'}, {id:'slow',text:'satu dua tiga empat',seconds:100,product:'s',group_id:'g'}];
 const d={narration_and_captions:[{id:'l',narration_ms:'satu dua tiga empat'}], estimated_picture_timeline:{rows:[{unit_id:'g',mode_order:['original','explanation'],original_source_seconds:[0,0.9],line_ids:['l']}]}};
 assert(lintBlueprint(d,{samples}).findings.some(f=>f.rule_id==='B05'&&f.level==='warn'));
});
test('markdown-machine-source-binding', async () => {
 const dir=await mkdtemp(join(tmpdir(),'bp-review-'));
 try {
  const json=join(dir,'current.json'), other=join(dir,'old.json'), md=join(dir,'view.md');
  await writeFile(json,JSON.stringify(simple('Ayat.','Label')));await writeFile(other,'{}');
  await writeFile(md,'Ayat.\n[机器源](old.json)\n[观察记录](old.json)');
  const r=await checkBlueprintFiles([json,'--md',md]);assert(r.findings.some(f=>f.rule_id==='B09'&&f.message.includes('source')));
  await writeFile(md,'Ayat.\n[机器源](current.json)\n[观察记录](old.json)\n[历史机器源](old.json)');
  assert(!(await checkBlueprintFiles([json,'--md',md])).findings.some(f=>f.rule_id==='B09'));
 } finally { await rm(dir,{recursive:true,force:true}); }
});
test('private-annotations-not-visible-copy', () => {
 const d: any=structuredClone(corpus.cases[0].input);
 const ir=d.clipMentorAnalysis.blueprint[0].internal_review;
 ir[ir.current_picture_plan].phases[1].author_self_check={text:'RM99,999',product:{name:'PRIVATE_NAME'}};
 assert(!findings(d,'B04').some(f=>f.excerpt==='RM99,999'));
 assert(!lintBlueprint(d).name_inventory.declared.some(n=>n.text==='PRIVATE_NAME'));
 assert.equal(findings(simple('Seribu lima ratus ringgit.','RM1,500'),'B04').length,0);
});
test('nested-self-check-private-to-author', async () => {
 const baseline=await copyTeachingPacketFromDoc(structuredClone(corpus.isolation_project.doc) as unknown as ProjectDoc);
 const d: any=structuredClone(corpus.isolation_project.doc), marker='PRIVATE_SELF_CHECK_MUST_NOT_REACH_REVIEW';
 d.delivery_record={sections:[{title:'作者自检',answers:marker}]};
 for(const u of d.clipMentorAnalysis.blueprint){const ir=u.internal_review;const p=ir[ir.current_picture_plan];
  p.author_self_check={S1:marker};p.delivery_record={sections:[{title:'作者自检',text:marker}]};

 }
 const packet=await copyTeachingPacketFromDoc(d);const request=buildCopyTeachingReviewRequest([{case_id:'neutral-current',packet}]);
 assert(!JSON.stringify(request).includes(marker));
 assert.deepEqual(request,buildCopyTeachingReviewRequest([{case_id:'neutral-current',packet:baseline}]));
 // This test also runs on the committed API, which does not yet support
 // delivery sections. Exercise its real projection; do not claim unsupported
 // section-schema checks passed or pull unrelated WIP into this lint commit.
 if ((baseline as { delivery_sections?: unknown[] }).delivery_sections?.length) {
 // Nested annotations must be projected out. Extra section-level fields are
 // rejected by the existing strict section schema before any reviewer input.
 for(const u of d.clipMentorAnalysis.blueprint){const ir=u.internal_review;for(const s of ir[ir.current_picture_plan].delivery_sections??[]){s.picture.author_self_check=marker;s.voice.author_self_check=marker;}}
 const nested=buildCopyTeachingReviewRequest([{case_id:'neutral-current',packet:await copyTeachingPacketFromDoc(d)}]);
 assert.deepEqual(nested,request);
 for(const u of d.clipMentorAnalysis.blueprint){const ir=u.internal_review;for(const s of ir[ir.current_picture_plan].delivery_sections??[])s.author_self_check=marker;}
 assert(checkSourceBreakdown(d).issues.some(i=>i.code==='delivery_sections_invalid'));
 await assert.rejects(copyTeachingPacketFromDoc(d), /source_breakdown_not_ready/);
 } else console.log('NOT_APPLICABLE section-specific guard: committed reviewer API has no delivery support; neutral projection assertions executed.');
});
// Independent oracles: valid data must be read, missing data must not be estimated,
// and each quoted picture source must resolve back to those exact saved bytes.
const green = () => structuredClone(boardFixture.cases.green) as any;
const pictureFindings = (d: unknown) => lintBlueprint(d).findings.filter(f => ['B10','B11'].includes(f.rule_id));
function quotedAt(root: unknown, path: string): unknown {
 assert(path.startsWith('$')); let rest=path.slice(1),value:any=root;
 while(rest){const m=/^(?:\.([A-Za-z_$][\w$]*)|\[(\d+|"(?:[^"\\]|\\.)*")\])/u.exec(rest);assert(m,`Not a concrete JSON path: ${path}`);const key=m[1]??JSON.parse(m[2]);assert(value!==null&&typeof value==='object'&&Object.hasOwn(value,key),`Missing quoted field: ${path}`);value=value[key];rest=rest.slice(m[0].length);}
 return value;
}
function assertPictureSources(d: unknown) {
 const found=pictureFindings(d);assert(found.length>0,'positive source case must emit at least one finding');
 for(const f of found){const paths=(f as any).locations??[f.location];assert(paths.length>0);for(const path of paths)assert.equal(quotedAt(d,path),f.excerpt);}
}
test('missing-current-picture-plan-never-falls-back-to-history',()=>{
 const d=green();for(const u of d.clipMentorAnalysis.blueprint)u.internal_review.current_picture_plan='missing-picture';
 const r=lintBlueprint(d),data=readBlueprint(d),issues=r.findings.filter(f=>f.rule_id==='INPUT');
 assert.equal(issues.length,5);for(const [i,u]of d.clipMentorAnalysis.blueprint.entries()){assert(issues.some(f=>f.location===`$.clipMentorAnalysis.blueprint[${i}].internal_review.current_picture_plan`&&f.message.includes(u.unit_id)&&f.message.includes('missing-picture')));}
 assert.equal(data.groups.length,0);assert.equal(data.uses.length,0);assert(r.line_estimates.every(l=>data.deliveryIds.has(l.line_id)));assert.equal(r.reuse.length,0);assert(r.durations.every(x=>x.estimated_total_seconds===null&&x.original_seconds===0&&x.explanation_seconds===0));
});
test('missing-plan-is-local-and-unrelated-groups-still-run',()=>{
 const d=green(),ir=d.clipMentorAnalysis.blueprint[0].internal_review;ir.current_picture_plan='missing-picture';
 const r=lintBlueprint(d),data=readBlueprint(d);assert.equal(r.findings.filter(f=>f.rule_id==='INPUT').length,1);assert.equal(r.groups.length,4);
 assert(!r.groups.some(g=>g.line_ids.includes('GM-L01')));assert(!r.line_estimates.some(l=>l.line_id==='GM-L01'));assert(!data.uses.some(u=>u.location.includes('blueprint[0]')||u.location.includes('estimated_picture_timeline')&&u.range[0]===0));
 assert(pictureFindings(d).some(f=>f.rule_id==='B11'));assert(r.line_estimates.some(l=>l.line_id==='GM-L04'));assert(r.durations.every(x=>x.estimated_total_seconds===null));
});
test('declared-plan-pointer-types-fail-without-hiding-valid-legacy-input',()=>{
 for(const target of [null,[],42,'not-a-plan']){const d=green(),ir=d.clipMentorAnalysis.blueprint[0].internal_review;ir[ir.current_picture_plan]=target;const r=lintBlueprint(d);assert(r.findings.some(f=>f.rule_id==='INPUT'&&f.location.endsWith('current_picture_plan')));assert(!r.groups.some(g=>g.line_ids.includes('GM-L01')));}
 for(const pointer of ['',null,42,'toString']){const d=green(),ir=d.clipMentorAnalysis.blueprint[0].internal_review;ir['']=structuredClone(ir[ir.current_picture_plan]);ir.current_picture_plan=pointer;const r=lintBlueprint(d);assert(r.findings.some(f=>f.rule_id==='INPUT'&&f.location.endsWith('current_picture_plan')));assert(!r.groups.some(g=>g.line_ids.includes('GM-L01')));assert(!pictureFindings(d).some(f=>f.rule_id==='B10'));}
 // Older timeline-only and genuinely local inputs have no declared current
 // picture pointer; do not make missing modern fields a new save gate.
 const legacy={narration_and_captions:[{id:'l',narration_ms:'Ini ayat.',zh:'测试'}],estimated_picture_timeline:{fps:30,rows:[{unit_id:'local',kind:'original',source_frames:[0,300]},{unit_id:'local',kind:'explanation',line_ids:['l'],source_frames:[0,300]}]}};
 const valid=lintBlueprint(legacy);assert(!valid.findings.some(f=>f.rule_id==='INPUT'));assert.equal(valid.groups.length,1);
 assert.equal(lintBlueprint(boardFixture.cases.barelyFour).findings.filter(f=>f.rule_id==='INPUT').length,0);
});
test('picture-quote-resolves-to-direct-and-composition-source',()=>{
 assertPictureSources(green());
 for(const nested of [false,true]){const d=green(),ir=d.clipMentorAnalysis.blueprint[0].internal_review,p=ir[ir.current_picture_plan];p.phases[1].picture='';p.composition={...p.composition,detail:'只用源帧21和195。'};
  if(nested){p.execution_plan={content:{phases:p.phases,composition:p.composition}};delete p.phases;delete p.composition;}
  const f=pictureFindings(d).find(f=>f.rule_id==='B10')!;assert(f.location.endsWith(nested?'.execution_plan.content.composition.detail':'.composition.detail'));assertPictureSources(d);
 }
});
test('legacy-timeline-and-prior-phase-keep-actual-picture-source',()=>{
 const d={clipMentorAnalysis:{source:{fps:30},blueprint:[{unit_id:'u',internal_review:{current_script_candidate:'copy',current_picture_plan:'plan',copy:{lines:[{id:'l1',narration_ms:'Ini ayat.',zh:'测试1'},{id:'l2',narration_ms:'Ini lagi.',zh:'测试2'}]},plan:{phases:[{line_id:'l1',picture:'只用源帧21。'},{line_id:'l2',picture:'只用源帧195。'}]}}}]},estimated_picture_timeline:{fps:30,rows:[{unit_id:'u',kind:'original',source_frames:[0,300],line_ids:[]},{unit_id:'u',kind:'explanation',source_frames:[0,300],line_ids:['l1']},{unit_id:'u',kind:'explanation',source_frames:[0,300],line_ids:['l2'],picture:'只用源帧222。'}]}};
 const found=pictureFindings(d);assert.equal(found.length,2);assert(found.some(f=>f.location==='$.clipMentorAnalysis.blueprint[0].internal_review["plan"].phases[0].picture'));assert(found.some(f=>f.location==='$.estimated_picture_timeline.rows[2].picture'));assertPictureSources(d);
});
test('runtime-picture-source-guard-keeps-valid-and-locates-mismatch',()=>{
 const d=green(),before=JSON.stringify(d),notices=blueprintPictureNotices(pictureNoticeRows(readBlueprint(d)));
 assert.equal(notices.length,2);const checked=verifyPictureNoticeSources(d,notices);assert.equal(checked.issues.length,0);assert.deepEqual(checked.notices,notices);
 // The independent oracle is the saved literal at the known G1 field, not
 // agreement between two implementations of the same path reader.
 const u=d.clipMentorAnalysis.blueprint[0],raw=u.internal_review[u.internal_review.current_picture_plan].phases[1].picture;
 assert.equal(notices[0].excerpt,raw);
 const wrong={...notices[0],excerpt:'This literal is not the saved picture text.'},mixed=verifyPictureNoticeSources(d,[wrong,notices[1]]);
 assert.equal(mixed.issues.length,1);assert.equal(mixed.issues[0].path,notices[0].location);assert.deepEqual(mixed.notices,[notices[1]]);assert.equal(JSON.stringify(d),before);
});
test('runtime-picture-source-guard-rejects-fabricated-and-incomplete-paths',()=>{
 const d=green(),[one,two]=blueprintPictureNotices(pictureNoticeRows(readBlueprint(d)));
 for(const path of ['$.not_saved.picture','$.clipMentorAnalysis.blueprint[999].picture','$.toString','$.clipMentorAnalysis.source.asset_id','$.clipMentorAnalysis.blueprint[0]();']){
  const result=verifyPictureNoticeSources(d,[{...one,location:path,locations:[path]}]);assert.equal(result.notices.length,0);assert(result.issues.length>0);
 }
 for(const bad of [{...one,locations:[]},{...two,locations:[two.location]},{...one,location:'$.not_saved.picture'}]){const result=verifyPictureNoticeSources(d,[bad]);assert.equal(result.notices.length,0);assert(result.issues.length>0);}
});
test('source-move-and-local-edits-preserve-independent-group-facts',()=>{
 const d=green(),before=lintBlueprint(d),beforeQuotes=pictureFindings(d),ir=d.clipMentorAnalysis.blueprint[0].internal_review,p=ir[ir.current_picture_plan],literal=p.phases[1].picture;
 p.phases[1].picture='';p.composition={...p.composition,detail:literal};
 const moved=lintBlueprint(d),afterQuotes=pictureFindings(d);
 assert.deepEqual(moved.groups,before.groups);assert.deepEqual(moved.durations,before.durations);assert.deepEqual(moved.reuse,before.reuse);
 assert.deepEqual(afterQuotes.map(f=>[f.rule_id,f.excerpt,f.message]),beforeQuotes.map(f=>[f.rule_id,f.excerpt,f.message]));assert(afterQuotes[0].location.endsWith('.composition.detail'));assertPictureSources(d);
 // Revise only the G1 picture prose. Other groups retain their actual facts
 // and diagnostic source identities; no matching output text is used as a pass.
 p.composition.detail=literal+' 保留其余组。';const revised=lintBlueprint(d);
 assert.deepEqual(revised.groups.filter(g=>!g.line_ids.includes('GM-L01')),before.groups.filter(g=>!g.line_ids.includes('GM-L01')));
 assert.deepEqual(pictureFindings(d).filter(f=>f.rule_id==='B11'),beforeQuotes.filter(f=>f.rule_id==='B11'));
});
test('unreadable-existing-plan-content-does-not-revive-history',()=>{
 for(const content of [{},{phases:[]},{phases:null},{phases:{}},{phases:[null]},{phases:[{}]},{phases:[{mode:'unknown',source_range_seconds:[0,1]}]},{phases:[{mode:'original'}]},{phases:[{mode:'original',source_range_seconds:[3,1]}]},{phases:[{mode:'original',source_range_seconds:[0,1000]}]},{phases:[{mode:'original',source_range_seconds:[69.2,69.2]}]}]){
  const d=green();for(const u of d.clipMentorAnalysis.blueprint){const ir=u.internal_review;ir[ir.current_picture_plan]={...content,script_candidate_id:ir.current_script_candidate};}
  const r=lintBlueprint(d),data=readBlueprint(d);assert.equal(r.findings.filter(f=>f.rule_id==='INPUT').length,5);assert.equal(r.groups.length,0);assert.equal(data.uses.length,0);assert.equal(r.reuse.length,0);assert(r.line_estimates.every(l=>data.deliveryIds.has(l.line_id)));assert(r.durations.every(x=>x.estimated_total_seconds===null&&x.original_seconds===0&&x.explanation_seconds===0));
 }
});
test('partly-valid-current-phases-are-not-partly-approved-estimates',()=>{
 const d=green(),ir=d.clipMentorAnalysis.blueprint[0].internal_review,p=ir[ir.current_picture_plan];p.phases.push({mode:'unknown',source_range_seconds:[0,1]});
 const r=lintBlueprint(d);assert.equal(r.findings.filter(f=>f.rule_id==='INPUT').length,1);assert.equal(r.groups.length,4);assert(!r.groups.some(g=>g.line_ids.includes('GM-L01')));assert(pictureFindings(d).some(f=>f.rule_id==='B11'));assert(r.durations.every(x=>x.estimated_total_seconds===null));
});
test('legacy-resolution-requires-declared-meaningful-phases-and-matching-rows',()=>{
 for(const change of ['empty-raw','null-raw','unknown-row','missing-range','missing-line','unmatched-line']){
  const d:any=structuredClone(boardFixture.cases.barelyV5),ir=d.clipMentorAnalysis.blueprint[0].internal_review,p=ir[ir.current_picture_plan],rows=d.estimated_picture_timeline.rows;
  if(change==='empty-raw')p.phases=[];if(change==='null-raw')p.phases=[null];if(change==='unknown-row')rows[1].kind='unknown';if(change==='missing-range')delete rows[1].source_frames;if(change==='missing-line')rows[1].line_ids=[];if(change==='unmatched-line')rows[1].line_ids=['not-declared-in-plan'];
  const r=lintBlueprint(d);assert(r.findings.some(f=>f.rule_id==='INPUT'),change);assert.equal(r.groups.length,0);assert(r.durations.every(x=>x.estimated_total_seconds===null));
 }
 for(const value of [boardFixture.cases.barelyV5,boardFixture.cases.barelyFour,boardFixture.cases.green]){const r=lintBlueprint(value);assert.equal(r.findings.filter(f=>f.rule_id==='INPUT').length,0);assert(r.groups.length>0);assert(r.durations.every(x=>x.estimated_total_seconds!==null));assertPictureSources(value);}
});
test('modern-implicit-explanation-and-source-alias-use-the-same-phase-facts',()=>{
 const d=green(),before=lintBlueprint(d),ir=d.clipMentorAnalysis.blueprint[0].internal_review,p=ir[ir.current_picture_plan];
 p.phases[1].source_seconds=p.phases[1].source_range_seconds;delete p.phases[1].source_range_seconds;delete p.phases[1].mode;
 const after=lintBlueprint(d);assert.equal(after.findings.filter(f=>f.rule_id==='INPUT').length,0);assert.deepEqual(after.groups,before.groups);assert.deepEqual(after.durations,before.durations);assertPictureSources(d);
});
let failed=0;let executed=0;
for(const [name,run] of cases)if(!pick||pick===name){executed++;try{await run();console.log('PASS',name);}catch(e){failed++;console.log('FAIL',name,e instanceof Error?e.message:e);}}
assert(executed>0);console.log(JSON.stringify({executed,failed,real_calls:0}));if(failed)process.exitCode=1;
