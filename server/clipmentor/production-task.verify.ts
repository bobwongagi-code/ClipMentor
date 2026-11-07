import assert from 'node:assert/strict';
import {savePendingBlueprintFeedback} from './production-task';
import {bindBlueprintFeedbackSummary,blueprintFeedbackPoints,captureBlueprintFeedbackSummary} from './production-feedback';
import {advanceProductionTask,productionFeedback,acceptProductionTask,PRODUCTION_STAGES,validateProductionInput,cancelActiveProductionTask,type ProductionInput,type ProductionTask,type TaskStore} from './production-task';
const input:ProductionInput={projectId:'test',sourceAssetId:'source',product:{name:'Fixture',category:'test'},brief:'Fixture production without a provider',
 voice:{provider:'minimax',voiceId:'fixture'},
 author:{provider:'openai',model:'fixture',origin:'http://127.0.0.1:5199',apiMode:'responses'},reviewer:{provider:'openai',model:'fixture',origin:'http://127.0.0.1:5199',apiMode:'responses'},
 budget:{model:20,review:2,tts:2,render:2,observation:1,maxElapsedMs:100000,maxRepairs:1}};
const fresh=():ProductionTask=>({version:1,taskId:'test',projectId:'test',input:structuredClone(input),stage:'analysis',status:'queued',createdAt:Date.now(),updatedAt:Date.now(),sequence:0,
 completed:{},effects:{},attempts:{model:0,review:0,observation:0,tts:0,render:0},repairs:0,feedbackUsed:false});
let saved:ProductionTask;
const store:TaskStore={async save(t){saved=structuredClone(t);},async load(){return structuredClone(saved);}};
const pending=fresh();pending.input.humanBlueprintReview=true;pending.status='blocked';pending.stage='copy_review';
const budgetBefore=structuredClone(pending.attempts);
for(const [reviewedDigest,allowed,requirementsDigest,expected] of [['approved',true,'requirements','awaiting_review'],['changed',true,'requirements','awaiting_blueprint'],['approved',true,'new-requirements','awaiting_blueprint'],['approved',false,'requirements','blocked']] as const){
 const confirmed=fresh();confirmed.input.humanBlueprintReview=true;confirmed.stage='copy_review';confirmed.projectRevision='confirmed-r1';
 confirmed.blueprintApproval={sourceProjectId:'source-project',sourceTaskId:'source-task',sourceRevision:'source-r1',digest:'approved',requirementsDigest:'requirements',confirmedAt:Date.now()};
 const visited:string[]=[];
 await advanceProductionTask(confirmed,async t=>{visited.push(t.stage);return {artifact:{revision:'confirmed-r1',blueprint_digest:reviewedDigest,requirementsDigest,authorSelfCheck:'passed',gate:{allowed}}};},store);
 assert.equal(confirmed.status,expected);
 assert.equal(visited.includes('audio'),expected==='awaiting_review','human intent cannot skip failed review or authorize changed content');
}
await savePendingBlueprintFeedback(pending,'current-draft','保留成绩钩子',store);
assert.equal(pending.status,'blocked');assert.equal(pending.stage,'copy_review');
const spoken=fresh();spoken.blueprintFeedback='嗯，第一个片头要成绩和提问。第二个呢，两个片尾一个CTA一个Storyboard。还有人审版不要技术报告，补原话中文。'.repeat(3);
const rawSpoken=spoken.blueprintFeedback;
assert.deepEqual(blueprintFeedbackPoints(spoken),[],'long speech is never shown verbatim or mechanically truncated');
assert(bindBlueprintFeedbackSummary(spoken,rawSpoken,['片头：成绩与提问。','双片尾：CTA与Storyboard。','人审版：去技术信息，补中文。']));
assert.equal(spoken.blueprintFeedback,rawSpoken,'the display summary cannot replace original instructions');
assert.equal(blueprintFeedbackPoints(spoken).length,3);
assert(!captureBlueprintFeedbackSummary(spoken,rawSpoken,'<feedback_summary>not json</feedback_summary>'));
assert(!bindBlueprintFeedbackSummary(spoken,rawSpoken,['duplicate','duplicate']));
assert(!bindBlueprintFeedbackSummary(spoken,'other raw words',['不要显示过期意见']));
assert(captureBlueprintFeedbackSummary(spoken,rawSpoken,'Done. <feedback_summary>["片头：保留提问。","片尾：保留双版。"]</feedback_summary>'));
spoken.blueprintFeedback='新的修改意见'.repeat(30);
assert.deepEqual(blueprintFeedbackPoints(spoken),[],'a summary for another raw-feedback digest must disappear');

assert.equal(pending.repairContext?.pending_blueprint_feedback&&pending.blueprintFeedback,'保留成绩钩子');
assert.deepEqual(pending.attempts,budgetBefore);assert.deepEqual(pending.completed,{});
const changedAfterReview=fresh();changedAfterReview.input.humanBlueprintReview=true;
changedAfterReview.status='awaiting_blueprint';changedAfterReview.stage='copy_review';changedAfterReview.projectRevision='reviewed-old';
await savePendingBlueprintFeedback(changedAfterReview,'current-new','核对当前原CTA',store);
assert.equal(changedAfterReview.status,'awaiting_blueprint');assert.equal(changedAfterReview.projectRevision,'reviewed-old');
assert.deepEqual(changedAfterReview.attempts,fresh().attempts);
await assert.rejects(savePendingBlueprintFeedback(changedAfterReview,'reviewed-old','不能伪造旧审核的当前反馈',store));
await assert.rejects(savePendingBlueprintFeedback(pending,'current-draft','',store));
validateProductionInput(input);assert.throws(()=>validateProductionInput({...input,budget:{...input.budget,model:-1}}));
let calls:string[]=[];const task=fresh();
await advanceProductionTask(task,async(t,c)=>{calls.push(t.stage);await c.effect('model',t.stage,async()=>({value:1}));return {artifact:{saved:true}};},store);
assert.deepEqual(calls,[...PRODUCTION_STAGES]);assert.equal(task.status,'awaiting_review');assert.equal(task.attempts.model,7);
await assert.rejects(productionFeedback(task,'unbound text',store),/feedback_saved_project_required/);
assert.equal(task.feedbackUsed,false,'unbound feedback cannot consume allowance or restart planning');
await assert.rejects(acceptProductionTask(task,false,store));await acceptProductionTask(task,true,store);assert.equal(task.status,'completed');
// Bound content/execution feedback and preservation are covered through real saved native fixtures in execution-view.verify.
// A crash/failed action consumes its budget, and is never submitted twice on resume.
const failed=fresh();let paid=0;
await advanceProductionTask(failed,async(_t,c)=>{await c.effect('render','same',async()=>{paid++;throw Error('Injected export failure');});return {artifact:{saved:true}};},store);
assert.equal(failed.status,'blocked');assert.equal(failed.attempts.render,1);
await advanceProductionTask(failed,async(_t,c)=>{await c.effect('render','same',async()=>{paid++;return {};});return {artifact:{saved:true}};},store);
assert.equal(paid,1);assert.match(failed.error!,/outcome_failed/);
const interrupted=fresh();interrupted.completed.analysis={at:1,artifact:{saved:true}};interrupted.status='running';interrupted.stage='analysis';calls=[];
await advanceProductionTask(interrupted,async(t)=>{calls.push(t.stage);return {artifact:{saved:true}};},store);
assert(!calls.includes('analysis'),'completed stages survive an interrupted run');
const zero=fresh();zero.input.budget.model=0;let attempts=0;
await advanceProductionTask(zero,async(_t,c)=>{await c.effect('model','x',async()=>{attempts++;return {};});return {artifact:{saved:true}};},store);
assert.equal(attempts,0);assert.equal(zero.status,'blocked');
const expired=fresh();await advanceProductionTask(expired,async()=>{throw Error('must not run');},store,()=>expired.createdAt+100001);assert.match(expired.error!,/deadline/);
const empty=fresh();await advanceProductionTask(empty,async()=>({artifact:{}}),store);assert.equal(empty.status,'blocked');
const repair=fresh();let repaired=false;
await advanceProductionTask(repair,async(t)=>t.stage==='copy_review'&&!repaired?(repaired=true,{artifact:{},repair:'blueprint'}):{artifact:{saved:true}},store);
assert.equal(repair.repairs,1);assert.equal(repair.status,'awaiting_review');
const cancellation=fresh();let cancelInvoked=false;
await advanceProductionTask(cancellation,async(t,c)=>{cancelInvoked=cancelActiveProductionTask(t.projectId,t.taskId);c.signal.throwIfAborted();return {artifact:{saved:true}};},store);assert(cancelInvoked);assert.equal(cancellation.status,'cancelled');
const reserved=fresh();reserved.effects['analysis:initial:0:pending']={kind:'review',operationId:'unknown-outcome',status:'reserved'};
await advanceProductionTask(reserved,async(_t,c)=>{await c.effect('review','pending',async()=>{throw Error('must not resubmit');});return {artifact:{saved:true}};},store);assert.match(reserved.error!,/outcome_reserved/);assert.equal(reserved.attempts.review,0);
const reconciled=fresh();reconciled.attempts.render=1;reconciled.effects['analysis:initial:0:existing']={kind:'render',operationId:'saved-render-id',status:'reserved'};
await advanceProductionTask(reconciled,async(t,c)=>{if(t.stage==='analysis')await c.effect('render','existing',async()=>{throw Error('must not submit');},async id=>({renderId:id}));return {artifact:{saved:true}};},store);assert.equal(reconciled.status,'awaiting_review');assert.equal(reconciled.attempts.render,1);
const persistenceFailure=fresh();let forbiddenPaid=0;
await advanceProductionTask(persistenceFailure,async(_t,c)=>{await c.effect('review','x',async()=>{forbiddenPaid++;return {};});return {artifact:{saved:true}};},{...store,async save(){throw Error('Injected checkpoint quota');}});assert.equal(forbiddenPaid,0);assert.equal(persistenceFailure.status,'blocked');assert.match(persistenceFailure.error!,/checkpoint_write_failed/);
console.log('production-task: all stages, saved resume, spent/zero/deadline budgets, bounded repair, one feedback and explicit language acceptance passed; zero provider calls');

const localRepair=fresh();localRepair.stage='self_check';localRepair.repairContext={final_feedback:{kind:'execution',item_ids:['frozen-item'],preview:{timelineId:'frozen-timeline'}}};
let localFailed=false,scopeSeen=false;
await advanceProductionTask(localRepair,async t=>{
 if(t.stage==='self_check'&&!localFailed){localFailed=true;return{artifact:{receipt:{status:'needs_revision'}},repair:'edit'};}
 if(t.stage==='edit'){assert.deepEqual((t.repairContext!.final_feedback as {item_ids:string[]}).item_ids,['frozen-item']);scopeSeen=true;}
 return{artifact:{saved:true}};
},store);
assert.equal(localRepair.status,'awaiting_review');assert(scopeSeen,'an automatic preview repair cannot discard final-feedback scope');

const interactive=fresh();
interactive.input.humanBlueprintReview=true;
interactive.input.budget.maxRepairs=2;
const visited:string[]=[];
const fixtureWorker:Parameters<typeof advanceProductionTask>[1]=async t=>{
 visited.push(t.stage);
 const revision=`rev-${t.repairs}`;
 if(t.stage==='copy_review'&&t.repairs===0)return {artifact:{revision,author_self_check:[{id:'S1',status:'fix'}]},repair:'blueprint'};
 return {artifact:{revision,...(t.stage==='copy_review'?{authorSelfCheck:'passed',gate:{allowed:true}}:{})}};
};
await advanceProductionTask(interactive,fixtureWorker,store);
assert.equal(interactive.status,'awaiting_blueprint');
const beforeHuman=['analysis','blueprint','copy_review','blueprint','copy_review'];
assert.deepEqual(visited,beforeHuman,'known self-check defect must be repaired before handing off');
await advanceProductionTask(interactive,fixtureWorker,store);
assert.deepEqual(visited,beforeHuman);
const {resolveHumanBlueprint}=await import('./production-task');
await assert.rejects(resolveHumanBlueprint(interactive,'old','rev-1',undefined,store),/版本已变化/);
await resolveHumanBlueprint(interactive,'rev-1','rev-1','修改原片说明',store);
await advanceProductionTask(interactive,fixtureWorker,store);
assert.equal(interactive.status,'awaiting_blueprint');
assert.deepEqual(visited,[...beforeHuman,'blueprint','copy_review']);
await resolveHumanBlueprint(interactive,'rev-2','rev-2',undefined,store);
await advanceProductionTask(interactive,fixtureWorker,store);
assert.equal(interactive.status,'awaiting_review');
assert.deepEqual(visited.slice(7),['audio','edit','export','self_check']);
const dual=fresh();
dual.input.humanBlueprintReview=true;
dual.input.panelDelivery={productAssetId:'product',productAssetHash:'a'.repeat(64),salesAssetId:'sales',ctaAssetId:'cta',ctaAssetHash:'b'.repeat(64)};
const dualWorker=(verified:boolean):Parameters<typeof advanceProductionTask>[1]=>async t=>({artifact:{
 revision:'dual-r1',...(t.stage==='copy_review'?{authorSelfCheck:'passed',gate:{allowed:true},panelDeliveryVerified:verified}:{}),
}});
await advanceProductionTask(dual,dualWorker(false),store);
assert.equal(dual.status,'blocked','copy approval cannot substitute for the panel delivery checks');
assert.match(dual.error!,/human_blueprint_verified_receipts_missing/);
await advanceProductionTask(dual,dualWorker(true),store);
assert.equal(dual.status,'awaiting_blueprint');
await assert.rejects(resolveHumanBlueprint(dual,'dual-r1','dual-r1',undefined,store),/dual_delivery_execution_requires_variant_selection/);
assert.equal(dual.status,'awaiting_blueprint');

const missingReceipt=fresh();missingReceipt.input.humanBlueprintReview=true;
await advanceProductionTask(missingReceipt,async()=>({artifact:{revision:'fake'}}),store);
assert.equal(missingReceipt.status,'blocked');
assert.match(missingReceipt.error??'',/verified_receipts_missing/);
const noBudget=fresh();noBudget.input.humanBlueprintReview=true;noBudget.input.budget.maxRepairs=0;
await advanceProductionTask(noBudget,fixtureWorker,store);
assert.equal(noBudget.status,'blocked');
assert.deepEqual(noBudget.repairContext?.author_self_check,[{id:'S1',status:'fix'}]);
console.log('interactive production: bounded repairs, receipt gate, stale rejection, human feedback, and no duplicated review verified');

const {recoverProductionGateway}=await import('./production-recovery');
const originalOperation='a24963be-10e4-4738-83f8-b15d03f8bc78';
const gatewayArgs={operationId:originalOperation,expectedRevision:7};
function sourceGatewayFailure(args:Record<string,unknown>,status:number|null){
 return {error:'gateway failure',receipt:{operationId:args.operationId,projectId:'test',status:'failed',
  requestsAttempted:1,receipt_persisted:true,phase:'gateway_request',upstream_http_status:status}};
}
const gatewayTask=fresh();gatewayTask.input.humanBlueprintReview=true;gatewayTask.input.budget.observation=3;
gatewayTask.input.budget.review=1;gatewayTask.input.budget.preview_review=3;
const delays:number[]=[],ids:unknown[]=[];
await advanceProductionTask(gatewayTask,async(t,c)=>{
 if(t.stage==='analysis'){
  const result=await recoverProductionGateway('observe_clipmentor_source_video',gatewayArgs,t.projectId,()=>c.remaining!('observation')>0,
   args=>c.effect('observation',String(args.operationId),async()=>{
    ids.push(args.operationId);
    return ids.length<3?sourceGatewayFailure(args,ids.length===1?504:429):{ok:true,operationId:args.operationId};
   }),async ms=>{delays.push(ms);}) as {ok?:boolean;gateway_operation_ids?:string[]};
  assert.equal(result.ok,true);assert.deepEqual(result.gateway_operation_ids,ids);
 }
 if(t.stage==='copy_review'){
  await c.effect('review','copy',async()=>({passed:true}));
  return {artifact:{revision:'gateway-fixture',authorSelfCheck:'passed',gate:{allowed:true}}};
 }
 return {artifact:{revision:'gateway-fixture'}};
},store);
assert.equal(gatewayTask.attempts.observation,3);assert.equal(gatewayTask.attempts.review,1);
assert.deepEqual(delays,[1500,3500]);assert.equal(new Set(ids).size,3);
await resolveHumanBlueprint(gatewayTask,'gateway-fixture','gateway-fixture',undefined,store);
await advanceProductionTask(gatewayTask,async(t,c)=>{
 if(t.stage==='self_check'){
  assert.equal(c.remaining!('review'),0);assert.equal(c.remaining!('preview_review'),3);
  let calls=0;
  const result=await recoverProductionGateway('review_clipmentor_preview',{action:'request',operationId:originalOperation,videoSha256:'fixture'},t.projectId,
   ()=>c.remaining!('preview_review')>0,args=>c.effect('preview_review',String(args.operationId),async()=>{
    calls++;return {operationId:args.operationId,projectId:t.projectId,videoSha256:'fixture',requestsAttempted:1,receipt_persisted:true,
     status:calls===1?'failed':'completed',upstream_http_status:calls===1?503:undefined};
   }),async()=>{}) as {status:string};
  assert.equal(result.status,'completed');assert.equal(calls,2);
 }
 return {artifact:{revision:'gateway-fixture'}};
},store);
assert.equal(gatewayTask.attempts.preview_review,2);
assert.equal(gatewayTask.attempts.review,1);

for(const [status,allowBudget,patch] of [
 [null,true,{}], [401,true,{}], [422,true,{}], [504,false,{}], [504,true,{receipt_persisted:false}],
 [504,true,{operationId:'foreign'}], [504,true,{phase:'validate_response'}],
] as const){
 let calls=0;
 await recoverProductionGateway('observe_clipmentor_source_video',gatewayArgs,'test',()=>allowBudget,async args=>{
  calls++;
  const result=sourceGatewayFailure(args,status);
  return {...result,receipt:{...result.receipt,...patch}};
 },async()=>{throw new Error('unsafe retry');});
 assert.equal(calls,1);
}
function noResponse(args:Record<string,unknown>,uploaded=0,code=28) {
 const result=sourceGatewayFailure(args,null);
 return {...result,receipt:{...result.receipt,transport_diagnostic:{
  operation_id:args.operationId,http_status:null,curl_exit_code:code,error_kind:code===28?'curl_timeout':'curl_failed',
  metrics:{size_upload:uploaded,time_pretransfer:uploaded?0.1:0,time_starttransfer:0},
  request_ids:{},response_body:{bytes:0},
 }}};
}
for(const [uploaded,modelBudget,failures,expectedCalls,expectedDebits] of [
 [0,1,4,5,1], [0,1,20,6,0], [2048,1,1,1,1], [2048,2,1,2,2],
]){
 const task=fresh();task.input.budget.observation=modelBudget;
 let calls=0;
 await advanceProductionTask(task,async(t,c)=>{
  if(t.stage==='analysis'){
   const execute=async()=>recoverProductionGateway('observe_clipmentor_source_video',gatewayArgs,t.projectId,
    next=>c.remaining!('observation')>0||c.hasEffect!('observation',next),async args=>(await c.effect('observation',String(args.operationId),async()=>({
     status:++calls<=failures?409:200,body:calls<=failures?noResponse(args,uploaded,[6,7,28][uploaded?2:(calls-1)%3]):{ok:true},
    }))).body,async()=>{});
   const first=await execute();
   const reread=await execute(); // A paid final receipt remains readable after the budget is used.
   assert.deepEqual(reread,first);
  }
  return {artifact:{saved:true}};
 },store);
 assert.equal(task.status,'awaiting_review',task.error);
 assert.equal(calls,expectedCalls);
 assert.equal(task.attempts.observation,expectedDebits);
 assert.equal(Object.values(task.effects).filter(e=>e.transportUnsubmitted).length,uploaded?0:Math.min(failures,6));
}
const {confirmedUnsubmittedGateway}=await import('./production-recovery');
const result=noResponse(gatewayArgs);
assert.equal(confirmedUnsubmittedGateway('observation',{body:result},originalOperation,'test'),true);
for(const patch of [
 {operation_id:'wrong'}, {request_ids:{'x-request-id':'upstream'}}, {response_body:{bytes:4}},
 {metrics:{size_upload:0,time_pretransfer:0}}, {error_kind:'aborted'},
]){
 const receipt={...result.receipt,transport_diagnostic:{...result.receipt.transport_diagnostic,...patch}};
 assert.equal(confirmedUnsubmittedGateway('observation',{body:{receipt}},originalOperation,'test'),false);
}
const preview={...result.receipt,videoSha256:'preview'};
assert.equal(confirmedUnsubmittedGateway('preview_review',{body:preview},originalOperation,'test'),true);
let mismatchedPreview=0;
await recoverProductionGateway('review_clipmentor_preview',{...gatewayArgs,action:'request',videoSha256:'other'},'test',
 ()=>true,async()=>{mismatchedPreview++;return preview;},async()=>{throw Error('wrong video retried');});
assert.equal(mismatchedPreview,1);
console.log('Gateway recovery: free pre-dispatch retries, charged uncertain outcomes, replay-safe accounting, bounded backoff and bound receipts verified.');

const {recordTechnicalRecovery,remainingContentRepairs,legacyTechnicalRecoveryEpochs}=await import('./production-task');
const separate=fresh();separate.input.budget.maxRepairs=1;
recordTechnicalRecovery(separate);
assert.equal(separate.repairs,1,'technical continuation receives a new effect namespace');
assert.equal(remainingContentRepairs(separate),1);
let contentReturns=0;
await advanceProductionTask(separate,async t=>{
 if(t.stage==='copy_review'){
  contentReturns++;
  return {artifact:{author_self_check:[{reason:'fixture content defect'}]},repair:'blueprint'};
 }
 return {artifact:{saved:true}};
},store);
assert.equal(contentReturns,2);
assert.equal(separate.repairs,2);
assert.equal(separate.status,'blocked');
assert.equal(remainingContentRepairs(separate),0,'a real content return still consumes the existing limit');

const old=fresh();
old.status='blocked';old.stage='blueprint';old.sequence=1;old.error='Error: copy_scope_incomplete';
const recovered={...old,status:'running' as const,sequence:2,repairs:1,projectRevision:'bound',
 repairContext:{blueprint_structure_issue:'copy_scope_incomplete'}};
assert.deepEqual(legacyTechnicalRecoveryEpochs([recovered,old],recovered),[1]);
const zeroMigrated={...recovered,attempts:{...recovered.attempts,preview_review:0}};
assert.deepEqual(legacyTechnicalRecoveryEpochs([old,zeroMigrated],zeroMigrated),[1]);
const paidMigrated={...recovered,attempts:{...recovered.attempts,preview_review:1}};
assert.deepEqual(legacyTechnicalRecoveryEpochs([old,paidMigrated],paidMigrated),[]);
assert.deepEqual(legacyTechnicalRecoveryEpochs([{...old,error:'genuine content problem'},recovered],recovered),[]);
assert.deepEqual(legacyTechnicalRecoveryEpochs([{...old,taskId:'other'},recovered],recovered),[]);
assert.deepEqual(legacyTechnicalRecoveryEpochs([old,{...recovered,sequence:3}],{...recovered,sequence:3}),[]);
console.log('Production content repairs: verified legacy technical recovery is separate, content limit and operation namespaces remain enforced.');

const {grantFocusedBlueprintRepair}=await import('./production-task');
const focused=fresh();focused.input.humanBlueprintReview=true;
const missing={id:'U-01',code:'picture_plan_group_explanation_missing'};
const mismatched={id:'U-02',code:'picture_plan_revisits_mismatch'};
const issues=(...rows:unknown[])=>'blueprint_stage_incomplete:'+JSON.stringify(rows);
assert.equal(grantFocusedBlueprintRepair(focused,issues(missing,mismatched)),true);
assert.equal(grantFocusedBlueprintRepair(focused,issues(mismatched,missing)),false);
assert.equal(grantFocusedBlueprintRepair(focused,issues({...missing,id:'U-03'})),false);
assert.equal(grantFocusedBlueprintRepair(focused,issues(missing)),true);
focused.attempts.model=focused.input.budget.model;
assert.equal(grantFocusedBlueprintRepair(focused,issues(missing)),false);
assert.equal(grantFocusedBlueprintRepair(fresh(),issues(missing)),false);
assert.equal(grantFocusedBlueprintRepair({...focused,attempts:{...focused.attempts,model:0}},issues({id:'U-01',code:'source_hash_missing_or_changed'})),false);
console.log('Focused blueprint continuation: only new or strictly shrinking known defects under the model cap.');


const {runProductionWithRecovery}=await import('./production-task');
const background=fresh();
let restorations=0;
await runProductionWithRecovery(background,async t=>{
 if(t.stage==='analysis'&&t.repairs===0)throw Error('fixture recoverable');
 return {artifact:{saved:true}};
},async t=>{
 assert.equal(t.status,'blocked');
 restorations++;
 t.repairs++;
},store);
assert.equal(background.status,'awaiting_review');
assert.equal(restorations,1);
const halted=fresh();
await runProductionWithRecovery(halted,async()=>{throw Error('fixture no progress');},async()=>{},store);
assert.equal(halted.status,'blocked');
assert.match(halted.error!,/no progress/);
const {isSettledSiblingReview}=await import('./production-task');
const staleReview=fresh();
staleReview.stage='copy_review';staleReview.status='blocked';staleReview.sequence=12;
staleReview.error='Error: production_project_changed; reconcile the saved project before resuming';
staleReview.attempts.review=1;
staleReview.effects['copy_review:initial:0:operation']={kind:'review',status:'reserved',operationId:'operation'};
const settledReview=structuredClone(staleReview);
settledReview.projectRevision='saved-review-revision';
settledReview.error='Error: 已用完自动返修额度';
settledReview.effects['copy_review:initial:0:operation']={kind:'review',status:'completed',operationId:'operation',
 result:{status:200,body:{operationId:'operation',receipt:{content_digest:'saved-digest',verdict:'insufficient_evidence'}}}};
assert(isSettledSiblingReview(staleReview,settledReview,'saved-review-revision','saved-digest','insufficient_evidence'));
assert(!isSettledSiblingReview(staleReview,settledReview,'saved-review-revision','different-digest','insufficient_evidence'));
assert(!isSettledSiblingReview(staleReview,settledReview,'saved-review-revision','saved-digest','pass'));
assert(!isSettledSiblingReview(staleReview,{...settledReview,sequence:13},'saved-review-revision','saved-digest','insufficient_evidence'));
assert(!isSettledSiblingReview(staleReview,{...settledReview,attempts:{...settledReview.attempts,review:2}},'saved-review-revision','saved-digest','insufficient_evidence'));
const cancellingRecovery=fresh();
let recoveryEntered!:()=>void,releaseRecovery!:()=>void,recoveryWork=0;
const recoveryEnteredPromise=new Promise<void>(resolve=>{recoveryEntered=resolve;});
const recoveryReleasedPromise=new Promise<void>(resolve=>{releaseRecovery=resolve;});
const pendingRecovery=runProductionWithRecovery(cancellingRecovery,async()=>{
 recoveryWork++;throw Error('fixture recoverable');
},async t=>{recoveryEntered();await recoveryReleasedPromise;t.repairs++;},store);
await recoveryEnteredPromise;
assert.equal(cancelActiveProductionTask(cancellingRecovery.projectId,cancellingRecovery.taskId),true);
await assert.rejects(advanceProductionTask(structuredClone(cancellingRecovery),async()=>{throw Error('must not run');},store),/already running/);
releaseRecovery();
await pendingRecovery;
assert.equal(cancellingRecovery.status,'cancelled');assert.equal(saved.status,'cancelled');assert.equal(recoveryWork,1);
const unsavedRecovery=fresh();
let unsafeReconciles=0;
await runProductionWithRecovery(unsavedRecovery,async()=>{throw Error('must not run');},async()=>{unsafeReconciles++;},{...store,async save(){throw Error('checkpoint unavailable');}});
assert.equal(unsafeReconciles,0);
const cancellingAtReview=fresh();
await advanceProductionTask(cancellingAtReview,async()=>({artifact:{saved:true}}),{
 ...store,
 async save(t){
  await store.save(t);
  if(t.status==='awaiting_review')assert(cancelActiveProductionTask(t.projectId,t.taskId));
 },
});
assert.equal(saved.status,'cancelled');
console.log('Production background recovery: verified progress relaunches within one task, unchanged checkpoint stays paused.');

const {grantFocusedIndependentRepair}=await import('./production-task');
const independent=fresh();independent.input.humanBlueprintReview=true;
const firstVerdict={status:'bound',review_approved:false,units:[{unit_id:'U1'},{unit_id:'U2'}],delivery_checks:[{verdict:'pass'}]};
assert(grantFocusedIndependentRepair(independent,firstVerdict));
assert(!grantFocusedIndependentRepair(independent,firstVerdict));
assert(!grantFocusedIndependentRepair(independent,{...firstVerdict,units:[{unit_id:'U2'}],delivery_checks:[{verdict:'needs_revision'}]}));
assert(grantFocusedIndependentRepair(independent,{...firstVerdict,units:[{unit_id:'U2'}]}));
independent.attempts.review=independent.input.budget.review;
assert(!grantFocusedIndependentRepair(independent,{...firstVerdict,units:[{unit_id:'U2'}]}));

// Batch policy: the routine estimate is not an extra approval gate.
const automatic=fresh();automatic.input.humanBlueprintReview=true;
automatic.input.budget={...automatic.input.budget,model:12,review:6,maxRepairs:3,routine:{model:6,review:3,observation:0,tts:1,render:1}};
let repairRuns=0;
await advanceProductionTask(automatic,async(t,c)=>{
 if(t.stage==='analysis'){
  await c.effect('model','repair',async()=>({saved:true}));
  if(++repairRuns<=4)return {artifact:{issue:'fixture'},repair:'analysis'};
 }
 return {artifact:{revision:'batch-r',authorSelfCheck:'passed',gate:{allowed:true}}};
},store);
assert.equal(automatic.status,'awaiting_blueprint',automatic.error);
assert.equal(repairRuns,5,'routine three repairs must not stop a batch within its hard ceiling');
const ceiling=fresh();ceiling.input.humanBlueprintReview=true;
ceiling.input.budget={...automatic.input.budget,model:2,routine:{model:1,review:3,observation:0,tts:1,render:1}};
await advanceProductionTask(ceiling,async(t,c)=>{await c.effect('model','repair',async()=>null);return {artifact:{issue:'fixture'},repair:'analysis'};},store);
assert.equal(ceiling.status,'blocked');assert.equal(ceiling.attempts.model,2);assert.match(ceiling.error!,/model budget exhausted/);

const {panelProductionBudget,outputProductionBudget}=await import('./production-budget');
const batchBudget=panelProductionBudget();validateProductionInput({...input,budget:batchBudget});
assert.equal(batchBudget.review,2*batchBudget.routine!.review);
const childBudget=outputProductionBudget(batchBudget,37);
assert.equal(childBudget.model,37);assert.equal(childBudget.review,6);assert.equal(childBudget.observation,2);
assert.throws(()=>validateProductionInput({...input,budget:{...batchBudget,routine:{...batchBudget.routine!,review:7}}}),/routine review/);
let copyCalls=0;const copyIds:string[]=[];
const copyResult=await recoverProductionGateway('request_clipmentor_copy_review',gatewayArgs,'test',()=>copyCalls<4,async args=>{
 copyIds.push(String(args.operationId));copyCalls++;
 return copyCalls<4?{error:'failed',operationId:args.operationId,diagnostic:{operationId:args.operationId,
  code:'response_receipt_invalid',stage:'response_validation',requestsAttempted:1,retryable:false}}:{review_approved:false};
},async()=>{},6);
assert.equal(copyCalls,4);assert.equal(new Set(copyIds).size,4);assert.deepEqual((copyResult as {review_approved:boolean}).review_approved,false);
for(const [code,stage,attempts] of [['operation_unavailable','reservation',1],['review_storage_failed','persistence',1],['model_turn_failed','model_turn',null]] as const){
 let n=0;await recoverProductionGateway('request_clipmentor_copy_review',gatewayArgs,'test',()=>true,async args=>{
  n++;return {error:'failed',operationId:args.operationId,diagnostic:{operationId:args.operationId,code,stage,requestsAttempted:attempts,retryable:false}};
 },async()=>{throw Error('unknown result must not be retried');},6);assert.equal(n,1);
}
console.log('Batch hard caps, routine overrun, charged copy failures and unknown-outcome protection verified.');

// Restart the exact retry sequence: return the terminal saved receipt, no new provider call.
const replay=fresh();replay.input.budget={...panelProductionBudget(),review:4};replay.stage='analysis';
let copyPaid=0;
await advanceProductionTask(replay,async(t,c)=>{
 if(t.stage==='analysis'){
  const run=()=>recoverProductionGateway('request_clipmentor_copy_review',gatewayArgs,t.projectId,
   next=>c.remaining!('review')>0||c.hasEffect!('review',next),args=>c.effect('review',String(args.operationId),async()=>{
    copyPaid++;return copyPaid<4?{error:'failed',operationId:args.operationId,diagnostic:{operationId:args.operationId,
     code:'response_not_json',stage:'response_parse',requestsAttempted:1,retryable:false}}:{review_approved:false};
   }),async()=>{},replay.input.budget.review);
  const first=await run();assert.deepEqual(await run(),first);
 }
 return {artifact:{saved:true}};
},store);
assert.equal(copyPaid,4);assert.equal(replay.attempts.review,4);assert.equal(replay.status,'awaiting_review');
assert.equal(Object.values(replay.effects).filter(e=>e.transportUnsubmitted).length,0);
console.log('Charged review retries replay their saved terminal result even at zero remaining budget.');
