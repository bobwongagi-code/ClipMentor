import {randomUUID,createHash} from 'node:crypto';
import {storeAgentArtifact,loadAgentArtifact,loadAgentRuntimeSidecar} from '../../src/persist/agentRuntimeStore';
import {createRun,flushRunPersistence,setRunStatus,pushRunEvent,recoverServerRun} from '../agent-runs/store';
import {currentAgentSessionGeneration} from '../../src/persist/agentSessionGeneration';
import {LLM_PROVIDER_PRESETS} from '../../shared/llm-providers';
import type {ReviewApiConfig} from './copy-review-api';

export const PRODUCTION_STAGES=['analysis','blueprint','copy_review','audio','edit','export','self_check'] as const;
export type ProductionStage=typeof PRODUCTION_STAGES[number];
export type EffectKind='model'|'review'|'observation'|'tts'|'render';
export interface ProductionInput {
 projectId:string;sourceAssetId:string;product:{name:string;category:string};brief:string;
 author:ReviewApiConfig;reviewer:ReviewApiConfig;
 voice?:{provider:string;voiceId:string};
 budget:Record<EffectKind,number>&{maxElapsedMs:number;maxRepairs:number};
}
export interface ProductionTask {
 version:1;taskId:string;projectId:string;input:ProductionInput;stage:ProductionStage;
 status:'queued'|'running'|'blocked'|'awaiting_review'|'completed'|'cancelled';
 createdAt:number;updatedAt:number;sequence:number;feedback?:string;feedbackUsed:boolean;repairs:number;
 completed:Partial<Record<ProductionStage,{at:number;artifact:Record<string,unknown>}>>;
 effects:Record<string,{kind:EffectKind;operationId:string;status:'reserved'|'completed'|'failed';result?:unknown;error?:string}>;
 attempts:Record<EffectKind,number>;error?:string;projectRevision?:string;repairContext?:Record<string,unknown>;
}
export interface TaskStore {save(task:ProductionTask):Promise<void>;load(projectId:string,id:string):Promise<ProductionTask>}
export const productionTaskStore:TaskStore={
 async save(task){
  task.updatedAt=Math.max(Date.now(),task.updatedAt+1);task.sequence++;
  const body=JSON.stringify({type:'clipmentor-production-task/v1',task});
  const ok=await storeAgentArtifact({version:1,artifactId:`p_${randomUUID().replaceAll('-','').slice(0,18)}`,projectId:task.projectId,runId:task.taskId,
   kind:'checkpoint-source',toolName:'clipmentor-production-task',body,bodySha256:createHash('sha256').update(body).digest('hex'),
   originalBytes:Buffer.byteLength(body),originalChars:body.length,createdAt:task.updatedAt,redacted:false,binaryOmitted:false});
  if(!ok)throw new Error('Production checkpoint could not be persisted');
 },
 async load(projectId,id){
  const sidecar=await loadAgentRuntimeSidecar(projectId);
  const records=sidecar.artifacts.filter(a=>a.runId===id&&a.toolName==='clipmentor-production-task').sort((a,b)=>b.createdAt-a.createdAt);
  for(const record of records){const artifact=await loadAgentArtifact(projectId,record.artifactId);if(!artifact)continue;
   const value=JSON.parse(artifact.body);if(value.type==='clipmentor-production-task/v1'&&value.task.taskId===id&&value.task.projectId===projectId)return value.task;
  }
  throw new Error('Production task not found');
 }
};
const busy=new Set<string>();
const cancellations=new Map<string,AbortController>();
export function cancelActiveProductionTask(projectId:string,id:string){
 const controller=cancellations.get(`${projectId}:${id}`);if(controller)controller.abort(new Error('Production cancelled by user'));return !!controller;
}
export function validateProductionInput(v:ProductionInput){
 if(!v||!/^[A-Za-z0-9_-]{1,160}$/.test(v.projectId)||!v.sourceAssetId||!v.product?.name?.trim()||typeof v.brief!=='string'||!v.brief.trim()||v.brief.length>32000)throw new Error('Invalid production input');
 for(const config of [v.author,v.reviewer])if(!config?.model?.trim()||!LLM_PROVIDER_PRESETS.some(p=>p.id===config.provider)||!['responses','chat'].includes(config.apiMode))throw new Error('Explicit API author/reviewer configuration required');
 if(!v.budget||!Number.isSafeInteger(v.budget.maxElapsedMs)||v.budget.maxElapsedMs<1||v.budget.maxElapsedMs>86400000||!Number.isSafeInteger(v.budget.maxRepairs)||v.budget.maxRepairs<0||v.budget.maxRepairs>3)throw new Error('Explicit production budget required');
 if(v.budget.tts>0&&(!v.voice?.provider?.trim()||!v.voice.voiceId?.trim()))throw new Error('Confirmed voice required for a nonzero TTS budget');
 for(const kind of ['model','review','observation','tts','render'] as const)if(!Number.isSafeInteger(v.budget[kind])||v.budget[kind]<0||v.budget[kind]>1000)throw new Error(`Invalid ${kind} budget`);
}
export async function createProductionTask(input:ProductionInput,store=productionTaskStore):Promise<ProductionTask>{
 validateProductionInput(input);
 const run=createRun({projectId:input.projectId,sessionGeneration:await currentAgentSessionGeneration(input.projectId),backend:'api',provider:input.author.provider,model:input.author.model,askOnly:false});
 await flushRunPersistence(run);
 const now=Date.now(),task:ProductionTask={version:1,taskId:run.id,projectId:input.projectId,input:structuredClone(input),stage:'analysis',status:'queued',createdAt:now,updatedAt:now,sequence:0,
  feedbackUsed:false,repairs:0,completed:{},effects:{},attempts:{model:0,review:0,observation:0,tts:0,render:0}};
 await store.save(task);return task;
}
export interface StageContext {
 effect<T>(kind:EffectKind,key:string,work:(operationId:string)=>Promise<T>,recover?:(operationId:string)=>Promise<T>):Promise<T>;
 signal:AbortSignal;
}
export interface StageResult {artifact:Record<string,unknown>;repair?:'blueprint'|'edit'}
export type StageWorker=(task:ProductionTask,ctx:StageContext)=>Promise<StageResult>;
/** Canonical business state is an immutable checkpoint in the existing run/artifact ledger. */
export async function advanceProductionTask(task:ProductionTask,worker:StageWorker,store=productionTaskStore,now=()=>Date.now()):Promise<ProductionTask>{
 const key=`${task.projectId}:${task.taskId}`;if(busy.has(key))throw new Error('Production task already running');
 if(['completed','cancelled','awaiting_review'].includes(task.status))return task;
 busy.add(key);
 cancellations.set(key,new AbortController());
 const deadline=task.createdAt+task.input.budget.maxElapsedMs,abort=cancellations.get(key)!;
 const timer=setTimeout(()=>abort.abort(new Error('Production deadline exceeded')),Math.max(0,deadline-now()));
 const check=()=>{abort.signal.throwIfAborted();if(now()>=deadline)throw new Error('Production deadline exceeded');};
 const ctx:StageContext={signal:abort.signal,async effect<T>(kind:EffectKind,name:string,work:(operationId:string)=>Promise<T>,recover?:(operationId:string)=>Promise<T>){
  check();const id=`${task.stage}:${task.feedbackUsed?'feedback':'initial'}:${task.repairs}:${name}`;
  const old=task.effects[id];
  if(old?.status==='completed')return structuredClone(old.result) as T;
  if(old&&recover){const result=await recover(old.operationId);task.effects[id]={...old,status:'completed',result:structuredClone(result)};await store.save(task);return result;}
  if(old)throw new Error(`effect_outcome_${old.status}:${old.operationId}; read original receipt, no automatic resubmission`);
  if(task.attempts[kind]>=task.input.budget[kind])throw new Error(`${kind} budget exhausted`);
  const effect={kind,operationId:/^[a-f0-9-]{36}$/.test(name)?name:randomUUID(),status:'reserved' as const};task.effects[id]=effect;task.attempts[kind]++;await store.save(task);
  try{const result=await work(effect.operationId);check();task.effects[id]={...effect,status:'completed',result:structuredClone(result)};await store.save(task);return result;}
  catch(error){task.effects[id]={...effect,status:'failed',error:String(error).slice(0,1200)};await store.save(task);throw error;}
 }};
 try{
  check();task.status='running';delete task.error;await store.save(task);
  for(let index=PRODUCTION_STAGES.indexOf(task.stage);index<PRODUCTION_STAGES.length;){
   check();task.stage=PRODUCTION_STAGES[index]!;
   if(task.completed[task.stage]){index++;continue;}
   const result=await worker(task,ctx);check();
   if(typeof result.artifact?.revision==='string')task.projectRevision=result.artifact.revision;
   if(result.repair){
    if(task.repairs>=task.input.budget.maxRepairs)throw new Error('Content repair budget exhausted');
    task.repairContext=result.artifact;task.repairs++;index=PRODUCTION_STAGES.indexOf(result.repair);
    for(const stage of PRODUCTION_STAGES.slice(index))delete task.completed[stage];
    await store.save(task);continue;
   }
   if(!result.artifact||Object.keys(result.artifact).length===0)throw new Error('Stage has no verified artifact');
   task.completed[task.stage]={at:now(),artifact:result.artifact};await store.save(task);index++;
  }
  task.status='awaiting_review';await store.save(task);
 }catch(error){task.status=abort.signal.aborted&&String(abort.signal.reason).includes('cancelled by user')?'cancelled':'blocked';task.error=String(error).slice(0,1600);try{await store.save(task);}catch(persistenceError){task.error=`${task.error}; checkpoint_write_failed: ${String(persistenceError).slice(0,500)}; last persisted checkpoint is authoritative, do not resubmit unknown effects`;}}
 finally{clearTimeout(timer);busy.delete(key);cancellations.delete(key);}
 const run=await recoverServerRun(task.projectId,task.taskId);
 if(run){run.error=task.error??null;pushRunEvent(run,'production-stage',{stage:task.stage,status:task.status,attempts:task.attempts,error:task.error});await setRunStatus(run,task.status==='awaiting_review'?'awaiting-user':task.status==='cancelled'?'cancelled':'failed');}
 return task;
}
export async function productionFeedback(task:ProductionTask,feedback:string,store=productionTaskStore){
 if(task.status!=='awaiting_review'||task.feedbackUsed||!feedback.trim()||feedback.length>8000)throw new Error('One consolidated local feedback is allowed after preview');
 task.feedback=feedback;task.feedbackUsed=true;task.stage='blueprint';task.status='queued';
 for(const stage of PRODUCTION_STAGES.slice(1))delete task.completed[stage];
 await store.save(task);return task;
}
export async function acceptProductionTask(task:ProductionTask,languageConfirmed:boolean,store=productionTaskStore){
 if(task.status!=='awaiting_review'||languageConfirmed!==true)throw new Error('Final reviewer must confirm Malay delivery suitability');
 task.status='completed';await store.save(task);return task;
}

export async function cancelProductionTask(task:ProductionTask,store=productionTaskStore){
 if(['completed','cancelled'].includes(task.status))throw new Error('Task is already terminal');
 if(cancelActiveProductionTask(task.projectId,task.taskId))return {taskId:task.taskId,status:'cancelling'};
 task.status='cancelled';await store.save(task);return task;
}
