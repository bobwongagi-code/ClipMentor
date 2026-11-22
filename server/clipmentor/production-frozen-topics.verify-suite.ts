import assert from 'node:assert/strict';
import type {ProjectDoc} from '../../src/editor/types';
import {checkTeachingBaseline,frozenTeachingTopics,teachingBaselineDigest,teachingBaselineSource,teachingRebuild,
 unchangedWholeFilmTeaching,validateTeachingBaselineReview,wholeFilmIssue} from './production-teaching-baseline';
import {productionAuthorTaskData} from './production-worker';
import type {ProductionTask} from './production-task';

type Source=ReturnType<typeof teachingBaselineSource>;
type Review=ReturnType<typeof validateTeachingBaselineReview>;

export async function verifyFrozenTopics(draft:ProjectDoc,strictTask:ProductionTask,strictPositive:Source,positiveReceipt:Review){
 assert(positiveReceipt.whole_film);
 const frozenDoc=structuredClone(draft);
 const frozenHash='567e6312bd2024655eeee499ffb1358fa081341004d71436829d9ed846aebf49';
 frozenDoc.clipMentorAnalysis!.source.sourceContentHash=frozenHash;
 frozenDoc.assets[0].sourceContentHash=frozenHash;
 const topics=frozenTeachingTopics(frozenDoc,strictTask)!;
 assert(topics);
 assert.equal(frozenTeachingTopics(draft,strictTask),undefined);
 assert.equal(frozenTeachingTopics(frozenDoc,{...strictTask,input:{...strictTask.input,sourceAssetId:'unrelated'}}),undefined);
 const authorScope=await productionAuthorTaskData({...strictTask,stage:'analysis'},frozenDoc);
 assert.deepEqual(authorScope.frozenTopics,topics);
 assert.match(authorScope.frozenTopicInstruction??'',/segments\[\]\.unknowns/);
 const scopedSource=structuredClone(strictPositive);
 const [palette,nose,background]=scopedSource.evidence;
 palette.range=[8,9.333333333333334];
 nose.range=[35,36.6];
 background.range=[44,44];
 const [mainUnit]=scopedSource.units;
 const [mainPoint]=mainUnit.points;
 mainUnit.source_ranges=[palette.range,nose.range];
 mainPoint.teaching_basis!.evidence_ids=[palette.id,nose.id];
 scopedSource.units=[mainUnit];
 scopedSource.frozenTopics={...topics,closingUnitId:mainUnit.unit_id,closingSegmentId:'ending'};
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
 }
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
 tail.source_range_seconds=[63,67.3];
 tail.unknowns=[topics.closing];
 const declared=teachingBaselineSource(frozenDoc,strictTask,[]);
 assert.equal(declared.frozenTopics?.closingSegmentId,tail.segment_id);
 tail.unknowns=[topics.closing,'已确认原片促单'];
 const contradictory=teachingBaselineSource(frozenDoc,strictTask,[]);
 const rebuild=teachingRebuild(contradictory,frozenDoc,{feedback_scope:'none',units:[],whole_film:{...scopedReceipt.whole_film,
  status:'fix',frozen_topic_checks:{main_scope:'pass',closing_status:'fail'}}});
 assert(unchangedWholeFilmTeaching(contradictory,rebuild));
 assert.equal(unchangedWholeFilmTeaching(declared,rebuild),false,'correcting the closing note counts as repair progress');
 tail.unknowns=[topics.closing];
 frozenDoc.clipMentorAnalysis!.blueprint.reverse();
 assert.equal(teachingBaselineSource(frozenDoc,strictTask,[]).frozenTopics?.closingSegmentId,null,'board order controls the ending');
 frozenDoc.clipMentorAnalysis!.blueprint.reverse();
 const recipient=frozenDoc.clipMentorAnalysis!.source_breakdown!.units;
 for(const unit of recipient){
  unit.original_segment_ids=unit.original_segment_ids.filter(id=>id!==tail.segment_id);
  unit.explanation_segment_ids=unit.explanation_segment_ids.filter(id=>id!==tail.segment_id);
 }
 recipient[0].original_segment_ids.push(tail.segment_id);
 assert.equal(teachingBaselineSource(frozenDoc,strictTask,[]).frozenTopics?.closingSegmentId,null);
 recipient.at(-1)!.explanation_segment_ids.push(tail.segment_id);
 assert.equal(teachingBaselineSource(frozenDoc,strictTask,[]).frozenTopics?.closingSegmentId,null,'explanation-only attachment cannot serve as the original ending');
 console.log('PASS frozen topic scope rejects false overall approval, reuses saved decisions and binds the original ending to board order');
}
