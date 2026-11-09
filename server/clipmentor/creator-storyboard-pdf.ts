import {access} from 'node:fs/promises';
import {join} from 'node:path';
import sharp from 'sharp';
import {openBrowser} from '@remotion/renderer';
import type {CreatorStoryboardDocument} from './creator-storyboard-document';

const esc=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const time=(s:number)=>`${String(Math.floor(s/60)).padStart(2,'0')}:${(s%60).toFixed(s%1===0?0:2).padStart(s%1===0?2:5,'0')}`;
export async function assertCreatorDocumentPdf(bytes:Buffer,expected:string[],pages:number){
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const task=getDocument({data:new Uint8Array(bytes),useSystemFonts:false,verbosity:0}),pdf=await task.promise;
 try{
  if(pdf.numPages!==pages||!expected.length)throw Error('storyboard_pdf_pages_or_content_missing');
  let text='';for(let i=1;i<=pdf.numPages;i++){const page=await pdf.getPage(i);const content=await page.getTextContent();text+=content.items.map(i=>'str'in i?i.str:'').join(' ')+' ';}
  const normal=(v:string)=>v.normalize('NFKC').replace(/\s+/g,'');
  if(!expected.every(value=>normal(text).includes(normal(value))))throw Error('storyboard_pdf_text_missing_or_rasterized');
 }finally{await task.destroy();}
}
export function creatorDocumentHtml(title:string,content:CreatorStoryboardDocument,images:string[][],logo:string){
 const pages=[];
 for(let i=0;i<content.rows.length;i+=3){
  const rows=content.rows.slice(i,i+3);
  pages.push(`<section class="page"><header><div><h1>${esc(title)}</h1><p>Storyboard video asal</p></div><img class="logo" src="${logo}"></header>
   <table><colgroup><col class="time"><col class="shot"><col></colgroup><thead><tr><th>Masa</th><th>Shot / aksi</th><th>Maklumat sari kata / suara</th></tr></thead><tbody>${rows.map((r,j)=>`<tr><td><div class="cell">${esc(time(r.source_range_seconds[0]))}<br>–<br>${esc(time(r.source_range_seconds[1]))}</div></td><td><div class="cell"><div class="frames">${images[i+j].map(src=>`<img src="${src}">`).join('')}</div><p class="action">${esc(r.shot_ms)}</p></div></td><td><div class="cell info">${esc(r.information_ms)}</div></td></tr>`).join('')}</tbody></table>
   <footer><span>${esc(title)} · Ringkasan video asal</span><span>Disediakan oleh Rootify · ${i/3+1}/${Math.ceil(content.rows.length/3)}</span></footer></section>`);
 }
 return `<!doctype html><html lang="ms"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><title>${esc(title)} · Storyboard</title><style>
 @page{size:A4;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;background:white;color:#1f2933;font-family:Arial,Helvetica,sans-serif;font-size:10.5pt} .page{width:595.28pt;height:841.89pt;padding:32pt;position:relative;break-after:page}.page:last-child{break-after:auto}
 header{min-height:69pt;max-height:100pt;display:flex;justify-content:space-between;align-items:flex-start}header>div{max-width:400pt;overflow-wrap:anywhere}h1{font-size:23pt;line-height:28pt;margin:0 0 6pt;color:#111827}header p{font-size:15pt;margin:0}.logo{width:112pt;height:45pt;object-fit:contain;object-position:right top}
 table{width:100%;border-collapse:collapse;table-layout:fixed}col.time{width:79pt}col.shot{width:251pt}th{height:38pt;background:#172b3a;color:white;text-align:left;font-size:10pt;padding:8pt 10pt}td{vertical-align:top;border:0.55pt solid #d9e0e5;padding:11pt 10pt;height:202pt}td:first-child{background:#f7f9fb;font-size:10pt}.cell{overflow-wrap:anywhere;height:179pt;line-height:14pt;overflow:visible}.frames{display:flex;gap:20pt;height:104pt;align-items:flex-start}.frames img{height:104pt;max-width:101pt;object-fit:contain;object-position:left top}.action{font-size:9.5pt;line-height:12.3pt;margin:8pt 0 0}.info{white-space:pre-wrap}footer{position:absolute;left:32pt;right:32pt;bottom:32pt;display:flex;justify-content:space-between;font-size:9pt;color:#64748b}
 </style><body>${pages.join('')}</body></html>`;
}

/** Reuse the installed product render engine. No browser download or external page request. */
export async function renderCreatorDocument(html:string,signal:AbortSignal){
 const platform=process.platform==='darwin'?'mac':process.platform;
 const executable=process.env.CC_BROWSER_EXECUTABLE??join(process.cwd(),'node_modules/.remotion/chrome-headless-shell',platform+'-'+process.arch,`chrome-headless-shell-${platform}-${process.arch}`,'chrome-headless-shell');
 await access(executable);signal.throwIfAborted();
 const browser=await openBrowser('chrome',{browserExecutable:executable,logLevel:'error'});
 const abort=()=>{void browser.close({silent:true}).catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
 try{
  signal.throwIfAborted();
  const page=await browser.newPage({context:()=>null,logLevel:'error',indent:false,pageIndex:0,onBrowserLog:null,onLog:()=>{}});
  const client=page._client();
  // Remotion's narrower protocol type omits these standard CDP methods.
  const extra=client.send.bind(client) as unknown as (method:'Network.setBlockedURLs'|'Page.setDocumentContent',args:Record<string,unknown>)=>Promise<unknown>;
  await client.send('Network.enable');await extra('Network.setBlockedURLs',{urls:['http://*','https://*','file://*','ftp://*']});
  await page.setViewport({width:794,height:1123,deviceScaleFactor:1.5});
  const tree=await client.send('Page.getFrameTree');
  await extra('Page.setDocumentContent',{frameId:tree.value.frameTree.frame.id,html});
  await page.evaluate(async()=>{await document.fonts.ready;await Promise.all(Array.from(document.images).map(img=>img.decode()));});
  const overflow=await page.evaluate(()=>Array.from(document.querySelectorAll('.cell,header')).some(e=>e.scrollHeight>e.clientHeight+2||e.scrollWidth>e.clientWidth+2)
   ||Array.from(document.querySelectorAll('.page')).some(e=>e.scrollHeight>e.clientHeight+2||e.scrollWidth>e.clientWidth+2));
  if(overflow)throw Error('storyboard_document_layout_overflow');
  signal.throwIfAborted();
  const pdf=await client.send('Page.printToPDF',{printBackground:true,preferCSSPageSize:true,marginTop:0,marginBottom:0,marginLeft:0,marginRight:0});
  const expected=await page.evaluate(()=>Array.from(document.querySelectorAll('.action,.info')).map(e=>e.textContent??''));
  const pages=await page.evaluate(()=>document.querySelectorAll('.page').length);
  await assertCreatorDocumentPdf(Buffer.from(pdf.value.data,'base64'),['Masa','Shot / aksi','Maklumat sari kata / suara','Disediakan oleh Rootify',...expected],pages);
  const screen=await client.send('Page.captureScreenshot',{format:'jpeg',quality:94,clip:{x:0,y:0,width:794,height:1123,scale:1}});
  return {bytes:Buffer.from(pdf.value.data,'base64'),preview:await sharp(Buffer.from(screen.value.data,'base64')).resize(1190,1684).jpeg({quality:94}).toBuffer()};
 }finally{signal.removeEventListener('abort',abort);await browser.close({silent:true});}
}
