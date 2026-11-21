// The real HTTP enqueue/read path, with all render permits held: zero renders/providers.
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,rm,readdir,mkdir,writeFile,utimes,readFile,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomUUID} from 'node:crypto';
const root=await mkdtemp(join(tmpdir(),'export-receipt-')),previous=process.env.OPENCHATCUT_DATA_DIR;
const previousSqlite=process.env.OPENCHATCUT_SQLITE_STORE;
process.env.OPENCHATCUT_DATA_DIR=root;
process.env.OPENCHATCUT_SQLITE_STORE='0';
try{
 const {registerExportJobRoute}=await import('../plugins/export-job-routes');
 const {exportPlugin}=await import('../plugins/export');exportPlugin(); // production cleanup/retention registration
 const {acquireExportPermit,resolveMaxActiveExports,exportJobFilename,trackExportJobController,forgetExportJobController}=await import('../plugins/export-runtime');
 const {projectDoc}=await import('../external-agent/offline-runtime.verify-fixtures');
 const {makeDraft}=await import('../../src/editor/store');
 const {historyReduce}=await import('../../src/editor/reduce');
 const {revisionOf}=await import('../../src/agent/external-edit-session');
 const {uploadDir}=await import('../media-dir');await mkdir(uploadDir(),{recursive:true});
 const {generationJobStore}= (await import('../runtime-profile')).runtimeProfile();
 let handler:((req:any,res:any)=>Promise<void>)|undefined;
 registerExportJobRoute({middlewares:{use(route:string,fn:typeof handler){assert.equal(route,'/export/job');handler=fn;}},config:{logger:{warn:()=>undefined}}} as never);assert(handler);
 const releases:Array<()=>void>=[];
 for(let i=0;i<resolveMaxActiveExports();i++)releases.push(await acquireExportPermit());
 let watchedPost:{opened?:()=>void;closed:()=>void;handled:()=>void}|undefined;
 const server=createServer((req,res)=>{
  if(!req.url?.startsWith('/export/job')){res.statusCode=404;res.end();return;}
  const watch=req.method==='POST'?watchedPost:undefined;
  if(watch){res.once('close',watch.closed);watch.opened?.();}
  req.url=req.url.slice('/export/job'.length)||'/';
  void handler!(req,res).finally(()=>watch?.handled());
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address==='object');
 const url=`http://127.0.0.1:${address.port}/export/job`;
 const draft=makeDraft(projectDoc(320,180));draft.commands.addTextClip({text:'Receipt fixture',startFrame:0,durationInFrames:30,track:'track-v1'});
 const doc=draft.getDoc(),jobIds:string[]=[];
 const post=async(body:unknown)=>{const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,200,await response.clone().text());return response.json();};
 try{
  const unreadableId=randomUUID(),operationUrl=`${url}/${unreadableId}`;
  const lookups=[['GET',operationUrl],['DELETE',operationUrl],['POST',operationUrl+'/promote'],['POST',operationUrl+'/cancel']] as const;
  await writeFile(generationJobStore,'{unfinished');
  const readCodes=async()=>Promise.all(lookups.map(async ([method,path])=>{
   const response=await fetch(path,{method});await response.text();return response.status;
  }));
  assert.deepEqual(await readCodes(),[503,503,503,503],'an unreadable cold ledger is unknown on every render-ID path');
  const unknownSubmission=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},
   body:JSON.stringify({operationId:unreadableId})});
  assert.equal(unknownSubmission.status,503,'cold repeat submission cannot infer absence or start work');
  await unknownSubmission.text();
  const priorColdId=randomUUID(),cancelledStaleId=randomUUID(),cancelledStaleAttempt=randomUUID(),now=Date.now();
  await writeFile(generationJobStore,JSON.stringify({version:1,jobs:[{
   id:priorColdId,status:'failed',progress:100,params:{kind:'export',projectRevision:'original-revision',timelineId:'timeline-1'},
   createdAt:now,updatedAt:now,
  },{
   id:cancelledStaleId,status:'failed',progress:100,code:'export_cancelled',
   params:{kind:'export',exportAttemptId:cancelledStaleAttempt},createdAt:now,updatedAt:now,
  }]}));
  const coldDuplicate=await post({operationId:priorColdId});
  assert.deepEqual(coldDuplicate,{renderId:priorColdId,projectRevision:'original-revision',timelineId:'timeline-1'},
   'a cold duplicate must read the existing job before validating new render input');
  assert.deepEqual(await readCodes(),[404,404,404,404],'a healthy ledger can establish that an ID is absent');
  jobIds.push(priorColdId);
  const id=randomUUID();jobIds.push(id);
  const submissionId=randomUUID();
  const first=await post({operationId:id,submissionId,state:draft.getState(),project:doc,timelineId:doc.activeTimelineId});
  assert.equal(first.renderId,id);assert.equal(first.projectRevision,revisionOf(doc));assert.equal(first.timelineId,doc.activeTimelineId);
  assert.equal(first.submissionId,submissionId);
  const snapshot=await (await fetch(`${url}/${id}`)).json();assert.equal(snapshot.params.projectRevision,first.projectRevision);assert.equal(snapshot.params.timelineId,doc.activeTimelineId);
  assert.equal(snapshot.params.exportSubmissionId,submissionId,'recovery can identify the original admission even after losing its response');
  assert.notEqual(snapshot.status,'succeeded','render cannot run while permits are held');
  const changed=structuredClone(doc);changed.timelines[0]!.items[0]!.props!.text='DIFFERENT';
  const duplicate=await post({operationId:id,submissionId:randomUUID(),state:changed.timelines[0],project:changed,timelineId:doc.activeTimelineId});
  assert.equal(duplicate.submissionId,submissionId,'a duplicate POST returns the token of its actual owner');
  assert.equal(duplicate.projectRevision,revisionOf(doc),'a reused ID returns its actual original snapshot, never the latest request identity');
  assert.notEqual(duplicate.projectRevision,revisionOf(changed));
  const concurrentId=randomUUID();jobIds.push(concurrentId);
  const parallel=await Promise.all([post({operationId:concurrentId,state:draft.getState(),project:doc}),post({operationId:concurrentId,state:changed.timelines[0],project:changed})]);
  assert.equal(parallel[0].projectRevision,parallel[1].projectRevision,'concurrent duplicates identify the single winning snapshot');
  assert.equal(parallel[0].renderId,parallel[1].renderId);
  const reusedId=randomUUID();
  const originalAttempt=await post({operationId:reusedId,state:draft.getState()});
  const stopOriginal=async()=>fetch(`${url}/${reusedId}/cancel?attemptId=${originalAttempt.attemptId}`,{method:'POST'});
  const until=Date.now()+4000;
  for(;;){
   const response=await stopOriginal();await response.text();
   if(response.status===204)break;
   assert.equal(response.status,202);assert(Date.now()<until);await new Promise(r=>setTimeout(r,30));
  }
  assert.equal((await fetch(`${url}/${reusedId}`,{method:'DELETE'})).status,204);
  const replacement=await post({operationId:reusedId,state:draft.getState()});
  jobIds.push(reusedId);
  assert.notEqual(replacement.attemptId,originalAttempt.attemptId);
  assert.equal((await stopOriginal()).status,409,'delayed cancellation cannot stop a replacement under the same ID');
  const {createGenerationJob,deleteGenerationJob,getGenerationJobSnapshot}=await import('../plugins/generation-jobs');
  const foreignId=randomUUID();await createGenerationJob({kind:'fixture-other'},async()=>{throw Error('fixture terminal job');},{operationId:foreignId});
  const foreign=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operationId:foreignId,state:draft.getState(),project:doc})});
  assert.equal(foreign.status,400);assert.match(await foreign.text(),/different job kind/);
  assert.equal((await fetch(`${url}/${foreignId}/cancel`,{method:'POST'})).status,404);
  await deleteGenerationJob(foreignId);
  const legacyId=randomUUID();jobIds.push(legacyId);const legacy=await post({operationId:legacyId,state:draft.getState()});
  assert.equal(legacy.renderId,legacyId);assert.equal(legacy.projectRevision,undefined,'ordinary state-only exports remain valid');
  const finishedId=randomUUID(),assetId=randomUUID(),filename=exportJobFilename(assetId,'mp4'),file=join(uploadDir(),filename);
  const output=Buffer.from('synthetic fixture bytes');
  const controller=new AbortController(),started=Promise.withResolvers<void>(),complete=Promise.withResolvers<void>(),finished=Promise.withResolvers<void>();
  await createGenerationJob({kind:'export',exportAttemptId:assetId},async()=>{
   started.resolve();await complete.promise;
   return {assetId,path:'/media/uploads/'+filename,kind:'video',name:'Fixture',sizeBytes:output.length,durationSeconds:1};
  },{operationId:finishedId,cleanupPolicy:'server-export',onSettled:id=>{forgetExportJobController(id);finished.resolve();}});
  await started.promise;
  trackExportJobController(finishedId,controller);
  await writeFile(file,output);
  complete.resolve();await finished.promise;
  const lateCancellation=await fetch(`${url}/${finishedId}/cancel`,{method:'POST'});
  assert.equal(lateCancellation.status,409,'a cancellation racing a completed render must keep the successful result');
  assert.match(await lateCancellation.text(),/result was retained/);
  assert.equal(getGenerationJobSnapshot(finishedId)?.status,'succeeded');
  const status=async()=>{const answer=await fetch(`${url}/${finishedId}`);assert.equal(answer.status,200);return answer.json();};
  assert.equal((await status()).result.path,'/media/uploads/'+filename);
  for(const bytes of [null,Buffer.from('short')]){
   if(bytes===null)await rm(file);
   else await writeFile(file,bytes);
   const unavailable=await status();
   assert.equal(unavailable.id,finishedId);
   assert.equal(unavailable.status,'failed','missing or truncated export cannot be reported as deliverable');
   assert.equal(unavailable.result,undefined);
   assert.equal(unavailable.retryable,false);
   assert.equal(getGenerationJobSnapshot(finishedId)?.status,'succeeded','the original receipt remains a historical fact');
   const promotion=await fetch(`${url}/${finishedId}/promote`,{method:'POST'});
   assert.equal(promotion.status,500,'promotion must use the same receipt/file checks');
   await promotion.text();
   await assert.rejects(readFile(join(uploadDir(),`openchatcut-derived-${assetId}.mp4`)),{code:'ENOENT'});
  }
  await writeFile(file,output);
  assert.equal((await status()).status,'succeeded','same-ID readback works again once the original file is available');
  const staleAttemptId=randomUUID();
  const directStatus=await fetch(`${url}/${finishedId}?attemptId=${staleAttemptId}`);
  assert.equal(directStatus.status,409,'a stale status read must not expose the replacement output');
  const staleDelete=await fetch(`${url}/${finishedId}?attemptId=${staleAttemptId}`,{method:'DELETE'});
  assert.equal(staleDelete.status,409,'a stale cleanup must leave the replacement output intact');
  assert.equal((await fetch(`${url}/${finishedId}?attemptId=`,{method:'DELETE'})).status,409,
    'legacy browser cleanup must leave a modern attempt intact');
  assert.deepEqual(await readFile(file),output);
  const matchingStatus=await fetch(`${url}/${finishedId}?attemptId=${assetId}`);
  assert.equal(matchingStatus.status,200);
  assert.equal((await matchingStatus.json()).result.assetId,assetId);
  const outdatedPromotion=await fetch(`${url}/${finishedId}/promote?attemptId=${randomUUID()}`,{method:'POST'});
  assert.equal(outdatedPromotion.status,409,'an older reader cannot promote a replacement render attempt');
  await outdatedPromotion.text();
  const outdatedOutput=await fetch(`${url}/${finishedId}/promote?assetId=${randomUUID()}`,{method:'POST'});
  assert.equal(outdatedOutput.status,409,'an older reader cannot promote a replacement output without an attempt ID');
  await outdatedOutput.text();
  await assert.rejects(readFile(join(uploadDir(),`openchatcut-derived-${assetId}.mp4`)),{code:'ENOENT'});
  const promotion=await fetch(`${url}/${finishedId}/promote?attemptId=${assetId}`,{method:'POST'});
  assert.equal(promotion.status,200);
  await promotion.text();
  assert.deepEqual(await readFile(join(uploadDir(),`openchatcut-derived-${assetId}.mp4`)),output);
  const {setStoredEntry,deleteStoredEntry}=await import('../plugins/project-store');
  const recoveryKey='export-recovery:'+finishedId;
  const cancelledRecoveryKey='export-recovery:'+cancelledStaleId;
  await setStoredEntry(recoveryKey,{version:1,renderId:finishedId,stage:'output-ready'});
  await setStoredEntry(cancelledRecoveryKey,{version:1,renderId:cancelledStaleId,stage:'polling'});
  assert.notEqual(finishedId,assetId,'legacy export output ID differs from its persisted operation ID');
  const orphan=join(uploadDir(),exportJobFilename(randomUUID(),'mp4'));
  const activeAlias=join(uploadDir(),exportJobFilename(snapshot.params.exportAttemptId,'mp4'));
  const cancelledAlias=join(uploadDir(),exportJobFilename(cancelledStaleAttempt,'mp4'));
  const obsolete=new Date(Date.now()-3*60*60_000);
  await Promise.all([writeFile(orphan,output),writeFile(activeAlias,output),writeFile(cancelledAlias,output)]);
  await Promise.all([file,orphan,activeAlias,cancelledAlias].map(path=>utimes(path,obsolete,obsolete)));
  const swept=Promise.withResolvers<void>();
  const cleanupServer=createServer();
  const plugin=exportPlugin();
  (plugin.configureServer as (server:unknown)=>void)({httpServer:cleanupServer,middlewares:{use:()=>undefined},
   config:{logger:{info:()=>swept.resolve(),warn:(message:string)=>swept.reject(Error(message))}}});
  try{
   await swept.promise;
   await assert.rejects(readFile(orphan),{code:'ENOENT'});
   await assert.rejects(readFile(cancelledAlias),{code:'ENOENT'},'cancelled output can expire with a browser recovery record');
   assert.deepEqual(await readFile(file),output,'startup cleanup must resolve an older output to the operation that still needs it');
   assert.deepEqual(await readFile(activeAlias),output,'cleanup cannot evict an active attempt older than the sweep threshold');
   assert.equal((await status()).result.path,'/media/uploads/'+filename,'readback uses the original operation after unrelated cleanup');
  }finally{
   cleanupServer.emit('close');
   await rm(activeAlias,{force:true});
   await deleteStoredEntry(recoveryKey);
   await deleteStoredEntry(cancelledRecoveryKey);
  }
  const blockedLedger=generationJobStore+'.cleanup-backup';
  await rename(generationJobStore,blockedLedger);await mkdir(generationJobStore);
  try{
   const failedRemovals=await Promise.all([finishedId,id].map(renderId=>fetch(`${url}/${renderId}`,{method:'DELETE'})));
   for(const response of failedRemovals){
    assert.equal(response.status,503,'failed durable removal must be an explicit unknown HTTP result');
    await response.text();
   }
   assert.deepEqual(await readFile(file),output);
   assert.equal(getGenerationJobSnapshot(finishedId)?.status,'succeeded');
   assert.equal(getGenerationJobSnapshot(id)?.status,'queued','an unreadable ledger cannot authorize cancellation');
  }finally{
   await rm(generationJobStore,{recursive:true,force:true});await rename(blockedLedger,generationJobStore);
  }
  const released=await fetch(`${url}/${finishedId}?attemptId=${assetId}`,{method:'DELETE'});
  assert.equal(released.status,204,'the original task can be cleared after the ledger is writable');
  await assert.rejects(readFile(file),{code:'ENOENT'});
  const promoted=join(uploadDir(),`openchatcut-derived-${assetId}.mp4`);
  assert.deepEqual(await readFile(promoted),output,'published media survives cleanup of its temporary export');
  await rm(promoted);
  const incompleteId=randomUUID();
  const incompleteOpened=Promise.withResolvers<void>(),incompleteClosed=Promise.withResolvers<void>(),incompleteHandled=Promise.withResolvers<void>();
  watchedPost={opened:incompleteOpened.resolve,closed:incompleteClosed.resolve,handled:incompleteHandled.resolve};
  const incomplete=httpRequest(url,{method:'POST',headers:{'Content-Type':'application/json'}});
  incomplete.on('error',()=>undefined);
  incomplete.write('{"operationId":'+JSON.stringify(incompleteId)+',');
  await incompleteOpened.promise;
  incomplete.destroy();await incompleteClosed.promise;await incompleteHandled.promise;
  watchedPost=undefined;
  assert.equal(getGenerationJobSnapshot(incompleteId),undefined,'a disconnected, incomplete request must not reserve a render');
  const {jobs}=await import('../plugins/generation-job-store');
  const {registerGenerationRetentionGuard}=await import('../plugins/generation-jobs');
  const priorId=randomUUID(),operationId=randomUUID();
  const priorSettled=Promise.withResolvers<void>(),checking=Promise.withResolvers<void>(),resume=Promise.withResolvers<void>();
  await createGenerationJob({kind:'fixture'},async()=>{throw Error('fixture expired job');},
   {operationId:priorId,cleanupPolicy:'server-export',onSettled:priorSettled.resolve});
  await priorSettled.promise;
  jobs.get(priorId)!.updatedAt=obsolete.getTime();
  registerGenerationRetentionGuard('server-export',async renderId=>{
   if(renderId!==priorId)return false;
   checking.resolve();await resume.promise;return true;
  });
  const closed=Promise.withResolvers<void>(),handled=Promise.withResolvers<void>();
  watchedPost={closed:closed.resolve,handled:handled.resolve};
  const disconnect=new AbortController();
  const request=fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},signal:disconnect.signal,
   body:JSON.stringify({operationId,state:draft.getState(),project:doc})}).catch(()=>undefined);
  try{
   await checking.promise;
   disconnect.abort();await closed.promise;
   watchedPost=undefined;
   let history=historyReduce({past:[],present:doc,future:[]},{type:'tl.setDoc',doc:changed});
   assert.notEqual(revisionOf(history.present),revisionOf(doc));
   const secondId=randomUUID();
   const second=await post({operationId:secondId,state:history.present.timelines[0],project:history.present});
   jobIds.push(secondId);
   assert.equal(second.projectRevision,revisionOf(changed));
   history=historyReduce(history,{type:'undo'});
   assert.equal(revisionOf(history.present),revisionOf(doc));
   resume.resolve();await handled.promise;
   jobIds.push(operationId);
   const recovered=await (await fetch(`${url}/${operationId}`)).json();
   assert.equal(recovered.id,operationId);
   assert.equal(recovered.status,'queued','disconnecting after preflight must not cancel an accepted asynchronous render');
   assert.equal(recovered.params.projectRevision,revisionOf(history.present),'A resumes with its original input after admitting B and undoing B');
   assert.equal((await (await fetch(`${url}/${secondId}`)).json()).params.projectRevision,revisionOf(changed),
    'undo and A readback leave B attached to its own admitted snapshot');
  }finally{
   resume.resolve();await request;watchedPost=undefined;
   exportPlugin();await deleteGenerationJob(priorId);
  }
 }finally{
  for(const id of jobIds){
   const deadline=Date.now()+8000;
   const existing=await (await fetch(`${url}/${id}`)).json();
   const attemptId=existing.params?.exportAttemptId;
   for(;;){
    const attempt=attemptId?`?attemptId=${encodeURIComponent(attemptId)}`:'';
    const requested=await fetch(`${url}/${id}/cancel${attempt}`,{method:'POST'});await requested.text();
    if(requested.status!==202)break;
    assert(Date.now()<deadline,'queued cancellation did not settle');await new Promise(r=>setTimeout(r,50));
   }
   const deleted=await fetch(`${url}/${id}`,{method:'DELETE'});assert.equal(deleted.status,204,await deleted.text());
  }
  releases.forEach(release=>release());await new Promise<void>(r=>server.close(()=>r()));
 }
 assert(!(await readdir(uploadDir())).some(name=>name.endsWith('.mp4')),'no renderer created a video');
 console.log('Export HTTP receipt: persisted POST/GET binding, disconnect → B → undo → same A, correct output retention and cancellation; zero renders and provider calls');
}finally{
 if(previous===undefined)delete process.env.OPENCHATCUT_DATA_DIR;else process.env.OPENCHATCUT_DATA_DIR=previous;
 if(previousSqlite===undefined)delete process.env.OPENCHATCUT_SQLITE_STORE;else process.env.OPENCHATCUT_SQLITE_STORE=previousSqlite;
 await rm(root,{recursive:true,force:true});
}
