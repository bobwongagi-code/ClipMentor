import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {ProjectDoc} from '../../src/editor/types';
import {checkTeachingBaseline,frozenTeachingTopics,interruptedClosingPlanUnit,teachingBaselineDigest,teachingBaselineSource,teachingRebuild,
 teachingPointGaps,unchangedWholeFilmTeaching,validateTeachingBaselineReview,wholeFilmIssue} from './production-teaching-baseline';
import {productionAuthorTaskData} from './production-worker';
import {productionOpeningComparison,productionTeachingBrief,type ProductionTask} from './production-task';
import {panelSalesEvidence} from './production-panel-delivery';
import {parseProductionSourceCriteria,type SourceTeachingCriterion,type SourcePerformanceCriterion} from '../../shared/clipmentor-handoff';
import {revisionOf} from '../../src/agent/external-edit-session';
import {recordEditorApprovedGateProbe,firstSuspectedGateDefect} from './production-gate-probes';
import {sourceClosingDecision} from './production-source-policy';

type Source=ReturnType<typeof teachingBaselineSource>;
type Review=ReturnType<typeof validateTeachingBaselineReview>;

export async function verifyFrozenTopics(draft:ProjectDoc,strictTask:ProductionTask,strictPositive:Source,positiveReceipt:Review){
 assert(positiveReceipt.whole_film);
 const frozenDoc=structuredClone(draft);
 const frozenHash='567e6312bd2024655eeee499ffb1358fa081341004d71436829d9ed846aebf49';
 frozenDoc.clipMentorAnalysis!.source.sourceContentHash=frozenHash;
 frozenDoc.assets[0].sourceContentHash=frozenHash;
 const sourceId=strictTask.input.sourceAssetId,quote='把原话、画面证据、达人能学什么和讲解怎么承载都做实';
 const source={assetId:sourceId,sha256:frozenHash};
 const declaration:SourceTeachingCriterion={kind:'source_teaching',source,quote,
  main:'主线只讲盘内相对色差和鼻侧色痕',background:'外颊和高光留作背景',
  mainRanges:[[7.6,9.8],[34,36.6]],backgroundRanges:[[43.6,45.2],[56,61.2]],
  closing:{status:'weak_candidate',note:'无已确认促单组，仅有弱促单待核',evidenceRange:[64,66.9]}};
 frozenDoc.clipMentorAnalysis!.source.duration_seconds=67.33333333333333;
 assert.throws(()=>parseProductionSourceCriteria([declaration,declaration]),/source_criteria_invalid/);
 assert.throws(()=>parseProductionSourceCriteria([{...declaration,mainRanges:[[9,7]]}]),/source_criteria_invalid/);
 assert.equal(frozenTeachingTopics(frozenDoc,{input:{...strictTask.input,doneCriteria:[]}}),undefined,
  'matching uploaded bytes alone never install the teaching requirement');
 const scopeTask={...strictTask,input:{...strictTask.input,doneCriteria:[declaration]}};
 const topics=frozenTeachingTopics(frozenDoc,scopeTask)!;
 assert(topics);
 assert.equal(frozenTeachingTopics(frozenDoc,strictTask),undefined);
 assert.throws(()=>frozenTeachingTopics(draft,scopeTask),/source_teaching_binding_changed/);
 assert.throws(()=>frozenTeachingTopics(frozenDoc,{...scopeTask,input:{...scopeTask.input,sourceAssetId:'unrelated'}}),/source_teaching_binding_changed/);
 const authorScope=await productionAuthorTaskData({...scopeTask,stage:'analysis'},frozenDoc);
 assert.deepEqual(authorScope.frozenTopics,topics);
 assert.deepEqual(authorScope.sourceClosing,teachingBaselineSource(frozenDoc,scopeTask,[]).sourceClosing);
 assert.deepEqual(Object.keys(authorScope.sourceClosing!.rules),['confirmed','weak_candidate','none']);
 assert.equal(authorScope.sourceClosing?.decision,'weak_candidate');
 assert.equal(sourceClosingDecision({...topics,closingStatus:'confirmed'}),'confirmed');
 assert.equal(sourceClosingDecision({...topics,closingStatus:'none'}),'none');
 assert.match(authorScope.sourceClosing?.noteLocation??'',/segments\[\]\.unknowns/);
 const otherAuthor=await productionAuthorTaskData({...strictTask,stage:'analysis'},draft);
 assert.equal(otherAuthor.sourceClosing?.decision,null);
 assert.deepEqual(otherAuthor.sourceClosing?.rules,authorScope.sourceClosing.rules);
 const salesHash='4a62b3adca0c3a8890ef0a676706bd266a30d10d0cff875206e43bd90b0b5c24',saleId='fixture-sales-image';
 const performance:SourcePerformanceCriterion={kind:'source_performance',source,evidence:{assetId:saleId,sha256:salesHash},
  quote:'等义改写的片头',results:{views:'339.32k',units:'135',revenue:'RM5.31k'}};
 const sale=panelSalesEvidence(sourceId,saleId,performance.results);
 const boundDoc=structuredClone(frozenDoc);
 boundDoc.assets.push({...boundDoc.assets[0],id:saleId,kind:'image',sourceContentHash:salesHash});
 boundDoc.clipMentorAnalysis!.evidence.push(sale);
 const boundTask={...scopeTask,input:{...scopeTask.input,doneCriteria:[declaration,performance],
  panelDelivery:{...strictTask.input.panelDelivery!,salesAssetId:saleId,salesAssetHash:salesHash,
   salesEvidenceId:sale.evidence_id,salesEvidenceSha256:createHash('sha256').update(sale.text).digest('hex')}}};
 assert((await productionAuthorTaskData({...boundTask,stage:'analysis'},boundDoc)).doneCriteria?.includes(quote));
 assert.deepEqual(productionOpeningComparison(boundTask,null,boundDoc)?.results,performance.results);
 const generic=panelSalesEvidence(sourceId,saleId);
 const oldDoc=structuredClone(boundDoc);
 oldDoc.clipMentorAnalysis!.evidence=oldDoc.clipMentorAnalysis!.evidence.map(e=>e.evidence_id===sale.evidence_id?generic:e);
 const oldTask={...boundTask,input:{...boundTask.input,openingComparison:undefined,panelDelivery:{...boundTask.input.panelDelivery,
  salesEvidenceSha256:createHash('sha256').update(generic.text).digest('hex')}}};
 assert.deepEqual(productionOpeningComparison(oldTask,null,oldDoc)?.results,performance.results);
 assert.throws(()=>productionOpeningComparison({...oldTask,input:{...oldTask.input,openingComparison:{kind:'opening_comparison',quote:'legacy',
  results:{...performance.results,views:'7'}}}},null,oldDoc),/source_performance_evidence_changed/);
 const tampered=structuredClone(boundDoc);
 tampered.clipMentorAnalysis!.evidence.find(e=>e.evidence_id===sale.evidence_id)!.text+=' changed same ID';
 assert.throws(()=>productionOpeningComparison(boundTask,null,tampered),/source_performance_evidence_changed/);
 const child:ProductionTask={...boundTask,blueprintApproval:{sourceProjectId:boundTask.projectId,sourceTaskId:boundTask.taskId,
  sourceRevision:'fixture',digest:'fixture',requirementsDigest:'fixture',confirmedAt:1,
  teachingBrief:{instruction:'Frozen',doneCriteria:['保留明确交付要求']}}};
 assert.deepEqual(productionTeachingBrief(child,null,boundDoc)?.doneCriteria,[quote,'保留明确交付要求']);
 tampered.clipMentorAnalysis!.evidence=boundDoc.clipMentorAnalysis!.evidence;
 tampered.assets.find(a=>a.id===saleId)!.sourceContentHash='c'.repeat(64);
 assert.throws(()=>productionOpeningComparison(boundTask,null,tampered),/source_performance_binding_changed/);
 assert.throws(()=>productionOpeningComparison(boundTask,null,draft),/source_performance_binding_changed/);
 const scopedSource=structuredClone(strictPositive);
 const [palette,nose,background]=scopedSource.evidence;
 palette.range=[8,9.333333333333334];
 nose.range=[35,36.6];
 background.range=[44,44];
 const supplementary=structuredClone(background);supplementary.id='supplementary';supplementary.range=[21,21];
 scopedSource.evidence.push(supplementary);
 const [mainUnit]=scopedSource.units;
 const [mainPoint]=mainUnit.points;
 mainUnit.source_ranges=[palette.range,nose.range];
 mainPoint.teaching_basis!.evidence_ids=[palette.id,nose.id];
 scopedSource.units=[mainUnit];
 scopedSource.frozenTopics={...topics,closingUnitId:mainUnit.unit_id,closingSegmentId:'ending',misplacedClosingNote:false,closingTailSegmentIds:['ending']};
 const scopedReceipt={...structuredClone(positiveReceipt),units:structuredClone(positiveReceipt.units.slice(0,1)),
  whole_film:{...positiveReceipt.whole_film,frozen_topic_checks:{main_scope:'pass',closing_status:'pass'}}};
 assert.equal(validateTeachingBaselineReview(scopedReceipt,scopedSource).whole_film?.status,'ok');
 for(const field of ['main_scope','closing_status'] as const){
  const bad=structuredClone(scopedReceipt);
  bad.whole_film.focus='主线超出盘内色差和鼻侧上脸参照的确认范围';
  bad.whole_film.frozen_topic_checks[field]='fail';
  const result=validateTeachingBaselineReview(bad,scopedSource);
  assert.equal(result.whole_film?.status,'fix',field);
  assert(wholeFilmIssue(result.whole_film));
  assert.deepEqual(validateTeachingBaselineReview(result,scopedSource),result);
  const digest=teachingBaselineDigest(scopedSource),operationId=`frozen-review-${field}`;
  const effects:ProductionTask['effects']={[`fixture:teaching-baseline:${digest}`]:{kind:'model',operationId,status:'completed',
   result:{digest,runId:operationId,review:result}}};
  const reused=await checkTeachingBaseline({...strictTask,effects},{signal:new AbortController().signal,
   async effect(){throw Error('Saved review must be reused');}},scopedSource);
  assert.deepEqual(reused.review,result);
 }
 assert.throws(()=>validateTeachingBaselineReview({...scopedReceipt,whole_film:positiveReceipt.whole_film},scopedSource),/teaching_frozen_topic_verdict_invalid/);
 for(const evidenceIds of [[palette.id],[palette.id,nose.id,background.id]]){
  mainPoint.teaching_basis!.evidence_ids=evidenceIds;
  assert.throws(()=>validateTeachingBaselineReview(scopedReceipt,scopedSource),/teaching_frozen_topic_scope_invalid/);
  const gaps=teachingPointGaps(scopedSource,frozenDoc);
  if(evidenceIds.length===1)assert(gaps.includes('主线须覆盖任务声明的全部主要证据窗口'));
  else assert(gaps.some(gap=>gap.includes('背景用途')));
 }
 mainPoint.teaching_basis!.evidence_ids=[palette.id,nose.id,supplementary.id];
 assert.equal(validateTeachingBaselineReview(scopedReceipt,scopedSource).whole_film?.status,'ok');
 mainPoint.teaching_basis!.evidence_ids=[palette.id,nose.id];
 // Two primary judgments carry different evidence from the same declared topic.
 const secondUnit=structuredClone(strictPositive.units[1]);
 secondUnit.source_ranges=[nose.range];
 const [secondPoint]=secondUnit.points;
 secondPoint.teaching_basis!.evidence_ids=[nose.id,supplementary.id];
 mainPoint.teaching_basis!.evidence_ids=[palette.id];
 scopedSource.units.push(secondUnit);
 const splitReceipt={...scopedReceipt,units:[...scopedReceipt.units,positiveReceipt.units[1]]};
 const missingWindow='主线须覆盖任务声明的全部主要证据窗口';
 assert(!teachingPointGaps(scopedSource,frozenDoc).includes(missingWindow));
 assert.equal(validateTeachingBaselineReview(splitReceipt,scopedSource).whole_film?.status,'ok');
 secondPoint.role='supporting';
 assert(teachingPointGaps(scopedSource,frozenDoc).includes(missingWindow));
 assert.throws(()=>validateTeachingBaselineReview(splitReceipt,scopedSource),/teaching_frozen_topic_scope_invalid/);
 secondPoint.role='primary';
 secondUnit.coverage[0].treatment='omit';
 assert(teachingPointGaps(scopedSource,frozenDoc).includes(missingWindow));
 scopedSource.units.pop();
 mainPoint.teaching_basis!.evidence_ids=[palette.id,nose.id];
 const backgroundGroup=structuredClone(strictPositive.units[2]);
 backgroundGroup.source_ranges=[[47,60]];
 background.range=[47,60];
 scopedSource.units.push(backgroundGroup);
 const twoGroups={...scopedReceipt,units:[...scopedReceipt.units,positiveReceipt.units[2]]};
 for(const kind of ['visible_action','original_claim']){
  background.kind=kind;
  assert.throws(()=>validateTeachingBaselineReview(twoGroups,scopedSource),/teaching_frozen_topic_scope_invalid/,kind);
 }
 scopedSource.units.pop();
 scopedSource.frozenTopics.closingSegmentId=null;
 assert.throws(()=>validateTeachingBaselineReview(scopedReceipt,scopedSource),/teaching_frozen_topic_scope_invalid/);
 const tail=frozenDoc.clipMentorAnalysis!.source_breakdown!.segments.at(-1)!;
 frozenDoc.clipMentorAnalysis!.source.duration_seconds=67.33333333333333;
 tail.source_range_seconds=[61.2,67.33333333333333];
 tail.unknowns=[topics.closing];
 const recipient=frozenDoc.clipMentorAnalysis!.source_breakdown!.units;
 const closingUnit=recipient.at(-1)!;
 closingUnit.original_source_ranges=[tail.source_range_seconds];
 const declared=teachingBaselineSource(frozenDoc,scopeTask,[]);
 assert.equal(declared.frozenTopics?.closingSegmentId,tail.segment_id);
 // The note cites the evidence. A separately registered adjacent segment supplies the tail.
 const ledger=frozenDoc.clipMentorAnalysis!.source_breakdown!;
 const end=tail.source_range_seconds[1];
 const endCap={...tail,segment_id:'end-cap',source_range_seconds:[66.9,end] as [number,number],unknowns:[] as string[]};
 tail.source_range_seconds=[61.2,66.9];
 ledger.segments.push(endCap);
 closingUnit.original_segment_ids.push(endCap.segment_id);
 const split=()=>teachingBaselineSource(frozenDoc,scopeTask,[]).frozenTopics!;
 for(const playback of [[[61.2,end]],[[61.2,66.9],[66.9,end]]] as [number,number][][]){
  closingUnit.original_source_ranges=playback;
  assert.equal(split().closingSegmentId,tail.segment_id);
 }
 const mid={...tail,segment_id:'closing-evidence-part',source_range_seconds:[65.2,66.9] as [number,number],unknowns:[]};
 tail.source_range_seconds=[61.2,65.2];
 ledger.segments.push(mid);
 closingUnit.original_segment_ids.splice(-1,0,mid.segment_id);
 closingUnit.original_source_ranges=[tail.source_range_seconds,mid.source_range_seconds,endCap.source_range_seconds];
 assert.equal(split().closingSegmentId,tail.segment_id,'the declared evidence can span two adjacent registered segments');
 const authored=frozenDoc.clipMentorAnalysis!.blueprint.find(unit=>unit.unit_id===closingUnit.unit_id) as {internal_review?:Record<string,unknown>};
 const priorReview=authored.internal_review;
 const copy={mode:'explanation',line_id:'closing-explanation',source_range_seconds:[64,65]};
 const originals=closingUnit.original_source_ranges.map(source_range_seconds=>({mode:'original',source_range_seconds}));
 const plan={phases:[...originals,copy]};
 authored.internal_review={current_picture_plan:'closing-plan','closing-plan':plan};
 const closingSource=teachingBaselineSource(frozenDoc,scopeTask,[]);
 assert.equal(interruptedClosingPlanUnit(frozenDoc,closingSource),undefined);
 plan.phases=[originals[0],copy,...originals.slice(1)];
 assert.equal(interruptedClosingPlanUnit(frozenDoc,closingSource),closingUnit.unit_id,'an explanation can break continuous playback despite adjacent source times');
 if(priorReview)authored.internal_review=priorReview;else delete authored.internal_review;
 closingUnit.original_segment_ids.splice(-2,1);
 ledger.segments.pop();
 tail.source_range_seconds=[61.2,66.9];
 closingUnit.original_source_ranges=[tail.source_range_seconds,endCap.source_range_seconds];
 tail.unknowns=[topics.closing+'；仅见手背色块，原声未核。'];
 assert.equal(split().closingSegmentId,tail.segment_id);
 for(const note of ['请补写：'+topics.closing,topics.closing+'并不成立']){
  tail.unknowns=[note];
  assert.equal(split().closingSegmentId,null);
 }
 tail.unknowns=[topics.closing];
  endCap.unknowns=[topics.closing+'；原声未核。'];
  assert(teachingPointGaps(teachingBaselineSource(frozenDoc,scopeTask,[]),frozenDoc)
   .some(issue=>issue.startsWith('source_closing_note_duplicate')));
  endCap.unknowns=[];
  assert(!teachingPointGaps(teachingBaselineSource(frozenDoc,scopeTask,[]),frozenDoc)
   .some(issue=>issue.startsWith('source_closing_note_duplicate')));
 endCap.source_range_seconds[0]+=0.1;
 assert.equal(split().closingSegmentId,null,'a registration gap cannot be covered by the playback envelope');
 endCap.source_range_seconds[0]=66.9;
 closingUnit.original_source_ranges=[[61.2,66.8],[66.9,end]];
 assert.equal(split().closingSegmentId,null,'the original playback itself must also be continuous');
 closingUnit.original_source_ranges=[[61.2,end]];
 tail.unknowns=[];endCap.unknowns=[topics.closing];
 assert(split().misplacedClosingNote,'an EOF-only annotation cannot support the earlier evidence');
 endCap.unknowns=[];
 assert.equal(split().closingSegmentId,null);
 closingUnit.original_segment_ids.pop();
 ledger.segments.pop();
 tail.source_range_seconds=[61.2,end];
 tail.unknowns=[];
 const omitted=teachingBaselineSource(frozenDoc,scopeTask,[]);
 assert.equal(omitted.frozenTopics?.closingSegmentId,null);
 assert(teachingPointGaps(omitted,frozenDoc).includes('收尾须登记：'+topics.closing));
 const wrongNote=frozenDoc.clipMentorAnalysis!.source_breakdown!.segments[0].unknowns;
 wrongNote.push(topics.closing);
 assert(teachingPointGaps(teachingBaselineSource(frozenDoc,scopeTask,[]),frozenDoc).some(f=>f.startsWith('source_closing_note_binding_changed')));
 wrongNote.pop();
 tail.unknowns=[topics.closing,'已确认原片促单'];
 const contradictory=teachingBaselineSource(frozenDoc,scopeTask,[]);
 const rebuild=teachingRebuild(contradictory,frozenDoc,{feedback_scope:'none',units:[],whole_film:{...scopedReceipt.whole_film,
  status:'fix',frozen_topic_checks:{main_scope:'pass',closing_status:'fail'}}});
 assert(unchangedWholeFilmTeaching(contradictory,rebuild));
 assert.equal(unchangedWholeFilmTeaching(declared,rebuild),false,'correcting the closing note counts as repair progress');
 tail.unknowns=[topics.closing];
 frozenDoc.clipMentorAnalysis!.source.duration_seconds=80;
 const early=teachingBaselineSource(frozenDoc,scopeTask,[]);
 assert(teachingPointGaps(early,frozenDoc).includes('最后一个教学组的原片回放须覆盖已登记的收尾证据并到达片尾'));
 tail.source_range_seconds=[79.97,80];
 closingUnit.original_source_ranges=[tail.source_range_seconds];
 assert.equal(teachingBaselineSource(frozenDoc,scopeTask,[]).frozenTopics?.closingSegmentId,null,'the last frame does not cover the cited tail');
 tail.source_range_seconds=[61.2,80];
 closingUnit.original_source_ranges=[tail.source_range_seconds];
 assert.equal(teachingBaselineSource(frozenDoc,scopeTask,[]).frozenTopics?.closingSegmentId,tail.segment_id);
 frozenDoc.clipMentorAnalysis!.blueprint.reverse();
 assert.equal(teachingBaselineSource(frozenDoc,scopeTask,[]).frozenTopics?.closingSegmentId,null,'board order controls the ending');
 frozenDoc.clipMentorAnalysis!.blueprint.reverse();
 for(const unit of recipient){
  unit.original_segment_ids=unit.original_segment_ids.filter(id=>id!==tail.segment_id);
  unit.explanation_segment_ids=unit.explanation_segment_ids.filter(id=>id!==tail.segment_id);
 }
 recipient[0].original_segment_ids.push(tail.segment_id);
 assert.equal(teachingBaselineSource(frozenDoc,scopeTask,[]).frozenTopics?.closingSegmentId,null);
 recipient.at(-1)!.explanation_segment_ids.push(tail.segment_id);
 assert.equal(teachingBaselineSource(frozenDoc,scopeTask,[]).frozenTopics?.closingSegmentId,null,'explanation-only attachment cannot serve as the original ending');
 const probe=structuredClone(draft);
 const firstUnit=probe.clipMentorAnalysis!.blueprint[0];
 const sourceHash=probe.clipMentorAnalysis!.source.sourceContentHash!;
 const internal=(firstUnit as any).internal_review={
  current_picture_plan:'picture_plan_probe',current_script_candidate:'script_candidate_probe',
  picture_plan_probe:{phases:[{mode:'original',source_range_seconds:[0,1]}]},
  script_candidate_probe:{lines:[{narration_ms:'Contoh bacaan.'}]},
 };
 const phase=internal[internal.current_picture_plan].phases[0];
 const script=internal[internal.current_script_candidate];
 phase.mode='invalid-mode';
 const attestation=(project:ProjectDoc)=>({editor:'Fixture editor',approval:'Synthetic watched-candidate receipt',
  acceptedAt:'2026-11-23T00:00:00Z',projectRevision:revisionOf(project),attestation:'editor_viewed_accepted' as const});
 await assert.rejects(recordEditorApprovedGateProbe(probe,{...attestation(probe),projectRevision:'wrong revision'}));
 const first=await recordEditorApprovedGateProbe(probe,attestation(probe));
 assert(first.length>0&&first.every(result=>result.count===1));
 script.lines[0].narration_ms+='  ';
 const duplicate=await recordEditorApprovedGateProbe(probe,attestation(probe));
 assert(duplicate.every(result=>result.count===1));
 script.lines[0].narration_ms+=' Maklumat tambahan.';
 const reusedApproval=await recordEditorApprovedGateProbe(probe,attestation(probe));
 assert(reusedApproval.every(result=>result.count===0));
 const second=await recordEditorApprovedGateProbe(probe,{...attestation(probe),approval:'Second synthetic watched-candidate receipt'});
 assert(second.every(result=>result.count===1));
 const restored=structuredClone(probe);
 (restored.clipMentorAnalysis!.blueprint[0] as any).internal_review.script_candidate_probe.lines[0].narration_ms='Contoh bacaan.';
 const distinct=await recordEditorApprovedGateProbe(restored,{...attestation(restored),approval:'Original candidate checked independently'});
 const registered=distinct.find(result=>result.count===2);
 assert(registered);
 const {productionBoardPhaseIssues}=await import('./production-readiness');
 const {checkSourceBreakdown}=await import('../../src/clipmentor/source-breakdown');
 const gateIssue='blueprint_stage_incomplete:'+JSON.stringify([
  ...productionBoardPhaseIssues(restored),...checkSourceBreakdown(restored).issues,
 ]);
 assert(await firstSuspectedGateDefect(sourceHash,gateIssue));
 assert.equal(await firstSuspectedGateDefect('f'.repeat(64),gateIssue),undefined);
 console.log('PASS frozen topic scope rejects false overall approval, reuses saved decisions and binds the original ending to board order');
}
