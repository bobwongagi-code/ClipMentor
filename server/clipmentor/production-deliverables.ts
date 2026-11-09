import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import type {ProjectDoc} from '../../src/editor/types';
import {deliverySectionsFromDoc} from '../../src/clipmentor/delivery-bindings';
import {isSafeUploadName,resolveUploadFile} from '../media-dir';
import {creatorStoryboard,creatorStoryboardSource} from './creator-storyboard';
import {deliveryFileName} from './delivery-filename';
import {loadCreatorStoryboardDocument} from './creator-storyboard-document';

/** Required outputs come from the current bound plan; pool registration is not delivery. */
export async function productionAttachmentSlots(doc:ProjectDoc,io={resolve:resolveUploadFile,read:readFile},at=Date.now()){
 const outputs=[];
 for(const section of deliverySectionsFromDoc(doc)){
  const layout=section.picture.layout;
  if(layout?.kind!=='product_storyboard')continue;
  const expected=layout.attachment,asset=doc.assets.find(a=>a.id===expected.asset_id);
  const name=expected.src.startsWith('/media/uploads/')?expected.src.slice('/media/uploads/'.length):'';
  const file=isSafeUploadName(name)?io.resolve(name):null;
  if(!asset||asset.kind!=='image'||asset.src!==expected.src||asset.sourceContentHash!==expected.sha256||!file)
   throw Error('required_delivery_output_unavailable:'+section.section_id);
  const bytes=await io.read(file);
  if(!bytes.length||createHash('sha256').update(bytes).digest('hex')!==expected.sha256)
   throw Error('required_delivery_output_changed:'+section.section_id);
  const metadata=await sharp(bytes).metadata();
  if(!metadata.width||!metadata.height)throw Error('required_delivery_output_unreadable:'+section.section_id);
  creatorStoryboardSource(doc);
  await loadCreatorStoryboardDocument(doc);
  outputs.push({sectionId:section.section_id,assetId:asset.id,
   fileName:deliveryFileName(doc.clipMentorAnalysis!.product.name,undefined,'storyboard',at)});
 }
 return outputs;
}

export async function productionDeliverables(doc:ProjectDoc,io={resolve:resolveUploadFile,read:readFile,storyboard:creatorStoryboard},at=Date.now()){
 const slots=await productionAttachmentSlots(doc,io,at);
 if(!slots.length)return [];
 const document=await io.storyboard(doc);
 // assetId is the authorized attachment slot, not a claim that the screen PNG
 // contains these PDF bytes. No PNG URL is published as the document's location.
 return slots.map(slot=>({...slot,mimeType:'application/pdf',sha256:createHash('sha256').update(document.bytes).digest('hex'),bytes:document.bytes}));
}
