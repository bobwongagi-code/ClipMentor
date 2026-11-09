import assert from 'node:assert/strict';
import {makeDraft} from '../../src/editor/store';
import type {AgentContext} from '../../src/agent/context';
import type {ProjectDoc} from '../../src/editor/types';
import {executeCodexTool} from '../../src/agent/runtime';
import {ToolActivation} from '../../src/agent/tool-activation';
import {DEFAULT_AGENT_SETTINGS} from '../../src/agent/settings/agentSettings';
import {TOOL_SCHEMAS} from '../../src/agent/tools';
import {execEditItemTool} from '../../src/agent/tools/edit-item-tools';
import {executeTool} from '../../src/agent/tools';
import {executeCoreEditItem} from './headless-edit-item';
import {openHeadlessEditor} from './headless-editor';
import {executeOfflineTool} from '../external-agent/offline-executor';
import {MemoryPersistence,projectDoc,projectId} from '../external-agent/offline-runtime.verify-fixtures';
import {revisionOf} from '../../src/agent/external-edit-session';
import fixture from '../../src/agent/tools/fixtures/barely-there-mg-replacement-20261030.json';

const network=globalThis.fetch;let networkCalls=0,passed=0;const failures:string[]=[];
globalThis.fetch=async()=>{networkCalls++;throw Error('Network forbidden');};
const context=(doc:ProjectDoc):AgentContext=>({...makeDraft(structuredClone(doc)),templates:[],audio:[],getCreativeMode:()=>null,getProjectId:()=>projectId});
const options=(persistence:MemoryPersistence,extra:Record<string,unknown>={})=>({projectId,runId:'execution-fixture',origin:'http://127.0.0.1:5199',
 review:{provider:'openai' as const,model:'fixture',origin:'http://127.0.0.1:5199',apiMode:'responses' as const},persistence,browserConnected:()=>false,
 effect:async<T>(_kind:unknown,_key:string,work:(id:string)=>Promise<T>)=>work('fixture-operation'),...extra});
async function test(name:string,work:()=>unknown){try{await work();passed++;console.log(`PASS ${name}`);}catch(e){failures.push(name);console.error(`FAIL ${name}: ${e}`);}}
function base(){const d=makeDraft(projectDoc());d.commands.addTextClip({text:'OLD',startFrame:0,durationInFrames:30,track:'track-v1'});return d.getDoc();}
function canonical(doc:ProjectDoc,original:ProjectDoc){
 const old=new Set(original.timelines.flatMap(t=>t.items.map(i=>i.id)));
 const ids=new Map(doc.timelines.flatMap(t=>t.items).filter(i=>!old.has(i.id)).map((i,index)=>[i.id,`new-${index}`]));
 return JSON.parse(JSON.stringify(doc,(_key,v)=>typeof v==='string'?(ids.get(v)??v):v));
}
try{
 await test('actual browser runtime and server preserve the same replacement contract',async()=>{
  const doc=base(),ui=context(doc),server=context(doc),args={adds:[{type:'text',text:'REPLACED',track:'V1',startFrame:0,durationInFrames:30}],deletes:[{type:'text',itemId:doc.timelines[0]!.items[0]!.id}]};
  const result=await executeCodexTool({name:'edit_item',args,activation:new ToolActivation(TOOL_SCHEMAS,[]),ctx:ui,onEvent:()=>undefined,settings:DEFAULT_AGENT_SETTINGS});
  assert.equal(result.execution.success,true,JSON.stringify(result.execution.result));assert.equal(executeCoreEditItem(args,server).ok,true);
  assert.deepEqual(canonical(server.getDoc(),doc),canonical(ui.getDoc(),doc));
 });
 await test('same-track replacement has the same slot and result in both hosts',async()=>{
  const doc=base(),id=doc.timelines[0]!.items[0]!.id;
  const args={adds:[{type:'text',text:'NEW',track:'V1',startFrame:0,durationInFrames:30}],deletes:[{type:'text',itemId:id}]};
  const ui=context(doc),server=context(doc);
  const a=await execEditItemTool('edit_item',args,ui),b=executeCoreEditItem(args,server);
  assert.equal((a as any).ok,true);assert.equal(b.ok,true);assert.deepEqual(canonical(server.getDoc(),doc),canonical(ui.getDoc(),doc));
  assert.equal(server.getState().items[0]!.startFrame,0);
 });
 await test('real saved MG replacement applies source AND position/props',async()=>{
  const doc=fixture.before as unknown as ProjectDoc,args={...fixture.args,validateOnly:false};
  const ui=context(doc),server=context(doc);assert.equal((await execEditItemTool('edit_item',args,ui) as any).ok,true);
  assert.equal(executeCoreEditItem(args,server).ok,true);assert.deepEqual(canonical(server.getDoc(),doc),canonical(ui.getDoc(),doc));
 });
 await test('protected native image cannot be removed by the server path',()=>{
  const doc=fixture.before as unknown as ProjectDoc,c=context(doc);
  const native=doc.timelines[0]!.items.find(i=>i.kind==='image'&&i.startFrame===0)!;assert(native);
  const r=executeCoreEditItem({deletes:[{type:'image',itemId:native.id}]},c);
  assert.equal(r.ok,false);assert.match(String(r.error),/delivery_native_picture/);assert.deepEqual(c.getDoc(),doc);
 });
 await test('cancelled core edit does not publish',()=>{
  const doc=base(),c=context(doc);c.getAgentRunSignal=()=>AbortSignal.abort();
  assert.equal(executeCoreEditItem({updates:[{type:'text',itemId:c.getState().items[0]!.id,props:{text:'LATE'}}]},c).ok,false);
  assert.deepEqual(c.getDoc(),doc);
 });
 await test('invalid final entry is atomic in both hosts',async()=>{
  const doc=base(),args={updates:[{type:'text',itemId:doc.timelines[0]!.items[0]!.id,props:{text:'STAGED'}},{type:'text',itemId:'missing',props:{text:'BAD'}}]};
  for(const run of [async(c:AgentContext)=>execEditItemTool('edit_item',args,c),async(c:AgentContext)=>executeCoreEditItem(args,c)]){
   const c=context(doc);assert.equal((await run(c) as any).ok,false);assert.deepEqual(c.getDoc(),doc);
  }
 });
 await test('dry run shares validation and publishes nothing',async()=>{
  const doc=base(),args={updates:[{type:'text',itemId:doc.timelines[0]!.items[0]!.id,props:{text:'DRY'}}],validateOnly:true};
  const ui=context(doc),server=context(doc);assert.deepEqual(executeCoreEditItem(args,server),await execEditItemTool('edit_item',args,ui));
  assert.deepEqual(server.getDoc(),doc);assert.deepEqual(ui.getDoc(),doc);
 });
 await test('common read and property tools agree across browser/offline/server',async()=>{
  const doc=base(),ui=context(doc),offline=context(doc),p=new MemoryPersistence(doc),e=await openHeadlessEditor(options(p));
  try{
   const args={itemId:doc.timelines[0]!.items[0]!.id,props:{text:'CONSISTENT'}};
   assert.equal((await executeTool('update_item_props',args,ui) as any).ok,true);
   assert.equal((await executeOfflineTool('update_item_props',args,offline) as any).ok,true);
   await e.execute('update_item_props',args,'update');assert.deepEqual(e.getDoc(),ui.getDoc());assert.deepEqual(offline.getDoc(),ui.getDoc());
   const a=await executeTool('read_project',{},ui),b=await executeOfflineTool('read_project',{},offline),c=await e.execute('read_project',{},'read');
   assert.deepEqual(a,b);assert.deepEqual(c,a);
  }finally{await e.close();}
 });
 await test('successful mutation returns a committed project revision',async()=>{
  const p=new MemoryPersistence(base()),e=await openHeadlessEditor(options(p));
  try{const r=await e.execute('update_item_props',{itemId:e.getDoc().timelines[0]!.items[0]!.id,props:{text:'SAVED'}},'save') as any;
   assert.equal(r.saved,true);assert.equal(r.projectRevision,revisionOf(p.current));assert.equal(r.projectId,projectId);
  }finally{await e.close();}
  const e2=await openHeadlessEditor(options(p));try{assert.equal(e2.getDoc().timelines[0]!.items[0]!.props!.text,'SAVED');}finally{await e2.close();}
 });
 await test('already cancelled editor refuses commit',async()=>{
  const p=new MemoryPersistence(base()),abort=new AbortController(),e=await openHeadlessEditor(options(p,{signal:abort.signal}));
  try{const doc=structuredClone(e.getDoc());doc.timelines[0]!.items[0]!.props!.text='LATE';e.context.commands.applyDoc(doc);abort.abort(Error('deadline'));
   await assert.rejects(e.commit(),/deadline|abort|cancel/i);assert.equal(p.commitCount,0);
  }finally{await e.close();}
 });
 await test('cancellation while commit is queued is checked at actual write',async()=>{
  const p=new MemoryPersistence(base()),abort=new AbortController();
  const original=p.commitProject.bind(p);let entered!:()=>void,release!:()=>void;const entering=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  p.commitProject=async input=>{entered();await gate;return original(input);};
  const e=await openHeadlessEditor(options(p,{signal:abort.signal}));
  try{const pending=e.execute('update_item_props',{itemId:e.getDoc().timelines[0]!.items[0]!.id,props:{text:'LATE'}},'late');await entering;abort.abort(Error('deadline'));release();
   await assert.rejects(pending);assert.equal(p.commitCount,0);assert.equal(p.current.timelines[0]!.items[0]!.props!.text,'OLD');
  }finally{release();await e.close();}
 });
 await test('concurrent failed edit cannot erase a successful edit',async()=>{
  const p=new MemoryPersistence(base()),e=await openHeadlessEditor(options(p));
  try{const id=e.getDoc().timelines[0]!.items[0]!.id;
   await Promise.all([e.execute('update_item_props',{itemId:id,props:{text:'KEPT'}},'keep'),e.execute('edit_item',{updates:[{type:'text',itemId:'missing',props:{text:'BAD'}}]},'bad')]);
   assert.equal(e.getDoc().timelines[0]!.items[0]!.props!.text,'KEPT');assert.equal(p.current.timelines[0]!.items[0]!.props!.text,'KEPT');
  }finally{await e.close();}
 });
 await test('stale project and lost ownership remain blocked',async()=>{
  for(const lose of [false,true]){const p=new MemoryPersistence(base()),e=await openHeadlessEditor(options(p));
   try{if(lose)p.ownership=null;else p.current.timelines[0]!.items[0]!.props!.text='OTHER';
    await assert.rejects(e.execute('update_item_props',{itemId:e.getDoc().timelines[0]!.items[0]!.id,props:{text:'BAD'}},'stale'),/ownership/i);
    assert.equal(p.commitCount,0);
   }finally{await e.close();}}
 });
 await test('foreign project ID is refused before any mutation',async()=>{
  const p=new MemoryPersistence(base()),e=await openHeadlessEditor(options(p));
  try{await assert.rejects(e.execute('update_item_props',{projectId:'wrong',itemId:e.getDoc().timelines[0]!.items[0]!.id,props:{text:'BAD'}},'wrong'),/binding/);assert.equal(p.commitCount,0);}finally{await e.close();}
 });
 await test('close during an actual pending write rejects late publication',async()=>{
  const p=new MemoryPersistence(base()),original=p.commitProject.bind(p);
  let entered!:()=>void,release!:()=>void;const entering=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  p.commitProject=async input=>{entered();await gate;return original(input);};
  const e=await openHeadlessEditor(options(p));
  const pending=e.execute('update_item_props',{itemId:e.getDoc().timelines[0]!.items[0]!.id,props:{text:'LATE'}},'closing');
  await entering;const closing=e.close();release();await assert.rejects(pending);await closing;
  assert.equal(p.commitCount,0);assert.equal(p.ownership,null);
 });
 await test('export snapshot survives failure and polling does not require edit ownership',async()=>{
  const p=new MemoryPersistence(base());let fail=false,submits=0;
  const transport:typeof fetch=async(url,init)=>{
   if(init?.method==='POST'){submits++;if(fail)return Response.json({error:'Export failed'},{status:500});
    const body=JSON.parse(String(init.body));assert.equal(body.project.timelines[0].items[0].props.text,'COMMITTED');
    return Response.json({renderId:'fixture-operation',projectRevision:revisionOf(body.project),timelineId:body.timelineId});
   }
   return Response.json({id:new URL(String(url)).pathname.split('/').at(-1),status:'completed',result:{path:'/media/uploads/fixture.mp4'}});
  };
  const e=await openHeadlessEditor(options(p,{fetch:transport}));
  try{
   await e.execute('update_item_props',{itemId:e.getDoc().timelines[0]!.items[0]!.id,props:{text:'COMMITTED'}},'edit');
   const saved=JSON.stringify(p.current);fail=true;await assert.rejects(e.execute('submit_render_job',{},'failed'),/Export failed/);
   assert.equal(JSON.stringify(p.current),saved);fail=false;
   const submitted=await e.execute('submit_render_job',{},'export') as any;assert.equal(submitted.projectRevision,revisionOf(p.current));
   await e.close();assert.equal(p.ownership,null);
   const other=await openHeadlessEditor(options(p));
   try{assert.equal((await e.readExport(submitted.renderId)).status,'completed');assert.equal(submits,2);}finally{await other.close();}
  }finally{await e.close();}
 });
 await test('completed preview is durable before task publication and survives temporary export cleanup',async()=>{
  const fs=await import('node:fs/promises'),path=await import('node:path'),os=await import('node:os');
  const {promoteExportResult,cleanupStaleExportFiles}=await import('../plugins/export-runtime');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'clipmentor-preview-publish-'));
  const id='00000000-0000-4000-8000-000000000009',name=`openchatcut-export-job-${id}.mp4`;
  const result={assetId:id,path:`/media/uploads/${name}`,sizeBytes:5,durationSeconds:1};let promotes=0,gets=0;
  const p=new MemoryPersistence(base()),e=await openHeadlessEditor(options(p,{fetch:async(url,init)=>{
   if(init?.method==='POST'){promotes++;assert.equal(new URL(String(url)).pathname,'/export/job/fixture-operation/promote');return Response.json(await promoteExportResult(result,directory));}
   gets++;return Response.json({id:'fixture-operation',status:'succeeded',result});
  }}));
  try{await fs.writeFile(path.join(directory,name),'video');const read=await e.readExport('fixture-operation');
   assert.equal(read.result.path,`/media/uploads/openchatcut-derived-${id}.mp4`,'must not publish a one-hour temporary URL');
   assert.equal(promotes,1);assert.equal(gets,1);assert.equal(p.commitCount,0,'publishing media does not edit the project');
   const old=new Date(Date.now()-7200000);await fs.utimes(path.join(directory,name),old,old);
   await cleanupStaleExportFiles(directory);await assert.rejects(fs.stat(path.join(directory,name)));
   assert.equal(await fs.readFile(path.join(directory,read.result.path.split('/').at(-1)),'utf8'),'video');
  }finally{await e.close();await fs.rm(directory,{recursive:true,force:true});}
 });
 await test('preview promotion refuses failure and foreign identity without another render or project write',async()=>{
  for(const state of ['failed-promotion','wrong-id','wrong-path','running','already-durable']){
   const p=new MemoryPersistence(base());let posts=0;
   const id='00000000-0000-4000-8000-000000000009',source=`/media/uploads/openchatcut-export-job-${id}.mp4`,target=`/media/uploads/openchatcut-derived-${id}.mp4`;
   const e=await openHeadlessEditor(options(p,{fetch:async(_url,init)=>{
    if(init?.method==='POST'){posts++;return Response.json({assetId:state==='wrong-id'?'foreign':id,path:state==='wrong-path'?'/media/uploads/foreign.mp4':target},{status:state==='failed-promotion'?500:200});}
    return Response.json({id:'fixture-operation',status:state==='running'?'running':'completed',result:{assetId:id,path:state==='already-durable'?target:source}});
   }}));
   try{if(['running','already-durable'].includes(state)){await e.readExport('fixture-operation');assert.equal(posts,0);}
    else {await assert.rejects(e.readExport('fixture-operation'),/publication|promotion/i);assert.equal(posts,1);}
    assert.equal(p.commitCount,0);
   }finally{await e.close();}
  }
 });
 await test('render recovery queries the original ID only and refuses missing or mismatched jobs',async()=>{
  for(const state of ['completed','missing','wrong','no-binding','stale-binding']){
   const p=new MemoryPersistence(base());let posts=0,gets=0;
   const e=await openHeadlessEditor(options(p,{
    fetch:async(_url:unknown,init:RequestInit)=>{if(init?.method==='POST')posts++;else gets++;
     return Response.json({id:state==='wrong'?'other-job':'fixture-operation',status:state,params:state==='no-binding'?undefined:{projectRevision:state==='stale-binding'?'old':revisionOf(p.current),timelineId:p.current.activeTimelineId}},{status:state==='missing'?404:200});},
    effect:async(_kind:unknown,_key:unknown,_work:unknown,recover:(id:string)=>unknown)=>recover('fixture-operation'),
   }));
   try{if(state==='completed')assert.equal((await e.execute('submit_render_job',{},'resume') as any).renderId,'fixture-operation');
    else await assert.rejects(e.execute('submit_render_job',{},'resume'),/unavailable|mismatch/);
    assert.equal(posts,0);assert.equal(gets,1);
   }finally{await e.close();}
  }
 });
 await test('cached export receipt cannot be rebound to a changed project',async()=>{
  const p=new MemoryPersistence(base());let cached:unknown,posts=0;
  const e=await openHeadlessEditor(options(p,{
   fetch:async(_url:unknown,init:RequestInit)=>{posts++;const body=JSON.parse(String(init.body));return Response.json({renderId:'fixture-operation',projectRevision:revisionOf(body.project),timelineId:body.timelineId});},
   effect:async(_kind:unknown,_key:unknown,work:(id:string)=>Promise<unknown>)=>cached??(cached=await work('fixture-operation')),
  }));
  try{await e.execute('submit_render_job',{},'same');await e.execute('update_item_props',{itemId:e.getDoc().timelines[0]!.items[0]!.id,props:{text:'NEW VERSION'}},'edit');
   await assert.rejects(e.execute('submit_render_job',{},'same'),/Cached render snapshot/);assert.equal(posts,1);
  }finally{await e.close();}
 });
 await test('dry-run and blocked edits are never labelled as saved commits',async()=>{
  const p=new MemoryPersistence(base()),e=await openHeadlessEditor(options(p));
  try{for(const args of [
   {updates:[{type:'text',itemId:e.getDoc().timelines[0]!.items[0]!.id,props:{text:'DRY'}}],validateOnly:true},
   {updates:[{type:'text',itemId:'missing',props:{text:'BAD'}}]},
  ]){const r=await e.execute('edit_item',args,'no-save') as any;assert.equal(r.saved,undefined);assert.equal(p.commitCount,0);}}
  finally{await e.close();}
 });
 await test('browser takeover during queued commit refuses the actual write',async()=>{
  const p=new MemoryPersistence(base()),original=p.commitProject.bind(p);let busy=false;
  let entered!:()=>void,release!:()=>void;const entering=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  p.commitProject=async input=>{entered();await gate;return original(input);};
  const e=await openHeadlessEditor(options(p,{browserConnected:()=>busy}));
  try{const pending=e.execute('update_item_props',{itemId:e.getDoc().timelines[0]!.items[0]!.id,props:{text:'LATE'}},'takeover');await entering;busy=true;release();await assert.rejects(pending);assert.equal(p.commitCount,0);}
  finally{release();await e.close();}
 });
 await test('100-clip batch commits once with no per-item persistence',async()=>{
  const p=new MemoryPersistence(projectDoc()),e=await openHeadlessEditor(options(p));const start=performance.now();
  try{
   const r=await e.execute('edit_item',{adds:Array.from({length:100},(_,i)=>({type:'text',text:`Item ${i}`,track:'V1',startFrame:i*30,durationInFrames:30}))},'bulk') as any;
   assert.equal(r.ok,true);assert.equal(r.saved,true);assert.equal(p.commitCount,1);assert.equal(p.current.timelines[0]!.items.length,100);
   for(const [i,item] of p.current.timelines[0]!.items.entries())assert.equal(item.startFrame,i*30);
   console.log(`PERF 100 clips: ${(performance.now()-start).toFixed(2)}ms, commits=${p.commitCount}, providerCalls=0`);
  }finally{await e.close();}
 });
 assert.equal(networkCalls,0);console.log(`Execution contract: ${passed} passed, ${failures.length} failed, zero external calls`);
 assert.deepEqual(failures,[]);
}finally{globalThis.fetch=network;}
