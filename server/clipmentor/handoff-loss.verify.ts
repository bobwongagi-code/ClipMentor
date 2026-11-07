// Entry-contract regression: imports only pre-existing public entries, so it also runs on the frozen pre-fix tree.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import saved from '../../src/clipmentor/fixtures/production-saved-projects-20261028.json';
import type {ProjectDoc} from '../../src/editor/types';







import type {ProductionTask} from './production-task';
import type {HeadlessOptions} from './headless-editor';
import type {MemoryPersistence as Persistence} from '../external-agent/offline-runtime.verify-fixtures';
const root=await mkdtemp(join(tmpdir(),'handoff-loss-')),prior=process.env.OPENCHATCUT_DATA_DIR,priorFetch=globalThis.fetch;
process.env.OPENCHATCUT_DATA_DIR=root;let network=0;globalThis.fetch=async()=>{network++;throw Error('Network forbidden');};
const {productionAuthorTaskData}=await import('./production-worker');
const {productionFeedback}=await import('./production-task');
const {openHeadlessEditor}=await import('./headless-editor');
const {MemoryPersistence,projectId}=await import('../external-agent/offline-runtime.verify-fixtures');
const {copyReviewSubject,copyTeachingPacketFromDoc,buildCopyTeachingReviewRequest}=await import('../../src/clipmentor/production-gate');
const {productionPreviewFacts,previewFactsDigest}=await import('./production-preview-facts');
const {revisionOf}=await import('../../src/agent/external-edit-session');
assert.equal((await import('../runtime-profile')).runtimeProfile().rootDir,root,'profile must resolve AFTER temporary data dir is set');
const cases:Array<{name:string;passed:boolean;error?:string}>=[];
async function test(name:string,work:()=>Promise<void>){try{await work();cases.push({name,passed:true});console.log('PASS',name);}catch(error){cases.push({name,passed:false,error:String(error).slice(0,300)});console.log('FAIL',name,String(error).slice(0,300));}}
const doc=()=>structuredClone(saved.cases[0].doc) as unknown as ProjectDoc;
const options=(p:Persistence,extra:Record<string,unknown>={})=>({projectId,runId:'fixture',origin:'http://127.0.0.1:5199',review:{provider:'openai',model:'fixture',origin:'http://127.0.0.1:5199',apiMode:'responses'},persistence:p,browserConnected:()=>false,effect:async()=>{throw Error('No provider effects');},...extra}) as HeadlessOptions;
try{
 await test('product edit and audio consume current packet, identities and measured audio',async()=>{
  const d=doc();
  for(const stage of ['edit','audio'] as const){const value=await productionAuthorTaskData({stage,input:{brief:'frozen',sourceAssetId:d.clipMentorAnalysis!.source.asset_id}} as ProductionTask,d) as any;
   assert.equal(value.frozenBlueprint.audio.length,6);assert(value.frozenBlueprint.audio.every((v:any)=>v.assetId&&v.durationSeconds>0&&v.src));assert(value.frozenBlueprint.packet.units[0].intent_zh);}
 });
 await test('actual collaborative send excludes historical candidates and keeps complete current plan',async()=>{
  const {withSerializedProjectStore}=await import('../plugins/project-store');
  const {registerHandoff,prepareHandoff}=await import('./handoff');
  const d=doc();const internal=d.clipMentorAnalysis!.blueprint[0].internal_review as Record<string,unknown>;
  internal.obsolete_draft={reason:'OBSOLETE_HANDOFF_SENTINEL'};
  await withSerializedProjectStore(s=>s.writeEntry('project:current-handoff-fixture',d));const subject=await copyReviewSubject(d);
  await registerHandoff({projectId:'current-handoff-fixture',expectedProjectRevision:revisionOf(d),previousDigest:null,brief:{version:1,briefId:'current-fixture',revision:1,mode:'collaborative',phase:'execution',planner:'external_codex',executor:'builtin_agent',projectId:'current-handoff-fixture',timelineId:d.activeTimelineId,objective:'Execute current only',doneCriteria:['Preserve current copy'],blueprint:{revision:subject.revision,digest:subject.digest},budget:{maxModelTurns:1,maxToolCalls:1,maxElapsedMs:10000,paidToolCalls:{}}}});
  const prepared=await prepareHandoff('current-handoff-fixture',[{role:'user',content:'Run frozen decisions'}]);assert(prepared);
  const sent=JSON.parse(prepared.messages[0].content as string);
  assert(!JSON.stringify(sent).includes('OBSOLETE_HANDOFF_SENTINEL'));assert.equal(sent.blueprint.packet.units[0].picture_plan.execution_plan.plan_id,internal.current_picture_plan);
 });
 await test('actual native edit applies frozen caption style without model choosing parameters',async()=>{
  const d=doc(),p=new MemoryPersistence(d),e=await openHeadlessEditor(options(p));
  try{const line=(await copyTeachingPacketFromDoc(d)).units[0].lines[0];
   const result=await e.execute('edit_item',{adds:[{type:'text',text:line.caption_lines[0],track:'V1',fromFrame:10000,durationInFrames:30}]},'caption') as any;
   assert(!result.error,JSON.stringify(result));const item=e.getDoc().timelines[0].items.find(i=>i.kind==='text'&&i.props?.text===line.caption_lines[0]);assert.equal(item?.props?.fontSize,28);
   const frozen=JSON.stringify(p.current);const rejected=await e.execute('edit_item',{adds:[{type:'text',text:line.caption_lines[0],color:'#ff0000'}]},'style-conflict') as any;
   assert(rejected.error);assert.equal(JSON.stringify(p.current),frozen);
  }finally{await e.close();}
 });
 await test('exact existing voice reused through original host with zero synthesis effects',async()=>{
  const d=doc(),line=(await copyTeachingPacketFromDoc(d)).units[0].lines[0],a=d.assets.find(a=>a.kind==='audio')!;
  const request={text:line.narration_ms,provider:'minimax',voiceId:'fixture-voice',speed:1,pitch:0,volume:1,languageBoost:'Malay',sampleRate:32000,channel:1,audioFormat:'mp3'};
  a.props={...a.props,generation:{...request,durationSeconds:a.durationInFrames/30}};
  let effects=0;const e=await openHeadlessEditor(options(new MemoryPersistence(d),{voice:{provider:'minimax',voiceId:'fixture-voice'},effect:async()=>{effects++;throw Error('Forbidden synth');}}));
  try{const reused=await e.execute('submit_voice',request,'reuse') as any;assert.equal(reused.reused,true);assert.equal(reused.asset.id,a.id);assert.equal(effects,0);}finally{await e.close();}
 });
 await test('local feedback protection runs BEFORE every real host commit',async()=>{
  const d=doc(),p=new MemoryPersistence(d),target=d.timelines[0].items[0],other=d.timelines[0].items[1];
  const e=await openHeadlessEditor(options(p,{finalFeedback:{kind:'execution',item_ids:[target.id],preview:{timelineId:d.activeTimelineId}}}));
  try{const frozen=JSON.stringify(p.current);
   await assert.rejects(e.execute('edit_item',{updates:[{type:other.kind,itemId:other.id,transform:{x:5}}]},'outside-scope'),/unaffected/);assert.equal(JSON.stringify(p.current),frozen);
   const result=await e.execute('edit_item',{updates:[{type:target.kind,itemId:target.id,transform:{x:2}}]},'inside-scope') as any;assert(!result.error);assert.equal(e.getDoc().timelines[0].items[0].transform?.x,2);
   const committed=JSON.stringify(p.current);const bad=structuredClone(e.getDoc());bad.assets.find(a=>a.kind==='video')!.src='/media/uploads/wrong.mp4';e.context.commands.applyDoc(bad);
   await assert.rejects(e.commit(),/shared_asset/);assert.equal(JSON.stringify(p.current),committed);
  }finally{await e.close();}
 });
 await test('unbound final text cannot silently restart the whole blueprint',async()=>{
  const task={status:'awaiting_review',feedbackUsed:false,completed:{},input:{}} as ProductionTask;const frozen=JSON.stringify(task);
  await assert.rejects(productionFeedback(task,'Move this label',{save:async()=>undefined,load:async()=>task}));assert.equal(JSON.stringify(task),frozen);
 });
 await test('bound execution feedback resumes edit; content feedback resumes blueprint; save failure retains task',async()=>{
  const d=doc(),t=d.timelines[0],facts=productionPreviewFacts(d,t,await copyTeachingPacketFromDoc(d));
  const base={status:'awaiting_review',feedbackUsed:false,completed:{analysis:{at:1,artifact:{ok:true}},blueprint:{at:1,artifact:{ok:true}},export:{at:1,artifact:{renderId:'fixture-render',revision:revisionOf(d),facts_digest:previewFactsDigest(facts)}}},input:{},sequence:0,updatedAt:1} as unknown as ProductionTask;
  const input={text:'Move target',kind:'execution',preview:{revision:revisionOf(d),renderId:'fixture-render',facts_digest:previewFactsDigest(facts),timelineId:t.id},unit_ids:[],item_ids:[t.items[0].id]};
  for(const kind of ['execution','content']){const task=structuredClone(base);await (productionFeedback as any)(task,{...input,kind},{save:async()=>undefined,load:async()=>task},d);assert.equal(task.stage,kind==='execution'?'edit':'blueprint');assert(task.completed.analysis);if(kind==='execution')assert(task.completed.blueprint);}
  const task=structuredClone(base),snapshot=JSON.stringify(task);await assert.rejects((productionFeedback as any)(task,input,{save:async()=>{throw Error('checkpoint failed');},load:async()=>task},d));assert.equal(JSON.stringify(task),snapshot);
 });
 await test('author additions and saved repair context do not enter independent reviewer input',async()=>{
  const d=doc(),before=buildCopyTeachingReviewRequest([{case_id:'isolated',packet:await copyTeachingPacketFromDoc(d)}]);
  (d.clipMentorAnalysis!.blueprint[0].internal_review as any).self_check={expected_answer:'AUTHOR_EXPECTED_ANSWER'};
  const after=buildCopyTeachingReviewRequest([{case_id:'isolated',packet:await copyTeachingPacketFromDoc(d)}]);assert.deepEqual(after,before);assert(!JSON.stringify(after).includes('AUTHOR_EXPECTED_ANSWER'));
 });
 assert.equal(network,0);
 console.log(JSON.stringify({passed:cases.filter(c=>c.passed).length,failed:cases.filter(c=>!c.passed).length,cases,network}));
 if(cases.some(c=>!c.passed))process.exitCode=1;
}finally{globalThis.fetch=priorFetch;if(prior===undefined)delete process.env.OPENCHATCUT_DATA_DIR;else process.env.OPENCHATCUT_DATA_DIR=prior;await rm(root,{recursive:true,force:true});}
