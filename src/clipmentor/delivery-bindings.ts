import {labelTranslationsShape} from './author-translations';
import type { ProjectDoc, MediaAsset, TimelineItem } from '../editor/types';
type Row=Record<string,unknown>;
const row=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown):v is string=>typeof v==='string'&&!!v.trim();
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const strings=(v:unknown):v is string[]=>Array.isArray(v)&&v.length>0&&v.every(text)&&new Set(v).size===v.length;
export const deliveryCropShape=(v:unknown):boolean=>row(v)&&Object.keys(v).length===4&&['left','top','right','bottom'].every(k=>typeof v[k]==='number'&&Number.isFinite(v[k])&&Number(v[k])>=0&&Number(v[k])<1)&&Number(v.left)+Number(v.right)<1&&Number(v.top)+Number(v.bottom)<1;
type FrameRange = [number, number];
type PictureCrop = {left:number;top:number;right:number;bottom:number};
type PictureAsset = {asset_id:string;src:string;sha256:string};
export type DeliveryLayout =
 | {kind:'original_underlay';source:{asset_id:string;src:string;sha256:string};range:[number,number];shade:number;show_sales:boolean;headline:string[];transition:string[]}
 | {kind:'product_commission';product_crop:PictureCrop;commission_crop:PictureCrop}
 | {kind:'recruitment_card';poster:PictureAsset}
 | {kind:'product_storyboard';product:PictureAsset;storyboard:PictureAsset;attachment:PictureAsset};
export const endingCardLayout=(layout:DeliveryLayout|undefined)=>layout?.kind==='recruitment_card'||layout?.kind==='product_storyboard'?layout:undefined;
export const endingCardSources=(layout:NonNullable<ReturnType<typeof endingCardLayout>>)=>layout.kind==='recruitment_card'?[layout.poster]:[layout.product,layout.storyboard,layout.attachment];
function referenceOnlyMediaReader(assets:readonly MediaAsset[]) {
 const references=assets.filter(a=>a.props?.clipmentorReferenceOnly===true);
 const identities=new Set(references.flatMap(a=>[a.id,a.src,...(a.sourceContentHash?[a.sourceContentHash]:[])]));
 const paths=new Set(references.map(a=>a.src));
 const contains=(entry:unknown):boolean=>{
  if(typeof entry==='string')return identities.has(entry)
   ||(entry.match(/\/media\/uploads\/[^\s"'<>?#()[\]{}\\\x60]+/g)??[]).some(path=>paths.has(path));
  if(Array.isArray(entry))return entry.some(contains);
  return row(entry)&&Object.values(entry).some(contains);
 };
 return contains;
}
/** References can stay in the library. Executable instances, including embedded media, cannot use them. */
export function assertNoReferenceMedia(doc:ProjectDoc,previous?:ProjectDoc):void {
 for(const reference of previous?.assets.filter(a=>a.props?.clipmentorReferenceOnly===true)??[]){
  if(doc.assets.some(a=>(a.id===reference.id||a.src===reference.src)&&a.props?.clipmentorReferenceOnly!==true))
   throw Error('reference_only_asset_role_cannot_change');
 }
 const assets=[...(previous?.assets??[]),...doc.assets];
 if(!assets.some(a=>a.props?.clipmentorReferenceOnly===true))return;
 const used=referenceOnlyMediaReader(assets);
 if(doc.timelines.some(t=>t.items.some(i=>used([i,doc.assets.find(a=>a.id===i.sourceAssetId||a.src===i.src)]))))
  throw Error('reference_only_asset_cannot_enter_timeline');
}
function deliveryLayoutShape(v:unknown):v is DeliveryLayout {
 if(!row(v))return false;
 const titles=(lines:unknown,min:number)=>Array.isArray(lines)&&lines.length>=min&&lines.length<=4
  &&lines.every(line=>text(line)&&Array.from(line).length<=42&&!/[\p{Cc}\p{Cf}]/u.test(line));
 if(v.kind==='original_underlay')return Object.keys(v).length===7&&row(v.source)&&Object.keys(v.source).length===3
  &&text(v.source.asset_id)&&typeof v.source.src==='string'&&/^\/media\/uploads\/[^/?#]+$/.test(v.source.src)&&hash(v.source.sha256)
  &&Array.isArray(v.range)&&v.range.length===2&&v.range.every(n=>typeof n==='number'&&Number.isFinite(n))
  &&v.range[0]>=0&&v.range[1]>v.range[0]&&typeof v.shade==='number'&&v.shade>=0.35&&v.shade<=0.8&&typeof v.show_sales==='boolean'
  &&titles(v.headline,v.show_sales?1:0)&&(v.show_sales||Array.isArray(v.headline)&&v.headline.length===0)&&titles(v.transition,1);
 const asset=(a:unknown):a is PictureAsset=>row(a)&&Object.keys(a).length===3&&text(a.asset_id)&&typeof a.src==='string'
  &&/^\/media\/uploads\/[^/?#]+$/.test(a.src)&&hash(a.sha256);
 if(v.kind==='recruitment_card')return Object.keys(v).length===2&&asset(v.poster);
 if(v.kind==='product_storyboard')return Object.keys(v).length===4&&asset(v.product)&&asset(v.storyboard)&&asset(v.attachment)
  &&v.product.asset_id!==v.storyboard.asset_id&&v.product.asset_id!==v.attachment.asset_id;
 if(v.kind!=='product_commission'||Object.keys(v).length!==3||!deliveryCropShape(v.product_crop)||!deliveryCropShape(v.commission_crop))return false;
 const p=v.product_crop as PictureCrop,c=v.commission_crop as PictureCrop;
 return 1-p.bottom<=c.top||1-c.bottom<=p.top||1-p.right<=c.left||1-c.right<=p.left;
}
interface PictureDisplay { fps: number; ranges: FrameRange[] }
function displayShape(v: unknown): v is PictureDisplay {
 return row(v) && Object.keys(v).length === 2 && typeof v.fps === 'number' && Number.isFinite(v.fps) && v.fps > 0
  && Array.isArray(v.ranges) && v.ranges.length > 0 && v.ranges.every((r, n, all) => Array.isArray(r) && r.length === 2
   && r.every(Number.isSafeInteger) && r[0] >= 0 && r[1] > r[0] && (n === 0 || all[n - 1][1] <= r[0]));
}
export interface DeliverySection {
 section_id:string; kind:'performance_opening'|'creator_invitation';
 line:{line_id:string;narration_ms:string;caption_lines:string[];meaning_zh:string;labels:string[];labels_zh?:string[]};
 evidence_ids:string[]; evidence?:Array<{evidence_id:string;text:string}>;
 picture:{asset_id:string;src:string;sha256:string;description:string;crop?:PictureCrop;layout?:DeliveryLayout;
  /** Half-open native-picture intervals relative to this section's audio, at the declared fps. Omission requires the full section. */
  display?:PictureDisplay};
 voice:{provider:string;voiceId:string;speed:1;existing_audio?:{assetId:string;src:string;sha256:string;durationSeconds:number;text:string}};
}
const normalize=(s:string)=>s.replace(/\s+/g,' ').trim();
export function deliverySectionsShape(v:unknown):v is DeliverySection[]{
 if(!Array.isArray(v)||v.length<1||v.length>3)return false;
 return v.every(s=>row(s)&&Object.keys(s).every(k=>['section_id','kind','line','evidence_ids','evidence','picture','voice'].includes(k))&&text(s.section_id)
  &&['performance_opening','creator_invitation'].includes(String(s.kind))&&strings(s.evidence_ids)
  &&row(s.line)&&text(s.line.line_id)&&text(s.line.narration_ms)&&text(s.line.meaning_zh)&&Array.isArray(s.line.caption_lines)&&s.line.caption_lines.length>0&&s.line.caption_lines.every(text)
  &&normalize(s.line.narration_ms)===normalize(s.line.caption_lines.join(' '))&&Array.isArray(s.line.labels)&&s.line.labels.every(text)&&labelTranslationsShape(s.line.labels_zh,s.line.labels)
  &&row(s.picture)&&text(s.picture.asset_id)&&typeof s.picture.src==='string'&&/^\/media\/uploads\/[^/?#]+$/.test(s.picture.src)&&hash(s.picture.sha256)&&text(s.picture.description)
  &&(s.picture.crop===undefined||deliveryCropShape(s.picture.crop))
  &&(s.picture.layout===undefined||(s.picture.crop===undefined&&deliveryLayoutShape(s.picture.layout)
    &&(s.picture.layout.kind==='original_underlay'?s.kind==='performance_opening':s.kind==='creator_invitation'
      &&s.section_id===(s.picture.layout.kind==='product_storyboard'?'existing_partner':'new_contact'))))
  &&(s.picture.display===undefined||displayShape(s.picture.display))
  &&row(s.voice)&&text(s.voice.provider)&&text(s.voice.voiceId)&&s.voice.speed===1
  &&(s.voice.existing_audio===undefined||(row(s.voice.existing_audio)&&text(s.voice.existing_audio.assetId)&&typeof s.voice.existing_audio.src==='string'&&/^\/media\/uploads\/[^/?#]+$/.test(s.voice.existing_audio.src)&&hash(s.voice.existing_audio.sha256)&&s.voice.existing_audio.text===s.line.narration_ms&&typeof s.voice.existing_audio.durationSeconds==='number'&&Number.isFinite(s.voice.existing_audio.durationSeconds)&&s.voice.existing_audio.durationSeconds>0))
  &&(s.evidence===undefined||(Array.isArray(s.evidence)&&s.evidence.length===s.evidence_ids.length&&new Set(s.evidence.map(e=>row(e)?e.evidence_id:null)).size===s.evidence.length&&s.evidence.every(e=>row(e)&&text(e.evidence_id)&&(s.evidence_ids as string[]).includes(e.evidence_id)&&text(e.text)))))
  &&new Set(v.map(s=>s.section_id)).size===v.length&&new Set(v.map(s=>s.line.line_id)).size===v.length
  &&v.filter(s=>s.kind==='performance_opening').length<=1
  &&(v.filter(s=>s.kind==='creator_invitation').length<=1||v.filter(s=>s.kind==='creator_invitation').length===2
    &&v.some(s=>s.kind==='creator_invitation'&&s.section_id==='new_contact')
    &&v.some(s=>s.kind==='creator_invitation'&&s.section_id==='existing_partner'));
}
/** A small extension of the current picture plan, not source evidence or a parallel blueprint. */
export function deliverySectionsFromDoc(doc:ProjectDoc):DeliverySection[]{
 const all:DeliverySection[]=[];
 for(const u of doc.clipMentorAnalysis?.blueprint??[]){
  const i=(u as unknown as Row).internal_review;if(!row(i))continue;const plan=i[String(i.current_picture_plan)];
  if(!row(plan)||!Object.hasOwn(plan,'delivery_sections'))continue;
  if(!deliverySectionsShape(plan.delivery_sections))throw new Error('delivery_sections_invalid');
  all.push(...structuredClone(plan.delivery_sections));
 }
 if(!all.length)return all;
 if(!deliverySectionsShape(all))throw new Error('delivery_sections_duplicate');
 const lineIds=doc.clipMentorAnalysis!.blueprint.flatMap(u=>{const i=(u as unknown as Row).internal_review;if(!row(i))return[];const c=i[String(i.current_script_candidate)];return row(c)&&Array.isArray(c.lines)?c.lines.filter(row).map(l=>l.id):[];});
 const usesReference=referenceOnlyMediaReader(doc.assets);
 for(const s of all){
  const a=doc.assets.find(a=>a.id===s.picture.asset_id);
  if(usesReference([s.picture.asset_id,s.picture.src,s.picture.sha256,s.picture.layout]))throw Error('delivery_reference_only_asset_forbidden');
  if(!a||a.kind!=='image'||a.src!==s.picture.src||a.sourceContentHash!==s.picture.sha256||lineIds.includes(s.line.line_id))throw new Error('delivery_asset_binding_invalid');
  const layout=s.picture.layout;
  const ending=endingCardLayout(layout);
  if(ending){
   const wholePoster=ending.kind==='recruitment_card'&&ending.poster.asset_id===a.id;
   if((!wholePoster&&(a.width!==720||a.height!==1280))||endingCardSources(ending).some(ref=>!doc.assets.some(media=>
    media.kind==='image'&&media.id===ref.asset_id&&media.src===ref.src&&media.sourceContentHash===ref.sha256)))throw Error('delivery_ending_card_source_invalid');
   if(ending.kind==='product_storyboard'&&endingCardSources(ending).some(ref=>ref.asset_id===a.id))throw Error('delivery_ending_card_source_invalid');
   if(ending.kind==='product_storyboard'&&[ending.storyboard,ending.attachment].some(ref=>{
    const media=doc.assets.find(m=>m.id===ref.asset_id)!;
    return media.props?.clipmentorStoryboardSource!==doc.clipMentorAnalysis!.source.asset_id||
     media.props?.clipmentorStoryboardHash!==doc.clipMentorAnalysis!.source.sourceContentHash;
   }))throw Error('delivery_ending_storyboard_source_invalid');
  }
  if(layout?.kind==='original_underlay'){
   const source=doc.clipMentorAnalysis!.source;
   if(layout.source.asset_id!==source.asset_id||layout.source.sha256!==source.sourceContentHash||layout.range[1]>source.duration_seconds
    ||!doc.assets.some(a=>a.kind==='video'&&a.id===source.asset_id&&a.src===layout.source.src&&a.sourceContentHash===layout.source.sha256))
    throw new Error('delivery_opening_original_binding_invalid');
  }
  const evidence=s.evidence_ids.map(id=>doc.clipMentorAnalysis!.evidence.find(e=>e.evidence_id===id));
  if(evidence.some(e=>!e||e.kind!=='operator_supplied'||!e.source_ids.includes(a.id)||e.call_status==='failed'))throw new Error('delivery_evidence_missing');
  s.evidence=evidence.map(e=>({evidence_id:e!.evidence_id,text:e!.text}));
  const audio=s.voice.existing_audio;
  if(audio&&!doc.assets.some(a=>a.id===audio.assetId&&a.kind==='audio'&&a.src===audio.src))throw new Error('delivery_audio_binding_invalid');
  if (s.picture.display) {
   let frames: number | undefined;
   try { frames = deliveryAudio(doc, s).frames; } catch { /* Preparatory plans can precede measured voice. */ }
   deliveryPictureRanges(s, frames, doc.timelines.find(t => t.id === doc.activeTimelineId)?.fps ?? 0);
  }
 }
 return all.sort((a,b)=>a.kind===b.kind?0:a.kind==='performance_opening'?-1:1);
}
export function deliveryAudio(doc:ProjectDoc,s:DeliverySection):{asset:MediaAsset;frames:number}{
 const fps=doc.timelines.find(t=>t.id===doc.activeTimelineId)?.fps;
 if(!fps)throw new Error('delivery_timeline_missing');
 const old=s.voice.existing_audio;
 const asset=old?doc.assets.find(a=>a.id===old.assetId&&a.kind==='audio'&&a.src===old.src):doc.assets.find(a=>{
  const g=a.props?.generation as Row|undefined;return a.kind==='audio'&&g?.text===s.line.narration_ms&&g.provider===s.voice.provider&&g.voiceId===s.voice.voiceId&&g.speed===1&&typeof g.durationSeconds==='number'&&Number.isFinite(g.durationSeconds)&&g.durationSeconds>0;
 });
 const seconds=old?.durationSeconds??(asset?.props?.generation as Row|undefined)?.durationSeconds;
 if(!asset||typeof seconds!=='number'||!Number.isFinite(seconds)||seconds<=0||![Math.round(seconds*fps),Math.ceil(seconds*fps)].includes(asset.durationInFrames))throw new Error('delivery_audio_missing:'+s.section_id);
 return{asset,frames:asset.durationInFrames};
}
/** One range contract for review/readback, save protection and export. Never infer it from prose or MG code. */
export function deliveryPictureRanges(section: DeliverySection, frames: number | undefined, fps: number, anchor = 0): FrameRange[] {
 const display = section.picture.display;
 if (display !== undefined) {
  if (!displayShape(display)) throw new Error('delivery_picture_display_invalid:' + section.section_id);
  if (display.fps !== fps) throw new Error('delivery_picture_display_fps_mismatch:' + section.section_id);
  if (frames !== undefined && display.ranges.some(r => r[1] > frames)) throw new Error('delivery_picture_display_outside_audio:' + section.section_id);
  return display.ranges.map(([a, b]) => [anchor + a, anchor + b]);
 }
 if (frames === undefined) throw new Error('delivery_audio_missing:' + section.section_id);
 return [[anchor, anchor + frames]];
}
export function deliveryRangesCovered(required: FrameRange[], actual: FrameRange[]): boolean {
 const ordered = actual.filter(([a, b]) => Number.isSafeInteger(a) && Number.isSafeInteger(b) && a >= 0 && b > a).sort((a, b) => a[0] - b[0]);
 return required.every(([start, end]) => {
  let edge = start;
  for (const [a, b] of ordered) {
   if (a > edge) break;
   edge = Math.max(edge, b);
   if (edge >= end) return true;
  }
  return false;
 });
}
export function nativeDeliveryPicture(doc: ProjectDoc, timeline: ProjectDoc['timelines'][number], i: TimelineItem, section: DeliverySection): boolean {
 return i.kind === 'image' && i.sourceAssetId === section.picture.asset_id && i.src === section.picture.src
  && (i.sourceContentHash === undefined || i.sourceContentHash === section.picture.sha256)
  && doc.assets.some(a => a.id === section.picture.asset_id && a.kind === 'image' && a.src === section.picture.src && a.sourceContentHash === section.picture.sha256)
  && !timeline.tracks?.[i.track]?.hidden && Number.isFinite(i.transform?.opacity ?? 1) && (i.transform?.opacity ?? 1) > 0;
}
/** A draft cannot reduce an existing obligation by declaring its own new ranges.
 * This matches a saved review binding only; checkCopyProduction still authorizes production. */
function reviewedPictureDisplay(doc: ProjectDoc, section: DeliverySection): boolean {
 const review: unknown = doc.clipMentorAnalysis?.production_copy_review;
 if (!row(review) || review.verdict !== 'pass' || review.scope !== 'copy_and_planned_picture_only'
  || review.analysis_revision !== doc.clipMentorAnalysis?.revision || !hash(review.content_digest)
  || !row(review.teaching_review) || !row(review.teaching_review.packet)
  || !Array.isArray(review.teaching_review.packet.delivery_sections) || !Array.isArray(review.delivery_checks)
  || !review.delivery_checks.some(c => row(c) && c.section_id === section.section_id && c.verdict === 'pass'
   && c.claims_supported === 'supported' && c.purpose_clear === true)) return false;
 const s = review.teaching_review.packet.delivery_sections.find(s => row(s) && s.section_id === section.section_id);
 if (!row(s) || !row(s.picture) || !row(s.line) || !row(s.voice) || !displayShape(s.picture.display) || !section.picture.display) return false;
 const picture = s.picture;
 return s.kind === section.kind && s.line.line_id === section.line.line_id && s.line.narration_ms === section.line.narration_ms
  && s.voice.provider === section.voice.provider && s.voice.voiceId === section.voice.voiceId && s.voice.speed === section.voice.speed
  && ['asset_id','src','sha256','description'].every(k => picture[k] === section.picture[k as keyof DeliverySection['picture']])
  && JSON.stringify(picture.layout)===JSON.stringify(section.picture.layout)
  && ['left','top','right','bottom'].every(k => (row(picture.crop) ? picture.crop[k] : undefined) === section.picture.crop?.[k as keyof NonNullable<DeliverySection['picture']['crop']>])
  && s.picture.display.fps === section.picture.display.fps && JSON.stringify(s.picture.display.ranges) === JSON.stringify(section.picture.display.ranges);
}
/** Keep registered delivery purposes when a local plan is replaced; no obligation is invented for body-only tasks. */
export function missingDeliverySectionKinds(before:ProjectDoc,after:ProjectDoc):DeliverySection['kind'][] {
 // Compare scope only; existing checks decide evidence validity and repairability.
 // The normal import/review paths still validate the full section and actual assets.
 const declarations=(doc:ProjectDoc)=>(doc.clipMentorAnalysis?.blueprint??[]).flatMap(u=>{
  const i=(u as unknown as Row).internal_review;if(!row(i))return[];const p=i[String(i.current_picture_plan)];
  return row(p)&&Array.isArray(p.delivery_sections)?p.delivery_sections.filter(row):[];
 });
 const previous=declarations(before),next=declarations(after);
 const kinds=['performance_opening','creator_invitation'] as const;
 const missing=kinds.filter(kind=>previous.some(s=>s.kind===kind)&&!next.some(s=>s.kind===kind));
 const audiences=['new_contact','existing_partner'];
 if(!missing.includes('creator_invitation')&&audiences.every(id=>previous.some(s=>s.kind==='creator_invitation'&&s.section_id===id))
  &&audiences.some(id=>!next.some(s=>s.kind==='creator_invitation'&&s.section_id===id)))missing.push('creator_invitation');
 return missing;
}
/** Preserve registered native pictures across a draft commit, including other edit tools.
 * Embedded MG images cannot replace a separately bound evidence asset. Crop/layout
 * edits and contiguous native replacements remain allowed; empty timelines can be built.
 */
export function assertDeliveryPicturePreservation(before: ProjectDoc, after: ProjectDoc): void {
 assertNoReferenceMedia(after,before);
 if(after.clipMentorAnalysis&&missingDeliverySectionKinds(before,after).length)throw new Error('delivery_sections_would_be_lost');
 let sections:DeliverySection[];
 try{sections=deliverySectionsFromDoc(before);}
 catch(error){
  if(!(error instanceof Error)||error.message!=='delivery_sections_invalid'||!after.clipMentorAnalysis
   ||before.timelines.some(timeline=>timeline.items.length)||after.timelines.some(timeline=>timeline.items.length))throw error;
  deliverySectionsFromDoc(after);
  return;
 }
 for (const previous of before.timelines) {
  for (const section of sections) {
   const matches = (i: typeof previous.items[number]) => i.kind === 'image'
    && i.sourceAssetId === section.picture.asset_id && i.src === section.picture.src;
   const original = previous.items.filter(matches);
   if (!original.length) continue;
   const next = after.timelines.find(t => t.id === previous.id);
   if (!next) throw new Error(`delivery_native_picture_would_be_lost:${section.section_id}`);
   const ranges: FrameRange[] = next.items.filter(i => nativeDeliveryPicture(after, next, i, section))
    .map(i => [i.startFrame, i.startFrame + i.durationInFrames]);
   const phased = section.picture.display && previous.id === before.activeTimelineId && reviewedPictureDisplay(before, section);
   if (phased && next.fps !== previous.fps) throw new Error(`delivery_picture_display_fps_mismatch:${section.section_id}`);
   // Pictures can be prepared before voice synthesis. Missing audio does not
   // waive existing picture coverage or prevent otherwise valid image edits.
   let audio: ReturnType<typeof deliveryAudio> | undefined;
   try { audio = deliveryAudio(before, section); } catch { /* preserve original image ranges */ }
   // Only move an existing section obligation with its own original audio anchor.
   // Other uses of the same audio asset are not new picture obligations.
   const anchors = audio ? previous.items.filter(i => i.kind === 'audio' && i.sourceAssetId === audio!.asset.id
    && original.some(p => p.startFrame < i.startFrame + i.durationInFrames
      && p.startFrame + p.durationInFrames > i.startFrame)) : [];
   const candidates = audio ? next.items.filter(i => i.kind === 'audio' && i.sourceAssetId === audio!.asset.id) : [];
   const moved = anchors.map(i => candidates.find(n => n.id === i.id)
    ?? (anchors.length === 1 && candidates.length === 1 && candidates[0].src === i.src
      && candidates[0].durationInFrames === i.durationInFrames && (candidates[0].srcInFrame ?? 0) === (i.srcInFrame ?? 0)
      && (candidates[0].playbackRate ?? 1) === (i.playbackRate ?? 1) ? candidates[0] : undefined));
   const required: FrameRange[] = original.flatMap(p => {
    const index = anchors.findIndex(i => p.startFrame < i.startFrame + i.durationInFrames
      && p.startFrame + p.durationInFrames > i.startFrame);
    const shift = index >= 0 && moved[index] ? moved[index]!.startFrame - anchors[index].startFrame : 0;
    const start = p.startFrame + shift, end = start + p.durationInFrames;
    // Only the BEFORE contract can narrow an existing obligation. Missing
    // measured audio or an unrelated reuse retains its original full extent.
    if (!phased || !audio || index < 0) return [[start, end] as FrameRange];
    const anchor = anchors[index].startFrame + shift, audioEnd = anchor + audio.frames;
    const display = deliveryPictureRanges(section, audio.frames, previous.fps, anchor);
    return [...display, [start, Math.min(end, anchor)] as FrameRange, [Math.max(start, audioEnd), end] as FrameRange]
     .map(([a, b]) => [Math.max(start, a), Math.min(end, b)] as FrameRange).filter(([a, b]) => b > a);
   });
   if (!deliveryRangesCovered(required, ranges)) throw new Error(`delivery_native_picture_would_be_lost:${section.section_id}`);
  }
 }
}
