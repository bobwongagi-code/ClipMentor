import type {ProjectDoc} from '../../src/editor/types';
import type {ProductionTask} from './production-task';

import {parseProductionSourceCriteria,sourceTeachingCriterion,type SourceAssetBinding,type SourceClosingStatus} from '../../shared/clipmentor-handoff';

export function registeredSourceBound(doc:ProjectDoc,binding:SourceAssetBinding){
 const source=doc.clipMentorAnalysis?.source;
 return (!source||source.asset_id===binding.assetId&&source.sourceContentHash===binding.sha256)
  &&doc.assets.some(asset=>asset.id===binding.assetId&&asset.kind==='video'&&asset.sourceContentHash===binding.sha256);
}

/** An explicit editor declaration can travel to a new intake of the same bytes. */
export function bindPanelSourceCriteria(value:unknown,source:{id:string;sourceContentHash?:string},sales:{id:string;sourceContentHash?:string}){
 const criteria=parseProductionSourceCriteria(value);
 if(!criteria.length)throw Error('source_criteria_empty');
 return criteria.map(criterion=>{
  if(criterion.source.sha256!==source.sourceContentHash)throw Error('source_criteria_original_changed');
  const bound={...criterion,source:{...criterion.source,assetId:source.id}};
  if(criterion.kind==='source_teaching')return {...criterion,source:bound.source};
  if(criterion.evidence.sha256!==sales.sourceContentHash)throw Error('source_criteria_sales_changed');
  return {...criterion,source:bound.source,evidence:{...criterion.evidence,assetId:sales.id}};
 });
}

export function frozenTeachingTopics(doc:ProjectDoc,task:{input:Pick<ProductionTask['input'],'sourceAssetId'|'doneCriteria'>},criteria:readonly unknown[]=task.input.doneCriteria??[]){
 const declaration=sourceTeachingCriterion(criteria);
 if(!declaration)return;
 if(declaration.source.assetId!==task.input.sourceAssetId||!registeredSourceBound(doc,declaration.source))
  throw Error('source_teaching_binding_changed');
 const source=doc.assets.find(asset=>asset.id===task.input.sourceAssetId);
 const timeline=doc.timelines.find(t=>t.id===doc.activeTimelineId);
 const duration=doc.clipMentorAnalysis?.source.duration_seconds??(source?.durationInFrames&&timeline?.fps
  ?source.durationInFrames/timeline.fps:undefined);
 if(duration!==undefined&&[...declaration.mainRanges,...declaration.backgroundRanges,declaration.closing.evidenceRange].some(range=>range[1]>duration))
  throw Error('source_teaching_window_outside_original');
 return {quote:declaration.quote,main:declaration.main,background:declaration.background,
  mainRanges:declaration.mainRanges,backgroundRanges:declaration.backgroundRanges,
  closingStatus:declaration.closing.status,closing:declaration.closing.note,closingEvidenceRange:declaration.closing.evidenceRange};
}

export function sourceClosingDecision(topics:ReturnType<typeof frozenTeachingTopics>,doc?:ProjectDoc):SourceClosingStatus|null{
 return topics?.closingStatus??doc?.clipMentorAnalysis?.source_breakdown?.source_closing?.status??null;
}

type SourceClosingPolicy={
 decision:SourceClosingStatus|null;
 rules:Record<SourceClosingStatus,string>;
 instruction:string;
 factOnly?:true;
 factualNote?:string;
 requiredNote?:string;
 sourceEvidenceRange?:readonly [number,number];
 noteLocation?:string;
 evidenceSegmentId?:string;
};

export function sourceClosingPolicy(topics:ReturnType<typeof frozenTeachingTopics>,doc?:ProjectDoc):SourceClosingPolicy{
 const closing=doc?.clipMentorAnalysis?.source_breakdown?.source_closing;
 const bound=closing&&doc?.clipMentorAnalysis?.source_breakdown?.segments.find(s=>s.segment_id===closing.segment_id);
 const factOnly=topics?.closingStatus==='weak_candidate';
 return {
  decision:sourceClosingDecision(topics,doc),
  rules:{
   confirmed:'原片证据明确要求买家采取购买相关行动，才独立成教学点。引用对应原片依据，交代行动、入口或激励时仅用已核实信息。',
   weak_candidate:'有疑似建议或购买线索，证据尚不足以确认促单。保留待核记录，禁止独立建促单组或补写推荐；辅助画面只承担证据所支持的用途。',
   none:'已核对实际收尾，未见促单或疑似线索。记录无促单，禁止补建促单组。收尾尚未核清时不能判无促单。',
  },
  instruction:'有任务声明时按其处置。普通任务先在选题基线 source_closing 登记同一档位，附实际片尾 segment_id 和 note。未核清时暂留待核。作者和审核读取同一登记，审核仍须核对原片是否支持。达人邀请属于独立交付。',
  ...(factOnly?{factOnly:true as const,factualNote:topics.closing,sourceEvidenceRange:topics.closingEvidenceRange,
   instruction:'任务声明已登记弱促单事实。直接保留这份记录，不要求另写注记、插入回放或讲解。若把它改判为已确认促单、无促单或新增推荐，按实际内容和引用核对。'}
   :topics?{requiredNote:topics.closing,sourceEvidenceRange:topics.closingEvidenceRange,noteLocation:'蓝图最后一个教学组的原片收尾回放段 segments[].unknowns'}
   :bound&&closing?{requiredNote:closing.note,sourceEvidenceRange:bound.source_range_seconds,evidenceSegmentId:bound.segment_id}:{}),
 };
}
