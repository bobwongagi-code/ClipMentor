import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';
const sha=b=>createHash('sha256').update(b).digest('hex');
const wav=Buffer.alloc(32044);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);
if(process.argv[2]==='worker'){
 const [root,endpoint,mode,variant='one']=process.argv.slice(3);let paused=false;
 const stop=async phase=>{if(paused||mode!==phase)return;paused=true;process.send?.({event:'checkpoint',phase});await new Promise(()=>{});};
 if(mode==='raw'){
  const rename=fs.rename;
  fs.rename=async(source,target)=>{
   if(String(target).includes('/external-calls/')&&/\/[a-f0-9]{64}\.json$/.test(String(target))){
    const row=JSON.parse(await fs.readFile(source,'utf8'));
    if(row.status==='returned')await stop('raw');
   }
   return rename(source,target);
  };
  syncBuiltinESMExports();
 }
 if(mode==='observe-body'){const real=globalThis.fetch;globalThis.fetch=async(...args)=>{const response=await real(...args);if(response.body){const get=response.body.getReader.bind(response.body);response.body.getReader=(...args)=>{const reader=get(...args),read=reader.read.bind(reader);reader.read=async(...args)=>{const chunk=await read(...args);if(chunk.value?.byteLength)process.send?.({event:'partial_received',bytes:chunk.value.byteLength});return chunk;};return reader;};}return response;};}
 const {minimaxVoice}=await import('../plugins/voice-providers.ts');
 const {validateVoiceRequest}=await import('../plugins/voice-validation.ts');
 const {saveVoiceAudio}=await import('../plugins/voice-media.ts');
 const {resolveUploadFile}=await import('../media-dir.ts');
 const {atomicWriteFile}=await import('../plugins/project-store-durable.ts');
 const {loadOfflineStoredProject,commitOfflineStoredProject}=await import('../external-agent/offline-project-store.ts');
 const {setStoredEntry}=await import('../plugins/project-store.ts');
 const {claimOfflineProjectOwnership,releaseProjectEditOwnership}=await import('../external-agent/project-edit-ownership.ts');
 if(mode==='deadline'){
  const {externalFetch}=await import('./external-fetch.ts');const started=performance.now();let failure;
  try{await externalFetch({directory:root,kind:'voice',purpose:'deadline-wire-fixture',scope:{project:'fixture'},endpoint,
   timeoutMs:250,init:{method:'POST',body:JSON.stringify({text:'deadline'}),headers:{'Content-Type':'application/json'}},fetch});}
  catch(e){failure=e.code;}
  process.send?.({event:'deadline',failure,elapsed_ms:performance.now()-started});process.disconnect();
 }else if(mode==='inspect'){const value=await loadOfflineStoredProject('offline-project');process.send?.({event:'inspect',doc:value?.doc??null});process.disconnect();
 }else{
  const {advanceProductionTask}=await import('./production-task.ts');
  const {projectDoc,projectId}=await import('../external-agent/offline-runtime.verify-fixtures.ts');
  const {revisionOf}=await import('../../src/agent/external-edit-session.ts');
  const taskFile=join(root,`task-${variant}.json`),projectFile=join(root,'project.json');
  const input=validateVoiceRequest({provider:'minimax',text:variant==='two'?'Dua produk.':'Satu produk.',voiceId:'Malay_female_1_v1',speed:1,audioFormat:'wav',sampleRate:16000,channel:1});
  const options={minimaxBaseUrl:endpoint.replace(/\/v1\/t2a_v2$/,''),minimaxApiKey:'offline-fixture-secret',minimaxModel:'speech-2.8-hd'};
  const load=async(file,fallback)=>{try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback();throw e;}};
  const task=await load(taskFile,()=>({version:1,taskId:randomUUID(),projectId,input:{projectId,sourceAssetId:'fixture',product:{name:'fixture',category:'test'},brief:'offline recovery fixture',voice:{provider:'minimax',voiceId:input.voiceId},author:{provider:'openai',model:'fixture',origin:'http://127.0.0.1:5199',apiMode:'responses'},reviewer:{provider:'openai',model:'fixture',origin:'http://127.0.0.1:5199',apiMode:'responses'},budget:{model:0,review:0,observation:0,tts:1,render:0,maxElapsedMs:60_000,maxRepairs:0}},stage:'audio',status:'queued',createdAt:Date.now(),updatedAt:Date.now(),sequence:0,completed:{analysis:{fixture:true},blueprint:{fixture:true},copy_review:{fixture:true}},effects:{},attempts:{model:0,review:0,observation:0,tts:0,render:0},repairs:0,feedbackUsed:false}));
  const store={save:async t=>{await atomicWriteFile(taskFile,JSON.stringify(t));},load:async()=>JSON.parse(await fs.readFile(taskFile,'utf8'))};
  const obtain=async(operationId,readOnly=false)=>{
   const result=await minimaxVoice(options,input,{scope:projectId,operationId,readOnly});
   const saved=await saveVoiceAudio(result.audio,'wav',16000);
   const file=resolveUploadFile(saved.path.slice('/media/uploads/'.length));
   assert(file);assert.equal(sha(await fs.readFile(file)),saved.sha256);await stop('artifact');
   let snapshot=await loadOfflineStoredProject(projectId);
   if(!snapshot){await setStoredEntry(`project:${projectId}`,projectDoc(1080,1920));await setStoredEntry('projects',[{id:projectId,name:'offline fixture',updatedAt:Date.now()}]);snapshot=await loadOfflineStoredProject(projectId);}
   assert(snapshot);const doc=snapshot.doc,id=`audio-${sha(JSON.stringify([saved.sha256,input.text,input.voiceId]))}`;
   if(!doc.assets.some(a=>a.id===id)){
    const claim=await claimOfflineProjectOwnership(projectId,randomUUID());assert.equal(claim.status,'claimed');
    const next=structuredClone(doc);next.assets.push({id,kind:'audio',name:'fixture',src:saved.path,sourceContentHash:saved.sha256,durationInFrames:Math.ceil(saved.durationSeconds*30),props:{generation:{provider:'minimax',voiceId:input.voiceId,text:input.text,speed:1,durationSeconds:saved.durationSeconds}}});
    const committed=await commitOfflineStoredProject({projectId,expectedRevision:revisionOf(doc),doc:next,ownership:claim.claim,canCommit:()=>true});assert.equal(committed.status,'applied');
    await releaseProjectEditOwnership(committed.ownership??claim.claim);
    const stored=await loadOfflineStoredProject(projectId);assert(stored);await atomicWriteFile(projectFile,JSON.stringify(stored.doc));await fs.appendFile(join(root,'commits.ndjson'),JSON.stringify({id,revision:stored.revision})+'\n');
   }else{const old=doc.assets.find(a=>a.id===id);assert.equal(old.src,saved.path);assert.equal(old.sourceContentHash,saved.sha256);assert.equal(old.props.generation.text,input.text);}
   await stop('project');return {assetId:id,src:saved.path,sha256:saved.sha256,durationSeconds:saved.durationSeconds};
  };
  const settled=await advanceProductionTask(task,async(t,c)=>t.stage==='audio'?{artifact:await c.effect('tts','fixture-voice',id=>obtain(id),id=>obtain(id,true))}:{artifact:{fixture_only:true}},store);
  process.send?.({event:'settled',status:settled.status,tts:settled.attempts.tts,audio_completed:!!settled.completed.audio,error:settled.error});process.disconnect();
 }
}else{
 const root=await fs.mkdtemp(join(tmpdir(),'cc-wire-recovery-')),children=[],received=[],serverErrors=[];let tests=0;
 const server=createServer(async(req,res)=>{
  try{
   const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks),caseId=req.url.split('/')[1],text=JSON.parse(body).text;
   assert.equal(req.method,'POST');
   if(caseId!=='deadline')assert.deepEqual(JSON.parse(body),{model:'speech-2.8-hd',text,stream:false,output_format:'hex',voice_setting:{voice_id:'Malay_female_1_v1',speed:1,vol:1,pitch:0},audio_setting:{sample_rate:16000,format:'wav',channel:1}},'independent receiver sees the frozen provider/model/voice/format, not merely a claimed input hash');
   const record={caseId,text,body_sha256:sha(body),bytes:body.length};received.push(record);await fs.appendFile(join(root,'receiver.ndjson'),JSON.stringify(record)+'\n');
   if(caseId==='unknown'||caseId==='deadline'){res.writeHead(200,{'Content-Type':'application/json'});res.write('{"data":');return;}
   if(caseId==='unsupported'){res.writeHead(404);res.end('unsupported model');return;}
   if(caseId==='malformed'){res.writeHead(200,{'Content-Type':'application/json'});res.end('{not-json');return;}
   res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(caseId==='empty'?{data:{audio:''},base_resp:{status_code:0}}:{data:{audio:wav.toString('hex')},base_resp:{status_code:0}}));
  }catch(e){serverErrors.push(e.message);res.destroy(e);}
 });server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert(address&&typeof address==='object');
 const count=id=>received.filter(r=>r.caseId===id).length;
 const wait=async predicate=>{const deadline=Date.now()+15_000;while(!predicate()){if(Date.now()>deadline)throw Error('test checkpoint deadline exceeded');await sleep(5);}};
 const start=async(id,mode='none',variant='one')=>{
  const dir=join(root,id);await fs.mkdir(dir,{recursive:true});
  const env={...process.env,OPENCHATCUT_DATA_DIR:join(dir,'runtime'),PROXY_URL:'',HTTP_PROXY:'',HTTPS_PROXY:'',ALL_PROXY:'',http_proxy:'',https_proxy:'',all_proxy:''};
  const child=fork(new URL(import.meta.url),['worker',dir,`http://127.0.0.1:${address.port}/${id}/v1/t2a_v2`,mode,variant],{execArgv:['--import','tsx'],env,stdio:['ignore','pipe','pipe','ipc']});
  const messages=[],errors=[];child.on('message',m=>messages.push(m));child.stderr.on('data',c=>errors.push(String(c)));child.stdout.on('data',()=>{});
  let exited=false;const exit=new Promise(resolve=>child.once('exit',(code,signal)=>{exited=true;resolve({code,signal});}));children.push(child);
  return {child,messages,errors,exit,get exited(){return exited;}};
 };
 const finish=async worker=>{await wait(()=>worker.exited);const exit=await worker.exit;assert.equal(exit.code,0,worker.errors.join(''));const result=worker.messages.find(m=>m.event==='settled'||m.event==='deadline'||m.event==='inspect');assert(result,worker.errors.join(''));return result;};
 const kill=async worker=>{worker.child.kill('SIGKILL');const e=await worker.exit;assert.equal(e.signal,'SIGKILL');};
 const snapshot=async(id,variant='one')=>{const dir=join(root,id),task=JSON.parse(await fs.readFile(join(dir,`task-${variant}.json`),'utf8'));const project=await fs.readFile(join(dir,'project.json'),'utf8').then(JSON.parse).catch(()=>({assets:[]}));const commits=await fs.readFile(join(dir,'commits.ndjson'),'utf8').then(v=>v.trim().split('\n').filter(Boolean)).catch(()=>[]);return {task,project,commits};};
 const usable=async(id,expectedAssets=1)=>{const s=await snapshot(id);const actual=await finish(await start(id,'inspect'));assert.deepEqual(actual.doc,s.project,'fresh process reads the production project store, not just a test mirror');assert.equal(s.task.attempts.tts,1);assert.equal(s.task.completed.audio!==undefined,true);assert.equal(s.project.assets.length,expectedAssets);const {resolveRuntimeProfile}=await import('../runtime-profile.ts');const profile=resolveRuntimeProfile({OPENCHATCUT_DATA_DIR:join(root,id,'runtime')});for(const asset of s.project.assets){const file=join(profile.mediaDir,asset.src.split('/').at(-1));assert.equal(sha(await fs.readFile(file)),sha(wav));assert.equal(asset.durationInFrames,30);}return s;};
 try{
  for(const phase of ['raw','artifact','project']){
   const id=`crash-${phase}`,worker=await start(id,phase);await wait(()=>worker.messages.some(m=>m.event==='checkpoint')||worker.exited);assert(worker.messages.some(m=>m.phase===phase),worker.errors.join(''));
   assert.equal(count(id),1);const before=await snapshot(id);assert.equal(before.task.attempts.tts,1);assert.equal(before.project.assets.length,phase==='project'?1:0);await kill(worker);
   const result=await finish(await start(id));assert.equal(result.audio_completed,true);assert.equal(count(id),1,'receiver saw duplicate submission across SIGKILL');const s=await usable(id);assert.equal(s.commits.length,1,'asset commit was duplicated on recovery');tests++;console.log(`PASS SIGKILL ${phase}: fresh process, receiver=1, measured file+project=1, original budget=1`);
  }
  const unknown=await start('unknown','observe-body');await wait(()=>unknown.messages.some(m=>m.event==='partial_received'&&m.bytes>0));assert.equal(count('unknown'),1);await kill(unknown);const stopped=await finish(await start('unknown'));
  assert.equal(stopped.audio_completed,false);assert.equal(stopped.tts,1);assert.equal(count('unknown'),1);assert.equal((await snapshot('unknown')).project.assets.length,0);tests++;console.log('PASS partial body + SIGKILL: unknown stays blocked, original reservation retained, receiver=1');
  for(const id of ['unsupported','malformed','empty']){
   const first=await finish(await start(id));assert.equal(first.audio_completed,false);assert.equal(first.tts,1);
   const again=await finish(await start(id));assert.equal(again.audio_completed,false);assert.equal(count(id),1);assert.equal((await snapshot(id)).project.assets.length,0);tests++;console.log(`PASS ${id}: no false artifact, receiver=1 on recovery`);
  }
  const normal=await finish(await start('normal'));assert.equal(normal.audio_completed,true);await usable('normal');const frozen=sha(await fs.readFile(join(root,'normal','task-one.json')));
  assert.equal((await finish(await start('normal'))).audio_completed,true);assert.equal(count('normal'),1);
  const fresh=await finish(await start('normal','none','two'));assert.equal(fresh.audio_completed,true);assert.equal(count('normal'),2);assert.equal(new Set(received.filter(r=>r.caseId==='normal').map(r=>r.body_sha256)).size,2);assert.equal(sha(await fs.readFile(join(root,'normal','task-one.json'))),frozen);await usable('normal',2);tests++;console.log('PASS positive controls: complete result usable, existing task reused, changed legitimate text submitted and bound');
  const deadline=await finish(await start('deadline','deadline'));assert.equal(deadline.failure,'external_deadline');assert(deadline.elapsed_ms<1500,`deadline wait ${deadline.elapsed_ms}`);assert.equal(count('deadline'),1);tests++;console.log(`PASS wire body deadline: observed ${Math.round(deadline.elapsed_ms)}ms for 250ms policy, no complete result`);
  assert.equal((await fs.readFile(join(root,'receiver.ndjson'),'utf8')).trim().split('\n').length,received.length);
  console.log(JSON.stringify({groups:tests,observer:'independent local HTTP receiver, survives client SIGKILL',actual_receiver_requests:received.length,expected_receiver_requests:10,confirmed_unnecessary_duplicate_submissions:0,production_model_asr_tts_calls:0,receiver_evidence:received.map(({caseId,body_sha256,bytes})=>({caseId,body_sha256,bytes})),limits:['Author/reviewer replaced by fixture stages; not full film quality acceptance','Project commit uses the real store; ownership is released before the project checkpoint; lease-crash recovery is not covered','SIGKILL is process crash, not physical disk power-loss proof','250ms timeout assertion allows scheduler/IO reporting tolerance, not exact real-time guarantee']}));assert.equal(received.length,10);assert.deepEqual(serverErrors,[]);
 }finally{for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});}
}
