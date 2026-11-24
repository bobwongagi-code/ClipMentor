import assert from 'node:assert/strict';
import {nativeExecutionMapping,checkSourceBreakdown} from '../../src/clipmentor/source-breakdown';
import {deliveryTimeline,deliverySectionsFromDoc} from '../../src/clipmentor/delivery-sections';
import {productionPreviewFacts,productionPreviewReviewInput} from './production-preview-facts';
import {makeDraft} from '../../src/editor/store';
import type {ProjectDoc} from '../../src/editor/types';
import bookends from '../../src/agent/tools/fixtures/barely-there-bookend-replacement-20261029.json';
const hash='a'.repeat(64);
export const nativeFixture={version:3,activeTimelineId:'tl',mediaFolders:[],assets:[
 {id:'source',kind:'video',name:'source',src:'/media/uploads/source.mp4',sourceContentHash:hash,width:576,height:1024,durationInFrames:120},
 ...[1,2].map(n=>({id:'a'+n,kind:'audio',name:'a'+n,src:'/media/uploads/a'+n+'.mp3',sourceContentHash:'b'.repeat(64),durationInFrames:n===1?90:60,
 props:{generation:{text:'Line '+n,provider:'fixture',voiceId:'fixture',speed:1,durationSeconds:n===1?3:2}}})),
 {id:'reference',kind:'image',name:'source reference',src:'/media/uploads/ref.png',sourceContentHash:'c'.repeat(64),width:576,height:1024,durationInFrames:1,props:{sourceAssetId:'source',sourceHash:hash,sourceSeconds:1}},
],timelines:[{id:'tl',name:'test',order:0,fps:30,width:576,height:1024,selectedId:null,trackOrder:['V2','V1','A1'],tracks:{V1:{kind:'video'},V2:{kind:'video'},A1:{kind:'audio'}},items:[
 {id:'original',kind:'video',sourceAssetId:'source',src:'/media/uploads/source.mp4',sourceContentHash:hash,startFrame:0,durationInFrames:120,srcInFrame:0,track:'V1'},
 {id:'line1',kind:'audio',sourceAssetId:'a1',src:'/media/uploads/a1.mp3',startFrame:120,durationInFrames:90,track:'A1'},
 {id:'line2',kind:'audio',sourceAssetId:'a2',src:'/media/uploads/a2.mp3',startFrame:210,durationInFrames:60,track:'A1'},
 {id:'revisit1',kind:'video',sourceAssetId:'source',src:'/media/uploads/source.mp4',sourceContentHash:hash,startFrame:120,durationInFrames:60,srcInFrame:0,volume:0,track:'V1'},
 {id:'ref',kind:'image',sourceAssetId:'reference',src:'/media/uploads/ref.png',startFrame:180,durationInFrames:30,track:'V1'},
 {id:'revisit2',kind:'video',sourceAssetId:'source',src:'/media/uploads/source.mp4',sourceContentHash:hash,startFrame:210,durationInFrames:60,srcInFrame:60,volume:0,track:'V1'},
]}],clipMentorAnalysis:{schema_version:1,analysis_id:'test',revision:1,source:{asset_id:'source',sourceContentHash:hash,duration_seconds:4,fps:30},product:{name:'test',category:'test'},import_origin:'synthetic_test',points:[],transcripts:[],reviews:[],audit:[],
 evidence:[1,2].map(n=>({evidence_id:'E'+n,kind:'source_frame',text:'Synthetic visible object',status:'historical_unknown',source_ids:['source'],supporting_evidence_ids:[],time_seconds:n===1?1:3,source_frame:n===1?30:90})),
 blueprint:[1,2].map(n=>({unit_id:'U'+n,point_ids:['P'+n],intent_zh:'Synthetic teaching',line_guidance:'unchanged',internal_review:{current_script_candidate:'copy',current_picture_plan:'plan',copy:{lines:[{id:'L'+n,point_ids:['P'+n],narration_ms:'Line '+n,caption_lines:['Line '+n],zh:'示例'+n,source_seconds:n===1?[0,2]:[2,4],labels:[]}]},plan:{script_candidate_id:'copy',composition:{detail:'Reviewed picture prose, not a JSON production timeline'},phases:[{mode:'original',source_range_seconds:n===1?[0,2]:[2,4],picture:'Original'},{mode:'explanation',line_id:'L'+n,source_range_seconds:n===1?[0,2]:[2,4],picture:'Revisit with source reference'}],viewer_stage_cues:{original:{text:'Video asal',enter:'start',exit:'end'},revisit:[{line_ids:['L'+n],text:'Lihat semula',enter:'start',exit:'end'}]}}}})),
 source_breakdown:{version:1,segments:[1,2].map(n=>({segment_id:'S'+n,source_range_seconds:n===1?[0,2]:[2,4],visible_evidence_ids:['E'+n],claim_evidence_ids:[],interpretation_evidence_ids:[],unknowns:[]})),
 points:[1,2].map(n=>({point_id:'P'+n,segment_ids:['S'+n],buying_concern:'Synthetic concern',teaching_question:'What is visible?',filming_conditions:['Object visible'],role:'primary',importance:'must_explain'})),
 units:[1,2].map(n=>({unit_id:'U'+n,original_segment_ids:['S'+n],original_source_ranges:[n===1?[0,2]:[2,4]],explanation_segment_ids:['S'+n],coverage:[{point_id:'P'+n,treatment:'explain'}],revisits:[{from_segment_id:'S'+n,to_segment_id:'S'+n,reason:'Revisit'}]}))}}} as unknown as ProjectDoc;
const project=nativeFixture;
const before=JSON.stringify(project),good=nativeExecutionMapping(project);
assert.deepEqual(good.issues,[]);assert.deepEqual(good.placements.U1,{timeline_id:'tl',original_frames:[0,60],explanation_frames:[120,210]});
assert.deepEqual(good.placements.U2,{timeline_id:'tl',original_frames:[60,120],explanation_frames:[210,270]});
assert.equal(good.bindings.length,5);assert.equal(JSON.stringify(project),before,'actual inspection cannot revise or restamp the blueprint');
assert.equal(checkSourceBreakdown(project,true).status,'structurally_ready',JSON.stringify(checkSourceBreakdown(project,true).issues));
const combined=structuredClone(project);
const combinedAnalysis=combined.clipMentorAnalysis!;
const combinedUnit=combinedAnalysis.source_breakdown!.units[1];
combinedUnit.original_source_ranges=[[2,2.5],[2.5,4]];
const lastSegment={...combinedAnalysis.source_breakdown!.segments[1],segment_id:'S2-tail',source_range_seconds:[2.5,4] as [number,number]};
combinedAnalysis.source_breakdown!.segments.push(lastSegment);
combinedUnit.original_segment_ids.push(lastSegment.segment_id);
combinedUnit.revisits[0].from_segment_id=lastSegment.segment_id;
const combinedPlan=(combinedAnalysis.blueprint[1] as any).internal_review.plan;
combinedPlan.phases.splice(0,1,...combinedUnit.original_source_ranges.map(range=>({mode:'original',source_range_seconds:range,picture:'Original'})));
assert.equal(checkSourceBreakdown(combined,true).status,'structurally_ready','both source windows precede a shared explanation');
const disordered=structuredClone(combined);
const combinedOriginal=disordered.timelines[0].items.shift()!;
disordered.timelines[0].items.push(
 {...combinedOriginal,id:'first-unit-source',startFrame:0,srcInFrame:0,durationInFrames:60},
 {...combinedOriginal,id:'second-unit-tail',startFrame:60,srcInFrame:75,durationInFrames:45},
 {...combinedOriginal,id:'second-unit-start',startFrame:105,srcInFrame:60,durationInFrames:15});
assert(nativeExecutionMapping(disordered).issues.some(issue=>issue.id==='U2'&&issue.code==='unit_output_order_invalid'));
assert.notEqual(checkSourceBreakdown(disordered,true).status,'structurally_ready','reversing the two windows still blocks delivery');
const middleSwap=structuredClone(combined);
const middleReview=(middleSwap.clipMentorAnalysis!.blueprint[1] as any).internal_review;
for(const [index,id] of ['L3','L4','L5'].entries()){
 const text='Additional '+id,start=270+index*30;
 const sample=middleSwap.assets.find(asset=>asset.id==='a2')!;
 const voice={...sample,id:'a'+id,src:'/media/uploads/'+id+'.mp3',durationInFrames:30,
  props:{generation:{...sample.props!.generation,text,durationSeconds:1}}};
 middleSwap.assets.push(voice);
 middleReview.copy.lines.push({...middleReview.copy.lines[0],id,narration_ms:text,caption_lines:[text]});
 middleReview.plan.phases.push({...middleReview.plan.phases.at(-1),line_id:id});
 middleReview.plan.viewer_stage_cues.revisit.push({line_ids:[id],text:'Lihat semula',enter:'start',exit:'end'});
 middleSwap.timelines[0].items.push(
  {...middleSwap.timelines[0].items.find(item=>item.id==='line2')!,id,sourceAssetId:voice.id,src:voice.src,startFrame:start,durationInFrames:30},
  {...middleSwap.timelines[0].items.find(item=>item.id==='revisit2')!,id:'picture-'+id,startFrame:start,durationInFrames:30});
}
assert.deepEqual(nativeExecutionMapping(middleSwap).issues,[]);
[middleReview.plan.phases[3],middleReview.plan.phases[4]]=[middleReview.plan.phases[4],middleReview.plan.phases[3]];
assert(nativeExecutionMapping(middleSwap).issues.some(issue=>issue.id==='U2'&&issue.code==='unit_output_order_invalid'));
// Editor defaults may persist an empty gap-cap map; only actual gap edits are nonlinear.
const emptyGaps=structuredClone(project);
for(const item of emptyGaps.timelines[0].items.filter(i=>i.kind==='video'))item.gapCapsMs={};
assert.deepEqual(nativeExecutionMapping(emptyGaps).issues,[],'empty editor gap maps preserve native mapping');
assert.deepEqual(nativeExecutionMapping(emptyGaps).placements,good.placements);
assert.equal(checkSourceBreakdown(emptyGaps,true).status,'structurally_ready','empty gap maps do not block export');
const packet={units:[1,2].map(n=>({unit_id:'U'+n,
 points:[{point_id:'P'+n,question:'Synthetic teaching',buying_concern:'Concern',filming_conditions:['Object visible'],
  teaching_basis:{connection:'Buyer can judge the actual contrast'}}],
 lines:[{line_id:'L'+n,narration_ms:'Line '+n,labels:['Cue '+n]}],
 picture_plan:{execution_plan:{content:(project.clipMentorAnalysis!.blueprint[n-1] as any).internal_review.plan}},
}))} as any;
const preview=productionPreviewFacts(project,makeDraft(project).getState(),packet);
assert.deepEqual(preview.input.units.map(u=>u.output_range_seconds),[[0,7],[2,9]]);
assert(preview.executionManifest.review_window_basis.every(r=>r.basis==='actual_native_source_and_audio'));
const reviewInput=productionPreviewReviewInput(project,preview.input,packet);
assert.deepEqual(reviewInput.units.map(u=>u.approved_teaching_ranges),[[[0,2],[4,7]],[[2,4],[7,9]]],
 'overlapping unit envelopes must not authorize evidence from a neighboring group');
assert.equal(reviewInput.points[0].approved_connection,'Buyer can judge the actual contrast');
assert.deepEqual(reviewInput.points[0].filming_conditions,['Object visible']);
assert.deepEqual(reviewInput.units[0].approved_cues,[
 {text:'Video asal',phase:'original',output_ranges:[[0,2]]},
 {text:'Lihat semula',phase:'explanation',narration:['Line 1'],output_ranges:[[4,7]]},
 {text:'Cue 1',phase:'explanation',narration:['Line 1'],output_ranges:[[4,7]]},
]);
const oddCue=structuredClone(packet);
oddCue.units[0].picture_plan.execution_plan.content.viewer_stage_cues.revisit.push({line_ids:42,text:'Legacy extra cue'});
assert.deepEqual(productionPreviewReviewInput(project,preview.input,oddCue),reviewInput,'malformed optional rows cannot invalidate the approved cue');
const exactCue=structuredClone(packet);
exactCue.units[0].picture_plan.execution_plan.content.composition.detail=JSON.stringify({production_rows:[
 {unit_id:'U1',kind:'explanation',stage_label:'Lihat semula · Kain'},
]});
assert.deepEqual(productionPreviewReviewInput(project,preview.input,exactCue).units[0].approved_cues?.map(c=>c.text),
 ['Video asal','Lihat semula · Kain','Cue 1'],'exact reviewed labels are authoritative over generic cues');
assert.equal('approved_connection' in preview.input.points[0],false,'old export facts stay stable');

const withContext=structuredClone(project),contextAnalysis=withContext.clipMentorAnalysis!;
contextAnalysis.source_breakdown!.units[0].explanation_segment_ids.push('S2');
const contextReview=(contextAnalysis.blueprint[0] as any).internal_review;
contextReview.copy.lines[0].source_seconds=[0,4];
contextReview.plan.phases[1].context_source_ranges=[{segment_id:'S2',source_range_seconds:[2,4],purpose:'Extra picture context'}];
withContext.timelines[0].items.find(item=>item.id==='revisit1')!.srcInFrame=60;
assert.deepEqual(checkSourceBreakdown(withContext,true).issues,[],'approved context plus a source-bound evidence still is valid');
const contextOnly=structuredClone(withContext);
contextOnly.assets.find(asset=>asset.id==='reference')!.props!.sourceSeconds=3;
assert.deepEqual(checkSourceBreakdown(contextOnly,true).issues,[{code:'native_mapping_point_evidence_missing',id:'L1:P1'}],
 'continuous approved context cannot stand in for direct point evidence');
const contextState=makeDraft(contextOnly).getState();
assert.throws(()=>productionPreviewFacts(contextOnly,contextState,packet),/native_mapping_point_evidence_missing/);
assert.deepEqual(productionPreviewFacts(contextOnly,contextState,packet,{legacyExport:true}).input.units,
 preview.input.units,'readback of a legacy export retains its earlier time ranges');
const twoPoints=structuredClone(withContext),twoBreakdown=twoPoints.clipMentorAnalysis!.source_breakdown!;
twoBreakdown.points.push({...twoBreakdown.points[1],point_id:'P3'});
(twoPoints.clipMentorAnalysis!.blueprint[0] as any).internal_review.copy.lines[0].point_ids.push('P3');
assert.deepEqual(nativeExecutionMapping(twoPoints).issues,[],'one line can use a source-bound frame and a second moving evidence window');
twoPoints.timelines[0].items.find(item=>item.id==='revisit1')!.srcInFrame=0;
assert.deepEqual(nativeExecutionMapping(twoPoints).issues,[{code:'native_mapping_point_evidence_missing',id:'L1:P3'}],
 'enough footage for one linked point cannot stand in for the second one');
const reject=(name:string,change:(d:ProjectDoc)=>void,code:RegExp)=>{const d=structuredClone(project);change(d);assert(nativeExecutionMapping(d).issues.some(i=>code.test(i.code)),name);assert.notEqual(checkSourceBreakdown(d,true).status,'structurally_ready',name+' still blocks export');};
reject('missing narration',d=>{d.timelines[0].items=d.timelines[0].items.filter(i=>i.id!=='line1');},/narration_missing/);
reject('duplicate narration',d=>{d.timelines[0].items.push({...d.timelines[0].items.find(i=>i.id==='line1')!,id:'duplicate'});},/narration_missing_or_ambiguous/);
reject('truncated narration',d=>{d.timelines[0].items.find(i=>i.id==='line1')!.durationInFrames--;},/narration_modified/);
reject('wrong source window',d=>{d.timelines[0].items.find(i=>i.id==='revisit2')!.srcInFrame=0;},/outside_frozen_selection/);
reject('missing reference',d=>{d.timelines[0].items=d.timelines[0].items.filter(i=>i.id!=='ref');},/picture_missing/);
reject('wrong reference identity',d=>{d.assets.find(a=>a.id==='reference')!.props!.sourceHash='d'.repeat(64);},/reference_unbound/);
reject('wrong reference time',d=>{d.assets.find(a=>a.id==='reference')!.props!.sourceSeconds=3;},/reference_unbound/);
reject('original source incomplete',d=>{d.timelines[0].items.find(i=>i.id==='original')!.durationInFrames--;},/original_incomplete/);
reject('original muted',d=>{d.timelines[0].items.find(i=>i.id==='original')!.volume=0;},/original_audio_missing/);
reject('slow motion',d=>{d.timelines[0].items.find(i=>i.id==='revisit2')!.playbackRate=0.5;},/nonlinear/);
for(const id of ['original','revisit2'])reject('actual source gap edit '+id,d=>{d.timelines[0].items.find(i=>i.id===id)!.gapCapsMs={0:100};},/nonlinear/);
reject('cross-unit narration swapped',d=>{d.timelines[0].items.find(i=>i.id==='line1')!.startFrame=210;d.timelines[0].items.find(i=>i.id==='line2')!.startFrame=120;},/narration_order/);
reject('original repeated',d=>{d.timelines[0].items.push({...d.timelines[0].items.find(i=>i.id==='original')!,id:'duplicate-original',startFrame:300});},/original_incomplete_or_repeated/);
reject('reference hidden',d=>{d.timelines[0].items.find(i=>i.id==='ref')!.transform={opacity:0};},/picture_missing/);
reject('source on non-picture track',d=>{d.timelines[0].items.find(i=>i.id==='revisit2')!.track='A1';},/picture_missing/);

reject('narration wrong order',d=>{d.timelines[0].items.find(i=>i.id==='line1')!.startFrame=0;},/unit_output_order/);
// Existing strict reviewed display ranges still take priority. Without exact
// times the frozen layered layout permits an initial covered score stage and
// a clear exit, never an all-film score card or an unshaded background.
const layered=structuredClone(bookends.before) as unknown as ProjectDoc,t=layered.timelines.find(t=>t.id===layered.activeTimelineId)!;
const ir=(layered.clipMentorAnalysis!.blueprint[0] as any).internal_review,s=ir[ir.current_picture_plan].delivery_sections.find((s:any)=>s.kind==='performance_opening');
const photo=t.items.find(i=>i.kind==='image'&&i.sourceAssetId===s.picture.asset_id)!,source=t.items.find(i=>i.kind==='video')!,asset=layered.assets.find(a=>a.id===source.sourceAssetId)!;
const [top,middle,lower]=t.trackOrder!;s.picture.layout={kind:'original_underlay',source:{asset_id:asset.id,src:asset.src,sha256:asset.sourceContentHash},range:[0,10],shade:0.63,show_sales:true,headline:['Score'],transition:['View']};delete s.picture.display;
photo.track=top;photo.startFrame=0;photo.durationInFrames=157;
t.items.push({...source,id:'opening-video',track:lower,startFrame:0,srcInFrame:0,durationInFrames:275},{id:'matte',kind:'solid',name:'shade',track:middle,startFrame:0,durationInFrames:157,props:{color:'#000000'},transform:{opacity:0.63}});
assert.deepEqual(deliveryTimeline(layered,[s]).issues,[]);
photo.durationInFrames=275;assert(deliveryTimeline(layered,[s]).issues.includes('delivery_opening_sales_layer_or_exit_missing'));photo.durationInFrames=157;
t.items.find(i=>i.id==='matte')!.durationInFrames=1;assert(deliveryTimeline(layered,[s]).issues.includes('delivery_opening_sales_layer_or_exit_missing'));
t.items.find(i=>i.id==='matte')!.durationInFrames=157;s.picture.display={fps:30,ranges:[[0,200]]};assert(deliveryTimeline(layered,[s]).issues.includes('delivery_opening_sales_layer_or_exit_missing'));
assert.equal(JSON.stringify(project),before,'positive and negative tests leave the saved source unchanged');
console.log('native execution mapping: shared original block, measured audio, dynamic/reference coverage, empty gap maps, no blueprint writes; 16 invalid variants refused; layered opening exits and exact display protection passed');
