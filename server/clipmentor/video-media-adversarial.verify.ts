import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';

const root=await mkdtemp(join(tmpdir(),'clipmentor-r2-adversarial-'));
process.env.OPENCHATCUT_DATA_DIR=root;process.env.OPENCHATCUT_DEV_PROFILE_ID='88888888-8888-4888-8888-888888888888';
for(const k of ['R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET','CLIPMENTOR_R2_ACCOUNT_ID','CLIPMENTOR_R2_BUCKET','CLIPMENTOR_R2_API_TOKEN','PROXY_URL','HTTPS_PROXY','https_proxy','HTTP_PROXY','http_proxy'])process.env[k]='';
const originalFetch=globalThis.fetch,originalExec=childProcess.execFile;
globalThis.fetch=async()=>{throw Error('Real network forbidden');};
let checks=0;
const config=(token:string)=>({CLIPMENTOR_R2_ACCOUNT_ID:'a'.repeat(32),CLIPMENTOR_R2_BUCKET:'fixture',CLIPMENTOR_R2_API_TOKEN:token});
function gate() {
  let release!:()=>void;const wait=new Promise<void>(r=>release=r);let signal:AbortSignal|undefined,calls=0;
  const verify:typeof fetch=async(_url,init)=>{
    calls++;signal=init?.signal as AbortSignal;
    await new Promise<void>((resolve,reject)=>{const abort=()=>{signal!.removeEventListener('abort',abort);reject(Error('offline verification cancelled'));};
      signal!.addEventListener('abort',abort,{once:true});wait.then(()=>{signal!.removeEventListener('abort',abort);resolve();});if(signal!.aborted)abort();});
    return new Response(JSON.stringify({success:true,result:{status:'active',id:'b'.repeat(32)}}));
  };
  return {verify,release,get signal(){return signal!;},get calls(){return calls;}};
}
try {
  const {resolveVideoR2Credentials,prepareVideoMedia}=await import('./video-media');
  const {seedKeystore,setKeys,getKey}=await import('../keystore');
  {
    const g=gate(),a=new AbortController(),b=new AbortController(),c=config('first-cancel');
    const first=resolveVideoR2Credentials(c,a.signal,g.verify),second=resolveVideoR2Credentials(c,b.signal,g.verify);
    const secondOutcome=second.then(value=>({value}),error=>({error}));
    a.abort();await assert.rejects(first,(e:any)=>e.code==='aborted');
    assert.equal(g.signal.aborted,false,'one task must not cancel another task verification');
    g.release();const outcome=await secondOutcome;assert(!('error' in outcome),'the surviving caller must succeed');assert.equal(outcome.value.bucket,'fixture');assert.equal(g.calls,1);
    await resolveVideoR2Credentials(c,b.signal,async()=>assert.fail('Successful verification should remain cached'));checks++;
  }
  {
    const g=gate(),a=new AbortController(),b=new AbortController(),c=config('second-cancel');
    const first=resolveVideoR2Credentials(c,a.signal,g.verify),second=resolveVideoR2Credentials(c,b.signal,g.verify);
    b.abort();
    const state=await Promise.race([second.then(()=> 'resolved',()=> 'rejected'),new Promise<string>(r=>setImmediate(()=>r('still_waiting')))]);
    g.release();await first;await second.catch(()=>undefined);
    assert.equal(state,'rejected','a cancelled waiter must not wait for the shared network request');assert.equal(g.calls,1);checks++;
  }
  {
    const g=gate(),a=new AbortController(),b=new AbortController(),c=config('all-cancel');
    const first=resolveVideoR2Credentials(c,a.signal,g.verify),second=resolveVideoR2Credentials(c,b.signal,g.verify);
    a.abort();b.abort();await Promise.allSettled([first,second]);assert.equal(g.signal.aborted,true,'no remaining tasks means cancel underlying verification');
    let fresh=0;await resolveVideoR2Credentials(c,new AbortController().signal,async()=>{fresh++;return new Response(JSON.stringify({success:true,result:{status:'active',id:'b'.repeat(32)}}));});
    assert.equal(fresh,1,'a fully cancelled verification must not become cached success');g.release();checks++;
  }
  // Actual preview plugin default dependency path: observe child env, not an injected deps.run.
  const launched:Array<{args:string[];env:NodeJS.ProcessEnv}>=[];
  childProcess.execFile=((_file:any,args:any,options:any,callback:any)=>{
    launched.push({args,env:options.env});queueMicrotask(()=>callback(Error('offline child intercepted')));return new EventEmitter();}) as any;
  syncBuiltinESMExports();
  const {clipMentorPreviewReviewPlugin,previewBridge}=await import('../plugins/clipmentor-preview-review');
  const media=join(root,'media/uploads');await mkdir(media,{recursive:true});const bytes=Buffer.from('offline-bound-preview');await writeFile(join(media,'preview.mp4'),bytes);
  const sha=createHash('sha256').update(bytes).digest('hex');let handler:any;
  (clipMentorPreviewReviewPlugin().configureServer as any)({middlewares:{use:(route:string,h:any)=>{if(route==='/api/clipmentor/review-preview')handler=h;}}});
  const request=async()=>{
    const body={action:'request',projectId:'fixture-project',operationId:randomUUID(),maxRequests:1,src:'/media/uploads/preview.mp4',videoSha256:sha,
      input:{duration_seconds:10,points:[{point_id:'P',teaching_goal_zh:'goal',product_relevance:'product'}],units:[{unit_id:'U',point_ids:['P']}],reference_text:[]}};
    const req=Readable.from([Buffer.from(JSON.stringify(body))]);Object.assign(req,{method:'POST',headers:{host:'127.0.0.1:3456',origin:'http://127.0.0.1:3456','content-type':'application/json'},socket:{remoteAddress:'127.0.0.1'}});
    const res=new EventEmitter();Object.assign(res,{destroyed:false,writableEnded:false,headersSent:false,setHeader(){},write(){(this as any).headersSent=true;},end(){(this as any).writableEnded=true;}});
    await handler(req,res);
  };
  const names=['CLIPMENTOR_R2_ACCOUNT_ID','CLIPMENTOR_R2_BUCKET','CLIPMENTOR_R2_API_TOKEN','PROXY_URL'] as const;
  seedKeystore({...config('fixture-current-token'),ROOTIFY_GATEWAY_API_KEY:'fixture-model',PROXY_URL:'http://127.0.0.1:9999'});
  await request();assert.equal(launched.length,1);
  for(const n of names)assert.equal(launched[0].env[n],getKey(n),'current server config must reach preview child');
  assert.equal(launched[0].args[launched[0].args.indexOf('--expected-video-sha256')+1],sha);checks++;
  for(const n of names)process.env[n]='fixture-stale';
  await setKeys(Object.fromEntries(names.map(n=>[n,''])));await request();assert.equal(launched.length,2);
  for(const n of names)assert.equal(launched[1].env[n],'','cleared server config must override stale process environment');checks++;
  // A bad proxy must fail closed in both credential and standard-S3 paths, never silently connect directly.
  await setKeys({PROXY_URL:'://invalid-proxy'});
  await assert.rejects(resolveVideoR2Credentials(config('bad-proxy'),new AbortController().signal), (e:any)=>e.code==='invalid_proxy_configuration');checks++;
  seedKeystore({R2_ACCOUNT_ID:'a'.repeat(32),R2_BUCKET:'fixture',R2_ACCESS_KEY_ID:'fixture',R2_SECRET_ACCESS_KEY:'fixture'});
  await assert.rejects(prepareVideoMedia(join(media,'preview.mp4'),sha,new AbortController().signal),(e:any)=>e.code==='invalid_proxy_configuration');checks++;
  // Host -> actual CLI -> durable failure -> host read: a changed file must be accounted as zero submitted.
  const bin=join(root,'bin'),marker=join(root,'unexpected-model-dispatch');await mkdir(bin);
  await writeFile(join(bin,'curl'),`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'must not run');process.exit(88);`,{mode:0o700});
  const preload=join(root,'offline.mjs');await writeFile(preload,"globalThis.fetch=()=>{throw Error('Real network forbidden');};");
  let childRuns=0;
  const bound={action:'request',projectId:'race-project',operationId:randomUUID(),maxRequests:1,src:'/media/uploads/preview.mp4',videoSha256:sha,
    input:{duration_seconds:10,points:[{point_id:'P',teaching_goal_zh:'goal',product_relevance:'product'}],units:[{unit_id:'U',point_ids:['P']}],reference_text:[]}};
  const bridgeDeps={directory:join(root,'bridge-race'),resolve:()=>join(media,'preview.mp4'),run:async(args:string[])=>{
    childRuns++;await writeFile(join(media,'preview.mp4'),Buffer.from('changed between host and child'));
    const child=childProcess.spawnSync(process.execPath,['--import',preload,'--import','tsx',resolve('server/clipmentor/preview-review-cli.mts'),...args],{
      cwd:process.cwd(),env:{PATH:bin+':'+process.env.PATH,HOME:root,OPENCHATCUT_DATA_DIR:join(root,'child-profile'),OPENCHATCUT_DEV_PROFILE_ID:'88888888-8888-4888-8888-888888888888',ROOTIFY_GATEWAY_API_KEY:'fixture-model',CLIPMENTOR_VIDEO_TRANSPORT:'inline'},encoding:'utf8',timeout:15000});
    assert.equal(child.status,1,child.stderr);throw Error('offline CLI rejected changed preview');}};
  const rejected=await previewBridge(bound,bridgeDeps);
  assert.equal(rejected.requestsAttempted,0);assert.equal(rejected.requestsSent,0);assert.equal((rejected as any).requestOutcome,'not_submitted');
  const reread=await previewBridge({action:'read',projectId:bound.projectId,operationId:bound.operationId,videoSha256:sha},bridgeDeps);
  assert.equal(reread.requestsAttempted,0);assert.equal(childRuns,1);await assert.rejects(readFile(marker),(e:any)=>e.code==='ENOENT');checks++;
  console.log(`R2 adversarial: ${checks} checks passed; shared cancellation, real preview bridge, cleared env, frozen identity and invalid proxy; 0 real network/model calls.`);
} finally {
  globalThis.fetch=originalFetch;childProcess.execFile=originalExec;syncBuiltinESMExports();await rm(root,{recursive:true,force:true});
}
