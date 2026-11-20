import type { ProjectDoc } from '../../src/editor/types';
import type { SourceBreakdown } from '../../src/clipmentor/source-breakdown';
import { originalPlaybackRanges } from '../../src/clipmentor/source-breakdown';
import { deliverySectionsFromDoc } from '../../src/clipmentor/delivery-sections';
import { currentAgentSessionGeneration } from '../../src/persist/agentSessionGeneration';
import { loadAgentRuntimeSidecar } from '../../src/persist/agentRuntimeStore';
import { createRun, flushRunPersistence } from '../agent-runs/store';
import { executeRun } from '../agent-runs/executor';
import { digestValue } from '../agent-runs/store-values';
import { authorSelfCheckReceiptText, authorSelfCheckText, selectAuthorSelfCheckReceipt } from './production-author-self-check';
import type { ProductionTask, StageContext } from './production-task';

export const panelTeachingPurpose = '给达人拆解原作者怎样用可观察的拍法呈现购买理由或推进理解，让达人能借鉴。不要把镜头动作清单当成教学，也不把拍法归因为成交。';

type Row = Record<string, unknown>;
const row = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const normalized = (value: unknown) => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ') : '';
const shortText = (value: unknown): value is string => typeof value === 'string' && !!normalized(value) && value.length <= 500;

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

function currentTeachingMaterial(doc: ProjectDoc, unitId: string) {
 const internal = (doc.clipMentorAnalysis?.blueprint.find(unit => unit.unit_id === unitId) as {internal_review?:Row} | undefined)?.internal_review;
 const candidateId = internal?.current_script_candidate, planId = internal?.current_picture_plan;
 const candidate = typeof candidateId === 'string' ? internal?.[candidateId] : undefined;
 const plan = typeof planId === 'string' ? internal?.[planId] : undefined;
 const lines = row(candidate) && Array.isArray(candidate.lines) ? candidate.lines.filter(row) : [];
 const text={voice:normalized(lines.map(line=>line.narration_ms).join(' ')),
  labels:lines.flatMap(line=>Array.isArray(line.labels)?line.labels.map(normalized).filter(Boolean):[])};
 const pictures = row(plan) && Array.isArray(plan.phases) ? plan.phases.filter(row).map(phase => ({
  mode:phase.mode, range:phase.source_range_seconds,
  context:Array.isArray(phase.context_source_ranges) ? phase.context_source_ranges.filter(row).map(context => context.source_range_seconds) : [],
 })) : [];
 return {candidateId, planId, text:digestValue(text), pictures:digestValue(pictures), hasCopy:row(candidate) && row(plan)};
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

export function teachingBaselineSource(doc: ProjectDoc, task: ProductionTask, requirements:readonly unknown[], objective?:string) {
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
 return {
  source:analysis.source, evidence, transcripts, product:analysis.product,
  purpose:panelTeachingPurpose, task:task.input.brief, objective, requirements,
  scope:baseline.review_scope, units:baseline.units.map(unit => unitDefinition(baseline,unit)),
  feedback:task.blueprintFeedback ? {text:task.blueprintFeedback,revision:task.blueprintFeedbackRevision} : null,
  rebuilding:!!task.repairContext?.teaching_rebuild,
 };
}

type BaselineSource = ReturnType<typeof teachingBaselineSource>;
type Decision = {unit_id:string;status:'ok'|'fix'|'unresolved';source_role:string;takeaway:string;evidence_ids:string[];reason:string};
type BaselineReview = {feedback_scope:'none'|'copy'|'baseline';units:Decision[]};
export function validateTeachingBaselineReview(value: unknown, source: BaselineSource): BaselineReview {
 const invalid = () => Error('teaching_baseline_review_invalid');
 if (!row(value) || !Array.isArray(value.units) || value.units.length !== source.units.length
  || (source.feedback ? value.feedback_scope!=='copy'&&value.feedback_scope!=='baseline' : value.feedback_scope !== 'none')) throw invalid();
 const decisions = value.units;
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
  return {unit_id,status,source_role,takeaway,evidence_ids,reason} as Decision;
 });
 if (value.feedback_scope==='baseline' && !source.rebuilding && units.every(unit=>unit.status==='ok')) throw invalid();
 return {feedback_scope:value.feedback_scope as BaselineReview['feedback_scope'],units};
}

export type TeachingRebuild = {
 rejected:Array<{unitId:string;pointIds:string[];definition:string;evidence:string;status:Decision['status'];reason:string}>;
 affected:Array<{unitId:string;pointIds:string[]}>;
 prior:Record<string,ReturnType<typeof currentTeachingMaterial>>;
 definitions:Record<string,string>;
};

function teachingMeaning(unit:BaselineSource['units'][number]) {
 return digestValue({points:unit.points,coverage:unit.coverage,handoffs:unit.handoffs,original:unit.source_ranges,explanation:unit.explanation_segments});
}

function evidenceDigest(source:BaselineSource,unit:BaselineSource['units'][number]) {
 const overlaps=(start:number,end:number)=>unit.source_ranges.some(([a,b])=>start===end?a<=start&&start<b:start<b&&a<end);
 const evidence=source.evidence.filter(entry=>overlaps(...entry.range)).map(({kind,range,text})=>digestValue({kind,range,text:normalized(text)}));
 const transcripts=source.transcripts.flatMap(transcript=>transcript.words.filter(word=>overlaps(word.start_seconds,word.end_seconds))
  .map(({start_seconds,end_seconds,text})=>digestValue({start_seconds,end_seconds,text:normalized(text)})));
 return digestValue({evidence:[...new Set(evidence)].sort(),transcripts:[...new Set(transcripts)].sort()});
}

export function teachingRebuild(source: BaselineSource, doc: ProjectDoc, review: BaselineReview, previous?:TeachingRebuild):TeachingRebuild {
 const rejected=review.units.filter(decision => decision.status !== 'ok').map(decision => {
  const unit=source.units.find(item=>item.unit_id===decision.unit_id)!;
  return {unitId:unit.unit_id,pointIds:unit.points.map(point=>point.point_id),definition:teachingMeaning(unit),evidence:evidenceDigest(source,unit),status:decision.status,reason:decision.reason};
 });
 return {
  prior:previous?.prior ?? Object.fromEntries(source.units.map(unit => [unit.unit_id,currentTeachingMaterial(doc,unit.unit_id)])),
  definitions:previous?.definitions ?? Object.fromEntries(source.units.map(unit=>[unit.unit_id,teachingMeaning(unit)])),
  rejected, affected:[...new Map([...(previous?.affected??[]),...rejected].map(unit=>[unit.unitId,{unitId:unit.unitId,pointIds:unit.pointIds}])).values()],
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

function implicatedUnits(source:BaselineSource, rejected:TeachingRebuild['affected'][number]) {
 return source.units.filter(unit=>unit.unit_id===rejected.unitId || unit.points.some(point=>rejected.pointIds.includes(point.point_id)));
}

export function unchangedRejectedTeaching(source:BaselineSource, rebuild:TeachingRebuild) {
 return rebuild.rejected.filter(rejected => {
  const units=implicatedUnits(source,rejected);
  return !units.length||units.some(unit=>teachingMeaning(unit)===rejected.definition
   &&(rejected.status==='fix'||evidenceDigest(source,unit)===rejected.evidence));
 });
}

export function staleRebuiltTeaching(source:BaselineSource, doc:ProjectDoc, rebuild:TeachingRebuild) {
 const affected=new Set(rebuild.affected.flatMap(entry=>implicatedUnits(source,entry).map(unit=>unit.unit_id)));
 return source.units.filter(unit => {
  if (!affected.has(unit.unit_id)&&rebuild.definitions[unit.unit_id]===teachingMeaning(unit)) return false;
  const before = rebuild.prior[unit.unit_id], now = currentTeachingMaterial(doc,unit.unit_id);
  if (!now.hasCopy) return true;
  if (!before?.hasCopy) return false;
  const targets=new Set(rebuild.affected.filter(entry=>implicatedUnits(source,entry).includes(unit)).flatMap(entry=>entry.pointIds));
  const covered=unit.coverage.filter(point=>!targets.size||targets.has(point.point_id));
  const visualOnly=covered.some(point=>point.treatment==='visual_only')&&covered.every(point=>point.treatment!=='explain');
  return now.candidateId===before.candidateId || now.planId===before.planId
   || now.text===before.text && (!visualOnly || now.pictures===before.pictures);
 }).map(unit=>unit.unit_id);
}

const instructions = `只读核验教学选题，不审稿。先从任务要求、按原片时间排列的动作与原话候选判断原作者在做什么，再看 units 的作者基线。逐组判：是否保留了该段承担的原片功能、观众想判断的具体问题、原作者让这个信息可见或可听的手法、拿掉本组后达人会少学的做法。动作顺序、泛泛形容或作者备注不够。开场与衔接可承担核心任务，按本片证据判断，不套固定顺序或组数。机器听写与画面只支持各自能确认的关系；不据此证明成交、配方功效或人群适用，也不要求把资料所有卖点写进片。未知不影响当前有依据的选题时，保留该边界。引用必须是本组可回读的 source evidence ID，不能把听写当人工听审。若有 feedback 原话，区分仅改措辞/版式与选题、功能或购买理由错误；后者标 baseline。首次收到要求改变选题的意见（rebuilding=false）时列出需重做的组；已经重选点（rebuilding=true）才核对各组是否兑现。原话中还有其他要求时一并保留，勿改写用户范围。
仅输出 JSON {feedback_scope:"none"|"copy"|"baseline",units:[{unit_id,status:"ok"|"fix"|"unresolved",source_role,takeaway,evidence_ids:[...],reason}]}。每组恰好一条，ok 必须引用证据。禁止改稿或调用工具。`;

export function teachingBaselineDigest(source:BaselineSource) {
 return digestValue({source,instructions});
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
   ...(backend==='codex'?{localProductionCodex:true as const}:{}),instructions,
   messages:[{role:'user',content:JSON.stringify(source)}],
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
