// The real HTTP enqueue/read path, with all render permits held: zero renders/providers.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm,readdir,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
const root=await mkdtemp(join(tmpdir(),'export-receipt-')),previous=process.env.OPENCHATCUT_DATA_DIR;
process.env.OPENCHATCUT_DATA_DIR=root;
try{
 const {registerExportJobRoute}=await import('../plugins/export-job-routes');
 const {exportPlugin}=await import('../plugins/export');exportPlugin(); // production cleanup/retention registration
 const {acquireExportPermit,resolveMaxActiveExports}=await import('../plugins/export-runtime');
 const {projectDoc}=await import('../external-agent/offline-runtime.verify-fixtures');
 const {makeDraft}=await import('../../src/editor/store');
 const {revisionOf}=await import('../../src/agent/external-edit-session');
 const {uploadDir}=await import('../media-dir');await mkdir(uploadDir(),{recursive:true});
 let handler:((req:any,res:any)=>Promise<void>)|undefined;
 registerExportJobRoute({middlewares:{use(route:string,fn:typeof handler){assert.equal(route,'/export/job');handler=fn;}},config:{logger:{warn:()=>undefined}}} as never);assert(handler);
 const releases:Array<()=>void>=[];
 for(let i=0;i<resolveMaxActiveExports();i++)releases.push(await acquireExportPermit());
 const server=createServer((req,res)=>{if(!req.url?.startsWith('/export/job')){res.statusCode=404;res.end();return;}req.url=req.url.slice('/export/job'.length)||'/';void handler!(req,res);});
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address==='object');
 const url=`http://127.0.0.1:${address.port}/export/job`;
 const draft=makeDraft(projectDoc(320,180));draft.commands.addTextClip({text:'Receipt fixture',startFrame:0,durationInFrames:30,track:'track-v1'});
 const doc=draft.getDoc(),jobIds:string[]=[];
 const post=async(body:unknown)=>{const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200,await response.clone().text());return response.json();};
 try{
  const id=randomUUID();jobIds.push(id);
  const first=await post({operationId:id,state:draft.getState(),project:doc,timelineId:doc.activeTimelineId});
  assert.equal(first.renderId,id);assert.equal(first.projectRevision,revisionOf(doc));assert.equal(first.timelineId,doc.activeTimelineId);
  const snapshot=await (await fetch(`${url}/${id}`)).json();assert.equal(snapshot.params.projectRevision,first.projectRevision);assert.equal(snapshot.params.timelineId,doc.activeTimelineId);
  assert.notEqual(snapshot.status,'succeeded','render cannot run while permits are held');
  const changed=structuredClone(doc);changed.timelines[0]!.items[0]!.props!.text='DIFFERENT';
  const duplicate=await post({operationId:id,state:changed.timelines[0],project:changed,timelineId:doc.activeTimelineId});
  assert.equal(duplicate.projectRevision,revisionOf(doc),'a reused ID returns its actual original snapshot, never the latest request identity');
  assert.notEqual(duplicate.projectRevision,revisionOf(changed));
  const concurrentId=randomUUID();jobIds.push(concurrentId);
  const parallel=await Promise.all([post({operationId:concurrentId,state:draft.getState(),project:doc}),post({operationId:concurrentId,state:changed.timelines[0],project:changed})]);
  assert.equal(parallel[0].projectRevision,parallel[1].projectRevision,'concurrent duplicates identify the single winning snapshot');
  assert.equal(parallel[0].renderId,parallel[1].renderId);
  const {createGenerationJob,deleteGenerationJob}=await import('../plugins/generation-jobs');
  const foreignId=randomUUID();await createGenerationJob({kind:'fixture-other'},async()=>{throw Error('fixture terminal job');},{operationId:foreignId});
  const foreign=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operationId:foreignId,state:draft.getState(),project:doc})});
  assert.equal(foreign.status,400);assert.match(await foreign.text(),/different job kind/);await deleteGenerationJob(foreignId);
  const legacyId=randomUUID();jobIds.push(legacyId);const legacy=await post({operationId:legacyId,state:draft.getState()});
  assert.equal(legacy.renderId,legacyId);assert.equal(legacy.projectRevision,undefined,'ordinary state-only exports remain valid');
 }finally{
  for(const id of jobIds){const cancelled=await fetch(`${url}/${id}`,{method:'DELETE'});assert.equal(cancelled.status,204,await cancelled.text());}
  releases.forEach(release=>release());await new Promise<void>(r=>server.close(()=>r()));
 }
 assert(!(await readdir(uploadDir())).some(name=>name.endsWith('.mp4')),'no renderer created a video');
 console.log('Export HTTP receipt: actual POST/GET persisted snapshot binding, duplicate ID cannot relabel old output, legacy state-only compatible; queue cancelled before render, zero provider calls');
}finally{if(previous===undefined)delete process.env.OPENCHATCUT_DATA_DIR;else process.env.OPENCHATCUT_DATA_DIR=previous;await rm(root,{recursive:true,force:true});}
