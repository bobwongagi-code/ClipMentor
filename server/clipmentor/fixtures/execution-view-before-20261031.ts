// Frozen execution-view reference from the pre-optimization 2026-10-31 worktree.
// Test-only oracle; do not use as a production implementation.
import {frozenParameterEdits} from '../../../src/clipmentor/execution-parameters';
import type {ProjectDoc} from '../../../src/editor/types';
import {copyTeachingPacketFromDoc} from '../../../src/clipmentor/production-gate';
import {deliverySectionsFromDoc,deliveryAudio,deliveryPictureBindings} from '../../../src/clipmentor/delivery-sections';
import {handoffAssetsOf} from '../../../shared/clipmentor-handoff';
import {matchMeasuredNarration,registeredAudioBindings,prepareProductionBlueprint,productionBlueprintReadiness} from '../production-readiness';
import {digestValue} from '../../agent-runs/store-values';

/** Current operational facts for the EXECUTOR. This must never replace the independent-review projection. */
export async function currentExecutionView(doc:ProjectDoc,voice?:{provider:string;voiceId:string}){
 const reviewed=await prepareProductionBlueprint(doc),packet=await copyTeachingPacketFromDoc(doc);
 const a=doc.clipMentorAnalysis!,t=doc.timelines.find(t=>t.id===doc.activeTimelineId)!;
 const bindings=registeredAudioBindings(doc);
 const lines=[...packet.units.flatMap(u=>u.lines),...(packet.delivery_sections??[]).map(s=>s.line)];
 const audio=lines.map(line=>{
  try{
   const section=deliverySectionsFromDoc(doc).find(s=>s.line.line_id===line.line_id);
   const match=section?(()=>{const v=deliveryAudio(doc,section);return{assetId:v.asset.id,durationSeconds:v.frames/t.fps};})():matchMeasuredNarration([line],doc.assets,voice,bindings)[0];
   const asset=doc.assets.find(x=>x.id===match.assetId)!;
   const registered=bindings.find(b=>b.lineId===line.line_id&&b.assetId===match.assetId&&b.text===line.narration_ms);
   return {line_id:line.line_id,status:'reusable' as const,text:line.narration_ms,...match,src:asset.src,
    asset_identity:handoffAssetsOf([asset])[0],configuration:Object.fromEntries(['provider','voiceId','speed','pitch','volume','languageBoost','sampleRate','channel','audioFormat'].flatMap(key=>{const value=(asset.props?.generation as Record<string,unknown>|undefined)?.[key]??registered?.[key]??(section?.voice as unknown as Record<string,unknown>|undefined)?.[key];return value===undefined?[]:[[key,value]];})),
    audio_sha256:asset.sourceContentHash??registered?.audioSha256??section?.voice.existing_audio?.sha256??null,
    measurement_source:asset.props?.generation?'asset_generation':section?'delivery_binding':'measured_audio_binding'};
  }catch(error){return {line_id:line.line_id,status:'missing_or_unverified' as const,reason:String(error)};}
 });
 const units=packet.units.map(u=>{
  const registered=a.blueprint.find(x=>x.unit_id===u.unit_id)!;
  const relation=a.source_breakdown!.units.find(x=>x.unit_id===u.unit_id)!;
  return {...u,intent_zh:registered.intent_zh,placement:relation.placement??null,
   coverage:relation.coverage,original_segment_ids:relation.original_segment_ids,explanation_segment_ids:relation.explanation_segment_ids};
 });
 const value={subject:reviewed.subject,packet:{...packet,units},source:a.source,
  segments:a.source_breakdown!.segments,assets:handoffAssetsOf(doc.assets),audio,
  picture_bindings:deliveryPictureBindings(doc),
  fixed_native_edits:{tool:'edit_item',args:frozenParameterEdits(doc),scope:'existing_items_only_no_timing_inference'},
  native_timeline:{id:t.id,fps:t.fps,width:t.width,height:t.height,item_ids:t.items.map(i=>i.id)},
  authority:'current_execution_facts_not_review_approval',
  history_lookup:{tool:'read_clipmentor_analysis',scope:'current_copy',note:'Read history or actual timeline only when a specific conflict requires it; never reselect an old candidate.'},
  unresolved_policy:'Prose, estimated/reference timing and unknown evidence are not executable parameters. Return located conflicts; do not invent source windows or redesign frozen decisions.'};
 return {...value,view_digest:digestValue(value)};
}

import type {ProductionTask} from '../production-task';
const goals={
 analysis:'完整观察原片，理解商品购买理由及结构，登记证据、重点与blueprint。区分所见、原话及推论；不能听清的留未知。不得配音或剪辑。',
 blueprint:'先确定完整学习结构与每组说服关系，再登记source_breakdown、现行马来语口播/字幕/中文及picture plan。成绩与学习过渡缺资料时明确记录原因，不静默删掉；按完整话意和动作决定看一组讲一组或其他组织，不固定四组。把卖点、怎么拍、为什么这样拍讲清，原消费者促单与达人阶段邀请分开。每组用既有unit表达原声与解释，必要条件、画面承担、回看进出和视觉继承明确。未配音仅填语义锚点，不编实测秒数；先检查最终审核投影。不得自签审核或剪辑。',
 audio:'只处理已审现行稿。先找同文、同音色现有音频；仅合成缺少的句子，保留实测声长及来源。按整组核承载，缺素材或需改稿时说明冲突，不赶读、慢放、循环或长定格凑时长。',
 edit:'按当前已审蓝图和真实音频执行，保留教学重点和必要拍法，原片/讲解强区分、字幕实底可读且无阴影。源片对象、阶段与讲解意群对应。需要定格时用save_clipmentor_source_frame，不临时编新意思。用实际合成帧自查，保存后停止，不自行导出。'
};
export async function productionAuthorTaskData(task:ProductionTask,doc:ProjectDoc){
 const goal=goals[task.stage as keyof typeof goals];if(!goal)throw new Error('production_stage_not_authoring');
 return {task:task.input.brief,stage:task.stage,goal,feedback:task.feedback??null,repairContext:task.repairContext?.repair?{repair:task.repairContext.repair,revision:task.repairContext.revision,final_feedback:task.repairContext.final_feedback??null}:task.repairContext??null,
  voice:task.input.voice??null,sourceAssetId:task.input.sourceAssetId,revision:doc.clipMentorAnalysis?.revision,
  frozenBlueprint:['audio','edit'].includes(task.stage)?await currentExecutionView(doc,task.input.voice):null,blueprintReadiness:await productionBlueprintReadiness(doc,task.input.voice),
  actor:{operator:'task_operator',executor:'builtin_api_agent',instruction:task.input.brief,identity:'local_declared_not_authenticated'}};
}
