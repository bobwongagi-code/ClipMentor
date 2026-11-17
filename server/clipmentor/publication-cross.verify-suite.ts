// Production-entry publication cross probe. Run: node --import tsx server/clipmentor/publication-cross.verify-suite.ts
// No real provider/render/network. Expected findings are reported as CONFIRMED; assertions verify causal evidence.
// Bundles the current production entry points in memory with controlled dependency boundaries; the probe never writes product files.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const baseline=process.env.CM_PUBLICATION_BASELINE;
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const sha=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
const source=Buffer.from('synthetic-source:publication-cross'),sourceHash=sha(source);
const files=new Map<string,Buffer>([['/fake/uploads/source.mp4',source],['/fake/logo.png',Buffer.from('logo')]]);
const events:string[]=[];
const gates:Array<{html:string;signal:AbortSignal;resolve:(r:any)=>void;reject:(e:Error)=>void}>=[];
let frames=0,receiptReads=0,work=0;
const receiptId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',otherReceiptId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function persistReceipt(id:string,visible='Valid action'){
 const original=JSON.stringify({projectId:'synthetic'}),directory='/fake/profile/clipmentor-source-video/';
 files.set(directory+id+'.json',Buffer.from(original));
 files.set(directory+id+'.revalidated.json',Buffer.from(JSON.stringify({operationId:id,projectId:'synthetic',source_hash:sourceHash,revalidation:{original_record_sha256:sha(original),requestsSent:0},result:{validation:{status:'valid'},actual_handoff_verified:false,complete_film_accepted:false,raw_observation:{windows:[{evidence:[{start_seconds:0,end_seconds:4,visible,audible:'Valid claim'}]}]}}})));
}
persistReceipt(receiptId);persistReceipt(otherReceiptId);
const io={
 async readFile(p:string,encoding?:string){const v=files.get(p);if(!v)throw Object.assign(Error('ENOENT:'+p),{code:'ENOENT'});return encoding?v.toString():Buffer.from(v);},
 async writeFile(p:string,v:any,options?:any){if(options?.flag==='wx'&&files.has(p))throw Error('EEXIST');files.set(p,Buffer.from(v));events.push('write:'+p);},
 async mkdir(){},async mkdtemp(prefix:string){return prefix+(++work);},
 async rename(from:string,to:string){const value=files.get(from);assert(value);files.set(to,value);files.delete(from);},
 async rm(p:string,options?:any){files.delete(p);if(options?.recursive)for(const k of files.keys())if(k.startsWith(p+'/'))files.delete(k);},
};
const h={io,sha,files,sourceHash,
 async extract(_file:string,_seek:number,target:string,_a:any,_b:any,signal:AbortSignal){signal.throwIfAborted();frames++;await io.writeFile(target,'FRAME:'+sourceHash);},
 async receipt(operationId:string,projectId:string,deps:{directory:string}){
  receiptReads++;assert.match(operationId,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);assert.equal(projectId,'synthetic');assert.equal(deps.directory,'/fake/profile/clipmentor-source-video');
  const original=await io.readFile(deps.directory+'/'+operationId+'.json','utf8'),saved=JSON.parse(await io.readFile(deps.directory+'/'+operationId+'.revalidated.json','utf8') as string);
  assert.equal(saved.operationId,operationId);assert.equal(saved.projectId,projectId);assert.equal(saved.revalidation.original_record_sha256,sha(original));assert.equal(saved.revalidation.requestsSent,0);assert.equal(saved.result.actual_handoff_verified,false);assert.equal(saved.result.complete_film_accepted,false);return saved;
 },
 render(html:string,signal:AbortSignal){events.push('render:'+gates.length);return new Promise((resolve,reject)=>gates.push({html,signal,resolve,reject}));},
};
(globalThis as any).__publicationCross=h;
const stubs:Record<string,string>={
 'node:fs/promises':'const io=globalThis.__publicationCross.io;export const readFile=(...a)=>io.readFile(...a),writeFile=(...a)=>io.writeFile(...a),mkdir=(...a)=>io.mkdir(...a),mkdtemp=(...a)=>io.mkdtemp(...a),rename=(...a)=>io.rename(...a),rm=(...a)=>io.rm(...a);',
 'sharp':'export default ()=>({trim(){return this},png(){return this},async toBuffer(){return Buffer.from("TRIMMED-LOGO")}});',
 'server/runtime-profile.ts':'export const runtimeProfile=()=>({rootDir:"/fake/profile"});',
 'server/media-dir.ts':'export const resolveUploadFile=n=>"/fake/uploads/"+n;export const uploadDir=()=>"/fake/uploads";export const isSafeUploadName=n=>/^[\\w.-]+$/.test(n);',
 'server/product-assets.ts':'export const resolveProductAsset=()=>"/fake/logo.png";',
 'server/plugins/extract-frames.ts':'export const extractOneFrame=globalThis.__publicationCross.extract;',
 'shared/node-content-hash.ts':'export const sha256File=async p=>globalThis.__publicationCross.sha(await globalThis.__publicationCross.io.readFile(p));',
 'server/clipmentor/source-video.ts':'export const readSourceVideoReceipt=globalThis.__publicationCross.receipt;',
 'server/clipmentor/creator-storyboard-pdf.ts':'export const creatorDocumentHtml=(title,document,images,logo)=>JSON.stringify({title,document,images,logo});export const renderCreatorDocument=globalThis.__publicationCross.render;',
 'src/clipmentor/delivery-bindings.ts':'export const deliverySectionsFromDoc=()=>[];',
};
const bundle=await build({stdin:{contents:`export * from './server/clipmentor/creator-storyboard';export * from './server/clipmentor/creator-storyboard-document';export * from './server/clipmentor/production-panel-delivery';export * from './src/persist/agentRuntimeStore';export * from './src/persist/sharedKv';`,resolveDir:root},bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'controlled-boundaries',setup(b){
 b.onResolve({filter:/.*/},args=>{
  if(args.path==='node:fs/promises'||args.path==='sharp')return {path:args.path,namespace:'fake'};
  if(args.path.startsWith('.')){const p=resolve(args.resolveDir,args.path);const relative=p.slice(root.length+1)+(p.endsWith('.ts')?'':'.ts');if(stubs[relative])return {path:relative,namespace:'fake'};}
 });
 b.onLoad({filter:/.*/,namespace:'fake'},args=>({contents:stubs[args.path],loader:'js'}));
 if(baseline)b.onLoad({filter:/\.(ts|tsx)$/},args=>({contents:execFileSync('git',['show',baseline+':'+args.path.slice(root.length+1)],{cwd:root,encoding:'utf8'}),loader:args.path.endsWith('.tsx')?'tsx':'ts'}));
}}]});
const api=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
function fixture(tag:string){return {assets:[{id:'source',kind:'video',src:'/media/uploads/source.mp4',sourceContentHash:sourceHash,props:{clipmentorCreatorStoryboard:{source_sha256:sourceHash,rows:[{source_range_seconds:[0,4],source_frames:[0],shot_ms:'Shot '+tag,information_ms:'Info '+tag,visible_evidence_ids:['visible'],claim_evidence_ids:['claim']}]}}}],clipMentorAnalysis:{product:{name:'Synthetic '+tag},source:{asset_id:'source',sourceContentHash:sourceHash,duration_seconds:4,fps:10},evidence:[{evidence_id:'visible',kind:'visible_action',text:'Valid action',source_range_seconds:[0,4],source_ids:[receiptId],call_status:'succeeded'},{evidence_id:'claim',kind:'original_claim',text:'Valid claim',source_range_seconds:[0,4],source_ids:[receiptId],call_status:'succeeded'}]}};}

const settle=(p:Promise<any>)=>p.then(value=>({value,error:undefined}),error=>({value:undefined,error}));
async function until(test:()=>boolean){for(let i=0;i<100;i++){if(test())return;await new Promise(r=>setImmediate(r));}throw Error('barrier not reached');}
const results:any[]=[];
const expected=(i:number)=>({bytes:Buffer.from('%PDF-FAKE:'+gates[i].html),preview:Buffer.from('JPEG-FAKE:'+gates[i].html)});
const release=(i:number)=>gates[i].resolve(expected(i));
async function check(name:string,run:()=>Promise<any>){try{const evidence=await run();results.push({name,status:'PASS',...evidence});}catch(error){results.push({name,status:'RED',error:(error as Error).message});process.exitCode=1;}console.log(JSON.stringify(results.at(-1)));}
await check('same-content different-path shared render isolation',async()=>{
 const a=fixture('path-cross'),b=structuredClone(a);b.assets[0].src='/media/uploads/duplicate.mp4';files.set('/fake/uploads/duplicate.mp4',Buffer.from(source));
 const before=JSON.stringify(b),i=gates.length,one=settle(api.creatorStoryboard(a));await until(()=>gates.length===i+1);
 const reads=receiptReads,two=settle(api.creatorStoryboard(b));await until(()=>receiptReads>=reads+1);await new Promise(r=>setImmediate(r));assert.equal(gates.length,i+1);
 files.set('/fake/uploads/source.mp4',Buffer.from('changed owner path'));release(i);const [owner,survivor]=await Promise.all([one,two]);
 try{assert.match(owner.error?.message??'',/source_changed/);assert(!survivor.error,'healthy B must not inherit first caller A source path failure: '+survivor.error?.message);assert.deepEqual(survivor.value.bytes,expected(i).bytes);assert.deepEqual(survivor.value.preview,expected(i).preview);assert.deepEqual(files.get('/fake/uploads/duplicate.mp4'),source);assert.equal(JSON.stringify(b),before);
 const retried=await api.creatorStoryboard(b);assert.deepEqual(retried.bytes,expected(i).bytes);assert.equal(gates.length,i+1);assert.notDeepEqual(files.get('/fake/uploads/source.mp4'),source);
 return {sharedRenders:1,healthyBExactBytes:true,ownerSourceChangedOnly:true};}finally{files.set('/fake/uploads/source.mp4',Buffer.from(source));}
});
await check('cover final rename cancel/ack-loss preserves other project reference',async()=>{
 const doc=fixture('cover-cross'),i=gates.length,p=settle(api.createPanelStoryboard(doc,new AbortController().signal));await until(()=>gates.length===i+1);release(i);const asset=(await p).value;assert(asset);
 const other=structuredClone(doc);other.assets.push(asset);const target='/fake/uploads/'+asset.id+'.jpg',before=Buffer.from(files.get(target)!);
 const rename=io.rename,write=io.writeFile;
 const outcomes=[];
 for(const boundary of ['pre-rename-cancel','post-rename-cancel','rename-ack-lost']){
  const controller=new AbortController();let injected=0;
  io.writeFile=async(p:string,v:any,o?:any)=>{await write(p,v,o);if(p.startsWith(target+'.')&&boundary==='pre-rename-cancel'){injected++;controller.abort(Error(boundary));}};
  io.rename=async(from:string,to:string)=>{await rename(from,to);if(to===target){injected++;if(boundary==='post-rename-cancel')controller.abort(Error(boundary));if(boundary==='rename-ack-lost')throw Error(boundary);}};
  try{const outcome=await settle(api.createPanelStoryboard(structuredClone(doc),controller.signal));assert(outcome.error);assert.equal(injected,1);assert.deepEqual(files.get(target),before);assert.equal(api.panelStoryboardAsset(other)?.id,asset.id);assert.equal([...files.keys()].some(k=>k.startsWith(target+'.')),false);outcomes.push({boundary,error:outcome.error.message,exactBytes:true,otherReference:true});}
  finally{io.rename=rename;io.writeFile=write;}
 }
 const retry=await api.createPanelStoryboard(structuredClone(doc),new AbortController().signal);assert.equal(retry.id,asset.id);assert.equal(gates.length,i+1);assert.deepEqual(files.get(target),before);
 const fresh=fixture('pre-rename-no-target'),j=gates.length,controller=new AbortController(),next=settle(api.createPanelStoryboard(fresh,controller.signal));await until(()=>gates.length===j+1);
 io.writeFile=async(p:string,v:any,o?:any)=>{await write(p,v,o);if(p.endsWith('.tmp'))controller.abort(Error('pre-rename'));};
 try{release(j);assert((await next).error);const absent='/fake/uploads/clipmentor-storyboard-'+sha(expected(j).preview)+'.jpg';assert.equal(files.has(absent),false);}finally{io.writeFile=write;}
 return {classification:'PASS negative/control',outcomes,retryRenderCount:0,freshPreRenameTargetAbsent:true};
});
await check('artifact body and index commit acknowledgement loss across restart',async()=>{
 const entries=new Map<string,any>();let fault='',hits=0,readbackFailures=0;const deletes:string[]=[];
 const backend={get:async(k:string)=>{if(fault==='readback'&&k.includes('artifact:')){fault='';readbackFailures++;throw Error('authoritative-readback-unavailable');}return structuredClone(entries.get(k));},set:async(k:string,v:any)=>{entries.set(k,structuredClone(v));if(['body','body-unknown'].includes(fault)&&k.includes('artifact:')){fault=fault==='body-unknown'?'readback':'';hits++;throw Error('body-ack-lost');}}, delete:async(k:string)=>{deletes.push(k);entries.delete(k);},keys:async()=>[...entries.keys()],writeAgentRuntime:async(r:any)=>{const old=entries.get(r.key);assert.equal(r.expectedRevision,old?.revision??null);entries.set(r.key,structuredClone(r.value));if(fault==='index'){fault='';hits++;throw Error('index-ack-lost');}return {accepted:true,found:true,value:r.value};},updateAgentRunLease:async()=>{throw Error('unused');}};
 api.configureSharedKvBackend(backend);
 const record=(projectId:string)=>{const body='exact immutable operation evidence';return {version:1,projectId,runId:'run',artifactId:'operation_evidence',kind:'checkpoint-source',toolName:'probe',body,bodySha256:sha(body),originalBytes:Buffer.byteLength(body),originalChars:body.length,createdAt:1,redacted:false,binaryOmitted:false};};
 const seed=async(projectId:string)=>api.createAgentRun({version:1,projectId,runId:'run',status:'running',askOnly:false,userInputPreview:'fake',userInputDigest:'a'.repeat(64),createdAt:1,updatedAt:1,artifactIds:[],checkpointIds:[],proposalIds:[],events:[]});
 await seed('bodyloss');const body=record('bodyloss');fault='body';const bodyOutcome=await settle(api.storeAgentArtifact(body));assert.deepEqual(entries.get(api.agentArtifactKey('bodyloss',body.artifactId)),body);
 await seed('orphan');const orphan=record('orphan');entries.set(api.agentArtifactKey('orphan',orphan.artifactId),structuredClone(orphan));assert.equal(await api.loadAgentArtifact('orphan',orphan.artifactId),null,'crash before index leaves exact body without published authority');
 await seed('unknown');const unknown=record('unknown');fault='body-unknown';await assert.rejects(api.storeAgentArtifact(unknown));fault='';assert.deepEqual(entries.get(api.agentArtifactKey('unknown',unknown.artifactId)),unknown);assert(!deletes.includes(api.agentArtifactKey('unknown',unknown.artifactId)),'unknown body write outcome must retain body');
 const restarted=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text+'\n// restart instance').toString('base64'));restarted.configureSharedKvBackend(backend);
 const recovered=await restarted.storeAgentArtifact(orphan);const recoveredRecord=await restarted.loadAgentArtifact('orphan',orphan.artifactId);assert.deepEqual(entries.get(api.agentArtifactKey('orphan',orphan.artifactId)),orphan);
 assert.equal(await restarted.storeAgentArtifact(orphan),false,'already indexed duplicate retains original false behavior');
 const unknownRecovered=await restarted.storeAgentArtifact(unknown);const unknownRecord=await restarted.loadAgentArtifact('unknown',unknown.artifactId);
 for(const variant of ['metadata','body']){const project='conflict_'+variant;await seed(project);const conflict=record(project),changedBody='other exact content',other=variant==='metadata'?{...conflict,createdAt:2}:{...conflict,body:changedBody,bodySha256:sha(changedBody),originalBytes:Buffer.byteLength(changedBody),originalChars:changedBody.length};entries.set(api.agentArtifactKey(project,conflict.artifactId),other);assert.equal(await restarted.storeAgentArtifact(conflict),false,'nonexact '+variant+' orphan cannot be adopted');assert.deepEqual(entries.get(api.agentArtifactKey(project,conflict.artifactId)),other);assert.equal(await restarted.loadAgentArtifact(project,conflict.artifactId),null);}
 await seed('indexloss');const indexed=record('indexloss');fault='index';await assert.rejects(api.storeAgentArtifact(indexed),/index-ack-lost/);assert.deepEqual(await restarted.loadAgentArtifact('indexloss',indexed.artifactId),indexed);assert(!deletes.includes(api.agentArtifactKey('indexloss',indexed.artifactId)));
 await seed('baseline');assert.equal(await api.storeAgentArtifact(record('baseline')),true);assert.deepEqual(await api.loadAgentArtifact('baseline','operation_evidence'),record('baseline'));
 const rejected=record('missingrun');assert.equal(await api.storeAgentArtifact(rejected),false);assert.equal(entries.has(api.agentArtifactKey('missingrun',rejected.artifactId)),false);assert.equal(hits,3);
 assert.equal(recovered,true,'restart retry must publish same exact unindexed orphan');assert.deepEqual(recoveredRecord,orphan);assert.equal(bodyOutcome.value,true,'exact authoritative readback must complete initial publication after body ack loss');assert.deepEqual(await restarted.loadAgentArtifact('bodyloss',body.artifactId),body);assert.equal(unknownRecovered,true,'unknown outcome retained body must recover after restart');assert.deepEqual(unknownRecord,unknown);assert.equal(readbackFailures,1,'unknown outcome control reaches actual authoritative readback failure');
 return {orphanRestartRecovered:true,bodyAckLostReadbackRecovered:true,unknownBodyRetainedAndRestartRecovered:true,indexedDuplicate:false,nonexactBodyAndMetadataRejected:true,indexAckLostRetainedExactBody:true,baseline:true,rejectedRunCleaned:true};
});
console.log(JSON.stringify({base:'5f23383',externalCalls:0,realRenders:0,results},null,2));
