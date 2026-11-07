import {findGenericItem} from '../agent/tools/edit-item-generic-result';
import type {ProjectDoc} from '../editor/types';
import {deliveryPictureBindings,deliverySectionsFromDoc,deliveryAudio} from './delivery-sections';
import {deliveryPictureRanges,deliveryRangesCovered} from './delivery-bindings';

type Row=Record<string,unknown>;
const row=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v);
const canonical=(v:unknown):string=>Array.isArray(v)?`[${v.map(canonical).join(',')}]`:row(v)?`{${Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')}}`:JSON.stringify(v)??'null';
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const norm=(s:string)=>s.replace(/\s+/gu,' ').trim();
function plans(doc:ProjectDoc){return (doc.clipMentorAnalysis?.blueprint??[]).flatMap(u=>{
 const i=(u as unknown as Row).internal_review as Row|undefined,p=i?.[String(i.current_picture_plan)],c=i?.[String(i.current_script_candidate)];
 if(!row(p)||!row(c)||!Array.isArray(c.lines)||p.script_candidate_id!==i?.current_script_candidate)return[];
 let detail:Row={};try{if(row(p.composition)&&typeof p.composition.detail==='string'){const parsed:unknown=JSON.parse(p.composition.detail);if(row(parsed))detail=parsed;}}catch{/* Free prose remains free prose; never execute it. */}
 return [{unit_id:u.unit_id,plan:p,lines:c.lines.filter(row),detail}];
 });}
/** Resolve existing edit_item parameters from current saved decisions, not model-written equivalents.
 * No new operation/schema. Only unambiguously identified audio, image crop and plain caption style
 * are filled. MG code, prose timing, placement and unresolved creative choices are not inferred.
 */
export function resolveFrozenEditParameters(doc:ProjectDoc,args:Row):Row{
 const t=doc.timelines.find(t=>t.id===doc.activeTimelineId);if(!t||!doc.clipMentorAnalysis)return args;
 const current=plans(doc),cropBindings=deliveryPictureBindings(doc),sections=deliverySectionsFromDoc(doc);

 const result=structuredClone(args);
 const fixed=(entry:Row,key:string,value:unknown,where:string)=>{
  if(entry[key]!==undefined&&!same(entry[key],value))throw new Error(`frozen_parameter_conflict:${where}:${key}`);
  entry[key]=value;
 };
 for(const bucket of ['adds','updates'] as const){
  if(!Array.isArray(result[bucket]))continue;
  for(const [index,e] of result[bucket].entries()){
   if(!row(e))continue;
   const rawId=e.itemId??e.id??e.targetItemId;
   const item=findGenericItem(t.items,rawId==='selected'||rawId===undefined?t.selectedId:rawId);
   const assetId=typeof e.assetId==='string'?e.assetId:item?.sourceAssetId;
   const where=`${bucket}[${index}]`;
   const kind=e.type??(bucket==='updates'?item?.kind:undefined);
   if(kind==='audio'&&assetId){
    const asset=doc.assets.find(a=>a.id===assetId&&a.kind==='audio');
    const narrations=current.flatMap(p=>p.lines.map(l=>l.narration_ms));
    let measured=false;
    if(asset){
     const g=asset.props?.generation as Row|undefined;
     measured=!!g&&narrations.includes(g.text)&&g.speed===1&&typeof g.durationSeconds==='number'&&Number.isFinite(g.durationSeconds)&&g.durationSeconds>0&&Math.abs(asset.durationInFrames-g.durationSeconds*t.fps)<=1;
     if(!g)measured=current.some(p=>Array.isArray(p.detail.measured_audio_bindings)&&p.detail.measured_audio_bindings.some(b=>row(b)&&b.assetId===asset.id&&b.src===asset.src&&narrations.includes(b.text)&&b.playback_rate===1&&b.full_file_untrimmed===true&&typeof b.audioSha256==='string'&&/^[a-f0-9]{64}$/.test(b.audioSha256)&&typeof b.durationSeconds==='number'&&b.durationSeconds>0&&Math.abs(asset.durationInFrames-b.durationSeconds*t.fps)<=1));
    }
    if(asset&&measured){
     if(e.operation!==undefined||['sourceStartMs','sourceEndMs','sourceStartSeconds','sourceEndSeconds'].some(k=>e[k]!==undefined))throw new Error(`frozen_parameter_conflict:${where}:narration_source_operation`);
     for(const k of ['speed','playbackRate'])if(e[k]!==undefined&&e[k]!==1)throw new Error(`frozen_parameter_conflict:${where}:${k}`);
     for(const k of ['srcInFrame','sourceStartFrame'])if(e[k]!==undefined&&e[k]!==0)throw new Error(`frozen_parameter_conflict:${where}:${k}`);
     if(e.sourceDurationInFrames!==undefined&&e.sourceDurationInFrames!==asset.durationInFrames)throw new Error(`frozen_parameter_conflict:${where}:sourceDurationInFrames`);
     if(e.sourceDurationInFrames===undefined)fixed(e,'durationInFrames',asset.durationInFrames,where);
     // Adds default to the entire file, rate 1 and in-point 0 in the existing media validator.
     if(bucket==='updates'){fixed(e,'srcInFrame',0,where);fixed(e,'playbackRate',1,where);}
    }
   }

   if(bucket==='updates'&&kind==='image'&&assetId){
    const candidates=cropBindings.filter(b=>{
     if(b.status!=='ready'||!('asset_id' in b)||b.asset_id!==assetId)return false;
     const section=sections.find(s=>s.section_id===b.section_id);if(!section||!item)return false;
     try{const audio=deliveryAudio(doc,section),anchors=t.items.filter(i=>i.kind==='audio'&&i.sourceAssetId===audio.asset.id);
      const start=Number(e.fromFrame??e.startFrame??item.startFrame),end=start+Number(e.durationInFrames??item.durationInFrames);
      return anchors.some(i=>deliveryRangesCovered([[start,end]],deliveryPictureRanges(section,audio.frames,t.fps,i.startFrame)));
     }catch{return false;}
    });
    if(candidates.some(b=>'tool_crop_px' in b&&'tool_crop_px' in candidates[0]&&!same(b.tool_crop_px,candidates[0].tool_crop_px)))throw new Error(`frozen_parameter_ambiguous:${where}:picture_crop`);
    const binding=candidates[0];
    if(binding&&'tool_crop_px' in binding){
     if(e.transform!==undefined&&!row(e.transform))throw new Error(`frozen_parameter_conflict:${where}:transform`);
     const transform=row(e.transform)?e.transform:{};
     if(transform.flexCrop!==undefined&&!same(transform.flexCrop,binding.tool_crop_px))throw new Error(`frozen_parameter_conflict:${where}:flexCrop`);
     fixed(transform,'crop',binding.tool_crop_px,where);e.transform=transform;
    }
   }
   if(kind==='text'){
    const text=typeof e.text==='string'?e.text:row(e.props)&&typeof e.props.text==='string'?e.props.text:item?.props?.text;
    if(typeof text!=='string')continue;
    const styles=current.flatMap(p=>{
     if(!p.lines.some(l=>Array.isArray(l.caption_lines)&&[...l.caption_lines,l.caption_lines.join(' ')].some(x=>typeof x==='string'&&norm(x)===norm(text))))return[];
     const spec=p.detail.layout_spec;
     if(!row(spec)||!row(spec.explanation)||!row(spec.explanation.caption_text))return[];
     const c=spec.explanation.caption_text;
     // These are supported native TextItem fields; rect/padding/MG layout stay in the saved plan.
     return [Object.fromEntries([['fontSize',c.font_size],['color',c.color]].filter(([,v])=>v!==undefined))];
    });
    if(!styles.length)continue;
    if(styles.some(s=>!same(s,styles[0])))throw new Error(`frozen_parameter_ambiguous:${where}:caption_style`);
    const target=bucket==='adds'?e:row(e.props)?e.props:{};
    for(const [k,v] of Object.entries(styles[0]))fixed(target,k,v,where);
    if(bucket==='updates')e.props=target;
   }
  }
 }
 return result;
}

/** Existing native items are addressed by exact ID. No allocation or semantic source selection. */
export function frozenParameterEdits(doc:ProjectDoc):Row{
 const t=doc.timelines.find(t=>t.id===doc.activeTimelineId);if(!t)return {updates:[]};
 const updates:Row[]=[];
 const targets=t.items.filter(item=>['audio','image','text'].includes(item.kind));
 const resolved=resolveFrozenEditParameters(doc,{updates:targets.map(item=>({type:item.kind,itemId:item.id}))}).updates as Row[];
 for(const [index,item] of targets.entries()){
  const fixed=resolved[index];
  if(fixed.props){const props=fixed.props as Row;for(const k of Object.keys(props))if(props[k]===item.props?.[k])delete props[k];if(!Object.keys(props).length)delete fixed.props;}
  for(const k of ['durationInFrames','srcInFrame','playbackRate'])if(fixed[k]!==undefined&&fixed[k]===(item[k as keyof typeof item]??(k==='srcInFrame'?0:k==='playbackRate'?1:undefined)))delete fixed[k];
  if(row(fixed.transform)&&row(fixed.transform.crop)){const px=fixed.transform.crop;const native={left:Number(px.left)/t.width,right:Number(px.right)/t.width,top:Number(px.top)/t.height,bottom:Number(px.bottom)/t.height};if(same(native,item.transform?.crop))delete fixed.transform;}
  if(Object.keys(fixed).length>2)updates.push(fixed);
 }
 return {updates};
}

/** Check changed native facts before publishing, independent of the tool/alias used.
 * Unchanged historical discrepancies do not prevent an unrelated edit. */
export function assertFrozenParameterChanges(before:ProjectDoc,after:ProjectDoc):void{
 if(!before.clipMentorAnalysis)return;
 for(const timeline of after.timelines){
  const previous=before.timelines.find(t=>t.id===timeline.id);if(!previous)continue;
  const originals=new Map(previous.items.map(i=>[i.id,i]));
  const updates:Row[]=[];
  for(const item of timeline.items){
   const old=originals.get(item.id),entry:Row={type:item.kind,itemId:item.id};
   if(item.kind==='text'){
    const props:Row={};for(const k of ['fontSize','color'])if(!old||old.props?.text!==item.props?.text||!same(old.props?.[k],item.props?.[k]))props[k]=item.props?.[k]??null;
    if(Object.keys(props).length)entry.props=props;
   }
   if(item.kind==='audio'){
    for(const k of ['durationInFrames','srcInFrame','playbackRate'] as const){const value=item[k]??(k==='srcInFrame'?0:k==='playbackRate'?1:undefined),prior=old?.[k]??(k==='srcInFrame'?0:k==='playbackRate'?1:undefined);
     if(!old||old.sourceAssetId!==item.sourceAssetId||value!==prior)entry[k]=value;
    }
   }
   if(item.kind==='image'&&(old||item.transform?.crop)&&(!old||old.sourceAssetId!==item.sourceAssetId||old.startFrame!==item.startFrame||old.durationInFrames!==item.durationInFrames||!same(old.transform?.crop,item.transform?.crop))){
    const crop=item.transform?.crop;
    entry.transform={crop:crop?{left:Math.round((crop.left??0)*timeline.width),right:Math.round((crop.right??0)*timeline.width),top:Math.round((crop.top??0)*timeline.height),bottom:Math.round((crop.bottom??0)*timeline.height)}:null};
   }
   if(Object.keys(entry).length>2)updates.push(entry);
  }
  if(updates.length)resolveFrozenEditParameters({...after,activeTimelineId:timeline.id},{updates});
 }
}
