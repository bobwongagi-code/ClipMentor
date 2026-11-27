import {BLUEPRINT_OPINION_MAX_LENGTH} from '../../shared/clipmentor-blueprint-opinions';
/** Human presentation of the same saved plan. No new source selection or judgment. */
import type {ReviewBoardPlan,ReviewBoardRow} from './blueprint-review-board';
import type {ProjectDoc} from '../../src/editor/types';
import {sourceSpeech,unitUnknowns,translatedLabels,stageTranslations,overlaps,reviewReplayViews} from './blueprint-review-board-human-context';
import type {readBlueprint,lintBlueprint} from '../../src/clipmentor/blueprint-lint';
import {reviewBoardInteractions} from './blueprint-review-board-page';
import type {VisualReferenceFrame} from './visual-done-criteria';
import type {PublishedNarrationDecision} from './production-teaching-baseline';
type Data=ReturnType<typeof readBlueprint>;
type Lint=ReturnType<typeof lintBlueprint>;
const obj=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const arr=(v:unknown):unknown[]=>Array.isArray(v)?v:[];
const text=(v:unknown)=>typeof v==='string'?v:'';
const esc=(s:unknown)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const json=(v:unknown)=>JSON.stringify(v).replace(/</g,'\\u003c');
const n=(v:number)=>Number(v.toFixed(1)).toString();
const questionKey=(r:ReviewBoardRow)=>r.stage==='opening'||r.stage==='closing'?r.key:r.unit_id;
export function endingLabel(variant:string,index=0){
 if(variant==='new_contact')return'新建联达人';
 if(variant==='existing_partner')return'已合作达人';
 return `达人结尾${index+1}`;
}
/** Ask about visible claims with an editorial choice. The planner retains repair diagnostics. */
export function humanBoardQuestions(board:ReviewBoardPlan){
 const byUnit=new Map<string,Set<string>>();
 for(const row of board.rows){
  for(const finding of row.lint.filter(f=>f.rule_id==='B04'&&f.level==='warn'&&row.line_ids.includes(f.location))){
   const amounts=finding.excerpt.match(/(?:RM|MYR|USD)\s*[\d,.]+|[\d,.]+\s*%/gu);
   const question=amounts?.length?`计划上屏有${[...new Set(amounts)].join('、')}，请核对是否适用于本次内容。`:'计划上屏有口播未提到的数字，请核对是否适用于本次内容。';
   const key=questionKey(row);
   const questions=byUnit.get(key)??new Set<string>();
   questions.add(question);
   byUnit.set(key,questions);
  }
 }
 return byUnit;
}
export function humanReviewBoardPage(board:ReviewBoardPlan,data:Data,lint:Lint,_materials:ProjectDoc[]=[],references:VisualReferenceFrame[]=[],embedded=false,teachingExcerptUnit?:string,narrationDecisions:readonly PublishedNarrationDecision[]=[]){
 const body=board.rows.filter(r=>r.stage==='original'||r.stage==='explanation'),unitIds=[...new Set(body.map(r=>r.unit_id))],questions=humanBoardQuestions(board);
 const productName=text(obj(data.analysis.product).name).trim();
 const title=embedded||!productName||/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(productName)?'剪辑蓝图':productName;
 const version=board.candidate_id.match(/(?:^|[-_])v(\d+)/iu)?.[1];
 const revision=version?`第${version}版候选`:'现行保存候选';
 const teaching=(id:string)=>{const u=data.selectedPlans.find(p=>p.unit.unit_id===id)?.unit;const intent=text(u?.intent_zh).trim();
  if(embedded||intent)return intent;
  return arr(obj(data.analysis.source_breakdown).points).map(obj).filter(p=>arr(u?.point_ids).includes(p.point_id)).map(p=>text(p.teaching_question)).filter(Boolean).join('；')||'本组教学点尚未登记';};
 const originalDescription=(id:string)=>{const breakdown=obj(data.analysis.source_breakdown),unit=arr(breakdown.units).map(obj).find(u=>u.unit_id===id),segments=arr(breakdown.segments).map(obj).filter(s=>arr(unit?.original_segment_ids).includes(s.segment_id)),evidenceIds=segments.flatMap(s=>arr(s.visible_evidence_ids));const evidence=arr(data.analysis.evidence).map(obj).find(e=>evidenceIds.includes(e.evidence_id)&&e.kind==='visible_action'),range=evidence?.source_range_seconds;if(!text(evidence?.text)||!Array.isArray(range)||range.length!==2||!range.every(v=>typeof v==='number'&&Number.isFinite(v))||range[0]<0||range[1]<range[0])return null;return{text:text(evidence?.text),range:range as [number,number]};};
 const frameLabel=(r:ReviewBoardRow,i:number)=>`${r.stage==='original'?'原片':'讲解'}画面${i+1}`;
 const image=(r:ReviewBoardRow,i:number,detail?:string)=>{const f=r.frames[i],label=detail??frameLabel(r,i);return `<button class="image-button" data-zoom="${board.rows.indexOf(r)}"${detail?` data-zoom-frame="${i}"`:''} aria-label="放大${esc(label)}"><img src="data:image/jpeg;base64,${f.jpeg}" alt="${esc(label)}" decoding="async"></button>`;};
 const strip=(r:ReviewBoardRow,kind:string)=>`<div class="thumb-strip ${kind}">${r.frames.map((f,i)=>(r.stage==='original'||r.replayFrames)?`<figure>${image(r,i)}<figcaption>原片 ${n(f.seconds)}秒</figcaption></figure>`:image(r,i)).join('')}</div>`;
 const labelList=(lineId:string)=>{const labels=translatedLabels(data,lineId);return `${labels.invalid&&!embedded?'<p class="input-notice" data-input-code="INPUT">输入提示：短标中文与原文数量或类型不一致，未猜测对应。</p>':''}${labels.pairs.length?`<div class="label-copy"><h4>${embedded?'画面标注':'短标对照'}</h4><ul>${labels.pairs.map(p=>`<li><span lang="ms">${esc(p.ms)}</span>${p.zh||!embedded?`<span aria-hidden="true"> → </span><span>${esc(p.zh||'短标译文未登记')}</span>`:''}</li>`).join('')}</ul></div>`:''}`;};
 const stageCue=(row:ReviewBoardRow,style:string)=>embedded&&row.stage_text==='未登记阶段标识'?'':`<div class="stage-cue" style="${style}">${esc(row.stage_text)}</div>`;
 const copy=(r:ReviewBoardRow,lines=r.lines)=>lines.map(l=>`<div class="line-copy" data-line-id="${esc(l.id)}"><p class="meaning">${esc(l.zh)}</p><p class="narration" lang="ms">${esc(l.ms)}</p><div class="caption-cards">${l.cards.map((card,i)=>`<div class="caption-card"><span>${embedded?'字幕 ':'字幕卡'}${i+1}</span>${card.map(s=>`<p lang="ms">${esc(s)}</p>`).join('')}</div>`).join('')}</div>${labelList(l.id)}</div>`).join('');
 const mock=(r:ReviewBoardRow,lines:ReviewBoardRow['lines'][number])=>{
  const colors=r.colors.filter(c=>/^#[\da-f]{6}$/iu.test(c)),mid=Math.floor(r.frames.length/2);
  return`<figure class="mock"><figcaption>${embedded?'画面示意':'版式示意，非渲染 <span>示意模板</span>'}</figcaption><div class="mock-screen">${stageCue(r,`background:${colors[0]??'#e8e7e1'};color:${colors[1]??'#252a27'}`)}<div class="mock-visual">${image(r,mid)}${!r.replayFrames&&lines?.labels.length?`<div class="mock-labels" lang="ms">${lines.labels.map(v=>`<span style="background:${colors[0]??'#e8e7e1'};color:${colors[1]??'#252a27'}">${esc(v)}</span>`).join('')}</div>`:''}</div><div class="mock-caption" lang="ms">${lines?.cards[0]?.map(s=>`<p>${esc(s)}</p>`).join('')??''}</div></div>${strip(r,'explanation-strip')}</figure>`;
 };
 const stageStyle=(row:ReviewBoardRow)=>{
  const [background,foreground]=row.colors;
  const color=(value:string|undefined,fallback:string)=>value&&/^#[\da-f]{6}$/iu.test(value)?value:fallback;
  return `background:${color(background,'#e8e7e1')};color:${color(foreground,'#252a27')}`;
 };
 const replayGallery=(views:ReturnType<typeof reviewReplayViews>)=>{
  const stamp=(seconds:number)=>`原片 ${Number(seconds.toFixed(2))} 秒`;
  const keys=views.map(({frame})=>{
   const label=frame.selection?.shortLabel;
   return label?JSON.stringify([label.zh,label.ms]):undefined;
  });
  const areas=[...new Set(keys.filter(key=>key!==undefined))];
  const controls=views.map(({frame},i)=>{
   const name=frame.selection?.shortLabel?.zh;
   const ambiguous=name&&views.some((view,index)=>index!==i&&view.frame.selection?.shortLabel?.zh===name);
   return `<button type="button" data-show="${i}" aria-pressed="${i===0}">${esc(name?(ambiguous?`${name} · ${stamp(frame.seconds)}`:name):stamp(frame.seconds))}</button>`;
  }).join('');
  const frames=views.map(({row,index,frame},i)=>{
   const label=frame.selection?.shortLabel;
   return `<figure data-replay-frame="${i}"${keys[i]!==undefined?` data-recap-frame="${areas.indexOf(keys[i])}"`:''}${i===0?'':' hidden'}>${image(row,index,label?.zh??stamp(frame.seconds))}<figcaption>${label?`<strong>${esc(label.zh)}</strong> <span lang="ms">${esc(label.ms)}</span>`:''} <span class="replay-time">${stamp(frame.seconds)}</span></figcaption></figure>`;
  }).join('');
  return `<div class="replay-gallery"><div class="replay-navigation" role="group" aria-label="回看画面">${controls}${areas.length>1?'<button type="button" data-show="recap" aria-pressed="false">总览</button>':''}</div>${stageCue(views[0].row,stageStyle(views[0].row))}<div class="replay-frames">${frames}</div></div>`;
 };
 const questionHtml=(id:string)=>{const q=[...questions.get(id)??[]];return q.length?`<aside class="questions"><h3>需要你看一眼</h3>${q.map(v=>`<p>${esc(v)}</p>`).join('')}</aside>`:'';};
 const visualQuestions=(id:string)=>references.filter(({criterion})=>criterion.sectionId===id).map(({criterion,base64})=>
  `<aside class="questions"><h3>${esc(criterion.question)}</h3><blockquote style="white-space:pre-wrap">${esc(criterion.quote)}</blockquote><details class="picture-note"><summary>核对参照（不上屏）</summary><figure><img style="display:block;width:100%;max-width:15rem;height:auto" src="data:image/jpeg;base64,${esc(base64)}" alt="参照画面"><figcaption>${esc(criterion.reference.fileName)} · ${n(criterion.reference.seconds)}秒</figcaption></figure></details></aside>`).join('');
 // Older records also store Chinese listening notes in the original-language field.
 // Publish the timed Malay transcript where available, without guessing a quote from mixed prose.
 const transcript=(rows:ReviewBoardRow[])=>sourceSpeech(data,rows).filter(claim=>!embedded||!/[\p{Script=Han}]/u.test(claim.ms));
 const speechBlock=(index:number,originals:ReviewBoardRow[])=>{
  const claims=transcript(originals);
  const provenance=embedded?'机器听写，未经人工核对。':'模型听写，未经人工听审；中文为策划译文';
  const empty=embedded?'这一段没有可显示的听写内容。':'此段没有带时间的原话记录，不能据此认定没有口播。';
  const entries=claims.map((claim,i)=>{
   const [start,end]=claim.range;
   const within=originals.some(row=>row.range&&start>=row.range[0]&&end<=row.range[1]);
   const scope=within?'':embedded?' · 含选段之外的内容':' · 记录跨出本组选段，按重叠列出整条';
   const malay=`<p lang="ms">${esc(claim.ms)}</p>`;
   const copy=embedded?malay:claim.zh
    ?`<p class="speech-meaning">${esc(claim.zh)}</p><details class="source-ms"><summary>马来语原话</summary>${malay}</details>`
    :`<p class="missing-translation">此条原话暂无中文译文</p>${malay}`;
   return `<article id="speech-${index+1}-${i}" class="speech-record"><p class="speech-time">原片 ${n(start)}–${n(end)}秒${scope}</p>${copy}</article>`;
  }).join('');
  return `<details class="source-speech" id="source-group-${index+1}"><summary>附录 · 原片听写</summary><p class="provenance-note">${provenance}</p>${entries||`<p>${empty}</p>`}</details>`;
 };
 const sourceLink=(row:ReviewBoardRow,index:number,originals:ReviewBoardRow[])=>{const order=[index,...unitIds.map((_,i)=>i).filter(i=>i!==index)];let target=`source-group-${index+1}`;for(const i of order){const claims=transcript(i===index?originals:body.filter(r=>r.unit_id===unitIds[i]&&r.stage==='original')),match=claims.findIndex(c=>row.range&&overlaps(c.range,row.range));if(match>=0){target=`speech-${i+1}-${match}`;break;}}if(!row.range)return '';const [start,end]=row.range;
  const time=start===end?n(start):`${n(start)}–${n(end)}`;
  return `<p class="source-link"><a href="#${target}">${embedded?'原片听写':'回看原片'} ${time}秒</a></p>`;
 };

 const stageZh=new Map([['Video asal','原片'],['Lihat semula','回看讲解'],['Ulasan semula','回看讲解']]);
 const stageList=(rows:ReviewBoardRow[])=>{if(embedded)return '';const pairs=[...new Map(rows.flatMap(r=>stageTranslations(data,r)).map(p=>[p.ms+'\0'+p.zh,p])).values()];return pairs.length?`<p class="stage-translations">阶段标识：${pairs.map(p=>`${esc(p.ms)+((p.zh||stageZh.get(p.ms))?' → '+esc(p.zh||stageZh.get(p.ms)):'')}`).join('；')}</p>`:'';};
 const unknownBlock=(id:string)=>{const unknowns=unitUnknowns(data,id);return `<details class="evidence-boundaries"><summary>证据边界与未知</summary>${unknowns.length?`<ul>${unknowns.map(v=>`<li>${esc(v)}</li>`).join('')}</ul>`:'<p>本组没有登记未知项，不等于已全部核实。</p>'}</details>`;};
 const opening=board.rows.find(r=>r.stage==='opening');const openingHtml=opening?`<section class="delivery opening${opening.deliveryLayout?' layered-opening':''}" data-card="opening"><h2>片头</h2><div class="delivery-body"><div class="provided">${opening.deliveryLayout?opening.frames.map((frame,i)=>`<figure>${image(opening,i)}<figcaption>${esc(frame.label)}</figcaption></figure>`).join(''):image(opening,0)}</div><div>${embedded?'':visualQuestions(opening.unit_id)}${copy(opening)}${embedded?'':questionHtml(questionKey(opening))}</div></div></section>`:'';
 const excerptUnit=embedded&&unitIds.includes(teachingExcerptUnit??'')?teachingExcerptUnit:undefined;
 const sourceLinksScript=`<script>{
 for(const link of document.querySelectorAll('.source-link a'))link.addEventListener('click',event=>{
  const target=document.getElementById(link.hash.slice(1));
  if(!target)return;
  event.preventDefault();
  const appendix=target.closest('details.source-speech');
  if(appendix)appendix.open=true;
  target.scrollIntoView({block:'start'});
 });
 }</script>`;
 const replayScript=`<script>{
 for(const gallery of document.querySelectorAll('.replay-gallery')){
  const buttons=[...gallery.querySelectorAll('[data-show]')];
  const frames=[...gallery.querySelectorAll('[data-replay-frame]')];
  let selected=frames[0];
  for(const button of buttons)button.addEventListener('click',()=>{
   const choice=button.dataset.show,recap=choice==='recap';
   if(!recap)selected=frames.find(frame=>frame.dataset.replayFrame===choice);
   const representative=new Map();
   if(recap)for(const frame of frames){
    const area=frame.dataset.recapFrame;
    if(area!==undefined&&(!representative.has(area)||frame===selected))representative.set(area,frame);
   }
   gallery.classList.toggle('is-recap',recap);
   for(const item of buttons)item.setAttribute('aria-pressed',String(item===button));
   for(const frame of frames){
    frame.hidden=recap?representative.get(frame.dataset.recapFrame)!==frame:frame!==selected;
    frame.toggleAttribute('data-recap-current',recap&&!frame.hidden&&frame===selected);
   }
  });
 }
 }</script>`;
 const opinionsScript=`<script>{
 const origin=new URL(document.baseURI).origin;
 const fields=[...document.querySelectorAll('[data-blueprint-opinion]')];
 for(const field of fields)field.addEventListener('input',()=>{
  parent.postMessage({type:'clipmentor:blueprint-opinion',unitId:field.dataset.blueprintOpinion,text:field.value},origin);
 });
 addEventListener('message',event=>{
  if(event.source!==parent||event.origin!==origin)return;
  if(event.data?.type==='clipmentor:open-blueprint-opinion'){
   const field=fields.find(field=>field.dataset.blueprintOpinion===event.data.unitId);
   if(field){field.closest('details').open=true;field.focus();}
   return;
  }
  if(event.data?.type!=='clipmentor:blueprint-opinion-draft')return;
  const drafts=Array.isArray(event.data.entries)?new Map(event.data.entries.map(entry=>[entry.unitId,entry.text])):null;
  for(const field of fields){
   if(drafts){
    const value=drafts.get(field.dataset.blueprintOpinion)??'';
    if(field.value!==value){field.value=value;if(value)field.closest('details').open=true;}
   }
   field.disabled=event.data.pending===true;
  }
 });
 }</script>`;
 const excerptHtml='<div class="teaching-excerpt"><button type="button">播放回看</button><span role="status"></span><video hidden controls playsinline preload="none" tabindex="0" aria-label="本组回看片段"></video><p class="sampling-note">还没配音，暂无声音。</p></div>';
 const excerptScript=`<script>
 const excerpt=document.querySelector('.teaching-excerpt');
 const button=excerpt.querySelector('button'),video=excerpt.querySelector('video'),status=excerpt.querySelector('[role=status]');
 const parentOrigin=new URL(document.baseURI).origin;
 let waiting=false,timer;
 const unavailable=()=>{
  waiting=false;button.disabled=false;status.textContent='暂时播不了，稍后再试。';
 };
 button.addEventListener('click',()=>{
  waiting=true;button.disabled=true;status.textContent='正在生成…';
  timer=setTimeout(unavailable,55000);
  parent.postMessage({type:'clipmentor:request-teaching-excerpt'},parentOrigin);
 });
 addEventListener('message',event=>{
  if(!waiting||event.source!==parent||event.origin!==parentOrigin||event.data?.type!=='clipmentor:teaching-excerpt')return;
  waiting=false;clearTimeout(timer);
  if(!(event.data.bytes instanceof ArrayBuffer)){unavailable();return;}
  const url=URL.createObjectURL(new Blob([event.data.bytes],{type:'video/mp4'}));
  video.addEventListener('error',()=>{
   URL.revokeObjectURL(url);video.hidden=true;button.hidden=false;unavailable();button.focus();
  },{once:true});
  addEventListener('pagehide',()=>URL.revokeObjectURL(url),{once:true});
  video.src=url;video.hidden=false;button.hidden=true;status.textContent='';video.focus();
 });
 </script>`;
 const groups=unitIds.map((id,index)=>{
  const rows=body.filter(row=>row.unit_id===id),originals=rows.filter(row=>row.stage==='original');
  const lines=new Set(rows.flatMap(row=>row.line_ids));
  const decisions=embedded?[]:narrationDecisions.filter(answer=>answer.unit_id===id&&answer.status==='ok'
   &&answer.line_id&&lines.has(answer.line_id)&&answer.decision&&answer.viewer_basis&&answer.quote);
  const check=decisions.length?`<details class="picture-note" data-narration-review><summary>独立口播审核</summary>${decisions.map(answer=>{
   const decision=(answer.decision??'').trimEnd();
   const separator=/[。！？.!?]$/u.test(decision)?'':'。';
   return `<p>${esc(decision)}${separator}${esc(answer.viewer_basis)}</p><blockquote lang="ms" data-quote-line-id="${esc(answer.line_id)}">${esc(answer.quote)}</blockquote>${answer.source_quote?`<p data-source-evidence-id="${esc(answer.source_evidence_id)}">原片依据 ${esc(answer.source_quote)}</p>`: ''}`;
  }).join('')}</details>`:'';
  const observation=embedded?null:originalDescription(id),originalDuration=originals.reduce((sum,row)=>sum+(row.range?row.range[1]-row.range[0]:0),0);
  const excerpt=observation?`<div class="source-description"><h3>原片观察摘录 <span>· ${esc(observation.range.join('–'))}秒</span></h3><p>${esc(observation.text)}</p>${observation.range[1]-observation.range[0]<originalDuration?`<p class="observation-scope">只描述其中${esc(observation.range.join('–'))}秒。</p>`:''}</div>`:'';
  const runs:ReviewBoardRow[][]=[];
  for(const row of rows){
   const previous=runs.at(-1);
   if(previous?.[0].stage===row.stage)previous.push(row);
   else runs.push([row]);
  }
  const reviewedRuns=runs.map(run=>({run,views:run[0].stage==='explanation'?reviewReplayViews(run):[]}));
  const focused=reviewedRuns.some(({views})=>views.length);
  const pictureNotes=(run:ReviewBoardRow[])=>embedded?'':`<details class="picture-note"><summary>审核依据</summary>${run.map(r=>`<p>${esc(r.picture)}</p>`).join('')}</details>`;
  const playback=reviewedRuns.map(({run,views},position)=>{
   if(run[0].stage==='original')return focused
    ?`<div class="focused-original"><h3>${embedded?'原片画面':'原片选帧'}</h3><div class="source-rail">${run.map(r=>`<div>${stageCue(r,stageStyle(r))}${strip(r,'source-strip')}</div>`).join('')}</div>${position===0&&excerpt?`<details class="picture-note"><summary>原片观察</summary>${excerpt}${stageList(run)}</details>`:''}</div>`
    :`<div class="source-block"><h3>原片</h3>${run.map(r=>strip(r,'source-strip')).join('')}${position===0?excerpt:''}</div>${stageList(run)}`;
   if(views.length){
    const copyById=new Map(run.flatMap(r=>r.lines.map(l=>[l.id,{r,l}] as const)));
    return `<div class="focused-explanation"><h3>讲解</h3>${replayGallery(views)}<div class="focused-copy">${[...copyById.values()].map(({l})=>`<div class="focused-line"><p class="meaning">${esc(l.zh)}</p><p class="narration" lang="ms">${esc(l.ms)}</p></div>`).join('')}<details class="picture-note"><summary>字幕与来源</summary>${stageList(run)}${[...copyById.values()].map(({r,l})=>`${sourceLink(r,index,originals)}${copy(r,[l])}`).join('')}</details>${pictureNotes(run)}</div></div>`;
   }
   return run.flatMap(r=>r.lines.map(l=>`<div class="explanation"><div>${mock(r,l)}</div><div class="explanation-copy"><h3>讲解</h3>${sourceLink(r,index,originals)}${stageList([r])}${copy(r,[l])}${pictureNotes([r])}</div></div>`)).join('');
  }).join('');
  const opinion=embedded?`<details class="group-opinion"><summary>第 ${index+1} 组意见（可不填）</summary><textarea rows="3" maxlength="${BLUEPRINT_OPINION_MAX_LENGTH}" data-blueprint-opinion="${esc(id)}" aria-label="第 ${index+1} 组意见" placeholder="只改本组"></textarea></details>`:'';
  const lesson=teaching(id);
  return `<section class="group" data-card="group-${index+1}" data-unit-id="${esc(id)}"><h2><span>第${index+1}组${lesson?(embedded?' · 她怎么拍':' · 教什么'):''}</span>${esc(lesson)}</h2>${id===excerptUnit?excerptHtml:''}${playback}${speechBlock(index,originals)}${embedded?'':check+unknownBlock(id)+questionHtml(id)}${opinion}</section>`;
 }).join('');

 const endings=board.rows.filter(r=>r.stage==='closing');
 const edges=['left','top','right','bottom'] as const;
 const sharedCrop=endings.some((row,i)=>row.asset_hash&&endings.slice(i+1).some(other=>
  row.asset_hash===other.asset_hash&&edges.every(edge=>(row.crop?.[edge]??0)===(other.crop?.[edge]??0)),
 ));
 const audiences=new Map<string,string>();
 const endingCards=endings.map((row,i)=>{
  const layout=row.deliveryLayout?.layout?.kind;
  const audience=layout==='product_storyboard'?'existing_partner'
   :layout==='recruitment_card'||layout==='product_commission'?'new_contact':row.unit_id;
  const label=endingLabel(audience,i);
  if(row.ending_variant)audiences.set(row.ending_variant,label);
  const prompt=audience==='new_contact'?'请核对佣金等合作数字是否正确。':'';
  const route=label==='新建联达人'?(embedded?'合作海报':'上传的 CTA 素材'):label==='已合作达人'?(embedded?'商品图和原片分镜':'产品图＋Storyboard'):'';
  const fullPicture=row.full_picture?.jpeg?`<details class="picture-note"><summary>${embedded?'查看原图':'核对未裁原图'}</summary><img style="display:block;width:100%;height:auto" src="data:image/jpeg;base64,${row.full_picture.jpeg}" alt="片尾素材原图"></details>`:'';
  return `<article class="ending"><h3>${esc(label)}</h3>${route?`<p class="ending-route">${esc(route)}</p>`:''}<div class="ending-body"><div class="provided"><p class="sampling-note">${embedded?'片尾画面':'计划上屏'}</p>${image(row,0)}${fullPicture}</div>${embedded?'':visualQuestions(row.unit_id)}${prompt?`<p>${esc(prompt)}</p>`:''}${copy(row)}${embedded?'':questionHtml(questionKey(row))}</div></article>`;
 }).join('');
 const endingsHtml=endings.length?`<section class="delivery" data-card="endings"><h2>片尾</h2>${!embedded&&sharedCrop?'<aside class="questions"><p>两个达人结尾使用同一张原图与同一裁切。请分别核对合作条件与开拍参考是否已经体现。</p></aside>':''}<div class="ending-grid">${endingCards}</div></section>`:'';
 const durationSummary=lint.durations.map((d,i)=>`${audiences.get(d.variant)??endingLabel('',i)}约${d.estimated_total_seconds===null?'未知':Math.round(d.estimated_total_seconds)+'秒'}`).join('；');
 const payload=json({hash:board.candidate_sha256,mode:board.hash_mode}),pictures=json(board.rows.map(r=>r.frames.map((f,i)=>({jpeg:f.jpeg,label:frameLabel(r,i)}))));
 return`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; ${excerptUnit?'media-src blob:; ':''}script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>${embedded?`审蓝图 · ${esc(title)}`:`人审版 · ${esc(title)} · ${revision}`}</title><style>
.source-speech{margin:0 0 30px;padding:22px 24px;background:#f5f6f0;border-left:3px solid #a1ae95}.provenance-note{font-size:12px;color:#72806c}.speech-record{scroll-margin-top:24px;padding:14px 0;border-top:1px solid #dde3d5}.speech-time{font-size:12px;color:#64745e;margin-bottom:7px}.speech-meaning{font-size:18px;line-height:1.8;margin-bottom:8px}.source-ms{font-size:13px;color:#64745e}.source-ms p{margin:10px 0 0;white-space:pre-wrap}.source-link,.stage-translations{font-size:13px;color:#687565}.source-link a{color:#3f6d54;text-underline-offset:4px}.stage-translations{margin-bottom:14px}.label-copy h4{font-size:12px;font-weight:500;margin:0 0 6px}.label-copy ul{list-style:none;padding:0;margin:0}.label-copy li{margin:4px 0}.input-notice,.missing-translation{color:#8b591d;font-size:13px}.evidence-boundaries{font-size:13px;border-top:1px solid #e1e5da;padding-top:14px;margin-top:22px;color:#687565}.evidence-boundaries ul{padding-left:20px}.delivery-check{display:grid;grid-template-columns:1fr 1fr;gap:24px;border-top:1px solid #e1e5da;padding-top:20px;margin-top:20px;font-size:14px;overflow-wrap:anywhere}.delivery-check blockquote{margin:0;padding:0}.delivery-check blockquote>span{font-size:11px;color:#75826e}.delivery-check p{white-space:pre-wrap}.ending .delivery-check{grid-template-columns:1fr;gap:12px}.thumb-strip figure{margin:0;min-width:0}.thumb-strip figcaption{font-size:11px;color:#718069;margin-top:5px;text-align:center}.speech-record:target{background:#fff8e8;outline:2px solid #d5aa3e;outline-offset:6px}
*{box-sizing:border-box}body{margin:0;background:#efeee9;color:#252e29;font:16px/1.65 system-ui,"PingFang SC",sans-serif}header,main,footer{max-width:1200px;margin:auto;padding:28px 32px}header{padding-top:38px;padding-bottom:10px}h1{font-size:30px;line-height:1.3;letter-spacing:-.5px;margin:4px 0 14px;font-weight:650}h2,h3,p{margin-top:0}h2{font-weight:600;font-size:25px;line-height:1.55;margin-bottom:24px}h2>span{display:block;font-size:13px;color:#6a756b;margin-bottom:8px;font-weight:500}h3{font-size:14px;font-weight:600;margin:0 0 10px;color:#677568}.kicker{font-size:13px;color:#687267}.status,.overview,.version-note{font-size:14px;margin:6px 0;color:#637164}.overview{font-variant-numeric:tabular-nums}.identity{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin-top:14px;font-size:13px}.identity label{background:#fff;padding:7px 12px;border:1px solid #d2d8ce;cursor:pointer}.identity input{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.identity label:focus-within{outline:2px solid #856c2d;outline-offset:3px}#freshness{color:#8a641c}.expired{background:#fbe6d8;padding:7px 12px}.group,.delivery{background:#fff;border:1px solid #d9ded4;margin-bottom:24px;padding:30px;scroll-margin-top:20px}.source-block{display:grid;grid-template-columns:55px 330px 1fr;gap:16px;align-items:center;border-bottom:1px solid #e2e5dd;padding-bottom:24px;margin-bottom:28px}.source-block h3{margin:0}.source-description{font-size:14px;color:#6c766d;margin:0;line-height:1.7}.source-description h3 span{font-size:12px;font-weight:400}.source-description p{margin:0}.source-description .observation-scope{font-size:12px;margin-top:8px}.thumb-strip{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px}.image-button{padding:0;border:0;background:#ecefe7;display:block;width:100%;cursor:zoom-in}.image-button img{display:block;width:100%;height:auto}.thumb-strip img{width:100%;aspect-ratio:9/16;object-fit:contain;background:#e8ebe3}.source-strip{max-width:330px}.explanation{display:grid;grid-template-columns:266px minmax(0,1fr);gap:34px;padding:0 0 30px}.explanation+.explanation{border-top:1px solid #e2e5dd;padding-top:30px}.explanation:last-of-type{padding-bottom:0}.mock{margin:0;width:266px}.mock figcaption{font-size:11px;margin-bottom:8px;color:#6f786d}.mock figcaption span{display:inline-block;margin-left:6px;background:#eeefe8;padding:1px 5px}.mock-screen{background:#101310;overflow:hidden}.stage-cue{text-align:center;padding:7px 10px;font-size:13px;font-weight:650;line-height:1.45;overflow-wrap:anywhere}.mock-visual{position:relative;aspect-ratio:9/12;display:flex;background:#151815}.mock-visual .image-button{height:100%;background:#151815}.mock-visual img{height:100%;object-fit:contain}.mock-labels{position:absolute;left:9px;right:9px;bottom:10px;display:flex;flex-wrap:wrap;gap:4px;pointer-events:none}.mock-labels span{background:#f5f4ed;color:#1b241c;padding:3px 6px;font-size:11px;line-height:1.4;overflow-wrap:anywhere;max-width:100%}.mock-caption{color:#fff;background:#101310;padding:14px 12px;text-align:center;font-size:12px;line-height:1.65;overflow-wrap:anywhere}.mock-caption p{margin:0}.mock-caption p+p{margin-top:5px}.explanation-strip{margin-top:9px}.sampling-note{font-size:11px;color:#7b8377;margin:7px 0 0}.meaning{font-size:23px;line-height:1.7;font-weight:500;margin:0 0 15px}.narration{font-size:15px;color:#69746a;line-height:1.8;margin:0 0 20px}.caption-cards{display:grid;gap:8px}.caption-card{border-left:2px solid #dce1d3;padding:4px 12px;font-size:14px;color:#5e6c61}.caption-card>span{font-size:11px;color:#8a9385}.caption-card p{margin:3px 0}.label-copy{font-size:12px;color:#7e876f;margin:14px 0}.label-copy span{color:#606d55;margin-left:8px}.picture-note{font-size:13px;border-top:1px solid #e1e5da;padding-top:12px;margin-top:18px;color:#64715e}.picture-note p{white-space:pre-wrap;margin-top:12px}.questions{border-left:3px solid #d5aa3e;background:#fff8e8;padding:14px 18px;margin-top:26px}.questions h3{color:#8d681c}.questions p{margin:5px 0;font-size:14px;color:#765d27}.delivery-body{display:grid;grid-template-columns:310px minmax(0,1fr);gap:28px;align-items:start}.provided{background:#eef0e8;padding:12px}.provided .image-button img{max-height:300px;object-fit:contain}.ending-grid{display:grid;grid-template-columns:1fr 1fr;gap:30px}.ending+.ending{border-left:1px solid #e0e4d8;padding-left:30px}.ending h3{font-size:18px;color:#2d382b;margin-bottom:18px}.ending .provided{margin-bottom:22px}.ending .meaning{font-size:21px}summary{cursor:pointer}details:not([open])>p,details:not([open])>pre{display:none}footer{padding-top:0;color:#687265;font-size:12px}#technical{border-top:1px solid #cfd5c8;padding-top:16px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.5 ui-monospace,monospace}dialog{max-width:95vw;width:1050px;border:1px solid #c9d2c4;padding:20px;background:#f8f9f4}dialog::backdrop{background:#152419aa}dialog button{float:right;font:inherit;background:white;border:1px solid #c9d2c4;padding:5px 14px}.zoom-frames{display:flex;gap:12px;clear:both;padding-top:16px;overflow:auto}.zoom-frames figure{margin:0;flex:1;min-width:220px}.zoom-frames img{max-height:75vh;max-width:100%;object-fit:contain}.zoom-frames figcaption{font-size:12px;margin-top:6px}:focus-visible{outline:2px solid #856c2d;outline-offset:3px}@media(max-width:900px){header,main,footer{padding-left:20px;padding-right:20px}.source-block{grid-template-columns:55px 1fr}.source-description{grid-column:2}.explanation{grid-template-columns:240px 1fr;gap:22px}.mock{width:240px}}@media print{.identity,dialog{display:none}.group,.delivery{break-inside:avoid}body{background:white}}
@media(max-width:600px){header,main,footer{padding-left:14px;padding-right:14px}.group,.delivery{padding:20px}.source-block{grid-template-columns:1fr}.source-description{grid-column:auto}.explanation,.delivery-body,.delivery-check,.ending-grid{grid-template-columns:1fr}.mock{width:min(100%,300px);margin:auto}.source-strip{max-width:100%}.ending+.ending{border-left:0;border-top:1px solid #e0e4d8;padding-left:0;padding-top:24px}.source-speech{padding:16px}.meaning{font-size:21px}h1{font-size:25px}}
.layered-opening .delivery-body{grid-template-columns:1fr}.layered-opening .provided{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(130px,100%),1fr));gap:12px}.layered-opening figure{margin:0;text-align:center}
.teaching-excerpt{margin:0 0 22px}.teaching-excerpt button{font:inherit;color:inherit;background:#fff;border:1px solid #c9d2c4;padding:6px 12px;cursor:pointer}.teaching-excerpt [role=status]{margin-left:10px;font-size:13px}.teaching-excerpt video{display:block;max-width:min(100%,320px);max-height:65vh;background:#101310}.teaching-excerpt video[hidden]{display:none}
.group-opinion{border-top:1px solid #d9ded4;padding-top:12px;margin-top:22px}.group-opinion textarea{box-sizing:border-box;width:100%;display:block;resize:vertical;margin-top:8px;padding:8px;border:1px solid #d2d8ce;border-radius:6px;font:inherit}
.focused-original{margin-bottom:24px}.focused-original .source-description{margin-top:10px}
.source-rail{display:flex;gap:12px;overflow-x:auto;padding:3px 3px 10px}
.source-rail>div{flex:0 0 min(82%,290px);min-width:0}
.source-rail .source-strip{padding:5px;background:#f1f3ef}.source-rail .stage-cue{padding:4px 8px}
.focused-explanation{display:grid;grid-template-columns:minmax(0,320px) minmax(0,1fr);gap:12px 24px;margin-bottom:24px}
.focused-explanation>h3{grid-column:1/-1;margin:0}.focused-copy{min-width:0}.focused-line+.focused-line{border-top:1px solid #e1e5da;padding-top:12px}
.focused-copy .meaning{font-size:19px;margin-bottom:5px}.focused-copy .narration{margin-bottom:14px}
.replay-gallery{min-width:0;border:1px solid #d9ded4;background:#faf8f1}
.replay-frames figure{margin:0;min-width:0}.replay-frames figure[hidden]{display:none}
.replay-frames .image-button img{aspect-ratio:9/16;object-fit:contain;background:#181c20}
.replay-frames figcaption{padding:8px 10px;font-size:13px;overflow-wrap:anywhere}
.replay-frames strong{display:block;font-size:15px;color:#302719}.replay-time{display:block;color:#5d645a;font-size:12px}
.is-recap .replay-frames{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;padding:5px}
.is-recap [data-recap-current]{outline:2px solid #8a6727;outline-offset:-2px;background:#faefd0}
.replay-navigation{display:flex;flex-wrap:wrap;gap:6px;padding:10px}
.replay-navigation button{border:1px solid #c8c1b4;background:white;color:#302719;border-radius:6px;padding:6px 9px;font:inherit;font-size:13px;cursor:pointer}
.replay-navigation button[aria-pressed="true"]{background:#faefd0;border-color:#846a35;font-weight:650}
@media(max-width:600px){.focused-explanation{grid-template-columns:minmax(0,1fr)}.focused-explanation>h3{grid-column:auto}}
</style></head><body><header>${embedded?'':'<p class="kicker">剪辑蓝图 · 人审版</p>'}<h1>${esc(title)}</h1><p class="overview">${unitIds.length}${embedded?' 组讲解':'组教学'} · ${new Set(body.flatMap(r=>r.line_ids)).size}${embedded?' 句口播':'句讲解'}${!embedded&&durationSummary?' · '+esc(durationSummary)+'（估算）':''}</p>${embedded?'':`<p class="version-note">这块板对应${revision}；稿子改过就要重新生成。示意图不代表实际成片或声音对位。</p><div class="identity"><label>核对现行稿件 <input id="candidate-file" type="file" accept=".json,application/json"></label><span id="freshness" role="status">未核对现行版本</span></div>`}</header><main>${openingHtml}${groups}${endingsHtml}</main>${embedded?'':'<footer><p>内部审稿使用，不发给达人。截图依照登记范围抽取，动作连续性与实际字幕可读性仍需看成片。</p></footer>'}<dialog id="zoom"><button id="close">关闭</button><div id="zoom-body" class="zoom-frames"></div></dialog>${reviewBoardInteractions(payload,pictures,!embedded,true)}${sourceLinksScript}${replayScript}${excerptUnit?excerptScript:''}${embedded?opinionsScript:''}</body></html>`;
}
