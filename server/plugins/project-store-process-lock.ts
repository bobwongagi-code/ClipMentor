import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

export async function beginSqliteWrite(lock: DatabaseSync): Promise<void> {
  const deadline = performance.now() + 5_000;
  for (;;) {
    try {
      lock.exec('BEGIN IMMEDIATE');
      return;
    } catch (error) {
      if ((error as { errcode?: number }).errcode !== 5) throw error;
      if (performance.now() >= deadline) throw new Error('project store is busy in another process', { cause: error });
      await delay(20);
    }
  }
}

/** Coordinate local processes without a stale lock file after process death. */
export async function withProjectStoreProcessLock<T>(directory: string, work: () => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // The lock database has no application rows. It stays separate from project
  // SQLite writes so the lock can safely span asynchronous legacy file writes.
  const lock = new DatabaseSync(join(directory, 'project-store-lock.sqlite3'));
  try {
    await beginSqliteWrite(lock);
    return await work();
  } finally {
    // Closing also releases an open write transaction on the lock database.
    lock.close();
  }
}
