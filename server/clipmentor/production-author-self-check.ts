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

const questions = ['S1','S2','S3','S4','S5','S6','S7'];
type RepairResolution={finding_id:string;status:'resolved'|'unresolved';reference:string[];reason:string};
type CheckStatus='ok'|'fix'|'unresolved';
type TeachingCheck={
 unit_id:string;status:CheckStatus;source_role:string;source_evidence_ids:string[];takeaway:string;reason:string;
 delivered?:{line_id:string;quote:string}|{evidence_id:string;source_seconds:number};
};
type Check = { id:string; status:CheckStatus; reference:string|string[]; reason:string;repair_resolutions?:RepairResolution[];teaching_units?:TeachingCheck[] };
type AuthorCheckResult = { digest:string; sourceDigest:string; runId:string; checks:Check[] };
class InvalidAuthorCheckResponse extends Error {}

function validateTeachingUnits(value:unknown,packet:TeachingPacket):TeachingCheck[]{
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
  const delivery=check.delivered;
  if(check.status==='ok'||delivery!==undefined){
   if(!delivery||typeof delivery!=='object')throw invalid(unit.unit_id);
   if('line_id' in delivery){
    const line=unit.lines.find(line=>line.line_id===delivery.line_id),quote=delivery.quote;
    if(!line||!nonempty(quote)||![line.narration_ms,line.caption_lines.join(' '),...line.labels]
     .some(text=>text===quote.trim()||quote.trim().length>=4&&text.includes(quote.trim())))throw invalid(unit.unit_id);
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
    const bound=unit.points.some(point=>point.treatment==='visual_only'&&point.visual_evidence?.some(binding=>
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
    const panelSource=source as {panelTeachingReview?:true;blueprint?:TeachingPacket}|undefined;
    if(id==='S1'&&panelSource?.panelTeachingReview){
     if(!panelSource.blueprint)throw new InvalidAuthorCheckResponse('blueprint_author_self_check_invalid:S1');
     check.teaching_units=validateTeachingUnits(row.teaching_units,panelSource.blueprint);
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

export function productionAuthorSelfCheckSource(doc:ProjectDoc,prepared:Awaited<ReturnType<typeof createProductionPreparation>>,
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
  sourceEvidence:evidence?.filter(item=>!failed.has(item.evidence_id)).map(({evidence_id,kind,status,text,meaning_zh,source_range_seconds,time_seconds})=>({
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
 originalRequirements:HandoffBrief['doneCriteria'],hostDeliveryEvidence?:Record<string,unknown>,panelDraft=false,
){
 const {reviewed}=prepared;
 const requirements=[task.input.brief,...originalRequirements,...(task.blueprintFeedback?[task.blueprintFeedback]:[])];
 const source={...productionAuthorSelfCheckSource(doc,prepared,requirements,panelDraft),
  ...(hostDeliveryEvidence?{hostDeliveryEvidence}:{}),
  ...(panelDraft?{panelTeachingReview:true as const}:{}),
  repairReview:productionRepairTargets(task,prepared.rawPacket),
  unchangedReviewedDelivery:unchangedReviewedDelivery(task,prepared.rawPacket)};
 const sourceDigest=digestValue({source,guide});
 const legacyName='blueprint-author-self-check';
 const currentName=legacyName+':'+sourceDigest;
 const effectKey=(name:string)=>`copy_review:${task.feedbackUsed?'feedback':'initial'}:${task.repairs}:${name}`;
 const first=task.effects?.[effectKey(currentName)];
 const formatRetry=task.effects?.[effectKey(currentName+':format-retry')];
 if(formatRetry&&(first?.kind!=='model'||formatRetry.kind!=='model'))
  throw new Error('blueprint_author_self_check_recovery_binding_mismatch');
 const legacy=task.effects?.[effectKey(legacyName)];
 const useLegacy=!panelDraft&&!first&&!formatRetry&&legacy?.kind==='model';
 const effectBase=useLegacy?legacyName:currentName;
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
   instructions:`${guide}\n本次只执行只读作者自检。输出 JSON 数组，按 S1–S7 各一条 {id,status,reference,reason}。status 只能是 ok、fix、unresolved。reference 可填一个逐字引文字符串，或由多个逐字引文组成的数组（最多24条）；每条必须能单独在收到的当前材料中找回。reason 写具体判断或最小修法。S6 的版本绑定由服务端核验：用 reportBinding 核本次单元覆盖和报告未读项，不要求你复算摘要，不要求配音、成片或人审板。后续阶段才能检查的事项，标清归属即可，不作为本阶段未通过。S2 只检查现行稿实际说出的断言能否回源，候选引语可以作为有明确边界的原作者转述证据；整句听审、精确同步和已明示未确认的边界属于后续检查，不能单独判未通过。S5 逐句对照已声明的实际子窗和字幕分卡，组级回看外窗可比子窗宽。若输入有 hostDeliveryEvidence，用其像素矩形核裁窗。引用裁切证据时，只逐字引用 referenceText 的文字，不引用 JSON 结构；left/top/right/bottom 是各边去掉的比例，不是坐标端点。已合作版的 attachment 可能是绑定原片文档的索引，不能只按索引后缀判断独立附件格式。若宿主已读到独立 PDF 字节，下载入口放行和最终接收仍属交付阶段。S6 非阻断拼写或标点提示引用报告原文即可；未显示的历史字段不能据此判现行报告漏读。S7 审现行计划要上屏的文字，不要求已经制卡、渲染或完成终审。正常且说明了未知边界的缺失可以保留。如有unchangedReviewedDelivery，它仅指与原审核逐字段相同的片头片尾计划：复用其原判，不因本次输入未重复图片文字转录而要求重审；不代表成片批准，现行可见文字与事实有实际冲突仍须列出。如输入有repairReview，S2必须增加repair_resolutions数组，逐条按finding_id给出{finding_id,status:"resolved"或"unresolved",reference:[现行材料逐字引文],reason}。对照原问题，核当前口播、教学重点、实际画面计划和证据边界是否一起修正；只改备注、换版本或收窄正文但重点仍保留旧断言，不算解决。reference只能引用当前该单元或当前sourceEvidence，不能引用original_quote/original_reason当已修证据。补证解决时引用新证据并说明支持关系，不能靠作者自评。仍不确定就unresolved，不能为进入审核而填resolved。禁止改稿、调用工具或给出生产批准。${panelDraft?` 网页蓝图交审前，在 S1 增加 teaching_units 数组，现行每组恰好一条 {unit_id,status,source_role,source_evidence_ids,takeaway,reason,delivered?}。先用 source_evidence 中原片原话、带时间的听写或具体可见动作和全片顺序写 source_role，说明这一段怎样把观看带到下一步。WHY、只记录已提取的帧、作者点评都不是来源。再看口播、字幕、短标和计划画面。takeaway 写拿掉本组讲解后达人会少学的具体拍法。只复述动作、只在备注解释，或遗漏原片承担的主要作用，判 fix。ok 必须引用本组原片范围里的证据并附 delivered：实际马来语口播、字幕或短标用 {line_id,quote} 逐字引用；纯画面用现行 visual_only 绑定的 {evidence_id,source_seconds}。证据不足写 unresolved，可省 delivered 或暂留空 source_evidence_ids。画面或听写仅支持各自能确认的含义，不需要虚构原话，也不把抽帧当整段听审。`:''}`,
   messages:[{role:'user',content:JSON.stringify(source)},...(formatError?[{role:'user' as const,content:`上次返回未满足自检回执格式（${formatError}）。请基于同一材料重新完成七项，逐字引用材料，按实际判断填写状态。`}]:[])],
   host:{signal:stage.signal,maxTurns:1,deadlineAt:task.createdAt+task.input.budget.maxElapsedMs,
    async beforeRequest(){if(requests++!==0)throw new Error('作者自检单轮额度已用完');},
    async execute(){throw new Error('作者自检只读，不允许调用工具');}},
  });
  if(run.status!=='completed')throw new Error(run.error??'blueprint_author_self_check_failed');
  const text=authorSelfCheckText(run.events);
  return {digest:reviewed.subject.digest,sourceDigest,runId:run.id,checks:validateAuthorSelfCheck(text,source)};
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
  let checks:Check[];
  try{checks=validateAuthorSelfCheck(text,source);}
  catch(error){
   if(error instanceof InvalidAuthorCheckResponse&&(!exact||(!verified&&!recordedFormatFailure(old))))
    throw new Error('blueprint_author_self_check_recovery_run_unverified');
   throw error;
  }
  if(!exact&&checks.every(check=>check.status==='ok'))
   throw new Error('blueprint_author_self_check_recovery_approval_unverified');
  return {digest:reviewed.subject.digest,sourceDigest,runId:run.runId,checks};
 });
 if(panelDraft||(useLegacy&&saved?.status==='completed')||(isRetry&&saved)){
  if(result?.digest!==reviewed.subject.digest||result.sourceDigest!==sourceDigest||typeof result.runId!=='string'
   ||((isRetry||panelDraft)&&saved&&result.runId!==saved.operationId))
   throw new Error('blueprint_author_self_check_recovery_binding_mismatch');
  return {...result,checks:validateAuthorSelfCheck(JSON.stringify(result.checks),source)};
 }
 return result;
 };
 // A retry can be reserved after a cold format failure while the primary is
 // still reserved. The already-counted slot can recover without the first run.
 if(formatRetry&&(first?.status==='reserved'||recordedFormatFailure(first)))return attempt(undefined,true);
 if(useLegacy)return attempt();
 return runAuthorSelfCheckWithFormatRetry(attempt);
}
