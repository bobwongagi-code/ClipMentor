import {labelTranslationsShape} from './author-translations';
/** Import existing native analysis/full planner envelopes through the original import action.
 * The outer delivery declarations are a completeness check, never an approval or a second store. */
import {isClipMentorAnalysis,type AnalysisActor,type ClipMentorAnalysis} from './analysis';
import {deliverySectionsFromDoc,deliveryPictureBinding} from './delivery-sections';
import {copyLineKeys} from './source-breakdown';
import type {ProjectDoc} from '../editor/types';
type Row=Record<string,unknown>;
const row=(v:unknown):v is Row=>!!v&&typeof v==='object'&&!Array.isArray(v);
const codes=['blueprint_import_invalid','blueprint_import_source_mismatch','blueprint_body_copy_mismatch','blueprint_declared_delivery_unbound','blueprint_delivery_copy_mismatch','blueprint_delivery_asset_binding_invalid']as const;
export class BlueprintImportError extends Error {readonly code:typeof codes[number];constructor(code:typeof codes[number]){super(code);this.code=code;}}
const fail=(code:typeof codes[number]):never=>{throw new BlueprintImportError(code);};
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);

export function importNativeBlueprint(input:unknown,assetId:string,doc:ProjectDoc,actor:AnalysisActor,reason:string,now:number):ClipMentorAnalysis|null{
 const wrapper=row(input)&&Object.hasOwn(input,'clipMentorAnalysis')?input:null;
 if(!wrapper&&!isClipMentorAnalysis(input))return null; // Historical adapter keeps its original path.
 const source=wrapper?.clipMentorAnalysis??input;
 if(!isClipMentorAnalysis(source))return fail('blueprint_import_invalid');
 const a=structuredClone(source),asset=doc.assets.find(v=>v.id===assetId);
 if(asset?.kind!=='video'||a.source.asset_id!==assetId||!asset.sourceContentHash||a.source.sourceContentHash!==asset.sourceContentHash)return fail('blueprint_import_source_mismatch');
 // Imported flags and old receipts never sign the destination project.
 delete a.production_copy_review;a.reviews=[];
 for(const unit of a.blueprint){const ir=(unit as unknown as Row).internal_review;if(!row(ir))continue;
  for(const id of [ir.current_script_candidate,ir.current_picture_plan])if(typeof id==='string'&&row(ir[id]))Object.assign(ir[id],{status:'candidate',review_status:'pending',production_allowed:false});
 }
 // Optional existing read-view mirror must describe these exact selected lines, not a stale author draft.
 if(wrapper&&Object.hasOwn(wrapper,'narration_and_captions')){
  const lineView=(v:unknown)=>row(v)?Object.fromEntries(copyLineKeys.map(k=>[k,v[k]])):null;
  const selected=a.blueprint.flatMap(unit=>{const ir=(unit as unknown as Row).internal_review;if(!row(ir))return[];const c=ir[String(ir.current_script_candidate)];return row(c)&&Array.isArray(c.lines)?c.lines:[];});
  if(!Array.isArray(wrapper.narration_and_captions)||!same(wrapper.narration_and_captions.map(lineView),selected.map(lineView)))return fail('blueprint_body_copy_mismatch');
 }
 const boundDoc={...doc,clipMentorAnalysis:a};
 if(wrapper&&Object.hasOwn(wrapper,'delivery_sections')){
  const declarations=wrapper.delivery_sections;
  if(!row(declarations))return fail('blueprint_import_invalid');
  const hasOpening=Object.hasOwn(declarations,'opening'),hasEndings=Object.hasOwn(declarations,'creator_endings');
  const declarationShape=(v:unknown)=>row(v)&&typeof v.id==='string'&&!!v.id.trim()&&typeof v.narration_ms==='string'&&!!v.narration_ms.trim()&&Array.isArray(v.caption_lines)&&v.caption_lines.length>0&&v.caption_lines.every(t=>typeof t==='string'&&!!t.trim())&&typeof v.zh==='string'&&!!v.zh.trim()&&Array.isArray(v.labels)&&v.labels.every(t=>typeof t==='string')&&labelTranslationsShape(v.labels_zh,v.labels);
  if((!hasOpening&&!hasEndings)||(hasOpening&&!declarationShape(declarations.opening))
   ||(hasEndings&&(!row(declarations.creator_endings)||Object.keys(declarations.creator_endings).length===0||!Object.values(declarations.creator_endings).every(declarationShape))))return fail('blueprint_import_invalid');
  let sections:ReturnType<typeof deliverySectionsFromDoc>;
  try{sections=deliverySectionsFromDoc(boundDoc);}catch{return fail('blueprint_delivery_asset_binding_invalid');}
  const opening=sections.filter(s=>s.kind==='performance_opening'),endings=sections.filter(s=>s.kind==='creator_invitation');
  const declaredEnds=row(declarations.creator_endings)?Object.values(declarations.creator_endings):[];
  if(opening.length!==(hasOpening?1:0)||endings.length!==(hasEndings?1:0))return fail('blueprint_declared_delivery_unbound');
  const match=(line:typeof sections[number]['line'],declared:unknown)=>row(declared)&&line.line_id===declared.id&&line.narration_ms===declared.narration_ms&&same(line.caption_lines,declared.caption_lines)&&line.meaning_zh===declared.zh&&same(line.labels,declared.labels)&&same(line.labels_zh,declared.labels_zh);
  if(opening.some(s=>!match(s.line,declarations.opening))||endings.some(s=>!declaredEnds.some(e=>match(s.line,e))))return fail('blueprint_delivery_copy_mismatch');
  // Registration validates material geometry, not a future synthesis result.
  // deliverySectionsFromDoc already checks display shape/fps and known audio bounds.
  try{for(const section of sections)if(section.picture.crop)deliveryPictureBinding(boundDoc,section);}catch{return fail('blueprint_delivery_asset_binding_invalid');}
 }
 a.audit.push({revision:a.revision,action:'native_blueprint_import',target_id:'analysis',actor,at:now,reason});
 a.import_origin='native_blueprint_import:'+source.import_origin;
 return a;
}
