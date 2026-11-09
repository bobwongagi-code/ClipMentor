import './native-execution.verify';
import './production-format.verify';
import './production-source-evidence.verify';
import assert from 'node:assert/strict';
import {productionPreviewFacts,productionAuthorTaskData,productionStageToolAllowed,loadProductionAuthorGuidance,executionMappingDiagnostic,productionGatewayDecisionArtifact} from './production-worker';
import {isValidAgentArtifactRecord} from '../../src/persist/agentRuntimeCodec';
import {sha256Text} from '../../src/persist/agentRuntimeStore';
import {projectDoc} from '../external-agent/offline-runtime.verify-fixtures';
import {makeDraft} from '../../src/editor/store';
import {checkTransitionManifest} from '../../src/clipmentor/transition-check';
import type {TeachingPacket} from '../../src/clipmentor/production-gate';
import {productionAuthorSelfCheckSource,checkProductionAuthorBlueprint} from './production-author-self-check';
import {createProductionPreparation} from './production-readiness';
import {isBoundCanvasReflow,assertCanvasReflowPreservation} from './production-worker';
import {digestValue} from '../agent-runs/store-values';
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
const {buildCopyTeachingReviewRequest}=await import('../../src/clipmentor/production-gate');
const reviewInput=JSON.stringify(buildCopyTeachingReviewRequest([{case_id:'isolation',packet:checkSource.blueprint}]));
assert(!reviewInput.includes('originalRequirements'),'author-check material cannot leak through the independent review projection');
const effectNames:string[]=[];
const selfCheckStage={effect:async(_kind:string,name:string)=>{effectNames.push(name);return {digest:'fixture',runId:'fixture',checks:[]};}} as unknown as import('./production-task').StageContext;
const preparedCheck=await createProductionPreparation(checkDoc);
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
const repairTargets=productionRepairTargets({repairContext:secondContext},{units:[{unit_id:'U-04',line:'current gesture observation'},{unit_id:'U-05',line:'current audience recommendation'}] as any});
const repairSource={...source,repairReview:repairTargets,sourceEvidence:[{text:'new continuous source observation'}]};
assert.throws(()=>validateAuthorSelfCheck(JSON.stringify(checks),repairSource),/repair_coverage/);
const withRepair=structuredClone(checks) as any[];
withRepair[1].repair_resolutions=repairTargets.map(t=>({finding_id:t.finding_id,status:'resolved',reference:[(t.current as any).line],reason:'current copy and point now agree'}));
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
const replaced=productionRepairContext(secondContext,{repair:{...originalRepair,units:originalRepair.units.slice(1)}});
assert.equal((replaced.pending_review_repair as any).units.length,1,'new independent receipt supersedes prior pending set');
console.log('PASS repair coverage, preserved findings, current-only references, cross-unit refusal, unresolved blocking and evidence-based response');

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
