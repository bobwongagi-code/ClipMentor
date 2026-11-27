import type {ProjectDoc} from '../../src/editor/types';
import {deliveryAudio,deliverySectionsFromDoc} from '../../src/clipmentor/delivery-bindings';
import {nativeExecutionMapping} from '../../src/clipmentor/source-breakdown';

/** Use output frames on the verified edit. Source-video seconds do not locate
 * a chapter after cutting. Partial or ambiguous plans simply have fewer links. */
export function productionPreviewChapters(doc:ProjectDoc,duration:number|undefined){
 const timeline=doc.timelines.find(t=>t.id===doc.activeTimelineId);
 if(!timeline||!Number.isFinite(timeline.fps)||timeline.fps<=0)return [];
 const chapters:Array<{id:string;label:string;seconds:number}>=[];
 const frames=timeline.items.reduce((end,item)=>Math.max(end,item.startFrame+item.durationInFrames),0);
 const limit=Math.min(frames/timeline.fps,duration??Infinity);
 const add=(id:string,label:string,frame:number)=>{
  const seconds=frame/timeline.fps;
  if(Number.isSafeInteger(frame)&&frame>=0&&seconds<limit&&!chapters.some(c=>c.seconds===seconds))chapters.push({id,label,seconds});
 };
 const units=doc.clipMentorAnalysis?.source_breakdown?.units??[];
 const mapping=units.some(unit=>!unit.placement)?nativeExecutionMapping(doc):undefined;
 const groupPlacements=units.map(unit=>unit.placement??(mapping?.issues.some(issue=>issue.id===unit.unit_id||issue.id==='analysis')?undefined:mapping?.placements[unit.unit_id]));
 for(const section of deliverySectionsFromDoc(doc)){
  try{
   const {asset}=deliveryAudio(doc,section);
   const matches=timeline.items.filter(item=>item.kind==='audio'&&item.sourceAssetId===asset.id&&item.src===asset.src
    &&!timeline.tracks?.[item.track]?.muted&&!timeline.tracks?.[item.track]?.hidden&&(item.volume??1)>0
    &&(item.srcInFrame??0)===0&&(item.playbackRate??1)===1&&item.durationInFrames===asset.durationInFrames);
   if(matches.length===1)add('delivery/'+section.section_id,section.kind==='performance_opening'?'片头':'片尾',matches[0].startFrame);
  }catch{/* Older bookends may lack a scheduled audio binding. */}
 }
 groupPlacements.forEach((placement,index)=>{
  if(!placement||placement.timeline_id!==timeline.id)return;
  const start=placement.original_frames[0],previous=groupPlacements[index-1];
  // Early groups may share original playback. Use the group's own explanation
  // when the original is also scheduled inside the preceding group.
  const frame=previous?.timeline_id===timeline.id&&start<previous.original_frames[1]?placement.explanation_frames[0]:start;
  add(units[index].unit_id,`第 ${index+1} 组`,frame);
 });
 return chapters.sort((a,b)=>a.seconds-b.seconds);
}
