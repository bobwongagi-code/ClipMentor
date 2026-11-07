import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import type {ProjectDoc} from '../../src/editor/types';
import type {ProductionTask} from './production-task';

type Counters=Record<string,number>;
const scope=globalThis as typeof globalThis & {handoffEfficiencyTest?:{instrumented:boolean;counts:Counters}};
if(!scope.handoffEfficiencyTest){
 const {build}=await import('esbuild');
 const dir=await mkdtemp(join(process.cwd(),'.cc-efficiency-'));
 const childErrors:unknown[]=[];
 try{
  // Observe real function entries only in the test bundle; no production hooks or caches.
  for(const instrumented of [true,false]){
   const outfile=join(dir,instrumented?'count.mjs':'timing.mjs');
   await build({entryPoints:[resolve('server/clipmentor/handoff-efficiency.verify.ts')],bundle:true,platform:'node',format:'esm',packages:'external',outfile,logLevel:'silent',loader:{'.frag':'text','.vert':'text'},plugins:[{
    name:'test-observation',setup(b){
     b.onResolve({filter:/\?raw$/},args=>({path:resolve(args.resolveDir,args.path.slice(0,-4)),namespace:'raw-text'}));
     b.onLoad({filter:/.*/,namespace:'raw-text'},async args=>({contents:await readFile(args.path,'utf8'),loader:'text',resolveDir:dirname(args.path)}));
     if(instrumented)b.onLoad({filter:/(production-gate|production-readiness|delivery-bindings)\.ts$/},async args=>{
      let contents=await readFile(args.path,'utf8');
      for(const name of ['copyTeachingPacketFromDoc','registeredAudioBindings','deliverySectionsFromDoc']){
       const declaration=new RegExp(`export (?:async )?function ${name}\\([^\\n]+?\\{`);
       contents=contents.replace(declaration,match=>match+`globalThis.handoffEfficiencyTest.counts.${name}=(globalThis.handoffEfficiencyTest.counts.${name}??0)+1;`);
      }
      return{contents,loader:'ts',resolveDir:dirname(args.path)};
     });
    },
   }]});
   scope.handoffEfficiencyTest={instrumented,counts:{}};
   try{await import(pathToFileURL(outfile).href);}catch(error){childErrors.push(error);}
  }
  assert.equal(childErrors.length,0,childErrors.map(String).join('\n'));
 }finally{delete scope.handoffEfficiencyTest;await rm(dir,{recursive:true,force:true});}
}else{
 const root=await mkdtemp(join(tmpdir(),'handoff-efficiency-')),priorData=process.env.OPENCHATCUT_DATA_DIR,priorFetch=globalThis.fetch;
 process.env.OPENCHATCUT_DATA_DIR=root;
 let network=0;globalThis.fetch=async()=>{network++;throw Error('Network forbidden in handoff efficiency regression');};
 const failures:string[]=[];
 try{
  const {default:saved}=await import('../../src/clipmentor/fixtures/production-saved-projects-20261028.json');
  const {default:phased}=await import('../../src/agent/tools/fixtures/barely-there-mg-replacement-20261030.json');
  const {currentExecutionView}=await import('./execution-view');
  const {currentExecutionView:legacyViewRaw,productionAuthorTaskData:oldTaskRaw}=await import('./fixtures/execution-view-before-20261031');
  const {productionAuthorTaskData}=await import('./production-worker');
  const assertTaskUnchanged=(actual:any,previous:any)=>{
   if(actual.stage==='edit'){
    assert.equal(actual.goal.endsWith(previous.goal.slice(previous.goal.indexOf('，')+1)),true,'existing editing protections remain intact');
    for(const term of ['edit_item 的 adds','空数组不代表禁止创建','不得把估算当实测','必须带实际 unitId'])assert(actual.goal.includes(term));
   }else assert.equal(actual.goal,previous.goal);
   const {goal:actualGoal,...a}=actual,{goal:previousGoal,...b}=previous;
   assert.deepEqual(a,b);assert.equal(JSON.stringify(a),JSON.stringify(b));
  };

  const {digestValue}=await import('../agent-runs/store-values');
  // The frozen efficiency baseline contains the independently fixed frame-rounded
  // delivery-duration bug. Adjust only that known output, never the current view.
  const measuredBaseline=(view:any,d:ProjectDoc)=>{
   for(const section of view.packet.delivery_sections??[]){
    const a=view.audio.find((a:any)=>a.line_id===section.line.line_id&&a.status==='reusable');
    if(!a)continue;
    const asset=d.assets.find(x=>x.id===a.assetId)!;
    const seconds=section.voice.existing_audio?.durationSeconds??(asset.props?.generation as any)?.durationSeconds;
    if(typeof seconds==='number')a.durationSeconds=seconds;
   }
   const {view_digest,...body}=view;return{...body,view_digest:digestValue(body)};
  };
  const legacyView=async(d:ProjectDoc)=>measuredBaseline(await legacyViewRaw(d),d);
  const oldTask=async(...args:Parameters<typeof oldTaskRaw>)=>{const value=await oldTaskRaw(...args);if(value.frozenBlueprint)value.frozenBlueprint=measuredBaseline(value.frozenBlueprint,args[1]);return {evidenceInspection:null,...value};};

  const {prepareProductionBlueprint,productionBlueprintReadiness,registeredAudioBindings}=await import('./production-readiness');
  const {copyTeachingPacketFromDoc,buildCopyTeachingReviewRequest,checkCopyProduction}=await import('../../src/clipmentor/production-gate');
  const {runtimeProfile}=await import('../runtime-profile');
  assert.equal(runtimeProfile().rootDir,root);
  const obs=scope.handoffEfficiencyTest;
  const count=async(work:()=>Promise<unknown>)=>{obs.counts={};const result=await work();return{result,counts:{...obs.counts}};};
  const test=async(name:string,work:()=>Promise<void>)=>{try{await work();console.log('PASS',name);}catch(e){failures.push(name+': '+String(e));console.error('FAIL',name,String(e));}};
  const doc=()=>structuredClone(saved.cases[0].doc) as unknown as ProjectDoc;
  const task=(d:ProjectDoc,stage:'audio'|'edit')=>({stage,input:{brief:'Frozen efficiency test',sourceAssetId:d.clipMentorAnalysis!.source.asset_id}} as ProductionTask);

  await test('saved projects: complete execution values, digest, input and review projection unchanged',async()=>{
   for(const entry of saved.cases){
    const d=structuredClone(entry.doc) as unknown as ProjectDoc,original=JSON.stringify(d);
    const request=buildCopyTeachingReviewRequest([{case_id:'same',packet:await copyTeachingPacketFromDoc(d)}]);
    assert.deepEqual(await currentExecutionView(d),await legacyView(d));
    assert.deepEqual(await prepareProductionBlueprint(d),{subject:(await currentExecutionView(d)).subject,packet:request.input.cases[0].packet});
    assert.equal(JSON.stringify(d),original);
    assert.deepEqual(buildCopyTeachingReviewRequest([{case_id:'same',packet:await copyTeachingPacketFromDoc(d)}]),request);
   }
  });
  await test('synthetic treatment reason stays in execution; independent reviewer keeps its distinct projection',async()=>{
   const d=doc();
   // Saved cases lack this optional field: add an explicitly synthetic isolation sentinel.
   d.clipMentorAnalysis!.source_breakdown!.units[0].coverage[0].reason='AUTHOR_TREATMENT_EFFICIENCY_SENTINEL';
   const raw=await copyTeachingPacketFromDoc(d),projected=await prepareProductionBlueprint(d),view=await currentExecutionView(d);
   const reason=raw.units.flatMap(u=>u.points).find(p=>p.treatment_reason);
   assert(reason,'sentinel must actually reach the raw packet');
   assert(view.packet.units.flatMap(u=>u.points).some(p=>p.treatment_reason===reason.treatment_reason));
   assert(!JSON.stringify(projected.packet).includes(JSON.stringify(reason.treatment_reason)),'author treatment reason must not enter reviewer projection');
   assert.deepEqual(view,await legacyView(d));
  });
  await test('actual collaborative handoff retains the entire frozen message and authoritative binding',async()=>{
   const {withSerializedProjectStore}=await import('../plugins/project-store');
   const {registerHandoff,prepareHandoff}=await import('./handoff');
   const {copyReviewSubject}=await import('../../src/clipmentor/production-gate');
   const {revisionOf}=await import('../../src/agent/external-edit-session');
   const d=doc(),projectId='efficiency-handoff-fixture';
   await withSerializedProjectStore(s=>s.writeEntry('project:'+projectId,d));
   const subject=await copyReviewSubject(d);
   await registerHandoff({projectId,expectedProjectRevision:revisionOf(d),previousDigest:null,brief:{version:1,briefId:'efficiency-fixture',revision:1,mode:'collaborative',phase:'execution',planner:'external_codex',executor:'builtin_agent',projectId,timelineId:d.activeTimelineId,objective:'Execute frozen plan',doneCriteria:['Preserve all current facts'],blueprint:{revision:subject.revision,digest:subject.digest},budget:{maxModelTurns:1,maxToolCalls:1,maxElapsedMs:10000,paidToolCalls:{}}}});
   const measured=await count(()=>prepareHandoff(projectId,[{role:'user',content:'Execute unchanged'}]));
   const prepared=measured.result as Awaited<ReturnType<typeof prepareHandoff>>;assert(prepared);
   const sent=JSON.parse(prepared.messages[0].content as string);
   const expected={kind:'task_data_not_control',objective:prepared.policy.brief.objective,doneCriteria:prepared.policy.brief.doneCriteria,taskDetails:'Execute unchanged',blueprint:await legacyView(d),sourceAssets:prepared.policy.assetBindings};
   assert.deepEqual(sent,expected);
   assert.equal(prepared.messages[0].content,JSON.stringify(expected),'actual sent bytes must match the frozen reference');
   const changed=structuredClone(d);changed.clipMentorAnalysis!.revision++;
   await withSerializedProjectStore(s=>s.writeEntry('project:'+projectId,changed));
   await assert.rejects(prepareHandoff(projectId,[{role:'user',content:'Execute unchanged'}]),/blueprint_changed/);
   if(obs.instrumented){console.log('COUNTS handoff',JSON.stringify(measured.counts));assert.equal(measured.counts.copyTeachingPacketFromDoc,2,'admission and execution each derive once; neither gate nor payload is omitted');}
  });
  await test('saved phased opening and ending: audio order, native pictures and error behavior unchanged',async()=>{
   const d=structuredClone(phased.before) as unknown as ProjectDoc;
   const original=JSON.stringify(d),old=await legacyView(d),actual=await currentExecutionView(d);
   assert.equal(actual.packet.delivery_sections?.length,2,'must exercise actual opening and ending, not empty arrays');
   assert(actual.picture_bindings.length>0,'must exercise actual native-picture bindings');
   for(const section of actual.packet.delivery_sections!)assert(actual.audio.some(a=>a.line_id===section.line.line_id));
   assert.deepEqual(actual,old);assert.equal(JSON.stringify(d),original);
   for(const stage of ['audio','edit'] as const){
    const t=task(d,stage),before=await oldTask(t,d),next=await productionAuthorTaskData(t,d);
    assertTaskUnchanged(next,before);
   }
   const bad=structuredClone(d),ir=bad.clipMentorAnalysis!.blueprint[0].internal_review as Record<string,unknown>;
   const plan=ir[String(ir.current_picture_plan)] as {delivery_sections:Array<{picture:{sha256:string}}>};
   plan.delivery_sections[0].picture.sha256='f'.repeat(64);
   const failed=async(f:()=>Promise<unknown>)=>{try{await f();return'NO_ERROR';}catch(e){return String(e);}};
   assert.equal(await failed(()=>currentExecutionView(bad)),await failed(()=>legacyView(bad)));
   assert.notEqual(await failed(()=>currentExecutionView(bad)),'NO_ERROR');
  });
  if(obs.instrumented){
   await test('current execution view derives teaching packet once',async()=>{
    const d=doc(),old=await count(()=>legacyView(d)),next=await count(()=>currentExecutionView(d));
    console.log('COUNTS view',JSON.stringify({before:old.counts,after:next.counts}));
    assert.equal(next.counts.copyTeachingPacketFromDoc,1);
    assert(next.counts.deliverySectionsFromDoc<old.counts.deliverySectionsFromDoc);
   });
   await test('audio/edit task preparation shares packet and measured bindings without caching approval',async()=>{
    for(const stage of ['audio','edit'] as const){
     const d=doc(),t=task(d,stage),old=await count(()=>oldTask(t,d)),next=await count(()=>productionAuthorTaskData(t,d));
     console.log('COUNTS '+stage,JSON.stringify({before:old.counts,after:next.counts}));
     const result=next.result as Awaited<ReturnType<typeof productionAuthorTaskData>>;
     assertTaskUnchanged(result,old.result);
     assert.deepEqual(result.frozenBlueprint,(old.result as Awaited<ReturnType<typeof oldTask>>).frozenBlueprint);
     assert.deepEqual(result.blueprintReadiness,(old.result as Awaited<ReturnType<typeof oldTask>>).blueprintReadiness);
     assert(next.counts.copyTeachingPacketFromDoc<old.counts.copyTeachingPacketFromDoc);
     assert.equal(next.counts.registeredAudioBindings,1);
    }
   });
  }
  await test('same object changed between operations, candidate pointer and audio parse never go stale',async()=>{
   const d=doc();await currentExecutionView(d);registeredAudioBindings(d);
   const u=d.clipMentorAnalysis!.blueprint[0],ir=u.internal_review as Record<string,unknown>,p=ir[String(ir.current_picture_plan)] as {composition:{detail:string}};
   const detail=JSON.parse(p.composition.detail);detail.measured_audio_bindings=[];p.composition.detail=JSON.stringify(detail);
   assert.deepEqual(registeredAudioBindings(d),[]);
   assert.deepEqual(await currentExecutionView(d),await legacyView(d));
   ir.current_picture_plan='missing';
   const failure=async(f:()=>Promise<unknown>)=>{try{await f();return'NO_ERROR';}catch(e){return String(e);}};
   assert.equal(await failure(()=>currentExecutionView(d)),await failure(()=>legacyView(d)));
   assert.notEqual(await failure(()=>currentExecutionView(d)),'NO_ERROR');
  });
  await test('concurrent projects, caller result mutation, and changed review state do not contaminate later operations',async()=>{
   const a=doc(),b=structuredClone(saved.cases.at(-1)!.doc) as unknown as ProjectDoc;
   const [av,bv]=await Promise.all([currentExecutionView(a),currentExecutionView(b)]);
   assert.deepEqual(av,await legacyView(a));assert.deepEqual(bv,await legacyView(b));
   av.audio.splice(0);av.packet.units.splice(0);
   assert.deepEqual(await currentExecutionView(a),await legacyView(a));
   const t=task(a,'edit');await productionAuthorTaskData(t,a);
   a.clipMentorAnalysis!.production_copy_review!.verdict='needs_revision';
   const actual=await productionAuthorTaskData(t,a),expected=await oldTask(t,a);
   assert.deepEqual(actual.blueprintReadiness,expected.blueprintReadiness);
   assert.equal(actual.blueprintReadiness.ready,false);assert.equal((await checkCopyProduction(a,'clipmentor')).allowed,false);
  });
  await test('missing audio and malformed current plan retain error/readiness semantics',async()=>{
   const d=doc();d.assets=d.assets.filter(a=>a.kind!=='audio');
   assert.deepEqual(await currentExecutionView(d),await legacyView(d));
   const result=await productionAuthorTaskData(task(d,'audio'),d),expected=await oldTask(task(d,'audio'),d);
   assert.deepEqual(result.blueprintReadiness,expected.blueprintReadiness);assert.equal(result.blueprintReadiness.ready,false);
   const bad=doc();delete bad.clipMentorAnalysis!.source_breakdown;
   assert.equal((await productionBlueprintReadiness(bad)).next,'blueprint');
   await assert.rejects(currentExecutionView(bad));
  });
  if(!obs.instrumented){
   const percentile=(v:number[],p:number)=>[...v].sort((a,b)=>a-b)[Math.ceil(v.length*p)-1];
   for(const entry of [...saved.cases,{case_id:'saved-phased-opening-ending',doc:phased.before}]){
    const d=structuredClone(entry.doc) as unknown as ProjectDoc,t=task(d,'edit');
    for(const [label,before,after] of [
     ['view',()=>legacyView(d),()=>currentExecutionView(d)],
     ['task',()=>oldTask(t,d),()=>productionAuthorTaskData(t,d)],
    ] as const){
     for(let i=0;i<4;i++){await before();await after();}
     const old:number[]=[],next:number[]=[];
     for(let i=0;i<21;i++)for(const phase of i%2?[1,0]:[0,1]){
      const start=performance.now();await(phase?after():before());(phase?next:old).push(performance.now()-start);
     }
     const stat=(v:number[])=>({p50_ms:percentile(v,.5),p95_ms:percentile(v,.95),min_ms:Math.min(...v),max_ms:Math.max(...v)});
     console.log('TIMING',JSON.stringify({case_id:entry.case_id,path:label,samples:21,before:stat(old),after:stat(next)}));
    }
   }
  }
  assert.equal(network,0);console.log('RESULT',JSON.stringify({instrumented:obs.instrumented,failures,network}));
 }finally{
  globalThis.fetch=priorFetch;
  if(priorData===undefined)delete process.env.OPENCHATCUT_DATA_DIR;else process.env.OPENCHATCUT_DATA_DIR=priorData;
  await rm(root,{recursive:true,force:true});
 }
 if(failures.length)throw Error('Handoff efficiency regression: '+failures.join('\n'));
}
