import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import fixture from './fixtures/judydoll-teaching-baseline-r9.json';
import accepted from '../../src/clipmentor/fixtures/production-saved-projects-20261028.json';
import { projectDoc } from '../external-agent/offline-runtime.verify-fixtures';
import type { ProjectDoc } from '../../src/editor/types';
import type { ClipMentorAnalysis } from '../../src/clipmentor/analysis';
import type { SourceBreakdown } from '../../src/clipmentor/source-breakdown';
import type { ProductionInput } from './production-task';

const path=await mkdtemp(join(tmpdir(),'teaching-baseline-'));
const prior=process.env.OPENCHATCUT_DATA_DIR,realFetch=globalThis.fetch;
process.env.OPENCHATCUT_DATA_DIR=path;
let calls:string[]=[];
let analysisCorrection:SourceBreakdown|undefined;
const host=createServer(async(req,res)=>{
 const chunks:Buffer[]=[];
 for await(const chunk of req)chunks.push(Buffer.from(chunk));
 const body=JSON.parse(Buffer.concat(chunks).toString()) as {messages:Array<{role:string;content:string}>};
 const data=JSON.parse(body.messages.find(message=>message.role==='user')!.content);
 const stream=()=>{
  res.writeHead(200,{'content-type':'text/event-stream'});
  return (delta:unknown,finish_reason:string|null)=>res.write('data: '+JSON.stringify({id:'teaching-check-fixture',
   object:'chat.completion.chunk',created:0,model:'baseline-fixture',choices:[{index:0,delta,finish_reason}]})+'\n\n');
 };
 if(!data.units||!data.purpose){
  if(data.stage==='analysis'&&analysisCorrection){
   calls.push('analysis');
   const send=stream();
   if(body.messages.some(message=>message.role==='tool')){
    send({role:'assistant',content:'已保存教学选题。'},null);send({},'stop');
   }else{
    const args={action:'set_source_breakdown',expectedRevision:data.revision,record:analysisCorrection,reason:'按现场原片证据修订购买关注与作用',
     actor:{operator:'fixture',executor:'builtin_api_agent',instruction:'用户要求修正教学方向',identity:'local_declared_not_authenticated'}};
    send({role:'assistant',tool_calls:[{index:0,id:'call_baseline',type:'function',function:{name:'revise_clipmentor_analysis',arguments:JSON.stringify(args)}}]},null);
    send({},'tool_calls');
   }
   res.end('data: [DONE]\n\n');return;
  }
  calls.push('author');
  res.writeHead(400,{'content-type':'application/json'});
  res.end(JSON.stringify({error:{message:'author transport reached; fixture stops here'}}));
  return;
 }
 calls.push('baseline');
 const fail=data.units[0].points[0].teaching_question===fixture.source_breakdown.points[0].teaching_question.normalize('NFKC');
 const verdict={
  feedback_scope:data.feedback?'baseline':'none',summary:'ok',
  units:data.units.map((unit:any)=>({
   unit_id:unit.unit_id,status:fail?'fix':'ok',source_role:fail?'展示动作未说明教学功能':'以相同参照让受众判断差异',
   takeaway:fail?'需要回到原片确认怎样呈现购买理由':'达人可学走把观察对象和比较结果放在一起的拍法',
   evidence_ids:[data.evidence.find((e:any)=>unit.source_ranges.some(([a,b]:number[])=>e.range[0]>=a&&e.range[0]<b))?.id].filter(Boolean),
   reason:fail?'教学基线遗漏了原片承接和观众要判断的问题。':'人工标注的符合样本',
  })),
 };
 const send=stream();
 send({role:'assistant',content:'\x60\x60\x60json\n'+JSON.stringify(verdict)+'\n\x60\x60\x60'},null);
 send({},'stop');res.end('data: [DONE]\n\n');
});
try{
 await new Promise<void>((resolve,reject)=>{host.once('error',reject);host.listen(0,'127.0.0.1',resolve);});
 const address=host.address();assert(address&&typeof address!=='string');
 const origin='http://127.0.0.1:'+address.port;
 globalThis.fetch=async(input,options)=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  assert.equal(url.href,origin+'/llm/chat/completions','no real provider or other service permitted');
  return realFetch(input,options);
 };
 const {setStoredEntry}=await import('../plugins/project-store');
 const {loadOfflineStoredProject}=await import('../external-agent/offline-project-store');
 const {productionStageWorker}=await import('./production-worker');
 const {advanceProductionTask,createProductionTask,queueDraftBlueprintFeedback,productionTaskStore,panelBlueprintRequirementsDigest}=await import('./production-task');
 const {revisionOf}=await import('../../src/agent/external-edit-session');
 const {digestValue}=await import('../agent-runs/store-values');
 const {teachingBaselineSource,validateTeachingBaselineReview,teachingRebuild,staleRebuiltTeaching,
  unchangedRejectedTeaching,teachingDraftPointersDigest,teachingBaselineDigest,retireTeachingDrafts,newlyChangedTeaching}=await import('./production-teaching-baseline');
 const {copyPreparationReady,checkSourceBreakdown}=await import('../../src/clipmentor/source-breakdown');
 const old=projectDoc(1080,1920);
 old.assets=[{id:'source',kind:'video',src:'/media/uploads/judy-fixture.mp4',name:'fixture',durationInFrames:2020,width:1080,height:1920,sourceContentHash:'a'.repeat(64)}];
 old.clipMentorAnalysis={schema_version:1,analysis_id:'revision-9-fixture',revision:9,import_origin:'isolated_fixture',
  audit:[],reviews:[],...structuredClone(fixture)} as unknown as ClipMentorAnalysis;
 const taskFor=async(projectId:string,doc:ProjectDoc,maxRepairs=0)=>{
  await setStoredEntry('project:'+projectId,doc);
  const saved=(await loadOfflineStoredProject(projectId))!;
  const input:ProductionInput={projectId,sourceAssetId:doc.clipMentorAnalysis!.source.asset_id,product:doc.clipMentorAnalysis!.product,
   brief:doc.clipMentorAnalysis!.source_breakdown!.review_scope!.instruction!,author:{provider:'openai',model:'baseline-fixture',origin,apiMode:'chat'},
   reviewer:{provider:'openai',model:'independent-must-not-run',origin,apiMode:'chat'},humanBlueprintReview:true,
   panelDelivery:{productAssetId:'product',productAssetHash:'b'.repeat(64),salesAssetId:'sales',ctaAssetId:'cta',ctaAssetHash:'c'.repeat(64)},
   budget:{model:6,review:0,observation:0,tts:0,render:0,preview_review:0,maxRepairs,maxElapsedMs:120_000}};
  const task=await createProductionTask(input);
  task.projectRevision=saved.revision;task.stage='blueprint';
  task.completed.analysis={at:Date.now(),artifact:{revision:saved.revision}};
  await productionTaskStore.save(task);
  return task;
 };
 const draft=structuredClone(old);
 for(const unit of draft.clipMentorAnalysis!.blueprint)delete (unit as any).internal_review;
 assert.equal(checkSourceBreakdown(draft).status,'structurally_ready','actual revision-9 teaching baseline passed the old pre-copy structural gate');
 const negative=await taskFor('teaching-old',draft);
 await advanceProductionTask(negative,productionStageWorker);
 assert.deepEqual(calls,['baseline'],'an aggregate pass does not hide the groups; no drafting request occurred');
 assert.equal(negative.status,'blocked');
 assert.match(negative.error??'',/U-01/);
 assert.equal(negative.attempts.model,1);
 const cold=await productionTaskStore.load(negative.projectId,negative.taskId);
 await advanceProductionTask(cold,productionStageWorker);
 assert.deepEqual(calls,['baseline'],'cold read reuses the original judgment');
 assert.equal(cold.attempts.model,1);
 assert.equal((await loadOfflineStoredProject(negative.projectId))?.revision,negative.projectRevision);
 console.log('PASS revision 9 reaches the existing pre-copy structure, is rejected before drafting, and reopens without a second model submission');

 const feedbackTask=await taskFor('teaching-feedback',old,2);
 feedbackTask.status='awaiting_blueprint';feedbackTask.stage='copy_review';await productionTaskStore.save(feedbackTask);
 const feedback='第1组教学方向错了。讲清上脸结果怎么引出产品比较。';
 assert.equal(await queueDraftBlueprintFeedback(feedbackTask,feedbackTask.projectRevision!,feedback,productionTaskStore),'queued');
 const visits:string[]=[];
 await advanceProductionTask(feedbackTask,async(task,ctx)=>{
  visits.push(task.stage);
  if(task.stage==='analysis'){
   assert.equal(task.blueprintFeedback,feedback);
   assert.ok(task.repairContext?.teaching_rebuild);
   return {artifact:{revision:task.projectRevision}};
  }
  return productionStageWorker(task,ctx);
 });
 assert.deepEqual(visits,['blueprint','analysis','blueprint']);
 assert.deepEqual(calls,['baseline','baseline'],'unmodified baseline never buys another judgment or advances to drafting');
 assert.match(feedbackTask.error??'',/U-01/);
 assert.equal(teachingDraftPointersDigest((await loadOfflineStoredProject(feedbackTask.projectId))!.doc),teachingDraftPointersDigest(old));
 console.log('PASS displayed-version feedback routes to analysis; no-progress repair does not spend another check');

 const source=teachingBaselineSource(old,feedbackTask,[],'Teaching objective');
 assert.ok(source.evidence.some(e=>e.id==='VIS-1-1'));
 assert.notEqual(teachingBaselineDigest(source),teachingBaselineDigest(teachingBaselineSource(old,feedbackTask,[],'A different objective')));
 const reply={feedback_scope:'baseline',units:source.units.map(unit=>({unit_id:unit.unit_id,status:'fix',source_role:'source role',
  takeaway:'reusable takeaway',reason:'A supported editorial correction',evidence_ids:[]}))};
 const review=validateTeachingBaselineReview(reply,source);
 assert.throws(()=>validateTeachingBaselineReview({...reply,feedback_scope:['baseline']},source),/review_invalid/);
 const unresolved=teachingRebuild(source,old,validateTeachingBaselineReview({...reply,units:reply.units.map(unit=>({...unit,status:'unresolved'}))},source));
 assert.equal(unchangedRejectedTeaching(source,unresolved).length,3);
 const missing=structuredClone(old);
 missing.clipMentorAnalysis!.evidence.find(e=>e.evidence_id==='VIS-1-1')!.observation_id='missing-observation';
 assert.equal(teachingBaselineSource(missing,feedbackTask,[]).evidence.some(e=>e.id==='VIS-1-1'),false);
 const wrong=structuredClone(old);
 wrong.clipMentorAnalysis!.observations!.find(o=>o.observation_id===wrong.clipMentorAnalysis!.evidence.find(e=>e.evidence_id==='VIS-1-1')!.observation_id)!.source_hash='b'.repeat(64);
 assert.equal(teachingBaselineSource(wrong,feedbackTask,[]).evidence.some(e=>e.id==='VIS-1-1'),false);
 for(const fault of ['drop observation','orphan frame','unbound claim'] as const){
  const broken=structuredClone(old),expected=fault==='unbound claim'?'CL-1':'VIS-1-1';
  const entry=broken.clipMentorAnalysis!.evidence.find(e=>e.evidence_id===expected)!;
  if(fault==='drop observation')delete entry.observation_id;
  if(fault==='orphan frame')entry.supporting_evidence_ids=['ghost-frame'];
  if(fault==='unbound claim')entry.source_ids=['ghost-transcript'];
  assert.equal(teachingBaselineSource(broken,feedbackTask,[]).evidence.some(e=>e.id===expected),false);
 }
 const duplicate=structuredClone(old);
 duplicate.clipMentorAnalysis!.evidence.push({...duplicate.clipMentorAnalysis!.evidence.find(e=>e.evidence_id==='VIS-1-1')!,evidence_id:'copy-of-VIS-1-1'});
 duplicate.clipMentorAnalysis!.transcripts[0].words[0].text+='  ';
 assert.equal(unchangedRejectedTeaching(teachingBaselineSource(duplicate,feedbackTask,[]),unresolved).length,3);
 duplicate.clipMentorAnalysis!.transcripts[0].words[0].text+='Frasa tambahan';
 assert.equal(unchangedRejectedTeaching(teachingBaselineSource(duplicate,feedbackTask,[]),unresolved).length,2);
 const reworked=structuredClone(old);
 const b=reworked.clipMentorAnalysis!.source_breakdown!;
 b.points[0].teaching_question='上脸效果怎样留下一个需要用两盘比较回答的问题？';
 b.points[0].change_reason='原片开场承接';
 b.points[2].teaching_question='怎样让观众判断刚上脸时颜色有多深？';
 const checked=teachingBaselineSource(reworked,feedbackTask,[]);
 const one=teachingRebuild(source,old,{...review,units:review.units.slice(0,1)});
 assert.deepEqual(staleRebuiltTeaching(checked,reworked,one),['U-01','U-02'],'the changed second group is stale, untouched third group remains usable');
 assert.ok(newlyChangedTeaching(source,checked,old));
 const internal=(reworked.clipMentorAnalysis!.blueprint[0] as any).internal_review;
 const candidate=structuredClone(internal[internal.current_script_candidate]);
 const plan=structuredClone(internal[internal.current_picture_plan]);
 const [line,...rest]=candidate.lines;
 const tokens=line.narration_ms.split(' ');
 candidate.lines=[{...line,narration_ms:tokens.slice(0,2).join(' ')},{...line,labels:[],narration_ms:tokens.slice(2).join(' ')},...rest];
 internal.current_script_candidate='script_candidate_split';
 internal.current_picture_plan='picture_plan_split';internal.script_candidate_split=candidate;internal.picture_plan_split=plan;
 assert.deepEqual(staleRebuiltTeaching(checked,reworked,one),['U-01','U-02'],'fresh IDs and repagination cannot discharge a rebuild');
 candidate.lines[0].narration_ms='Dia tunjuk hasil dahulu dan kemudian memperkenalkan kedua-dua palet.';
 assert.deepEqual(staleRebuiltTeaching(checked,reworked,one),['U-02']);
 const merged=structuredClone(old);
 const mb=merged.clipMentorAnalysis!.source_breakdown!,[first,second]=mb.units;
 first.original_segment_ids.push(...second.original_segment_ids);
 first.explanation_segment_ids.push(...second.explanation_segment_ids);
 first.original_source_ranges=[[0,45.28]];first.coverage.push(...second.coverage);first.revisits.push(...second.revisits);
 mb.units.splice(1,1);
 assert.equal(copyPreparationReady(merged),false);
 const historical=retireTeachingDrafts(merged);
 assert.equal(copyPreparationReady(historical),true);
 const past=(historical.clipMentorAnalysis!.blueprint[1] as any).internal_review;
 assert.equal(past.current_script_candidate,undefined);
 assert.ok(Object.keys(past).some(k=>k.startsWith('script_candidate_')));
 console.log('PASS provenance, literal verdict, evidence dead end, adjacent stale copy, pagination, and merge history');

 const pending=await taskFor('teaching-checkpoint',old);
 pending.stage='analysis';pending.repairs=1;
 const before=(await loadOfflineStoredProject(pending.projectId))!;
 const restored=structuredClone(before.doc);
 restored.clipMentorAnalysis!.source_breakdown!.points[0].teaching_question=b.points[0].teaching_question;
 restored.clipMentorAnalysis!.revision++;
 const stagedRevision=revisionOf(restored);
 pending.teachingAnalysisPublication={baseRevision:before.revision,revision:stagedRevision,repairEpoch:pending.repairs,
  inputDigest:digestValue({brief:pending.input.brief,feedback:undefined,feedbackRevision:undefined,policy:panelBlueprintRequirementsDigest(null)}),
  outputDigest:digestValue(restored),analysis:restored.clipMentorAnalysis!,artifact:{revision:stagedRevision}};
 await productionTaskStore.save(pending);
 const noRequests={signal:new AbortController().signal,async effect(){throw Error('recovery must not submit');}};
 const restart=()=>productionTaskStore.load(pending.projectId,pending.taskId);
 for(const phase of ['before commit','after commit']){
  const current=await restart();
  assert.equal((await productionStageWorker(current,noRequests)).artifact.revision,stagedRevision,phase);
  assert.equal((await loadOfflineStoredProject(pending.projectId))?.revision,stagedRevision,phase);
 }
 const changedProject=structuredClone(restored);changedProject.clipMentorAnalysis!.product.category='unrelated editor write';
 await setStoredEntry('project:'+pending.projectId,changedProject);
 await assert.rejects(productionStageWorker(await restart(),noRequests),/production_teaching_analysis_publication_unconfirmed/);
 console.log('PASS both sides of the analysis commit boundary recover exactly, and unrelated writes cannot be adopted');

 analysisCorrection=structuredClone(b);
 for(const [i,question] of [[2,'怎样让观众判断颜色刚上脸时有多深？'],[3,'如何用两盘同框与转脸展示让买家分清盘色和上脸亮度？']] as const){
  analysisCorrection.points[i].teaching_question=question;analysisCorrection.points[i].change_reason='根据原片可回读的实际拍法纠正选题';
 }
 const correctionTask=await taskFor('teaching-actual-analysis',old,3);
 correctionTask.status='awaiting_blueprint';correctionTask.stage='copy_review';await productionTaskStore.save(correctionTask);
 await queueDraftBlueprintFeedback(correctionTask,correctionTask.projectRevision!,feedback,productionTaskStore);
 calls=[];await advanceProductionTask(correctionTask,productionStageWorker);
 const realCorrection=(await loadOfflineStoredProject(correctionTask.projectId))!.doc;
 assert.deepEqual(calls,['baseline','analysis','analysis','baseline','author']);
 assert.equal(realCorrection.clipMentorAnalysis!.source_breakdown!.points[0].teaching_question,b.points[0].teaching_question);
 assert.equal(teachingDraftPointersDigest(realCorrection),teachingDraftPointersDigest(old),'analysis rewrite leaves old candidates for the draft phase');
 assert.equal(correctionTask.teachingAnalysisPublication,undefined,'analysis publication body is cleared once its stage settles');
 analysisCorrection=undefined;
 console.log('PASS real worker executes the analysis tool and checks the corrected source before authoring can resume');

 const corrected=structuredClone(draft);
 corrected.clipMentorAnalysis!.source_breakdown=b;
 const fixedTask=await taskFor('teaching-corrected',corrected);
 calls=[];await advanceProductionTask(fixedTask,productionStageWorker);
 assert.deepEqual(calls,['baseline','author'],'correcting revision 9 on the same original evidence reaches authoring');
 assert.equal(fixedTask.attempts.model,2);

 const known=structuredClone(accepted.cases[0]!.doc) as unknown as ProjectDoc;
 known.timelines=projectDoc(1080,1920).timelines;known.activeTimelineId=known.timelines[0]!.id;
 const knownTask=await taskFor('teaching-known',known);
 calls=[];await advanceProductionTask(knownTask,productionStageWorker);
 assert.deepEqual(calls,['baseline','author'],'a different valid opening reaches actual author dispatch after pre-draft admission');
 assert.equal(knownTask.attempts.model,2);
 assert.equal(knownTask.attempts.review,0);
 console.log('PASS qualified other-product baseline reaches the separate author slot without starting independent review, voice or render');
}finally{
 globalThis.fetch=realFetch;
 host.closeAllConnections();await new Promise<void>(resolve=>host.close(()=>resolve()));
 if(prior===undefined)delete process.env.OPENCHATCUT_DATA_DIR;else process.env.OPENCHATCUT_DATA_DIR=prior;
 await rm(path,{recursive:true});
}
