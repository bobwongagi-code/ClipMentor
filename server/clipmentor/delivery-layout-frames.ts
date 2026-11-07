import {execFile} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {endingCardSources,type DeliverySection} from '../../src/clipmentor/delivery-bindings';
import {ffmpegBin} from '../media-binaries';
import sharp from 'sharp';

type Picture=DeliverySection['picture'];
type Binding=Pick<Picture,'src'|'sha256'>;
const width=576,height=1024;
const escapeXml=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
async function withTitles(bytes:Buffer,lines:string[],highlightFirst:boolean){
 const svg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${lines.map((line,index)=>
  `<text x="288" y="${128+index*58}" text-anchor="middle" font-family="sans-serif" font-weight="bold" font-size="${Math.min(44,Math.floor(720/Array.from(line).length))}" fill="${(highlightFirst?index===0:index===lines.length-1)?'#FFD83D':'white'}">${escapeXml(line)}</text>`).join('')}</svg>`);
 return sharp(bytes).composite([{input:svg}]).jpeg({quality:90}).toBuffer();
}

export function deliveryLayoutStages(picture:Picture){
 const layout=picture.layout;
 if(!layout)return [];
 if(layout.kind==='recruitment_card')return ['完整招商卡'];
 if(layout.kind==='product_storyboard')return ['商品与Storyboard并排'];
 return layout.kind==='product_commission'?['商品与佣金同屏']
  :layout.show_sales?['成绩截图','同款提问与过渡','接入原片']:['开场过渡','接入原片'];
}

/** Shared visual projection. One bounded, read-only composition per phase. */
export async function renderDeliveryLayoutFrames(picture:Picture,io:{
 resolve(name:string):string|null;hash(file:string):Promise<string>;signal?:AbortSignal;
}):Promise<Buffer[]>{
 const layout=picture.layout;
 if(!layout)return [];
 const bound=new Map<string,string>();
 async function resolve(binding:Binding){
  const name=decodeURIComponent(binding.src.slice('/media/uploads/'.length));
  if(!name||/[\\/]/.test(name)||name==='.'||name==='..')throw Error('delivery_layout_unsafe_media');
  const file=io.resolve(name);
  if(!file||await io.hash(file)!==binding.sha256)throw Error('delivery_layout_media_changed');
  bound.set(file,binding.sha256);
  return file;
 }
 const pictureFile=await resolve(picture),folder=await mkdtemp(join(tmpdir(),'clipmentor-delivery-layout-'));
 const run=promisify(execFile);
 async function frame(index:number,input:string[],filter:string){
  const file=join(folder,index+'.jpg');
  await run(ffmpegBin(),['-v','error','-nostdin','-filter_complex_threads','1',...input,'-filter_complex',filter,
   '-frames:v','1','-q:v','3',file],{timeout:15_000,signal:io.signal});
  return readFile(file);
 }
 const fit=`scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1`;
 try{
  let frames:Buffer[];
  if(layout.kind==='original_underlay'){
   const source=await resolve(layout.source),[start,end]=layout.range;
   const dark=`[0:v]${fit},drawbox=x=0:y=0:w=iw:h=ih:color=black@${layout.shade}:t=fill`;
   frames=[];
   if(layout.show_sales)frames.push(await withTitles(await frame(0,['-ss',String(start),'-i',source,'-i',pictureFile],
    `${dark}[bg];[1:v]scale=528:230:force_original_aspect_ratio=decrease[stats];[bg][stats]overlay=(W-w)/2:(H-h)/2`),layout.headline,true));
   frames.push(await withTitles(await frame(1,['-ss',String((start+end)/2),'-i',source],dark),layout.transition,false));
   frames.push(await frame(2,['-i',source],`[0:v]${fit}`));
  }else if(layout.kind==='product_commission'){
   const crop=({left,top,right,bottom}:NonNullable<Picture['crop']>)=>
    `crop=iw*${1-left-right}:ih*${1-top-bottom}:iw*${left}:ih*${top}`;
   frames=[await frame(0,['-i',pictureFile],
    `[0:v]split=2[a][b];[a]${crop(layout.product_crop)},scale=500:600:force_original_aspect_ratio=decrease[p];`+
    `[b]${crop(layout.commission_crop)},scale=528:180:force_original_aspect_ratio=decrease[c];`+
    `color=c=0xf6f4f0:s=${width}x${height}[bg];[bg][p]overlay=(W-w)/2:60+(600-h)/2[x];[x][c]overlay=(W-w)/2:740+(180-h)/2`)];
  }else{
   for(const source of endingCardSources(layout))if(source.src!==picture.src||source.sha256!==picture.sha256)await resolve(source);
   const wholePoster=layout.kind==='recruitment_card'&&layout.poster.asset_id===picture.asset_id;
   const display=wholePoster?`scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1`:fit;
   frames=[await frame(0,['-i',pictureFile],`[0:v]${display}`)];
  }
  for(const [file,expected] of bound)if(await io.hash(file)!==expected)throw Error('delivery_layout_media_changed');
  return frames;
 }finally{await rm(folder,{recursive:true,force:true});}
}
