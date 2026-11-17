import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transcribeClipMentorSource, readClipMentorSourceAsr } from './clipmentor-funasr.ts';

const operationId = '73665a13-1e59-4f4c-b2be-a323d4a875bd';
const sourceHash = 'a'.repeat(64);
const request = { src: '/media/uploads/crash-master.mp4', expectedSourceHash: sourceHash,
  language: 'auto', operationId, maxRequests: 3, projectId: 'offline-project' };
const readRequest = { action: 'read', operationId, src: request.src,
  expectedSourceHash: sourceHash, projectId: request.projectId };
const workerMode = process.argv[2];

function dependencies(directory: string, fetcher: typeof fetch) {
  return { directory, key: () => 'local-fixture-key',
    endpoint: () => 'https://fixture.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    resolve: () => '/local-fixture-master.mp4', hash: async () => sourceHash,
    probe: async () => ({ duration: 601, fps: 30, bytes: 123 }),
    encode: async (_file: string, start: number, _end: number, _output: string) => new Uint8Array([Math.round(start) % 255, 1, 2]), fetch: fetcher };
}

if(workerMode==='asr-crash-in-preparation'){
  const deps=dependencies(process.argv[3],(async()=>{throw Error('Unexpected provider request');}) as typeof fetch);
  deps.encode=async(_file,start,_end,output)=>{
    await writeFile(output,Buffer.from([start,1,2]));
    process.kill(process.pid,'SIGKILL');
    return new Uint8Array();
  };
  await transcribeClipMentorSource(request,deps);
  process.exit(74);
}

if (workerMode === 'asr-crash-before-response' || workerMode === 'asr-crash-after-raw') {
  let sent = 0;
  const originalJson = Response.prototype.json;
  Response.prototype.json = function () {
    // externalFetch has already durably archived the second response before the
    // adapter calls json(). Exit without running its catch/finally handlers.
    if (workerMode === 'asr-crash-after-raw' && sent === 2) process.exit(73);
    return originalJson.call(this);
  };
  await transcribeClipMentorSource(request, dependencies(process.argv[3], (async () => {
    sent++;
    if (workerMode === 'asr-crash-before-response' && sent === 2) process.exit(73);
    return Response.json({ output: { sentence: { words: [
      { text: `chunk-${sent}-fixture`, begin_time: 100, end_time: 900 },
    ] } } });
  }) as typeof fetch));
  process.exit(74);
}

async function verifyAsrHostRecovery(deps:ReturnType<typeof dependencies>) {
  const {clipMentorFunAsrPlugin}=await import('./clipmentor-funasr');
  const {openHeadlessEditor}=await import('../clipmentor/headless-editor');
  const {projectDoc,MemoryPersistence}=await import('../external-agent/offline-runtime.verify-fixtures');
  let handler:((req:IncomingMessage,res:ServerResponse)=>void)|undefined;
  const configure=clipMentorFunAsrPlugin(deps).configureServer;
  if(typeof configure!=='function')throw Error('Missing ASR route');
  configure({middlewares:{use:(_path:string,fn:typeof handler)=>{handler=fn;}}} as never);
  const server=createServer((req,res)=>handler!(req,res));
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  try{
    const actions:string[]=[];
    const editor=await openHeadlessEditor({projectId:request.projectId,runId:'fixture-asr-recovery',origin,
      review:{provider:'openai',model:'fixture',origin,apiMode:'responses'},persistence:new MemoryPersistence(projectDoc()),browserConnected:()=>false,
      fetch:async(url,init)=>{actions.push(JSON.parse(String(init?.body)).action);return fetch(url,init);},
      effect:async(_kind,key,_work,recover)=>{assert.equal(key,request.operationId);assert(recover);return recover(key);}});
    try{
      const send=()=>editor.context.hostFetch!('/api/clipmentor/transcribe-source',{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});
      const first=await (await send()).json();
      const second=await (await send()).json();
      assert.equal(first.status,'completed');
      assert.equal(second.status,'completed');
      assert.deepEqual(first.words,second.words);
      assert.deepEqual(actions,['read','resume_preparation','read']);
    }finally{await editor.close();}
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}

export async function verifyAsrCrashRecovery(root: string): Promise<void> {
  const preparing=join(root,'asr-crash-in-preparation');
  const interrupted=spawnSync(process.execPath,['--import','tsx',fileURLToPath(import.meta.url),'asr-crash-in-preparation',preparing],
    {cwd:process.cwd(),encoding:'utf8',timeout:20_000});
  assert.equal(interrupted.signal,'SIGKILL',interrupted.stderr);
  const preparingLedger=join(preparing,`${operationId}.json`);
  const frozen=await readFile(preparingLedger,'utf8');
  assert.equal(JSON.parse(frozen).requests_attempted,0);
  let dispatched=0;
  const prepareDeps=dependencies(preparing,(async()=>{
    dispatched++;
    return Response.json({output:{sentence:{words:[{text:'fixture',begin_time:100,end_time:200}]}}});
  }) as typeof fetch);
  assert.equal((await readClipMentorSourceAsr(readRequest,prepareDeps)).requestsAttempted,0);
  await assert.rejects(transcribeClipMentorSource(request,{...prepareDeps,key:()=> 'other-account'}));
  assert.equal(await readFile(preparingLedger,'utf8'),frozen);
  assert.equal(dispatched,0);
  await assert.rejects(transcribeClipMentorSource({...request,operationId:'f8636ccf-b241-4114-a0d3-c54be76a0f59'},prepareDeps,undefined,true));
  await verifyAsrHostRecovery(prepareDeps);
  assert.equal(dispatched,3);
  assert.equal((await readdir(preparing)).some(name=>name.startsWith('audio-')),false);
  assert.equal((await transcribeClipMentorSource(request,prepareDeps)).status,'completed');
  assert.equal(dispatched,3);

  for (const mode of ['asr-crash-before-response', 'asr-crash-after-raw']) {
    const directory = join(root, mode);
    const child = spawnSync(process.execPath,
      ['--import', 'tsx', fileURLToPath(import.meta.url), mode, directory],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 20_000 });
    assert.equal(child.status, 73, child.stderr);
    const ledgerFile = join(directory, `${operationId}.json`);
    const original = await readFile(ledgerFile, 'utf8');
    const saved = JSON.parse(original);
    assert.equal(saved.requests_attempted, 2);
    assert.deepEqual(saved.result.chunks.map((c: { status: string }) => c.status), ['completed', 'failed', 'not_requested']);
    assert.equal(saved.result.status, 'partial');
    assert.equal(saved.result.words[0].text, 'chunk-1-fixture');
    let repeated = 0;
    const deps = dependencies(directory, (async () => { repeated++; throw Error('No provider dispatch permitted during recovery'); }) as typeof fetch);
    const read = await readClipMentorSourceAsr(readRequest, deps);
    assert.equal(read.state, 'partial');
    assert.equal(read.requestsAttempted, 2);
    assert.equal(read.recovered_from_raw, mode === 'asr-crash-after-raw');
    assert.deepEqual(read.result!.chunks.map(c => c.status),
      mode === 'asr-crash-after-raw' ? ['completed', 'completed', 'not_requested'] : ['completed', 'failed', 'not_requested']);
    const replay = await transcribeClipMentorSource(request, deps);
    assert.deepEqual(replay.chunks.map(c => c.status), read.result!.chunks.map(c => c.status));
    assert.equal(repeated, 0, 'neither an unknown attempted chunk nor the undispatched final chunk is submitted');
    assert.equal(await readFile(ledgerFile, 'utf8'), original, 'recovery preserves original attempt and failure evidence');
    assert.equal((await readClipMentorSourceAsr({ ...readRequest, projectId: 'foreign' }, deps)).state, 'stale');
    assert.equal((await readClipMentorSourceAsr(readRequest, { ...deps, hash: async () => 'b'.repeat(64) })).state, 'stale');
    if (mode === 'asr-crash-after-raw') {
      const rawDirectory = join(directory, 'external-calls');
      // A corrupt raw cannot reuse the previously derived recovery file as a pass.
      const rows = (await readdir(rawDirectory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
      const alias=join(rawDirectory,`request-${createHash('sha256').update(`${operationId}:chunk-2`).digest('hex')}.json`);
      const originalAlias=await readFile(alias,'utf8');
      const firstAlias=join(rawDirectory,`request-${createHash('sha256').update(`${operationId}:chunk-1`).digest('hex')}.json`);
      const first=JSON.parse(await readFile(firstAlias,'utf8'));
      await writeFile(alias,JSON.stringify({...JSON.parse(originalAlias),input_sha256:first.input_sha256}));
      const wrongChunk=await readClipMentorSourceAsr(readRequest,deps);
      assert.equal(wrongChunk.recovered_from_raw,false,'a complete archived response for a different chunk cannot recover this one');
      assert.equal(wrongChunk.result!.chunks[1].status,'failed');
      await writeFile(alias,originalAlias);
      for (const name of rows) {
        const row = JSON.parse(await readFile(join(rawDirectory, name), 'utf8'));
        if (row.request_id === `${operationId}:chunk-2`) await writeFile(join(rawDirectory, name.replace('.json', '.response')), '{}');
      }
      const corrupt = await readClipMentorSourceAsr(readRequest, deps);
      assert.equal(corrupt.recovered_from_raw, false);
      assert.deepEqual(corrupt.result!.chunks.map(c => c.status), ['completed', 'failed', 'not_requested']);
      assert.equal(await readFile(ledgerFile, 'utf8'), original);
    }
  }
}
