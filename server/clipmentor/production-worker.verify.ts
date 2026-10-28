import assert from 'node:assert/strict';
import {productionPreviewFacts,productionAuthorTaskData,productionStageToolAllowed} from './production-worker';
import {projectDoc} from '../external-agent/offline-runtime.verify-fixtures';
import {makeDraft} from '../../src/editor/store';
import {checkTransitionManifest} from '../../src/clipmentor/transition-check';
import type {TeachingPacket} from '../../src/clipmentor/production-gate';
const doc=projectDoc();
doc.timelines[0].items=[0,200,100].map(startFrame=>({id:`v${startFrame}`,kind:'video',src:'/media/uploads/source.mp4',sourceAssetId:'source',startFrame,durationInFrames:100,track:'track-v1'})) as never;
const d=makeDraft(doc);
doc.clipMentorAnalysis={source:{asset_id:'source'},source_breakdown:{units:[{unit_id:'U02',placement:{timeline_id:doc.activeTimelineId,original_frames:[0,100],explanation_frames:[100,300]}}]}} as never;
const packet={units:[{unit_id:'U02',points:[{point_id:'P',question:'怎么拍清产品使用？',buying_concern:'使用方式'}]}]} as TeachingPacket;
const {input,executionManifest}=productionPreviewFacts(doc,d.getState(),packet);
assert.deepEqual(executionManifest.scenes.map(s=>s.start_frame),[0,100,200],'actual playback order, not insertion order');
assert.equal(checkTransitionManifest(executionManifest).review_groups.length,0,'valid film can have no mechanical candidates');
assert.equal(input.units[0].unit_id,'U02');
assert.deepEqual(input.units[0].output_range_seconds,[0,10],'teaching unit uses saved output placement');
const bad=structuredClone(executionManifest);bad.scenes[1].start_frame=99;
assert.throws(()=>checkTransitionManifest(bad),/overlapping|discontinuous/,'real overlap remains blocked');
doc.clipMentorAnalysis!.source_breakdown!.units[0].placement!.timeline_id='other';
assert.throws(()=>productionPreviewFacts(doc,d.getState(),packet),/placement/,'stale placement is not guessed');
console.log('production worker projection: unsorted valid clips, teaching IDs, output placement and invalid-range refusal passed; zero provider calls');

// Saved real plans exercise the same message generator used by executeRun, no API call.
const {default:saved}=await import('../../src/clipmentor/fixtures/production-saved-projects-20261028.json');
const {prepareProductionBlueprint}=await import('./production-readiness');
const task={stage:'edit',input:{brief:'Implement frozen decisions',sourceAssetId:'d24aef47-f694-4a50-a639-42d80e25d75a'}} as import('./production-task').ProductionTask;
for(const entry of saved.cases){
 const project=entry.doc as unknown as import('../../src/editor/types').ProjectDoc;
 const actual=JSON.parse(JSON.stringify(await productionAuthorTaskData(task,project)));
 assert.deepEqual(actual.frozenBlueprint,await prepareProductionBlueprint(project));
 assert.equal(actual.frozenBlueprint.subject.digest,project.clipMentorAnalysis!.production_copy_review!.content_digest);
 assert(actual.frozenBlueprint.packet.units[0].picture_plan.execution_plan.content.composition.detail.includes('measured_audio_bindings'));
}
const planning=await productionAuthorTaskData({...task,stage:'blueprint'},saved.cases[0].doc as unknown as import('../../src/editor/types').ProjectDoc);
assert.equal(planning.frozenBlueprint,null,'a teaching draft must not pretend to be a frozen executable plan');
assert(planning.goal.includes('不固定四组'));
console.log('production worker actual message: two saved plans, subject digests and complete picture/audio instructions survive serialization; draft stage remains separate; no provider requests');

for(const name of ['revise_clipmentor_analysis','submit_voice','observe_clipmentor_source_video'])assert.equal(productionStageToolAllowed('edit',name),false);
assert.equal(productionStageToolAllowed('blueprint','revise_clipmentor_analysis'),true);assert.equal(productionStageToolAllowed('edit','edit_item'),true);
