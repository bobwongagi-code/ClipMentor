import {frozenParameterEdits} from '../../src/clipmentor/execution-parameters';
import type {ProjectDoc} from '../../src/editor/types';
import {copyTeachingPacketFromDoc,copyReviewSubject} from '../../src/clipmentor/production-gate';
import {deliveryAudio,deliveryPictureBindings} from '../../src/clipmentor/delivery-sections';
import {handoffAssetsOf} from '../../shared/clipmentor-handoff';
import {matchMeasuredNarration,createProductionPreparation} from './production-readiness';
import {digestValue} from '../agent-runs/store-values';
import {createSpeechAnchorReader} from './word-anchors';
import {NATIVE_TEXT_STYLE_VERSION,NATIVE_TEXT_PROPS} from '../../shared/native-text-style';

/** Current operational facts for the EXECUTOR. This must never replace the independent-review projection. */
export async function currentExecutionView(doc:ProjectDoc,voice?:{provider:string;voiceId:string}){
 return executionView(doc,await createProductionPreparation(doc),voice);
}

/** The product's audio/edit message prepares both views from this one operation.
 * Do not keep this preparation across edits, requests or a new saved snapshot. */
export async function currentExecutionPreparation(doc:ProjectDoc,voice?:{provider:string;voiceId:string}){
 const prepared=await createProductionPreparation(doc);
 const view=await executionView(doc,prepared,voice);
 return {view,readiness:await prepared.readiness(voice)};
}

async function executionView(doc:ProjectDoc,prepared:Awaited<ReturnType<typeof createProductionPreparation>>,voice?:{provider:string;voiceId:string}){
 const {reviewed,rawPacket:packet}=prepared;
 const a=doc.clipMentorAnalysis!,t=doc.timelines.find(t=>t.id===doc.activeTimelineId)!;
 const bindings=prepared.audioBindings(),sections=packet.delivery_sections??[];
 const lines=[...packet.units.flatMap(u=>u.lines),...(packet.delivery_sections??[]).map(s=>s.line)];
 const readAnchors=createSpeechAnchorReader();
 const audio=await Promise.all(lines.map(async line=>{
  try{
   const section=sections.find(s=>s.line.line_id===line.line_id);
   const match=section?(()=>{const v=deliveryAudio(doc,section);return{assetId:v.asset.id,durationSeconds:Number(section.voice.existing_audio?.durationSeconds??(v.asset.props?.generation as Record<string,unknown>|undefined)?.durationSeconds??v.frames/t.fps)};})():matchMeasuredNarration([line],doc.assets,voice,bindings)[0];
   const asset=doc.assets.find(x=>x.id===match.assetId)!;
   const registered=bindings.find(b=>b.lineId===line.line_id&&b.assetId===match.assetId&&b.text===line.narration_ms);
   const anchors=await readAnchors(asset,line.narration_ms,match.durationSeconds,t,line.caption_lines);
   return {line_id:line.line_id,status:'reusable' as const,text:line.narration_ms,...match,src:asset.src,
    asset_identity:handoffAssetsOf([asset])[0],configuration:Object.fromEntries(['provider','voiceId','speed','pitch','volume','languageBoost','sampleRate','channel','audioFormat'].flatMap(key=>{const value=(asset.props?.generation as Record<string,unknown>|undefined)?.[key]??registered?.[key]??(section?.voice as unknown as Record<string,unknown>|undefined)?.[key];return value===undefined?[]:[[key,value]];})),
    audio_sha256:asset.sourceContentHash??registered?.audioSha256??section?.voice.existing_audio?.sha256??null,
    measurement_source:asset.props?.generation?'asset_generation':section?'delivery_binding':'measured_audio_binding',
    ...(anchors?{speech_anchors:anchors}:{})};
  }catch(error){return {line_id:line.line_id,status:'missing_or_unverified' as const,reason:String(error)};}
 }));
 const units=packet.units.map(u=>{
  const registered=a.blueprint.find(x=>x.unit_id===u.unit_id)!;
  const relation=a.source_breakdown!.units.find(x=>x.unit_id===u.unit_id)!;
  return {...u,intent_zh:registered.intent_zh,placement:relation.placement??null,
   coverage:relation.coverage,original_segment_ids:relation.original_segment_ids,explanation_segment_ids:relation.explanation_segment_ids};
 });
 const value={subject:reviewed.subject,packet:{...packet,units},source:a.source,
  segments:a.source_breakdown!.segments,assets:handoffAssetsOf(doc.assets.filter(a=>a.props?.clipmentorReferenceOnly!==true)),audio,
  picture_bindings:deliveryPictureBindings(doc,sections),
  fixed_native_edits:{tool:'edit_item',args:frozenParameterEdits(doc),scope:'existing_items_only_no_timing_inference'},
  native_timeline:{id:t.id,fps:t.fps,width:t.width,height:t.height,item_ids:t.items.map(i=>i.id)},
  authority:'current_execution_facts_not_review_approval',
  history_lookup:{tool:'read_clipmentor_analysis',scope:'current_copy',note:'Read history or actual timeline only when a specific conflict requires it; never reselect an old candidate.'},
  unresolved_policy:'Prose, estimated/reference timing and unknown evidence are not executable parameters. Return located conflicts; do not invent source windows or redesign frozen decisions.',
  native_text:{renderer:NATIVE_TEXT_STYLE_VERSION,supported_props:NATIVE_TEXT_PROPS,evidence_scope:'capability_only_verify_actual_rendered_pixels'}};
 return {...value,view_digest:digestValue(value)};
}
/** Located findings plus the ORIGINAL unit context; no suggested replacement answer. */
export async function currentReviewRepair(doc:ProjectDoc){
 const receipt=doc.clipMentorAnalysis?.production_copy_review;
 if(!receipt)return {status:'receipt_missing' as const,review_approved:false};
 const subject=await copyReviewSubject(doc);
 if(receipt.content_digest!==subject.digest||receipt.analysis_revision!==subject.revision)return {status:'receipt_stale' as const,original_receipt:receipt,review_approved:false};
 const packet=await copyTeachingPacketFromDoc(doc);
 return {status:'bound' as const,subject,original_receipt:{scope:receipt.scope,protocol:receipt.protocol,verdict:receipt.verdict,analysis_revision:receipt.analysis_revision,content_digest:receipt.content_digest,reviewer_run_id:receipt.reviewer_run_id,reviewed_at:receipt.reviewed_at},review_approved:false,
  units:receipt.units.filter(u=>u.verdict!=='pass'||u.findings.length>0).map(u=>({unit_id:u.unit_id,candidate_id:u.candidate_id,
   verdict:u.verdict,findings:u.findings.map((f,index)=>({...f,finding_id:`${receipt.content_digest}:${u.unit_id}:finding:${index}`})),narration_checks:u.narration_checks,group_checks:u.group_checks,
   point_checks:structuredClone(receipt.teaching_review?.review.units.find(v=>v.unit_id===u.unit_id)?.points??[]),
   context:packet.units.find(v=>v.unit_id===u.unit_id)??null})),
  delivery_sections:packet.delivery_sections??[],delivery_checks:receipt.delivery_checks??[],
  ...(receipt.visual_criteria_checks?{visual_criteria_checks:receipt.visual_criteria_checks.filter(c=>c.answer!=='yes')}:{}),
  instruction:'Locate the original quote and group relation; retain original verdict. Missing evidence is not an instruction to invent a replacement or approve a partial group.'};
}

/** A missing stage label is a reviewer-output problem, not an instruction to rewrite passed copy. */
export function needsVisualReviewCompletion(repair:unknown){
 const r=repair as {status?:string;review_approved?:boolean;units?:unknown[];delivery_checks?:Array<{verdict?:string}>;
  visual_criteria_checks?:Array<{answer?:string;observation?:string;picture_stage?:string}>}|undefined;
 return r?.status==='bound'&&r.review_approved===false&&Array.isArray(r.units)&&r.units.length===0
  &&Array.isArray(r.delivery_checks)&&r.delivery_checks.length>0&&r.delivery_checks.every(c=>c.verdict==='pass')
  &&Array.isArray(r.visual_criteria_checks)&&r.visual_criteria_checks.length>0
  &&r.visual_criteria_checks.every(c=>c.answer==='unknown'&&c.picture_stage===''&&c.observation==='缺少该段可定位的画面判断');
}
