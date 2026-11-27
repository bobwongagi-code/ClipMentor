import {stageCueTopStripProps} from '../../src/clipmentor/blueprint-picture-notices';
import {contiguousPlaybackRuns,nativeExecutionMapping} from '../../src/clipmentor/source-breakdown';
import {captionTrackEntries,type ProjectDoc,type TimelineItem} from '../../src/editor/types';

type Row=Record<string,unknown>;
type Window=[number,number];
const record=(value:unknown):Row=>value&&typeof value==='object'&&!Array.isArray(value)?value as Row:{};
const entries=(value:unknown):Row[]=>Array.isArray(value)?value.map(record):[];
const normalized=(value:unknown)=>typeof value==='string'
 ?value.normalize('NFC').replace(/[^\p{L}\p{N}]+/gu,' ').trim(): '';
const duration=(windows:Window[])=>windows.reduce((sum,[start,end])=>sum+end-start,0);
const contains=(windows:Window[],start:number,end:number)=>windows.some(([a,b])=>start>=a&&end<=b);

/** Apply the chosen top strip to stage titles. Caption and annotation styling
 * remains with the edit, including when captions share the stage title's text. */
export function productionTeachingPresentation(doc:ProjectDoc,options:{apply?:boolean}={}){
 const a=doc.clipMentorAnalysis;
 const timeline=doc.timelines.find(t=>t.id===doc.activeTimelineId);
 if(!a?.source_breakdown||!timeline)return {doc,units:[]};
 const captions=captionTrackEntries(timeline);
 const captionsOff=timeline.captionsHidden===true
  ||(timeline.captionsHidden===undefined&&captions.length>0&&captions.every(entry=>!entry.captions?.enabled));
 const native=nativeExecutionMapping(doc);
 const allOriginals=[...Object.values(native.teachingPhases).flatMap(phases=>phases.original),
  ...a.source_breakdown.units.flatMap(unit=>unit.placement?.timeline_id===timeline.id?[unit.placement.original_frames]:[])];
 type StripStyle=NonNullable<ReturnType<typeof stageCueTopStripProps>>;
 const updates=new Map<string,StripStyle|null>();
 const missing:Array<{id:string;text:string;span:Window;style:StripStyle}>=[];
 const units=a.source_breakdown.units.flatMap(unit=>{
  const board=a.blueprint.find(b=>b.unit_id===unit.unit_id),internal=record(record(board).internal_review);
  const plan=record(internal[String(internal.current_picture_plan)]),candidate=record(internal[String(internal.current_script_candidate)]);
  const cues=record(plan.viewer_stage_cues);
  const stripStyles={original:stageCueTopStripProps(cues.layout,'original'),explanation:stageCueTopStripProps(cues.layout,'explanation')};
  if(plan.script_candidate_id!==internal.current_script_candidate||!Array.isArray(plan.phases)||!normalized(record(cues.original).text))return [];
  // Exact historical compositions keep their own reviewed caption treatment.
  const detail=record(plan.composition).detail;
  if(typeof detail==='string')try{
   const exact=record(JSON.parse(detail));
   if(Array.isArray(exact.production_rows)||exact.layout_spec)return [];
  }catch{/* Natural-language picture notes are not exact rendering instructions. */}
  if(unit.placement&&unit.placement.timeline_id!==timeline.id)return [];
  const placement=unit.placement;
  const ranges=placement?{original:[placement.original_frames],explanation:[placement.explanation_frames]}:native.teachingPhases[unit.unit_id];
  if(!ranges)return [];
  const original=contiguousPlaybackRuns(ranges.original,0),explanation=contiguousPlaybackRuns(ranges.explanation,0);
  // A phase cue can stay across a silent beat within the explanation. A
  // subsequent original demonstration separates the two explanation runs.
  const explanationCueWindows:Window[]=[];
  for(const [start,end] of explanation){
   const previous=explanationCueWindows.at(-1);
   if(previous&&!allOriginals.some(([a,b])=>previous[1]<b&&start>a))previous[1]=end;
   else explanationCueWindows.push([start,end]);
  }
  const use=(item:TimelineItem)=>!timeline.tracks?.[item.track]?.hidden&&item.transform?.opacity!==0;
  const audioByLine=new Map<string,{words:string[];span:Window}>();
  const labels=new Set<string>();
  const plannedLabels:Array<{lineId:string;text:string}>=[];
  for(const line of entries(candidate.lines)){
   if(typeof line.narration_ms!=='string')continue;
   if(Array.isArray(line.labels))for(const label of line.labels){
    if(typeof label!=='string'||!normalized(label))continue;
    labels.add(normalized(label));
    plannedLabels.push({lineId:String(line.id),text:label});
   }
   const voices=timeline.items.filter(t=>t.kind==='audio'&&use(t)&&!timeline.tracks?.[t.track]?.muted&&(t.volume??1)>0
    &&contains(explanation,t.startFrame,t.startFrame+t.durationInFrames)
    &&doc.assets.some(asset=>asset.id===t.sourceAssetId&&asset.src===t.src&&record(asset.props?.generation).text===line.narration_ms));
   if(voices.length!==1)continue;
   const voice=voices[0];
   audioByLine.set(String(line.id),{words:[normalized(line.narration_ms),...(Array.isArray(line.caption_lines)?line.caption_lines.map(normalized):[])],
    span:[voice.startFrame,voice.startFrame+voice.durationInFrames]});
  }
  const stageCounts={original:0,explanation:0};
  const ambiguousTitles=new Set<string>();
  let captionCount=0;
  const referenceReads=entries(plan.timing_dispositions).filter(row=>row.action==='reference_reading')
   .map(row=>({lineId:row.line_id,information:row.reason}));
  const sourceStills=timeline.items.flatMap(item=>{
   if(item.kind!=='image'||!use(item)
    ||!contains(explanation,item.startFrame,item.startFrame+item.durationInFrames))return [];
   const asset=doc.assets.find(asset=>asset.id===item.sourceAssetId&&asset.src===item.src);
   if(asset?.props?.sourceAssetId!==a.source.asset_id||asset.props.sourceHash!==a.source.sourceContentHash
    ||typeof asset.props.sourceSeconds!=='number'||!Number.isFinite(asset.props.sourceSeconds)||asset.props.sourceSeconds<0)return [];
   return [{sourceSeconds:asset.props.sourceSeconds,startsAt:item.startFrame/timeline.fps,seconds:item.durationInFrames/timeline.fps}];
  });
  const labelWindows=new Map<string,Window[]>();
  for(const item of timeline.items){
   const words=normalized(item.props?.text);
   if(item.kind!=='text'||!words||!use(item))continue;
   const start=item.startFrame,end=start+item.durationInFrames;
   const phase=contains(original,start,end)?'original':contains(explanationCueWindows,start,end)?'explanation':undefined;
   const phaseLabel=phase==='original'?words===normalized(record(cues.original).text)
    :entries(cues.revisit).some(cue=>words===normalized(cue.text));
   const caption=[...audioByLine.values()].some(({words:approved,span})=>
    start<span[1]&&end>span[0]&&approved.some(text=>text===words||words.includes(' ')&&` ${text} `.includes(` ${words} `)));
   if(!captionsOff&&labels.has(words)&&!phaseLabel&&!caption&&item.props?.placement!=='top_strip'){
    const intersections:Window[]=explanation.flatMap(([a,b])=>Math.max(a,start)<Math.min(b,end)
     ?[[Math.max(a,start),Math.min(b,end)] as Window]:[]);
    if(intersections.length)labelWindows.set(words,[...labelWindows.get(words)??[],...intersections]);
   }
   if(!phase)continue;
   if(phase==='explanation'&&!captionsOff&&caption&&!labels.has(words))captionCount++;
   if(!phaseLabel)continue;
   if(caption||labels.has(words)){
    ambiguousTitles.add(words);
    if(item.props?.placement!=='top_strip')continue;
   }
   stageCounts[phase]++;
   const style=stripStyles[phase];
   if(!style)continue;
   const prior=updates.get(item.id);
   updates.set(item.id,prior!==undefined&&JSON.stringify(prior)!==JSON.stringify(style)?null:style);
  }
  const seconds=([start,end]:Window):Window=>[start/timeline.fps,end/timeline.fps];
  // A scheduled native text item is a locator for playback review. Text
  // embedded in a picture, visual coverage and word timing need visual/audio review.
  const labelReadback=plannedLabels.map(({lineId,text})=>{
   const voice=audioByLine.get(lineId)?.span;
   const shown=(labelWindows.get(normalized(text))??[]).toSorted(([a],[b])=>a-b);
   return {lineId,text,voiceWindow:voice?seconds(voice):null,textWindows:shown.map(seconds),
    timing:!voice?'voice_unbound':!shown.length?'native_text_unlocated'
     :shown.some(([start,end])=>start<voice[1]&&end>voice[0])?'overlaps_voice':'elsewhere_in_explanation'};
  });
  const originalText=record(cues.original).text;
  const revisitTexts=[...new Set(entries(cues.revisit).flatMap(cue=>typeof cue.text==='string'&&cue.text.trim()?[cue.text]:[]))];
  // If the editor omitted a whole phase label, recover the unambiguous saved
  // title. A plan with multiple revisit titles still owns their individual timing.
  for(const [phase,windows,title] of [
   ['original',original,originalText],['explanation',explanationCueWindows,revisitTexts.length===1?revisitTexts[0]:undefined],
  ] as const){
   const style=stripStyles[phase];
   if(!style||stageCounts[phase]||typeof title!=='string'||!title.trim()||ambiguousTitles.has(normalized(title)))continue;
   windows.forEach((span,index)=>missing.push({id:`clipmentor-stage-${unit.unit_id}-${phase}-${index}`,span,text:title,style}));
  }
  return [{unitId:unit.unit_id,originalSeconds:duration(original)/timeline.fps,explanationSeconds:duration(explanation)/timeline.fps,
   stageLabels:stageCounts,matchedCaptionCards:captionCount,referenceReads,sourceStills:sourceStills.sort((a,b)=>a.startsAt-b.startsAt),labelReadback}];
 });
 if(!options.apply||(!updates.size&&!missing.length))return {doc,units};
 const items=timeline.items.map(item=>{
  const change=updates.get(item.id);
  if(!change)return item;
  const {transform:_position,...rest}=item;
  return {...rest,props:{...item.props,...change}};
 });
 const ids=new Set(items.map(item=>item.id));
 const recoverable=missing.filter(label=>!ids.has(label.id));
 if(!recoverable.length)return {doc:{...doc,timelines:doc.timelines.map(t=>t===timeline?{...timeline,items}:t)},units};
 const track='clipmentor-phase-strips';
 const existing=timeline.tracks?.[track];
 if(existing&&(existing.kind!=='video'||existing.name!=='Phase strips'||existing.hidden))
  return {doc:{...doc,timelines:doc.timelines.map(t=>t===timeline?{...timeline,items}:t)},units};
 const strips=recoverable.map(({id,text,span:[startFrame,end],style}):TimelineItem=>({
  id,name:text,kind:'text',track,startFrame,durationInFrames:end-startFrame,
  width:timeline.width,height:timeline.height,props:{text,...style},
 }));
 const active={...timeline,items:[...items,...strips],tracks:{...timeline.tracks,[track]:{kind:'video' as const,name:'Phase strips'}},
  trackOrder:[track,...(timeline.trackOrder??Object.keys(timeline.tracks??{})).filter(id=>id!==track)]};
 return {doc:{...doc,timelines:doc.timelines.map(t=>t===timeline?active:t)},units};
}
