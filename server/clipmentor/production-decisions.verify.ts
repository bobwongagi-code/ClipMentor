import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type {ProductionTask,ProductionInput} from './production-task';
import {blockedProductionDecision,productionAuthorDecision,productionEffectDecision,productionRecoveryProgress,productionDecisionEvent,productionOutputsMatch} from './production-decisions';
const input:ProductionInput={projectId:'decision-fixture',sourceAssetId:'source',product:{name:'fixture',category:'fixture'},brief:'private briefing, must never enter decision events',
 author:{provider:'openai',model:'fixture',origin:'http://fixture.invalid',apiMode:'responses'},reviewer:{provider:'openai',model:'fixture',origin:'http://fixture.invalid',apiMode:'responses'},humanBlueprintReview:true,
 budget:{model:10,review:3,observation:2,tts:0,render:2,maxElapsedMs:100000,maxRepairs:1,routine:{model:5,review:1,observation:1,tts:0,render:1}}};
const fresh=():ProductionTask=>({version:1,taskId:'task',projectId:input.projectId,input:structuredClone(input),stage:'blueprint',status:'blocked',createdAt:Date.now(),updatedAt:Date.now(),sequence:0,
 feedbackUsed:false,repairs:0,completed:{},effects:{},attempts:{model:0,review:0,observation:0,tts:0,render:0},projectRevision:'current'});
const routes=(t:ProductionTask,left=1)=>blockedProductionDecision(t,left).routes;
const picture=fresh();picture.stage='edit';picture.error='Error: Actual sequence mapping incomplete: []';
assert.deepEqual(routes(picture),['picture_capacity']);picture.attempts.review=3;assert.deepEqual(routes(picture),[]);
const fallback=fresh();fallback.stage='copy_review';fallback.error='Error: 蓝图返修未改变送审内容';fallback.blueprintApproval={sourceProjectId:'parent',sourceTaskId:'parent',sourceRevision:'r',digest:'d',requirementsDigest:'r',confirmedAt:1};
assert.deepEqual(routes(fallback),['review_source_observation','visual_review_contract','continuation_brief'],'ordered candidates retain fallback after IO inspection fails');
fallback.attempts.observation=2;assert.deepEqual(routes(fallback),['visual_review_contract','continuation_brief']);fallback.attempts.review=3;assert.deepEqual(routes(fallback),['continuation_brief']);fallback.attempts.model=10;assert.deepEqual(routes(fallback),[]);
const focused=fresh();focused.stage='copy_review';focused.error='Error: 已用完自动返修额度';focused.repairContext={revision:'current',author_self_check:[{id:'S2',status:'fix'}],repair:{status:'bound'}};
assert.deepEqual(routes(focused),['source_evidence_import','focused_independent']);focused.sourceEvidenceRecoveryOperation='saved';assert.deepEqual(routes(focused),['focused_author','focused_independent']);focused.repairContext.revision='stale';assert.deepEqual(routes(focused),[]);
const structural=fresh();structural.error='Error: 已用完自动返修额度';structural.repairContext={revision:'current'};assert.deepEqual(routes(structural),['focused_structure'],'missing issue must not fall through to an unrelated checkpoint recovery');
const checkpoint=fresh();checkpoint.error='Error: copy_scope_incomplete';const before=structuredClone(checkpoint);assert.deepEqual(routes(checkpoint),['author_checkpoint']);assert.deepEqual(checkpoint,before,'selection cannot mutate counters/authority');
checkpoint.error='Error: picture_plan_revisits_mismatch';assert.deepEqual(routes(checkpoint,0),[]);assert.deepEqual(routes(checkpoint,1),['author_checkpoint']);checkpoint.error='Error: picture_plan_unknown';assert.deepEqual(routes(checkpoint),[]);
checkpoint.error='Error: tool failed (revise_clipmentor_analysis: delivery_sections_invalid)';assert.deepEqual(routes(checkpoint,0),['author_checkpoint']);checkpoint.deliveryDraftRecoveryUsed=true;assert.deepEqual(routes(checkpoint),[]);
checkpoint.error='Error: tool failed (read_clipmentor_source_video: Cannot read/bind saved source receipt; no model request sent).';assert.deepEqual(routes(checkpoint),['author_checkpoint']);delete checkpoint.deliveryDraftRecoveryUsed;assert.deepEqual(routes(checkpoint),[]);
checkpoint.error='Error: tool failed (read_clipmentor_analysis: storyboard_current_plan_unavailable).';checkpoint.authorCheckContractRevision=2;assert.deepEqual(routes(checkpoint),['author_checkpoint']);delete checkpoint.authorCheckContractRevision;assert.deepEqual(routes(checkpoint),[]);
for(const status of ['queued','running','cancelled','completed','awaiting_blueprint','awaiting_review'] as const){checkpoint.status=status;checkpoint.error='Error: copy_scope_incomplete';assert.deepEqual(routes(checkpoint),[]);}
const author=fresh();author.repairContext={audio_picture_repair:{groups:[]},pending_review_repair:{status:'bound'},author_self_check:[]};
assert.deepEqual(productionAuthorDecision(author,false),{mode:'picture_capacity',pictureOnly:true,independent:true,selfCheck:true},'priority must not erase pending independent obligations');
assert.equal(productionAuthorDecision(author,true).mode,'canvas_reflow');delete author.repairContext.audio_picture_repair;assert.equal(productionAuthorDecision(author,false).mode,'independent_review');delete author.repairContext.pending_review_repair;assert.equal(productionAuthorDecision(author,false).mode,'author_self_check');delete author.repairContext.author_self_check;assert.equal(productionAuthorDecision(author,false).mode,'ordinary');author.stage='edit';assert.equal(productionAuthorDecision(author,false).mode,'ordinary');
for(const status of ['reserved','failed','completed'] as const){const old={kind:'render' as const,operationId:'saved',status};for(const recovery of [false,true])assert.equal(productionEffectDecision(old,recovery,0).action,status==='completed'?'reuse':recovery?'recover':'stop');}
assert.equal(productionEffectDecision(undefined,true,0).action,'stop');assert.equal(productionEffectDecision(undefined,false,1).action,'submit');
const progress=fresh();assert.equal(productionRecoveryProgress(progress,{stage:'copy_review',repairs:0},['blueprint','copy_review']),false);progress.repairs++;assert.equal(productionRecoveryProgress(progress,{stage:'copy_review',repairs:0},['blueprint','copy_review']),true);
const privateTask=fresh();privateTask.repairContext={secret:'PRIVATE_REASON'};privateTask.error='PRIVATE_ERROR';privateTask.effects.secret={kind:'review',operationId:'op',status:'completed',result:{secret:'PRIVATE_RESPONSE'}};
const event=productionDecisionEvent(privateTask,{scope:'effect',action:'reuse',reason:'effect_result_saved',effectKey:'PRIVATE_KEY',operationId:'op',extra:'PRIVATE_EXTRA'} as never);
const serialized=JSON.stringify(event);assert(!serialized.includes('PRIVATE'));assert(!serialized.includes('private briefing'));assert.equal(event.operationId,'op');assert.equal(event.effectKeySha256?.length,64);privateTask.attempts.model++;assert.equal(event.attempts.model,0);
// Two variants keep one original confirmation even after independent revisions.
const parent=fresh(),producer=fresh(),follower=fresh();
producer.taskId='producer';producer.projectId='producer-project';follower.taskId='follower';follower.projectId='follower-project';
producer.input.panelDelivery={audience:'existing_partner'} as never;follower.input.panelDelivery={audience:'new_contact'} as never;
for(const t of [producer,follower])t.blueprintApproval={sourceProjectId:parent.projectId,sourceTaskId:parent.taskId,sourceRevision:'original-confirmation',digest:'own-digest',requirementsDigest:'own-requirements',confirmedAt:1};
follower.sharedProduction={projectId:producer.projectId,taskId:producer.taskId};
parent.productionChildren=[producer,follower].map(t=>({projectId:t.projectId,taskId:t.taskId,audience:t.input.panelDelivery!.audience!}));
assert(productionOutputsMatch(parent,[producer,follower]));
producer.projectRevision='producer-v3';follower.projectRevision='follower-v2';parent.projectRevision='later-parent-draft';
assert(productionOutputsMatch(parent,[producer,follower]),'current revision drift cannot invalidate an originally confirmed independent output');
producer.sharedProduction={projectId:follower.projectId,taskId:follower.taskId,prepared:true,endFrame:10,digest:'body'};
assert(productionOutputsMatch(parent,[producer,follower]));
for(const change of [
 (p:ProductionTask,_a:ProductionTask,_b:ProductionTask)=>{p.productionChildren![0].audience='new_contact';},
 (_p:ProductionTask,a:ProductionTask,b:ProductionTask)=>{b.projectId=a.projectId;},
 (_p:ProductionTask,_a:ProductionTask,b:ProductionTask)=>{b.blueprintApproval!.sourceRevision='another-confirmation';},
 (_p:ProductionTask,_a:ProductionTask,b:ProductionTask)=>{b.blueprintApproval!.sourceTaskId='another-parent';},
 (_p:ProductionTask,_a:ProductionTask,b:ProductionTask)=>{delete b.sharedProduction;},
 (_p:ProductionTask,a:ProductionTask)=>{a.sharedProduction!.taskId='another-producer';},
 (_p:ProductionTask,_a:ProductionTask,b:ProductionTask)=>{b.input.sourceAssetId='another-source';},
]){const p=structuredClone(parent),a=structuredClone(producer),b=structuredClone(follower);change(p,a,b);assert(!productionOutputsMatch(p,[a,b]));}
// Real event store and checkpoint replay: fixture providers only, isolated persistent profile.
const root=await mkdtemp(join(tmpdir(),'cm-decisions-'));const previous=process.env.OPENCHATCUT_DATA_DIR;process.env.OPENCHATCUT_DATA_DIR=root;
const {resetServerRunStoreForTest}=await import('../agent-runs/store');
const {resetAgentRuntimeStoreMemory,loadAgentRuntimeSidecar}=await import('../../src/persist/agentRuntimeStore');
const {resetSharedKvMemory}=await import('../../src/persist/sharedKv');
const {recordProductionDecision,advanceProductionTask,createProductionTask,productionTaskStore}=await import('./production-task');
const {activateOfflineAgentRuntimeBackend}=await import('../external-agent/agent-runtime-persistence');activateOfflineAgentRuntimeBackend();
try{
 let t=await createProductionTask(input);
 let submits=0;
 await advanceProductionTask(t,async(task,ctx)=>{if(task.stage==='analysis'){await ctx.effect('model','fixture',async()=>{submits++;return {saved:'private-result'};});throw Error('fixture crash after effect, before stage checkpoint');}return {artifact:{saved:true}};});
 assert.equal(submits,1);assert.equal(t.status,'blocked');
 const savedEffect=structuredClone(t.effects),identity={projectId:t.projectId,taskId:t.taskId};
 resetServerRunStoreForTest();resetAgentRuntimeStoreMemory();resetSharedKvMemory();activateOfflineAgentRuntimeBackend();
 t=await productionTaskStore.load(identity.projectId,identity.taskId);
 assert.deepEqual(t.effects,savedEffect);
 await advanceProductionTask(t,async(task,ctx)=>{if(task.stage==='analysis'){await ctx.effect('model','fixture',async()=>{submits++;throw Error('duplicate');});}return {artifact:{revision:'current',authorSelfCheck:'passed',gate:{allowed:true}}};});
 assert.equal(submits,1);assert.deepEqual(t.effects,savedEffect);assert.equal(t.attempts.model,1);assert.equal(t.status,'awaiting_blueprint','replay cannot skip human review');
 await recordProductionDecision(t,{scope:'recovery',action:'stop',reason:'no_verified_progress',fromStage:'copy_review',fromEpoch:0});
 await recordProductionDecision({...t,projectId:'different-project'},{scope:'author',action:'select',reason:'ordinary'});
 let sidecar=await loadAgentRuntimeSidecar(input.projectId);
 const run=sidecar.runs.find(r=>r.runId===t.taskId)!;
 const terminalEvents=run.events.map(e=>JSON.parse(e.summary??'{}').serverEvent).filter(Boolean);
 assert.equal(terminalEvents.at(-1).type,'done','diagnostics must not reopen terminal transport');
 const records=run.events.map(e=>JSON.parse(e.summary??'{}').productionDecision).filter(Boolean);
 assert(records.some(e=>e.action==='submit'&&e.operationId));assert(records.some(e=>e.action==='reuse'&&e.operationId));assert(records.some(e=>e.reason==='no_verified_progress'));
 assert(records.every(e=>e.projectId===input.projectId));assert(!JSON.stringify(records).includes('private-result'));
 const artifactCount=sidecar.artifacts.length,attempts=structuredClone(t.attempts);
 const timed:number[]=[];
 for(let i=0;i<260;i++){const started=performance.now();await recordProductionDecision(t,{scope:'recovery',action:'stop',reason:'no_verified_progress',fromStage:'blueprint',fromEpoch:i});timed.push(performance.now()-started);}
 const sorted=timed.toSorted((a,b)=>a-b);console.log(JSON.stringify({diagnosticWrites:timed.length,p50Ms:sorted[130],p95Ms:sorted[247],maxMs:sorted.at(-1),scope:'isolated real local persistence, no provider'}));
 sidecar=await loadAgentRuntimeSidecar(input.projectId);
 assert.equal(sidecar.artifacts.length,artifactCount,'diagnostics cannot consume production artifact slots');
 assert(sidecar.runs.find(r=>r.runId===t.taskId)!.events.length<=192,'existing diagnostic retention is bounded');
 await productionTaskStore.save(t);assert.deepEqual((await productionTaskStore.load(t.projectId,t.taskId)).attempts,attempts);
 // Original adversarial counterexample: diagnostics must leave the last
 // artifact slot available even when no old task history can be compacted.
 const edge=await createProductionTask({...structuredClone(input),projectId:'decision-near-quota'});
 const {getRun,setRunStatus}=await import('../agent-runs/store');await setRunStatus(getRun(edge.taskId)!,'failed');
 const {storeAgentArtifact}=await import('../../src/persist/agentRuntimeStore');const {createHash}=await import('node:crypto');
 const body='{}',hash=createHash('sha256').update(body).digest('hex');
 for(let i=0;i<254;i++)assert(await storeAgentArtifact({version:1,artifactId:'q_'+String(i).padStart(18,'0'),projectId:edge.projectId,runId:edge.taskId,kind:'checkpoint-source',toolName:'fixture-aux',body,bodySha256:hash,originalBytes:2,originalChars:2,createdAt:Date.now(),redacted:false,binaryOmitted:false}));
 assert.equal((await loadAgentRuntimeSidecar(edge.projectId)).artifacts.length,255);
 await recordProductionDecision(edge,{scope:'author',action:'select',reason:'ordinary'});
 assert.equal((await loadAgentRuntimeSidecar(edge.projectId)).artifacts.length,255);
 await productionTaskStore.save(edge);assert.equal((await loadAgentRuntimeSidecar(edge.projectId)).artifacts.length,256);
 assert.equal((await productionTaskStore.load(edge.projectId,edge.taskId)).taskId,edge.taskId);
 console.log('PASS production decisions: ordered routes, overlapping obligations, immutable budgets, persisted cold task replay, safe bounded events, 260-event pressure; zero provider calls');
}finally{resetServerRunStoreForTest();resetAgentRuntimeStoreMemory();resetSharedKvMemory();if(previous===undefined)delete process.env.OPENCHATCUT_DATA_DIR;else process.env.OPENCHATCUT_DATA_DIR=previous;await rm(root,{recursive:true,force:true});}
