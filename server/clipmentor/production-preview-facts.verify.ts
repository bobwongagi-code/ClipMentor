import assert from 'node:assert/strict';
import {productionPreviewFacts} from './production-worker';
import {projectDoc} from '../external-agent/offline-runtime.verify-fixtures';
import {makeDraft} from '../../src/editor/store';
import {checkTransitionManifest} from '../../src/clipmentor/transition-check';
import type {TeachingPacket} from '../../src/clipmentor/production-gate';
const doc=projectDoc();
doc.clipMentorAnalysis={source:{asset_id:'source'},source_breakdown:{units:[{unit_id:'U',placement:{timeline_id:doc.activeTimelineId,original_frames:[0,100],explanation_frames:[100,300]}}]}} as never;
doc.timelines[0].trackOrder=['overlay','track-v1'];
doc.timelines[0].tracks={overlay:{kind:'video'},'track-v1':{kind:'video'}};
doc.timelines[0].items=[
 {id:'v',kind:'video',src:'/media/uploads/source.mp4',sourceAssetId:'source',startFrame:0,durationInFrames:300,track:'track-v1'},
 {id:'image',kind:'image',src:'/media/uploads/product.png',sourceAssetId:'product',startFrame:100,durationInFrames:200,track:'overlay'},
] as never;
const packet={units:[{unit_id:'U',points:[{point_id:'P',question:'怎样展示商品',buying_concern:'实际产品'}]}]} as TeachingPacket;
const facts=productionPreviewFacts(doc,makeDraft(doc).getState(),packet);
assert.equal(facts.executionManifest.scenes.at(-1)?.kind,'composition');
assert.equal(checkTransitionManifest(facts.executionManifest).full_film_accepted,false);
console.log('multi-track native product-image manifest accepted without invented source seconds; no provider calls');

import {productionPreviewFacts as build,previewFactsDigest,assertPreviewExportBinding} from './production-preview-facts';
import {checkPreviewTimelineObservations} from './preview-timeline-check';
import {buildPreviewReviewRequest,evaluatePreviewTeachingJudgment} from './preview-review';
import type {ProjectDoc} from '../../src/editor/types';
import saved from '../../src/clipmentor/fixtures/production-compositions-20261030.json';
let checks=0;
const test=(name:string,run:()=>void)=>{run();checks++;console.log(`ok ${checks} ${name}`);};
const snapshot=JSON.stringify({doc,packet});
const state=()=>makeDraft(doc).getState();
const restore=()=>Object.assign(doc,JSON.parse(snapshot).doc);
const reject=(change:()=>void,pattern:RegExp)=>{restore();change();assert.throws(()=>build(doc,state(),packet),pattern);restore();};
const layers=()=>{const s=build(doc,state(),packet).executionManifest.scenes.at(-1)!;assert.equal(s.kind,'composition');return s.kind==='composition'?s.layers:[];};
test('source asset image has no fabricated original-video time',()=>{
 const image=layers().find(l=>l.item_id==='image')!;assert.equal(image.origin,'media_asset');assert.equal(image.source_start_seconds,undefined);
});
test('media replacement alone is not a layout change',()=>{
 const d=structuredClone(doc);d.timelines[0].items[0].durationInFrames=100;d.timelines[0].items[1].track='track-v1';
 const f=build(d,makeDraft(d).getState(),packet),c=checkTransitionManifest(f.executionManifest).cut_events[0];
 assert.equal(c.layout_changed,false);assert.equal(c.medium_changed,true);
});
test('native paint order is bottom to top',()=>assert.deepEqual(layers().map(l=>l.item_id),['v','image']));
test('hidden track has neither layers nor scheduled audio',()=>{doc.timelines[0].tracks!['track-v1']!.hidden=true;const f=build(doc,state(),packet);assert(!f.executionManifest.scenes.some(s=>s.kind==='composition'&&s.layers.some(l=>l.item_id==='v')));assert.equal(f.executionManifest.audios.length,0);restore();});
test('muted video keeps picture and removes audio',()=>{doc.timelines[0].tracks!['track-v1']!.muted=true;assert(layers().some(l=>l.item_id==='v'));assert.equal(build(doc,state(),packet).executionManifest.audios.length,0);restore();});
test('same-track order matches native start ordering',()=>{doc.timelines[0].items[1].track='track-v1';assert.deepEqual(layers().map(l=>l.item_id),['v','image']);restore();});
test('linear source rate and trim are actual facts',()=>{Object.assign(doc.timelines[0].items[0],{srcInFrame:60,playbackRate:2});const f=layers().find(l=>l.item_id==='v')!;assert.equal(f.source_start_seconds,(60+100*2)/30);assert.equal(f.playback_rate,2);restore();});
test('detached media snapshot is kept without a pool dependency',()=>assert.equal(layers().find(l=>l.item_id==='image')!.asset_id,'product'));
test('missing media identity cannot be passed off as a still',()=>reject(()=>{delete doc.timelines[0].items[1].sourceAssetId;},/identity_missing/));
test('live source relink disagreement blocks',()=>reject(()=>{doc.assets=[{id:'product',kind:'image',src:'/media/uploads/wrong.png'}] as never;},/binding_conflict/));
test('live byte identity disagreement blocks',()=>reject(()=>{doc.assets=[{id:'product',kind:'image',src:'/media/uploads/product.png',sourceContentHash:'a'.repeat(64)}] as never;doc.timelines[0].items[1].sourceContentHash='b'.repeat(64);},/hash_conflict/));
test('original source identity is checked against analysis',()=>reject(()=>{doc.clipMentorAnalysis!.source.sourceContentHash='a'.repeat(64);doc.timelines[0].items[0].sourceContentHash='b'.repeat(64);},/original_hash_mismatch/));
test('true extracted frame requires matching original provenance',()=>{
 doc.assets=[{id:'product',kind:'image',src:'/media/uploads/product.png',props:{sourceSeconds:2,sourceAssetId:'source'}}] as never;
 assert.equal(layers().find(l=>l.item_id==='image')!.origin,'source_frame');assert.equal(layers().find(l=>l.item_id==='image')!.source_start_seconds,2);restore();
});
test('wrong extracted frame provenance still blocks',()=>reject(()=>{doc.assets=[{id:'product',kind:'image',src:'/media/uploads/product.png',props:{sourceSeconds:2,sourceAssetId:'wrong'}}] as never;},/provenance_invalid/));
test('MG uses item code, not the latest asset code',()=>{
 doc.timelines[0].items[1]={...doc.timelines[0].items[1],kind:'motion-graphic',code:'const Component=()=>null',props:{color:'yellow'}};
 doc.assets=[{id:'product',kind:'motion-graphic',src:'',code:'wrong asset code'}] as never;delete doc.timelines[0].items[1].src;
 const l=layers().find(l=>l.item_id==='image')!;assert.equal(l.origin,'authored');assert.equal(l.render_state.code_sha256,previewFactsDigest(doc.timelines[0].items[1].code));restore();
});
test('missing MG code cannot claim a materialized composition',()=>reject(()=>{doc.timelines[0].items[1].kind='motion-graphic';delete doc.timelines[0].items[1].src;},/mg_code_missing/));
test('native layout and fades survive manifest serialization',()=>{
 Object.assign(doc.timelines[0].items[1],{transform:{crop:{left:10,right:20,top:0,bottom:0},opacity:0.8},fadeInFrames:5});
 const l=JSON.parse(JSON.stringify(layers().at(-1))) as {render_state:{transform:unknown;fadeInFrames:number}};
 assert.deepEqual(l.render_state.transform,doc.timelines[0].items[1].transform);assert.equal(l.render_state.fadeInFrames,5);restore();
});
test('unrepresented transcript compression stops before review',()=>reject(()=>{doc.timelines[0].items[0].deletedWordIdx=[0];},/mapping_unsupported/));
test('crossfade not flattened into sequential facts',()=>reject(()=>{doc.timelines[0].transitions=[{id:'crossfade'}] as never;},/unsupported:transitions/));
test('nested sequences not flattened silently',()=>reject(()=>{doc.timelines[0].items[1].kind='sequence';},/unsupported:sequence/));
test('overrun source is not described as continuous motion',()=>reject(()=>{doc.assets=[{id:'source',kind:'video',src:'/media/uploads/source.mp4',durationInFrames:299}] as never;},/exceeds_media/));
test('duplicate native item IDs block',()=>reject(()=>{doc.timelines[0].items[1].id='v';},/item_invalid/));
test('invalid playback cannot create source timestamps',()=>reject(()=>{doc.timelines[0].items[0].playbackRate=NaN;},/timing_invalid/));
test('malformed composition cannot enter original manifest checker',()=>{
 const f=build(doc,state(),packet);const bad=structuredClone(f.executionManifest);if(bad.scenes[0].kind==='composition')bad.scenes[0].layers[0].origin='source_frame';
 assert.throws(()=>checkTransitionManifest(bad),/provenance/);
});
test('external image cannot carry a counterfeit source time',()=>{
 const f=build(doc,state(),packet);const bad=structuredClone(f.executionManifest);const s=bad.scenes.at(-1)!;if(s.kind==='composition')s.layers.at(-1)!.source_start_seconds=0;
 assert.throws(()=>checkTransitionManifest(bad),/provenance/);
});
test('fresh export fact binding passes; missing/stale binding fails',()=>{
 const f=build(doc,state(),packet),binding={revision:'r',facts_digest:previewFactsDigest(f)};
 assertPreviewExportBinding(binding,'r',f);assert.throws(()=>assertPreviewExportBinding(binding,'other',f),/stale/);
 assert.throws(()=>assertPreviewExportBinding(undefined,'r',f),/stale/);
 doc.timelines[0].items[1].transform={opacity:0.5};assert.throws(()=>assertPreviewExportBinding(binding,'r',build(doc,state(),packet)),/stale/);restore();
});
test('same-ID media URL replacement invalidates export even without byte hash',()=>{
 const f=build(doc,state(),packet),binding={revision:'r',facts_digest:previewFactsDigest(f)};
 doc.timelines[0].items[1].src='/media/uploads/new.png';assert.throws(()=>assertPreviewExportBinding(binding,'r',build(doc,state(),packet)),/stale/);restore();
});
test('audio routing changes invalidate the frozen export',()=>{
 const f=build(doc,state(),packet),binding={revision:'r',facts_digest:previewFactsDigest(f)};
 doc.timelines[0].tracks!['track-v1']!.role='anchor';assert.throws(()=>assertPreviewExportBinding(binding,'r',build(doc,state(),packet)),/stale/);restore();
});
test('native item changes cannot hide behind unchanged projected geometry',()=>{
 const f=build(doc,state(),packet),binding={revision:'r',facts_digest:previewFactsDigest(f)};
 doc.timelines[0].items[1].name='native code can read an item name';assert.throws(()=>assertPreviewExportBinding(binding,'r',build(doc,state(),packet)),/stale/);restore();
});
test('selection-only changes do not invalidate render facts',()=>{
 const f=build(doc,state(),packet);doc.timelines[0].selectedId='image';assert.equal(previewFactsDigest(f),previewFactsDigest(build(doc,state(),packet)));restore();
});
test('missing historical single-unit placement uses full context explicitly',()=>{
 delete doc.clipMentorAnalysis!.source_breakdown!.units[0].placement;const f=build(doc,state(),packet);
 assert.deepEqual(f.input.units[0].output_range_seconds,[0,10]);assert.equal(f.executionManifest.review_window_basis[0].basis,'whole_film_context_not_inferred_group_cut');restore();
});
test('multiple units with missing ranges do not invent cuts',()=>{
 const multiple=structuredClone(packet);multiple.units.push({...multiple.units[0],unit_id:'U2'});assert.throws(()=>build(doc,state(),multiple),/placement/);
});
const r={start_seconds:0,end_seconds:10,channel:'visual_organization' as const,observed:'全程只有静帧'};
const supported={status:'supported' as const,reasoning:'synthetic test only',evidence:[r]};
const judgment={coverage:[{point_id:'P',depiction:[r],teaching:supported}],continuity:[{unit_id:'U',point_ids:['P'],previous:[r],current:[r],relation:'recap',narrative:supported,teaching:supported}]};
test('layered opening reaches the preview request at its actual voice window',()=>{
 const d=structuredClone(doc),p=structuredClone(packet),t=d.timelines[0];
 const src='/media/uploads/opening-voice.mp3',assetId='opening-voice';
 d.assets.push({id:assetId,kind:'audio',src,durationInFrames:30} as ProjectDoc['assets'][number]);
 t.trackOrder!.push('track-a1');t.tracks!['track-a1']={kind:'audio'};
 t.items.push({id:'opening-audio',kind:'audio',src,sourceAssetId:assetId,startFrame:30,durationInFrames:30,track:'track-a1'} as ProjectDoc['timelines'][number]['items'][number]);
 p.delivery_sections=[{section_id:'opening',line:{narration_ms:'Jom tengok.'},
  voice:{existing_audio:{assetId,src,durationSeconds:1}},picture:{layout:{kind:'original_underlay',show_sales:true}}}] as TeachingPacket['delivery_sections'];
 const f=build(d,makeDraft(d).getState(),p);
 const req=buildPreviewReviewRequest(new Uint8Array([1]),f.input);
 assert.deepEqual(req.input.units.at(-1),{unit_id:'delivery/opening',point_ids:['delivery/opening'],output_range_seconds:[1,2]});
 assert.match(req.body,/成绩截图完整可读并及时退出/);
 const withReference={...f.input,points:[...f.input.points,{point_id:'delivery/criterion/opening',teaching_goal_zh:'同屏？',product_relevance:'用户要求'}],
  units:[...f.input.units,{unit_id:'delivery/criterion/opening',point_ids:['delivery/criterion/opening'],output_range_seconds:[1,2] as [number,number]}],
  visual_criteria:[{point_id:'delivery/criterion/opening',quote:'  用户原话。\n ',question:'同屏？',fileName:'NIUMO V7.mp4',seconds:1.5,base64:'aGVsbG8='}]};
 const paired=buildPreviewReviewRequest(new Uint8Array([1]),withReference);
 const parts=JSON.parse(paired.body).contents[0].parts;
 assert.equal(parts[0].inlineData.mimeType,'video/mp4');
 assert.equal(parts.at(-1).inlineData.mimeType,'image/jpeg');
 assert.equal(JSON.parse(parts.at(-2).text).quote,withReference.visual_criteria[0].quote);
 assert(!parts[1].text.includes('aGVsbG8='));
 const issue='delivery/opening:delivery_visual_evidence_missing_in_section';
 const receipt=(start_seconds:number,end_seconds:number)=>evaluatePreviewTeachingJudgment({
  continuity:[],coverage:[{point_id:'delivery/opening',depiction:[],teaching:{status:'supported',reasoning:'fixture',
   evidence:[{start_seconds,end_seconds,channel:'visual_organization',observed:'fixture'}]}}],
 },req.input);
 assert(receipt(2,3).issues.includes(issue));
 assert(!receipt(1,1.5).issues.includes(issue));
 t.tracks!['track-a1'].muted=true;
 assert.throws(()=>build(d,makeDraft(d).getState(),p),/preview_delivery_audio_binding_invalid:opening/);
});
test('a scheduled lower video is not proof of visible motion',()=>{
 const f=build(doc,state(),packet),receipt={judgment,full_film_accepted:false},before=JSON.stringify(receipt);
 const check=checkPreviewTimelineObservations(f.executionManifest,receipt,f.input);
 assert.equal(check.status,'review_required');assert.equal(check.units[0].issues.find(i=>i.code==='static_description_over_video')?.certainty,'needs_semantic_check');
 assert.equal(JSON.stringify(receipt),before);assert.equal(check.units[0].model_verdict_preserved.teaching.status,'supported');assert.equal(check.full_film_accepted,false);
});
for(const entry of saved.cases)test(`saved ${entry.case_id}: all 38 native items remain; no project writes`,()=>{
 const d=entry.doc as unknown as ProjectDoc,t=d.timelines[0],p=entry.packet as TeachingPacket,before=JSON.stringify(entry);
 const f=build(d,t,p);assert.equal(t.items.length,38);checkTransitionManifest(JSON.parse(JSON.stringify(f.executionManifest)));
 const all=f.executionManifest.scenes.flatMap(s=>s.kind==='composition'?s.layers:[]);
 for(const i of t.items.filter(i=>i.kind!=='audio'))assert(all.some(l=>l.item_id===i.id),`missing ${i.id}`);
 const pictures=all.filter(l=>l.kind==='image');assert(pictures.length);assert(pictures.every(l=>l.origin==='media_asset'&&l.source_start_seconds===undefined));
 assert(all.some(l=>l.kind==='motion-graphic'&&l.render_state.code_sha256));
 assert.equal(f.input.units[0].output_range_seconds[1],f.input.duration_seconds);
 assert.equal(JSON.stringify(entry),before);
});
console.log(`${checks} composition regressions passed; synthetic receipts are test data only; zero provider calls, renders or production writes`);
