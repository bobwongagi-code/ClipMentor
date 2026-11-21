import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, writeSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { basename, join } from 'node:path';
import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { revisionOf } from '../../src/agent/external-edit-session.ts';
import { historyReduce } from '../../src/editor/reducerHistory.ts';
import { editSessionId, projectDoc } from './offline-runtime.verify-fixtures.ts';
import type { ViteDevServer } from 'vite';
import { sqliteProjectStorePath } from '../project-store-paths.ts';

export const project = 'offline-process-project';
export const sibling = 'offline-process-sibling';
export const base = projectDoc();
export const portrait = projectDoc(1080, 1920);
portrait.timelines[0].fit = 'contain';
export const projectKey = (id: string) => `project:${id}`;
export const checkpointKey = (id: string) => `offline-edit-session:${id}`;
export const ownershipKey = (id: string) => `project-edit-ownership:${id}`;
export const oldTime = 1_000_000;
export const newTime = 2_000_000;
export const later = (time: number) => time + 180_000;

type Pause = { key: string; when: 'before' | 'after' };
export interface Command {
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
export type Result = Record<string, unknown>;

export const row = (snapshot: Result, key: string): Row => (snapshot as Snapshot)[key];

export function send(event: string, value?: unknown): void {
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

export async function execute(command: Command): Promise<unknown> {
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

export interface Worker {
  child: ChildProcess;
  paused: Promise<void>;
  waiting: Promise<void>;
  postCommitFault: Promise<void>;
  result: Promise<Result>;
  exit: Promise<NodeJS.Signals | null>;
  release(): Promise<void>;
}

export function launch(
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
  const child = fork(fileURLToPath(new URL('./offline-edit-process.verify.ts', import.meta.url)), ['--worker', JSON.stringify(command)], {
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

export async function wait<T>(promise: Promise<T>, label: string): Promise<T> {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => deadline.reject(new Error(`timed out waiting for ${label}`)), 12_000);
  try { return await Promise.race([promise, deadline.promise]); }
  finally { clearTimeout(timer); }
}

export async function kill(worker: Worker): Promise<void> {
  assert(worker.child.kill('SIGKILL'));
  assert.equal(await wait(worker.exit, 'SIGKILL'), 'SIGKILL');
}
