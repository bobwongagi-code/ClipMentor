// Real persisted transactions, isolated from the user's profile and production projects.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,unlink,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import fixture from '../../src/agent/tools/fixtures/barely-there-mg-replacement-20261030.json';
import type {ProjectDoc} from '../../src/editor/types';
const root=await mkdtemp(join(tmpdir(),'execution-storage-')),previous=process.env.OPENCHATCUT_DATA_DIR,fetchBefore=globalThis.fetch;
process.env.OPENCHATCUT_DATA_DIR=root;globalThis.fetch=async()=>{throw Error('Network forbidden');};
try{
 const {setStoredEntry,getStoredEntry}=await import('../plugins/project-store');
 const {commitOfflineStoredProject,loadOfflineStoredProject}=await import('../external-agent/offline-project-store');
 const {claimOfflineProjectOwnership,releaseProjectEditOwnership}=await import('../external-agent/project-edit-ownership');
 const {openHeadlessEditor}=await import('./headless-editor');
 const id='isolated-execution',before=fixture.before as unknown as ProjectDoc;
 await setStoredEntry(`project:${id}`,before);await setStoredEntry('projects',[{id,name:'Test fixture',updatedAt:1}]);
 await setStoredEntry(`versions:${id}`,[]);
 const claim=await claimOfflineProjectOwnership(id,'fixture-owner');assert.equal(claim.status,'claimed');if(claim.status!=='claimed')throw Error('No claim');
 const native=claim.doc.timelines[0]!.items.find(i=>i.kind==='image'&&i.startFrame===0)!;assert(native);
 const damaged=structuredClone(claim.doc);damaged.timelines[0]!.items=damaged.timelines[0]!.items.filter(i=>i.id!==native.id);
 await assert.rejects(commitOfflineStoredProject({projectId:id,expectedRevision:claim.revision,ownership:claim.claim,doc:damaged,canCommit:()=>true}),/delivery_native_picture/);
 assert.deepEqual((await loadOfflineStoredProject(id))!.doc,claim.doc);assert.deepEqual((await getStoredEntry(`versions:${id}`)).value,[]);
 const lostSections=structuredClone(claim.doc);
 for(const u of lostSections.clipMentorAnalysis!.blueprint){const ir=(u as unknown as Record<string,unknown>).internal_review as Record<string,unknown>;delete(ir[String(ir.current_picture_plan)]as Record<string,unknown>).delivery_sections;}
 await assert.rejects(commitOfflineStoredProject({projectId:id,expectedRevision:claim.revision,ownership:claim.claim,doc:lostSections,canCommit:()=>true}),/delivery_sections_would_be_lost/);
 assert.deepEqual((await loadOfflineStoredProject(id))!.doc,claim.doc,'rejected metadata loss preserves the saved document');assert.deepEqual((await getStoredEntry(`versions:${id}`)).value,[],'rejected metadata loss creates no version');
 const repaired=structuredClone(claim.doc);repaired.timelines[0]!.name='Layout-only fixture';
 const committed=await commitOfflineStoredProject({projectId:id,expectedRevision:claim.revision,ownership:claim.claim,doc:repaired,canCommit:()=>true});
 assert.equal(committed.status,'applied');assert(committed.ownership);assert.equal((await loadOfflineStoredProject(id))!.doc.timelines[0]!.name,'Layout-only fixture');
 const previousDoc=JSON.stringify((await loadOfflineStoredProject(id))!.doc),previousVersions=JSON.stringify((await getStoredEntry(`versions:${id}`)).value);
 const late=structuredClone(repaired);late.timelines[0]!.name='Late write';let checks=0;
 const cancelled=await commitOfflineStoredProject({projectId:id,expectedRevision:committed.revision!,ownership:committed.ownership,doc:late,canCommit:()=>++checks<4});
 assert.equal(cancelled.status,'browser-takeover');assert.equal(JSON.stringify((await loadOfflineStoredProject(id))!.doc),previousDoc);
 assert.equal(JSON.stringify((await getStoredEntry(`versions:${id}`)).value),previousVersions,'failed commit retains versions and saved editing');
 await releaseProjectEditOwnership(committed.ownership);
 const editor=await openHeadlessEditor({projectId:id,runId:'fixture',origin:'http://127.0.0.1:5199',review:{provider:'openai',model:'fixture',origin:'http://127.0.0.1:5199',apiMode:'responses'},browserConnected:()=>false,
  effect:async()=>{throw Error('Provider effects forbidden');}});
 try{
  // This historical fixture carries a stale copy approval. The normal tool
  // entrance refuses it before commit; the direct commit assertion above
  // independently verifies the native picture guard.
  const blocked=await editor.execute('remove_item',{itemId:native.id},'remove-native') as {production_gate?:{allowed:boolean;code:string}};
  assert.equal(blocked.production_gate?.allowed,false);
  assert.equal(blocked.production_gate?.code,'copy_review_stale');
  assert.equal(JSON.stringify((await loadOfflineStoredProject(id))!.doc),previousDoc);
  assert.deepEqual((await getStoredEntry(`versions:${id}`)).value,JSON.parse(previousVersions));
 }finally{await editor.close();}
 // Exercise the actual production export stage, using an existing approved
 // project and a fake local job transport. No rendering or provider request.
 const {productionStageWorker}=await import('./production-worker');
 const {materializeHandoffVoice}=await import('./handoff-voice.verify-fixture');
 const profile=(await import('../runtime-profile')).runtimeProfile();
 assert.equal(profile.rootDir,root);
 const {default:compositions}=await import('../../src/clipmentor/fixtures/production-saved-projects-20261028.json');
 const savedPlan=structuredClone(compositions.cases[0]!.doc) as unknown as ProjectDoc;
 const audioFiles=[];
 for(const asset of savedPlan.assets.filter(asset=>asset.kind==='audio')){
  audioFiles.push(await materializeHandoffVoice(savedPlan,asset,profile.mediaDir));
 }
 const firstAudio=audioFiles[0]!;
 await setStoredEntry(`project:${id}`,savedPlan);
 const accepted=(await loadOfflineStoredProject(id))!.doc;
 for(const failExport of [false,true]){
  let posts=0,polls=0;
  globalThis.fetch=async(input,init)=>{
   const path=new URL(String(input)).pathname;
   if(path==='/export/job'&&init?.method==='POST'){
    posts++;const body=JSON.parse(String(init.body));assert.deepEqual(body.project,accepted);
    const {planExport}=await import('../plugins/export-plan');const plan=planExport(body);
    assert.equal(plan.projectRevision,(await loadOfflineStoredProject(id))!.revision);
    return Response.json({renderId:'fixture-job',projectRevision:plan.projectRevision,timelineId:plan.timelineId});
   }
   assert.equal(path,'/export/job/fixture-job');polls++;
   const editing=await claimOfflineProjectOwnership(id,'while-rendering');
   assert.equal(editing.status,'claimed','production worker must release editing before it polls the immutable export');
   if(editing.status==='claimed')await releaseProjectEditOwnership(editing.claim);
   return Response.json({id:'fixture-job',status:failExport?'failed':'succeeded',result:failExport?undefined:{path:'/media/uploads/fake.mp4'}});
  };
  const task={taskId:'export-fixture',projectId:id,stage:'export',input:{sourceAssetId:accepted.clipMentorAnalysis!.source.asset_id,
   author:{origin:'http://127.0.0.1:5199'},reviewer:{provider:'openai',model:'fixture',origin:'http://127.0.0.1:5199',apiMode:'responses'}}} as import('./production-task').ProductionTask;
  const stage={signal:new AbortController().signal,effect:async<T>(_kind:unknown,_key:string,work:(id:string)=>Promise<T>)=>work('fixture-job')};
  if(!failExport){
   await unlink(firstAudio.file);
   await assert.rejects(productionStageWorker(task,stage),/production_audio_file_missing/);
   assert.equal(posts,0);
   await writeFile(firstAudio.file,firstAudio.bytes);
  }
  if(failExport)await assert.rejects(productionStageWorker(task,stage),/committed editing retained/);
  else{const result=await productionStageWorker(task,stage);assert.equal(result.artifact.revision,(await loadOfflineStoredProject(id))!.revision);assert.equal(typeof result.artifact.facts_digest,'string');}
  assert.equal(posts,1);assert.equal(polls,1);assert.deepEqual((await loadOfflineStoredProject(id))!.doc,accepted,'success/failure leaves the saved project unchanged');
 }
 console.log('Actual production export stage: missing narration blocks submission, restored approved fixture exports, releases project before polling, retains committed edits after job failure; fake jobs, zero renders');

 // Lose the enqueue acknowledgement after a job receipt exists. Resume
 // through the persisted task with real job reads and promotion.
 const {advanceProductionTask,createProductionTask,productionTaskStore}=await import('./production-task');
 const {registerExportJobRoute}=await import('../plugins/export-job-routes');
 const {createGenerationJob}=await import('../plugins/generation-jobs');
 const {exportJobFilename}=await import('../plugins/export-runtime');
 const {createMiniConnect}=await import('../../desktop/mini-connect');
 const app=createMiniConnect(error=>{throw error;});
 registerExportJobRoute({middlewares:{use:(route:string,fn:Parameters<typeof app.use>[1])=>app.use(route,fn)},
  config:{logger:{warn:()=>undefined}}} as never);
 const server=createServer((req,res)=>app.handle(req,res));
 server.listen(0,'127.0.0.1');
 try{
  await once(server,'listening');
  const address=server.address();assert(address&&typeof address==='object');
  const origin=`http://127.0.0.1:${address.port}`;
  const config={provider:'openai' as const,model:'fixture',origin,apiMode:'responses' as const};
  const task=await createProductionTask({projectId:id,sourceAssetId:accepted.clipMentorAnalysis!.source.asset_id,
   author:config,reviewer:config,product:{name:'Export fixture',category:'fixture'},brief:'Recover saved export',
   budget:{model:0,review:0,observation:0,tts:0,render:1,maxElapsedMs:30_000,maxRepairs:0}});
  task.stage='export';
  const original=(await loadOfflineStoredProject(id))!;
  task.projectRevision=original.revision;
  const assetId=randomUUID(),name=exportJobFilename(assetId,'mp4'),temporary=join(profile.mediaDir,name);
  const publishedName=`openchatcut-derived-${assetId}.mp4`,published=join(profile.mediaDir,publishedName);
  const bytes=Buffer.from('complete synthetic export bytes');
  let operationId:string|undefined;
  let statusReads=0;
  let truncateAtPromotion=true;
  const wire:string[]=[];
  async function assertProjectLease(held:boolean){
   const competing=await claimOfflineProjectOwnership(id,'export-read-probe');
   if(competing.status==='claimed')await releaseProjectEditOwnership(competing.claim);
   assert.equal(competing.status==='claimed',!held,'enqueue and identity recovery hold the lease; polling and promotion release it');
  }
  globalThis.fetch=async(input,init)=>{
   const url=new URL(input instanceof Request?input.url:String(input)),method=init?.method??'GET';
   assert.equal(url.origin,origin,'only isolated local job routes are allowed');
   wire.push(`${method} ${url.pathname}`);
   if(method==='POST'&&url.pathname==='/export/job'){
    assert.equal(operationId,undefined,'a lost acknowledgement must never submit a second render');
    await assertProjectLease(true);
    const body=JSON.parse(String(init?.body));
    assert.deepEqual(body.project,original.doc);
    assert.equal(body.timelineId,original.doc.activeTimelineId);
    operationId=body.operationId;
    assert(operationId);
    const settled=Promise.withResolvers<void>();
    await createGenerationJob({kind:'export',projectRevision:original.revision,timelineId:body.timelineId},async()=>{
     await writeFile(temporary,bytes);
     return {assetId,path:'/media/uploads/'+name,kind:'video',name:'Fixture',sizeBytes:bytes.length};
    },{operationId,onSettled:()=>settled.resolve()});
    await settled.promise;
    throw Error('fixture enqueue acknowledgement lost');
   }
   assert(operationId);
   if(method==='GET'){
    assert.equal(url.pathname,'/export/job/'+operationId);
    await assertProjectLease(++statusReads===1);
   }else{
    assert.equal(method,'POST');
    assert.equal(url.pathname,`/export/job/${operationId}/promote`);
    await assertProjectLease(false);
    if(truncateAtPromotion){
     truncateAtPromotion=false;
     await writeFile(temporary,bytes.subarray(0,4));
    }
   }
   return fetchBefore(input,init);
  };
  let downstream=0;
  const run=(current:typeof task)=>advanceProductionTask(current,(item,stage)=>{
   if(item.stage==='export')return productionStageWorker(item,stage);
   assert.equal(item.stage,'self_check');
   downstream++;
   return Promise.resolve({artifact:{fixture:true}});
  });
  await run(task);
  let savedTask=await productionTaskStore.load(id,task.taskId);
  const effectKey='export:initial:0:export';
  assert.match(savedTask.error??'',/fixture enqueue acknowledgement lost/);
  assert.equal(savedTask.effects[effectKey].operationId,operationId);
  assert.equal(savedTask.effects[effectKey].status,'failed');
  assert.equal(savedTask.attempts.render,1);

  await writeFile(temporary,bytes.subarray(0,4));
  await run(savedTask);
  savedTask=await productionTaskStore.load(id,task.taskId);
  assert.match(savedTask.error??'',/Original render output is missing or incomplete/);
  assert.equal(savedTask.effects[effectKey].status,'completed','binding recovered even though delivery was refused');
  assert.equal(savedTask.completed.export,undefined);
  assert.equal(downstream,0);
  await assert.rejects(readFile(published),{code:'ENOENT'});
  const read='GET /export/job/'+operationId;
  assert.deepEqual(wire,['POST /export/job',read,read],'a truncated result never reaches promotion or resubmission');

  const promote=`POST /export/job/${operationId}/promote`;
  await writeFile(temporary,bytes);
  await run(savedTask);
  savedTask=await productionTaskStore.load(id,task.taskId);
  assert.match(savedTask.error??'',/Preview publication failed; saved render retained/);
  assert.equal(savedTask.completed.export,undefined);
  assert.equal(downstream,0);
  assert.equal(savedTask.attempts.render,1);
  await assert.rejects(readFile(published),{code:'ENOENT'});
  assert.deepEqual(wire,['POST /export/job',read,read,read,promote],'promotion rechecks the bytes after a successful status read');

  await writeFile(temporary,bytes);
  await run(savedTask);
  savedTask=await productionTaskStore.load(id,task.taskId);
  const output=savedTask.completed.export?.artifact;
  assert.equal(output?.path,'/media/uploads/'+publishedName);
  assert.equal(output?.renderId,operationId);
  assert.equal(output?.revision,original.revision);
  assert.equal(savedTask.attempts.render,1);
  assert.deepEqual(Object.keys(savedTask.effects),[effectKey]);
  assert.deepEqual(wire,['POST /export/job',read,read,read,promote,read,promote]);
  assert.deepEqual(await readFile(published),bytes);
  assert.deepEqual(await loadOfflineStoredProject(id),original);
  assert.equal(downstream,1);
  console.log('PASS export recovery: one fixture submission, exact render ID and lease order, truncation blocks status or promotion, intact bytes published once');
 }finally{
  await new Promise<void>((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});
 }
 console.log('Execution storage: native preservation enforced at real commit for every entry, normal save/cold read, in-write rollback keeps document and versions; zero network/model/media changes');
}finally{
 globalThis.fetch=fetchBefore;if(previous===undefined)delete process.env.OPENCHATCUT_DATA_DIR;else process.env.OPENCHATCUT_DATA_DIR=previous;
 await rm(root,{recursive:true,force:true});
}
