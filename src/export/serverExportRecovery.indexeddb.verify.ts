import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { build } from 'esbuild';
import { openBrowser } from '@remotion/renderer';

// Use the already installed product browser, never download one. A fresh browser
// profile exercises native IndexedDB transactions across two isolated tabs.
const platform = process.platform === 'darwin' ? 'mac' : process.platform;
const executable = process.env.CC_BROWSER_EXECUTABLE ?? join(process.cwd(), 'node_modules/.remotion/chrome-headless-shell',
  `${platform}-${process.arch}`, `chrome-headless-shell-${platform}-${process.arch}`, 'chrome-headless-shell');
await access(executable);
const bundle = await build({
  stdin: { contents: `import * as api from './src/export/serverExportRecovery.ts';
    import * as store from './src/export/serverExportRecoveryStore.ts';
    window.fixture={...api,...store};window.fetch=()=>{throw Error('No provider or product API request allowed')};`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'iife', platform: 'browser', plugins: [{ name: 'standalone-only', setup(b) {
    b.onResolve({ filter: /projectStoreTransport$/ }, () => ({ path: 'standalone-only', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const projectStoreRemoteAvailable=()=>false;
      export const projectStoreWriteCredential=()=>false;export const requestProjectStore=()=>{throw Error('No remote store')};` }));
  } }],
});
const source = bundle.outputFiles[0].text;
const server = createServer((req, res) => {
  if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(source); }
  else if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<script src="/fixture.js"></script>'); }
  else { res.statusCode = 404; res.end(); }
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const address = server.address(); assert(address && typeof address === 'object');
let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
try {
  browser = await openBrowser('chrome', { browserExecutable: executable, logLevel: 'error' });
  const page = () => browser!.newPage({ context: () => null, logLevel: 'error', indent: false, pageIndex: 0, onBrowserLog: null, onLog: () => {} });
  const tabs = await Promise.all([page(), page()]);
  await Promise.all(tabs.map(p => p.goto({ url: `http://127.0.0.1:${address.port}`, timeout: 10_000 })));
  await tabs[0].evaluate(async () => {
    const f = (window as any).fixture;
    await f.persistServerExportJob({ version: 1, renderId: 'native', projectId: 'fixture-project', label: 'native.mp4',
      targetPath: null, createdAt: 1, updatedAt: 1, format: 'video', codec: 'h264', base: 'fixture', fps: 30,
      state: { fps: 30, items: [] }, destination: { type: 'downloads', label: 'downloads' }, autoQaEnabled: false, stage: 'polling' });
  });
  const claims = await Promise.all(tabs.map(p => p.evaluate(() => (window as any).fixture.claimServerExportDelivery('native'))));
  assert.equal(claims.filter(Boolean).length, 1, 'Native IndexedDB must serialize two independent tab claims');
  const winner = tabs[claims[0] ? 0 : 1], claim = claims.find(Boolean);
  const result = await winner.evaluate(async (claim) => {
    const f = (window as any).fixture;
    let earlyCommitRejected = false;
    try { await f.markServerExportTargetCommitted('native', claim); } catch { earlyCommitRejected = true; }
    await f.markServerExportOutputReady('native');
    await f.markServerExportDeliveryAmbiguous('native', claim);
    const rebound = await f.rebindServerExportJob('native', { type: 'downloads', label: 'new destination' }, 'new.mp4', claim);
    await f.markServerExportTargetCommitted('native', claim);
    const committed = JSON.stringify(await f.readLocalRecord('native'));
    let lateErrorRejected = false, lateRebindRejected = false;
    try { await f.markServerExportDeliveryAmbiguous('native', claim); } catch { lateErrorRejected = true; }
    try { await f.rebindServerExportJob('native', { type: 'downloads', label: 'old' }, 'old.mp4', claim); } catch { lateRebindRejected = true; }
    await f.markServerExportOutputReady('native');
    const stale = { ...await f.readLocalRecord('native'), stage: 'polling', updatedAt: Number.MAX_SAFE_INTEGER };
    await f.persistServerExportJob(stale);
    return { earlyCommitRejected, lateErrorRejected, lateRebindRejected, reboundStage: rebound.stage,
      committedPreserved: JSON.stringify(await f.readLocalRecord('native')) === committed };
  }, claim);
  assert.deepEqual(result, { earlyCommitRejected: true, lateErrorRejected: true, lateRebindRejected: true,
    reboundStage: 'output-ready', committedPreserved: true });
  const rollback = await winner.evaluate(async () => {
    const f = (window as any).fixture, before = JSON.stringify(await f.readLocalRecord('native'));
    let reducerRejected = false, cloneRejected = false;
    try { await f.mutateLocalRecord('native', () => { throw Error('injected validation failure'); }); } catch { reducerRejected = true; }
    try { await f.mutateLocalRecord('native', (row: any) => ({ result: 'must not return success', next: { ...row, uncloneable: () => 0 } })); } catch { cloneRejected = true; }
    return { reducerRejected, cloneRejected, unchanged: JSON.stringify(await f.readLocalRecord('native')) === before };
  });
  assert.deepEqual(rollback, { reducerRejected: true, cloneRejected: true, unchanged: true }, 'Aborted native transactions cannot publish success or lose the saved result');
  const future = await winner.evaluate(async () => {
    const f = (window as any).fixture, current = await f.readLocalRecord('native');
    const unknown = { ...current, version: 2 };
    await f.writeLocalRecord(unknown);
    let refused = false;
    try { await f.persistServerExportJob(current); } catch { refused = true; }
    // Read the raw row: a filtered reader intentionally hides unsupported versions.
    const db: IDBDatabase = await new Promise((resolve, reject) => { const r = indexedDB.open('openchatcut-server-export-recovery', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try {
      const raw = await new Promise((resolve, reject) => { const r = db.transaction('jobs', 'readonly').objectStore('jobs').get('native'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      return { refused, preserved: JSON.stringify(raw) === JSON.stringify(unknown) };
    } finally { db.close(); }
  });
  assert.deepEqual(future, { refused: true, preserved: true }, 'Unknown future records must not be overwritten as missing');
  console.log('Native IndexedDB: two-tab single owner, stage parity, explicit reselection, terminal/stale-registration fences, validation/DataCloneError rollback passed; provider/render calls 0');
} finally {
  await browser?.close({ silent: true });
  server.closeAllConnections();
  await new Promise<void>(r => server.close(() => r()));
}
