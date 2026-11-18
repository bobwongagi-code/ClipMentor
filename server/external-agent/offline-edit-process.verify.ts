import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, writeSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { revisionOf } from '../../src/agent/external-edit-session.ts';
import { historyReduce } from '../../src/editor/reducerHistory.ts';
import { editSessionId, projectDoc } from './offline-runtime.verify-fixtures.ts';
import type { ProjectEditOwnershipClaim } from './project-edit-ownership.ts';
import type { ViteDevServer } from 'vite';
import { sqliteProjectStorePath } from '../project-store-paths.ts';

const project = 'offline-process-project';
const sibling = 'offline-process-sibling';
const base = projectDoc();
const portrait = projectDoc(1080, 1920);
portrait.timelines[0].fit = 'contain';
const projectKey = (id: string) => `project:${id}`;
const checkpointKey = (id: string) => `offline-edit-session:${id}`;
const ownershipKey = (id: string) => `project-edit-ownership:${id}`;
const oldTime = 1_000_000;
const newTime = 2_000_000;
const later = (time: number) => time + 180_000;

type Pause = { key: string; when: 'before' | 'after' };
interface Command {
  action: 'seed' | 'claim' | 'draft' | 'apply' | 'read' | 'browser' | 'reopen' | 'migration' | 'runs'
    | 'relocate' | 'settings' | 'purge' | 'bulk' | 'generation-ledger'
    | 'sqlite-wal-write' | 'sqlite-contents' | 'sqlite-export-write';
  id?: string;
  name?: string;
  target?: string;
  extraSettings?: Record<string, unknown>;
  time?: number;
  pause?: Pause | 'durable-commit' | 'before-action' | 'sqlite-backup';
  failCommitAcknowledgement?: boolean;
  failSearchIndex?: boolean;
}
interface Row {
  found: boolean;
  value?: unknown;
}
type Snapshot = Record<string, Row>;
type Result = Record<string, unknown>;

const row = (snapshot: Result, key: string): Row => (snapshot as Snapshot)[key];

function send(event: string, value?: unknown): void {
  if (process.connected) process.send?.({ event, value }, () => undefined);
}

function instrument(command: Command): void {
  const pause = command.pause;
  const editedKey = projectKey(command.id ?? project);
  const maybePause = (key: string, when: Pause['when']) => {
    if (typeof pause === 'object' && key === pause.key && when === pause.when) hold();
  };
  let writesProject = false;
  let committedProject = false;
  let reportedFault = false;
  const dbExec = DatabaseSync.prototype.exec;
  if (command.pause === 'sqlite-backup' || command.name === 'damage-backup') {
    const sqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
    const nativeBackup = sqlite.backup;
    sqlite.backup = async (source, path, options) => {
      let paused = false;
      const pages = await nativeBackup(source, path, {
        ...options,
        progress: (status) => {
          options?.progress?.(status);
          if (!paused && command.pause === 'sqlite-backup' && status.remainingPages < status.totalPages
            && status.remainingPages > 0) {
            paused = true;
            hold();
          }
        },
      });
      if (command.name === 'damage-backup') await fs.writeFile(path, 'corrupted staged SQLite backup');
      return pages;
    };
  }
  if (command.action === 'settings' && command.name === 'media-race') {
    const link = fs.link;
    fs.link = async (source, target) => {
      if (typeof target === 'string' && basename(target) === 'fixture.mp4') {
        await fs.writeFile(target, 'concurrent upload', { flag: 'wx' });
      }
      return link(source, target);
    };
  }
  DatabaseSync.prototype.exec = function (sql) {
    try {
      if ((sql === 'BEGIN' || sql === 'BEGIN IMMEDIATE')
        && command.failSearchIndex && committedProject && !reportedFault) {
        reportedFault = true;
        send('post-commit-fault');
        throw new Error('synthetic search index failure');
      }
      dbExec.call(this, sql);
      if (sql === 'COMMIT' && (writesProject || command.action === 'migration') && !committedProject) {
        committedProject = true;
        if (pause === 'durable-commit') hold();
      }
    } catch (error) {
      if (sql === 'BEGIN IMMEDIATE' && (error as { errcode?: number }).errcode === 5) send('waiting');
      throw error;
    }
  };
  const remove = fs.rm;
  fs.rm = async (path, options) => {
    const filename = typeof path === 'string' ? basename(path) : '';
    const key = filename.endsWith('.json') ? decodeURIComponent(filename.slice(0, -5)) : filename;
    maybePause(key, 'before');
    await remove(path, options);
    maybePause(key, 'after');
    if (filename === 'project-edit-rollback-v1.json') {
      if (pause === 'durable-commit') hold();
      if (command.failCommitAcknowledgement) {
        send('post-commit-fault');
        throw new Error('synthetic error after unlinking the commit marker');
      }
    }
  };
  const rename = fs.rename;
  fs.rename = async (source, destination) => {
    const filename = typeof destination === 'string' ? basename(destination) : '';
    const key = filename.endsWith('.json') ? decodeURIComponent(filename.slice(0, -5)) : filename;
    maybePause(key, 'before');
    await rename(source, destination);
    maybePause(key, 'after');
    if (key === 'data-dir' && command.failCommitAcknowledgement) {
      throw new Error('synthetic error after publishing the directory pointer');
    }
  };
  syncBuiltinESMExports();
  const memory = new DatabaseSync(':memory:');
  const statements = Object.getPrototypeOf(memory.prepare('SELECT 1')) as StatementSync;
  memory.close();
  const dbRun = statements.run;
  statements.run = function (...args: SQLInputValue[]) {
    const key = typeof args[0] === 'string' ? args[0] : '';
    maybePause(key, 'before');
    const result = dbRun.apply(this, args);
    if (key === editedKey) writesProject = true;
    maybePause(key, 'after');
    return result;
  };
}

function hold(): void {
  // Synchronous notification also works in SQLite's synchronous transaction.
  writeSync(1, 'PAUSED\n');
  const resumeFile = process.env.OPENCHATCUT_TEST_RESUME_FILE!;
  const deadline = performance.now() + 15_000;
  const interval = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(resumeFile)) {
    if (performance.now() > deadline) throw new Error('test did not release the writer');
    Atomics.wait(interval, 0, 0, 10);
  }
}

async function saveSettings(target: string, extra: Record<string, unknown> = {}): Promise<Result> {
  const { settingsPlugin } = await import('../plugins/settings.ts');
  const configure = settingsPlugin().configureServer;
  assert.equal(typeof configure, 'function');
  const server = createServer();
  await (configure as (server: ViteDevServer) => void)({
    config: { logger: { info() {}, error() {} } },
    middlewares: { use: (_path, handler) => server.on('request', handler) },
  } as unknown as ViteDevServer);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    const answer = await fetch(`http://127.0.0.1:${address.port}/api/keys`, {
      method: 'POST',
      body: JSON.stringify({ OPENCHATCUT_DATA_DIR: target, ...extra }),
    });
    return { status: answer.status, body: await answer.json() };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function execute(command: Command): Promise<unknown> {
  const id = command.id ?? project;
  if (command.time) Date.now = () => command.time!;
  instrument(command);
  const { deleteStoredEntry, isStoredProjectDeleted, mergeStoredEntries, setStoredEntry, updateExportRecoveryLease,
    withSerializedProjectStore, writeProjectDocument } =
    await import('../plugins/project-store.ts');
  const { initializeSqliteProjectStore, runStorageMigration, sqliteStoreEnabled } =
    await import('../storage/sqlite-store.ts');
  const { claimOfflineProjectOwnership, claimBrowserProjectOwnership, releaseProjectEditOwnership } =
    await import('./project-edit-ownership.ts');
  const { OfflineExternalEditRuntime } = await import('./offline-runtime.ts');
  if (command.pause === 'before-action') {
    if (command.action === 'sqlite-export-write') await initializeSqliteProjectStore();
    hold();
  }
  if (command.action === 'settings') return saveSettings(command.target!, command.extraSettings);
  if (command.action === 'sqlite-export-write') {
    const renderId = '11111111-1111-4111-8111-111111111111';
    return updateExportRecoveryLease({
      operation: 'export-recovery-lease', key: `export-recovery:${renderId}`, action: 'claim',
      renderId, ownerInstanceId: 'relocation-fixture', leaseMs: 10_000,
    });
  }
  if (command.action === 'sqlite-wal-write' || command.action === 'sqlite-contents') {
    const { runtimeProfile } = await import('../runtime-profile.ts');
    const root = runtimeProfile().rootDir;
    if (command.action === 'sqlite-contents' && !(await initializeSqliteProjectStore()).enabled) {
      throw new Error('SQLite is not the authority at the requested data directory');
    }
    const { load } = await import('sqlite-vec');
    const db = new DatabaseSync(sqliteProjectStorePath(root), { allowExtension: true });
    try {
      load(db);
      const { GENERATION_JOBS_KV_KEY, DELETED_PROJECTS_KV_KEY } = await import('../storage/sqlite-migration.ts');
      if (command.action === 'sqlite-contents') {
        return {
          project: JSON.parse(String(db.prepare('SELECT v FROM kv WHERE k = ?').get(projectKey(project))?.v)),
          version: JSON.parse(String(db.prepare('SELECT v FROM kv WHERE k = ?').get(`versions:${project}`)?.v)),
          draft: db.prepare('SELECT v FROM kv WHERE k = ?').get(checkpointKey(project))?.v,
          index: JSON.parse(String(db.prepare("SELECT v FROM kv WHERE k = 'projects'").get()?.v)),
          ledger: db.prepare('SELECT v FROM kv WHERE k = ?').get(GENERATION_JOBS_KV_KEY)?.v,
          deleted: db.prepare('SELECT v FROM kv WHERE k = ?').get(DELETED_PROJECTS_KV_KEY)?.v,
          fts: db.prepare("SELECT body FROM relocation_search WHERE relocation_search MATCH 'snapshot'").all(),
          vec: db.prepare('SELECT rowid FROM relocation_vec').all(),
          payload: db.prepare('SELECT length(bytes) AS length FROM relocation_payload').get()?.length,
          integrity: db.prepare('PRAGMA quick_check').get()?.quick_check,
        };
      }
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
        CREATE VIRTUAL TABLE IF NOT EXISTS relocation_search USING fts5(body);
        CREATE VIRTUAL TABLE IF NOT EXISTS relocation_vec USING vec0(embedding float[2]);
        CREATE TABLE IF NOT EXISTS relocation_payload (bytes BLOB);
        PRAGMA wal_checkpoint(TRUNCATE); BEGIN IMMEDIATE;`);
      const write = db.prepare('INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v');
      const previous = command.name === 'new-base';
      const name = previous ? 'wal-base' : 'wal-updated';
      const previousIndex = JSON.parse(String(db.prepare("SELECT v FROM kv WHERE k = 'projects'").get()?.v));
      if (command.name === 'unindexed') write.run(projectKey('unindexed-project'), JSON.stringify(base));
      write.run(projectKey(project), JSON.stringify(previous ? base : portrait));
      write.run(`versions:${project}`, JSON.stringify([{ id: `${name}-version`, doc: base }]));
      write.run('projects', JSON.stringify(previousIndex.map((row: { id: string; name: string }) =>
        row.id === project ? { ...row, name } : row)));
      write.run(GENERATION_JOBS_KV_KEY, JSON.stringify({ version: 1, jobs: [{ id: name }] }));
      write.run(DELETED_PROJECTS_KV_KEY, JSON.stringify({ [sibling]: oldTime }));
      db.exec("DELETE FROM relocation_search; INSERT INTO relocation_search VALUES ('committed snapshot');");
      db.exec('DELETE FROM relocation_vec; DELETE FROM relocation_payload; INSERT INTO relocation_payload VALUES (zeroblob(1048576));');
      db.prepare('INSERT INTO relocation_vec (rowid, embedding) VALUES (?,?)').run(1n, new Float32Array([0, 1]));
      if (command.name === 'pause-uncommitted') hold();
      db.exec('COMMIT');
      if (command.name === 'keep-wal') hold();
      return { committed: true };
    } finally {
      db.close();
    }
  }
  if (command.action === 'purge') return deleteStoredEntry(projectKey(id)).then(() => ({ purged: true }));
  if (command.action === 'bulk') {
    return mergeStoredEntries({
      [projectKey(id)]: command.name === 'update' ? portrait : base,
      projects: [{ id, name: command.name === 'update' ? 'updated project' : id, updatedAt: command.name === 'update' ? 20 : 10 }],
    });
  }
  if (command.action === 'generation-ledger') {
    const { jobs, loadPersistedJobs, persistJobs } = await import('../plugins/generation-job-store.ts');
    if (command.name === 'write') await persistJobs();
    else await loadPersistedJobs();
    return command.name === 'migrate' ? runStorageMigration() : { count: jobs.size };
  }
  if (command.action === 'relocate') {
    const { relocateDataDir } = await import('../data-dir.ts');
    return relocateDataDir(process.env.OPENCHATCUT_DATA_DIR!, command.target!, () => undefined);
  }
  if (command.action === 'migration') return initializeSqliteProjectStore();
  if (command.action === 'runs') {
    const { activateOfflineAgentRuntimeBackend } = await import('./agent-runtime-persistence.ts');
    const { loadAgentRuntimeSidecar } = await import('../../src/persist/agentRuntimeStore.ts');
    activateOfflineAgentRuntimeBackend();
    return { runs: (await loadAgentRuntimeSidecar(id)).runs };
  }
  if (command.action === 'seed') {
    for (const key of [project, sibling]) {
      await setStoredEntry(projectKey(key), base);
      await setStoredEntry(`versions:${key}`, []);
    }
    await setStoredEntry('projects', [project, sibling].map((key) => ({ id: key, name: key, updatedAt: 1 })));
    return { sqlite: sqliteStoreEnabled() };
  }
  if (command.action === 'claim') return claimOfflineProjectOwnership(id, command.name!);
  if (command.action === 'read') {
    const names = [projectKey(id), ownershipKey(id), checkpointKey(id), `versions:${id}`, 'projects'];
    const rows = await withSerializedProjectStore(async (store) => (
      Object.fromEntries(await Promise.all(names.map(async (key) => [key, await store.readEntry(key)])))
    ));
    return { ...rows, siblingDeleted: await isStoredProjectDeleted(sibling) };
  }
  if (command.action === 'browser') {
    const current = command.name === 'undo' ? portrait : base;
    const edited = command.name === 'undo'
      ? historyReduce({ past: [base], present: portrait, future: [] }, { type: 'undo' }).present
      : portrait;
    const owner = await claimBrowserProjectOwnership(id, `browser-${process.pid}`, revisionOf(current));
    if (owner.status !== 'claimed') return owner;
    const result = await writeProjectDocument({
      operation: 'project-document-write',
      key: projectKey(id),
      value: edited,
      expectedRevision: owner.claim.baseRevision,
      ownerId: owner.claim.ownerId,
      ownershipEpoch: owner.claim.epoch,
    });
    await releaseProjectEditOwnership(owner.claim);
    return result;
  }
  const runtime = await OfflineExternalEditRuntime.create(id, 'http://127.0.0.1');
  try {
    const begin = await runtime.execute('begin_edit_session', { approvalMode: 'auto' });
    const sessionId = editSessionId(begin);
    if (command.action === 'reopen') return begin;
    if (command.action === 'draft' || id === sibling) {
      await runtime.execute('set_aspect_ratio', {
        editSessionId: sessionId,
        ratio: command.name === 'square' ? '1:1' : '9:16',
      });
    }
    if (command.action === 'draft') return begin;
    return await runtime.execute('review_edit_session', { editSessionId: sessionId });
  } finally {
    await runtime.dispose();
  }
}

interface Worker {
  child: ChildProcess;
  paused: Promise<void>;
  waiting: Promise<void>;
  postCommitFault: Promise<void>;
  result: Promise<Result>;
  exit: Promise<NodeJS.Signals | null>;
  release(): Promise<void>;
}

function launch(
  root: string,
  mode: '0' | '1',
  command: Command,
  workers: Worker[],
  desktop?: { home: string; cwd: string },
): Worker {
  const marker = join(desktop?.cwd ?? root, `resume-${workers.length}`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCHATCUT_DATA_DIR: root,
    OPENCHATCUT_SQLITE_STORE: mode,
    OPENCHATCUT_TEST_RESUME_FILE: marker,
  };
  if (desktop) {
    delete env.OPENCHATCUT_DATA_DIR;
    delete env.MEDIA_DIR;
    env.HOME = desktop.home;
    env.USERPROFILE = desktop.home;
  }
  const child = fork(fileURLToPath(import.meta.url), ['--worker', JSON.stringify(command)], {
    env,
    cwd: desktop?.cwd,
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
  });
  const paused = Promise.withResolvers<void>();
  void paused.promise.catch(() => undefined);
  const waiting = Promise.withResolvers<void>();
  const postCommitFault = Promise.withResolvers<void>();
  const result = Promise.withResolvers<Result>();
  void result.promise.catch(() => undefined);
  const exit = Promise.withResolvers<NodeJS.Signals | null>();
  let stdout = '';
  child.stdout!.on('data', (data: Buffer) => {
    stdout += data.toString();
    if (stdout.includes('PAUSED\n')) paused.resolve();
  });
  child.on('message', (message: { event: string; value: unknown }) => {
    if (message.event === 'waiting') waiting.resolve();
    if (message.event === 'post-commit-fault') postCommitFault.resolve();
    if (message.event === 'result') {
      paused.reject(new Error(`worker ${command.action} finished before its fault point: ${JSON.stringify(message.value)}`));
      result.resolve(message.value as Result);
    }
    if (message.event === 'error') {
      const error = new Error(String(message.value));
      paused.reject(error);
      result.reject(error);
    }
  });
  child.once('exit', (code, signal) => {
    const error = new Error(`worker ${command.action} exited before response (${code ?? signal})`);
    paused.reject(error);
    result.reject(error);
    exit.resolve(signal);
  });
  child.once('error', (error) => {
    paused.reject(error);
    result.reject(error);
    exit.resolve(null);
  });
  const worker: Worker = {
    child, paused: paused.promise, waiting: waiting.promise, postCommitFault: postCommitFault.promise,
    result: result.promise, exit: exit.promise, release: () => fs.writeFile(marker, ''),
  };
  workers.push(worker);
  return worker;
}

async function wait<T>(promise: Promise<T>, label: string): Promise<T> {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => deadline.reject(new Error(`timed out waiting for ${label}`)), 12_000);
  try { return await Promise.race([promise, deadline.promise]); }
  finally { clearTimeout(timer); }
}

async function kill(worker: Worker): Promise<void> {
  assert(worker.child.kill('SIGKILL'));
  assert.equal(await wait(worker.exit, 'SIGKILL'), 'SIGKILL');
}

async function verify(mode: '0' | '1', scenario?: string): Promise<void> {
  const root = await fs.mkdtemp(join(tmpdir(), `occ-edit-process-${mode}-`));
  const workers: Worker[] = [];
  const start = (command: Command) => launch(root, mode, command, workers);
  const run = (command: Command) => wait(start(command).result, command.action);
  const read = (id = project) => run({ action: 'read', id });
  async function expectWaiting(worker: Worker, label: string) {
    const result = await wait(Promise.race([
      worker.waiting.then(() => 'waiting'),
      worker.result.then(() => 'finished'),
    ]), label);
    assert.equal(result, 'waiting', `${label} must wait at the durable boundary`);
  }
  function assertUnchanged(actual: Result, expected: Result, keys: string[]) {
    for (const key of keys) assert.deepEqual(row(actual, key), row(expected, key), `${key} must survive abort`);
  }
  const protectedRows = [projectKey(project), checkpointKey(project), `versions:${project}`, 'projects'];
  try {
    assert.equal((await run({ action: 'seed' })).sqlite, mode === '1');
    if (!scenario || scenario === 'race') {
      const first = start({
        action: 'claim', name: 'first', time: oldTime,
        pause: { key: ownershipKey(project), when: 'before' },
      });
      await wait(first.paused, 'first claim before write');
      const second = start({ action: 'claim', name: 'second', time: oldTime });
      const contested = await wait(Promise.race([
        second.waiting.then(() => 'waiting'),
        second.result.then((result) => result.status),
      ]), 'second claim');
      await first.release();
      assert.equal((await wait(first.result, 'first claim')).status, 'claimed');
      assert.equal((await wait(second.result, 'other claim')).status, 'busy',
        `both processes raced a single ownership claim (second reached ${contested})`);
      assert.equal((row(await read(), ownershipKey(project)).value as ProjectEditOwnershipClaim).ownerId, 'first');

      if (mode === '0' && !scenario) {
        const slow = start({
          action: 'claim', id: sibling, name: 'slow', time: oldTime,
          pause: { key: ownershipKey(sibling), when: 'before' },
        });
        await wait(slow.paused, 'writer held past the lock deadline');
        const blocked = start({ action: 'read', id: sibling });
        await expectWaiting(blocked, 'bounded read');
        await assert.rejects(wait(blocked.result, 'bounded read timeout'), /project store is busy in another process/);
        await slow.release();
        assert.equal((await wait(slow.result, 'slow claim')).status, 'claimed');
        const competing = await run({ action: 'claim', id: sibling, name: 'late', time: oldTime });
        assert.equal(competing.status, 'busy');
      }
    }
    if (!scenario || scenario === 'crash') {
      const draft = await run({ action: 'draft', time: newTime });
      const before = await read();
      const partial = start({
        action: 'apply', time: newTime,
        pause: { key: projectKey(project), when: 'after' },
      });
      await wait(partial.paused, 'offline project write');
      const observer = start({ action: 'read' });
      // For the original red run, kill first and check the published rows.
      if (!scenario) await expectWaiting(observer, 'read of an unfinished commit');
      await kill(partial);
      const recovered = await wait(observer.result, 'recover after SIGKILL');
      assertUnchanged(recovered, before, protectedRows);
      assert.equal((row(recovered, ownershipKey(project)).value as ProjectEditOwnershipClaim).baseRevision, revisionOf(base));
      assert.equal((await run({ action: 'reopen', time: later(newTime) })).editSessionId, draft.editSessionId);
    }
    if (!scenario) {
      const before = await read();
      const beforeDraft = start({
        action: 'draft', name: 'square', time: later(newTime),
        pause: { key: checkpointKey(project), when: 'after' },
      });
      await wait(beforeDraft.paused, 'checkpoint row written');
      await kill(beforeDraft);
      assertUnchanged(await read(), before, protectedRows);

      if (mode === '0') {
        const partial = start({
          action: 'apply', time: later(later(newTime)),
          pause: { key: projectKey(project), when: 'after' },
        });
        await wait(partial.paused, 'second interrupted project write');
        await kill(partial);
        const recovery = start({
          action: 'read', pause: { key: projectKey(project), when: 'after' },
        });
        await wait(recovery.paused, 'interrupted rollback');
        await kill(recovery);
        const journal = join(root, 'project-edit-rollback-v1.json');
        const valid = await fs.readFile(journal);
        await fs.writeFile(journal, '{');
        await assert.rejects(read(), /JSON|Unexpected|Expected/);
        assert.equal(await fs.readFile(journal, 'utf8'), '{');
        const truncated = JSON.parse(valid.toString());
        delete truncated.originals[ownershipKey(project)];
        await fs.writeFile(journal, JSON.stringify(truncated));
        await assert.rejects(read(), /incomplete project edit rollback rows/);
        const changed = JSON.parse(valid.toString());
        changed.originals[ownershipKey(project)].value.baseRevision = 'wrong-revision';
        await fs.writeFile(journal, JSON.stringify(changed));
        await assert.rejects(read(), /checksum mismatch/);
        assert.equal(await fs.readFile(journal, 'utf8'), JSON.stringify(changed));
        await fs.writeFile(journal, valid);
        assertUnchanged(await read(), before, protectedRows);
        assert.equal(existsSync(journal), false);
      }

      const commitTime = later(later(later(newTime)));
      const independent = start({
        action: 'apply', time: commitTime, pause: { key: 'projects', when: 'after' },
        failCommitAcknowledgement: mode === '0',
        failSearchIndex: mode === '1',
      });
      await wait(independent.paused, 'first project index write');
      const siblingCommit = start({ action: 'apply', id: sibling, time: commitTime + 100 });
      await expectWaiting(siblingCommit, 'sibling project commit');
      await independent.release();
      assert.equal((await wait(independent.result, 'first project commit')).status, 'applied');
      await wait(independent.postCommitFault, 'fault after reaching the commit point');
      assert.equal((await wait(siblingCommit.result, 'sibling project commit')).status, 'applied');
      const committed = await read();
      assert.deepEqual(row(committed, projectKey(project)).value, portrait);
      assert.deepEqual(row(await read(sibling), projectKey(sibling)).value, portrait);
      const projects = row(committed, 'projects').value as Array<{ id: string; updatedAt: number }>;
      assert.equal(projects.find((entry) => entry.id === project)?.updatedAt, commitTime);
      assert.equal(projects.find((entry) => entry.id === sibling)?.updatedAt, commitTime + 100);

      assert.equal((await run({ action: 'browser', name: 'undo', time: commitTime + 500 })).accepted, true);
      const beforeBrowser = await read();
      const browser = start({
        action: 'browser', time: commitTime + 600,
        pause: { key: projectKey(project), when: 'after' },
      });
      await wait(browser.paused, 'browser document row written');
      const waitingOwner = start({ action: 'claim', name: 'after-browser', time: commitTime + 600 });
      await expectWaiting(waitingOwner, 'offline claim during browser save');
      await kill(browser);
      assert.equal((await wait(waitingOwner.result, 'claim after rollback')).status, 'busy');
      assertUnchanged(await read(), beforeBrowser, protectedRows);
      assert.equal((row(await read(), ownershipKey(project)).value as ProjectEditOwnershipClaim).baseRevision, revisionOf(base));

      const draftTime = later(commitTime);
      const finalDraft = await run({ action: 'draft', time: draftTime });
      const beforeFinalRow = await read();
      const finalRow = start({
        action: 'apply', time: draftTime,
        pause: { key: checkpointKey(project), when: 'after' },
      });
      await wait(finalRow.paused, 'last changed row before the commit point');
      await kill(finalRow);
      const rolledBack = await read();
      assertUnchanged(rolledBack, beforeFinalRow, protectedRows);
      assert.equal((row(rolledBack, ownershipKey(project)).value as ProjectEditOwnershipClaim).baseRevision, revisionOf(base));

      const lastTime = later(draftTime);
      const lastApply = start({
        action: 'apply', time: lastTime, pause: 'durable-commit',
      });
      await wait(lastApply.paused, 'applied edit before response');
      await kill(lastApply);
      const after = await read();
      assert.deepEqual(row(after, projectKey(project)).value, portrait);
      assert.equal(row(after, checkpointKey(project)).found, false);
      const { runs } = await run({ action: 'runs' }) as { runs: Array<{ status: string; externalSessionId?: string }> };
      const finished = runs.filter((entry) => entry.externalSessionId === finalDraft.editSessionId);
      assert(finished.length > 0, 'the interrupted Agent run exists');
      assert(!finished.some((entry) => entry.status === 'completed'), 'the Agent never received the post-commit acknowledgement');
      assert.equal((await run({ action: 'browser', name: 'undo', time: lastTime + 1 })).status, 'blocked');
      assert.equal((await run({ action: 'browser', name: 'undo', time: later(lastTime) })).accepted, true);
      const afterUndo = await run({ action: 'reopen', time: later(lastTime) + 1 });
      assert.equal(afterUndo.resumed, false);
      assert.notEqual(afterUndo.editSessionId, finalDraft.editSessionId);
      assert.deepEqual(row(await read(), projectKey(project)).value, base);

      if (mode === '0') {
        const migrationTime = later(later(lastTime));
        await run({ action: 'draft', time: migrationTime });
        const beforeMigration = await read();
        const interrupted = start({
          action: 'apply', time: migrationTime,
          pause: { key: projectKey(project), when: 'after' },
        });
        await wait(interrupted.paused, 'interrupted edit before SQLite migration');
        await kill(interrupted);
        const journal = join(root, 'project-edit-rollback-v1.json');
        const valid = await fs.readFile(journal);
        await fs.writeFile(journal, '{');
        const blocked = await wait(launch(root, '1', { action: 'migration' }, workers).result, 'blocked SQLite migration');
        assert.equal(blocked.phase, 'failed');
        assert.equal(blocked.enabled, false);
        assert.match(String(blocked.error), /rollback JSON/);
        await fs.writeFile(journal, valid);
        const migrated = await wait(launch(root, '1', { action: 'migration' }, workers).result, 'SQLite migration');
        assert.equal(migrated.phase, 'complete');
        assert.equal(migrated.enabled, true);
        const migratedRows = await wait(launch(root, '1', { action: 'read' }, workers).result, 'migrated snapshot');
        assertUnchanged(migratedRows, beforeMigration, protectedRows);
      }
    }
    console.log(`offline edit cross-process ${mode === '1' ? 'SQLite' : 'JSON'} passed`);
  } finally {
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGKILL');
    }
    await Promise.all(workers.map((worker) => worker.exit));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10 });
  }
}

async function verifyRelocation(scenario?: string): Promise<void> {
  const root = await fs.mkdtemp(join(tmpdir(), 'occ-data-relocation-'));
  const workers: Worker[] = [];
  const source = join(root, 'source');
  const target = join(root, 'target');
  const start = (command: Command, directory = source) => launch(directory, '0', command, workers);
  const run = (command: Command, directory = source) => wait(start(command, directory).result, command.action);
  const journal = join(source, 'project-edit-rollback-v1.json');
  const pointer = (home: string) => join(home, '.openchatcut', 'data-dir.json');
  const marker = (directory: string) => join(directory, '.data-dir-relocation-v1.json');
  const editKeys = [projectKey(project), checkpointKey(project), `versions:${project}`, 'projects'];
  async function waitAtLock(worker: Worker, label: string) {
    const result = await wait(Promise.race([
      worker.waiting.then(() => 'waiting'),
      worker.result.then(() => 'finished'),
    ]), label);
    assert.equal(result, 'waiting', label);
  }
  try {
    await run({ action: 'seed' });
    await run({ action: 'purge', id: sibling });
    await run({ action: 'draft', time: newTime });
    const before = await run({ action: 'read' });
    const writer = start({
      action: 'apply', time: newTime, pause: { key: projectKey(project), when: 'after' },
    });
    await wait(writer.paused, 'project edit before completion');
    if (scenario === 'active') {
      const relocation = start({ action: 'relocate', target });
      await waitAtLock(relocation, 'a live partial edit must hold the relocation');
      await writer.release();
      assert.equal((await wait(writer.result, 'committed edit')).status, 'applied');
      await wait(relocation.result, 'relocate committed edit');
      const moved = await run({ action: 'read' }, target);
      const after = await run({ action: 'read' });
      for (const key of editKeys) assert.deepEqual(row(moved, key), row(after, key));
      assert.deepEqual(row(moved, projectKey(project)).value, portrait);
      assert.equal(row(moved, checkpointKey(project)).found, false);
      const movedLease = row(moved, ownershipKey(project)).value as ProjectEditOwnershipClaim;
      const sourceLease = row(after, ownershipKey(project)).value as ProjectEditOwnershipClaim;
      assert.equal(movedLease.baseRevision, revisionOf(portrait));
      assert.equal(movedLease.epoch, sourceLease.epoch);
      assert.equal(movedLease.ownerId, sourceLease.ownerId);
      assert.equal(moved.siblingDeleted, true);
    } else {
      await kill(writer);
      const recovery = await fs.readFile(journal);
      await fs.writeFile(journal, '{');
      const refused = join(root, 'corrupt-source');
      await assert.rejects(run({ action: 'relocate', target: refused }), /invalid project edit rollback JSON/);
      assert.equal(existsSync(join(refused, 'project-store-v1')), false);
      assert.equal(await fs.readFile(journal, 'utf8'), '{');
      await fs.writeFile(journal, recovery);
      assert(Number((await run({ action: 'relocate', target })).copiedEntries) > 0);
      const moved = await run({ action: 'read' }, target);
      for (const key of editKeys) assert.deepEqual(row(moved, key), row(before, key), `relocation did not recover ${key}`);
      assert.equal((row(moved, ownershipKey(project)).value as ProjectEditOwnershipClaim).baseRevision, revisionOf(base));
      assert.equal(moved.siblingDeleted, true);
      const interruptedTarget = join(root, 'interrupted-target');
      const interrupted = start({
        action: 'relocate', target: interruptedTarget,
        pause: { key: 'project-store-v1', when: 'after' },
      });
      await wait(interrupted.paused, 'first target entry published');
      await kill(interrupted);
      await assert.rejects(run({ action: 'read' }, interruptedTarget), /data directory relocation is incomplete/);
      await assert.rejects(run({ action: 'claim', name: 'too-early' }, interruptedTarget), /data directory relocation is incomplete/);
      await assert.rejects(run({ action: 'generation-ledger', name: 'write' }, interruptedTarget), /data directory relocation is incomplete/);
      const prematureMigration = launch(interruptedTarget, '1', { action: 'migration' }, workers);
      assert.equal((await wait(prematureMigration.result, 'pending target SQLite migration')).enabled, false);
      assert.equal((await run({ action: 'browser', time: later(newTime) })).accepted, true);
      const otherSource = join(root, 'other-source');
      await run({ action: 'seed' }, otherSource);
      const retry = start({
        action: 'relocate', target: interruptedTarget,
        pause: { key: 'project-store-v1', when: 'after' },
      });
      await wait(retry.paused, 'same source retries a snapshot');
      const competing = start({ action: 'relocate', target: interruptedTarget }, otherSource);
      await waitAtLock(competing, 'another source waits for the target to finish');
      await retry.release();
      assert(Number((await wait(retry.result, 'relocation retry')).copiedEntries) > 0);
      assert.equal((await wait(competing.result, 'competing relocation')).refused, 'target-contains-data');
      assert.deepEqual(await run({ action: 'read' }, interruptedTarget), await run({ action: 'read' }));
      assert.equal(existsSync(marker(interruptedTarget)), false);

      const migrating = launch(source, '1', { action: 'migration', pause: 'durable-commit' }, workers);
      await wait(migrating.paused, 'SQLite authority committed under the source lock');
      const unavailable = start({ action: 'relocate', target: join(root, 'no-sqlite-copy') });
      await waitAtLock(unavailable, 'relocation waits while SQLite migration holds the lock');
      await migrating.release();
      assert.equal((await wait(migrating.result, 'completed SQLite migration')).enabled, true);
      assert.equal((await wait(unavailable.result, 'live SQLite source')).refused, 'sqlite-store-active');
      assert.equal((await run({ action: 'relocate', target: source }, otherSource)).refused, 'target-contains-data');
      const importedId = 'bulk-orphan';
      const bulk = start({
        action: 'bulk', id: importedId, pause: { key: projectKey(importedId), when: 'after' },
      }, otherSource);
      await wait(bulk.paused, 'bulk project before its index write');
      await kill(bulk);
      const orphanTarget = join(root, 'orphan-target');
      await assert.rejects(run({ action: 'relocate', target: orphanTarget }, otherSource), /legacy project bulk write is incomplete/);
      assert.equal(existsSync(join(orphanTarget, 'project-store-v1')), false);
      await run({ action: 'bulk', id: importedId }, otherSource);
      assert(Number((await run({ action: 'relocate', target: orphanTarget }, otherSource)).copiedEntries) > 0);
      assert.equal(row(await run({ action: 'read', id: importedId }, orphanTarget), projectKey(importedId)).found, true);
      const update = start({
        action: 'bulk', id: importedId, name: 'update', pause: { key: projectKey(importedId), when: 'after' },
      }, otherSource);
      await wait(update.paused, 'existing project changed before its index write');
      await kill(update);
      const mixed = await run({ action: 'read', id: importedId }, otherSource);
      assert.deepEqual(row(mixed, projectKey(importedId)).value, portrait);
      const entry = (row(mixed, 'projects').value as Array<{ id: string; name: string }>).find((item) => item.id === importedId);
      assert.equal(entry?.name, importedId, 'project IDs agree despite the incomplete update');
      const updateTarget = join(root, 'updated-project-target');
      await assert.rejects(run({ action: 'relocate', target: updateTarget }, otherSource), /legacy project bulk write is incomplete/);
      await assert.rejects(run({ action: 'bulk', id: importedId }, otherSource), /different legacy project bulk write/);
      const prematureBulkMigration = launch(otherSource, '1', { action: 'migration' }, workers);
      const blocked = await wait(prematureBulkMigration.result, 'interrupted bulk SQLite migration');
      assert.equal(blocked.enabled, false);
      assert.match(String(blocked.error), /legacy project bulk write is incomplete/);
      await run({ action: 'bulk', id: importedId, name: 'update' }, otherSource);
      assert(Number((await run({ action: 'relocate', target: updateTarget }, otherSource)).copiedEntries) > 0);
      const updated = await run({ action: 'read', id: importedId }, updateTarget);
      assert.deepEqual(row(updated, projectKey(importedId)).value, portrait);
      assert((row(updated, 'projects').value as Array<{ id: string; name: string }>)
        .some((item) => item.id === importedId && item.name === 'updated project'));

      const ledgerRoot = join(root, 'legacy-ledger');
      await fs.mkdir(ledgerRoot);
      await fs.writeFile(join(ledgerRoot, 'generation-operations-v1.json'), JSON.stringify({
        version: 1, jobs: [{
          id: 'ledger-test', status: 'succeeded', progress: 100, params: {}, createdAt: newTime, updatedAt: newTime,
        }],
      }));
      assert.equal((await run({ action: 'generation-ledger', name: 'migrate', time: newTime }, ledgerRoot)).receiptWritten, true);
      const ledgerRead = launch(ledgerRoot, '1', { action: 'generation-ledger', time: newTime }, workers);
      assert.equal((await wait(ledgerRead.result, 'hydrated ledger on SQLite')).count, 1);

      const desktop = { home: join(root, 'desktop-home'), cwd: join(root, 'desktop-cwd') };
      const desktopSource = join(desktop.home, '.openchatcut');
      const desktopTarget = join(root, 'desktop-target');
      const desktopStart = (command: Command) => launch(desktopSource, '0', command, workers, desktop);
      const desktopRun = (command: Command) => wait(desktopStart(command).result, command.action);
      const uploads = join(desktop.cwd, 'public', 'media', 'uploads');
      await fs.mkdir(uploads, { recursive: true });
      await fs.writeFile(join(uploads, 'fixture.mp4'), 'local test media');
      await desktopRun({ action: 'seed' });
      const invalid = await desktopRun({
        action: 'settings', target: desktopTarget, extraSettings: { MEDIA_DIR: 'relative/path' },
      });
      assert.equal(invalid.status, 400);
      assert.equal(existsSync(pointer(desktop.home)), false);
      assert.equal(existsSync(join(desktopTarget, 'project-store-v1')), false);
      assert.equal((await desktopRun({
        action: 'settings', target: desktopSource, failCommitAcknowledgement: true,
      })).status, 200, 'a pointer already published on disk must be reported as saved');
      assert.equal(await fs.readFile(join(desktopSource, 'media', 'uploads', 'fixture.mp4'), 'utf8'), 'local test media');
      const targetUploads = join(desktopTarget, 'media', 'uploads');
      await fs.mkdir(targetUploads, { recursive: true });
      const colliding = join(targetUploads, 'fixture.mp4');
      await fs.writeFile(colliding, 'different existing media');
      assert.equal((await desktopRun({ action: 'settings', target: desktopTarget })).status, 400);
      assert.equal(await fs.readFile(colliding, 'utf8'), 'different existing media');
      assert.equal(JSON.parse(await fs.readFile(pointer(desktop.home), 'utf8')).dataDir, desktopSource);
      await fs.unlink(colliding);
      assert.equal((await desktopRun({ action: 'settings', target: desktopTarget, name: 'media-race' })).status, 400);
      assert.equal(await fs.readFile(colliding, 'utf8'), 'concurrent upload');
      assert.equal(JSON.parse(await fs.readFile(pointer(desktop.home), 'utf8')).dataDir, desktopSource);
      await fs.unlink(colliding);
      const beforeSwitch = desktopStart({
        action: 'settings', target: desktopTarget, pause: { key: 'data-dir', when: 'before' },
      });
      await wait(beforeSwitch.paused, 'prepared Settings relocation before pointer publish');
      await kill(beforeSwitch);
      assert.equal(JSON.parse(await fs.readFile(pointer(desktop.home), 'utf8')).dataDir, desktopSource);
      await assert.rejects(run({ action: 'read' }, desktopTarget), /data directory relocation is incomplete/);
      const stale = desktopStart({ action: 'claim', name: 'stale-owner', time: newTime, pause: 'before-action' });
      await wait(stale.paused, 'old profile loaded');
      const afterSwitch = desktopStart({
        action: 'settings', target: desktopTarget, pause: { key: 'data-dir', when: 'after' },
      });
      await wait(afterSwitch.paused, 'pointer published before Settings reply');
      await kill(afterSwitch);
      await stale.release();
      await assert.rejects(wait(stale.result, 'old profile write'), /data directory has changed/);
      assert.equal(JSON.parse(await fs.readFile(pointer(desktop.home), 'utf8')).dataDir, desktopTarget);
      const reopened = await desktopRun({ action: 'read' });
      assert.deepEqual(row(reopened, projectKey(project)).value, base);
      assert.equal(existsSync(marker(desktopTarget)), false);
      assert.equal(await fs.readFile(join(desktopTarget, 'media', 'uploads', 'fixture.mp4'), 'utf8'), 'local test media');
    }
  } finally {
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGKILL');
    }
    await Promise.all(workers.map((worker) => worker.exit));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10 });
  }
  console.log('data directory relocation across project writers passed');
}

async function verifySqliteRelocation(): Promise<void> {
  const root = await fs.mkdtemp(join(tmpdir(), 'occ-sqlite-relocation-'));
  const workers: Worker[] = [];
  const source = join(root, 'sqlite-source');
  const start = (command: Command, directory = source) => launch(directory, '1', command, workers);
  const run = (command: Command, directory = source) => wait(start(command, directory).result, command.action);
  async function waiting(worker: Worker, label: string): Promise<void> {
    assert.equal(await wait(Promise.race([
      worker.waiting.then(() => 'waiting'),
      worker.result.then(() => 'completed'),
    ]), label), 'waiting');
  }
  const marker = (directory: string) => join(directory, '.data-dir-relocation-v1.json');
  function assertSnapshot(snapshot: Result, doc: unknown): void {
    const name = doc === base ? 'wal-base' : 'wal-updated';
    assert.equal(snapshot.integrity, 'ok');
    assert.deepEqual(snapshot.project, doc);
    assert.deepEqual(snapshot.version, [{ id: `${name}-version`, doc: base }]);
    assert.equal((snapshot.index as { id: string; name: string }[]).find(({ id }) => id === project)?.name, name);
    assert.deepEqual(snapshot.fts, [{ body: 'committed snapshot' }]);
    assert.deepEqual(snapshot.vec, [{ rowid: 1 }]);
    assert.equal(snapshot.payload, 1048576);
    assert.deepEqual(JSON.parse(String(snapshot.ledger)), { version: 1, jobs: [{ id: name }] });
    assert.deepEqual(JSON.parse(String(snapshot.deleted)), { [sibling]: oldTime });
  }
  try {
    await run({ action: 'seed' });
    const draft = await run({ action: 'draft', time: newTime });
    assert.equal(typeof draft.editSessionId, 'string');
    const wal = start({ action: 'sqlite-wal-write', name: 'keep-wal' });
    await wait(wal.paused, 'committed WAL retained by an open connection');
    assert((await fs.stat(sqliteProjectStorePath(source) + '-wal')).size > 0);
    const mainOnly = join(root, 'unsafe-main-only.sqlite3');
    await fs.copyFile(sqliteProjectStorePath(source), mainOnly);
    const wrongCopy = new DatabaseSync(mainOnly, { readOnly: true });
    try {
      const previous = wrongCopy.prepare('SELECT v FROM kv WHERE k = ?').get(projectKey(project));
      assert.deepEqual(JSON.parse(String(previous?.v)), base, 'a raw main file copy loses the committed update');
    } finally {
      wrongCopy.close();
    }
    const target = join(root, 'wal-target');
    assert.equal((await run({ action: 'relocate', target })).copiedEntries, 1);
    for (const suffix of ['-wal', '-shm', '-journal']) assert.equal(existsSync(sqliteProjectStorePath(target) + suffix), false);
    if (process.platform !== 'win32') assert.equal((await fs.stat(sqliteProjectStorePath(target))).mode & 0o777, 0o600);
    const snapshot = await run({ action: 'sqlite-contents' }, target);
    assertSnapshot(snapshot, portrait);
    assert.equal(JSON.parse(String(snapshot.draft)).sessionId, draft.editSessionId);
    assert.equal((await run({ action: 'relocate', target })).refused, 'target-contains-data');
    assert.deepEqual(await run({ action: 'sqlite-contents' }, target), snapshot);
    await wal.release();
    await wait(wal.result, 'finish the WAL witness');

    for (const commit of [true, false]) {
      await run({ action: 'sqlite-wal-write', name: 'new-base' });
      const writer = start({ action: 'sqlite-wal-write', name: 'pause-uncommitted' });
      await wait(writer.paused, 'SQLite writer transaction is still open');
      const nextTarget = join(root, commit ? 'after-commit' : 'after-kill');
      const move = start({ action: 'relocate', target: nextTarget });
      await waiting(move, 'relocate waits on the SQLite writer');
      if (commit) {
        await writer.release();
        await wait(writer.result, 'writer finishes its SQLite commit');
      } else {
        await kill(writer);
      }
      assert.equal((await wait(move.result, 'relocation after writer settled')).copiedEntries, 1);
      assertSnapshot(await run({ action: 'sqlite-contents' }, nextTarget), commit ? portrait : base);
    }

    for (const sidecar of ['.receipt.json', '-wal']) {
      const orphan = join(root, sidecar === '-wal' ? 'orphan-wal' : 'orphan-receipt');
      const refused = join(root, 'refused-' + basename(orphan));
      await fs.mkdir(orphan);
      await fs.writeFile(sqliteProjectStorePath(orphan) + sidecar, 'fixture SQLite evidence');
      assert.equal((await run({ action: 'relocate', target: refused }, orphan)).refused, 'sqlite-store-active');
      assert.equal(existsSync(sqliteProjectStorePath(refused)), false);
      assert.equal(await fs.readFile(sqliteProjectStorePath(orphan) + sidecar, 'utf8'), 'fixture SQLite evidence');
    }
    const noReceipt = join(root, 'missing-authority');
    await fs.mkdir(noReceipt);
    const unattributed = new DatabaseSync(sqliteProjectStorePath(noReceipt));
    unattributed.exec('CREATE TABLE kv(k TEXT, v TEXT)');
    unattributed.close();
    assert.equal((await run({ action: 'relocate', target: join(root, 'refused-no-authority') }, noReceipt)).refused, 'sqlite-store-active');

    const unindexed = join(root, 'sqlite-unindexed-source');
    const unindexedTarget = join(root, 'refused-unindexed-source');
    await run({ action: 'seed' }, unindexed);
    await run({ action: 'sqlite-wal-write', name: 'unindexed' }, unindexed);
    await assert.rejects(run({ action: 'relocate', target: unindexedTarget }, unindexed), /index and saved documents disagree/);
    assert.equal(existsSync(sqliteProjectStorePath(unindexedTarget)), false);
    const unchanged = new DatabaseSync(sqliteProjectStorePath(unindexed), { readOnly: true });
    try {
      assert(unchanged.prepare('SELECT 1 FROM kv WHERE k = ?').get(projectKey('unindexed-project')));
    } finally {
      unchanged.close();
    }

    const desktop = { home: join(root, 'home'), cwd: join(root, 'workspace') };
    const desktopSource = join(desktop.home, '.openchatcut');
    const desktopTarget = join(root, 'desktop-target');
    const desktopStart = (command: Command) => launch(desktopSource, '1', command, workers, desktop);
    const desktopRun = (command: Command) => wait(desktopStart(command).result, command.action);
    const uploads = join(desktop.cwd, 'public', 'media', 'uploads');
    const pointer = join(desktopSource, 'data-dir.json');
    await fs.mkdir(uploads, { recursive: true });
    await fs.writeFile(join(uploads, 'fixture.mp4'), 'in the SQLite app profile');
    await desktopRun({ action: 'seed' });
    await desktopRun({ action: 'sqlite-wal-write', name: 'new-base' });
    const backupWorker = desktopStart({ action: 'settings', target: desktopTarget, pause: 'sqlite-backup' });
    await wait(backupWorker.paused, 'actual online backup after copying some but not all pages');
    await kill(backupWorker);
    assert.equal(existsSync(pointer), false);
    assert.equal(existsSync(sqliteProjectStorePath(desktopTarget)), false);
    assert.equal((await run({ action: 'migration' }, desktopTarget)).enabled, false);
    assert.equal(existsSync(sqliteProjectStorePath(desktopTarget)), false);
    assert(existsSync(marker(desktopTarget)));
    assert.equal((await desktopRun({ action: 'settings', target: desktopTarget, name: 'damage-backup' })).status, 400);
    assert.equal(existsSync(pointer), false);
    assert.equal(existsSync(sqliteProjectStorePath(desktopTarget)), false);
    await desktopRun({ action: 'sqlite-wal-write' });

    const prepared = desktopStart({ action: 'settings', target: desktopTarget, pause: { key: 'data-dir', when: 'before' } });
    await wait(prepared.paused, 'database and media published before pointer');
    await kill(prepared);
    assert.equal(existsSync(pointer), false);
    assert(existsSync(sqliteProjectStorePath(desktopTarget)));
    assert.equal((await run({ action: 'migration' }, desktopTarget)).enabled, false);
    await desktopRun({ action: 'sqlite-wal-write', name: 'new-base' });
    const stale = desktopStart({ action: 'sqlite-export-write', pause: 'before-action' });
    await wait(stale.paused, 'old process loaded before pointer publication');
    const selected = desktopStart({ action: 'settings', target: desktopTarget, pause: { key: 'data-dir', when: 'after' } });
    await wait(selected.paused, 'pointer written, just before process acknowledged');
    await kill(selected);
    assert.equal(JSON.parse(await fs.readFile(pointer, 'utf8')).dataDir, desktopTarget);
    await stale.release();
    await assert.rejects(wait(stale.result, 'old process trying to write after switch'), /data directory has changed/);

    const dbPath = sqliteProjectStorePath(desktopTarget);
    const heldSnapshot = join(root, 'held-verified-snapshot.sqlite3');
    await fs.rename(dbPath, heldSnapshot);
    await assert.rejects(desktopRun({ action: 'sqlite-contents' }), /SQLite is not the authority/);
    assert(existsSync(marker(desktopTarget)), 'unknown snapshot must keep its recovery record');
    assert.equal(existsSync(dbPath), false, 'reopen must not bootstrap an empty replacement');
    await fs.rename(heldSnapshot, dbPath);
    assertSnapshot(await desktopRun({ action: 'sqlite-contents' }), base);
    assert.equal(existsSync(marker(desktopTarget)), false);
    assert.equal(await fs.readFile(join(desktopTarget, 'media', 'uploads', 'fixture.mp4'), 'utf8'), 'in the SQLite app profile');

    const nextDesktopTarget = join(root, 'desktop-queued-writer-target');
    const queued = desktopStart({ action: 'sqlite-export-write', pause: 'before-action' });
    await wait(queued.paused, 'old SQLite writer warmed before second relocation');
    const switching = desktopStart({
      action: 'settings', target: nextDesktopTarget, pause: { key: 'data-dir', when: 'before' },
    });
    await wait(switching.paused, 'second relocation ready while holding the source fence');
    await queued.release();
    await waiting(queued, 'old export writer waits before the pointer switches');
    await switching.release();
    assert.equal((await wait(switching.result, 'second Settings cutover')).status, 200);
    await assert.rejects(wait(queued.result, 'queued export writer after cutover'), /data directory has changed/);
    assert.equal(JSON.parse(await fs.readFile(pointer, 'utf8')).dataDir, nextDesktopTarget);
    assertSnapshot(await desktopRun({ action: 'sqlite-contents' }), base);
  } finally {
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGKILL');
    }
    await Promise.all(workers.map((worker) => worker.exit));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10 });
  }
  console.log('SQLite data-directory relocation: WAL, contention, SIGKILL, Settings cutover and cold reopen passed');
}

if (process.argv[2] === '--worker') {
  try {
    const result = await execute(JSON.parse(process.argv[3]));
    send('result', result);
  } catch (error) {
    send('error', error instanceof Error ? error.stack : String(error));
  } finally {
    process.disconnect?.();
  }
} else {
  const mode = process.argv[2];
  if (mode === 'relocate') await verifyRelocation(process.argv[3]);
  else if (mode === 'relocate-sqlite') await verifySqliteRelocation();
  else {
    for (const backend of ['0', '1'] as const) {
      if (!mode || mode === backend) await verify(backend, process.argv[3]);
    }
    if (!mode) {
      await verifyRelocation('active');
      await verifyRelocation();
      await verifySqliteRelocation();
    }
  }
}
