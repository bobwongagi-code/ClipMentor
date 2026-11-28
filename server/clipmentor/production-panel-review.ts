import type {ProjectDoc} from '../../src/editor/types';
import {deliverySectionsFromDoc,endingCardLayout,endingCardSources} from '../../src/clipmentor/delivery-bindings';
import {opinionScopeText,readReviewIssue,reviewMessages as copy} from '../../shared/clipmentor-review-feedback';

export type BlueprintReviewGroup = {id:string;label:string};
type GroupReview = {id:string;decision:string;stance:'accepted'|'changes'|'pending'};
type ReviewEnding = {id:string;label:string;materials:Array<{id:string;name:string}>};
export type BlueprintReviewRecord = {revision:string;boardIdentity:string;scope?:'whole_blueprint';groups:GroupReview[];endings:ReviewEnding[]};
type ReviewIssueKind = 'content'|'gate'|'binding';

export class PanelReviewIssue extends Error {
 readonly kind:ReviewIssueKind;
 constructor(kind:ReviewIssueKind,message:string){super(message);this.kind=kind;}
}

const row=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);

export function panelReviewIssue(error:unknown){
 if(error instanceof PanelReviewIssue)return readReviewIssue(error);
 if(typeof error!=='string'&&!(error instanceof Error))return;
 const message=typeof error==='string'?error:error.message;
 if(/^(?:Error: )?production_reference_retry_no_progress$/.test(message))
  return {kind:'binding',message:'同一处引用补调后仍未通过。已保留回执，待维护侧核对。'} as const;
 if(/^(?:Error: )?production_reference_repair_confirmed_teaching_changed$/.test(message))
  return {kind:'binding',message:copy.choicesRetained} as const;
 if(/^(?:Error: )?production_source_breakdown_no_progress$/.test(message))
  return {kind:'binding',message:copy.analysisPaused} as const;
 if(/^(?:Error: )?creator_opening_metrics_unconfirmed\b/u.test(message))
  return {kind:'content',message:copy.openingPerformanceMissing} as const;
 if(/^(?:Error: )?(?:creator_quality_repair_no_progress|creator_incomplete_review_with_rejection)\b/u.test(message))
  return {kind:'content',message:copy.sameIssue} as const;
 const opinionIssue=message.match(/^(?:Error: )?(blueprint_repair_no_progress )?blueprint_opinion_scope_(?:locked|groups|group|overall): ([^\r\n]+)$/u);
 if(opinionIssue&&opinionScopeText.test(opinionIssue[2]))return {kind:'content',message:opinionIssue[2]+(opinionIssue[1]?' 同一问题再次出现，修改已暂停。':'')} as const;
 if(/suspected_gate_defect|门禁问题|teaching_confirmed_scope_requires_maintenance|teaching_whole_film_confirmed_criterion_invalid|production_confirmed_groups_(missing|changed)|confirmed_copy_review_reference_binding_invalid/.test(message))
  return {kind:'gate',message:copy.paused} as const;
 if(/^(?:Error: )?copy_review_confirmed_selection_conflict$/.test(message))
  return {kind:'gate',message:copy.choicesRetained} as const;
 if(/production_opening_underlay_shortfall/.test(message))
  return {kind:'binding',message:copy.openingPaused} as const;
 if(message.includes('preview_shared_body_requires_reconciliation'))
  return {kind:'content',message:copy.bothPreviews} as const;
 if(/preview_review_(?:receipt_unavailable|timeout_unconfirmed|incomplete_generation|invalid_judgment_schema|evidence_unverified)|preview_retry_original_outcome_unavailable/.test(message))
  return {kind:'binding',message:copy.reviewPaused} as const;
 if(/production_confirmed_teaching_baseline_changed/.test(message))
  return {kind:'gate',message:copy.choicesRetained} as const;
 if(message==='feedback_range_targets_required')return {kind:'binding',message:copy.feedbackRangeEmpty} as const;
 if(/binding|_scope_|_stale|_schema_|_format|review_reference_invalid|author_self_check_invalid|execution_mapping_repair_no_progress|feedback_(target_missing|unit_placement_missing|execution_targets_required|changed_)|绑定错|版本.*变化|预览.*变化|版本记录不匹配|片尾.*齐备|片尾.*变化|证据.*缺失/i.test(message))
  return {kind:'binding',message:copy.updated} as const;
 if(/(?:teaching_baseline_repair|teaching_final_narration_repair|preview_blueprint_alignment|blueprint_repair)_no_progress/.test(message))
  return {kind:'content',message:copy.sameIssue} as const;
 if(/需补充事实|当前蓝图待独立审核|尚未完成教学自检|needs_revision/.test(message))
  return {kind:'content',message:copy.checkBoard} as const;
}

export function blueprintReviewGroups(doc:ProjectDoc):BlueprintReviewGroup[]{
 // Delivery sections and original-source notes are not teaching groups.
 return (doc.clipMentorAnalysis?.source_breakdown?.units??[]).map(({unit_id},index)=>({id:unit_id,label:`第 ${index+1} 组`}));
}

export function blueprintReviewEndings(doc:ProjectDoc):ReviewEnding[]{
 return deliverySectionsFromDoc(doc).flatMap(section=>{
  const id=section.section_id;
  if(section.kind!=='creator_invitation'||!['existing_partner','new_contact'].includes(id))return [];
  const layout=endingCardLayout(section.picture.layout);
  const assets=layout?endingCardSources(layout):[section.picture];
  return [{id,label:id==='existing_partner'?'已合作达人版':'新建联达人版',materials:assets.map(({asset_id})=>{
   const asset=doc.assets.find(a=>a.id===asset_id);
   return {id:asset_id,name:asset?.name||'片尾素材'};
  })}];
 });
}

export function assertWholeBlueprintConfirmation(input:unknown){
 if(!row(input)||input.scope!=='whole_blueprint'||Object.keys(input).length!==1)
  throw new PanelReviewIssue('binding',copy.refreshBoard);
}

export function bindBlueprintReview(input:unknown,scope:{
 revision:string;boardIdentity:string;groups:BlueprintReviewGroup[];endings:ReviewEnding[];
}):BlueprintReviewRecord{
 assertWholeBlueprintConfirmation(input);
 if(!scope.groups.length)throw new PanelReviewIssue('binding',copy.emptyBoard);
 return {revision:scope.revision,boardIdentity:scope.boardIdentity,scope:'whole_blueprint',
  groups:[],endings:scope.endings};
}

export function panelFeedbackTarget(value:unknown,groups:BlueprintReviewGroup[],preview:boolean){
 if(row(value)&&value.scope==='whole'&&value.confirmed===true)return {unitIds:undefined,range:undefined,kind:'content' as const};
 if(row(value)&&value.scope==='group'&&typeof value.unitId==='string'&&groups.some(group=>group.id===value.unitId)
  &&(value.kind===undefined||value.kind==='content'||preview&&value.kind==='execution'))
  return {unitIds:[value.unitId],range:undefined,kind:preview&&value.kind==='execution'?'execution' as const:'content' as const};
 if(preview&&row(value)&&value.scope==='range'&&typeof value.start==='number'&&typeof value.end==='number'
   &&Number.isFinite(value.start)&&Number.isFinite(value.end)&&value.start>=0&&value.end>value.start)
  return {unitIds:undefined,range:[value.start,value.end] as [number,number],kind:'execution' as const};
 throw new PanelReviewIssue('binding',copy.feedbackTarget);
}
