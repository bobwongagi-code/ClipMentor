import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root=await mkdtemp(join(tmpdir(),'clipmentor-video-cli-'));
try {
 const setup=join(root,'setup.mjs'),bin=join(root,'bin');await mkdir(bin);
 await writeFile(setup,`
 import {createRequire} from 'node:module';import {appendFileSync} from 'node:fs';import {Readable} from 'node:stream';
 const require=createRequire(${JSON.stringify(resolve('package.json'))});
 process.loadEnvFile=()=>{throw Error('Offline test does not read real credentials');};
 globalThis.fetch=async(url,init)=>{
 if(process.env.TEST_LEGACY_R2!=='1'||url!=='https://api.cloudflare.com/client/v4/user/tokens/verify')throw Error('Network forbidden in verification');
 if(init.headers.Authorization!=='Bearer fixture-video-token')throw Error('Wrong private credential');
 appendFileSync(process.env.TEST_TRACE,'mock-token-verify\\n');
 return new Response(JSON.stringify({success:true,result:{status:'active',id:'b'.repeat(32)}}),{status:200});};
 const {S3Client}=require('@aws-sdk/client-s3');let object,parts=[];
 S3Client.prototype.send=async function(command){const name=command.constructor.name;appendFileSync(process.env.TEST_TRACE,name+'\\n');
 if(process.env.TEST_LEGACY_R2==='1'){
 const keys=await this.config.credentials();if(keys.accessKeyId!=='b'.repeat(32))throw Error('Legacy key not used');
 const {computeCaps}=await import(${JSON.stringify(resolve('server/keystore.ts'))});if(computeCaps().storage)throw Error('Video credentials must not enable generic storage');}
 const i=command.input;
 if(name==='HeadObjectCommand'){if(!object)throw {$metadata:{httpStatusCode:404}};return {ContentLength:object.length,ETag:'test-etag'};}
 if(name==='ListMultipartUploadsCommand')return {Uploads:[]};
 if(name==='CreateMultipartUploadCommand')return {UploadId:'test-upload'};
 if(name==='ListPartsCommand')return {Parts:[]};
 if(name==='UploadPartCommand'){const chunks=[];for await(const c of i.Body)chunks.push(c);parts[i.PartNumber-1]=Buffer.concat(chunks);return {ETag:'test-part'};}
 if(name==='CompleteMultipartUploadCommand'){if(i.IfNoneMatch!==undefined)throw Error('Do not assume undocumented R2 completion conditionals');object=Buffer.concat(parts);return {};}
 if(name==='GetObjectCommand')return {Body:Readable.from([object])};
 throw Error('Unexpected SDK command');};
 `);
 const curl=join(bin,'curl');
 await writeFile(curl,`#!${process.execPath}
 const fs=require('node:fs'),a=process.argv.slice(2);let h='';process.stdin.on('data',c=>h+=c);process.stdin.on('end',()=>{
 const at=k=>a[a.indexOf(k)+1],body=JSON.parse(fs.readFileSync(at('--data-binary').slice(1),'utf8'));
 const videoPart=body.contents[0].parts[0];
 if(process.env.TEST_EXPECT_INLINE==='1'?(!videoPart.inlineData||videoPart.fileData):(!videoPart.fileData||videoPart.inlineData))process.exit(9);
 fs.appendFileSync(process.env.TEST_TRACE,'mock-model-post\\n');
 fs.writeFileSync(at('--dump-header'),'HTTP/1.1 200 OK\\r\\n\\r\\n');
 fs.writeFileSync(at('--output'),JSON.stringify({modelVersion:'offline-mock',candidates:[{finishReason:'STOP',content:{parts:[{text:'{}'}]}}]}));
 process.stdout.write(JSON.stringify({http_code:200,size_upload:1,size_download:1,time_total:0.01}));});
 `,{mode:0o700});
 const video=join(root,'video.mp4'),input=join(root,'input.json'),output=join(root,'result.json'),trace=join(root,'trace');
 await writeFile(video,Buffer.from('offline-fixture-original-bytes'));
 await writeFile(input,JSON.stringify({duration_seconds:10,points:[{point_id:'P',teaching_goal_zh:'动作',product_relevance:'商品'}],units:[{unit_id:'U',point_ids:['P']}],reference_text:[]}));
 const operation=randomUUID();
 const env:NodeJS.ProcessEnv={...process.env,PATH:bin+':'+process.env.PATH,OPENCHATCUT_DATA_DIR:join(root,'profile'),
 ROOTIFY_GATEWAY_API_KEY:'test-only-key',R2_ACCOUNT_ID:'a'.repeat(32),R2_ACCESS_KEY_ID:'test-only-access',R2_SECRET_ACCESS_KEY:'test-only-secret',R2_BUCKET:'test-bucket',R2_ENABLED:'1',TEST_TRACE:trace};
 delete env.CLIPMENTOR_VIDEO_TRANSPORT;
 const frozenHash=createHash('sha256').update(await readFile(video)).digest('hex');
 const args=['--import',setup,'--import','tsx','server/clipmentor/preview-review-cli.mts','--video',video,'--expected-video-sha256',frozenHash,'--input',input,'--out',output,'--operation',operation];
 const run=()=>spawnSync(process.execPath,args,{cwd:process.cwd(),env,encoding:'utf8',timeout:15_000});
 const first=run();assert.equal(first.status,0,first.stderr);const result=JSON.parse(await readFile(output,'utf8'));
 assert.equal(result.media_transfer.mode,'r2');assert.equal(result.requests_attempted,1);assert.equal(result.full_film_accepted,false);assert.equal(result.status,'review_required');
 const history=await readFile(trace,'utf8');assert.equal(history.split('mock-model-post').length-1,1);assert.ok(history.includes('UploadPartCommand'));assert.ok(history.includes('GetObjectCommand'));
 assert.ok(!JSON.stringify(result).includes('X-Amz-Signature'));
 const second=run();assert.equal(second.status,0,second.stderr);assert.equal(JSON.parse(second.stdout).status,'cached');assert.equal(await readFile(trace,'utf8'),history);
 const wrongCached=spawnSync(process.execPath,args.map(v=>v===frozenHash?'f'.repeat(64):v),{cwd:process.cwd(),env,encoding:'utf8',timeout:15_000});
 assert.equal(wrongCached.status,1);assert.match(wrongCached.stderr,/Preview source binding mismatch/);assert.equal(await readFile(trace,'utf8'),history);
 assert.equal(JSON.parse(await readFile(join(root,operation+'.operation.json'),'utf8')).status,'completed','Wrong expected hash must not rewrite the prior successful record');
 // A missing storage credential fails before model accounting and the original failed attempt cannot replay.
 env.R2_ACCESS_KEY_ID='';const failedId=randomUUID(),failedOut=join(root,'failed-result.json');
 const failArgs=args.map(v=>v===operation?failedId:v===output?failedOut:v);
 const failed=spawnSync(process.execPath,failArgs,{cwd:process.cwd(),env,encoding:'utf8',timeout:15_000});assert.equal(failed.status,1);
 const receipt=JSON.parse(await readFile(join(root,failedId+'.operation.json'),'utf8'));
 assert.equal(receipt.requests_attempted,0);assert.equal(receipt.status,'failed');assert.equal(receipt.media_failure.code,'r2_configuration_unavailable');assert.equal(await readFile(trace,'utf8'),history);
 // The existing video-only token works through the actual CLI without enabling general R2 uploads.
 for(const name of ['R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET'])env[name]='';
 env.CLIPMENTOR_R2_ACCOUNT_ID='a'.repeat(32);env.CLIPMENTOR_R2_BUCKET='fixture-video-only';env.CLIPMENTOR_R2_API_TOKEN='fixture-video-token';env.TEST_LEGACY_R2='1';
 const legacyId=randomUUID(),legacyOut=join(root,'legacy-result.json');
 const legacy=spawnSync(process.execPath,args.map(v=>v===operation?legacyId:v===output?legacyOut:v),{cwd:process.cwd(),env,encoding:'utf8',timeout:15_000});
 assert.equal(legacy.status,0,legacy.stderr);assert.equal(JSON.parse(await readFile(legacyOut,'utf8')).media_transfer.mode,'r2');
 const legacyTrace=await readFile(trace,'utf8');assert.equal(legacyTrace.split('mock-token-verify').length-1,1);assert.equal(legacyTrace.split('mock-model-post').length-1,2);
 env.CLIPMENTOR_VIDEO_TRANSPORT='inline';env.TEST_EXPECT_INLINE='1';
 const inlineId=randomUUID(),inlineOut=join(root,'inline-result.json');
 const inline=spawnSync(process.execPath,args.map(v=>v===operation?inlineId:v===output?inlineOut:v),{cwd:process.cwd(),env,encoding:'utf8',timeout:15_000});
 assert.equal(inline.status,0,inline.stderr);assert.equal(JSON.parse(await readFile(inlineOut,'utf8')).media_transfer.mode,'inline');
 const afterInline=await readFile(trace,'utf8');assert.equal(afterInline.split('mock-token-verify').length-1,1,'Explicit inline must not verify or upload to R2');
 assert.equal(afterInline.split('UploadPartCommand').length,legacyTrace.split('UploadPartCommand').length);
 const legacyArgs=args.filter((v,i)=>v!=='--expected-video-sha256'&&args[i-1]!=='--expected-video-sha256');
 const compatId=randomUUID(),compatOut=join(root,'compat-result.json');
 const compat=spawnSync(process.execPath,legacyArgs.map(v=>v===operation?compatId:v===output?compatOut:v),{cwd:process.cwd(),env,encoding:'utf8',timeout:15_000});
 assert.equal(compat.status,0,compat.stderr);
 const beforeChanged=await readFile(trace,'utf8');await writeFile(video,Buffer.from('different-video-after-host-binding'));
 const changedId=randomUUID(),changedOut=join(root,'changed-result.json');
 const changed=spawnSync(process.execPath,args.map(v=>v===operation?changedId:v===output?changedOut:v),{cwd:process.cwd(),env,encoding:'utf8',timeout:15_000});
 assert.equal(changed.status,1);
 assert.equal(await readFile(trace,'utf8'),beforeChanged,'Changed media must be rejected before model or storage dispatch');
 const changedReceipt=JSON.parse(await readFile(join(root,changedId+'.operation.json'),'utf8'));
 assert.equal(changedReceipt.requests_attempted,0);assert.equal(changedReceipt.status,'failed');assert.equal(changedReceipt.media_failure.code,'host_source_hash_mismatch');
 assert.equal(changedReceipt.expected_video_sha256,frozenHash);assert.notEqual(changedReceipt.actual_video_sha256,frozenHash);
 console.log('Video media CLI: synthetic keystore -> real SDK-command adapter -> native URL request -> durable review; cache/failed-zero replay; 0 real network/model calls.');
} finally {await rm(root,{recursive:true,force:true});}
