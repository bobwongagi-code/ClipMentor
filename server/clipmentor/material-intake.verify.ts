import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
const { sha256File: hashIntakeFile } = await import('../../shared/node-content-hash');
let afterHash: (() => Promise<void>) | undefined;
const intakeHashPaths: string[] = [];
const id = 'intake-regression';
const server = createServer(createMaterialIntakeHandler({ hashFile: async (file) => {
  intakeHashPaths.push(file);
  const hash = await hashIntakeFile(file), action = afterHash; afterHash = undefined;
  await action?.(); return hash;
} }));
try {
  await setStoredEntry('projects', [{ id, name: 'Intake regression', updatedAt: 1 }]);
  await setStoredEntry(`project:${id}`, {
    version: 3, assets: [], mediaFolders: [], activeTimelineId: 'timeline',
    timelines: [{ id: 'timeline', name: 'Sequence', order: 0, fps: 30, width: 1920, height: 1080,
      items: [], selectedId: null, trackOrder: ['track_v1'], tracks: { track_v1: { kind: 'video' } } },
      { id: 'other', name: 'Untouched', order: 1, fps: 30, width: 1920, height: 1080, items: [], selectedId: null }],
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
  assert.deepEqual((await loadOfflineStoredProject(id))?.doc.timelines.map(t=>[t.width,t.height]),[[1920,1080],[1920,1080]],
    'failed uploads leave both media and canvas unchanged');
  const good = await submit(body());
  const receipt = await good.json();
  assert.equal(good.status, 200, JSON.stringify(receipt));
  assert.deepEqual(await (await read()).json(), { receipt });
  let saved = await loadOfflineStoredProject(id);
  assert.equal(saved?.revision, receipt.revision);
  assert.deepEqual(saved?.doc.assets.map(a => [a.id, a.name, a.sourceContentHash]),
    receipt.assets.map((a: { id: string; name: string; sourceContentHash: string }) => [a.id, a.name, a.sourceContentHash]));
  assert.equal(saved?.doc.timelines[0]?.items.length, 0);
  assert.deepEqual([saved?.doc.timelines[0]?.width,saved?.doc.timelines[0]?.height],[720,1280],'fresh upload must replace the generic landscape canvas before planning');
  assert.deepEqual([saved?.doc.assets[0]?.width,saved?.doc.assets[0]?.height],[32,48],'source metadata is not the output canvas');
  assert.deepEqual([saved?.doc.timelines[1]?.width,saved?.doc.timelines[1]?.height],[1920,1080],'unrelated empty timelines are not reformatted');
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
  // A saved asset pointer is not proof the bytes are still present or correct.
  const originalIds = saved.doc.assets.map(a => a.id);
  const productPath = join(uploadDir(), saved.doc.assets[1].src.split('/').at(-1)!);
  await writeFile(productPath, await readFile(ctaPath));
  assert.deepEqual(await (await read()).json(), { receipt: null }, 'Changed bytes cannot be reported as a complete saved intake');
  const broken = (await loadOfflineStoredProject(id))!;
  assert.equal((await submit(body(video, 'different-sales.png'))).status, 409);
  assert.equal((await loadOfflineStoredProject(id))?.revision, broken.revision, 'Different input cannot be used to repair a missing or corrupt slot');
  const repaired = await submit(body());
  assert.equal(repaired.status, 200, await repaired.clone().text());
  const repairedReceipt = await repaired.json();
  saved = await loadOfflineStoredProject(id); assert(saved);
  assert.deepEqual(saved.doc.assets.map(a => a.id), originalIds, 'Exact-content repair keeps asset IDs');
  assert.notEqual(saved.doc.assets[1].src, broken.doc.assets[1].src, 'Repair publishes a private verified copy instead of overwriting old bytes');
  for (const i of [0, 2, 3]) assert.deepEqual(saved.doc.assets[i], broken.doc.assets[i], 'Valid existing slots stay unchanged');
  assert.deepEqual(await (await read()).json(), { receipt: repairedReceipt });
  assert.deepEqual(await readFile(productPath), await readFile(ctaPath), 'An old corrupt object may be referenced elsewhere; repair does not delete or overwrite it');
  await rm(productPath); // Fixture-only cleanup of the synthetic obsolete object.
  const missingPath = join(uploadDir(), saved.doc.assets[2].src.split('/').at(-1)!);
  await rm(missingPath);
  assert.deepEqual(await (await read()).json(), { receipt: null });
  const missingRepair = await submit(body()); assert.equal(missingRepair.status, 200);
  saved = await loadOfflineStoredProject(id); assert(saved);
  assert.deepEqual(saved.doc.assets.map(a => a.id), originalIds);
  assert.deepEqual(await (await read()).json(), { receipt: await missingRepair.json() });
  assert.equal((await readdir(uploadDir())).length, 4, 'Unused staged retry files are reclaimed');
  const beforeDrift = saved;
  afterHash = async () => {
    const changed = structuredClone(beforeDrift.doc); changed.timelines[1].name = 'Concurrent edit';
    await setStoredEntry(`project:${id}`, changed);
  };
  const staleRead = await read(); assert.equal(staleRead.status, 503, 'A receipt cannot certify the old project while its bytes are being checked');
  assert(!('receipt' in await staleRead.json()));
  saved = await loadOfflineStoredProject(id); assert(saved); assert.notEqual(saved.revision, beforeDrift.revision);
  const freshRead = await (await read()).json(); assert.equal(freshRead.receipt.revision, saved.revision);
  assert.equal((await loadOfflineStoredProject(id))?.revision, saved.revision, 'Readback does not mutate the project');
  const beforeUnsafe = saved;
  const oldSalesFile = join(uploadDir(), beforeUnsafe.doc.assets[2].src.split('/').at(-1)!);
  const unsafe = structuredClone(beforeUnsafe.doc); unsafe.assets[2].src = '/media/uploads/../fixture.png';
  await setStoredEntry(`project:${id}`, unsafe); intakeHashPaths.length = 0;
  assert.deepEqual(await (await read()).json(), { receipt: null });
  assert(!intakeHashPaths.includes(imagePath), 'An invalid old src must not be hashed outside the upload directory');
  const safeRepair = await submit(body()); assert.equal(safeRepair.status, 200);
  saved = await loadOfflineStoredProject(id); assert(saved);
  assert.deepEqual(saved.doc.assets.map(a => a.id), originalIds);
  assert(!saved.doc.assets[2].src.includes('..'));
  assert.deepEqual(await readFile(imagePath), Buffer.from(await image.arrayBuffer()), 'Repair never changes the outside file');
  await rm(oldSalesFile); // Fixture-only cleanup; the handler must not reclaim old references.

  const raceOldFile = join(uploadDir(), saved.doc.assets[1].src.split('/').at(-1)!);
  await writeFile(raceOldFile, await readFile(ctaPath));
  const otherId = 'untouched-intake-project';
  await setStoredEntry(`project:${otherId}`, structuredClone(saved.doc));
  const otherBefore = (await loadOfflineStoredProject(otherId))!;
  const gate = Promise.withResolvers<void>(); let waiting = 0;
  const settledIntakes = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const competitors = [0, 1].map(index => {
    let held = false;
    const handler = createMaterialIntakeHandler({ hashFile: async (file) => {
      const hash = await hashIntakeFile(file);
      if (!held) { held = true; waiting++; if (waiting === 2) gate.resolve(); await gate.promise; }
      return hash;
    } });
    return createServer((req, res) => { void handler(req, res).then(settledIntakes[index].resolve, settledIntakes[index].reject); });
  });
  try {
    const endpoints = await Promise.all(competitors.map(async s => {
      s.listen(0, '127.0.0.1'); await once(s, 'listening');
      const a = s.address(); assert(a && typeof a !== 'string'); return `http://127.0.0.1:${a.port}`;
    }));
    const replies = await Promise.all(endpoints.map(base => fetch(`${base}/?projectId=${id}`, {
      method: 'POST', headers: { origin: base, 'sec-fetch-site': 'same-origin' }, body: body(), signal: AbortSignal.timeout(10_000),
    })));
    await Promise.all(settledIntakes.map(done => done.promise));
    assert.deepEqual(replies.map(r => r.status).sort(), [200, 409], 'Independent handlers still have exactly one winning project commit');
    saved = await loadOfflineStoredProject(id); assert(saved);
    for (const asset of saved.doc.assets) assert.equal(await hashIntakeFile(join(uploadDir(), asset.src.split('/').at(-1)!)), asset.sourceContentHash, 'Loser cleanup cannot remove winner files');
    assert.deepEqual(saved.doc.assets.map(a => a.id), originalIds);
    assert.equal((await loadOfflineStoredProject(otherId))?.revision, otherBefore.revision, 'Another project is untouched');
    assert.deepEqual(await readFile(raceOldFile), await readFile(ctaPath), 'Even a referenced old corrupt object is untouched');
  } finally {
    gate.resolve();
    await Promise.all(competitors.map(async s => { s.closeAllConnections(); if (s.listening) await new Promise<void>(r => s.close(() => r())); }));
  }
  await rm(raceOldFile); // Fixture-owned obsolete object only.
  assert.equal((await readdir(uploadDir())).length, 4);
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
  // Exercise the real stage entry on a persisted legacy landscape project:
  // refuse before analysis initialization, author/model work or paid effects.
  const wrong=structuredClone((await loadOfflineStoredProject(id))!.doc);
  wrong.timelines[0].width=1920;wrong.timelines[0].height=1080;
  await setStoredEntry(`project:${id}`,wrong);
  const wrongSaved=(await loadOfflineStoredProject(id))!;
  const {productionStageWorker}=await import('./production-worker');
  let effects=0;
  for(const stage of ['blueprint','audio','edit','export','self_check'] as const){
    const task={projectId:id,taskId:'format-regression',projectRevision:wrongSaved.revision,stage,
      input:{sourceAssetId:wrong.assets[0].id,author:{origin},reviewer:{provider:'openai',model:'fixture',origin},panelDelivery:{}}};
    await assert.rejects(productionStageWorker(task as never,{signal:new AbortController().signal,
      effect:async()=>{effects++;throw Error('Provider effects forbidden');}} as never),/clipmentor_output_canvas_mismatch/);
  }
  assert.equal(effects,0);
  assert.equal((await loadOfflineStoredProject(id))?.revision,wrongSaved.revision,'format refusal does not silently migrate saved work');
  // Legacy review-ready/completed tasks never revisit the worker. Exercise the
  // existing acceptance and panel media entry points with actual local files.
  const {createProductionTask,productionTaskStore,acceptProductionTask}=await import('./production-task');
  const {createProductionPanel}=await import('./production-panel');
  for(const [name,size] of [['legacy-wrong','32x18'],['legacy-portrait','18x32']])
    execFileSync(ffmpegBin(),['-hide_banner','-loglevel','error','-f','lavfi','-i',`color=s=${size}:d=0.1`,
      '-c:v','libx264','-pix_fmt','yuv420p',join(uploadDir(),name+'.mp4')]);
  const legacy=await createProductionTask({projectId:id,sourceAssetId:wrong.assets[0].id,product:{name:'Fixture'},brief:'fixture',
    author:{provider:'openai',model:'fixture',origin,apiMode:'responses'},reviewer:{provider:'openai',model:'fixture',origin,apiMode:'responses'},
    budget:{model:1,review:1,observation:1,tts:0,render:1,preview_review:1,maxElapsedMs:100000,maxRepairs:1},humanBlueprintReview:true,
    panelDelivery:{productAssetId:'p',productAssetHash:'a'.repeat(64),salesAssetId:'s',ctaAssetId:'c',ctaAssetHash:'b'.repeat(64)}});
  legacy.stage='self_check';legacy.status='awaiting_review';legacy.completed.export={at:1,artifact:{renderId:'legacy-render'}};
  legacy.completed.self_check={at:1,artifact:{preview:'/media/uploads/legacy-wrong.mp4'}};
  const panel=createProductionPanel(()=>{throw Error('Must not launch');},()=>false);
  const panelServer=createServer((req,res)=>{const q=new URL(req.url!,'http://localhost').searchParams;
    void panel(id,origin,q,req,res,async()=>({})).catch(error=>{res.statusCode=409;res.end(JSON.stringify({error:String(error)}));});});
  panelServer.listen(0,'127.0.0.1');await once(panelServer,'listening');
  const pa=panelServer.address();assert(pa&&typeof pa!=='string');const panelOrigin=`http://127.0.0.1:${pa.port}`;
  try{
    const leaks:string[]=[];let acceptedWrites=0;
    const accepting=structuredClone(legacy),beforeAccept=JSON.stringify(accepting);
    try{await acceptProductionTask(accepting,true,{save:async()=>{acceptedWrites++;}} as never);leaks.push('legacy acceptance');}
    catch(error){assert.match(String(error),/clipmentor_output_canvas_mismatch/);}
    assert.equal(JSON.stringify(accepting),beforeAccept,'failed acceptance must not mutate state or confirmations');
    for(const status of ['awaiting_review','completed'] as const){
      legacy.status=status;await productionTaskStore.save(legacy);
      const beforeRead=JSON.stringify(await productionTaskStore.load(id,legacy.taskId));
      for(const view of ['panel','panel_video',...(status==='completed'?['panel_download']:[])]){
        const response=await fetch(`${panelOrigin}/?view=${view}&renderId=legacy-render`);
        if(response.status!==409)leaks.push(`${status}:${view}`);
        await response.arrayBuffer();
      }
      assert.equal(JSON.stringify(await productionTaskStore.load(id,legacy.taskId)),beforeRead,'refusing legacy delivery does not rewrite historical results or budgets');
    }
    assert.deepEqual(leaks,[],'legacy outputs cannot bypass the worker-only guard');assert.equal(acceptedWrites,0);
    legacy.status='awaiting_review';legacy.completed.self_check.artifact.preview='/media/uploads/legacy-portrait.mp4';
    await productionTaskStore.save(legacy);
    const requestStart=performance.now();
    const panelStatus=await fetch(`${panelOrigin}/?view=panel`);assert.equal(panelStatus.status,200);await panelStatus.arrayBuffer();
    const readable=await fetch(`${panelOrigin}/?view=panel_video&renderId=legacy-render`);
    assert.equal(readable.status,200);assert((await readable.arrayBuffer()).byteLength>0);
    const range=await fetch(`${panelOrigin}/?view=panel_video&renderId=legacy-render`,{headers:{Range:'bytes=0-31'}});
    assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,32);
    console.log(`legacy preview guard: valid status/video/Range in ${(performance.now()-requestStart).toFixed(1)}ms total; zero model/render effects`);
    await assert.rejects(acceptProductionTask(legacy,true,{save:async()=>{acceptedWrites++;}} as never),
      /final_output_evidence_missing_or_stale/,'valid portrait pixels alone cannot replace a bound continuous-review receipt');
    const {sha256File}=await import('../../shared/node-content-hash');
    const preview='/media/uploads/legacy-portrait.mp4';
    legacy.projectRevision=wrongSaved.revision;
    legacy.completed.export!.artifact={renderId:'legacy-render',revision:wrongSaved.revision,path:preview};
    legacy.completed.self_check!.artifact.receipt={projectId:id,videoSha256:await sha256File(join(uploadDir(),'legacy-portrait.mp4')),
      status:'completed',scope:'rendered_preview_continuous_review',full_film_accepted:false,
      effective_review:{status:'pass',can_use_as_pass:true,blockers:[],manifest_binding:'frozen_at_request'},
      timeline_check:{status:'no_detected_conflict'}};
    await acceptProductionTask(legacy,true,{save:async()=>{acceptedWrites++;}} as never);
    assert.equal(legacy.status,'completed');assert.equal(acceptedWrites,1);await productionTaskStore.save(legacy);
    const downloadable=await fetch(`${panelOrigin}/?view=panel_download&renderId=legacy-render`);
    assert.equal(downloadable.status,200);assert((await downloadable.arrayBuffer()).byteLength>0);
  }finally{await new Promise<void>(resolve=>panelServer.close(()=>resolve()));}
  // Failed post-commit verification must preserve all newly referenced files.
  const uncertainId = 'intake-post-commit-readback';
  await setStoredEntry('projects', [{ id, name: 'Intake regression', updatedAt: 1 }, { id: uncertainId, name: 'Uncertain commit', updatedAt: 1 }]);
  await setStoredEntry(`project:${uncertainId}`, { ...saved.doc, assets: [] });
  const uncertainEndpoint = `${origin}/?projectId=${uncertainId}`;
  afterHash = async () => { throw new Error('injected post-commit verification unavailable'); };
  const uncertain = await fetch(uncertainEndpoint, { method: 'POST', headers, body: body() });
  assert.equal(uncertain.status, 409);
  const committed = (await loadOfflineStoredProject(uncertainId))!;
  assert.equal(committed.doc.assets.length, 4, 'The actual commit survives a readback failure');
  for (const asset of committed.doc.assets) assert.equal(await hashIntakeFile(join(uploadDir(), asset.src.split('/').at(-1)!)), asset.sourceContentHash);
  const recovered = await fetch(uncertainEndpoint, { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal((await recovered.json()).receipt.revision, committed.revision, 'A later read recovers the saved receipt without another upload');
  assert.equal((await loadOfflineStoredProject(uncertainId))?.revision, committed.revision);
  console.log('material intake verified: real-byte receipts, exact-content missing/corrupt repair, stale-read refusal, post-commit preservation, origin, idempotence and cleanup');
} finally {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
