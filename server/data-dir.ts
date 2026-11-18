// User-chosen storage root ("games-style save folder"): projects, versions and
// media live where the user asks, so removing or reinstalling the app never
// touches their work.
//
// The chosen path CANNOT live in the settings keystore: in an isolated dev
// profile the keystore file itself sits inside the storage root, so reading it
// would require already knowing the root. It is therefore recorded in a small
// pointer file at a fixed location that never moves.
import { lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { atomicWriteJson, durableRemove, durableRename } from './plugins/project-store-durable.ts';
import { projectEditRollbackPath, recoverLegacyProjectEdit } from './plugins/project-store-edit-journal.ts';
import { withProjectStoreProcessLock } from './plugins/project-store-process-lock.ts';
import { assertNoActiveExportForRelocation, unfinishedExportAttempts } from './plugins/generation-job-types.ts';
import {
  legacyProjectBulkPendingPath, legacyProjectStoreEntryPath, PROJECT_STORE_DIRECTORY, sqliteProjectStorePath,
  SQLITE_PROJECT_STORE_FILENAME, SQLITE_STORE_ENV,
} from './project-store-paths.ts';

/** Fixed pointer location — deliberately outside the movable storage root. */
export function dataDirPointerPath(home: string = homedir()): string {
  return join(home, '.openchatcut', 'data-dir.json');
}

/** Expand ~/ and require an absolute path; anything else is rejected. */
export function expandDataDir(raw: string, home: string = homedir()): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const expanded = trimmed === '~' ? home : trimmed.replace(/^~(?=\/)/, home);
  if (!isAbsolute(expanded)) return null;
  return resolve(expanded);
}

/** Recorded storage root, or null when the app uses its default location.
 *  Synchronous: the runtime profile resolves at module load. A malformed
 *  pointer degrades to the default rather than blocking startup. */
export function readDataDirPointer(home: string = homedir()): string | null {
  try { return readDataDirPointerAuthority(home); }
  catch { return null; }
}

/** Only absence means default when deciding whether writes or a cutover are safe. */
export function readDataDirPointerAuthority(home: string = homedir()): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(dataDirPointerPath(home), 'utf8'));
    if (!parsed || typeof parsed !== 'object') throw new Error('invalid data directory pointer');
    const value = (parsed as { dataDir?: unknown }).dataDir;
    const path = typeof value === 'string' ? expandDataDir(value, home) : null;
    if (!path) throw new Error('invalid data directory pointer');
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('could not verify the configured data directory', { cause: error });
  }
}

/** Record the storage root, or clear it (empty value) to return to the default. */
export async function writeDataDirPointer(dir: string | null, home: string = homedir()): Promise<void> {
  const pointer = dataDirPointerPath(home);
  await mkdir(join(home, '.openchatcut'), { recursive: true });
  try {
    if (dir) await atomicWriteJson(pointer, { version: 1, dataDir: dir });
    else await durableRemove(pointer);
  } catch (error) {
    // A directory sync can fail after rename/unlink already published the pointer.
    if (dir ? readDataDirPointerAuthority(home) !== resolve(dir) : await present(pointer)) throw error;
  }
}

export interface DataDirProbe { ok: boolean; note?: string; error?: string; }

/** Writability probe for the settings "test" action and for save-time validation. */
export async function checkDataDir(raw: string, currentDir: string): Promise<DataDirProbe> {
  if (!raw.trim()) return { ok: true, note: `未设置 · 使用默认目录 ${currentDir}` };
  const dir = expandDataDir(raw);
  if (!dir) return { ok: false, error: '必须是绝对路径（可用 ~/ 开头）' };
  try {
    await mkdir(dir, { recursive: true });
    const probe = join(dir, `.cc-data-probe-${randomUUID()}`);
    await writeFile(probe, 'ok', { flag: 'wx' });
    await unlink(probe);
    return { ok: true, note: `目录可写 · ${dir}` };
  } catch (err) {
    return { ok: false, error: `目录不可写 · ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Root-level entries that travel with a relocation. Media is NOT here: in the
 *  default profile uploads live outside the root (checkout `public/media/uploads`
 *  or packaged `userData/...`), so it is copied separately from the resolved
 *  upload directory. Anything else in the root is regenerated and left behind. */
const RELOCATED_ENTRIES = [
  PROJECT_STORE_DIRECTORY,
  'project-store-v1.json',
  'project-store-auth-v1',
  'deleted-projects-v1.json',
  'generation-operations-v1.json',
] as const;
const ALL_RELOCATABLE_ENTRIES = [...RELOCATED_ENTRIES, SQLITE_PROJECT_STORE_FILENAME] as const;
const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal', '.receipt.json'] as const;

/** Why a relocation was refused, so the caller can explain it to the user. */
export type RelocationRefusal = 'sqlite-store-active' | 'target-contains-data';

export interface RelocationOutcome {
  refused?: RelocationRefusal;
  copiedEntries: number;
}

type RelocatedEntry = typeof ALL_RELOCATABLE_ENTRIES[number];
interface RelocationRecord {
  version: 1;
  source: string;
  phase: 'copying' | 'ready';
  entries: RelocatedEntry[];
}

interface RelocationPublication {
  generationJobStore?: string;
  shouldPublish(): boolean;
  prepareTarget(unfinishedAttempts?: ReadonlySet<string>): Promise<void>;
  publishTarget(): Promise<void>;
}

const relocationRecordPath = (root: string) => join(root, '.data-dir-relocation-v1.json');

function readRelocationRecord(root: string): RelocationRecord | null {
  let raw: string;
  try {
    const path = relocationRecordPath(root);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid data directory relocation record');
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let record: Partial<RelocationRecord> | null;
  try { record = JSON.parse(raw); }
  catch { throw new Error('invalid data directory relocation record'); }
  if (record?.version !== 1 || typeof record.source !== 'string' || !isAbsolute(record.source)
    || (record.phase !== 'copying' && record.phase !== 'ready')
    || !Array.isArray(record.entries) || new Set(record.entries).size !== record.entries.length
    || record.entries.some((entry) => !ALL_RELOCATABLE_ENTRIES.includes(entry))) {
    throw new Error('invalid data directory relocation record');
  }
  return record as RelocationRecord;
}

function targetIsConfigured(root: string): boolean {
  const configured = readDataDirPointerAuthority() ?? join(homedir(), '.openchatcut');
  try { return realpathSync(configured) === realpathSync(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** SQLite probing must not open or create a database in an unpublished target. */
export function canOpenDataDirSqlite(root: string): boolean {
  try { return !readRelocationRecord(root); }
  catch { return false; }
}

/** Settle a pointer published just before the previous process was killed. */
export async function recoverDataDirSqlitePublication(root: string): Promise<void> {
  const record = readRelocationRecord(root);
  if (record?.phase === 'ready' && targetIsConfigured(root)) {
    await withProjectStoreProcessLock(root, () => assertDataDirRelocationReady(root));
  }
}

/** Called under the project store lock before opening or migrating a root. */
export async function assertDataDirRelocationReady(root: string): Promise<void> {
  const record = readRelocationRecord(root);
  if (!record) return;
  if (record.phase === 'ready' && targetIsConfigured(root)) {
    if (record.entries.includes(SQLITE_PROJECT_STORE_FILENAME)) {
      const { verifyRelocatedSqliteSnapshot } = await import('./storage/sqlite-relocation.ts');
      await verifyRelocatedSqliteSnapshot(sqliteProjectStorePath(root));
    }
    // A killed settings process may have switched the pointer before cleanup.
    try { await durableRemove(relocationRecordPath(root)); }
    catch (error) { if (await present(relocationRecordPath(root))) throw error; }
    return;
  }
  throw new Error('the data directory relocation is incomplete; retry it from the source directory');
}

async function present(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Bulk JSON imports have to finish before the directory is treated as a snapshot. */
export async function assertLegacyProjectBulkComplete(root: string): Promise<void> {
  if (await present(legacyProjectBulkPendingPath(root))) {
    throw new Error('a legacy project bulk write is incomplete; retry the original import');
  }
}

async function canonicalRoot(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(await canonicalRoot(dirname(path)), basename(path));
  }
}

function containsRoot(parent: string, child: string): boolean {
  const fragment = relative(parent, child);
  return Boolean(fragment) && fragment !== '..' && !fragment.startsWith(`..${sep}`) && !isAbsolute(fragment);
}

async function readSnapshotJson(path: string): Promise<unknown> {
  try {
    if (!(await lstat(path)).isFile()) throw new Error('not a regular file');
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('could not verify the project directory snapshot', { cause: error });
  }
}

/** Do not publish an unindexed project left by a multi-request create/import. */
async function checkProjectIndex(root: string): Promise<void> {
  const store = join(root, PROJECT_STORE_DIRECTORY);
  if (!(await lstat(store)).isDirectory()) throw new Error('unsupported project store directory');
  const index = await readSnapshotJson(legacyProjectStoreEntryPath(root, 'projects')) ?? [];
  const deleted = await readSnapshotJson(join(root, 'deleted-projects-v1.json')) ?? {};
  const ids = (await readdir(store)).flatMap((file) => {
    const match = /^project%3a([A-Za-z0-9_-]{1,160})\.json$/i.exec(file);
    return match ? [match[1]] : [];
  });
  assertProjectIndexCompleteness(index, ids, deleted);
}

export function assertProjectIndexCompleteness(index: unknown, ids: string[], deleted: unknown): void {
  if (!Array.isArray(index) || typeof deleted !== 'object' || deleted === null || Array.isArray(deleted)) {
    throw new Error('could not verify the project directory snapshot');
  }
  const docs = new Set(ids.filter((id) => !Object.hasOwn(deleted, id)));
  for (const entry of index) {
    const id = entry?.id;
    if (typeof id !== 'string' || (!Object.hasOwn(deleted, id) && !docs.delete(id))) {
      throw new Error('the project index and saved documents disagree; relocation is unavailable');
    }
  }
  if (docs.size) throw new Error('the project index and saved documents disagree; relocation is unavailable');
}

/** Publish one consistent snapshot and leave its source available for recovery. */
export async function relocateDataDir(
  source: string,
  target: string,
  log: (msg: string) => void,
  publication?: RelocationPublication,
): Promise<RelocationOutcome> {
  const [from, to] = await Promise.all([canonicalRoot(resolve(source)), canonicalRoot(resolve(target))]);
  if (from === to) {
    return withProjectStoreProcessLock(from, async () => {
      if (publication?.shouldPublish() === false) return { copiedEntries: 0 };
      await assertDataDirRelocationReady(from);
      await publication?.prepareTarget();
      await publication?.publishTarget();
      return { copiedEntries: 0 };
    });
  }
  if (containsRoot(from, to) || containsRoot(to, from)) {
    throw new Error('source and target data directories must not contain each other');
  }
  const [first, second] = [from, to].sort();
  return withProjectStoreProcessLock(first, () => withProjectStoreProcessLock(second, async () => {
    if (publication?.shouldPublish() === false) return { copiedEntries: 0 };
    await assertDataDirRelocationReady(from);
    const prior = readRelocationRecord(to);
    const resumable = prior?.source === from
      && (prior.phase === 'copying' || !targetIsConfigured(to));
    const staging = join(to, '.data-dir-relocation.incoming');
    if (await present(projectEditRollbackPath(to)) || await present(legacyProjectBulkPendingPath(to))) {
      return { refused: 'target-contains-data', copiedEntries: 0 };
    }
    for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
      if (await present(sqliteProjectStorePath(to) + suffix)) {
        return { refused: 'target-contains-data', copiedEntries: 0 };
      }
    }
    for (const entry of [...ALL_RELOCATABLE_ENTRIES, basename(staging)]) {
      const owned = resumable && (entry === basename(staging) || prior.entries.includes(entry as RelocatedEntry));
      if (!owned && await present(join(to, entry))) {
        log('[data-dir] relocation refused: the target already contains storage data');
        return { refused: 'target-contains-data', copiedEntries: 0 };
      }
    }
    if (prior && !resumable) return { refused: 'target-contains-data', copiedEntries: 0 };
    await assertLegacyProjectBulkComplete(from);

    // The backend may have changed while waiting for the directory lock.
    const sqliteSource = sqliteProjectStorePath(from);
    if (await present(sqliteSource)) {
      const configuredMode = process.env[SQLITE_STORE_ENV];
      if ((configuredMode !== undefined && configuredMode !== '1') || !(await lstat(sqliteSource)).isFile()) {
        return unavailableSqlite();
      }
      const { withSqliteRelocationSnapshot } = await import('./storage/sqlite-relocation.ts');
      return withSqliteRelocationSnapshot(sqliteSource, (save, ledger) =>
        save ? publishSnapshot(save, ledger) : unavailableSqlite());
    }
    if ((await Promise.all(SQLITE_SIDECAR_SUFFIXES.map((suffix) => present(sqliteSource + suffix)))).some(Boolean)) {
      return unavailableSqlite();
    }
    await recoverLegacyProjectEdit(from);
    const ledgerPath = publication?.generationJobStore ?? join(from, 'generation-operations-v1.json');
    const ledger = await readSnapshotJson(ledgerPath);
    assertNoActiveExportForRelocation(ledger);
    return publishSnapshot(undefined, ledger);

    async function unavailableSqlite(): Promise<RelocationOutcome> {
      log('[data-dir] relocation refused: SQLite authority could not be verified');
      return { refused: 'sqlite-store-active', copiedEntries: 0 };
    }

    async function publishSnapshot(saveSqlite?: (path: string) => Promise<void>, ledger?: unknown): Promise<RelocationOutcome> {
      if (resumable) {
        for (const entry of prior.entries) await durableRemove(join(to, entry), true);
        await durableRemove(staging, true);
      }
      const entries: RelocatedEntry[] = [];
      for (const entry of saveSqlite ? ['project-store-auth-v1'] as const : RELOCATED_ENTRIES) {
        if (await present(join(from, entry))) entries.push(entry);
      }
      if (saveSqlite) entries.push(SQLITE_PROJECT_STORE_FILENAME);
      const projectDirectory = entries.indexOf(PROJECT_STORE_DIRECTORY);
      if (projectDirectory !== -1) {
        if (entries.includes('project-store-v1.json') && !await present(join(from, PROJECT_STORE_DIRECTORY, '.ready'))) {
          // Old one-file storage still owns the data until its upgrade finishes.
          entries.splice(projectDirectory, 1);
        } else {
          await checkProjectIndex(from);
        }
      }
      const record: RelocationRecord = { version: 1, source: from, phase: 'copying', entries };
      await atomicWriteJson(relocationRecordPath(to), record);
      await mkdir(staging, { mode: 0o700 });
      for (const entry of entries) {
        const stagedEntry = join(staging, entry);
        if (entry === SQLITE_PROJECT_STORE_FILENAME && saveSqlite) {
          await saveSqlite(stagedEntry);
        } else await cp(join(from, entry), stagedEntry, {
          recursive: true, force: false, errorOnExist: true,
          filter: async (path) => {
            if (/\.\d+\.[\da-f-]{36}\.tmp$/i.test(basename(path))) return false;
            const item = await lstat(path);
            if (!item.isFile() && !item.isDirectory()) throw new Error('unsupported file in data directory relocation');
            return true;
          },
        });
        await durableRename(stagedEntry, join(to, entry));
      }
      await durableRemove(staging, true);
      await publication?.prepareTarget(unfinishedExportAttempts(ledger));
      if (publication) {
        await atomicWriteJson(relocationRecordPath(to), { ...record, phase: 'ready' });
        await publication.publishTarget();
        await durableRemove(relocationRecordPath(to)).catch(() => {
          log('[data-dir] relocation committed; could not remove its completion record');
        });
      } else {
        await durableRemove(relocationRecordPath(to));
      }
      if (entries.length > 0) log(`[data-dir] copied ${entries.length} entries: ${from} → ${to}`);
      return { copiedEntries: entries.length };
    }
  }));
}

/** Upload directory the relocated root will resolve to, so the caller can copy
 *  the existing media into it. Mirrors uploadDir()'s layout for a chosen root. */
export function relocatedUploadDir(target: string): string {
  return join(target, 'media', 'uploads');
}

/**
 * Media destination for a data-dir relocation. Setting the field moves media
 * next to the new root; clearing it returns to the default root, whose media
 * dir is checkout-relative and lives OUTSIDE rootDir (mirrors the no-dataDir
 * branch of resolveRuntimeProfile).
 */
export function relocatedMediaDestination(
  target: string | null,
  destination: string,
  defaultUploadDir: string,
): string {
  return target ? relocatedUploadDir(destination) : defaultUploadDir;
}

/** Create the storage root up-front so a first run never races the first write. */
export function ensureDataDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
