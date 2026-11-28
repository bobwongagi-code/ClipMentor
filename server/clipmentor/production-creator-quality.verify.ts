import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import grouped from '../../src/clipmentor/fixtures/grouped-registration-v1.json';
import {creatorFilmQuestions,creatorGroupQuestions} from '../../src/clipmentor/creator-teaching-quality';
import {deliverySectionsFromDoc,openingPerformanceHeadlines} from '../../src/clipmentor/delivery-bindings';
import {confirmedOpeningResultsMatch} from '../../src/clipmentor/delivery-sections';
import {revisionOf} from '../../src/agent/external-edit-session';
import {readPanelSourceRegistration} from './production-panel-source-requirements';
import {runtimeProfile} from '../runtime-profile';
import {relative,isAbsolute} from 'node:path';
import type {ProjectDoc} from '../../src/editor/types';
import {parseProductionSourceCriteria,sourcePerformanceCriterion,sourceTeachingCriterion} from '../../shared/clipmentor-handoff';
import {planReviewBoards,requiredReviewViewIssues} from './blueprint-review-board';
import {blueprintRepairStopped} from './production-decisions';
import {captureCreatorReference,creatorBlueprintFacts,creatorNarrationRelationships,creatorOpeningMetricsValid,creatorRegressionGaps,creatorReviewIssues,
 creatorReviewWorksheet,creatorWorksheetGaps,readCreatorChecks,type CreatorConfirmedReference} from './production-creator-quality';
import {teachingSourceEvidence} from './production-teaching-baseline';

let providerCalls=0;
globalThis.fetch=async()=>{providerCalls++;throw Error('Creator replay forbids provider calls');};
type Row=Record<string,any>;
function current(doc:ProjectDoc,id:string){
 const unit=doc.clipMentorAnalysis!.blueprint.find(entry=>entry.unit_id===id) as unknown as {internal_review:Row};
 const state=unit.internal_review;
 return {candidate:state[state.current_script_candidate],plan:state[state.current_picture_plan]};
}
const registeredEvidence=(doc:ProjectDoc)=>new Set(teachingSourceEvidence(doc.clipMentorAnalysis!).map(item=>item.id));
const shape=(doc:ProjectDoc)=>({value:doc,sha256:'0'.repeat(64),hashMode:'project' as const,assertUnchanged:async()=>{},
 embedded:true,qualityRules:'v1' as const});
const strictDoc=structuredClone(grouped) as unknown as ProjectDoc;
const unit=strictDoc.clipMentorAnalysis!.source_breakdown!.units[0];
const {plan,candidate}=current(strictDoc,unit.unit_id);
assert(candidate.lines.length>1);
delete plan.selected_narration;
const withoutMirror=creatorBlueprintFacts(strictDoc);
assert.equal(withoutMirror[0].lines.length,candidate.lines.length);
assert.deepEqual(creatorRegressionGaps(withoutMirror),[{code:'creator_conclusion_missing',id:unit.unit_id}]);
plan.creator_conclusion_line_id=candidate.lines.find((line:Row)=>line.point_ids.includes(unit.coverage[0].point_id)).id;
assert.equal(creatorRegressionGaps(creatorBlueprintFacts(strictDoc)).length,0);

const before=captureCreatorReference(strictDoc,'v3-00000000','a'.repeat(64),{[unit.unit_id]:'fixture-decision'});
const hostedFacts=creatorBlueprintFacts(strictDoc).map(group=>({...group,decision:'fixture-decision'}));
assert.equal(creatorRegressionGaps(hostedFacts,before).length,0);
const relationship={category:'teaching_decision',text:'Show both objects',source:{who:'Editor',reference:'Confirmed selection'},
 rationale:'The objects share a useful reference',reconsiderWhen:'Evidence changes',confirmedDecisionId:'fixture-decision',
 narrationRelationship:'Explain which judgment the shared reference supports'};
const criterion={kind:'source_teaching',source:{assetId:'source',sha256:'0'.repeat(64)},quote:'Confirmed selection',
 closing:{status:'none',note:'No source closing',evidenceRange:[0,1]},guidance:[relationship]};
assert.deepEqual(parseProductionSourceCriteria([criterion]),[criterion]);
for(const guidance of [{...relationship,narrationRelationship:' '},{...relationship,confirmedDecisionId:undefined},
 {...relationship,category:'fact_boundary'}])
 assert.throws(()=>parseProductionSourceCriteria([{...criterion,guidance:[guidance]}]),/source_criteria_invalid/);
const required=creatorNarrationRelationships(parseProductionSourceCriteria([criterion]).flatMap(entry=>'guidance' in entry?entry.guidance:[]));
assert.deepEqual(creatorRegressionGaps(hostedFacts,before,required),[]);
assert.deepEqual(creatorRegressionGaps(hostedFacts.map(group=>({...group,narrated:false,conclusion:undefined})),before,required),
 [{code:'creator_narration_relationship_missing',id:unit.unit_id}]);
assert.deepEqual(creatorRegressionGaps(creatorBlueprintFacts(strictDoc),undefined,required),
 [{code:'creator_narration_relationship_missing',id:'fixture-decision'}]);
const duplicateLine=structuredClone(strictDoc);
const duplicate=current(duplicateLine,unit.unit_id);
duplicate.candidate.lines.push(structuredClone(duplicate.candidate.lines.find((line:Row)=>line.id===plan.creator_conclusion_line_id)));
assert.deepEqual(creatorRegressionGaps(creatorBlueprintFacts(duplicateLine)),[],'existing declarations keep their earlier conclusion rules');
assert.deepEqual(creatorRegressionGaps(creatorBlueprintFacts(duplicateLine).map(group=>({...group,decision:'fixture-decision'})),undefined,required),
 [{code:'creator_narration_relationship_missing',id:unit.unit_id}]);
assert(creatorRegressionGaps([...hostedFacts,{...hostedFacts[0],unit_id:'extra',decision:undefined}],before)
 .some(issue=>issue.code==='creator_confirmed_group_order_changed'));
assert(creatorRegressionGaps(hostedFacts.map(group=>({...group,originalSeconds:group.originalSeconds*2})),before)
 .some(issue=>issue.code==='creator_original_expanded'));
candidate.lines.push({...candidate.lines[0],id:'overlong-copy',narration_ms:'ucapan '.repeat(110).trim()});
assert(creatorRegressionGaps(creatorBlueprintFacts(strictDoc).map(group=>({...group,decision:'fixture-decision'})),before)
 .some(issue=>issue.code==='creator_copy_expanded'));
const initialLength=candidate.lines.length;
assert(initialLength>5);
unit.coverage[0].treatment='visual_only';
unit.coverage[0].reason='视觉细节仅作支持。';
delete plan.creator_conclusion_line_id;
assert.equal(creatorBlueprintFacts(strictDoc)[0].narrated,true);
assert.equal(creatorRegressionGaps(creatorBlueprintFacts(strictDoc))[0].code,'creator_conclusion_missing');

assert.equal(creatorOpeningMetricsValid({views:'339.32k',units:'135',revenue:'RM5.31k'}),true);
assert.equal(creatorOpeningMetricsValid({views:'339,320',units:'1 235',revenue:'MYR 5,310.00'}),true);
assert.equal(creatorOpeningMetricsValid({views:'N/A',units:'135',revenue:'RM5.31k'}),false);
assert.equal(creatorOpeningMetricsValid(undefined),false);
assert(blueprintRepairStopped({status:'blocked',error:'Error: creator_quality_repair_no_progress U:opening'}));
assert(blueprintRepairStopped({status:'blocked',error:'Error: creator_opening_metrics_unconfirmed: 待核实'}));

const [snapshot,reusablePath]=process.argv.slice(2);
if(snapshot&&reusablePath){
 const saved=JSON.parse(await readFile(snapshot,'utf8')) as ProjectDoc;
 const registration=JSON.parse(await readFile(reusablePath,'utf8'));
 const reference=registration.creatorReference as CreatorConfirmedReference;
 assert.equal(revisionOf(saved),reference.revision);
 const teaching=sourceTeachingCriterion(registration.doneCriteria);
 const performance=sourcePerformanceCriterion(registration.doneCriteria);
 assert(teaching&&'guidance' in teaching&&teaching.reviewViews&&performance);
 const local=relative(runtimeProfile().rootDir,reusablePath);
 if(!isAbsolute(local)&&!local.startsWith('..')&&process.env.OPENCHATCUT_DATA_DIR){
  const source={id:'incoming-original',sourceContentHash:reference.originalSha256};
  const sales={id:'incoming-sales',sourceContentHash:reference.salesSha256};
  const inherited=await readPanelSourceRegistration('new-replay-intake',source,sales);
  assert.deepEqual(inherited?.creatorReference,reference);
  assert.equal(sourcePerformanceCriterion(inherited?.doneCriteria??[])?.source.assetId,source.id);
  assert.equal(sourcePerformanceCriterion(inherited?.doneCriteria??[])?.evidence.assetId,sales.id);
  assert.equal(await readPanelSourceRegistration('new-replay-intake',{...source,sourceContentHash:'0'.repeat(64)},sales),undefined);
  assert.equal(await readPanelSourceRegistration('new-replay-intake',source,{...sales,sourceContentHash:'1'.repeat(64)}),undefined);
 }
 const ids=reference.groups.map(group=>group.id);
 const doc=structuredClone(saved), ledger=doc.clipMentorAnalysis!.source_breakdown!;
 const answers=[
  ['先亮妆面再亮带编号双盘','一眼看出两盘怎么对编号','不知道妆面悬念如何接到可比双盘','下条先露实际妆面，再让两盘和编号同框','先吊起产品好奇，再给两盘对号的共同参照','停留看两个编号和相邻棕色格','JD-opening-pair'],
  ['分部位近拍工具与落点','一眼看到工具该落在哪里','只看动作无法跟拍关键部位','下条为每个关键落点选能辨认位置的近镜','将面部位置和工具放在同一镜，省去观众猜测','看工具接触位置及各部位短标','JD-application'],
  ['示范后侧转露出颊面','妆面和脸颊轮廓一起可见','会错过怎样交代动作之后的结果','下条等手离开脸，再保留斜侧角','无遮挡斜角让颊面可读，和开场承担不同任务','看无遮挡的颊面及轮廓','JD-finish'],
 ];
 ledger.creator_quality={opening:'据实报播放、销量和成交额，用同款问题带进实际拍法。',
  balance:'原声让达人先看实际画面，短句讲清何时保留参照、示范落点和露出结果。'};
 for(const [index,group] of ledger.units.entries()){
  const [decision,first_glance,omission_loss,next_decision,narration_why,still_focus,entry]=answers[index];
  const point=ledger.points.find(item=>item.point_id===group.coverage.find(item=>item.treatment==='explain')?.point_id)!;
  const evidence=point.teaching_basis!.evidence_ids.filter(id=>registeredEvidence(doc).has(id));
  group.teaching_selection={...group.teaching_selection!,decision,first_glance,omission_loss,
   creator_quality:{next_decision,narration_why,still_focus,confirmed_decision_id:ids[index],
    analogy:{entry,evidence_ids:evidence,application:narration_why,difference:'画面仅证明本片可见关系与实际示范。'}}};
  const own=current(doc,group.unit_id);
  own.plan.creator_conclusion_line_id=own.candidate.lines[1].id;
 }
 assert.deepEqual(creatorWorksheetGaps(doc,ids,registeredEvidence(doc)),[]);
 const oldView=requiredReviewViewIssues(planReviewBoards(shape(doc)).plans,teaching.reviewViews);
 assert.deepEqual(oldView.missing,['外颊']);
 // Add the already checked exterior cheek range only in the replay projection.
 const use=current(doc,'U-use'), line=use.candidate.lines[0];
 line.labels.unshift('Luar pipi');line.labels_zh.unshift('外颊');
 use.plan.selected_narration=structuredClone(use.candidate.lines);
 use.plan.phases.find((phase:Row)=>phase.line_id===line.id).context_source_ranges.push(
  {segment_id:'S4',source_range_seconds:[15.77,17.27],purpose:'外颊'});
 const headline=openingPerformanceHeadlines(performance.results);
 for(const entry of ledger.units){
  const own=current(doc,entry.unit_id);
  const section=own.plan.delivery_sections?.find((row:Row)=>row.kind==='performance_opening');
  if(section)section.picture.layout.headline=headline;
 }
 const visible=requiredReviewViewIssues(planReviewBoards(shape(doc)).plans,teaching.reviewViews);
 assert.deepEqual(visible,{unitIds:['U-use'],missing:[]});
 const opening=deliverySectionsFromDoc(doc).find(section=>section.kind==='performance_opening')!;
 assert.deepEqual(opening.picture.layout?.kind==='original_underlay'&&opening.picture.layout.headline,headline);
 assert(confirmedOpeningResultsMatch(opening,performance.results));
 const noViews=structuredClone(opening);
 noViews.line.narration_ms=noViews.line.narration_ms.replace(performance.results.views,'');
 assert.equal(confirmedOpeningResultsMatch(noViews,performance.results),false);
 assert.deepEqual(creatorRegressionGaps(creatorBlueprintFacts(doc),reference),[]);
 const wrongOrder=structuredClone(doc);
 const order=wrongOrder.clipMentorAnalysis!.blueprint;
 [order[0],order[1]]=[order[1],order[0]];
 assert(creatorRegressionGaps(creatorBlueprintFacts(wrongOrder),reference).some(gap=>gap.code==='creator_confirmed_group_order_changed'));
 const overflow=structuredClone(doc);
 overflow.clipMentorAnalysis!.source_breakdown!.units[1].original_source_ranges=[[0,49]];
 assert(creatorRegressionGaps(creatorBlueprintFacts(overflow),reference).some(gap=>gap.code==='creator_original_expanded'));
 const worksheet=creatorReviewWorksheet(doc,true,registeredEvidence(doc));
 const questions=(items:readonly string[])=>items.map(question=>({question,status:'ok',answer:'已核当前实拍与实句中的可学拍法。'}));
 const checked=readCreatorChecks({film:questions(creatorFilmQuestions),groups:worksheet.groups.map((group,index)=>({
  unit_id:group.unit_id,checks:questions(creatorGroupQuestions),conclusion_line_id:worksheet.copy![index].conclusion,
  analogy:{status:'ok',answer:'参考方法在当前可见范围内成立。',evidence_id:group.analogy!.evidence_ids[0]},
 }))},worksheet);
 assert.equal(checked.groups.length,3);
 assert.deepEqual(creatorReviewIssues(checked),[]);
 assert.equal(worksheet.groups.some(group=>Object.hasOwn(group.analogy!,'entry')),false);
 console.log(JSON.stringify({revision:reference.revision,groups:ids,headline,priorMissing:oldView.missing,actualViews:teaching.reviewViews.map(view=>view.labelZh),
  providerCalls,positive:'confirmed current narration plus isolated, previously checked exterior cheek and exact headline',
  rejects:['missing original exterior cheek','missing views number','wrong actual board order','overlong original','missing conclusion','overlong narration']}));
}else{
 assert(!snapshot&&!reusablePath,'Pass both a saved project and reusable declaration for the optional JUDYDOLL replay');
}
assert.equal(providerCalls,0);
console.log('Creator quality replay passed: canonical narration, required conclusions, numeric performance and bounded same-source regression.');
