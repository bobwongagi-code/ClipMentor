import assert from 'node:assert/strict';
import saved from '../../src/clipmentor/fixtures/production-saved-projects-20261028.json';
import type {ProjectDoc} from '../../src/editor/types';
import type {ProductionTask} from './production-task';
import {productionEvidenceInspection,productionReviewObservation} from './production-source-evidence';
const base=structuredClone(saved.cases[0].doc) as unknown as ProjectDoc;
const a=base.clipMentorAnalysis!;
a.source.sourceContentHash='a'.repeat(64);
base.assets.find(asset=>asset.id===a.source.asset_id)!.sourceContentHash='a'.repeat(64);
const task={stage:'blueprint',input:{sourceAssetId:a.source.asset_id,brief:'Inspect saved original'},repairContext:{author_self_check:[]}} as unknown as ProductionTask;
let failures=0;
function check(name:string,fn:()=>void){try{fn();console.log('PASS',name);}catch(e){failures++;console.error('FAIL',name,String(e));}}
check('registered point-frame evidence is reusable',()=>{
 const doc=structuredClone(base),segment=doc.clipMentorAnalysis!.source_breakdown!.segments[0];
 doc.clipMentorAnalysis!.evidence=[{evidence_id:'saved-frame',kind:'source_frame',text:'already extracted',status:'frame_extracted_not_interpreted',time_seconds:segment.source_range_seconds[0],supporting_evidence_ids:[],source_ids:[]}];
 segment.visible_evidence_ids=['saved-frame'];
 const route=productionEvidenceInspection(doc,task)!;
 assert(JSON.stringify(route.existing_evidence).includes('saved-frame'));
});
check('explicit support chains retain missing links without sending missing IDs',()=>{
 const doc=structuredClone(base),segment=doc.clipMentorAnalysis!.source_breakdown!.segments[0];
 doc.clipMentorAnalysis!.evidence=[{evidence_id:'parent',kind:'visible_action',text:'saved',supporting_evidence_ids:['child','missing'],source_ids:[]},{evidence_id:'child',kind:'source_frame',text:'frame',supporting_evidence_ids:['parent'],source_ids:[]}];
 segment.visible_evidence_ids=['parent'];
 const route=productionEvidenceInspection(doc,task)!;
 const range=route.targets!.flatMap(t=>'ranges' in t?t.ranges??[]:[]).find(r=>r.segment_id===segment.segment_id)!;
 assert(range.evidence_ids.includes('child'));assert(range.missing_evidence_ids.includes('missing'));
 assert(!JSON.stringify(route.existing_evidence).includes('missing'));
});
check('source fps governs local inspection independently of timeline fps',()=>{
 for(const fps of [24,29.97,60]){
  const doc=structuredClone(base);doc.clipMentorAnalysis!.source.fps=fps;
  const route=productionEvidenceInspection(doc,task)!;
  for(const r of route.targets!.flatMap(t=>'ranges' in t?t.ranges??[]:[]))for(const c of r.local_checks)for(const t of c.args.seconds){
   const actual=Math.floor(t*fps)/fps;
   assert(actual>=r.source_range_seconds[0]&&actual<r.source_range_seconds[1]);
  }
 }
});
check('local route uses evidence-producing original tool',()=>{
 const route=productionEvidenceInspection(base,task)!;
 const calls=route.targets!.flatMap(t=>'ranges' in t?t.ranges?.flatMap(r=>r.local_checks)??[]:[]);
 assert(calls.length>0);assert(calls.every(c=>c.tool==='observe_clipmentor_source'));
});
check('short window cannot inspect preceding frame',()=>{
 const doc=structuredClone(base);doc.clipMentorAnalysis!.source.fps=30;
 for(const segment of doc.clipMentorAnalysis!.source_breakdown!.segments)segment.source_range_seconds=[1.01,1.02];
 const route=productionEvidenceInspection(doc,task)!;
 assert(route.targets?.every(t=>t.status==='unavailable'),'there is no source frame start in this window');
});
if(failures)throw new Error(`${failures} evidence regression failures`);

// Exercise actual extraction registration -> interpretation append -> cold JSON read, without provider or real media access.
const {makeDraft}=await import('../../src/editor/store');
const {execClipMentorAnalysisTool}=await import('../../src/agent/tools/clipmentor-analysis-tools');
const routed=productionEvidenceInspection(base,task)!;
const first=routed.targets!.flatMap(t=>'ranges' in t?t.ranges??[]:[])[0];
assert(first?.local_checks.length);
const engine=makeDraft(structuredClone(base));
let localRequests=0,partial=false;
const ctx={...engine,getCreativeMode:()=>'clipmentor',hostFetch:async(url:string,init:RequestInit)=>{
 assert.equal(url,'/api/extract-frames');localRequests++;
 const body=JSON.parse(String(init.body));
 const times:number[]=body.sourceTimesMs;
 const sourceFps=engine.getDoc().clipMentorAnalysis!.source.fps;
 for(const t of times)assert(t>=first.source_range_seconds[0]*1000-1&&t<first.source_range_seconds[1]*1000);
 assert(times.every(t=>Number.isInteger(t)));
 assert.deepEqual(times,first.local_checks[0].args.seconds.map(t=>Math.floor(Math.floor(t*sourceFps)/sourceFps*1000)));
 assert(sourceFps>0);
 const returned=partial?times.slice(0,-1):times;
 return Response.json({output:'frames',sampleCount:returned.length,sourceTimesMs:returned,
  frames:returned.map(t=>({base64:'Zml4dHVyZQ==',sourceTimeMs:t,mediaType:'image/jpeg'}))});
}};
const beforeMedia=JSON.stringify([engine.getDoc().assets,engine.getDoc().timelines]);
const observed=await execClipMentorAnalysisTool(first.local_checks[0].tool,first.local_checks[0].args,ctx as never) as any;
assert(observed.ok,JSON.stringify(observed));assert.equal(observed.interpretationVerified,false);
const o=observed.observation;
const entry={evidence_id:'review-inspection-candidate',kind:'visible_action',text:'Synthetic visible evidence, not a real-video finding',
 status:'agent_observed_candidate',source_range_seconds:first.source_range_seconds,supporting_evidence_ids:o.frame_evidence_ids,
 source_ids:[],observation_id:o.observation_id,observation_method:'main_agent_direct_image_read_not_independently_verified',call_status:'unknown'};
const appended=await execClipMentorAnalysisTool('revise_clipmentor_analysis',{action:'append',expectedRevision:observed.revision,
 actor:first.local_checks[0].args.actor,reason:'Test existing candidate contract',records:{evidence:[entry]}},ctx as never) as any;
assert(!appended.error,JSON.stringify(appended));
const cold=JSON.parse(JSON.stringify(engine.getDoc())) as ProjectDoc;
assert(cold.clipMentorAnalysis!.evidence.some(e=>e.evidence_id===entry.evidence_id));
const read=await execClipMentorAnalysisTool('read_clipmentor_analysis',{view:'evidence',evidenceIds:[entry.evidence_id]},
 {...ctx,getDoc:()=>cold} as never) as any;
assert.equal(read.analysis.evidence[0].status,'agent_observed_candidate');
assert.deepEqual(read.analysis.linked_evidence.map((e:any)=>e.evidence_id).sort(),[...o.frame_evidence_ids].sort());
assert.equal(JSON.stringify([cold.assets,cold.timelines]),beforeMedia);
const priorRequests=localRequests;
assert((await execClipMentorAnalysisTool(first.local_checks[0].tool,first.local_checks[0].args,ctx as never) as any).error);
assert.equal(localRequests,priorRequests,'stale revision does not extract');
partial=true;
const beforeEvidence=engine.getDoc().clipMentorAnalysis!.evidence.length;
const failed=await execClipMentorAnalysisTool(first.local_checks[0].tool,{...first.local_checks[0].args,expectedRevision:engine.getDoc().clipMentorAnalysis!.revision},ctx as never) as any;
assert.equal(failed.ok,false);assert.equal(engine.getDoc().clipMentorAnalysis!.evidence.length,beforeEvidence);
console.log('PASS actual local extraction registration, candidate append, cold read, stale and partial rejection; zero providers');

// Review repair must acquire source evidence before a rewrite; negative content is not an observation request.
const routedDoc=structuredClone(base);
const ra=routedDoc.clipMentorAnalysis!;
ra.production_copy_review={content_digest:'bound'} as never;
const routedTask={...task,repairContext:{repair:{status:'bound',subject:{revision:ra.revision,digest:'bound'},
 units:[{unit_id:ra.source_breakdown!.units[0].unit_id,verdict:'insufficient_evidence'}]}}} as unknown as ProductionTask;
const observationRoute=productionReviewObservation(routedDoc,routedTask)!;
assert(observationRoute.contexts.length>0);
assert(observationRoute.contexts.every(c=>c.unit_id===ra.source_breakdown!.units[0].unit_id));
assert(!JSON.stringify(observationRoute).includes('insufficient_evidence'),'observer does not receive reviewer judgment');
const {validateSourceVideoTask}=await import('../../shared/clipmentor-source-video');
validateSourceVideoTask(observationRoute,ra.source.duration_seconds,ra.source_breakdown!.units.map(u=>u.unit_id));
for(const verdict of ['pass','needs_revision']){
 const t=structuredClone(routedTask);(t.repairContext!.repair as any).units[0].verdict=verdict;
 assert.equal(productionReviewObservation(routedDoc,t),null);
}
const stale=structuredClone(routedTask);(stale.repairContext!.repair as any).subject.revision++;
assert.throws(()=>productionReviewObservation(routedDoc,stale),/targets_unavailable/);
const missing=structuredClone(routedDoc);missing.clipMentorAnalysis!.source_breakdown!.segments=[];
assert.throws(()=>productionReviewObservation(missing,routedTask),/targets_unavailable/);
assert.equal(productionReviewObservation(routedDoc,{...routedTask,stage:'audio'}),null);
console.log('PASS evidence-first routing, content repair, stale/missing targets, observer isolation and non-blueprint stages');

const {default:receiptVerdicts}=await import('../../src/clipmentor/fixtures/production-evidence-repair-verdicts.json');
for(const recorded of receiptVerdicts.units){
 const t=structuredClone(routedTask);
 (t.repairContext!.repair as any).units[0].verdict=recorded.verdict;
 assert.equal(!!productionReviewObservation(routedDoc,t),recorded.verdict==='insufficient_evidence',recorded.unit_id);
}
console.log('PASS saved JUDYDOLL review-6 verdicts routed against registered-range fixture; source IDs not invented');
