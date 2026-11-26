import { createRun, flushRunPersistence } from '../agent-runs/store';
import { executeRun } from '../agent-runs/executor';
import { loadAgentRuntimeSidecar } from '../../src/persist/agentRuntimeStore';
import type { AgentRunRecord } from '../../src/persist/agentRuntimeTypes';
import { digestValue } from '../agent-runs/store-values';
import { currentAgentSessionGeneration } from '../../src/persist/agentSessionGeneration';
import { lintBlueprint, readBlueprint } from '../../src/clipmentor/blueprint-lint';
import type { ProjectDoc } from '../../src/editor/types';
import type { createProductionPreparation } from './production-readiness';
import type { ProductionTask, StageContext } from './production-task';
import type { HandoffBrief } from '../../shared/clipmentor-handoff';
import type { TeachingPacket } from '../../src/clipmentor/production-gate';
import type { AnalysisEvidence } from '../../src/clipmentor/analysis';
import {reviewRecord,reviewReferenceResolver,type ReviewReferenceIssue} from './review-references';
import teachingPurpose from '../../src/agent/skills/clipmentor/references/teaching-purpose.json';

const questions = ['S1','S2','S3','S4','S5','S6','S7'];
type RepairResolution={finding_id:string;status:'resolved'|'unresolved';reference:string[];reason:string};
type CheckStatus='ok'|'fix'|'unresolved';
type TeachingCheck={
 unit_id:string;status:CheckStatus;source_role:string;source_evidence_ids:string[];takeaway:string;reason:string;
 delivered?:{line_id:string;quote:string}|{evidence_id:string;source_seconds:number};
};
type Check = { id:string; status:CheckStatus; reference:string|string[]; reason:string;repair_resolutions?:RepairResolution[];teaching_units?:TeachingCheck[] };
const shortReference=(value:string)=>/^[\p{L}\p{N}]{2,3}$/u.test(value);
export const blockingAuthorBlueprintChecks=(checks:readonly Check[],independentTeaching:boolean)=>
 checks.filter(check=>check.status!=='ok'&&(!independentTeaching||check.id!=='S1'));
type AuthorCheckResult = { digest:string; sourceDigest:string; runId:string; checks:Check[]; referenceIssues?:ReviewReferenceIssue[] };
class InvalidAuthorCheckResponse extends Error {
 readonly issues:ReviewReferenceIssue[];
 readonly checks:Check[];
 constructor(message:string,issues:ReviewReferenceIssue[]=[],checks:Check[]=[]) {
  super(message);this.issues=issues;this.checks=checks;
 }
}

type RepairEvidence=Pick<AnalysisEvidence,'kind'|'text'|'source_range_seconds'|'time_seconds'>;
function repairEvidenceIndexes(unit:RepairTarget['current'],evidence:readonly RepairEvidence[]) {
 const windows=[...(unit.picture_plan?.original_source_ranges??[]),
  ...(unit.picture_plan?.line_source_ranges.flatMap(line=>{
   const selected=[...line.evidence_source_ranges??[],...line.context_source_ranges??[]];
   return selected.length?selected.map(range=>range.source_range_seconds):[line.source_range_seconds];
  })??[])];
 return evidence.flatMap((item,index)=>{
  if(item.kind!=='visible_action'&&item.kind!=='original_claim')return [];
  const start=item.source_range_seconds?.[0]??item.time_seconds;
  const end=item.source_range_seconds?.[1]??start;
  if(start===undefined||end===undefined||!Number.isFinite(start)||!Number.isFinite(end)||end<start)return [];
  // Full-source context provides background for every group. Only a quote
  // within actual playback or selected line material can close this finding.
  return windows.some(([a,b])=>a===b?start===a&&end===b:a<=start&&start<b&&end<=b)?[index]:[];
 });
}

function repairSourceQuotes(unit:RepairTarget['current'],evidence:readonly RepairEvidence[]) {
 const quotes=unit.lines.flatMap(line=>[line.narration_ms,line.caption_lines.join(' '),...line.labels]);
 const picture=unit.picture_plan?.execution_plan?.content as {
  phases?:Array<{picture?:string}>;composition?:{detail?:string;comparison_detail?:string};
 }|undefined;
 quotes.push(...repairEvidenceIndexes(unit,evidence).map(index=>evidence[index].text));
 return [...quotes,...(picture?.phases?.map(phase=>phase.picture)??[]),picture?.composition?.detail,picture?.composition?.comparison_detail]
  .filter((quote):quote is string=>typeof quote==='string');
}

function validateTeachingUnits(value:unknown,packet:TeachingPacket,spokenOnly=false):TeachingCheck[]{
 const invalid=(unit?:string)=>new InvalidAuthorCheckResponse('blueprint_author_self_check_invalid:S1'+(unit?':teaching_unit='+unit:''));
 if(!Array.isArray(value)||!packet.units.length||value.length!==packet.units.length)throw invalid();
 const nonempty=(v:unknown):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=500;
 const spans=([first,last=first]:number[],[start,end]:[number,number])=>{
  if(start===end)return first===last?first===start:first<=start&&start<last;
  if(first===last)return start<=first&&first<end;
  return first<end&&start<last;
 };
 return packet.units.map(unit=>{
  const matches=value.filter(check=>check?.unit_id===unit.unit_id),check=matches[0];
  if(matches.length!==1||!['ok','fix','unresolved'].includes(check.status)
   ||![check.source_role,check.takeaway,check.reason].every(nonempty)
   ||!Array.isArray(check.source_evidence_ids)||check.source_evidence_ids.length>8
   ||new Set(check.source_evidence_ids).size!==check.source_evidence_ids.length)throw invalid(unit.unit_id);
  const source=new Set(unit.source_context?.evidence_ids);
  const cited=check.source_evidence_ids.map((id:unknown)=>packet.source_evidence.find(e=>e.evidence_id===id&&source.has(e.evidence_id)));
  if(!cited.every((e:TeachingPacket['source_evidence'][number]|undefined)=>e?.time_seconds?.length
   &&/^\[(?:original_claim|original_asr|visible_action); /u.test(e.observation)))throw invalid(unit.unit_id);
  if(check.status==='ok'&&!cited.some((e:TeachingPacket['source_evidence'][number])=>
   unit.picture_plan?.original_source_ranges.some(range=>spans(e.time_seconds!,range))))throw invalid(unit.unit_id);
  const baselines=unit.points.filter(point=>point.role==='primary'&&point.treatment!=='omit'&&point.teaching_basis);
  const linked = check.status==='ok'&&baselines.length ? new Set(baselines.filter(point=>
   point.teaching_basis!.evidence_ids.some(id=>check.source_evidence_ids.includes(id))).map(point=>point.point_id)) : undefined;
  const delivery=Array.isArray(check.delivered)&&check.delivered.length===1?check.delivered[0]:check.delivered;
  if(check.status==='ok'||delivery!==undefined){
   if(!delivery||typeof delivery!=='object'||Array.isArray(delivery))throw invalid(unit.unit_id);
   if('line_id' in delivery){
    const line=unit.lines.find(line=>line.line_id===delivery.line_id),quote=delivery.quote;
    if(!line||(linked&&!line.point_ids.some(id=>linked.has(id)))||!nonempty(quote))throw invalid(unit.unit_id);
    const lines=spokenOnly?[line.narration_ms]:[line.narration_ms,line.caption_lines.join(' '),...line.labels];
    if(!lines.some(text=>text===quote.trim()||quote.trim().length>=4&&text.includes(quote.trim())))throw invalid(unit.unit_id);
   }else{
    const evidence=packet.source_evidence.find(e=>e.evidence_id===delivery.evidence_id&&source.has(e.evidence_id));
    const t=delivery.source_seconds,times=evidence?.time_seconds;
    if(!evidence||typeof t!=='number'||!Number.isFinite(t)||!times?.length||!spans(times,[t,t])
     ||!/^\[visible_action; /u.test(evidence.observation))throw invalid(unit.unit_id);
    const shownInOriginal=unit.picture_plan?.original_source_ranges.some(range=>spans([t],range));
    const shownInExplanation=unit.picture_plan?.line_source_ranges.some(line=>{
     const selected=[...line.evidence_source_ranges??[],...line.context_source_ranges??[]];
     return selected.length?selected.some(({source_range_seconds})=>spans([t],source_range_seconds)):spans([t],line.source_range_seconds);
    });
    const bound=unit.points.some(point=>point.treatment==='visual_only'&&(!linked||linked.has(point.point_id))&&point.visual_evidence?.some(binding=>
     binding.evidence_ids.includes(evidence.evidence_id)&&spans([t],binding.source_range_seconds)
     &&(binding.phase==='original'?shownInOriginal:shownInExplanation)));
    if(!bound)throw invalid(unit.unit_id);
   }
  }
  return {unit_id:unit.unit_id,status:check.status,source_role:check.source_role,takeaway:check.takeaway,
   reason:check.reason,source_evidence_ids:check.source_evidence_ids,...(delivery?{delivered:'line_id' in delivery
    ?{line_id:delivery.line_id,quote:delivery.quote}:{evidence_id:delivery.evidence_id,source_seconds:delivery.source_seconds}}:{})};
 });
}

export async function runAuthorSelfCheckWithFormatRetry<T>(run:(formatError?:string)=>Promise<T>) {
  try { return await run(); }
  catch (error) {
    if (!(error instanceof InvalidAuthorCheckResponse)) throw error;
    return run(error.message);
  }
}

export function authorReferenceChoices(source:unknown) {
 const choices=new Map<string,string>();
 const collect=(value:unknown,path:string,field:string)=>{
  if(typeof value==='string'){
   const text=value.trim();
   if(text.length>=2&&text.length<=500
    &&/^(text|narration_ms|caption_lines|labels|labels_zh|zh|meaning_zh|picture|description|scope|claim_limit|method|connection|excerpt|message|note|referenceText|originalRequirements|reason)$/u.test(field))
    choices.set(path,text);
  }else if(Array.isArray(value))value.forEach((entry,index)=>collect(entry,path+'.'+index,field));
  else if(reviewRecord(value))for(const [key,entry] of Object.entries(value))collect(entry,path?path+'.'+key:key,key);
 };
 if(!reviewRecord(source))return choices;
 const {repairReview:_,unchangedReviewedDelivery,...current}=source;
 collect(current,'','');
 if(Array.isArray(unchangedReviewedDelivery))unchangedReviewedDelivery.forEach((entry,index)=>{
  if(reviewRecord(entry)&&typeof entry.scope==='string')choices.set('unchangedReviewedDelivery.'+index+'.scope',entry.scope);
 });
 return choices;
}

function selectedAuthorReferences(value:unknown,source:unknown) {
 const resolver=reviewReferenceResolver();
 const choices=authorReferenceChoices(source);
 const data=source as {blueprint?:TeachingPacket;repairReview?:RepairTarget[];sourceEvidence?:RepairEvidence[]};
 const quote=(row:Record<string,unknown>,path:string,available:ReadonlyMap<string,string>)=>{
  const ids=row.reference_ids;
  if(!Array.isArray(ids)||!ids.length||ids.length>24||row.reference!==undefined){
   resolver.missing(path+'.reference_ids','current_author_check_source',row.reference);
   return [];
  }
  return ids.map((id,index)=>resolver.text(path+'.reference_ids['+index+']','current_author_check_source',id,available));
 };
 const rows=Array.isArray(value)?value.map((row:unknown)=>{
  if(!reviewRecord(row))return row;
  const path=String(row.id);
  const repair_resolutions=Array.isArray(row.repair_resolutions)?row.repair_resolutions.map((resolution:unknown)=>{
   if(!reviewRecord(resolution))return resolution;
   const target=data.repairReview?.find(entry=>entry.finding_id===resolution.finding_id);
   const unitIndex=target?data.blueprint?.units.findIndex(unit=>unit.unit_id===target.unit_id)??-1:-1;
   const scoped=unitIndex>=0?`blueprint.units.${unitIndex}.`:undefined;
   const evidenceKeys=new Set(target?repairEvidenceIndexes(target.current,data.sourceEvidence??[]).map(i=>`sourceEvidence.${i}.text`):[]);
   const permitted=new Map([...choices].filter(([id])=>evidenceKeys.has(id)||scoped&&id.startsWith(scoped)
    &&/^(?:lines\.\d+\.(?:narration_ms|(?:caption_lines|labels)\.\d+)|picture_plan\.execution_plan\.content\.(?:phases\.\d+\.picture|composition\.(?:detail|comparison_detail)))$/u.test(id.slice(scoped.length))));
   return {...resolution,reference:quote(resolution,path+'.repair_resolutions.'+String(resolution.finding_id),permitted)};
  }):row.repair_resolutions;
  const teaching_units=Array.isArray(row.teaching_units)?row.teaching_units.map((unit:unknown)=>{
   if(!reviewRecord(unit)||!reviewRecord(unit.delivered)||!Object.hasOwn(unit.delivered,'line_id'))return unit;
   const {line_id,quote}=unit.delivered;
   const line=data.blueprint?.units.find(entry=>entry.unit_id===unit.unit_id)?.lines.find(entry=>entry.line_id===line_id);
   if(quote!==undefined||!line)
    resolver.missing(path+'.teaching_units.'+String(unit.unit_id)+'.delivered.line_id','current_unit_narration',line_id);
   return {...unit,delivered:{...unit.delivered,quote:line?.narration_ms}};
  }):row.teaching_units;
  return {...row,reference:quote(row,path,choices),repair_resolutions,teaching_units};
 }):value;
 return {rows,issues:resolver.issues};
}

function parseAuthorSelfCheck(text:string, source:unknown, useSelections:boolean) {
  let rows:unknown;
  try{rows=JSON.parse(text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/,'$1'));}catch{throw new InvalidAuthorCheckResponse('blueprint_author_self_check_invalid_json');}
  const resolved=useSelections?selectedAuthorReferences(rows,source):undefined;
  if(resolved)rows=resolved.rows;
  const panelSource=source as {panelTeachingReview?:true;editorialPolicy?:string;blueprint?:TeachingPacket}|undefined;
  const teachingAppendix=panelSource?.panelTeachingReview===true&&panelSource.editorialPolicy==='exemplar-v1';
  if(!Array.isArray(rows)||rows.length!==questions.length&&!(teachingAppendix&&rows.length===questions.length-1))
   throw new InvalidAuthorCheckResponse('blueprint_author_self_check_incomplete');
  const excerpts:string[]=[];
  function collect(value:unknown){
    if(typeof value==='string')excerpts.push(value);
    else if(value&&typeof value==='object')Object.values(value).forEach(collect);
  }
  const {repairReview:_,unchangedReviewedDelivery:__,...currentSource}=(source??{}) as Record<string,unknown>;
  collect(currentSource);
  // Host-derived current reuse scope is valid context; historical reviewer prose is not current copy.
  collect(((source as any)?.unchangedReviewedDelivery??[]).map((entry:any)=>({section_id:entry.section_id,scope:entry.scope})));
  const result:Check[]=[];
  const issues:ReviewReferenceIssue[]=[...resolved?.issues??[]];
  let firstError:string|undefined;
  const receipts=rows;
  for(const id of questions){
    if(resolved?.issues.some(issue=>issue.field.startsWith(id+'.')))continue;
    try{
    const matching=receipts.filter(row=>row?.id===id);
    const row=matching[0];
    const references:unknown[]=Array.isArray(row?.reference)?row.reference:[row?.reference];
    const found=(quote:unknown):quote is string=>{
      if(typeof quote!=='string'||quote.length>500)return false;
      const excerpt=quote.trim();
      return excerpt.length>=4?excerpts.some(value=>value.includes(excerpt))
        :shortReference(excerpt)&&excerpts.some(value=>value.trim()===excerpt);
    };
    if(matching.length!==1||!['ok','fix','unresolved'].includes(row?.status)||typeof row.reason!=='string'
     ||!row.reason.trim()||row.reason.length>900||!references.length||references.length>24
     ||!references.every(found)) {
      if(id==='S1'&&teachingAppendix)continue;
      const missing=references.filter(q=>typeof q==='string'&&!excerpts.some(v=>v.includes(q.trim())));
      const fields=references.flatMap((quote,index)=>found(quote)?[]:[{
       field:id+'.reference['+index+']',material:'current_author_check_source',
       ...(typeof quote==='string'?{value:quote.slice(0,500)}:{}),
      }]);
      throw new InvalidAuthorCheckResponse(`blueprint_author_self_check_invalid:${id}${missing.length?`:unmatched_reference=${JSON.stringify(missing).slice(0,1200)}`:''}`,fields);
    }
    const trimmed=references.map(quote=>quote.trim());
    const check:Check={id,status:row.status,reference:Array.isArray(row.reference)?trimmed:trimmed[0],reason:row.reason.trim()};
    if(id==='S1'&&panelSource?.panelTeachingReview){
     if(!panelSource.blueprint)throw new InvalidAuthorCheckResponse('blueprint_author_self_check_invalid:S1');
     try{check.teaching_units=validateTeachingUnits(row.teaching_units,panelSource.blueprint,teachingAppendix);}
     catch(error){
      if(teachingAppendix&&error instanceof InvalidAuthorCheckResponse)continue;
      throw error;
     }
     if(check.teaching_units.some(unit=>unit.status==='fix'))check.status='fix';
     else if(check.status==='ok'&&check.teaching_units.some(unit=>unit.status==='unresolved'))check.status='unresolved';
    }
    const targets=(source as {repairReview?:RepairTarget[]})?.repairReview??[];
    if(id==='S2'&&targets.length){
     const resolutions=row.repair_resolutions;
     if(!Array.isArray(resolutions)||resolutions.length!==targets.length)
      throw new InvalidAuthorCheckResponse('blueprint_author_repair_coverage_incomplete');
     for(const target of targets){
      const matches=resolutions.filter((r:any)=>r?.finding_id===target.finding_id),r=matches[0];
      const evidence=(source as {sourceEvidence?:RepairEvidence[]}).sourceEvidence??[];
      const currentStrings=repairSourceQuotes(target.current,evidence);
      const plan=target.current.picture_plan?.execution_plan;
      const identifiers=new Set([target.finding_id,target.unit_id,plan?.plan_id,plan?.script_candidate_id,
       ...target.current.lines.map(line=>line.line_id),...target.current.points.map(point=>point.point_id),
       ...target.current.source_context?.evidence_ids??[]]);
      if(matches.length!==1||!['resolved','unresolved'].includes(r?.status)||typeof r.reason!=='string'||!r.reason.trim()
       ||!Array.isArray(r.reference)||!r.reference.length||r.reference.length>24
       ||!r.reference.every((q:unknown)=>typeof q==='string'&&q.length<=500&&!identifiers.has(q.trim())
        &&currentStrings.some(v=>q.trim().length>=4?v.includes(q.trim()):shortReference(q.trim())&&v.trim()===q.trim())))
       throw new InvalidAuthorCheckResponse('blueprint_author_repair_reference_invalid');
     }
     check.repair_resolutions=resolutions;
     if(resolutions.some((r:RepairResolution)=>r.status==='unresolved'))check.status='fix';
    }
    result.push(check);
    }catch(error){
      if(!(error instanceof InvalidAuthorCheckResponse))throw error;
      firstError??=error.message;
      issues.push(...(error.issues.length?error.issues:[{field:id,material:'current_author_check_source',value:error.message}]));
    }
  }
  if(issues.length)throw new InvalidAuthorCheckResponse(firstError??'blueprint_author_self_check_invalid:reference_selection',issues,result);
  return result;
}

export function validateAuthorSelfCheck(text:string,source:unknown) {
 return parseAuthorSelfCheck(text,source,false);
}

export function readAuthorCheckAttachment(text:string,source:unknown,useSelections=false):Pick<AuthorCheckResult,'checks'|'referenceIssues'>{
 try{return {checks:parseAuthorSelfCheck(text,source,useSelections)};}
 catch(error){
  if(!(error instanceof InvalidAuthorCheckResponse))throw error;
  return {checks:error.checks,referenceIssues:error.issues.length?error.issues:[{field:'receipt',material:'current_author_check_source',value:error.message}]};
 }
}

/** A format retry cannot clear a valid business hold from the same saved subject. */
export function recoveredAuthorChecks(first:Check[],retry:Check[]):Check[] {
 const original=first.find(check=>check.id==='S7'&&check.status!=='ok');
 if(!original||retry.some(check=>check.id==='S7'&&check.status!=='ok'))return retry;
 return [...retry.filter(check=>check.id!=='S7'),original];
}


export function selectAuthorSelfCheckReceipt(
 runs:readonly AgentRunRecord[],task:ProductionTask,operationId:string,sourceDigest:string,blueprintAt:number,allowLegacy:boolean,
){
 const eligible=runs.filter(run=>run.projectId===task.projectId&&run.askOnly
  &&run.backend===(task.input.authorBackend??'api')&&run.modelId===task.input.author.model
  &&(run.provider===undefined||run.provider===task.input.author.provider)
  &&run.createdAt>=blueprintAt&&run.context?.transportStatus==='completed'
  &&!run.events.some(event=>['tool_requested','tool_started','tool_outcome'].includes(event.type)));
 const exact=eligible.find(run=>run.runId===operationId&&run.userInputDigest===sourceDigest);
 if(exact)return {run:exact,exact:true};
 // A receipt can finish after its parent's last checkpoint. Only the
 // historical identity-less fallback needs the old timestamp restriction.
 const legacy=eligible.length===1?eligible[0]:undefined;
 // Server runs without an explicit source binding used the request-shape hash
 // for both fields. A different explicit source digest is contrary evidence.
 if(allowLegacy&&legacy&&legacy.runId!==operationId&&legacy.updatedAt<=task.updatedAt
  &&legacy.userInputDigest===legacy.context?.requestShapeHash)
  return {run:legacy,exact:false};
}

export function authorSelfCheckText(events:readonly unknown[]):string {
 const chunks:string[]=[];
 let done=false;
 let expectedId=1;
 const incomplete=()=>new Error('blueprint_author_self_check_recovery_incomplete');
 for(const raw of events){
  const event=raw as {id?:unknown;type?:unknown;data?:{status?:unknown;text?:unknown}}|undefined;
  if(!event||event.id!==expectedId++||typeof event.type!=='string'||done)throw incomplete();
  if(event.type==='done'){
   if(event.data?.status!=='completed')throw incomplete();
   done=true;
  }else if(event.type==='text-delta'){
   if(typeof event.data?.text!=='string')throw incomplete();
   chunks.push(event.data.text);
  }else if(['tool-request','server-tool-request','tool-result','server-tool-result'].includes(event.type))throw incomplete();
 }
 if(!done)throw incomplete();
 return chunks.join('');
}

export function authorSelfCheckReceiptText(run:AgentRunRecord):{text:string;verified:boolean} {
 const events=run.events.map(row=>{
  try{return row.summary===undefined?undefined:JSON.parse(row.summary)?.serverEvent;}
  catch{return undefined;}
 });
 const text=authorSelfCheckText(events);
 let verified=true;
 for(const event of events){
  if(event.type!=='text-delta')continue;
  if(event.rawTextChanged===true)throw new Error('blueprint_author_self_check_recovery_text_changed');
  if(event.rawTextDigest===undefined)verified=false;
  else if(event.rawTextDigest!==digestValue(event.data.text))throw new Error('blueprint_author_self_check_recovery_text_changed');
 }
 return {text,verified};
}

function recordedFormatFailure(effect:ProductionTask['effects'][string]|undefined):boolean {
 return effect?.status==='failed'
  &&/^Error: (?:blueprint_author_self_check_(?:invalid_json|incomplete|invalid:S[1-7](?::(?:unmatched_reference=|teaching_unit=).+)?)|blueprint_author_repair_(?:coverage_incomplete|reference_invalid))$/s.test(effect.error??'');
}

export function productionAuthorSelfCheckSource(doc:ProjectDoc,prepared:{rawPacket:TeachingPacket;reviewed:Pick<Awaited<ReturnType<typeof createProductionPreparation>>['reviewed'],'subject'>},
 originalRequirements:HandoffBrief['doneCriteria'],panelDraft=false){
 const { rawPacket, reviewed }=prepared;
 const evidence=doc.clipMentorAnalysis?.evidence;
 const failed=new Set(panelDraft?evidence?.filter(item=>item.call_status==='failed').map(item=>item.evidence_id):[]);
 const blueprint=failed.size?{...rawPacket,source_evidence:rawPacket.source_evidence.filter(item=>!failed.has(item.evidence_id)),
  units:rawPacket.units.map(unit=>unit.source_context?{...unit,source_context:{...unit.source_context,
   evidence_ids:unit.source_context.evidence_ids.filter(id=>!failed.has(id))}}:unit)}:rawPacket;
 const lint=lintBlueprint(doc).findings.slice(0,80);
 const {lines}=readBlueprint(doc);
 return {
  originalRequirements:structuredClone(originalRequirements),
  blueprint,lint,
  reportBinding:{blueprint_digest:reviewed.subject.digest,loaded_unit_ids:rawPacket.units.map(unit=>unit.unit_id),
   delivery_ids:rawPacket.delivery_sections?.map(section=>section.section_id)??[],scope:'现行候选与登记画面的只读检查。未生成审核通过或成片验收。'},
  sourceEvidence:evidence?.filter(item=>item.call_status!=='failed').map(({evidence_id,kind,status,text,meaning_zh,source_range_seconds,time_seconds})=>({
   evidence_id,kind,status,text,meaning_zh,source_range_seconds,time_seconds,
  })),
  labelTranslations:lines.filter(line=>line.raw.labels_zh!==undefined).map(line=>({id:line.id,labels:line.raw.labels,labels_zh:line.raw.labels_zh})),
 };
}

type RepairTarget={finding_id:string;unit_id:string;original_quote:string;original_reason:string;current:TeachingPacket['units'][number]};
/** Author-only feedback: it cannot replace or enter the independent review packet. */
export function productionRepairTargets(task:Pick<ProductionTask,'repairContext'>,packet:Pick<TeachingPacket,'units'>):RepairTarget[]{
 const repair=(task.repairContext?.pending_review_repair??task.repairContext?.repair) as
  {status?:string;units?:Array<{unit_id:string;findings?:Array<{finding_id?:string;quote:string;reason:string}>}>}|undefined;
 if(!repair)return [];
 if(repair.status!=='bound')throw new Error('author_repair_original_receipt_unbound');
 return (repair.units??[]).flatMap(unit=>(unit.findings??[]).map(f=>{
  const current=packet.units.find(u=>u.unit_id===unit.unit_id);
  if(!f.finding_id||!current)throw new Error('author_repair_target_missing');
  return {finding_id:f.finding_id,unit_id:unit.unit_id,original_quote:f.quote,original_reason:f.reason,current};
 }));
}

export function unchangedReviewedDelivery(task:Pick<ProductionTask,'repairContext'>,packet:{delivery_sections?:Array<{section_id:string}>}){
 const r=(task.repairContext?.pending_review_repair??task.repairContext?.repair) as any;
 if(r?.status!=='bound')return [];
 return (packet.delivery_sections??[]).flatMap(section=>{
  const before=r.delivery_sections?.find((s:any)=>s.section_id===section.section_id);
  const verdict=r.delivery_checks?.find((s:any)=>s.section_id===section.section_id);
  return before&&verdict?.verdict==='pass'&&digestValue(before)===digestValue(section)
   ?[{section_id:section.section_id,prior_check:verdict,scope:'same_saved_delivery_plan_only_not_current_film_approval'}]:[];
 });
}

/** Fresh context, read-only and bound to the exact candidate. Its record stays outside reviewer input. */
export async function checkProductionAuthorBlueprint(
 task:ProductionTask,stage:StageContext,doc:ProjectDoc,prepared:Awaited<ReturnType<typeof createProductionPreparation>>,guide:string,
 originalRequirements:HandoffBrief['doneCriteria'],hostDeliveryEvidence?:Record<string,unknown>,panelDraft=false,
){
 const {reviewed}=prepared;
 const requirements=[task.input.brief,...originalRequirements,...(task.blueprintFeedback?[task.blueprintFeedback]:[])];
 const exemplarPolicy=task.input.panelDelivery?.editorialPolicy==='exemplar-v1';
 const source={...productionAuthorSelfCheckSource(doc,prepared,requirements,panelDraft),
  ...(hostDeliveryEvidence?{hostDeliveryEvidence}:{}),
  ...(panelDraft?{panelTeachingReview:true as const}:{}),
  ...(exemplarPolicy?{editorialPolicy:'exemplar-v1' as const,...(panelDraft?{teachingPurpose}:{})}:{}),
  repairReview:productionRepairTargets(task,prepared.rawPacket),
  unchangedReviewedDelivery:unchangedReviewedDelivery(task,prepared.rawPacket)};
 const advisoryReceipt=panelDraft&&exemplarPolicy;
 const referenceChoices=advisoryReceipt?[...authorReferenceChoices(source).keys()]:undefined;
 const referenceField=advisoryReceipt?'reference_ids':'reference';
 const referenceRule=advisoryReceipt?'reference_ids 是包含 1–24 个编号的数组，只选输入 referenceChoices 中的编号（路径下标从 0 起），不输出逐字引文。':'reference 可填一个逐字引文字符串，或由多个逐字引文组成的数组（最多24条）；每条必须能单独在收到的当前材料中找回。';
 const sourceDigest=digestValue({source,guide});
 const legacyName='blueprint-author-self-check';
 const currentName=legacyName+':'+sourceDigest;
 const effectKey=(name:string)=>`copy_review:${task.feedbackUsed?'feedback':'initial'}:${task.repairs}:${name}`;
 const first=task.effects?.[effectKey(currentName)];
 const formatRetry=task.effects?.[effectKey(currentName+':format-retry')];
 if(formatRetry&&(first?.kind!=='model'||formatRetry.kind!=='model'))
  throw new Error('blueprint_author_self_check_recovery_binding_mismatch');
 // A repaired review contract may use another review operation on the same
 // subject. Reuse the exact author attachment, without borrowing a verdict
 // from a different draft, guide, requirement or repair input.
 if(!first&&!formatRetry&&task.blueprintApproval?.teachingBrief?.confirmedGroups?.length){
  const earlier=Object.entries(task.effects).findLast(([key,effect])=>
   key.startsWith('copy_review:')&&key.endsWith(':'+currentName)&&effect.kind==='model'&&effect.status==='completed');
  if(earlier){
   const effect=earlier[1],result=effect.result as AuthorCheckResult|undefined;
   if(result?.digest!==reviewed.subject.digest||result.sourceDigest!==sourceDigest||result.runId!==effect.operationId)
    throw Error('blueprint_author_self_check_recovery_binding_mismatch');
   return {...result,checks:validateAuthorSelfCheck(JSON.stringify(result.checks),source)};
  }
 }
 const legacy=task.effects?.[effectKey(legacyName)];
 const useLegacy=!panelDraft&&!exemplarPolicy&&!first&&!formatRetry&&legacy?.kind==='model';
 const effectBase=useLegacy?legacyName:currentName;
 const readRecordedAttachment=async(effect:ProductionTask['effects'][string])=>{
  const {runs}=await loadAgentRuntimeSidecar(task.projectId);
  const entry=selectAuthorSelfCheckReceipt(runs,task,effect.operationId,sourceDigest,task.completed.blueprint?.at??task.createdAt,false);
  if(!entry?.exact)throw Error('blueprint_author_self_check_recovery_run_unverified');
  const {text,verified}=authorSelfCheckReceiptText(entry.run);
  if(!verified)throw Error('blueprint_author_self_check_recovery_text_unverified');
  const result=readAuthorCheckAttachment(text,source,/"reference_ids"\s*:/u.test(text));
  return {...result,runId:entry.run.runId,
   referenceIssues:result.referenceIssues?.map(issue=>({...issue,receipt:entry.run.runId}))??[]};
 };
 const readAdvisoryAttachment=async(effect:ProductionTask['effects'][string])=>{
  try {return {...await readRecordedAttachment(effect),verified:true};}
  catch(error){
   if(!(error instanceof Error)||!/^blueprint_author_self_check_recovery_/u.test(error.message))throw error;
   return {runId:effect.operationId,checks:[],verified:false,referenceIssues:[{
    field:'S7',material:'original_author_check',receipt:effect.operationId,value:error.message,
   }]};
  }
 };
 // The old format retry consumed both operations. Re-read both failures as attachments
 // without settling either failed effect or attempting a third submission.
 if(advisoryReceipt&&first&&formatRetry&&recordedFormatFailure(first)&&recordedFormatFailure(formatRetry)){
  const [original,retry]=await Promise.all([readAdvisoryAttachment(first),readAdvisoryAttachment(formatRetry)]);
  const bothVerified=original.verified&&retry.verified&&original.referenceIssues.length>0&&retry.referenceIssues.length>0;
  const checks=recoveredAuthorChecks(original.checks,retry.checks).filter(check=>bothVerified||check.id!=='S7'||check.status!=='ok');
  const referenceIssues=[...original.referenceIssues,...retry.referenceIssues];
  return {digest:reviewed.subject.digest,sourceDigest,runId:retry.runId,checks,
   referenceIssues:referenceIssues.length?referenceIssues:[{field:'receipt',material:'original_author_check',value:'saved_author_format_status_conflict'}]};
 }
 if(!task.repairContext?.review_contract_recheck&&task.repairContext?.blueprint_digest===reviewed.subject.digest
  &&task.repairContext?.author_self_check_source_digest===sourceDigest
  &&!stage.hasEffect?.('model',effectBase)&&!stage.hasEffect?.('model',currentName+':format-retry'))
  throw new Error('蓝图返修未改变送审内容');
 const attempt=async(formatError?:string,resumeRetry=false)=>{
 const isRetry=resumeRetry||formatError!==undefined;
 const effectName=effectBase+(isRetry?':format-retry':'');
 const saved=task.effects?.[effectKey(effectName)];
 const result=await stage.effect<AuthorCheckResult>('model',effectName,async operationId=>{
  if(resumeRetry||useLegacy)throw new Error('blueprint_author_self_check_recovery_binding_mismatch');
  const author=task.input.author;
  const backend=task.input.authorBackend??'api';
  const run=createRun({id:operationId,userInputDigest:sourceDigest,projectId:task.projectId,sessionGeneration:await currentAgentSessionGeneration(task.projectId),
   backend,provider:author.provider,model:author.model,askOnly:true,context:{productionTaskId:task.taskId,stage:'blueprint_author_self_check'}});
  await flushRunPersistence(run);
  let requests=0;
  await executeRun(run,{backend,provider:author.provider,model:author.model,origin:author.origin,openAiApiMode:author.apiMode,cacheMode:'short',
   maxOutputTokens:4096,autonomousAcceptance:false,maxAcceptanceIterations:1,tools:[],
   ...(backend==='codex'?{localProductionCodex:true as const}:{}),
   instructions:`${guide}\n本次只执行只读作者自检。输出 JSON 数组，按 S1–S7 各一条 {id,status,${referenceField},reason}。status 只能是 ok、fix、unresolved。${referenceRule}reason 写具体判断或最小修法。S6 的版本绑定由服务端核验：用 reportBinding 核本次单元覆盖和报告未读项，不要求你复算摘要，不要求配音、成片或人审板。后续阶段才能检查的事项，标清归属即可，不作为本阶段未通过。S2 只检查现行稿实际说出的断言能否回源，候选引语可以作为有明确边界的原作者转述证据；整句听审、精确同步和已明示未确认的边界属于后续检查，不能单独判未通过。S5 逐句对照已声明的实际子窗和字幕分卡，组级回看外窗可比子窗宽。若输入有 hostDeliveryEvidence，用其像素矩形核裁窗。引用裁切证据时，${advisoryReceipt?'只选 referenceText 的编号':'只逐字引用 referenceText 的文字'}，不引用 JSON 结构；left/top/right/bottom 是各边去掉的比例，不是坐标端点。已合作版的 attachment 可能是绑定原片文档的索引，不能只按索引后缀判断独立附件格式。若宿主已读到独立 PDF 字节，下载入口放行和最终接收仍属交付阶段。S6 非阻断拼写或标点提示引用报告原文即可；未显示的历史字段不能据此判现行报告漏读。S7 审现行计划要上屏的文字，不要求已经制卡、渲染或完成终审。正常且说明了未知边界的缺失可以保留。如有unchangedReviewedDelivery，它仅指与原审核逐字段相同的片头片尾计划：复用其原判，不因本次输入未重复图片文字转录而要求重审；不代表成片批准，现行可见文字与事实有实际冲突仍须列出。如输入有repairReview，S2必须增加repair_resolutions数组，逐条按finding_id给出{finding_id,status:"resolved"或"unresolved",${referenceField}:[${advisoryReceipt?'本组现行材料编号':'现行材料逐字引文'}],reason}。对照原问题，核当前口播、教学重点、实际画面计划和证据边界是否一起修正；只改备注、换版本或收窄正文但重点仍保留旧断言，不算解决。${referenceField} 只指向本组口播、字幕、短标、画面描述，或时间记录完整落在本组原片及逐句选段内的原话或动作原文。全片上下文、标识符、策划译文和历史判词不能单独结案。补证解决时说明新证据的支持关系。仍不确定就unresolved，不能为进入审核而填resolved。禁止改稿、调用工具或给出生产批准。${panelDraft?` 网页蓝图交审前，在 S1 增加 teaching_units 数组，现行每组恰好一条 {unit_id,status,source_role,source_evidence_ids,takeaway,reason,delivered?}。先用 source_evidence 中原片原话、带时间的听写或具体可见动作和全片顺序写 source_role，说明这一段怎样把观看带到下一步。WHY、只记录已提取的帧、作者点评都不是来源。${exemplarPolicy?'按 teachingPurpose 先只读现行马来语口播，再核本组原片依据。':'再看口播、字幕、短标和计划画面。'}takeaway 写拿掉本组讲解后达人会少学的具体拍法。只复述动作、只在备注解释，或遗漏原片承担的主要作用，判 fix。ok 必须引用本组原片范围里的证据并附 delivered：实际马来语口播${exemplarPolicy?'':'、字幕或短标'}用 ${advisoryReceipt?'{line_id} 选择句子':'{line_id,quote} 逐字引用'}；纯画面用现行 visual_only 绑定的 {evidence_id,source_seconds}。证据不足写 unresolved，可省 delivered 或暂留空 source_evidence_ids。画面或听写仅支持各自能确认的含义，不需要虚构原话，也不把抽帧当整段听审。`:''}${task.input.panelDelivery?.editorialPolicy==='exemplar-v1'?' 严格网页稿的 S1 只作作者自评。口播主讲定位现行马来语句子，答达人会改哪个拍摄决定、观众多能判断什么。用同组已登记的原片依据核对，纯画面沿用已绑定的可见证据。机器听写候选须标明未听审；缺少中文译文时仍读马来语原话和可见动作。若只能从作者备注读出作用，判 fix。S6 已可见的选材或对象缺项现在修；实测声长留到配音。':''}`,
   messages:[{role:'user',content:JSON.stringify(referenceChoices?{...source,referenceChoices}:source)},...(formatError?[{role:'user' as const,content:`上次返回未满足自检回执格式（${formatError}）。请基于同一材料重新完成七项，按 ${referenceField} 的格式引用材料，并按实际判断填写状态。`}]:[])],
   host:{signal:stage.signal,maxTurns:1,deadlineAt:task.createdAt+task.input.budget.maxElapsedMs,
    async beforeRequest(){if(requests++!==0)throw new Error('作者自检单轮额度已用完');},
    async execute(){throw new Error('作者自检只读，不允许调用工具');}},
  });
  if(run.status!=='completed')throw new Error(run.error??'blueprint_author_self_check_failed');
  const text=authorSelfCheckText(run.events);
  return {digest:reviewed.subject.digest,sourceDigest,runId:run.id,...(advisoryReceipt
    ?readAuthorCheckAttachment(text,source,true):{checks:validateAuthorSelfCheck(text,source)})};
 },async operationId=>{
  const old=task.effects[effectKey(effectName)];
  const blueprint=task.completed.blueprint;
  if(old?.operationId!==operationId||!blueprint||blueprint.artifact.revision!==task.projectRevision)
   throw new Error('blueprint_author_self_check_recovery_binding_mismatch');
  const sidecar=await loadAgentRuntimeSidecar(task.projectId);
  // Pre-fix runs lack a request binding. Only recover their non-passing findings,
  // with a unique read-only run and every quote verified against this saved revision.
  const allowLegacy=!isRetry&&old.status==='failed'&&/^Error: blueprint_author_self_check_invalid:S[1-7]$/.test(old.error??'');
  const selected=selectAuthorSelfCheckReceipt(sidecar.runs,task,operationId,sourceDigest,blueprint.at,allowLegacy);
  if(!selected)throw new Error('blueprint_author_self_check_recovery_run_unverified');
  const {run,exact}=selected;
  const {text,verified}=authorSelfCheckReceiptText(run);
  if(!isRetry&&formatRetry&&(!exact||!verified))
   throw new Error('blueprint_author_self_check_recovery_run_unverified');
  if(advisoryReceipt&&exact&&verified){
   // Historical raw responses still use quotes. Re-read them without changing their decision or bytes.
   const selected=/["']reference_ids["']\s*:/u.test(text);
   return {digest:reviewed.subject.digest,sourceDigest,runId:run.runId,...readAuthorCheckAttachment(text,source,selected)};
  }
  let checks:Check[];
  try{checks=validateAuthorSelfCheck(text,source);}
  catch(error){
   if(error instanceof InvalidAuthorCheckResponse&&(!exact||(!verified&&!recordedFormatFailure(old))))
    throw new Error('blueprint_author_self_check_recovery_run_unverified');
   throw error;
  }
  if(!exact&&!blockingAuthorBlueprintChecks(checks,panelDraft&&exemplarPolicy).length)
   throw new Error('blueprint_author_self_check_recovery_approval_unverified');
  return {digest:reviewed.subject.digest,sourceDigest,runId:run.runId,checks};
 });
 if(panelDraft||(saved?.status==='completed'&&(useLegacy||source.repairReview.length>0))||(isRetry&&saved)){
  if(result?.digest!==reviewed.subject.digest||result.sourceDigest!==sourceDigest||typeof result.runId!=='string'
   ||((isRetry||panelDraft||source.repairReview.length>0)&&saved&&result.runId!==saved.operationId))
   throw new Error('blueprint_author_self_check_recovery_binding_mismatch');
  if(advisoryReceipt&&result.referenceIssues?.length)return result;
  try{return {...result,checks:validateAuthorSelfCheck(JSON.stringify(result.checks),source)};}
  catch(error){
   // A persisted completed result can lose admissibility under a stricter
   // evidence check. Preserve it and do not treat it as a fresh format error.
   if(saved?.status==='completed'&&error instanceof InvalidAuthorCheckResponse)
    throw new Error('blueprint_author_self_check_saved_result_invalid',{cause:error});
   throw error;
  }
 }
 return result;
 };
 // A retry can be reserved after a cold format failure while the primary is
 // still reserved. The already-counted slot can recover without the first run.
 if(formatRetry&&(first?.status==='reserved'||recordedFormatFailure(first))){
  if(advisoryReceipt&&first){
   const retry=await attempt(undefined,true);
   const original=await readAdvisoryAttachment(first);
   const checks=recoveredAuthorChecks(original.checks,retry.checks).filter(check=>original.verified||check.id!=='S7'||check.status!=='ok');
   return {...retry,checks,...(!original.verified?{referenceIssues:[...retry.referenceIssues??[],...original.referenceIssues]}:{})};
  }
  if(formatRetry.status!=='completed'&&recordedFormatFailure(first)){
   try { return await attempt(); }
   catch(error){
    if(!(error instanceof InvalidAuthorCheckResponse)&&!(error instanceof Error
     &&['blueprint_author_self_check_recovery_run_unverified','blueprint_author_self_check_recovery_incomplete',
      'blueprint_author_self_check_recovery_text_changed'].includes(error.message)))throw error;
   }
  }
  return attempt(undefined,true);
 }
 if(useLegacy)return attempt();
 return runAuthorSelfCheckWithFormatRetry(attempt);
}
