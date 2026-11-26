import type {ProjectDoc} from '../../src/editor/types';
import {deliverySectionsFromDoc,endingCardLayout,endingCardSources} from '../../src/clipmentor/delivery-bindings';

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
 if(error instanceof PanelReviewIssue)return {kind:error.kind,message:error.message};
 if(typeof error!=='string'&&!(error instanceof Error))return;
 const message=typeof error==='string'?error:error.message;
 if(/^(?:Error: )?production_source_breakdown_no_progress$/.test(message))
  return {kind:'binding',message:'原片分析已暂停，已上传素材仍在。'} as const;
 const opinionIssue=message.match(/blueprint_opinion_scope_(?:locked|groups|group|overall): ([^\n]+)$/u);
 if(opinionIssue)return {kind:'content',message:opinionIssue[1]+(message.includes('blueprint_repair_no_progress')?' 同一问题再次出现，修改已暂停。':'')} as const;
 if(/suspected_gate_defect|门禁问题/.test(message))
  return {kind:'gate',message:'制作已暂停，当前进度已保存。'} as const;
 if(/binding|_scope_|_stale|_schema_|_format|review_reference_invalid|author_self_check_invalid|execution_mapping_repair_no_progress|feedback_(target_missing|unit_placement_missing|execution_targets_required|changed_)|绑定错|版本.*变化|预览.*变化|版本记录不匹配|片尾.*齐备|片尾.*变化|证据.*缺失/i.test(message))
  return {kind:'binding',message:'请刷新后查看当前版本。'} as const;
 if(/(?:teaching_baseline_repair|teaching_final_narration_repair|preview_blueprint_alignment|blueprint_repair)_no_progress/.test(message))
  return {kind:'content',message:'同一问题再次出现，修改已暂停。'} as const;
 if(/需补充事实|当前蓝图待独立审核|尚未完成教学自检|needs_revision/.test(message))
  return {kind:'content',message:'请查看当前蓝图，按需提交修改意见。'} as const;
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
   return {id:asset_id,name:asset?.name||'已绑定素材'};
  })}];
 });
}

export function assertWholeBlueprintConfirmation(input:unknown){
 if(!row(input)||input.scope!=='whole_blueprint'||Object.keys(input).length!==1)
  throw new PanelReviewIssue('binding','请刷新蓝图后重新确认。');
}

export function bindBlueprintReview(input:unknown,scope:{
 revision:string;boardIdentity:string;groups:BlueprintReviewGroup[];endings:ReviewEnding[];
}):BlueprintReviewRecord{
 assertWholeBlueprintConfirmation(input);
 if(!scope.groups.length)throw new PanelReviewIssue('binding','当前蓝图没有可审核的讲解。');
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
 throw new PanelReviewIssue('binding','请选择当前版本中的反馈位置，或明确确认这条意见作用于整体。');
}
