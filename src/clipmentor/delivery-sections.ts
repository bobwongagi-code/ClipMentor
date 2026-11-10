import { deliveryCropShape as cropShape, deliveryAudio, deliverySectionsFromDoc, deliveryPictureRanges, deliveryRangesCovered, nativeDeliveryPicture, type DeliverySection } from './delivery-bindings';
export { deliveryAudio, deliverySectionsFromDoc, deliverySectionsShape, assertDeliveryPicturePreservation, type DeliverySection } from './delivery-bindings';
import type { ProjectDoc } from '../editor/types';
import { renderedVisualFrameRect } from '../editor/visualFrameGeometry';
import { flexCropRect, PREVIEW_CROP_MIN_SPAN } from '../editor/flexCrop';
import { isBackgroundFillActive } from '../editor/backgroundFill';
import { timelineTrackIds } from '../editor/timelineTypes';
type Row=Record<string,unknown>;
const row=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown):v is string=>typeof v==='string'&&!!v.trim();
const strings=(v:unknown):v is string[]=>Array.isArray(v)&&v.length>0&&v.every(text)&&new Set(v).size===v.length;
export function deliveryReview(sections:DeliverySection[],raw:unknown):{verdict:'pass'|'needs_revision'|'insufficient_evidence';issues:string[]}{
 if(!sections.length)return {verdict:raw===undefined?'pass':'insufficient_evidence',issues:raw===undefined?[]:['unexpected_delivery_review']};
 if(!Array.isArray(raw)||raw.length!==sections.length||new Set(raw.filter(row).map(r=>r.section_id)).size!==sections.length)return{verdict:'insufficient_evidence',issues:['delivery_review_missing_or_duplicate']};
 let verdict:'pass'|'needs_revision'|'insufficient_evidence'='pass';const issues:string[]=[];
 for(const s of sections){
  const r=raw.find(r=>row(r)&&r.section_id===s.section_id);
  if(!row(r)||!['pass','needs_revision','insufficient_evidence'].includes(String(r.verdict))||!['supported','uncertain','contradicted'].includes(String(r.claims_supported))||typeof r.purpose_clear!=='boolean'||!text(r.reason)
   ||!strings(r.evidence_ids)||r.evidence_ids.length!==s.evidence_ids.length||r.evidence_ids.some(id=>!s.evidence_ids.includes(id))||!Array.isArray(r.narration_checks)||r.narration_checks.length!==1){issues.push(s.section_id+':incomplete');if(verdict!=='needs_revision')verdict='insufficient_evidence';continue;}
  const n=r.narration_checks[0];
  if(!row(n)||n.line_id!==s.line.line_id||!['necessary','redundant','uncertain'].includes(String(n.necessity))||!['natural','awkward','uncertain'].includes(String(n.naturalness))||!text(n.omission_loss)||!text(n.reason)){issues.push(s.section_id+':narration_incomplete');if(verdict!=='needs_revision')verdict='insufficient_evidence';continue;}
  if(r.verdict==='needs_revision'||r.claims_supported==='contradicted'||!r.purpose_clear||n.necessity==='redundant'||n.naturalness==='awkward'){issues.push(s.section_id+':needs_revision');verdict='needs_revision';}
  else if(r.verdict!=='pass'||r.claims_supported!=='supported'||n.necessity!=='necessary'||n.naturalness!=='natural'){issues.push(s.section_id+':uncertain');if(verdict!=='needs_revision')verdict='insufficient_evidence';}
 }
 return{verdict,issues};
}
/** The plan uses original-image margins; edit_item uses composition pixels.
 * Resolve through the same fitted source rectangle as preview and export.
 * This is a derived view, not a plan revision or an instruction to edit. */
export function deliveryPictureBinding(doc:ProjectDoc,s:DeliverySection){
 const timeline=doc.timelines.find(t=>t.id===doc.activeTimelineId),asset=doc.assets.find(a=>a.id===s.picture.asset_id);
 const crop=s.picture.crop;
 if(!timeline||![timeline.width,timeline.height].every(n=>Number.isSafeInteger(n)&&n>0))throw new Error('delivery_crop_canvas_missing');
 if(!asset||asset.kind!=='image'||asset.src!==s.picture.src||asset.sourceContentHash!==s.picture.sha256
  ||![asset.width,asset.height].every(n=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0))throw new Error('delivery_crop_source_dimensions_missing');
 if(!cropShape(crop))throw new Error('delivery_crop_invalid');
 const width=asset.width!,height=asset.height!;
 // The existing review extractor rounds x/y and width/height at original resolution.
 const source_rect={x:Math.round(width*crop!.left),y:Math.round(height*crop!.top),width:Math.round(width*(1-crop!.left-crop!.right)),height:Math.round(height*(1-crop!.top-crop!.bottom))};
 if(source_rect.width<=0||source_rect.height<=0||source_rect.x+source_rect.width>width||source_rect.y+source_rect.height>height)throw new Error('delivery_crop_source_rect_invalid');
 const fit=timeline.fit??'contain';if(fit!=='contain'&&fit!=='cover')throw new Error('delivery_crop_fit_invalid');
 // Contain is painted into the renderer's integer fitted box. Cover is a
 // replaced element in a canvas-sized box, so its object-fit scale is fractional.
 const scale=Math.max(timeline.width/width,timeline.height/height);
 const fitted=fit==='cover'?{x:(timeline.width-width*scale)/2,y:(timeline.height-height*scale)/2,width:width*scale,height:height*scale}
  :renderedVisualFrameRect(timeline,{width,height},fit);
 const left=Math.round(fitted.x+source_rect.x/width*fitted.width),top=Math.round(fitted.y+source_rect.y/height*fitted.height);
 const right=timeline.width-Math.round(fitted.x+(source_rect.x+source_rect.width)/width*fitted.width);
 const bottom=timeline.height-Math.round(fitted.y+(source_rect.y+source_rect.height)/height*fitted.height);
 if([left,top,right,bottom].some(n=>n<0)||left+right>=timeline.width||top+bottom>=timeline.height)throw new Error('delivery_crop_outside_canvas');
 if((timeline.width-left-right)/timeline.width<PREVIEW_CROP_MIN_SPAN||(timeline.height-top-bottom)/timeline.height<PREVIEW_CROP_MIN_SPAN)throw new Error('delivery_crop_below_editor_minimum');
 const transform_crop={left:left/timeline.width,top:top/timeline.height,right:right/timeline.width,bottom:bottom/timeline.height};
 return {section_id:s.section_id,asset_id:asset.id,source_dimensions:{width,height},canvas_dimensions:{width:timeline.width,height:timeline.height},fit,
  source_rect,canvas_rect:flexCropRect(transform_crop,timeline.width,timeline.height),
  tool_crop_px:{left,top,right,bottom},transform_crop};
}
function commissionCropBindings(doc:ProjectDoc,s:DeliverySection){
 const layout=s.picture.layout;
 if(layout?.kind!=='product_commission')return;
 const bind=(crop:typeof layout.product_crop)=>deliveryPictureBinding(doc,{...s,picture:{...s.picture,crop}});
 return {product:bind(layout.product_crop),commission:bind(layout.commission_crop)};
}
export function deliveryPictureBindings(doc:ProjectDoc,sections?:DeliverySection[]){
 try{return(sections??deliverySectionsFromDoc(doc)).filter(s=>s.picture.crop||s.picture.display||s.picture.layout?.kind==='product_commission').map(s=>{
  try{
   if(s.picture.display)deliveryPictureRanges(s,deliveryAudio(doc,s).frames,doc.timelines.find(t=>t.id===doc.activeTimelineId)?.fps??0);
   const roles=commissionCropBindings(doc,s);
   return{status:'ready' as const,...(s.picture.crop?deliveryPictureBinding(doc,s):{section_id:s.section_id,asset_id:s.picture.asset_id}),
    ...(s.picture.display?{display:structuredClone(s.picture.display)}:{}),...(roles?{roles}:{})};}
  catch(e){return{status:'unavailable' as const,section_id:s.section_id,reason:e instanceof Error?e.message:'delivery_crop_invalid'};}
 });}catch(e){return[{status:'unavailable' as const,reason:e instanceof Error?e.message:'delivery_crop_invalid'}];}
}
export function deliveryTimeline(doc:ProjectDoc,sections=deliverySectionsFromDoc(doc),nativePlacements?:Record<string,{explanation_frames:[number,number]}>){
 const timeline=doc.timelines.find(t=>t.id===doc.activeTimelineId);const issues:string[]=[];
 if(!sections.length)return{offset:0,issues};
 if(sections.filter(s=>s.kind==='creator_invitation').length>1)return{offset:0,issues:['delivery_timeline_requires_one_audience']};
 if(!timeline)return{offset:0,issues:['delivery_timeline_missing']};
 const opening=sections.find(s=>s.kind==='performance_opening');let offset=0;
 try{if(opening)offset=deliveryAudio(doc,opening).frames;}catch(e){issues.push(String(e));}
 let middleEnd=0;
 for(const u of doc.clipMentorAnalysis?.blueprint??[]){
  const actual=nativePlacements?.[u.unit_id];
  if(actual){middleEnd=Math.max(middleEnd,actual.explanation_frames[1]-offset);continue;}
  const i=(u as unknown as Row).internal_review;if(!row(i))continue;const p=i[String(i.current_picture_plan)];
  try{const d=row(p)&&row(p.composition)&&typeof p.composition.detail==='string'?JSON.parse(p.composition.detail):null;
   for(const r of d?.production_rows??[])middleEnd=Math.max(middleEnd,Number(r.output_frames_reference?.[1])||0);
  }catch{issues.push('delivery_middle_rows_invalid');}
 }
 for(const s of sections){
  try{const a=deliveryAudio(doc,s),start=s.kind==='performance_opening'?0:offset+middleEnd,end=start+a.frames;
   const visible=(i:typeof timeline.items[number])=>!timeline.tracks?.[i.track]?.hidden&&i.transform?.opacity!==0;
   const audios=timeline.items.filter(i=>i.kind==='audio'&&i.sourceAssetId===a.asset.id&&visible(i));
   if(audios.length!==1||audios[0].src!==a.asset.src||audios[0].startFrame!==start||audios[0].durationInFrames!==a.frames||(audios[0].srcInFrame??0)!==0||(audios[0].playbackRate??1)!==1||timeline.tracks?.[audios[0].track]?.muted||!Number.isFinite(audios[0].volume??1)||(audios[0].volume??1)<=0)issues.push('delivery_audio_placement:'+s.section_id);
   const required=deliveryPictureRanges(s,a.frames,timeline.fps,start);
   const pictures=timeline.items.filter(i=>nativeDeliveryPicture(doc,timeline,i,s)&&i.startFrame<end&&i.startFrame+i.durationInFrames>start);
   const matchesCrop=(i:typeof pictures[number],binding:ReturnType<typeof deliveryPictureBinding>|null)=>{
    if(!binding)return !i.transform?.crop;
    // An inner zoom changes which source pixels lie behind the fixed clip path;
    // a full-poster background can reveal material excluded by the approved crop.
    if(i.width!==binding.source_dimensions.width||i.height!==binding.source_dimensions.height||!i.transform?.crop||i.zoom||isBackgroundFillActive(timeline,i))return false;
    const actual=i.transform.crop;
    if(Object.values(actual).some(v=>typeof v!=='number'||!Number.isFinite(v)))return false;
    const rectangle=flexCropRect(actual,timeline.width,timeline.height);
    if(!['x','y','width','height'].every(k=>rectangle[k as keyof typeof rectangle]===binding.canvas_rect[k as keyof typeof rectangle]))return false;
    // Static placement is allowed after clipping, provided it does not push any
    // approved source pixels off-screen. Animated geometry needs its own check.
    if(['x','y','scale','scaleX','scaleY','rotation'].some(k=>(i.keyframes?.[k as keyof typeof i.keyframes]?.length??0)>0))return false;
    const t=i.transform,sx=t.scaleX??t.scale??1,sy=t.scaleY??t.scale??1,x=t.x??0,y=t.y??0,angle=(t.rotation??0)*Math.PI/180;
    if(![sx,sy,x,y,angle].every(Number.isFinite)||sx<=0||sy<=0)return false;
    return [rectangle.x,rectangle.x+rectangle.width].every(px=>[rectangle.y,rectangle.y+rectangle.height].every(py=>{
     const dx=(px-timeline.width/2)*sx,dy=(py-timeline.height/2)*sy;
     const ox=timeline.width/2+x*timeline.width/100+dx*Math.cos(angle)-dy*Math.sin(angle);
     const oy=timeline.height/2+y*timeline.height/100+dx*Math.sin(angle)+dy*Math.cos(angle);
     return ox>=-1e-6&&oy>=-1e-6&&ox<=timeline.width+1e-6&&oy<=timeline.height+1e-6;
    }));
   };
   const layout=s.picture.layout;
   if(layout?.kind==='recruitment_card'||layout?.kind==='product_storyboard'){
    const wholePoster=layout.kind==='recruitment_card'&&layout.poster.asset_id===s.picture.asset_id;
    const ranges=pictures.filter(i=>{
     const t=i.transform??{};
     return (!wholePoster||timeline.fit!=='cover')&&!t.crop&&!i.zoom&&!isBackgroundFillActive(timeline,i)&&!(t.x||t.y||t.rotation)
      &&[t.scale,t.scaleX,t.scaleY,t.opacity].every(v=>v===undefined||v===1)
      &&!Object.values(i.keyframes??{}).some(k=>k?.length);
    }).map(i=>[i.startFrame,i.startFrame+i.durationInFrames] as [number,number]);
    if(!deliveryRangesCovered(required,ranges))issues.push('delivery_ending_card_not_preserved:'+s.section_id);
    continue;
   }
   const visibleBounds=(i:typeof pictures[number],rect:{x:number;y:number;width:number;height:number})=>{
    const t=i.transform??{};
    if(t.rotation||i.zoom||(t.opacity??1)<0.95||Object.values(i.keyframes??{}).some(k=>k?.length))return;
    const sx=t.scaleX??t.scale??1,sy=t.scaleY??t.scale??1;
    const x=timeline.width/2+(rect.x-timeline.width/2)*sx+(t.x??0)*timeline.width/100;
    const y=timeline.height/2+(rect.y-timeline.height/2)*sy+(t.y??0)*timeline.height/100;
    const w=rect.width*sx,h=rect.height*sy;
    if(![x,y,w,h].every(Number.isFinite)||x<0||y<0||x+w>timeline.width+1e-6||y+h>timeline.height+1e-6
     ||w<timeline.width*0.15||h<timeline.height*0.035)return;
    return {top:y,bottom:y+h};
   };
   if(layout?.kind==='product_commission'){
    const {product,commission}=commissionCropBindings(doc,s)!;
    const parts=[product,commission].map(binding=>pictures.flatMap(i=>{
     const bounds=matchesCrop(i,binding)&&visibleBounds(i,binding.canvas_rect);
     return bounds?[{item:i,...bounds}]:[];
    }));
    const common=parts[0].flatMap(product=>parts[1].flatMap(commission=>product.bottom>commission.top?[]:[[
     Math.max(product.item.startFrame,commission.item.startFrame),
     Math.min(product.item.startFrame+product.item.durationInFrames,commission.item.startFrame+commission.item.durationInFrames),
    ] as [number,number]]));
    if(!deliveryRangesCovered([[start,end]],common))issues.push('delivery_new_contact_product_or_commission_missing');
    continue;
   }
   if(layout?.kind==='original_underlay'){
    const tracks=timelineTrackIds(timeline),endOf=(i:typeof pictures[number])=>i.startFrame+i.durationInFrames;
    const source=timeline.items.find(i=>i.kind==='video'&&visible(i)&&i.sourceAssetId===layout.source.asset_id&&i.src===layout.source.src
     &&i.startFrame===start&&endOf(i)===end&&(i.playbackRate??1)===1&&(i.srcInFrame??0)>=Math.round(layout.range[0]*timeline.fps)
     &&(i.srcInFrame??0)+i.durationInFrames<=Math.round(layout.range[1]*timeline.fps));
    const matte=source&&timeline.items.find(i=>i.kind==='solid'&&visible(i)&&i.startFrame===start&&endOf(i)<=end&&endOf(i)>start
     &&['#000','#000000','black'].includes(String(i.props?.color).toLowerCase())
     &&Math.abs((i.transform?.opacity??1)-layout.shade)<0.01&&tracks.indexOf(i.track)<tracks.indexOf(source.track)
     &&!(i.transform?.x||i.transform?.y||i.transform?.rotation||i.transform?.crop)
     &&[i.transform?.scale,i.transform?.scaleX,i.transform?.scaleY].every(n=>n===undefined||n===1)
     &&!Object.values(i.keyframes??{}).some(v=>v?.length));
    if(!source||!matte)issues.push('delivery_opening_original_underlay_or_matte_missing');
    if(layout.show_sales){
     const ranges=pictures.filter(i=>matte&&tracks.indexOf(i.track)<tracks.indexOf(matte.track)&&matchesCrop(i,null)
      &&typeof i.width==='number'&&typeof i.height==='number'&&visibleBounds(i,renderedVisualFrameRect(timeline,{width:i.width,height:i.height},'contain')))
      .map(i=>[i.startFrame,endOf(i)] as [number,number]);
     const expected=s.picture.display?required:matte?[[start,endOf(matte)] as [number,number]]:[];
     if(!expected.length||expected[0][0]!==start||expected.at(-1)![1]>=end
      ||!deliveryRangesCovered(expected,ranges)||!deliveryRangesCovered(ranges,expected)||ranges.length!==pictures.length
      ||matte&&!deliveryRangesCovered(expected,[[start,endOf(matte)]]))
      issues.push('delivery_opening_sales_layer_or_exit_missing');
    }else if(pictures.length)issues.push('delivery_opening_unplanned_product_picture');
    continue;
   }
   const binding=s.picture.crop?deliveryPictureBinding(doc,s):null;
   const valid=pictures.filter(i=>matchesCrop(i,binding));
   const ranges=valid.map(i=>[i.startFrame,i.startFrame+i.durationInFrames] as [number,number]);
   const actual=pictures.map(i=>[Math.max(start,i.startFrame),Math.min(end,i.startFrame+i.durationInFrames)] as [number,number]);
   if(!deliveryRangesCovered(required,ranges)||(s.picture.display&&!deliveryRangesCovered(actual,required)))issues.push('delivery_picture_missing_or_crop_mismatch:'+s.section_id);
  }catch(e){issues.push(String(e));}
 }
 return{offset,issues};
}
export const DELIVERY_REVIEW_CRITERIA=`材料如有delivery_sections，是成绩片头或对达人的行动邀请，不是原片教学点。审数字口径与用户事实/截图一致、商品和行动清楚、马来语自然、计划画面可承载。不要要求邀请句新增教学知识，不把消费者促单和达人邀请混算。成绩开场可提问、对比或普通报数，不强制句式。对比或“很多人在卖”等前提必须有给定证据支持，无证据记claims_supported:uncertain，不能因使用问句而省略核实。不得暗示其他视频表现差或拆解能证明成交原因；有此暗示记needs_revision，并在reason引用具体措辞与依据。邀请看拍法不等于承诺解释成交原因。evidence为用户提供的业务事实，不当成外部独立验证或当前佣金承诺。另在JSON顶层返回delivery_checks，逐section恰好一次：{section_id,verdict:pass/needs_revision/insufficient_evidence,claims_supported:supported/uncertain/contradicted,purpose_clear:boolean,evidence_ids:[本段所用证据ID],reason:具体依据,narration_checks:[{line_id,necessity:necessary/redundant/uncertain,omission_loss:删去后损失的成绩背景或行动信息,naturalness:natural/awkward/uncertain,reason:具体依据}]}。必须看给定素材图片及裁切，不签发成片验收，不改稿。`;
/** Criteria are part of the existing review digest; changed criteria invalidate prior delivery approvals. */
export function deliveryReviewCriteria(sections: readonly DeliverySection[]): string {
 const audienceChecks=sections.some(s=>s.section_id==='new_contact')&&sections.some(s=>s.section_id==='existing_partner')
  ? '\n本材料的两个达人片尾独立审。new_contact 核实际招商海报与联系合作的行动、可见佣金是否准确及广告预算有无被说成个人保证。existing_partner 核是否用本商品原片 Storyboard 承接开拍，不假设已到货。片头核同款提问是否保留，以及没有已绑定的本视频成绩证据时是否删去归属于该视频的数字。'
  : '';
 const layeredChecks=sections.some(s=>s.picture.layout)
  ? '\n计划整屏以 planned_composition 图片核对。片头要看到压暗原片、可读的已确认成绩前景（仅 show_sales 时）及回到原片的分段，不能用电商静图充当底层。新建联同一屏必须认得商品与已确认佣金，只有佣金条时记 needs_revision。已合作核本片拍摄参考和开拍动作。整屏图只证明计划构图，实际音画时机留到成片。'
  : '';
 return DELIVERY_REVIEW_CRITERIA + audienceChecks + layeredChecks + (sections.some(s=>s.picture.display)
  ? '\n若picture.display存在，fps是范围帧率，ranges为相对于本段音频起点的半开帧区间。逐段核对图片出现、退出与后续文字/画面的分工是否讲得通；不能以整句总时长替代这些阶段，也不能仅凭区间合法认定语义通过。范围缺失仍按全段要求，不从描述或代码猜范围。'
  : '');
}
