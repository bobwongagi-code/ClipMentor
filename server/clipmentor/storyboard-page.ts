import type {ClipMentorStoryboard} from '../../shared/clipmentor-storyboard';

/** Product view, not a new project document. All authored text is inserted with textContent. */
export function storyboardPage(board:ClipMentorStoryboard,nonce:string){
 const data=JSON.stringify(board).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
 return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>剪辑蓝图</title>
<style nonce="${nonce}">
:root{color-scheme:light;font-family:system-ui,"PingFang SC","Microsoft YaHei",sans-serif;color:#202623;background:#f4f5f1;font-size:14px}*{box-sizing:border-box}body{margin:0}header{padding:28px 32px 22px;background:#fff;border-bottom:1px solid #dde2d9;display:flex;justify-content:space-between;align-items:center;gap:16px}h1{margin:0;font-size:24px;font-weight:650;letter-spacing:-.5px}.subtitle{margin:7px 0 0;color:#667164;line-height:1.5}button{font:inherit;border:1px solid #cbd2c6;background:#fff;border-radius:7px;padding:8px 14px;color:#26352a;cursor:pointer;white-space:nowrap;flex-shrink:0}button:hover{background:#edf1e9}button:disabled{opacity:.5;cursor:default}main{max-width:1520px;margin:auto;padding:24px 32px}.columns,.card{display:grid;grid-template-columns:minmax(220px,.85fr) minmax(0,1fr) minmax(0,1fr);gap:24px}.columns{padding:0 18px 12px;color:#687366;font-size:12px;letter-spacing:.04em}.card{background:#fff;border:1px solid #dfe4d9;border-radius:12px;padding:18px;margin:0 0 18px;align-items:start}.id{font-size:12px;color:#6e786b;margin-bottom:8px}.intent{font-weight:600;line-height:1.6;margin:0 0 18px}.line{border-top:1px solid #edf0e9;padding-top:12px;margin-top:12px}.ms{font-size:15px;line-height:1.65;margin:5px 0}.zh{color:#727b6d;font-size:13px;line-height:1.65;margin:4px 0}.labels{color:#70560b;font-size:12px;line-height:1.6}.images{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}figure{margin:0;min-width:0}img{width:100%;height:190px;object-fit:contain;background:#f0f2ed;border-radius:5px;display:block}figcaption{color:#6d7668;font-size:11px;line-height:1.4;margin:5px 0 8px;overflow-wrap:anywhere}.empty{background:#f6f7f3;border:1px dashed #d6ddcf;padding:24px 14px;color:#7a8375;line-height:1.6;border-radius:7px;min-height:120px;display:flex;align-items:center}.error{color:#9c5022}.panel h3{display:none}#notice{display:none;background:#fff0db;color:#8a491b;padding:14px 18px;border-radius:8px;margin-bottom:16px}footer{color:#778171;font-size:12px;padding:6px 0 22px;line-height:1.7}a{color:inherit}.image-button{border:0;padding:0;width:100%;background:none;cursor:zoom-in}.image-button:hover{background:none}dialog{border:1px solid #dfe4d9;border-radius:10px;max-width:95vw;width:900px;padding:16px}dialog::backdrop{background:rgba(20,27,20,.65)}dialog img{height:75vh;max-height:75vh;width:100%;object-fit:contain}dialog button{float:right;margin-bottom:12px}dialog p{clear:both;color:#596751}.sample-error{font-size:12px;color:#935b35;background:#fbf4ea;padding:10px;border-radius:5px;overflow-wrap:anywhere}
@media(max-width:1000px){.columns,.card{gap:16px;grid-template-columns:minmax(200px,.85fr) 1fr 1fr}main{padding:20px 16px}img{height:155px}}@media(max-width:720px){header{padding:20px;align-items:flex-start}h1{font-size:21px}.columns{display:none}.card{grid-template-columns:1fr;padding:16px;gap:18px}.panel h3{display:block;font-size:13px;margin:0 0 10px;color:#566451}.images img{height:205px}.intent{margin-bottom:10px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto}}
</style></head><body><header><div><h1 id="title"></h1><p class="subtitle" id="version"></p></div><button id="refresh">刷新现行蓝图</button></header><main><div id="notice" role="status"></div><div class="columns"><span>口播与画面任务</span><span>素材参考</span><span>实际排版</span></div><div id="cards"></div><footer>素材参考不代表字幕、短标已落位。实际排版来自已保存时间线的抽帧，连续观看与听审仍需单独验收。</footer></main>
<dialog id="preview"><button id="close-preview">关闭</button><img id="preview-image" alt=""><p id="preview-label"></p></dialog>
<script nonce="${nonce}">
const board=${data};const $=id=>document.getElementById(id);const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
$('title').textContent=board.title+' · 剪辑蓝图';$('version').textContent='现行版本 '+board.analysis_revision+' · '+board.cards.length+' 组';
$('close-preview').onclick=()=>$('preview').close();
function enlarge(image,label){$('preview-image').src=image.src;$('preview-image').alt=image.alt;$('preview-label').textContent=label;$('preview').showModal();}
$('refresh').onclick=()=>{const u=new URL(location.href);u.searchParams.delete('expectedDigest');u.searchParams.delete('expectedProjectRevision');location.assign(u);};
const unknown={storyboard_media_identity_missing:'素材身份尚未核准',storyboard_media_missing:'素材文件不可用',storyboard_media_changed:'素材已变化，请刷新',storyboard_actual_media_unavailable:'实际排版素材尚不可用',storyboard_busy:'图片处理繁忙，稍后可刷新',storyboard_frame_unavailable:'这张画面暂不可用'};
let stopped=false;const queue=[];let working=false;
async function run(){if(working||stopped)return;working=true;while(queue.length&&!stopped){const job=queue.shift();await job();}working=false;}
async function load(card,part,panel,offset=0,grid){
 const refs=part==='source'?card.source:card.actual;
 if(!refs.length){panel.replaceChildren(el('div',part==='source'?'尚无可用素材参考':card.actual_status==='not_placed'?'尚未排版':'未找到可靠的保存位置','empty'));return;}
 if(!grid){grid=el('div',undefined,'images');panel.replaceChildren(grid);}
 try{
  const u=new URL('/api/clipmentor/production-task',location.origin);for(const [k,v]of Object.entries({view:'storyboard',projectId:board.project_id,part,cardId:card.id,expectedDigest:board.digest,offset:String(offset)}))u.searchParams.set(k,v);
  const res=await fetch(u,{credentials:'same-origin'}),data=await res.json();
  if(!res.ok||data.digest!==board.digest){if(res.status===409||data.digest&&data.digest!==board.digest){stopped=true;$('notice').textContent='工程或蓝图已更新，请刷新后查看，旧图不与新版混用。';$('notice').style.display='block';$('preview').close();document.querySelectorAll('.image-button').forEach(n=>n.remove());$('preview-image').removeAttribute('src');}throw Error('read_failed');}
  for(const image of data.images){const fig=el('figure');const ref=refs.find(r=>r.key===image.key);
   if(image.status==='available'){const img=el('img');img.alt=part==='source'?'素材参考':'已保存时间线排版';img.src='data:image/jpeg;base64,'+image.base64;const button=el('button',undefined,'image-button');button.setAttribute('aria-label','放大'+img.alt);button.append(img);button.onclick=()=>enlarge(img,fig.querySelector('figcaption').textContent);fig.append(button);}
   else fig.append(el('div',unknown[image.reason]||'画面不可用','sample-error'));
   const label=part==='source'?((ref.line_ids||[]).join(' / ')+' · '+Number(ref.source_seconds).toFixed(2)+'s'+(ref.origin==='planned_crop'?' · 计划裁切':ref.origin==='supplied_full'?' · 提供图片':'')):(ref.phase+' · f'+ref.frame);
   fig.append(el('figcaption',label));grid.append(fig);
  }if(data.next_offset!==null&&!stopped)queue.push(()=>load(card,part,panel,data.next_offset,grid));
 }catch{grid.append(el('div','画面读取未完成，请刷新后查看','sample-error'));}
}
const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){observer.unobserve(entry.target);const card=board.cards.find(c=>c.id===entry.target.dataset.cardId),panels=entry.target.querySelectorAll('[data-part]');for(const panel of panels)queue.push(()=>load(card,panel.dataset.part,panel.querySelector('.content')));run();}},{rootMargin:'200px'});
for(const card of board.cards){const row=el('section',undefined,'card');row.dataset.cardId=card.id;
 const copy=el('div');copy.append(el('div',card.title===card.subject_id?card.subject_id:card.title+' · '+card.subject_id,'id'),el('p',card.intent,'intent'));
 for(const line of card.lines){const block=el('div',undefined,'line');block.append(el('div',line.id,'id'),el('p',line.ms,'ms'),el('p',line.zh,'zh'));if(line.labels.length)block.append(el('div',line.labels.join(' · '),'labels'));const caption=el('details'),summary=el('summary','字幕');caption.append(summary,el('p',line.captions.join('\\n'),'zh'));block.append(caption);copy.append(block);}row.append(copy);
 for(const [part,name]of [['source','素材参考'],['actual','实际排版']]){const panel=el('div',undefined,'panel');panel.dataset.part=part;panel.append(el('h3',name));const content=el('div',undefined,'content');content.append(el('div','等待加载','empty'));panel.append(content);row.append(panel);}
 $('cards').append(row);observer.observe(row);
}
</script></body></html>`;
}
