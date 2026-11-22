import type { ProjectDoc } from '../../src/editor/types';
import type { SourceBreakdown } from '../../src/clipmentor/source-breakdown';
import { breakdownPointEvidence,originalPlaybackRanges } from '../../src/clipmentor/source-breakdown';
import { deliverySectionsFromDoc } from '../../src/clipmentor/delivery-sections';
import { readBlueprint } from '../../src/clipmentor/blueprint-lint';
import { currentAgentSessionGeneration } from '../../src/persist/agentSessionGeneration';
import { loadAgentRuntimeSidecar } from '../../src/persist/agentRuntimeStore';
import { createRun, flushRunPersistence } from '../agent-runs/store';
import { executeRun } from '../agent-runs/executor';
import { digestValue } from '../agent-runs/store-values';
import { authorSelfCheckReceiptText, authorSelfCheckText, selectAuthorSelfCheckReceipt } from './production-author-self-check';
import type { ProductionTask, StageContext } from './production-task';

export const panelTeachingPurpose = '给达人拆解原作者怎样用可观察的拍法呈现购买理由或推进理解，让达人能借鉴。不要把镜头动作清单当成教学，也不把拍法归因为成交。';

// The confirmed selection for this exact original. Other videos keep their own teaching scope.
const frozenJudydollTopics={
 main:'主线只讲盘内相对色差和刷头移开后的鼻侧色痕。保留原片双盘编号同框，鼻侧参照只说明当时的可见妆面。选色结论留空，不把上脸色痕归给某一盘。',
 background:'外颊和高光留作原片背景，不作为教学点或讲解依据。',
 closing:'无已确认促单组，仅有弱促单待核',
 mainRanges:[[7.6,9.8],[34,36.6]],
 backgroundRanges:[[43.6,45.2],[56,61.2]],
} as const;

export function frozenTeachingTopics(doc:ProjectDoc,task:ProductionTask){
 const source=doc.clipMentorAnalysis?.source;
 if(task.input.panelDelivery?.editorialPolicy==='exemplar-v1'
  &&source?.asset_id===task.input.sourceAssetId
  &&source.sourceContentHash==='567e6312bd2024655eeee499ffb1358fa081341004d71436829d9ed846aebf49'
  &&doc.assets.some(asset=>asset.id===source.asset_id&&asset.kind==='video'&&asset.sourceContentHash===source.sourceContentHash))
  return frozenJudydollTopics;
}

type Row = Record<string, unknown>;
const row = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const normalized = (value: unknown) => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ') : '';
const sameWords=(left:string,right:string)=>{
 const words=(value:string)=>normalized(value).toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
 return words(left)===words(right);
};
const shortText = (value: unknown): value is string => typeof value === 'string' && !!normalized(value) && value.length <= 500;
const exactExcerpt=(quote:unknown,source:string)=>shortText(quote)&&
 (normalized(quote).match(/[\p{L}\p{N}]/gu)?.length??0)>=4&&normalized(source).includes(normalized(quote));

function unitDefinition(breakdown: SourceBreakdown, unit: SourceBreakdown['units'][number]) {
 const pointIds = new Set(unit.coverage.map(point => point.point_id));
 const points = breakdown.points.filter(point => pointIds.has(point.point_id)).map(({change_reason:_reason,...point}) => ({
  ...point, buying_concern:normalized(point.buying_concern), teaching_question:normalized(point.teaching_question),
  filming_conditions:point.filming_conditions.map(normalized),
 }));
 const segmentIds = new Set([...unit.original_segment_ids, ...unit.explanation_segment_ids, ...points.flatMap(point => point.segment_ids)]);
 return {
  unit_id:unit.unit_id, points,
  source_ranges:originalPlaybackRanges(breakdown,unit),
  segments:breakdown.segments.filter(segment => segmentIds.has(segment.segment_id)).map(segment => ({
   id:segment.segment_id, range:segment.source_range_seconds, visible:segment.visible_evidence_ids, claims:segment.claim_evidence_ids, unknowns:segment.unknowns,
  })),
  coverage:unit.coverage.map(({reason:_reason,...coverage}) => coverage),
  explanation_segments:unit.explanation_segment_ids,
  handoffs:unit.revisits.map(({from_segment_id,to_segment_id}) => ({from_segment_id,to_segment_id})),
 };
}

function teachingUnitReview(doc:ProjectDoc,unitId:string) {
 return (doc.clipMentorAnalysis?.blueprint.find(unit=>unit.unit_id===unitId) as {internal_review?:Row}|undefined)?.internal_review;
}

function teachingCopy(candidate:unknown) {
 const lines = row(candidate) && Array.isArray(candidate.lines) ? candidate.lines.filter(row) : [];
 const spoken=normalized(lines.map(line=>line.narration_ms).join(' '));
 const labels=lines.flatMap(line=>Array.isArray(line.labels)?line.labels.map(normalized).filter(Boolean):[]);
 return {spoken,voice:digestValue(spoken),text:digestValue({voice:spoken,labels})};
}

function currentTeachingMaterial(doc: ProjectDoc, unitId: string) {
 const internal=teachingUnitReview(doc,unitId);
 const candidateId = internal?.current_script_candidate, planId = internal?.current_picture_plan;
 const candidate = typeof candidateId === 'string' ? internal?.[candidateId] : undefined;
 const plan = typeof planId === 'string' ? internal?.[planId] : undefined;
 const pictures = row(plan) && Array.isArray(plan.phases) ? plan.phases.filter(row).map(phase => ({
  mode:phase.mode, range:phase.source_range_seconds,
  context:Array.isArray(phase.context_source_ranges) ? phase.context_source_ranges.filter(row).map(context => context.source_range_seconds) : [],
 })) : [];
 return {candidateId,planId,...teachingCopy(candidate),pictures:digestValue(pictures),hasCopy:row(candidate)&&row(plan)};
}

export function retireTeachingDrafts(doc:ProjectDoc):ProjectDoc {
 const analysis=doc.clipMentorAnalysis,baseline=analysis?.source_breakdown;
 if(!analysis||!baseline)return doc;
 const active=new Set(baseline.units.map(unit=>unit.unit_id));
 const blueprint=analysis.blueprint.map(unit=>{
  if(active.has(unit.unit_id))return unit;
  const internal=(unit as {internal_review?:Row}).internal_review;
  if(!internal)return unit;
  const {current_script_candidate:_copy,current_picture_plan:_picture,...history}=internal;
  return {...unit,internal_review:history};
 });
 const next={...doc,clipMentorAnalysis:{...analysis,blueprint}};
 if(digestValue(deliverySectionsFromDoc(next))!==digestValue(deliverySectionsFromDoc(doc)))
  throw Error('teaching_regroup_must_preserve_delivery_unit');
 return next;
}

/** Prevent analysis writes through both explicit candidate tools and generic append/revise. */
export function teachingDraftPointersDigest(doc: ProjectDoc) {
 return digestValue(doc.clipMentorAnalysis?.blueprint.flatMap(unit => {
  const internal = (unit as {internal_review?:Row}).internal_review;
  const candidates=Object.fromEntries(Object.entries(internal??{}).filter(([key])=>/^(?:script_candidate_|picture_plan_|current_script_candidate$|current_picture_plan$)/u.test(key)));
  return Object.keys(candidates).length? [{unit:unit.unit_id,candidates}] : [];
 }).sort((a,b) => a.unit.localeCompare(b.unit)) ?? []);
}

export function teachingDefinitionDigest(doc:ProjectDoc) {
 const baseline=doc.clipMentorAnalysis?.source_breakdown;
 return digestValue(baseline&&{scope:baseline.review_scope,units:baseline.units.map(unit=>unitDefinition(baseline,unit))});
}

/** Bind the evidence chosen for the confirmed teaching, while allowing later unrelated evidence. */
export function confirmedTeachingDigest(doc:ProjectDoc){
 const analysis=doc.clipMentorAnalysis;
 const pending=[...new Set(analysis?.source_breakdown?.points.flatMap(point=>point.teaching_basis?.evidence_ids??[]))];
 const linked=new Set(pending),byId=new Map(analysis?.evidence.map(item=>[item.evidence_id,item]));
 for(const id of pending)for(const support of byId.get(id)?.supporting_evidence_ids??[]){
  if(!linked.has(support)){linked.add(support);pending.push(support);}
 }
 const evidence=analysis?.evidence.filter(item=>linked.has(item.evidence_id))
  .sort((a,b)=>a.evidence_id.localeCompare(b.evidence_id));
 const sources=new Set(evidence?.flatMap(item=>item.source_ids)),observationIds=new Set(evidence?.map(item=>item.observation_id));
 const observations=analysis?.observations?.filter(item=>observationIds.has(item.observation_id))
  .sort((a,b)=>a.observation_id.localeCompare(b.observation_id));
 const transcripts=analysis?.transcripts.filter(item=>sources.has(item.source_id)).sort((a,b)=>a.source_id.localeCompare(b.source_id));
 const transcription=analysis?.source_transcription;
 return digestValue({definition:teachingDefinitionDigest(doc),source:analysis?.source,evidence,
  ...(observations?.length?{observations}:{}),...(transcripts?.length?{transcripts}:{}),
  ...(transcription&&sources.has(transcription.operation_id)?{transcription}:{})});
}

export function teachingBaselineSource(doc: ProjectDoc, task: ProductionTask, requirements:readonly unknown[], objective?:string,referenceBinding?:string) {
 const analysis = doc.clipMentorAnalysis, baseline = analysis?.source_breakdown;
 if (!analysis?.source.sourceContentHash || !baseline?.units.length || baseline.review_scope?.kind !== 'full_source')
  throw Error('teaching_baseline_not_ready');
 const observations=new Map(analysis.observations?.map(observation=>[observation.observation_id,observation]));
 const byId=new Map(analysis.evidence.map(entry=>[entry.evidence_id,entry]));
 const transcriptIds=new Set(analysis.transcripts.filter(entry=>entry.words.length).map(entry=>entry.source_id));
 const imported=new Set(analysis.audit.filter(entry=>entry.action==='import_source_video_evidence'&&entry.actor.executor==='production_host').map(entry=>entry.target_id));
 const evidence = analysis.evidence.flatMap(entry => {
  if (!['visible_action','original_claim'].includes(entry.kind)||entry.call_status==='failed'
   ||entry.supporting_evidence_ids.some(id=>!byId.has(id)||byId.get(id)?.call_status==='failed')) return [];
  if(entry.observation_id||entry.observation_method==='main_agent_direct_image_read_not_independently_verified'){
   const observation=entry.observation_id?observations.get(entry.observation_id):undefined;
   if(observation?.status!=='images_returned'||observation.source_hash!==analysis.source.sourceContentHash
    ||!entry.supporting_evidence_ids.length||!entry.supporting_evidence_ids.every(id=>observation.frame_evidence_ids.includes(id)
     &&byId.get(id)?.kind==='source_frame'&&byId.get(id)?.observation_id===observation.observation_id))return [];
  }
  if(entry.observation_method==='saved_source_video_model_receipt'&&!entry.source_ids.some(id=>imported.has(id)))return [];
  if(entry.kind==='original_claim'&&entry.status==='candidate_unverified_speech'
   &&!entry.source_ids.some(id=>transcriptIds.has(id)||imported.has(id)))return [];
  const range = entry.source_range_seconds ?? (entry.time_seconds === undefined ? undefined : [entry.time_seconds,entry.time_seconds] as const);
  if (!range || range[0] < 0 || range[1] > analysis.source.duration_seconds || range[0] > range[1]) return [];
  return [{ id:entry.evidence_id, kind:entry.kind, range, text:entry.text, status:entry.status }];
 }).sort((a,b)=>a.range[0]-b.range[0]);
 // Use the complete source evidence, even if the proposed selection overlooked it.
 const transcripts = analysis.transcripts.filter(entry => entry.words.length).map(({source_id,status,words}) => ({source_id,status,words}));
 const topics=frozenTeachingTopics(doc,task);
 // The review board renders the registered teaching groups in blueprint order.
 const closingBlueprint=topics&&analysis.blueprint.findLast(entry=>baseline.units.some(unit=>unit.unit_id===entry.unit_id));
 const closingUnit=closingBlueprint&&baseline.units.find(unit=>unit.unit_id===closingBlueprint.unit_id);
 const closingSegment=topics&&baseline.segments.find(segment=>frozenEndingRange(segment.source_range_seconds)
  &&segment.unknowns.includes(topics.closing)&&closingUnit?.original_segment_ids.includes(segment.segment_id));
 return {
  source:analysis.source, evidence, transcripts, product:analysis.product,
  purpose:panelTeachingPurpose, task:task.input.brief, objective, requirements,
  scope:baseline.review_scope, units:baseline.units.map(unit => unitDefinition(baseline,unit)),
  ...(referenceBinding?{referenceBinding}:{}),
  feedback:task.blueprintFeedback ? {text:task.blueprintFeedback,revision:task.blueprintFeedbackRevision,
   ...(task.blueprintFeedbackUnitIds?{rejectedUnitIds:task.blueprintFeedbackUnitIds}:{}),
  } : null,
  rebuilding:!!task.repairContext?.teaching_rebuild,
  ...(task.input.panelDelivery?.editorialPolicy==='exemplar-v1'?{pointReview:true as const,evidenceBinding:confirmedTeachingDigest(doc)}:{}),
  ...(topics?{frozenTopics:{...topics,closingUnitId:closingUnit?.unit_id??null,closingSegmentId:closingSegment?.segment_id??null}}:{}),
 };
}

type BaselineSource = ReturnType<typeof teachingBaselineSource>;
type PointDecision={point_id:string;status:'ok'|'fix'|'unresolved';learner_takeaway:string;connection:string;question_quote:string;
 source_evidence_id:string;source_quote:string;visual_check?:string;omission_loss?:string};
type Decision = {unit_id:string;status:'ok'|'fix'|'unresolved';source_role:string;takeaway:string;evidence_ids:string[];reason:string;point_checks?:PointDecision[]};
type FrozenTopicChecks={main_scope:'pass'|'fail';closing_status:'pass'|'fail'};
const mainScopeIssue='主线超出盘内色差和鼻侧上脸参照的确认范围';
const closingStatusIssue='收尾未保持弱促单待核的判断';
type WholeFilmDecision = {
 status:Decision['status'];main_point_id:string|null;focus:string;alternative:string;reason:string;
 evidence_id:string|null;source_quote:string|null;affected_unit_ids:string[];
 frozen_topic_checks?:FrozenTopicChecks;
};
type BaselineReview = {feedback_scope:'none'|'copy'|'baseline';units:Decision[];whole_film?:WholeFilmDecision};

function repeatsTeachingAction(method:string|undefined,evidence:readonly string[],answer:string){
 return [method,...evidence].some(input=>typeof input==='string'&&sameWords(input,answer));
}

function withinTopicRange([start,end]:readonly [number,number],[from,to]:readonly [number,number]){
 return start>=from&&start<to&&end<=to;
}

function frozenEndingRange([start,end]:readonly [number,number]){
 return start>=63&&end>=67&&start<end;
}

function frozenTopicReview(source:BaselineSource){
 const topics=source.frozenTopics;
 if(!topics)return;
 const mainPointIds=new Set<string>();
 const issues=new Set<string>();
 for(const unit of source.units){
  for(const point of unit.points){
   const treatment=unit.coverage.find(entry=>entry.point_id===point.point_id)?.treatment;
   if(!treatment||treatment==='omit')continue;
   const selected=source.evidence.filter(entry=>point.teaching_basis?.evidence_ids.includes(entry.id));
   const visible=selected.filter(entry=>entry.kind==='visible_action');
   if(selected.some(({range:[start,end]})=>topics.backgroundRanges.some(range=>
    withinTopicRange([start,end],range)||start<range[1]&&range[0]<end)))
    issues.add(`${point.point_id} 外颊或高光只能作背景`);
   if(point.role==='primary'&&(treatment==='explain'||treatment==='visual_only')
    &&topics.mainRanges.every(range=>visible.some(entry=>withinTopicRange(entry.range,range)))
    &&selected.every(entry=>topics.mainRanges.some(range=>withinTopicRange(entry.range,range))))
    mainPointIds.add(point.point_id);
  }
 }
 if(!mainPointIds.size)issues.add('主线须同时引用双盘盘内色差和鼻侧上脸参照');
 if(!topics.closingSegmentId)issues.add('收尾须登记：'+topics.closing);
 return {mainPointIds,issues:[...issues]};
}

export function teachingPointGaps(source:BaselineSource,doc:ProjectDoc){
 if(!source.pointReview)return [];
 const breakdown=doc.clipMentorAnalysis!.source_breakdown!;
 const evidenceById=new Map(source.evidence.map(entry=>[entry.id,entry]));
 const points=breakdown.points.flatMap(point=>{
  const basis=point.teaching_basis,linked=breakdownPointEvidence(breakdown,point.point_id);
  const ranges=breakdown.segments.filter(segment=>point.segment_ids.includes(segment.segment_id)).map(segment=>segment.source_range_seconds);
  const covered=breakdown.units.flatMap(unit=>unit.coverage.filter(entry=>entry.point_id===point.point_id));
  if(!covered.length)return [point.point_id+' 缺少教学覆盖'];
  const selected=(basis?.evidence_ids??[]).flatMap(id=>{
   const evidence=evidenceById.get(id);
   return evidence&&linked.includes(id)&&ranges.some(([from,to])=>
    evidence.range[0]===evidence.range[1]?from<=evidence.range[0]&&evidence.range[0]<to:evidence.range[0]<to&&from<evidence.range[1])
    ?[evidence]:[];
  });
  if(!basis||selected.length!==basis.evidence_ids.length)
   return [point.point_id+' 缺教学依据或本点原片证据'];
  if(sameWords(basis.selling_point,point.buying_concern))
   return [point.point_id+' 卖点与买家顾虑重复，分别写清商品提供什么和买家要解决的问题'];
  if(repeatsTeachingAction(basis.method,selected.filter(e=>e.kind==='visible_action').map(e=>e.text),basis.connection)
   ||[basis.selling_point,point.buying_concern].some(input=>sameWords(input,basis.connection)))
   return [point.point_id+' 作用栏只重复原片动作、卖点或顾虑，缺买家的具体判断'];
  if(covered.some(entry=>entry.treatment==='visual_only'&&!normalized(entry.reason)))
   return [point.point_id+' 缺纯画面承载理由'];
  return [];
 });
 return [...points,...(frozenTopicReview(source)?.issues??[])];
}

function teachingDirectionGroups(feedback:string|undefined){
 // Only force a rewind on an affirmative rejection. The read-only verifier still reads the full feedback.
 const instruction=(feedback??'').replace(/“[^”]*”|「[^」]*」|『[^』]*』|【[^】]*】|"[^"]*"/gu,' ')
  .replace(/(不是说|没说|不认为)\s*[，,：:]\s*/gu,'$1').replaceAll('而是','；');
 const rejection=/^(?:我(?:觉得|认为)\s*)?(?:(?:这[版个]|第\s*(\d+|[一二三四五六七八九十])\s*组)\s*的?\s*)?(?:(?:教学|讲解|选题)\s*)?(?:方向\s*(?:错了|是错的)|教错了)$/u;
 return (instruction.match(/[^。！？；，,.!?;\n]+[？?]?/gu)??[]).flatMap(clause=>{
  const match=rejection.exec(clause.trim());
  if(!match)return [];
  if(!match[1])return [0];
  const number=/^\d+$/u.test(match[1])?Number(match[1]):'一二三四五六七八九十'.indexOf(match[1])+1;
  return [number>0?number:-1];
 });
}
export const rejectsTeachingDirection=(feedback:string|undefined)=>teachingDirectionGroups(feedback).length>0;

/** Resolve group numbers against the actual board's ordered picture plans while its revision is checked. */
export function bindTeachingFeedbackUnits(doc:ProjectDoc,feedback:string){
 const groups=[...new Set(teachingDirectionGroups(feedback).filter(number=>number!==0))];
 if(!groups.length)return;
 const plans=readBlueprint(doc).selectedPlans;
 const unitIds=groups.map(number=>plans[number-1]?.unit.unit_id);
 return unitIds.every((id):id is string=>typeof id==='string')?unitIds:[];
}

function reviewedPoints(value:unknown,unit:BaselineSource['units'][number],source:BaselineSource):PointDecision[]{
 if(!Array.isArray(value)||value.length!==unit.points.length)throw Error('teaching_baseline_point_review_incomplete');
 return unit.points.map(point=>{
  const entries=value.filter(entry=>row(entry)&&entry.point_id===point.point_id);
  const entry=entries[0];
  if(entries.length!==1||!['ok','fix','unresolved'].includes(entry.status)
   ||![entry.learner_takeaway,entry.connection].every(shortText)
   ||!exactExcerpt(entry.question_quote,point.teaching_question))throw Error('teaching_baseline_point_quote_invalid');
  const evidence=source.evidence.find(item=>item.id===entry.source_evidence_id&&point.teaching_basis?.evidence_ids.includes(item.id));
  if(entry.status==='ok'||entry.source_evidence_id||entry.source_quote){
   if(!evidence||!exactExcerpt(entry.source_quote,evidence.text))
    throw Error('teaching_baseline_point_source_quote_invalid');
  }
  if(entry.status==='ok'&&unit.coverage.some(coverage=>coverage.point_id===point.point_id&&coverage.treatment==='visual_only')
   &&(evidence?.kind!=='visible_action'||!shortText(entry.visual_check)||!shortText(entry.omission_loss)))
    throw Error('teaching_baseline_visual_only_incomplete');
  const answer=entry as PointDecision;
  if(answer.status==='ok'&&evidence&&repeatsTeachingAction(point.teaching_basis?.method,
   evidence.kind==='visible_action'?[answer.source_quote,evidence.text]:[],answer.connection))
   return {...answer,status:'fix',connection:'审核回答只重复原片动作，缺买家的具体判断。'};
  return answer;
 });
}

function pointForIndependentReview(point:BaselineSource['units'][number]['points'][number]){
 if(!point.teaching_basis)return point;
 const {exemplar:_exemplar,difference:_difference,...basis}=point.teaching_basis;
 return {...point,teaching_basis:basis};
}

function baselineReviewInput(source:BaselineSource){
 const {referenceBinding:_reference,evidenceBinding:_evidence,...input}=source;
 return input.pointReview?{...input,units:input.units.map(unit=>({...unit,points:unit.points.map(pointForIndependentReview)}))}:input;
}

function readFrozenTopicChecks(value:unknown):FrozenTopicChecks {
 if(!row(value)||(value.main_scope!=='pass'&&value.main_scope!=='fail')
  ||(value.closing_status!=='pass'&&value.closing_status!=='fail'))throw Error('teaching_frozen_topic_verdict_invalid');
 return {main_scope:value.main_scope,closing_status:value.closing_status};
}

function readWholeFilmDecision(value:unknown,source:BaselineSource):WholeFilmDecision {
 const invalid=()=>Error('teaching_whole_film_review_invalid');
 const judgment=(text:unknown):text is string=>shortText(text)&&(text.match(/[\p{L}\p{N}]/gu)?.length??0)>=4;
 if(!row(value)||(value.status!=='ok'&&value.status!=='fix'&&value.status!=='unresolved')
  ||!judgment(value.focus)||!judgment(value.alternative)||!judgment(value.reason)
  ||sameWords(value.focus,value.alternative)||sameWords(value.focus,value.reason)||sameWords(value.alternative,value.reason)
  ||!Array.isArray(value.affected_unit_ids)||new Set(value.affected_unit_ids).size!==value.affected_unit_ids.length
  ||!value.affected_unit_ids.every(id=>source.units.some(unit=>unit.unit_id===id)))throw invalid();
 const {status,main_point_id,focus,alternative,reason,evidence_id,source_quote,affected_unit_ids}=value;
 if((status==='ok')!==(affected_unit_ids.length===0))throw invalid();
 const mainUnit=source.units.find(unit=>unit.points.some(point=>point.point_id===main_point_id&&point.role==='primary')
  &&unit.coverage.some(coverage=>coverage.point_id===main_point_id&&['explain','visual_only'].includes(coverage.treatment)));
 const main=mainUnit?.points.find(point=>point.point_id===main_point_id);
 if((main_point_id!==null||status==='ok')&&!main)throw invalid();
 const frozen=frozenTopicReview(source);
 if(status==='ok'&&frozen&&(frozen.issues.length||!main||!frozen.mainPointIds.has(main.point_id)))
  throw Error('teaching_frozen_topic_scope_invalid');
 const evidence=source.evidence.find(entry=>entry.id===evidence_id);
 if(status!=='unresolved'||evidence_id!==null||source_quote!==null){
  if(!evidence||!exactExcerpt(source_quote,evidence.text))throw invalid();
  if(status==='ok'&&!main?.teaching_basis?.evidence_ids.includes(evidence.id))throw invalid();
 }
 const checks=frozen?readFrozenTopicChecks(value.frozen_topic_checks):undefined;
 const result:WholeFilmDecision={status,main_point_id:main?.point_id??null,focus,alternative,reason,evidence_id:evidence?.id??null,
  source_quote:typeof source_quote==='string'?source_quote:null,affected_unit_ids,...(checks?{frozen_topic_checks:checks}:{})};
 if(status!=='ok'||!checks)return result;
 const affected=new Set<string>();
 if(checks.main_scope==='fail'&&mainUnit)affected.add(mainUnit.unit_id);
 if(checks.closing_status==='fail'&&source.frozenTopics?.closingUnitId)affected.add(source.frozenTopics.closingUnitId);
 return affected.size?{...result,status:'fix',affected_unit_ids:[...affected]}:result;
}

export function wholeFilmIssue(whole:WholeFilmDecision|undefined){
 if(!whole||whole.status==='ok')return;
 const issues=[];
 if(whole.frozen_topic_checks?.main_scope==='fail')issues.push(mainScopeIssue);
 if(whole.frozen_topic_checks?.closing_status==='fail')issues.push(closingStatusIssue);
 return issues.length?issues.join('。'):whole.reason;
}

export function validateTeachingBaselineReview(value: unknown, source: BaselineSource): BaselineReview {
 const invalid = () => Error('teaching_baseline_review_invalid');
 if (!row(value) || !Array.isArray(value.units) || value.units.length !== source.units.length
  || (source.feedback ? value.feedback_scope!=='copy'&&value.feedback_scope!=='baseline' : value.feedback_scope !== 'none')) throw invalid();
 const decisions = value.units;
 const whole_film=source.pointReview?readWholeFilmDecision(value.whole_film,source):undefined;
 const wholeFilmResult=whole_film?{whole_film}:{};
 const units = source.units.map(unit => {
  const matches = decisions.filter(entry => row(entry) && entry.unit_id === unit.unit_id);
  const entry = matches[0];
  if (matches.length !== 1 || !['ok','fix','unresolved'].includes(entry.status) || ![entry.source_role,entry.takeaway,entry.reason].every(shortText)
   || !Array.isArray(entry.evidence_ids) || entry.evidence_ids.length > 8 || new Set(entry.evidence_ids).size !== entry.evidence_ids.length) throw invalid();
  const ranges = unit.source_ranges;
  const overlaps = (start:number,end:number) => ranges.some(([a,b]) => start === end ? a <= start && start < b : start < b && a < end);
  if (!entry.evidence_ids.every((id:unknown) => source.evidence.some(evidence => evidence.id === id && overlaps(...evidence.range)))) throw invalid();
  if (entry.status === 'ok' && (!entry.evidence_ids.length || !unit.points.some(point => point.role === 'primary'
   && unit.coverage.some(coverage => coverage.point_id === point.point_id && ['explain','visual_only'].includes(coverage.treatment))))) throw invalid();
  const {unit_id,status,source_role,takeaway,evidence_ids,reason} = entry;
  const points=source.pointReview?reviewedPoints(entry.point_checks,unit,source):undefined;
  const issue=points?.find(point=>point.status==='fix')??points?.find(point=>point.status==='unresolved');
  return {unit_id,status:issue?.status==='fix'?'fix':status==='ok'?issue?.status??'ok':status,source_role,takeaway,evidence_ids,
   reason:issue?`${issue.point_id} ${issue.connection}`:reason,
   ...(points?{point_checks:points}:{})} as Decision;
 });
 if(source.pointReview&&!source.rebuilding){
  const groups=teachingDirectionGroups(source.feedback?.text);
  if(groups.length){
   const targets=source.feedback?.rejectedUnitIds??[];
   const forceAll=groups.includes(0)&&units.every(unit=>unit.status==='ok');
   const rejected=units.map(unit=>unit.status==='ok'&&(forceAll||targets.includes(unit.unit_id))
    ?{...unit,status:'fix' as const,reason:'用户已明确退回教学方向，须重做选题基线。'}:unit);
   const invalidBinding=!groups.includes(0)&&source.feedback?.rejectedUnitIds!==undefined
    &&(!targets.length||targets.some(id=>!units.some(unit=>unit.unit_id===id)));
   if(invalidBinding||rejected.every(unit=>unit.status==='ok'))throw Error('teaching_baseline_feedback_scope_unresolved');
   return {feedback_scope:'baseline',units:rejected,...wholeFilmResult};
  }
 }
 if (value.feedback_scope==='baseline' && !source.rebuilding && (!whole_film||whole_film.status==='ok')&&units.every(unit=>unit.status==='ok')) throw invalid();
 return {feedback_scope:source.feedback&&whole_film&&whole_film.status!=='ok'?'baseline':value.feedback_scope as BaselineReview['feedback_scope'],
  units,...wholeFilmResult};
}

type PriorTeachingMaterial=Omit<ReturnType<typeof currentTeachingMaterial>,'spoken'|'voice'>&{voice?:string};
export type TeachingRebuild = {
 rejected:Array<{unitId:string;pointIds:string[];definition:string;evidence:string;status:Decision['status'];reason:string}>;
 affected:Array<{unitId:string;pointIds:string[]}>;
 prior:Record<string,PriorTeachingMaterial>;
 definitions:Record<string,string>;
 wholeFilm?:{definition:string;evidenceId:string|null;evidence:string;status:'fix'|'unresolved';reason:string;unitIds:string[]};
};

function teachingMeaning(unit:BaselineSource['units'][number]) {
 const points=unit.points.map(input=>{
  const point=pointForIndependentReview(input);
  if(!point.teaching_basis)return point;
  const {evidence_ids:_ids,...basis}=point.teaching_basis;
  return {...point,filming_conditions:[],teaching_basis:basis};
 });
 return digestValue({points,coverage:unit.coverage,handoffs:unit.handoffs,original:unit.source_ranges,explanation:unit.explanation_segments});
}

function evidenceDigest(source:BaselineSource,unit:BaselineSource['units'][number]) {
 const overlaps=(start:number,end:number)=>unit.source_ranges.some(([a,b])=>start===end?a<=start&&start<b:start<b&&a<end);
 const evidence=source.evidence.filter(entry=>overlaps(...entry.range)).map(({kind,range,text})=>digestValue({kind,range,text:normalized(text)}));
 const transcripts=source.transcripts.flatMap(transcript=>transcript.words.filter(word=>overlaps(word.start_seconds,word.end_seconds))
  .map(({start_seconds,end_seconds,text})=>digestValue({start_seconds,end_seconds,text:normalized(text)})));
 return digestValue({evidence:[...new Set(evidence)].sort(),transcripts:[...new Set(transcripts)].sort()});
}

function wholeTeachingMeaning(source:BaselineSource) {
 const selection=source.units.map(unit=>[unit.unit_id,teachingMeaning(unit)]);
 if(!source.frozenTopics)return digestValue(selection);
 const closing=source.units.find(unit=>unit.unit_id===source.frozenTopics?.closingUnitId);
 const endingNotes=closing?.segments.filter(segment=>frozenEndingRange(segment.range)).map(segment=>({
  range:segment.range,unknowns:[...new Set(segment.unknowns.map(normalized))].sort(),
 }));
 return digestValue({selection,closing:closing?.unit_id,endingNotes});
}

function wholeTeachingEvidence(source:BaselineSource) {
 const evidence=source.evidence.map(({kind,range,text,status})=>digestValue({kind,range,text:normalized(text),status}));
 const transcripts=source.transcripts.flatMap(transcript=>transcript.words.map(({start_seconds,end_seconds,text})=>
  digestValue({start_seconds,end_seconds,text:normalized(text),status:transcript.status})));
 return digestValue({evidence:[...new Set(evidence)].sort(),transcripts:[...new Set(transcripts)].sort()});
}

export function unchangedWholeFilmTeaching(source:BaselineSource,rebuild:TeachingRebuild) {
 const finding=rebuild.wholeFilm;
 return !!finding&&finding.definition===wholeTeachingMeaning(source)
  &&(finding.status==='fix'||finding.evidence===wholeTeachingEvidence(source));
}

export function teachingRebuild(source: BaselineSource, doc: ProjectDoc, review: BaselineReview, previous?:TeachingRebuild):TeachingRebuild {
 const rejected=review.units.filter(decision => decision.status !== 'ok').map(decision => {
  const unit=source.units.find(item=>item.unit_id===decision.unit_id)!;
  return {unitId:unit.unit_id,pointIds:unit.points.map(point=>point.point_id),definition:teachingMeaning(unit),evidence:evidenceDigest(source,unit),status:decision.status,reason:decision.reason};
 });
 const whole=review.whole_film;
 const wholeFilm:TeachingRebuild['wholeFilm']=whole&&whole.status!=='ok'?{
  definition:wholeTeachingMeaning(source),evidenceId:whole.evidence_id,evidence:wholeTeachingEvidence(source),
  status:whole.status,reason:wholeFilmIssue(whole)??whole.reason,unitIds:whole.affected_unit_ids,
 }:whole?undefined:previous?.wholeFilm;
 return {
  prior:previous?.prior ?? Object.fromEntries(source.units.map(unit => {
   const {spoken:_spoken,...prior}=currentTeachingMaterial(doc,unit.unit_id);
   return [unit.unit_id,prior];
  })),
  definitions:previous?.definitions ?? Object.fromEntries(source.units.map(unit=>[unit.unit_id,teachingMeaning(unit)])),
  rejected, affected:[...new Map([...(previous?.affected??[]),...rejected].map(unit=>[unit.unitId,{unitId:unit.unitId,pointIds:unit.pointIds}])).values()],
  ...(wholeFilm?{wholeFilm}:{}),
 };
}

export function newlyChangedTeaching(before:BaselineSource,after:BaselineSource,doc:ProjectDoc,previous?:TeachingRebuild) {
 const changed=before.units.filter(unit=>!after.units.some(next=>teachingMeaning(unit)===teachingMeaning(next)&&next.unit_id===unit.unit_id));
 if(!changed.length)return previous;
 const findings:BaselineReview={feedback_scope:'none',units:changed.map(unit=>({unit_id:unit.unit_id,status:'unresolved',
  evidence_ids:[],reason:'Teaching definition changed.',source_role:'',takeaway:''}))};
 const next=teachingRebuild(before,doc,findings,previous);
 return {...next,rejected:previous?.rejected??[]};
}

function affectedTeachingUnit(unit:BaselineSource['units'][number],entry:TeachingRebuild['affected'][number]) {
 return unit.unit_id===entry.unitId||unit.points.some(point=>entry.pointIds.includes(point.point_id));
}

export function unchangedRejectedTeaching(source:BaselineSource, rebuild:TeachingRebuild) {
 return rebuild.rejected.filter(rejected => {
  const units=source.units.filter(unit=>affectedTeachingUnit(unit,rejected));
  return !units.length||units.some(unit=>teachingMeaning(unit)===rejected.definition
   &&(rejected.status==='fix'||evidenceDigest(source,unit)===rejected.evidence));
 });
}

export function staleRebuiltTeaching(source:BaselineSource, doc:ProjectDoc, rebuild:TeachingRebuild) {
 const current=new Map(source.units.map(unit=>[unit.unit_id,currentTeachingMaterial(doc,unit.unit_id)]));
 const byPredecessor=new Map(rebuild.affected.map(entry=>[entry.unitId,
  source.units.filter(unit=>affectedTeachingUnit(unit,entry)).map(unit=>current.get(unit.unit_id)!.spoken).filter(Boolean).join(' ')]));
 const containsCopy=(spoken:string,prior:string)=>prior ? (' '+spoken+' ').includes(' '+prior+' ') : !spoken;
 return source.units.filter(unit => {
  const affected=rebuild.affected.filter(entry=>affectedTeachingUnit(unit,entry));
  if(!affected.length&&rebuild.definitions[unit.unit_id]===teachingMeaning(unit))return false;
  const now=current.get(unit.unit_id)!;
  if (!now.hasCopy) return true;
  const targets=new Set(affected.flatMap(entry=>entry.pointIds));
  const covered=unit.coverage.filter(point=>!targets.size||targets.has(point.point_id));
  const visualOnly=covered.some(point=>point.treatment==='visual_only')&&covered.every(point=>point.treatment!=='explain');
  const predecessors=new Set([unit.unit_id,...affected.map(entry=>entry.unitId)]);
  return [...predecessors].some(id=>{
   const before=rebuild.prior[id];
   if(!before?.hasCopy)return false;
   if(id===unit.unit_id&&(now.candidateId===before.candidateId||now.planId===before.planId))return true;
   if(visualOnly)return now.text===before.text&&now.pictures===before.pictures;
   // Compare with the saved script so appended copy and a split can be
   // distinguished from an actual rewrite. Older checkpoints have only text.
   const archived=typeof before.candidateId==='string'?teachingUnitReview(doc,id)?.[before.candidateId]:undefined;
   if(!row(archived))return true;
   const prior=teachingCopy(archived);
   if(prior.text!==before.text||before.voice!==undefined&&prior.voice!==before.voice)return true;
   return containsCopy(now.spoken,prior.spoken)
    ||!!prior.spoken&&containsCopy(byPredecessor.get(id)??'',prior.spoken);
  });
 }).map(unit=>unit.unit_id);
}

const instructions = `只读核验教学选题，不审稿。先从任务要求、按原片时间排列的动作与原话候选判断原作者在做什么，再看 units 的作者基线。逐组判：是否保留了该段承担的原片功能、观众想判断的具体问题、原作者让这个信息可见或可听的手法、拿掉本组后达人会少学的做法。动作顺序、泛泛形容或作者备注不够。开场与衔接可承担核心任务，按本片证据判断，不套固定顺序或组数。机器听写与画面只支持各自能确认的关系；不据此证明成交、配方功效或人群适用，也不要求把资料所有卖点写进片。未知不影响当前有依据的选题时，保留该边界。引用必须是本组可回读的 source evidence ID，不能把听写当人工听审。若有 feedback 原话，区分仅改措辞/版式与选题、功能或购买理由错误；后者标 baseline。首次收到要求改变选题的意见（rebuilding=false）时列出需重做的组；已经重选点（rebuilding=true）才核对各组是否兑现。原话中还有其他要求时一并保留，勿改写用户范围。
仅输出 JSON {feedback_scope:"none"|"copy"|"baseline",units:[{unit_id,status:"ok"|"fix"|"unresolved",source_role,takeaway,evidence_ids:[...],reason}]}。每组恰好一条，ok 必须引用证据。禁止改稿或调用工具。`;

const pointInstructions=' 每组再填 point_checks，每个 point_id 恰好一条 {point_id,status,learner_takeaway,connection,question_quote,source_evidence_id,source_quote}。question_quote 逐字引本点问题；source_quote 逐字引本点登记的原话或可见动作，缺可靠证据时标 unresolved。用本点原片证据核对作者的卖点、买家顾虑和拍法。connection 直接回答买家多了哪一项具体判断依据，选题或答案只复述动作时，即使换了词或问题带「为什么」，也判 fix。只列功能、混淆原片促单与达人CTA、照搬别片形式同样判 fix。机器听写按来源核，只支持原作者说法，画面独立判断。若 visual_only，另填 visual_check、omission_loss 并引用可见动作，解释画面怎样承载及撤掉讲解会损失什么。';
const wholeFilmInstructions=' 在逐组判断前，从全片原话候选和画面证据独立找最有解释力的教学主线及一个合理备选。比较两者会帮助买家做什么决定，前后哪些内容为主线服务，有没有一项漏掉会改变购买判断的内容。不要把多段相似演示当多个购买理由，也不要因为强证据更容易截图就让辅助点变主线。另在同一 JSON 增加 whole_film:{status,main_point_id,focus,alternative,reason,evidence_id,source_quote,affected_unit_ids}。各项简洁具体。ok 时 main_point_id 是实际承载主线的主讲重点，evidence_id 属于该点，affected_unit_ids 为空。整片重点选错、排序影响理解或有重要遗漏，即使各组单独成立也标 fix，引用能说明问题的全片原证据，可来自未选中的段落。证据决定当前关键结论却无法核清，标 unresolved；仅当无可引用证据时 evidence_id 和 source_quote 均填 null。fix 或 unresolved 要列出受影响的现行组 ID，主线未成立时 main_point_id 可为 null。保留原片实际收尾促单作为独立教学，达人邀请属于交付。';
const baselineInstructions=(source:BaselineSource)=>instructions+(source.pointReview?wholeFilmInstructions+pointInstructions:'')
 +(source.frozenTopics?' frozenTopics 是本片已确认的选题范围，优先于通用收尾要求。无论总评如何，whole_film 须填 frozen_topic_checks:{main_scope:"pass"|"fail",closing_status:"pass"|"fail"}。main_scope 核对实际提交的标题、问题、讲解任务和证据。将声称能选出具体色号、把色痕归给一盘、或把外颊和高光纳入教学判为 fail。closing_status 逐项对照观众行动指令、购买入口和与购买绑定的激励。末组源片段须有指定待核注记。把待核建议写成已确认促单或独立促单组时判 fail，即使另有待核注记。总评在 reason 中说明具体问题。':'');

export function teachingBaselineDigest(source:BaselineSource) {
 return digestValue({source,instructions:baselineInstructions(source)});
}

export async function checkTeachingBaseline(task:ProductionTask, stage:StageContext, source:BaselineSource) {
 const digest = teachingBaselineDigest(source);
 const key = 'teaching-baseline:'+digest;
 const effects = Object.entries(task.effects).filter(([id,effect]) => id.endsWith(':'+key) && effect.kind==='model');
 const saved = effects.find(([,effect])=>effect.status==='completed')?.[1];
 const read = (value:unknown,operationId:string) => {
  if (!row(value) || value.digest!==digest || value.runId!==operationId) throw Error('teaching_baseline_receipt_binding_mismatch');
  return validateTeachingBaselineReview(value.review,source);
 };
 if (saved) return {digest,review:read(saved.result,saved.operationId)};
 if (effects.length && !stage.hasEffect?.('model',key)) throw Error('teaching_baseline_prior_attempt_unresolved');
 let runId:string|undefined;
 const result = await stage.effect('model',key,async operationId => {
  runId=operationId;
  const author=task.input.author,backend=task.input.authorBackend??'api';
  const run=createRun({id:operationId,userInputDigest:digest,projectId:task.projectId,sessionGeneration:await currentAgentSessionGeneration(task.projectId),
   backend,provider:author.provider,model:author.model,askOnly:true,context:{productionTaskId:task.taskId,stage:'teaching_baseline_check'}});
  await flushRunPersistence(run);
  let attempts=0;
  await executeRun(run,{backend,provider:author.provider,model:author.model,origin:author.origin,openAiApiMode:author.apiMode,
   cacheMode:'short',maxOutputTokens:4096,autonomousAcceptance:false,maxAcceptanceIterations:1,tools:[],
   ...(backend==='codex'?{localProductionCodex:true as const}:{}),instructions:baselineInstructions(source),
   messages:[{role:'user',content:JSON.stringify(baselineReviewInput(source))}],
   host:{signal:stage.signal,maxTurns:1,deadlineAt:task.createdAt+task.input.budget.maxElapsedMs,
    async beforeRequest(){if(attempts++!==0)throw Error('teaching_baseline_single_request');},
    async execute(){throw Error('teaching_baseline_read_only');}}});
  if(run.status!=='completed')throw Error(run.error??'teaching_baseline_check_failed');
  const value=parseTeachingBaselineText(authorSelfCheckText(run.events));
  return {digest,runId:operationId,review:validateTeachingBaselineReview(value,source)};
 },async operationId => {
  runId=operationId;
  const {runs}=await loadAgentRuntimeSidecar(task.projectId);
  const run=selectAuthorSelfCheckReceipt(runs,task,operationId,digest,task.createdAt,false)?.run;
  if(!run)throw Error('teaching_baseline_recovery_run_unverified');
  const {text,verified}=authorSelfCheckReceiptText(run);
  if(!verified)throw Error('teaching_baseline_recovery_text_unverified');
  return {digest,runId:operationId,review:validateTeachingBaselineReview(parseTeachingBaselineText(text),source)};
 });
 const id=runId??Object.entries(task.effects).find(([id])=>id.endsWith(':'+key))?.[1].operationId;
 if(!id)throw Error('teaching_baseline_receipt_binding_mismatch');
 return {digest,review:read(result,id)};
}

function parseTeachingBaselineText(text:string):unknown {
 try{return JSON.parse(text.trim().replace(/^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/,'$1'));}
 catch{throw Error('teaching_baseline_review_invalid');}
}
