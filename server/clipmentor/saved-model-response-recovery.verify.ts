import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import fixture from '../../src/clipmentor/fixtures/copy-review-r171-contract.json';
import { observeSourceVideo, readSourceVideoReceipt, sourceVideoInput, type SourceVideoDependencies } from './source-video.ts';
import { reviewClipMentorCopy, type CopyReviewDependencies } from './copy-review.ts';
import { readSavedExternalResponse } from './external-call.ts';
import type { CopyReviewRequest } from '../../shared/clipmentor-copy-review.ts';

type Kind = 'source' | 'copy';
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const video = Buffer.from('local-source-video-fixture');
function requestFor(kind: Kind): CopyReviewRequest {
  const request = structuredClone(fixture.request) as CopyReviewRequest;
  request.projectId='offline-project';
  request.operationId = kind === 'source' ? 'ac981860-1614-4c3e-a665-f2427522e43c' : '6490827e-74bc-4cf0-a93e-8066b85a6f74';
  if (kind === 'source') request.source.hash = hash(video);
  for (const unit of request.packet.units) unit.source_context = {
    scope: 'frozen_task_scope', source_ranges: [[0, request.source.duration]],
    evidence_ids: request.packet.source_evidence.filter(e => e.time_seconds?.length).map(e => e.evidence_id), speech: 'unavailable',
  };
  return request;
}
function sourceResponse(request: CopyReviewRequest) {
  const input = sourceVideoInput(request);
  return { status: 200, body: { modelVersion: 'local-fixture-model', candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify({
    windows: input.units.flatMap(unit => unit.windows.map(window => ({ window_id: window.window_id,
      observed_sequence: 'Fixture continuous action; no production judgment', endpoint: 'Fixture endpoint unknown',
      evidence: [{ start_seconds: window.source_range_seconds[0], end_seconds: window.source_range_seconds[1], visible: 'Fixture visible action', audible: 'Unclear fixture audio' }],
    }))),
    lines: input.units.flatMap(unit => unit.lines.map(line => ({ unit_id: unit.unit_id, line_id: line.line_id,
      status: 'insufficient_evidence', reason: 'Fixture cannot establish edited narration sync', window_ids: [unit.windows[0].window_id] }))),
    limitations: ['Fixture only; semantic and production approval unverified'],
  }) }] } }] } };
}
function dependencies(directory: string, request: CopyReviewRequest, dispatch: () => Promise<void>, verifyHash?: () => void) {
  let frames = 0;
  const shared = { directory, resolve: () => '/local-fixture-master', hash: async () => { verifyHash?.(); return request.source.hash; } };
  const source: SourceVideoDependencies = { ...shared, key: 'local-fixture-only', read: async () => video,
    size: async () => video.length, audioPresent: async () => true,
    post: async () => { await dispatch(); return sourceResponse(request); } };
  const copy: CopyReviewDependencies = { ...shared, frame: async () => { frames++; return Buffer.from('fixture-image').toString('base64'); },
    run: async () => { await dispatch(); return structuredClone(fixture.raw_review); } };
  return { source, copy, frames: () => frames };
}
async function read(kind: Kind, request: CopyReviewRequest, deps: ReturnType<typeof dependencies>) {
  return kind === 'source' ? readSourceVideoReceipt(request.operationId, request.projectId, deps.source)
    : reviewClipMentorCopy(request, deps.copy, undefined, true);
}
async function assertBlocked(kind: Kind, request: CopyReviewRequest, deps: ReturnType<typeof dependencies>) {
  if (kind === 'source') {
    const result = await readSourceVideoReceipt(request.operationId, request.projectId, deps.source);
    assert.equal(result.status, 'failed'); assert.equal(result.result, undefined); assert.equal(result.requestsAttempted, 1);
  } else await assert.rejects(reviewClipMentorCopy(request, deps.copy, undefined, true), /review_cancelled_or_timed_out/);
}

async function resumeSourceThroughHost(request:CopyReviewRequest,source:SourceVideoDependencies) {
  const {clipMentorSourceVideoPlugin}=await import('../plugins/clipmentor-source-video');
  const {openHeadlessEditor}=await import('./headless-editor');
  const {MemoryPersistence,projectDoc}=await import('../external-agent/offline-runtime.verify-fixtures');
  let handler:((req:IncomingMessage,res:ServerResponse)=>void)|undefined;
  const configure=clipMentorSourceVideoPlugin(source).configureServer;
  assert.equal(typeof configure,'function');
  if(typeof configure!=='function')throw Error('Missing route');
  configure({middlewares:{use:(_path:string,fn:typeof handler)=>{handler=fn;}}} as never);
  const server=createServer((req,res)=>handler!(req,res));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try{
    const actions:unknown[]=[];
    const editor=await openHeadlessEditor({projectId:request.projectId,runId:request.authorRunId,origin,
      review:{provider:'openai',model:'fixture',origin,apiMode:'responses'},persistence:new MemoryPersistence(projectDoc()),browserConnected:()=>false,
      fetch:async(url,init)=>{actions.push(JSON.parse(String(init?.body)).action);return fetch(url,init);},
      effect:async(_kind,key,_work,recover)=>{assert.equal(key,request.operationId);assert(recover);return recover(key);}});
    try{
      const response=await editor.context.hostFetch!('/api/clipmentor/observe-video',{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});
      assert.equal(response.status,200);
      assert.deepEqual(actions,['read_receipt','resume_preparation']);
      return await response.json();
    }finally{await editor.close();}
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}

const workerKind = process.argv[2];
if (workerKind?.endsWith('-crash-worker')) {
  const kind: Kind = workerKind.startsWith('source-') ? 'source' : 'copy';
  const directory = process.argv[3], request = requestFor(kind);
  await mkdir(directory, { recursive: true });
  let hashReads = 0;
  const deps = dependencies(directory, request, async () => {
    await appendFile(join(directory, 'dispatch.ndjson'), 'local-fixture\n');
    if(workerKind.includes('-sent-'))process.kill(process.pid,'SIGKILL');
  }, () => {
    hashReads++;
    // The raw envelope and reserved parent have been saved, but no completed
    // receipt exists. Exit bypasses catch/finally in the real adapter.
    if (hashReads === (kind === 'source' ? 2 : 3)) process.exit(73);
  });
  if(workerKind.includes('-prepare-')){
    deps.source.read=async()=>{process.kill(process.pid,'SIGKILL');return video;};
    deps.copy.frame=async(_file,_seconds,output)=>{
      await writeFile(output,'interrupted fixture frame');
      process.kill(process.pid,'SIGKILL');
      return '';
    };
  }
  if (kind === 'source') await observeSourceVideo(request, deps.source);
  else await reviewClipMentorCopy(request, deps.copy);
  process.exit(74);
}

const root = await mkdtemp(join(tmpdir(), 'clipmentor-saved-model-read-'));
try {
  for (const kind of ['source', 'copy'] as const) {
    {
    const prepareDirectory=join(root,`${kind}-prepare-crash`),prepareRequest=requestFor(kind);
    const preparing=spawnSync(process.execPath,['--import','tsx',fileURLToPath(import.meta.url),`${kind}-prepare-crash-worker`,prepareDirectory],
      {cwd:process.cwd(),encoding:'utf8',timeout:20_000});
    assert.equal(preparing.signal,'SIGKILL',preparing.stderr);
    const prepareLedger=join(prepareDirectory,`${prepareRequest.operationId}.json`);
    const interrupted=await readFile(prepareLedger,'utf8');
    assert.equal(JSON.parse(interrupted).status,'preparing');
    assert.equal(JSON.parse(interrupted).requests_attempted,0);
    await assert.rejects(readFile(join(prepareDirectory,'dispatch.ndjson')), {code:'ENOENT'});
    let preparedCalls=0;
    const prepareDeps=dependencies(prepareDirectory,prepareRequest,async()=>{preparedCalls++;});
    const submit=(request=prepareRequest)=>kind==='source'?observeSourceVideo(request,prepareDeps.source,undefined,true)
      :reviewClipMentorCopy(request,prepareDeps.copy,undefined,'resume_preparation');
    await assert.rejects(submit({...prepareRequest,operationId:'557ee016-1bdd-4f8f-a46f-17cd60362092'}));
    await assert.rejects(submit({...prepareRequest,authorRunId:'different-author'}));
    assert.equal(await readFile(prepareLedger,'utf8'),interrupted);
    if(kind==='source'){
      await assert.rejects(observeSourceVideo(prepareRequest,{...prepareDeps.source,key:'different-account'},undefined,true));
    }else{
      await writeFile(prepareLedger,JSON.stringify({...JSON.parse(interrupted),criteria_digest:'f'.repeat(64)}));
      await assert.rejects(submit());
      await writeFile(prepareLedger,interrupted);
    }
    const legacy=JSON.parse(interrupted);delete legacy.preparation_protocol;
    await writeFile(prepareLedger,JSON.stringify(legacy));
    await assert.rejects(submit());
    assert.equal(preparedCalls,0);
    await writeFile(prepareLedger,interrupted);
    const entered=Promise.withResolvers<void>(),releasePrep=Promise.withResolvers<void>();
    const readSource=prepareDeps.source.read,readFrame=prepareDeps.copy.frame;
    prepareDeps.source.read=async()=>{entered.resolve();await releasePrep.promise;return readSource('local');};
    prepareDeps.copy.frame=async(...args)=>{entered.resolve();await releasePrep.promise;return readFrame(...args);};
    const pending=kind==='source'?resumeSourceThroughHost(prepareRequest,prepareDeps.source):submit();
    await Promise.race([entered.promise,pending.then(()=>{throw Error('Preparation did not wait for its owner');})]);
    try{
      await assert.rejects(submit());
      assert.equal(preparedCalls,0);
      assert.equal(await readFile(prepareLedger,'utf8'),interrupted);
    }finally{releasePrep.resolve();}
    const resumed=await pending;
    assert.equal(resumed.requestsAttempted,1);
    assert.equal(preparedCalls,1);
    await submit();
    assert.equal(preparedCalls,1);
    assert.equal((await readdir(prepareDirectory)).some(name=>name.startsWith('frames-')),false);

    const sentDirectory=join(root,`${kind}-sent-crash`);
    const sent=spawnSync(process.execPath,['--import','tsx',fileURLToPath(import.meta.url),`${kind}-sent-crash-worker`,sentDirectory],
      {cwd:process.cwd(),encoding:'utf8',timeout:20_000});
    assert.equal(sent.signal,'SIGKILL',sent.stderr);
    const sentLedger=join(sentDirectory,`${prepareRequest.operationId}.json`),sentBefore=await readFile(sentLedger,'utf8');
    const sentDeps=dependencies(sentDirectory,prepareRequest,async()=>{preparedCalls++;});
    assert.equal(JSON.parse(sentBefore).status,'reserved');
    await assert.rejects(kind==='source'?observeSourceVideo(prepareRequest,sentDeps.source,undefined,true)
      :reviewClipMentorCopy(prepareRequest,sentDeps.copy,undefined,'resume_preparation'));
    assert.equal(await readFile(sentLedger,'utf8'),sentBefore);
    assert.equal(preparedCalls,1);
    }

    const request = requestFor(kind), directory = join(root, `${kind}-late`);
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let calls = 0;
    const deps = dependencies(directory, request, async () => { calls++; started.resolve(); await release.promise; });
    const controller = new AbortController();
    const pending = kind === 'source' ? observeSourceVideo(request, deps.source, controller.signal)
      : reviewClipMentorCopy(request, deps.copy, controller.signal);
    const rejected = assert.rejects(pending);
    await started.promise; controller.abort(); await rejected;
    const parent = join(directory, `${request.operationId}.json`), frozen = await readFile(parent, 'utf8');
    await assertBlocked(kind, request, deps);
    release.resolve();
    for (let at = 0; at < 100; at++) {
      if (await readSavedExternalResponse(directory, request.operationId)) break;
      await delay(5);
    }
    assert(await readSavedExternalResponse(directory, request.operationId), 'complete late raw must actually be durable');
    const frameCount = deps.frames();
    const result = await read(kind, request, deps) as any;
    if (kind === 'source') {
      assert.equal(result.status, 'completed'); assert.equal(result.local_response_recovery, true);
      assert.equal(result.original_operation_status, 'failed'); assert.equal(result.requestsSent, 0);
      assert.equal(result.result.validation.status, 'valid'); assert.equal(result.complete_film_accepted, false);
      assert.equal(result.result.raw_observation.lines[0].status, 'insufficient_evidence');
    } else {
      assert.equal(result.cached, true); assert.equal(result.receipt.verdict, 'insufficient_evidence');
      assert.deepEqual(result.receipt.units.map((unit: any) => unit.group_checks), fixture.raw_review.copy_units.map(unit => unit.group_checks),
        'original negative/unknown reviewer judgments stay intact');
    }
    assert.equal(result.requestsAttempted, 1); assert.equal(calls, 1); assert.equal(deps.frames(), frameCount);
    assert.equal(await readFile(parent, 'utf8'), frozen, 'read recovery must preserve the original cancelled operation');
    await read(kind, request, deps); assert.equal(calls, 1); assert.equal(deps.frames(), frameCount);
    const changed = { ...deps, source: { ...deps.source, hash: async () => 'b'.repeat(64) }, copy: { ...deps.copy, hash: async () => 'b'.repeat(64) } };
    await assertBlocked(kind, request, changed);
    if (kind === 'source') await assert.rejects(readSourceVideoReceipt(request.operationId, 'foreign-project', deps.source));
    else await assert.rejects(reviewClipMentorCopy({ ...request, projectId: 'foreign-project' }, deps.copy, undefined, true));

    const externalDirectory = join(directory, 'external-calls');
    const name = (await readdir(externalDirectory)).find(name => /^[a-f0-9]{64}\.response$/.test(name))!;
    const rawPath = join(externalDirectory, name), rawText = await readFile(rawPath, 'utf8');
    const rowPath = rawPath.replace('.response', '.json'), rowText = await readFile(rowPath, 'utf8');
    await rm(rawPath); await assertBlocked(kind, request, deps); await writeFile(rawPath, rawText);
    await writeFile(rawPath, '{}'); await assertBlocked(kind, request, deps); await writeFile(rawPath, rawText);
    // A self-consistent archive for a different semantic identity cannot stand in
    // for the exact reserved operation merely because its raw JSON is parseable.
    const envelope = JSON.parse(rawText); envelope.value.fingerprint = 'f'.repeat(64);
    envelope.value_sha256 = hash(JSON.stringify(envelope.value));
    const wrongRaw = JSON.stringify(envelope), row = JSON.parse(rowText); row.response_sha256 = hash(wrongRaw);
    await writeFile(rawPath, wrongRaw); await writeFile(rowPath, JSON.stringify(row));
    await assertBlocked(kind, request, deps);
    await writeFile(rawPath, rawText); await writeFile(rowPath, rowText);
    const invalid = JSON.parse(rawText);
    if (kind === 'source') invalid.value.body.candidates[0].finishReason = 'MAX_TOKENS';
    else invalid.value.raw_review = {};
    invalid.value_sha256 = hash(JSON.stringify(invalid.value));
    const invalidRaw = JSON.stringify(invalid), invalidRow = JSON.parse(rowText); invalidRow.response_sha256 = hash(invalidRaw);
    await writeFile(rawPath, invalidRaw); await writeFile(rowPath, JSON.stringify(invalidRow));
    await assertBlocked(kind, request, deps);
    await writeFile(rawPath, rawText); await writeFile(rowPath, rowText);
    const legacy = JSON.parse(frozen);
    delete legacy[kind === 'source' ? 'source_src' : 'prompt_sha256'];
    await writeFile(parent, JSON.stringify(legacy)); await assertBlocked(kind, request, deps); await writeFile(parent, frozen);
    const drifting = { ...deps, source: { ...deps.source, hash: async () => { await writeFile(parent, frozen + '\n'); return request.source.hash; } },
      copy: { ...deps.copy, hash: async () => { await writeFile(parent, frozen + '\n'); return request.source.hash; } } };
    await assertBlocked(kind, request, drifting); await writeFile(parent, frozen);
    assert.equal(calls, 1); assert.equal(deps.frames(), frameCount); assert.equal(await readFile(parent, 'utf8'), frozen);

    const crashDirectory = join(root, `${kind}-crash`);
    const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), `${kind}-crash-worker`, crashDirectory],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000 });
    assert.equal(child.status, 73, child.stderr);
    const crashParent = join(crashDirectory, `${request.operationId}.json`), crashed = await readFile(crashParent, 'utf8');
    assert.equal(JSON.parse(crashed).status, 'reserved');
    const crashDeps = dependencies(crashDirectory, request, async () => { throw Error('No second dispatch allowed'); });
    const recovered = await read(kind, request, crashDeps) as any;
    assert.equal(kind === 'source' ? recovered.status : recovered.receipt.verdict, kind === 'source' ? 'completed' : 'insufficient_evidence');
    assert.equal(recovered.requestsAttempted, 1); assert.equal(crashDeps.frames(), 0);
    assert.equal(await readFile(crashParent, 'utf8'), crashed);
    assert.equal((await readFile(join(crashDirectory, 'dispatch.ndjson'), 'utf8')).trim().split('\n').length, 1);
  }
  console.log('Saved source/copy response recovery: SIGKILL before/after dispatch, real source host/HTTP resume, concurrent owner, legacy/wrong/missing binding, late raw and immutable original verdicts passed');
} finally { await rm(root, { recursive: true, force: true }); }
