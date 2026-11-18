import { chmod, lstat, open } from 'node:fs/promises';
import sqlite, { DatabaseSync } from 'node:sqlite';
import { load as loadSqliteVec } from 'sqlite-vec';
import { beginSqliteWrite } from '../plugins/project-store-process-lock.ts';
import { assertProjectIndexCompleteness } from '../data-dir.ts';
import { DELETED_PROJECTS_KV_KEY, readAuthoritativeImportReceipt, RECEIPT_PHASE } from './sqlite-migration.ts';

type SaveSnapshot = (stagedPath: string) => Promise<void>;

function readAuthority(db: DatabaseSync) {
  const receipt = readAuthoritativeImportReceipt(db);
  const kv = db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'kv'").get();
  if (!receipt || receipt.phase < RECEIPT_PHASE || !kv) return null;
  const read = db.prepare('SELECT v FROM kv WHERE k = ?');
  const index = read.get('projects');
  const deleted = read.get(DELETED_PROJECTS_KV_KEY);
  const documents = db.prepare("SELECT substr(k, 9) AS id FROM kv WHERE substr(k, 1, 8) = 'project:'").all();
  assertProjectIndexCompleteness(
    index ? JSON.parse(String(index.v)) : [],
    documents.map(({ id }) => String(id)),
    deleted ? JSON.parse(String(deleted.v)) : {},
  );
  return receipt;
}

export async function verifyRelocatedSqliteSnapshot(path: string) {
  if (!(await lstat(path)).isFile()) throw new Error('invalid relocated SQLite snapshot file');
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: true });
  try {
    const schema = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND sql IS NOT NULL").all();
    if (schema.some(({ sql }) => /\busing\s+vec0\s*\(/i.test(String(sql)))) loadSqliteVec(db);
    const results = db.prepare('PRAGMA quick_check').all();
    const authority = readAuthority(db);
    if (!authority || results.length !== 1 || results[0].quick_check !== 'ok') {
      throw new Error('SQLite relocation snapshot did not pass verification');
    }
    return authority;
  } finally {
    db.close();
  }
}

/** Keep a writer fence until the caller finishes the directory cutover. */
export async function withSqliteRelocationSnapshot<T>(
  sourcePath: string,
  relocate: (saveSnapshot: SaveSnapshot | null) => Promise<T>,
): Promise<T> {
  const writerFence = new DatabaseSync(sourcePath);
  try {
    await beginSqliteWrite(writerFence);
    const reader = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      const authority = readAuthority(reader);
      if (!authority) return await relocate(null);
      return await relocate(async (stagedPath) => {
        await sqlite.backup(reader, stagedPath, { rate: 64 });
        await chmod(stagedPath, 0o600);
        const staged = new DatabaseSync(stagedPath);
        try {
          // Publish one independent file. No WAL or SHM from the source or
          // from verification may be needed to read it after reopening.
          staged.exec('PRAGMA journal_mode = DELETE');
        } finally {
          staged.close();
        }
        if (JSON.stringify(await verifyRelocatedSqliteSnapshot(stagedPath)) !== JSON.stringify(authority)) {
          throw new Error('SQLite relocation snapshot does not match the source authority');
        }
        const file = await open(stagedPath, 'r+');
        try { await file.sync(); }
        finally { await file.close(); }
      });
    } finally {
      reader.close();
    }
  } finally {
    writerFence.close();
  }
}
