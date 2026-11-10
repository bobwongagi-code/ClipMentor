import assert from 'node:assert/strict';
import sharp from 'sharp';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
import {makeDraft} from '../../src/editor/store';
import {projectDoc,projectId,MemoryPersistence} from '../external-agent/offline-runtime.verify-fixtures';
import {openHeadlessEditor} from './headless-editor';
import {acceptExportSubmission} from '../plugins/export-submission';
// @ts-expect-error existing JS renderer
import {renderTimeline,renderTimelineStills,setUploadsDirProvider} from '../../remotion/render.mjs';
const root=await mkdtemp(join(tmpdir(),'clipmentor-headless-'));
class FilePersistence extends MemoryPersistence {
 override async commitProject(input:Parameters<MemoryPersistence['commitProject']>[0]){const r=await super.commitProject(input);if(r.status==='applied')await writeFile(join(root,'saved.json'),JSON.stringify(this.current));return r;}
}
try{
 const d=makeDraft(projectDoc(320,180));d.commands.addTextClip({text:'BEFORE',fontSize:32,color:'#ff00ff',startFrame:0,durationInFrames:15,track:'track-v1'});
 const persistence=new FilePersistence(d.getDoc());let failExport=false,rendered=false;
 const transport:typeof fetch=async(_url,init)=>{
  if(failExport)return Response.json({error:'Injected export failure'},{status:500});
  const body=JSON.parse(String(init?.body)),accepted=await acceptExportSubmission(body);
  try{setUploadsDirProvider(()=>root);await renderTimeline({state:accepted.plan.state,project:accepted.plan.project,timelineId:accepted.plan.timelineId,
   outputLocation:join(root,'headless.mp4'),codec:'h264',videoBitrate:1000000});rendered=true;return Response.json({renderId:'fixture-render',projectRevision:accepted.plan.projectRevision,timelineId:accepted.plan.timelineId});}
  finally{await accepted.cleanup();}
 };
 const effect=async<T>(_kind:unknown,_key:string,work:(id:string)=>Promise<T>)=>work('fixture-operation');
 const opts={projectId,runId:'fixture',origin:'http://127.0.0.1:5199',review:{provider:'openai' as const,model:'fixture',origin:'http://127.0.0.1:5199',apiMode:'responses' as const},
  persistence,browserConnected:()=>false,fetch:transport,effect};
 await assert.rejects(openHeadlessEditor({...opts,browserConnected:()=>true}),/busy_browser/);
 const editor=await openHeadlessEditor(opts),item=editor.getDoc().timelines[0].items[0];
 const page=await editor.loadSkillTool({name:'clipmentor',file:'SKILL.md',offset:0,limit:40});assert.equal((page as {nextOffset:number}).nextOffset,40);
 await assert.rejects(editor.loadSkillTool({name:'clipmentor',file:'../SKILL.md'}));
 const beforeSkillReads=JSON.stringify(editor.getDoc());
 await assert.rejects(editor.loadSkillTool({name:'clipmentor',file:'references/not-installed.md'}),/ENOENT/);
 // Production reads filesystem skills rather than Vite's bundle. Exercise
 // actual routed pages too, without invoking an author or modifying a project.
 for(const name of ['clipmentor','storyboard-shot-breakdown','transcription','verification','skill-creator','export','voice','known-errors']){
  const files=new Set(['SKILL.md']);
  for(const file of files){
   const expected=await readFile(new URL(`../../src/agent/skills/${name}/${file}`,import.meta.url),'utf8');
   let text='',offset:number|null=0;
   while(offset!==null){
    const chunk=await editor.loadSkillTool({name,file,offset,limit:997}) as {contents:Record<string,string>;nextOffset:number|null};
    text+=chunk.contents[file];assert(chunk.nextOffset===null||chunk.nextOffset>offset);offset=chunk.nextOffset;
   }
   assert.equal(text,expected,`production loader must retain all ${name}/${file} content`);
   for(const match of text.matchAll(/\]\((references\/[a-zA-Z0-9_-]+\.md)(?:#[^)]*)?\)/g))files.add(match[1]);
  }
 }
 assert.equal(JSON.stringify(editor.getDoc()),beforeSkillReads,'failed and successful skill reads never change the draft');
 const result=await editor.execute('update_item_props',{itemId:item.id,props:{text:'AFTER'}},'edit') as {ok:boolean};assert(result.ok);
 const saved=JSON.parse(await readFile(join(root,'saved.json'),'utf8'));assert.equal(saved.timelines[0].items[0].props.text,'AFTER');
 const beforeAtomic=JSON.stringify(editor.getDoc());
 const rejected=await editor.execute('edit_item',{adds:[{type:'text',text:'Must rollback'}],deletes:[{type:'effect',itemId:item.id}]},'atomic') as {error?:string};assert(rejected.error);
 assert.equal(JSON.stringify(editor.getDoc()),beforeAtomic,'unsupported effect deletion must neither remove the clip nor publish preceding adds');
 await assert.rejects(editor.execute('edit_captions',{action:'preset_list'},'unsupported'),/unsupported browser/);
 const bytes=await readFile(join(root,'saved.json'),'utf8');failExport=true;
 await assert.rejects(editor.execute('submit_render_job',{},'bad-export'),/Injected export/);
 assert.equal(await readFile(join(root,'saved.json'),'utf8'),bytes,'failed export cannot discard committed editing');
 failExport=false;await editor.execute('submit_render_job',{},'export');assert(rendered);
 const info=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','stream=width,height,nb_frames','-of','json',join(root,'headless.mp4')],{encoding:'utf8'}));
 assert.equal(info.streams[0].width,320);assert.equal(info.streams[0].nb_frames,'30','existing renderer keeps a one-second minimum; the full 15-frame clip remains');
 const pictures=await renderTimelineStills({state:saved.timelines[0],project:saved,timelineId:saved.activeTimelineId,frames:[5]});
 const oldPictures=await renderTimelineStills({state:d.getDoc().timelines[0],project:d.getDoc(),timelineId:d.getDoc().activeTimelineId,frames:[5]});
 assert.notEqual(pictures[0].base64,oldPictures[0].base64,'persisted AFTER text must actually change rendered pixels from BEFORE');
 assert(pictures[0].base64.length>1000,'saved composition produces visible rendered pixels');
 // A saved style value is not proof: exercise the actual native renderer's pixels.
 const styleDoc=structuredClone(saved),native=styleDoc.timelines[0].items[0];
 native.width=320;native.height=180;native.transform={};native.props={text:'TEXT',fontSize:40,paddingX:24,color:'#000000',backgroundColor:'#123456',backgroundOpacity:1,textShadow:'none'};
 const styled=await renderTimelineStills({state:styleDoc.timelines[0],project:styleDoc,timelineId:styleDoc.activeTimelineId,frames:[5]});
 const {data,info:rawInfo}=await sharp(Buffer.from(styled[0].base64,'base64')).removeAlpha().raw().toBuffer({resolveWithObject:true});
 const pixel=(x:number,y:number)=>[...data.subarray((y*rawInfo.width+x)*rawInfo.channels,(y*rawInfo.width+x)*rawInfo.channels+3)];
 assert(pixel(Math.round(30/320*rawInfo.width),Math.round(90/180*rawInfo.height)).every((v,n)=>Math.abs(v-[18,52,86][n])<12),'declared text backplate must be present in exported pixels');
 native.props={...native.props,backgroundColor:'#FFFFFF',textShadow:'0 10px 0 #ff0000'};
 const shadowed=await renderTimelineStills({state:styleDoc.timelines[0],project:styleDoc,timelineId:styleDoc.activeTimelineId,frames:[5]});
 native.props={...native.props,textShadow:'none'};
 const plain=await renderTimelineStills({state:styleDoc.timelines[0],project:styleDoc,timelineId:styleDoc.activeTimelineId,frames:[5]});
 assert.notEqual(shadowed[0].base64,plain[0].base64,'shadow:none must change the real rendered result, not just metadata');

 await editor.close();
 const restarted=await openHeadlessEditor({...opts,persistence:new FilePersistence(saved)});
 assert.equal(restarted.getDoc().timelines[0].items[0].props.text,'AFTER');await restarted.close();
 // Existing ClipMentor gates are still checked before an unapproved edit.
 const guarded=projectDoc();guarded.clipMentorAnalysis={revision:1,source:{asset_id:'missing',sourceContentHash:''}} as never;
 const gp=new FilePersistence(guarded),ge=await openHeadlessEditor({...opts,persistence:gp});
 const refused=await ge.execute('clear_timeline',{},'forbidden') as {production_gate:{allowed:boolean}};
 assert.equal(refused.production_gate.allowed,false);assert.equal(gp.commitCount,0);await ge.close();
 console.log('headless-editor: no browser, file-backed save/cold-read, real MP4/still render, export failure preserves commit, ownership and production gate passed; zero model calls');
}finally{await rm(root,{recursive:true,force:true});}
