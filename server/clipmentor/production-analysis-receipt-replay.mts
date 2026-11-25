// Offline replay of an interrupted author run. The archived full analysis read
// is the base. Only successful writes advance it; no provider or project store is opened.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {appendAnalysisFindings} from '../../src/clipmentor/append-findings';
import {recoveredAnalysisWrite} from './production-analysis-recovery';
import {teachingBaselineSource} from './production-teaching-baseline';

const [store,projectId,taskFile]=process.argv.slice(2);
const load=async(key:string)=>JSON.parse(await readFile(path.join(store,encodeURIComponent(key)+'.json'),'utf8'));
const runtime=await load('agent-runtime:'+projectId);
const task=JSON.parse(JSON.parse(await readFile(taskFile,'utf8')).body).task;
assert.equal(task.projectId,projectId);
const run=runtime.runs.find((r:any)=>r.projectId===projectId&&r.context.transportError&&r.events.some((e:any)=>e.summary?.includes('production:'+task.taskId)));
assert.ok(run);
const events=run.events.flatMap((e:any)=>{try{return JSON.parse(e.summary).serverEvent??[];}catch{return [];}});
const doc=await load('project:'+projectId);
const suppliedImages=doc.assets.filter((asset:{kind:string})=>asset.kind==='image').map((asset:{id:string})=>asset.id);
const calls=new Map<string,any>();
let analysis,latest;
for(const event of events){
 const {name,result,toolCallId,args}=event.data;
 if(event.type==='server-tool-request')calls.set(toolCallId,args);
 if(event.type!=='server-tool-result')continue;
 if(!analysis&&name==='read_clipmentor_analysis'&&result?.archived){
  const artifact=await load('agent-artifact:'+projectId+':'+result.artifactId);
  assert.equal(artifact.runId,run.runId);
  assert.equal(createHash('sha256').update(artifact.body).digest('hex'),result.bodySha256);
  analysis=JSON.parse(artifact.body).analysis;assert.equal(analysis.analysis_id,'production:'+task.taskId);
 }
 if(!analysis||name!=='revise_clipmentor_analysis'||result.ok!==true)continue;
 const a=calls.get(toolCallId);assert.equal(a.expectedRevision,analysis.revision);
 if(a.action==='append')analysis=await appendAnalysisFindings(analysis,a.records,a.actor,a.reason,suppliedImages);
 else {assert.equal(a.action,'set_source_breakdown');analysis.source_breakdown=structuredClone(a.record);analysis.revision++;}
 assert.equal(result.revision,analysis.revision);latest=toolCallId;
}
const readback=events.findLast((e:any)=>e.type==='server-tool-result'&&e.data.name==='read_clipmentor_analysis').data.result;
assert.equal(readback.revision,analysis.revision);
analysis.source_breakdown.review_scope=readback.analysis.source_breakdown.review_scope;
assert.deepEqual(analysis.source_breakdown,readback.analysis.source_breakdown);
const draft={...doc,clipMentorAnalysis:analysis};
const error=run.context.transportError;
const source=(d:any)=>teachingBaselineSource(d,task,task.input.doneCriteria??[]);
const check=(d:any,ev=events)=>recoveredAnalysisWrite(d,ev,error,source);
assert.equal(check(draft)?.registeredWrite,latest,'complete registered choice can go to independent review');
for(const mutate of [(d:any)=>d.clipMentorAnalysis.blueprint=[],(d:any)=>delete d.clipMentorAnalysis.source_breakdown,
 (d:any)=>d.clipMentorAnalysis.evidence=[],(d:any)=>d.clipMentorAnalysis.revision++]){
 const half=structuredClone(draft);mutate(half);assert.equal(check(half),undefined);
}
assert.equal(check(draft,events.filter((e:any)=>e.type!=='server-tool-result'||e.data.toolCallId!==latest)),undefined);
const finalSupplement=events.findLast((e:any)=>e.type==='server-tool-request'&&e.data.args?.action==='append');
const staleArgs=events.map((e:any)=>e===finalSupplement
 ?{...e,data:{...e.data,args:{...e.data.args,reason:'different input'}}}:e);
assert.equal(check(draft,staleArgs),undefined,'paired receipts must describe the actual submitted arguments');
const changedSelection=events.map((e:any)=>e===finalSupplement
 ?{...e,data:{...e.data,args:{...e.data.args,action:'set_source_breakdown'}}}:e);
assert.equal(check(draft,changedSelection),undefined,'a rejected change to the selection still needs work');
assert.equal(check(draft,[...events,{...finalSupplement,data:{...finalSupplement.data,toolCallId:'unanswered'}}]),undefined,
 'a submitted write without a result cannot be published');
assert.equal(recoveredAnalysisWrite(draft,events,'network timeout',source),undefined);
console.log('PASS stored complete topic, rejected supplement, cold readback; partials, missing receipt, and unknown failure rejected. No provider calls.');
