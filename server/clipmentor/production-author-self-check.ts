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

const questions = ['S1','S2','S3','S4','S5','S6','S7'];
type RepairResolution={finding_id:string;status:'resolved'|'unresolved';reference:string[];reason:string};
type Check = { id:string; status:'ok'|'fix'|'unresolved'; reference:string|string[]; reason:string;repair_resolutions?:RepairResolution[] };
class InvalidAuthorCheckResponse extends Error {}

export async function runAuthorSelfCheckWithFormatRetry<T>(run:(formatError?:string)=>Promise<T>) {
  try { return await run(); }
  catch (error) {
    if (!(error instanceof InvalidAuthorCheckResponse)) throw error;
    return run(error.message);
  }
}

export function validateAuthorSelfCheck(text:string, source:unknown) {
  let rows:unknown;
  try{rows=JSON.parse(text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/,'$1'));}catch{throw new InvalidAuthorCheckResponse('blueprint_author_self_check_invalid_json');}
  if(!Array.isArray(rows)||rows.length!==questions.length)throw new InvalidAuthorCheckResponse('blueprint_author_self_check_incomplete');
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
  for(const id of questions){
    const matching=rows.filter(row=>row?.id===id);
    const row=matching[0];
    const references:unknown[]=Array.isArray(row?.reference)?row.reference:[row?.reference];
    if(matching.length!==1||!['ok','fix','unresolved'].includes(row?.status)||typeof row.reason!=='string'
     ||!row.reason.trim()||row.reason.length>900||!references.length||references.length>24
     ||!references.every((quote):quote is string=>{
      if(typeof quote!=='string'||quote.length>500)return false;
      const excerpt=quote.trim();
      if(excerpt.length>=4)return excerpts.some(value=>value.includes(excerpt));
      // A short label is evidence only when it is the entire saved value.
      return /^[\p{L}\p{N}]{2,3}$/u.test(excerpt)&&excerpts.some(value=>value.trim()===excerpt);
     })) {
      const missing=references.filter(q=>typeof q==='string'&&!excerpts.some(v=>v.includes(q.trim())));
      throw new InvalidAuthorCheckResponse(`blueprint_author_self_check_invalid:${id}${missing.length?`:unmatched_reference=${JSON.stringify(missing).slice(0,1200)}`:''}`);
    }
    const trimmed=references.map(quote=>quote.trim());
    const check:Check={id,status:row.status,reference:Array.isArray(row.reference)?trimmed:trimmed[0],reason:row.reason.trim()};
    const targets=(source as {repairReview?:RepairTarget[]})?.repairReview??[];
    if(id==='S2'&&targets.length){
     const resolutions=row.repair_resolutions;
     if(!Array.isArray(resolutions)||resolutions.length!==targets.length)
      throw new InvalidAuthorCheckResponse('blueprint_author_repair_coverage_incomplete');
     for(const target of targets){
      const matches=resolutions.filter((r:any)=>r?.finding_id===target.finding_id),r=matches[0];
      const currentStrings:string[]=[];
      const read=(v:unknown)=>{if(typeof v==='string')currentStrings.push(v);else if(v&&typeof v==='object')Object.values(v).forEach(read);};
      read(target.current);read((source as any).sourceEvidence);
      if(matches.length!==1||!['resolved','unresolved'].includes(r?.status)||typeof r.reason!=='string'||!r.reason.trim()
       ||!Array.isArray(r.reference)||!r.reference.length||r.reference.length>24
       ||!r.reference.every((q:unknown)=>typeof q==='string'&&q.trim().length>=4&&q.length<=500&&currentStrings.some(v=>v.includes(q.trim()))))
       throw new InvalidAuthorCheckResponse('blueprint_author_repair_reference_invalid');
     }
     check.repair_resolutions=resolutions;
     if(resolutions.some((r:RepairResolution)=>r.status==='unresolved'))check.status='fix';
    }
    result.push(check);
  }
  return result;
}

export function selectAuthorSelfCheckReceipt(
 runs:readonly AgentRunRecord[],task:ProductionTask,operationId:string,sourceDigest:string,blueprintAt:number,allowLegacy:boolean,
){
 const eligible=runs.filter(run=>run.projectId===task.projectId&&run.askOnly
  &&run.backend===(task.input.authorBackend??'api')&&run.modelId===task.input.author.model
  &&run.createdAt>=blueprintAt&&run.context?.transportStatus==='completed'
  &&!run.events.some(event=>event.type==='tool_requested'));
 const exact=eligible.find(run=>run.runId===operationId&&run.userInputDigest===sourceDigest);
 if(exact)return {run:exact,exact:true};
 // A receipt can finish after its parent's last checkpoint. Only the
 // historical identity-less fallback needs the old timestamp restriction.
 if(allowLegacy&&eligible.length===1&&eligible[0].runId!==operationId&&eligible[0].updatedAt<=task.updatedAt)
  return {run:eligible[0],exact:false};
}

export function productionAuthorSelfCheckSource(doc:ProjectDoc,prepared:Awaited<ReturnType<typeof createProductionPreparation>>,
 originalRequirements:HandoffBrief['doneCriteria']){
 const { rawPacket, reviewed }=prepared;
 const lint=lintBlueprint(doc).findings.slice(0,80);
 const {lines}=readBlueprint(doc);
 return {
  originalRequirements:structuredClone(originalRequirements),
  blueprint:rawPacket,lint,
  reportBinding:{blueprint_digest:reviewed.subject.digest,loaded_unit_ids:rawPacket.units.map(unit=>unit.unit_id),
   delivery_ids:rawPacket.delivery_sections?.map(section=>section.section_id)??[],scope:'现行候选与登记画面的只读检查。未生成审核通过或成片验收。'},
  sourceEvidence:doc.clipMentorAnalysis?.evidence.map(({evidence_id,kind,status,text,meaning_zh,source_range_seconds,time_seconds})=>({
   evidence_id,kind,status,text,meaning_zh,source_range_seconds,time_seconds,
  })),
  labelTranslations:lines.filter(line=>line.raw.labels_zh!==undefined).map(line=>({id:line.id,labels:line.raw.labels,labels_zh:line.raw.labels_zh})),
 };
}

type RepairTarget={finding_id:string;unit_id:string;original_quote:string;original_reason:string;current:unknown};
/** Author-only feedback: it cannot replace or enter the independent review packet. */
export function productionRepairTargets(task:Pick<ProductionTask,'repairContext'>,packet:{units:Array<{unit_id:string}>}):RepairTarget[]{
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
 originalRequirements:HandoffBrief['doneCriteria'],
){
 const {reviewed}=prepared;
 const source={...productionAuthorSelfCheckSource(doc,prepared,[task.input.brief,...originalRequirements]),
  repairReview:productionRepairTargets(task,prepared.rawPacket),
  unchangedReviewedDelivery:unchangedReviewedDelivery(task,prepared.rawPacket)};
 const sourceDigest=digestValue({source,guide});
 const effectBase='blueprint-author-self-check:'+sourceDigest;
 if(!task.repairContext?.review_contract_recheck&&task.repairContext?.blueprint_digest===reviewed.subject.digest
  &&task.repairContext?.author_self_check_source_digest===sourceDigest
  &&!stage.hasEffect?.('model',effectBase)&&!stage.hasEffect?.('model','blueprint-author-self-check'))
  throw new Error('蓝图返修未改变送审内容');
 return runAuthorSelfCheckWithFormatRetry(formatError=>{
 const effectName=effectBase+(formatError?':format-retry':'');
 return stage.effect('model',effectName,async operationId=>{
  const author=task.input.author;
  const backend=task.input.authorBackend??'api';
  const run=createRun({id:operationId,userInputDigest:sourceDigest,projectId:task.projectId,sessionGeneration:await currentAgentSessionGeneration(task.projectId),
   backend,provider:author.provider,model:author.model,askOnly:true,context:{productionTaskId:task.taskId,stage:'blueprint_author_self_check'}});
  await flushRunPersistence(run);
  let requests=0;
  await executeRun(run,{backend,provider:author.provider,model:author.model,origin:author.origin,openAiApiMode:author.apiMode,cacheMode:'short',
   maxOutputTokens:4096,autonomousAcceptance:false,maxAcceptanceIterations:1,tools:[],
   ...(backend==='codex'?{localProductionCodex:true as const}:{}),
   instructions:`${guide}\n本次只执行只读作者自检。输出 JSON 数组，按 S1–S7 各一条 {id,status,reference,reason}。status 只能是 ok、fix、unresolved。reference 可填一个逐字引文字符串，或由多个逐字引文组成的数组（最多24条）；每条必须能单独在收到的当前材料中找回。reason 写具体判断或最小修法。S6 的版本绑定由服务端核验：用 reportBinding 核本次单元覆盖和报告未读项，不要求你复算摘要，不要求配音、成片或人审板。后续阶段才能检查的事项，标清归属即可，不作为本阶段未通过。S2 只检查现行稿实际说出的断言能否回源，候选引语可以作为有明确边界的原作者转述证据；整句听审、精确同步和已明示未确认的边界属于后续检查，不能单独判未通过。S5 逐句对照已声明的实际子窗和字幕分卡，组级回看外窗可比子窗宽。S6 非阻断拼写或标点提示引用报告原文即可；未显示的历史字段不能据此判现行报告漏读。S7 审现行计划要上屏的文字，不要求已经制卡、渲染或完成终审。正常且说明了未知边界的缺失可以保留。如有unchangedReviewedDelivery，它仅指与原审核逐字段相同的片头片尾计划：复用其原判，不因本次输入未重复图片文字转录而要求重审；不代表成片批准，现行可见文字与事实有实际冲突仍须列出。如输入有repairReview，S2必须增加repair_resolutions数组，逐条按finding_id给出{finding_id,status:"resolved"或"unresolved",reference:[现行材料逐字引文],reason}。对照原问题，核当前口播、教学重点、实际画面计划和证据边界是否一起修正；只改备注、换版本或收窄正文但重点仍保留旧断言，不算解决。reference只能引用当前该单元或当前sourceEvidence，不能引用original_quote/original_reason当已修证据。补证解决时引用新证据并说明支持关系，不能靠作者自评。仍不确定就unresolved，不能为进入审核而填resolved。禁止改稿、调用工具或给出生产批准。`,
   messages:[{role:'user',content:JSON.stringify(source)},...(formatError?[{role:'user' as const,content:`上次返回未满足自检回执格式（${formatError}）。请基于同一材料重新完成七项，逐字引用材料，按实际判断填写状态。`}]:[])],
   host:{signal:stage.signal,maxTurns:1,deadlineAt:task.createdAt+task.input.budget.maxElapsedMs,
    async beforeRequest(){if(requests++!==0)throw new Error('作者自检单轮额度已用完');},
    async execute(){throw new Error('作者自检只读，不允许调用工具');}},
  });
  if(run.status!=='completed')throw new Error(run.error??'blueprint_author_self_check_failed');
  const text=run.events.filter(event=>event.type==='text-delta').map(event=>(event.data as {text?:string}).text??'').join('');
  return {digest:reviewed.subject.digest,sourceDigest,runId:run.id,checks:validateAuthorSelfCheck(text,source)};
 },async operationId=>{
  const key=`copy_review:${task.feedbackUsed?'feedback':'initial'}:${task.repairs}:${effectName}`;
  const old=task.effects[key];
  const blueprint=task.completed.blueprint;
  if(old?.operationId!==operationId||!blueprint||blueprint.artifact.revision!==task.projectRevision)
   throw new Error('blueprint_author_self_check_recovery_binding_mismatch');
  const sidecar=await loadAgentRuntimeSidecar(task.projectId);
  // Pre-fix runs lack a request binding. Only recover their non-passing findings,
  // with a unique read-only run and every quote verified against this saved revision.
  const legacy=!formatError&&old.status==='failed'&&/^Error: blueprint_author_self_check_invalid:S[1-7]$/.test(old.error??'');
  const selected=selectAuthorSelfCheckReceipt(sidecar.runs,task,operationId,sourceDigest,blueprint.at,legacy);
  if(!selected)throw new Error('blueprint_author_self_check_recovery_run_unverified');
  const {run,exact}=selected;
  const events=run.events.flatMap(event=>{
   try{return event.summary?[JSON.parse(event.summary).serverEvent]:[];}catch{return [];}
  }).filter(Boolean);
  if(events.findLast(event=>event.type==='done')?.data?.status!=='completed')
   throw new Error('blueprint_author_self_check_recovery_incomplete');
  const checks=validateAuthorSelfCheck(events.filter(event=>event.type==='text-delta').map(event=>event.data.text).join(''),source);
  if(!exact&&checks.every(check=>check.status==='ok'))
   throw new Error('blueprint_author_self_check_recovery_approval_unverified');
  return {digest:reviewed.subject.digest,sourceDigest,runId:run.runId,checks};
 });
 });
}
