import assert from 'node:assert/strict';
import {matchMeasuredNarration,prepareProductionBlueprint,productionBlueprintReadiness,productionExecutionReport} from './production-readiness';
import savedProjects from '../../src/clipmentor/fixtures/production-saved-projects-20261028.json';
import type {ProjectDoc} from '../../src/editor/types';
import {performance} from 'node:perf_hooks';
import type {MediaAsset} from '../../src/editor/types';
const voice={provider:'minimax',voiceId:'confirmed'};
const lines=[{line_id:'A',narration_ms:'Close-up comparison.'},{line_id:'B',narration_ms:'Usage sequence.'}];
const assets:MediaAsset[]=lines.map((l,i)=>({id:`audio-${i}`,kind:'audio',name:'fixture',src:'/media/uploads/fixture.mp3',durationInFrames:90,
 props:{generation:{...voice,text:l.narration_ms,speed:1,durationSeconds:3}}}));
assert.equal(matchMeasuredNarration(lines,assets,voice).length,2);
assert.throws(()=>matchMeasuredNarration(lines,[assets[0]],voice),/B/,'one audio does not satisfy the whole group');
for(const patch of [{text:'stale copy'},{speed:1.2},{durationSeconds:0},{durationSeconds:NaN},{voiceId:'unconfirmed'}]){
 const bad=structuredClone(assets);Object.assign(bad[1].props!.generation as object,patch);assert.throws(()=>matchMeasuredNarration(lines,bad,voice));
}
assert.throws(()=>matchMeasuredNarration(lines,[{...assets[0],props:{}}],voice));
console.log('production readiness: exact current text, confirmed voice, measured duration and normal speed per line; missing/stale/speed-up cases refused, valid group accepted');

let modelCalls=0;
globalThis.fetch=(async()=>{modelCalls++;throw Error('Unexpected network in blueprint regression');}) as typeof fetch;
const clock=performance.now();
for(const entry of savedProjects.cases){
 const doc=entry.doc as unknown as ProjectDoc,before=JSON.stringify(doc);
 const prepared=await prepareProductionBlueprint(doc);
 assert(prepared.packet.units.every(u=>u.picture_plan?.execution_plan),'saved current plans reach product entry');
 const maturity=await productionBlueprintReadiness(doc);
 assert.equal(maturity.next,'edit',`${entry.case_id}: legacy measured audio is reusable without regeneration`);
 assert.equal(maturity.ready,true);assert.equal(maturity.complete_film_accepted,false);
 assert.equal(maturity.actual_audio_visual_capacity_verified,false,'availability is not semantic capacity acceptance');
 const report=await productionExecutionReport(doc,doc);
 assert.equal(report.actual_source_bindings.length,10);assert.equal(report.narration.length,6);
 assert.equal(report.captions.status,'matches');assert.equal(report.complete_film_accepted,false);
 assert.equal(report.differences.changes.length,0);
 assert.equal(JSON.stringify(doc),before,'readiness/report must never modify saved case or judgments');
 const draft=structuredClone(doc);delete draft.clipMentorAnalysis!.production_copy_review;
 draft.assets=draft.assets.filter(a=>a.kind!=='audio');draft.timelines[0].items=[];
 assert.equal((await productionBlueprintReadiness(draft)).next,'copy_review','teaching plan can be reviewed before voice or editing');
 const unvoiced=structuredClone(doc);unvoiced.assets=unvoiced.assets.filter(a=>a.kind!=='audio');
 assert.equal((await productionBlueprintReadiness(unvoiced)).next,'audio');
 const modified=structuredClone(doc);
 const internal=modified.clipMentorAnalysis!.blueprint[0].internal_review as Record<string,any>;
 internal[internal.current_script_candidate].lines[0].narration_ms+=' Extra wording.';
 assert.equal((await productionBlueprintReadiness(modified)).ready,false,'changed wording cannot inherit the old review/audio');
 await assert.rejects(productionExecutionReport(doc,modified),/blueprint_changed|blueprint_stage_incomplete/);
 const captions=structuredClone(doc),overlay=captions.timelines[0].items.find(i=>i.kind==='motion-graphic')!;
 if(typeof overlay.props!.cards==='string')overlay.props!.cards=(overlay.props!.cards as string).replace('Tengok','Wrong');
 else (overlay.props!.cards as any[])[0][2][0]='Wrong caption';
 await assert.rejects(productionExecutionReport(doc,captions),/caption_text_mismatch/);
 const source=structuredClone(doc),video=source.timelines[0].items.find(i=>i.kind==='video')!;
 video.srcInFrame=(video.srcInFrame??0)+60;
 await assert.rejects(productionExecutionReport(doc,source),/Actual sequence mapping/);
}
assert.equal((await productionBlueprintReadiness(null)).code,'project_missing');
// No voice provenance can be invented for historical bindings when a voice is required.
const unknownVoice=await productionBlueprintReadiness(savedProjects.cases[0].doc as unknown as ProjectDoc,{provider:'minimax',voiceId:'unknown'});
assert.equal(unknownVoice.next,'audio');assert.equal(unknownVoice.code,'audio_voice_provenance_missing');assert.deepEqual('missing_line_ids' in unknownVoice?unknownVoice.missing_line_ids:[],[],'unknown voice must not be reported as six missing files requiring synthesis');
const boundDoc=savedProjects.cases[0].doc as unknown as ProjectDoc;
const bInternal=boundDoc.clipMentorAnalysis!.blueprint[0].internal_review as Record<string,any>;
const boundRows=JSON.parse(bInternal[bInternal.current_picture_plan].composition.detail).measured_audio_bindings;
const boundLines=(await prepareProductionBlueprint(boundDoc)).packet.units.flatMap(u=>u.lines);
assert.equal(matchMeasuredNarration(boundLines,boundDoc.assets,undefined,boundRows).length,6);
for(const patch of [{text:'wrong text'},{src:'/media/wrong.mp3'},{assetId:'missing'},{playback_rate:1.2},{full_file_untrimmed:false},{audioSha256:''},{durationSeconds:-1}]){
 const wrong=structuredClone(boundRows);Object.assign(wrong[0],patch);
 assert.throws(()=>matchMeasuredNarration(boundLines,boundDoc.assets,undefined,wrong),'saved audio bindings must not be trusted without exact current identity and normal-speed provenance');
}
const conflicting=structuredClone(boundDoc.assets);conflicting.find(a=>a.kind==='audio')!.props={generation:{text:'different current words',speed:1,durationSeconds:3}};
assert.throws(()=>matchMeasuredNarration(boundLines,conflicting,undefined,boundRows),'do not use a legacy binding to override conflicting current generation metadata');
// Adversarial review: readable metadata is insufficient when actual execution is muted,
// hidden, or has substituted media under an unchanged asset ID.
const frozen=structuredClone(boundDoc);
const muted=structuredClone(frozen),spoken=muted.timelines[0].items.find(i=>i.kind==='audio')!;
muted.timelines[0].tracks![spoken.track].muted=true;
await assert.rejects(productionExecutionReport(frozen,muted),/muted|Narration/);
const swapped=structuredClone(frozen),audioAsset=swapped.assets.find(a=>a.kind==='audio')!;
audioAsset.src='/media/uploads/substituted.mp3';
await assert.rejects(productionExecutionReport(frozen,swapped),/media_changed/);
const hidden=structuredClone(frozen),graphic=hidden.timelines[0].items.find(i=>i.kind==='motion-graphic')!;
hidden.timelines[0].tracks![graphic.track].hidden=true;
assert.equal((await productionExecutionReport(frozen,hidden)).captions.status,'unverified');
assert.equal(modelCalls,0);
console.log(JSON.stringify({saved_case_count:2,actual_source_bindings_each:10,matching_audio_each:6,elapsed_ms:Math.round(performance.now()-clock),modelCalls}));
