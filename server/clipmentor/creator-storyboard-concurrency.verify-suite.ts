// Deterministic production-entry probe. Run: TMPDIR=/tmp/cm-pdf-erzl node --import tsx server/clipmentor/creator-storyboard-concurrency.verify-suite.ts
// Bundles the current production entry points in memory with controlled dependency boundaries; the probe never writes product files.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const sha=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
const source=Buffer.from('synthetic-source:SM37/66/67'),sourceHash=sha(source);
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
(globalThis as any).__pdfConditions=h;
const stubs:Record<string,string>={
 'node:fs/promises':'export const {readFile,writeFile,mkdir,mkdtemp,rename,rm}=globalThis.__pdfConditions.io;',
 'sharp':'export default ()=>({trim(){return this},png(){return this},async toBuffer(){return Buffer.from("TRIMMED-LOGO")}});',
 'server/runtime-profile.ts':'export const runtimeProfile=()=>({rootDir:"/fake/profile"});',
 'server/media-dir.ts':'export const resolveUploadFile=n=>"/fake/uploads/"+n;export const uploadDir=()=>"/fake/uploads";export const isSafeUploadName=n=>/^[\\w.-]+$/.test(n);',
 'server/product-assets.ts':'export const resolveProductAsset=()=>"/fake/logo.png";',
 'server/plugins/extract-frames.ts':'export const extractOneFrame=globalThis.__pdfConditions.extract;',
 'shared/node-content-hash.ts':'export const sha256File=async p=>globalThis.__pdfConditions.sha(await globalThis.__pdfConditions.io.readFile(p));',
 'server/clipmentor/source-video.ts':'export const readSourceVideoReceipt=globalThis.__pdfConditions.receipt;',
 'server/clipmentor/creator-storyboard-pdf.ts':'export const creatorDocumentHtml=(title,document,images,logo)=>JSON.stringify({title,document,images,logo});export const renderCreatorDocument=globalThis.__pdfConditions.render;',
 'src/clipmentor/delivery-bindings.ts':'export const deliverySectionsFromDoc=()=>[];',
};
const bundle=await build({stdin:{contents:`export * from './server/clipmentor/creator-storyboard';export * from './server/clipmentor/creator-storyboard-document';export * from './server/clipmentor/production-panel-delivery';`,resolveDir:root},bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'controlled-boundaries',setup(b){
 b.onResolve({filter:/.*/},args=>{
  if(args.path==='node:fs/promises'||args.path==='sharp')return {path:args.path,namespace:'fake'};
  if(args.path.startsWith('.')){const p=resolve(args.resolveDir,args.path);const relative=p.slice(root.length+1)+(p.endsWith('.ts')?'':'.ts');if(stubs[relative])return {path:relative,namespace:'fake'};}
 });
 b.onLoad({filter:/.*/,namespace:'fake'},args=>({contents:stubs[args.path],loader:'js'}));
}}]});
const api=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
function fixture(tag:string){return {assets:[{id:'source',kind:'video',src:'/media/uploads/source.mp4',sourceContentHash:sourceHash,props:{clipmentorCreatorStoryboard:{source_sha256:sourceHash,rows:[{source_range_seconds:[0,4],source_frames:[0],shot_ms:'Shot '+tag,information_ms:'Info '+tag,visible_evidence_ids:['visible'],claim_evidence_ids:['claim']}]}}}],clipMentorAnalysis:{product:{name:'Synthetic '+tag},source:{asset_id:'source',sourceContentHash:sourceHash,duration_seconds:4,fps:10},evidence:[{evidence_id:'visible',kind:'visible_action',text:'Valid action',source_range_seconds:[0,4],source_ids:[receiptId],call_status:'succeeded'},{evidence_id:'claim',kind:'original_claim',text:'Valid claim',source_range_seconds:[0,4],source_ids:[receiptId],call_status:'succeeded'}]}};}
const snap=(x:any)=>JSON.stringify(x);
const settle=(p:Promise<any>)=>p.then(value=>({value,error:undefined}),error=>({value:undefined,error}));
async function until(test:()=>boolean){for(let i=0;i<100;i++){if(test())return;await new Promise(resolve=>setImmediate(resolve));}throw Error('probe barrier not reached');}
function expected(index:number){return {bytes:Buffer.from('%PDF-FAKE:'+gates[index].html),preview:Buffer.from('JPEG-FAKE:'+gates[index].html)};}
function release(index:number){gates[index].resolve(expected(index));}
const results:Array<{name:string;status:string;detail?:string}>=[];
async function check(name:string,run:()=>Promise<void>){try{await run();results.push({name,status:'PASS'});console.log('PASS '+name);}catch(e){const detail=e instanceof Error?e.message:String(e);results.push({name,status:'RED',detail});console.log('RED '+name+': '+detail);}}

await check('SM37: abort only requester while shared render is pending',async()=>{
 const a=fixture('cancel'),b=structuredClone(a),beforeA=snap(a),beforeB=snap(b),controller=new AbortController(),index=gates.length,frameBefore=frames;
 const first=settle(api.creatorStoryboard(a,controller.signal));await until(()=>gates.length===index+1);
 const readBefore=receiptReads,second=settle(api.creatorStoryboard(b,new AbortController().signal));await until(()=>receiptReads>=readBefore+1);await new Promise(resolve=>setImmediate(resolve));
 const invalid=structuredClone(a);invalid.clipMentorAnalysis.evidence[0].text='Invalid evidence during shared cancellation';const invalidBefore=snap(invalid);await assert.rejects(api.creatorStoryboard(invalid),/excerpt_changed/);assert.equal(snap(invalid),invalidBefore);
 const reason=Error('only-requester-A');controller.abort(reason);assert.equal((await first).error,reason);assert.equal(gates[index].signal.aborted,false);assert.equal(gates.length,index+1);
 release(index);const result=(await second).value;assert(result);assert.deepEqual(result.bytes,expected(index).bytes);assert.deepEqual(result.preview,expected(index).preview);assert.equal(result.pages,1);assert.equal(frames,frameBefore+1);assert.equal(snap(a),beforeA);assert.equal(snap(b),beforeB);
});
await check('SM66: changed document forks bytes; invalid evidence cannot borrow pending/cache',async()=>{
 const a=fixture('fork'),before=snap(a),index=gates.length,old=settle(api.creatorStoryboard(a));await until(()=>gates.length===index+1);
 const changed=structuredClone(a);changed.assets[0].props.clipmentorCreatorStoryboard.rows[0].shot_ms='Updated authored shot';const changedBefore=snap(changed),next=settle(api.creatorStoryboard(changed));await until(()=>gates.length===index+2);
 const bad=structuredClone(a);bad.clipMentorAnalysis.evidence[0].text='Unverified action';const badBefore=snap(bad);await assert.rejects(api.creatorStoryboard(bad),/excerpt_changed/);
 release(index+1);release(index);const oldResult=(await old).value,newResult=(await next).value;assert.deepEqual(oldResult.bytes,expected(index).bytes);assert.deepEqual(newResult.bytes,expected(index+1).bytes);assert.notDeepEqual(oldResult.bytes,newResult.bytes);assert.notEqual(api.creatorDocumentHash(a.assets[0].props.clipmentorCreatorStoryboard),api.creatorDocumentHash(changed.assets[0].props.clipmentorCreatorStoryboard));
 await assert.rejects(api.creatorStoryboard(bad),/excerpt_changed/);assert.equal(snap(a),before);assert.equal(snap(changed),changedBefore);assert.equal(snap(bad),badBefore);
});
await check('SM66: persisted evidence digest changes while valid shared work is pending',async()=>{
 const a=fixture('persisted'),content=a.assets[0].props.clipmentorCreatorStoryboard;await api.saveCreatorStoryboardDocument(a,content);delete (a.assets[0].props as any).clipmentorCreatorStoryboard;
 const before=snap(a),index=gates.length,valid=settle(api.creatorStoryboard(a));await until(()=>gates.length===index+1);
 const bad=structuredClone(a);bad.clipMentorAnalysis.evidence[0].text='Changed after save';const badBefore=snap(bad);await assert.rejects(api.creatorStoryboard(bad),/document_evidence_changed/);release(index);assert.deepEqual((await valid).value.bytes,expected(index).bytes);assert.equal(snap(a),before);assert.equal(snap(bad),badBefore);
});
await check('SM37: shared renderer error rejects all; retry cannot reuse stale failure/result',async()=>{
 const a=fixture('failure'),before=snap(a),index=gates.length,one=settle(api.creatorStoryboard(a));await until(()=>gates.length===index+1);const reads=receiptReads,two=settle(api.creatorStoryboard(structuredClone(a)));await until(()=>receiptReads>=reads+1);await new Promise(resolve=>setImmediate(resolve));
 const reason=Error('controlled-render-failure');gates[index].reject(reason);assert.equal((await one).error,reason);assert.equal((await two).error,reason);
 const retry=settle(api.creatorStoryboard(a));await until(()=>gates.length===index+2);release(index+1);assert.deepEqual((await retry).value.bytes,expected(index+1).bytes);assert.equal(snap(a),before);
});
await check('SM67: stale registered cover must not bypass changed evidence validation',async()=>{
 const doc=fixture('cover-fast'),index=gates.length,created=settle(api.createPanelStoryboard(doc,new AbortController().signal));await until(()=>gates.length===index+1);release(index);const asset=(await created).value;assert(asset);assert.equal(asset.sourceContentHash,sha(expected(index).preview));assert.deepEqual(files.get('/fake/uploads/'+asset.id+'.jpg'),expected(index).preview);assert.equal(asset.props.clipmentorCreatorDocumentHash,api.creatorDocumentHash(doc.assets[0].props.clipmentorCreatorStoryboard));doc.assets.push(asset);
 const before=snap(doc),rendersBeforeReuse=gates.length;
 assert.equal(await api.createPanelStoryboard(doc,new AbortController().signal),undefined,'valid registered cover and valid receipt reuse the exact existing asset');assert.equal(gates.length,rendersBeforeReuse,'valid registered cover does not render again');assert.equal(snap(doc),before);assert.deepEqual(files.get('/fake/uploads/'+asset.id+'.jpg'),expected(index).preview);
 persistReceipt(receiptId,'Receipt no longer supports saved visible claim');
 try{await assert.rejects(api.creatorStoryboard(doc),/excerpt_changed/);const answer=await settle(api.createPanelStoryboard(doc,new AbortController().signal));assert.equal(snap(doc),before);assert(answer.error,'registered-cover fast path returned success despite creatorStoryboard rejecting changed persisted receipt');}finally{persistReceipt(receiptId);}
});
await check('SM66/67: evidence invalidated in flight cannot publish old shared cover',async()=>{
 const changed=fixture('inflight'),valid=structuredClone(changed);valid.clipMentorAnalysis.evidence.forEach(e=>{e.source_ids=[otherReceiptId];});const validBefore=snap(valid),changedBefore=snap(changed),index=gates.length;
 const cover=settle(api.createPanelStoryboard(changed,new AbortController().signal));await until(()=>gates.length===index+1);const reads=receiptReads,survivor=settle(api.creatorStoryboard(valid));await until(()=>receiptReads>=reads+1);await new Promise(resolve=>setImmediate(resolve));assert.equal(gates.length,index+1,'different valid receipt references still share identical authored PDF work');
 persistReceipt(receiptId,'Receipt invalidated during renderer await');release(index);
 try{const good=await survivor,bad=await cover;assert.deepEqual(good.value.bytes,expected(index).bytes);assert.deepEqual(good.value.preview,expected(index).preview);assert.equal(snap(valid),validBefore);assert.equal(snap(changed),changedBefore);await assert.rejects(api.creatorStoryboard(changed),/excerpt_changed/);
 if(bad.value){assert.deepEqual(files.get('/fake/uploads/'+bad.value.id+'.jpg'),expected(index).preview);const lookup=structuredClone(changed);lookup.assets.push(bad.value);assert.equal(api.panelStoryboardAsset(lookup)?.id,bad.value.id);console.log('EVIDENCE in-flight stale cover exact hash='+bad.value.sourceContentHash+' binding='+bad.value.props.clipmentorCreatorDocumentHash+' approvedByLookup=true');}
 assert(bad.error,'requester with changed persistent receipt published exact old preview and lookup approved its document binding');}finally{persistReceipt(receiptId);}
});
await check('SM67: registered cover cannot succeed after legitimate persisted document replacement',async()=>{
 const doc=fixture('registered-document-race'),content=doc.assets[0].props.clipmentorCreatorStoryboard;
 await api.saveCreatorStoryboardDocument(doc,content);delete (doc.assets[0].props as any).clipmentorCreatorStoryboard;
 const index=gates.length,created=settle(api.createPanelStoryboard(doc,new AbortController().signal));await until(()=>gates.length===index+1);release(index);
 const asset=(await created).value;assert(asset);doc.assets.push(asset);
 const before=snap(doc),cover='/fake/uploads/'+asset.id+'.jpg',originalRead=io.readFile,changed=structuredClone(content);changed.rows[0].shot_ms='Legitimately updated persisted authored shot';
 let replaced=false;
 io.readFile=async(p:string,encoding?:string)=>{const value=await originalRead(p,encoding);if(p===cover&&!replaced){replaced=true;await api.saveCreatorStoryboardDocument(doc,changed);}return value;};
 try{
  const rendersBefore=gates.length,answer=await settle(api.createPanelStoryboard(doc,new AbortController().signal));
  assert(replaced,'replacement must occur during registered-cover hash read');assert.equal(snap(doc),before);
  const current=await api.loadCreatorStoryboardDocument(doc);assert.deepEqual(current,changed,'replacement is a legitimate authored document with unchanged evidence digest');
  assert.notEqual(api.creatorDocumentHash(current),asset.props.clipmentorCreatorDocumentHash);assert.equal(api.panelStoryboardAsset(doc,current),undefined);
  assert.equal(gates.length,rendersBefore,'identity mismatch rejects without rendering or silently publishing');assert.deepEqual(files.get(cover),expected(index).preview,'old registered bytes remain intact');
  assert(answer.error,'registered fastpath reported success for cover A after verifying valid persisted document B');assert(api.isCreatorDocumentIssue(answer.error),'identity mismatch returns an author-repairable document issue');
 }finally{io.readFile=originalRead;}
});
console.log(JSON.stringify({base:'5dd0e8b',level:'production-function integration with in-memory IO and controlled fake render',frames,renders:gates.length,receiptReads,results},null,2));
if(results.some(r=>r.status==='RED'))process.exitCode=1;
