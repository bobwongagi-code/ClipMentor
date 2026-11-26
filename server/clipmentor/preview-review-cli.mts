import {echoesMediaSecret} from './video-input.ts';
import {externalCall} from './external-call.ts';
import { runtimeProfile } from '../runtime-profile.ts';
import { sha256File } from '../../shared/node-content-hash.ts';
import { previewReviewCredential, seedKeystore } from '../keystore.ts';
import { prepareVideoMedia, VideoMediaError } from './video-media.ts';
import { readFile, writeFile, mkdir, access, stat } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  buildPreviewReviewRequest, previewReviewIdentity, reviewClipMentorPreview, validatePreviewReviewInput,
  PREVIEW_REVIEW_ENDPOINT, type PreviewReviewFormat,
} from './preview-review.ts';
import { postSourceVideoTransport, SourceVideoTransportError } from './source-video-transport.ts';
import {atomicWriteFile} from '../plugins/project-store-durable.ts';
import {isResumablePreparation,publishOperationPreparation,tryLocalOperationLock} from './local-operation-lock.ts';
import type { SourceVideoTransportDiagnostic } from '../../shared/clipmentor-source-video.ts';

const args = process.argv.slice(2);
const options: Record<string, string> = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--video', '--input', '--out', '--operation','--expected-video-sha256'].includes(args[i]) || !args[i + 1]
    || options[args[i]]) throw new Error('Use --video MP4 --input JSON --out JSON --operation UUID [--expected-video-sha256 SHA256]');
  options[args[i]] = args[i + 1];
}
if (!['--video','--input','--out','--operation'].every(k=>options[k]) || ![4,5].includes(Object.keys(options).length)
  || (options['--expected-video-sha256']!==undefined&&!/^[a-f0-9]{64}$/.test(options['--expected-video-sha256']))
  || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(options['--operation'])) {
  throw new Error('All four arguments and a UUID v4 operation are required');
}
try { process.loadEnvFile(runtimeProfile().keystorePath); } catch { /* server environment is also supported */ }
seedKeystore(Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string]=>entry[1]!==undefined)));
const key = previewReviewCredential(process.env.ROOTIFY_GATEWAY_API_KEY ?? '');
if (!key) throw new Error('Preview review server credential unavailable');
const file=resolve(options['--video']);
const videoHash=await sha256File(file), videoBytes=(await stat(file)).size;
const sourceBindingMatches=options['--expected-video-sha256']===undefined||videoHash===options['--expected-video-sha256'];
const input = validatePreviewReviewInput(JSON.parse(await readFile(resolve(options['--input']), 'utf8')));
const output = resolve(options['--out']);
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
const ledger = join(dirname(output), `${options['--operation']}.operation.json`);
const account = createHash('sha256').update(key).digest('hex');
const release=tryLocalOperationLock(ledger+'.owner');
if(!release)throw Error('Preview review operation is in progress');
try{await review();}finally{release();}

async function review(){
const outputExists=await access(output).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
const original=await readFile(ledger,'utf8').catch(error=>{if(error.code==='ENOENT')return;throw error;});
const prior=original===undefined?undefined:JSON.parse(original);
if(prior&&!sourceBindingMatches)throw Error('Preview source binding mismatch; no request sent');
const priorVideo=prior&&prior.identity_version!=='video-logical-v1'?await readFile(file):undefined;
function locateRequest(format:PreviewReviewFormat){
  const prepared=previewReviewIdentity(videoHash,videoBytes,input,format);
  const request=priorVideo?buildPreviewReviewRequest(priorVideo,input,format).request_sha256:prepared.logical_request_sha256;
  const fingerprint=createHash('sha256').update(PREVIEW_REVIEW_ENDPOINT+prepared.version+request).digest('hex');
  return {format,prepared,fingerprint};
}
let bound:ReturnType<typeof locateRequest>; // Preflight before reserving or incurring charges.
try{bound=locateRequest('compact');}
catch(error){if(!prior)throw error;bound=locateRequest('original');}
if(prior&&prior.fingerprint!==bound.fingerprint&&bound.format!=='original')bound=locateRequest('original');
const {format,prepared,fingerprint}=bound;
if(!prior){
  if(outputExists)throw Error('Output already exists; no request sent');
  await publishOperationPreparation(ledger,{identity_version:'video-logical-v1',fingerprint,account,model_retry_policy:'no_automatic_retry'});
}else{
  if(prior.fingerprint!==fingerprint)throw Error('Operation belongs to different review input');
  if(prior.status==='completed'){
    console.log(JSON.stringify({status:'cached',output:prior.output,requests_sent:0}));
    return;
  }
  if(outputExists||!isResumablePreparation(prior)||prior.account!==account)throw Error('Prior attempt pending or failed; no automatic replay');
}
let diagnostic: SourceVideoTransportDiagnostic | undefined;
let attempts = 0;
let mediaTransfer: Awaited<ReturnType<typeof prepareVideoMedia>>['receipt'] | undefined;
try {
  const signal=AbortSignal.timeout(600_000);
  if(!sourceBindingMatches)throw new VideoMediaError('local_read','host_source_hash_mismatch');
  const media = await prepareVideoMedia(resolve(options['--video']), prepared.video_sha256, signal);
  mediaTransfer=media.receipt;
  const result = await reviewClipMentorPreview(media, input, { key, signal, format, post: async (body, credential, signal) => {
    signal.throwIfAborted();
    attempts=1;
    await atomicWriteFile(ledger, JSON.stringify({ status:'reserved',identity_version:'video-logical-v1',fingerprint,requests_attempted:attempts,model_retry_policy:'no_automatic_retry',media_transfer:mediaTransfer }));
    try {
      const {body:_wire,input:_frozenInput,...requestInfo}=buildPreviewReviewRequest(media,input,format);
      const archived=await externalCall({directory:dirname(output),kind:'video',purpose:'preview-continuous-review-v1',requestId:options['--operation'],
        identity:{operation:options['--operation'],fingerprint},signal,preserveErrors:true,
        execute:async childSignal=>{const r=await postSourceVideoTransport(body,credential,childSignal,options['--operation'],tmpdir());
          diagnostic=r.diagnostic;if(JSON.stringify(r.body)?.includes(credential)||echoesMediaSecret(r.body,media))throw Error('Preview review response rejected for credential echo');return {response:r,requestInfo,fingerprint};}});
      // Authoritative envelope includes both response and frozen request metadata.
      return archived.response;
    }
    catch (error) {
      if (error instanceof SourceVideoTransportError) diagnostic = error.diagnostic;
      throw error;
    }
  } });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await atomicWriteFile(ledger, JSON.stringify({ status: 'completed', identity_version:'video-logical-v1', fingerprint, requests_attempted: attempts, model_retry_policy:'no_automatic_retry', media_transfer:mediaTransfer, output }));
  console.log(JSON.stringify({ status: result.status, output, requests_attempted: 1, full_film_accepted: false }));
} catch (error) {
  const message = error instanceof Error && /^(Preview review|Invalid preview|Inline request)/.test(error.message)
    && !error.message.includes(key) ? error.message : 'Review failed; inspect operation record, no automatic retry';
  await atomicWriteFile(ledger, JSON.stringify({ status: 'failed', identity_version:'video-logical-v1', fingerprint, requests_attempted: attempts, model_retry_policy:'no_automatic_retry', media_transfer:mediaTransfer, error: message,
    ...(options['--expected-video-sha256']?{expected_video_sha256:options['--expected-video-sha256'],actual_video_sha256:videoHash}:{}),
    ...(error instanceof VideoMediaError?{media_failure:{stage:error.stage,code:error.code,metrics:error.metrics}}:{}), ...(diagnostic ? { transport_diagnostic: diagnostic } : {}) }));
  console.error(message);
  process.exitCode = 1;
}
}
