import assert from 'node:assert/strict';
import { execFile, fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ffmpegBin, ffprobeBin } from '../media-binaries.ts';
import { runOwnedProcess } from '../owned-render-process.ts';

const entry = fileURLToPath(import.meta.url);
const execute = promisify(execFile);
const bytes = async (file: string) => (await stat(file).catch(() => null))?.size ?? 0;
const nativeOptions = (output: string, seconds: number) => [
  '-hide_banner', '-loglevel', 'error', '-y', '-re', '-f', 'lavfi', '-i', 'testsrc=size=96x64:rate=15',
  '-t', String(seconds), '-an', '-threads', '1', '-c:v', 'mpeg4',
  '-movflags', 'frag_keyframe+empty_moov', '-g', '5', '-flush_packets', '1', output,
];

async function until<T>(check: () => Promise<T | false>, label: string, waitMs = 8_000): Promise<T> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const found = await check();
    if (found !== false) return found;
    await delay(45);
  }
  throw new Error('Timed out waiting for ' + label);
}

async function processes() {
  const { stdout } = await execute('ps', ['-axo', 'pid,ppid,stat,command']);
  return stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    return match ? [{ pid: +match[1], parent: +match[2], state: match[3], command: match[4] }] : [];
  });
}

async function fixtureOwner(output: string, mode: string) {
  if (mode === 'native' || mode === 'native-worker') {
    const args = nativeOptions(output, 30);
    if (mode === 'native') await runOwnedProcess({ command: ffmpegBin(), args });
    else await assert.rejects(runOwnedProcess({
      command: process.execPath,
      args: ['--eval', `const {spawn}=require('node:child_process');
        process.on('message', ({ input }) => {
          if (input) spawn(input.command, input.args, {stdio:'ignore'});
        });`],
      input: { command: ffmpegBin(), args },
    }), /SIGKILL/);
    return;
  }
  const { registerExportJobRoute } = await import('./export-job-routes.ts');
  const { setUploadsDirProvider } = await import('./export-rendering.ts');
  const { uploadDir } = await import('../media-dir.ts');
  setUploadsDirProvider(uploadDir);
  let route: Parameters<import('vite').Connect.Server['use']>[1] | undefined;
  registerExportJobRoute({ middlewares: { use(_path: string, fn: typeof route) { route = fn; } },
    config: { logger: { warn() {} } } } as never);
  const server = createServer((req, res) => {
    req.url = req.url?.replace(/^\/export\/job/, '') || '/';
    route?.(req, res, () => { res.statusCode = 404; res.end(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  process.send?.('http://127.0.0.1:' + address.port + '/export/job');
}

async function verify() {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'cm-native-export-'));
  const owners: ChildProcess[] = [];
  const started = Date.now();
  async function launch(output: string, mode: string, extra: NodeJS.ProcessEnv = {}) {
    const child = fork(entry, ['worker', output, mode], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      env: { ...process.env, ...extra },
    });
    owners.push(child);
    return child;
  }
  async function stop(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  try {
    const interrupted = join(root, 'interrupted.mp4');
    const owner = await launch(interrupted, 'native');
    const healthy = join(root, 'healthy.mp4');
    const concurrent = runOwnedProcess({ command: ffmpegBin(), args: nativeOptions(healthy, 2.5) });
    await until(async () => (await bytes(interrupted)) > 1024, 'FFmpeg to write partial output');
    const target = await until(async () => (await processes()).find(({ command }) =>
      command.endsWith(interrupted) && command.includes('testsrc=')) ?? false, 'active native FFmpeg PID');
    await stop(owner);
    await until(async () => !(await processes()).some(({ pid, state }) =>
      pid === target.pid && !state.startsWith('Z')), 'native writer exit after owner SIGKILL');
    const partial = await bytes(interrupted);
    await delay(300);
    assert.equal(await bytes(interrupted), partial, 'no writes after the guarded native process exited');
    await concurrent;
    const positive = await execute(ffprobeBin(), ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', healthy]);
    assert.equal(positive.stdout.trim(), 'video');
    const terminatedWorker = join(root, 'terminated-worker.mp4');
    const supervisorOwner = await launch(terminatedWorker, 'native-worker');
    await until(async () => (await bytes(terminatedWorker)) > 1024, 'worker-owned FFmpeg write');
    const workerTarget = await until(async () => (await processes()).find(({ command }) =>
      command.endsWith(terminatedWorker) && command.includes('testsrc=')) ?? false, 'worker-owned FFmpeg PID');
    const ownerExit = once(supervisorOwner, 'exit');
    process.kill(workerTarget.parent, 'SIGKILL');
    assert.deepEqual(await ownerExit, [0, null], 'worker death rejects its own render result');
    await until(async () => !(await processes()).some(({ pid, state }) =>
      pid === workerTarget.pid && !state.startsWith('Z')), 'native writer exit after worker SIGKILL');

    const abort = new AbortController();
    const stopped = join(root, 'cancelled.mp4');
    const cancellation = runOwnedProcess({ command: ffmpegBin(), args: nativeOptions(stopped, 30), signal: abort.signal });
    await until(async () => (await bytes(stopped)) > 1024, 'FFmpeg to reach the cancellation point');
    abort.abort(new Error('fixture cancelled'));
    await assert.rejects(cancellation, /fixture cancelled/);
    assert(!(await processes()).some(({ command }) => command.endsWith(stopped) && command.includes('testsrc=')));
    console.log(`Native FFmpeg owner and worker SIGKILL, concurrent success and live cancellation passed (${Date.now() - started}ms, no external calls)`);

    if (process.env.CLIPMENTOR_TEST_EXISTING_CHROMIUM) {
      const browser = process.env.CLIPMENTOR_TEST_EXISTING_CHROMIUM;
      // @ts-expect-error — the existing JS render entry has no declarations.
      const { prebuildServeBundle } = await import('../../remotion/render.mjs');
      const bundle = join(root, 'bundle');
      await prebuildServeBundle(bundle);
      const profile = join(root, 'profile');
      const scratch = join(root, 'scratch');
      await mkdir(scratch);
      const env = { OPENCHATCUT_DATA_DIR: profile, OPENCHATCUT_SQLITE_STORE: '0',
        CC_BROWSER_EXECUTABLE: browser, CC_REMOTION_BUNDLE: bundle, TMPDIR: scratch };
      const { projectDoc } = await import('../external-agent/offline-runtime.verify-fixtures.ts');
      const state = { ...projectDoc(160, 96).timelines[0], durationInFrames: 240 };
      const srv = await launch('', 'render', env);
      const [url] = await once(srv, 'message') as [string];
      const submit = async (base: string, operationId = randomUUID()) => {
        const response = await fetch(base, { method: 'POST', body: JSON.stringify({
          operationId, state, format: 'video', videoCodec: 'h264', resolution: '480p', frameRange: [0, 29],
        }) });
        assert.equal(response.status, 200, await response.clone().text());
        return await response.json() as { renderId: string; attemptId: string };
      };
      const good = await submit(url);
      const result = await until(async () => {
        const status = await fetch(url + '/' + good.renderId).then((r) => r.json());
        assert.notEqual(status.status, 'failed', JSON.stringify(status));
        return status.status === 'succeeded' ? status.result : false;
      }, 'complete Remotion export', 60_000);
      const rendered = join(profile, 'media', 'uploads', result.path.split('/').at(-1)!);
      const saved = await readFile(rendered);
      assert(saved.length > 1024);
      const renderScratchEmpty = async () => !(await readdir(scratch)).some((name) => name.startsWith('openchatcut-render-'));
      await until(renderScratchEmpty, 'completed render scratch cleanup');
      const interruptedJob = await submit(url);
      const chrome = await until(async () => (await processes()).find(({ command }) =>
        command.startsWith(browser) && command.includes('--user-data-dir=' + scratch) && !command.includes('--type=')) ?? false,
      'real renderer Chromium', 60_000);
      await stop(srv);
      await until(async () => !(await processes()).some(({ pid, state }) => pid === chrome.pid && !state.startsWith('Z')),
        'detached Chromium to exit after server SIGKILL');
      await until(renderScratchEmpty, 'per-render scratch cleanup');
      const restarted = await launch('', 'render', env);
      const [again] = await once(restarted, 'message') as [string];
      const old = await fetch(again + '/' + good.renderId).then((r) => r.json());
      assert.equal(old.status, 'succeeded');
      assert.deepEqual(await readFile(rendered), saved);
      const broken = await fetch(again + '/' + interruptedJob.renderId).then((r) => r.json());
      assert.equal(broken.status, 'failed');
      assert.equal(broken.result, undefined);
      assert.equal((await fetch(again + '/' + interruptedJob.renderId + '/promote', { method: 'POST' })).status, 409);
      assert.deepEqual(await submit(again, interruptedJob.renderId), interruptedJob, 'same ID cannot start another renderer');
      assert(await renderScratchEmpty());
      console.log('Actual Remotion export completed, Chromium stopped after SIGKILL, and cold HTTP recovery preserved only the successful result');
    }
  } finally {
    await Promise.all(owners.map(stop));
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === 'worker') await fixtureOwner(process.argv[3], process.argv[4]);
else await verify();
