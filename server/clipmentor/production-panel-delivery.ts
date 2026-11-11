import {createHash,randomUUID} from 'node:crypto';
import {rename,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {MediaAsset,ProjectDoc} from '../../src/editor/types';
import {deliverySectionsFromDoc} from '../../src/clipmentor/delivery-bindings';
import {resolveUploadFile,uploadDir} from '../media-dir';
import {sha256File} from '../../shared/node-content-hash';
import {creatorStoryboard} from './creator-storyboard';
import {loadCreatorStoryboardDocument,creatorDocumentHash,creatorDocumentFromSourceAsset,isCreatorDocumentIssue,type CreatorStoryboardDocument} from './creator-storyboard-document';
import type {ProductionTask} from './production-task';
import type {AnalysisEvidence} from '../../src/clipmentor/analysis';

/** The operator uploads this slot as the source video's performance evidence. */
export function panelSalesEvidence(sourceId:string,salesId:string):AnalysisEvidence{
 return {evidence_id:'panel-sales-'+createHash('sha256').update(sourceId+':'+salesId).digest('hex').slice(0,20),
  kind:'operator_supplied',text:'用户提供的原片成绩图，图中成绩属于本任务原片。统计窗口按图中信息；没有显示的日期留未知。',
  status:'operator_provided_not_independently_verified',source_ids:[sourceId,salesId],supporting_evidence_ids:[],
  provenance:'操作者在原片成绩图上传槽提供，按用户确认的业务口径登记'};
}

export function panelStoryboardTimes(doc:ProjectDoc,content=creatorDocumentFromSourceAsset(doc)){
 return content?content.rows.flatMap(r=>r.source_frames.map(f=>f/doc.clipMentorAnalysis!.source.fps)):[];
}
function storyboardSourceMatches(doc:ProjectDoc,asset:MediaAsset|undefined,times:number[]){
 const source=doc.clipMentorAnalysis?.source;
 return asset?.props?.clipmentorStoryboardDocument===2&&!!times.length&&!!source?.sourceContentHash&&asset?.kind==='image'&&asset.props?.clipmentorStoryboardSource===source.asset_id
  &&asset.props?.clipmentorStoryboardHash===source.sourceContentHash
  &&JSON.stringify(asset.props?.clipmentorStoryboardTimes)===JSON.stringify(times)
  &&asset.id===`clipmentor-storyboard-${asset.sourceContentHash}`
  &&asset.src===`/media/uploads/${asset.id}.jpg`;
}
export function panelStoryboardAsset(doc:ProjectDoc,content:CreatorStoryboardDocument|null|undefined=creatorDocumentFromSourceAsset(doc)){
 if(!content)return undefined;
 const times=panelStoryboardTimes(doc,content),documentHash=creatorDocumentHash(content);
 return doc.assets.find(asset=>storyboardSourceMatches(doc,asset,times)&&asset.props?.clipmentorCreatorDocumentHash===documentHash);
}

/** Previewable original-frame reference for the existing partner ending. */
export async function createPanelStoryboard(doc:ProjectDoc,signal:AbortSignal):Promise<MediaAsset|undefined>{
 signal.throwIfAborted();
 const source=doc.clipMentorAnalysis?.source;
 if(!source)throw Error('panel_storyboard_source_plan_missing');
 let content:Awaited<ReturnType<typeof loadCreatorStoryboardDocument>>;
 content=await loadCreatorStoryboardDocument(doc);
 const times=panelStoryboardTimes(doc,content);
 const contentHash=createHash('sha256').update(JSON.stringify(content)).digest('hex');
 const registered=doc.assets.find(a=>storyboardSourceMatches(doc,a,times)&&a.props?.clipmentorCreatorDocumentHash===contentHash);
 if(registered){
  const file=resolveUploadFile(`${registered.id}.jpg`);
  if(file&&await sha256File(file).catch(()=>null)===registered.sourceContentHash){signal.throwIfAborted();return;}
 }
 const asset=doc.assets.find(a=>a.id===source.asset_id);
 const file=asset?.kind==='video'&&resolveUploadFile(asset.src.replace(/^\/media\/uploads\//,''));
 if(!file||!source.sourceContentHash||await sha256File(file)!==source.sourceContentHash)throw Error('Original source changed');
 signal.throwIfAborted();
 const document=await creatorStoryboard(doc,signal);
 signal.throwIfAborted();
 const bytes=document.preview,hash=createHash('sha256').update(bytes).digest('hex'),id=`clipmentor-storyboard-${hash}`;
 if(registered&&registered.sourceContentHash!==hash)throw Error('storyboard_document_cover_recovery_mismatch');
 const target=join(uploadDir(),`${id}.jpg`),temp=`${target}.${randomUUID()}.tmp`;
 try{await writeFile(temp,bytes,{flag:'wx'});signal.throwIfAborted();await rename(temp,target);}finally{await rm(temp,{force:true});}
 signal.throwIfAborted();
 if(registered)return;
 return {id,name:'Storyboard video asal · Rootify',kind:'image',src:`/media/uploads/${id}.jpg`,sourceContentHash:hash,
  width:1190,height:1684,durationInFrames:1,props:{clipmentorStoryboardSource:source.asset_id,
   clipmentorStoryboardHash:source.sourceContentHash,clipmentorStoryboardTimes:times,clipmentorStoryboardDocument:2,clipmentorCreatorDocumentHash:contentHash}};
}

/** A local document problem must return to the author, not block the author from running. */
export async function preparePanelStoryboardForAuthor(doc:ProjectDoc,signal:AbortSignal){
 try{return {asset:await createPanelStoryboard(doc,signal)};}
 catch(error){if(!isCreatorDocumentIssue(error))throw error;return {issue:(error as Error).message};}
}

export function panelDeliveryIssues(doc:ProjectDoc,scope:NonNullable<ProductionTask['input']['panelDelivery']>,content:CreatorStoryboardDocument|null|undefined=creatorDocumentFromSourceAsset(doc)){
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
   ?partnerLayout.product.asset_id!==scope.productAssetId||partnerLayout.product.sha256!==scope.productAssetHash?['existing_partner_product_image']
    :panelStoryboardAsset(doc,content)?.id!==partnerLayout.storyboard.asset_id?['existing_partner_storyboard']:[]
   :!partner||panelStoryboardAsset(doc,content)?.id!==partner.picture.asset_id?['existing_partner_storyboard']:[]),
 ];
}
