import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {MemoryPersistence, projectDoc, projectId} from '../external-agent/offline-runtime.verify-fixtures';
import type {ProjectDoc} from '../../src/editor/types';
import type {ClipMentorAnalysis} from '../../src/clipmentor/analysis';
import {openHeadlessEditor} from './headless-editor';
import baseline from './fixtures/judydoll-teaching-baseline-r9.json';

const fixture = process.env.CLIPMENTOR_OFFLINE_REFERENCE_REPLAY;
const saved: {doc:ProjectDoc;frameArgs:{assetId:string;seconds:number[]}} = fixture
 ? JSON.parse(await readFile(resolve(fixture),'utf8'))
 : {doc:{...projectDoc(),assets:[
  {id:baseline.source.asset_id,name:'Original',kind:'video',src:'/media/uploads/judydoll-fixture.mp4',durationInFrames:2020,
   sourceContentHash:baseline.source.sourceContentHash},
 ],clipMentorAnalysis:{...structuredClone(baseline),schema_version:1,analysis_id:'isolated-fixture',revision:9,
  import_origin:'isolated_fixture',audit:[],reviews:[]} as unknown as ClipMentorAnalysis},
 frameArgs:{assetId:'sour',seconds:[8.5,16.6,18,47.5,59.1,63,65,67.1]}};
const source = saved.doc.assets.find(asset=>asset.id.startsWith(saved.frameArgs.assetId))!;
let frameReads=0;
const persistence=new MemoryPersistence(saved.doc);
const opts={projectId,runId:'reference-replay',origin:'http://127.0.0.1:5199',
 review:{provider:'openai' as const,model:'fixture',origin:'http://127.0.0.1:5199',apiMode:'responses' as const},
 persistence,browserConnected:()=>false,stageEditWrites:true,
 effect:async<T>():Promise<T>=>{throw new Error('Offline replay must not dispatch effects');},
 fetch:async(url:URL|RequestInfo,init?:RequestInit)=>{
  assert.equal(new URL(String(url)).pathname,'/api/extract-frames');
  const body=JSON.parse(String(init?.body)) as {src:string;sourceTimesMs:number[]};
  assert.equal(body.src,source.src);
  frameReads++;
  return Response.json({frames:body.sourceTimesMs.map(sourceTimeMs=>({sourceTimeMs,base64:'AA=='}))});
 }};
const editor=await openHeadlessEditor(opts);
try{
 const actual=await editor.execute('view_asset_frames',saved.frameArgs,'recorded-shortened-call') as {assetId?:string;error?:string};
 assert.equal(actual.error,undefined,'saved shortened frame request must resolve the registered asset');
 assert.equal(actual.assetId,source.id);
 assert.equal(frameReads,1);
}finally{await editor.close();}

// Exercise the actual server-tool bridge. Fetch is closed except for local
// frame extraction injected above. Production task and project stay isolated.
const {mkdtemp,rm,writeFile}=await import('node:fs/promises');
const {tmpdir}=await import('node:os');
const {join}=await import('node:path');
const {execFileSync}=await import('node:child_process');
const isolated=await mkdtemp(join(tmpdir(),'cm-reference-replay-'));
const oldProfile=process.env.OPENCHATCUT_DATA_DIR;
const oldFetch=globalThis.fetch;
process.env.OPENCHATCUT_DATA_DIR=isolated;
let providerRequests=0;
globalThis.fetch=async()=>{providerRequests++;throw new Error('No network in reference replay');};
try{
 const {executeBrowserTool}=await import('../agent-runs/browser-tool');
 const {createRun,flushRunPersistence}=await import('../agent-runs/store');
 const {canonicalServerRunToolCatalog}=await import('../agent-runs/tool-policy');
 const {ToolActivation}=await import('../../src/agent/tool-activation');
 const {ToolFailureTracker}=await import('../../src/agent/toolFailure');
 const {createAcceptanceLoop}=await import('../agent-runs/acceptance-loop');
 const {productionReferenceSelection,productionReferenceStop}=await import('./production-references');
 const {blueprintRepairStopped}=await import('./production-decisions');
 const {checkProductionAuthorBlueprint,readAuthorCheckAttachment}=await import('./production-author-self-check');
 const {isFailedToolResult}=await import('../../src/agent/toolFailure');
 const {advanceProductionTask}=await import('./production-task');
 const {loadedProductionGeneration}=await import('./production-generation');
 const {digestValue}=await import('../agent-runs/store-values');
 const {assertReferenceRepairTeaching,retainedReferenceRepairTeaching}=await import('./production-source-policy');
 const {revisionOf}=await import('../../src/agent/external-edit-session');
 const {validateAgentToolInvocation}=await import('../../src/agent/execution-policy');
 const {loadAgentRuntimeSidecar}=await import('../../src/persist/agentRuntimeStore');

 const full=source.id;
 const savedTask=(saved as {task?:import('./production-task').ProductionTask}).task;
 const teachingLock=savedTask?retainedReferenceRepairTeaching(saved.doc,savedTask):undefined;
 if(fixture)assert(teachingLock,'the official task must qualify for the technical editorial lock');
 const referenceDoc=structuredClone(saved.doc);
 const observationId='imported-source-receipt';
 const native=referenceDoc.clipMentorAnalysis!;
 native.evidence.push({evidence_id:'fixture-imported-claim',kind:'original_claim',text:'Exact received claim.',
  source_ids:[observationId],supporting_evidence_ids:[],status:'candidate_unverified_speech',source_range_seconds:[0,1],
  observation_method:'saved_source_video_model_receipt'});
 native.audit.push({revision:native.revision,action:'import_source_video_evidence',target_id:observationId,
  actor:{operator:'fixture',executor:'production_host',instruction:'loaded source receipt',identity:'local_declared_not_authenticated'},
  at:0,reason:'fixture'});
 const typed=productionReferenceSelection(()=>referenceDoc,full,new AbortController());
 const findOption=(kind:'evidence'|'frame'|'source',id:string)=>{
  for(let offset=0;;){
   const page=typed.list(kind,offset);
   const result=page.choices.find(c=>c.id===id);
   if(result)return result.selection;
   assert.notEqual(page.nextOffset,null,'registered choice must be present: '+id);
   offset=page.nextOffset!;
  }
 };
 const imported=native.evidence.at(-1)!;
 const importedId=findOption('evidence',imported.evidence_id);
 const importedReceipt=findOption('source',observationId);
 const revisionArgs={action:'revise',collection:'evidence',id:importedId,
  record:{...imported,evidence_id:importedId,source_ids:[importedReceipt],meaning_zh:'保留原始出典'}};
 const importedEdit=typed.resolveReferences('revise_clipmentor_analysis',revisionArgs,'registered-import');
 assert(!importedEdit.failure);
 assert.deepEqual((importedEdit.args.record as {source_ids:string[]}).source_ids,[observationId]);
 const append=typed.resolveReferences('revise_clipmentor_analysis',{action:'append',records:{evidence:[
  {kind:'original_claim',source_ids:[importedReceipt]}]}},'try-borrowed-provenance');
 assert.equal(append.failure?.error,'reference_not_registered','a new claim cannot borrow the original host receipt');
 const frame=native.evidence.find(e=>e.kind==='source_frame'&&e.source_frame!==undefined&&e.call_status!=='failed')!;
 const frameSelection=findOption('frame',frame.evidence_id);
 const evidenceSelection=findOption('evidence',frame.evidence_id);
 const wrongKind=typed.resolveReferences('revise_clipmentor_analysis',{action:'set_source_breakdown',record:{segments:[
  {source_range_seconds:[0,native.source.duration_seconds],claim_evidence_ids:[evidenceSelection]}]}},'claim-with-frame');
 assert.equal(wrongKind.failure?.error,'reference_not_registered');
 assert(wrongKind.failure?.candidates.every(c=>native.evidence.find(e=>e.evidence_id===c.id)?.kind==='original_claim'));
 const storyboard=typed.resolveReferences('edit_asset',{props:{clipmentorCreatorStoryboard:{rows:[
  {shot_ms:'fixture',source_range_seconds:[0,native.source.duration_seconds],source_frames:[frameSelection]}]}}},'selected-storyboard-frame');
 assert(!storyboard.failure);
 assert.deepEqual((storyboard.args.props as {clipmentorCreatorStoryboard:{rows:Array<{source_frames:number[]}>}})
  .clipmentorCreatorStoryboard.rows[0].source_frames,[frame.source_frame]);
 const placed={id:'known-placed-item',sourceAssetId:full} as ProjectDoc['timelines'][number]['items'][number];
 const placementDoc={...saved.doc,timelines:saved.doc.timelines.map(t=>({...t,items:[...t.items,placed]}))};
 for(const tamper of ['drop','add','replace'] as const){
  const controller=new AbortController();
  const refs=productionReferenceSelection(()=>placementDoc,full,controller);
  const assetId=refs.assetChoices().find(c=>c.id===full)!.selection;
  const itemId=refs.list('item').choices.find(c=>c.id===placed.id)!.selection;
  const first=tamper==='drop'?{assetId,itemId:99999,seconds:[1]}:{assetId:99999,seconds:[1]};
  const wrong=refs.resolveReferences('view_asset_frames',first,'bad-'+tamper);
  assert(wrong.failure);
  const second=tamper==='drop'?{assetId,seconds:[1]}:tamper==='add'?{assetId,itemId,seconds:[1]}:{itemId,seconds:[1]};
  const retry=refs.resolveReferences('view_asset_frames',{...second,referenceRetry:wrong.failure.referenceRetry},'tamper-'+tamper);
  assert.equal(retry.failure?.error,'reference_retry_binding_changed','a retry must preserve reference paths and cardinality');
 }
 const collisionId=saved.frameArgs.assetId+'-second-registered-image';
 const second={...source,id:collisionId,kind:'image' as const,name:'Similar prefix in this task'};
 const testAudio={...source,id:saved.frameArgs.assetId+'-audio',kind:'audio' as const,name:'Not a frame source'};
 const withCollision={...saved.doc,assets:[...saved.doc.assets,second,testAudio]};
 const sourcePath=(saved as {sourcePath?:string}).sourcePath;
 class FilePersistence extends MemoryPersistence {
  override async commitProject(input:Parameters<MemoryPersistence['commitProject']>[0]){
   const committed=await super.commitProject(input);
   if(committed.status==='applied')await writeFile(join(isolated,'analysis-readback.json'),JSON.stringify(this.current));
   return committed;
  }
 }
 const isolatedStore=new FilePersistence(saved.doc);
 const hostEditor=await openHeadlessEditor({...opts,persistence:isolatedStore,
  assertCanvas:doc=>assertReferenceRepairTeaching(teachingLock,doc),fetch:async(url,init)=>{
  assert.equal(new URL(String(url)).pathname,'/api/extract-frames');
  const body=JSON.parse(String(init?.body)) as {src:string;sourceTimesMs:number[]};
  assert.equal(body.src,source.src);
  frameReads++;
  return Response.json({frames:body.sourceTimesMs.map(sourceTimeMs=>({sourceTimeMs,base64:sourcePath?
   execFileSync('ffmpeg',['-nostdin','-v','error','-ss',String(sourceTimeMs/1000),'-i',sourcePath,
    '-frames:v','1','-vf','scale=150:-2','-f','image2','-vcodec','mjpeg','pipe:1']).toString('base64'):'AA=='}))});
 }});
 try{
  const slots=canonicalServerRunToolCatalog(false,true).filter(s=>['view_asset_frames','read_clipmentor_analysis',
   'read_clipmentor_references','revise_clipmentor_analysis'].includes(s.name));
  function bridge(){
   const controller=new AbortController();
   const refs=productionReferenceSelection(hostEditor.getDoc,full,controller);
   const run=createRun({projectId,backend:'codex',provider:'openai',model:'fixture'});
   const activation={current:new ToolActivation(slots,[],slots.map(s=>s.name)),tail:Promise.resolve(),
    followupText:null,toolFailures:new ToolFailureTracker(),acceptance:createAcceptanceLoop(false,1),
    host:{...refs,signal:controller.signal,maxTurns:1,deadlineAt:Infinity,async beforeRequest(){throw Error('No model allowed');},
     execute:async(name:string,args:Record<string,unknown>,id:string)=>name==='read_clipmentor_references'
      ?refs.list(args.kind as 'evidence',Number(args.offset??0),undefined,args.referenceRetry as number|undefined):hostEditor.execute(name,args,id)}};
   const invoke=async(name:string,args:Record<string,unknown>,id:string)=>
    await executeBrowserTool(run,slots.find(s=>s.name===name)!,args,id,activation) as Record<string,any>;
   return {refs,controller,activation,invoke,run};
  }
  const main=bridge();
  const chosen=main.refs.assetChoices().find(c=>c.id===full)!;
  const schema=main.refs.modelSchema(slots.find(s=>s.name==='view_asset_frames')!);
  assert(!validateAgentToolInvocation(schema,{assetId:saved.frameArgs.assetId},[schema]).ok);
  assert(validateAgentToolInvocation(schema,{assetId:chosen.selection},[schema]).ok);
  const revisionSchema=main.refs.modelSchema(slots.find(s=>s.name==='revise_clipmentor_analysis')!);
  const revise={action:'revise',collection:'evidence',expectedRevision:1,reason:'fixture',
   actor:{operator:'fixture',executor:'fixture',instruction:'fixture',identity:'local_declared_not_authenticated'}};
  assert(!validateAgentToolInvocation(revisionSchema,{...revise,id:'handwritten'},[revisionSchema]).ok);
  assert(validateAgentToolInvocation(revisionSchema,{...revise,id:1},[revisionSchema]).ok);
  const rawAuthor=await main.invoke('view_asset_frames',saved.frameArgs,'raw-author-id');
  assert.equal(rawAuthor.error,'reference_selection_required');
  assert.deepEqual(rawAuthor.candidates.map((c:{id:string})=>c.id),[full]);
  const correctedDirect=await main.invoke('view_asset_frames',{...saved.frameArgs,assetId:chosen.selection,
   referenceRetry:rawAuthor.referenceRetry},'selected-actual');
  assert.equal(correctedDirect.assetId,full);
  assert(!main.activation.toolFailures.hasUnresolved);
  hostEditor.context.commands.applyDoc(withCollision);

  const frameCountBeforeRefusals=frameReads;
  const ambiguous=await main.invoke('view_asset_frames',saved.frameArgs,'ambiguous');
  assert.equal(ambiguous.error,'reference_ambiguous');
  assert.deepEqual(ambiguous.candidates.map((c:{id:string})=>c.id).sort(),[full,collisionId].sort());
  const missing=await main.invoke('view_asset_frames',{assetId:'does-not-exist',count:1},'unknown');
  assert.equal(missing.error,'reference_not_registered');
  assert(missing.candidates.some((c:{id:string})=>c.id===full));
  assert(!missing.candidates.some((c:{id:string})=>c.id===testAudio.id));
  assert.equal(frameReads,frameCountBeforeRefusals);
  const unrelated=await main.invoke('view_asset_frames',{assetId:chosen.selection,count:1},'unrelated');
  assert.equal(unrelated.assetId,full);
  assert.equal(main.activation.toolFailures.snapshot().length,2,'same-tool unrelated success leaves both failures open');
  const retry=await main.invoke('view_asset_frames',{...saved.frameArgs,assetId:chosen.selection,referenceRetry:ambiguous.referenceRetry},'corrected-full-id');
  assert.equal(retry.assetId,full);
  assert.deepEqual(main.activation.toolFailures.snapshot().map(f=>f.operation),['unknown']);
  const retryUnknown=await main.invoke('view_asset_frames',{assetId:chosen.selection,count:1,referenceRetry:missing.referenceRetry},'corrected-registered-choice');
  assert.equal(retryUnknown.assetId,full);
  assert(!main.activation.toolFailures.hasUnresolved);
  await flushRunPersistence(main.run);
  const recoveryEvents=main.run.events.filter(event=>event.type==='server-tool-result').map(event=>event.data as Record<string,unknown>);
  assert.deepEqual(recoveryEvents.filter(e=>e.referenceOperation==='ambiguous').map(e=>[e.toolCallId,e.success]),
   [['ambiguous',false],['corrected-full-id',true]]);
  const runtime=await loadAgentRuntimeSidecar(projectId);
  const recorded=runtime.runs.find(r=>r.runId===main.run.id);
  assert(recorded);
  assert.deepEqual(recorded.events.filter(e=>e.type==='tool_outcome').flatMap(e=>{
   const data=JSON.parse(e.summary??'{}').serverEvent?.data;
   return data?.referenceOperation==='ambiguous'?[[data.toolCallId,data.success]]:[];
  }),[['ambiguous',false],['corrected-full-id',true]]);

  const stopped=bridge();
  const repeated={assetId:'unregistered-reference',seconds:[1]};
  assert.equal((await stopped.invoke('view_asset_frames',repeated,'repeat-first')).error,'reference_not_registered');
  assert(!stopped.controller.signal.aborted);
  assert.equal((await stopped.invoke('view_asset_frames',repeated,'repeat-second')).error,'reference_not_registered');
  assert.equal(stopped.controller.signal.reason?.message,productionReferenceStop);
  assert(blueprintRepairStopped({status:'blocked',error:'Error: '+productionReferenceStop}));
  await flushRunPersistence(stopped.run);
  assert.equal(isolatedStore.commitCount,0,'repeated reference failure cannot write analysis');

  hostEditor.context.commands.applyDoc(structuredClone(saved.doc));
  const original=hostEditor.getDoc().clipMentorAnalysis;
  if(original?.source_breakdown){
   const offered=(saved as {rejectedPublicationArgs?:Record<string,any>;frameRejection?:{candidates?:Array<{assetId:string}>}}).rejectedPublicationArgs;
   const audited=(saved as {frameRejection?:{candidates?:Array<{assetId:string}>}}).frameRejection;
   if(fixture)assert.equal(audited?.candidates?.[0].assetId,full);
   const decision=(analysis:typeof original)=>analysis.source_breakdown?.units.map(u=>[u.unit_id,u.teaching_selection?.decision]);
   assert.equal(decision(original)?.length,3);
   if(offered){
    assert.notDeepEqual(offered.record.units.map((u:{unit_id:string;teaching_selection:{decision:string}})=>[u.unit_id,u.teaching_selection.decision]),decision(original));
    assert(offered.record.points.some((p:{point_id:string})=>p.point_id==='P-hand-swatch'));
   }
   const exactBaseline=structuredClone(original.source_breakdown);
   const frameChoices=await main.invoke('read_clipmentor_references',{kind:'frame'},'frame-choice-list');
   assert(frameChoices.choices.length>0);
   const firstFrame=frameChoices.choices[0];
   const sourceRead=await main.invoke('read_clipmentor_analysis',{view:'evidence',evidenceIds:[firstFrame.selection]},'wrong-reference-kind');
   assert.equal(sourceRead.error,'reference_not_registered','a frame selector is not an evidence selector');
   const catalog=new Map<string,number>();
   for(let offset=0;;){
    const page=await main.invoke('read_clipmentor_references',{kind:'evidence',offset},'evidence-page-'+offset);
    for(const c of page.choices)catalog.set(c.id,c.selection);
    if(page.nextOffset===null)break;
    offset=page.nextOffset;
   }
   // Replay the saved write operation against the last published editorial
   // decision. The rejected candidate's third-group swatch rewrite stays a
   // suggestion and is never included in this write.
   const select=(v:unknown):unknown=>{
    if(Array.isArray(v))return v.map(select);
    if(!v||typeof v!=='object')return v;
    return Object.fromEntries(Object.entries(v).map(([key,val])=>[key,/_evidence_ids$|^evidence_ids$/.test(key)
     ?(val as string[]).map(id=>{assert(catalog.has(id));return catalog.get(id);})
     :select(val)]));
   };
   const evidenceChoice=catalog.get(firstFrame.id)!;
   assert(evidenceChoice);
   assert(!isFailedToolResult(await main.invoke('read_clipmentor_analysis',{view:'evidence',evidenceIds:[evidenceChoice],
    referenceRetry:sourceRead.referenceRetry},'correct-reference-kind')));
   const args={action:'set_source_breakdown',actor:{operator:'offline reference replay',executor:'fixture',
    instruction:'No change to confirmed decisions',identity:'local_declared_not_authenticated'},reason:'Register the same analysis locally',
    ...offered,expectedRevision:original.revision,record:select(exactBaseline)};
   if(offered){
    const variant=await main.invoke('revise_clipmentor_analysis',{...args,record:select(offered.record)},'reject-swatch-group-change');
    assert.equal(variant.ok,true,'the replay exercises a structurally valid but editorially forbidden edit');
    await assert.rejects(hostEditor.commit(),/production_reference_repair_confirmed_teaching_changed/);
    assert.equal(isolatedStore.commitCount,0);
    hostEditor.context.commands.applyDoc(structuredClone(saved.doc));
   }
   const write=await main.invoke('revise_clipmentor_analysis',args,'save-isolated-analysis');
   assert(!isFailedToolResult(write),JSON.stringify(write));
   assert.equal(write.revision,original.revision+1);
   await flushRunPersistence(main.run);
   assert(!main.activation.toolFailures.hasUnresolved);
   await hostEditor.commit();
   const cold=JSON.parse(await readFile(join(isolated,'analysis-readback.json'),'utf8')) as ProjectDoc;
   assert.equal(cold.clipMentorAnalysis?.revision,original.revision+1);
   assert.deepEqual(decision(cold.clipMentorAnalysis!),decision(original));
   assert.deepEqual(cold.clipMentorAnalysis?.source_breakdown,exactBaseline);
   assert.deepEqual(cold.clipMentorAnalysis?.blueprint,original.blueprint);
   assert.equal(revisionOf(cold),hostEditor.revision);
   if(process.env.CLIPMENTOR_OFFLINE_REFERENCE_REPORT)
    await writeFile(process.env.CLIPMENTOR_OFFLINE_REFERENCE_REPORT,JSON.stringify({
     oldRejection:audited,result:'saved_and_cold_read',revisionBefore:original.revision,revisionAfter:cold.clipMentorAnalysis?.revision,
     isolatedProjectRevision:hostEditor.revision,confirmedGroups:decision(original),suggestion:{sourceEvidence:'V-end',text:'手背试色只供第 1 组回看或选题参考，逐条色号未确认。'},
     sameOperation:recoveryEvents.filter(e=>e.referenceOperation==='ambiguous').map(e=>({callId:e.toolCallId,success:e.success})),
     extractedRealFrames:!!sourcePath,providerRequests,negativeCases:['ambiguous','unknown','repeated','swatch_group_change'],originalChanged:false,
    },null,2)+'\n');
  }
 }finally{await hostEditor.close();}

 const authorInput={blueprint:{units:[],source_evidence:[]},sourceEvidence:[{text:'Only this exact quote is registered.'}]};
 const authorRows=['S1','S2','S3','S4','S5','S6','S7'].map(id=>({id,status:'ok',reference_ids:[1],reason:'Read the registered material.'}));
 const receipt=(rows:unknown)=>readAuthorCheckAttachment(JSON.stringify(rows),authorInput,'numbered');
 assert.deepEqual(receipt(authorRows).checks.map(check=>check.reference),authorRows.map(()=>['Only this exact quote is registered.']));
 assert.equal(receipt(authorRows.map(row=>({...row,reference_ids:['sourceEvidence.0.text']}))).referenceIssues?.length,7);
 assert.equal(receipt(authorRows.map(row=>({...row,reference_ids:[2]}))).referenceIssues?.length,7);
 const ordered=readAuthorCheckAttachment(JSON.stringify(authorRows),{description:'Registered description.',text:'Registered text.'},'numbered');
 const reordered=readAuthorCheckAttachment(JSON.stringify(authorRows),{text:'Registered text.',description:'Registered description.'},'numbered');
 assert.deepEqual(reordered,ordered,'numbered replay must keep quote identity across equivalent object ordering');

 const checks=['S2','S3','S4','S5','S6','S7'].map(id=>({id,status:'ok' as const,reference:'same guide text',reason:'validated'}));
 const remainingCheck=checks.filter(c=>c.id!=='S5').map(c=>c.id==='S2'?{...c,status:'fix' as const}:c);
 const stages: string[]=[];
 const reviewTask={input:{brief:'same guide text',panelDelivery:{blueprintQuality:'v1',editorialPolicy:'exemplar-v1'},budget:{model:2,maxElapsedMs:60000}},
  effects:{},createdAt:Date.now(),repairs:0,attempts:{model:0}} as import('./production-task').ProductionTask;
 const context={signal:new AbortController().signal,remaining:()=>2,async effect<T>(_kind:unknown,name:string):Promise<T>{
  stages.push(name);
  const retry=name.endsWith(':format-retry');
  return {digest:'same-packet',sourceDigest:name.split(':')[1],runId:'receipt',checks:retry?checks:remainingCheck,
   ...(!retry?{referenceIssues:[{field:'S5.reference[0]',material:'draft'}]}:{})} as T;
 }};
 const prep={reviewed:{subject:{digest:'same-packet'}},rawPacket:{units:[],source_evidence:[]}} as unknown as
  Awaited<ReturnType<typeof import('./production-readiness').createProductionPreparation>>;
 const merged=await checkProductionAuthorBlueprint(reviewTask,context,projectDoc(),prep,'guide',[],undefined,true);
 assert.equal(stages.length,2);
 assert.equal(merged.checks.find(c=>c.id==='S2')?.status,'fix','a reference correction cannot overwrite a validated finding');
 assert.equal(merged.checks.find(c=>c.id==='S5')?.status,'ok','the originally invalid row can be corrected');
 const {productionAuthorSelfCheckSource}=await import('./production-author-self-check');
 const legacySource={...productionAuthorSelfCheckSource(projectDoc(),prep,['same guide text'],true),panelTeachingReview:true,
  editorialPolicy:'exemplar-v1',teachingPurpose:(await import('../../src/agent/skills/clipmentor/references/teaching-purpose.json')).default,
  repairReview:[],unchangedReviewedDelivery:[]};
 const unchanged=structuredClone(reviewTask);
 unchanged.repairs=1;
 unchanged.repairContext={blueprint_digest:'same-packet',author_self_check_source_digest:digestValue({source:legacySource,guide:'guide'})};
 await assert.rejects(checkProductionAuthorBlueprint(unchanged,context,projectDoc(),prep,'guide',[],undefined,true),/蓝图返修未改变送审内容/);
 assert.equal(stages.length,2,'changing the citation format does not justify a new attempt on an unchanged subject');

 const generation=await loadedProductionGeneration;
 const start={qualityRules:'v1' as const,commit:'1'.repeat(40),trackedChanges:false};
 const now=Date.now();
 const task={version:1,projectId,taskId:'generation-fixture',input:{panelDelivery:{blueprintQuality:'v1'},blueprintGeneration:start,
  budget:{model:0,review:0,observation:0,tts:0,render:0,maxElapsedMs:120000,maxRepairs:2}},stage:'analysis',status:'queued',
  createdAt:now,updatedAt:now,sequence:1,repairs:0,feedbackUsed:false,completed:{},effects:{},attempts:{model:0,review:0,observation:0,tts:0,render:0}} as import('./production-task').ProductionTask;
 let current=structuredClone(task);
 const checkpoints:typeof task[]=[];
 const tasks={async load(){return structuredClone(current);},async save(t:typeof task){t.sequence++;t.updatedAt++;current=structuredClone(t);checkpoints.push(current);}};
 const paused=async()=>{throw Error('Fixture pauses before any effect');};
 await advanceProductionTask(task,paused,tasks);
 assert.equal(task.executionGenerations?.[0].kind,'start');
 assert.equal(task.executionGenerations?.[0].referenceRules,'registered-v1');
 assert.equal(checkpoints[0].executionGenerations?.[0].checkpoint,checkpoints[0].sequence);
 task.repairs=1;
 current=structuredClone(task);
 await advanceProductionTask(task,paused,tasks);
 assert.deepEqual(task.input.blueprintGeneration,start);
 assert.deepEqual(task.executionGenerations?.map(g=>[g.kind,g.commit,g.qualityRules,g.repairEpoch]),
  [['start',generation.commit,'v1',0],['resume',generation.commit,'v1',1]]);
 assert.equal(providerRequests,0);
 console.log('ClipMentor reference replay: structured selection, unique prefix, ambiguous/unknown choices, one operation retry, fail closed, durable generation, zero provider calls'
  +(fixture?', actual JUDYDOLL saved analysis/cold read verified':''));
}finally{
 globalThis.fetch=oldFetch;
 if(oldProfile===undefined)delete process.env.OPENCHATCUT_DATA_DIR;
 else process.env.OPENCHATCUT_DATA_DIR=oldProfile;
 await rm(isolated,{recursive:true,force:true});
}
