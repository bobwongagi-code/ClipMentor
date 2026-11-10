import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rename,mkdir,rm,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {renameSync,mkdirSync} from 'node:fs';
import type {GenerationJobTask,GenerationJobOptions,GenerationResult} from './generation-job-types';
const root=await mkdtemp(join(tmpdir(),'generation-state-')),storePath=join(root,'jobs.json');
const beforeEnv={data:process.env.OPENCHATCUT_DATA_DIR,store:process.env.OPENCHATCUT_GENERATION_JOB_STORE,sqlite:process.env.OPENCHATCUT_SQLITE_STORE};
const sqliteMode=process.argv.includes('--sqlite-ledger');
process.env.OPENCHATCUT_DATA_DIR=root;process.env.OPENCHATCUT_GENERATION_JOB_STORE=storePath;process.env.OPENCHATCUT_SQLITE_STORE=sqliteMode?'1':'0';
const originalFetch=globalThis.fetch;let external=0;globalThis.fetch=async()=>{external++;throw Error('External calls forbidden');};
const failures:string[]=[],passes:string[]=[];
const test=async(name:string,work:()=>Promise<void>)=>{try{await work();passes.push(name);console.log('PASS',name);}catch(e){failures.push(name+': '+String(e));console.error('FAIL',name,String(e));}};
const deferred=()=>Promise.withResolvers<void>();
const exists=(path:string)=>access(path).then(()=>true,()=>false);
const result=(id:string):GenerationResult=>({assetId:id,kind:'video',name:'fixture',path:'/media/uploads/'+id+'.mp4',durationSeconds:1});
let jobs:typeof import('./generation-job-store').jobs|undefined;let closeSqlite:(()=>void)|undefined;
try{
 const profile=(await import('../runtime-profile')).runtimeProfile();assert.equal(profile.rootDir,root);assert.equal(profile.generationJobStore,storePath);
 if(sqliteMode){
  const sql=await import('../storage/sqlite-store'),s=await import('./generation-job-store'),{GENERATION_JOBS_KV_KEY:key}=await import('../storage/sqlite-migration');
  jobs=s.jobs;closeSqlite=sql.resetSqliteStoreForTests;await sql.initializeSqliteProjectStore();
  for(const shape of ['missing','empty','legacy','future-version','null-root','future-status','duplicate-id'])await test(`SQLite ledger ${shape}`,async()=>{
   const id=randomUUID(),now=Date.now(),row={id,status:'succeeded',progress:100,params:{kind:'retained'},createdAt:now,updatedAt:now};
   const value=shape==='future-version'?{version:2,jobs:[]}:shape==='null-root'?null:shape==='future-status'?{version:1,jobs:[row,{...row,id:randomUUID(),status:'paused'}]}:shape==='duplicate-id'?{version:1,jobs:[row,row]}:{version:1,jobs:shape==='legacy'?[row]:[]};
   await sql.sqliteWriteAll({});if(shape!=='missing')await sql.sqliteWriteEntry(key,value);
   try{
    if(['missing','empty','legacy'].includes(shape)){
     await s.loadPersistedJobs();if(shape==='legacy'){assert.equal(s.jobs.get(id)!.status,'succeeded');assert.equal(s.jobs.get(id)!.timestamps.createdAt,now);}else assert.equal(s.jobs.size,0);
    }else{await assert.rejects(s.loadPersistedJobs());assert.equal(s.jobs.size,0,'invalid tail cannot partially publish SQL jobs');}
    const after=await sql.sqliteReadEntry(key);if(shape==='missing')assert.equal(after.found,false);else{assert(after.found);assert.deepEqual(after.value,value,'load cannot rewrite unsupported SQLite bytes');}
   }finally{for(const j of s.jobs.values())clearTimeout(j.expiryTimer);s.jobs.clear();}
  });
 }else{
 await test('failed local initialization recovers after the file is repaired',async()=>{
  await writeFile(storePath,'{bad');const path='./generation-job-lifecycle.ts?cold-init';const cold=await import(path) as typeof import('./generation-job-lifecycle');
  await assert.rejects(cold.initializeGenerationJobs());await writeFile(storePath,JSON.stringify({version:1,jobs:[]}));
  await cold.initializeGenerationJobs();assert.equal(await readFile(storePath,'utf8'),JSON.stringify({version:1,jobs:[]}));
 });
 await test('successful hydration does not retry a failed recovery phase',async()=>{
  const s=await import('./generation-job-store'),id=randomUUID(),tool='fixture-'+id,key=tool+':fixture',backup=storePath+'.resumer-backup';let lookups=0,resumerCalls=0;
  const now=Date.now();await writeFile(storePath,JSON.stringify({version:1,jobs:[{id,status:'running',progress:50,params:{},toolName:tool,provider:'fixture',providerTaskId:'retained-task',createdAt:now,updatedAt:now,timestamps:{createdAt:now,submittedAt:now,updatedAt:now,acceptedAt:now}}]}));
  s.registerGenerationJobResumer(tool,'fixture',async()=>{resumerCalls++;return result(id);});
  const get=s.resumers.get;
  s.resumers.get=function(this:typeof s.resumers,k:string){if(k===key&&++lookups===1){renameSync(storePath,backup);mkdirSync(storePath);}return get.call(this,k);};
  try{
   const path='./generation-job-lifecycle.ts?failed-recovery';const cold=await import(path) as typeof import('./generation-job-lifecycle');
   await assert.rejects(cold.initializeGenerationJobs());await rm(storePath,{recursive:true,force:true});await rename(backup,storePath);
   await assert.rejects(cold.initializeGenerationJobs(),'a failed recovery phase must not be re-entered by initialize');assert.equal(lookups,1);assert.equal(resumerCalls,0);
  }finally{s.resumers.get=get;s.resumers.delete(key);const j=s.jobs.get(id);if(j)clearTimeout(j.expiryTimer);s.jobs.delete(id);if(await exists(backup)){await rm(storePath,{recursive:true,force:true});await rename(backup,storePath);}await writeFile(storePath,JSON.stringify({version:1,jobs:[]}));}
 });
 for(const invalid of ['future-version','null-root','future-status','duplicate-id'])await test(`unreadable ${invalid} ledger cannot be overwritten by submission`,async()=>{
  const s=await import('./generation-job-store'),id=randomUUID(),now=Date.now(),row={id,status:'succeeded',progress:100,params:{kind:'retained'},createdAt:now,updatedAt:now};
  const value=invalid==='future-version'?{version:2,jobs:[]}:invalid==='null-root'?null:invalid==='future-status'?{version:1,jobs:[row,{...row,id:randomUUID(),status:'paused'}]}:{version:1,jobs:[row,{...row,params:{kind:'different'}}]};
  const raw=JSON.stringify(value);await writeFile(storePath,raw);let launches=0;const done=deferred();
  try{
   const path='./generation-job-lifecycle.ts?unsupported-'+invalid;const cold=await import(path) as typeof import('./generation-job-lifecycle');
   const outcome=await cold.createGenerationJob({kind:'export'},async jobId=>{launches++;return result(jobId);},{onSettled:()=>done.resolve()}).then(()=>({accepted:true}),()=>({accepted:false}));
   if(outcome.accepted)await done.promise;
   assert.equal(outcome.accepted,false,'unsupported input must not be silently replaced with an empty ledger');assert.equal(s.jobs.size,0,'a rejected ledger must not partially publish its valid prefix');assert.equal(launches,0);assert.equal(await readFile(storePath,'utf8'),raw);
  }finally{for(const j of s.jobs.values())clearTimeout(j.expiryTimer);s.jobs.clear();await writeFile(storePath,JSON.stringify({version:1,jobs:[]}));}
 });
 for(const shape of ['missing','empty','legacy'])await test(`normal ${shape} ledger remains readable without rewriting`,async()=>{
  const s=await import('./generation-job-store'),id=randomUUID(),now=Date.now();
  const raw=JSON.stringify({version:1,jobs:shape==='legacy'?[{id,status:'succeeded',progress:100,params:{kind:'old'},createdAt:now,updatedAt:now}]:[]});
  if(shape==='missing')await rm(storePath,{force:true});else await writeFile(storePath,raw);
  try{
   const path='./generation-job-lifecycle.ts?compatible-'+shape;const cold=await import(path) as typeof import('./generation-job-lifecycle');await cold.initializeGenerationJobs();
   if(shape==='legacy'){assert.equal(cold.getGenerationJobSnapshot(id)!.status,'succeeded');assert.equal(cold.getGenerationJobSnapshot(id)!.timestamps.createdAt,now);}
   else assert.equal(s.jobs.size,0);
   if(shape==='missing')assert.equal(await exists(storePath),false);else assert.equal(await readFile(storePath,'utf8'),raw);
  }finally{for(const j of s.jobs.values())clearTimeout(j.expiryTimer);s.jobs.clear();await writeFile(storePath,JSON.stringify({version:1,jobs:[]}));}
 });
 const store=await import('./generation-job-store'),api=await import('./generation-job-lifecycle');jobs=store.jobs;
 const {ResultDownloadError}=await import('./result-download');await api.initializeGenerationJobs();
 const start=async(task:GenerationJobTask,options:GenerationJobOptions={})=>{
  const done=deferred(),id=options.operationId??randomUUID();
  await api.createGenerationJob({kind:'export'},task,{...options,operationId:id,onSettled:()=>{done.resolve();options.onSettled?.(id);}});
  return{id,done:done.promise};
 };
 const disk=async(id:string)=>JSON.parse(await readFile(storePath,'utf8')).jobs.find((j:any)=>j.id===id);
 for(const outcome of ['succeeded','failed'])for(const callback of ['progress','download','provider'])await test(`late ${callback} after ${outcome} cannot rewrite the ledger`,async()=>{
  let controls!:Parameters<GenerationJobTask>;
  const j=await start(async(...args)=>{controls=args;await args[2]('https://fixture.invalid/original',async()=>result(args[0]));await args[3]('fixture','original-task');if(outcome==='failed')throw new ResultDownloadError('https://fixture.invalid/original','fixture');return result(args[0]);});
  await j.done;const saved=JSON.stringify(api.getGenerationJobSnapshot(j.id)),savedDisk=await disk(j.id);
  if(callback==='progress')await controls[1]({phase:'late-stage',progress:77});
  if(callback==='download')await controls[2]('https://fixture.invalid/late',async()=>result('wrong'));
  if(callback==='provider')await controls[3]('wrong-provider','late-task');
  assert.equal(JSON.stringify(api.getGenerationJobSnapshot(j.id)),saved,'terminal result must be immutable');assert.deepEqual(await disk(j.id),savedDisk);
 });
 for(const callback of ['progress','download','provider'])await test(`old ${callback} cannot affect an explicit download recovery`,async()=>{
  let controls!:Parameters<GenerationJobTask>;const entered=deferred(),release=deferred();
  const j=await start(async(...args)=>{controls=args;await args[2]('https://fixture.invalid/original',async()=>{entered.resolve();await release.promise;return result(args[0]);});throw new ResultDownloadError('https://fixture.invalid/original','fixture');});await j.done;
  const recovery=api.resumeGenerationJobDownload(j.id);await entered.promise;
  try{
   const before=JSON.stringify(api.getGenerationJobSnapshot(j.id));
   if(callback==='progress')await controls[1]({phase:'old-attempt',progress:1});
   if(callback==='download')await controls[2]('https://fixture.invalid/wrong',async()=>result('wrong'));
   if(callback==='provider')await controls[3]('wrong','wrong');
   assert.equal(JSON.stringify(api.getGenerationJobSnapshot(j.id)),before,'closed attempt cannot write into the recovering attempt');
  }finally{release.resolve();await recovery;}
  assert.equal(api.getGenerationJobSnapshot(j.id)!.status,'succeeded');
 });
 await test('two deletions share one cleanup owner',async()=>{
  let cleaned=0;const entered=deferred(),release=deferred();
  const j=await start(async id=>result(id),{cleanupResult:async()=>{cleaned++;entered.resolve();await release.promise;}});await j.done;
  const first=api.deleteGenerationJob(j.id);await entered.promise;const second=api.deleteGenerationJob(j.id);release.resolve();
  assert.deepEqual(await Promise.all([first,second]),[true,true]);assert.equal(cleaned,1,'concurrent deletion cannot run destructive cleanup twice');assert.equal(api.getGenerationJobSnapshot(j.id),undefined);
 });
 await test('retention check excludes download recovery and operation reuse',async()=>{
  const entered=deferred(),release=deferred();let cleaned=0,resumes=0,reused=0;
  store.registerGenerationRetentionGuard('server-export',async()=>{entered.resolve();await release.promise;return false;});
  store.registerGenerationCleanupPolicy('server-export',async()=>{cleaned++;});
  const j=await start(async(id,_u,register)=>{await register('https://fixture.invalid/result',async()=>{resumes++;return result(id);});throw new ResultDownloadError('https://fixture.invalid/result','fixture');},{cleanupPolicy:'server-export'});await j.done;
  const deletion=api.deleteGenerationJob(j.id);await entered.promise;
  try{
   assert.equal(await api.resumeGenerationJobDownload(j.id),false,'a claimed deletion excludes recovery');
   await assert.rejects(api.createGenerationJob({kind:'export'},async id=>{reused++;return result(id);},{operationId:j.id}),'same ID cannot be reused during deletion');
  }finally{release.resolve();await deletion;store.registerGenerationRetentionGuard('server-export',async()=>false);}
  assert.equal(resumes,0);assert.equal(reused,0);assert.equal(cleaned,0,'a failed downloader has no saved result to remove');assert.equal(api.getGenerationJobSnapshot(j.id),undefined);
 });
 await test('a failed durable deletion keeps the actual result file',async()=>{
  const file=join(root,'preserved.mp4');await writeFile(file,'original saved output');let cleaned=0;
  const j=await start(async id=>result(id),{cleanupResult:async()=>{cleaned++;await rm(file);}});await j.done;
  const backup=storePath+'.backup';await rename(storePath,backup);await mkdir(storePath);
  try{await assert.rejects(api.deleteGenerationJob(j.id));}
  finally{await rm(storePath,{recursive:true,force:true});await rename(backup,storePath);}
  assert.equal(cleaned,0,'do not destroy files before durable removal succeeds');assert.equal(await readFile(file,'utf8'),'original saved output');assert.equal(api.getGenerationJobSnapshot(j.id)!.status,'succeeded');await store.persistJobs();
 });
 for(const throws of [false,true])await test(`retention refusal preserves ledger and output (${throws?'error':'held'})`,async()=>{
  let cleaned=0;store.registerGenerationRetentionGuard('server-export',async()=>{if(throws)throw Error('fixture guard');return true;});store.registerGenerationCleanupPolicy('server-export',async()=>{cleaned++;});
  const j=await start(async id=>result(id),{cleanupPolicy:'server-export'});await j.done;const before=await disk(j.id);
  assert.equal(await api.deleteGenerationJob(j.id),false);assert.equal(cleaned,0);assert.deepEqual(await disk(j.id),before);store.registerGenerationRetentionGuard('server-export',async()=>false);
 });
 await test('retention await cannot evict a replacement record',async()=>{
  let cleaned=0;const j=await start(async id=>result(id),{cleanupPolicy:'server-export'});await j.done;
  store.registerGenerationCleanupPolicy('server-export',async()=>{cleaned++;});
  store.registerGenerationRetentionGuard('server-export',async id=>{const previous=store.jobs.get(id)!;store.jobs.set(id,{...previous,params:{kind:'replacement'}});await store.persistJobs();return false;});
  try{assert.equal(await api.deleteGenerationJob(j.id),false);assert.equal(cleaned,0);assert.equal(api.getGenerationJobSnapshot(j.id)!.params.kind,'replacement');assert.equal((await disk(j.id)).params.kind,'replacement');}
  finally{store.registerGenerationRetentionGuard('server-export',async()=>false);}
 });
 await test('scheduled persistence failure preserves bytes and is handled',async()=>{
  const file=join(root,'scheduled.mp4');await writeFile(file,'scheduled saved result');let cleaned=0;
  const j=await start(async id=>result(id),{cleanupResult:async()=>{cleaned++;await rm(file);}});await j.done;
  const backup=storePath+'.scheduled-backup';await rename(storePath,backup);await mkdir(storePath);
  const done=deferred(),errors:unknown[]=[],warn=console.warn;const listener=(error:unknown)=>{errors.push(error);done.resolve();};
  const timeout=setTimeout(()=>done.reject(Error('scheduled cleanup did not settle')),2_000);
  process.on('unhandledRejection',listener);console.warn=(...args)=>{warn(...args);if(String(args[0]).includes('scheduled cleanup failed'))done.resolve();};
  try{
   store.scheduleExpiry(store.jobs.get(j.id)!,0);await done.promise;await new Promise(r=>setImmediate(r));
   assert.equal(errors.length,0);assert.equal(cleaned,0);assert.equal(await readFile(file,'utf8'),'scheduled saved result');assert(api.getGenerationJobSnapshot(j.id));
  }finally{clearTimeout(timeout);process.off('unhandledRejection',listener);console.warn=warn;await rm(storePath,{recursive:true,force:true});await rename(backup,storePath);await store.persistJobs();}
 });
 for(const hook of ['release','observer'])await test(`throwing ${hook} cannot lose a completed task or crash the worker`,async()=>{
  const bad=deferred(),done=deferred();const errors:unknown[]=[];const listener=(error:unknown)=>{errors.push(error);bad.resolve();};process.on('unhandledRejection',listener);
  const id=randomUUID();
  try{
   await api.createGenerationJob({kind:'export'},async()=>result(id),{operationId:id,acquire:async()=>()=>{if(hook==='release')throw Error('fixture release');},onSettled:()=>{done.resolve();if(hook==='observer')throw Error('fixture observer');}});
   await Promise.race([done.promise,bad.promise]);await new Promise(r=>setImmediate(r));
   assert.equal(errors.length,0,'settlement callbacks must not become unhandled failures');assert.equal(api.getGenerationJobSnapshot(id)!.status,'succeeded');assert.equal((await disk(id)).status,'succeeded','completed result must have reached the real ledger');
  }finally{process.off('unhandledRejection',listener);}
 });
 for(const timing of ['delete-before-finally','queued-old-timer'])await test(`old expiry cannot delete a reused ID (${timing})`,async()=>{
  const id=randomUUID(),timerCallbacks:Array<()=>void>=[],handles:Array<ReturnType<typeof setTimeout>>=[];let deleting:Promise<boolean>|undefined,capture=true,newCleaned=0;
  const native=globalThis.setTimeout;
  globalThis.setTimeout=((callback:(...args:any[])=>void,ms?:number,...args:any[])=>{const handle=native(callback,ms,...args);if(capture){timerCallbacks.push(()=>callback(...args));handles.push(handle);}return handle;}) as typeof setTimeout;
  try{
   const old=await start(async()=>result('old'),{operationId:id,retentionMs:60_000,acquire:async()=>()=>{if(timing==='delete-before-finally')deleting=api.deleteGenerationJob(id);}});await old.done;capture=false;
   if(timing==='queued-old-timer'){assert.equal(timerCallbacks.length,1,'capture the actual old expiry closure');deleting=api.deleteGenerationJob(id);}
   assert.equal(await deleting,true);
   const replacement=await start(async()=>result('new'),{operationId:id,retentionMs:600_000,cleanupResult:async()=>{newCleaned++;}});await replacement.done;
   for(const fire of timerCallbacks)fire();
   try{assert.equal(store.isGenerationJobEvicting(id),false,'an old timer must not claim cleanup of the replacement');}
   finally{const deadline=Date.now()+2_000;while(store.isGenerationJobEvicting(id)){assert(Date.now()<deadline);await new Promise(r=>setImmediate(r));}}
   assert.equal(api.getGenerationJobSnapshot(id)!.result!.assetId,'new');assert.equal(newCleaned,0);assert.equal((await disk(id)).result.assetId,'new');
  }finally{globalThis.setTimeout=native;for(const h of handles)clearTimeout(h);}
 });
 }
 if(!sqliteMode)await test('old failed-attempt expiry cannot claim a registered recovery result',async()=>{
  const s=await import('./generation-job-store'),api=await import('./generation-job-lifecycle'),{ResultDownloadError}=await import('./result-download');
  const id=randomUUID(),tool='resume-'+id,done=deferred(),published=deferred(),callbacks:Array<()=>void>=[],handles:Array<ReturnType<typeof setTimeout>>=[];
  const native=globalThis.setTimeout;let capture=true,injections=0;
  globalThis.setTimeout=((callback:(...args:any[])=>void,ms?:number,...args:any[])=>{const h=native(callback,ms,...args);if(capture){callbacks.push(()=>callback(...args));handles.push(h);}return h;}) as typeof setTimeout;
  try{
   await api.createGenerationJob({kind:'video'},async(_id,_u,_d,register)=>{await register('fixture','known-task');throw new ResultDownloadError('https://fixture.invalid/retained','fixture');},{operationId:id,provider:'fixture',toolName:tool,retentionMs:60_000,onSettled:()=>done.resolve()});await done.promise;capture=false;
   assert.equal(callbacks.length,1);
   s.registerGenerationJobResumer(tool,'fixture',async()=>{const value=result('recovered');Object.defineProperty(value,'name',{enumerable:true,get:()=>{if(!injections){injections++;callbacks[0]();published.resolve();}return 'recovered';}});return value;});
   assert.equal(await api.resumeGenerationJobDownload(id),true);await published.promise;
   try{assert.equal(injections,1);assert.equal(s.isGenerationJobEvicting(id),false,'the prior execution timer cannot take the new terminal result');}
   finally{const deadline=Date.now()+2_000;while(s.isGenerationJobEvicting(id)){assert(Date.now()<deadline);await new Promise(r=>setImmediate(r));}}
   await s.persistJobs();assert.equal(api.getGenerationJobSnapshot(id)!.result!.assetId,'recovered');
  }finally{globalThis.setTimeout=native;for(const h of handles)clearTimeout(h);s.resumers.delete(tool+':fixture');}
 });
 assert.equal(external,0);assert.deepEqual(failures,[]);console.log('generation-job-state:',passes.length,'cases passed; local profile only, zero external calls');
}finally{
 if(jobs){for(const j of jobs.values())clearTimeout(j.expiryTimer);jobs.clear();}
 globalThis.fetch=originalFetch;closeSqlite?.();
 for(const [key,value]of Object.entries({OPENCHATCUT_DATA_DIR:beforeEnv.data,OPENCHATCUT_GENERATION_JOB_STORE:beforeEnv.store,OPENCHATCUT_SQLITE_STORE:beforeEnv.sqlite})){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 await rm(root,{recursive:true,force:true});
}
