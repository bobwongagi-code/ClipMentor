import type {AgentContext} from '../../src/agent/context';
import {executeContextEditBatch} from '../../src/agent/tools/edit-item-batch';
import {GENERIC_ITEM_KINDS,applyGeneric,validateGenericAdd,validateGenericDelete,validateGenericUpdate,resolveClipUpdateEntry,validateSlipUpdate} from '../../src/agent/tools/edit-item-generic';
import {commitMediaPlan,commitTextPlan,commitSolidPlan,commitPoolAssetReplacement} from '../../src/agent/tools/edit-item-core-commit';

/** Same validators/commands and atomic batch as the UI, without WebGL libraries. */
export function executeCoreEditItem(args:Record<string,unknown>,ctx:AgentContext){
 return executeContextEditBatch(args,ctx,{
  validateAdd:(draft,entry)=>validateGenericAdd(draft.getState(),draft.getDoc().assets,entry),
  validate(draft,operation){
   const state=draft.getState(),entry=operation.entry;
   if(operation.bucket==='adds')return validateGenericAdd(state,draft.getDoc().assets,entry);
   if(operation.bucket==='deletes'){
    if(entry.type===undefined)return {error:'Delete requires the explicit clip kind; effects cannot delete a clip'};
    if(!GENERIC_ITEM_KINDS.has(String(entry.type)))return {error:'Unsupported server edit kind; no browser fallback'};
    return validateGenericDelete(state,entry);
   }
   if(entry.operation!==undefined)return validateSlipUpdate(state,entry);
   const normalized=resolveClipUpdateEntry(state,entry);
   if('error' in normalized)return normalized;
   if(!GENERIC_ITEM_KINDS.has(normalized.type))return {error:'Unsupported server edit kind; no browser fallback'};
   return validateGenericUpdate(state,normalized.entry,draft.getDoc().assets);
  },
  apply(draft,plan,ripple){
   if(plan.plan==='addMedia')return commitMediaPlan(draft,plan);
   if(plan.plan==='addText')return commitTextPlan(draft,plan,ripple);
   if(plan.plan==='addSolid')return commitSolidPlan(draft,plan,ripple);
   if(plan.plan==='replacePoolAsset')return commitPoolAssetReplacement(draft,plan);
   return applyGeneric(plan,draft.commands)??{error:'Unsupported server edit plan'};
  }
 });
}
