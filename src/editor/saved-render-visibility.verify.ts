// Real local Remotion pixels after a file-backed save + cold reload. No models,
// source media, live project store or production timeline are touched.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeDraft } from './store';
import { createProject, docFromTimeline, loadProject, resetProjectStoreMemory } from '../persist/projectStore';
import { configureSharedKvBackend, type SharedKvBackend } from '../persist/sharedKv';
import { createRequire } from 'node:module';
const ffmpeg = process.env.OPENCHATCUT_FFMPEG ?? process.env.FFMPEG_PATH ?? createRequire(import.meta.url)('ffmpeg-static') ?? 'ffmpeg';
// @ts-expect-error local renderer is a JavaScript module
import { renderTimelineStills, setUploadsDirProvider } from '../../remotion/render.mjs';

const root = await mkdtemp(join(tmpdir(), 'occ-saved-visibility-'));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Network is forbidden in saved-render regression'); };
const backend = (): SharedKvBackend => ({
  get: async <T>(key: string) => {
    try { return JSON.parse(await readFile(join(root, encodeURIComponent(key) + '.json'), 'utf8')) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  },
  set: async (key, value) => { await writeFile(join(root, encodeURIComponent(key) + '.json'), JSON.stringify(value)); },
  delete: async (key) => { await rm(join(root, encodeURIComponent(key) + '.json'), { force: true }); },
  keys: async () => (await readdir(root)).filter(name => name.endsWith('.json')).map(name => decodeURIComponent(name.slice(0, -5))),
  writeAgentRuntime: async () => { throw new Error('No Agent calls allowed'); },
  updateAgentRunLease: async () => { throw new Error('No Agent calls allowed'); },
});
const began = performance.now();
try {
  configureSharedKvBackend(backend());
  const draft = makeDraft(docFromTimeline({ fps: 30, width: 1080, height: 1920, selectedId: null,
    trackOrder: ['V3', 'V2', 'V1'], tracks: { V1: { kind: 'video' }, V2: { kind: 'video' }, V3: { kind: 'video', hidden: true } },
    items: [{ id: 'background', name: 'black', kind: 'solid', track: 'V1', startFrame: 0, durationInFrames: 210, props: { color: '#000000' } }],
  }));
  const id = draft.commands.addTextClip({ text: 'VISIBLE', color: '#ff00ff', fontSize: 48, startFrame: 0, durationInFrames: 30, track: 'V2' });
  const fixture = structuredClone(draft.getDoc()), timeline = fixture.timelines[0];
  const text = timeline.items.find(item => item.id === id)!;
  timeline.items.push(
    { ...structuredClone(text), id: 'legacy-landscape', startFrame: 30, width: 1920, height: 1080 },
    { ...structuredClone(text), id: 'hidden', startFrame: 60, track: 'V3' },
    { ...structuredClone(text), id: 'off-canvas', startFrame: 90, transform: { x: 300, y: 300 } },
    // 120..150 intentionally contains no text layer.
    {...structuredClone(text),id:'blue-strip',startFrame:150,transform:{x:10,y:20},props:{text:'Video asal',
      placement:'top_strip',color:'#FFFFFF',backgroundColor:'#0D5EA6'}},
    {...structuredClone(text),id:'yellow-strip',startFrame:180,props:{text:'Lihat semula',
      placement:'top_strip',color:'#2F261A',backgroundColor:'#E6C46F',stripHeightFraction:.03}},
  );
  const meta = await createProject('isolated-render-visibility', fixture);
  // Drop every cache, then construct a NEW storage adapter. A live draft or
  // an in-memory getDoc() success cannot satisfy this check.
  resetProjectStoreMemory(); configureSharedKvBackend(backend());
  const reloaded = await loadProject(meta.id);
  assert(reloaded);
  assert.deepEqual(reloaded.timelines[0].items.map(item => item.id), timeline.items.map(item => item.id));
  setUploadsDirProvider(() => root);
  const frames = await renderTimelineStills({ state: reloaded.timelines[0], project: reloaded,
    timelineId: reloaded.activeTimelineId, frames: [10, 40, 70, 100, 130, 160, 190] }) as Array<{ frame: number; base64: string }>;
  assert.equal(frames.length, 7);
  if (process.env.CC_VERIFY_OUTPUT_DIR) {
    await mkdir(process.env.CC_VERIFY_OUTPUT_DIR, { recursive: true });
    for (const frame of frames) await writeFile(join(process.env.CC_VERIFY_OUTPUT_DIR, `frame-${frame.frame}.jpg`), Buffer.from(frame.base64, 'base64'));
  }
  const measure = (frame: { frame: number; base64: string }, outputHeight = 1138) => {
    const decoded = spawnSync(ffmpeg, ['-loglevel', 'error', '-i', 'pipe:0', '-frames:v', '1', '-vf', `scale=640:${outputHeight}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
      { input: Buffer.from(frame.base64, 'base64'), maxBuffer: 5_000_000 });
    assert.equal(decoded.status, 0, decoded.stderr.toString());
    assert.equal(decoded.stdout.length, 640 * outputHeight * 3);
    let pixels = 0, minY = outputHeight, maxY = -1;
    for (let at = 0; at < decoded.stdout.length; at += 3) {
      const [r, g, b] = decoded.stdout.subarray(at, at + 3);
      if (r > 150 && b > 150 && g < 120) { pixels++; const y = Math.floor(at / 3 / 640); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    }
    return { frame: frame.frame, pixels, height: maxY < 0 ? 0 : maxY - minY + 1 };
  };
  const measurements = frames.map(frame => measure(frame));
  // The threshold is this fixture's known 48px text at 640/1080 scale,
  // not a universal claim about readable typography.
  assert(measurements[0].height >= 18, JSON.stringify({ reason: 'saved portrait title was silently shrunk', measurements }));
  assert(measurements[1].height < 18 && measurements[1].pixels > 0, 'legacy landscape mismatch must be detected, not merely count any visible pixel');
  for (const result of measurements.slice(2,5)) assert.equal(result.pixels, 0, 'hidden, off-canvas and missing layers must not pass visible-content checks');
  for(const [index,background,lastStripRow,firstClearRow] of [[5,[13,94,166],21,30],[6,[230,196,111],16,22]] as const){
    const decoded=spawnSync(ffmpeg,['-loglevel','error','-i','pipe:0','-frames:v','1','-vf','scale=360:640',
      '-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{input:Buffer.from(frames[index].base64,'base64'),maxBuffer:2_000_000});
    assert.equal(decoded.status,0,decoded.stderr.toString());
    const pixel=(x:number,y:number)=>[...decoded.stdout.subarray((y*360+x)*3,(y*360+x)*3+3)];
    const is=(rgb:number[],expected:readonly number[])=>rgb.every((v,i)=>Math.abs(v-expected[i])<24);
    assert(is(pixel(0,0),background)&&is(pixel(359,0),background),'strip begins at both edges of the first row');
    assert(is(pixel(0,lastStripRow),background)&&is(pixel(359,lastStripRow),background),'strip spans the width at its chosen height');
    assert(is(pixel(180,firstClearRow),[0,0,0]),'picture starts immediately below the configured band');
    assert(is(pixel(180,58),[0,0,0])&&is(pixel(180,320),[0,0,0]),'the strip must leave the rest of the picture clear');
  }
  // Small supported canvases must retain the previous default's physical
  // text size. Explicit typography must also fit without fixed 96px padding.
  const tiny = makeDraft(docFromTimeline({ fps: 30, width: 320, height: 180, selectedId: null,
    trackOrder: ['V2', 'V1'], tracks: { V1: { kind: 'video' }, V2: { kind: 'video' } },
    items: [{ id: 'tiny-bg', kind: 'solid', name: 'black', track: 'V1', startFrame: 0, durationInFrames: 90, props: { color: '#000000' } }],
  }));
  const tinyId = tiny.commands.addTextClip({ text: 'VISIBLE', color: '#ff00ff', startFrame: 0, durationInFrames: 30, track: 'V2' });
  tiny.commands.addTextClip({ text: 'VISIBLE TEXT', color: '#ff00ff', fontSize: 36, startFrame: 30, durationInFrames: 30, track: 'V2' });
  const smallFixture = structuredClone(tiny.getDoc());
  const legacy = structuredClone(smallFixture.timelines[0].items.find(item => item.id === tinyId)!);
  Object.assign(legacy, { id: 'legacy-default', startFrame: 60, width: 1920, height: 1080 });
  legacy.props = { ...legacy.props, fontSize: 96 }; delete legacy.props.paddingX;
  smallFixture.timelines[0].items.push(legacy);
  const smallProject = await createProject('isolated-small-canvas', smallFixture);
  resetProjectStoreMemory(); configureSharedKvBackend(backend());
  const smallReload = await loadProject(smallProject.id); assert(smallReload);
  const smallFrames = await renderTimelineStills({ state: smallReload.timelines[0], project: smallReload,
    timelineId: smallReload.activeTimelineId, frames: [10, 40, 70] }) as Array<{ frame: number; base64: string }>;
  assert.equal(smallFrames.length, 3);
  const small = smallFrames.map(frame => measure(frame, 360));
  assert(small[0].pixels > 0 && Math.abs(small[0].height - small[2].height) <= 1,
    JSON.stringify({ reason: 'small canvas default title must retain legacy physical size', small }));
  assert(small[1].pixels > 0 && small[1].height < 70,
    JSON.stringify({ reason: 'explicit small canvas title must not wrap due to landscape padding', small }));
  console.log(JSON.stringify({ status: 'passed', frames: 10, modelCalls: 0, milliseconds: Math.round(performance.now() - began), measurements, small }));
} finally {
  configureSharedKvBackend(undefined); globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
