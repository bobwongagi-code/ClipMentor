import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import fixture from '../../src/clipmentor/fixtures/copy-review-r171-contract.json';
import {observeSourceVideo,readSourceVideoReceipt,sourceVideoInput} from './source-video';
import {reviewClipMentorCopy} from './copy-review';
import {apiCopyReviewDependencies} from './copy-review-api';
import {transcribeClipMentorSource} from '../plugins/clipmentor-funasr';
import {previewBridge,clipMentorPreviewReviewPlugin} from '../plugins/clipmentor-preview-review';
import {clipMentorSourceVideoPlugin} from '../plugins/clipmentor-source-video';
import {clipMentorCopyReviewPlugin} from '../plugins/clipmentor-copy-review';
import {clipMentorFunAsrPlugin} from '../plugins/clipmentor-funasr';
import {openHeadlessEditor} from './headless-editor';
import {MemoryPersistence,projectDoc} from '../external-agent/offline-runtime.verify-fixtures';
import {createMiniConnect} from '../../desktop/mini-connect';
import {videoInput} from './video-input';
import {reviewClipMentorPreview,previewReviewIdentity,PREVIEW_REVIEW_ENDPOINT} from './preview-review';

const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const video=Buffer.from('config-composition-synthetic-master');
const id='32924d8e-edf1-4ec3-a0f1-393b9a147f85';
const endpoint='https://fixture.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
function request(kind:string){const r=structuredClone(fixture.request) as any;r.operationId=id;r.projectId='offline-project';if(kind==='source')r.source.hash=hash(video);for(const u of r.packet.units)u.source_context={scope:'frozen_task_scope',source_ranges:[[0,r.source.duration]],evidence_ids:r.packet.source_evidence.filter((e:any)=>e.time_seconds?.length).map((e:any)=>e.evidence_id),speech:'unavailable'};return r;}
const asrRequest={src:'/media/uploads/master.mp4',expectedSourceHash:hash(video),language:'auto',operationId:id,maxRequests:1,projectId:'offline-project'};
function sourceResponse(r:any){const i=sourceVideoInput(r);return {status:200,body:{modelVersion:'offline',candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({windows:i.units.flatMap(u=>u.windows.map(w=>({window_id:w.window_id,observed_sequence:'fixture action',endpoint:'unknown fixture',evidence:[{start_seconds:w.source_range_seconds[0],end_seconds:w.source_range_seconds[1],visible:'fixture visible',audible:'fixture unclear'}]}))),lines:i.units.flatMap(u=>u.lines.map(l=>({unit_id:u.unit_id,line_id:l.line_id,status:'insufficient_evidence',reason:'fixture limitation',window_ids:[u.windows[0].window_id]}))),limitations:['offline fixture only']})}]}}]}};}
function deps(kind:string,directory:string,config='same',call=()=>{}){
 const r=request(kind);let hashes=0;
 const common={directory,resolve:()=>'/synthetic-master',hash:async()=>{hashes++;if(process.argv[2]==='worker'&&process.argv[4]==='raw'&&hashes===(kind==='source'?2:3))process.exit(73);return r.source.hash;}};
 const api=apiCopyReviewDependencies({provider:config==='provider'?'anthropic':'openai',model:config==='model'?'fixture-new':'fixture-old',origin:config==='origin'?'http://127.0.0.1:2':'http://127.0.0.1:1',apiMode:config==='mode'?'chat':'responses'},(async()=>{call();return{text:JSON.stringify(fixture.raw_review)};}) as never);
 if(kind==='copy')return {...api,...common,frame:async()=>{if(process.argv[2]==='worker'&&process.argv[4]==='prepare')process.exit(73);return Buffer.from('fixture-jpeg').toString('base64');},run:async(...args:any[])=>{if(process.argv[2]==='worker'&&process.argv[4]==='unknown')process.exit(73);return (api.run as any)(...args);}};
 if(kind==='asr')return {...common,hash:async()=>hash(video),key:()=>config==='account'?'account-new':'account-old',endpoint:()=>config==='endpoint'?endpoint.replace('fixture.','changed.'):endpoint,probe:async()=>({duration:config==='metadata'?11:10,fps:30,bytes:video.length}),encode:async()=>{if(process.argv[2]==='worker'&&process.argv[4]==='prepare')process.exit(73);return new Uint8Array([1,2,3]);},fetch:async()=>{call();if(process.argv[2]==='worker'&&process.argv[4]==='unknown')process.exit(73);return Response.json({output:{sentence:{words:[{text:'fixture',begin_time:100,end_time:200}]}}});}};
 return {...common,key:config==='account'?'account-new':'account-old',size:async()=>video.length,audioPresent:async()=>true,read:async()=>{if(process.argv[2]==='worker'&&process.argv[4]==='prepare')process.exit(73);return video;},post:async()=>{call();if(process.argv[2]==='worker'&&process.argv[4]==='unknown')process.exit(73);return sourceResponse(r);},...(config==='media-config'?{prepareMedia:async()=>videoInput(video)}:{})};
}
if(process.argv[2]==='worker'){
 const kind=process.argv[3],d=deps(kind,process.argv[5],process.argv[6]??'same');
 if(kind==='source')await observeSourceVideo(request(kind),d as any);
 if(kind==='copy')await reviewClipMentorCopy(request(kind),d as any);
 if(kind==='asr')await transcribeClipMentorSource(asrRequest,d as any);
 process.exit(74);
}
const root=await mkdtemp(join(tmpdir(),'cm-preparation-config-'));console.log('EVIDENCE_ROOT',root);
const rows:any[]=[];
const regressions:string[]=[];
function expectGoverned(label:string,check:()=>void){try{check();}catch(error){regressions.push(label+': '+String(error));}}
async function snap(directory:string,prefix=''):Promise<Record<string,{bytes:number,sha256:string}>>{const out:any={};for(const e of await readdir(directory,{withFileTypes:true}).catch(()=>[])){if(e.name.includes('.owner')||e.name.endsWith('.events'))continue;const p=join(directory,e.name);if(e.isDirectory())Object.assign(out,await snap(p,prefix+e.name+'/'));else {const b=await readFile(p);out[prefix+e.name]={bytes:b.length,sha256:hash(b)};}}return out;}
function seed(kind:string,state:string,directory:string){const c=spawnSync(process.execPath,['--import','tsx',fileURLToPath(import.meta.url),'worker',kind,state,directory],{encoding:'utf8',timeout:20000});assert.equal(c.status,73,c.stderr);}
async function route(kind:string,d:any,work:(origin:string)=>Promise<any>){const plugin=kind==='source'?clipMentorSourceVideoPlugin(d):kind==='copy'?clipMentorCopyReviewPlugin(d):kind==='asr'?clipMentorFunAsrPlugin(d):clipMentorPreviewReviewPlugin(d);const app=createMiniConnect(e=>{throw e;});(plugin.configureServer as any)({middlewares:{use:(path:string,handler:any)=>app.use(path,handler)}});const server=createServer((req,res)=>app.handle(req,res));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${(server.address() as any).port}`;try{return await work(origin);}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}}
const paths:any={source:'/api/clipmentor/observe-video',copy:'/api/clipmentor/review-copy',asr:'/api/clipmentor/transcribe-source',preview:'/api/clipmentor/review-preview'};
async function send(kind:string,d:any,body:any,host=false){return route(kind,d,async origin=>{const actions:any[]=[];const transport:typeof fetch=async(url,init)=>{actions.push(JSON.parse(String(init?.body)).action??'request');return fetch(url,{...init,headers:{...Object.fromEntries(new Headers(init?.headers)),origin,'sec-fetch-site':'same-origin'}});};if(!host){const res=await transport(new URL(paths[kind],origin),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return{http:res.status,body:await res.json(),actions};}const editor=await openHeadlessEditor({projectId:body.projectId,runId:'config-probe',origin,review:{provider:'openai',model:'fixture',origin,apiMode:'responses'},persistence:new MemoryPersistence(projectDoc()),browserConnected:()=>false,fetch:transport,effect:async(_kind,_key,_work,recover)=>recover!(_key)});try{const res=await editor.context.hostFetch!(paths[kind],{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return{http:res.status,body:await res.json(),actions};}catch(e){return{error:String(e),actions};}finally{await editor.close();}});}
function record(row:any){rows.push(row);console.log(JSON.stringify(row));}

// Actual HTTP source/copy/ASR entrypoints, with headless recovery for source/ASR.
for(const kind of ['source','copy','asr']){
 const variants=kind==='copy'?['same','model','provider','mode','origin']:kind==='source'?['same','account','media-config']:['same','account','endpoint','metadata'];
 for(const config of variants)for(const host of (kind==='copy'?[false]:[false,true])){
  const directory=join(root,`${kind}-${config}-${host?'host':'http'}`);seed(kind,'prepare',directory);const before=await snap(directory);let calls=0;const d=deps(kind,directory,config,()=>calls++);const body=kind==='asr'?asrRequest:request(kind);const reply=await send(kind,d,host?body:kind==='copy'?body:{...body,action:'resume_preparation'},host);const after=await snap(directory);const unchanged=JSON.stringify(before)===JSON.stringify(after);
  if(kind==='copy'&&config==='origin')expectGoverned('copy origin must refuse old preparation',()=>{assert.equal(calls,0);assert(unchanged);assert.equal((reply as any).http,409);});else if(config==='same')assert.equal(calls,1,JSON.stringify(reply));else if(kind==='source'&&config==='media-config')assert.equal(calls,1);else{assert.equal(calls,0);assert(unchanged);}
  record({kind,state:'prepare',config,host,calls,journal_unchanged:unchanged,before,after,reply});
 }
 // Unknown consumed attempt: new current account/config must not reach provider.
 {const directory=join(root,kind+'-unknown');seed(kind,'unknown',directory);const before=await snap(directory);let calls=0;const reply=await send(kind,deps(kind,directory,'account',()=>calls++),kind==='copy'?request(kind):{...(kind==='asr'?asrRequest:request(kind)),action:'resume_preparation'},kind!=='copy');const after=await snap(directory);assert.equal(calls,0);assert.deepEqual(after,before);record({kind,state:'unknown',config:'account',calls,journal_unchanged:true,before,after,reply});}
 // Old archived response is a normal read: do not label it a config-rebind dispatch.
 if(kind!=='asr'){const directory=join(root,kind+'-old-raw');seed(kind,'raw',directory);const before=await snap(directory);let calls=0;const d=deps(kind,directory,kind==='copy'?'origin':'account',()=>calls++);const result=kind==='source'?await readSourceVideoReceipt(id,'offline-project',d as any):await reviewClipMentorCopy(request(kind),d as any,undefined,true);assert.equal(calls,0);const after=await snap(directory);assert.deepEqual(after[id+'.json'],before[id+'.json']);record({kind,state:'old-raw',config:kind==='copy'?'origin':'account',calls,parent_unchanged:true,before,after,result});}
}

// Preview pre-launch reservation has no account/config identity. Existing child
// preparations are separately account-bound by the actual CLI (source trace).
const input={duration_seconds:10,points:[{point_id:'P',teaching_goal_zh:'fixture',product_relevance:'fixture'}],units:[{unit_id:'U',point_ids:['P']}],reference_text:[]};
const file=join(root,'preview.mp4');await writeFile(file,video);
for(const host of [false,true])for(const config of ['same','account']){
 const directory=join(root,`preview-${config}-${host}`),operationId=randomUUID();const body={action:'request',operationId,projectId:'offline-project',maxRequests:1,src:'/media/uploads/preview.mp4',videoSha256:hash(video),input};let calls=0;let account='account-old';const accounts:string[]=[];const d={directory,preparationIdentity:()=>hash('preview-account-v1:'+account),resolve:()=>file,run:async(args:string[])=>{const output=args[args.indexOf('--out')+1];const ledger=join(output,'..',operationId+'.operation.json');const result=await reviewClipMentorPreview(videoInput(video),input,{key:account,post:async()=>{calls++;accounts.push(account);await writeFile(ledger,JSON.stringify({status:'reserved',requests_attempted:1}));return{status:200,body:{candidates:[{finishReason:'STOP',content:{parts:[{text:'{"coverage":[],"continuity":[]}'}]}}]}};}});await writeFile(output,JSON.stringify(result));}};
 await assert.rejects(previewBridge(body,d,AbortSignal.abort(Error('before launch'))));const before=await snap(directory);assert.equal(calls,0);if(config==='account'){account='account-new';}const reply=await send('preview',d,host?body:{...body,action:'resume_preparation'},host);const after=await snap(directory);if(config==='account')expectGoverned('preview account must refuse old prelaunch/'+host,()=>{assert.equal(calls,0);assert.deepEqual(after,before);assert((reply as any).error||(reply as any).http>=400);});else assert.equal(calls,1);record({kind:'preview',state:'prelaunch',config,host,calls,accounts,before,after,reply,config_note:'current launch environment is selected only by run(); binding has no prior account/transport'});
}
// Actual preview CLI account fingerprint negative: exits before media/network.
{const directory=join(root,'preview-cli-account');await mkdir(directory);const output=join(directory,'result.json'),inputFile=join(directory,'input.json');await writeFile(inputFile,JSON.stringify(input));const prepared=previewReviewIdentity(hash(video),video.length,input);const ledger=join(directory,id+'.operation.json');await writeFile(ledger,JSON.stringify({identity_version:'video-logical-v1',fingerprint:hash(PREVIEW_REVIEW_ENDPOINT+prepared.version+prepared.logical_request_sha256),account:hash('account-old'),preparation_protocol:1,status:'preparing',requests_attempted:0}));const before=await snap(directory);const child=spawnSync(process.execPath,['--import','tsx','server/clipmentor/preview-review-cli.mts','--video',file,'--input',inputFile,'--out',output,'--operation',id,'--expected-video-sha256',hash(video)],{encoding:'utf8',env:{...process.env,OPENCHATCUT_DATA_DIR:join(directory,'profile'),ROOTIFY_GATEWAY_API_KEY:'account-new',CLIPMENTOR_VIDEO_TRANSPORT:'inline'},timeout:20000});assert.equal(child.status,1);assert.match(child.stderr,/no automatic replay/);const after=await snap(directory);assert.deepEqual(after[id+'.operation.json'],before[id+'.operation.json']);record({kind:'preview-cli',state:'child-prepare',config:'account',calls:0,parent_unchanged:true,before,after,exit:child.status,refusal:'Prior attempt pending or failed; no automatic replay'});}
await writeFile(join(root,'results.json'),JSON.stringify(rows,null,2));
console.log('CONFIG_REGRESSIONS',JSON.stringify(regressions));
assert.deepEqual(regressions,[],'configuration changes must not authorize recovery dispatch');
console.log('PASS config composition focused regression',rows.length,'cases; real external services/render/install: 0');
