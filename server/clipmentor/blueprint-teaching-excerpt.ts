import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ensureBrowser} from '@remotion/renderer';
import {readBlueprint} from '../../src/clipmentor/blueprint-lint';
import {copyLineSourceBinding} from '../../src/clipmentor/source-breakdown';
import {currentPicturePhases,stageCueColors} from '../../src/clipmentor/blueprint-picture-notices';
import type {ProjectDoc,TimelineItem,TimelineState} from '../../src/editor/types';
import {sha256File} from '../../shared/node-content-hash';
import {isSafeUploadName,resolveUploadFile} from '../media-dir';
import {materializeServerExportMedia} from '../plugins/export-media-plan';
import {renderTimeline} from '../plugins/export-rendering';

const MAX_REVISIT_SECONDS=6;
export const TEACHING_EXCERPT_MAX_BYTES=2*1024*1024;
const row=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
function range(value:unknown):[number,number]|null {
 return Array.isArray(value)&&value.length===2&&value.every(v=>typeof v==='number'&&Number.isFinite(v))
  &&value[0]>=0&&value[1]>value[0]?[value[0],value[1]]:null;
}
const frameCeil=(time:number,fps:number)=>Math.max(0,Math.ceil(time*fps-1e-8));
const cueText=(value:unknown)=>typeof value==='string'&&value.trim().length<=42?value.trim():'';

export function representativeTeachingExcerpt(doc:ProjectDoc,data=readBlueprint(doc)){
 const source=doc.clipMentorAnalysis?.source;
 const breakdown=doc.clipMentorAnalysis?.source_breakdown;
 const timeline=doc.timelines.find(t=>t.id===doc.activeTimelineId);
 const asset=doc.assets.find(a=>a.id===source?.asset_id);
 const fps=source?.fps??0;
 if(data.issues.length||!source||!breakdown||!timeline||timeline.width<360||timeline.width>2160||timeline.width*16!==timeline.height*9
  ||!Number.isInteger(fps)||fps<15||fps>60||timeline.fps!==fps||!asset||asset.kind!=='video'
  ||!asset.width||!asset.height||!Number.isSafeInteger(asset.durationInFrames)||asset.durationInFrames!<1
  ||!source.sourceContentHash||asset.sourceContentHash!==source.sourceContentHash||!asset.src.startsWith('/media/uploads/')
  ||!isSafeUploadName(asset.src.slice('/media/uploads/'.length)))return null;
 const duration=Math.min(source.duration_seconds,asset.durationInFrames!/fps);
 const within=(v:[number,number],outer:[number,number])=>v[0]>=outer[0]&&v[1]<=outer[1];
 const spans=(v:[number,number])=>({first:frameCeil(v[0],fps),end:frameCeil(v[1],fps)});
 const candidates=data.selectedPlans.flatMap(({plan,resolved,unit})=>{
  const unitId=unit.unit_id;
  if(typeof unitId!=='string'||!unitId)return [];
  const {phases,operational,issues,legacyMissing}=resolved??currentPicturePhases(plan,data.root.estimated_picture_timeline,unitId,fps,duration);
  if(issues.length||legacyMissing||phases[0]?.mode!=='original'||phases.length!==2||phases[1]?.mode!=='explanation')return [];
  const [original,revisit]=phases;
  if(phases.some(p=>p.source_asset_id!==undefined&&p.source_asset_id!==asset.id))return [];
  const originalRange=range(original.source_range_seconds??original.source_seconds);
  const revisitRange=range(revisit.source_range_seconds??revisit.source_seconds);
  if(!originalRange||originalRange[1]>duration||!revisitRange||revisitRange[1]>duration)return [];
  const context=revisit.context_source_ranges;
  if(!Array.isArray(context)||!context.length||context.length>8)return [];
  const selections=context.map(x=>range(row(x).source_range_seconds));
  if(selections.some((x,index)=>!x||!within(x,revisitRange)||!within(x,originalRange)
   ||index>0&&x[0]<selections[index-1]![1]))return [];
  const selected=selections.map(x=>spans(x!));
  if(selected.some(x=>x.end<=x.first)||selected.reduce((sum,x)=>sum+x.end-x.first,0)>MAX_REVISIT_SECONDS*fps)return [];
  const cues=row(operational.viewer_stage_cues);
  const lineId=revisit.line_id;
  const replayCue=Array.isArray(cues.revisit)?cues.revisit.map(row).filter(c=>Array.isArray(c.line_ids)&&c.line_ids.includes(lineId)):[];
  const originalLabel=cueText(row(cues.original).text),revisitLabel=replayCue.length===1?cueText(replayCue[0].text):'';
  const line=data.lines.find(l=>l.id===lineId);
  const unitBinding=breakdown.units.find(u=>u.unit_id===unitId);
  if(!originalLabel||!revisitLabel||!line||!unitBinding||!copyLineSourceBinding(breakdown,unitBinding,line.raw,operational))return [];
  const layout=row(cues.layout);
  const palette=[stageCueColors(layout.original,'original'),stageCueColors(layout.revisit,'explanation')];
  // Show the longest registered action before the planned replay. An arbitrary
  // original tail can contain the next action, even inside the saved group.
  const anchor=selected.reduce((a,b)=>b.end-b.first>a.end-a.first?b:a);
  const originalSample={first:anchor.first,end:Math.min(anchor.end,anchor.first+2*fps)};
  return [{unitId,original:originalSample,originalLabel,selected,revisitLabel,palette}];
 });
 // Prioritize the registered comparison with the most independently timed shots.
 const picked=candidates.sort((a,b)=>b.selected.length-a.selected.length)[0];
 if(!picked)return null;
 const {width,height}=timeline;
 const items:TimelineItem[]=[];
 let startFrame=0;
 for(const [index,clip] of [picked.original,...picked.selected].entries()){
  const durationInFrames=clip.end-clip.first;
  const base={startFrame,durationInFrames};
  items.push({...base,id:'source-'+index,track:'track-v1',kind:'video',name:'原片',src:asset.src,
   width:asset.width,height:asset.height,srcInFrame:clip.first,sourceAssetId:asset.id,sourceContentHash:asset.sourceContentHash,
   volume:index===0?1:0});
  startFrame+=durationInFrames;
 }
 const originalFrames=picked.original.end-picked.original.first;
 for(const [index,label] of [picked.originalLabel,picked.revisitLabel].entries()){
  items.push({id:'stage-'+index,kind:'text',track:'track-v2',name:label,width,height,
   startFrame:index===0?0:originalFrames,durationInFrames:index===0?originalFrames:startFrame-originalFrames,
   props:{text:label,placement:'top_strip',color:picked.palette[index][1],
    backgroundColor:picked.palette[index][0],
    backgroundOpacity:1,fontWeight:700,textShadow:'none'}});
 }
 const state:TimelineState={fps,width,height,fit:'contain',trackOrder:['track-v2','track-v1'],items,selectedId:null};
 return {unitId:picked.unitId,asset,state};
}

/** Uses the native timeline export, in a temporary directory and within a bounded request. */
export async function verifyTeachingExcerptAsset(asset:NonNullable<ReturnType<typeof representativeTeachingExcerpt>>['asset']){
 const path=resolveUploadFile(asset.src.slice('/media/uploads/'.length));
 if(!path||await sha256File(path)!==asset.sourceContentHash)throw Error('Teaching excerpt source changed');
 return path;
}

export async function renderTeachingExcerpt(excerpt:NonNullable<ReturnType<typeof representativeTeachingExcerpt>>,signal:AbortSignal){
 const {asset,state}=excerpt;
 const name=asset.src.slice('/media/uploads/'.length);
 const path=await verifyTeachingExcerptAsset(asset);
 signal.throwIfAborted();
 const configured=process.env.CC_BROWSER_EXECUTABLE;
 const browser=configured?null:await ensureBrowser({chromeMode:'headless-shell',onBrowserDownload:()=>{throw Error('Local preview browser unavailable');}});
 const browserExecutablePath=configured||(browser?.type==='local-puppeteer-browser'?browser.path:undefined);
 if(!browserExecutablePath)throw Error('Local preview browser unavailable');
 const folder=await mkdtemp(join(tmpdir(),'clipmentor-excerpt-'));
 let cleanup=()=>Promise.resolve();
 try{
  const media=await materializeServerExportMedia(state,{signal,resolveUpload:n=>n===name?path:null,
   resolveUploadReference:n=>n===name?path:null,hydrateUpload:async()=>null});
  cleanup=media.cleanup;
  const outputLocation=join(folder,'teaching.mp4');
  await renderTimeline({state:media.snapshot,outputLocation,frameRange:[0,state.items.filter(i=>i.kind==='video').reduce((n,i)=>n+i.durationInFrames,0)-1],
   codec:'h264',scale:360/state.width,videoBitrate:900_000,signal,browserExecutablePath});
  if((await stat(outputLocation)).size>TEACHING_EXCERPT_MAX_BYTES)throw Error('Teaching excerpt exceeds byte limit');
  const bytes=await readFile(outputLocation,{signal});
  if(!bytes.length||await sha256File(path)!==asset.sourceContentHash)throw Error('Teaching excerpt source changed');
  signal.throwIfAborted();
  return bytes;
 }finally{
  try{await cleanup();}finally{await rm(folder,{recursive:true,force:true});}
 }
}
