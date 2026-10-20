// Runnable check: `npx tsx server/plugins/extract-frames.verify.ts`.
// Verify contact table sampling: the basic properties of uniform sampling, and the selection rule of "change priority + uniform completion"
// (Change points are selected first, those too close to each other are not repeated, too many candidates are evenly distributed in order, and discarded outside the window,
// Exactly the same as uniform sampling when there are no candidates).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer, type ViteDevServer } from 'vite';
import { seedKeystore } from '../keystore.ts';
import { ffmpegBin, ffprobeBin } from '../media-binaries.ts';
import { extractFramesPlugin, frameSeekArgs, pickDistinctTimes, sampleTimesMs } from './extract-frames.ts';

const source = await readFile(new URL('./extract-frames.ts', import.meta.url), 'utf8');
assert.doesNotMatch(source, /\bspawn\(ffprobeBin\(\)/, 'ffprobe must use the shared low-priority process launcher');

const inWindow = (times: number[], lo: number, hi: number): boolean =>
  times.every((t) => t >= lo && t < hi);
const ascending = (times: number[]): boolean =>
  times.every((t, i) => i === 0 || t >= times[i - 1]!);

assert.deepEqual(frameSeekArgs(0), [], '静态图片零秒取帧不得在输入前 seek');
assert.deepEqual(frameSeekArgs(1500), ['-ss', '1.5'], '视频正时间继续走快速 seek');

// ── Uniform sampling: equally divided block midpoint, number of bars, interval ──
{
  assert.deepEqual(sampleTimesMs(0, 12000, 6), [1000, 3000, 5000, 7000, 9000, 11000], '等分块中点');
  assert.equal(sampleTimesMs(0, 1000, 99).length, 20, '受 MAX_SAMPLES 上限约束');
  assert.equal(sampleTimesMs(0, 1000, 0).length, 1, 'count 0 至少给 1 个');
}

// ── No candidates → exactly the same as uniform sampling (the fallback path when scene analysis fails) ──
{
  assert.deepEqual(pickDistinctTimes([], 0, 18000, 6), sampleTimesMs(0, 18000, 6), '空候选=均匀取样');
}

// ── Change points are selected first, and the rest are filled up to count using uniform sampling ──
{
  const out = pickDistinctTimes([9000, 12000, 15000], 0, 18000, 6);
  assert.equal(out.length, 6, '补齐到 count');
  for (const t of [9000, 12000, 15000]) assert.ok(out.includes(t), `变化点 ${t} 必须入选`);
  assert.ok(ascending(out) && inWindow(out, 0, 18000), '升序且落在窗口内');
}

// ── Candidates who are too close to each other will not occupy duplicate seats (otherwise one transition will take up multiple places) ──
{
  const out = pickDistinctTimes([9000, 9050, 9100], 0, 18000, 6);
  const near = out.filter((t) => t >= 9000 && t <= 9100);
  assert.equal(near.length, 1, '同一处变化只占一个名额');
}

// ── There are more candidates than places → divide them evenly in order, not all at the beginning ──
{
  const dense = Array.from({ length: 40 }, (_, i) => i * 250); // 0..9750ms dense candidates
  const out = pickDistinctTimes(dense, 0, 10000, 5);
  assert.equal(out.length, 5, '不超过 count');
  assert.ok(out[out.length - 1]! - out[0]! > 5000, `应覆盖整段而非挤在开头(实得 ${out.join(',')})`);
  assert.ok(ascending(out), '升序');
}

// ── Candidates outside the window are discarded ──
{
  const out = pickDistinctTimes([-500, 500, 99000], 0, 3000, 3);
  assert.ok(inWindow(out, 0, 3000), `窗口外候选必须丢弃(实得 ${out.join(',')})`);
  assert.ok(out.includes(500), '窗口内候选保留');
}

// ── The interval that is not the starting point of the window (view_asset_frames will pass fromMs/toMs) ──
{
  const out = pickDistinctTimes([7000], 5000, 9000, 3);
  assert.ok(inWindow(out, 5000, 9000), '相对区间内');
  assert.ok(out.includes(7000), '区间内变化点保留');
}

console.log('extract-frames.verify: ok (均匀取样/空候选兜底/变化优先/近邻去重/均摊/窗口裁剪)');

// Actual portrait video: clear individual frames, source-time identity and legacy sheet regression.
const directory = await mkdtemp(join(tmpdir(), 'openchatcut-frame-detail-'));
let server: ViteDevServer | undefined;
try {
  execFileSync(ffmpegBin(), ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=red:s=576x1024:r=10:d=1',
    '-f', 'lavfi', '-i', 'color=blue:s=576x1024:r=10:d=1',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(directory, 'action.mp4')]);
  seedKeystore({ MEDIA_DIR: directory });
  server = await createServer({ root: directory, configFile: false, appType: 'custom', logLevel: 'silent',
    plugins: [extractFramesPlugin()], server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const request = async (body: object) => fetch(origin + '/api/extract-frames', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ src: '/media/uploads/action.mp4', ...body }) });
  const detailResponse = await request({ output: 'frames', sourceTimesMs: [100, 1500] });
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.output, 'frames'); assert.equal(detail.sampleCount, 2); assert(!detail.base64);
  assert.deepEqual(detail.frames.map((f: { sourceTimeMs: number }) => f.sourceTimeMs), [100, 1500]);
  for (let i = 0; i < detail.frames.length; i++) {
    const bytes = Buffer.from(detail.frames[i].base64, 'base64');
    const path = join(directory, `detail-${i}.jpg`); await writeFile(path, bytes);
    const probe = JSON.parse(execFileSync(ffprobeBin(), ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', path], { encoding: 'utf8' }));
    assert.equal(probe.streams[0].width, 576); assert.equal(probe.streams[0].height, 1024, 'portrait ratio and detail preserved, no sheet padding');
    const rgb = execFileSync(ffmpegBin(), ['-v', 'error', '-i', path, '-vf', 'scale=1:1', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    assert(i === 0 ? rgb[0] > rgb[2] + 100 : rgb[2] > rgb[0] + 100, 'red/blue source moments must not swap');
  }
  const partial = await (await request({ output: 'frames', sourceTimesMs: [100, 5000, 1500] })).json();
  assert.deepEqual(partial.sourceTimesMs, [100, 1500], 'failed middle extraction cannot shift source-time labels');
  assert.equal(partial.frames.length, 2);
  for (const sourceTimesMs of [[], [0, '1'], Array(9).fill(1)]) assert.equal((await request({ output: 'frames', sourceTimesMs })).status, 400);
  const legacy = await (await request({ sourceTimesMs: [100, 1500] })).json();
  assert.equal(legacy.sampleCount, 2); assert.equal(typeof legacy.base64, 'string'); assert(!legacy.frames);
  const legacyFile = join(directory, 'legacy.jpg'); await writeFile(legacyFile, Buffer.from(legacy.base64, 'base64'));
  const legacyProbe = JSON.parse(execFileSync(ffprobeBin(), ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', legacyFile], { encoding: 'utf8' }));
  assert.deepEqual([legacyProbe.streams[0].width, legacyProbe.streams[0].height], [640, 180]);
} finally {
  await server?.close(); await rm(directory, { recursive: true, force: true });
}
console.log('extract-frames: real portrait detail, action-time/color identity, partial failure and unchanged legacy sheet passed');
