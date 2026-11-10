import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {previewEditBridge,executePreviewMaterial,type PreviewEditPermit} from './preview-edit';
import {previewDocDigest,buildPreviewRevision,editClipMentorPreview} from '../../src/clipmentor/preview-edit';
import {previewEditDependencies} from '../plugins/clipmentor-preview-review';
import {resolveRuntimeProfile} from '../runtime-profile';
import {registerMediaReference} from '../media-references';
import {sha256File} from '../../shared/node-content-hash';
import {clipMentorProductionBlock} from '../../src/clipmentor/production-gate';
import {policyForTool} from '../../src/agent/execution-policy';
import {makeDraft} from '../../src/editor/store';
import type {ProjectDoc} from '../../src/editor/types';
import type {AgentContext} from '../../src/agent/context';
import {verifyPreviewMaterialPublication} from './preview-edit-publication.verify-suite';
const dir=await mkdtemp(join(tmpdir(),'clipmentor-preview-edit-'));
const projectId='test-project',operationId='9eb329e2-928c-4f2b-87cf-3b22f54e72ef';
const doc={version:1,assets:[],mediaFolders:[],activeTimelineId:'old',timelines:[{id:'old',order:0,name:'old',fps:30,width:720,height:1280,
  selectedId:null,items:[]}]} as unknown as ProjectDoc;
const grant=join(dir,projectId,operationId);await mkdir(grant,{recursive:true});
await writeFile(join(dir,'base.mp4'),'baseline');await writeFile(join(dir,'source.mp4'),'source');
const permit:PreviewEditPermit={projectId,operationId,expiresAt:Date.now()+60000,baseProjectSha256:await previewDocDigest(doc),
 baseline:{src:'/media/uploads/base.mp4',sha256:await sha256File(join(dir,'base.mp4')),fps:30,totalFrames:2640,width:720,height:1280},
 source:{src:'/media/uploads/source.mp4',sha256:await sha256File(join(dir,'source.mp4')),fps:30},
 relation:{referenceFrame:1408,startFrame:1409,endFrame:1415,clearCaptionY:960},
 tail:{allowedSourceFrames:[2557,2558],startFrame:1880,endFrame:1888,sourceOutFrameExclusive:2559},
 label:{text:'Ulasan semula',startFrame:1888,endFrame:2112},instruction:'Approved local changes only'};
const save=()=>writeFile(join(grant,'permit.json'),JSON.stringify(permit));await save();
let commands=0;
const deps={directory:dir,resolve:(n:string)=>join(dir,n),execute:async(args:string[])=>{commands++;await writeFile(args.at(-1)!,'prepared image');}};
const call=(action:string,extra={})=>previewEditBridge({projectId,operationId,doc,action,...extra},deps);
try {
 await verifyPreviewMaterialPublication(dir,doc,permit);
 // A rejected competing tail choice must not alter the published winner's bytes.
 const raceId='3af989d2-0d07-4774-a998-98f6ff389194',raceDir=join(dir,projectId,raceId);
 await mkdir(raceDir,{recursive:true});
 await writeFile(join(raceDir,'permit.json'),JSON.stringify({...permit,operationId:raceId}));
 const tailStarted=Promise.withResolvers<void>(),releaseTail=Promise.withResolvers<void>();
 const raceExecute=async(args:string[])=>{await writeFile(args.at(-1)!,args.join(' '));};
 const heldExecute=async(args:string[])=>{
   if(args.at(-1)!.endsWith('-tail.png')){tailStarted.resolve();await releaseTail.promise;}
   await raceExecute(args);
 };
 const raceCall=(tailFrame:number,execute:typeof raceExecute)=>previewEditBridge({projectId,operationId:raceId,doc,action:'prepare',tailFrame},{...deps,execute});
 const losing=raceCall(2558,heldExecute);const losingRejected=assert.rejects(losing,/content mismatch/);
 await tailStarted.promise;
 const winning=await raceCall(2557,raceExecute) as any;
 releaseTail.resolve();await losingRejected;
 await previewEditBridge({projectId,operationId:raceId,action:'check_render',doc:buildPreviewRevision(doc,winning.plan)},deps);
 // Exercise the production resolver: custom writable root, Unicode names and external references.
 const profile=resolveRuntimeProfile({}, {homeDir:join(dir,'home'),cwd:dir});
 const custom=join(dir,'custom-media');await mkdir(custom,{recursive:true});
 await writeFile(join(custom,'基线 预览.mp4'),'baseline');
 await registerMediaReference(custom,'原片.mp4',join(dir,'source.mp4'));
 const customDeps={...previewEditDependencies(profile,custom),directory:dir,execute:deps.execute};
 const originalBaseline=permit.baseline.src,originalSource=permit.source.src;
 permit.baseline.src='/media/uploads/基线 预览.mp4';permit.source.src='/media/uploads/原片.mp4';await save();
 assert.equal((await previewEditBridge({projectId,operationId,doc,action:'read'},customDeps)).allowed,true);
 const customPrepared=await previewEditBridge({projectId,operationId,doc,action:'prepare',tailFrame:2558},customDeps) as any;
 for(const patch of customPrepared.plan.patches) {
   const name=patch.asset.src.slice('/media/uploads/'.length);
   assert.equal(customDeps.resolve(name),join(custom,name),'new outputs must resolve from the configured writable root');
   assert(await readFile(join(custom,name)));
 }
 for(const name of ['../private.mp4','a/b.mp4','a\\b.mp4','.hidden','bad\nname']) assert.equal(customDeps.output!(name),null);
 await rm(join(grant,'prepared.json'));commands=0;
 permit.baseline.src=originalBaseline;permit.source.src=originalSource;await save();
 assert.equal((await call('read')).quality_status,'review_required');
 await assert.rejects(call('check_render'),/prepared native project/);
 await assert.rejects(call('prepare',{tailFrame:2559}),/tail selection/);
 await assert.rejects(call('prepare',{tailFrame:2558,approved:true}),/Invalid/);
 const before=JSON.stringify(doc);
 const prepared=await call('prepare',{tailFrame:2558}) as any;
 assert.equal(commands,2);assert.equal(JSON.stringify(doc),before);
 const next=buildPreviewRevision(doc,prepared.plan);assert.equal(await previewDocDigest(next),prepared.preparedProjectSha256);
 assert.deepEqual(next.timelines[0],doc.timelines[0]);assert.deepEqual(next.clipMentorAnalysis,doc.clipMentorAnalysis);
 const timeline=next.timelines.at(-1)!;
 assert.equal(timeline.items[0]!.durationInFrames,2640);assert.equal(timeline.items[0]!.volume,1);
 assert.deepEqual(timeline.items.slice(1).map(i=>[i.startFrame,i.durationInFrames]),[[1409,6],[1880,8],[1888,224]]);
 assert.equal(makeDraft(next).getDoc().activeTimelineId,next.activeTimelineId);
 assert.equal(await previewDocDigest(makeDraft(next).getDoc()),prepared.preparedProjectSha256,'draft engine must preserve exact binding');
 await assert.rejects(call('prepare',{tailFrame:2557}),/replace prepared input/);
 const body={projectId,operationId,doc:next};
 assert.equal((await previewEditBridge({...body,action:'check_render'},deps)).allowed,true);
 await assert.rejects(previewEditBridge({...body,action:'check_render',doc:{...next,activeTimelineId:'old'}},deps),/Project changed/);
 // General production never inherits the local draft authorization.
 const ctx={getDoc:()=>next,getState:()=>timeline,getCreativeMode:()=> 'clipmentor'} as unknown as AgentContext;
 assert.equal((await clipMentorProductionBlock('submit_voice',{text:'x'},ctx))?.production_gate.allowed,false);
 await previewEditBridge({...body,action:'reserve_render'},deps);
 await assert.rejects(previewEditBridge({...body,action:'reserve_render'},deps),/EEXIST/);
 await assert.rejects(previewEditBridge({...body,action:'check_render'},deps),/attempt already consumed/);
 await writeFile(join(dir,'source.mp4'),'replaced');await assert.rejects(call('read'),/hash changed/);
 await writeFile(join(dir,'source.mp4'),'source');permit.expiresAt=1;await save();await assert.rejects(call('read'),/expired/);
 assert.deepEqual(policyForTool('edit_clipmentor_preview',{action:'read'}),{effect:'read',recovery:'pure'});
 assert.equal(policyForTool('edit_clipmentor_preview',{action:'render'}).recovery,'outcome_unknown');
 // Browser execution applies only the server-bound returned doc; no host editor side effect.
 permit.expiresAt=Date.now()+60000;await save();
 const fetchBefore=globalThis.fetch;
 try {
  let applied:ProjectDoc|undefined;
  globalThis.fetch=async(_url,init)=>new Response(JSON.stringify(await previewEditBridge(JSON.parse(String(init?.body)),deps)));
  const browser={...ctx,getDoc:()=>doc,getProjectId:()=>projectId,commands:{applyDoc:(d:ProjectDoc)=>{applied=d;}}} as unknown as AgentContext;
  const result=await editClipMentorPreview({action:'apply',operationId,tailFrame:2558},browser);
  assert.equal('ok' in result&&result.ok,true);assert.deepEqual(applied,next);
  applied=undefined;
  globalThis.fetch=async()=>new Response(JSON.stringify({...prepared,allowed:true,scope:'authorized_local_preview_revision',full_film_accepted:false,operationId:'other',projectId}));
  const forged=await editClipMentorPreview({action:'apply',operationId,tailFrame:2558},browser);
  assert.equal('error' in forged,true);assert.equal(applied,undefined,'wrong-operation receipts must never apply');
 } finally {globalThis.fetch=fetchBefore;}
 assert.equal(JSON.parse(await readFile(join(grant,'render-reserved.json'),'utf8')).projectSha256,prepared.preparedProjectSha256);
 // Real local media regression: exercise crop, conditional captions, frame count and audio trim.
 const mergeId='b0ff9dea-f364-4088-ab3d-bb2c6597b72e';
 const mergeDir=join(dir,projectId,mergeId);await mkdir(mergeDir,{recursive:true});
 await executePreviewMaterial(['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=white:s=720x1280:r=30:d=1',
   '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=1','-c:v','libx264','-preset','ultrafast','-threads','2','-c:a','aac','-shortest',join(dir,'fixture.mp4')]);
 const fixtureHash=await sha256File(join(dir,'fixture.mp4'));
 const merge:PreviewEditPermit={kind:'sniff_merge',projectId,operationId:mergeId,expiresAt:Date.now()+60000,
   baseProjectSha256:await previewDocDigest(doc),instruction:'Only approved sentence removal; preserve semantic point',
   baseline:{src:'/media/uploads/fixture.mp4',sha256:fixtureHash,fps:30,totalFrames:30,width:720,height:1280},
   source:{src:'/media/uploads/fixture.mp4',sha256:fixtureHash,fps:30},removeFrames:[3,6],removeAudioSeconds:[.1,.2],
   sourceStartFrame:0,pictureFrames:3,captionFrames:2,captionReferenceFrame:6};
 await writeFile(join(mergeDir,'permit.json'),JSON.stringify(merge));
 const mergeCall=(action:string,extra={})=>previewEditBridge({projectId,operationId:mergeId,action,doc,...extra},{...deps,execute:executePreviewMaterial});
 assert.equal((await mergeCall('read')).quality_status,'review_required');
 const m=await mergeCall('prepare') as any;
 assert.equal(m.plan.totalFrames,27);assert.deepEqual(m.plan.baseSegments,[{startFrame:0,durationInFrames:3,srcInFrame:0},{startFrame:3,durationInFrames:24,srcInFrame:6}]);
 const merged=buildPreviewRevision(doc,m.plan),mt=merged.timelines.at(-1)!;
 assert.deepEqual(merged.timelines[0],doc.timelines[0]);
 assert.equal(mt.items.filter(i=>i.track==='preview_baseline').every(i=>i.volume===0),true);
 assert.equal(mt.items.find(i=>i.track==='preview_audio')!.durationInFrames,27);
 assert.equal(mt.items.find(i=>i.track==='preview_patches')!.kind,'video');
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const probe=promisify(execFile);
 const video=JSON.parse((await probe('ffprobe',['-v','error','-show_entries','stream=nb_frames','-of','json',join(dir,m.plan.patches[0].asset.src.split('/').at(-1))])).stdout);
 assert.equal(video.streams[0].nb_frames,'3');
 const wav=JSON.parse((await probe('ffprobe',['-v','error','-show_entries','format=duration','-of','json',join(dir,m.plan.audio.src.split('/').at(-1))])).stdout);
 assert.ok(Math.abs(Number(wav.format.duration)-.9)<1/48000);
 await mergeCall('check_render',{doc:merged});
 await writeFile(join(dir,m.plan.audio.src.split('/').at(-1)),'changed');
 await assert.rejects(mergeCall('check_render',{doc:merged}),/material changed/);
 const invalid={...merge,removeAudioSeconds:[.1,.5]};await writeFile(join(mergeDir,'permit.json'),JSON.stringify(invalid));
 await assert.rejects(mergeCall('read'),/merge boundaries/);
 console.log('preview-edit: scoped authorization, source/project binding, preserved baseline, native draft, denied out-of-scope production and one-attempt export passed');
} finally {await rm(dir,{recursive:true,force:true});}
