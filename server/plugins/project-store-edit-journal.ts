import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeProfile } from '../runtime-profile.ts';
import { atomicWriteJson, durableRemove } from './project-store-durable.ts';
import type { LockedProjectStore, StoredEntryValue } from './project-store-locked.ts';

type EditRows = Readonly<Record<string, StoredEntryValue>>;
export type CommitEditRows = (
  changes: EditRows,
  originals: EditRows,
  canCommit: () => boolean,
) => Promise<boolean>;

const rollbackPath = (profile: RuntimeProfile) => join(profile.rootDir, 'project-edit-rollback-v1.json');
const editableKey = /^(?:project|versions|project-edit-ownership|offline-edit-session):([A-Za-z0-9_-]{1,160})$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const checksum = (rows: unknown): string => createHash('sha256').update(JSON.stringify(rows)).digest('hex');

function editRows(value: unknown): EditRows {
  if (!isRecord(value)) throw new Error('invalid project edit rollback rows');
  const projects = new Set<string>();
  for (const [key, entry] of Object.entries(value)) {
    const project = editableKey.exec(key)?.[1];
    if (project) projects.add(project);
    if ((!project && key !== 'projects') || !isRecord(entry) || typeof entry.found !== 'boolean'
      || (entry.found && !Object.hasOwn(entry, 'value'))) throw new Error('invalid project edit rollback row');
  }
  if (projects.size !== 1) throw new Error('invalid project edit rollback scope');
  const [project] = projects;
  const has = (prefix: string) => Object.hasOwn(value, `${prefix}:${project}`);
  const document = has('project');
  const draft = has('offline-edit-session');
  const versions = has('versions');
  const index = Object.hasOwn(value, 'projects');
  if (!has('project-edit-ownership') || versions !== index || (versions && !document)
    || (!document && !draft) || (document && draft && !versions)) {
    throw new Error('incomplete project edit rollback rows');
  }
  return value as EditRows;
}

function legacyEditRowPath(profile: RuntimeProfile, key: string): string {
  return key === 'projects'
    ? profile.projectStore.indexPath
    : join(profile.projectStore.directory, `${encodeURIComponent(key)}.json`);
}

/** Replay the durable undo record while holding the common process lock. */
export async function recoverLegacyProjectEdit(profile: RuntimeProfile): Promise<void> {
  const path = rollbackPath(profile);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  let journal: unknown;
  try {
    journal = JSON.parse(raw);
  } catch (error) {
    throw new Error('invalid project edit rollback JSON', { cause: error });
  }
  if (!isRecord(journal) || journal.version !== 1) throw new Error('unsupported project edit rollback record');
  const originals = editRows(journal.originals);
  if (journal.sha256 !== checksum(originals)) throw new Error('project edit rollback checksum mismatch');
  for (const [key, original] of Object.entries(originals).reverse()) {
    const destination = legacyEditRowPath(profile, key);
    if (original.found) await atomicWriteJson(destination, original.value);
    else await durableRemove(destination);
  }
  await durableRemove(path);
}

type EditStore = Pick<LockedProjectStore, 'writeEntry' | 'removeEntry' | 'commitEditRows'>;

async function writeRows(
  store: Pick<EditStore, 'writeEntry' | 'removeEntry'>,
  changes: EditRows,
  canCommit: () => boolean,
  written?: string[],
): Promise<boolean> {
  for (const [key, entry] of Object.entries(changes)) {
    if (!canCommit()) return false;
    // A write can reach disk and then fail while acknowledging durability.
    written?.push(key);
    if (entry.found) await store.writeEntry(key, entry.value);
    else await store.removeEntry(key);
  }
  return canCommit();
}

export async function commitProjectEditRows(
  store: EditStore,
  changes: EditRows,
  originals: EditRows,
  canCommit: () => boolean,
): Promise<boolean> {
  if (store.commitEditRows) return store.commitEditRows(changes, originals, canCommit);
  // In-memory adapters use this path. Production supplies a durable commit.
  const written: string[] = [];
  try {
    if (await writeRows(store, changes, canCommit, written)) return true;
  } catch (error) {
    await restore();
    throw error;
  }
  await restore();
  return false;

  async function restore(): Promise<void> {
    for (const key of written.reverse()) {
      const original = originals[key];
      if (original.found) await store.writeEntry(key, original.value);
      else await store.removeEntry(key);
    }
  }
}

export async function commitLegacyProjectEdit(
  profile: RuntimeProfile,
  store: Pick<LockedProjectStore, 'writeEntry' | 'removeEntry'>,
  changes: EditRows,
  originals: EditRows,
  canCommit: () => boolean,
): Promise<boolean> {
  if (!canCommit()) return false;
  const path = rollbackPath(profile);
  const before = editRows(originals);
  if (Object.keys(changes).length !== Object.keys(before).length
    || Object.keys(changes).some((key) => !Object.hasOwn(before, key))) {
    throw new Error('project edit changes do not match rollback rows');
  }
  await atomicWriteJson(path, { version: 1, originals: before, sha256: checksum(before) });
  let applied: boolean;
  try {
    applied = await writeRows(store, changes, canCommit);
  } catch (error) {
    await recoverLegacyProjectEdit(profile);
    throw error;
  }
  if (!applied) {
    await recoverLegacyProjectEdit(profile);
    return false;
  }
  try {
    await durableRemove(path);
  } catch (error) {
    // Unlink and directory sync are separate operations. The marker's actual
    // presence still decides a process-crash recovery while this lock is held.
    try {
      await stat(path);
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw readError;
    }
    await recoverLegacyProjectEdit(profile);
    throw error;
  }
  return true;
}
