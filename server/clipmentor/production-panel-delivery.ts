import {createHash,randomUUID} from 'node:crypto';
import {readFile,rename,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import sharp from 'sharp';
import {digestValue} from '../agent-runs/store-values';
import type {MediaAsset,ProjectDoc} from '../../src/editor/types';
import {deliverySectionsFromDoc,type DeliverySection} from '../../src/clipmentor/delivery-bindings';
import {isSafeUploadName,resolveUploadFile,uploadDir} from '../media-dir';
import {sha256File} from '../../shared/node-content-hash';
import {creatorStoryboard,verifyCreatorStoryboardEvidence} from './creator-storyboard';
import {loadCreatorStoryboardDocument,currentCreatorDocument,creatorDocumentHash,creatorDocumentFromSourceAsset,isCreatorDocumentIssue,type CreatorStoryboardDocument} from './creator-storyboard-document';
import type {ProductionTask} from './production-task';
import type {BlueprintFinding} from '../../src/clipmentor/blueprint-lint';
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
 const times=panelStoryboardTimes(doc,content),documentHash=creatorDocumentHash(content),legacySortedHash=digestValue(content);
 return doc.assets.find(asset=>storyboardSourceMatches(doc,asset,times)
  &&[documentHash,legacySortedHash].includes(String(asset.props?.clipmentorCreatorDocumentHash)));
}

/** Previewable original-frame reference for the existing partner ending. */
export async function createPanelStoryboard(doc:ProjectDoc,signal:AbortSignal,verifyCover=false):Promise<MediaAsset|undefined>{
 signal.throwIfAborted();
 const source=doc.clipMentorAnalysis?.source;
 if(!source)throw Error('panel_storyboard_source_plan_missing');
 let content:Awaited<ReturnType<typeof loadCreatorStoryboardDocument>>;
 content=await loadCreatorStoryboardDocument(doc);
 const times=panelStoryboardTimes(doc,content);
 const contentHash=creatorDocumentHash(content);
 const prior=panelStoryboardAsset(doc,content);
 if(prior&&!verifyCover){
  const registered=prior;
  const file=resolveUploadFile(`${registered.id}.jpg`);
  if(file&&await sha256File(file).catch(()=>null)===registered.sourceContentHash){const verified=await verifyCreatorStoryboardEvidence(doc,signal);if(creatorDocumentHash(verified.document)!==contentHash)throw Error('storyboard_document_evidence_changed');signal.throwIfAborted();return;}
 }
 const asset=doc.assets.find(a=>a.id===source.asset_id);
 const file=asset?.kind==='video'&&resolveUploadFile(asset.src.replace(/^\/media\/uploads\//,''));
 if(!file||!source.sourceContentHash||await sha256File(file)!==source.sourceContentHash)throw Error('Original source changed');
 signal.throwIfAborted();
 const document=await creatorStoryboard(doc,signal);
 signal.throwIfAborted();
 const bytes=document.preview,hash=createHash('sha256').update(bytes).digest('hex'),id=`clipmentor-storyboard-${hash}`;
 if(prior&&!verifyCover&&prior.sourceContentHash!==hash)throw Error('storyboard_document_cover_recovery_mismatch');
 const registered=doc.assets.find(candidate=>candidate.id===id);
 const target=join(uploadDir(),`${id}.jpg`),temp=`${target}.${randomUUID()}.tmp`;
 if(prior?.id===id&&await sha256File(target).catch(()=>null)===hash)return;
 try{await writeFile(temp,bytes,{flag:'wx'});signal.throwIfAborted();await rename(temp,target);}finally{await rm(temp,{force:true});}
 signal.throwIfAborted();
 if(registered?.id===prior?.id&&registered)return;
 return {id,name:'Storyboard video asal · Rootify',kind:'image',src:`/media/uploads/${id}.jpg`,sourceContentHash:hash,
  width:1190,height:1684,durationInFrames:1,props:{clipmentorStoryboardSource:source.asset_id,
   clipmentorStoryboardHash:source.sourceContentHash,clipmentorStoryboardTimes:times,clipmentorStoryboardDocument:2,clipmentorCreatorDocumentHash:contentHash}};
}

/** A local document problem must return to the author, not block the author from running. */
export async function preparePanelStoryboardForAuthor(doc:ProjectDoc,signal:AbortSignal,verifyCover=false){
 try{return {asset:await createPanelStoryboard(doc,signal,verifyCover)};}
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
   :partnerStoryboardRequired(scope)?['existing_partner_product_image', 'existing_partner_storyboard', 'existing_partner_pdf_binding']
    :!partner||panelStoryboardAsset(doc,content)?.id!==partner.picture.asset_id?['existing_partner_storyboard']:[]),
  ...(partnerStoryboardRequired(scope)&&partnerLayout?.kind==='product_storyboard'
   &&panelStoryboardAsset(doc,content)?.id!==partnerLayout.attachment.asset_id?['existing_partner_pdf_binding']:[]),
 ];
}

type PanelScope=NonNullable<ProductionTask['input']['panelDelivery']>;
export function panelDeliveryFindings(doc:ProjectDoc,scope:PanelScope,content:CreatorStoryboardDocument|null):BlueprintFinding[]{
 let issues:string[];
 try{issues=panelDeliveryIssues(doc,scope,content);}
 catch(error){issues=[error instanceof Error?error.message:'delivery_invalid'];}
 return issues.map(issue=>({
  rule_id:'DELIVERY_BINDING',level:'warn',location:issue.startsWith('existing_partner')?'delivery_sections.existing_partner':
   issue.startsWith('new_contact')?'delivery_sections.new_contact':issue.startsWith('opening')?'delivery_sections.performance_opening':'delivery_sections',
  excerpt:'',message:issue,
 }));
}

type PartnerLayout=Extract<NonNullable<DeliverySection['picture']['layout']>,{kind:'product_storyboard'}>;
export function partnerStoryboardRequired(scope?:PanelScope){
 return scope?.partnerEnding==='product_storyboard_pdf'&&scope.audience!=='new_contact';
}
const imageRef=({id,src,sourceContentHash}:MediaAsset)=>({asset_id:id,src,sha256:sourceContentHash!});
function partnerCardInputs(doc:ProjectDoc,scope:PanelScope,content?:CreatorStoryboardDocument|null){
 const product=doc.assets.find(a=>a.id===scope.productAssetId&&a.kind==='image'&&a.sourceContentHash===scope.productAssetHash&&!a.props?.clipmentorReferenceOnly);
 const storyboard=panelStoryboardAsset(doc,content);
 if(!product||!storyboard||product.id===storyboard.id)return;
 const layout:PartnerLayout={kind:'product_storyboard',product:imageRef(product),storyboard:imageRef(storyboard),attachment:imageRef(storyboard)};
 return {layout,key:digestValue({version:1,layout})};
}

/** The author binds the host-created picture and separately declares the PDF slot. */
export function panelPartnerPicture(doc:ProjectDoc,scope:PanelScope,content?:CreatorStoryboardDocument|null){
 const inputs=partnerCardInputs(doc,scope,content);
 if(!inputs)return;
 const card=doc.assets.find(a=>a.kind==='image'&&a.width===720&&a.height===1280
  &&a.props?.clipmentorPartnerCardInputs===inputs.key
  &&a.id==='clipmentor-partner-'+a.sourceContentHash&&a.src==='/media/uploads/'+a.id+'.png');
 if(card)return {...imageRef(card),layout:inputs.layout};
}

async function partnerRoleBytes(ref:PartnerLayout['product']){
 const name=ref.src.startsWith('/media/uploads/')?ref.src.slice('/media/uploads/'.length):'';
 const file=isSafeUploadName(name)?resolveUploadFile(name):null;
 if(!file)throw Error('existing_partner_composition_source_missing');
 const bytes=await readFile(file);
 if(createHash('sha256').update(bytes).digest('hex')!==ref.sha256)throw Error('existing_partner_composition_source_changed');
 return bytes;
}
async function renderPartnerCard(layout:PartnerLayout){
 const fit=async(ref:PartnerLayout['product'],width:number,height:number)=>sharp(await partnerRoleBytes(ref))
  .rotate().resize(width,height,{fit:'contain',background:'#ffffff'}).flatten({background:'#ffffff'}).png().toBuffer();
 const [product,storyboard]=await Promise.all([fit(layout.product,262,542),fit(layout.storyboard,374,542)]);
 return sharp({create:{width:720,height:1280,channels:3,background:'#f6f4f0'}})
  .composite([{input:product,left:30,top:260},{input:storyboard,left:316,top:260}]).removeAlpha().png().toBuffer();
}
export async function preparePanelPartnerCard(doc:ProjectDoc,scope:PanelScope,signal:AbortSignal):Promise<MediaAsset|undefined>{
 if(!partnerStoryboardRequired(scope))return;
 const content=await currentCreatorDocument(doc);
 const inputs=partnerCardInputs(doc,scope,content);
 if(!inputs)return;
 signal.throwIfAborted();
 const existing=panelPartnerPicture(doc,scope,content);
 if(existing&&await verifyPanelPartnerCard(doc,scope,content,existing,signal))return;
 const bytes=await renderPartnerCard(inputs.layout);
 signal.throwIfAborted();
 const hash=createHash('sha256').update(bytes).digest('hex'),id='clipmentor-partner-'+hash;
 const path=join(uploadDir(),id+'.png'),temp=path+'.'+randomUUID()+'.tmp';
 try{await writeFile(temp,bytes,{flag:'wx'});signal.throwIfAborted();await rename(temp,path);}
 finally{await rm(temp,{force:true});}
 signal.throwIfAborted();
 if(existing?.asset_id===id)return;
 return {id,kind:'image',name:'Produk + Storyboard',src:'/media/uploads/'+id+'.png',
  width:720,height:1280,durationInFrames:1,sourceContentHash:hash,props:{clipmentorPartnerCardInputs:inputs.key}};
}

/** Check the actual planned image against the composition made from both frozen inputs. */
export async function verifyPanelPartnerCard(doc:ProjectDoc,scope:PanelScope,content?:CreatorStoryboardDocument|null,
 picture?:Pick<DeliverySection['picture'],'asset_id'|'src'|'sha256'|'layout'>,signal?:AbortSignal){
 if(!partnerStoryboardRequired(scope))return true;
 picture??=deliverySectionsFromDoc(doc).find(s=>s.section_id==='existing_partner')?.picture;
 const inputs=partnerCardInputs(doc,scope,content);
 if(!inputs||!picture?.layout||digestValue(picture.layout)!==digestValue(inputs.layout))return false;
 try{
  const document=await creatorStoryboard(doc,signal);
  if(createHash('sha256').update(document.preview).digest('hex')!==inputs.layout.storyboard.sha256)return false;
  const registered=panelPartnerPicture(doc,scope,content);
  if(!registered||registered.asset_id!==picture.asset_id||registered.src!==picture.src||registered.sha256!==picture.sha256)return false;
  const actual=await partnerRoleBytes(picture);
  const meta=await sharp(actual).metadata();
  if(meta.format!=='png'||(meta.pages??1)!==1||(meta.orientation??1)!==1)return false;
  const expected=await renderPartnerCard(inputs.layout);
  const [pixels,reference]=await Promise.all([sharp(actual).ensureAlpha().raw().toBuffer({resolveWithObject:true}),
   sharp(expected).ensureAlpha().raw().toBuffer({resolveWithObject:true})]);
  return pixels.info.width===reference.info.width&&pixels.info.height===reference.info.height&&pixels.data.equals(reference.data);
 }catch(error){if(signal?.aborted)throw error;return false;}
}
