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
 assert.deepEqual(authorScope.selectionAdvice,{recordedRequest:quote,previousPlan:declaration.main,
  previousBackground:declaration.background,suggestedWindows:declaration.mainRanges,previouslyUnusedWindows:declaration.backgroundRanges});
 assert(!Object.hasOwn(authorScope,'frozenTopics'));
 const advice={category:'teaching_decision',text:'旁白讲动作为什么值得留下。',source:{who:'记录方',reference:'选题讨论'},
  rationale:'达人用原速示范接触面。',reconsiderWhen:'原片或选题发生变化。'};
 const proposal={kind:'source_teaching',source,quote,closing:declaration.closing,guidance:[advice]};
 assert.deepEqual((await productionAuthorTaskData({...scopeTask,stage:'analysis',
  input:{...scopeTask.input,doneCriteria:parseProductionSourceCriteria([proposal])}},frozenDoc)).selectionAdvice,
  {recordedRequest:quote,advice:[advice]});
 for(const field of ['category','source','rationale','reconsiderWhen'] as const){
  const incomplete:Partial<typeof advice>={...advice};delete incomplete[field];
  assert.throws(()=>parseProductionSourceCriteria([{...proposal,guidance:[incomplete]}]),/source_criteria_invalid/,field);
 }
 for(const extra of [{requiredWindows:[[1,2]]},{backgroundRanges:[[1,2]]},{mustCoverAllWindows:true}]){
  assert.throws(()=>parseProductionSourceCriteria([{...proposal,...extra}]),/source_criteria_invalid/);
 }
 assert.throws(()=>parseProductionSourceCriteria([{...proposal,guidance:[{...advice,
  enforcement:'hard',confirmedBy:'editor'}]}]),/source_criteria_invalid/);
 assert.deepEqual(authorScope.sourceClosing,teachingBaselineSource(frozenDoc,scopeTask,[]).sourceClosing);
 assert.deepEqual(Object.keys(authorScope.sourceClosing!.rules),['confirmed','weak_candidate','none']);
 assert.equal(authorScope.sourceClosing?.decision,'weak_candidate');
 assert.equal(sourceClosingDecision({...topics,closingStatus:'confirmed'}),'confirmed');
 assert.equal(sourceClosingDecision({...topics,closingStatus:'none'}),'none');
 assert.equal(authorScope.sourceClosing?.factOnly,true);
 assert.equal(authorScope.sourceClosing?.factualNote,topics.closing);
 assert.equal(authorScope.sourceClosing?.requiredNote,undefined);
 const otherAuthor=await productionAuthorTaskData({...strictTask,stage:'analysis'},draft);
 assert.equal(otherAuthor.sourceClosing?.decision,null);
 assert.deepEqual(otherAuthor.sourceClosing?.rules,authorScope.sourceClosing.rules);
 assert.equal(otherAuthor.sourceClosing?.factOnly,undefined);
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
 assert(!(await productionAuthorTaskData({...boundTask,stage:'analysis'},boundDoc)).doneCriteria?.includes(quote));
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
 assert.deepEqual(productionTeachingBrief(child,null,boundDoc)?.doneCriteria,[quote,'保留明确交付要求'],
  'an already approved legacy output retains the brief digest used by its receipt');
 child.blueprintApproval!.teachingBrief!.sourceAdviceSeparated=true;
 assert.deepEqual(productionTeachingBrief(child,null,boundDoc)?.doneCriteria,['保留明确交付要求']);
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
 const weakSource={...scopedSource,sourceClosing:authorScope.sourceClosing!};
 const weakReview={...scopedReceipt,whole_film:{...scopedReceipt.whole_film,frozen_topic_checks:{main_scope:'pass'}}};
 // A longer observation crosses a historical background boundary. The same
 // qualified teaching point can cite it without changing its decision.
 const originalPaletteRange=palette.range;
 const originalUnitRanges=mainUnit.source_ranges;
 palette.range=[43.5,43.7];
 mainUnit.source_ranges=[palette.range,nose.range];
 assert.equal(validateTeachingBaselineReview(weakReview,weakSource).whole_film?.status,'ok');
 const withoutOldScopeCheck=structuredClone(weakReview);
 Reflect.deleteProperty(withoutOldScopeCheck.whole_film,'frozen_topic_checks');
 assert.equal(validateTeachingBaselineReview(withoutOldScopeCheck,weakSource).whole_film?.status,'ok');
 palette.range=originalPaletteRange;
 mainUnit.source_ranges=originalUnitRanges;
 assert.equal(validateTeachingBaselineReview(weakReview,weakSource).whole_film?.status,'ok');
 const staleClosingCheck={...weakReview,whole_film:{...weakReview.whole_film,frozen_topic_checks:{main_scope:'pass',closing_status:'fail'}}};
 assert.equal(wholeFilmIssue(validateTeachingBaselineReview(staleClosingCheck,weakSource).whole_film),undefined);
 const scopeFailure={...weakReview,whole_film:{...weakReview.whole_film,frozen_topic_checks:{main_scope:'fail'}}};
 assert.equal(validateTeachingBaselineReview(scopeFailure,weakSource).whole_film?.status,'ok');
 const actualRejection={...weakReview,whole_film:{...weakReview.whole_film,status:'fix',affected_unit_ids:[mainUnit.unit_id],
  reason:'实际讲解把原片弱建议写成确定推荐。'}};
 assert.equal(wholeFilmIssue(validateTeachingBaselineReview(actualRejection,weakSource).whole_film),'实际讲解把原片弱建议写成确定推荐。');
 assert.equal(validateTeachingBaselineReview(scopedReceipt,scopedSource).whole_film?.status,'ok');
 for(const field of ['closing_status'] as const){
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
 // Registered evidence for a point can come from a different window. The
 // rest of its clips and historical choices need not be cited.
 mainPoint.teaching_basis!.evidence_ids=[palette.id,supplementary.id];
 assert.equal(validateTeachingBaselineReview(scopedReceipt,scopedSource).whole_film?.status,'ok');
 assert(!teachingPointGaps(scopedSource,frozenDoc).some(gap=>gap.includes('全部主要证据窗口')));
 // Adding a new teaching group cannot turn a historical background window
 // into a prohibition. Reuse an actual point and ground its finding separately.
 const addedUnit=structuredClone(strictPositive.units[1]);
 addedUnit.source_ranges=[background.range];
 const [addedPoint]=addedUnit.points;
 const originalBackgroundRange=background.range;
 background.range=[43.6,45.2];
 addedUnit.source_ranges=[background.range];
 addedPoint.teaching_basis!.evidence_ids=[background.id];
 scopedSource.units.push(addedUnit);
 const [addedDecision]=structuredClone(positiveReceipt.units.slice(1,2));
 addedDecision.evidence_ids=[background.id];
 addedDecision.point_checks![0].source_evidence_id=background.id;
 addedDecision.point_checks![0].source_quote=background.text;
 const withNewGroup={...scopedReceipt,units:[...scopedReceipt.units,addedDecision]};
 assert.equal(validateTeachingBaselineReview(withNewGroup,scopedSource).whole_film?.status,'ok');
 // A group can teach from a registered replay that is outside its own original playback.
 addedUnit.source_ranges=[[12,22]];
 const replayId='declared-replay';
 addedUnit.segments.push({id:replayId,range:background.range,visible:[background.id],claims:[],unknowns:[]});
 addedPoint.segment_ids=[replayId];
 addedUnit.explanation_segments=[replayId];
 assert.equal(validateTeachingBaselineReview(withNewGroup,scopedSource).whole_film?.status,'ok');
 addedUnit.explanation_segments=[];
 assert.throws(()=>validateTeachingBaselineReview(withNewGroup,scopedSource),/teaching_baseline_review_invalid/);
 addedUnit.explanation_segments=[replayId];
 addedPoint.teaching_basis!.evidence_ids=[];
 assert.throws(()=>validateTeachingBaselineReview(withNewGroup,scopedSource),/teaching_baseline_review_invalid/);
 scopedSource.units.pop();
 background.range=originalBackgroundRange;
 mainPoint.teaching_basis!.evidence_ids=[palette.id,nose.id];
 const replacedBy=structuredClone(palette);
 replacedBy.id='replacement-palette-view';replacedBy.range=[10.2,11];
 scopedSource.evidence.push(replacedBy);
 mainUnit.source_ranges=[replacedBy.range,nose.range];
 mainPoint.teaching_basis!.evidence_ids=[replacedBy.id];
 const switched=structuredClone(scopedReceipt);
 switched.units[0].evidence_ids=[replacedBy.id];
 switched.units[0].point_checks![0].source_evidence_id=replacedBy.id;
 switched.whole_film.evidence_id=replacedBy.id;
 assert.equal(validateTeachingBaselineReview(switched,scopedSource).whole_film?.status,'ok');
 // An unregistered citation still fails even when the enclosing verdict is OK.
 switched.units[0].point_checks![0].source_evidence_id=palette.id;
 assert.throws(()=>validateTeachingBaselineReview(switched,scopedSource),/teaching_baseline_point_source_quote_invalid/);
 mainUnit.source_ranges=originalUnitRanges;
 mainPoint.teaching_basis!.evidence_ids=[palette.id,nose.id];
 const oldScopeEffect='blueprint:initial:0:teaching-baseline:'+('f'.repeat(64));
 await assert.rejects(checkTeachingBaseline({...strictTask,stage:'blueprint',repairs:0,feedbackUsed:false,effects:{
  [oldScopeEffect]:{kind:'model',operationId:'previous-review',status:'completed'},
 }},{signal:new AbortController().signal,async effect(){throw Error('Must not redispatch a prior review');}},weakSource),
 /teaching_selection_review_contract_changed/);
 scopedSource.frozenTopics.closingSegmentId=null;
 assert.throws(()=>validateTeachingBaselineReview(scopedReceipt,scopedSource),/teaching_source_closing_invalid/);
 assert.equal(validateTeachingBaselineReview(weakReview,weakSource).whole_film?.status,'ok');
 const confirmedNote='原片结尾提出已确认的购买行动';
 const confirmedTask={...scopeTask,input:{...scopeTask.input,doneCriteria:[{...declaration,closing:{...declaration.closing,status:'confirmed',note:confirmedNote}}]}};
 const tail=frozenDoc.clipMentorAnalysis!.source_breakdown!.segments.at(-1)!;
 frozenDoc.clipMentorAnalysis!.source.duration_seconds=67.33333333333333;
 tail.source_range_seconds=[61.2,67.33333333333333];
 tail.unknowns=[confirmedNote];
 const recipient=frozenDoc.clipMentorAnalysis!.source_breakdown!.units;
 const closingUnit=recipient.at(-1)!;
 closingUnit.original_source_ranges=[tail.source_range_seconds];
 const declared=teachingBaselineSource(frozenDoc,confirmedTask,[]);
 assert.equal(declared.frozenTopics?.closingSegmentId,tail.segment_id);
 // The note cites the evidence. A separately registered adjacent segment supplies the tail.
 const ledger=frozenDoc.clipMentorAnalysis!.source_breakdown!;
 const end=tail.source_range_seconds[1];
 const endCap={...tail,segment_id:'end-cap',source_range_seconds:[66.9,end] as [number,number],unknowns:[] as string[]};
 tail.source_range_seconds=[61.2,66.9];
 ledger.segments.push(endCap);
 closingUnit.original_segment_ids.push(endCap.segment_id);
 const split=()=>teachingBaselineSource(frozenDoc,confirmedTask,[]).frozenTopics!;
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
 const closingSource=teachingBaselineSource(frozenDoc,confirmedTask,[]);
 assert.equal(interruptedClosingPlanUnit(frozenDoc,closingSource),undefined);
 plan.phases=[originals[0],copy,...originals.slice(1)];
 assert.equal(interruptedClosingPlanUnit(frozenDoc,closingSource),closingUnit.unit_id,'an explanation can break continuous playback despite adjacent source times');
 if(priorReview)authored.internal_review=priorReview;else delete authored.internal_review;
 closingUnit.original_segment_ids.splice(-2,1);
 ledger.segments.pop();
 tail.source_range_seconds=[61.2,66.9];
 closingUnit.original_source_ranges=[tail.source_range_seconds,endCap.source_range_seconds];
 tail.unknowns=[confirmedNote+'；仅见手背色块，原声未核。'];
 assert.equal(split().closingSegmentId,tail.segment_id);
 for(const note of ['请补写：'+confirmedNote,confirmedNote+'并不成立']){
  tail.unknowns=[note];
  assert.equal(split().closingSegmentId,null);
 }
 tail.unknowns=[confirmedNote];
  endCap.unknowns=[confirmedNote+'；原声未核。'];
  assert(teachingPointGaps(teachingBaselineSource(frozenDoc,confirmedTask,[]),frozenDoc)
   .some(issue=>issue.startsWith('source_closing_note_duplicate')));
  endCap.unknowns=[];
  assert(!teachingPointGaps(teachingBaselineSource(frozenDoc,confirmedTask,[]),frozenDoc)
   .some(issue=>issue.startsWith('source_closing_note_duplicate')));
 endCap.source_range_seconds[0]+=0.1;
 assert.equal(split().closingSegmentId,null,'a registration gap cannot be covered by the playback envelope');
 endCap.source_range_seconds[0]=66.9;
 closingUnit.original_source_ranges=[[61.2,66.8],[66.9,end]];
 assert.equal(split().closingSegmentId,null,'the original playback itself must also be continuous');
 closingUnit.original_source_ranges=[[61.2,end]];
 tail.unknowns=[];endCap.unknowns=[confirmedNote];
 assert(split().misplacedClosingNote,'an EOF-only annotation cannot support the earlier evidence');
 endCap.unknowns=[];
 assert.equal(split().closingSegmentId,null);
 closingUnit.original_segment_ids.pop();
 ledger.segments.pop();
 tail.source_range_seconds=[61.2,end];
 tail.unknowns=[];
 const omitted=teachingBaselineSource(frozenDoc,confirmedTask,[]);
 assert.equal(omitted.frozenTopics?.closingSegmentId,null);
 assert(teachingPointGaps(omitted,frozenDoc).includes('收尾须登记：'+confirmedNote));
 const wrongNote=frozenDoc.clipMentorAnalysis!.source_breakdown!.segments[0].unknowns;
 wrongNote.push(confirmedNote);
 assert(teachingPointGaps(teachingBaselineSource(frozenDoc,confirmedTask,[]),frozenDoc).some(f=>f.startsWith('source_closing_note_binding_changed')));
 wrongNote.pop();
 tail.unknowns=[confirmedNote,'另称片尾无促单'];
 const contradictory=teachingBaselineSource(frozenDoc,confirmedTask,[]);
 const rebuild=teachingRebuild(contradictory,frozenDoc,{feedback_scope:'none',units:[],whole_film:{...scopedReceipt.whole_film,
  status:'fix',frozen_topic_checks:{main_scope:'pass',closing_status:'fail'}}});
 assert(unchangedWholeFilmTeaching(contradictory,rebuild));
 assert.equal(unchangedWholeFilmTeaching(declared,rebuild),false,'correcting the closing note counts as repair progress');
 tail.unknowns=[confirmedNote];
 frozenDoc.clipMentorAnalysis!.source.duration_seconds=80;
 const early=teachingBaselineSource(frozenDoc,confirmedTask,[]);
 assert(teachingPointGaps(early,frozenDoc).includes('最后一个教学组的原片回放须覆盖已登记的收尾证据并到达片尾'));
 tail.source_range_seconds=[79.97,80];
 closingUnit.original_source_ranges=[tail.source_range_seconds];
 assert.equal(split().closingSegmentId,null,'the last frame does not cover the cited tail');
 tail.source_range_seconds=[61.2,80];
 closingUnit.original_source_ranges=[tail.source_range_seconds];
 assert.equal(split().closingSegmentId,tail.segment_id);
 frozenDoc.clipMentorAnalysis!.blueprint.reverse();
 assert.equal(split().closingSegmentId,null,'board order controls the ending');
 frozenDoc.clipMentorAnalysis!.blueprint.reverse();
 for(const unit of recipient){
  unit.original_segment_ids=unit.original_segment_ids.filter(id=>id!==tail.segment_id);
  unit.explanation_segment_ids=unit.explanation_segment_ids.filter(id=>id!==tail.segment_id);
 }
 recipient[0].original_segment_ids.push(tail.segment_id);
 assert.equal(split().closingSegmentId,null);
 recipient.at(-1)!.explanation_segment_ids.push(tail.segment_id);
 assert.equal(split().closingSegmentId,null,'explanation-only attachment cannot serve as the original ending');
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
 console.log('PASS source advice is scoped to guidance; replacement evidence passes, invalid facts and broken closing bindings still fail');
}
