import {HANDOFF_PREFIX,HANDOFF_RUN_PREFIX,HANDOFF_TEMPLATE_VERSION,handoffRecord,parseHandoffPolicy,handoffToolAccess,handoffAssetsOf,handoffDigest} from '../../shared/clipmentor-handoff';
import {kvGetAuthoritative} from '../persist/sharedKv';
import type {AgentContext} from '../agent/context';
import { assertHandoffCopy } from './handoff-copy';
/** Covers browser/local and external/offline dispatch, including the preparation early return. */
export async function clipMentorHandoffBlock(name:string,args:Record<string,unknown>,ctx:AgentContext){
 const projectId=ctx.getProjectId?.();if(!projectId)return null;
 try{
  const value=await kvGetAuthoritative(`${HANDOFF_PREFIX}${projectId}`);if(value===undefined)return null;
  const p=parseHandoffPolicy(value),runId=ctx.getAgentRunId?.();
  const raw=runId?await kvGetAuthoritative(`${HANDOFF_RUN_PREFIX}${projectId}:${runId}`):undefined;
  const bound=handoffRecord(raw)&&raw.version===1&&raw.projectId===projectId&&raw.runId===runId&&raw.policyDigest===p.digest&&raw.templateVersion===HANDOFF_TEMPLATE_VERSION;
  const access=handoffToolAccess(p.brief,name,args,bound);
  if(access==='read')return null;
  if(runId&&!bound)throw new Error('handoff_run_binding_required');
  if(args.projectId!==undefined&&args.projectId!==projectId)throw new Error('handoff_tool_project_mismatch');
  if(args.timelineId!==undefined&&args.timelineId!==p.brief.timelineId)throw new Error('handoff_tool_timeline_mismatch');
  const doc=ctx.getDoc();
  if(p.brief.phase==='execution'){
   if(doc.activeTimelineId!==p.brief.timelineId)throw new Error('handoff_active_timeline_changed');
   const {copyReviewSubject}=await import('./production-gate');const subject=await copyReviewSubject(doc);
   if(p.brief.blueprint?.revision!==subject.revision||p.brief.blueprint?.digest!==subject.digest)throw new Error('handoff_blueprint_changed');
   if(await handoffDigest(handoffAssetsOf(doc.assets,p.assetBindings.map(x=>String(x.id))))!==await handoffDigest(p.assetBindings))throw new Error('handoff_assets_changed');
   assertHandoffCopy(name,args,ctx);
  }
  return null;
 }catch(error){return {error:String(error instanceof Error?error.message:error),handoff_gate:{allowed:false,scope:'mode_role_and_frozen_input_only',complete_film_accepted:false},production_gate:{allowed:false,code:'handoff_blocked',scope:'mode_role_and_frozen_input_only',complete_film_accepted:false}};}
}

export async function assertExternalHandoffCommit(projectId:string,before:ReturnType<AgentContext['getDoc']>,after:ReturnType<AgentContext['getDoc']>):Promise<void>{
 const value=await kvGetAuthoritative(`${HANDOFF_PREFIX}${projectId}`);if(value===undefined)return;
 const p=parseHandoffPolicy(value);
 if(p.brief.mode!=='collaborative'||p.brief.phase!=='planning')throw new Error('handoff_external_commit_forbidden');
 const {_a,...oldDoc}={...before,_a:before.clipMentorAnalysis};const {_b,...newDoc}={...after,_b:after.clipMentorAnalysis};
 delete oldDoc.clipMentorAnalysis;delete newDoc.clipMentorAnalysis;
 if(await handoffDigest(oldDoc)!==await handoffDigest(newDoc))throw new Error('handoff_planner_may_only_register_analysis');
}
