import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { createMiniConnect } from '../../desktop/mini-connect';
import { resetAgentRuntimeStoreMemory } from '../../src/persist/agentRuntimeStore';
import type { ProductionTask } from '../clipmentor/production-task';

export async function verifyProductionColdStart(
 panelTask:ProductionTask,suppliedScope:NonNullable<ProductionTask['input']['panelDelivery']>,
){
 const {createProductionTask,productionTaskStore}=await import('../clipmentor/production-task');
 const {flushServerRunPersistence,resetServerRunStoreForTest}=await import('../agent-runs/store');
 const {clipMentorProductionPlugin}=await import('./clipmentor-production');
 const {setStoredEntry}=await import('./project-store');
 const {projectDoc}=await import('../external-agent/offline-runtime.verify-fixtures');
 const {continuationBrief}=await import('../clipmentor/production-continuation');
 const recoveryInput={...panelTask.input,budget:{...panelTask.input.budget,model:1,maxElapsedMs:60_000}};
 const makeCheckpoint=async(projectId:string,status:typeof panelTask.status)=>{
  const item=await createProductionTask({...recoveryInput,projectId});
  item.status=status;
  return item;
 };
 const queued=await makeCheckpoint('queued-fixture','queued');
 const resumed=await makeCheckpoint('resume-fixture','running');
 const unknown=await makeCheckpoint('unknown-fixture','running');
 const cancelled=await makeCheckpoint('cancel-fixture','cancelled');
 const blockedTask=await makeCheckpoint('blocked-fixture','blocked');
 const deleted=await makeCheckpoint('deleted-fixture','queued');
 const legacyParent=await makeCheckpoint('legacy-output-parent','awaiting_blueprint');
 const removedParent=await makeCheckpoint('removed-output-parent','awaiting_blueprint');
 const supersededParent=await makeCheckpoint('superseded-output-parent','awaiting_blueprint');
 const badManifest=await makeCheckpoint('bad-output-parent','awaiting_blueprint');
 const partialParent=await makeCheckpoint('partially-deleted-parent','awaiting_blueprint');
 const bindOutput=async(parent:typeof panelTask,id:string,audience:'existing_partner'|'new_contact')=>{
  const child=await makeCheckpoint(id,'queued');
  child.stage='copy_review';
  child.input.panelDelivery={...suppliedScope,audience};
  child.input.brief=continuationBrief(child.input.product.name,audience);
  child.blueprintApproval={sourceProjectId:parent.projectId,sourceTaskId:parent.taskId,sourceRevision:'cold-source-r1',
   digest:'confirmed',requirementsDigest:'requirements',confirmedAt:Date.now()};
  return child;
 };
 // Hold the actual HTTP worker before its next effect reservation.
 for(const boundary of ['valid','before_effect','stage_publish','stage_reload_failure'] as const){
  const p=await makeCheckpoint('mid-worker-parent-'+boundary,'awaiting_blueprint');
  const c=await bindOutput(p,'mid-worker-child-'+boundary,'existing_partner');
  p.productionChild={projectId:c.projectId,taskId:c.taskId,audience:'existing_partner'};
  await productionTaskStore.save(p);await productionTaskStore.save(c);
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let submissions=0;
  const midApp=createMiniConnect(error=>{throw error;});
  const midServer=createServer((req,res)=>midApp.handle(req,res));
  midServer.listen(0,'127.0.0.1');await once(midServer,'listening');
  const address=midServer.address();assert(address&&typeof address==='object');const url=`http://127.0.0.1:${address.port}`;
  const midPlugin=clipMentorProductionPlugin(async(item,context)=>{
   entered.resolve();await release.promise;
   await context.effect('model','held-author',async()=>{submissions++;return {fixture:true};});
   return {artifact:{revision:'r1',blueprint_digest:'confirmed',requirementsDigest:'requirements',authorSelfCheck:'passed',gate:{allowed:true},panelDeliveryVerified:true}};
  });
  (midPlugin.configureServer as (s:unknown)=>void)({httpServer:midServer,config:{server:{}},middlewares:{use:(route:string,fn:(req:IncomingMessage,res:ServerResponse)=>void)=>midApp.use(route,fn)}});
  const originalSave=productionTaskStore.save,originalLoad=productionTaskStore.load;let stageCrossed=false,failedReload=0;
  productionTaskStore.load=async(project,id)=>{
   if(boundary==='stage_reload_failure'&&stageCrossed&&project===c.projectId&&id===c.taskId&&failedReload<2){failedReload++;throw Error('fixture stage reload unavailable');}
   return originalLoad(project,id);
  };
  productionTaskStore.save=async(next,guards)=>{
   if(boundary.startsWith('stage_')&&next.taskId===c.taskId&&next.completed.copy_review&&!stageCrossed){
    stageCrossed=true;delete p.productionChild;await originalSave(p);
   }
   await originalSave(next,guards);
  };
  try{
   const response=await fetch(url+'/api/clipmentor/production-task',{method:'POST',headers:{Origin:url,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json'},body:JSON.stringify({action:'resume',projectId:c.projectId,taskId:c.taskId})});
   assert.equal(response.status,202);await entered.promise;
   if(boundary==='before_effect'){delete p.productionChild;await productionTaskStore.save(p);}
   release.resolve();
   // Wait on the worker's completion rather than letting a GET consume the
   // injected checkpoint-read failure intended for the stage publisher.
   const {productionExecutionActive}=await import('../clipmentor/production-task');
   for(let i=0;i<400&&productionExecutionActive(c.projectId,c.taskId);i++)await new Promise(resolve=>setTimeout(resolve,5));
   assert.equal(productionExecutionActive(c.projectId,c.taskId),false);
   let stopped=false;
   for(let i=0;i<200;i++){
    const res=await fetch(url+`/api/clipmentor/production-task?projectId=${c.projectId}&taskId=${c.taskId}`,{headers:{Origin:url,'Sec-Fetch-Site':'same-origin'}});
    if(!(await res.json()).executionActive){stopped=true;break;}
    await new Promise(resolve=>setTimeout(resolve,5));
   }
   assert(stopped,'held worker must finish before checking durable outcomes');
   const saved=await originalLoad(c.projectId,c.taskId);
   assert.equal(submissions,boundary==='before_effect'?0:1,'withdrawn publication cannot authorize a later worker effect');
   assert.equal(saved.attempts.model,boundary==='before_effect'?0:1,'submitted work preserves its original effect count');
   if(boundary.startsWith('stage_')){
    assert(stageCrossed);if(boundary==='stage_reload_failure')assert.equal(failedReload,2,'both acknowledgement recovery and publisher reload must fail to exercise safe checkpoint fallback');
    assert.equal(saved.projectRevision,c.projectRevision,'unpublished revision cannot survive checkpoint rollback');assert.equal(saved.completed.copy_review,undefined,'a withdrawn stage publication must not be recorded as completed');
    assert.equal(Object.values(saved.effects)[0].status,'completed','the real original effect result remains saved');
   }
  }finally{productionTaskStore.save=originalSave;productionTaskStore.load=originalLoad;release.resolve();await new Promise<void>((r,e)=>midServer.close(err=>err?e(err):r()));}
 }
 const legacyOutput=await bindOutput(legacyParent,'legacy-output-child','existing_partner');
 const removedOutput=await bindOutput(removedParent,'removed-output-child','existing_partner');
 const supersededOutput=await bindOutput(supersededParent,'superseded-output-child','existing_partner');
 const wrongExisting=await bindOutput(badManifest,'bad-existing-child','existing_partner');
 const wrongNew=await bindOutput(badManifest,'bad-new-child','new_contact');
 const liveOutput=await bindOutput(partialParent,'live-output-child','existing_partner');
 const deletedOutput=await bindOutput(partialParent,'deleted-output-child','new_contact');
 deletedOutput.status='awaiting_blueprint';
 const outputRef=(task:typeof panelTask)=>({projectId:task.projectId,taskId:task.taskId,audience:task.input.panelDelivery!.audience!});
 legacyParent.productionChild=outputRef(legacyOutput);
 removedParent.productionChild=outputRef(removedOutput);
 supersededParent.productionChild=outputRef(supersededOutput);
 badManifest.productionChildren=[{...outputRef(wrongExisting),audience:'new_contact'},outputRef(wrongNew)];
 wrongNew.sharedProduction={projectId:wrongExisting.projectId,taskId:wrongExisting.taskId};
 partialParent.productionChildren=[outputRef(liveOutput),outputRef(deletedOutput)];
 deletedOutput.sharedProduction={projectId:liveOutput.projectId,taskId:liveOutput.taskId};
 const outputFixtures=[legacyParent,legacyOutput,removedParent,removedOutput,supersededParent,supersededOutput,badManifest,wrongExisting,wrongNew,partialParent,liveOutput,deletedOutput];
 for(const item of outputFixtures)await productionTaskStore.save(item);
 const newParent=await makeCheckpoint(supersededParent.projectId,'awaiting_blueprint');await productionTaskStore.save(newParent);
 const prior=await makeCheckpoint(panelTask.projectId,'running');
 // Reproduce an older task saving a late checkpoint after the current one.
 prior.createdAt=panelTask.createdAt-1000;
 await productionTaskStore.save(panelTask);
 await productionTaskStore.save(prior);
 const {latestPanelProductionTask,productionExecutionActive}=await import('../clipmentor/production-task');
 assert.equal((await latestPanelProductionTask(panelTask.projectId))?.taskId,panelTask.taskId,
  'a late checkpoint from an earlier task must not reclaim the current panel');
 await flushServerRunPersistence();resetServerRunStoreForTest();
 const supersededRetry=await makeCheckpoint('superseded-retry-fixture','running');
 for(const item of [resumed,unknown,supersededRetry]){
  item.stage='blueprint';
  item.completed.analysis={at:Date.now(),artifact:{verifiedFixture:true}};
  item.effects['blueprint:initial:0:fixture']={kind:'model',operationId:item.taskId,status:'reserved'};
  item.attempts.model=1;
 }
 for(const item of [resumed,unknown,supersededRetry,cancelled,blockedTask])await productionTaskStore.save(item);
 const indexed=[...outputFixtures,panelTask,queued,resumed,unknown,supersededRetry,cancelled,blockedTask,deleted];
 for(const item of indexed)await setStoredEntry(`project:${item.projectId}`,projectDoc());
 await setStoredEntry('projects',indexed.map(item=>({
  id:item.projectId,name:'Cold recovery fixture',updatedAt:Date.now(),...([deleted,removedParent].includes(item)?{deletedAt:Date.now()}:{}),
 })));
 const {deleteStoredEntry}=await import('./project-store');
 await deleteStoredEntry('project:'+deletedOutput.projectId);
 await assert.rejects(productionTaskStore.load(deletedOutput.projectId,deletedOutput.taskId),/not found/i);
 await flushServerRunPersistence();resetServerRunStoreForTest();resetAgentRuntimeStoreMemory();
 const visited:string[]=[];
 let replayed:string|undefined,newSubmissions=0,leaseAttempts=0;
 let winningCheckpoint:typeof panelTask|undefined,supersededAttempts=0;
 const coldApp=createMiniConnect(error=>{throw error;});
 const coldServer=createServer((req,res)=>coldApp.handle(req,res));
 const coldPlugin=clipMentorProductionPlugin(async(item,stage)=>{
  visited.push(item.taskId);
  assert.equal(item.input.author.origin,item.input.reviewer.origin);
  if(item.stage==='analysis')assert.equal(item.taskId,queued.taskId,'completed stages must not be repeated');
  if(item.stage==='blueprint'&&item.taskId===resumed.taskId&&++leaseAttempts===1)throw Error('project_busy');
  if(item.taskId===supersededRetry.taskId&&++supersededAttempts===1){
   winningCheckpoint={...await productionTaskStore.load(item.projectId,item.taskId),status:'blocked',error:'other worker settled the checkpoint'};
   await productionTaskStore.save(winningCheckpoint);
   throw Error('project_busy');
  }
  if(item.stage==='blueprint'&&item.taskId!==queued.taskId)await stage.effect('model','fixture',async()=>{newSubmissions++;},item.taskId===resumed.taskId
   ?async id=>{replayed=id;return {saved:true};}:undefined);
  return {artifact:{verifiedFixture:true,revision:'recovered',authorSelfCheck:'passed',gate:{allowed:true},panelDeliveryVerified:true}};
 });
 (coldPlugin.configureServer as (s:unknown)=>void)({httpServer:coldServer,config:{server:{}},middlewares:{use:(route:string,fn:(req:IncomingMessage,res:ServerResponse)=>void)=>coldApp.use(route,fn)}});
 coldServer.listen(0,'127.0.0.1');await once(coldServer,'listening');
 try{
  // No browser or HTTP request is needed to resume a production task.
  for(let n=0;n<400;n++){
   const results=await Promise.all([queued,resumed,unknown,supersededRetry,legacyOutput,liveOutput].map(item=>productionTaskStore.load(item.projectId,item.taskId)));
   if(results.every(item=>['awaiting_blueprint','blocked'].includes(item.status))
    &&!productionExecutionActive(supersededRetry.projectId,supersededRetry.taskId))break;
   await new Promise(r=>setTimeout(r,5));
  }
  const restored=await productionTaskStore.load(resumed.projectId,resumed.taskId);
  const finished=await productionTaskStore.load(queued.projectId,queued.taskId);
  const unresolved=await productionTaskStore.load(unknown.projectId,unknown.taskId);
  const coldAddress=coldServer.address();assert(coldAddress&&typeof coldAddress==='object');
  assert.equal(restored.input.author.origin,`http://127.0.0.1:${coldAddress.port}`);
  assert.equal(restored.status,'awaiting_blueprint');assert.equal(finished.status,'awaiting_blueprint');
  assert.equal(restored.attempts.model,1);assert.equal(replayed,resumed.taskId);
  assert.equal(leaseAttempts,2);
  assert.equal(supersededAttempts,1,'another worker advancing the checkpoint during the lease wait cancels the stale retry');
  assert.deepEqual(await productionTaskStore.load(supersededRetry.projectId,supersededRetry.taskId),winningCheckpoint);
  assert.equal(unresolved.status,'blocked');assert.match(unresolved.error!,/no automatic resubmission/);
  assert.equal(unresolved.attempts.model,1);assert.equal(newSubmissions,0);
  assert.equal((await productionTaskStore.load(legacyOutput.projectId,legacyOutput.taskId)).status,'awaiting_blueprint','a valid historical manifest can still resume');
  assert.equal((await productionTaskStore.load(liveOutput.projectId,liveOutput.taskId)).status,'awaiting_blueprint','an available sibling can still resume');
  const coldPost=(task:typeof panelTask)=>fetch(`http://127.0.0.1:${coldAddress.port}/api/clipmentor/production-task`,{method:'POST',
   headers:{Origin:`http://127.0.0.1:${coldAddress.port}`,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json'},
   body:JSON.stringify({action:'resume',projectId:task.projectId,taskId:task.taskId})});
  for(const item of [removedOutput,supersededOutput,wrongExisting,wrongNew]){
   assert.equal((await coldPost(item)).status,409);
   assert.deepEqual(await productionTaskStore.load(item.projectId,item.taskId),item,'a separately indexed child cannot write or dispatch without a live and matching parent');
  }
  assert.equal((await coldPost(deletedOutput)).status,409);
  await assert.rejects(productionTaskStore.load(deletedOutput.projectId,deletedOutput.taskId),/not found/i);
  const parentUrl=`http://127.0.0.1:${coldAddress.port}/api/clipmentor/production-task?view=panel&projectId=${partialParent.projectId}`;
  const replay=await fetch(parentUrl,{method:'POST',headers:{Origin:`http://127.0.0.1:${coldAddress.port}`,
   'Sec-Fetch-Site':'same-origin','Content-Type':'application/json'},
   body:JSON.stringify({action:'produce_versions',revision:liveOutput.blueprintApproval!.sourceRevision})});
  assert.equal(replay.status,200,'retrying the parent action also tolerates the confirmed deletion');
  assert.deepEqual(new Set(visited),new Set([queued.taskId,resumed.taskId,unknown.taskId,supersededRetry.taskId,legacyOutput.taskId,liveOutput.taskId]));
 }finally{await new Promise<void>((r,e)=>coldServer.close(err=>err?e(err):r()));}
}
