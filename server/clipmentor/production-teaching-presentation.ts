import {stageCuePalette} from '../../src/clipmentor/blueprint-picture-notices';
import {contiguousPlaybackRuns,nativeExecutionMapping} from '../../src/clipmentor/source-breakdown';
import type {ProjectDoc,TimelineItem} from '../../src/editor/types';

type Row=Record<string,unknown>;
type Window=[number,number];
const record=(value:unknown):Row=>value&&typeof value==='object'&&!Array.isArray(value)?value as Row:{};
const entries=(value:unknown):Row[]=>Array.isArray(value)?value.map(record):[];
const normalized=(value:unknown)=>typeof value==='string'
 ?value.normalize('NFC').replace(/[^\p{L}\p{N}]+/gu,' ').trim(): '';
const duration=(windows:Window[])=>windows.reduce((sum,[start,end])=>sum+end-start,0);
const contains=(windows:Window[],start:number,end:number)=>windows.some(([a,b])=>start>=a&&end<=b);

/** Apply the saved cues to the actual authored text layers. The edit still owns
 * what the viewer sees. Captions are identified from the approved words and
 * the measured voice instance, never by a free-text label or track name. */
export function productionTeachingPresentation(doc:ProjectDoc,options:{apply?:boolean}={}){
 const a=doc.clipMentorAnalysis;
 const timeline=doc.timelines.find(t=>t.id===doc.activeTimelineId);
 if(!a?.source_breakdown||!timeline)return {doc,units:[]};
 const native=nativeExecutionMapping(doc);
 const allOriginals=[...Object.values(native.teachingPhases).flatMap(phases=>phases.original),
  ...a.source_breakdown.units.flatMap(unit=>unit.placement?.timeline_id===timeline.id?[unit.placement.original_frames]:[])];
 const updates=new Map<string,{cue:boolean;props:ReturnType<typeof stageCuePalette>}|null>();
 const missing:Array<{id:string;text:string;span:Window;style:ReturnType<typeof stageCuePalette>}>=[];
 const units=a.source_breakdown.units.flatMap(unit=>{
  const board=a.blueprint.find(b=>b.unit_id===unit.unit_id),internal=record(record(board).internal_review);
  const plan=record(internal[String(internal.current_picture_plan)]),candidate=record(internal[String(internal.current_script_candidate)]);
  const cues=record(plan.viewer_stage_cues),layout=record(cues.layout);
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
  const use=(t:typeof timeline.items[number])=>!timeline.tracks?.[t.track]?.hidden&&t.transform?.opacity!==0;
  const audioByLine=new Map<string,{words:string[];span:Window}>();
  const labels=new Set(entries(cues.revisit).map(cue=>normalized(cue.text)).filter(Boolean));
  for(const line of entries(candidate.lines)){
   if(typeof line.narration_ms!=='string')continue;
   if(Array.isArray(line.labels))for(const label of line.labels)labels.add(normalized(label));
   const voices=timeline.items.filter(t=>t.kind==='audio'&&use(t)&&contains(explanation,t.startFrame,t.startFrame+t.durationInFrames)
    &&doc.assets.some(asset=>asset.id===t.sourceAssetId&&asset.src===t.src&&record(asset.props?.generation).text===line.narration_ms));
   if(voices.length!==1)continue;
   const voice=voices[0];
   audioByLine.set(String(line.id),{words:[normalized(line.narration_ms),...(Array.isArray(line.caption_lines)?line.caption_lines.map(normalized):[])],
    span:[voice.startFrame,voice.startFrame+voice.durationInFrames]});
  }
  const stageCounts={original:0,explanation:0};
  let captionCount=0;
  const referenceReads=entries(plan.timing_dispositions).filter(row=>row.action==='reference_reading')
   .map(row=>({lineId:row.line_id,information:row.reason}));
  const sourceStills=timeline.items.flatMap(item=>{
   if(!referenceReads.length||item.kind!=='image'||!use(item)
    ||!contains(explanation,item.startFrame,item.startFrame+item.durationInFrames))return [];
   const asset=doc.assets.find(asset=>asset.id===item.sourceAssetId&&asset.src===item.src);
   if(asset?.props?.sourceAssetId!==a.source.asset_id||typeof asset.props.sourceSeconds!=='number')return [];
   return [{sourceSeconds:asset.props.sourceSeconds,startsAt:item.startFrame/timeline.fps,seconds:item.durationInFrames/timeline.fps}];
  });
  for(const item of timeline.items){
   const words=normalized(item.props?.text);
   if(item.kind!=='text'||!words||!use(item))continue;
   const start=item.startFrame,end=start+item.durationInFrames;
   const phase=contains(original,start,end)?'original':contains(explanationCueWindows,start,end)?'explanation':undefined;
   if(!phase)continue;
   const phaseLabel=phase==='original'?words===normalized(record(cues.original).text)
    :entries(cues.revisit).some(cue=>words===normalized(cue.text));
   const caption=phase==='explanation'&&!labels.has(words)&&[...audioByLine.values()].some(({words:approved,span})=>
    contains([span],start,end)&&approved.some(text=>text===words||words.includes(' ')&&` ${text} `.includes(` ${words} `)));
   if(!phaseLabel&&!caption)continue;
   if(phaseLabel)stageCounts[phase]++;
   else captionCount++;
   const style={cue:phaseLabel,props:stageCuePalette(phase==='original'?layout.original:layout.revisit,phase)};
   const prior=updates.get(item.id);
   updates.set(item.id,prior!==undefined&&JSON.stringify(prior)!==JSON.stringify(style)?null:style);
  }
  const originalText=record(cues.original).text;
  const revisitTexts=[...new Set(entries(cues.revisit).flatMap(cue=>typeof cue.text==='string'&&cue.text.trim()?[cue.text]:[]))];
  // If the editor omitted a whole phase label, recover the unambiguous saved
  // title. A plan with multiple revisit titles still owns their individual timing.
  for(const [phase,windows,title,style] of [
   ['original',original,originalText,layout.original],['explanation',explanationCueWindows,revisitTexts.length===1?revisitTexts[0]:undefined,layout.revisit],
  ] as const){
   if(stageCounts[phase]||typeof title!=='string'||!title.trim())continue;
   windows.forEach((span,index)=>missing.push({id:`clipmentor-stage-${unit.unit_id}-${phase}-${index}`,span,text:title,
    style:stageCuePalette(style,phase)}));
  }
  return [{unitId:unit.unit_id,originalSeconds:duration(original)/timeline.fps,explanationSeconds:duration(explanation)/timeline.fps,
   stageLabels:stageCounts,matchedCaptionCards:captionCount,referenceReads,sourceStills}];
 });
 if(!options.apply||(!updates.size&&!missing.length))return {doc,units};
 const items=timeline.items.map(item=>{
  const change=updates.get(item.id);
  if(!change)return item;
  const props={...item.props,...change.props,backgroundOpacity:1};
  if(!change.cue)return {...item,props};
  const {transform:_position,...rest}=item;
  return {...rest,props:{...props,placement:'top_strip'}};
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
  width:timeline.width,height:timeline.height,props:{text,...style,placement:'top_strip',backgroundOpacity:1},
 }));
 const active={...timeline,items:[...items,...strips],tracks:{...timeline.tracks,[track]:{kind:'video' as const,name:'Phase strips'}},
  trackOrder:[track,...(timeline.trackOrder??Object.keys(timeline.tracks??{})).filter(id=>id!==track)]};
 return {doc:{...doc,timelines:doc.timelines.map(t=>t===timeline?active:t)},units};
}
