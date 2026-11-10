import {currentExecutionView} from './execution-view';
import { runProjectMigrations } from '../../src/persist/migrations';
import { revisionOf } from '../../src/agent/external-edit-session';
import {randomUUID,createHash} from 'node:crypto';
import {HANDOFF_PREFIX,HANDOFF_RUN_PREFIX,HANDOFF_HISTORY_PREFIX,HANDOFF_TEMPLATE_VERSION,parseHandoffBrief,parseHandoffPolicy,handoffRecord,handoffToolAccess,handoffControlText,handoffAssetsOf,type HandoffPolicy,type HandoffRunBinding} from '../../shared/clipmentor-handoff';
import {getStoredEntry,withSerializedProjectStore} from '../plugins/project-store';
import {loadOfflineStoredProject} from '../external-agent/offline-project-store';
import {checkSourceBreakdown} from '../../src/clipmentor/source-breakdown';
import {createProductionPreparation} from './production-readiness';
import {assertVisualCriteriaPlan,boundVisualCriteria,visualCriteriaPlanApproved} from './visual-done-criteria';
import {storeAgentArtifact,loadAgentArtifact,loadAgentRuntimeSidecar} from '../../src/persist/agentRuntimeStore';
import {digestValue} from '../agent-runs/store-values';
import {getRun,recoverServerRun,flushRunPersistence,type ServerRun} from '../agent-runs/store';
import type {ServerRunInput} from '../agent-runs/executor';
import type {ProjectDoc} from '../../src/editor/types';

export const handoffKey=(id:string)=>HANDOFF_PREFIX+id;
export const handoffRunKey=(project:string,run:string)=>`${HANDOFF_RUN_PREFIX}${project}:${run}`;
export function handoffAssets(doc:ProjectDoc,ids?:readonly string[]) { return handoffAssetsOf(doc.assets,ids); }
export async function assertHandoffSubject(policy:HandoffPolicy,doc:ProjectDoc):Promise<void>{
 if(!doc.timelines.some(t=>t.id===policy.brief.timelineId)||doc.activeTimelineId!==policy.brief.timelineId)throw new Error('handoff_timeline_missing');
 const ids=policy.assetBindings.map(a=>String(a.id));
 if(digestValue(handoffAssets(doc,ids))!==digestValue(policy.assetBindings))throw new Error('handoff_assets_changed');
 const visual=boundVisualCriteria(policy);
 if(policy.brief.phase==='execution'){
  if(!doc.clipMentorAnalysis||checkSourceBreakdown(doc).status!=='structurally_ready')throw new Error('handoff_blueprint_incomplete');
  const prepared=await createProductionPreparation(doc),packet=prepared.rawPacket;
  assertVisualCriteriaPlan(visual,packet.delivery_sections,packet.units.map(u=>u.unit_id),doc.activeTimelineId);
  if(!packet.units.length||packet.units.some(u=>!u.picture_plan?.execution_plan))throw new Error('handoff_picture_plan_required');
  const subject=prepared.reviewed.subject,b=policy.brief.blueprint;
  if(!b||b.revision!==subject.revision||b.digest!==subject.digest)throw new Error('handoff_blueprint_changed');
 }
}
function assertVisualApproval(policy:HandoffPolicy,doc:ProjectDoc){
 if(policy.brief.phase!=='execution')return;
 const criteria=boundVisualCriteria(policy),receipt=doc.clipMentorAnalysis?.production_copy_review;
 if(criteria&&!visualCriteriaPlanApproved(criteria,receipt))
  throw Error('handoff_visual_criteria_review_missing_or_stale');
}
export async function readHandoffPolicy(projectId:string):Promise<HandoffPolicy|null>{
 const entry=await getStoredEntry(handoffKey(projectId));if(!entry.found)return null;const p=parseHandoffPolicy(entry.value);
 if(p.brief.projectId!==projectId||p.digest!==digestValue({templateVersion:HANDOFF_TEMPLATE_VERSION,brief:p.brief,assetBindings:p.assetBindings}))throw new Error('handoff_policy_corrupt');return p;
}
/** Authenticated operator preparation on the existing admission endpoint; never a model tool. */
export async function registerHandoff(body:Record<string,unknown>){
 const brief=parseHandoffBrief(body.brief);
 if(body.projectId!==brief.projectId)throw new Error('handoff_project_mismatch');
 const snapshot=await loadOfflineStoredProject(brief.projectId);
 if(!snapshot||snapshot.revision!==body.expectedProjectRevision)throw new Error('handoff_project_revision_changed');
 const old=await readHandoffPolicy(brief.projectId);
 if((old?.digest??null)!==(body.previousDigest??null))throw new Error('handoff_previous_binding_mismatch');
 if(old){
  for(const id of old.runIds){const run=getRun(id)??await recoverServerRun(brief.projectId,id);
   const archived=await getStoredEntry(handoffRunKey(brief.projectId,id));
   const terminal=handoffRecord(archived.value)&&archived.value.policyDigest===old.digest&&typeof archived.value.terminalStatus==='string'&&['completed','failed','cancelled','awaiting-user'].includes(archived.value.terminalStatus);
   if(run?!['completed','failed','cancelled','awaiting-user'].includes(run.status):!terminal)throw new Error('handoff_active_or_unknown_run');}
  if((old.runIds.length||old.brief.mode!==brief.mode||old.brief.planner!==brief.planner)&&old.brief.briefId===brief.briefId)throw new Error('handoff_used_brief_requires_new_id');
  if(!old.runIds.length&&old.brief.briefId===brief.briefId&&brief.revision<=old.brief.revision)throw new Error('handoff_revision_must_increase');
 }
 const assetBindings=handoffAssets(snapshot.doc);
 if(!assetBindings.length)throw new Error('handoff_assets_required');
 const digest=digestValue({templateVersion:HANDOFF_TEMPLATE_VERSION,brief,assetBindings});
 const next:HandoffPolicy={version:1,brief,digest,assetBindings,runIds:[],startedAt:null,modelTurns:0,toolCalls:0,paidCalls:{},callIds:[]};
 await assertHandoffSubject(next,snapshot.doc);
 await withSerializedProjectStore(async store=>{
  const current=await store.readEntry(handoffKey(brief.projectId));
  if(digestValue(current.found?current.value:null)!==digestValue(old))throw new Error('handoff_registration_conflict');
  const project=await store.readEntry(`project:${brief.projectId}`);
  const normalized=project.found?runProjectMigrations(project.value)?.doc:null;
  if(!normalized||revisionOf(normalized)!==snapshot.revision)throw new Error('handoff_project_revision_changed');
  if(old)await store.writeEntry(`${HANDOFF_HISTORY_PREFIX}${brief.projectId}:${old.digest}`,old);
  await store.writeEntry(handoffKey(brief.projectId),next);
 });
 return {registered:true,digest,briefId:brief.briefId,revision:brief.revision,mode:brief.mode,phase:brief.phase,productionApproved:false};
}
export interface PreparedHandoff {policy:HandoffPolicy;controlText:string;taskDetails:string;ignoredInstructions:string;ignoredHistory:unknown[];blueprint:unknown;messages:ServerRunInput['messages'];instructions:string}
export async function prepareHandoff(projectId:string,messages:readonly {role:string;content:string}[],instructions?:string):Promise<PreparedHandoff|null>{
 const policy=await readHandoffPolicy(projectId);if(!policy)return null;
 if(policy.brief.mode==='collaborative'&&policy.brief.phase==='planning')throw new Error('handoff_waiting_for_external_planner');
 if(!messages.length||messages.at(-1)?.role!=='user')throw new Error('handoff_current_user_input_required');
 // Client system text is retained for audit, never used as execution authority.
 if(policy.brief.budget.maxModelTurns===0)throw new Error('handoff_model_budget_exhausted');
 const snapshot=await loadOfflineStoredProject(projectId);if(!snapshot)throw new Error('handoff_project_missing');
 await assertHandoffSubject(policy,snapshot.doc);
 assertVisualApproval(policy,snapshot.doc);
 const controlText=handoffControlText(policy.brief,policy.digest),taskDetails=messages.at(-1)!.content;
 const blueprint=policy.brief.phase==='execution'?await currentExecutionView(snapshot.doc):null;
 const data={kind:'task_data_not_control',objective:policy.brief.objective,doneCriteria:policy.brief.doneCriteria,taskDetails,
  blueprint,sourceAssets:policy.assetBindings};
 const content=JSON.stringify(data);if(Buffer.byteLength(content)>512*1024)throw new Error('handoff_payload_too_large');
 return {policy,controlText,taskDetails,ignoredInstructions:instructions??'',ignoredHistory:messages.slice(0,-1),blueprint,messages:[{role:'user',content}],instructions:controlText};
}
export async function saveHandoffRun(run:ServerRun,prepared:PreparedHandoff,persist=withSerializedProjectStore):Promise<void>{
 const body=JSON.stringify({version:1,templateVersion:HANDOFF_TEMPLATE_VERSION,brief:prepared.policy.brief,bindingDigest:prepared.policy.digest,
  generatedControl:{text:prepared.controlText,digest:digestValue(prepared.controlText)},
  plannerDetails:{text:prepared.taskDetails,digest:digestValue(prepared.taskDetails),authority:'task_data_only'},
  ignoredClientInstructions:{text:prepared.ignoredInstructions,digest:digestValue(prepared.ignoredInstructions),authority:'none_not_sent'},
  ignoredClientHistory:{messages:prepared.ignoredHistory,digest:digestValue(prepared.ignoredHistory),authority:'none_not_sent'},
  sent:{instructions:prepared.instructions,messages:prepared.messages,digest:digestValue({instructions:prepared.instructions,messages:prepared.messages})}});
 // Publication spans immutable payload, policy membership and a separate binding.
 // Reuse only the exact original payload after any interrupted write; never
 // restamp a changed request under an old run identity or consume another slot.
 const sidecar=await loadAgentRuntimeSidecar(run.projectId);
 const prior=sidecar.artifacts.filter(a=>a.runId===run.id&&a.toolName==='clipmentor-handoff');
 let artifactId:string|undefined,payloadCreatedAt:number|undefined;
 for(const index of prior){
  const artifact=await loadAgentArtifact(run.projectId,index.artifactId);
  if(!artifact||artifact.body!==body)throw Error('handoff_run_already_bound');
  if(!artifactId){artifactId=artifact.artifactId;payloadCreatedAt=artifact.createdAt;}
 }
 if(!artifactId){
  artifactId=`h_${randomUUID().replaceAll('-','').slice(0,18)}`;
  payloadCreatedAt=Date.now();
  const saved=await storeAgentArtifact({version:1,artifactId,projectId:run.projectId,runId:run.id,kind:'checkpoint-source',toolName:'clipmentor-handoff',body,
   bodySha256:digestText(body),originalBytes:Buffer.byteLength(body),originalChars:body.length,createdAt:payloadCreatedAt,redacted:false,binaryOmitted:false});
  if(!saved)throw new Error('handoff_payload_not_saved');
 }
 const binding:HandoffRunBinding={version:1,projectId:run.projectId,runId:run.id,policyDigest:prepared.policy.digest,templateVersion:HANDOFF_TEMPLATE_VERSION,payloadArtifactId:artifactId};
 await persist(async store=>{
  const entry=await store.readEntry(handoffKey(run.projectId));const current=parseHandoffPolicy(entry.value);
  if(current.digest!==binding.policyDigest)throw new Error('handoff_binding_changed');
  const key=handoffRunKey(run.projectId,run.id),existing=await store.readEntry(key);
  if(existing.found&&digestValue(existing.value)!==digestValue(binding))throw new Error('handoff_run_already_bound');
  // Reserve membership first so even a failed binding write keeps the run
  // visible to replacement/deadline checks. A retry fills only the missing side.
  if(!current.runIds.includes(run.id)||current.startedAt===null){
   if(!current.runIds.includes(run.id))current.runIds.push(run.id);
   current.startedAt??=payloadCreatedAt!;
   await store.writeEntry(handoffKey(run.projectId),current);
  }
  if(!existing.found)await store.writeEntry(key,binding);
 });
 await flushRunPersistence(run);
}
function digestText(text:string):string{return createHash('sha256').update(text).digest('hex');}
export async function assertRunHandoff(run:ServerRun):Promise<HandoffPolicy|null>{
 const policy=await readHandoffPolicy(run.projectId);if(!policy)return null;
 const entry=await getStoredEntry(handoffRunKey(run.projectId,run.id));const v=entry.value;
 if(!policy.runIds.includes(run.id)||!handoffRecord(v)||v.version!==1||v.runId!==run.id||v.projectId!==run.projectId||v.policyDigest!==policy.digest||v.templateVersion!==HANDOFF_TEMPLATE_VERSION)throw new Error('handoff_run_binding_required');
 const snapshot=await loadOfflineStoredProject(run.projectId);if(!snapshot)throw new Error('handoff_project_missing');
 await assertHandoffSubject(policy,snapshot.doc);
 assertVisualApproval(policy,snapshot.doc);
 const artifact=await loadAgentArtifact(run.projectId,String(v.payloadArtifactId));if(!artifact)throw new Error('handoff_payload_missing');
 if(policy.startedAt===null||Date.now()>=policy.startedAt+policy.brief.budget.maxElapsedMs)throw new Error('handoff_deadline_exceeded');
 return policy;
}
export async function reserveHandoff(run:ServerRun,kind:'model'|'tool',callId?:string,name?:string,args:Record<string,unknown>={}):Promise<void>{
 const policy=await assertRunHandoff(run);if(!policy)return;
 const access=kind==='tool'?handoffToolAccess(policy.brief,name!,args,true):null;
 if(access==='read')return;
 await withSerializedProjectStore(async store=>{
  const entry=await store.readEntry(handoffKey(run.projectId));const p=parseHandoffPolicy(entry.value);
  if(p.digest!==policy.digest)throw new Error('handoff_binding_changed');
  const b=p.brief.budget;
  if(kind==='model'){if(p.modelTurns>=b.maxModelTurns)throw new Error('handoff_model_budget_exhausted');p.modelTurns++;}
  else{
   if(typeof callId!=='string'||!callId.length)throw new Error('handoff_tool_call_id_required');
   const id=digestValue({runId:run.id,callId});if(p.callIds.includes(id))throw new Error('handoff_call_already_attempted');
   if(p.toolCalls>=b.maxToolCalls)throw new Error('handoff_tool_budget_exhausted');
   if(access==='paid'){const n=p.paidCalls[name!]??0;if(n>=(b.paidToolCalls[name!]??0))throw new Error(`handoff_paid_budget_exhausted:${name}`);p.paidCalls[name!]=n+1;}
   p.toolCalls++;p.callIds.push(id);
  }
  await store.writeEntry(handoffKey(run.projectId),p);
 });
}

export async function assertHandoffInput(run:ServerRun,input:Pick<ServerRunInput,'instructions'|'messages'>):Promise<void>{
 const policy=await assertRunHandoff(run);if(!policy)return;
 const entry=await getStoredEntry(handoffRunKey(run.projectId,run.id));
 const artifact=await loadAgentArtifact(run.projectId,String((entry.value as HandoffRunBinding).payloadArtifactId));
 const payload=JSON.parse(artifact!.body);
 if(digestValue({instructions:input.instructions,messages:input.messages})!==payload.sent.digest)throw new Error('handoff_runtime_input_mismatch');
}
/** Archive the actual post-context-preparation request before contacting a provider. */
export async function recordHandoffDispatch(run:ServerRun,kind:'author'|'summary',request:Record<string,unknown>):Promise<void>{
 const policy=await assertRunHandoff(run);if(!policy)return;
 const body=JSON.stringify({version:1,kind,bindingDigest:policy.digest,templateVersion:HANDOFF_TEMPLATE_VERSION,request,digest:digestValue(request)});
 const artifactId=`hs_${randomUUID().replaceAll('-','').slice(0,17)}`;
 const ok=await storeAgentArtifact({version:1,artifactId,projectId:run.projectId,runId:run.id,kind:'checkpoint-source',toolName:'clipmentor-handoff-dispatch',body,
  bodySha256:digestText(body),originalBytes:Buffer.byteLength(body),originalChars:body.length,createdAt:Date.now(),redacted:false,binaryOmitted:false});
 if(!ok)throw new Error('handoff_dispatch_not_saved');
 await reserveHandoff(run,'model');
}
