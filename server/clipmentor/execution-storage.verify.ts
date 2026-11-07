// Real persisted transactions, isolated from the user's profile and production projects.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
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
 const {default:compositions}=await import('../../src/clipmentor/fixtures/production-saved-projects-20261028.json');
 const savedPlan=compositions.cases[0]!.doc as unknown as ProjectDoc;
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
  if(failExport)await assert.rejects(productionStageWorker(task,stage),/committed editing retained/);
  else{const result=await productionStageWorker(task,stage);assert.equal(result.artifact.revision,(await loadOfflineStoredProject(id))!.revision);assert.equal(typeof result.artifact.facts_digest,'string');}
  assert.equal(posts,1);assert.equal(polls,1);assert.deepEqual((await loadOfflineStoredProject(id))!.doc,accepted,'success/failure leaves the saved project unchanged');
 }
 console.log('Actual production export stage: saved approved fixture, releases project before polling, retains committed edits after job failure, snapshot revision/digest returned; fake jobs, zero renders');
 console.log('Execution storage: native preservation enforced at real commit for every entry, normal save/cold read, in-write rollback keeps document and versions; zero network/model/media changes');
}finally{
 globalThis.fetch=fetchBefore;if(previous===undefined)delete process.env.OPENCHATCUT_DATA_DIR;else process.env.OPENCHATCUT_DATA_DIR=previous;
 await rm(root,{recursive:true,force:true});
}
