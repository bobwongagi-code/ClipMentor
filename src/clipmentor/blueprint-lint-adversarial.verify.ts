/** Synthetic adversarial inputs, never edits to saved cases or new semantic approvals. */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintBlueprint } from './blueprint-lint';
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
test('mixed-plan-and-row-units-not-lost', () => {
 const d: any = structuredClone(corpus.cases[0].input);
 const rows=d.estimated_picture_timeline.rows;
 const ir=d.clipMentorAnalysis.blueprint[1].internal_review;delete ir[ir.current_picture_plan].phases;
 assert.equal(lintBlueprint(d).groups.length, rows.length);
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
let failed=0;let executed=0;
for(const [name,run] of cases)if(!pick||pick===name){executed++;try{await run();console.log('PASS',name);}catch(e){failed++;console.log('FAIL',name,e instanceof Error?e.message:e);}}
assert(executed>0);console.log(JSON.stringify({executed,failed,real_calls:0}));if(failed)process.exitCode=1;
