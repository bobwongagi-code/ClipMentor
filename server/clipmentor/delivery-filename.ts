/** Human-readable, stable names; transport headers keep UTF-8 separate from ASCII fallback. */
export function deliveryFileName(product:string,audience:string|undefined,kind:'video'|'storyboard',at:number){
 const name=Array.from(product.toWellFormed().normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g,'_').replace(/^\.+/,'').replace(/_+/g,'_').replace(/^_|_$/g,'').trim()).slice(0,64).join('')||'ClipMentor';
 if(!Number.isFinite(at))throw Error('delivery_timestamp_missing');
 const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Singapore',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(at)).replace(/[-:]/g,'').replace(' ','_');
 return kind==='storyboard'?`${name}_原片Storyboard_${parts}.pdf`:`${name}_视频拆解_${audience==='new_contact'?'新建联达人版':'已合作达人版'}_${parts}.mp4`;
}
export function attachmentDisposition(name:string){
 const encoded=encodeURIComponent(name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
 const suffix=name.toLowerCase().match(/\.(pdf|png|jpe?g|webp)$/)?.[1]??'mp4';
 const type=suffix==='pdf'?'Storyboard':suffix==='mp4'?'video':'image';
 const marker=name.startsWith('未复核_')?'unreviewed-':'';
 return `attachment; filename="ClipMentor-${marker}${type}.${suffix}"; filename*=UTF-8''${encoded}`;
}
