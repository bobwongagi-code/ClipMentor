import assert from 'node:assert/strict';
import type {ProjectDoc,ClipTransform} from '../editor/types';
import * as delivery from './delivery-sections';
import {renderedVisualFrameRect} from '../editor/visualFrameGeometry';
import {flexCropRect} from '../editor/flexCrop';
import saved from './fixtures/delivery-review-inputs-20261029.json';
import grouped from './fixtures/grouped-registration-v1.json';
import {makeDraft} from '../editor/store';
import {execClipMentorAnalysisTool} from '../agent/tools/clipmentor-analysis-tools';
import {validateGenericUpdate} from '../agent/tools/edit-item-generic';
const section=structuredClone(saved.request.packet.delivery_sections![1]) as delivery.DeliverySection;
const source={width:1587,height:2003},canvas={width:576,height:1024};
const pixels={x:432,y:550,width:400,height:360};
const frame=renderedVisualFrameRect(canvas,source,'contain');
// Independent expected mapping: full source fit → source pixel edges → canvas pixel edges.
const left=Math.round(frame.x+pixels.x/source.width*frame.width),top=Math.round(frame.y+pixels.y/source.height*frame.height);
const right=canvas.width-Math.round(frame.x+(pixels.x+pixels.width)/source.width*frame.width),bottom=canvas.height-Math.round(frame.y+(pixels.y+pixels.height)/source.height*frame.height);
const correct={left:left/canvas.width,top:top/canvas.height,right:right/canvas.width,bottom:bottom/canvas.height};
const duration=Math.round(section.voice.existing_audio!.durationSeconds*30);
const doc={version:1,activeTimelineId:'test',assets:[{id:section.picture.asset_id,kind:'image',name:'Synthetic bound poster',src:section.picture.src,...source,sourceContentHash:section.picture.sha256},{id:section.voice.existing_audio!.assetId,kind:'audio',src:section.voice.existing_audio!.src,durationInFrames:duration}],timelines:[{id:'test',name:'Test only',...canvas,fps:30,selectedId:null,items:[{id:'picture',kind:'image',sourceAssetId:section.picture.asset_id,src:section.picture.src,track:'V1',startFrame:0,durationInFrames:duration,...source,transform:{crop:correct}},{id:'audio',kind:'audio',sourceAssetId:section.voice.existing_audio!.assetId,src:section.voice.existing_audio!.src,track:'A1',startFrame:0,durationInFrames:duration}]}],mediaFolders:[]} as unknown as ProjectDoc;
const pick=process.argv.find(a=>a.startsWith('--case='))?.slice(7);
if(!pick||pick==='wrong'){
 const wrong=structuredClone(doc);wrong.timelines[0].items[0].transform!.crop=section.picture.crop;
 assert(delivery.deliveryTimeline(wrong,[section]).issues.some(i=>i.includes('crop_mismatch')),'source fractions pasted into canvas crop must not pass');
}
if(!pick||pick==='correct')assert.deepEqual(delivery.deliveryTimeline(doc,[section]).issues,[],'proper source-to-canvas conversion must pass');
if(!pick){
 const binding=delivery.deliveryPictureBinding(doc,section);
 assert.deepEqual(binding.source_rect,pixels);assert.deepEqual(binding.tool_crop_px,{left,top,right,bottom});assert.deepEqual(binding.transform_crop,correct);
 const tool=validateGenericUpdate(doc.timelines[0],{type:'image',itemId:'picture',transform:{crop:binding.tool_crop_px}});
 assert.equal(tool.error,undefined);assert.deepEqual((tool.transform as ClipTransform|undefined)?.crop,correct,'original edit_item converts returned pixel arguments to the expected stored fractions');
 const unchanged=JSON.stringify(doc);delivery.deliveryPictureBindings(doc,[section]);assert.equal(JSON.stringify(doc),unchanged,'readback must not edit a project');
 const failures=[
  (d:ProjectDoc)=>{d.assets[0].width=undefined;},
  (d:ProjectDoc)=>{d.timelines[0].items[0].width=undefined;},
  (d:ProjectDoc)=>{d.timelines[0].items[0].width=123;},
  (d:ProjectDoc)=>{d.timelines[0].items[0].transform!.crop!.top!+=1/canvas.height;},
  (d:ProjectDoc)=>{d.timelines[0].items[0].zoom={magnification:2};},
  (d:ProjectDoc)=>{d.timelines[0].items[0].backgroundFill=true;},
  (d:ProjectDoc)=>{d.timelines[0].items[0].transform!.x=200;},
  (d:ProjectDoc)=>{d.timelines[0].items[0].keyframes={scale:[{frame:0,value:1},{frame:10,value:10}]};},
 ];
 for(const mutate of failures){const bad=structuredClone(doc);mutate(bad);assert(delivery.deliveryTimeline(bad,[section]).issues.length,'unknown dimensions, wrong crop, zoom and full-poster background cannot certify a planned crop');}
 for(const size of [{width:1587,height:2003},{width:1024,height:576},{width:800,height:800}]){
  const d=structuredClone(doc);Object.assign(d.timelines[0],size);const b=delivery.deliveryPictureBinding(d,section);d.timelines[0].items[0].transform={crop:b.transform_crop};assert.deepEqual(delivery.deliveryTimeline(d,[section]).issues,[]);
  assert.deepEqual(flexCropRect(b.transform_crop,size.width,size.height),b.canvas_rect);
 }
 const cover=structuredClone(doc);cover.timelines[0].fit='cover';const cb=delivery.deliveryPictureBinding(cover,section);cover.timelines[0].items[0].transform={crop:cb.transform_crop};assert.deepEqual(delivery.deliveryTimeline(cover,[section]).issues,[],'cover remains valid when all required pixels fit');
 const outside=structuredClone(section);outside.picture.crop={left:0,top:0,right:0,bottom:0};assert.throws(()=>delivery.deliveryPictureBinding(cover,outside),'cover cannot certify original pixels already outside its viewport');
 const invalid=structuredClone(section);invalid.picture.crop!.left=NaN;assert.throws(()=>delivery.deliveryPictureBinding(doc,invalid));
 const missing=structuredClone(doc);missing.timelines=[];assert.throws(()=>delivery.deliveryPictureBinding(missing,section));
 // Uncropped legacy sections do not require the new crop conversion path.
 const uncropped=structuredClone(section);delete uncropped.picture.crop;const old=structuredClone(doc);delete old.timelines[0].items[0].transform!.crop;assert.deepEqual(delivery.deliveryTimeline(old,[uncropped]).issues,[]);
 // A static crop may be repositioned after clipping; this does not change source selection.
 const positioned=structuredClone(doc);positioned.timelines[0].items[0].transform={crop:correct,scale:1.5,x:0,y:0};assert.deepEqual(delivery.deliveryTimeline(positioned,[section]).issues,[]);
 const readDoc=structuredClone(grouped) as unknown as ProjectDoc;
 readDoc.assets.push(...structuredClone(doc.assets));readDoc.timelines=structuredClone(doc.timelines);readDoc.activeTimelineId='test';
 const ir=(readDoc.clipMentorAnalysis!.blueprint[0] as any).internal_review;ir[ir.current_picture_plan].delivery_sections=[section];
 readDoc.clipMentorAnalysis!.evidence.push({evidence_id:section.evidence_ids[0],kind:'operator_supplied',text:'Synthetic readback fixture',status:'operator_provided_not_independently_verified',source_ids:[section.picture.asset_id],supporting_evidence_ids:[]});
 const draft=makeDraft(readDoc),before=JSON.stringify(draft.getDoc());
 const read:any=await execClipMentorAnalysisTool('read_clipmentor_analysis',{view:'current_copy',unitId:'BT-U01',copyPart:'picture_plan'},{...draft,getCreativeMode:()=> 'clipmentor',templates:[],audio:[]});
 assert(JSON.stringify(read).indexOf('delivery_picture_bindings')<JSON.stringify(read).indexOf('current_copy'),'derived tool parameters precede the long historical picture plan in readback');
 assert.equal(read.analysis.delivery_picture_bindings[0].status,'ready');assert.deepEqual(read.analysis.delivery_picture_bindings[0].tool_crop_px,binding.tool_crop_px);
 assert.equal(JSON.stringify(draft.getDoc()),before);assert.equal(draft.takeActions().length,0,'execution readback remains read-only and does not bind approval');
 const incomplete=structuredClone(readDoc);incomplete.assets.find(a=>a.id===section.picture.asset_id)!.width=undefined;
 const missingDraft=makeDraft(incomplete),missingRead:any=await execClipMentorAnalysisTool('read_clipmentor_analysis',{view:'current_copy',unitId:'BT-U01',copyPart:'picture_plan'},{...missingDraft,getCreativeMode:()=> 'clipmentor',templates:[],audio:[]});assert.equal(missingRead.analysis.delivery_picture_bindings[0].status,'unavailable','incomplete plans remain readable with a concrete geometry diagnostic');
 console.log('Delivery crop: wrong source-as-canvas rejected; mapped crop, aspect ratios, metadata, read-only bindings and legacy positive controls passed.');
}
