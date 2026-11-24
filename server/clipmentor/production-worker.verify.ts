import './native-execution.verify';
import './production-format.verify';
import './production-source-evidence.verify';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {productionPreviewFacts,productionAuthorTaskData,productionStageToolAllowed,loadProductionAuthorGuidance,executionMappingDiagnostic,productionGatewayDecisionArtifact} from './production-worker';
import {isValidAgentArtifactRecord} from '../../src/persist/agentRuntimeCodec';
import {sha256Text} from '../../src/persist/agentRuntimeStore';
import {projectDoc} from '../external-agent/offline-runtime.verify-fixtures';
import {makeDraft} from '../../src/editor/store';
import {checkTransitionManifest} from '../../src/clipmentor/transition-check';
import type {TeachingPacket} from '../../src/clipmentor/production-gate';
import {blockingAuthorBlueprintChecks,productionAuthorSelfCheckSource,checkProductionAuthorBlueprint} from './production-author-self-check';
import { verifyAuthorSelfCheckRecovery } from './production-author-self-check.verify-suite';
import {createProductionPreparation} from './production-readiness';
import {isBoundCanvasReflow,assertCanvasReflowPreservation} from './production-worker';
import {digestValue} from '../agent-runs/store-values';
import type {ProductionTask,StageContext} from './production-task';
import type {ProjectDoc} from '../../src/editor/types';
const recoveryArtifact=productionGatewayDecisionArtifact({taskId:'fixture',projectId:'fixture',stage:'blueprint',
 input:{budget:{observation:3}}} as import('./production-task').ProductionTask,'v3-fixture','observation',
 {operation_id:'a24963be-10e4-4738-83f8-b15d03f8bc78',action:'retry_charged',reason:'部分上传，保留次数'},2);
assert.equal(isValidAgentArtifactRecord(recoveryArtifact,'fixture',recoveryArtifact.artifactId),true,
 'real worker recovery evidence must satisfy the canonical persisted-artifact codec');
assert.equal(await sha256Text(recoveryArtifact.body),recoveryArtifact.bodySha256);
assert.equal(isValidAgentArtifactRecord({...recoveryArtifact,artifactId:'g_'+'a'.repeat(24)},'fixture','g_'+'a'.repeat(24)),false,
 'the previously emitted 26-character ID really is rejected');
assert(executionMappingDiagnostic(new Error('Actual sequence mapping incomplete: [{"code":"delivery_ending_card_not_preserved:existing_partner"}]')));
for(const error of [new Error('Current review no longer authorizes editing'),new Error('execution_media_changed:source'),new Error('Tool failed'),{},'Actual sequence mapping incomplete: []'])assert.equal(executionMappingDiagnostic(error),undefined);
for(const stage of ['analysis','blueprint','audio','edit'] as const){
 const files:string[]=[];
 const guidance=await loadProductionAuthorGuidance(stage,async file=>{files.push(file);return `fixture:${file}`;});
 assert.deepEqual(files.slice(0,2),['SKILL.md','references/planning.md']);
 assert.equal(files.includes('references/reproduction-lessons.md'),stage==='analysis'||stage==='blueprint');
 assert.equal(guidance.includes('fixture:references/reproduction-lessons.md'),stage==='analysis'||stage==='blueprint');
 assert.equal(new Set(files).size,files.length,'each reference loaded once');
}
for(const stage of ['copy_review','export','self_check'] as const){
 let reads=0;
 await assert.rejects(loadProductionAuthorGuidance(stage,async()=>{reads++;return 'must not send author examples';}),/not_authoring/);
 assert.equal(reads,0,'review and non-author stages cannot receive author examples through this entry');
}
await assert.rejects(loadProductionAuthorGuidance('analysis',async file=>{
 if(file==='references/reproduction-lessons.md')throw new Error('fixture lesson unavailable');
 return 'fixture';
}),/lesson unavailable/,'missing planned guidance must not silently fall back to incomplete instructions');
for(const file of ['SKILL.md','references/planning.md','references/reproduction-lessons.md']){
 await assert.rejects(loadProductionAuthorGuidance('analysis',async current=>current===file?' \n\t ':'valid fixture guidance'),/empty.*guidance|guidance.*empty/,
  'an existing but empty required file must stop before a model is started');
}
const doc=projectDoc();
doc.timelines[0].items=[0,200,100].map(startFrame=>({id:`v${startFrame}`,kind:'video',src:'/media/uploads/source.mp4',sourceAssetId:'source',startFrame,durationInFrames:100,track:'track-v1'})) as never;
const d=makeDraft(doc);
doc.clipMentorAnalysis={source:{asset_id:'source'},source_breakdown:{units:[{unit_id:'U02',placement:{timeline_id:doc.activeTimelineId,original_frames:[0,100],explanation_frames:[100,300]}}]}} as never;
const packet={units:[{unit_id:'U02',points:[{point_id:'P',question:'怎么拍清产品使用？',buying_concern:'使用方式'}]}]} as TeachingPacket;
const {input,executionManifest}=productionPreviewFacts(doc,d.getState(),packet);
assert.deepEqual(executionManifest.scenes.map(s=>s.start_frame),[0,100,200],'actual playback order, not insertion order');
assert.equal(checkTransitionManifest(executionManifest).review_groups.length,0,'valid film can have no mechanical candidates');
assert.equal(input.units[0].unit_id,'U02');
assert.deepEqual(input.units[0].output_range_seconds,[0,10],'teaching unit uses saved output placement');
const bad=structuredClone(executionManifest);bad.scenes[1].start_frame=99;
assert.throws(()=>checkTransitionManifest(bad),/overlapping|discontinuous/,'real overlap remains blocked');
doc.clipMentorAnalysis!.source_breakdown!.units[0].placement!.timeline_id='other';
assert.throws(()=>productionPreviewFacts(doc,d.getState(),packet),/placement/,'stale placement is not guessed');
console.log('production worker projection: unsorted valid clips, teaching IDs, output placement and invalid-range refusal passed; zero provider calls');

// Saved real plans exercise the same message generator used by executeRun, no API call.
const {default:saved}=await import('../../src/clipmentor/fixtures/production-saved-projects-20261028.json');
const {currentExecutionView}=await import('./execution-view');
const task={projectId:'production-worker-message-fixture',stage:'edit',input:{brief:'Implement frozen decisions',sourceAssetId:'d24aef47-f694-4a50-a639-42d80e25d75a'}} as import('./production-task').ProductionTask;
for(const entry of saved.cases){
 const project=entry.doc as unknown as import('../../src/editor/types').ProjectDoc;
 const actual=JSON.parse(JSON.stringify(await productionAuthorTaskData(task,project)));
 assert.deepEqual(actual.frozenBlueprint,await currentExecutionView(project));
 assert.equal(actual.frozenBlueprint.subject.digest,project.clipMentorAnalysis!.production_copy_review!.content_digest);
 assert(actual.frozenBlueprint.packet.units[0].picture_plan.execution_plan.content.composition.detail.includes('measured_audio_bindings'));
}
const planning=await productionAuthorTaskData({...task,stage:'blueprint'},saved.cases[0].doc as unknown as import('../../src/editor/types').ProjectDoc);
assert.equal(planning.frozenBlueprint,null,'a teaching draft must not pretend to be a frozen executable plan');
assert(planning.goal.includes('不固定四组'));
const checkDoc=structuredClone(saved.cases[0].doc) as unknown as import('../../src/editor/types').ProjectDoc;
const beforeCheck=JSON.stringify(checkDoc);
const requirements=['这么多人拍这款商品，为什么这支视频取得这个成绩？','用我提供的CTA，不自制商品卡'];
const checkSource=productionAuthorSelfCheckSource(checkDoc,await createProductionPreparation(checkDoc),requirements);
assert.deepEqual(checkSource.originalRequirements,requirements);
requirements[0]='external mutation';
assert.equal(checkSource.originalRequirements[0],'这么多人拍这款商品，为什么这支视频取得这个成绩？');
assert.equal(JSON.stringify(checkDoc),beforeCheck,'self-check projection cannot rewrite source or review');
const failedSourceDoc=structuredClone(checkDoc);
const originalRange=(await createProductionPreparation(checkDoc)).rawPacket.units[0].picture_plan!.original_source_ranges[0];
const failedEvidenceId='unselected-failed-speech';
failedSourceDoc.clipMentorAnalysis!.evidence.push({evidence_id:failedEvidenceId,kind:'original_claim',
 status:'candidate_unverified_speech',text:'Failed observation cannot be proof',call_status:'failed',
 source_range_seconds:[originalRange[0],originalRange[0]+.05],source_ids:[]});
const failedSourcePacket=await createProductionPreparation(failedSourceDoc);
assert(failedSourcePacket.rawPacket.source_evidence.some(e=>e.evidence_id===failedEvidenceId),'unselected original is present in the upstream context');
const filtered=productionAuthorSelfCheckSource(failedSourceDoc,failedSourcePacket,[],true);
assert(!filtered.blueprint.source_evidence.some(e=>e.evidence_id===failedEvidenceId));
assert(filtered.blueprint.units.every(u=>!u.source_context?.evidence_ids.includes(failedEvidenceId)));
assert(!filtered.sourceEvidence?.some(e=>e.evidence_id===failedEvidenceId));
const {buildCopyTeachingReviewRequest}=await import('../../src/clipmentor/production-gate');
const reviewInput=JSON.stringify(buildCopyTeachingReviewRequest([{case_id:'isolation',packet:checkSource.blueprint}]));
assert(!reviewInput.includes('originalRequirements'),'author-check material cannot leak through the independent review projection');
const effectNames:string[]=[];
const selfCheckStage={effect:async(_kind:string,name:string)=>{effectNames.push(name);return {digest:'fixture',runId:'fixture',checks:[]};}} as unknown as import('./production-task').StageContext;
const preparedCheck=await createProductionPreparation(checkDoc);
await verifyAuthorSelfCheckRecovery(checkDoc, preparedCheck);
{
 const guide='S1 no-op recovery fixture';
 const panelSource={...productionAuthorSelfCheckSource(checkDoc,preparedCheck,[task.input.brief],true),
  panelTeachingReview:true,repairReview:[],unchangedReviewedDelivery:[]};
 const newRevision={...task,projectRevision:'changed-unrelated-project-metadata',repairContext:{
  blueprint_digest:preparedCheck.reviewed.subject.digest,author_self_check_source_digest:digestValue({source:panelSource,guide})}};
 const before=effectNames.length;
 await assert.rejects(checkProductionAuthorBlueprint(newRevision,selfCheckStage,checkDoc,preparedCheck,guide,[],undefined,true),/蓝图返修未改变送审内容/);
 assert.equal(effectNames.length,before,'a different project revision alone cannot spend another author call');
}
for(const [currentRequirements,guide] of [[['原始要求'],'guide'],[['原始要求'],'guide'],[['更新要求'],'guide'],[['更新要求'],'updated-guide']] as const){
 await checkProductionAuthorBlueprint(task,selfCheckStage,checkDoc,preparedCheck,guide,[...currentRequirements]);
}
assert.equal(effectNames[0],effectNames[1],'identical self-check inputs reuse the same counted operation');
assert.notEqual(effectNames[1],effectNames[2],'changed original requirements cannot reuse a completed self-check');
assert.notEqual(effectNames[2],effectNames[3],'changed self-check criteria cannot reuse a completed self-check');
await checkProductionAuthorBlueprint({...task,input:{...task.input,brief:'Changed original business request'}},selfCheckStage,checkDoc,preparedCheck,'updated-guide',['更新要求']);
assert.notEqual(effectNames[3],effectNames[4],'the original task request is part of the self-check binding even without visual criteria');
const panelPlanning=await productionAuthorTaskData({...task,stage:'blueprint',input:{...task.input,panelDelivery:{
 productAssetId:'product',productAssetHash:'a'.repeat(64),salesAssetId:'sales',ctaAssetId:'cta',ctaAssetHash:'b'.repeat(64),
}}},saved.cases[0].doc as unknown as import('../../src/editor/types').ProjectDoc);
assert.match(panelPlanning.deliveryRequirements!.instructions,/默认 layout=\{kind:recruitment_card/);
assert.match(panelPlanning.deliveryRequirements!.instructions,/原海报整图等比适配，不自制替代卡/);
assert.match(panelPlanning.deliveryRequirements!.instructions,/只有本项目原话明确要求分裁时/);
assert.match(panelPlanning.deliveryRequirements!.instructions,/参照只比较构图，不作为上屏素材或本项目业绩事实/);
// The actual task-message entry must reject a wrong canvas before preparing a handoff.
const wrongCanvas=structuredClone(checkDoc);wrongCanvas.timelines[0].width=1920;wrongCanvas.timelines[0].height=1080;
const formatTask={...task,input:{...task.input,panelDelivery:{productAssetId:'p',salesAssetId:'s',ctaAssetId:'c'}}} as typeof task;
await assert.rejects(productionAuthorTaskData(formatTask,wrongCanvas),/clipmentor_output_canvas_mismatch/);
await productionAuthorTaskData(task,wrongCanvas); // Generic editor tasks are not forced into the panel's product format.
const boundReflow={...formatTask,projectRevision:'exact-old',repairContext:{canvas_reflow:{project_revision:'exact-old',project_digest:digestValue(wrongCanvas),target_width:720,target_height:1280}}};
assert(isBoundCanvasReflow(boundReflow,wrongCanvas));
await productionAuthorTaskData(boundReflow,wrongCanvas);
for(const bad of [{...boundReflow,stage:'export'},{...boundReflow,projectRevision:'other'},{...boundReflow,repairContext:{canvas_reflow:{...boundReflow.repairContext.canvas_reflow,target_width:1280}}}])
 assert.equal(isBoundCanvasReflow(bad as typeof task,wrongCanvas),false);
assert.equal(isBoundCanvasReflow(boundReflow,{...wrongCanvas,activeTimelineId:'other'}),false);
const geometry=structuredClone(wrongCanvas);geometry.timelines[0].width=720;geometry.timelines[0].height=1280;
assertCanvasReflowPreservation(wrongCanvas,geometry);
for(const bad of [(()=>{const d=structuredClone(geometry);d.assets[0].src='/different';return d;})(),
 (()=>{const d=structuredClone(geometry);d.clipMentorAnalysis!.revision++;return d;})()])assert.throws(()=>assertCanvasReflowPreservation(wrongCanvas,bad));
const reflowItems=projectDoc();reflowItems.timelines[0].items=[{id:'t',kind:'text',startFrame:0,durationInFrames:30,track:'track-v1',props:{text:'Frozen copy',fontSize:32}},
 {id:'a',kind:'audio',startFrame:0,durationInFrames:30,track:'track-a',src:'/voice.mp3',volume:1}] as never;
const newGeometry=structuredClone(reflowItems);newGeometry.timelines[0].width=720;newGeometry.timelines[0].height=1280;
newGeometry.timelines[0].items[0].props!.fontSize=40;newGeometry.timelines[0].items[0].props!.paddingX=60;
assertCanvasReflowPreservation(reflowItems,newGeometry);
for(const edit of [(d:typeof newGeometry)=>{d.timelines[0].items[0].props!.text='Rewritten';},
 (d:typeof newGeometry)=>{d.timelines[0].items[1].volume=0;},(d:typeof newGeometry)=>{d.timelines[0].items[0].startFrame++;}]){
 const invalid=structuredClone(newGeometry);edit(invalid);assert.throws(()=>assertCanvasReflowPreservation(reflowItems,invalid));
}
console.log('production worker actual message: two saved plans, subject digests and complete picture/audio instructions survive serialization; draft stage remains separate; no provider requests');

for(const name of ['revise_clipmentor_analysis','submit_voice','observe_clipmentor_source_video'])assert.equal(productionStageToolAllowed('edit',name),false);
assert.equal(productionStageToolAllowed('blueprint','revise_clipmentor_analysis'),true);assert.equal(productionStageToolAllowed('edit','edit_item'),true);


const {validateAuthorSelfCheck,runAuthorSelfCheckWithFormatRetry,selectAuthorSelfCheckReceipt}=await import('./production-author-self-check');
const source={currentLine:'Perhatikan warna di tangan'};
const checks=Array.from({length:7},(_,index)=>({id:`S${index+1}`,status:'ok',reference:'warna di tangan',reason:'对应当前口播及手背演示'}));
assert.equal(validateAuthorSelfCheck(JSON.stringify(checks),source).length,7);
const multipleReferences=[{...checks[0],status:'fix',reference:['Perhatikan warna','warna di tangan']},...checks.slice(1)];
assert.deepEqual(validateAuthorSelfCheck(JSON.stringify(multipleReferences),source)[0],multipleReferences[0]);
// Reduced replay of JUDYDOLL v3-8fed2080. The first group names
// visible actions correctly but never teaches the hook-to-product handoff.
{
 const ranges:[[number,number],[number,number],[number,number]]=[[0,29],[29,45.28],[45.28,67.33]];
 const ids=['U-01','U-02','U-03'];
 const evidence=['先看上脸和人物反应，再举盘，两盘同框','盘和刷头同框，随后鼻侧出现棕色','双盘同框，接着用侧脸给人看高光'];
 const copy=['Dia rapatkan wajah ke kamera.','Penonton boleh nampak sepekat mana warna pada sisi hidung.','Kedua-dua palet ditunjukkan bersama supaya beza warna mudah dilihat.'];
 const blueprint={
  source_evidence:[...ids.map((_,i)=>({evidence_id:'raw-'+i,observation:'[visible_action; candidate] '+evidence[i],time_seconds:[ranges[i][0]+1]})),
   {evidence_id:'why',observation:'[expression_analysis_not_verified_causal_effect; candidate] 显示了卖点',time_seconds:[2]},
   {evidence_id:'bare-frame',observation:'[source_frame; frame_extracted_not_interpreted] Source frame extracted and returned; interpretation pending',time_seconds:[2]}],
  units:ids.map((unit_id,i)=>({unit_id,source_context:{evidence_ids:['raw-0','raw-1','raw-2','why','bare-frame']},
   lines:[{line_id:'L'+i,narration_ms:copy[i],caption_lines:[copy[i]],labels:[]}],points:[],
   picture_plan:{original_source_ranges:[ranges[i]],line_source_ranges:[]}})),
 };
 const panelSource={panelTeachingReview:true,blueprint};
 const rows=ids.map((unit_id,i)=>({unit_id,status:'ok',source_role:evidence[i],source_evidence_ids:['raw-'+i],
  takeaway:['用上脸效果和反应抓注意，亮出两盘引出比较','近拍显色让买家自己判断颜色深浅','同框让买家比较两盘色差'][i],reason:'对照本组现行口播',
  delivered:{line_id:'L'+i,quote:copy[i]}}));
 const result=(teaching_units:unknown)=>validateAuthorSelfCheck(JSON.stringify([
  {...checks[0],reference:copy[0],teaching_units},
  ...checks.slice(1).map(check=>({...check,reference:copy[0]})),
 ]),panelSource)[0];
 const bad=structuredClone(rows);bad[0].status='fix';bad[0].reason='讲解只有靠近镜头，漏掉用效果抓注意再引出双盘比较';
 assert.equal(result(bad).status,'fix','an aggregate ok cannot overrule a rejected JUDYDOLL group');
 assert.equal(result([{...rows[0],delivered:[rows[0].delivered]},...rows.slice(1)]).status,'ok');
 assert.throws(()=>result([{...rows[0],delivered:[rows[0].delivered,rows[1].delivered]},...rows.slice(1)]),/invalid:S1:teaching_unit=U-01/);
 assert.throws(()=>result([{...rows[0],delivered:[rows[1].delivered]},...rows.slice(1)]),/invalid:S1:teaching_unit=U-01/);
 assert.throws(()=>result(undefined),/invalid:S1/,'seven valid generic answers still leave every group unchecked');
 assert.throws(()=>result([rows[1],rows[1],rows[2]]),/invalid:S1:teaching_unit=U-01/);
 assert.throws(()=>result([{...rows[0],source_evidence_ids:['why']},...rows.slice(1)]),/invalid:S1:teaching_unit=U-01/);
 assert.throws(()=>result([{...rows[0],source_evidence_ids:['bare-frame']},...rows.slice(1)]),/invalid:S1:teaching_unit=U-01/);
 assert.throws(()=>result([{...rows[0],source_evidence_ids:['raw-1']},...rows.slice(1)]),/invalid:S1:teaching_unit=U-01/);
 assert.throws(()=>result([{...rows[0],delivered:rows[1].delivered},...rows.slice(1)]),/invalid:S1:teaching_unit=U-01/);
 assert.throws(()=>result([{...rows[0],delivered:{line_id:'L0',quote:rows[0].takeaway}},...rows.slice(1)]),/invalid:S1:teaching_unit=U-01/);
 const unknown={...rows[0],status:'unresolved',delivered:undefined,source_evidence_ids:[]};
 assert.equal(result([unknown,...rows.slice(1)]).status,'unresolved');
 const corrected='Dia tunjuk hasil pada wajah dulu, kemudian tunjuk dua palet untuk buka perbandingan.';
 blueprint.units[0].lines[0].narration_ms=corrected;
 blueprint.units[0].lines[0].caption_lines=[corrected];
 copy[0]=corrected;
 assert.equal(result([{...rows[0],delivered:{line_id:'L0',quote:corrected}},...rows.slice(1)]).status,'ok');
 const related=structuredClone(panelSource) as {panelTeachingReview:boolean;blueprint:TeachingPacket};
 related.blueprint.units[0].points=[{point_id:'P0',role:'primary',question:rows[0].takeaway,evidence_ids:['raw-0'],
  teaching_basis:{selling_point:'上脸效果',method:'先展示上脸结果',connection:'用上脸差异引出选盘的理由',evidence_ids:['raw-0']}}];
 related.blueprint.units[0].lines[0].point_ids=['P0'];
 related.blueprint.units[0].source_context!.evidence_ids.push('in-group-other');
 related.blueprint.source_evidence.push({evidence_id:'in-group-other',observation:'[visible_action; candidate] 刷子放在桌上',time_seconds:[2]});
 const relatedResult=(id:string)=>validateAuthorSelfCheck(JSON.stringify([
  {...checks[0],reference:corrected,teaching_units:[{...rows[0],source_evidence_ids:[id],delivered:{line_id:'L0',quote:corrected}},...rows.slice(1)]},
  ...checks.slice(1).map(check=>({...check,reference:corrected})),
 ]),related)[0];
 assert.equal(relatedResult('raw-0').status,'ok');
 assert.throws(()=>relatedResult('in-group-other'),/invalid:S1:teaching_unit=U-01/,'a same-window action cannot stand in for the selected teaching evidence');
 const strictPanel={...related,editorialPolicy:'exemplar-v1'};
 const strictRows=[{...checks[0],reference:corrected,teaching_units:[{...rows[0],status:'fix',delivered:undefined},...rows.slice(1)]},
  ...checks.slice(1).map(check=>({...check,reference:corrected}))];
 const strictChecks=validateAuthorSelfCheck(JSON.stringify(strictRows),strictPanel);
 assert.equal(strictChecks.find(check=>check.id==='S1')?.status,'fix','preserve the original author opinion');
 assert.deepEqual(blockingAuthorBlueprintChecks(strictChecks,true),[]);
 assert.equal(blockingAuthorBlueprintChecks(strictChecks,false)[0].id,'S1');
 assert.deepEqual(validateAuthorSelfCheck(JSON.stringify(strictRows.slice(1)),strictPanel).map(check=>check.id),['S2','S3','S4','S5','S6','S7']);
 const labelOnly={...rows[0],delivered:{line_id:'L0',quote:'仅有短标'}};
 strictPanel.blueprint.units[0].lines[0].labels=['仅有短标'];
 const invalidS1={...strictRows[0],teaching_units:[labelOnly,...rows.slice(1)]};
 assert(!validateAuthorSelfCheck(JSON.stringify([invalidS1,...strictRows.slice(1)]),strictPanel).some(check=>check.id==='S1'));
 const strictS2Fix=strictChecks.map(check=>check.id==='S2'?{...check,status:'fix' as const}:check);
 assert.deepEqual(blockingAuthorBlueprintChecks(strictS2Fix,true).map(check=>check.id),['S2']);
 const visual=structuredClone(panelSource) as {panelTeachingReview:boolean;blueprint:TeachingPacket};
 visual.blueprint.units[0].points=[{point_id:'P0',role:'primary',question:rows[0].takeaway,evidence_ids:['raw-0','bare-frame'],
  treatment:'visual_only',visual_evidence:[{segment_id:'S0',phase:'explanation',source_range_seconds:[0,4],evidence_ids:['raw-0','bare-frame']}]}];
 visual.blueprint.units[0].picture_plan!.line_source_ranges=[{line_id:'L0',source_range_seconds:[0,4],
  context_source_ranges:[{segment_id:'S0',source_range_seconds:[1,1],purpose:'当前明确选中的静帧'}]}];
 const visualResult=(evidence_id:string,source_seconds:number)=>validateAuthorSelfCheck(JSON.stringify([
  {...checks[0],reference:corrected,teaching_units:[{...rows[0],delivered:{evidence_id,source_seconds}},...rows.slice(1)]},
  ...checks.slice(1).map(check=>({...check,reference:corrected})),
 ]),visual)[0];
 assert.equal(visualResult('raw-0',1).status,'ok','deliberately selected exact still remains usable');
 assert.throws(()=>visualResult('raw-0',1+1/30),/invalid:S1:teaching_unit=U-01/);
 assert.throws(()=>visualResult('bare-frame',2),/invalid:S1:teaching_unit=U-01/);
 console.log('JUDYDOLL replay: checked source role and same-unit delivery, caught fake aggregate, omission, wrong group and author-note citations');
}
const translatedLabels={...source,labels:['较浅','较深','06'],note:'请比较颜色深浅'};
const labelReferences=[...checks.slice(0,2),{...checks[2],reference:['较浅','较深','06']},...checks.slice(3)];
assert.deepEqual(validateAuthorSelfCheck(JSON.stringify(labelReferences),translatedLabels)[2],labelReferences[2]);
for(const reference of ['深浅','较浓','较','  ']){
 assert.throws(()=>validateAuthorSelfCheck(JSON.stringify([{...checks[0],reference},...checks.slice(1)]),translatedLabels),/invalid:S1/);
}
for(const reference of [[],['warna di tangan','虚构的文稿'],['warna di tangan',{}],Array(25).fill('warna di tangan')]){
 assert.throws(()=>validateAuthorSelfCheck(JSON.stringify([{...checks[0],reference},...checks.slice(1)]),source),/invalid:S1/);
}
assert.throws(()=>validateAuthorSelfCheck(JSON.stringify(checks.slice(0,6)),source),/incomplete/);
assert.throws(()=>validateAuthorSelfCheck(JSON.stringify([{...checks[0],reference:'虚构的文稿'},...checks.slice(1)]),source),/invalid:S1/);
assert.throws(()=>validateAuthorSelfCheck(JSON.stringify([{...checks[0],id:'S2'},...checks.slice(1)]),source),/invalid:S1/);
const formatAttempts:(string|undefined)[]=[];
const corrected=await runAuthorSelfCheckWithFormatRetry(async error=>{
 formatAttempts.push(error);
 return validateAuthorSelfCheck(error?JSON.stringify(multipleReferences):'{bad json',source);
});
assert.deepEqual(formatAttempts,[undefined,'blueprint_author_self_check_invalid_json']);
assert.equal(corrected[0].status,'fix','format recovery cannot turn a content finding into approval');
let malformedAttempts=0;
await assert.rejects(runAuthorSelfCheckWithFormatRetry(async()=>{
 malformedAttempts++;return validateAuthorSelfCheck('[]',source);
}),/incomplete/);
assert.equal(malformedAttempts,2);
let transportAttempts=0;
await assert.rejects(runAuthorSelfCheckWithFormatRetry(async()=>{
 transportAttempts++;throw new Error('unknown transport outcome');
}),/unknown transport outcome/);
assert.equal(transportAttempts,1);
const selfCheckTask={projectId:'project',taskId:'production',updatedAt:110,input:{author:{model:'fixture'}}} as import('./production-task').ProductionTask;
const lateReceipt={
 version:1,runId:'reserved-operation',projectId:'project',status:'completed',askOnly:true,backend:'api',modelId:'fixture',
 userInputDigest:'same-blueprint',userInputPreview:'',createdAt:105,updatedAt:140,context:{transportStatus:'completed'},
 artifactIds:[],checkpointIds:[],proposalIds:[],events:[],
} satisfies import('../../src/persist/agentRuntimeTypes').AgentRunRecord;
assert.deepEqual(selectAuthorSelfCheckReceipt([lateReceipt],selfCheckTask,'reserved-operation','same-blueprint',100,false),{run:lateReceipt,exact:true});
assert.equal(selectAuthorSelfCheckReceipt([lateReceipt],selfCheckTask,'other-operation','same-blueprint',100,true),undefined);
assert.equal(selectAuthorSelfCheckReceipt([lateReceipt],selfCheckTask,'reserved-operation','different-blueprint',100,true),undefined);
assert.equal(selectAuthorSelfCheckReceipt([{...lateReceipt,projectId:'other-project'}],selfCheckTask,'reserved-operation','same-blueprint',100,true),undefined);

for(const stage of ['analysis','blueprint','audio'] as const)
 for(const tool of ['edit_item','clear_timeline','set_aspect_ratio','submit_render_job'])
  assert.equal(productionStageToolAllowed(stage,tool),false);
assert.equal(productionStageToolAllowed('blueprint','submit_voice'),false);
assert.equal(productionStageToolAllowed('audio','submit_voice'),true);
assert.equal(productionStageToolAllowed('analysis','load_skill'),true);
assert.equal(productionStageToolAllowed('blueprint','observe_clipmentor_source_video'),true);

const {importProductionSourceEvidence}=await import('./production-source-evidence');
const evidenceDoc=structuredClone(saved.cases[0].doc) as unknown as import('../../src/editor/types').ProjectDoc;
const evidenceAnalysis=evidenceDoc.clipMentorAnalysis!;
const evidenceUnit=evidenceAnalysis.source_breakdown!.units[0];
const evidenceSegment=evidenceAnalysis.source_breakdown!.segments.find(segment=>evidenceUnit.original_segment_ids.includes(segment.segment_id))!;
const [evidenceStart,evidenceEnd]=evidenceSegment.source_range_seconds;
const evidenceSourceHash=evidenceAnalysis.source.sourceContentHash!;
const syntheticReceipt={
 operationId:'fixture-operation',projectId:'fixture-project',source_hash:evidenceSourceHash,
 result:{operationId:'fixture-operation',source_hash:evidenceSourceHash,validation:{status:'valid'},
  actual_handoff_verified:false,complete_film_accepted:false,subject:{units:[{unit_id:evidenceUnit.unit_id}]},
  raw_observation:{windows:[{window_id:evidenceUnit.unit_id+':0',evidence:[
   {start_seconds:evidenceStart,end_seconds:evidenceEnd,visible:'Fixture visible action',audible:'模型听写：“Fixture literal quote”'},
   {start_seconds:evidenceEnd,end_seconds:evidenceEnd+1,visible:'Outside current segment',audible:'“Do not attach this quote”'},
  ]}]}}
} as unknown as import('../../shared/clipmentor-source-video').SourceVideoReceipt;
const evidenceImported=importProductionSourceEvidence(evidenceAnalysis,syntheticReceipt,'fixture-project')!;
assert(evidenceImported);
assert.equal(evidenceImported.evidence.filter(item=>item.text==='模型听音记录（可能含概述，非逐字核准）：模型听写：“Fixture literal quote”').length,1);
assert(!evidenceImported.evidence.some(item=>item.text==='Do not attach this quote'));
assert(evidenceImported.source_breakdown!.segments.find(segment=>segment.segment_id===evidenceSegment.segment_id)!.claim_evidence_ids
 .some(id=>evidenceImported.evidence.some(item=>item.evidence_id===id&&item.text==='模型听音记录（可能含概述，非逐字核准）：模型听写：“Fixture literal quote”')));
assert.equal(importProductionSourceEvidence(evidenceImported,syntheticReceipt,'fixture-project'),null);
assert.equal(importProductionSourceEvidence(evidenceAnalysis,syntheticReceipt,'foreign-project'),null);
assert.equal(importProductionSourceEvidence(evidenceAnalysis,{...syntheticReceipt,source_hash:'wrong'},'fixture-project'),null);

// Local evidence routes must remain source-bound, executable and author-only.
const {productionEvidenceInspection}=await import('./production-source-evidence');
const inspectDoc=structuredClone(saved.cases[0].doc) as unknown as import('../../src/editor/types').ProjectDoc;
const ia=inspectDoc.clipMentorAnalysis!;
const inspectAsset=inspectDoc.assets.find(asset=>asset.id===ia.source.asset_id)!;
assert(inspectAsset);
ia.source.sourceContentHash='fixture-source-hash';inspectAsset.sourceContentHash=ia.source.sourceContentHash;
const inspectTask={...task,stage:'blueprint' as const,input:{...task.input,sourceAssetId:ia.source.asset_id},repairContext:{author_self_check:[{id:'S2',reason:'boundary needs observation'}]}};
const untouched=JSON.stringify(inspectDoc);
const route=productionEvidenceInspection(inspectDoc,inspectTask)!;
assert.equal(route.status,'inspection_plan');
assert.equal(JSON.stringify(inspectDoc),untouched);
assert.equal(productionEvidenceInspection(inspectDoc,{...inspectTask,stage:'edit'}),null);
for(const target of route.targets??[])for(const range of ('ranges' in target?target.ranges:[])??[]){
 for(const call of range.local_checks){
  assert(productionStageToolAllowed('blueprint',call.tool));
  assert.equal(call.tool,'observe_clipmentor_source');
  assert(call.args.seconds.length<=8);
  const frames=call.args.seconds.map(t=>Math.floor(t*ia.source.fps));
  assert(frames.every(f=>f/ia.source.fps>=range.source_range_seconds[0]&&f/ia.source.fps<range.source_range_seconds[1]));
 }
}
const projected=await productionAuthorTaskData(inspectTask,inspectDoc);
assert.deepEqual(projected.evidenceInspection,route,'actual author message includes local checks');
const inspectPreparation=await createProductionPreparation(inspectDoc);
const reviewer=JSON.stringify(buildCopyTeachingReviewRequest([{case_id:'inspection-isolation',packet:inspectPreparation.rawPacket}]));
assert(!reviewer.includes('local_checks')&&!reviewer.includes('evidenceInspection'),'no author check instructions in independent review');
const broken=structuredClone(inspectDoc);broken.assets.find(asset=>asset.id===ia.source.asset_id)!.sourceContentHash='different';
assert.equal(productionEvidenceInspection(broken,inspectTask)?.status,'unavailable');
const missing=structuredClone(inspectDoc);missing.clipMentorAnalysis!.source_breakdown!.units[0].original_segment_ids.push('missing-segment');
const missingRoute=productionEvidenceInspection(missing,inspectTask)!;
assert.equal(missingRoute.targets?.[0].status,'unavailable','missing current pointer cannot borrow old intervals');
assert(missingRoute.targets?.slice(1).every(t=>t.status==='ready'));
const stale=productionEvidenceInspection(inspectDoc,{...inspectTask,repairContext:{repair:{status:'receipt_stale'}}});
assert.equal(stale?.status,'unavailable');
const unknown=productionEvidenceInspection(inspectDoc,{...inspectTask,repairContext:{repair:{status:'bound',subject:{revision:ia.revision,digest:ia.production_copy_review!.content_digest},units:[{unit_id:'unknown'}]}}});
assert.deepEqual(unknown?.unresolved_unit_ids,['unknown']);
assert.deepEqual(unknown?.targets,[],'unknown issue is not silently assigned to another group');
console.log('evidence inspection: real author entry, source binding, missing/stale pointers, frame tool contract and reviewer isolation passed');

const {productionSourceObservationAllowed}=await import('./production-source-evidence');
const permission={...inspectTask,input:{...inspectTask.input,budget:{observation:2}},attempts:{observation:1}} as unknown as import('./production-task').ProductionTask;
assert(productionSourceObservationAllowed(permission),'self-check repair can use remaining original authorization');
assert(!productionSourceObservationAllowed(permission,'already-recovered'));
assert(!productionSourceObservationAllowed({...permission,attempts:{...permission.attempts,observation:2}}));
assert(!productionSourceObservationAllowed({...permission,stage:'edit'}));
assert(!productionSourceObservationAllowed({...permission,input:{...permission.input,budget:{...permission.input.budget,observation:0}}}));
assert(!productionSourceObservationAllowed({...permission,attempts:{...permission.attempts,observation:NaN}}));

const outdated=productionEvidenceInspection(inspectDoc,{...inspectTask,repairContext:{repair:{status:'bound',subject:{revision:ia.revision-1,digest:ia.production_copy_review!.content_digest},units:[{unit_id:ia.source_breakdown!.units[0].unit_id}]}}});
assert.equal(outdated?.status,'unavailable','a bound label cannot revive old review locators');

const {execClipMentorAnalysisTool}=await import('../../src/agent/tools/clipmentor-analysis-tools');
assert(route.existing_evidence?.length,'saved example has readable evidence');
for(const read of route.existing_evidence??[]){
 const result=await execClipMentorAnalysisTool(read.tool,read.args,{getDoc:()=>inspectDoc,getCreativeMode:()=>'clipmentor'} as never) as {error?:string;analysis:{evidence:Array<{evidence_id:string}>}};
 assert(!result.error,result.error);
 assert.deepEqual(result.analysis.evidence.map(e=>e.evidence_id).sort(),[...read.args.evidenceIds].sort());
}
console.log('evidence reads executed through actual analysis tool, all requested records returned');

const {needsVisualReviewCompletion}=await import('./execution-view');
const visualMissing={status:'bound',review_approved:false,units:[],delivery_checks:[{verdict:'pass'}],
 visual_criteria_checks:[{answer:'unknown',picture_stage:'',observation:'缺少该段可定位的画面判断'}]};
assert.equal(needsVisualReviewCompletion(visualMissing),true);
for(const patch of [{units:[{verdict:'needs_revision'}]},{delivery_checks:[{verdict:'needs_revision'}]},
 {visual_criteria_checks:[{answer:'no',picture_stage:'product',observation:'wrong picture'}]},
 {visual_criteria_checks:[{answer:'unknown',picture_stage:'product',observation:'cannot see logo'}]},
 {status:'receipt_stale'},{visual_criteria_checks:[]}])assert.equal(needsVisualReviewCompletion({...visualMissing,...patch}),false);
console.log('Missing reviewer-stage labels return to review; negative, real unknown and stale copy still cannot pass.');

// Review findings must survive author self-check detours and cannot be closed using the old quote as evidence.
const {productionRepairContext}=await import('./production-task');
const {productionRepairTargets}=await import('./production-author-self-check');
const originalRepair={status:'bound',units:[{unit_id:'U-04',findings:[{finding_id:'saved:U-04:0',quote:'OLD highlighter 06',reason:'identity unverified'}]},
 {unit_id:'U-05',findings:[{finding_id:'saved:U-05:0',quote:'OLD recommendation 06',reason:'point still exceeds evidence'}]}]};
const firstContext=productionRepairContext(undefined,{repair:originalRepair});
const secondContext=productionRepairContext(firstContext,{author_self_check:[{id:'S7',status:'fix'}]});
assert.deepEqual(secondContext.pending_review_repair,originalRepair);
const repairUnit=(unit_id:string,narration_ms:string,range:[number,number]):TeachingPacket['units'][number]=>({
 unit_id,points:[],lines:[{line_id:unit_id+'-1',narration_ms,caption_lines:[],labels:[],meaning_zh:''}],
 picture_plan:{original_source_ranges:[range],explanation_source_ranges:[],line_source_ranges:[],registered_revisits:[]},
});
const repairTargets=productionRepairTargets({repairContext:secondContext},{units:[
 repairUnit('U-04','current gesture observation',[41,51.5]),
 repairUnit('U-05','current audience recommendation',[51.5,59]),
]});
const repairSource={...source,repairReview:repairTargets,sourceEvidence:[
 {evidence_id:'observed-g4',kind:'visible_action',source_range_seconds:[45,46],text:'new continuous source observation'},
 {evidence_id:'observed-g5',kind:'visible_action',time_seconds:51.5,text:'the separate color comparison is visible'},
 {evidence_id:'translated-g4',kind:'original_claim',time_seconds:45,text:'existing source transcription',meaning_zh:'只有作者改写的译文'},
 {evidence_id:'unlocated',kind:'original_claim',text:'new note with no source time'},
 {evidence_id:'both-groups',kind:'original_claim',source_range_seconds:[42,55],text:'unresolved timing across both groups'}]};
assert.throws(()=>validateAuthorSelfCheck(JSON.stringify(checks),repairSource),/repair_coverage/);
const withRepair=structuredClone(checks) as any[];
withRepair[1].repair_resolutions=repairTargets.map(t=>({finding_id:t.finding_id,status:'resolved',reference:[t.current.lines[0].narration_ms],reason:'current copy and point now agree'}));
assert.equal(validateAuthorSelfCheck(JSON.stringify(withRepair),repairSource)[1].status,'ok');
const unresolved=structuredClone(withRepair);unresolved[1].repair_resolutions[0].status='unresolved';
assert.equal(validateAuthorSelfCheck(JSON.stringify(unresolved),repairSource)[1].status,'fix','unresolved cannot pass despite top-level ok');
const historical=structuredClone(withRepair);historical[1].repair_resolutions[0].reference=['OLD highlighter 06'];
assert.throws(()=>validateAuthorSelfCheck(JSON.stringify(historical),repairSource),/repair_reference/);
const wrongUnit=structuredClone(withRepair);wrongUnit[1].repair_resolutions[0].reference=['current audience recommendation'];
assert.throws(()=>validateAuthorSelfCheck(JSON.stringify(wrongUnit),repairSource),/repair_reference/);
const duplicate=structuredClone(withRepair);duplicate[1].repair_resolutions[1]=duplicate[1].repair_resolutions[0];
assert.throws(()=>validateAuthorSelfCheck(JSON.stringify(duplicate),repairSource),/repair_reference/);
assert.throws(()=>productionRepairTargets({repairContext:secondContext},{units:[]}),/target_missing/);
const evidenceFix=structuredClone(withRepair);evidenceFix[1].repair_resolutions[0].reference=['new continuous source observation'];
assert.equal(validateAuthorSelfCheck(JSON.stringify(evidenceFix),repairSource)[1].status,'ok');
for(const quote of ['the separate color comparison is visible','只有作者改写的译文','new note with no source time','unresolved timing across both groups','U-04']){
 const badEvidence=structuredClone(evidenceFix);
 badEvidence[1].repair_resolutions[0].reference=[quote];
 assert.throws(()=>validateAuthorSelfCheck(JSON.stringify(badEvidence),repairSource),/repair_reference/,quote);
}
const replaced=productionRepairContext(secondContext,{repair:{...originalRepair,units:originalRepair.units.slice(1)}});
assert.equal((replaced.pending_review_repair as any).units.length,1,'new independent receipt supersedes prior pending set');
console.log('PASS repair coverage, preserved findings, current-only references, cross-unit refusal, unresolved blocking and evidence-based response');

// Reopen a completed result through the actual author-check entry. It may be
// read, but an inadmissible citation must not pass or reserve a format retry.
{
 const unit=preparedCheck.rawPacket.units[0];
 const guide='Saved repair reference fixture';
 const repairedTask={...task,stage:'copy_review',repairs:0,effects:{},repairContext:{repair:{status:'bound',units:[{
  unit_id:unit.unit_id,findings:[{finding_id:'saved-finding',quote:'historical disputed copy',reason:'fixture'}],
 }]}}} as import('./production-task').ProductionTask;
 const cachedSource={...productionAuthorSelfCheckSource(checkDoc,preparedCheck,[task.input.brief]),
  repairReview:productionRepairTargets(repairedTask,preparedCheck.rawPacket),unchangedReviewedDelivery:[]};
 const sourceDigest=digestValue({source:cachedSource,guide});
 const name='blueprint-author-self-check:'+sourceDigest;
 const quote=unit.lines[0].narration_ms;
 const answers=checks.map(row=>({...row,reference:quote}));
 const read=(repairQuote:string)=>{
  const result={digest:preparedCheck.reviewed.subject.digest,sourceDigest,runId:'old-complete-operation',checks:
   answers.map(row=>row.id==='S2'?{...row,repair_resolutions:[{
    finding_id:'saved-finding',status:'resolved',reference:[repairQuote],reason:'fixture',
   }]}:row)};
  const receipt={kind:'model',operationId:result.runId,status:'completed',result} as const;
  repairedTask.effects['copy_review:initial:0:'+name]=receipt;
  const before=JSON.stringify(receipt),names:string[]=[];
  const stage={effect:async(_kind:string,effectName:string)=>{
   names.push(effectName);
   assert.equal(effectName,name,'recovery must not dispatch');
   return structuredClone(receipt.result);
  }} as unknown as import('./production-task').StageContext;
  return {before,receipt,names,run:()=>checkProductionAuthorBlueprint(repairedTask,stage,checkDoc,preparedCheck,guide,[])};
 };
 const invalid=read(unit.unit_id);
 await assert.rejects(invalid.run(),/blueprint_author_self_check_saved_result_invalid/);
 assert.deepEqual(invalid.names,[name]);
 assert.equal(JSON.stringify(invalid.receipt),invalid.before);
 const valid=read(quote);
 assert.equal((await valid.run()).checks[1].status,'ok');
 assert.deepEqual(valid.names,[name]);
}
console.log('PASS completed repair recovery rechecks current quotes without rewriting the receipt or repeating a request');

const {unchangedReviewedDelivery}=await import('./production-author-self-check');
const passedSection={section_id:'existing_partner',line:{narration_ms:'Use the original storyboard'},picture:{asset_id:'own-storyboard',sha256:'fixed'}};
const priorDelivery={status:'bound',delivery_sections:[passedSection],delivery_checks:[{section_id:'existing_partner',verdict:'pass'}]};
assert.equal(unchangedReviewedDelivery({repairContext:{pending_review_repair:priorDelivery}},{delivery_sections:[passedSection]}).length,1);
assert.equal(unchangedReviewedDelivery({repairContext:{pending_review_repair:priorDelivery}},{delivery_sections:[{...passedSection,picture:{asset_id:'other',sha256:'changed'}}] as any}).length,0);
assert.equal(unchangedReviewedDelivery({repairContext:{pending_review_repair:{...priorDelivery,status:'receipt_stale'}}},{delivery_sections:[passedSection]}).length,0);
console.log('PASS identical previously reviewed delivery context reuse; changed image and stale receipt refused');

const scopeSource={...source,unchangedReviewedDelivery:[{section_id:'existing_partner',scope:'same_saved_delivery_plan_only_not_current_film_approval',prior_check:{reason:'OLD review interpretation only'}}]};
const scopeChecks=structuredClone(checks) as any[];scopeChecks[3].reference=['warna di tangan','same_saved_delivery_plan_only_not_current_film_approval'];
assert.equal(validateAuthorSelfCheck(JSON.stringify(scopeChecks),scopeSource)[3].status,'ok');
scopeChecks[3].reference=['OLD review interpretation only'];
assert.throws(()=>validateAuthorSelfCheck(JSON.stringify(scopeChecks),scopeSource),/unmatched_reference=.*OLD review/);
console.log('PASS current host-derived reuse scope may be cited; historical reviewer prose still rejected with precise quote diagnostic');

// Raw model audio observations survive without typographic quotation marks.
const contextReceipt=structuredClone(syntheticReceipt);
contextReceipt.result!.observation_task={version:'source-boundaries-v1',contexts:[{context_id:'context',unit_id:evidenceUnit.unit_id,
 source_range_seconds:[evidenceStart,evidenceEnd],boundary_seconds:[],goals:['material_continuity']}]};
contextReceipt.result!.raw_observation.task_observation={boundaries:[],contexts:[{context_id:'context',sequence:[
 {start_seconds:evidenceStart,end_seconds:evidenceEnd,visible:'Neutral visible action',audible:'I suggest kosong...'}],material_ranges:[],limitations:['Speech truncated']}]};
contextReceipt.result!.raw_observation.lines=[{unit_id:evidenceUnit.unit_id,line_id:'x',status:'supported',reason:'DO_NOT_LEAK_OBSERVER_VERDICT',window_ids:[]}];
const contextual=importProductionSourceEvidence(evidenceAnalysis,contextReceipt,'fixture-project')!;
const raw=contextual.evidence.find(e=>e.text.endsWith('I suggest kosong...'))!;
assert(raw);assert.equal(raw.status,'candidate_unverified_speech');assert(!JSON.stringify(contextual).includes('DO_NOT_LEAK_OBSERVER_VERDICT'));
assert(!raw.text.includes('06'));assert.equal(importProductionSourceEvidence(contextual,contextReceipt,'fixture-project'),null);
const {buildSourceContext}=await import('../../src/clipmentor/source-alignment');
const noAsrContext=structuredClone(contextual);noAsrContext.transcripts=[];delete noAsrContext.source_transcription;
const pool:any[]=[];const sc=buildSourceContext(noAsrContext,[[evidenceStart,evidenceEnd]],pool);
assert.equal(sc.speech,'model_observation_not_listening_verified');assert(sc.evidence_ids.includes(raw.evidence_id));
assert(pool.some(e=>e.observation.includes('I suggest kosong...')));
const invalidContext=structuredClone(contextReceipt);invalidContext.result!.observation_task!.contexts[0].context_id='other';
assert(!importProductionSourceEvidence(evidenceAnalysis,invalidContext,'fixture-project')!.evidence.some(e=>e.text.endsWith('I suggest kosong...')));
const failedContext=structuredClone(contextReceipt);failedContext.result!.validation.status='invalid';
assert.equal(importProductionSourceEvidence(evidenceAnalysis,failedContext,'fixture-project'),null);
console.log('PASS raw context audio projection, truncation, source binding, idempotence and observer verdict isolation');

const missingLink=structuredClone(contextual);
for(const segment of missingLink.source_breakdown!.segments)segment.claim_evidence_ids=segment.claim_evidence_ids.filter(id=>id!==raw.evidence_id);
const relinked=importProductionSourceEvidence(missingLink,contextReceipt,'fixture-project')!;
assert(relinked);assert.equal(relinked.evidence.length,missingLink.evidence.length);
assert(relinked.source_breakdown!.segments.some(s=>s.claim_evidence_ids.includes(raw.evidence_id)));
const outside=structuredClone(contextReceipt);outside.result!.raw_observation.task_observation!.contexts[0].sequence[0].end_seconds=evidenceEnd+1;
assert(!importProductionSourceEvidence(evidenceAnalysis,outside,'fixture-project')!.evidence.some(e=>e.text.endsWith('I suggest kosong...')));
console.log('PASS existing raw evidence relinks without duplication; out-of-context speech excluded');

const {completedSourceEvidenceOperations}=await import('./production-source-evidence');
const effectsFixture={effects:{ok:{kind:'observation',status:'completed',operationId:'ok',result:{status:200}},bad:{kind:'observation',status:'completed',operationId:'bad',result:{status:400}},invalid:{kind:'observation',status:'completed',operationId:'invalid',result:{status:422}},pending:{kind:'observation',status:'reserved',operationId:'pending',result:{status:200}}}} as any;
assert.deepEqual(completedSourceEvidenceOperations(effectsFixture),['ok']);
assert.deepEqual(completedSourceEvidenceOperations({...effectsFixture,sourceEvidenceRecoveryOperation:'explicit'}),['ok','explicit']);
assert.equal(effectsFixture.effects.bad.result.status,400,'failed effects remain unchanged');

const {persistProductionGatewayDecision}=await import('./production-worker');
const decisionBodies=new Map<string,any>();let decisionWrites=0;
const decisionDeps={store:async(r:any)=>{if(decisionBodies.has(r.artifactId))return false;decisionBodies.set(r.artifactId,structuredClone(r));decisionWrites++;return true;},load:async(_p:string,id:string)=>decisionBodies.get(id)??null};
await persistProductionGatewayDecision(recoveryArtifact,decisionDeps);await persistProductionGatewayDecision({...recoveryArtifact,createdAt:recoveryArtifact.createdAt+1},decisionDeps);
assert.equal(decisionWrites,1);await assert.rejects(persistProductionGatewayDecision({...recoveryArtifact,runId:'another'},decisionDeps),/not_saved/);
await assert.rejects(persistProductionGatewayDecision({...recoveryArtifact,body:'changed'},decisionDeps),/not_saved/);
console.log('PASS repeated immutable gateway decision is idempotent; changed content/owner still refuse');

// Exercise the worker and project store. Replace only the external review effect.
{
 const root=await mkdtemp(join(tmpdir(),'production-copy-review-'));
 const priorDirectory=process.env.OPENCHATCUT_DATA_DIR,priorFetch=globalThis.fetch;
 process.env.OPENCHATCUT_DATA_DIR=root;
 let network=0;
 globalThis.fetch=async()=>{network++;throw Error('Unexpected network request');};
 try{
  const {productionStageWorker}=await import('./production-worker');
  const {setStoredEntry}=await import('../plugins/project-store');
  const {loadOfflineStoredProject}=await import('../external-agent/offline-project-store');
  const {claimOfflineProjectOwnership,releaseProjectEditOwnership}=await import('../external-agent/project-edit-ownership');
  const projectId='worker-copy-review-fixture';
  const candidate=structuredClone(saved.cases[0].doc) as unknown as ProjectDoc;
  const reviewed=candidate.clipMentorAnalysis!.production_copy_review!;
  delete candidate.clipMentorAnalysis!.production_copy_review;
  await setStoredEntry('projects',[{id:projectId,name:'Worker copy review fixture',updatedAt:1}]);
  await setStoredEntry(`project:${projectId}`,candidate);
  const before=(await loadOfflineStoredProject(projectId))!;
  assert(before);
  const initialTask={
   taskId:'worker-copy-review-task',projectId,projectRevision:before.revision,stage:'copy_review',
   repairs:0,feedbackUsed:false,effects:{},
   input:{sourceAssetId:candidate.clipMentorAnalysis!.source.asset_id,brief:'Copy review fixture',budget:{review:1},
    author:{origin:'http://127.0.0.1:5199'},
    reviewer:{provider:'openai',model:'fixture',origin:'http://127.0.0.1:5199',apiMode:'chat'}},
  } satisfies Partial<ProductionTask> as ProductionTask;
  const keys:string[]=[];
  const bodies=new Map<string,{body:{operationId:string;requestsAttempted:number;receipt:typeof reviewed};status:number}>();
  let submissions=0;
  let staleReceipt=true;
  let reviewRemaining=1;
  const stage:StageContext={
   signal:new AbortController().signal,
   remaining:()=>reviewRemaining,
   hasEffect:(kind,key)=>kind==='review'&&bodies.has(key),
   async effect<T>(kind:Parameters<StageContext['effect']>[0],key:string){
    assert.equal(kind,'review');
    keys.push(key);
    const retained=bodies.get(key);
    if(retained)return {...retained,body:{...retained.body,cached:true}} as T;
    submissions++;
    const competing=await claimOfflineProjectOwnership(projectId,'while-reviewing');
    if(competing.status==='claimed')await releaseProjectEditOwnership(competing.claim);
    assert.notEqual(competing.status,'claimed','review must hold the editor lease across the awaited effect');
    const receipt={...reviewed,author_run_id:initialTask.taskId,reviewer_run_id:`clipmentor-review:${key}`,
     analysis_revision:reviewed.analysis_revision-(staleReceipt?1:0)};
    const result={body:{operationId:key,requestsAttempted:1,receipt},status:200};
    if(!staleReceipt)bodies.set(key,result);
    return result as T;
   },
  };
  await assert.rejects(productionStageWorker({...initialTask,projectRevision:'v3-stale'},stage),/production_project_changed/);
  assert.equal(keys.length,0,'stale task revision must stop before reserving an effect');
  await assert.rejects(productionStageWorker(initialTask,stage),/Review could not be completed or bound/);
  assert.deepEqual(await loadOfflineStoredProject(projectId),before,'old receipt must not change the current project');
  assert.equal(submissions,1,'the stale receipt must actually reach the worker once');
  staleReceipt=false;
  const currentTask={...initialTask,repairs:1};
  const current=await productionStageWorker(currentTask,stage);
  assert.equal(current.repair,undefined);
  assert.equal((current.artifact.gate as {allowed:boolean}).allowed,true);
  const stored=(await loadOfflineStoredProject(projectId))!;
  assert.notEqual(stored.revision,before.revision);
  assert.equal(current.artifact.revision,stored.revision);
  const operationId=keys[1];
  const receipt=current.artifact.receipt as {operationId:string;requestsSent:number;saved:boolean;projectRevision:string};
  assert.deepEqual([receipt.operationId,receipt.requestsSent,receipt.saved,receipt.projectRevision],[operationId,1,true,stored.revision]);
  assert.deepEqual(stored.doc.clipMentorAnalysis!.production_copy_review,bodies.get(operationId)!.body.receipt);

  reviewRemaining=0;
  await assert.rejects(productionStageWorker({...currentTask,repairs:2,projectRevision:stored.revision},stage),/review budget exhausted/);
  assert.equal(keys.length,2,'a new operation cannot dispatch on exhausted budget');
  const replay=await productionStageWorker({...currentTask,projectRevision:stored.revision},stage);
  const replayReceipt=replay.artifact.receipt as {operationId:string;requestsSent:number;cached:boolean};
  assert.deepEqual([replayReceipt.operationId,replayReceipt.requestsSent,replayReceipt.cached],[operationId,0,true]);
  assert.deepEqual(await loadOfflineStoredProject(projectId),stored);
  assert.equal(keys.length,3,'only the two fresh cases and a replay enter the review effect');
  assert.notEqual(keys[0],operationId,'repair epochs have distinct effect keys');
  assert.equal(keys[2],operationId,'the same stage and repair resume the original effect');
  assert.equal(submissions,2,'one fake submission per fresh review, none on stale start or replay');
  assert.equal(network,0);
  console.log('PASS real copy_review worker: stale task and receipt refused, lease held, fresh review saved/read back, exhausted-budget replay submits zero times');
 }finally{
  globalThis.fetch=priorFetch;
  if(priorDirectory===undefined)delete process.env.OPENCHATCUT_DATA_DIR;
  else process.env.OPENCHATCUT_DATA_DIR=priorDirectory;
  await rm(root,{recursive:true,force:true});
 }
}
