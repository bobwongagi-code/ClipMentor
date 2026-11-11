import {outputProductionBudget} from './production-budget';
import {productionOutputsMatch} from './production-decisions';
import {digestValue} from '../agent-runs/store-values';
import {withSerializedProjectStore,getStoredEntry} from '../plugins/project-store';
import {loadOfflineStoredProject} from '../external-agent/offline-project-store';
import {copyReviewSubject,copyTeachingPacketFromDoc,checkCopyProduction} from '../../src/clipmentor/production-gate';
import {storeAgentArtifact,agentRuntimeKey} from '../../src/persist/agentRuntimeStore';
import {currentAgentSessionGeneration} from '../../src/persist/agentSessionGeneration';
import {createHash,randomUUID} from 'node:crypto';
import {runProjectMigrations} from '../../src/persist/migrations';
import {deliverySectionsFromDoc,deliveryAudio,type DeliverySection} from '../../src/clipmentor/delivery-bindings';
import {productionFeedbackAnchor} from './production-feedback';
import type {ProjectDoc} from '../../src/editor/types';
import {HANDOFF_TEMPLATE_VERSION,type HandoffPolicy} from '../../shared/clipmentor-handoff';
import {createProductionTask,latestPanelProductionTask,productionTaskStore,saveProductionControl,type EntryPreconditions,type ProductionTask} from './production-task';

export type ProductionAudience='new_contact'|'existing_partner';

/** The current production command is generated from the confirmed mode, never appended to a past repair command. */
export function continuationBrief(productName:string,audience:ProductionAudience){
 return `制作 ${productName} 的${audience==='new_contact'?'新建联':'已合作'}达人版。用户已确认含两种结尾的完整蓝图，本执行任务负责其中的 ${audience} 输出；两版共用片头、教学主体与同文配音，仅片尾不同。从当前保存蓝图的独立审核接续，不重新分析原片。原始业务要求和参照以本任务绑定的 doneCriteria 为准；历史修订任务不作为本轮执行指令。审核指出的问题由策划 Agent 按现有证据定向修订，其他已通过内容保留；不虚构补证，不自签审核。通过后在当前阶段及预算内准备配音、剪辑、导出和复核。片尾使用独立时间线实例，片头和教学主体的实例在片尾起点前闭合，便于直接复用实际剪辑。`;
}

/** Exact migration of the previous concatenating template, not a license to replace user-authored instructions. */
export async function upgradeContinuationBrief(task:ProductionTask){
 const approval=task.blueprintApproval,audience=task.input.panelDelivery?.audience;
 if(!approval||!audience||task.input.brief===continuationBrief(task.input.product.name,audience))return false;
 const source=await productionTaskStore.load(approval.sourceProjectId,approval.sourceTaskId);
 const legacy=source.input.brief+'\n用户已确认含两种结尾的完整蓝图。本执行任务负责其中的'+audience+'输出；两版共用片头、教学主体与同文配音，仅片尾不同。从独立审核接续，不重新分析原片。片尾使用独立时间线实例，片头和教学主体的实例在片尾起点前闭合，便于直接复用实际剪辑。';
 if(task.input.brief!==legacy)return false;
 task.input.brief=continuationBrief(task.input.product.name,audience);return true;
}

/** Internal output scope only; the human confirms the complete two-ending blueprint once. */
export function selectProductionAudience(doc:ProjectDoc,audience:ProductionAudience){
 if(!['new_contact','existing_partner'].includes(audience))throw Error('Invalid production output');
 const sections=deliverySectionsFromDoc(doc);
 if(!sections.some(s=>s.kind==='performance_opening')||!sections.some(s=>s.kind==='creator_invitation'&&s.section_id===audience))
  throw Error('这个版本的片头或结尾尚未齐备');
 if(doc.timelines.some(t=>t.items.length))throw Error('工程已有剪辑，请从成片页修改');
 const selected=structuredClone(doc);
 for(const unit of selected.clipMentorAnalysis!.blueprint){
  const review=(unit as unknown as {internal_review?:Record<string,unknown>}).internal_review;
  const plan=review?.[String(review.current_picture_plan)] as {delivery_sections?:DeliverySection[]}|undefined;
  if(Array.isArray(plan?.delivery_sections))plan.delivery_sections=plan.delivery_sections.filter(s=>s.kind==='performance_opening'||s.section_id===audience);
 }
 selected.clipMentorAnalysis!.revision++;
 return selected;
}

/** This is called only by a user's confirmation. Old effects and failed receipts remain on the source task. */
export async function createBlueprintContinuation(parent:ProductionTask,source:{doc:ProjectDoc;revision:string},audience:ProductionAudience,
 requirements:HandoffPolicy|null,origin:string){
 const projectId='cm-output-'+digestValue({project:parent.projectId,task:parent.taskId,revision:source.revision,audience,
  requirements:requirements?.digest??null}).slice(0,40);
 const existing=await latestPanelProductionTask(projectId);
 if(existing){
  if(existing.blueprintApproval?.sourceTaskId!==parent.taskId||existing.blueprintApproval.sourceRevision!==source.revision)
   throw Error('制作记录不匹配，请刷新');
  return existing;
 }
 const doc=selectProductionAudience(source.doc,audience);
 const remainingModels=parent.input.budget.model-parent.attempts.model;
 if(remainingModels<1)throw Error('本次制作已达到处理上限');
 const selectedRequirements=requirements?structuredClone(requirements):undefined;
 if(selectedRequirements){
  const ids=new Set(deliverySectionsFromDoc(doc).map(s=>s.section_id));
  selectedRequirements.brief.projectId=projectId;
  selectedRequirements.brief.doneCriteria=selectedRequirements.brief.doneCriteria.filter(c=>typeof c==='string'||c.layout==='native_composition'||ids.has(c.sectionId));
  selectedRequirements.digest=digestValue({templateVersion:HANDOFF_TEMPLATE_VERSION,brief:selectedRequirements.brief,assetBindings:selectedRequirements.assetBindings});
 }
 await withSerializedProjectStore(async store=>{
  const old=await store.readEntry('project:'+projectId);
  if(old.found&&digestValue(old.value)!==digestValue(doc))throw Error('制作副本已有变化，请刷新');
  if(!old.found)await store.writeEntry('project:'+projectId,doc);
  const index=await store.readEntry('projects');
  const rows=Array.isArray(index.value)?index.value:[];
  if(!rows.some(p=>p?.id===projectId))await store.writeEntry('projects',[...rows,{id:projectId,
   name:parent.input.product.name+' · '+(audience==='new_contact'?'新建联':'已合作'),updatedAt:Date.now()}]);
 });
 const saved=await loadOfflineStoredProject(projectId);
 if(!saved)throw Error('制作副本未保存');
 const approval={sourceProjectId:parent.projectId,sourceTaskId:parent.taskId,sourceRevision:source.revision,
  digest:(await copyReviewSubject(saved.doc)).digest,requirementsDigest:digestValue(selectedRequirements?.brief.doneCriteria??[]),confirmedAt:Date.now(),...(selectedRequirements?{requirements:selectedRequirements}:{})};
 const task=await createProductionTask({...parent.input,projectId,
  author:{...parent.input.author,origin},reviewer:{...parent.input.reviewer,origin},
  brief:continuationBrief(parent.input.product.name,audience),
  panelDelivery:{...parent.input.panelDelivery!,audience},
  budget:outputProductionBudget(parent.input.budget,remainingModels),
 },{...productionTaskStore,async save(task){
  // Publish a complete, non-runnable continuation in the first durable checkpoint.
  // Restart or duplicate confirmation can then reuse it before the parent links both outputs.
  task.stage='copy_review';task.status='awaiting_blueprint';task.projectRevision=saved.revision;
  task.completed.blueprint={at:Date.now(),artifact:{revision:saved.revision,sourceRevision:source.revision}};
  task.blueprintApproval=approval;
  await productionTaskStore.save(task);
 }});
 return task;
}

/** Persist both outputs before dispatch. A duplicate click or restart reuses the same children. */
export async function createBlueprintContinuations(parent:ProductionTask,source:{doc:ProjectDoc;revision:string},requirements:HandoffPolicy|null,origin:string,guards?:EntryPreconditions){
 // Validate BOTH scopes before creating either output.
 selectProductionAudience(source.doc,'existing_partner');selectProductionAudience(source.doc,'new_contact');
 const first=await createBlueprintContinuation(parent,source,'existing_partner',requirements,origin);
 const second=await createBlueprintContinuation(parent,source,'new_contact',requirements,origin);
 if(!second.sharedProduction){
  if(second.status!=='awaiting_blueprint'||second.completed.copy_review)throw Error('Output already started independently');
  second.sharedProduction={projectId:first.projectId,taskId:first.taskId};
  await productionTaskStore.save(second);
 }
 const next=structuredClone(parent);
 next.productionChildren=[first,second].map(task=>({projectId:task.projectId,taskId:task.taskId,audience:task.input.panelDelivery!.audience!}));
 delete next.productionChild;
 if(guards)await saveProductionControl(parent,next,productionTaskStore,guards);
 else await productionTaskStore.save(next);
 delete parent.productionChild;
 Object.assign(parent,next);
 return queueBlueprintContinuations(parent);
}

const outputReleaseTurns=new Map<string,Promise<void>>();
/** One local host owns a batch release at a time, including the fresh read.
 * The next caller re-reads after this one finishes instead of saving old children
 * over a worker's newer checkpoint. Durable task state remains authoritative. */
export async function queueBlueprintContinuations(parent:ProductionTask){
 const key=`${parent.projectId}:${parent.taskId}`,previous=outputReleaseTurns.get(key);
 let release!:()=>void;const turn=new Promise<void>(resolve=>{release=resolve;});outputReleaseTurns.set(key,turn);
 await previous;
 try{return await queueConfirmedOutputs(parent);}
 finally{release();if(outputReleaseTurns.get(key)===turn)outputReleaseTurns.delete(key);}
}

/** Recover the narrow gap between persisting a confirmed batch and queueing its children. */
async function queueConfirmedOutputs(parent:ProductionTask){
 const children=await Promise.all((parent.productionChildren??[]).map(entry=>productionTaskStore.load(entry.projectId,entry.taskId)));
 if(!productionOutputsMatch(parent,children))throw Error('production_outputs_binding_invalid');
 for(const child of children)if(child.status==='awaiting_blueprint'&&child.stage==='copy_review'&&!child.completed.copy_review){
  child.status='queued';await productionTaskStore.save(child);
 }
 return children;
}

/** Hash actual common timeline inputs, including shared assets, rather than just blueprint text. */
export function commonProductionDigest(doc:ProjectDoc,endFrame:number){
 const timeline=doc.timelines.find(t=>t.id===doc.activeTimelineId);
 if(!timeline||!Number.isSafeInteger(endFrame)||endFrame<=0)throw Error('shared_body_boundary_missing');
 const items=timeline.items.filter(i=>i.startFrame<endFrame);
 if(!items.length||items.some(i=>i.startFrame+i.durationInFrames>endFrame))throw Error('shared_body_item_crosses_ending');
 const refs=new Set(items.map(i=>i.sourceAssetId).filter(Boolean));
 return digestValue({timeline:{...timeline,selectedId:null,selectedIds:[],items},
  assets:doc.assets.filter(a=>refs.has(a.id))});
}

export function assertSharedProduction(task:ProductionTask,doc:ProjectDoc){
 const shared=task.sharedProduction;
 if(shared?.prepared&&commonProductionDigest(doc,shared.endFrame!)!==shared.digest)throw Error('shared_body_changed');
}

/** Reuse actual saved common editing and audio, while the second ending keeps its own formal review. */
export async function sharedProductionDocument(first:ProjectDoc,next:ProjectDoc){
 const [a,b]=await Promise.all([copyTeachingPacketFromDoc(first),copyTeachingPacketFromDoc(next)]);
 if(digestValue({...a,delivery_sections:[]})!==digestValue({...b,delivery_sections:[]})
  ||digestValue(first.clipMentorAnalysis!.source)!==digestValue(next.clipMentorAnalysis!.source))throw Error('shared_body_blueprint_changed');
 const opening=(packet:typeof a)=>packet.delivery_sections?.find(s=>s.kind==='performance_opening');
 if(digestValue(opening(a))!==digestValue(opening(b)))throw Error('shared_opening_blueprint_changed');
 const ending=deliverySectionsFromDoc(first).find(s=>s.kind==='creator_invitation');
 if(!ending)throw Error('shared_ending_missing');
 const timeline=first.timelines.find(t=>t.id===first.activeTimelineId);
 const audio=deliveryAudio(first,ending).asset;
 const slots=timeline?.items.filter(i=>i.kind==='audio'&&i.sourceAssetId===audio.id)??[];
 if(!timeline||slots.length!==1||timeline.transitions?.length||timeline.captions)throw Error('shared_ending_boundary_ambiguous');
 const endFrame=slots[0].startFrame;
 commonProductionDigest(first,endFrame);
 const doc=structuredClone(next);
 for(const asset of first.assets){
  const old=doc.assets.find(a=>a.id===asset.id);
  if(old&&digestValue(old)!==digestValue(asset))throw Error('shared_asset_changed:'+asset.id);
  if(!old)doc.assets.push(structuredClone(asset));
 }
 if(doc.activeTimelineId!==first.activeTimelineId)throw Error('shared_timeline_mismatch');
 const index=doc.timelines.findIndex(t=>t.id===doc.activeTimelineId);
 doc.timelines[index]={...structuredClone(timeline),items:structuredClone(timeline.items.filter(i=>i.startFrame<endFrame)),selectedId:null,selectedIds:[]};
 const digest=commonProductionDigest(doc,endFrame);
 if(digest!==commonProductionDigest(first,endFrame))throw Error('shared_body_copy_mismatch');
 return {doc,endFrame,digest};
}

/** A waiting, untouched variant follows the producer's current common plan;
 * its own previously chosen ending is retained byte-for-byte. This grants no
 * review permission. The caller archives the old waiting document before save. */
export async function alignUnstartedSharedBlueprint(first:ProjectDoc,next:ProjectDoc){
 if(next.timelines.some(t=>t.items.length)||digestValue(first.clipMentorAnalysis?.source)!==digestValue(next.clipMentorAnalysis?.source))
  throw Error('shared_rebase_requires_untouched_same_source');
 const own=deliverySectionsFromDoc(next).filter(s=>s.kind==='creator_invitation');
 if(own.length!==1||!first.clipMentorAnalysis)throw Error('shared_rebase_ending_missing');
 const doc=structuredClone(next),analysis=structuredClone(first.clipMentorAnalysis);
 delete analysis.production_copy_review;
 let replacements=0;
 for(const unit of analysis.blueprint){
  const ir=(unit as unknown as {internal_review?:Record<string,unknown>}).internal_review;
  const plan=ir?.[String(ir.current_picture_plan)] as {delivery_sections?:DeliverySection[]}|undefined;
  if(Array.isArray(plan?.delivery_sections))plan.delivery_sections=plan.delivery_sections.flatMap((s:DeliverySection)=>s.kind==='creator_invitation'
   ?(++replacements===1?[structuredClone(own[0])]:[]):[s]);
 }
 if(replacements!==1)throw Error('shared_rebase_ending_owner_ambiguous');
 for(const id of own[0].evidence_ids){
  const original=next.clipMentorAnalysis?.evidence.find(e=>e.evidence_id===id),current=analysis.evidence.find(e=>e.evidence_id===id);
  if(!original||current&&digestValue(current)!==digestValue(original))throw Error('shared_rebase_ending_fact_conflict');
  if(!current)analysis.evidence.push(structuredClone(original));
 }
 analysis.revision=Math.max(analysis.revision,next.clipMentorAnalysis?.revision??0)+1;doc.clipMentorAnalysis=analysis;
 for(const asset of first.assets){const old=doc.assets.find(a=>a.id===asset.id);
  if(old&&digestValue(old)!==digestValue(asset))throw Error('shared_asset_changed:'+asset.id);
  if(!old)doc.assets.push(structuredClone(asset));
 }
 const [a,b]=await Promise.all([copyTeachingPacketFromDoc(first),copyTeachingPacketFromDoc(doc)]);
 if(digestValue({...a,delivery_sections:[]})!==digestValue({...b,delivery_sections:[]})
  ||digestValue(a.delivery_sections?.find(s=>s.kind==='performance_opening'))!==digestValue(b.delivery_sections?.find(s=>s.kind==='performance_opening'))
  ||digestValue(deliverySectionsFromDoc(doc).filter(s=>s.kind==='creator_invitation'))!==digestValue(own))throw Error('shared_rebase_not_exact');
 return doc;
}

interface SharedPreparation {
 version:1;producer_project:string;producer_task:string;producer_revision:string;producer_digest:string;
 previous_revision:string;previous_digest:string;approval_digest:string;prepared_digest:string;
 common_digest:string;end_frame:number;rebased:boolean;
}
function savedSharedPreparation(task:ProductionTask):SharedPreparation|undefined{
 const value=task.completed.blueprint?.artifact.shared_preparation as SharedPreparation|undefined;
 if(value===undefined)return;
 if(!value||value.version!==1||!Number.isSafeInteger(value.end_frame)||value.end_frame<=0
  ||typeof value.rebased!=='boolean'
  ||[value.producer_project,value.producer_task,value.producer_revision,value.previous_revision,value.approval_digest].some(v=>typeof v!=='string'||!v)
  ||[value.producer_digest,value.previous_digest,value.prepared_digest,value.common_digest].some(v=>typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v)))throw Error('shared_preparation_invalid');
 return value;
}
/** Merge only the shared marker into a current producer checkpoint. An acceptance
 * arriving during preparation must not be overwritten by an older task clone. */
async function markSharedProducer(first:ProductionTask,source:{doc:ProjectDoc;revision:string},target:ProductionTask,endFrame:number,digest:string,check:()=>void){
 for(let attempt=0;attempt<3;attempt++){
  check();
  const generation=await currentAgentSessionGeneration(first.projectId),key=agentRuntimeKey(first.projectId,generation);
  const runtime=await getStoredEntry(key),project=await getStoredEntry('project:'+first.projectId);
  const current=await productionTaskStore.load(first.projectId,first.taskId);check();
  const doc=project.found?runProjectMigrations(project.value)?.doc:null;
  if(!runtime.found||!doc||digestValue(doc)!==digestValue(source.doc)||current.projectRevision!==source.revision
   ||!['awaiting_review','completed'].includes(current.status)||!current.completed.self_check
   ||digestValue(current.completed.export)!==digestValue(first.completed.export))throw Error('shared_producer_changed_during_preparation');
  if(current.sharedProduction){
   if(current.sharedProduction.prepared&&current.sharedProduction.projectId===target.projectId&&current.sharedProduction.taskId===target.taskId
    &&current.sharedProduction.endFrame===endFrame&&current.sharedProduction.digest===digest)return current;
   throw Error('shared_producer_binding_changed');
  }
  current.sharedProduction={projectId:target.projectId,taskId:target.taskId,prepared:true,endFrame,digest};
  try{await productionTaskStore.save(current,[{key,digest:digestValue(runtime.value)},{key:'project:'+first.projectId,digest:digestValue(project.value)}]);check();return current;}
  catch(error){if(!(error instanceof Error)||!error.message.includes('agent_runtime_precondition_changed'))throw error;}
 }
 throw Error('shared_producer_checkpoint_contended');
}

/** Returns false while the first output is unfinished; no model or media request is made. */
export async function prepareSharedProduction(task:ProductionTask,signal?:AbortSignal){
 const check=()=>signal?.throwIfAborted();check();
 const upgraded=await upgradeContinuationBrief(task);check();
 if(upgraded)await productionTaskStore.save(task);check();
 const shared=task.sharedProduction;if(!shared)return true;
 if(shared.prepared){const saved=await loadOfflineStoredProject(task.projectId);if(!saved)throw Error('shared_output_missing');assertSharedProduction(task,saved.doc);return true;}
 const first=await productionTaskStore.load(shared.projectId,shared.taskId);check();
 if(!['awaiting_review','completed'].includes(first.status)||!first.completed.self_check)return false;
 if(task.stage!=='copy_review'||task.completed.copy_review)throw Error('shared_output_already_started');
 const [source,next]=await Promise.all([loadOfflineStoredProject(first.projectId),loadOfflineStoredProject(task.projectId)]);check();
 if(!source||!next)throw Error('shared_output_missing');
 await productionFeedbackAnchor(first,source.doc);check();
 let prepared:Awaited<ReturnType<typeof sharedProductionDocument>>,rebased=false;
 const prior=savedSharedPreparation(task);
 if(prior&&(prior.producer_project!==first.projectId||prior.producer_task!==first.taskId||prior.producer_revision!==source.revision
  ||prior.producer_digest!==digestValue(source.doc)||prior.previous_revision!==task.projectRevision
  ||prior.approval_digest!==task.blueprintApproval?.digest))throw Error('shared_preparation_stale');
 const committed=!!prior&&digestValue(next.doc)===prior.prepared_digest;
 if(prior&&!committed&&digestValue(next.doc)!==prior.previous_digest)throw Error('shared_output_changed_during_preparation');
 if(committed){
  prepared=await sharedProductionDocument(source.doc,next.doc);rebased=prior!.rebased;
  if(digestValue(prepared.doc)!==prior!.prepared_digest||prepared.digest!==prior!.common_digest||prepared.endFrame!==prior!.end_frame)throw Error('shared_preparation_result_mismatch');
 }else{
  try{prepared=await sharedProductionDocument(source.doc,next.doc);}catch(error){
   check();
   if(!(error instanceof Error)||!['shared_body_blueprint_changed','shared_opening_blueprint_changed'].includes(error.message))throw error;
   if(!task.input.humanBlueprintReview||!first.input.humanBlueprintReview||(task.status!=='queued'&&!(prior&&task.status==='blocked'))||Object.values(task.attempts).some(n=>n!==0)||Object.keys(task.effects).length
    ||next.revision!==task.projectRevision||!(await checkCopyProduction(source.doc,'clipmentor')).allowed)throw Error('shared_rebase_not_authorized_for_started_or_unreviewed_output');
   const current=await copyReviewSubject(source.doc);
   if((first.completed.edit?.artifact.executionReport as {blueprint?:{digest?:string}}|undefined)?.blueprint?.digest!==current.digest)throw Error('shared_rebase_producer_execution_not_bound');
   const aligned=await alignUnstartedSharedBlueprint(source.doc,next.doc);check();prepared=await sharedProductionDocument(source.doc,aligned);
   const body=JSON.stringify({type:'clipmentor-shared-blueprint-rebase/v1',sourceProjectId:first.projectId,sourceTaskId:first.taskId,
    sourceRevision:source.revision,sourceSubject:current,previousRevision:next.revision,previousProject:next.doc});
   check();if(!await storeAgentArtifact({version:1,artifactId:'p_'+randomUUID().replaceAll('-','').slice(0,18),projectId:task.projectId,runId:task.taskId,
    kind:'checkpoint-source',toolName:'clipmentor-shared-blueprint-rebase',body,bodySha256:createHash('sha256').update(body).digest('hex'),
    originalBytes:Buffer.byteLength(body),originalChars:body.length,createdAt:Date.now(),redacted:false,binaryOmitted:false}))throw Error('shared_rebase_archive_failed');
   rebased=true;
  }
  check();
  if(!rebased&&(await copyReviewSubject(prepared.doc)).digest!==task.blueprintApproval?.digest)throw Error('shared_confirmed_blueprint_changed');
 }
 const proposal:SharedPreparation=prior??{version:1,producer_project:first.projectId,producer_task:first.taskId,producer_revision:source.revision,
  producer_digest:digestValue(source.doc),previous_revision:task.projectRevision!,previous_digest:digestValue(next.doc),approval_digest:task.blueprintApproval!.digest,
  prepared_digest:digestValue(prepared.doc),common_digest:prepared.digest,end_frame:prepared.endFrame,rebased};
 if(proposal.prepared_digest!==digestValue(prepared.doc)||proposal.common_digest!==prepared.digest||proposal.end_frame!==prepared.endFrame)throw Error('shared_preparation_stale');
 if(!prior){
  if(!task.completed.blueprint)throw Error('shared_preparation_blueprint_missing');
  task.completed.blueprint.artifact.shared_preparation=proposal;
  // Save the exact intended bytes before the project commit. This is a local
  // continuation permit, never an independent review or a second timeline.
  check();await productionTaskStore.save(task);check();
 }
 if(!committed)await withSerializedProjectStore(async store=>{
  check();const current=await store.readEntry('project:'+task.projectId),producer=await store.readEntry('project:'+first.projectId);check();
  const producerDoc=producer.found?runProjectMigrations(producer.value)?.doc:null,currentDoc=current.found?runProjectMigrations(current.value)?.doc:null;
  if(!producerDoc||digestValue(producerDoc)!==digestValue(source.doc))throw Error('shared_producer_changed_during_preparation');
  if(!currentDoc||digestValue(currentDoc)!==digestValue(next.doc))throw Error('shared_output_changed_during_preparation');
  await store.writeEntry('project:'+task.projectId,prepared.doc);
 });
 check();
 const saved=await loadOfflineStoredProject(task.projectId);if(!saved||digestValue(saved.doc)!==proposal.prepared_digest)throw Error('shared_preparation_result_mismatch');check();
 const currentProducer=await markSharedProducer(first,source,task,prepared.endFrame,prepared.digest,check);check();
 task.projectRevision=saved.revision;task.sharedProduction={...shared,prepared:true,endFrame:prepared.endFrame,digest:prepared.digest};
 if(rebased)task.completed.blueprint={at:Date.now(),artifact:{revision:saved.revision,sharedFromProject:first.projectId,
  sharedFromTask:first.taskId,sharedSourceRevision:source.revision,ownEndingPreserved:true,formalReviewRequired:true,shared_preparation:proposal}};
 task.input.budget.model=Math.min(task.input.budget.model,Math.max(0,currentProducer.input.budget.model-currentProducer.attempts.model));
 task.input.budget.tts=Math.min(task.input.budget.tts,Math.max(0,currentProducer.input.budget.tts-currentProducer.attempts.tts));
 if(task.input.budget.routine){task.input.budget.routine.model=Math.min(task.input.budget.routine.model,task.input.budget.model);task.input.budget.routine.tts=Math.min(task.input.budget.routine.tts,task.input.budget.tts);}
 await productionTaskStore.save(task);return true;
}
