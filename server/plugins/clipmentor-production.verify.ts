import assert from 'node:assert/strict';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {once} from 'node:events';
import {createMiniConnect} from '../../desktop/mini-connect';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {resetSharedKvMemory} from '../../src/persist/sharedKv';
import {resetAgentRuntimeStoreMemory} from '../../src/persist/agentRuntimeStore';


const directory=await mkdtemp(join(tmpdir(),'production-task-http-'));
const previousData=process.env.OPENCHATCUT_DATA_DIR;process.env.OPENCHATCUT_DATA_DIR=directory;
const {createProductionTask,productionTaskStore}=await import('../clipmentor/production-task');
const {resetServerRunStoreForTest,flushServerRunPersistence}=await import('../agent-runs/store');
const {clipMentorProductionPlugin}=await import('./clipmentor-production');
assert.equal((await import('../runtime-profile')).runtimeProfile().rootDir,directory,'test storage must be resolved after isolation');
const {activateOfflineAgentRuntimeBackend}=await import('../external-agent/agent-runtime-persistence');
resetSharedKvMemory();resetAgentRuntimeStoreMemory();resetServerRunStoreForTest();activateOfflineAgentRuntimeBackend();
let release!:()=>void,started!:()=>void;
const blocked=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{started=r;});
const steps:string[]=[],batchSteps:string[]=[];
const plugin=clipMentorProductionPlugin(async(t)=>{if(t.sharedProduction?.prepared){batchSteps.push(`${t.input.panelDelivery?.audience}:${t.stage}`);return {artifact:{revision:t.projectRevision,blueprint_digest:t.blueprintApproval!.digest,requirementsDigest:t.blueprintApproval!.requirementsDigest,authorSelfCheck:'passed',gate:{allowed:true},panelDeliveryVerified:true,fixtureOnly:true}};}steps.push(t.stage);if(t.stage==='analysis'){started();await blocked;}return {artifact:{verifiedFixture:true}};});
const app=createMiniConnect(e=>{throw e;});
const server=createServer((req,res)=>app.handle(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');
const address=server.address();assert(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
(plugin.configureServer as (s:unknown)=>void)({httpServer:server,config:{server:{port:address.port}},middlewares:{use:(route:string,fn:(req:IncomingMessage,res:ServerResponse)=>void)=>app.use(route,fn)}});
const input={projectId:'production-fixture',sourceAssetId:'source',product:{name:'Fixture',category:'test'},brief:'zero provider task',
 author:{provider:'openai',model:'fixture',apiMode:'responses'},reviewer:{provider:'openai',model:'fixture',apiMode:'responses'},
 budget:{model:0,review:0,observation:0,tts:0,render:0,maxElapsedMs:10000,maxRepairs:0}};
const post=(body:unknown,authorized=true)=>fetch(`${origin}/api/clipmentor/production-task`,{method:'POST',headers:{'Content-Type':'application/json',...(authorized?{Origin:origin,'Sec-Fetch-Site':'same-origin'}:{})},body:JSON.stringify(body)});
try{
 assert.equal((await post({action:'create',input},false)).status,403);
 const res=await post({action:'create',input});assert.equal(res.status,202);const created=await res.json();await entered;
 // HTTP submit has finished. No SSE consumer or browser-tool result ever exists.
 const running=await productionTaskStore.load(input.projectId,created.taskId);assert.equal(running.status,'running');
 assert.equal((await post({action:'resume',projectId:input.projectId,taskId:created.taskId})).status,409);
 release();
 let task=running;
 for(let n=0;n<200;n++){task=await productionTaskStore.load(input.projectId,created.taskId);if(task.status==='awaiting_review')break;await new Promise(r=>setTimeout(r,5));}
 assert.equal(task.status,'awaiting_review');assert.equal(steps.length,7);assert.equal(task.attempts.model,0);
 for(let n=0;n<200;n++){const r=await fetch(`${origin}/api/clipmentor/production-task?projectId=${input.projectId}&taskId=${created.taskId}`,{headers:{Origin:origin,'Sec-Fetch-Site':'same-origin'}});if(!(await r.json()).executionActive)break;await new Promise(r=>setTimeout(r,5));}
 // Drop every in-memory run/sidecar cache; recover from the canonical persisted artifacts.
 await flushServerRunPersistence();resetServerRunStoreForTest();resetAgentRuntimeStoreMemory();activateOfflineAgentRuntimeBackend();
 const recovered=await productionTaskStore.load(input.projectId,created.taskId);assert.equal(recovered.status,'awaiting_review');assert.deepEqual(recovered.completed,task.completed);
 const get=await fetch(`${origin}/api/clipmentor/production-task?projectId=${input.projectId}&taskId=${created.taskId}`,{headers:{Origin:origin,'Sec-Fetch-Site':'same-origin'}});
 const readback=await get.json();assert.equal(get.status,200);assert.equal(readback.taskId,created.taskId);
 assert.equal(readback.blueprintReadiness.code,'project_missing');assert.equal(readback.blueprintReadiness.next,'blueprint');
 assert.equal(readback.blueprintReadiness.complete_film_accepted,false,'a completed mocked task cannot certify a missing project');
 assert.equal((await post({action:'accept',projectId:input.projectId,taskId:created.taskId,malayDeliveryConfirmed:false})).status,409);
 const accepted=await post({action:'accept',projectId:input.projectId,taskId:created.taskId,malayDeliveryConfirmed:true});assert.equal(accepted.status,200,JSON.stringify(await accepted.json()));
 const panelTask=await createProductionTask({...input,author:{...input.author,origin},reviewer:{...input.reviewer,origin},humanBlueprintReview:true} as Parameters<typeof createProductionTask>[0]);
 const panelGet=async()=>await (await fetch(`${origin}/api/clipmentor/production-task?view=panel&projectId=${input.projectId}`,{headers:{Origin:origin,'Sec-Fetch-Site':'same-origin'}})).json();
 for(const [error,reason] of [
  ['Error: 已用完自动返修额度。blueprint_stage_incomplete: private fixture','service'],
  ['Error: Production deadline exceeded','limit'],
  ['Error: Original upload unavailable','materials'],
 ]){
  panelTask.status='blocked';panelTask.error=error;await productionTaskStore.save(panelTask);
  const projected=(await panelGet()).task;
  assert.equal(projected.status,'blocked');assert.equal(projected.stopReason,reason);
  assert(!('blocked' in projected)&&!('error' in projected)&&!('canContinue' in projected));
  assert.equal((await productionTaskStore.load(panelTask.projectId,panelTask.taskId)).error,error);
 }
 panelTask.status='awaiting_blueprint';panelTask.stage='copy_review';panelTask.projectRevision='fixture-r1';delete panelTask.error;
 await productionTaskStore.save(panelTask);
 const projected=(await panelGet()).task;
 assert.equal(projected.status,'awaiting_blueprint');assert.equal(projected.revision,'fixture-r1');assert(!('stopReason' in projected));
 const {setStoredEntry}=await import('./project-store');
 const {projectDoc}=await import('../external-agent/offline-runtime.verify-fixtures');
 const {loadOfflineStoredProject}=await import('../external-agent/offline-project-store');
 await setStoredEntry(`project:${panelTask.projectId}`,projectDoc());
 const {default:boardFixture}=await import('../clipmentor/fixtures/blueprint-review-board-20261031.json');
 const {createBlueprintContinuation,createBlueprintContinuations,selectProductionAudience,sharedProductionDocument,alignUnstartedSharedBlueprint,commonProductionDigest,assertSharedProduction,prepareSharedProduction,queueBlueprintContinuations,continuationBrief,upgradeContinuationBrief}=await import('../clipmentor/production-continuation');
 const {deliverySectionsFromDoc}=await import('../../src/clipmentor/delivery-bindings');
 const {checkCopyProduction}=await import('../../src/clipmentor/production-gate');
 const full=structuredClone(boardFixture.cases.newBinding) as unknown as import('../../src/editor/types').ProjectDoc;
 const partnerDoc=structuredClone(boardFixture.cases.existingBinding) as unknown as import('../../src/editor/types').ProjectDoc;
 // A declared downloadable output must cross the real HTTP route with exact bytes.
 const deliveryDoc=structuredClone(partnerDoc),deliverySection=deliverySectionsFromDoc(deliveryDoc).find(s=>s.kind==='creator_invitation')!;
 const png=await sharp({create:{width:4,height:4,channels:3,background:'#123456'}}).png().toBuffer();
 const media=(await import('../media-dir')).uploadDir();await mkdir(media,{recursive:true});
 const {execFileSync}=await import('node:child_process');const {ffmpegBin}=await import('../media-binaries');
 const sourceId=deliveryDoc.clipMentorAnalysis!.source.asset_id;
 const original=deliveryDoc.assets.find(a=>a.id===sourceId)!;
 original.src='/media/uploads/fixture-original.mp4';
 execFileSync(ffmpegBin(),['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=white:s=90x160:r=1','-t',String(deliveryDoc.clipMentorAnalysis!.source.duration_seconds),'-c:v','libx264','-pix_fmt','yuv420p',join(media,'fixture-original.mp4')]);
 original.sourceContentHash=createHash('sha256').update(await readFile(join(media,'fixture-original.mp4'))).digest('hex');
 deliveryDoc.clipMentorAnalysis!.source.sourceContentHash=original.sourceContentHash;
 const duration=deliveryDoc.clipMentorAnalysis!.source.duration_seconds;
 deliveryDoc.clipMentorAnalysis!.evidence.push({evidence_id:'fixture-original-claim',kind:'original_claim',text:'Ini contoh suara asal.',source_ids:[sourceId],supporting_evidence_ids:[],status:'candidate',source_range_seconds:[0,duration]});
 const breakdown=deliveryDoc.clipMentorAnalysis!.source_breakdown!;
 breakdown.segments=[{segment_id:'original',source_range_seconds:[0,duration],claim_evidence_ids:['fixture-original-claim'],visible_evidence_ids:[],interpretation_evidence_ids:[],unknowns:[]}];
 breakdown.units.forEach(u=>{u.original_segment_ids=['original'];u.original_source_ranges=[[0,duration]];});
 await (await import('../clipmentor/creator-storyboard.verify-fixtures')).writeStoryboardFixtureReceipt(deliveryDoc,directory);
 const pngHash=createHash('sha256').update(png).digest('hex'),ref=(id:string)=>({asset_id:id,src:`/media/uploads/${id}.png`,sha256:pngHash});
 const attachment=ref('fixture-attachment');deliverySection.section_id='existing_partner';
 const deliveryIR=(deliveryDoc.clipMentorAnalysis!.blueprint[0] as unknown as {internal_review:Record<string,unknown>}).internal_review;
 const deliveryRows=deliverySectionsFromDoc(deliveryDoc);deliveryRows[deliveryRows.findIndex(s=>s.kind==='creator_invitation')]=deliverySection;
 (deliveryIR[String(deliveryIR.current_picture_plan)] as {delivery_sections:unknown}).delivery_sections=deliveryRows;
 delete deliverySection.picture.crop;
 deliverySection.picture.layout={kind:'product_storyboard',product:ref('fixture-product'),storyboard:ref('fixture-board'),attachment};
 deliveryDoc.assets.find(a=>a.id===deliverySection.picture.asset_id)!.width=720;
 deliveryDoc.assets.find(a=>a.id===deliverySection.picture.asset_id)!.height=1280;
 for(const id of ['fixture-product','fixture-board','fixture-attachment'])deliveryDoc.assets.push({id,name:id+'.png',kind:'image',src:ref(id).src,sourceContentHash:pngHash,width:4,height:4,durationInFrames:1,props:{clipmentorStoryboardSource:deliveryDoc.clipMentorAnalysis!.source.asset_id,clipmentorStoryboardHash:deliveryDoc.clipMentorAnalysis!.source.sourceContentHash}});
 await writeFile(join(media,'fixture-attachment.png'),png);await writeFile(join(media,'fixture-preview.mp4'),'synthetic identity only');
 await setStoredEntry('project:'+panelTask.projectId,deliveryDoc);
 const deliverySaved=(await loadOfflineStoredProject(panelTask.projectId))!;
 panelTask.status='awaiting_review';panelTask.projectRevision=deliverySaved.revision;
 panelTask.completed.export={at:1,artifact:{revision:deliverySaved.revision,renderId:'delivery-fixture',path:'/media/uploads/fixture-preview.mp4'}};
 panelTask.completed.self_check={at:2,artifact:{preview:'/media/uploads/fixture-preview.mp4'}};await productionTaskStore.save(panelTask);
 const download=(assetId='fixture-attachment',renderId='delivery-fixture',authorized=true)=>fetch(`${origin}/api/clipmentor/production-task?${new URLSearchParams({view:'panel_attachment',projectId:panelTask.projectId,assetId,renderId})}`,{headers:authorized?{Origin:origin,'Sec-Fetch-Site':'same-origin'}:{}});
 assert.equal((await download(undefined,undefined,false)).status,403);
 const delivered=await download();assert.equal(delivered.status,200);assert.match(delivered.headers.get('content-disposition')! ,/attachment/);assert.equal(delivered.headers.get('content-type'),'application/pdf');assert.equal(Buffer.from(await delivered.arrayBuffer()).subarray(0,5).toString(),'%PDF-');
 assert.equal((await panelGet()).task.attachments[0].assetId,'fixture-attachment');
 assert.equal((await download('fixture-product')).status,409,'pool assets are not automatically deliverables');
 assert.equal((await download(undefined,'old-render')).status,409,'old export links cannot serve current attachments');
 await writeFile(join(media,'fixture-attachment.png'),'changed');assert.equal((await download()).status,409);assert.equal((await panelGet()).task.deliveryUnavailable,true);
 await writeFile(join(media,'fixture-attachment.png'),png);
 const newer=structuredClone(deliveryDoc);newer.name='changed project';await setStoredEntry('project:'+panelTask.projectId,newer);assert.equal((await download()).status,409);
 assert.deepEqual(await readFile(join(media,'fixture-attachment.png')),png,'delivery never rewrites source files');
 // Exercise final acceptance itself, with a synthetic portrait MP4 and fake local review evidence.
 execFileSync(ffmpegBin(),['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=white:s=720x1280:r=10','-frames:v','1','-c:v','libx264','-pix_fmt','yuv420p',join(media,'fixture-preview.mp4')]);
 await setStoredEntry('project:'+panelTask.projectId,deliveryDoc);panelTask.projectRevision=(await loadOfflineStoredProject(panelTask.projectId))!.revision;
 panelTask.completed.export!.artifact.revision=panelTask.projectRevision;
 panelTask.input.panelDelivery={productAssetId:'fixture-product',productAssetHash:pngHash,salesAssetId:'fixture-sales',ctaAssetId:'fixture-cta',ctaAssetHash:pngHash};await productionTaskStore.save(panelTask);
 const acceptFixture=()=>post({action:'accept',projectId:panelTask.projectId,taskId:panelTask.taskId,malayDeliveryConfirmed:true});
 assert.equal((await acceptFixture()).status,409,'export alone and a checked language box cannot certify actual inspection');
 const videoSha=createHash('sha256').update(await readFile(join(media,'fixture-preview.mp4'))).digest('hex');
 panelTask.completed.self_check!.artifact.receipt={projectId:panelTask.projectId,videoSha256:videoSha,status:'completed',scope:'rendered_preview_continuous_review',full_film_accepted:false,effective_review:{status:'pass',can_use_as_pass:true,blockers:[],manifest_binding:'frozen_at_request'},timeline_check:{status:'no_detected_conflict'}};
 await productionTaskStore.save(panelTask);
 await rm(join(media,'fixture-attachment.png'));assert.equal((await acceptFixture()).status,409,'review success cannot replace the missing promised attachment');
 await writeFile(join(media,'fixture-attachment.png'),png);assert.equal((await acceptFixture()).status,200,'fully bound local positive control remains deliverable');
 assert.equal((await productionTaskStore.load(panelTask.projectId,panelTask.taskId)).status,'completed');
 const finalVideo=await fetch(`${origin}/api/clipmentor/production-task?${new URLSearchParams({view:'panel_download',projectId:panelTask.projectId,renderId:'delivery-fixture'})}`,{headers:{Origin:origin,'Sec-Fetch-Site':'same-origin'}});
 assert.equal(finalVideo.status,200);assert.match(finalVideo.headers.get('content-disposition')!,/filename\*=UTF-8''/);assert.deepEqual(Buffer.from(await finalVideo.arrayBuffer()),await readFile(join(media,'fixture-preview.mp4')),'confirmed download contains actual saved MP4 bytes');
 delete panelTask.input.panelDelivery; // Complete requirement identity and atomic publication use the real canonical store.
 const requirementProject='required-final-fixture';await setStoredEntry('project:'+requirementProject,deliveryDoc);
 const required=await createProductionTask({...panelTask.input,projectId:requirementProject,panelDelivery:{productAssetId:'fixture-product',productAssetHash:pngHash,salesAssetId:'fixture-sales',ctaAssetId:'fixture-cta',ctaAssetHash:'f'.repeat(64)}});
 required.status='awaiting_review';required.projectRevision=(await loadOfflineStoredProject(requirementProject))!.revision;required.completed=structuredClone(panelTask.completed);required.completed.export!.artifact.revision=required.projectRevision;
 (required.completed.self_check!.artifact.receipt as Record<string,unknown>).projectId=requirementProject;
 const requirementApi=await import('../clipmentor/handoff'),{digestValue:requirementHash}=await import('../agent-runs/store-values');
 const requirementBrief={version:1,briefId:'final-requirements',revision:1,mode:'autonomous',phase:'planning',planner:'builtin_agent',executor:'builtin_agent',projectId:requirementProject,timelineId:deliveryDoc.activeTimelineId,objective:'Actual output',doneCriteria:['Original requirement'],blueprint:null,budget:{maxModelTurns:0,maxToolCalls:0,maxElapsedMs:10000,paidToolCalls:{}}};
 const registered=await requirementApi.registerHandoff({projectId:requirementProject,expectedProjectRevision:required.projectRevision,previousDigest:null,brief:requirementBrief});
 required.completed.copy_review={at:1,artifact:{requirementsDigest:requirementHash(requirementBrief.doneCriteria)}};required.completed.self_check!.artifact.requirementsDigest=requirementHash(requirementBrief.doneCriteria);await productionTaskStore.save(required);
 const changedBrief={...requirementBrief,revision:2,doneCriteria:['Original requirement','先导出代表视频并连续观看，不可用截图替代']};
 await requirementApi.registerHandoff({projectId:requirementProject,expectedProjectRevision:required.projectRevision,previousDigest:registered.digest,brief:changedBrief});
 const {acceptProductionTask}=await import('../clipmentor/production-task');
 await assert.rejects(acceptProductionTask(required,true),/final_requirements_changed/,'new text requirements cannot inherit old visual approval');
 assert.equal(required.status,'awaiting_review');
 required.completed.copy_review!.artifact.requirementsDigest=requirementHash(changedBrief.doneCriteria);required.completed.self_check!.artifact.requirementsDigest=requirementHash(changedBrief.doneCriteria);await productionTaskStore.save(required);
 const {loadAgentRuntimeSidecar}=await import('../../src/persist/agentRuntimeStore');const beforeRace=(await loadAgentRuntimeSidecar(requirementProject)).artifacts.length;
 const racingStore={...productionTaskStore,save:async(next:typeof required,conditions?:Parameters<typeof productionTaskStore.save>[1])=>{await setStoredEntry('project:'+requirementProject,newer);await productionTaskStore.save(next,conditions);}};
 await assert.rejects(acceptProductionTask(required,true,racingStore),/precondition_changed/,'a commit during evidence inspection cannot publish completed');
 assert.equal(required.status,'awaiting_review','failed acceptance does not mutate caller state');assert.equal((await productionTaskStore.load(requirementProject,required.taskId)).status,'awaiting_review');assert.equal((await loadAgentRuntimeSidecar(requirementProject)).artifacts.length,beforeRace,'failed completion body is not indexed');
 await setStoredEntry('project:'+requirementProject,deliveryDoc);
 const originalControlLoad=productionTaskStore.load;let controlEntered!:()=>void,controlRelease!:()=>void,holdControl=true;
 const enteredControl=new Promise<void>(r=>{controlEntered=r;}),releaseControl=new Promise<void>(r=>{controlRelease=r;});
 productionTaskStore.load=async(project,id)=>{if(project===requirementProject&&holdControl){holdControl=false;controlEntered();await releaseControl;}return originalControlLoad(project,id);};
 const pendingAccept=post({action:'accept',projectId:requirementProject,taskId:required.taskId,malayDeliveryConfirmed:true});await enteredControl;
 const errorLog=console.error;const controlErrors:string[]=[];console.error=(...args)=>{controlErrors.push(args.map(String).join(' '));};
 try{
  const competing=await fetch(`${origin}/api/clipmentor/production-task?view=panel&projectId=${requirementProject}`,{method:'POST',headers:{Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json'},body:JSON.stringify({action:'accept',renderId:'delivery-fixture',languageConfirmed:true})});
  assert.equal(competing.status,409);assert(controlErrors.some(e=>e.includes('该工程正在处理上一次操作')),'panel and API must share the same project control boundary');
 }finally{console.error=errorLog;productionTaskStore.load=originalControlLoad;controlRelease();}
 assert.equal((await pendingAccept).status,200);assert.equal((await originalControlLoad(requirementProject,required.taskId)).status,'completed');


 panelTask.status='awaiting_blueprint';panelTask.completed={};await productionTaskStore.save(panelTask);
 await setStoredEntry('project:'+panelTask.projectId,projectDoc());
 console.log('actual attachment route: exact bytes, declared scope, origin, stale render/revision and changed bytes; no external calls');
 const allSections=deliverySectionsFromDoc(full),partnerSection=deliverySectionsFromDoc(partnerDoc).find(s=>s.kind==='creator_invitation')!;
 allSections.find(s=>s.kind==='creator_invitation')!.section_id='new_contact';partnerSection.section_id='existing_partner';allSections.push(partnerSection);
 for(const asset of partnerDoc.assets)if(!full.assets.some(a=>a.id===asset.id))full.assets.push(asset);
 for(const evidence of partnerDoc.clipMentorAnalysis!.evidence){
  const present=full.clipMentorAnalysis!.evidence.find(e=>e.evidence_id===evidence.evidence_id);
  if(present)present.source_ids=[...new Set([...present.source_ids,...evidence.source_ids])];else full.clipMentorAnalysis!.evidence.push(evidence);
 }
 const ir=(full.clipMentorAnalysis!.blueprint[0] as unknown as {internal_review:Record<string,unknown>}).internal_review;
 (ir[String(ir.current_picture_plan)] as {delivery_sections:unknown}).delivery_sections=allSections;
 const independentProduct={...structuredClone(full.assets.find(a=>a.kind==='image')!),id:'independent-product',src:'/media/uploads/independent-product.png',sourceContentHash:'7'.repeat(64)};
 full.assets.push(independentProduct);
 const {combinePanelBlueprintEndings}=await import('../clipmentor/production-panel');
 const mainBoard=selectProductionAudience(full,'existing_partner'),otherBoard=selectProductionAudience(full,'new_contact');
 const beforeBoards=JSON.stringify([mainBoard,otherBoard]);
 const mergedBoard=combinePanelBlueprintEndings(mainBoard,otherBoard);
 assert.deepEqual(deliverySectionsFromDoc(mergedBoard).filter(s=>s.kind==='creator_invitation').map(s=>s.section_id).sort(),['existing_partner','new_contact']);
 assert.equal(JSON.stringify([mainBoard,otherBoard]),beforeBoards,'presentation must not write either project');
 assert.deepEqual(mergedBoard.clipMentorAnalysis!.evidence,mainBoard.clipMentorAnalysis!.evidence,'do not mix historical sibling teaching evidence');
 const wrongSource=structuredClone(otherBoard);wrongSource.clipMentorAnalysis!.source.sourceContentHash='f'.repeat(64);
 assert.throws(()=>combinePanelBlueprintEndings(mainBoard,wrongSource),/原片不一致/);
 assert.throws(()=>combinePanelBlueprintEndings(mainBoard,mainBoard),/新建联片尾方案缺失/);
 const conflict=structuredClone(otherBoard);conflict.assets[0].src='/media/uploads/conflict.mp4';
 assert.throws(()=>combinePanelBlueprintEndings(mainBoard,conflict),/素材冲突|binding/);
 assert.throws(()=>combinePanelBlueprintEndings(mergedBoard,otherBoard),/重复/);
 const originalFull=JSON.stringify(full);
 for(const audience of ['new_contact','existing_partner'] as const){
  const selected=selectProductionAudience(full,audience);
  assert.deepEqual(deliverySectionsFromDoc(selected).filter(s=>s.kind==='creator_invitation').map(s=>s.section_id),[audience]);
  assert.deepEqual(selected.assets,full.assets,'variant selection reuses media identities and never copies media files');
 }
 assert.equal(JSON.stringify(full),originalFull,'selecting a version cannot erase the common blueprint or other ending');
 await setStoredEntry(`project:${panelTask.projectId}`,full);
 const sourceSnapshot=(await loadOfflineStoredProject(panelTask.projectId))!;
 const suppliedScope={productAssetId:independentProduct.id,productAssetHash:independentProduct.sourceContentHash,
  salesAssetId:allSections[0].picture.asset_id,ctaAssetId:allSections[1].picture.asset_id,ctaAssetHash:allSections[1].picture.sha256};
 const confirmationParent={...structuredClone(panelTask),status:'blocked' as const,error:'original HTTP 502',attempts:{...panelTask.attempts,model:7,review:8},
  input:{...panelTask.input,brief:'只补指定句，禁止新增配音、剪辑或渲染。',sourceAssetId:full.clipMentorAnalysis!.source.asset_id,panelDelivery:suppliedScope,voice:{provider:'minimax',voiceId:'Malay_female_1_v1'},budget:{...panelTask.input.budget,model:20,review:8}}};
 const variantHandoff=await import('../clipmentor/handoff');
 await variantHandoff.registerHandoff({projectId:panelTask.projectId,expectedProjectRevision:sourceSnapshot.revision,previousDigest:null,brief:{
  version:1,briefId:'variant-source-requirements',revision:1,mode:'collaborative',phase:'planning',planner:'external_codex',executor:'builtin_agent',
  projectId:panelTask.projectId,timelineId:full.activeTimelineId,objective:'Use saved source',blueprint:null,
  doneCriteria:['Keep the supplied words and pictures',...(['new_contact','existing_partner'] as const).map(sectionId=>({id:sectionId,sectionId,
   quote:'Use the supplied reference',question:'Is the correct supplied picture visible?',pictureStage:'完整招商卡',layout:'recruitment_card',pictureSha256:suppliedScope.ctaAssetHash,
   reference:{assetId:suppliedScope.ctaAssetId,fileName:'CTA.png',seconds:0}})),{id:'body-style',sectionId:full.clipMentorAnalysis!.blueprint[0].unit_id,quote:'保留本项目认可的原片标识',question:'实际原片标识是否一致？',pictureStage:'原片',layout:'native_composition',reference:{assetId:suppliedScope.ctaAssetId,fileName:'CTA.png',seconds:0}}],
  budget:{maxModelTurns:0,maxToolCalls:0,maxElapsedMs:10000,paidToolCalls:{}}}});
 const variantRequirements=await variantHandoff.readHandoffPolicy(panelTask.projectId);
 // Crash immediately after the first durable child checkpoint; it must already be a non-runnable bound continuation.
 const interruptedParent={...structuredClone(confirmationParent),taskId:'first-child-checkpoint-fixture'};
 const originalChildSave=productionTaskStore.save;let firstChild:import('../clipmentor/production-task').ProductionTask|undefined;
 productionTaskStore.save=async task=>{await originalChildSave(task);firstChild=structuredClone(task);throw Error('injected child checkpoint crash');};
 try{await assert.rejects(createBlueprintContinuation(interruptedParent,sourceSnapshot,'existing_partner',variantRequirements,origin),/injected child checkpoint crash/);}finally{productionTaskStore.save=originalChildSave;}
 assert(firstChild);assert.equal(firstChild.status,'awaiting_blueprint','first persisted child must not auto-launch source analysis');assert.equal(firstChild.stage,'copy_review');assert.equal(firstChild.blueprintApproval?.sourceTaskId,interruptedParent.taskId);
 const resumedChild=await createBlueprintContinuation(interruptedParent,sourceSnapshot,'existing_partner',variantRequirements,origin);
 assert.equal(resumedChild.taskId,firstChild.taskId,'confirmation after first-checkpoint crash reuses the fully bound child');
 assert.equal(resumedChild.attempts.model,0);assert.equal(resumedChild.attempts.review,0);
 const output=await createBlueprintContinuation(confirmationParent,sourceSnapshot,'existing_partner',variantRequirements,origin);
 const replayedOutput=await createBlueprintContinuation(confirmationParent,sourceSnapshot,'existing_partner',variantRequirements,origin);
 assert.equal(output.taskId,replayedOutput.taskId,'duplicate confirmation must reuse one output task');
 assert.equal(output.stage,'copy_review');assert.equal(output.input.panelDelivery?.audience,'existing_partner');
 assert.equal(output.input.brief,continuationBrief(confirmationParent.input.product.name,'existing_partner'));
 assert(!output.input.brief.includes(confirmationParent.input.brief),'an old local-repair command cannot become the next production command');
 assert.equal(output.input.budget.model,13);assert.equal(output.input.budget.render,1);
 assert.equal(confirmationParent.attempts.review,8);assert.equal(confirmationParent.error,'original HTTP 502');
 const {productionReviewRequirements}=await import('../clipmentor/production-task');
 const inherited=await productionReviewRequirements(output.projectId);
 assert.deepEqual(inherited!.brief.doneCriteria.filter(c=>typeof c!=='string').map(c=>c.sectionId),['existing_partner',full.clipMentorAnalysis!.blueprint[0].unit_id]);
 assert.equal(inherited!.brief.doneCriteria[0],'Keep the supplied words and pictures');
 await (await import('./project-store')).withSerializedProjectStore(store=>store.removeEntry(variantHandoff.handoffKey(panelTask.projectId)));
 const outputDoc=(await loadOfflineStoredProject(output.projectId))!.doc;
 assert.equal((await checkCopyProduction(outputDoc,'clipmentor')).allowed,false,'a user confirmation never manufactures production approval');
 assert.equal((await loadOfflineStoredProject(panelTask.projectId))!.revision,sourceSnapshot.revision,'source project remains unchanged');
 const batch=await createBlueprintContinuations(confirmationParent,sourceSnapshot,variantRequirements,origin);
 const replayedBatch=await createBlueprintContinuations(confirmationParent,sourceSnapshot,variantRequirements,origin);
 assert.deepEqual(batch.map(t=>t.taskId),replayedBatch.map(t=>t.taskId),'one confirmation always creates the same two outputs');
 assert.deepEqual(confirmationParent.productionChildren!.map(t=>t.audience),['existing_partner','new_contact']);
 assert.equal(batch[1].sharedProduction!.taskId,batch[0].taskId);
 const migrated=structuredClone(batch[0]);
 migrated.input.brief=confirmationParent.input.brief+'\n用户已确认含两种结尾的完整蓝图。本执行任务负责其中的existing_partner输出；两版共用片头、教学主体与同文配音，仅片尾不同。从独立审核接续，不重新分析原片。片尾使用独立时间线实例，片头和教学主体的实例在片尾起点前闭合，便于直接复用实际剪辑。';
 const oldAttempts=structuredClone(migrated.attempts),oldApproval=structuredClone(migrated.blueprintApproval);
 assert.equal(await upgradeContinuationBrief(migrated),true);
 assert.equal(migrated.input.brief,output.input.brief);assert.deepEqual(migrated.attempts,oldAttempts);assert.deepEqual(migrated.blueprintApproval,oldApproval);
 const explicitCustom=structuredClone(batch[0]);explicitCustom.input.brief='用户明确要求的自定义任务';
 assert.equal(await upgradeContinuationBrief(explicitCustom),false,'an unknown/custom instruction must not be silently overwritten');

 assert.equal(await prepareSharedProduction(batch[1]),false,'the second output cannot duplicate common work while the first is unfinished');
 assert.equal(batch[1].attempts.model,0);assert.equal(batch[1].attempts.tts,0);
 batch[1].status='awaiting_blueprint';await productionTaskStore.save(batch[1]);
 assert.equal((await queueBlueprintContinuations(confirmationParent))[1].status,'queued','a persisted confirmed batch recovers before either dispatch');
 batch[1].status='queued';
 const batchView=(await panelGet());
 assert.deepEqual(batchView.outputs,[{audience:'existing_partner'},{audience:'new_contact'}]);
 const outputView=await (await fetch(`${origin}/api/clipmentor/production-task?view=panel&projectId=${input.projectId}&audience=new_contact`,{headers:{Origin:origin,'Sec-Fetch-Site':'same-origin'}})).json();
 assert.equal(outputView.task.status,'waiting');assert.equal(outputView.task.stopReason,undefined);
 const repeated=await fetch(`${origin}/api/clipmentor/production-task?view=panel&projectId=${input.projectId}`,{method:'POST',headers:{Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json'},body:JSON.stringify({action:'produce_versions',revision:'wrong'})});
 assert.equal(repeated.status,409,'stale duplicate confirmation remains rejected');
 // Exercise actual timeline reuse: media records are shared, the old ending is removed,
 // and a changed common item is rejected even if both output copy strings are identical.
 const firstDoc=structuredClone(outputDoc),secondDoc=(await loadOfflineStoredProject(batch[1].projectId))!.doc;
 const endSection=deliverySectionsFromDoc(firstDoc).find(section=>section.kind==='creator_invitation')!;
 const fps=firstDoc.timelines[0].fps;
 const narration={id:'shared-test-ending-audio',kind:'audio',name:'ending',src:'/media/uploads/ending.mp3',durationInFrames:fps,
  props:{generation:{text:endSection.line.narration_ms,provider:endSection.voice.provider,voiceId:endSection.voice.voiceId,speed:1,durationSeconds:1}}} as unknown as import('../../src/editor/types').MediaAsset;
 firstDoc.assets.push(narration);
 const timeline=firstDoc.timelines[0];
 timeline.items=[{id:'shared-common-video',name:'common',kind:'video',track:timeline.trackOrder![0],startFrame:0,durationInFrames:100,src:firstDoc.assets.find(a=>a.kind==='video')!.src,sourceAssetId:firstDoc.assets.find(a=>a.kind==='video')!.id},
  {id:'old-ending-audio',name:'ending',kind:'audio',track:timeline.trackOrder![2],startFrame:100,durationInFrames:fps,src:narration.src,sourceAssetId:narration.id}] as typeof timeline.items;
 const sourceBytes=JSON.stringify(firstDoc),targetBytes=JSON.stringify(secondDoc);
 const shared=await sharedProductionDocument(firstDoc,secondDoc);
 assert.equal(shared.endFrame,100);assert.deepEqual(shared.doc.timelines[0].items,timeline.items.slice(0,1));
 assert.equal(shared.doc.assets.find(a=>a.id===narration.id)!.src,narration.src);
 assert.equal(JSON.stringify(firstDoc),sourceBytes);assert.equal(JSON.stringify(secondDoc),targetBytes);
 const locked={...structuredClone(batch[1]),sharedProduction:{...batch[1].sharedProduction!,prepared:true as const,endFrame:100,digest:shared.digest}};
 assertSharedProduction(locked,shared.doc);
 const tail=structuredClone(shared.doc);tail.timelines[0].items.push({...timeline.items[1],id:'new-ending',startFrame:100});
 assertSharedProduction(locked,tail);
 tail.timelines[0].items[0].volume=0.5;
 assert.throws(()=>assertSharedProduction(locked,tail),/shared_body_changed/);
 const cross=structuredClone(firstDoc);cross.timelines[0].items[0].durationInFrames=101;
 assert.throws(()=>commonProductionDigest(cross,100),/crosses_ending/);
 const changedCopy=structuredClone(secondDoc);(changedCopy.clipMentorAnalysis!.blueprint[0].internal_review as Record<string,any>)[String(changedCopy.clipMentorAnalysis!.blueprint[0].internal_review!.current_script_candidate)].lines[0].narration_ms+=' changed';
 await assert.rejects(sharedProductionDocument(firstDoc,changedCopy),/shared_body_blueprint_changed/);
 // The untouched second output follows the latest producer plan; its own
 // ending survives and no producer receipt is copied as its approval.
 const updatedProducer=structuredClone(firstDoc),updatedIR=(updatedProducer.clipMentorAnalysis!.blueprint[0] as any).internal_review;
 const active=updatedIR[updatedIR.current_picture_plan];
 active.composition={...(typeof active.composition==='object'?active.composition:{}),detail:'Updated producer picture allocation; synthetic test only'};
 const preAlign=JSON.stringify(secondDoc),ownEnding=deliverySectionsFromDoc(secondDoc).filter(s=>s.kind==='creator_invitation');
 await assert.rejects(sharedProductionDocument(updatedProducer,secondDoc),/shared_body_blueprint_changed/);
 const aligned=await alignUnstartedSharedBlueprint(updatedProducer,secondDoc);
 assert.deepEqual(deliverySectionsFromDoc(aligned).filter(s=>s.kind==='creator_invitation'),ownEnding);
 assert.equal(aligned.clipMentorAnalysis!.production_copy_review,undefined,'no independent approval is inherited');
 assert.equal(JSON.stringify(secondDoc),preAlign,'candidate alignment never writes the waiting input');
 await sharedProductionDocument(updatedProducer,aligned);
 const started=structuredClone(secondDoc);started.timelines[0].items.push(structuredClone(timeline.items[0]));
 await assert.rejects(alignUnstartedSharedBlueprint(updatedProducer,started),/untouched_same_source/);
 const unrelated=structuredClone(secondDoc);unrelated.clipMentorAnalysis!.source.sourceContentHash='e'.repeat(64);
 await assert.rejects(alignUnstartedSharedBlueprint(updatedProducer,unrelated),/untouched_same_source/);
 const conflicting=structuredClone(updatedProducer),endingFact=ownEnding[0].evidence_ids[0];
 conflicting.clipMentorAnalysis!.evidence.find(e=>e.evidence_id===endingFact)!.text='Conflicting condition';
 await assert.rejects(alignUnstartedSharedBlueprint(conflicting,secondDoc),/ending_fact_conflict/);

 const missingEnding=selectProductionAudience(full,'existing_partner');
 await assert.rejects(createBlueprintContinuations(confirmationParent,{doc:missingEnding,revision:'missing-new-ending'},variantRequirements,origin),/尚未齐备/);

 // Bind a synthetic saved export (no provider and no renderer), then exercise the real
 // dependency preparation and automatic second-output dispatch through the service.
 const {copyTeachingPacketFromDoc,copyReviewSubject}=await import('../../src/clipmentor/production-gate');
 const {productionPreviewFacts,previewFactsDigest}=await import('../clipmentor/production-preview-facts');
 const {feedbackProjectDigest}=await import('../clipmentor/production-feedback');
 for(const doc of [firstDoc,secondDoc])doc.clipMentorAnalysis!.source_breakdown!.units.forEach((u,i)=>{
  u.placement={timeline_id:doc.activeTimelineId,original_frames:[i*15,i*15+5],explanation_frames:[i*15+5,i*15+15]};
 });
 await setStoredEntry('project:'+batch[0].projectId,firstDoc);await setStoredEntry('project:'+batch[1].projectId,secondDoc);
 const firstSaved=(await loadOfflineStoredProject(batch[0].projectId))!;
 Object.assign(firstDoc,firstSaved.doc);
 const firstFacts=productionPreviewFacts(firstDoc,firstDoc.timelines[0],await copyTeachingPacketFromDoc(firstDoc));
 batch[0].status='awaiting_review';batch[0].projectRevision=firstSaved.revision;
 batch[0].completed.export={at:Date.now(),artifact:{revision:firstSaved.revision,renderId:'synthetic-first-export',facts_digest:previewFactsDigest(firstFacts),feedback_project_digest:feedbackProjectDigest(firstDoc)}};
 batch[0].completed.self_check={at:Date.now(),artifact:{fixtureOnly:true}};
 batch[1].blueprintApproval!.digest=(await copyReviewSubject(secondDoc)).digest;
 await productionTaskStore.save(batch[0]);await productionTaskStore.save(batch[1]);
 assert.equal(await prepareSharedProduction(batch[1]),true);
 assert.equal(batch[1].sharedProduction!.prepared,true);
 assert.equal((await productionTaskStore.load(batch[0].projectId,batch[0].taskId)).sharedProduction!.digest,batch[1].sharedProduction!.digest);
 assert.equal((await checkCopyProduction((await loadOfflineStoredProject(batch[1].projectId))!.doc,'clipmentor')).allowed,false,'copying saved common editing cannot create formal review permission');
 const coldPrepared=await productionTaskStore.load(batch[1].projectId,batch[1].taskId);
 assert.equal(await prepareSharedProduction(coldPrepared),true,'preparation is safe to resume after persisted readback');
 const readyFirst=await productionTaskStore.load(batch[0].projectId,batch[0].taskId);
 readyFirst.status='queued';readyFirst.stage='self_check';delete readyFirst.completed.self_check;await productionTaskStore.save(readyFirst);
 assert.equal((await post({action:'resume',projectId:readyFirst.projectId,taskId:readyFirst.taskId})).status,202);
 for(let i=0;i<200;i++){
  const second=await productionTaskStore.load(batch[1].projectId,batch[1].taskId);
  if(second.status==='awaiting_review')break;
  await new Promise(resolve=>setTimeout(resolve,5));
 }
 assert.equal((await productionTaskStore.load(batch[1].projectId,batch[1].taskId)).status,'awaiting_review','the second output must start without another browser click');
 assert.deepEqual(batchSteps,['existing_partner:self_check','new_contact:copy_review','new_contact:audio','new_contact:edit','new_contact:export','new_contact:self_check']);
 // Return to the existing isolated HTTP cases without leaving queued fixture outputs.
 for(const child of batch){child.status='cancelled';await productionTaskStore.save(child);}
 delete panelTask.productionChildren;await productionTaskStore.save(panelTask);

 await setStoredEntry(`project:${panelTask.projectId}`,projectDoc());
 panelTask.projectRevision=(await loadOfflineStoredProject(panelTask.projectId))!.revision;
 await productionTaskStore.save(panelTask);
 const boardAction=(revision:string)=>fetch(`${origin}/api/clipmentor/production-task?view=panel&projectId=${panelTask.projectId}`,{
  method:'POST',headers:{Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json'},body:JSON.stringify({action:'approve_blueprint',revision}),
 });
 const unregistered=await boardAction(panelTask.projectRevision);
 assert.equal(unregistered.status,409);assert.equal((await unregistered.json()).reason,'review_board_reload');
 const stale=await boardAction('stale-board');assert.equal(stale.status,409);assert.notEqual((await stale.json()).reason,'review_board_reload');
 assert.equal((await productionTaskStore.load(panelTask.projectId,panelTask.taskId)).sequence,panelTask.sequence,'both rejections must precede any write');
 const {default:savedBlueprints}=await import('../../src/clipmentor/fixtures/production-saved-projects-20261028.json');
 await setStoredEntry(`project:${panelTask.projectId}`,structuredClone(savedBlueprints.cases[0].doc));
 const currentDraft=(await loadOfflineStoredProject(panelTask.projectId))!;
 const pendingView=(await panelGet()).task;
 assert.equal(pendingView.status,'awaiting_blueprint');
 assert.equal(pendingView.blueprintRevision,currentDraft.revision,'reviewable saved changes must not be hidden by the older task revision');
 assert.equal(pendingView.canApproveBlueprint,false);
 const {bindBlueprintFeedbackSummary}=await import('../clipmentor/production-feedback');
 const beforeFeedback=structuredClone(panelTask.attempts);
 panelTask.blueprintFeedback='嗯，第一个片头和双结尾需要核对，另外人审板不要整段内部技术信息。'.repeat(5);
 assert(bindBlueprintFeedbackSummary(panelTask,panelTask.blueprintFeedback,['片头与双结尾：核对现行安排。','人审板：精简内部技术信息。']));
 await productionTaskStore.save(panelTask);
 const concise=(await panelGet()).task;
 assert.deepEqual(concise.blueprintFeedbackSummary,['片头与双结尾：核对现行安排。','人审板：精简内部技术信息。']);
 assert.equal(concise.hasBlueprintFeedback,true);assert(!('blueprintFeedback' in concise));
 assert.deepEqual((await productionTaskStore.load(panelTask.projectId,panelTask.taskId)).attempts,beforeFeedback);
 assert.equal((await productionTaskStore.load(panelTask.projectId,panelTask.taskId)).blueprintFeedback,panelTask.blueprintFeedback);
 delete panelTask.blueprintFeedback;delete panelTask.blueprintFeedbackSummary;await productionTaskStore.save(panelTask);

 assert.equal((await boardAction(currentDraft.revision)).status,409,'a visible current draft cannot reuse the old approval');
 assert.equal((await productionTaskStore.load(panelTask.projectId,panelTask.taskId)).sequence,panelTask.sequence);
 const {registerHandoff,handoffKey}=await import('../clipmentor/handoff');
 const {digestValue}=await import('../agent-runs/store-values');
 const {withSerializedProjectStore}=await import('./project-store');
 const brief={version:1,briefId:'raw-requirement-http',revision:1,mode:'autonomous',phase:'planning',planner:'builtin_agent',executor:'builtin_agent',
  projectId:panelTask.projectId,timelineId:currentDraft.doc.activeTimelineId,objective:'No model fixture',doneCriteria:['Use original CTA'],blueprint:null,
  budget:{maxModelTurns:0,maxToolCalls:0,maxElapsedMs:10000,paidToolCalls:{}}};
 const bound=await registerHandoff({projectId:panelTask.projectId,expectedProjectRevision:currentDraft.revision,previousDigest:null,brief});
 const oldRevision=panelTask.projectRevision;
 panelTask.projectRevision=currentDraft.revision;
 panelTask.completed.copy_review={at:Date.now(),artifact:{requirementsDigest:digestValue(brief.doneCriteria)}};
 await productionTaskStore.save(panelTask);
 assert.equal((await panelGet()).task.canApproveBlueprint,true,'matching original requirements retain the ordinary confirmation path');
 await registerHandoff({projectId:panelTask.projectId,expectedProjectRevision:currentDraft.revision,previousDigest:bound.digest,
  brief:{...brief,revision:2,doneCriteria:['Use original CTA and retain the comparison hook']}});
 assert.equal((await panelGet()).task.canApproveBlueprint,false,'changing only a plain-text requirement invalidates prior confirmation readiness');
 assert.equal((await productionTaskStore.load(panelTask.projectId,panelTask.taskId)).completed.copy_review?.artifact.requirementsDigest,digestValue(brief.doneCriteria),
  'stale approval is preserved as history, never rewritten to match new requirements');
 await withSerializedProjectStore(store=>store.removeEntry(handoffKey(panelTask.projectId)));
 panelTask.projectRevision=oldRevision;delete panelTask.completed.copy_review;await productionTaskStore.save(panelTask);
 await setStoredEntry(`project:${panelTask.projectId}`,projectDoc());
 console.log('panel HTTP: sanitized service/material/limit outcomes; raw checkpoint preserved; human review remains visible');

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
 const prior=await makeCheckpoint(panelTask.projectId,'running');
 // A later human-review checkpoint for the same project takes precedence.
 await productionTaskStore.save(prior);
 await productionTaskStore.save(panelTask);
 for(const item of [resumed,unknown]){
  item.stage='blueprint';
  item.completed.analysis={at:Date.now(),artifact:{verifiedFixture:true}};
  item.effects['blueprint:initial:0:fixture']={kind:'model',operationId:item.taskId,status:'reserved'};
  item.attempts.model=1;
 }
 for(const item of [resumed,unknown,cancelled,blockedTask])await productionTaskStore.save(item);
 const indexed=[panelTask,queued,resumed,unknown,cancelled,blockedTask,deleted];
 for(const item of indexed)await setStoredEntry(`project:${item.projectId}`,projectDoc());
 await setStoredEntry('projects',indexed.map(item=>({
  id:item.projectId,name:'Cold recovery fixture',updatedAt:Date.now(),...(item===deleted?{deletedAt:Date.now()}:{}),
 })));
 await flushServerRunPersistence();resetServerRunStoreForTest();resetAgentRuntimeStoreMemory();
 const visited:string[]=[];
 let replayed:string|undefined,newSubmissions=0,leaseAttempts=0;
 const coldApp=createMiniConnect(error=>{throw error;});
 const coldServer=createServer((req,res)=>coldApp.handle(req,res));
 const coldPlugin=clipMentorProductionPlugin(async(item,stage)=>{
  visited.push(item.taskId);
  assert.equal(item.input.author.origin,item.input.reviewer.origin);
  if(item.stage==='analysis')assert.equal(item.taskId,queued.taskId,'completed stages must not be repeated');
  if(item.stage==='blueprint'&&item.taskId===resumed.taskId&&++leaseAttempts===1)throw Error('project_busy');
  if(item.stage==='blueprint'&&item.taskId!==queued.taskId)await stage.effect('model','fixture',async()=>{newSubmissions++;},item.taskId===resumed.taskId
   ?async id=>{replayed=id;return {saved:true};}:undefined);
  return {artifact:{verifiedFixture:true,revision:'recovered',authorSelfCheck:'passed',gate:{allowed:true}}};
 });
 (coldPlugin.configureServer as (s:unknown)=>void)({httpServer:coldServer,config:{server:{}},middlewares:{use:(route:string,fn:(req:IncomingMessage,res:ServerResponse)=>void)=>coldApp.use(route,fn)}});
 coldServer.listen(0,'127.0.0.1');await once(coldServer,'listening');
 try{
  // No browser or HTTP request is needed to resume a production task.
  for(let n=0;n<400;n++){
   const results=await Promise.all([queued,resumed,unknown].map(item=>productionTaskStore.load(item.projectId,item.taskId)));
   if(results.every(item=>['awaiting_blueprint','blocked'].includes(item.status)))break;
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
  assert.equal(unresolved.status,'blocked');assert.match(unresolved.error!,/no automatic resubmission/);
  assert.equal(unresolved.attempts.model,1);assert.equal(newSubmissions,0);
  assert.deepEqual(new Set(visited),new Set([queued.taskId,resumed.taskId,unknown.taskId]));
 }finally{await new Promise<void>((r,e)=>coldServer.close(err=>err?e(err):r()));}
 console.log('production cold start: resumes queued/running tasks, reuses a reserved effect, keeps unknown outcomes, skips prior versions, review gates and deleted projects');
 console.log('production HTTP: origin guard, async no-page execution, duplicate launch refusal, canonical artifact cold recovery/read and final human acceptance passed; mocked stages, zero provider calls');
}finally{release();await flushServerRunPersistence();await new Promise<void>((r,e)=>server.close(err=>err?e(err):r()));resetServerRunStoreForTest();resetAgentRuntimeStoreMemory();resetSharedKvMemory();if(previousData===undefined)delete process.env.OPENCHATCUT_DATA_DIR;else process.env.OPENCHATCUT_DATA_DIR=previousData;await rm(directory,{recursive:true,force:true});}
