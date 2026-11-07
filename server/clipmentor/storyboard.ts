import type {ProjectDoc} from '../../src/editor/types';
import type {ClipMentorStoryboard,StoryboardCard,StoryboardReference} from '../../shared/clipmentor-storyboard';
import {copyTeachingPacketFromDoc,copyReviewSubject,checkCopyProduction} from '../../src/clipmentor/production-gate';
import {checkSourceBreakdown} from '../../src/clipmentor/source-breakdown';
import {deliveryAudio} from '../../src/clipmentor/delivery-sections';
import {revisionOf} from '../../src/agent/external-edit-session';
import {digestValue} from '../agent-runs/store-values';
import {productionPreviewFacts} from './production-preview-facts';

// Correct only IEEE-754 noise around an integer source frame. An actual
// between-frame time still selects its preceding frame, never its nearest one.
const sourceFrame=(frames:number)=>{
 const nearest=Math.round(frames);
 return Math.abs(frames-nearest)<=4*Number.EPSILON*Math.max(1,Math.abs(frames))?nearest:Math.floor(frames);
};

/** Derive only current pointers. No audio, review or output cut is invented for an unplaced plan. */
export async function productionStoryboard(doc:ProjectDoc,projectId:string):Promise<ClipMentorStoryboard>{
 const packet=await copyTeachingPacketFromDoc(doc),subject=await copyReviewSubject(doc),a=doc.clipMentorAnalysis!;
 const timeline=doc.timelines.find(t=>t.id===doc.activeTimelineId);if(!timeline)throw Error('storyboard_timeline_missing');
 const fps=a.source.fps;if(!Number.isFinite(fps)||fps<=0)throw Error('storyboard_source_clock_invalid');
 const cards:StoryboardCard[]=[];
 const addSource=(card:StoryboardCard,assetId:string,seconds:number,origin:StoryboardReference['origin'],lineIds:string[],crop?:StoryboardReference['crop'])=>{
  // Evidence can name the rounded source end. A contact-sheet sample is a
  // real frame start, at most the start of the last complete source frame.
  if(origin==='source')seconds=Math.min(sourceFrame(seconds*fps),Math.max(0,sourceFrame(a.source.duration_seconds*fps-1)))/fps;
  const asset=doc.assets.find(x=>x.id===assetId);
  const key=digestValue({asset_id:assetId,hash:asset?.sourceContentHash??null,seconds,origin,crop});
  const prior=card.source.find(r=>r.key===key);
  if(prior){prior.line_ids=[...new Set([...prior.line_ids,...lineIds])];return;}
  card.source.push({key,origin,asset_id:assetId,source_seconds:seconds,line_ids:lineIds,...(crop?{crop}:{})});
 };
 const range=(card:StoryboardCard,r:readonly number[],ids:string[])=>{
  if(r.length!==2||!r.every(Number.isFinite)||r[0]<0||r[1]<r[0]||r[0]>=a.source.duration_seconds||r[1]>a.source.duration_seconds){card.notes.push('source_range_unavailable');return;}
  for(const seconds of [r[0],(r[0]+r[1])/2,Math.max(r[0],r[1]-1/fps)])addSource(card,a.source.asset_id,seconds,'source',ids);
 };
 let facts:ReturnType<typeof productionPreviewFacts>|undefined;
 if(timeline.items.length)try{facts=productionPreviewFacts(doc,timeline,packet);}catch{/* Actual layout stays unavailable for unsupported native mappings. */}
 const actual=(card:StoryboardCard,r:readonly number[]|undefined,phase:string)=>{
  if(!r||r.length!==2||!r.every(Number.isSafeInteger)||r[0]<0||r[1]<=r[0]||!facts||r[1]>facts.executionManifest.total_frames)return;
  for(const frame of [r[0],Math.floor((r[0]+r[1]-1)/2),r[1]-1]){
   if(card.actual.some(x=>x.frame===frame))continue;
   card.actual.push({key:digestValue({frame,render:facts.executionManifest}),frame,phase});
  }
 };
 const line=(l:Pick<typeof packet.units[number]['lines'][number],'line_id'|'narration_ms'|'meaning_zh'|'caption_lines'|'labels'>)=>({id:l.line_id,ms:l.narration_ms,zh:l.meaning_zh,captions:l.caption_lines,labels:l.labels??[]});
 const sections=packet.delivery_sections??[];
 const sectionCard=(section:typeof sections[number])=>{
  const card:StoryboardCard={id:`delivery:${section.section_id}`,subject_id:section.section_id,kind:section.kind==='performance_opening'?'opening':'closing',title:section.kind==='performance_opening'?'片头':'达人结尾',intent:section.picture.description,
   lines:[line(section.line)],source:[],actual:[],actual_status:'not_placed',notes:[]};
  addSource(card,section.picture.asset_id,0,'supplied_full',[section.line.line_id]);
  if(section.picture.crop)addSource(card,section.picture.asset_id,0,'planned_crop',[section.line.line_id],section.picture.crop);
  try{
   const bound=deliveryAudio(doc,section),items=timeline.items.filter(i=>i.kind==='audio'&&i.sourceAssetId===bound.asset.id);
   if(items.length===1)actual(card,[items[0].startFrame,items[0].startFrame+items[0].durationInFrames],'交付段');
  }catch{/* A plan is readable before synthesis; do not require audio to show its supplied picture. */}
  card.actual_status=card.actual.length?'placed':timeline.items.length?'mapping_unavailable':'not_placed';return card;
 };
 for(const section of sections.filter(s=>s.kind==='performance_opening'))cards.push(sectionCard(section));
 const order=a.source_breakdown?.units.map(u=>u.unit_id)??packet.units.map(u=>u.unit_id);
 for(const id of order){
  const unit=packet.units.find(u=>u.unit_id===id);if(!unit)continue;
  const card:StoryboardCard={id:`unit:${unit.unit_id}`,subject_id:unit.unit_id,kind:'unit',title:unit.unit_id,intent:a.blueprint.find(u=>u.unit_id===id)?.intent_zh??'',
   lines:unit.lines.map(line),source:[],actual:[],actual_status:'not_placed',notes:[]};
  for(const r of unit.picture_plan?.original_source_ranges??[])range(card,r,[]);
  for(const r of unit.picture_plan?.explanation_source_ranges??[])range(card,r,[]);
  for(const r of unit.picture_plan?.line_source_ranges??[]){
   // Keep the declared evidence/context windows; the enclosing line range is
   // not permission to play intervening gaps or proof of the teaching claim.
   for(const selected of [...(r.evidence_source_ranges??[]),...(r.context_source_ranges??[])])range(card,selected.source_range_seconds,[r.line_id]);
   if(!r.evidence_source_ranges?.length&&!r.context_source_ranges?.length)range(card,r.source_range_seconds,[r.line_id]);
  }
  for(const evidence of packet.source_evidence.filter(e=>unit.points.some(p=>p.evidence_ids.includes(e.evidence_id)))){
   for(const seconds of evidence.time_seconds??[])if(Number.isFinite(seconds)&&seconds>=0&&seconds<a.source.duration_seconds)addSource(card,a.source.asset_id,seconds,'source',unit.lines.filter(l=>l.point_ids.some(id=>unit.points.some(p=>p.point_id===id&&p.evidence_ids.includes(evidence.evidence_id)))).map(l=>l.line_id));
  }
  const placement=a.source_breakdown?.units.find(u=>u.unit_id===id)?.placement;
  if(placement?.timeline_id===timeline.id){actual(card,placement.original_frames,'原片播放');actual(card,placement.explanation_frames,'讲解排版');}
  card.actual_status=card.actual.length?'placed':timeline.items.length?'mapping_unavailable':'not_placed';
  if(!card.source.length)card.notes.push('source_reference_missing');cards.push(card);
 }
 for(const section of sections.filter(s=>s.kind!=='performance_opening'))cards.push(sectionCard(section));
 if(!cards.length)throw Error('storyboard_current_plan_missing');
 const gate=await checkCopyProduction(doc,'clipmentor');
 const base={project_id:projectId,project_revision:revisionOf(doc),timeline_id:timeline.id,analysis_revision:a.revision,blueprint_digest:subject.digest,
  title:a.product.name,cards,copy_gate:{allowed:gate.allowed,code:gate.code},authority:'read_only_reference_and_saved_layout_not_approval' as const,continuous_viewing:false as const,listening:false as const};
 // Includes native render state and asset identities, never an independently editable plan.
 return{...base,digest:digestValue({base,timeline,assets:doc.assets,structure:checkSourceBreakdown(doc)})};
}
