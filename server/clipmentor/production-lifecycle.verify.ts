import assert from 'node:assert/strict';
import {runProductionWithRecovery,advanceProductionTask,productionExecutionActive,cancelActiveProductionTask,type ProductionTask,type ProductionInput,type TaskStore} from './production-task';
const input:ProductionInput={projectId:'preparation-fixture',sourceAssetId:'source',product:{name:'fixture',category:'fixture'},brief:'offline lifecycle fixture',
 author:{provider:'openai',model:'fixture',origin:'http://fixture.invalid',apiMode:'responses'},reviewer:{provider:'openai',model:'fixture',origin:'http://fixture.invalid',apiMode:'responses'},
 budget:{model:1,review:0,observation:0,tts:0,render:0,maxElapsedMs:10000,maxRepairs:0}};
const fresh=():ProductionTask=>({version:1,taskId:crypto.randomUUID(),projectId:input.projectId,input:structuredClone(input),stage:'copy_review',status:'queued',createdAt:Date.now(),updatedAt:Date.now(),sequence:0,
 feedbackUsed:false,repairs:0,completed:{},effects:{},attempts:{model:0,review:0,observation:0,tts:0,render:0}});
let saved:ProductionTask|undefined,workers=0;
const store:TaskStore={async save(t){saved=structuredClone(t);},async load(){assert(saved);return structuredClone(saved);}};
const worker=async()=>{workers++;return {artifact:{saved:true}};};
const waiting=fresh(),before=structuredClone(waiting);
await runProductionWithRecovery(waiting,worker,async()=>{},store,async()=>{
 assert(productionExecutionActive(waiting.projectId,waiting.taskId));return false;
});
assert.deepEqual(waiting,before);assert.equal(workers,0);assert(!productionExecutionActive(waiting.projectId,waiting.taskId));
for(const status of ['completed','cancelled','awaiting_blueprint','awaiting_review'] as const){
 const terminal=fresh();terminal.status=status;let preparations=0;
 await runProductionWithRecovery(terminal,worker,async()=>{},store,async()=>{preparations++;return true;});
 assert.equal(preparations,0);assert.equal(terminal.status,status);
}
assert.equal(workers,0,'terminal tasks never enter a new preparatory operation');
const expired=fresh();expired.createdAt=Date.now()-20000;let expiredPreparations=0;
await runProductionWithRecovery(expired,worker,async()=>{},store,async()=>{expiredPreparations++;return true;});
assert.equal(expiredPreparations,0);assert.equal(expired.status,'blocked');assert.match(expired.error!,/deadline/);
const during=fresh();during.input.budget.maxElapsedMs=20;
await runProductionWithRecovery(during,worker,async()=>{},store,async signal=>{
 await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));return true;
});
assert.equal(during.status,'blocked');assert.match(during.error!,/deadline/);assert.equal(workers,0);
const cancelling=fresh();let enter!:()=>void,release!:()=>void;
const entered=new Promise<void>(resolve=>{enter=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
const pending=runProductionWithRecovery(cancelling,worker,async()=>{},store,async()=>{enter();await held;return true;});
await entered;assert(cancelActiveProductionTask(cancelling.projectId,cancelling.taskId));
await assert.rejects(advanceProductionTask(structuredClone(cancelling),worker,store),/already running/);
release();await pending;
assert.equal(cancelling.status,'cancelled');assert.equal(saved!.status,'cancelled');assert.equal(workers,0);assert.equal(cancelling.attempts.model,0);
assert(!productionExecutionActive(cancelling.projectId,cancelling.taskId));
const broken=fresh();await assert.rejects(runProductionWithRecovery(broken,worker,async()=>{},store,async()=>{throw Error('local preparation unavailable');}),/local preparation/);
assert(!productionExecutionActive(broken.projectId,broken.taskId),'failed preparation releases ownership for ordinary safe recovery');
await runProductionWithRecovery(broken,worker,async()=>{},store,async()=>true);
assert.equal(broken.status,'awaiting_review');assert.equal(workers,5,'valid preparation keeps all ordinary stages reachable');
console.log('PASS lifecycle: waiting/terminal/expired/preparing cancellation, whole-job ownership, preparation failure recovery; zero external calls');
