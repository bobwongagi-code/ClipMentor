import type { ProjectDoc } from '../../src/editor/types';
import type { SourceBreakdown } from '../../src/clipmentor/source-breakdown';
import { breakdownPointEvidence,contiguousPlaybackRuns,originalPlaybackRanges } from '../../src/clipmentor/source-breakdown';
import { deliverySectionsFromDoc } from '../../src/clipmentor/delivery-sections';
import { readBlueprint, teachingReplayRisks } from '../../src/clipmentor/blueprint-lint';
import { teachingSelectionGaps } from '../../src/clipmentor/teaching-selection';
import teachingPurpose from '../../src/agent/skills/clipmentor/references/teaching-purpose.json';
import { currentAgentSessionGeneration } from '../../src/persist/agentSessionGeneration';
import { loadAgentRuntimeSidecar } from '../../src/persist/agentRuntimeStore';
import { createRun, flushRunPersistence } from '../agent-runs/store';
import { executeRun } from '../agent-runs/executor';
import { digestValue } from '../agent-runs/store-values';
import { authorSelfCheckReceiptText, authorSelfCheckText, selectAuthorSelfCheckReceipt } from './production-author-self-check';
import type { ProductionTask, StageContext } from './production-task';

import {frozenTeachingTopics,sourceClosingPolicy} from './production-source-policy';
export {frozenTeachingTopics} from './production-source-policy';

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
  ...(unit.teaching_selection?{teaching_selection:unit.teaching_selection}:{}),
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
 const closing=baseline?.source_closing;
 const segment=closing&&baseline.segments.find(item=>item.segment_id===closing.segment_id);
 const inventory=baseline?.segments.flatMap(segment=>segment.inventory?[segment]:[]);
 return digestValue(baseline&&{scope:baseline.review_scope,units:baseline.units.map(unit=>unitDefinition(baseline,unit)),
  ...(inventory?.length?{inventory}:{}),...(baseline.unselected_buyer_roles?{unselectedBuyerRoles:baseline.unselected_buyer_roles}:{}),
  ...(closing?{closing,segment}:{})});
}

/** Bind the evidence chosen for the confirmed teaching, while allowing later unrelated evidence. */
export function confirmedTeachingDigest(doc:ProjectDoc){
 const analysis=doc.clipMentorAnalysis;
 const baseline=analysis?.source_breakdown;
 const closing=baseline?.source_closing&&baseline.segments.find(segment=>segment.segment_id===baseline.source_closing?.segment_id);
 const pending=[...new Set([...(baseline?.points.flatMap(point=>point.teaching_basis?.evidence_ids??[])??[]),
  ...(baseline?.segments.flatMap(segment=>segment.inventory?[...segment.visible_evidence_ids,...segment.claim_evidence_ids,...segment.interpretation_evidence_ids]:[])??[]),
  ...(closing?[...closing.visible_evidence_ids,...closing.claim_evidence_ids,...closing.interpretation_evidence_ids]:[])])];
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

const teachingFeedback=(task:ProductionTask)=>task.blueprintFeedback?{text:task.blueprintFeedback,revision:task.blueprintFeedbackRevision,
 ...(task.blueprintFeedbackUnitIds?{rejectedUnitIds:task.blueprintFeedbackUnitIds}:{})}:null;
const teachingReviewContext=(task:ProductionTask)=>({purpose:teachingPurpose,task:task.input.brief,feedback:teachingFeedback(task)});

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
 const sourceClosing=sourceClosingPolicy(topics,doc);
 // The review board renders the registered teaching groups in blueprint order.
 const closingBlueprint=topics&&!sourceClosing.factOnly
  ?analysis.blueprint.findLast(entry=>baseline.units.some(unit=>unit.unit_id===entry.unit_id)):undefined;
 const closingUnit=closingBlueprint&&baseline.units.find(unit=>unit.unit_id===closingBlueprint.unit_id);
 const closingTails=topics&&closingUnit
  ?closingEvidenceSegments(baseline,closingUnit,analysis.source,topics.closingEvidenceRange):[];
 const closingSegment=topics&&closingTails.find(segment=>hasClosingNote(segment.unknowns,topics.closing));
 const reviewNarration=task.stage==='copy_review'&&task.input.panelDelivery?.editorialPolicy==='exemplar-v1';
 const selectionRationale=reviewNarration?baseline.units.flatMap(unit=>unit.coverage.flatMap(coverage=>
  coverage.reason?.trim()&&baseline.points.some(point=>point.point_id===coverage.point_id&&point.role==='primary')
   ?[{unit_id:unit.unit_id,point_id:coverage.point_id,reason:coverage.reason}]:[])):[];
 return {
  source:analysis.source, evidence, transcripts, product:analysis.product,
  ...teachingReviewContext(task),objective,requirements,sourceClosing,
  ...(task.input.sourceClosingRegistration?{sourceClosingRegistration:true as const}:{}),
  scope:baseline.review_scope, units:baseline.units.map(unit => unitDefinition(baseline,unit)),
  ...(referenceBinding?{referenceBinding}:{}),
  rebuilding:!!task.repairContext?.teaching_rebuild,
  ...(task.input.panelDelivery?.editorialPolicy==='exemplar-v1'?{pointReview:true as const,evidenceBinding:confirmedTeachingDigest(doc)}:{}),
  ...(reviewNarration?{narrationTargets:finalNarrationTargets(doc,baseline),...(selectionRationale.length?{selectionRationale}:{})}:{}),
  ...(task.input.panelDelivery?.selectionPolicy==='v1'?{selection:{
   inventory:baseline.segments.filter(segment=>segment.inventory),
   unselectedBuyerRoles:baseline.unselected_buyer_roles??{},
   gaps:teachingSelectionGaps(baseline,analysis.source.duration_seconds,analysis.source.fps),
   ...(reviewNarration?{timingRisks:teachingReplayRisks(doc)}:{}),
  }}:{}),
  ...(topics?{frozenTopics:{...topics,closingUnitId:closingUnit?.unit_id??null,closingSegmentId:closingSegment?.segment_id??null,
   misplacedClosingNote:!sourceClosing.factOnly&&!closingSegment&&baseline.segments.some(segment=>hasClosingNote(segment.unknowns,topics.closing)),
   ...(sourceClosing.factOnly&&baseline.source_closing&&baseline.source_closing.status!==topics.closingStatus
    ?{closingFactConflict:true as const}:{}),
   ...(closingSegment&&baseline.segments.some(segment=>segment!==closingSegment&&hasClosingNote(segment.unknowns,topics.closing))
    ?{duplicateClosingNote:true as const}:{}),
   closingTailSegmentIds:closingTails.map(segment=>segment.segment_id)}}:{}),
 };
}

type BaselineSource = ReturnType<typeof teachingBaselineSource>;
export function finalNarrationTargets(doc:ProjectDoc,baseline:SourceBreakdown) {
 return baseline.units.flatMap(unit=>{
  const internal=teachingUnitReview(doc,unit.unit_id);
  const candidateId=typeof internal?.current_script_candidate==='string'?internal.current_script_candidate:null;
  const candidate=candidateId?internal?.[candidateId]:undefined;
  const lines=row(candidate)&&Array.isArray(candidate.lines)?candidate.lines.filter(row):[];
  return unit.coverage.filter(c=>c.treatment==='explain').flatMap(coverage=>{
   const point=baseline.points.find(item=>item.point_id===coverage.point_id&&item.role==='primary');
   if(!point)return [];
   return [{unit_id:unit.unit_id,point_id:point.point_id,candidate_id:candidateId,lines:lines.flatMap(line=>
    typeof line.id==='string'&&typeof line.narration_ms==='string'&&Array.isArray(line.point_ids)&&line.point_ids.includes(point.point_id)
     ?[{line_id:line.id,narration:line.narration_ms}]:[])}];
  });
 });
}
export type NarrationDecision={
 unit_id:string;point_id:string;status:'ok'|'fix'|'unresolved';reason:string;
 decision?:string;viewer_basis?:string;line_id?:string;quote?:string;
 baseline_criterion?:{field:'method'|'connection'|'claim_limit';quote:string};
};
export type PublishedNarrationDecision=NarrationDecision&{source_evidence_id:string;source_quote:string};
export function boundNarrationCriterion(criterion:unknown,basis:SourceBreakdown['points'][number]['teaching_basis']):NarrationDecision['baseline_criterion']{
 if(!basis||!row(criterion)||(criterion.field!=='method'&&criterion.field!=='connection'&&criterion.field!=='claim_limit')
  ||typeof criterion.quote!=='string'||!criterion.quote.trim())return;
 const {field}=criterion;
 if(normalized(criterion.quote)===normalized(basis[field]))return {field,quote:basis[field]};
}
export function checkedNarration(value:unknown,targets:NonNullable<BaselineSource['narrationTargets']>,
 confirmedUnits?:BaselineSource['units']):NarrationDecision[]{
 const invalid=()=>Error('teaching_final_narration_receipt_invalid');
 if(!Array.isArray(value)||value.length!==targets.length)throw invalid();
 return targets.map(target=>{
  const matches=value.filter(entry=>row(entry)&&entry.unit_id===target.unit_id&&entry.point_id===target.point_id);
  const entry=matches[0];
  if(matches.length!==1||!shortText(entry.reason)||!['ok','fix','unresolved'].includes(entry.status))throw invalid();
  const result:NarrationDecision={unit_id:target.unit_id,point_id:target.point_id,status:entry.status,reason:entry.reason};
  if(confirmedUnits&&entry.status!=='ok'){
   const basis=confirmedUnits.find(unit=>unit.unit_id===target.unit_id)?.points.find(point=>point.point_id===target.point_id)?.teaching_basis;
   const criterion=boundNarrationCriterion(entry.baseline_criterion,basis);
   if(!criterion)throw Error('teaching_final_narration_baseline_criterion_invalid');
   result.baseline_criterion=criterion;
  }
  if(entry.status!=='ok'&&!entry.line_id&&!entry.quote){
   if(result.baseline_criterion?.field==='claim_limit')throw invalid();
   return result;
  }
  const line=target.lines.find(item=>item.line_id===entry.line_id);
  if(!line||!shortText(entry.quote)||!exactExcerpt(entry.quote,line.narration)
   ||(entry.status==='ok'&&(!shortText(entry.decision)||!shortText(entry.viewer_basis))))throw invalid();
  return {...result,line_id:line.line_id,quote:entry.quote,
   ...(shortText(entry.decision)?{decision:entry.decision}:{}),...(shortText(entry.viewer_basis)?{viewer_basis:entry.viewer_basis}:{})};
 });
}

function narrationReviewSubject(task:ProductionTask,targets:NonNullable<BaselineSource['narrationTargets']>,teaching:string|undefined,
 requirementsDigest:string|undefined,{purpose,task:brief,feedback}=teachingReviewContext(task),timingRisks?:ReturnType<typeof teachingReplayRisks>){
 return digestValue({targets,teaching,requirementsDigest,purpose,brief,feedback,sourceCriteria:task.input.doneCriteria,
  ...(timingRisks?{timingRisks}:{})});
}

export function panelNarrationPublication(doc:ProjectDoc,task:ProductionTask,digest:unknown,requirementsDigest:string){
 const baseline=doc.clipMentorAnalysis?.source_breakdown;
 if(!baseline||typeof digest!=='string')throw Error('human_blueprint_narration_receipt_missing');
 const targets=finalNarrationTargets(doc,baseline);
 const timingRisks=task.input.panelDelivery?.selectionPolicy==='v1'?teachingReplayRisks(doc):undefined;
 const narrationSubject=narrationReviewSubject(task,targets,confirmedTeachingDigest(doc),requirementsDigest,undefined,timingRisks);
 const receipt=Object.entries(task.effects).find(([key,effect])=>
  key.startsWith('copy_review:')&&key.endsWith(':teaching-baseline:'+digest)&&effect.kind==='model'&&effect.status==='completed'
  &&row(effect.result)&&effect.result.digest===digest&&effect.result.runId===effect.operationId
  &&effect.result.narrationSubject===narrationSubject)?.[1].result;
 if(!row(receipt)||!row(receipt.review))throw Error('human_blueprint_narration_receipt_missing');
 const reviewedUnits=receipt.review.units;
 if(!Array.isArray(reviewedUnits)||reviewedUnits.length!==baseline.units.length
  ||baseline.units.some(unit=>reviewedUnits.filter((answer:unknown)=>row(answer)&&answer.unit_id===unit.unit_id&&answer.status==='ok').length!==1)
  ||!row(receipt.review.whole_film)||receipt.review.whole_film.status!=='ok')
  throw Error('human_blueprint_teaching_not_passed');
 const answers=checkedNarration(targets.length?receipt.review.narration_checks:receipt.review.narration_checks??[],targets);
 if(answers.some(answer=>answer.status!=='ok'))throw Error('human_blueprint_narration_not_passed');
 const publishedAnswers:PublishedNarrationDecision[]=answers.map(answer=>{
  const unit=reviewedUnits.find((entry:unknown)=>row(entry)&&entry.unit_id===answer.unit_id);
  const point=Array.isArray(unit?.point_checks)?unit.point_checks.find((entry:unknown)=>row(entry)&&entry.point_id===answer.point_id):undefined;
  const pointEvidence=baseline.points.find(point=>point.point_id===answer.point_id)?.teaching_basis?.evidence_ids;
  const evidence=doc.clipMentorAnalysis!.evidence.find(entry=>entry.evidence_id===point?.source_evidence_id&&pointEvidence?.includes(entry.evidence_id));
  if(point?.status!=='ok'||!evidence||!exactExcerpt(point.source_quote,evidence.text))throw Error('human_blueprint_narration_source_unverified');
  return {...answer,source_evidence_id:evidence.evidence_id,source_quote:point.source_quote};
 });
 const selection=baseline.units.map(unit=>({
  unitId:unit.unit_id,...(unit.teaching_selection?{decision:unit.teaching_selection}:{}),
  topics:unit.coverage.filter(({treatment})=>treatment!=='omit').map(({point_id,treatment})=>{
   const point=baseline.points.find(entry=>entry.point_id===point_id);
   return {pointId:point_id,treatment,question:point?.teaching_question,method:point?.teaching_basis?.method,connection:point?.teaching_basis?.connection};
  }),
 }));
 return {independentNarrationAnswers:publishedAnswers,teachingSelectionDigest:digestValue(selection),
  teachingNarrationDigest:digestValue(targets.map(target=>[target.unit_id,target.point_id,target.lines.map(line=>line.narration)]))};
}
type PointDecision={point_id:string;status:'ok'|'fix'|'unresolved';learner_takeaway:string;connection:string;question_quote:string;
 source_evidence_id:string;source_quote:string;visual_check?:string;omission_loss?:string};
type Decision = {unit_id:string;status:'ok'|'fix'|'unresolved';source_role:string;takeaway:string;evidence_ids:string[];reason:string;point_checks?:PointDecision[]};
type FrozenTopicChecks={main_scope:'pass'|'fail';closing_status?:'pass'|'fail'};
const mainScopeIssue='主线超出任务声明的教学范围';
const closingStatusIssue='收尾处置与任务声明不符';
type WholeFilmDecision = {
 status:Decision['status'];main_point_id:string|null;focus:string;alternative:string;reason:string;
 evidence_id:string|null;source_quote:string|null;affected_unit_ids:string[];
 frozen_topic_checks?:FrozenTopicChecks;
};
type BaselineReview = {feedback_scope:'none'|'copy'|'baseline';units:Decision[];whole_film?:WholeFilmDecision;narration_checks?:NarrationDecision[]};

function repeatsTeachingAction(method:string|undefined,evidence:readonly string[],answer:string){
 return [method,...evidence].some(input=>typeof input==='string'&&sameWords(input,answer));
}

function withinTopicRange([start,end]:readonly [number,number],[from,to]:readonly [number,number]){
 return start>=from&&start<to&&end<=to;
}

function hasClosingNote(notes:readonly string[],required:string){
 // A registered decision may be followed by a separate explanatory clause.
 // A quotation, instruction or negation containing the words is not a decision.
 return notes.some(note=>{
  const text=note.trim();
  return text===required||text.startsWith(required)&&/^[；;。.!！\n]/u.test(text.slice(required.length));
 });
}

/** Separate the note's evidence anchor from continuity of the last original playback. */
function closingPlayback(windows:Array<[number,number]>,source:{duration_seconds:number;fps:number},[first,last]:readonly [number,number]){
 const playback=contiguousPlaybackRuns(windows,1e-6).at(-1);
 return playback&&playback[0]<=first&&playback[1]>=last&&playback[1]<=source.duration_seconds
  &&source.duration_seconds-playback[1]<=1/source.fps+1e-6?playback:undefined;
}

function closingEvidenceSegments(baseline:SourceBreakdown,unit:SourceBreakdown['units'][number],
 source:{duration_seconds:number;fps:number},[first,last]:readonly [number,number]){
 const playback=closingPlayback(originalPlaybackRanges(baseline,unit),source,[first,last]);
 if(!playback)return [];
 const linked=baseline.segments.filter(segment=>unit.original_segment_ids.includes(segment.segment_id))
  .sort((a,b)=>a.source_range_seconds[0]-b.source_range_seconds[0]);
 let covered=first;
 for(const {source_range_seconds:[start,end]} of linked){
  if(start>covered+1e-6)break;
  covered=Math.max(covered,end);
 }
 if(covered+1e-6<playback[1])return [];
 return linked.filter(({source_range_seconds:[start,end]})=>Math.min(end,last)-Math.max(start,first)>1e-6);
}

export function interruptedClosingPlanUnit(doc:ProjectDoc,source:BaselineSource){
 const topics=source.frozenTopics,unitId=topics?.closingUnitId;
 if(!topics||!unitId)return;
 const resolved=readBlueprint(doc).selectedPlans.find(plan=>plan.unit.unit_id===unitId)?.resolved;
 if(!resolved||resolved.legacy||resolved.issues.length)return;
 const last=resolved.phases.findLastIndex(phase=>phase.mode==='original');
 const interrupt=resolved.phases.slice(0,last).findLastIndex(phase=>phase.mode!=='original');
 // The phase resolver already verified the source ranges.
 const windows=resolved.phases.slice(interrupt+1,last+1).map(phase=>(phase.source_range_seconds??phase.source_seconds) as [number,number]);
 if(!closingPlayback(windows,source.source,topics.closingEvidenceRange))return unitId;
}

function frozenTopicReview(source:BaselineSource){
 const topics=source.frozenTopics;
 if(!topics)return;
 const mainPointIds=new Set<string>();
 const coveredWindows=new Set<number>();
 const issues=new Set<string>();
 for(const unit of source.units){
  for(const point of unit.points){
   const treatment=unit.coverage.find(entry=>entry.point_id===point.point_id)?.treatment;
   if(!treatment||treatment==='omit')continue;
   const selected=source.evidence.filter(entry=>point.teaching_basis?.evidence_ids.includes(entry.id));
   const visible=selected.filter(entry=>entry.kind==='visible_action');
   if(selected.some(({range:[start,end]})=>topics.backgroundRanges.some(range=>
    withinTopicRange([start,end],range)||start<range[1]&&range[0]<end)))
    issues.add(`${point.point_id} 该来源仅限任务声明的背景用途`);
   if(point.role!=='primary'||(treatment!=='explain'&&treatment!=='visual_only'))continue;
   topics.mainRanges.forEach((range,index)=>{
    if(visible.some(entry=>withinTopicRange(entry.range,range))){
     coveredWindows.add(index);
     mainPointIds.add(point.point_id);
    }
   });
  }
 }
 if(coveredWindows.size!==topics.mainRanges.length)issues.add('主线须覆盖任务声明的全部主要证据窗口');
 if(source.sourceClosing.factOnly){
  if(topics.closingFactConflict)issues.add('source_closing_status_changed 收尾分类与任务声明的弱促单事实不符');
 }else if(!topics.closingTailSegmentIds.length)issues.add('最后一个教学组的原片回放须覆盖已登记的收尾证据并到达片尾');
 else if(topics.misplacedClosingNote)issues.add('source_closing_note_binding_changed 收尾注记须绑定实际收尾段');
 else if(!topics.closingSegmentId)issues.add('收尾须登记：'+topics.closing);
 else if(topics.duplicateClosingNote)issues.add('source_closing_note_duplicate 收尾待核注记只保留在证据段 '+topics.closingSegmentId+'，保留原片播放和教学点');
 return {mainPointIds,issues:[...issues]};
}

export function teachingPointGaps(source:BaselineSource,doc:ProjectDoc){
 if(!source.pointReview)return [];
 const breakdown=doc.clipMentorAnalysis!.source_breakdown!;
 if(source.sourceClosingRegistration&&!source.frozenTopics&&!source.sourceClosing.decision)
  return ['原片收尾未登记。请在选题基线 source_closing 绑定实际片尾，分清已确认促单、待核线索和无促单。'];
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
 const {referenceBinding:_reference,evidenceBinding:_evidence,narrationTargets,...input}=source;
 const material=narrationTargets?.length?{narrationTargets,...input}:input;
 return input.pointReview?{...material,units:input.units.map(unit=>({...unit,points:unit.points.map(pointForIndependentReview)}))}:material;
}

function readFrozenTopicChecks(value:unknown,reviewClosing:boolean):FrozenTopicChecks {
 if(!row(value)||(value.main_scope!=='pass'&&value.main_scope!=='fail'))throw Error('teaching_frozen_topic_verdict_invalid');
 if(!reviewClosing)return {main_scope:value.main_scope};
 if(value.closing_status!=='pass'&&value.closing_status!=='fail')throw Error('teaching_frozen_topic_verdict_invalid');
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
 const checks=frozen||source.sourceClosingRegistration?readFrozenTopicChecks(value.frozen_topic_checks,!source.sourceClosing.factOnly):undefined;
 const result:WholeFilmDecision={status,main_point_id:main?.point_id??null,focus,alternative,reason,evidence_id:evidence?.id??null,
  source_quote:typeof source_quote==='string'?source_quote:null,affected_unit_ids,...(checks?{frozen_topic_checks:checks}:{})};
 if(status!=='ok'||!checks)return result;
 const affected=new Set<string>();
 if(checks.main_scope==='fail'&&mainUnit)affected.add(mainUnit.unit_id);
 if(checks.closing_status==='fail'){
  const closingUnit=source.frozenTopics?.closingUnitId??source.units.at(-1)?.unit_id;
  if(closingUnit)affected.add(closingUnit);
 }
 return affected.size?{...result,status:'fix',affected_unit_ids:[...affected]}:result;
}

export function wholeFilmIssue(whole:WholeFilmDecision|undefined){
 if(!whole||whole.status==='ok')return;
 const issues=[];
 if(whole.frozen_topic_checks?.main_scope==='fail')issues.push(mainScopeIssue);
 if(whole.frozen_topic_checks?.closing_status==='fail')issues.push(closingStatusIssue);
 return issues.length?issues.join('。'):whole.reason;
}

export function validateTeachingBaselineReview(value: unknown, source: BaselineSource, requireNarrationCriterion=true): BaselineReview {
 const invalid = () => Error('teaching_baseline_review_invalid');
 if (!row(value) || !Array.isArray(value.units) || value.units.length !== source.units.length) throw invalid();
 const hasFeedback=!!source.feedback;
 let requiresBaseline=false;
 if(hasFeedback){
  if(Object.hasOwn(value,'feedback_requires_baseline')){
   if(typeof value.feedback_requires_baseline!=='boolean')throw invalid();
   requiresBaseline=value.feedback_requires_baseline;
  }else{
   // Read completed reviews produced before the host owned feedback_scope.
   if(value.feedback_scope!=='copy'&&value.feedback_scope!=='baseline')throw invalid();
   requiresBaseline=value.feedback_scope==='baseline';
  }
 }
 const decisions = value.units;
 const whole_film=source.pointReview?readWholeFilmDecision(value.whole_film,source):undefined;
 const wholeFilmResult={...(whole_film?{whole_film}:{}),...(source.narrationTargets?.length
  ?{narration_checks:checkedNarration(value.narration_checks,source.narrationTargets,requireNarrationCriterion?source.units:undefined)}:{})};
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
  // At final narration review, a bare group verdict cannot turn a new
  // narration demand into a baseline repair. Whole-film findings stay separate.
  if(requireNarrationCriterion&&source.narrationTargets?.length&&status!=='ok'&&!issue)
   throw Error('teaching_final_narration_unit_finding_unbound');
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
 const hasBaselineIssue=(whole_film&&whole_film.status!=='ok')||units.some(unit=>unit.status!=='ok');
 if (requiresBaseline && !source.rebuilding && !hasBaselineIssue){
  if(wholeFilmResult.narration_checks?.some(check=>check.status!=='ok'))
   return {feedback_scope:'copy',units,...wholeFilmResult};
  throw invalid();
 }
 const feedback_scope=!hasFeedback?'none':hasBaselineIssue||source.rebuilding?'baseline':'copy';
 return {feedback_scope,units,...wholeFilmResult};
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
 return digestValue({points,coverage:unit.coverage,handoffs:unit.handoffs,original:unit.source_ranges,explanation:unit.explanation_segments,
  ...(unit.teaching_selection?{teachingSelection:unit.teaching_selection}:{})});
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
 const unselected=source.selection?.unselectedBuyerRoles;
 const topics=source.frozenTopics;
 if(!topics||source.sourceClosing.factOnly)return digestValue(unselected?{selection,unselected}:selection);
 const closing=source.units.find(unit=>unit.unit_id===topics.closingUnitId);
 const endingNotes=closing?.segments.filter(segment=>topics.closingTailSegmentIds.includes(segment.id)).map(segment=>({
  range:segment.range,unknowns:[...new Set(segment.unknowns.map(normalized))].sort(),
 }));
 return digestValue({selection,closing:closing?.unit_id,endingNotes,...(unselected?{unselected}:{})});
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

const reviewInstructions = (opening:string,feedbackInstructions:string,feedbackOutput:string) => `${opening}先从任务要求、按原片时间排列的动作与原话候选判断原作者在做什么，再看 units 的作者基线。逐组判：是否保留了该段承担的原片功能、观众想判断的具体问题、原作者让这个信息可见或可听的手法、拿掉本组后达人会少学的做法。动作顺序、泛泛形容或作者备注不够。开场与衔接可承担核心任务，按本片证据判断，不套固定顺序或组数。机器听写与画面只支持各自能确认的关系；不据此证明成交、配方功效或人群适用，也不要求把资料所有卖点写进片。未知不影响当前有依据的选题时，保留该边界。引用必须是本组可回读的 source evidence ID，不能把听写当人工听审。${feedbackInstructions}
按 sourceClosing 核对原片收尾与选题处置。
仅输出 JSON {${feedbackOutput}units:[{unit_id,status:"ok"|"fix"|"unresolved",source_role,takeaway,evidence_ids:[...],reason}]}。每组恰好一条，ok 必须引用证据。禁止改稿或调用工具。`;

const pointInstructions=' 每组再填 point_checks，每个 point_id 恰好一条 {point_id,status,learner_takeaway,connection,question_quote,source_evidence_id,source_quote}。question_quote 逐字引本点问题；source_quote 逐字引本点登记的原话或可见动作，缺可靠证据时标 unresolved。用本点原片证据核对作者的卖点、买家顾虑和拍法。按 purpose 作答。learner_takeaway 写达人拍同类内容时会改的具体决定，connection 写原作者的这个选择让观众多得到哪一项判断依据。只说能看到、能比较、能认出，没说明具体依据时同样判 fix。选题或答案只复述动作时，即使换了词或问题带「为什么」，也判 fix。只列功能、混淆原片促单与达人CTA、照搬别片形式同样判 fix。机器听写按来源核，只支持原作者说法，画面独立判断。若 visual_only，另填 visual_check、omission_loss 并引用可见动作，解释画面怎样承载及撤掉讲解会损失什么。';
const wholeFilmInstructions=' 在逐组判断前，从全片原话候选和画面证据独立找最有解释力的教学主线及一个合理备选。比较两条主线各自会让达人改哪个决定，说明为何选这条、放弃备选会少教什么，以及前后各组怎样服务主线。核对有无漏掉会改变买家判断的内容。不要把多段相似演示当多个购买理由，也不要因为强证据更容易截图就让辅助点变主线。另在同一 JSON 增加 whole_film:{status,main_point_id,focus,alternative,reason,evidence_id,source_quote,affected_unit_ids}。各项简洁具体。ok 时 main_point_id 是实际承载主线的主讲重点，evidence_id 属于该点，affected_unit_ids 为空。整片重点选错、排序影响理解或有重要遗漏，即使各组单独成立也标 fix，引用能说明问题的全片原证据，可来自未选中的段落。证据决定当前关键结论却无法核清，标 unresolved；仅当无可引用证据时 evidence_id 和 source_quote 均填 null。fix 或 unresolved 要列出受影响的现行组 ID，主线未成立时 main_point_id 可为 null。';
function baselineInstructions(source:BaselineSource,legacyReceipt=false,requireNarrationCriterion=true){
 const feedbackInstructions=legacyReceipt
  ?'若有 feedback 原话，区分仅改措辞/版式与选题、功能或购买理由错误；后者标 baseline。首次收到要求改变选题的意见（rebuilding=false）时列出需重做的组；已经重选点（rebuilding=true）才核对各组是否兑现。原话中还有其他要求时一并保留，勿改写用户范围。'
  :source.feedback?'按 feedback 原话判断是否必须重做选题、功能或购买理由；须重做时将 feedback_requires_baseline 填 true，并列出有原片依据的退回项。仅改措辞或版式填 false。rebuilding=true 时核对已重选的教学能否兑现意见；保留其中其他要求。':'';
 const feedbackOutput=legacyReceipt?'feedback_scope:"none"|"copy"|"baseline",':source.feedback?'feedback_requires_baseline:true|false,':'';
 const opening=source.narrationTargets?.length
  ?'先独立阅读输入首部的 narrationTargets，判断实际口播能教达人改变哪个拍摄决定。再核对选题与原片依据。'
  :'只读核验教学选题，不审稿。';

 return reviewInstructions(opening,feedbackInstructions,feedbackOutput)+(source.pointReview?wholeFilmInstructions+(source.sourceClosing.factOnly?'':'收尾处置与 sourceClosing 不一致判 fix，证据决定结论且无法核清则判 unresolved。')+pointInstructions:'')
 +(source.sourceClosing.factOnly?' 任务声明已记录原片弱促单事实。whole_film.frozen_topic_checks 只填 {main_scope:"pass"|"fail"}。如实登记已完成，缺少重复注记、回放或讲解时仍按教学内容作答。核对实际稿件和证据；主线越界，或把弱促单改判、升格为教学或补写推荐时，main_scope 判 fail，并指出当前内容和依据。'
 :source.frozenTopics?' frozenTopics 是本片已确认的选题范围。无论总评如何，whole_film 须填 frozen_topic_checks:{main_scope:"pass"|"fail",closing_status:"pass"|"fail"}。main_scope 核对实际提交的标题、问题、讲解任务和证据。超出 frozenTopics.main 或将 frozenTopics.background 当成教学依据时判 fail。closing_status 按 sourceClosing 核对已核定的档位、处置及注记位置。处置或注记不符时判 fail。总评在 reason 中说明具体问题。'
 :source.sourceClosingRegistration?' whole_film 必须含 frozen_topic_checks:{main_scope:"pass",closing_status:"pass"|"fail"}。main_scope 由原有整片评审负责。closing_status 复核 sourceClosing 的档位、原片依据和实际处置。':'')
 +(source.selection?' 先从全片证据独立判断哪里支持想试、比较或跟着操作，再核对教学选点。盘点和选组文字是待核陈述。selection.gaps、角色和备选都是审阅提示，依据是实际选点、原片和稿件。仅有一层、缺备选或资料填写不全时，沿用现行判据。若确实漏掉会改变买家判断的内容，或两组实质重复，引用原片并说明损失。合组核对真实先后，每句引用本句供给的一个或多个实际窗口。把推断的动机、观众反应或功效当事实时，基线写进 point_checks 的 fix，口播写进 narration_checks 的 fix 并引用该句。编辑实看时点是回看线索。仅在当前结论依赖无法核实的证据时判 unresolved。selection.timingRisks 是逐句估计。若缺处置，引用相关句并指出待实测的声画风险。估算、单纯短窗或处置字段缺失不决定通过状态。':'')
 +(source.narrationTargets?.length?' 按同一个 purpose 审现行口播。顶层另填 narration_checks，每个 narrationTargets 项恰好一条 {unit_id,point_id,status,reason,decision?,viewer_basis?,line_id?,quote?}。先只读马来语实际口播，答达人下条片能改变哪个具体拍摄决定，并逐字引用能让他领会该决定的某句。再对照原片依据、本点选题和已登记的选题取舍 selectionRationale（如有），看口播是否传递了为什么这样拍、买家因此多了什么判断依据。证据准确但只能复述画面、能看到或能比较，仍判 fix；基线里有取舍而口播没交代时，理由写明“基线有、口播没有”及丢失的内容。该缺口只登记在 narration_checks。标题、字幕、画面说明、基线本身和作者自答不能补分。status=ok 必须给具体 decision、viewer_basis（观众多得到的判断依据）、真实 line_id 和逐字 quote。引文要实际支撑决定和判断依据。缺口写 fix，无法判断写 unresolved，均不得依赖总评通过。'
  +(requireNarrationCriterion?' 每条 fix 或 unresolved 必须另填 baseline_criterion:{field:"method"|"connection"|"claim_limit",quote:当前组当前点 teaching_basis 对应字段的完整原文}。reason 写明引用的判据和现行口播在哪一点不符。只按已经核定的判断和边界裁决。想加的细节或新标准仅作审阅建议，不能用来退回。必须拍到的内容不因此变成必须逐项念到的内容。引用 claim_limit 时，还须给出现行口播中受该边界影响的 line_id 和逐字 quote。实质漏讲而没有可引句子时，说明缺失的内容。逐组基线退回须有对应的 point_checks 问题，口播问题留在 narration_checks。':''):'');
}

export function teachingBaselineDigest(source:BaselineSource,legacyReceipt=false,requireNarrationCriterion=true) {
 return digestValue({source,instructions:baselineInstructions(source,legacyReceipt,requireNarrationCriterion)});
}

export async function checkTeachingBaseline(task:ProductionTask,stage:StageContext,source:BaselineSource,requirementsDigest?:string) {
 const narrationSubject=source.narrationTargets?narrationReviewSubject(task,source.narrationTargets,source.evidenceBinding,requirementsDigest,source,source.selection?.timingRisks):undefined;
 const reviewDigest=(baselineDigest:string)=>narrationSubject?digestValue({baselineDigest,narrationSubject}):baselineDigest;
 const currentDigest=reviewDigest(teachingBaselineDigest(source));
 const priorReviews=Object.entries(task.effects).filter(([id,effect])=>effect.kind==='model'&&id.includes(':teaching-baseline:'));
 const effectsFor=(digest:string)=>priorReviews.filter(([id])=>id.endsWith(':teaching-baseline:'+digest));
 const current={digest:currentDigest,requireCriterion:true,effects:effectsFor(currentDigest)};
 // Keep each previously submitted review on its original digest and response contract.
 const legacy=priorReviews.length?[false,true].flatMap(feedbackScope=>{
  const digest=reviewDigest(teachingBaselineDigest(source,feedbackScope,false));
  return digest===currentDigest?[]:[{digest,requireCriterion:false,effects:effectsFor(digest)}];
 }):[];
 const versions=[current,...legacy];
 const {digest,requireCriterion,effects}=versions.find(version=>version.effects.some(([,effect])=>effect.status==='completed'))
  ??versions.find(version=>version.effects.length)??current;
 const bind=(runId:string,review:BaselineReview)=>({digest,runId,review,...(narrationSubject?{narrationSubject}:{})});
 const key = 'teaching-baseline:'+digest;
 const saved = effects.find(([,effect])=>effect.status==='completed')?.[1];
 const read = (value:unknown,operationId:string) => {
  if (!row(value) || value.digest!==digest || value.runId!==operationId) throw Error('teaching_baseline_receipt_binding_mismatch');
  return validateTeachingBaselineReview(value.review,source,requireCriterion);
 };
 if (saved) return {digest,review:read(saved.result,saved.operationId)};
 if (effects.length && !stage.hasEffect?.('model',key)) throw Error('teaching_baseline_prior_attempt_unresolved');
 let runId:string|undefined;
 const result = await stage.effect('model',key,async operationId => {
  if(!requireCriterion)throw Error('teaching_baseline_prior_attempt_unresolved');
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
  return bind(operationId,validateTeachingBaselineReview(value,source,requireCriterion));
 },async operationId => {
  runId=operationId;
  const {runs}=await loadAgentRuntimeSidecar(task.projectId);
  const run=selectAuthorSelfCheckReceipt(runs,task,operationId,digest,task.createdAt,false)?.run;
  if(!run)throw Error('teaching_baseline_recovery_run_unverified');
  const {text,verified}=authorSelfCheckReceiptText(run);
  if(!verified)throw Error('teaching_baseline_recovery_text_unverified');
  return bind(operationId,validateTeachingBaselineReview(parseTeachingBaselineText(text),source,requireCriterion));
 });
 const id=runId??Object.entries(task.effects).find(([id])=>id.endsWith(':'+key))?.[1].operationId;
 if(!id)throw Error('teaching_baseline_receipt_binding_mismatch');
 return {digest,review:read(result,id)};
}

function parseTeachingBaselineText(text:string):unknown {
 try{return JSON.parse(text.trim().replace(/^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/,'$1'));}
 catch{throw Error('teaching_baseline_review_invalid');}
}
