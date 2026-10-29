// Real file-store read isolation; no production profile or provider calls.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'checkpoint-read-isolation-'));
const previousDataDir = process.env.OPENCHATCUT_DATA_DIR;
const previousFetch = globalThis.fetch;
process.env.OPENCHATCUT_DATA_DIR = root;
globalThis.fetch = async () => { throw new Error('Network forbidden'); };
try {
  const { setStoredEntry, getStoredEntry, withSerializedProjectStore } = await import('./project-store');
  const key = 'project:read-isolation';
  const committed = { marker: 'previously-committed' };
  await setStoredEntry(key, committed);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const writing = withSerializedProjectStore(async store => {
    await store.writeEntryExact(key, { marker: 'not-committed' });
    entered.resolve();
    try { await release.promise; }
    finally { await store.writeEntryExact(key, committed); }
  });
  await entered.promise;
  const reading = getStoredEntry(key);
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    // A bounded assertion that a reader is blocked, never a product wait/retry.
    const outcome = await Promise.race([
      reading.then(value => ({ state: 'read' as const, value })),
      new Promise<{ state: 'blocked' }>(resolve => { watchdog = setTimeout(() => resolve({ state: 'blocked' }), 100); }),
    ]);
    assert.equal(outcome.state, 'blocked', 'single-entry reads must not expose an in-flight write before rollback');
  } finally {
    clearTimeout(watchdog);
    release.resolve();
    await writing;
  }
  assert.deepEqual(await reading, { found: true, value: committed });
  assert.deepEqual(await getStoredEntry(key), { found: true, value: committed }, 'ordinary reads still work after the transaction');
  console.log('project-store-read-isolation: blocked during write, old committed value after rollback; zero providers');
} finally {
  globalThis.fetch = previousFetch;
  if (previousDataDir === undefined) delete process.env.OPENCHATCUT_DATA_DIR;
  else process.env.OPENCHATCUT_DATA_DIR = previousDataDir;
  await rm(root, { recursive: true, force: true });
}
