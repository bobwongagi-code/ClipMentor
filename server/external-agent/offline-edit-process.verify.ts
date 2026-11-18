import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, writeSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { revisionOf } from '../../src/agent/external-edit-session.ts';
import { historyReduce } from '../../src/editor/reducerHistory.ts';
import { editSessionId, projectDoc } from './offline-runtime.verify-fixtures.ts';
import type { ProjectEditOwnershipClaim } from './project-edit-ownership.ts';

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
  action: 'seed' | 'claim' | 'draft' | 'apply' | 'read' | 'browser' | 'reopen' | 'migration' | 'runs';
  id?: string;
  name?: string;
  time?: number;
  pause?: Pause | 'durable-commit';
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
  process.send?.({ event, value });
}

function instrument(command: Command): void {
  const pause = command.pause;
  const editedKey = projectKey(command.id ?? project);
  const maybePause = (key: string, when: Pause['when']) => {
    if (pause && pause !== 'durable-commit' && key === pause.key && when === pause.when) hold();
  };
  let writesProject = false;
  let committedProject = false;
  let reportedFault = false;
  const dbExec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function (sql) {
    try {
      if (sql === 'BEGIN' && command.failSearchIndex && committedProject && !reportedFault) {
        reportedFault = true;
        send('post-commit-fault');
        throw new Error('synthetic search index failure');
      }
      dbExec.call(this, sql);
      if (sql === 'COMMIT' && writesProject && !committedProject) {
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
    const key = decodeURIComponent(filename.slice(0, -5));
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
    const key = decodeURIComponent(filename.slice(0, -5));
    maybePause(key, 'before');
    await rename(source, destination);
    maybePause(key, 'after');
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

async function execute(command: Command): Promise<unknown> {
  const id = command.id ?? project;
  if (command.time) Date.now = () => command.time!;
  instrument(command);
  const { setStoredEntry, withSerializedProjectStore, writeProjectDocument } = await import('../plugins/project-store.ts');
  const { initializeSqliteProjectStore, sqliteStoreEnabled } = await import('../storage/sqlite-store.ts');
  const { claimOfflineProjectOwnership, claimBrowserProjectOwnership, releaseProjectEditOwnership } =
    await import('./project-edit-ownership.ts');
  const { OfflineExternalEditRuntime } = await import('./offline-runtime.ts');
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
    return withSerializedProjectStore(async (store) => (
      Object.fromEntries(await Promise.all(names.map(async (key) => [key, await store.readEntry(key)])))
    ));
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

function launch(root: string, mode: '0' | '1', command: Command, workers: Worker[]): Worker {
  const marker = join(root, `resume-${workers.length}`);
  const child = fork(fileURLToPath(import.meta.url), ['--worker', JSON.stringify(command)], {
    env: {
      ...process.env,
      OPENCHATCUT_DATA_DIR: root,
      OPENCHATCUT_SQLITE_STORE: mode,
      OPENCHATCUT_TEST_RESUME_FILE: marker,
    },
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
  });
  const paused = Promise.withResolvers<void>();
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
    if (message.event === 'result') result.resolve(message.value as Result);
    if (message.event === 'error') result.reject(new Error(String(message.value)));
  });
  child.once('exit', (code, signal) => {
    result.reject(new Error(`worker ${command.action} exited before response (${code ?? signal})`));
    exit.resolve(signal);
  });
  child.once('error', (error) => {
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
  for (const backend of ['0', '1'] as const) {
    if (!mode || mode === backend) await verify(backend, process.argv[3]);
  }
}
