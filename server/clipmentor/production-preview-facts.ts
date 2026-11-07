import {createHash} from 'node:crypto';
import {timelineTrackIds,trackKind,isVisualItemKind} from '../../src/editor/timelineTypes';
import {checkTransitionManifest,type Scene,type PictureLayer} from '../../src/clipmentor/transition-check';
import type {ProjectDoc,TimelineState,TimelineItem} from '../../src/editor/types';
import type {TeachingPacket} from '../../src/clipmentor/production-gate';
import {deliveryAudio} from '../../src/clipmentor/delivery-bindings';

function canonical(value:unknown):string {
 if(value===null||typeof value!=='object')return JSON.stringify(value)??'null';
 if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
 return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
export const previewFactsDigest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const renderKeys=['srcInFrame','playbackRate','props','templateId','width','height','transform','keyframes','filters','backgroundFill','backgroundFillStrength','zoom','effects','fadeInFrames','fadeOutFrames'] as const;
const hashCode=(i:TimelineItem)=>i.code?previewFactsDigest(i.code):undefined;
/** Snapshot actual native rendering inputs. Names, local paths and author evaluations are excluded. */
function renderState(i:TimelineItem) {
 return {code_sha256:hashCode(i),source_locator_sha256:i.src?previewFactsDigest(i.src):undefined,...Object.fromEntries(renderKeys.filter(k=>i[k]!==undefined).map(k=>[k,i[k]]))};
}
function assertLinear(i:TimelineItem) {
 if(i.deletedWordIdx?.length||i.transcriptPlayOrder?.length||i.silenceFrames!==undefined||i.cutPadFrames!==undefined||Object.keys(i.gapCapsMs??{}).length)
  throw new Error(`preview_source_mapping_unsupported:${i.id}:transcript_edit`);
 if(!Number.isFinite(i.playbackRate??1)||(i.playbackRate??1)<=0||!Number.isFinite(i.srcInFrame??0)||(i.srcInFrame??0)<0)
  throw new Error(`preview_source_timing_invalid:${i.id}`);
}
/** Extend the existing scenes/audios contract from native items; no second handwritten Shot table. */
export function productionPreviewFacts(doc:ProjectDoc,t:TimelineState,packet:TeachingPacket){
 if(!Number.isFinite(t.fps)||t.fps<=0||!t.items.length)throw new Error('preview_timeline_invalid');
 if(t.transitions?.length)throw new Error('preview_composition_unsupported:transitions');
 const ids=new Set<string>();
 for(const i of t.items){
  if(ids.has(i.id)||!Number.isSafeInteger(i.startFrame)||i.startFrame<0||!Number.isSafeInteger(i.durationInFrames)||i.durationInFrames<=0)throw new Error(`preview_item_invalid:${i.id}`);
  ids.add(i.id);
 }
 const total_frames=Math.max(t.fps,...t.items.map(i=>i.startFrame+i.durationInFrames));
 if(!Number.isSafeInteger(total_frames))throw new Error('preview_duration_invalid');
 const trackIds=timelineTrackIds(t),hidden=(i:TimelineItem)=>!!t.tracks?.[i.track]?.hidden;
 const pictures=t.items.filter(i=>!hidden(i)&&isVisualItemKind(i.kind)&&trackKind(t,i.track)==='video');
 if(pictures.some(i=>i.kind==='sequence'))throw new Error('preview_composition_unsupported:sequence');
 // Match TimelineComposition: stable same-track start order, bottom-to-top track order.
 const ordered=[...pictures].sort((a,b)=>a.track===b.track?a.startFrame-b.startFrame:trackIds.indexOf(b.track)-trackIds.indexOf(a.track));
 const assets=new Map(doc.assets.map(a=>[a.id,a]));
 function assetFor(i:TimelineItem){
  const asset=i.sourceAssetId?assets.get(i.sourceAssetId):doc.assets.find(a=>a.src===i.src);
  // An actual detached clip is valid; a conflicting live binding is not silently repaired.
  if(asset&&i.src&&asset.src!==i.src)throw new Error(`preview_asset_binding_conflict:${i.id}`);
  if(asset?.sourceContentHash&&i.sourceContentHash&&asset.sourceContentHash!==i.sourceContentHash)throw new Error(`preview_asset_hash_conflict:${i.id}`);
  return asset;
 }
 const base=doc.clipMentorAnalysis?.source;
 const layerCache=new Map(ordered.map(i=>{
  const asset=assetFor(i),state=renderState(i);
  const assetId=i.sourceAssetId??asset?.id;
  const media=['video','image','gif','svg'].includes(i.kind);
  if(media&&(!i.src||!assetId))throw new Error(`preview_media_identity_missing:${i.id}`);
  if(i.kind==='motion-graphic'&&!i.code)throw new Error(`preview_mg_code_missing:${i.id}`);
  if(i.kind==='video')assertLinear(i);
  const original=i.kind==='video'&&assetId===base?.asset_id;
  if(original&&base?.sourceContentHash&&(i.sourceContentHash??asset?.sourceContentHash)!==base.sourceContentHash)throw new Error(`preview_original_hash_mismatch:${i.id}`);
  if(i.kind==='video'&&asset?.durationInFrames&&((i.srcInFrame??0)+i.durationInFrames*(i.playbackRate??1)>asset.durationInFrames))throw new Error(`preview_source_window_exceeds_media:${i.id}`);
  const hasFrameProvenance=i.kind==='image'&&asset?.props?.sourceSeconds!==undefined;
  if(hasFrameProvenance&&(!Number.isFinite(asset?.props?.sourceSeconds)||Number(asset?.props?.sourceSeconds)<0||asset?.props?.sourceAssetId!==base?.asset_id
    ||(base?.sourceContentHash&&asset?.props?.sourceHash!==base.sourceContentHash)))throw new Error(`preview_still_provenance_invalid:${i.id}`);
  const layer:PictureLayer={item_id:i.id,track:i.track,kind:i.kind,origin:original?'original_video':hasFrameProvenance?'source_frame':media?'media_asset':'authored',
   ...(assetId?{asset_id:assetId}:{}),...(i.sourceContentHash??asset?.sourceContentHash?{source_hash:i.sourceContentHash??asset?.sourceContentHash}:{}),
   ...(i.sourceRevision??asset?.sourceRevision?{source_revision:i.sourceRevision??asset?.sourceRevision}:{}),
   ...(hasFrameProvenance?{source_start_seconds:Number(asset!.props!.sourceSeconds)}:{}),
   item_start_frame:i.startFrame,item_end_frame:i.startFrame+i.durationInFrames,layout_digest:previewFactsDigest(Object.fromEntries(['width','height','transform','keyframes','fadeInFrames','fadeOutFrames'].filter(k=>state[k as keyof typeof state]!==undefined).map(k=>[k,state[k as keyof typeof state]]))),render_digest:previewFactsDigest(state),render_state:state};
  return [i.id,layer] as const;
 }));
 const cuts=[...new Set([0,total_frames,...ordered.flatMap(i=>[i.startFrame,i.startFrame+i.durationInFrames])])].sort((a,b)=>a-b);
 const scenes:Scene[]=cuts.slice(0,-1).map((start,index)=>({start_frame:start,end_frame:cuts[index+1],kind:'composition',layers:ordered.filter(i=>i.startFrame<=start&&i.startFrame+i.durationInFrames>start).map(i=>{
  const layer=layerCache.get(i.id)!;
  return {...layer,...(layer.origin==='original_video'?{source_start_seconds:((i.srcInFrame??0)+(start-i.startFrame)*(i.playbackRate??1))/t.fps,playback_rate:i.playbackRate??1}:{})};
 })}));
 const sounding=t.items.filter(i=>!hidden(i)&&!t.tracks?.[i.track]?.muted&&(i.volume??1)>0&&!!i.src&&(i.kind==='audio'||i.kind==='video'&&pictures.includes(i)));
 const audios=sounding.map(i=>{
  assertLinear(i);assetFor(i);
  return {start:i.startFrame/t.fps,end:(i.startFrame+i.durationInFrames)/t.fps,kind:i.kind==='audio'?'audio':i.sourceAssetId===base?.asset_id?'original':'media_audio',item_id:i.id,
   source_locator_sha256:previewFactsDigest(i.src),denoised_locator_sha256:i.denoisedSrc?previewFactsDigest(i.denoisedSrc):null,denoise_strength:i.denoiseStrength??null,source_hash:i.sourceContentHash??assetFor(i)?.sourceContentHash??null,source_revision:i.sourceRevision??assetFor(i)?.sourceRevision??null,
   source_asset_id:i.sourceAssetId??null,source_start_seconds:(i.srcInFrame??0)/t.fps,playback_rate:i.playbackRate??1,
   volume:i.volume??1,fade_in_frames:i.fadeInFrames??0,fade_out_frames:i.fadeOutFrames??0};
 });
 const input={duration_seconds:total_frames/t.fps,
  points:packet.units.flatMap(u=>u.points.map(p=>({point_id:p.point_id,teaching_goal_zh:p.question,product_relevance:p.buying_concern}))),
  units:packet.units.map(u=>{
   const placement=doc.clipMentorAnalysis?.source_breakdown?.units.find(v=>v.unit_id===u.unit_id)?.placement;
   // A historical single-unit teaching packet can be reviewed against the whole film.
   // This broadens observation context; it does not invent a group cut or narrow away a defect.
   if(!placement&&packet.units.length===1)return {unit_id:u.unit_id,point_ids:u.points.map(p=>p.point_id),output_range_seconds:[0,total_frames/t.fps] as [number,number]};
   if(!placement||placement.timeline_id!==doc.activeTimelineId)throw new Error(`Teaching unit output placement missing/stale: ${u.unit_id}`);
   const range=[placement.original_frames[0]/t.fps,placement.explanation_frames[1]/t.fps] as [number,number];
   if(!range.every(Number.isFinite)||range[0]<0||range[1]<=range[0]||range[1]>total_frames/t.fps)throw new Error(`Teaching unit output placement invalid: ${u.unit_id}`);
   return {unit_id:u.unit_id,point_ids:u.points.map(p=>p.point_id),output_range_seconds:range};
  }),
  reference_text:sounding.flatMap(i=>{
   const asset=assetFor(i),text=(asset?.props?.generation as {text?:string}|undefined)?.text;
   // Whole text is a reference over a scheduled slot, never an invented word timestamp.
   return i.kind==='audio'&&typeof text==='string'&&(i.srcInFrame??0)===0&&(i.playbackRate??1)===1&&asset?.durationInFrames===i.durationInFrames
    ?[{channel:'narration' as const,start_seconds:i.startFrame/t.fps,end_seconds:(i.startFrame+i.durationInFrames)/t.fps,text}]:[];
  })};
 if(packet.delivery_sections?.some(s=>s.picture.layout))for(const section of packet.delivery_sections){
  const audio=deliveryAudio(doc,section).asset;
  const matching=sounding.filter(i=>i.kind==='audio'&&i.sourceAssetId===audio.id);
  if(matching.length!==1)throw Error('preview_delivery_audio_binding_invalid:'+section.section_id);
  const item=matching[0],id='delivery/'+section.section_id,layout=section.picture.layout;
  const goal=layout?.kind==='original_underlay'
   ?`在导出画面核实际运动原片底层与暗色蒙层；${layout.show_sales?'前景成绩截图完整可读并及时退出；':'画面与口播均不归入未确认成绩；'}开场过渡后切入清晰原片。`
   :layout?.kind==='recruitment_card'?'在导出画面核整张招商卡内商品与已确认佣金均清楚，且口播邀请联系合作。'
    :layout?.kind==='product_commission'?'在导出画面核商品与已确认佣金在同一屏可辨，且口播邀请联系合作。'
     :layout?.kind==='product_storyboard'?'在导出画面核独立商品图和本片 Rootify Storyboard 并排，以及到货后开拍邀请。'
      :'在导出画面核本片 Rootify Storyboard 和到货后开拍邀请。';
  input.points.push({point_id:id,teaching_goal_zh:goal,product_relevance:'达人交付画面和行动用途'});
  input.units.push({unit_id:id,point_ids:[id],output_range_seconds:[item.startFrame/t.fps,(item.startFrame+item.durationInFrames)/t.fps]});
 }
 const nativeItems=t.items.map(i=>Object.fromEntries(Object.entries(i).filter(([key])=>key!=='originalFilePath')));
 const executionManifest={native_snapshot_sha256:previewFactsDigest(nativeItems),fps:t.fps,total_frames,scenes,audios,canvas:{width:t.width,height:t.height,fit:t.fit??'contain',
  audio_track_state:trackIds.map(id=>({id,hidden:t.tracks?.[id]?.hidden??false,muted:t.tracks?.[id]?.muted??false,role:t.tracks?.[id]?.role??null,audio_routing:t.tracks?.[id]?.audioRouting??null})),
  captions_hidden:t.captionsHidden??null,captions:t.captions??null,caption_tracks:trackIds.filter(id=>trackKind(t,id)==='caption').map(id=>({id,...t.tracks?.[id]})),watermark:t.watermark??null,fx_defs_sha256:previewFactsDigest(t.fxDefs??{})},
  review_window_basis:packet.units.map(u=>({unit_id:u.unit_id,basis:doc.clipMentorAnalysis?.source_breakdown?.units.find(v=>v.unit_id===u.unit_id)?.placement?'saved_placement':'whole_film_context_not_inferred_group_cut'})),
  fact_scope:'scheduled_native_composition_not_pixel_visibility',layer_order:'bottom_to_top',source_timing:'linear_media_only',
  limits:['MG code hash and native props are frozen; internal animation, occlusion and actual speech require continuous preview observation.']};
 checkTransitionManifest(executionManifest);
 return {input,executionManifest};
}
/** Refuse stale/unbound exports before any paid self-check. No old approval is reconstructed. */
export function assertPreviewExportBinding(exported:Record<string,unknown>|undefined,revision:string,facts:ReturnType<typeof productionPreviewFacts>){
 if(exported?.revision!==revision||exported?.facts_digest!==previewFactsDigest(facts))throw new Error('preview_export_binding_missing_or_stale');
}
