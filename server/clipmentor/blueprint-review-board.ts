/** Internal, read-only review artifact. Phases remain the saved plan, never a timeline. */
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {readFile,mkdir,mkdtemp,rm,writeFile,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {readBlueprint,lintBlueprint} from '../../src/clipmentor/blueprint-lint';
import {currentPicturePhases,blueprintPictureNotices,pictureNoticeRows} from '../../src/clipmentor/blueprint-picture-notices';
import {deliverySectionsFromDoc,deliveryPictureBindings,type DeliverySection} from '../../src/clipmentor/delivery-sections';
import {labelTranslationsConflict} from '../../src/clipmentor/author-translations';
import type {ProjectDoc,MediaAsset} from '../../src/editor/types';
import {isSafeUploadName,resolveUploadFile} from '../media-dir';
import {sha256File} from '../../shared/node-content-hash';
import {extractOneFrame} from '../plugins/extract-frames';
import {sourceFrameSeekMs} from '../../shared/source-frame-seek';
import {tileContactSheet,formatFrameLabel} from '../frame-grid';
import {loadOfflineStoredProject} from '../external-agent/offline-project-store';
import {blueprintReviewBoardPage} from './blueprint-review-board-page';
import {humanReviewBoardPage} from './blueprint-review-board-human';
import {deliveryLayoutStages,renderDeliveryLayoutFrames} from './delivery-layout-frames';
import type {VisualReferenceFrame} from './visual-done-criteria';
export type ReviewBoardView='human'|'planner';

type Row=Record<string,unknown>;
const obj=(v:unknown):Row=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Row:{};
const arr=(v:unknown):unknown[]=>Array.isArray(v)?v:[];
const txt=(v:unknown)=>typeof v==='string'?v:'';
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
function fail(message:string):never{throw Error('INPUT: '+message);}
const window=(v:unknown):[number,number]|null=>Array.isArray(v)&&v.length===2&&v.every(n=>typeof n==='number'&&Number.isFinite(n))&&v[0]>=0&&v[1]>=v[0]?[v[0],v[1]]:null;
const frameFloor=(v:number)=>Math.abs(v-Math.round(v))<=4*Number.EPSILON*Math.max(1,Math.abs(v))?Math.round(v):Math.floor(v);
export const REVIEW_BOARD_FRAME_LIMIT=96;
export interface ReviewBoardRow {
 key:string;unit_id:string;stage:'opening'|'original'|'explanation'|'closing';line_ids:string[];
 lines:Array<{id:string;ms:string;zh:string;cards:string[][];labels:string[]}>;
 range:[number,number]|null;asset_id:string;asset_hash:string;picture:string;
 stage_text:string;colors:string[];notices:string[];lint:ReturnType<typeof lintBlueprint>['findings'];
 crop?:{left:number;top:number;right:number;bottom:number};tool_crop_px?:unknown;
 frames:Array<{key:string;frame:number;seconds:number;label:string;jpeg?:string}>;sheet?:string;reuse:string[];ending_variant?:string;
 full_picture?:{key:string;jpeg?:string};
 deliveryLayout?:DeliverySection['picture'];
}
export interface ReviewBoardPlan {
 candidate_id:string;candidate_sha256:string;hash_mode:'file'|'project';variant:string;
 source:{asset_id:string;sourceContentHash:string;fps:number;duration_seconds:number};rows:ReviewBoardRow[];
 reuse:Array<{id:string;range:[number,number];row_keys:string[]}>;generated_at:string;
 frame_count:number;unique_frame_count:number;elapsed_ms:number;binding_sha256:string|null;
}
export interface BoardInput {
 value:unknown;sha256:string;hashMode:'file'|'project';assertUnchanged:()=>Promise<void>;
 bindings?:ProjectDoc[];bindingSha256?:string;mediaDir?:string;
 visualReferences?:VisualReferenceFrame[];
}
export async function loadReviewBoardInput(input:string,options:{bindings?:string[];mediaDir?:string}={}):Promise<BoardInput>{
 let value:unknown,sha256:string,hashMode:'file'|'project',assertUnchanged:()=>Promise<void>;
 if(input.toLowerCase().endsWith('.json')){
  const file=resolve(input);let raw:Buffer;try{raw=await readFile(file);value=JSON.parse(raw.toString('utf8'));}catch{fail('候选JSON无法读取');}
  sha256=hash(raw!);hashMode='file';assertUnchanged=async()=>{if(await sha256File(file)!==sha256)fail('生成中候选已变化');};
 }else{
  const snapshot=await loadOfflineStoredProject(input);if(!snapshot)fail('工程不存在');value=snapshot.doc;sha256=hash(JSON.stringify(value));hashMode='project';
  assertUnchanged=async()=>{const current=await loadOfflineStoredProject(input);if(!current||hash(JSON.stringify(current.doc))!==sha256)fail('生成中工程已变化');};
 }
 let bindings:ProjectDoc[]|undefined,bindingSha256:string|undefined;
 if(options.bindings?.length){bindings=[];const frozen:Array<{path:string;hash:string}>=[];for(const file of options.bindings){const path=resolve(file);try{const bytes=await readFile(path);bindings.push(JSON.parse(bytes.toString('utf8')) as ProjectDoc);frozen.push({path,hash:hash(bytes)});}catch{fail('正式素材绑定JSON无法读取');}}bindingSha256=hash(JSON.stringify(frozen.map(f=>f.hash)));const prior=assertUnchanged!;assertUnchanged=async()=>{await prior();for(const f of frozen)if(await sha256File(f.path)!==f.hash)fail('生成中素材绑定已变化');};}
 return{value,sha256:sha256!,hashMode:hashMode!,assertUnchanged:assertUnchanged!,bindings,bindingSha256,mediaDir:options.mediaDir};
}
function lineView(line:ReturnType<typeof readBlueprint>['lines'][number]){
 if(!line.text.trim()||!line.zh.trim())fail('口播或中文意思缺失: '+line.id);
 const raw=line.raw,cards=arr(raw.caption_cards).map(v=>arr(obj(v).lines).map(txt));
 if(cards.some(c=>!c.length||c.some(s=>!s.trim())))fail('字幕分卡不可读: '+line.id);
 const caption=arr(raw.caption_lines).map(txt);if(!caption.length||caption.some(s=>!s.trim()))fail('字幕缺失: '+line.id);
 if((cards.length?cards.flat():caption).join(' ').replace(/\s+/g,' ').trim()!==line.text.replace(/\s+/g,' ').trim())fail('字幕与口播不一致: '+line.id);
 return{id:line.id,ms:line.text,zh:line.zh,cards:cards.length?cards:[caption],labels:arr(raw.labels).map(v=>typeof v==='string'?v:txt(obj(v).text)).filter(Boolean)};
}
export function planReviewBoards(input:BoardInput,variant?:string):{plans:ReviewBoardPlan[];doc:ProjectDoc;assets:Map<string,MediaAsset>;data:ReturnType<typeof readBlueprint>;lint:ReturnType<typeof lintBlueprint>}{
 const data=readBlueprint(input.value),lint=lintBlueprint(input.value);
 if(data.issues.length||lint.findings.some(f=>f.rule_id==='INPUT'))fail('候选读取/副本冲突: '+[...data.issues.map(i=>i.message),...lint.findings.filter(f=>f.rule_id==='INPUT').map(f=>f.message)].join('; '));
 const source=obj(data.analysis.source),fps=Number(source.fps),duration=Number(source.duration_seconds),sourceHash=txt(source.sourceContentHash);
 if(!txt(source.asset_id)||!/^[a-f0-9]{64}$/.test(sourceHash)||!Number.isFinite(fps)||fps<=0||!Number.isFinite(duration)||duration<=0)fail('原片身份或时钟无效');
 const rootDoc=input.value as ProjectDoc,docs=input.bindings??[rootDoc],doc=docs[0];
 if(!doc||!Array.isArray(doc.assets)||!Array.isArray(doc.timelines))fail('候选没有正式素材绑定，请提供 --bindings 工程JSON');
 const bindingSource=doc.clipMentorAnalysis?.source;if(!bindingSource||bindingSource.sourceContentHash!==sourceHash)fail('候选和正式素材原片不一致');
 const sourceAsset=doc.assets.find(a=>a.id===bindingSource.asset_id);if(!sourceAsset||sourceAsset.kind!=='video'||sourceAsset.sourceContentHash!==sourceHash)fail('缺少原片素材');
 const assets=new Map(doc.assets.map(a=>[a.id,a]));assets.set(txt(source.asset_id),sourceAsset);
 const deliveries=new Map<string,{section:DeliverySection;binding:ReturnType<typeof deliveryPictureBindings>[number]}>();
 const sameDelivery=(a:DeliverySection,b:DeliverySection)=>{
  const {labels_zh:aZh,...aLine}=a.line,{labels_zh:bZh,...bLine}=b.line;
  return !labelTranslationsConflict(aZh,bZh)&&isDeepStrictEqual(aLine,bLine)&&a.kind===b.kind
   &&isDeepStrictEqual(a.picture,b.picture)&&isDeepStrictEqual(a.evidence,b.evidence);
 };
 for(const material of docs){
  if(!material||!Array.isArray(material.assets)||!Array.isArray(material.timelines))fail('正式素材绑定结构不可读');
  if(material.clipMentorAnalysis?.source?.sourceContentHash!==sourceHash)fail('素材包原片不同');
  for(const asset of material.assets){const prior=assets.get(asset.id);if(prior&&JSON.stringify([prior.src,prior.sourceContentHash,prior.width,prior.height])!==JSON.stringify([asset.src,asset.sourceContentHash,asset.width,asset.height]))fail('同ID素材绑定冲突');assets.set(asset.id,asset);}
  for(const section of deliverySectionsFromDoc(material)){
   const prior=deliveries.get(section.line.line_id);
   if(prior){
    if(!sameDelivery(prior.section,section))fail('交付图片绑定副本冲突');
    // Remember the first supplied translation even when the first material was
    // legacy: missing -> A -> B must not compare both A and B only to missing.
    if(prior.section.line.labels_zh===undefined&&section.line.labels_zh!==undefined)prior.section.line.labels_zh=section.line.labels_zh;
    continue;
   }
   // Geometry stays attached to the material that supplied this exact section.
   deliveries.set(section.line.line_id,{section,binding:deliveryPictureBindings(material,[section])[0]});
  }
 }
 // An unbound planning candidate can borrow materials. A registered plan cannot
 // silently replace its current picture or evidence with an older material copy.
 const currentDoc=Array.isArray(rootDoc.assets)&&Array.isArray(rootDoc.timelines)?rootDoc:{...doc,assets:[...assets.values()],clipMentorAnalysis:data.analysis as unknown as ProjectDoc['clipMentorAnalysis']};
 for(const section of deliverySectionsFromDoc(currentDoc)){
  const material=deliveries.get(section.line.line_id);
  if(!material||!sameDelivery(section,material.section))fail('当前候选交付画面或证据与素材绑定不一致: '+section.line.line_id);
 }
 const lineById=new Map(data.lines.map(l=>[l.id,l])),ends=Object.entries(data.ends),variants=ends.length?ends.map(([id])=>id):['current'];
 if(variant&&variant!=='all'&&!variants.includes(variant))fail('达人版本不存在: '+variant);
 const chosen=variant&&variant!=='all'?[variant]:variants;
 const makeDelivery=(lineId:string,stage:'opening'|'closing',key:string):ReviewBoardRow=>{
  const line=lineById.get(lineId),delivery=deliveries.get(lineId);if(!line||!delivery)fail('缺少交付段正式图片绑定: '+lineId);
  const {section,binding}=delivery;
  if(line.text!==section.line.narration_ms||line.zh!==section.line.meaning_zh||JSON.stringify(arr(line.raw.labels))!==JSON.stringify(section.line.labels)
   ||labelTranslationsConflict(line.raw.labels_zh,section.line.labels_zh))fail('交付段绑定文稿不是本候选: '+lineId);
  if(section.picture.crop&&(!binding||binding.status!=='ready'||!('source_rect'in binding)))fail('交付图片裁切不可用: '+lineId);
  let crop:ReviewBoardRow['crop'];if(binding&&binding.status==='ready'&&'source_rect'in binding&&binding.source_rect&&binding.source_dimensions){const r=binding.source_rect,s=binding.source_dimensions;crop={left:r.x/s.width,top:r.y/s.height,right:(s.width-r.x-r.width)/s.width,bottom:(s.height-r.y-r.height)/s.height};}
  const layout=section.picture.layout?section.picture:undefined;
  const frames=layout?deliveryLayoutStages(layout).map((label,frame)=>({key:hash(JSON.stringify([layout,frame])),frame,seconds:0,label}))
   :[{key:hash(JSON.stringify({asset:section.picture.sha256,crop})),frame:0,seconds:0,label:'提供图片'+(crop?' · 已绑定裁切':'')}];
  return{key,unit_id:section.section_id,stage,line_ids:[lineId],lines:[lineView(line)],range:null,asset_id:section.picture.asset_id,asset_hash:section.picture.sha256,picture:section.picture.description,stage_text:stage==='opening'?'成绩开场':'达人结尾',colors:[],notices:[],lint:lint.findings.filter(f=>['B04','B05','B07'].includes(f.rule_id)&&f.location.includes(lineId)),crop,...(layout?{deliveryLayout:layout}:{}),...(binding&&'tool_crop_px'in binding?{tool_crop_px:binding.tool_crop_px}:{}),frames,reuse:[]};
 };
 const pictureNotices=blueprintPictureNotices(pictureNoticeRows(data));
 const body:ReviewBoardRow[]=[];
 for(const selected of data.selectedPlans){
  const plan=selected.plan,{operational,phases,legacyMissing}=selected.resolved??currentPicturePhases(plan,data.root.estimated_picture_timeline,selected.unit.unit_id,fps);
  if(legacyMissing)fail('旧方案未登记可读的阶段顺序');
  if(!phases.length||!selected.candidate_id||!selected.plan_id||txt(plan.script_candidate_id)!==selected.candidate_id)fail('现行画面方案/候选指针缺失或不一致');
  for(const [index,p]of phases.entries()){
   const phase=obj(p),stage=phase.mode===undefined&&txt(phase.line_id)?'explanation':phase.mode;
   if(stage!=='original'&&stage!=='explanation')fail('未知阶段，不猜播放顺序');
   if(phase.source_asset_id!==undefined&&phase.source_asset_id!==source.asset_id)fail('阶段引用的素材不是当前原片');
   const range=window(phase.source_range_seconds??phase.source_seconds);if(!range||range[0]>=duration||range[1]>duration)fail('阶段源窗无效');
   const ids=[...new Set([txt(phase.line_id),...arr(phase.line_ids).map(txt)].filter(Boolean))];if(stage==='explanation'&&!ids.length)fail('讲解阶段没有现行句ID');
   const lines=ids.map(id=>{const l=lineById.get(id);if(!l)fail('阶段引用不存在的句子: '+id);return lineView(l);});
   const cue=obj(operational.viewer_stage_cues),cueRows=stage==='original'?[obj(cue.original)]:arr(cue.revisit).map(obj).filter(r=>arr(r.line_ids).some(id=>ids.includes(txt(id))));
   const style=obj(cue.layout)[stage==='original'?'original':'revisit'],colors=typeof style==='string'?[...style.matchAll(/#[a-fA-F\d]{6}\b/g)].map(m=>m[0]):[txt(obj(style).color),txt(obj(style).text_color)].filter(Boolean);
   const picture=txt(phase.picture)||txt(obj(operational.composition).detail),notices:string[]=[];
   for(const finding of pictureNotices.filter(f=>f.row_keys.includes(`${txt(selected.unit.unit_id)}/${index}`)))notices.push(finding.message);
   if(!colors.length)notices.push('未声明可显示的阶段标识色值');
   for(const group of lint.groups.filter(g=>ids.some(id=>g.line_ids.includes(id))))notices.push(`B05 整组参考（估算）：${group.group_id}，${group.estimated_seconds===null?'声长未知':group.estimated_seconds.toFixed(2)+'秒声音'} / ${group.picture_seconds===null?'画面时长未知':group.picture_seconds.toFixed(2)+'秒计划画面'}；不能当实测或承载通过。`);
   const last=Math.max(0,frameFloor(duration*fps-1)),frames=[...new Set((range[0]===range[1]?[range[0]]:[range[0],(range[0]+range[1])/2,Math.max(range[0],range[1]-1/fps)]).map(s=>Math.min(last,frameFloor(s*fps))))];
   body.push({key:`${txt(selected.unit.unit_id)}/${index}`,unit_id:txt(selected.unit.unit_id),stage,line_ids:ids,lines,range,asset_id:txt(source.asset_id),asset_hash:sourceHash,picture,stage_text:cueRows.map(r=>txt(r.text)).filter(Boolean).join(' / ')||'未登记阶段标识',colors,notices,lint:lint.findings.filter(f=>['B04','B05','B07'].includes(f.rule_id)&&(ids.some(id=>f.location.includes(id))||f.location.includes(selected.path)||f.location.includes(txt(selected.unit.unit_id)))),frames:frames.map(frame=>({key:hash(sourceHash+':'+frame),frame,seconds:frame/fps,label:formatFrameLabel(frame,fps)})),reuse:[]});
  }
 }
 if(!body.length)fail('没有可读的阶段');
 const bodyLineIds=new Set(body.flatMap(r=>r.line_ids));for(const line of data.lines)if(!data.deliveryIds.has(line.id)&&!bodyLineIds.has(line.id))fail('现行句没有阶段: '+line.id);
 const plans=chosen.map(v=>{
  const rows:ReviewBoardRow[]=[];const openingId=txt(data.opening.id)||txt(data.opening.line_id);if(openingId)rows.push(makeDelivery(openingId,'opening','opening'));
  rows.push(...structuredClone(body));const end=ends.find(([id])=>id===v);if(end){const ending=obj(end[1]);rows.push(makeDelivery(txt(ending.id)||txt(ending.line_id),'closing','closing'));}
  if(new Set(rows.map(r=>r.key)).size!==rows.length)fail('阶段ID重复');
  const points=[...new Set(rows.flatMap(r=>r.range??[]))].sort((a,b)=>a-b),reuse:ReviewBoardPlan['reuse']=[];
  for(let i=1;i<points.length;i++){const active=rows.filter(r=>r.range&&r.range[0]<=points[i-1]&&r.range[1]>=points[i]);if(active.length<2)continue;const keys=active.map(r=>r.key),prior=reuse.at(-1);if(prior&&prior.range[1]===points[i-1]&&JSON.stringify(prior.row_keys)===JSON.stringify(keys))prior.range[1]=points[i];else reuse.push({id:'R'+(reuse.length+1),range:[points[i-1],points[i]],row_keys:keys});}
  for(const point of points){if(!rows.some(r=>r.range?.[0]===point&&r.range[1]===point))continue;const active=rows.filter(r=>r.range&&r.range[0]<=point&&(r.range[1]>point||r.range[0]===point&&r.range[1]===point));if(active.length>=2)reuse.push({id:'R'+(reuse.length+1),range:[point,point],row_keys:active.map(r=>r.key)});}
  for(const reused of reuse)for(const row of rows)if(reused.row_keys.includes(row.key))row.reuse.push(reused.id);
  const frame_count=rows.reduce((n,r)=>n+r.frames.length,0);if(frame_count>REVIEW_BOARD_FRAME_LIMIT)fail('帧数超限: '+frame_count+' > '+REVIEW_BOARD_FRAME_LIMIT);
  return{candidate_id:txt(data.root.candidate_id)||txt(data.analysis.analysis_id)||'saved-blueprint',candidate_sha256:input.sha256,hash_mode:input.hashMode,variant:v,source:{asset_id:txt(source.asset_id),sourceContentHash:sourceHash,fps,duration_seconds:duration},rows,reuse,generated_at:new Date().toISOString(),frame_count,unique_frame_count:new Set(rows.flatMap(r=>r.frames.map(f=>f.key))).size,elapsed_ms:0,binding_sha256:input.bindingSha256??null};
 });return{plans,doc,assets,data,lint};
}
export async function renderReviewBoards(input:BoardInput,outDir:string,variant?:string,view:ReviewBoardView='planner'){
 if(view!=='human'&&view!=='planner')fail('未知审片板视图');
 if(view==='human'&&variant&&variant!=='all')fail('人审版合并全部结尾，不单选variant');
 const start=performance.now(),prepared=planReviewBoards(input,variant),{assets,data,lint}=prepared;let plans=prepared.plans;
 if(view==='human'){
  const first=plans[0],common=first.rows.filter(r=>r.stage!=='closing');
  for(const p of plans)if(JSON.stringify(p.rows.filter(r=>r.stage!=='closing'))!==JSON.stringify(common))fail('不同版本主体不一致，不能合并');
  const endings=plans.flatMap(p=>p.rows.filter(r=>r.stage==='closing').map((r):ReviewBoardRow=>({
   ...r,key:r.key+'/'+p.variant,ending_variant:p.variant,
   full_picture:r.crop&&Object.values(r.crop).some(edge=>edge>0)?{key:hash(JSON.stringify({asset:r.asset_hash}))}:undefined,
  })));
  const rows=[...common,...endings];
  const frameKeys=rows.flatMap(r=>[...r.frames.map(f=>f.key),...(r.full_picture?[r.full_picture.key]:[])]);
  if(frameKeys.length>REVIEW_BOARD_FRAME_LIMIT)fail('合并人审版帧数超限');
  plans=[{...first,variant:'human',rows,frame_count:frameKeys.length,unique_frame_count:new Set(frameKeys).size}];
 }
 const files=new Map<string,string>(),checked=new Map<string,string>();
 // Preflight every required file before extraction; never hydrate/fetch media.
 for(const row of plans.flatMap(p=>p.rows)){
  const asset=assets.get(row.asset_id);if(!asset||asset.sourceContentHash!==row.asset_hash)fail('图片或原片身份不一致: '+row.asset_id);
  if(typeof asset.src!=='string'||![asset.width??576,asset.height??1024].every(n=>Number.isFinite(n)&&n>0))fail('素材地址或尺寸无效: '+row.asset_id);
  let file:string|null=null;if(asset.src.startsWith('/media/uploads/')){const name=asset.src.slice('/media/uploads/'.length);if(!isSafeUploadName(name))fail('非法本地素材路径');file=input.mediaDir?join(resolve(input.mediaDir),name):resolveUploadFile(name);}
  if(!file)fail('本地原片/图片不存在: '+row.asset_id);try{if(await sha256File(file)!==row.asset_hash)fail('素材哈希不一致: '+row.asset_id);}catch{fail('本地原片/图片缺失或哈希不一致: '+row.asset_id);}files.set(row.asset_id,file);checked.set(file,row.asset_hash);
 }
 const temp=await mkdtemp(join(tmpdir(),'blueprint-board-')),cache=new Map<string,Buffer>(),sheets=new Map<string,string>();
 async function frameBytes(key:string,row:ReviewBoardRow,seconds:number,crop?:ReviewBoardRow['crop']){
  const cached=cache.get(key);if(cached)return cached;
  const path=join(temp,key+'.jpg');
  await extractOneFrame(files.get(row.asset_id)!,sourceFrameSeekMs(seconds*1000),path,false,crop);
  const bytes=await readFile(path);
  cache.set(key,bytes);
  return bytes;
 }
 try{
  for(const plan of plans){const begun=performance.now();for(const row of plan.rows){
   if(row.deliveryLayout&&!cache.has(row.frames[0].key)){
    const frames=await renderDeliveryLayoutFrames(row.deliveryLayout,{
     resolve:name=>input.mediaDir?join(resolve(input.mediaDir),name):resolveUploadFile(name),hash:sha256File});
    row.frames.forEach((sample,index)=>cache.set(sample.key,frames[index]));
   }
   for(const sample of row.frames)sample.jpeg=(await frameBytes(sample.key,row,sample.seconds,row.crop)).toString('base64');
   if(row.full_picture)row.full_picture.jpeg=(await frameBytes(row.full_picture.key,row,0)).toString('base64');
   const signature=hash(row.frames.map(f=>f.key).join(','));if(!sheets.has(signature)){const asset=assets.get(row.asset_id)!;const ratio=(asset.height??1024)*(1-(row.crop?.top??0)-(row.crop?.bottom??0))/((asset.width??576)*(1-(row.crop?.left??0)-(row.crop?.right??0)));sheets.set(signature,(await tileContactSheet(row.frames.map(f=>({jpeg:cache.get(f.key)!,label:f.label})),{cellWidth:320,cols:3,cellHeight:Math.round(320*ratio)})).toString('base64'));}row.sheet=sheets.get(signature);
  }plan.elapsed_ms=performance.now()-begun;}
  await input.assertUnchanged();for(const [file,expected]of checked)if(await sha256File(file)!==expected)fail('生成中素材已变化');
  const artifacts=plans.map(plan=>{const began=performance.now(),html=view==='human'?humanReviewBoardPage(plan,data,lint,input.bindings??[prepared.doc],input.visualReferences):blueprintReviewBoardPage(plan);plan.elapsed_ms+=performance.now()-began;if(Buffer.byteLength(html)>32_000_000)fail('单文件HTML超限');const safe=(s:string)=>s.replace(/[^\p{L}\p{N}_-]/gu,'_').slice(0,100);return{plan,html,path:join(resolve(outDir),`审片板-${safe(plan.candidate_id)}-${safe(plan.variant)}.html`)};});
  if(new Set(artifacts.map(a=>a.path)).size!==artifacts.length)fail('输出文件名冲突');
  await mkdir(outDir,{recursive:true});const staged:string[]=[];try{for(const a of artifacts){const began=performance.now();const path=a.path+'.'+hash(String(Math.random())).slice(0,12)+'.tmp';staged.push(path);await writeFile(path,a.html,{flag:'wx'});a.plan.elapsed_ms+=performance.now()-began;}await input.assertUnchanged();for(const [i,a]of artifacts.entries())await rename(staged[i],a.path);}finally{for(const path of staged)await rm(path,{force:true});}
  return{artifacts:artifacts.map(({plan,path})=>({path,candidate_id:plan.candidate_id,variant:plan.variant,candidate_sha256:plan.candidate_sha256,frame_count:plan.frame_count,unique_frame_count:plan.unique_frame_count,elapsed_ms:Math.round(plan.elapsed_ms)})),total_elapsed_ms:Math.round(performance.now()-start),provider_calls:0,network_calls:0,internal_review_only:true};
 }finally{await rm(temp,{recursive:true,force:true});}
}
