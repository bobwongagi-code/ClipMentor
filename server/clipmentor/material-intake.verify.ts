import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'clipmentor-intake-'));
process.env.OPENCHATCUT_DATA_DIR = root;
process.env.OPENCHATCUT_DEV_PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const { createMaterialIntakeHandler } = await import('./material-intake');
const { setStoredEntry } = await import('../plugins/project-store');
const { loadOfflineStoredProject } = await import('../external-agent/offline-project-store');
const { ffmpegBin } = await import('../media-binaries');
const { uploadDir } = await import('../media-dir');
const id = 'intake-regression';
const server = createServer(createMaterialIntakeHandler());
try {
  await setStoredEntry('projects', [{ id, name: 'Intake regression', updatedAt: 1 }]);
  await setStoredEntry(`project:${id}`, {
    version: 3, assets: [], mediaFolders: [], activeTimelineId: 'timeline',
    timelines: [{ id: 'timeline', name: 'Sequence', order: 0, fps: 30, width: 576, height: 1024,
      items: [], selectedId: null, trackOrder: ['track_v1'], tracks: { track_v1: { kind: 'video' } } }],
  });
  const videoPath = join(root, 'fixture.mp4'), imagePath = join(root, 'fixture.png');
  execFileSync(ffmpegBin(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=s=32x48',
    '-f', 'lavfi', '-i', 'sine=frequency=500', '-t', '0.3', '-c:v', 'libx264', '-c:a', 'aac', videoPath]);
  execFileSync(ffmpegBin(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=s=32x48',
    '-frames:v', '1', '-threads', '1', imagePath]);
  const video = new Blob([new Uint8Array(await readFile(videoPath))], { type: 'video/mp4' });
  const image = new Blob([new Uint8Array(await readFile(imagePath))], { type: 'image/png' });
  const ctaPath = join(root, 'cta.png');
  execFileSync(ffmpegBin(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x48',
    '-frames:v', '1', '-threads', '1', ctaPath]);
  const cta = new Blob([new Uint8Array(await readFile(ctaPath))], { type: 'image/png' });
  function body(source = video, salesName = '销量图.png', ctaFile = cta, ctaName = 'CTA.png') {
    const form = new FormData();
    form.append('source', source, '爆款视频.mp4');
    form.append('product', image, '产品图.png');
    form.append('sales', image, salesName);
    form.append('cta', ctaFile, ctaName);
    return form;
  }
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const endpoint = `${origin}/?projectId=${id}`;
  const headers = { origin, 'sec-fetch-site': 'same-origin' };
  const submit = (form: FormData) => fetch(endpoint, { method: 'POST', headers, body: form });
  const read = () => fetch(endpoint, { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal((await fetch(endpoint)).status, 403);
  assert.deepEqual(await (await read()).json(), { receipt: null });
  assert.equal((await fetch(endpoint, { method: 'POST', body: body() })).status, 403);
  assert.equal((await submit(new FormData())).status, 409);
  assert.equal((await submit(body(new Blob(['corrupt'])))).status, 409);
  const missingCta = body();
  missingCta.delete('cta');
  assert.equal((await submit(missingCta)).status, 409);
  assert.equal((await submit(body(video, '销量图.png', cta, 'CTA.jpg'))).status, 409);
  assert.equal((await submit(body(video, '销量图.png', image))).status, 409);
  assert.equal((await loadOfflineStoredProject(id))?.doc.assets.length, 0);
  const good = await submit(body());
  const receipt = await good.json();
  assert.equal(good.status, 200, JSON.stringify(receipt));
  assert.deepEqual(await (await read()).json(), { receipt });
  const saved = await loadOfflineStoredProject(id);
  assert.equal(saved?.revision, receipt.revision);
  assert.deepEqual(saved?.doc.assets.map(a => [a.id, a.name, a.sourceContentHash]),
    receipt.assets.map((a: { id: string; name: string; sourceContentHash: string }) => [a.id, a.name, a.sourceContentHash]));
  assert.equal(saved?.doc.timelines[0]?.items.length, 0);
  const { claimBrowserProjectOwnership, releaseProjectEditOwnership } = await import('../external-agent/project-edit-ownership');
  const browser = await claimBrowserProjectOwnership(id, 'fixture-editor', receipt.revision);
  assert.equal(browser.status, 'claimed');
  const repeat = await submit(body());
  if (browser.status === 'claimed') await releaseProjectEditOwnership(browser.claim);
  assert.equal(repeat.status, 200);
  assert.deepEqual(await repeat.json(), receipt);
  assert.equal((await submit(body(video, '不同销量.png'))).status, 409);
  assert.equal((await loadOfflineStoredProject(id))?.revision, receipt.revision);
  assert.equal((await readdir(uploadDir())).length, 4);
  assert(saved);
  const prior = saved.doc.assets.slice(0, 3);
  await rm(join(uploadDir(), saved.doc.assets[3]!.src.split('/').at(-1)!));
  await setStoredEntry(`project:${id}`, { ...saved.doc, assets: prior });
  assert.deepEqual(await (await read()).json(), { receipt: null });
  const backfill = await submit(body());
  const backfillReceipt = await backfill.json();
  assert.equal(backfill.status, 200, JSON.stringify(backfillReceipt));
  assert.deepEqual(backfillReceipt.assets.slice(0, 3), receipt.assets.slice(0, 3));
  assert.equal(backfillReceipt.assets[3].name, 'CTA.png');
  assert.deepEqual(await (await read()).json(), { receipt: backfillReceipt });
  assert.equal((await readdir(uploadDir())).length, 4);
  const { openHeadlessEditor } = await import('./headless-editor');
  let frameRequests=0;
  const editor=await openHeadlessEditor({
    projectId:id,runId:'image-regression',origin,review:{provider:'openai',model:'fixture',origin,apiMode:'responses'},
    effect:async()=>{throw Error('Provider effects forbidden');},
    fetch:async(input,init)=>{
      assert.equal(new URL(String(input)).pathname,'/api/extract-frames');
      const args=JSON.parse(String(init?.body));
      assert.equal(args.src,saved.doc.assets[1]?.src);assert.deepEqual(args.sourceTimesMs,[0]);
      frameRequests++;return Response.json({frames:[{sourceTimeMs:0,base64:'ZmFrZQ=='}]});
    },
  });
  try{
    const preview=await editor.execute('view_asset_frames',{assetId:saved.doc.assets[1]?.id,count:1},'image') as {__images:unknown[]};
    assert.equal(preview.__images.length,1);
    const missing=await editor.execute('view_asset_frames',{assetId:'unknown'},'missing') as {error:string};
    assert.match(missing.error,/Exact video\/image/);assert.equal(frameRequests,1);
    assert.equal((await loadOfflineStoredProject(id))?.revision,backfillReceipt.revision);
  }finally{await editor.close();}
  console.log('material intake verified: origin, missing/corrupt files, save/readback, identical retry, non-overwrite, cleanup');
} finally {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
