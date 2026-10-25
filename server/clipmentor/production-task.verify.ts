import assert from 'node:assert/strict';
import {advanceProductionTask,productionFeedback,acceptProductionTask,PRODUCTION_STAGES,validateProductionInput,cancelActiveProductionTask,type ProductionInput,type ProductionTask,type TaskStore} from './production-task';
const input:ProductionInput={projectId:'test',sourceAssetId:'source',product:{name:'Fixture',category:'test'},brief:'Fixture production without a provider',
 voice:{provider:'minimax',voiceId:'fixture'},
 author:{provider:'openai',model:'fixture',origin:'http://127.0.0.1:5199',apiMode:'responses'},reviewer:{provider:'openai',model:'fixture',origin:'http://127.0.0.1:5199',apiMode:'responses'},
 budget:{model:20,review:2,tts:2,render:2,observation:1,maxElapsedMs:100000,maxRepairs:1}};
const fresh=():ProductionTask=>({version:1,taskId:'test',projectId:'test',input:structuredClone(input),stage:'analysis',status:'queued',createdAt:Date.now(),updatedAt:Date.now(),sequence:0,
 completed:{},effects:{},attempts:{model:0,review:0,observation:0,tts:0,render:0},repairs:0,feedbackUsed:false});
let saved:ProductionTask;
const store:TaskStore={async save(t){saved=structuredClone(t);},async load(){return structuredClone(saved);}};
validateProductionInput(input);assert.throws(()=>validateProductionInput({...input,budget:{...input.budget,model:-1}}));
let calls:string[]=[];const task=fresh();
await advanceProductionTask(task,async(t,c)=>{calls.push(t.stage);await c.effect('model',t.stage,async()=>({value:1}));return {artifact:{saved:true}};},store);
assert.deepEqual(calls,[...PRODUCTION_STAGES]);assert.equal(task.status,'awaiting_review');assert.equal(task.attempts.model,7);
await productionFeedback(task,'Move one label and adjust one phrase',store);
assert.equal(task.feedbackUsed,true);calls=[];
await advanceProductionTask(task,async(t)=>{calls.push(t.stage);return {artifact:{saved:true}};},store);
assert.deepEqual(calls,PRODUCTION_STAGES.slice(1));await assert.rejects(productionFeedback(task,'again',store));
await assert.rejects(acceptProductionTask(task,false,store));await acceptProductionTask(task,true,store);assert.equal(task.status,'completed');
// A crash/failed action consumes its budget, and is never submitted twice on resume.
const failed=fresh();let paid=0;
await advanceProductionTask(failed,async(_t,c)=>{await c.effect('render','same',async()=>{paid++;throw Error('Injected export failure');});return {artifact:{saved:true}};},store);
assert.equal(failed.status,'blocked');assert.equal(failed.attempts.render,1);
await advanceProductionTask(failed,async(_t,c)=>{await c.effect('render','same',async()=>{paid++;return {};});return {artifact:{saved:true}};},store);
assert.equal(paid,1);assert.match(failed.error!,/outcome_failed/);
const interrupted=fresh();interrupted.completed.analysis={at:1,artifact:{saved:true}};interrupted.status='running';interrupted.stage='analysis';calls=[];
await advanceProductionTask(interrupted,async(t)=>{calls.push(t.stage);return {artifact:{saved:true}};},store);
assert(!calls.includes('analysis'),'completed stages survive an interrupted run');
const zero=fresh();zero.input.budget.model=0;let attempts=0;
await advanceProductionTask(zero,async(_t,c)=>{await c.effect('model','x',async()=>{attempts++;return {};});return {artifact:{saved:true}};},store);
assert.equal(attempts,0);assert.equal(zero.status,'blocked');
const expired=fresh();await advanceProductionTask(expired,async()=>{throw Error('must not run');},store,()=>expired.createdAt+100001);assert.match(expired.error!,/deadline/);
const empty=fresh();await advanceProductionTask(empty,async()=>({artifact:{}}),store);assert.equal(empty.status,'blocked');
const repair=fresh();let repaired=false;
await advanceProductionTask(repair,async(t)=>t.stage==='copy_review'&&!repaired?(repaired=true,{artifact:{},repair:'blueprint'}):{artifact:{saved:true}},store);
assert.equal(repair.repairs,1);assert.equal(repair.status,'awaiting_review');
const cancellation=fresh();let cancelInvoked=false;
await advanceProductionTask(cancellation,async(t,c)=>{cancelInvoked=cancelActiveProductionTask(t.projectId,t.taskId);c.signal.throwIfAborted();return {artifact:{saved:true}};},store);assert(cancelInvoked);assert.equal(cancellation.status,'cancelled');
const reserved=fresh();reserved.effects['analysis:initial:0:pending']={kind:'review',operationId:'unknown-outcome',status:'reserved'};
await advanceProductionTask(reserved,async(_t,c)=>{await c.effect('review','pending',async()=>{throw Error('must not resubmit');});return {artifact:{saved:true}};},store);assert.match(reserved.error!,/outcome_reserved/);assert.equal(reserved.attempts.review,0);
const reconciled=fresh();reconciled.attempts.render=1;reconciled.effects['analysis:initial:0:existing']={kind:'render',operationId:'saved-render-id',status:'reserved'};
await advanceProductionTask(reconciled,async(t,c)=>{if(t.stage==='analysis')await c.effect('render','existing',async()=>{throw Error('must not submit');},async id=>({renderId:id}));return {artifact:{saved:true}};},store);assert.equal(reconciled.status,'awaiting_review');assert.equal(reconciled.attempts.render,1);
const persistenceFailure=fresh();let forbiddenPaid=0;
await advanceProductionTask(persistenceFailure,async(_t,c)=>{await c.effect('review','x',async()=>{forbiddenPaid++;return {};});return {artifact:{saved:true}};},{...store,async save(){throw Error('Injected checkpoint quota');}});assert.equal(forbiddenPaid,0);assert.equal(persistenceFailure.status,'blocked');assert.match(persistenceFailure.error!,/checkpoint_write_failed/);
console.log('production-task: all stages, saved resume, spent/zero/deadline budgets, bounded repair, one feedback and explicit language acceptance passed; zero provider calls');
