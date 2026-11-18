import assert from 'node:assert/strict';
import { execFile, fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ffmpegBin, ffprobeBin } from '../media-binaries.ts';
import { runOwnedProcess } from '../owned-render-process.ts';
import type { GenerationJobSnapshot } from './generation-job-types.ts';

const entry = fileURLToPath(import.meta.url);
const execute = promisify(execFile);

// The JS worker owns a native shell, which in turn spawns the real encoder.
// An immediate exit on stop models an AbortSignal closing the worker before
// a detached native helper has completed its own cancellation.
const renderWorker = String.raw`
const { spawn } = require('node:child_process');
process.on('message', ({ input, stop }) => {
  if (stop) process.exit(17);
  if (!input) return;
  const middle = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', input.script,
  ], {
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      OPENCHATCUT_VERIFY_FFMPEG: input.ffmpeg,
      OPENCHATCUT_VERIFY_OUTPUT: input.output,
      OPENCHATCUT_VERIFY_PID_FILE: input.pidFile,
      OPENCHATCUT_VERIFY_WORKER_PID: String(process.pid),
      OPENCHATCUT_VERIFY_DURATION: String(input.seconds),
    },
  });
  middle.once('error', (error) => process.send({ error: error.message }, () => process.exit(1)));
  middle.once('exit', (code) => {
    if (code !== 0) process.exit(code ?? 1);
    process.send({ result: true }, () => process.exit(0));
  });
});
`;

const nativeMiddle = String.raw`
$ErrorActionPreference = 'Stop'
$arguments = @(
  '-hide_banner', '-loglevel', 'error', '-y', '-re', '-f', 'lavfi', '-i', 'testsrc=size=96x64:rate=15',
  '-t', $env:OPENCHATCUT_VERIFY_DURATION, '-an', '-threads', '1', '-c:v', 'mpeg4',
  '-movflags', 'frag_keyframe+empty_moov', '-g', '5', '-flush_packets', '1',
  ('"' + $env:OPENCHATCUT_VERIFY_OUTPUT + '"')
)
$encoder = Start-Process -FilePath $env:OPENCHATCUT_VERIFY_FFMPEG -ArgumentList $arguments -NoNewWindow -PassThru
$pids = @{ worker = [int]$env:OPENCHATCUT_VERIFY_WORKER_PID; middle = $PID; writer = $encoder.Id }
[IO.File]::WriteAllText($env:OPENCHATCUT_VERIFY_PID_FILE, ($pids | ConvertTo-Json -Compress))
$encoder.WaitForExit()
exit $encoder.ExitCode
`;

interface FixtureJob {
  renderId: string;
  attemptId: string;
}

interface NativePids {
  worker: number;
  middle: number;
  writer: number;
}

function pidIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function until<T>(attempt: () => Promise<T | false>, label: string, waitMs = 25_000): Promise<T> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const value = await attempt();
    if (value !== false) return value;
    await delay(60);
  }
  throw new Error('Timed out waiting for ' + label);
}

function filename(attemptId: string) {
  return 'openchatcut-export-job-' + attemptId + '.mp4';
}

function uploadPath(profile: string, name: string) {
  return join(profile, 'media', 'uploads', name);
}

function pidPath(fixture: string, job: FixtureJob) {
  return join(fixture, job.attemptId + '.json');
}

async function fixtureServer(fixture: string) {
  const { createGenerationJob, initializeGenerationJobs } = await import('./generation-job-lifecycle.ts');
  const { registerExportJobRoute } = await import('./export-job-routes.ts');
  const { registerUploadRoutes } = await import('./upload-routes.ts');
  const { uploadDir } = await import('../media-dir.ts');
  const { readJsonBody, sendError, sendJson } = await import('./export-http.ts');
  await initializeGenerationJobs();
  await mkdir(uploadDir(), { recursive: true });

  type Route = Parameters<import('vite').Connect.Server['use']>[1];
  const routes = new Map<string, Route>();
  const vite = {
    middlewares: { use: (name: string, route: Route) => { routes.set(name, route); } },
    config: { logger: { info() {}, warn() {}, error() {} } },
  } as never;
  registerExportJobRoute(vite);
  registerUploadRoutes(vite);
  routes.set('/fixture', async (req, res) => {
    try {
      const { seconds } = await readJsonBody(req) as { seconds: number };
      const job = { renderId: randomUUID(), attemptId: randomUUID() };
      const name = filename(job.attemptId);
      const final = join(uploadDir(), name);
      const staged = join(uploadDir(), '.' + name);
      await createGenerationJob({ kind: 'export', exportAttemptId: job.attemptId }, async () => {
        await appendFile(join(fixture, 'launch.log'), job.attemptId + '\n');
        const result = await runOwnedProcess<boolean>({
          command: process.execPath,
          args: [join(fixture, 'render-worker.cjs')],
          input: {
            ffmpeg: ffmpegBin(), output: staged, seconds,
            script: join(fixture, 'middle.ps1'), pidFile: pidPath(fixture, job),
          },
        });
        assert.equal(result, true);
        return {
          assetId: job.attemptId,
          kind: 'video',
          name,
          path: '/media/uploads/' + name,
          durationSeconds: seconds,
          sizeBytes: (await stat(staged)).size,
        };
      }, { operationId: job.renderId, publishResult: () => rename(staged, final) });
      sendJson(res, 200, job);
    } catch (error) {
      sendError(res, 500, String(error));
    }
  });
  const server = createServer((req, res) => {
    const route = [...routes].find(([name]) => req.url === name || req.url?.startsWith(name + '/'));
    if (!route) { res.writeHead(404).end(); return; }
    const [name, handler] = route;
    req.url = req.url!.slice(name.length) || '/';
    handler(req, res, () => { res.writeHead(404).end(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  process.send?.('http://127.0.0.1:' + address.port);
}

async function startServer(fixture: string, profile: string, profileId: string, sqlite: boolean) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('OPENCHATCUT_DEV_PROFILE_') && key !== 'OPENCHATCUT_EDITOR_URL'));
  const child = fork(entry, ['--fixture-server', fixture], {
    execArgv: ['--import', 'tsx'],
    env: { ...env, OPENCHATCUT_DEV_PROFILE_ID: profileId, OPENCHATCUT_DATA_DIR: profile, OPENCHATCUT_SQLITE_STORE: sqlite ? '1' : '0' },
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  let url: string | undefined;
  child.once('message', (data) => { if (typeof data === 'string') url = data; });
  try {
    await until(async () => {
      assert(child.exitCode === null && child.signalCode === null, 'server exited before listening');
      return url ?? false;
    }, 'fixture HTTP startup');
    return { child, url: url! };
  } catch (error) {
    await stopServer(child);
    throw error;
  }
}

async function stopServer(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const exit = once(child, 'exit');
  assert(child.kill('SIGKILL'), 'fixture owner must accept hard termination');
  await exit;
}

async function submit(origin: string, seconds: number) {
  const response = await fetch(origin + '/fixture', { method: 'POST', body: JSON.stringify({ seconds }) });
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json() as FixtureJob;
}

async function snapshot(origin: string, job: FixtureJob) {
  const response = await fetch(origin + '/export/job/' + job.renderId);
  assert.equal(response.status, 200, await response.clone().text());
  return await response.json() as GenerationJobSnapshot;
}

async function findKeeper(worker: number): Promise<number> {
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$w = Get-CimInstance Win32_Process -Filter 'ProcessId = ${worker}';
    if (!$w) { exit 2 }
    $sameParent = "ParentProcessId = " + $w.ParentProcessId + " AND Name = 'powershell.exe'";
    $p = @(Get-CimInstance Win32_Process -Filter $sameParent);
    if ($p.Count -ne 1) { exit 3 }
    $p[0].ProcessId`]);
  const pid = Number(stdout.trim());
  assert(Number.isSafeInteger(pid) && pid > 0 && pid !== worker);
  return pid;
}

async function verifyBoundary(root: string, kill: 'owner' | 'worker' | 'keeper') {
  const fixture = join(root, kill);
  const profile = join(fixture, 'profile');
  const profileId = randomUUID();
  const sqlite = kill !== 'owner';
  await mkdir(fixture);
  await Promise.all([
    writeFile(join(fixture, 'render-worker.cjs'), renderWorker),
    writeFile(join(fixture, 'middle.ps1'), nativeMiddle),
  ]);
  const servers: ChildProcess[] = [];
  const pids: NativePids[] = [];
  try {
    const owner = await startServer(fixture, profile, profileId, sqlite);
    servers.push(owner.child);
    const good = await submit(owner.url, 1);
    const succeeded = await until(async () => {
      const job = await snapshot(owner.url, good);
      assert.notEqual(job.status, 'failed', JSON.stringify(job));
      return job.status === 'succeeded' && job.result ? job.result : false;
    }, 'uninterrupted native export');
    const goodPath = uploadPath(profile, filename(good.attemptId));
    const goodBytes = await readFile(goodPath);
    assert.equal(goodBytes.length, succeeded.sizeBytes);
    const probe = await execute(ffprobeBin(), ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', goodPath]);
    assert.equal(probe.stdout.trim(), 'video');

    const interrupted = await submit(owner.url, 40);
    const native = await until(async () => {
      try { return JSON.parse(await readFile(pidPath(fixture, interrupted), 'utf8')) as NativePids; }
      catch { return false; }
    }, 'worker, native shell and FFmpeg PID evidence');
    assert([native.worker, native.middle, native.writer].every((pid) => Number.isSafeInteger(pid) && pid > 0));
    assert.equal(new Set([owner.child.pid, native.worker, native.middle, native.writer]).size, 4);
    pids.push(native);
    const staged = uploadPath(profile, '.' + filename(interrupted.attemptId));
    const size = async () => (await stat(staged).catch(() => null))?.size ?? 0;
    const firstSize = await until(async () => { const n = await size(); return n > 1024 ? n : false; }, 'partial MP4');
    await until(async () => (await size()) > firstSize, 'continued writes before termination');
    assert([native.worker, native.middle, native.writer].every(pidIsRunning));
    assert.equal((await snapshot(owner.url, interrupted)).status, 'running');

    if (kill === 'owner') await stopServer(owner.child);
    else process.kill(kill === 'keeper' ? await findKeeper(native.worker) : native.worker, 'SIGKILL');
    const sizeAfterSignal = await size();
    await until(async () => ![native.worker, native.middle, native.writer].some(pidIsRunning),
      'fixture tree termination after hard ' + kill + ' stop', 7_000).catch(async (error) => {
        const alive = Object.entries(native).filter(([, pid]) => pidIsRunning(pid)).map(([name]) => name);
        throw new Error(`${error.message}; live=${alive.join(',')}; wrote ${(await size()) - sizeAfterSignal} bytes after the kill`);
      });
    const stoppedSize = await size();
    await delay(500);
    assert(stoppedSize >= firstSize);
    assert.equal(await size(), stoppedSize, 'FFmpeg must no longer write');

    if (kill !== 'owner') {
      await until(async () => (await snapshot(owner.url, interrupted)).status === 'failed', 'live owner failure receipt');
      await stopServer(owner.child);
    }
    // Even a leftover candidate under the published basename cannot authorize
    // delivery. This simulates a rename without a confirmed terminal receipt.
    const interruptionName = filename(interrupted.attemptId);
    await copyFile(staged, uploadPath(profile, interruptionName));
    const cold = await startServer(fixture, profile, profileId, sqlite);
    servers.push(cold.child);
    const stale = await snapshot(cold.url, interrupted);
    assert.equal(stale.status, 'failed');
    assert.equal(stale.result, undefined);
    assert.equal((await fetch(cold.url + '/export/job/' + interrupted.renderId + '/promote', { method: 'POST' })).status, 409);
    assert.equal((await fetch(cold.url + '/media/uploads/' + interruptionName)).status, 404);
    assert.equal((await fetch(cold.url + '/media/uploads/.' + interruptionName)).status, 404);
    const repeated = await fetch(cold.url + '/export/job', {
      method: 'POST', body: JSON.stringify({ operationId: interrupted.renderId }),
    });
    assert.equal(repeated.status, 200, await repeated.clone().text());
    assert.deepEqual(await repeated.json(), interrupted, 'same ID keeps its original attempt binding');
    assert.equal((await snapshot(cold.url, interrupted)).status, 'failed');
    assert.deepEqual((await readFile(join(fixture, 'launch.log'), 'utf8')).trim().split('\n'),
      [good.attemptId, interrupted.attemptId], 'recovery cannot start another writer');
    assert.equal((await snapshot(cold.url, good)).status, 'succeeded');
    const downloaded = await fetch(cold.url + succeeded.path);
    assert.equal(downloaded.status, 200, await downloaded.clone().text());
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), goodBytes);
    console.log(`Windows native export recovery after ${kill} termination passed (${sqlite ? 'SQLite' : 'JSON'})`);
  } finally {
    await Promise.allSettled(servers.map(stopServer));
    // A red test must not leave a 40-second writer behind on the runner.
    for (const native of pids) for (const pid of [native.worker, native.middle, native.writer]) {
      if (pidIsRunning(pid)) process.kill(pid, 'SIGKILL');
    }
  }
}

async function verifyDirectEncoder(root: string) {
  const output = join(root, 'direct.mp4');
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', 'color=size=96x64:rate=15', '-t', '0.5', '-an', '-threads', '1', '-c:v', 'mpeg4', output];
  await assert.rejects(runOwnedProcess({ command: ffmpegBin(), args, input: { invalid: 1n } }), /serialize/);
  await assert.rejects(stat(output), { code: 'ENOENT' });
  const aborted = new AbortController();
  const cancelled = runOwnedProcess({ command: ffmpegBin(), args, signal: aborted.signal });
  aborted.abort(new Error('cancelled before encoder admission'));
  await assert.rejects(cancelled, /cancelled before encoder admission/);
  await assert.rejects(stat(output), { code: 'ENOENT' });
  const started = Date.now();
  await runOwnedProcess({ command: ffmpegBin(), args });
  const elapsed = Date.now() - started;
  const probe = await execute(ffprobeBin(), ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', output]);
  assert.equal(probe.stdout.trim(), 'video');
  console.log(`Windows direct FFmpeg admission, early stop and valid output passed (${elapsed} ms for a half-second synthetic encode)`);
}

async function verify() {
  if (process.platform !== 'win32') {
    console.log('Windows native export recovery skipped on ' + process.platform);
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'cm windows native '));
  try {
    const errors: unknown[] = [];
    for (const boundary of ['owner', 'worker', 'keeper'] as const) {
      try { await verifyBoundary(root, boundary); }
      catch (error) { errors.push(error); console.error(boundary, error); }
    }
    try { await verifyDirectEncoder(root); }
    catch (error) { errors.push(error); console.error('direct encoder', error); }
    if (errors.length) throw new AggregateError(errors, 'Windows native export recovery failed');
    console.log('Windows native worker tree and cold delivery verified; no external calls');
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
}

if (process.argv[2] === '--fixture-server') await fixtureServer(process.argv[3]);
else await verify();
