import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {createMiniConnect} from '../../desktop/mini-connect';
import {createProductionCapacity,isProductionCapacityFull} from './production-capacity';

const slots=createProductionCapacity(1);
const release=slots.reserve('first');
assert.throws(()=>slots.reserve('other'),isProductionCapacityFull);
const aborted=new AbortController();
const cancelled=slots.wait('cancelled',aborted.signal);
const other=slots.wait('other');
const sibling=await slots.wait('first');
aborted.abort();
assert.equal(await cancelled,undefined);
release();
assert.equal(slots.running,1,'the sibling owns the same slot');
sibling?.();
const freeOther=await other;
assert.equal(slots.running,1);
freeOther?.();
freeOther?.();
assert.equal(slots.running,0);

const directory=await mkdtemp(join(tmpdir(),'clip-task-workspace-'));
process.env.OPENCHATCUT_DATA_DIR=directory;
process.env.OPENCHATCUT_DEV_PROFILE_ID=randomUUID();
const {runtimeProfile}=await import('../runtime-profile');
assert.equal(runtimeProfile().rootDir,directory);
const {clipMentorProductionPlugin}=await import('../plugins/clipmentor-production');
const {createProductionTask,productionTaskStore}=await import('./production-task');
const {getStoredEntry,setStoredEntry}=await import('../plugins/project-store');
const {loadOfflineStoredProject}=await import('../external-agent/offline-project-store');
const entered=new Set<string>();
const gates=new Map<string,PromiseWithResolvers<void>>();
const worker=clipMentorProductionPlugin(async task=>{
  if(task.stage==='analysis'){
    entered.add(task.projectId);
    await gates.get(task.projectId)?.promise;
  }
  if(task.stage==='copy_review'){
    return {artifact:{revision:(await loadOfflineStoredProject(task.projectId))!.revision,authorSelfCheck:'passed',gate:{allowed:true}}};
  }
  return {artifact:{fixture:true}};
});
const app=createMiniConnect(error=>{throw error;});
const server=createServer((req,res)=>app.handle(req,res));
server.listen(0,'127.0.0.1');
await once(server,'listening');
const address=server.address();
assert(address&&typeof address==='object');
const origin=`http://127.0.0.1:${address.port}`;
(worker.configureServer as (config:unknown)=>void)({
  httpServer:server,config:{server:{port:address.port}},
  middlewares:{use:(url:string,fn:(req:IncomingMessage,res:ServerResponse)=>void)=>app.use(url,fn)},
});
const request=(route:string,body?:unknown)=>fetch(origin+'/api/clipmentor/'+route,{
  method:body?'POST':'GET',headers:{Origin:origin,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json'},
  ...(body?{body:JSON.stringify(body)}:{}),
});
async function until(predicate:()=>Promise<boolean>|boolean){
  for(let attempt=0;attempt<150;attempt++){
    if(await predicate())return;
    await sleep(20);
  }
  throw Error('Fixture checkpoint did not settle');
}

const projects=Array.from({length:6},()=>randomUUID());
const fixtureInput=(projectId:string)=>({
  projectId,sourceAssetId:'test-video',product:{name:'Test product',category:'test'},brief:'isolated workspace fixture',
  author:{provider:'openai' as const,model:'fixture',apiMode:'responses' as const},
  reviewer:{provider:'openai' as const,model:'fixture',apiMode:'responses' as const},humanBlueprintReview:true as const,
  budget:{model:0,review:0,observation:0,tts:0,render:0,maxElapsedMs:15_000,maxRepairs:0},
});
const submit=(projectId:string)=>request('production-task',{action:'create',input:fixtureInput(projectId)});
try{
  assert.equal((await fetch(origin+'/api/clipmentor/task-workspace')).status,403);
  for(const [index,id] of projects.entries()){
    gates.set(id,Promise.withResolvers<void>());
    const created=await request('task-workspace',{id,name:`任务 ${index+1}`});
    assert.equal(created.status,201);
    assert.equal((await created.json()).name,`任务 ${index+1}`);
  }
  const duplicate=await request('task-workspace',{id:projects[0],name:'Do not overwrite'});
  assert.equal((await duplicate.json()).name,'任务 1');
  const indexed=(await getStoredEntry('projects')).value as Array<{id:string;name:string;taskName:string}>;
  assert.equal(indexed.find(row=>row.id===projects[0])?.name,'未命名任务');
  assert.equal(indexed.find(row=>row.id===projects[0])?.taskName,'任务 1');
  const replies=await Promise.all(projects.map(submit));
  assert.equal(replies.filter(reply=>reply.status===202).length,5);
  const denied=replies.findIndex(reply=>reply.status===409);
  assert.notEqual(denied,-1);
  assert.equal((await replies[denied].json()).reason,'capacity');
  const acceptedIndex=replies.findIndex(reply=>reply.status===202);
  const accepted=await replies[acceptedIndex].json();
  await until(()=>entered.size===5);
  const busy=await (await request('task-workspace')).json();
  assert.deepEqual([busy.running,busy.limit,busy.tasks.length],[5,5,6]);
  assert.equal(busy.tasks.filter((task:{status:string})=>task.status==='running').length,5);
  assert.equal(busy.tasks.find((task:{id:string})=>task.id===projects[denied]).status,'materials');
  assert(!entered.has(projects[denied]));
  gates.get(projects[acceptedIndex])?.resolve();
  await until(async()=>{
    const task=await productionTaskStore.load(projects[acceptedIndex],accepted.taskId);
    const workspace=await (await request('task-workspace')).json();
    return task.status==='awaiting_blueprint'&&workspace.running===4;
  });
  assert.equal((await submit(projects[denied])).status,202);
  await until(()=>entered.size===6);
  assert.equal((await (await request('task-workspace')).json()).running,5);
  for(const gate of gates.values())gate.resolve();
  await until(async()=>(await (await request('task-workspace')).json()).running===0);
  console.log('workspace: six simultaneous starts, one denied; human review frees a slot; second start admitted');

  const projectId=randomUUID();
  await request('task-workspace',{id:projectId});
  const {uploadDir}=await import('../media-dir');
  const {ffmpegBin}=await import('../media-binaries');
  const video=join(uploadDir(),'workspace-preview.mp4');
  await mkdir(uploadDir(),{recursive:true});
  execFileSync(ffmpegBin(),['-loglevel','error','-y','-f','lavfi','-i','color=s=720x1280:r=30',
    '-f','lavfi','-i','anullsrc','-t','0.4','-c:v','libx264','-c:a','aac',video]);
  const videoBytes=await readFile(video);
  const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
  const poster=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH1sAAAAASUVORK5CYII=','base64');
  const posterFile=join(uploadDir(),'fixture-cta.png');
  await writeFile(posterFile,poster);
  const document=(await loadOfflineStoredProject(projectId))!.doc;
  document.assets.push({id:'cta',kind:'image',name:'fixture-cta.png',src:'/media/uploads/fixture-cta.png',
    width:1,height:1,durationInFrames:30,sourceRevision:`source-sha256-${hash(poster)}`,sourceContentHash:hash(poster)});
  await setStoredEntry('project:'+projectId,document);
  const {revision}=(await loadOfflineStoredProject(projectId))!;
  const task=await createProductionTask({...fixtureInput(projectId),panelDelivery:{
    productAssetId:'product',productAssetHash:'1'.repeat(64),salesAssetId:'sales',ctaAssetId:'cta',ctaAssetHash:hash(poster),audience:'new_contact',
  }});
  Object.assign(task,{stage:'self_check',status:'blocked',projectRevision:revision});
  task.completed.export={at:Date.now(),artifact:{
    revision,path:'/media/uploads/workspace-preview.mp4',renderId:'workspace-render',
    videoSha256:hash(videoBytes),sizeBytes:videoBytes.length,durationSeconds:.4,width:720,height:1280,fps:30,facts_digest:'2'.repeat(64),
  }};
  await productionTaskStore.save(task);
  const download=(view:string,assetId?:string,renderId='workspace-render')=>request('production-task?'+new URLSearchParams({
    projectId,view,renderId,...(assetId?{assetId}:{}),
  }));
  const draft=await download('panel_draft_download');
  assert.equal(draft.status,200);
  assert.match(draft.headers.get('content-disposition')??'',/unreviewed-/);
  assert.deepEqual(Buffer.from(await draft.arrayBuffer()),videoBytes);
  assert.equal((await download('panel_download')).status,409,'pending file is ineligible for final download');
  assert.equal((await download('panel_draft_download',undefined,'wrong-version')).status,409);
  const thumbnail=await download('panel_poster');
  assert.equal(thumbnail.status,200);
  assert.equal(thumbnail.headers.get('content-type'),'image/jpeg');
  assert.deepEqual(Buffer.from(await thumbnail.arrayBuffer()).subarray(0,3),Buffer.from([255,216,255]));
  assert.equal((await download('panel_poster',undefined,'wrong-version')).status,409);
  const material=await download('panel_material','cta');
  assert.equal(material.status,200);
  assert.deepEqual(Buffer.from(await material.arrayBuffer()),poster);
  assert.equal((await download('panel_material','product')).status,409,'different audience material is not offered');
  await writeFile(posterFile,Buffer.from('different bytes'));
  assert.equal((await download('panel_material','cta')).status,409,'mutated attachment is rejected');
  const issue='point:teaching:not_supported';
  task.repairContext={receipt:{projectId,videoSha256:hash(videoBytes),scope:'rendered_preview_continuous_review',full_film_accepted:false,
    result:{issues:[issue],finish_reasons:['STOP']},effective_review:{manifest_binding:'frozen_at_request',blockers:[issue]}}};
  await productionTaskStore.save(task);
  assert.equal((await download('panel_draft_download')).status,409,'bound negative review prevents early download');
  assert.equal((await download('panel_video')).status,200,'the same preview is still playable');
  console.log('workspace: saved preview download, final refusal, audience attachment binding and hold passed');
}finally{
  for(const gate of gates.values())gate.resolve();
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  await rm(directory,{recursive:true,force:true});
}
