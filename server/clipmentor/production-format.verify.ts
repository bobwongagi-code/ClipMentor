import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {assertProductionDimensions,assertProductionCanvas,verifyProductionOutput} from './production-format';
import {ffmpegBin} from '../media-binaries';
import type {ProjectDoc} from '../../src/editor/types';

for(const [width,height] of [[720,1280],[1080,1920],[576,1024]])assertProductionDimensions({width,height},'fixture');
for(const value of [undefined,{}, {width:1920,height:1080},{width:720,height:720},{width:720,height:1200},
 {width:0,height:0},{width:-720,height:-1280},{width:NaN,height:1280},{width:'720',height:1280}])
 assert.throws(()=>assertProductionDimensions(value,'fixture'),/clipmentor_output_canvas_mismatch/);
const doc={activeTimelineId:'active',timelines:[{id:'other',width:1920,height:1080},{id:'active',width:720,height:1280}]} as ProjectDoc;
const before=JSON.stringify(doc);assertProductionCanvas(doc);assert.equal(JSON.stringify(doc),before);
assert.throws(()=>assertProductionCanvas({...doc,activeTimelineId:'missing'}),/clipmentor_output_canvas_mismatch/);
const root=await mkdtemp(join(tmpdir(),'clipmentor-output-format-'));
try{
 for(const size of ['18x32','32x18'])execFileSync(ffmpegBin(),['-hide_banner','-loglevel','error','-f','lavfi','-i',`color=s=${size}:d=0.1`,
  '-c:v','libx264','-pix_fmt','yuv420p',join(root,size+'.mp4')]);
 const start=performance.now();
 assert.deepEqual(await verifyProductionOutput(join(root,'18x32.mp4')),{width:18,height:32});
 const wrong=join(root,'32x18.mp4'),bytes=await readFile(wrong);
 await assert.rejects(verifyProductionOutput(wrong),/exported_file.*32x18/);
 assert.deepEqual(await readFile(wrong),bytes,'rejecting an exported file cannot crop, replace or delete it');
 const stretched=join(root,'stretched.mp4');
 execFileSync(ffmpegBin(),['-hide_banner','-loglevel','error','-f','lavfi','-i','color=s=18x32:d=0.1',
  '-vf','setsar=2','-c:v','libx264','-pix_fmt','yuv420p',stretched]);
 await assert.rejects(verifyProductionOutput(stretched),/square_pixels/,'coded portrait dimensions cannot hide stretched display pixels');
 for(const [source,accepted] of [['32x18',true],['18x32',false]] as const){
  const rotated=join(root,'rotated-'+source+'.mp4');
  execFileSync(ffmpegBin(),['-hide_banner','-loglevel','error','-display_rotation:v:0','90','-i',join(root,source+'.mp4'),'-c','copy',rotated]);
  if(accepted)assert.deepEqual(await verifyProductionOutput(rotated),{width:18,height:32});
  else await assert.rejects(verifyProductionOutput(rotated),/exported_file.*32x18/);
 }
 console.log(`format guard: valid 9:16, landscape/square/wrong portrait/missing/invalid refusal; actual ffprobe, SAR and rotation positive/negative; local fixtures/probes ${(performance.now()-start).toFixed(1)}ms; zero providers`);
}finally{await rm(root,{recursive:true,force:true});}

// Use the actual per-tool save path, rather than checking only after the author run ends.
const {openHeadlessEditor}=await import('./headless-editor');
const {projectDoc,projectId,MemoryPersistence}=await import('../external-agent/offline-runtime.verify-fixtures');
const base=projectDoc(720,1280);
base.timelines.push({...structuredClone(base.timelines[0]),id:'landscape',width:1920,height:1080});
const persistence=new MemoryPersistence(base);let effects=0;
const opts={projectId,runId:'format-commit',origin:'http://127.0.0.1:5199',review:{provider:'openai' as const,model:'fixture',origin:'http://127.0.0.1:5199'},
 persistence,browserConnected:()=>false,assertCanvas:assertProductionCanvas,
 effect:async()=>{effects++;throw Error('Provider effects forbidden');}};
const editor=await openHeadlessEditor(opts);
try{
 const revision=editor.revision,original=JSON.stringify(editor.getDoc());
 for(const [tool,args] of [['set_aspect_ratio',{ratio:'16:9'}],['manage_timelines',{action:'update',ratio:'16:9'}],
  ['manage_timelines',{action:'switch',timelineId:'landscape'}]] as const){
  await assert.rejects(editor.execute(tool,args,'wrong-format'),/clipmentor_output_canvas_mismatch/);
  assert.equal(editor.revision,revision);assert.equal(JSON.stringify(editor.getDoc()),original);
  assert.deepEqual(persistence.current,base);assert.equal(persistence.commitCount,0);
 }
 await editor.execute('manage_timelines',{action:'update',name:'Valid portrait edit'},'valid');
 assert.equal(persistence.current.timelines[0].name,'Valid portrait edit');assert.equal(persistence.commitCount,1);
 assert.equal(effects,0);
}finally{await editor.close();}
const genericStore=new MemoryPersistence(projectDoc(720,1280));
const genericEditor=await openHeadlessEditor({...opts,persistence:genericStore,assertCanvas:undefined});
try{await genericEditor.execute('set_aspect_ratio',{ratio:'16:9'},'generic');
 assert.deepEqual([genericStore.current.timelines[0].width,genericStore.current.timelines[0].height],[1920,1080]);
}finally{await genericEditor.close();}
const invalidStore=new MemoryPersistence(projectDoc());
const invalidEditor=await openHeadlessEditor({...opts,persistence:invalidStore});
try{await assert.rejects(invalidEditor.execute('submit_render_job',{},'no-render'),/clipmentor_output_canvas_mismatch/);
 assert.equal(effects,0);assert.equal(invalidStore.commitCount,0);
 await invalidEditor.execute('read_timeline',{},'read-legacy');assert.equal(invalidStore.commitCount,0);
 await invalidEditor.execute('set_aspect_ratio',{ratio:'9:16',fit:'contain'},'fix-legacy');
 assertProductionCanvas(invalidStore.current);assert.equal(invalidStore.commitCount,1);
 await assert.rejects(invalidEditor.execute('set_aspect_ratio',{ratio:'16:9'},'regress'),/clipmentor_output_canvas_mismatch/);
 assertProductionCanvas(invalidStore.current);assert.equal(invalidStore.commitCount,1);
}finally{await invalidEditor.close();}
