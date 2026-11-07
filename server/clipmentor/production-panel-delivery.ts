import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {MediaAsset,ProjectDoc} from '../../src/editor/types';
import {deliverySectionsFromDoc} from '../../src/clipmentor/delivery-bindings';
import {originalPlaybackRanges} from '../../src/clipmentor/source-breakdown';
import {resolveUploadFile,uploadDir} from '../media-dir';
import {sha256File} from '../../shared/node-content-hash';
import {sourceFrameSeekMs} from '../../shared/source-frame-seek';
import {extractOneFrame} from '../plugins/extract-frames';
import {tileContactSheet} from '../frame-grid';
import {ffmpegBin} from '../media-binaries';
import {resolveProductAsset} from '../product-assets';
import type {ProductionTask} from './production-task';
import type {AnalysisEvidence} from '../../src/clipmentor/analysis';

/** The operator uploads this slot as the source video's performance evidence. */
export function panelSalesEvidence(sourceId:string,salesId:string):AnalysisEvidence{
 return {evidence_id:'panel-sales-'+createHash('sha256').update(sourceId+':'+salesId).digest('hex').slice(0,20),
  kind:'operator_supplied',text:'用户提供的原片成绩图，图中成绩属于本任务原片。统计窗口按图中信息；没有显示的日期留未知。',
  status:'operator_provided_not_independently_verified',source_ids:[sourceId,salesId],supporting_evidence_ids:[],
  provenance:'操作者在原片成绩图上传槽提供，按用户确认的业务口径登记'};
}

export function panelStoryboardTimes(doc:ProjectDoc){
 const breakdown=doc.clipMentorAnalysis?.source_breakdown;
 const units=breakdown?.units;
 if(!breakdown||!units?.length)return [];
 return [...new Set([0,Math.floor(units.length/2),units.length-1])].flatMap(index=>{
  const window=originalPlaybackRanges(breakdown,units[index])[0];
  return window?[(window[0]+window[1])/2]:[];
 });
}
function storyboardSourceMatches(doc:ProjectDoc,asset:MediaAsset|undefined,times:number[]){
 const source=doc.clipMentorAnalysis?.source;
 return !!times.length&&!!source?.sourceContentHash&&asset?.kind==='image'&&asset.props?.clipmentorStoryboardSource===source.asset_id
  &&asset.props?.clipmentorStoryboardHash===source.sourceContentHash
  &&JSON.stringify(asset.props?.clipmentorStoryboardTimes)===JSON.stringify(times)
  &&asset.id===`clipmentor-storyboard-${asset.sourceContentHash}`
  &&asset.src===`/media/uploads/${asset.id}.jpg`;
}
export function panelStoryboardAsset(doc:ProjectDoc){
 const times=panelStoryboardTimes(doc);
 return doc.assets.find(asset=>storyboardSourceMatches(doc,asset,times));
}

/** Previewable original-frame reference for the existing partner ending. */
export async function createPanelStoryboard(doc:ProjectDoc,signal:AbortSignal):Promise<MediaAsset|undefined>{
 const analysis=doc.clipMentorAnalysis,source=analysis?.source,breakdown=analysis?.source_breakdown;
 if(!source||!breakdown?.units.length)throw Error('panel_storyboard_source_plan_missing');
 const times=panelStoryboardTimes(doc);
 if(times.length!==Math.min(3,breakdown.units.length)||times.some(s=>!Number.isFinite(s)||s<0||s>=source.duration_seconds))throw Error('panel_storyboard_source_plan_missing');
 const registered=panelStoryboardAsset(doc);
 if(registered){
  const file=resolveUploadFile(`${registered.id}.jpg`);
  if(file&&await sha256File(file)===registered.sourceContentHash)return;
  throw Error('panel_storyboard_asset_unavailable');
 }
 const asset=doc.assets.find(a=>a.id===source.asset_id);
 const file=asset?.kind==='video'&&resolveUploadFile(asset.src.replace(/^\/media\/uploads\//,''));
 if(!file||!source.sourceContentHash||await sha256File(file)!==source.sourceContentHash)throw Error('Original source changed');
 const logo=resolveProductAsset('clipmentor/rootify-logo.png');
 if(!logo)throw Error('panel_storyboard_logo_unavailable');
 const work=await mkdtemp(join(tmpdir(),'clipmentor-panel-storyboard-'));
 try{
  const frames=[];
  for(const [index,seconds]of times.entries()){
   signal.throwIfAborted();
   const frame=join(work,`${index}.jpg`);
   await extractOneFrame(file,sourceFrameSeekMs(seconds*1000),frame,true);
   frames.push({jpeg:await readFile(frame),label:`${index+1} / ${seconds.toFixed(1)}s`});
  }
  const sheet=join(work,'sheet.jpg'),branded=join(work,'storyboard.jpg');
  await writeFile(sheet,await tileContactSheet(frames,{cellWidth:320,cellHeight:560,cols:frames.length}));
  await promisify(execFile)(ffmpegBin(),['-v','error','-i',sheet,'-i',logo,'-filter_complex_threads','1',
   '-filter_complex','[0:v]pad=iw:ih+72:0:72:color=white[card];[1:v]scale=120:-2[logo];[card][logo]overlay=12:6',
   '-frames:v','1','-q:v','4',branded],{timeout:20_000,signal});
  const bytes=await readFile(branded);
  signal.throwIfAborted();
  if(await sha256File(file)!==source.sourceContentHash)throw Error('Original source changed');
  const hash=createHash('sha256').update(bytes).digest('hex'),id=`clipmentor-storyboard-${hash}`;
  // Stage beside the destination so publishing is atomic across volumes.
  const target=join(uploadDir(),`${id}.jpg`),temp=`${target}.${createHash('sha256').update(work).digest('hex')}.tmp`;
  try{await writeFile(temp,bytes,{flag:'wx'});await rename(temp,target);}finally{await rm(temp,{force:true});}
  return {id,name:'Storyboard video asal · Rootify',kind:'image',src:`/media/uploads/${id}.jpg`,sourceContentHash:hash,
   width:320*frames.length,height:632,durationInFrames:1,props:{clipmentorStoryboardSource:source.asset_id,
    clipmentorStoryboardHash:source.sourceContentHash,clipmentorStoryboardTimes:times}};
 }finally{await rm(work,{recursive:true,force:true});}
}

export function panelDeliveryIssues(doc:ProjectDoc,scope:NonNullable<ProductionTask['input']['panelDelivery']>){
 const sections=deliverySectionsFromDoc(doc);
 const opening=sections.find(s=>s.kind==='performance_opening');
 const invited=sections.filter(s=>s.kind==='creator_invitation');
 const fresh=invited.find(s=>s.section_id==='new_contact');
 const partner=invited.find(s=>s.section_id==='existing_partner');
 const freshLayout=fresh?.picture.layout,partnerLayout=partner?.picture.layout;
 const poster=freshLayout?.kind==='recruitment_card'?freshLayout.poster:fresh?.picture;
 const layered=scope.bookends==='layered-v1',layout=opening?.picture.layout;
 const salesEvidence=scope.salesEvidenceId&&doc.clipMentorAnalysis?.evidence.find(e=>e.evidence_id===scope.salesEvidenceId);
 const salesAllowed=!!salesEvidence&&salesEvidence.kind==='operator_supplied'&&salesEvidence.call_status!=='failed'
  &&salesEvidence.source_ids.includes(scope.salesAssetId)&&salesEvidence.source_ids.includes(doc.clipMentorAnalysis!.source.asset_id)
  &&createHash('sha256').update(salesEvidence.text).digest('hex')===scope.salesEvidenceSha256
  &&opening?.evidence_ids.includes(salesEvidence.evidence_id);
 return [
  ...(scope.audience&&(invited.length!==1||invited[0].section_id!==scope.audience)?['delivery_audience_scope_mismatch']:[]),
  ...(layered?(layout?.kind!=='original_underlay'?['opening_original_underlay_missing']:[])
   :(!opening||opening.picture.asset_id!==scope.productAssetId||opening.picture.sha256!==scope.productAssetHash?['opening_product_image']:[])),
  ...(layered&&layout?.kind==='original_underlay'&&(layout.show_sales!==!!scope.salesEvidenceId
   ||(layout.show_sales&&(!salesAllowed||opening!.picture.asset_id!==scope.salesAssetId||opening!.picture.sha256!==scope.salesAssetHash)))?['opening_sales_binding_invalid']:[]),
  ...(layered&&layout?.kind==='original_underlay'&&!layout.show_sales&&
   (opening!.picture.asset_id!==scope.productAssetId||opening!.picture.sha256!==scope.productAssetHash)?['opening_product_evidence_mismatch']:[]),
  ...((!layered||!salesAllowed)&&opening?.evidence_ids.some(id=>doc.clipMentorAnalysis?.evidence.find(e=>e.evidence_id===id)?.source_ids.includes(scope.salesAssetId))
   ?['opening_sales_attribution_unconfirmed']:[]),
  ...(scope.audience==='existing_partner'?[]:!poster||poster.asset_id!==scope.ctaAssetId||poster.sha256!==scope.ctaAssetHash
   ||fresh?.picture.asset_id!==scope.ctaAssetId||fresh.picture.sha256!==scope.ctaAssetHash?['new_contact_cta_image']:[]),
  ...(scope.audience!=='existing_partner'&&layered&&freshLayout?.kind!=='product_commission'&&freshLayout?.kind!=='recruitment_card'?['new_contact_product_commission_composition_missing']:[]),
  ...(scope.audience==='new_contact'?[]:partnerLayout?.kind==='product_storyboard'
   ?partnerLayout.product.asset_id!==scope.productAssetId||partnerLayout.product.sha256!==scope.productAssetHash?['existing_partner_product_image']:[]
   :!partner||!storyboardSourceMatches(doc,doc.assets.find(a=>a.id===partner.picture.asset_id),panelStoryboardTimes(doc))?['existing_partner_storyboard']:[]),
 ];
}
