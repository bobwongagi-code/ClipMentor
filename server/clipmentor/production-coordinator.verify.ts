// Real coordinator/worker entries; isolated store and a refusing local author host only.
import assert from 'node:assert/strict';
import {mkdtemp,rm,realpath,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import saved from '../../src/clipmentor/fixtures/production-saved-projects-20261028.json';
import type {ProjectDoc} from '../../src/editor/types';
import type {AgentRunRecord} from '../../src/persist/agentRuntimeTypes';
import type {ProductionTask,StageContext} from './production-task';

const root=await mkdtemp(join(tmpdir(),'production-coordinator-'));
const previousData=process.env.OPENCHATCUT_DATA_DIR,previousFetch=globalThis.fetch;
process.env.OPENCHATCUT_DATA_DIR=root;
let requests=0;
const wires:Array<{path:string;model:string}>=[];
const host=createServer(async(req,res)=>{
 const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
 const body=JSON.parse(Buffer.concat(chunks).toString());
 wires.push({path:req.url!,model:body.model});requests++;
 res.writeHead(400,{'content-type':'application/json'});
 res.end(JSON.stringify({error:{message:'coordinator_probe_first_author_request_captured'}}));
});
try{
 await new Promise<void>((ok,fail)=>{host.once('error',fail);host.listen(0,'127.0.0.1',ok);});
 const address=host.address();assert(address&&typeof address!=='string');
 const origin=`http://127.0.0.1:${address.port}`;
 globalThis.fetch=async(input,init)=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  assert.equal(url.origin,origin,'no actual service/provider traffic');
  assert.equal(url.pathname,'/llm/chat/completions','only the first author transport is allowed');
  return previousFetch(input,init);
 };
 const {setStoredEntry,getStoredEntry}=await import('../plugins/project-store');
 const {loadOfflineStoredProject}=await import('../external-agent/offline-project-store');
 const {createAgentRun,appendAgentRunEvents,loadAgentRuntimeSidecar}=await import('../../src/persist/agentRuntimeStore');
 const {productionBlueprintReadiness}=await import('./production-readiness');
 const {reconcileBlockedBlueprint,productionStageWorker,productionBoardPhaseIssues}=await import('./production-worker');
 const fixture=structuredClone(saved.cases[0]!.doc) as unknown as ProjectDoc;
 // Legal draft registration: keep the retained unit and its source plan, but no
 // current copy yet. Same draft boundary as source-breakdown.verify narrowedScope.
 delete (fixture.clipMentorAnalysis!.blueprint[0] as unknown as Record<string,unknown>).internal_review;
 assert.equal((await productionBlueprintReadiness(fixture)).code,'copy_scope_incomplete',
  'fixture must reach the real recoverable readiness condition, not a shape refusal');
 const input=(projectId:string):ProductionTask['input']=>({projectId,sourceAssetId:fixture.clipMentorAnalysis!.source.asset_id,
  product:{name:'Coordinator fixture',category:'local'},brief:'Local coordinator first-call verification',
  author:{provider:'openai',model:'coordinator-fixture-model',origin,apiMode:'chat'},
  reviewer:{provider:'openai',model:'coordinator-fixture-review',origin,apiMode:'chat'},humanBlueprintReview:true,
  budget:{model:4,review:2,observation:0,tts:0,render:0,preview_review:0,maxElapsedMs:120_000,maxRepairs:2}});
 const taskFor=(id:string,revision:string):ProductionTask=>({version:1,projectId:id,taskId:randomUUID(),input:input(id),
  stage:'blueprint',status:'blocked',createdAt:Date.now()-10_000,updatedAt:Date.now()+10_000,sequence:0,
  feedbackUsed:false,repairs:0,projectRevision:revision,error:'Error: copy_scope_incomplete',
  completed:{analysis:{at:Date.now()-9_000,artifact:{revision}}},
  attempts:{model:1,review:0,observation:0,tts:0,render:0,preview_review:0},
  effects:{'blueprint:initial:0:author-0':{kind:'model',status:'completed',operationId:randomUUID(),result:null}}});
 async function saveAuthor(task:ProductionTask,revision:string,observation?:{operationId:string;revision:number}){
  const status=observation?'failed':'completed';
  const run:AgentRunRecord={version:1,runId:randomUUID(),projectId:task.projectId,status,askOnly:false,
   backend:'api',modelId:task.input.author.model,userInputDigest:'a'.repeat(64),userInputPreview:'fixture',
   createdAt:task.createdAt+2_000,updatedAt:task.createdAt+3_000,artifactIds:[],checkpointIds:[],proposalIds:[],events:[]};
  await createAgentRun(run);
  await appendAgentRunEvents(task.projectId,run.runId,[
   {type:'tool_outcome',summary:JSON.stringify({serverEvent:{type:'server-tool-result',data:{name:'revise_clipmentor_analysis',success:true,
    result:{saved:true,projectId:task.projectId,projectRevision:revision,revision:observation?.revision}}}})},
   ...(observation?[{type:'tool_outcome' as const,summary:JSON.stringify({serverEvent:{type:'server-tool-result',
    data:{name:'observe_clipmentor_source_video',success:false,result:{receipt:{operationId:observation.operationId}}}}})}]:[]),
   {type:'final',summary:JSON.stringify({serverEvent:{type:'done',data:{status}}})},
  ]);
  const persisted=(await loadAgentRuntimeSidecar(task.projectId)).runs.find(row=>row.runId===run.runId)!;
  assert.equal(persisted.events.length,observation?3:2);assert.equal(persisted.status,status);
  assert(persisted.createdAt>=task.completed.analysis!.at&&persisted.updatedAt<=task.updatedAt,'matching author time window');
 }
 const authority=(t:ProductionTask)=>structuredClone({attempts:t.attempts,budget:t.input.budget,effects:t.effects,completed:t.completed});
 for(const mode of ['matching','wrong-write-revision','multiple-authors','model-budget-exhausted'] as const){
  const id='coordinator-'+mode;
  await setStoredEntry(`project:${id}`,structuredClone(fixture));
  await setStoredEntry(`versions:${id}`,[]);
  const snapshot=(await loadOfflineStoredProject(id))!;
  const task=taskFor(id,snapshot.revision),projectBefore=JSON.stringify((await getStoredEntry(`project:${id}`)).value);
  if(mode==='model-budget-exhausted')task.attempts.model=task.input.budget.model;
  const before=authority(task);
  await saveAuthor(task,mode==='wrong-write-revision'?'different-saved-revision':snapshot.revision);
  if(mode==='multiple-authors')await saveAuthor(task,snapshot.revision);
  if(mode==='matching'){
   await reconcileBlockedBlueprint(task);
   assert.equal(task.repairs,1);assert.deepEqual(task.technicalRecoveryEpochs,[1]);
   assert.equal(task.repairContext?.blueprint_structure_issue,'copy_scope_incomplete');
   assert.equal(task.projectRevision,snapshot.revision);
   const afterFirst=structuredClone(task);
   await assert.rejects(reconcileBlockedBlueprint(task),/blueprint_recovery_budget_or_effect_unverified/);
   assert.deepEqual(task,afterFirst,'old effect cannot grant a second epoch');
  }else{
   const reason=mode==='model-budget-exhausted'?/blueprint_recovery_budget_or_effect_unverified/:/blueprint_recovery_author_receipt_unverified/;
   await assert.rejects(reconcileBlockedBlueprint(task),reason);
   assert.equal(task.repairs,0);assert.equal(task.technicalRecoveryEpochs,undefined);
   assert.equal(task.repairContext,undefined);
  }
  assert.deepEqual(authority(task),before,'reconcile does not replenish or spend original counters/effects');
  assert.equal(JSON.stringify((await getStoredEntry(`project:${id}`)).value),projectBefore);
  assert.deepEqual((await getStoredEntry(`versions:${id}`)).value,[]);
  console.log(`PASS real reconcile ${mode}: epoch=${task.repairs}; counters/effects/project unchanged`);
 }
 // A saved gateway timeout can coexist with a real draft write and a later
 // storyboard asset edit. Resume authoring, never reissue the observation.
 for(const mode of ['gateway-timeout','wrong-source','missing-receipt','wrong-write'] as const){
  const id='coordinator-'+mode,source=fixture.clipMentorAnalysis!.source;
  await setStoredEntry('project:'+id,fixture);
  const snapshot=(await loadOfflineStoredProject(id))!;
  const task=taskFor(id,snapshot.revision),operationId=randomUUID();
  task.error='Error: tool failed (observe_clipmentor_source_video: source_observation_failed_or_unknown; revise_clipmentor_analysis: delivery_sections_invalid).';
  task.attempts.observation=1;task.input.budget.observation=2;
  const subject={revision:fixture.clipMentorAnalysis!.revision,digest:'a'.repeat(64),units:[]};
  task.effects['blueprint:initial:0:'+operationId]={kind:'observation',status:'completed',operationId,result:{body:{receipt:{
   operationId,projectId:id,status:'failed',phase:'gateway_request',receipt_persisted:true,requestsAttempted:1,
   source_hash:source.sourceContentHash,subject
  }}}};
  const receipts=join(root,'clipmentor-source-video');
  await mkdir(receipts,{recursive:true});
  if(mode!=='missing-receipt')await writeFile(join(receipts,operationId+'.json'),JSON.stringify({projectId:id,status:'failed',phase:'gateway_request',
   requests_attempted:1,model_retry_policy:'no_automatic_retry',source_hash:mode==='wrong-source'?'b'.repeat(64):source.sourceContentHash,subject}));
  const run:AgentRunRecord={version:1,runId:randomUUID(),projectId:id,status:'failed',askOnly:false,backend:'api',
   modelId:task.input.author.model,userInputDigest:'b'.repeat(64),userInputPreview:'fixture',createdAt:task.createdAt+2500,
   updatedAt:task.createdAt+4000,artifactIds:[],checkpointIds:[],proposalIds:[],events:[]};
  await createAgentRun(run);
  await appendAgentRunEvents(id,run.runId,[
   {type:'tool_outcome',summary:JSON.stringify({serverEvent:{type:'server-tool-result',data:{name:'revise_clipmentor_analysis',success:true,result:{saved:true,projectId:id,projectRevision:'before-storyboard',revision:subject.revision}}}})},
   {type:'tool_outcome',summary:JSON.stringify({serverEvent:{type:'server-tool-result',data:{name:'observe_clipmentor_source_video',success:false,result:{receipt:{operationId}}}}})},
   {type:'tool_outcome',summary:JSON.stringify({serverEvent:{type:'server-tool-result',data:{name:'edit_asset',success:true,result:{saved:true,projectId:id,projectRevision:mode==='wrong-write'?'stale':snapshot.revision}}}})},
   {type:'final',summary:JSON.stringify({serverEvent:{type:'done',data:{status:'failed'}}})},
  ]);
  const before=authority(task);
  if(mode==='gateway-timeout'){
   await reconcileBlockedBlueprint(task);
   assert.equal(task.sourceObservationUnavailableOperation,operationId);
   assert.equal(task.repairs,1);assert.equal(task.stage,'blueprint');assert.equal(task.projectRevision,snapshot.revision);
   const {productionSourceObservationAllowed}=await import('./production-source-evidence');
   assert.equal(productionSourceObservationAllowed(task),false,'repair cannot reserve another observation');
   assert.equal(productionSourceObservationAllowed({...task,sourceObservationUnavailableOperation:undefined}),true);
  }else{
   await assert.rejects(reconcileBlockedBlueprint(task),/blueprint_recovery_(observation_receipt|author_receipt)_unverified/);
   assert.equal(task.repairs,0);
  }
  assert.deepEqual(authority(task),before,'the attempt and its original effect are immutable');
  assert.equal(requests,0);
 }
 // A received-but-invalid observation has a distinct proof and still needs
 // remaining observation allowance to schedule a corrected context.
 const {copyReviewSubject}=await import('../../src/clipmentor/production-gate');
 for(const allowance of [2,1]){
  const id='coordinator-boundary-'+allowance,doc=structuredClone(saved.cases[0]!.doc) as unknown as ProjectDoc;
  const analysis=doc.clipMentorAnalysis!,unit=analysis.source_breakdown!.units[0]!;
  const end=unit.original_source_ranges![0][1];
  analysis.source.duration_seconds=end+3;
  await setStoredEntry('project:'+id,doc);
  const snapshot=(await loadOfflineStoredProject(id))!;
  const task=taskFor(id,snapshot.revision),operationId=randomUUID();
  task.error='Error: observe_clipmentor_source_video: Source observation failed; read the saved receipt, do not retry';
  task.attempts.observation=1;task.input.budget.observation=allowance;
  const subject=await copyReviewSubject(snapshot.doc);
  const context={context_id:'boundary-fixture',unit_id:unit.unit_id,source_range_seconds:[end-1,end],
   boundary_seconds:[end],goals:['speech_boundaries']};
  task.effects['blueprint:initial:0:'+operationId]={kind:'observation',status:'completed',operationId,result:{body:{receipt:{
   operationId,projectId:id,status:'failed',phase:'validate_response',receipt_persisted:true,requestsAttempted:1,
   upstream_http_status:200,source_hash:analysis.source.sourceContentHash,subject,
   validation:{status:'invalid',issues:[{severity:'error',code:'invalid_task_boundary_evidence'}]},
   observation_task:{version:'source-boundaries-v1',contexts:[context]},
  }}}};
  await saveAuthor(task,snapshot.revision,{operationId,revision:subject.revision});
  const before=structuredClone(task);
  if(allowance===2){
   await reconcileBlockedBlueprint(task);
   assert.equal(task.stage,'blueprint');
   assert.equal(task.repairs,1);assert.deepEqual(task.technicalRecoveryEpochs,[1]);
   assert.equal(task.sourceObservationUnavailableOperation,undefined);
   assert.deepEqual(task.repairContext?.source_observation_recovery,{version:'source-boundaries-v1',
    contexts:[{...context,source_range_seconds:[end-1,end+2]}]});
  }else{
   await assert.rejects(reconcileBlockedBlueprint(task),/blueprint_recovery_observation_receipt_unverified/);
   assert.deepEqual(task,before);
  }
  assert.deepEqual(authority(task),authority(before));
  assert.deepEqual(await loadOfflineStoredProject(id),snapshot);
  assert.equal(requests,0);
  console.log('PASS real reconcile boundary receipt with observation allowance '+allowance);
 }
 const {default:deliveryFixture}=await import('../../src/agent/tools/fixtures/barely-there-mg-replacement-20261030.json');
 for(const mode of ['source-evidence','visual-fallback','review-budget-exhausted'] as const){
  const id='coordinator-current-'+mode;
  const doc=structuredClone(mode==='source-evidence'?saved.cases[0]!.doc:deliveryFixture.before) as unknown as ProjectDoc;
  const receipt=doc.clipMentorAnalysis!.production_copy_review!,subject=await copyReviewSubject(doc);
  receipt.analysis_revision=subject.revision;receipt.content_digest=subject.digest;
  receipt.verdict='insufficient_evidence';
  if(mode==='source-evidence')receipt.units[0]!.verdict='insufficient_evidence';
  receipt.visual_criteria_digest='a'.repeat(64);
  receipt.visual_criteria_checks=[{id:'missing-stage',answer:'unknown',observation:'缺少该段可定位的画面判断',picture_stage:''}];
  await setStoredEntry('project:'+id,doc);
  const snapshot=(await loadOfflineStoredProject(id))!;
  const task=taskFor(id,snapshot.revision);
  task.stage='copy_review';task.error='Error: 蓝图返修未改变送审内容';
  task.input.budget.routine={model:1,review:1,observation:1,tts:0,render:0};task.input.budget.observation=1;
  task.completed.blueprint={at:task.createdAt+1,artifact:{revision:snapshot.revision}};
  task.repairContext={revision:snapshot.revision,blueprint_digest:subject.digest};
  if(mode==='review-budget-exhausted')task.attempts.review=task.input.budget.review;
  const before=structuredClone(task);
  await reconcileBlockedBlueprint(task);
  if(mode==='review-budget-exhausted')assert.deepEqual(task,before);
  else{
   assert.equal(task.repairs,1);
   assert.equal(task.technicalRecoveryEpochs,undefined);
   if(mode==='source-evidence'){
    assert.equal(task.stage,'blueprint');
    assert.equal(task.completed.blueprint,undefined);
    assert.equal((task.repairContext?.repair as {status:string}).status,'bound');
    assert.equal(task.repairContext?.review_contract_recheck,undefined);
   }else{
    assert.equal(task.stage,'copy_review');
    assert.deepEqual(task.completed,before.completed);
    assert.equal(task.repairContext?.review_contract_recheck,true);
    assert.equal(task.repairContext?.repair,undefined);
   }
  }
  assert.deepEqual(task.input.budget,before.input.budget);
  assert.deepEqual(task.attempts,before.attempts);
  assert.deepEqual(task.effects,before.effects);
  assert.deepEqual(await loadOfflineStoredProject(id),snapshot);
  assert.equal(requests,0);
  console.log('PASS real reconcile current plan '+mode);
 }
 // Both focused routes are candidates. The bound author route may stop even
 // when the same saved project qualifies for independent repair.
 for(const mode of ['author-shrinks','author-refuses','independent-fallback','stale-snapshot'] as const){
  const id='coordinator-focused-'+mode,doc=structuredClone(saved.cases[0]!.doc) as unknown as ProjectDoc;
  const receipt=doc.clipMentorAnalysis!.production_copy_review!;
  receipt.verdict='needs_revision';
  receipt.units[0]!.verdict='needs_revision';
  await setStoredEntry('project:'+id,doc);
  const snapshot=(await loadOfflineStoredProject(id))!;
  const task=taskFor(id,mode==='stale-snapshot'?'old-project-revision':snapshot.revision);
  task.stage='copy_review';
  task.error='Error: 已用完自动返修额度';
  task.repairs=task.input.budget.maxRepairs;
  task.completed.blueprint={at:task.createdAt+1,artifact:{revision:task.projectRevision}};
  task.repairContext={revision:task.projectRevision,blueprint_digest:receipt.content_digest,repair:{status:'bound'},
   author_self_check:[{id:mode==='independent-fallback'?'S2':'S1',status:'fix'}]};
  if(mode!=='independent-fallback'){
   task.sourceEvidenceRecoveryOperation='saved-source-evidence';
   task.focusedAuthorChecks=mode==='author-refuses'?['S1']:['S1','S5'];
  }
  const before=structuredClone(task);
  await reconcileBlockedBlueprint(task);
  if(mode==='author-refuses'||mode==='stale-snapshot'){
   assert.deepEqual(task,before,'refusal cannot change the repair state or fall through to independent repair');
  }else{
   assert.equal(task.stage,'blueprint');
   assert.equal(task.repairs,before.repairs+1);
   assert.equal(task.technicalRecoveryEpochs,undefined,'a focused repair is a content repair');
   assert.deepEqual(task.completed,{analysis:before.completed.analysis},'rewind invalidates the old blueprint only at the existing boundary');
   if(mode==='author-shrinks'){
    assert.deepEqual(task.focusedAuthorChecks,['S1']);
    assert.equal(task.focusedIndependentUnits,undefined);
   }else{
    assert.equal(task.sourceEvidenceRecoveryOperation,undefined);
    assert.deepEqual(task.focusedIndependentUnits,[receipt.units[0]!.unit_id]);
   }
  }
  assert.deepEqual(task.input.budget,before.input.budget);
  assert.deepEqual(task.attempts,before.attempts);
  assert.deepEqual(task.effects,before.effects);
  assert.deepEqual(await loadOfflineStoredProject(id),snapshot);
  assert.equal(requests,0);
  console.log('PASS real reconcile focused '+mode);
 }
 const readyFixture=structuredClone(saved.cases[0]!.doc) as unknown as ProjectDoc;
 const unit=readyFixture.clipMentorAnalysis!.blueprint[0]!;
 const internal=(unit as unknown as {internal_review:Record<string,any>}).internal_review;
 const plan=internal[internal.current_picture_plan];
 plan.phases=[{mode:'original',source_range_seconds:[0,1],picture:'原片'}];
 assert(!productionBoardPhaseIssues(readyFixture).some(issue=>issue.id===unit.unit_id),'valid registered phase is readable');
 plan.phases=[];
 assert(productionBoardPhaseIssues(readyFixture).some(issue=>issue.id===unit.unit_id),'empty current phases fail the actual board reader');
 // Worker control uses the original saved complete project. No media file is
 // opened by blueprint authoring before the first local request.
 const workerId='coordinator-worker';
 await setStoredEntry(`project:${workerId}`,structuredClone(saved.cases[0]!.doc));
 await setStoredEntry(`versions:${workerId}`,[]);
 const workerSnapshot=(await loadOfflineStoredProject(workerId))!;
 const workerTask=taskFor(workerId,workerSnapshot.revision);workerTask.status='running';delete workerTask.error;
 const workerBefore=JSON.stringify((await getStoredEntry(`project:${workerId}`)).value);
 let modelReservations=0;
 const stage:StageContext={signal:new AbortController().signal,effect:async(kind,_key,work)=>{
  assert.equal(kind,'model','no media/review/render effects allowed');modelReservations++;
  return work(randomUUID());
 }};
 await assert.rejects(productionStageWorker(workerTask,stage),/author_stage_already_attempted/);
 assert.equal(requests,0);assert.equal(modelReservations,0);
 assert.equal((await loadAgentRuntimeSidecar(workerId)).runs.length,0,'duplicate guard precedes author run creation');
 const positive=structuredClone(workerTask);positive.effects={};
 // AI SDK turns the deliberate nonretryable HTTP 400 into its empty-stream error.
 // The strict wire count/model/path below is the first-call oracle.
 await assert.rejects(productionStageWorker(positive,stage),/No output generated\. Check the stream for errors\./);
 assert.equal(requests,1);assert.equal(modelReservations,1);
 assert.deepEqual(wires,[{path:'/llm/chat/completions',model:'coordinator-fixture-model'}]);
 assert.equal(JSON.stringify((await getStoredEntry(`project:${workerId}`)).value),workerBefore);
 assert.deepEqual((await getStoredEntry(`versions:${workerId}`)).value,[]);
 console.log('PASS real productionStageWorker: same-epoch model effect -> 0 author requests/0 reservations; same task with only prior effect removed -> exactly 1 local fake author request/1 reservation; project unchanged');
 console.log('PASS SM07/08 coordinator probe: isolated real store; zero actual provider/Codex/media/render/install');
}finally{
 globalThis.fetch=previousFetch;
 await new Promise<void>((ok,fail)=>{host.closeAllConnections();host.close(error=>error?fail(error):ok());});
 if(previousData===undefined)delete process.env.OPENCHATCUT_DATA_DIR;else process.env.OPENCHATCUT_DATA_DIR=previousData;
 const absolute=await realpath(root);
 assert.equal(absolute,join(await realpath(tmpdir()),root.slice(root.lastIndexOf('/')+1)));
 assert(root.startsWith(join(tmpdir(),'production-coordinator-')));
 await rm(absolute,{recursive:true,force:true});
}
