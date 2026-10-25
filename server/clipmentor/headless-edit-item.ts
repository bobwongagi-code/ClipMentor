import type {AgentContext} from '../../src/agent/context';
import {makeDraft} from '../../src/editor/store';
import {executeAtomicEditBatch} from '../../src/agent/tools/edit-item-batch';
import {GENERIC_ITEM_KINDS,applyGeneric,validateGenericAdd,validateGenericDelete,validateGenericUpdate,validateSlipUpdate} from '../../src/agent/tools/edit-item-generic';
import {commitMediaPlan,commitTextPlan,commitSolidPlan} from '../../src/agent/tools/edit-item-core-commit';
import {replaceTimelineItemAsset} from '../../src/agent/tools/edit-item-pool-replacement';

/** Same validators/commands and atomic batch as the UI, without WebGL libraries. */
export function executeCoreEditItem(args:Record<string,unknown>,ctx:AgentContext){
 return executeAtomicEditBatch(args,{
  createDraft(){const engine=makeDraft(ctx.getDoc());return {...ctx,...engine};},
  validate(draft,operation){
   const state=draft.getState(),entry=operation.entry;
   if(operation.bucket==='adds')return validateGenericAdd(state,draft.getDoc().assets,entry);
   if(entry.type!==undefined&&!GENERIC_ITEM_KINDS.has(String(entry.type)))return {error:'Unsupported server edit kind; no browser fallback'};
   if(operation.bucket==='deletes'&&entry.type===undefined)return {error:'Delete requires the explicit clip kind; effects cannot delete a clip'};
   if(operation.bucket==='deletes')return validateGenericDelete(state,entry);
   if(entry.operation!==undefined)return validateSlipUpdate(state,entry);
   // Generic validation rejects effect/transition fields instead of silently dropping them.
   return validateGenericUpdate(state,entry,draft.getDoc().assets);
  },
  apply(draft,plan){
   if(plan.plan==='addMedia')return commitMediaPlan(draft,plan);
   if(plan.plan==='addText')return commitTextPlan(draft,plan,args.ripple===true);
   if(plan.plan==='addSolid')return commitSolidPlan(draft,plan,args.ripple===true);
   if(plan.plan==='replacePoolAsset'){
    const doc=draft.getDoc(),asset=doc.assets.find(a=>a.id===plan.assetId);
    if(!asset)return {error:'Pool asset not found'};
    draft.commands.applyDoc(replaceTimelineItemAsset(doc,doc.activeTimelineId,String(plan.itemId),asset,{
     durationInFrames:Number(plan.durationInFrames),srcInFrame:typeof plan.srcInFrame==='number'?plan.srcInFrame:undefined}));
    return {ok:true,itemId:plan.itemId};
   }
   return applyGeneric(plan,draft.commands)??{error:'Unsupported server edit plan'};
  },
  publish(draft){ctx.commands.applyDoc(draft.getDoc());}
 });
}
