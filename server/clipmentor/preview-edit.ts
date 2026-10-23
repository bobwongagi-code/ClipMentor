import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {isSafeUploadName} from '../media-dir';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {sha256File} from '../../shared/node-content-hash';
import {buildPreviewRevision,previewDocDigest,PREVIEW_EDIT_SCOPE,type PreviewEditPlan} from '../../src/clipmentor/preview-edit';
import type {ProjectDoc,MediaAsset} from '../../src/editor/types';

/** Host installs this bounded authorization from the user's explicit local-preview instruction.
 * No Agent/API operation can create or expand a permit. It never writes an approval. */
interface PreviewEditIdentity {
  operationId:string; projectId:string; expiresAt:number; baseProjectSha256:string;
  baseline:{src:string;sha256:string;fps:number;totalFrames:number;width:number;height:number};
  source:{src:string;sha256:string;fps:number};
  instruction:string;
}
interface OverlayPermit extends PreviewEditIdentity {
  kind?:'overlay';
  relation:{referenceFrame:number;startFrame:number;endFrame:number;clearCaptionY:number};
  tail:{allowedSourceFrames:number[];startFrame:number;endFrame:number;sourceOutFrameExclusive:number};
  label:{text:string;startFrame:number;endFrame:number};
}
interface SniffMergePermit extends PreviewEditIdentity {
  kind:'sniff_merge';
  removeFrames:[number,number];
  removeAudioSeconds:[number,number];
  sourceStartFrame:number;
  pictureFrames:number;
  captionFrames:number;
  captionReferenceFrame:number;
}
export type PreviewEditPermit=OverlayPermit|SniffMergePermit;
export interface PreviewEditDeps {directory:string; resolve:(name:string)=>string|null; output?:(name:string)=>string|null;
  execute:(args:string[])=>Promise<unknown>;}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const run=promisify(execFile);
export const executePreviewMaterial = (args:string[])=>run('ffmpeg',args,{timeout:30_000,maxBuffer:64*1024});
function upload(src:string,deps:PreviewEditDeps) {
  const prefix='/media/uploads/';
  if(!src.startsWith(prefix)||!isSafeUploadName(src.slice(prefix.length))) throw new Error('Upload path required');
  const path=deps.resolve(src.slice(prefix.length)); if(!path) throw new Error('Upload missing'); return path;
}
async function readJson(path:string) {return JSON.parse(await readFile(path,'utf8'));}
function asset(id:string,src:string,name:string,kind:'video'|'image',p:PreviewEditPermit,hash:string):MediaAsset {
  return {id,src,name,kind,width:p.baseline.width,height:p.baseline.height,
    durationInFrames:p.baseline.totalFrames,sourceContentHash:hash};
}
function validatePermit(p:PreviewEditPermit) {
  const n=p.baseline.totalFrames;
  if(!uuid.test(p.operationId)||!Number.isFinite(p.expiresAt)||p.expiresAt<=Date.now()
    ||!Number.isInteger(n)||n<=0||n>18000||p.baseline.fps!==30||p.source.fps!==30
    ||p.baseline.width!==720||p.baseline.height!==1280||!p.instruction.trim()) throw new Error('Invalid or expired bounded preview permit');
  if(p.kind==='sniff_merge') {
    const [a,b]=p.removeFrames,[x,y]=p.removeAudioSeconds;
    if(![a,b,p.sourceStartFrame,p.pictureFrames,p.captionFrames,p.captionReferenceFrame].every(Number.isInteger)
      ||a<0||b<=a||b>=n||!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<=x||y>n/p.baseline.fps
      ||Math.abs(x-a/30)>1/30||Math.abs(y-b/30)>1/30
      ||p.sourceStartFrame<0||p.captionReferenceFrame<b||p.captionReferenceFrame>=n
      ||p.captionFrames<=0||p.pictureFrames<p.captionFrames||a+p.pictureFrames>n-(b-a)) throw new Error('Invalid narration merge boundaries');
    return;
  }
  if(p.relation.clearCaptionY!==960||p.label.text!=='Ulasan semula') throw new Error('Invalid approved overlay');
  for(const span of [p.relation,p.tail,p.label]) if(!Number.isInteger(span.startFrame)||!Number.isInteger(span.endFrame)
    ||span.startFrame<0||span.endFrame<=span.startFrame||span.endFrame>n) throw new Error('Invalid approved range');
  if(p.relation.endFrame>p.tail.startFrame||p.tail.endFrame>p.label.startFrame
    ||p.relation.referenceFrame>=p.relation.startFrame||p.relation.referenceFrame<0
    ||!Number.isInteger(p.relation.referenceFrame)||!Number.isInteger(p.tail.sourceOutFrameExclusive)
    ||!Array.isArray(p.tail.allowedSourceFrames)||!p.tail.allowedSourceFrames.length
    ||p.tail.allowedSourceFrames.some(f=>!Number.isInteger(f)||f<0||f>=p.tail.sourceOutFrameExclusive)) throw new Error('Invalid source or overlap');
}
/** All actions rebind the current snapshot and source bytes; an old permit cannot authorize a new draft. */
export async function previewEditBridge(body:Record<string,unknown>,deps:PreviewEditDeps) {
  if(typeof body.projectId!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(body.projectId)
    ||typeof body.operationId!=='string'||!uuid.test(body.operationId)||!object(body.doc)
    ||Object.keys(body).some(k=>!['projectId','operationId','action','tailFrame','doc'].includes(k))) throw new Error('Invalid preview operation');
  const dir=join(deps.directory,body.projectId,body.operationId);
  const p=await readJson(join(dir,'permit.json')) as PreviewEditPermit;
  validatePermit(p);
  if(p.projectId!==body.projectId||p.operationId!==body.operationId) throw new Error('Permit identity mismatch');
  const baseline=upload(p.baseline.src,deps),source=upload(p.source.src,deps);
  if(await sha256File(baseline)!==p.baseline.sha256||await sha256File(source)!==p.source.sha256) throw new Error('Source hash changed');
  const doc=body.doc as unknown as ProjectDoc,hash=await previewDocDigest(doc);
  const stored=await readJson(join(dir,'prepared.json')).catch(()=>null);
  const action=String(body.action);
  const isApplied=stored?.preparedProjectSha256===hash;
  if(hash!==p.baseProjectSha256&&!isApplied) throw new Error('Project changed; new host authorization required');
  const receipt={allowed:true,scope:PREVIEW_EDIT_SCOPE,full_film_accepted:false,quality_status:'review_required',
    operationId:p.operationId,projectId:p.projectId,baseProjectSha256:p.baseProjectSha256};
  if(action==='read'||action==='check_read') return {...receipt,applied:isApplied,instruction:p.instruction,
    approved_changes:p.kind==='sniff_merge'?{kind:p.kind,remove_frames:p.removeFrames,remove_audio_seconds:p.removeAudioSeconds,source_start_frame:p.sourceStartFrame,picture_frames:p.pictureFrames,caption_frames:p.captionFrames}:{relation:p.relation,tail:p.tail,label:p.label},render_reserved:!!await stat(join(dir,'render-reserved.json')).catch(()=>null)};
  if(action==='check_apply') {
    if(isApplied) throw new Error('Already applied; do not repeat');
    if(p.kind!=='sniff_merge'&&body.tailFrame!==undefined&&!p.tail.allowedSourceFrames.includes(Number(body.tailFrame))) throw new Error('Tail frame outside approval');
    return receipt;
  }
  if(action==='check_render'||action==='reserve_render') {
    if(!isApplied) throw new Error('Exact prepared native project required');
    for(const material of [...stored.plan.patches.map((patch:{asset:MediaAsset})=>patch.asset),...(stored.plan.audio?[stored.plan.audio]:[])]) if(await sha256File(upload(material.src,deps))!==material.sourceContentHash) throw new Error('Prepared material changed');
    if(action==='reserve_render') await writeFile(join(dir,'render-reserved.json'),JSON.stringify({at:Date.now(),projectSha256:hash}),{flag:'wx',mode:0o600});
    else if(await stat(join(dir,'render-reserved.json')).catch(()=>null)) throw new Error('Preview export attempt already consumed');
    return receipt;
  }
  if(action!=='prepare'||isApplied||(p.kind!=='sniff_merge'&&(!Number.isInteger(body.tailFrame)||!p.tail.allowedSourceFrames.includes(Number(body.tailFrame))))) throw new Error('Authorized tail selection required');
  if(stored) {
    if(stored.tailFrame!==body.tailFrame) throw new Error('Do not replace prepared input');
    return {...receipt,...stored};
  }
  if(p.kind==='sniff_merge') return {...receipt,...await prepareSniffMerge(p,doc,deps,dir,baseline,source)};
  const prefix=`preview-edit-${p.operationId}`;
  const names=[`${prefix}-relation.png`,`${prefix}-tail.png`,`${prefix}-label.svg`];
  const output=names.map(n=>{const f=(deps.output??deps.resolve)(n);if(!f)throw new Error('Output path unavailable');return f;});
  await mkdir(dirname(output[0]!),{recursive:true});
  await deps.execute(['-hide_banner','-loglevel','error','-y','-i',baseline,'-vf',
    `select=eq(n\\,${p.relation.referenceFrame}),drawbox=x=0:y=960:w=iw:h=320:color=0xf7f8fa:t=fill`,
    '-frames:v','1',output[0]!]);
  await deps.execute(['-hide_banner','-loglevel','error','-y','-i',source,'-vf',
    `select=eq(n\\,${Number(body.tailFrame)}),scale=540:960,pad=720:1280:90:0:color=0xf7f8fa`,
    '-frames:v','1',output[1]!]);
  await writeFile(output[2]!,`<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280"><rect x="24" y="22" width="290" height="52" rx="12" fill="#ffd300"/><text x="40" y="58" font-family="Arial" font-size="30" fill="#1c2026">Ulasan semula</text></svg>`);
  const assets=await Promise.all(names.map(async(n,i)=>asset(`${prefix}-${i}`,`/media/uploads/${n}`,
    ['延续已批准关系画面','原声末端真实尾态','回看讲解短标'][i]!,'image',p,await sha256File(output[i]!))));
  const plan:PreviewEditPlan={operationId:p.operationId,projectId:p.projectId,
    baseline:asset(`${prefix}-base`,p.baseline.src,'88秒锁定预览基线','video',p,p.baseline.sha256),fps:p.baseline.fps,totalFrames:p.baseline.totalFrames,
    patches:[p.relation,p.tail,p.label].map((s,i)=>({asset:assets[i]!,startFrame:s.startFrame,endFrame:s.endFrame,name:assets[i]!.name}))};
  const prepared={plan,tailFrame:body.tailFrame,preparedProjectSha256:await previewDocDigest(buildPreviewRevision(doc,plan))};
  await mkdir(dir,{recursive:true});
  await writeFile(join(dir,'prepared.json'),JSON.stringify(prepared),{flag:'wx',mode:0o600});
  return {...receipt,...prepared};
}

/** Reuses exact mixed audio and subtitle pixels. Only the host-approved sentence is removed.
 * Picture trimming is frame based; audio cutting uses file-placement seconds to avoid clipping the next voice onset. */
async function prepareSniffMerge(p:SniffMergePermit,doc:ProjectDoc,deps:PreviewEditDeps,dir:string,baseline:string,source:string) {
  const prefix=`preview-edit-${p.operationId}`;
  const paths=['caption.png','sniff.mp4','mix.wav'].map(s=>{const name=`${prefix}-${s}`;const path=(deps.output??deps.resolve)(name);if(!path)throw new Error('Output unavailable');return {name,path};});
  await mkdir(dirname(paths[0]!.path),{recursive:true});
  const [a,b]=p.removeFrames,[x,y]=p.removeAudioSeconds,total=p.baseline.totalFrames-(b-a);
  await deps.execute(['-hide_banner','-loglevel','error','-y','-i',baseline,'-vf',
    `select=eq(n\\,${p.captionReferenceFrame}),crop=720:320:0:960`,'-frames:v','1',paths[0]!.path]);
  await deps.execute(['-hide_banner','-loglevel','error','-y','-ss',String(p.sourceStartFrame/p.source.fps),'-i',source,
    '-loop','1','-i',paths[0]!.path,'-filter_complex',
    `[0:v]fps=30,scale=540:960,pad=720:1280:90:0:color=0xf7f8fa,setsar=1[base];[base][1:v]overlay=0:960:enable=lt(n\\,${p.captionFrames}):shortest=1,format=yuv420p[v]`,
    '-map','[v]','-an','-frames:v',String(p.pictureFrames),'-c:v','libx264','-preset','fast','-crf','18','-threads','2',paths[1]!.path]);
  await deps.execute(['-hide_banner','-loglevel','error','-y','-i',baseline,'-filter_complex',
    `[0:a]asplit=2[head][tail];[head]atrim=end=${x},asetpts=PTS-STARTPTS[a];[tail]atrim=start=${y},asetpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=0:a=1,atrim=end=${total/p.baseline.fps}[out]`,
    '-map','[out]','-c:a','pcm_s16le',paths[2]!.path]);
  const base=asset(`${prefix}-base`,p.baseline.src,'锁定前版预览基线','video',p,p.baseline.sha256);
  const video={...asset(`${prefix}-sniff`,`/media/uploads/${paths[1]!.name}`,'近鼻连续画面及复用气味字幕','video',p,await sha256File(paths[1]!.path)),durationInFrames:p.pictureFrames};
  const audio:MediaAsset={id:`${prefix}-audio`,name:'原混音精简，仅去掉动作复述',kind:'audio',src:`/media/uploads/${paths[2]!.name}`,durationInFrames:total,sourceContentHash:await sha256File(paths[2]!.path)};
  const plan:PreviewEditPlan={operationId:p.operationId,projectId:p.projectId,baseline:base,fps:p.baseline.fps,totalFrames:total,
    baseSegments:[{startFrame:0,durationInFrames:a,srcInFrame:0},{startFrame:a,durationInFrames:p.baseline.totalFrames-b,srcInFrame:b}],
    patches:[{asset:video,startFrame:a,endFrame:a+p.pictureFrames,name:video.name}],audio};
  const prepared={plan,preparedProjectSha256:await previewDocDigest(buildPreviewRevision(doc,plan))};
  await writeFile(join(dir,'prepared.json'),JSON.stringify(prepared),{flag:'wx',mode:0o600});
  return prepared;
}
