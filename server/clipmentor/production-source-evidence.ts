import {createHash} from 'node:crypto';
import type {SourceVideoReceipt} from '../../shared/clipmentor-source-video';
import type {AnalysisEvidence,ClipMentorAnalysis} from '../../src/clipmentor/analysis';

export function importProductionSourceEvidence(
 analysis:ClipMentorAnalysis, receipt:SourceVideoReceipt, projectId:string,
):ClipMentorAnalysis|null {
 const result=receipt.result, breakdown=analysis.source_breakdown;
 if(!breakdown||!result||receipt.projectId!==projectId||!analysis.source.sourceContentHash
  ||receipt.source_hash!==analysis.source.sourceContentHash||result.source_hash!==receipt.source_hash
  ||result.operationId!==receipt.operationId||result.validation.status!=='valid'
  ||result.actual_handoff_verified!==false||result.complete_film_accepted!==false)return null;
 const next=structuredClone(analysis);
 const known=new Set(next.evidence.map(evidence=>evidence.evidence_id));
 let added=0;
 // Context sequences are neutral observations, not the observer's line verdicts.
 const contexts=result.raw_observation.task_observation?.contexts??[];
 const extra=contexts.flatMap(context=>{
  const requested=result.observation_task?.contexts.find(c=>c.context_id===context.context_id);
  if(!requested)return [];
  return [{window_id:requested.unit_id+':context:'+context.context_id,unit_id:requested.unit_id,
   evidence:context.sequence.filter(e=>e.start_seconds>=requested.source_range_seconds[0]
    &&e.end_seconds<=requested.source_range_seconds[1])}];
 });
 for(const window of [...result.raw_observation.windows.map(w=>({...w,unit_id:w.window_id.slice(0,w.window_id.lastIndexOf(':'))})),...extra]){
  const unitId=window.unit_id;
  const unit=next.source_breakdown!.units.find(unit=>unit.unit_id===unitId);
  if(!unit||!result.subject.units.some(entry=>entry.unit_id===unitId))continue;
  const segmentIds=new Set([...unit.original_segment_ids,...unit.explanation_segment_ids]);
  for(const event of window.evidence){
   const [start,end]=[event.start_seconds,event.end_seconds];
   if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>analysis.source.duration_seconds)continue;
   const segments=next.source_breakdown!.segments.filter(segment=>segmentIds.has(segment.segment_id)
    &&start>=segment.source_range_seconds[0]&&end<=segment.source_range_seconds[1]);
   if(!segments.length)continue;
   const add=(kind:'original_claim'|'visible_action',text:string)=>{
    const id='source-av-'+createHash('sha256').update(JSON.stringify([receipt.operationId,kind,start,end,text])).digest('hex').slice(0,24);
    if(!known.has(id)){
     const evidence:AnalysisEvidence={evidence_id:id,kind,text,source_range_seconds:[start,end],
      status:kind==='original_claim'?'candidate_unverified_speech':'model_observation_not_independently_verified',
      provenance:`原片连续视听模型回执 ${receipt.operationId} / ${window.window_id}。时间为段级，未经人工听审或复核。`,
      source_ids:[receipt.operationId],supporting_evidence_ids:[],observation_method:'saved_source_video_model_receipt',call_status:'succeeded'};
     next.evidence.push(evidence);known.add(id);added++;
    }
    for(const segment of segments){
     const ids=kind==='original_claim'?segment.claim_evidence_ids:segment.visible_evidence_ids;
     if(!ids.includes(id)){ids.push(id);added++;}
    }
   };
   // Preserve the exact audible field, including uncertainty and truncated speech.
   // It can be a description rather than verbatim speech: label it explicitly.
   if(event.audible.trim())add('original_claim',`模型听音记录（可能含概述，非逐字核准）：${event.audible.trim()}`);
   if(event.visible.trim())add('visible_action',event.visible.trim());
  }
 }
 if(!added)return null;
 next.revision++;
 next.audit.push({revision:next.revision,action:'import_source_video_evidence',target_id:receipt.operationId,
  actor:{operator:'task_operator',executor:'production_host',instruction:'reuse_saved_source_observation',identity:'local_declared_not_authenticated'},
  at:Date.now(),reason:'Reuse exact source-bound model evidence; do not confer copy or film approval.'});
 return next;
}

/** Author-only inspection instructions, derived from current source registration, never an approval. */
export function productionEvidenceInspection(
 doc:import('../../src/editor/types').ProjectDoc,
 task:Pick<import('./production-task').ProductionTask,'stage'|'input'|'repairContext'>,
){
 if(task.stage!=='blueprint'||!task.repairContext)return null;
 const a=doc.clipMentorAnalysis,source=a?.source;
 const asset=doc.assets.find(asset=>asset.id===task.input.sourceAssetId);
 if(!a?.source_breakdown)return {status:'unavailable',reason:'source_breakdown_missing'};
 if(asset?.kind!=='video'||!source?.sourceContentHash||source.asset_id!==task.input.sourceAssetId||asset?.sourceContentHash!==source.sourceContentHash)
  return {status:'unavailable',reason:'source_binding_mismatch'};
 if(!Number.isFinite(source.duration_seconds)||source.duration_seconds<=0||!Number.isFinite(source.fps)||source.fps<=0)
  return {status:'unavailable',reason:'source_coordinates_invalid'};
 const repair=task.repairContext.repair as {status?:string;subject?:{revision:number;digest:string};units?:Array<{unit_id:string}>}|undefined;
 // An old review is not a locator for the current draft. Self-check may describe a whole group relation.
 if(repair&&(repair.status!=='bound'||repair.subject?.revision!==a.revision
  ||repair.subject?.digest!==a.production_copy_review?.content_digest))return {status:'unavailable',reason:'review_not_bound'};
 const selected=repair?new Set((repair.units??[]).map(unit=>unit.unit_id)):null;
 const units=a.source_breakdown.units.filter(unit=>!selected||selected.has(unit.unit_id));
 const targets=units.map(unit=>{
  const ids=[...new Set([...unit.original_segment_ids,...unit.explanation_segment_ids])];
  const segments=ids.map(id=>a.source_breakdown!.segments.find(segment=>segment.segment_id===id));
  const invalid=ids.filter((_,i)=>!segments[i]||!validInspectionRange(segments[i]!.source_range_seconds,source.duration_seconds)
   ||!inspectionFrames(segments[i]!.source_range_seconds,source.fps));
  if(!ids.length||invalid.length)return {unit_id:unit.unit_id,status:'unavailable',missing_or_invalid_segments:invalid};
  const ranges=segments.map(segment=>{
   const [start,end]=segment!.source_range_seconds;
   const [firstFrame,lastFrame]=inspectionFrames([start,end],source.fps)!;
   const actor={operator:'task_operator',executor:'builtin_api_agent',instruction:task.input.brief,identity:'local_declared_not_authenticated' as const};
   // Use source-frame coordinates, not the active timeline's fps. The existing observation tool persists frame IDs.
   const calls=[firstFrame,Math.floor((firstFrame+lastFrame)/2),lastFrame].map(center=>{
    const lo=Math.max(firstFrame,center-Math.floor(0.6*source.fps)),hi=Math.min(lastFrame,center+Math.floor(0.6*source.fps));
    const frames=[...new Set(Array.from({length:7},(_,i)=>Math.round(lo+(hi-lo)*i/6)))];
    // Interior timestamps avoid f/fps floating-point round-down in the source tool; extracted frame starts remain in range.
    const seconds=frames.map(frame=>(frame/source.fps+Math.min(end,(frame+1)/source.fps))/2);
    return {tool:'observe_clipmentor_source',args:{seconds,expectedRevision:a.revision,actor,reason:`Inspect original evidence for ${unit.unit_id} / ${segment!.segment_id}; not approval`}};
   });
   const requested=new Set([...segment!.visible_evidence_ids,...segment!.claim_evidence_ids,...segment!.interpretation_evidence_ids]);
   for(const e of a.evidence){
    const point=e.time_seconds??(e.source_frame===undefined?undefined:e.source_frame/source.fps);
    const r=e.source_range_seconds;
    if(r?(r[0]===r[1]?r[0]>=start&&r[0]<end:r[0]<end&&r[1]>start):point!==undefined&&point>=start&&point<end)requested.add(e.evidence_id);
   }
   // Preserve registered support chains (including missing links) without interpreting them as verified facts.
   for(const id of requested)for(const child of a.evidence.find(e=>e.evidence_id===id)?.supporting_evidence_ids??[])requested.add(child);
   return {segment_id:segment!.segment_id,source_range_seconds:[start,end],
    evidence_ids:[...requested].filter(id=>a.evidence.some(e=>e.evidence_id===id)),
    missing_evidence_ids:[...requested].filter(id=>!a.evidence.some(e=>e.evidence_id===id)),
    local_checks:calls.filter((call,index)=>calls.findIndex(other=>JSON.stringify(other.args.seconds)===JSON.stringify(call.args.seconds))===index)};
  });
  return {unit_id:unit.unit_id,status:'ready',ranges};
 });
 return {status:'inspection_plan',source_hash:source.sourceContentHash,analysis_revision:a.revision,
  scope:repair?'review_units':'current_groups_context_not_issue_localization',targets,
  unresolved_unit_ids:[...(selected??[])].filter(id=>!units.some(unit=>unit.unit_id===id)),
  existing_evidence:inspectionEvidenceReads(targets),
  instruction:'先回读已有证据与原回执，再仅对相关疑点执行 local_checks；这些是首中尾附近的局部密集候选，不是完整动作或原声核验。未抽到不能断言不存在，切镜点不能替代动作完成点。local_checks 使用本地 observe_clipmentor_source，零模型调用并返回已保存的 observation_id、frame_evidence_ids 和新 revision。首批使用 expectedRevision；每批之后回读当前 source_breakdown，确认同一原片与范围，再用返回的新 revision 执行下一批，不能盲用旧版本。只记录实际看到的对象、动作、原片范围和来源；visible_action 必须引用实际返回的观察ID与帧证据ID，按现有候选合同用 revise_clipmentor_analysis 保存后回读 evidence/source_breakdown，再继续原返修和审核。工具或模型推断与原片冲突时保留冲突，不按多数投票。画面不能核实原话；需要连续视听时仅沿原入口在剩余授权内处理，无额度则保留未知，不能自签通过。'};
}
function validInspectionRange(value:unknown,duration:number):value is [number,number]{
 return Array.isArray(value)&&value.length===2&&value.every(Number.isFinite)&&value[0]>=0&&value[1]>value[0]&&value[1]<=duration;
}

/** A repair is not a new authorization; the original effect ledger still charges every request. */
export function productionSourceObservationAllowed(task:Pick<import('./production-task').ProductionTask,'stage'|'attempts'|'input'>,recoveredOperation?:string){
 return (task.stage==='analysis'||task.stage==='blueprint')&&!recoveredOperation
  &&Number.isInteger(task.input.budget.observation)&&Number.isInteger(task.attempts.observation)
  &&task.attempts.observation>=0&&task.attempts.observation<task.input.budget.observation;
}

function inspectionEvidenceReads(targets:Array<{ranges?:Array<{evidence_ids:string[]}>}>){
 const ids=[...new Set(targets.flatMap(target=>target.ranges?.flatMap(range=>range.evidence_ids)??[]))];
 return Array.from({length:Math.ceil(ids.length/8)},(_,i)=>({tool:'read_clipmentor_analysis',args:{view:'evidence',evidenceIds:ids.slice(i*8,i*8+8)}}));
}

function inspectionFrames([start,end]:[number,number],fps:number):[number,number]|null{
 let first=Math.ceil(start*fps),last=Math.ceil(end*fps)-1;
 if(first/fps<start)first++;
 if(last/fps>=end)last--;
 return first<=last?[first,last]:null;
}

/** Choose evidence acquisition from bound verdicts, not from words in a model's explanation.
 * Neutral source windows only: reviewer opinions never enter the observer request. */
export function productionReviewObservation(doc:import('../../src/editor/types').ProjectDoc,
 task:Pick<import('./production-task').ProductionTask,'stage'|'input'|'repairContext'>){
 if(task.stage!=='blueprint')return null;
 const repair=task.repairContext?.repair as {units?:Array<{unit_id:string;verdict:string}>}|undefined;
 const ids=new Set(repair?.units?.filter(u=>u.verdict==='insufficient_evidence').map(u=>u.unit_id));
 if(!ids.size)return null;
 const inspection=productionEvidenceInspection(doc,task);
 if(inspection?.status!=='inspection_plan'||inspection.unresolved_unit_ids?.length)
  throw new Error('review_evidence_targets_unavailable');
 const contexts:import('../../shared/clipmentor-source-video').SourceVideoTask['contexts']=[];
 for(const target of inspection.targets??[]){
  if(!ids.has(target.unit_id))continue;
  if(target.status!=='ready'||!target.ranges?.length)throw new Error('review_evidence_targets_unavailable');
  for(const range of target.ranges){
   const source_range_seconds=range.source_range_seconds as [number,number];
   if(contexts.some(c=>c.unit_id===target.unit_id&&c.source_range_seconds.every((n,i)=>n===source_range_seconds[i])))continue;
   contexts.push({context_id:`review-evidence:${contexts.length}`,unit_id:target.unit_id,
    source_range_seconds,boundary_seconds:[],goals:['material_continuity']});
  }
 }
 if(!contexts.length||contexts.length>8)throw new Error('review_evidence_targets_exceed_contract');
 return {version:'source-boundaries-v1' as const,contexts};
}

/** A completed HTTP effect may be a local rejection with no observation ledger. */
export function completedSourceEvidenceOperations(task:Pick<import('./production-task').ProductionTask,'effects'|'sourceEvidenceRecoveryOperation'>){
 const operations=new Set(Object.values(task.effects).filter(effect=>effect.kind==='observation'&&effect.status==='completed'
  &&(effect.result as {status?:number}|undefined)?.status===200).map(effect=>effect.operationId));
 if(task.sourceEvidenceRecoveryOperation)operations.add(task.sourceEvidenceRecoveryOperation);
 return [...operations];
}
