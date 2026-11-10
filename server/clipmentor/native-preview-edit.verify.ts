import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {previewEditBridge} from './preview-edit';
import {buildPreviewRevision,previewDocDigest} from '../../src/clipmentor/preview-edit';
import {sha256File} from '../../shared/node-content-hash';
import {makeDraft} from '../../src/editor/store';
import {migrateProjectDoc} from '../../src/persist/projectStore';
import type {ProjectDoc} from '../../src/editor/types';
const dir=await mkdtemp(join(tmpdir(),'native-preview-'));
const operationId='73665a13-1e59-4f4c-b2be-a323d4a875bd',projectId='native-test';
try {
 for(const name of ['base.mp4','source.mp4','still.png']) await writeFile(join(dir,name),name);
 const picture=(id:string,kind:string,startFrame:number,durationInFrames:number)=>({id,name:id,kind,track:'picture',startFrame,durationInFrames,
  src:kind==='video'?'/media/uploads/source.mp4':'/media/uploads/still.png',srcInFrame:0,volume:0,transform:{scale:.68,x:0,y:-10}});
 let doc={version:3,assets:[],mediaFolders:[],activeTimelineId:'t',timelines:[{
  id:'t',name:'native',order:0,fps:30,width:1080,height:1920,trackOrder:['caption','picture','audio'],tracks:{caption:{kind:'video'},picture:{kind:'video'},audio:{kind:'audio'}},
  selectedId:null,selectedIds:[],items:[picture('a','image',10,2),picture('b','video',12,2),picture('c','video',14,4),picture('d','image',18,2),
   {id:'cap',name:'locked caption',kind:'text',track:'caption',startFrame:0,durationInFrames:20,text:'locked'},
   {id:'audio',name:'locked audio',kind:'audio',track:'audio',startFrame:0,durationInFrames:20,src:'/media/uploads/base.mp4'}]}]} as unknown as ProjectDoc;
 doc=migrateProjectDoc(doc)!;assert.ok(doc,'fixture must cross the real persisted-document boundary');
 const native={timelineId:'t',range:[10,20],videoId:'c',stillId:'d',removeIds:['a','b'],sourceStartFrame:30,videoFrames:6,
  stillSha256:await sha256File(join(dir,'still.png')),boxes:[{x:330,y:520,width:210,height:290},{x:675,y:520,width:200,height:290}],
  arrows:[{x1:610,y1:680,x2:550,y2:665},{x1:610,y1:680,x2:675,y2:665}]};
 const permit={kind:'native_comparison',projectId,operationId,expiresAt:Date.now()+60000,baseProjectSha256:await previewDocDigest(doc),instruction:'Exact local comparison only',
  baseline:{src:'/media/uploads/base.mp4',sha256:await sha256File(join(dir,'base.mp4')),fps:30,totalFrames:20,width:720,height:1280},
  source:{src:'/media/uploads/source.mp4',sha256:await sha256File(join(dir,'source.mp4')),fps:30},native};
 const grant=join(dir,projectId,operationId);await mkdir(grant,{recursive:true});
 const save=(p=permit)=>writeFile(join(grant,'permit.json'),JSON.stringify(p));await save();
 let ffmpegCalls=0;const deps={directory:dir,resolve:(n:string)=>join(dir,n),execute:async()=>{ffmpegCalls++;}};
 const call=(action:string,d=doc)=>previewEditBridge({projectId,operationId,action,doc:d},deps);
 assert.equal((await call('read')).allowed,true);
 const before=JSON.stringify(doc),[r,raced]=await Promise.all([call('prepare'),call('prepare')]) as any[],next=buildPreviewRevision(doc,r.plan);
 assert.deepEqual(raced,r,'concurrent exact prepares read the same complete published winner');
 assert.equal(JSON.stringify(doc),before);assert.equal(ffmpegCalls,0);
 assert.equal(await previewDocDigest(next),r.preparedProjectSha256);
 assert.equal(await previewDocDigest(makeDraft(next).getDoc()),r.preparedProjectSha256);
 assert.equal(await previewDocDigest(migrateProjectDoc(next)!),r.preparedProjectSha256,'saved/cold-loaded media revision stamps must not invalidate an exact prepared project');
 assert.deepEqual(next.timelines[0],doc.timelines[0]);assert.deepEqual(next.clipMentorAnalysis,doc.clipMentorAnalysis);
 const t=next.timelines.at(-1)!;
 for(const id of ['cap','audio']) assert.deepEqual(t.items.find(i=>i.id===id),doc.timelines[0]!.items.find(i=>i.id===id));
 assert.deepEqual(t.items.filter(i=>i.track==='picture').map(i=>[i.id,i.startFrame,i.durationInFrames,i.srcInFrame]),[['c',10,6,30],['d',16,4,0]]);
 const overlay=t.items.find(i=>i.name==='比较区域框与箭头')!;
 assert.equal(overlay.startFrame,16);assert.equal(overlay.durationInFrames,4);
 assert.match(await readFile(join(dir,r.plan.native.annotation.src.split('/').at(-1)),'utf8'),/<rect/);
 // A follow-up annotation correction may replace only the prior emphasis overlay;
 // all source picture timing, text and audio remain exactly as saved.
 const replacement=structuredClone(r.plan);
 replacement.operationId='558d0532-562b-43ce-a4ab-92d75e5ce345';
 replacement.native.timelineId=t.id;replacement.native.removeIds=[];
 replacement.native.replaceAnnotationId=overlay.id;
 replacement.native.annotation={...replacement.native.annotation,id:'new-emphasis',src:'/media/uploads/new-emphasis.svg'};
 const revised=buildPreviewRevision(next,replacement),rt=revised.timelines.at(-1)!;
 assert.equal(rt.items.filter(i=>i.name==='比较区域框与箭头').length,1);
 assert.deepEqual(rt.items.filter(i=>i.name!=='比较区域框与箭头'),t.items.filter(i=>i.name!=='比较区域框与箭头'));
 assert.deepEqual(revised.timelines.slice(0,next.timelines.length),next.timelines);
 for(const forbidden of ['cap','audio','c','missing']) {
  const bad=structuredClone(replacement);bad.native.replaceAnnotationId=forbidden;
  assert.throws(()=>buildPreviewRevision(next,bad),/Invalid native comparison/);
 }
 await call('check_render',next);
 await assert.rejects(call('check_render',{...next,assets:[]}),/Project changed/);
 await writeFile(join(dir,'still.png'),'changed');await assert.rejects(call('read'),/Still material changed/);await writeFile(join(dir,'still.png'),'still.png');
 await call('reserve_render',next);await assert.rejects(call('reserve_render',next),/EEXIST/);
 assert.deepEqual(doc.clipMentorAnalysis,next.clipMentorAnalysis,'export failures cannot mutate already committed edits or old approvals');
 const renderReservation=await readFile(join(grant,'render-reserved.json'),'utf8');
 await rm(join(grant,'prepared.json'));
 const annotationPath=join(dir,r.plan.native.annotation.src.split('/').at(-1)),annotation=await readFile(annotationPath,'utf8');
 await writeFile(annotationPath,'corrupt annotation');
 await assert.rejects(call('prepare'),/content mismatch/);
 assert.equal(await readFile(annotationPath,'utf8'),'corrupt annotation','wrong existing material is never overwritten');
 await writeFile(annotationPath,annotation);
 const [restored,restoredRace]=await Promise.all([call('prepare'),call('prepare')]);
 assert.deepEqual(restored,restoredRace);assert.deepEqual(restored,r,'exact orphaned material recovers a lost prepared publication');
 assert.equal(await readFile(join(grant,'render-reserved.json'),'utf8'),renderReservation,'preparation recovery never refunds the consumed render');
 await assert.rejects(call('check_render',next),/attempt already consumed/);
 await rm(join(grant,'prepared.json'));
 for(const altered of [{...native,videoId:'audio'},{...native,removeIds:['a','cap']},{...native,range:[9,20]},
   {...native,videoFrames:10},{...native,sourceStartFrame:-1},{...native,boxes:[{x:0,y:1900,width:300,height:300}]}]) {
  await save({...permit,native:altered} as typeof permit);
  await assert.rejects(call('prepare'),/Invalid native|Native comparison|native source mismatch/);
 }
 await save();
 await assert.rejects(previewEditBridge({projectId,operationId,action:'prepare',doc,updates:[]},deps),/Invalid preview/);
 console.log('native-preview-edit: exact local delta, real layered shape, immutable text/audio/history, bound media, denied scope drift, one-attempt render passed');
} finally {await rm(dir,{recursive:true,force:true});}
