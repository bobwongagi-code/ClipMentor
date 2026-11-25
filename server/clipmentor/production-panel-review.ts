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
 const opinionIssue=message.match(/blueprint_opinion_scope_(?:locked|groups|group|overall): ([^\n]+)$/u);
 if(opinionIssue)return {kind:'content',message:opinionIssue[1]+(message.includes('blueprint_repair_no_progress')?' 同一问题再次出现，已暂停，待维护侧核对。':'')} as const;
 if(/suspected_gate_defect|门禁问题/.test(message))
  return {kind:'gate',message:'制作已暂停，需维护侧核对校验。候选和回执已保存。'} as const;
 if(/binding|_scope_|_stale|_schema_|_format|review_reference_invalid|author_self_check_invalid|execution_mapping_repair_no_progress|feedback_(target_missing|unit_placement_missing|execution_targets_required|changed_)|绑定错|版本.*变化|预览.*变化|版本记录不匹配|片尾.*齐备|片尾.*变化|证据.*缺失/i.test(message))
  return {kind:'binding',message:'当前版本的素材绑定或格式需要核对。请先刷新，仍有问题请交维护侧。'} as const;
 if(/(?:teaching_baseline_repair|teaching_final_narration_repair|preview_blueprint_alignment|blueprint_repair)_no_progress/.test(message))
  return {kind:'content',message:'同一缺口再次出现，自动返修已暂停。候选和回执已保存，需维护侧核对。'} as const;
 if(/需补充事实|当前蓝图待独立审核|尚未完成教学自检|needs_revision/.test(message))
  return {kind:'content',message:'当前内容仍有待处理的意见。若有明确的修改要求，请提交对应组的反馈。'} as const;
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

export function bindBlueprintReview(input:unknown,scope:{revision:string;boardIdentity:string;groups:BlueprintReviewGroup[];endings:ReviewEnding[]},confirm:boolean):BlueprintReviewRecord{
 const whole=row(input)&&input.scope==='whole_blueprint';
 if(whole){
  if(!confirm||Object.keys(input).some(key=>key!=='scope'&&key!=='groups')
   ||input.groups!==undefined&&!Array.isArray(input.groups))
   throw new PanelReviewIssue('binding','整份蓝图的确认格式无效。');
 }else if(input!==undefined&&(!row(input)||!Array.isArray(input.groups)||!Array.isArray(input.endingIds)))
  throw new PanelReviewIssue('binding','表态记录格式不完整，请刷新后重新提交。');
 const supplied=row(input)&&Array.isArray(input.groups)?input.groups:[];
 const entries=new Map<string,GroupReview>();
 for(const entry of supplied){
  if(!row(entry)||typeof entry.id!=='string'||!scope.groups.some(g=>g.id===entry.id)||entries.has(entry.id)
    ||typeof entry.decision!=='string'||entry.decision.length>500
    ||(entry.stance!=='accepted'&&entry.stance!=='changes'&&entry.stance!=='pending'))
   throw new PanelReviewIssue('binding','表态不对应当前蓝图的教学组，请刷新后核对。');
  entries.set(entry.id,{id:entry.id,decision:entry.decision.trim(),stance:entry.stance});
 }
 if(confirm){
  if(!scope.groups.length)throw new PanelReviewIssue('binding','当前蓝图没有可核对的教学组。');
  const missing=whole?[]:scope.groups.filter(group=>!entries.get(group.id)?.decision).map(group=>group.label);
  if(missing.length)throw new PanelReviewIssue('content',`请填写${missing.join('、')}教达人改哪个决定，并记录表态。`);
  const undecided=scope.groups.filter(group=>whole?entries.get(group.id)?.stance==='changes':entries.get(group.id)?.stance!=='accepted').map(group=>group.label);
  if(undecided.length)throw new PanelReviewIssue('content',`请先处理${undecided.join('、')}的待定或修改意见。`);
 }
 const selected=row(input)&&Array.isArray(input.endingIds)?input.endingIds:[];
 const endingIds=scope.endings.map(ending=>ending.id);
 if(new Set(selected).size!==selected.length||selected.some(id=>!endingIds.includes(id)))
  throw new PanelReviewIssue('binding','片尾确认与当前蓝图不符，请刷新核对。');
 if(confirm&&!whole&&selected.length!==endingIds.length)
  throw new PanelReviewIssue('content','请先核对两个片尾各自绑定的素材。');
 return {revision:scope.revision,boardIdentity:scope.boardIdentity,groups:scope.groups.flatMap(({id})=>entries.get(id)??[]),
  ...(whole?{scope:'whole_blueprint' as const}:{}),endings:whole?scope.endings:scope.endings.filter(ending=>selected.includes(ending.id))};
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
