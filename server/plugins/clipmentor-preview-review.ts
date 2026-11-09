import {readSavedExternalResponse} from '../clipmentor/external-call';
import { getKey } from '../keystore';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { editorCredentialAuthorized } from '../editor-auth';
import { resolveUploadFile, isSafeUploadName, uploadDir } from '../media-dir';
import { previewEditBridge, executePreviewMaterial, type PreviewEditDeps } from '../clipmentor/preview-edit';
import { runtimeProfile, type RuntimeProfile } from '../runtime-profile';
import { sha256File } from '../../shared/node-content-hash';
import { safeSourceTransportDiagnostic } from '../../shared/clipmentor-source-video';
import { readJson } from '../agent-runs/request';
import { PREVIEW_REVIEW_ENDPOINT, interpretPreviewResponse, previewReviewIdentity, evaluatePreviewTeachingJudgment, parsePreviewTeachingJudgment, validatePreviewReviewInput } from '../clipmentor/preview-review';
import { checkPreviewTimelineObservations, previewReviewWindows } from '../clipmentor/preview-timeline-check';
import { boundVisualCriteria,visualReferenceFrames,type BoundVisualCriteria } from '../clipmentor/visual-done-criteria';
import { productionReviewRequirements } from '../clipmentor/production-task';
import { copyReviewDependencies } from '../clipmentor/copy-review';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const project = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../clipmentor/preview-review-cli.mts', import.meta.url));
const loader = fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url));

export interface PreviewBridgeDependencies {
  directory: string;
  resolve: (name: string) => string | null;
  run: (args: string[], signal?: AbortSignal) => Promise<void>;
  visualCriteria?(projectId:string):Promise<BoundVisualCriteria|undefined>;
}
function dependencies(): PreviewBridgeDependencies {
  return { directory: join(runtimeProfile().rootDir, 'clipmentor-preview-reviews'), resolve: resolveUploadFile,
    async visualCriteria(projectId){return boundVisualCriteria(await productionReviewRequirements(projectId));},
    run: async (args, signal) => { await execute(process.execPath, ['--import', loader, cli, ...args],
      { signal, timeout: 660_000, maxBuffer: 64 * 1024, windowsHide: true,
        env:{...process.env,...Object.fromEntries((['ROOTIFY_GATEWAY_API_KEY','CLIPMENTOR_VIDEO_TRANSPORT','CLIPMENTOR_R2_ACCOUNT_ID','CLIPMENTOR_R2_BUCKET','CLIPMENTOR_R2_API_TOKEN','PROXY_URL','R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET','R2_ENABLED'] as const)
          .map(name=>[name,getKey(name)]))} }); } };
}

/** Reads honor references and configured roots; new files go to the writable root only. */
export function previewEditDependencies(profile: RuntimeProfile = runtimeProfile(), configuredMediaDir?: string): PreviewEditDeps {
  return { directory: join(profile.rootDir, 'clipmentor-preview-edits'),
    resolve: name => resolveUploadFile(name, profile, configuredMediaDir),
    output: name => isSafeUploadName(name) ? join(uploadDir(profile, configuredMediaDir), name) : null,
    execute: executePreviewMaterial };
}

/** Bind a single CLI operation to a project and immutable preview. No edits or approval writes. */
export async function previewBridge(body: Record<string, unknown>, deps: PreviewBridgeDependencies, signal?: AbortSignal) {
  if (!project(body.projectId) || typeof body.operationId !== 'string' || !UUID.test(body.operationId)
    || typeof body.action !== 'string' || !['request', 'read'].includes(body.action)) throw new Error('Invalid preview operation');
  const operationId = body.operationId;
  const directory = join(deps.directory, body.projectId, operationId);
  const bindingFile = join(directory, 'binding.json'), output = join(directory, 'result.json');
  const manifestFile = join(directory, 'execution-manifest.json');
  const read = async () => {
    const binding = JSON.parse(await readFile(bindingFile, 'utf8'));
    if (binding.projectId !== body.projectId || binding.operationId !== body.operationId) throw new Error('Invalid binding');
    let result = await readFile(output, 'utf8').then(JSON.parse).catch(() => null);
    let locallyRecovered=false;
    if(!result){
      try{
        const saved=await readSavedExternalResponse(directory,operationId) as {fingerprint:string;requestInfo:Record<string,any>;response:{status:number;body:unknown}}|undefined;
        if(!saved)throw Error('Saved response unavailable');
        const input=validatePreviewReviewInput(JSON.parse(await readFile(join(directory,'input.json'),'utf8')));
        const info=saved.requestInfo;
        if(!info||info.video_sha256!==binding.videoSha256||info.input_sha256!==binding.inputSha256||digest(input)!==binding.inputSha256)throw Error('Saved raw binding mismatch');
        const identity=previewReviewIdentity(binding.videoSha256,info.media_transfer?.bytes,input);
        const expected=createHash('sha256').update(PREVIEW_REVIEW_ENDPOINT+identity.version+identity.logical_request_sha256).digest('hex');
        if(saved.fingerprint!==expected||info.version!==identity.version||info.instruction_sha256!==identity.instruction_sha256)throw Error('Saved raw method mismatch');
        if(!/^[a-f0-9]{64}$/.test(info.request_sha256)||info.media_transfer?.sha256!==binding.videoSha256)throw Error('Saved wire/media binding missing');
        result=interpretPreviewResponse(saved.response,{...info,input} as Parameters<typeof interpretPreviewResponse>[1],getKey('ROOTIFY_GATEWAY_API_KEY'));locallyRecovered=true;
      }catch{/* Missing/invalid raw is never a new submission or an approval. */}
    }
    if (result && (result.video_sha256 !== binding.videoSha256 || result.input_sha256 !== binding.inputSha256
      || result.full_film_accepted !== false)) throw new Error('Invalid preview receipt');
    if (body.videoSha256 !== undefined && body.videoSha256 !== binding.videoSha256) throw new Error('Invalid preview identity');
    // Derived checks never replace the immutable model result or write an approval.
    const blockers: string[] = [];
    let timelineCheck: ReturnType<typeof checkPreviewTimelineObservations> | null = null;
    let manifestBinding = 'missing';
    let manifestSha256: string | null = null;
    let evaluated: ReturnType<typeof evaluatePreviewTeachingJudgment> | null = null;
    if (!result) blockers.push('review_not_completed');
    else {
      try {
        const input = validatePreviewReviewInput(JSON.parse(await readFile(join(directory, 'input.json'), 'utf8')));
        if (digest(input) !== binding.inputSha256) throw new Error('Input binding');
        if (typeof result.raw_public_judgment !== 'string'
          || JSON.stringify(parsePreviewTeachingJudgment(result.raw_public_judgment)) !== JSON.stringify(result.judgment)) throw new Error('Raw receipt binding');
        evaluated = evaluatePreviewTeachingJudgment(result.judgment, input);
        blockers.push(...evaluated.issues);
        if (result.status !== 'pass') blockers.push('saved_review_not_passed');
        let manifest: unknown;
        if (typeof binding.executionManifestSha256 === 'string') {
          manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
          manifestSha256 = digest(manifest);
          if (manifestSha256 !== binding.executionManifestSha256
            || (body.executionManifest !== undefined && digest(body.executionManifest) !== manifestSha256)) throw new Error('Manifest binding');
          manifestBinding = 'frozen_at_request';
        } else if (body.executionManifest !== undefined) {
          if (body.videoSha256 !== binding.videoSha256) throw new Error('Legacy manifest requires preview identity');
          manifest = body.executionManifest;
          manifestSha256 = digest(manifest);
          manifestBinding = 'read_supplied_not_frozen_at_request';
          blockers.push('execution_manifest_not_frozen_at_request');
        }
        if (manifest === undefined) blockers.push('execution_manifest_missing');
        else {
          timelineCheck = checkPreviewTimelineObservations(manifest, result, input);
          for (const u of timelineCheck.units) blockers.push(...u.issues.map(i => `${u.unit_id}:${i.code}`));
        }
      } catch { blockers.push('saved_evidence_invalid_or_binding_mismatch'); }
    }
    const canUse = !!result && evaluated?.status === 'pass' && timelineCheck?.status === 'no_detected_conflict'
      && manifestBinding === 'frozen_at_request' && blockers.length === 0;
    const rawUnits = object(result?.judgment) && Array.isArray(result.judgment.continuity) ? result.judgment.continuity : [];
    const effectiveReview = { status: canUse ? 'pass' : 'review_required', can_use_as_pass: canUse,
      blockers: [...new Set(blockers)], manifest_binding: manifestBinding, manifest_sha256: manifestSha256,
      unit_results: (evaluated?.unit_results ?? []).map(u => {
        const original = rawUnits.find((r: unknown) => object(r) && r.unit_id === u.unit_id);
        return { unit_id: u.unit_id, model_narrative: u.model_narrative,
          model_teaching: object(original) && object(original.teaching) ? original.teaching.status : 'not_validated',
          status: canUse ? 'pass' : 'review_required', issues: [...new Set([...u.issues,
            ...(timelineCheck?.units.find(t => t.unit_id === u.unit_id)?.issues.map(i => i.code) ?? [])])] };
      }),
      full_film_accepted: false };
    // Do not duplicate every raw observation's clipped scene table: it can push
    // the gate and second unit out of the model's bounded tool-result context.
    // All original observations remain intact in result.judgment below.
    const timelineReadback = timelineCheck && { ...timelineCheck, units: timelineCheck.units.map(u => ({
      unit_id: u.unit_id, status: u.status, actual_segments: u.actual_segments,
      cut_checks: u.cut_checks.map(({ matching_observation_paths: _paths, ...fact }) => fact),
      scheduled_audio_gaps: u.scheduled_audio_gaps, issues: u.issues,
    })) };
    const ledger = await readFile(join(directory, `${body.operationId}.operation.json`), 'utf8').then(JSON.parse).catch(() => null);
    const gatewayFailure=ledger?.status==='failed'&&typeof ledger.error==='string'
      ? /^Preview review HTTP ([0-9]{3}); attempt consumed, no automatic retry$/.exec(ledger.error) : null;
    const attempted = ledger?.requests_attempted === 0 ? 0 : 1;
    const failed = !result && ledger?.status === 'failed' && [0,1].includes(ledger.requests_attempted);
    const diagnostic = failed ? safeSourceTransportDiagnostic(ledger.transport_diagnostic,'',operationId) : undefined;
    return { operationId: body.operationId, projectId: body.projectId, videoSha256: binding.videoSha256,
      ...(binding.visualCriteriaDigest?{visualCriteriaDigest:binding.visualCriteriaDigest}:{}),
      ...(failed?{receipt_persisted:true}:{}), ...(diagnostic?{transport_diagnostic:diagnostic}:{}),
      status: result ? 'completed' : ledger?.status ?? 'reserved',...(locallyRecovered?{local_response_recovery:true,original_operation_status:ledger?.status}:{}),
      ...(gatewayFailure&&!result?{upstream_http_status:Number(gatewayFailure[1])}:{}), effective_review: effectiveReview, timeline_check: timelineReadback, result,
      requestsAttempted: attempted, model_retry_policy:ledger?.model_retry_policy, requestsSent: 0, full_film_accepted: false, scope: 'rendered_preview_continuous_review' };
  };
  if (body.action === 'read') {
    if (Object.keys(body).some(k => !['action','projectId','operationId','videoSha256','executionManifest'].includes(k))) throw new Error('Invalid receipt read');
    return read();
  }
  if (Object.keys(body).some(k => !['action','projectId','operationId','maxRequests','src','videoSha256','input','executionManifest'].includes(k))
    || body.maxRequests !== 1 || typeof body.src !== 'string' || !/^\/media\/uploads\/[^/?#]+\.mp4$/.test(body.src)
    || typeof body.videoSha256 !== 'string' || !SHA.test(body.videoSha256) || !object(body.input)
    || Object.keys(body.input).some(k => !['duration_seconds','points','units','reference_text'].includes(k))) throw new Error('One authorized immutable preview required');
  const input = validatePreviewReviewInput(body.input);
  const criteria=await deps.visualCriteria?.(body.projectId);
  if(criteria){
    if(body.executionManifest===undefined)throw Error('Visual criteria require saved preview windows');
    const frames=await visualReferenceFrames(criteria,{...copyReviewDependencies(),resolve:deps.resolve});
    input.visual_criteria=frames.map(({criterion,base64})=>{
      const window=input.units.find(u=>u.unit_id==='delivery/'+criterion.sectionId)?.output_range_seconds;
      const point_id='delivery/criterion/'+criterion.id;
      if(!window||input.points.some(p=>p.point_id===point_id)||input.units.some(u=>u.unit_id===point_id))throw Error('Visual criterion section missing from preview');
      input.points.push({point_id,teaching_goal_zh:criterion.question,product_relevance:'用户交付要求'});
      input.units.push({unit_id:point_id,point_ids:[point_id],output_range_seconds:window});
      return {point_id,quote:criterion.quote,question:criterion.question,fileName:criterion.reference.fileName,seconds:criterion.reference.seconds,base64};
    });
  }
  const manifestHash = body.executionManifest === undefined ? undefined : digest(body.executionManifest);
  if (body.executionManifest !== undefined) {
    previewReviewWindows(body.executionManifest,input);
  }
  const name = body.src.slice('/media/uploads/'.length);
  const video = isSafeUploadName(name) ? deps.resolve(name) : null;
  if (!video || (await stat(video)).size > 70_000_000 || await sha256File(video) !== body.videoSha256) throw new Error('Preview hash or file invalid');
  // Deterministic original-byte preflight; the CLI selects the configured transport without re-encoding.
  const prepared = previewReviewIdentity(body.videoSha256, (await stat(video)).size, input);
  if (prepared.video_sha256 !== body.videoSha256) throw new Error('Preview changed during preflight');
  const fingerprint = digest({ src: body.src, videoSha256: body.videoSha256, input,...(criteria?{visualCriteriaDigest:criteria.digest}:{}),
    ...(manifestHash === undefined ? {} : { executionManifestSha256: manifestHash }) });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try { await writeFile(bindingFile, JSON.stringify({ projectId: body.projectId, operationId: body.operationId,
    fingerprint, videoSha256: body.videoSha256, inputSha256: prepared.input_sha256,...(criteria?{visualCriteriaDigest:criteria.digest}:{}),
    ...(manifestHash === undefined ? {} : { executionManifestSha256: manifestHash }) }), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const prior = JSON.parse(await readFile(bindingFile, 'utf8'));
    if (prior.fingerprint !== fingerprint) throw new Error('Operation belongs to another input');
    return { ...await read(), cached: true }; // Never re-launch a failed/unknown operation.
  }
  const inputFile = join(directory, 'input.json');
  await writeFile(inputFile, JSON.stringify(input), { flag: 'wx', mode: 0o600 });
  if (manifestHash !== undefined) await writeFile(manifestFile, JSON.stringify(body.executionManifest), { flag: 'wx', mode: 0o600 });
  try { await deps.run(['--video',video,'--expected-video-sha256',body.videoSha256 as string,'--input',inputFile,'--out',output,'--operation',body.operationId], signal); }
  catch {
    const saved=await read();
    return saved.requestsAttempted===0 ? {...saved,requestsSent:0,requestOutcome:'not_submitted',error:'Media preparation failed; no model request sent'}
      : {...saved,requestsSent:null,requestOutcome:'unknown',error:'Continuous review failed or unknown; attempt consumed, no retry'};
  }
  return { ...await read(), requestsSent: 1 };
}

export function clipMentorPreviewReviewPlugin(deps?: PreviewBridgeDependencies): Plugin {
  return { name: 'clipmentor-preview-review', configureServer(server) {
    server.middlewares.use('/api/clipmentor/preview-edit', async (req:IncomingMessage,res:ServerResponse) => {
      const send=(code:number,body:unknown)=>{res.statusCode=code;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(body));};
      if(req.method!=='POST'||!editorCredentialAuthorized(req,true)) {req.resume();send(403,{error:'Authorized editor POST required'});return;}
      try {const body=await readJson(req,8*1024*1024);
        send(200,await previewEditBridge(body,previewEditDependencies()));
      } catch {send(409,{error:'Preview revision refused: authorization, project, source or attempt binding mismatch. Existing quality gate remains closed.'});}
    });

    server.middlewares.use('/api/clipmentor/review-preview', async (req: IncomingMessage, res: ServerResponse) => {
      const headers=(status:number)=>{if(!res.headersSent){res.statusCode=status;
        res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');}};
      const send = (status: number, value: unknown) => { if (!res.destroyed) { headers(status);res.end(JSON.stringify(value)); } };
      if (req.method !== 'POST') { req.resume(); send(405,{error:'POST required'}); return; }
      if (!editorCredentialAuthorized(req,true)) { req.resume(); send(401,{error:'Editor origin required'}); return; }
      if (!String(req.headers['content-type']).startsWith('application/json')) { req.resume(); send(415,{error:'JSON required'}); return; }
      const abort = new AbortController();
      const close = () => { if (!res.writableEnded) abort.abort(); };
      res.on('close', close);
      try {
        const body=await readJson(req,256*1024),original=deps??dependencies();
        // Start only after bridge preflight/reservation, at the existing single
        // run boundary. JSON permits whitespace before the terminal receipt.
        // This keeps the local fetch alive without a second provider request.
        const waiting={...original,run:async(args:string[],signal?:AbortSignal)=>{
          headers(200);res.write('\n');
          const heartbeat=setInterval(()=>{if(!res.destroyed&&!res.writableEnded)res.write('\n');},20_000);
          heartbeat.unref();
          try{await original.run(args,signal);}finally{clearInterval(heartbeat);}
        }};
        send(200,await previewBridge(body,waiting,abort.signal));
      }
      catch { send(400,{error:'Preview review unavailable or invalid; retain operationId, no retry. No credential or local path is returned.'}); }
      finally { res.off('close',close); }
    });
  } };
}
