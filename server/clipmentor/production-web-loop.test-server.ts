/** TEST ONLY. Real panel HTTP/store contracts; synthetic media and deterministic offline worker.
 * This proves UI handoff, not Agent judgment, teaching quality, or real production. */
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {once} from 'node:events';
import {readFile,mkdir,readdir} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root=process.env.CLIPMENTOR_WEB_TEST_DATA;
if(!root||dirname(resolve(root))!==resolve(tmpdir())||!basename(root).startsWith('cm-web-loop-')||(await readdir(root)).length)throw Error('Explicit empty temporary CLIPMENTOR_WEB_TEST_DATA is required');
process.env.OPENCHATCUT_DATA_DIR=root;
// No runtime/profile-dependent module may be statically imported above this line.
const {runtimeProfile}=await import('../runtime-profile');assert.equal(runtimeProfile().rootDir,root);
const {setStoredEntry}=await import('../plugins/project-store');
const {loadOfflineStoredProject}=await import('../external-agent/offline-project-store');
const {activateOfflineAgentRuntimeBackend}=await import('../external-agent/agent-runtime-persistence');activateOfflineAgentRuntimeBackend();
const {createProductionTask,productionTaskStore,latestPanelProductionTask,advanceProductionTask,cancelProductionTask}=await import('./production-task');
const {createProductionPanel}=await import('./production-panel');
const {createMaterialIntakeHandler}=await import('./material-intake');
const {copyReviewSubject,copyTeachingPacketFromDoc,bindCopyProductionReview,checkCopyProduction}=await import('../../src/clipmentor/production-gate');
const {reviewClipMentorCopy}=await import('./copy-review');
const {feedbackProjectDigest}=await import('./production-feedback');
const {ffmpegBin}=await import('../media-binaries');
const {extractOneFrame}=await import('../plugins/extract-frames');
const {uploadDir}=await import('../media-dir');
const fixture=JSON.parse(await readFile(new URL('../../src/clipmentor/fixtures/production-saved-projects-20261028.json',import.meta.url),'utf8'));
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
let doc=structuredClone(fixture.cases[0].doc);
const frozen=structuredClone(doc.clipMentorAnalysis.production_copy_review);
const media=uploadDir();await mkdir(media,{recursive:true});
// Keep the historical packet structure; replace every media identity with generated test bytes.
for(const asset of doc.assets.filter((a:any)=>a.kind==='video'||a.kind==='image')){
 const file=join(media,asset.src.split('/').at(-1));
 if(asset.kind==='video')execFileSync(ffmpegBin(),['-v','error','-y','-f','lavfi','-i','testsrc2=s=96x160:r=30','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t',String(asset.durationInFrames/30),'-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac',file]);
 else execFileSync(ffmpegBin(),['-v','error','-y','-f','lavfi','-i',`color=c=navy:s=${asset.width}x${asset.height}`,'-frames:v','1',file]);
 const old=asset.sourceContentHash,replacement=hash(await readFile(file));
 if(old)doc=JSON.parse(JSON.stringify(doc).replaceAll(old,replacement));
}
// Supplement only the historical test fixture's display timeline. It does not alter execution phases.
const ir=doc.clipMentorAnalysis.blueprint[0].internal_review,phases=ir[ir.current_picture_plan].phases;
doc.estimated_picture_timeline={rows:[{unit_id:doc.clipMentorAnalysis.blueprint[0].unit_id,kind:'original',source_range_seconds:[0,doc.clipMentorAnalysis.source.duration_seconds],line_ids:[],picture:'合成原片协议样本'},...phases.map((p:any)=>({unit_id:doc.clipMentorAnalysis.blueprint[0].unit_id,kind:'explanation',source_range_seconds:p.source_seconds,line_ids:[p.line_id],picture:p.picture}))]};
let original=doc.assets.find((a:any)=>a.id===doc.clipMentorAnalysis.source.asset_id);
const inputs={source:join(media,original.src.split('/').at(-1)),product:join(root,'product.png'),sales:join(root,'sales.png'),cta:join(root,'cta.png')};
for(const [key,color] of [['product','red'],['sales','blue'],['cta','green']] as const){
 execFileSync(ffmpegBin(),['-v','error','-y','-f','lavfi','-i',`color=c=${color}:s=64x64`,'-frames:v','1',inputs[key]]);
}
let fakeReviewerCalls=0,providerCalls=0;const actions:any[]=[],workerEvents:any[]=[],activeIds=new Set<string>();
// Any accidental external service call is a hard failure. Local test HTTP uses node:http, not fetch.
globalThis.fetch=async()=>{providerCalls++;throw Error('Real network/provider calls forbidden in web-loop fixture');};
async function bindOfflineReview(){
 delete doc.clipMentorAnalysis.production_copy_review;
 const subject=await copyReviewSubject(doc),packet=await copyTeachingPacketFromDoc(doc),source=doc.clipMentorAnalysis.source;
 const request={operationId:randomUUID(),maxRequests:1,projectId:'web-loop-fixture',authorRunId:'offline-fixture-author',
  source:{src:original.src,hash:source.sourceContentHash,fps:source.fps,duration:source.duration_seconds},
  subject:{revision:subject.revision,digest:subject.digest,units:subject.units.map(u=>({unit_id:u.unit_id,candidate_id:u.candidate_id}))},packet};
 const result=await reviewClipMentorCopy(request,{directory:join(root,'offline-review'),resolve:name=>join(media,name),hash:async file=>hash(await readFile(file)),frame:async(file,seconds,output,crop)=>{await extractOneFrame(file,Math.floor(seconds*1000),output,false,crop);return(await readFile(output)).toString('base64');},
  runtime:{method:'offline-web-loop-fixture',model:'frozen-response',inlineFrames:true},run:async()=>{fakeReviewerCalls++;return{cases:[{case_id:'current',units:frozen.teaching_review.review.units}],copy_units:frozen.units};}});
 doc.clipMentorAnalysis.production_copy_review=await bindCopyProductionReview(doc,result.receipt);
 const gate=await checkCopyProduction(doc,'clipmentor');assert.equal(gate.allowed,true,JSON.stringify(gate));
}
const project='web-loop-fixture';
const initial=structuredClone(doc);delete initial.clipMentorAnalysis;delete initial.estimated_picture_timeline;
initial.assets=[];for(const timeline of initial.timelines)timeline.items=[];
await setStoredEntry('project:'+project,initial);
const input={projectId:project,sourceAssetId:original.id,product:{name:'网页闭环测试',category:'test'},brief:'Synthetic protocol replay only',author:{provider:'openai',model:'offline-fixture',apiMode:'responses'},reviewer:{provider:'openai',model:'offline-fixture',apiMode:'responses'},budget:{model:20,review:0,observation:0,tts:0,render:0,maxElapsedMs:600000,maxRepairs:1},humanBlueprintReview:true};
async function readyBlueprint(task:any){task.status='awaiting_blueprint';task.stage='copy_review';delete task.error;task.projectRevision=(await loadOfflineStoredProject(project))!.revision;task.completed.copy_review={at:Date.now(),artifact:{revision:task.projectRevision,authorSelfCheck:'passed',gate:await checkCopyProduction(doc,'clipmentor')}};await productionTaskStore.save(task);}
const intake=createMaterialIntakeHandler();
let bootstrap:Promise<void>|undefined;
let cancelledState='',recoveredEffects=0;
async function prepareUploadedFixture(){
 const uploaded=(await loadOfflineStoredProject(project))!.doc.assets;
 assert.equal(uploaded.length,4);
 const master=uploaded[0];
 assert.equal(master.sourceContentHash,original.sourceContentHash);
 assert.equal(master.sourceContentHash,hash(await readFile(inputs.source)));
 doc=JSON.parse(JSON.stringify(doc).replaceAll(JSON.stringify(original.id),JSON.stringify(master.id))
  .replaceAll(JSON.stringify(original.src),JSON.stringify(master.src)));
 doc.assets=[...uploaded,...doc.assets.filter((asset:any)=>asset.id!==master.id)];
 original=master;input.sourceAssetId=master.id;
 const cancelled=await createProductionTask(input as any);
 const entered=Promise.withResolvers<void>();
 const running=advanceProductionTask(cancelled,async(_task,stage)=>{
  entered.resolve();
  await new Promise<void>((_,reject)=>stage.signal.addEventListener('abort',()=>reject(stage.signal.reason),{once:true}));
  throw Error('cancel fixture should never continue');
 });
 await entered.promise;await cancelProductionTask(cancelled);
 cancelledState=(await running).status;assert.equal(cancelledState,'cancelled');
 const parent=await createProductionTask(input as any);
 const operation=randomUUID();
 parent.status='running';parent.attempts.model=1;
 parent.effects['analysis:initial:0:fixture-author']={kind:'model',operationId:operation,status:'reserved'};
 await productionTaskStore.save(parent);
 const cold=await productionTaskStore.load(project,parent.taskId);
 await advanceProductionTask(cold,async(task,stage)=>{
  if(task.stage!=='analysis')throw Error('fixture handoff to deterministic blueprint');
  const saved=await stage.effect('model','fixture-author',async()=>{throw Error('duplicate provider submission');},async id=>{
   assert.equal(id,operation);recoveredEffects++;return 'saved fixture result';
  });
  return {artifact:{saved}};
 });
 assert.equal(recoveredEffects,1);assert.equal(cold.attempts.model,1);
 await bindOfflineReview();
 await setStoredEntry('project:'+project,doc);
 await readyBlueprint(cold);
}
for(const [audience,color] of [['existing_partner','navy'],['new_contact','maroon']] as const)
 execFileSync(ffmpegBin(),['-v','error','-y','-f','lavfi','-i',`color=c=${color}:s=720x1280:r=10`,'-t','1','-c:v','libx264','-pix_fmt','yuv420p',join(media,`web-loop-synthetic-${audience}.mp4`)]);
let previewSequence=0;
async function readyPreview(task:any){
 const saved=(await loadOfflineStoredProject(task.projectId))!;
 const file=`web-loop-synthetic-${task.input.panelDelivery.audience}.mp4`,path='/media/uploads/'+file;
 task.status='awaiting_review';task.stage='self_check';task.projectRevision=saved.revision;
 task.completed.export={at:Date.now(),artifact:{revision:saved.revision,renderId:'fixture-'+task.taskId+'-'+(++previewSequence),path,feedback_project_digest:feedbackProjectDigest(saved.doc),facts_digest:'a'.repeat(64)}};
 task.completed.self_check={at:Date.now(),artifact:{preview:path,receipt:{projectId:task.projectId,videoSha256:hash(await readFile(join(media,file))),status:'completed',scope:'rendered_preview_continuous_review',full_film_accepted:false,effective_review:{status:'pass',can_use_as_pass:true,blockers:[],manifest_binding:'frozen_at_request'},timeline_check:{status:'no_detected_conflict'}}}};
 await productionTaskStore.save(task);
}
function launch(task:any){activeIds.add(task.taskId);void(async()=>{
 workerEvents.push({task:task.taskId,project:task.projectId,stage:task.stage,fixtureWorker:true});
 if(task.projectId===project&&task.stage==='blueprint'){
  assert.equal(task.blueprintFeedback,'把标题改成修订后测试');doc.name='修订后测试';doc.clipMentorAnalysis.product.name='修订后测试';doc.clipMentorAnalysis.revision++;
  await bindOfflineReview();await setStoredEntry('project:'+project,doc);await readyBlueprint(task);
 }else if(task.projectId===project&&task.stage==='audio'){
  const children=[];
  for(const audience of ['existing_partner','new_contact']){
   const childProject=project+'-'+audience;await setStoredEntry('project:'+childProject,doc);
   const child=await createProductionTask({...input,projectId:childProject,panelDelivery:{audience,productAssetId:'fixture-product',productAssetHash:'a'.repeat(64),salesAssetId:'fixture-sales',ctaAssetId:'fixture-cta',ctaAssetHash:'b'.repeat(64)}} as any);
   child.blueprintApproval={sourceProjectId:project,sourceTaskId:task.taskId,sourceRevision:task.projectRevision,digest:'a'.repeat(64),requirementsDigest:'b'.repeat(64),confirmedAt:Date.now()};
   child.stage='edit';child.status='running';await productionTaskStore.save(child);activeIds.add(child.taskId);children.push({projectId:childProject,taskId:child.taskId,audience});
   workerEvents.push({task:child.taskId,project:child.projectId,stage:'edit',fixtureWorker:true});
  }
  task.productionChildren=children;task.status='awaiting_review';await productionTaskStore.save(task);
  await new Promise(resolve=>setTimeout(resolve,800));
  for(const entry of children){const child=await productionTaskStore.load(entry.projectId,entry.taskId);await readyPreview(child);activeIds.delete(child.taskId);}
 }else{assert.equal(task.feedback,'只调整片尾留白');await readyPreview(task);}
 })().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>activeIds.delete(task.taskId));}
const panel=createProductionPanel(launch,id=>activeIds.has(id));
let origin='';
const server=createServer(async(req,res)=>{try{
 const url=new URL(req.url!,origin);
 if(!url.pathname.startsWith('/api/')&&url.pathname!=='/audit'){
  assert.equal(req.method,'GET','Only GET static assets may reach the existing frontend service');
  const upstream=httpRequest({hostname:'127.0.0.1',port:5173,path:req.url,method:'GET'},response=>{res.writeHead(response.statusCode??502,response.headers);response.pipe(res);});
  upstream.on('error',error=>{res.statusCode=502;res.end(String(error));});upstream.end();return;
 }
 if(url.pathname==='/api/clipmentor/fixture-requirements'){
  assert.equal(req.method,'POST');let text='';for await(const chunk of req)text+=chunk;
  const {enabled}=JSON.parse(text),{registerHandoff,handoffKey}=await import('./handoff');
  if(enabled){
   const saved=(await loadOfflineStoredProject(project))!;
   await registerHandoff({projectId:project,expectedProjectRevision:saved.revision,previousDigest:null,brief:{version:1,briefId:'board-identity-fixture',revision:1,
    mode:'autonomous',phase:'planning',planner:'builtin_agent',executor:'builtin_agent',projectId:project,timelineId:saved.doc.activeTimelineId,
    objective:'Local HTTP board identity test',doneCriteria:['Changed fixture requirement'],blueprint:null,
    budget:{maxModelTurns:0,maxToolCalls:0,maxElapsedMs:10000,paidToolCalls:{}}}});
  }else{const {withSerializedProjectStore}=await import('../plugins/project-store');await withSerializedProjectStore(store=>store.removeEntry(handoffKey(project)));}
  res.setHeader('content-type','application/json');res.end(JSON.stringify({fixtureOnly:true}));return;
 }
 if(url.pathname==='/audit'){res.setHeader('content-type','application/json');res.end(JSON.stringify({project,root,inputs,providerCalls,fakeReviewerCalls,actions,workerEvents,cancelledState,recoveredEffects}));return;}
 if(url.pathname==='/api/clipmentor/intake'){
  req.url='/api/clipmentor/material-intake?projectId='+project;
  const uploaded=intake(req,res);
  if(req.method==='POST'&&!bootstrap){
   const prepared=uploaded.then(async()=>{
    if(res.statusCode===200)await prepareUploadedFixture();
    else if(bootstrap===prepared)bootstrap=undefined;
   });
   bootstrap=prepared;
   void prepared.catch(error=>console.error('Fixture preparation failed',error));
  }
  await uploaded;
  return;
 }
 assert.equal(url.pathname,'/api/clipmentor/production');
 await bootstrap;
 let body:Record<string,unknown>|undefined;
 const readBody=async()=>{if(body)return body;let text='';for await(const chunk of req)text+=chunk;return body=JSON.parse(text);};
 if(req.method==='POST'){const payload=await readBody(),current=await latestPanelProductionTask(project),target=current?.productionChildren?.find(child=>child.audience===url.searchParams.get('audience'));const action={project:target?.projectId??project,taskId:target?.taskId??current?.taskId,query:url.search,action:payload.action,revision:payload.revision,renderId:payload.renderId,status:0};actions.push(action);res.once('finish',()=>{action.status=res.statusCode;});}
 if(!url.searchParams.has('view'))url.searchParams.set('view','panel');
 await panel(project,origin,url.searchParams,req,res,readBody);
 }catch(error){res.statusCode=409;res.setHeader('content-type','application/json');res.end(JSON.stringify({error:String(error)}));}});
server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address==='object');origin=`http://127.0.0.1:${address.port}`;
console.log(JSON.stringify({ready:true,origin,project,profile:runtimeProfile().rootDir,fixtureWorker:true,providerCalls}));
process.on('SIGTERM',()=>server.close(()=>process.exit()));
