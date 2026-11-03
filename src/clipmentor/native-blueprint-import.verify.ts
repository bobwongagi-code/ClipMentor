import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';import{tmpdir}from'node:os';
import saved from '../agent/tools/fixtures/barely-there-mg-replacement-20261030.json';
import type {ProjectDoc}from'../editor/types';
const dir=await mkdtemp(join(tmpdir(),'native-blueprint-import-')),oldData=process.env.OPENCHATCUT_DATA_DIR,oldFetch=globalThis.fetch;
process.env.OPENCHATCUT_DATA_DIR=dir;let network=0;globalThis.fetch=async()=>{network++;throw Error('No provider/network calls');};
try{
 const {makeDraft}=await import('../editor/store');
 const {execClipMentorAnalysisTool}=await import('../agent/tools/clipmentor-analysis-tools');
 const {copyTeachingPacketFromDoc,checkCopyProduction}=await import('./production-gate');
 const {deliverySectionsFromDoc}=await import('./delivery-sections');
 const actor={operator:'fixture',executor:'external_planner',instruction:'Import frozen full blueprint',identity:'local_declared_not_authenticated'};
 const source=()=>structuredClone(saved.before)as unknown as ProjectDoc;
 const pack=(d:ProjectDoc)=>{
  const sections=deliverySectionsFromDoc(d),line=(s:typeof sections[number])=>({id:s.line.line_id,narration_ms:s.line.narration_ms,caption_lines:s.line.caption_lines,zh:s.line.meaning_zh,labels:s.line.labels});
  return{clipMentorAnalysis:structuredClone(d.clipMentorAnalysis),delivery_sections:{opening:line(sections.find(s=>s.kind==='performance_opening')!),creator_endings:{existing_partner:line(sections.find(s=>s.kind==='creator_invitation')!)},shared_body_once:true}};
 };
 const run=async(d:ProjectDoc,input:unknown)=>{
  const before=structuredClone(d);delete before.clipMentorAnalysis;
  const draft=makeDraft(before),initial=JSON.stringify(draft.getDoc());
  const result=await execClipMentorAnalysisTool('revise_clipmentor_analysis',{action:'import',input,assetId:d.clipMentorAnalysis!.source.asset_id,expectedRevision:0,actor,reason:'Contract regression only'},{...draft,getCreativeMode:()=> 'clipmentor',templates:[],audio:[]})as {ok?:boolean;error?:string};
  return{result,doc:draft.getDoc(),unchanged:JSON.stringify(draft.getDoc())===initial};
 };
 const tests:Array<{name:string;ok:boolean;error?:string}>=[];
 const test=async(name:string,fn:()=>Promise<void>)=>{try{await fn();tests.push({name,ok:true});console.log('PASS',name);}catch(e){tests.push({name,ok:false,error:String(e)});console.error('FAIL',name,String(e));}};
 await test('existing native analysis imports through original action; source and wording retained, no approval',async()=>{
  const d=source(),r=await run(d,d.clipMentorAnalysis);assert(r.result.ok,JSON.stringify(r.result));
  const a=r.doc.clipMentorAnalysis!;assert.deepEqual(a.source,d.clipMentorAnalysis!.source);assert(!a.production_copy_review);
  assert.deepEqual((await copyTeachingPacketFromDoc(r.doc)).units.map(u=>u.lines),(await copyTeachingPacketFromDoc(d)).units.map(u=>u.lines));assert(!(await checkCopyProduction(r.doc,'clipmentor')).allowed);
 });
 await test('full local wrapper imports with both opening and selected creator ending in actual packet',async()=>{
  const d=source(),p=pack(d),original=JSON.stringify(p),r=await run(d,p);assert(r.result.ok,JSON.stringify(r.result));assert.equal(JSON.stringify(p),original);
  const packet=await copyTeachingPacketFromDoc(r.doc);assert.equal(packet.delivery_sections!.length,2);assert.equal(packet.delivery_sections![0].line.narration_ms,p.delivery_sections.opening.narration_ms);
 });
 await test('declared opening/ending cannot disappear when only analysis was materialized',async()=>{
  const d=source(),p=pack(d);for(const u of p.clipMentorAnalysis!.blueprint){const ir=(u as unknown as Record<string,unknown>).internal_review as Record<string,unknown>;delete(ir[String(ir.current_picture_plan)]as Record<string,unknown>).delivery_sections;}
  const r=await run(d,p);assert.equal(r.result.error,'blueprint_declared_delivery_unbound');assert(r.unchanged);
 });
 await test('malformed or empty declarations fail instead of becoming an implicit body-only task',async()=>{
  for(const bad of [{opening:{}},{creator_endings:{}},{opening:null},{opening:pack(source()).delivery_sections.opening,creator_endings:'invalid'}]){
   const d=source(),p={...pack(d),delivery_sections:bad},r=await run(d,p);assert.equal(r.result.error,'blueprint_import_invalid');assert(r.unchanged);
  }
 });
 await test('undeclared extra delivery cannot slip into the selected variant',async()=>{
  const d=source(),p={...pack(d),delivery_sections:{opening:pack(d).delivery_sections.opening}},r=await run(d,p);assert.equal(r.result.error,'blueprint_declared_delivery_unbound');assert(r.unchanged);
 });
 await test('declared body mirror must match current selected copy, including labels and Chinese meaning',async()=>{
  const d=source(),p=pack(d),lines=d.clipMentorAnalysis!.blueprint.flatMap(u=>{const ir=(u as unknown as Record<string,unknown>).internal_review as Record<string,unknown>;return(ir[String(ir.current_script_candidate)]as {lines:unknown[]}).lines;});
  const full={...p,narration_and_captions:structuredClone(lines)};assert((await run(d,full)).result.ok);
  (full.narration_and_captions[0]as Record<string,unknown>).zh='Stale read-view meaning';const r=await run(d,full);assert.equal(r.result.error,'blueprint_body_copy_mismatch');assert(r.unchanged);
 });
 await test('different declared wording cannot be replaced by stale bound delivery copy',async()=>{
  const d=source(),p=pack(d);p.delivery_sections.opening.narration_ms+=' Changed.';
  const r=await run(d,p);assert.equal(r.result.error,'blueprint_delivery_copy_mismatch');assert(r.unchanged);
 });
 await test('missing or wrong image/hash blocks full wrapper without publication',async()=>{
  for(const bad of ['missing','hash']){const d=source(),p=pack(d),sections=deliverySectionsFromDoc(d),id=sections[0].picture.asset_id;
   if(bad==='missing')d.assets=d.assets.filter(a=>a.id!==id);else d.assets.find(a=>a.id===id)!.sourceContentHash='f'.repeat(64);
   const r=await run(d,p);assert.equal(r.result.error,'blueprint_delivery_asset_binding_invalid');assert(r.unchanged);
  }
 });
 await test('source mismatch rejects and cannot relabel source media',async()=>{
  const d=source(),p=pack(d);p.clipMentorAnalysis!.source.sourceContentHash='f'.repeat(64);
  const r=await run(d,p);assert.equal(r.result.error,'blueprint_import_source_mismatch');assert(r.unchanged);
 });
 await test('intentional body-only native import remains valid without forced opening/ending',async()=>{
  const d=source();for(const u of d.clipMentorAnalysis!.blueprint){const ir=(u as unknown as Record<string,unknown>).internal_review as Record<string,unknown>;delete(ir[String(ir.current_picture_plan)]as Record<string,unknown>).delivery_sections;}
  const r=await run(d,d.clipMentorAnalysis);assert(r.result.ok,JSON.stringify(r.result));assert.equal((await copyTeachingPacketFromDoc(r.doc)).delivery_sections?.length??0,0);
 });
 await test('imported historical candidates stay readable but broken active pointers still refuse atomically',async()=>{
  const d=source(),p=pack(d),ir=(p.clipMentorAnalysis!.blueprint[0] as unknown as Record<string,unknown>).internal_review as Record<string,unknown>;
  ir.current_picture_plan='missing';const r=await run(d,p);assert(r.result.error);assert(r.unchanged);
 });
 await test('initial import history allowance never applies to ordinary revisions or existing units',async()=>{
  const {blueprintRevisionError}=await import('./source-breakdown');const d=source(),units=d.clipMentorAnalysis!.blueprint;
  assert(blueprintRevisionError([],units),'ordinary revision cannot inject historical copy');
  assert.equal(blueprintRevisionError([],units,true),null);
  const changed=structuredClone(units),ir=(changed[0] as unknown as Record<string,unknown>).internal_review as Record<string,unknown>;
  ir.extra_candidate={lines:[{id:'unselected'}]};assert(blueprintRevisionError(units,changed,true));
 });
 const plans=(d:ProjectDoc)=>d.clipMentorAnalysis!.blueprint.map(u=>{const ir=(u as unknown as Record<string,unknown>).internal_review as Record<string,unknown>;return ir[String(ir.current_picture_plan)]as Record<string,unknown>;});
 const noVoice=()=>{const d=source();d.assets=d.assets.filter(a=>a.kind!=='audio');d.timelines.forEach(t=>{t.items=[];});for(const p of plans(d))for(const v of (p.delivery_sections??[])as Array<{voice:Record<string,unknown>;picture:Record<string,unknown>}>) {delete v.voice.existing_audio;delete v.picture.display;}return d;};
 await test('phased picture material can register before voice exists; no audio or approval is invented',async()=>{
  const d=noVoice(),fps=d.timelines[0].fps;for(const p of plans(d))for(const v of (p.delivery_sections??[])as Array<{picture:Record<string,unknown>}>)v.picture.display={fps,ranges:[[0,1]]};
  const r=await run(d,pack(d));assert(r.result.ok,JSON.stringify(r.result));assert.equal(r.doc.assets.filter(a=>a.kind==='audio').length,0);assert.equal((await checkCopyProduction(r.doc,'clipmentor')).allowed,false);
 });
 await test('pre-voice phases still reject wrong fps and malformed crop',async()=>{
  for(const bad of ['fps','crop']){const d=noVoice(),p=pack(d),sections=plans(d).flatMap(p=>(p.delivery_sections??[])as Array<{picture:Record<string,unknown>}>);sections[0].picture.display={fps:d.timelines[0].fps+(bad==='fps'?1:0),ranges:[[0,1]]};if(bad==='crop')sections[0].picture.crop={left:2,right:0,top:0,bottom:0};
   p.clipMentorAnalysis=d.clipMentorAnalysis;const r=await run(d,p);assert.equal(r.result.error,'blueprint_delivery_asset_binding_invalid');assert(r.unchanged);
  }
 });
 await test('full-frame pictures without a crop or synthesized voice remain legitimate',async()=>{
  const d=noVoice();for(const p of plans(d))for(const v of (p.delivery_sections??[])as Array<{picture:Record<string,unknown>}>) {delete v.picture.crop;delete v.picture.display;}
  assert((await run(d,pack(d))).result.ok);
 });
 await test('read-view source range drift cannot claim the same complete blueprint',async()=>{
  const d=source(),p=pack(d),lines=d.clipMentorAnalysis!.blueprint.flatMap(u=>{const ir=(u as unknown as Record<string,unknown>).internal_review as Record<string,unknown>;return(ir[String(ir.current_script_candidate)]as {lines:unknown[]}).lines;});
  const full={...p,narration_and_captions:structuredClone(lines)}; (full.narration_and_captions[0]as Record<string,unknown>).source_seconds=[0,1];
  const r=await run(d,full);assert.equal(r.result.error,'blueprint_body_copy_mismatch');assert(r.unchanged);
 });
 const revisePlan=async(d:ProjectDoc,remove:boolean,unitIndex=0,repair?: (plan:Record<string,unknown>)=>void)=>{
  const draft=makeDraft(d),before=JSON.stringify(draft.getDoc()),u=d.clipMentorAnalysis!.blueprint[unitIndex],ir=(u as unknown as Record<string,unknown>).internal_review as Record<string,unknown>,p=structuredClone(ir[String(ir.current_picture_plan)])as Record<string,unknown>;
  if(remove)delete p.delivery_sections;if(repair)repair(p);
  const result=await execClipMentorAnalysisTool('revise_clipmentor_analysis',{action:'set_picture_plan',id:u.unit_id,expectedRevision:d.clipMentorAnalysis!.revision,actor,reason:'Synthetic layout-only revision',record:{plan_id:'picture_plan_adversarial_revision',script_candidate_id:ir.current_script_candidate,plan:p,line_guidance:u.line_guidance}},{...draft,getCreativeMode:()=> 'clipmentor',templates:[],audio:[]})as {ok?:boolean;error?:string};
  return{result,doc:draft.getDoc(),unchanged:JSON.stringify(draft.getDoc())===before};
 };
 await test('a later group plan revision cannot silently drop registered opening and creator ending',async()=>{
  const imported=await run(noVoice(),pack(noVoice()));assert(imported.result.ok);
  const r=await revisePlan(imported.doc,true);assert.equal(r.result.error,'delivery_sections_would_be_lost');assert(r.unchanged);
 });
 await test('generic record revisions cannot erase a registered opening or ending either',async()=>{
  const imported=await run(noVoice(),pack(noVoice()));assert(imported.result.ok);
  for(const kind of ['performance_opening','creator_invitation']){
   const d=imported.doc,draft=makeDraft(d),u=structuredClone(d.clipMentorAnalysis!.blueprint[0]),ir=(u as unknown as Record<string,unknown>).internal_review as Record<string,unknown>,p=ir[String(ir.current_picture_plan)]as {delivery_sections:Array<{kind:string}>};p.delivery_sections=p.delivery_sections.filter(s=>s.kind!==kind);
   const r=await execClipMentorAnalysisTool('revise_clipmentor_analysis',{action:'revise',collection:'blueprint',id:u.unit_id,record:u,expectedRevision:d.clipMentorAnalysis!.revision,actor,reason:'Synthetic loss probe'},{...draft,getCreativeMode:()=> 'clipmentor',templates:[],audio:[]})as {error?:string};assert.equal(r.error,'delivery_sections_would_be_lost');assert.deepEqual(draft.getDoc(),d);
  }
 });
 await test('valid whole-plan local revisions retain existing delivery sections',async()=>{
  const imported=await run(noVoice(),pack(noVoice()));assert(imported.result.ok);
  for(const i of [0]){const r=await revisePlan(imported.doc,false,i);assert(r.result.ok,JSON.stringify(r.result));assert.equal(deliverySectionsFromDoc(r.doc).length,2);assert.equal((await checkCopyProduction(r.doc,'clipmentor')).allowed,false);}
 });
 await test('genuine body-only local plan revisions are not forced to add opening or ending',async()=>{
  const d=noVoice();for(const p of plans(d))delete p.delivery_sections;const imported=await run(d,d.clipMentorAnalysis);assert(imported.result.ok);
  const r=await revisePlan(imported.doc,false);assert(r.result.ok,JSON.stringify(r.result));assert.equal(deliverySectionsFromDoc(r.doc).length,0);
 });
 await test('shared commit guard protects registered sections even before native pictures are laid out',async()=>{
  const {assertDeliveryPicturePreservation}=await import('./delivery-bindings');const before=noVoice(),after=structuredClone(before);for(const p of plans(after))delete p.delivery_sections;
  assert.throws(()=>assertDeliveryPicturePreservation(before,after),/delivery_sections_would_be_lost/);assertDeliveryPicturePreservation(before,structuredClone(before));
 });
 await test('an incomplete current picture-copy mirror remains repairable with delivery scope retained',async()=>{
  const imported=await run(noVoice(),pack(noVoice()));assert(imported.result.ok);const d=imported.doc,u=d.clipMentorAnalysis!.blueprint[0],ir=(u as unknown as Record<string,unknown>).internal_review as Record<string,unknown>,lines=(ir[String(ir.current_script_candidate)]as {lines:Record<string,unknown>[]}).lines;
  plans(d)[0].selected_narration=structuredClone(lines);(plans(d)[0].selected_narration as Record<string,unknown>[])[0].narration_ms='Synthetic stale mirror';
  const r=await revisePlan(d,false,0,p=>{p.selected_narration=structuredClone(lines);});
  assert(r.result.ok,JSON.stringify(r.result));assert.equal(deliverySectionsFromDoc(r.doc).length,2);assert.equal((await checkCopyProduction(r.doc,'clipmentor')).allowed,false);
 });
 await test('undoing an unedited initial registration does not grant a production approval',async()=>{
  const {assertDeliveryPicturePreservation}=await import('./delivery-bindings');const before=noVoice(),after=structuredClone(before);delete after.clipMentorAnalysis;assertDeliveryPicturePreservation(before,after);assert.equal((await checkCopyProduction(after,'clipmentor')).code,'analysis_missing');
 });
 await test('import metadata and author self-check cannot contaminate the independent review projection',async()=>{
  const {buildCopyTeachingReviewRequest}=await import('./production-gate'),d=source(),p=pack(d),sentinel='PRIVATE_IMPORT_SELF_REVIEW_MUST_NOT_BE_REVIEWER_INPUT';
  Object.assign(p,{author_notes:sentinel,self_check:{reason:sentinel}});Object.assign(p.delivery_sections.opening,{necessity:sentinel,omission_loss:sentinel});
  for(const u of p.clipMentorAnalysis!.blueprint){const ir=(u as unknown as Record<string,unknown>).internal_review as Record<string,unknown>;Object.assign(ir,{author_notes:sentinel});Object.assign(ir[String(ir.current_script_candidate)]as object,{self_check:{reason:sentinel},author_notes:sentinel});Object.assign(ir[String(ir.current_picture_plan)]as object,{self_check:{reason:sentinel},author_notes:sentinel});
   const selected=ir[String(ir.current_picture_plan)]as Record<string,unknown>;for(const section of (selected.delivery_sections??[])as Array<{line:object;picture:object;voice:object}>){Object.assign(section.line,{author_notes:sentinel});Object.assign(section.picture,{self_check:{reason:sentinel}});Object.assign(section.voice,{expected_verdict:sentinel});}
  }
  const r=await run(d,p);assert(r.result.ok,JSON.stringify(r.result));assert(!r.doc.clipMentorAnalysis!.production_copy_review);const packet=await copyTeachingPacketFromDoc(r.doc),request=buildCopyTeachingReviewRequest([{case_id:'current',packet}]);assert.equal(request.input.cases[0].packet.delivery_sections!.length,2);assert(!JSON.stringify(request).includes(sentinel));assert.equal((await checkCopyProduction(r.doc,'clipmentor')).allowed,false);assert.equal((await checkCopyProduction(r.doc,null)).allowed,false);
 });
 assert.equal(network,0);console.log(JSON.stringify({tests,network}));assert(tests.every(t=>t.ok));
}finally{globalThis.fetch=oldFetch;if(oldData===undefined)delete process.env.OPENCHATCUT_DATA_DIR;else process.env.OPENCHATCUT_DATA_DIR=oldData;await rm(dir,{recursive:true,force:true});}
