import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {previewBridge,type PreviewBridgeDependencies} from '../plugins/clipmentor-preview-review';
import {tryLocalOperationLock} from './local-operation-lock';

// Discovery-only probe: no providers, child processes, media engines or installation.
const root='/tmp/cm-cross-preview';
await mkdir(root,{recursive:true});
const evidence=join(root,randomUUID());await mkdir(evidence);
const video=join(evidence,'fixture.mp4');await writeFile(video,'synthetic-preview');
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const directory=join(evidence,'store');
function request(){return {action:'request',projectId:'fixture',operationId:randomUUID(),maxRequests:1,src:'/media/uploads/fixture.mp4',videoSha256:hash('synthetic-preview'),input:{duration_seconds:10,points:[{point_id:'P',teaching_goal_zh:'fixture',product_relevance:'fixture'}],units:[{unit_id:'U',point_ids:['P']}],reference_text:[]}};}
const opDir=(body:ReturnType<typeof request>)=>join(directory,body.projectId,body.operationId);
const ledger=(body:ReturnType<typeof request>)=>join(opDir(body),body.operationId+'.operation.json');
const read=(body:ReturnType<typeof request>,deps:PreviewBridgeDependencies)=>previewBridge({action:'read',projectId:body.projectId,operationId:body.operationId},deps);
const resume=(body:ReturnType<typeof request>,deps:PreviewBridgeDependencies)=>previewBridge({...body,action:'resume_preparation'},deps);
const report:Array<Record<string,unknown>>=[];
const red:string[]=[];
function governed(name:string,check:()=>void){try{check();report.push({oracle:name,status:'PASS'});}catch(error){red.push(name);report.push({oracle:name,status:'RED',error:String(error)});}}
function depsFor(body:ReturnType<typeof request>){let calls=0;const deps:PreviewBridgeDependencies={directory,resolve:()=>video,preparationIdentity:()=> 'same',run:async()=>{calls++;await writeFile(ledger(body),JSON.stringify({status:'reserved',requests_attempted:1}));}};return {deps,calls:()=>calls};}

// Legal regular dispatch and conservative unknown-after-dispatch control.
{
 const body=request(),d=depsFor(body);const result=await previewBridge(body,d.deps);
 assert.equal(d.calls(),1);assert.equal(result.requestsSent,1);
 await previewBridge(body,d.deps);await resume(body,d.deps);assert.equal(d.calls(),1);
 report.push({case:'regular request and terminal repeat',calls:d.calls(),status:'PASS'});
}
{
 const body=request(),d=depsFor(body);d.deps.run=async()=>{throw Error('child may have been launched');};
 const result=await previewBridge(body,d.deps);assert.equal(result.requestsAttempted,1);assert.equal(result.requestOutcome,'unknown');
 report.push({case:'unknown after entering run is deliberately conservative',status:'PASS'});
}
// Legal early cancellation is resumable and unconsumed.
{
 const body=request(),d=depsFor(body);
 await assert.rejects(previewBridge(body,d.deps,AbortSignal.abort(Error('early cancellation'))));
 assert.equal((await read(body,d.deps)).requestsAttempted,0);await resume(body,d.deps);assert.equal(d.calls(),1);
 report.push({case:'early cancellation exact resume',status:'PASS'});
}
// Proven zero dispatch: abort after the first signal check, while identity remains exact.
{
 const body=request(),d=depsFor(body),abort=new AbortController();let checks=0;
 d.deps.preparationIdentity=()=>{if(++checks===2)abort.abort(Error('cancelled before any child dispatch'));return 'same';};
 const result=await previewBridge(body,d.deps,abort.signal);
 const before=await read(body,d.deps),files=await readdir(opDir(body));
 assert.equal(d.calls(),0,'instrumented child dispatch must remain zero');assert(!files.some(n=>n.endsWith('.operation.json')));
 governed('postclaim cancellation reports no attempt',()=>{assert.equal(result.requestsAttempted,0);assert.equal(result.requestOutcome,'not_submitted');});
 governed('postclaim cancellation durable read stays unconsumed',()=>assert.equal(before.requestsAttempted,0));
 d.deps.preparationIdentity=()=> 'same';const recovery=await resume(body,d.deps);
 governed('postclaim cancellation permits exact original resume',()=>assert.equal(d.calls(),1));
 report.push({case:'postclaim cancellation',checks,calls:d.calls(),files,result,before,recovery});
}
// Legal config drift deletes only the new claim; competing receipt read cannot strand it.
{
 const body=request(),d=depsFor(body);let checks=0,concurrentRead:ReturnType<typeof read>|undefined;
 d.deps.preparationIdentity=()=>{if(++checks===3){concurrentRead=read(body,d.deps);return 'changed';}return 'same';};
 const result=await previewBridge(body,d.deps);assert.equal(result.requestsAttempted,0);assert.equal(d.calls(),0);
 const observation=await concurrentRead;assert(!(await readdir(opDir(body))).includes('launch.claim'));
 assert.equal((await read(body,d.deps)).requestsAttempted,0);
 d.deps.preparationIdentity=()=> 'same';await resume(body,d.deps);assert.equal(d.calls(),1);
 report.push({case:'configuration drift plus competing read and original resume',status:'PASS',observation});
}
// Existing child preparation: active owner blocks launch; terminalization between
// resumeChild snapshot and actual dispatch is rechecked and must not revive.
for(const variant of ['live-owner','stale-resume','old-child'] as const){
 const body=request(),d=depsFor(body);
 d.deps.run=async()=>{await writeFile(ledger(body),JSON.stringify({preparation_protocol:1,status:'preparing',requests_attempted:0}));throw Error('synthetic child interrupted');};
 await previewBridge(body,d.deps);
 let calls=0;d.deps.run=async()=>{calls++;await writeFile(ledger(body),JSON.stringify({status:'reserved',requests_attempted:1}));};
 const original=await readFile(ledger(body),'utf8');
 if(variant==='live-owner'){
  const unlock=tryLocalOperationLock(ledger(body)+'.owner');assert(unlock);
  try{await resume(body,d.deps);assert.equal(calls,0);assert.equal(await readFile(ledger(body),'utf8'),original);}finally{unlock();}
  await resume(body,d.deps);assert.equal(calls,1);
 }else if(variant==='stale-resume'){
  let checks=0;d.deps.preparationIdentity=()=>{if(++checks===2)writeFileSync(ledger(body),JSON.stringify({status:'reserved',requests_attempted:1}));return 'same';};
  await resume(body,d.deps);assert.equal(calls,0,'stale resumeChild must not revive terminal ledger');
 }else{
  await Promise.all([resume(body,d.deps),resume(body,d.deps)]);assert.equal(calls,1);
 }
 report.push({case:variant,status:'PASS',calls});
}
await writeFile(join(evidence,'report.json'),JSON.stringify({head:'5f23383',report,red},null,2));
console.log(JSON.stringify({evidence,red,controls:report.filter(r=>r.status==='PASS').length},null,2));
assert.deepEqual(red,[],'proven no-child-dispatch cancellation must remain recoverable');
