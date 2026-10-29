import type { ProjectDoc, MediaAsset } from '../editor/types';
type Row=Record<string,unknown>;
const row=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=(v:unknown):v is string=>typeof v==='string'&&!!v.trim();
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const strings=(v:unknown):v is string[]=>Array.isArray(v)&&v.length>0&&v.every(text)&&new Set(v).size===v.length;
export const deliveryCropShape=(v:unknown):boolean=>row(v)&&Object.keys(v).length===4&&['left','top','right','bottom'].every(k=>typeof v[k]==='number'&&Number.isFinite(v[k])&&Number(v[k])>=0&&Number(v[k])<1)&&Number(v.left)+Number(v.right)<1&&Number(v.top)+Number(v.bottom)<1;
export interface DeliverySection {
 section_id:string; kind:'performance_opening'|'creator_invitation';
 line:{line_id:string;narration_ms:string;caption_lines:string[];meaning_zh:string;labels:string[]};
 evidence_ids:string[]; evidence?:Array<{evidence_id:string;text:string}>;
 picture:{asset_id:string;src:string;sha256:string;description:string;crop?:{left:number;top:number;right:number;bottom:number}};
 voice:{provider:string;voiceId:string;speed:1;existing_audio?:{assetId:string;src:string;sha256:string;durationSeconds:number;text:string}};
}
const normalize=(s:string)=>s.replace(/\s+/g,' ').trim();
export function deliverySectionsShape(v:unknown):v is DeliverySection[]{
 if(!Array.isArray(v)||v.length<1||v.length>2)return false;
 return v.every(s=>row(s)&&Object.keys(s).every(k=>['section_id','kind','line','evidence_ids','evidence','picture','voice'].includes(k))&&text(s.section_id)
  &&['performance_opening','creator_invitation'].includes(String(s.kind))&&strings(s.evidence_ids)
  &&row(s.line)&&text(s.line.line_id)&&text(s.line.narration_ms)&&text(s.line.meaning_zh)&&Array.isArray(s.line.caption_lines)&&s.line.caption_lines.length>0&&s.line.caption_lines.every(text)
  &&normalize(s.line.narration_ms)===normalize(s.line.caption_lines.join(' '))&&Array.isArray(s.line.labels)&&s.line.labels.every(text)
  &&row(s.picture)&&text(s.picture.asset_id)&&typeof s.picture.src==='string'&&/^\/media\/uploads\/[^/?#]+$/.test(s.picture.src)&&hash(s.picture.sha256)&&text(s.picture.description)
  &&(s.picture.crop===undefined||deliveryCropShape(s.picture.crop))
  &&row(s.voice)&&text(s.voice.provider)&&text(s.voice.voiceId)&&s.voice.speed===1
  &&(s.voice.existing_audio===undefined||(row(s.voice.existing_audio)&&text(s.voice.existing_audio.assetId)&&typeof s.voice.existing_audio.src==='string'&&/^\/media\/uploads\/[^/?#]+$/.test(s.voice.existing_audio.src)&&hash(s.voice.existing_audio.sha256)&&s.voice.existing_audio.text===s.line.narration_ms&&typeof s.voice.existing_audio.durationSeconds==='number'&&Number.isFinite(s.voice.existing_audio.durationSeconds)&&s.voice.existing_audio.durationSeconds>0))
  &&(s.evidence===undefined||(Array.isArray(s.evidence)&&s.evidence.length===s.evidence_ids.length&&new Set(s.evidence.map(e=>row(e)?e.evidence_id:null)).size===s.evidence.length&&s.evidence.every(e=>row(e)&&text(e.evidence_id)&&(s.evidence_ids as string[]).includes(e.evidence_id)&&text(e.text)))))
  &&new Set(v.map(s=>s.section_id)).size===v.length&&new Set(v.map(s=>s.line.line_id)).size===v.length&&new Set(v.map(s=>s.kind)).size===v.length;
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
 for(const s of all){
  const a=doc.assets.find(a=>a.id===s.picture.asset_id);
  if(!a||a.kind!=='image'||a.src!==s.picture.src||a.sourceContentHash!==s.picture.sha256||lineIds.includes(s.line.line_id))throw new Error('delivery_asset_binding_invalid');
  const evidence=s.evidence_ids.map(id=>doc.clipMentorAnalysis!.evidence.find(e=>e.evidence_id===id));
  if(evidence.some(e=>!e||e.kind!=='operator_supplied'||!e.source_ids.includes(a.id)||e.call_status==='failed'))throw new Error('delivery_evidence_missing');
  s.evidence=evidence.map(e=>({evidence_id:e!.evidence_id,text:e!.text}));
  const audio=s.voice.existing_audio;
  if(audio&&!doc.assets.some(a=>a.id===audio.assetId&&a.kind==='audio'&&a.src===audio.src))throw new Error('delivery_audio_binding_invalid');
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
 if(!asset||typeof seconds!=='number'||!Number.isFinite(seconds)||seconds<=0||asset.durationInFrames!==Math.round(seconds*fps))throw new Error('delivery_audio_missing:'+s.section_id);
 return{asset,frames:asset.durationInFrames};
}
/** Preserve registered native pictures across a draft commit, including other edit tools.
 * Embedded MG images cannot replace a separately bound evidence asset. Crop/layout
 * edits and contiguous native replacements remain allowed; empty timelines can be built.
 */
export function assertDeliveryPicturePreservation(before: ProjectDoc, after: ProjectDoc): void {
 const sections = deliverySectionsFromDoc(before);
 for (const previous of before.timelines) {
  for (const section of sections) {
   const matches = (i: typeof previous.items[number]) => i.kind === 'image'
    && i.sourceAssetId === section.picture.asset_id && i.src === section.picture.src;
   const original = previous.items.filter(matches);
   if (!original.length) continue;
   const next = after.timelines.find(t => t.id === previous.id);
   if (!next) throw new Error(`delivery_native_picture_would_be_lost:${section.section_id}`);
   const ranges = next.items.filter(matches).map(i => [i.startFrame, i.startFrame + i.durationInFrames])
    .sort((a, b) => a[0] - b[0]);
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
   const required = original.map(p => {
    const index = anchors.findIndex(i => p.startFrame < i.startFrame + i.durationInFrames
      && p.startFrame + p.durationInFrames > i.startFrame);
    const shift = index >= 0 && moved[index] ? moved[index]!.startFrame - anchors[index].startFrame : 0;
    return [p.startFrame + shift, p.startFrame + p.durationInFrames + shift];
   });
   for (const [start, end] of required) {
    let edge = start;
    for (const [a, b] of ranges) {
     if (a > edge) break;
     if (b > edge) edge = b;
     if (edge >= end) break;
    }
    if (edge < end) throw new Error(`delivery_native_picture_would_be_lost:${section.section_id}`);
   }
  }
 }
}
