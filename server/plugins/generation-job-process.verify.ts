import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { GenerationResult } from './generation-job-types.ts';

type Command = { op: 'submit' | 'recover' | 'status' | 'progress' | 'remove' | 'promote' | 'move' | 'restore-ledger'
  | 'block-ledger' | 'cancel' | 'release' | 'hide-sqlite' | 'restore-sqlite';
  id?: string; marker?: string; hold?: boolean; accepted?: boolean; fault?: boolean; acceptanceFault?: boolean; target?: string;
  cancellable?: boolean; noObserver?: boolean; attempt?: string; holdReply?: boolean; };
const entry = fileURLToPath(import.meta.url);
const send = (event: string, value?: unknown) => process.send?.({ event, value });

async function worker() {
  const copyMode = process.argv[3];
  if (copyMode?.startsWith('no-hardlink')) {
    const fs = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises');
    const copy = fs.copyFile;
    fs.link = async () => { throw Object.assign(new Error('fixture filesystem does not support links'), { code: 'ENOTSUP' }); };
    fs.copyFile = async (from, to, flags) => {
      if (String(to).endsWith('.pending') && copyMode === 'no-hardlink-kill') {
        await fs.writeFile(to, 'partial');
        send('copy-paused');
        await new Promise(() => undefined);
      }
      if (String(to).endsWith('.pending') && copyMode === 'no-hardlink-corrupt') {
        await fs.writeFile(to, Buffer.alloc((await fs.stat(from)).size, 33));
        return;
      }
      if (String(to).endsWith('.pending') && copyMode === 'no-hardlink-conflict') {
        const stage = String(to);
        await fs.writeFile(join(dirname(stage), basename(stage).slice(1, -'.pending'.length)), 'unrelated bytes', { flag: 'wx' });
      }
      return copy(from, to, flags);
    };
    syncBuiltinESMExports();
  }
  const lifecycle = await import('./generation-job-lifecycle.ts');
  const { registerGenerationJobResumer, generationProgressPlugin } = await import('./generation-jobs.ts');
  const { registerExportJobRoute } = await import('./export-job-routes.ts');
  const runtime = await import('./export-runtime.ts');
  const { runtimeProfile } = await import('../runtime-profile.ts');
  const { uploadDir } = await import('../media-dir.ts');
  const { DatabaseSync } = await import('node:sqlite');
  const { sqliteProjectStorePath } = await import('../project-store-paths.ts');
  const { settingsPlugin } = await import('./settings.ts');
  const profile = runtimeProfile();
  const renderFile = async (id: string, marker: string): Promise<GenerationResult> => {
    const name = runtime.exportJobFilename(id, 'mp4');
    await mkdir(uploadDir(), { recursive: true });
    const bytes = Buffer.from('complete synthetic output: ' + marker);
    await writeFile(join(uploadDir(), name), bytes);
    return { assetId: id, kind: 'video', name: marker, path: '/media/uploads/' + name, sizeBytes: bytes.length, durationSeconds: 1 };
  };
  registerGenerationJobResumer('fixture-process', 'fixture', async (snapshot) => {
    send('resume-start', snapshot.providerTaskId);
    return renderFile(snapshot.id, 'recovered');
  });
  const routes = new Map<string, Parameters<import('vite').Connect.Server['use']>[1]>();
  const vite = { middlewares: { use: (route: string, fn: Parameters<import('vite').Connect.Server['use']>[1]) =>
    routes.set(route, fn) }, config: { logger: { error() {}, warn() {}, info() {} } } } as never;
  registerExportJobRoute(vite);
  (generationProgressPlugin().configureServer as (server: never) => void)(vite);
  (settingsPlugin().configureServer as (server: never) => void)(vite);
  let holdCancellationReply = false;
  const server = createServer((req, res) => {
    const route = [...routes.keys()].find((prefix) => req.url?.startsWith(prefix));
    if (!route) { res.statusCode = 404; res.end(); return; }
    req.url = req.url!.slice(route.length) || '/';
    if (holdCancellationReply && req.url.split('?')[0]?.endsWith('/cancel')) {
      res.end = (() => { send('cancel-persisted', res.statusCode); return res; }) as typeof res.end;
    }
    routes.get(route)?.(req, res, () => { res.statusCode = 404; res.end(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = 'http://127.0.0.1:' + address.port;
  let failureDb: InstanceType<typeof DatabaseSync> | undefined;
  let blockedLedger: string | undefined;
  let offlineSqlite: string | undefined;
  const heldJobs = new Map<string, () => void>();
  async function blockSettlement() {
    if (process.env.OPENCHATCUT_SQLITE_STORE === '1') {
      failureDb = new DatabaseSync(sqliteProjectStorePath(profile.rootDir));
      failureDb.exec(`CREATE TRIGGER fixture_terminal_fault BEFORE UPDATE ON kv
        WHEN NEW.k='generation-jobs:snapshot' AND OLD.v <> NEW.v
        BEGIN SELECT RAISE(ABORT,'fixture ledger failure'); END`);
    } else {
      blockedLedger = profile.generationJobStore + '.blocked';
      await rename(profile.generationJobStore, blockedLedger);
      await mkdir(profile.generationJobStore);
    }
  }
  await lifecycle.initializeGenerationJobs();
  send('ready');
  process.on('message', async ({ seq, command }: { seq: number; command: Command }) => {
    try {
      const id = command.id!;
      let value: unknown;
      if (command.op === 'submit') {
        const controller = new AbortController();
        const name = runtime.exportJobFilename(id, 'mp4');
        const privateOutput = join(uploadDir(), '.' + name);
        const publicOutput = join(uploadDir(), name);
        const onCancel = () => send('abort-seen', id);
        if (command.cancellable) controller.signal.addEventListener('abort', onCancel, { once: true });
        value = await lifecycle.createGenerationJob({ kind: 'export', exportAttemptId: id, marker: command.marker }, async (_id, _update, _download, register) => {
          if (command.accepted) await register('fixture', 'original-provider-id');
          if (command.acceptanceFault) {
            await blockSettlement();
            await assert.rejects(register('fixture', 'uncommitted-provider-id'), /fixture ledger failure/);
            failureDb!.exec('DROP TRIGGER fixture_terminal_fault');
            failureDb!.close();
            failureDb = undefined;
            send('checkpoint-rejected');
          }
          if (command.hold) {
            const path = command.cancellable ? privateOutput : publicOutput;
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, 'partial');
          }
          send('launch', command.marker);
          if (command.hold) {
            await new Promise<void>((resolve) => heldJobs.set(id, resolve));
            heldJobs.delete(id);
          }
          if (command.cancellable) {
            const bytes = Buffer.from('candidate bytes before terminal commit');
            await writeFile(privateOutput, bytes);
            if (command.fault) await blockSettlement();
            return { assetId: id, kind: 'video', name, path: '/media/uploads/' + name, sizeBytes: bytes.length, durationSeconds: 1 };
          }
          const result = await renderFile(id, command.marker!);
          if (command.fault) await blockSettlement();
          return result;
        }, {
          operationId: id, toolName: 'fixture-process', provider: 'fixture',
          ...(command.cancellable && {
            publishResult: async () => { await rename(privateOutput, publicOutput); send('published', id); },
            onCancelled: async () => {
              await Promise.all([rm(privateOutput, { force: true }), rm(publicOutput, { force: true })]);
              send('cancel-cleaned', id);
            },
          }),
          onSettled: () => {
            const status = lifecycle.getGenerationJobSnapshot(id)?.status;
            if (status !== 'queued' && status !== 'running') runtime.forgetExportJobController(id, controller);
            send('settled', id);
          },
        });
        if (command.cancellable && !command.noObserver) runtime.trackExportJobController(id, controller, id);
      } else if (command.op === 'recover') {
        await lifecycle.refreshGenerationJobStatus(); await lifecycle.resumeRestoredJobs();
      } else if (command.op === 'release') {
        heldJobs.get(id)?.();
      } else if (command.op === 'block-ledger') {
        await blockSettlement();
      } else if (command.op === 'hide-sqlite') {
        const sql = await import('../storage/sqlite-store.ts');
        const stored = await sql.sqliteReadEntry('generation-jobs:snapshot');
        const rows = stored.value as { jobs: Array<{ id: string; executionPid?: number }> };
        const stale = rows.jobs.find((row) => row.id === id)!;
        delete stale.executionPid;
        await writeFile(profile.generationJobStore, JSON.stringify({ version: 1, jobs: [stale] }));
        const primary = sqliteProjectStorePath(profile.rootDir);
        offlineSqlite = primary + '.unavailable';
        await rename(primary, offlineSqlite);
      } else if (command.op === 'restore-sqlite') {
        assert(offlineSqlite);
        await rename(offlineSqlite, sqliteProjectStorePath(profile.rootDir));
        const legacy = JSON.parse(await readFile(profile.generationJobStore, 'utf8'));
        value = legacy.jobs[0];
      } else if (command.op === 'restore-ledger') {
        if (failureDb) { failureDb.exec('DROP TRIGGER fixture_terminal_fault'); failureDb.close(); failureDb = undefined; }
        if (blockedLedger) { await rm(profile.generationJobStore, { recursive: true }); await rename(blockedLedger, profile.generationJobStore); }
      } else {
        let route = '/export/job/' + id;
        let method = 'GET';
        let body: unknown;
        if (command.op === 'remove') method = 'DELETE';
        if (command.op === 'promote') { route += '/promote'; method = 'POST'; }
        if (command.op === 'cancel') {
          route += '/cancel' + (command.attempt ? '?attemptId=' + encodeURIComponent(command.attempt) : '');
          method = 'POST';
          holdCancellationReply = command.holdReply === true;
        }
        if (command.op === 'move') { route = '/api/keys'; method = 'POST'; body = { OPENCHATCUT_DATA_DIR: command.target }; }
        if (command.op === 'progress') { route = '/generate/progress'; method = 'POST'; body = { action: 'status', target: 'generation', jobIds: [id] }; }
        const response = await fetch(url + route, { method, ...(body && { body: JSON.stringify(body) }) });
        const raw = await response.text();
        value = { http: response.status, body: raw ? JSON.parse(raw) : null };
      }
      send('reply:' + seq, value);
    } catch (error) { send('reply:' + seq, { error: String(error) }); }
  });
}

interface Event { event: string; value: any }
interface Worker {
  child: ChildProcess;
  events: Event[];
  next(event: string): Promise<any>;
  request(command: Command): Promise<any>;
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'occ-gen-process-'));
  const workers: Worker[] = [];
  async function start(home: string, sqlite: boolean, mode = '') {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, OPENCHATCUT_SQLITE_STORE: sqlite ? '1' : '0' };
    delete env.OPENCHATCUT_DATA_DIR;
    delete env.OPENCHATCUT_GENERATION_JOB_STORE;
    if (!sqlite) env.OPENCHATCUT_GENERATION_JOB_STORE = join(home, 'pinned-generation-ledger.json');
    const child = fork(entry, ['--worker', mode], {
      env,
      cwd: home, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    const events: Event[] = [];
    child.on('message', (message) => events.push(message as Event));
    let seq = 0;
    const instance: Worker = { child, events, async next(event) {
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
        const index = events.findIndex((item) => item.event === event);
        if (index !== -1) return events.splice(index, 1)[0]!.value;
        await delay(15);
      }
      throw new Error('fixture event not observed: ' + event + ' ' + JSON.stringify(events));
    }, async request(command) {
      const id = ++seq;
      child.send({ seq: id, command });
      return this.next('reply:' + id);
    } };
    workers.push(instance);
    await instance.next('ready');
    return instance;
  }
  async function stop(w: Worker) {
    if (w.child.exitCode !== null || w.child.signalCode !== null) return;
    const exited = once(w.child, 'exit');
    w.child.kill('SIGKILL');
    await exited;
  }
  async function status(w: Worker, id: string, expected: string) {
    for (let n = 0; n < 100; n++) {
      const reply = await w.request({ op: 'status', id });
      if (reply.http === 200 && reply.body.status === expected) return reply.body;
      if (reply.http !== 200) assert.fail(JSON.stringify(reply));
      await delay(20);
    }
    assert.fail('expected status ' + expected);
  }
  async function verifyCancellation(home: string, sqlite: boolean) {
    await mkdir(home);
    const a = await start(home, sqlite), b = await start(home, sqlite), c = await start(home, sqlite);
    const submitHeld = async (options: Partial<Command> = {}) => {
      const id = randomUUID();
      await a.request({ op: 'submit', id, marker: id, cancellable: true, hold: true, ...options });
      assert.equal(await a.next('launch'), id);
      return id;
    };
    const cancel = (w: Worker, id: string, attempt = id) => w.request({ op: 'cancel', id, attempt });
    const uploads = join(home, 'public', 'media', 'uploads');

    const done = await submitHeld();
    await a.request({ op: 'release', id: done });
    assert.equal(await a.next('published'), done);
    assert.equal(await a.next('settled'), done);
    const complete = await status(c, done, 'succeeded');
    const donePath = join(uploads, basename(complete.result.path));
    const saved = await readFile(donePath);
    for (const peer of [b, c]) assert.equal((await cancel(peer, done)).http, 409);
    assert.deepEqual(await readFile(donePath), saved);
    assert.equal((await status(c, done, 'succeeded')).result.assetId, done);

    const cancelled = await submitHeld();
    assert.equal((await b.request({ op: 'cancel', id: cancelled })).http, 409, 'a new attempt requires the matching stop token');
    assert.equal((await cancel(b, cancelled, done)).http, 409, 'a stale attempt cannot cancel its replacement');
    assert.equal((await c.request({ op: 'remove', id: cancelled })).http, 409, 'cleanup cannot stop active work');
    const pending = await Promise.all([cancel(b, cancelled), cancel(c, cancelled)]);
    assert(pending.every(({ http }) => http === 202));
    assert.equal((await status(c, cancelled, 'running')).cancellationRequested, true);
    assert.equal(await a.next('abort-seen'), cancelled);
    assert.equal((await cancel(b, cancelled)).http, 202);
    await a.request({ op: 'release', id: cancelled });
    assert.equal(await a.next('cancel-cleaned'), cancelled);
    assert.equal(await a.next('settled'), cancelled);
    const cancelledJob = await status(c, cancelled, 'failed');
    assert.equal(cancelledJob.code, 'export_cancelled');
    assert.equal(cancelledJob.result, undefined);
    assert.equal(cancelledJob.timestamps.acceptedAt, undefined);
    for (const peer of [b, c]) assert.equal((await cancel(peer, cancelled)).http, 204);
    assert.equal((await status(b, cancelled, 'failed')).code, 'export_cancelled', 'repeat must retain the receipt');
    assert.equal((await c.request({ op: 'promote', id: cancelled })).http, 409);
    assert.equal(a.events.some(({ event, value }) => event === 'published' && value === cancelled), false);
    await assert.rejects(readFile(join(uploads, `openchatcut-export-job-${cancelled}.mp4`)), { code: 'ENOENT' });

    const retry = await submitHeld();
    if (sqlite && process.platform !== 'win32') {
      const removed = await b.request({ op: 'hide-sqlite', id: retry });
      assert.equal(removed, undefined);
      assert.equal((await cancel(b, retry)).http, 503, 'legacy must not replace unavailable SQLite authority');
      assert.equal((await c.request({ op: 'status', id: retry })).http, 503);
      assert.equal((await b.request({ op: 'restore-sqlite' })).status, 'running', 'old legacy bytes were not changed');
    }
    await b.request({ op: 'block-ledger' });
    assert.equal((await cancel(b, retry)).http, 503);
    await b.request({ op: 'restore-ledger' });
    await delay(300);
    assert.equal(a.events.some(({ event, value }) => event === 'abort-seen' && value === retry), false);
    await status(c, retry, 'running');
    assert.equal((await cancel(b, retry)).http, 202);
    assert.equal(await a.next('abort-seen'), retry);
    await a.request({ op: 'release', id: retry });
    assert.equal(await a.next('cancel-cleaned'), retry);
    assert.equal(await a.next('settled'), retry);
    assert.equal((await status(c, retry, 'failed')).code, 'export_cancelled');

    const late = await submitHeld({ fault: true });
    await a.request({ op: 'release', id: late });
    assert.equal(await a.next('settled'), late);
    await a.request({ op: 'restore-ledger' });
    assert.equal((await cancel(b, late)).http, 202);
    assert.equal(await a.next('cancel-cleaned'), late, 'peer request settles after terminal write failure without an owner GET');
    assert.equal((await status(c, late, 'failed')).code, 'export_cancelled');
    await assert.rejects(readFile(join(uploads, `openchatcut-export-job-${late}.mp4`)), { code: 'ENOENT' });

    for (const recoverFromStatus of sqlite ? [false, true] : []) {
      // SQLite can reject the row update after the finished file was renamed.
      // The owner then dies before its ordinary cancellation cleanup can run.
      const crashed = await start(home, sqlite);
      const id = randomUUID();
      await crashed.request({ op: 'submit', id, marker: id, cancellable: true, hold: true, fault: true, noObserver: true });
      assert.equal(await crashed.next('launch'), id);
      await crashed.request({ op: 'release', id });
      assert.equal(await crashed.next('published'), id);
      assert.equal(await crashed.next('settled'), id);
      await crashed.request({ op: 'restore-ledger' });
      if (recoverFromStatus) assert.equal((await cancel(b, id)).http, 202);
      await stop(crashed);
      const exposedPath = join(uploads, `openchatcut-export-job-${id}.mp4`);
      assert.equal(await readFile(exposedPath, 'utf8'), 'candidate bytes before terminal commit');
      if (!recoverFromStatus) assert.equal((await cancel(b, id)).http, 204);
      assert.equal((await status(c, id, 'failed')).code, 'export_cancelled');
      await assert.rejects(readFile(exposedPath), { code: 'ENOENT' }, 'recovering cancellation retracts the exposed attempt');
      assert.deepEqual(await readFile(donePath), saved, 'retraction leaves the previous completed attempt intact');
    }

    const abandoned = await submitHeld({ noObserver: true, accepted: true });
    const lost = b.request({ op: 'cancel', id: abandoned, attempt: abandoned, holdReply: true }).catch(() => undefined);
    assert.equal(await b.next('cancel-persisted'), 202);
    await stop(b);
    await lost;
    assert.equal((await cancel(c, abandoned)).http, 202);
    await stop(a);
    assert.equal(a.events.some(({ event, value }) => event === 'abort-seen' && value === abandoned), false);
    assert.equal((await status(c, abandoned, 'failed')).code, 'export_cancelled', 'warm status settles after owner death');
    const cold = await start(home, sqlite);
    const answers = await Promise.all([cancel(c, abandoned), cancel(cold, abandoned)]);
    assert(answers.every(({ http }) => http === 204));
    assert.equal((await status(cold, abandoned, 'failed')).code, 'export_cancelled');
    assert.equal(cold.events.some(({ event }) => event === 'resume-start' || event === 'launch'), false);
    assert.equal((await cancel(cold, randomUUID())).http, 404);
    assert.equal(await readFile(join(uploads, `.openchatcut-export-job-${abandoned}.mp4`), 'utf8'), 'partial');
    await assert.rejects(readFile(join(uploads, `openchatcut-export-job-${abandoned}.mp4`)), { code: 'ENOENT' });
    await Promise.all([stop(c), stop(cold)]);
    console.log('cross-process export cancellation', sqlite ? 'SQLite' : 'JSON', 'passed');
  }
  try {
    for (const sqlite of [false, true]) {
      const home = join(root, sqlite ? 'sqlite' : 'json');
      await mkdir(home);
      const a = await start(home, sqlite), b = await start(home, sqlite);
      const duplicate = '11111111-1111-4111-8111-111111111111';
      const separate = '22222222-2222-4222-8222-222222222222';
      const remains = '33333333-3333-4333-8333-333333333333';
      const live = '44444444-4444-4444-8444-444444444444';
      const pending = '55555555-5555-4555-8555-555555555555';
      const unknown = '66666666-6666-4666-8666-666666666666';
      const replies = await Promise.all([a.request({ op: 'submit', id: duplicate, marker: 'A' }),
        b.request({ op: 'submit', id: duplicate, marker: 'B' })]);
      assert(replies.every((reply) => reply.jobId === duplicate), JSON.stringify(replies));
      const initial = await status(a, duplicate, 'succeeded');
      assert.equal(a.events.concat(b.events).filter((e) => e.event === 'launch').length, 1);
      assert.equal((await status(b, duplicate, 'succeeded')).params.marker, initial.params.marker);
      await Promise.all([a.request({ op: 'submit', id: separate, marker: 'separate-A' }),
        b.request({ op: 'submit', id: remains, marker: 'separate-B' })]);
      const cold = await start(home, sqlite);
      assert.equal((await status(cold, separate, 'succeeded')).params.marker, 'separate-A');
      assert.equal((await status(cold, remains, 'succeeded')).params.marker, 'separate-B');
      assert.equal((await a.request({ op: 'progress', id: remains })).body.reports[0].status, 'succeeded');
      assert.equal((await b.request({ op: 'remove', id: separate })).http, 204);
      await a.request({ op: 'submit', id: '77777777-7777-4777-8777-777777777777', marker: 'fresh-write' });
      assert.equal((await cold.request({ op: 'status', id: separate })).http, 404);

      await a.request({ op: 'submit', id: live, marker: 'original', hold: true, accepted: true });
      await a.request({ op: 'submit', id: unknown, marker: 'never-accepted', hold: true, acceptanceFault: sqlite });
      await status(b, live, 'running'); await status(b, unknown, 'running');
      if (sqlite) await a.next('checkpoint-rejected');
      const rejectedCheckpoint = (await a.request({ op: 'progress', id: unknown })).body.reports[0];
      assert.equal(rejectedCheckpoint.providerTaskId, undefined, 'uncommitted provider identity stays private');
      assert.equal(rejectedCheckpoint.timestamps.acceptedAt, undefined);
      const observer = await start(home, sqlite);
      assert.equal((await status(observer, live, 'running')).providerTaskId, 'original-provider-id');
      await status(observer, unknown, 'running');
      const target = join(root, 'move-' + sqlite);
      const move = await b.request({ op: 'move', target });
      assert.equal(move.http, 400);
      assert.match(JSON.stringify(move.body), /export is still active/);
      assert.equal(observer.events.some((e) => e.event === 'resume-start'), false);
      await stop(a);
      await Promise.all([b.request({ op: 'recover' }), observer.request({ op: 'recover' })]);
      assert.equal((await status(cold, live, 'succeeded')).result.name, 'recovered');
      assert.equal((await status(cold, unknown, 'failed')).code, 'submission_unknown');
      const resumes = b.events.concat(observer.events).filter((e) => e.event === 'resume-start');
      assert.deepEqual(resumes.map((e) => e.value), ['original-provider-id']);

      await b.request({ op: 'submit', id: pending, marker: 'terminal-pending', fault: true });
      if (b.events.find((e) => e.event === 'settled' && e.value === pending) === undefined) {
        const deadline = Date.now() + 5000;
        while (!b.events.some((e) => e.event === 'settled' && e.value === pending) && Date.now() < deadline) await delay(10);
      }
      assert.equal((await b.request({ op: 'status', id: pending })).http, 503);
      assert.equal((await b.request({ op: 'promote', id: pending })).http, 503);
      await b.request({ op: 'restore-ledger' });
      assert.equal((await status(b, pending, 'succeeded')).result.name, 'terminal-pending');
      assert.equal(b.events.filter((e) => e.event === 'launch' && e.value === 'terminal-pending').length, 1);

      const copy = await start(home, sqlite, 'no-hardlink-kill');
      const copyCall = copy.request({ op: 'promote', id: pending }).catch(() => undefined);
      await copy.next('copy-paused');
      await stop(copy);
      await copyCall;
      const derived = join(home, 'public', 'media', 'uploads', 'openchatcut-derived-' + pending + '.mp4');
      await assert.rejects(readFile(derived), { code: 'ENOENT' });
      for (const mode of ['no-hardlink-corrupt', 'no-hardlink-conflict']) {
        const conflict = await start(home, sqlite, mode);
        assert.equal((await conflict.request({ op: 'promote', id: pending })).http, 500);
        await stop(conflict);
        if (mode === 'no-hardlink-conflict') {
          assert.equal(await readFile(derived, 'utf8'), 'unrelated bytes');
          await rm(derived);
        } else await assert.rejects(readFile(derived), { code: 'ENOENT' });
      }
      const fallback = await start(home, sqlite, 'no-hardlink-good');
      assert.equal((await fallback.request({ op: 'promote', id: pending })).http, 200);
      await stop(fallback);
      assert.match(await readFile(derived, 'utf8'), /complete synthetic output/);
      await assert.rejects(readFile(join(dirname(derived), '.' + basename(derived) + '.pending')), { code: 'ENOENT' });
      const partialName = 'openchatcut-export-job-' + unknown + '.mp4';
      assert.equal(await readFile(join(dirname(derived), partialName), 'utf8'), 'partial');
      const moved = await b.request({ op: 'move', target });
      assert.equal(moved.http, 200, JSON.stringify(moved));
      await assert.rejects(readFile(join(target, 'media', 'uploads', partialName)), { code: 'ENOENT' });
      assert.match(await readFile(join(target, 'media', 'uploads', 'openchatcut-export-job-' + pending + '.mp4'), 'utf8'), /complete synthetic output/);
      for (const w of [b, cold, observer]) await stop(w);
      console.log('generation-process', sqlite ? 'SQLite' : 'JSON', 'passed');
      await verifyCancellation(join(root, sqlite ? 'cancel-sqlite' : 'cancel-json'), sqlite);
    }
  } finally {
    await Promise.all(workers.map(stop));
    await rm(root, { recursive: true, force: true, maxRetries: 8 });
  }
}

if (process.argv[2] === '--worker') await worker();
else await main();
