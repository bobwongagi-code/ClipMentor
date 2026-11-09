import assert from 'node:assert/strict';
import {nativeExecutionMapping,checkSourceBreakdown} from '../../src/clipmentor/source-breakdown';
import {deliveryTimeline,deliverySectionsFromDoc} from '../../src/clipmentor/delivery-sections';
import {productionPreviewFacts} from './production-preview-facts';
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
// Editor defaults may persist an empty gap-cap map; only actual gap edits are nonlinear.
const emptyGaps=structuredClone(project);
for(const item of emptyGaps.timelines[0].items.filter(i=>i.kind==='video'))item.gapCapsMs={};
assert.deepEqual(nativeExecutionMapping(emptyGaps).issues,[],'empty editor gap maps preserve native mapping');
assert.deepEqual(nativeExecutionMapping(emptyGaps).placements,good.placements);
assert.equal(checkSourceBreakdown(emptyGaps,true).status,'structurally_ready','empty gap maps do not block export');
const packet={units:[1,2].map(n=>({unit_id:'U'+n,points:[{point_id:'P'+n,question:'Synthetic teaching',buying_concern:'Concern'}]}))} as any;
const preview=productionPreviewFacts(project,makeDraft(project).getState(),packet);
assert.deepEqual(preview.input.units.map(u=>u.output_range_seconds),[[0,7],[2,9]]);
assert(preview.executionManifest.review_window_basis.every(r=>r.basis==='actual_native_source_and_audio'));
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
