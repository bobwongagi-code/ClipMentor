import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { renderTimeline, renderTimelineStills, setUploadsDirProvider } from '../../remotion/render.mjs';

const run = promisify(execFile);
const width = 160;
const height = 90;
const fps = 30;
const sourceRate = '30000/1001';
const frameCount = 60;
const scenarios = [
  { label: 'normal', srcInFrame: 0, playbackRate: 1 },
  { label: 'trimmed-2x', srcInFrame: 5, playbackRate: 2 },
];
const sourceFrameCount = Math.max(...scenarios.map(({ srcInFrame, playbackRate }) =>
  Math.ceil(frameCount * playbackRate) + srcInFrame + 2));
const frameBytes = width * height * 3;
const softwareH264 = {
  id: 'libx264',
  label: 'Software (libx264)',
  hardware: false,
  transport: 'server',
};

if (!ffmpegPath) throw new Error('ffmpeg-static binary unavailable');

async function decodeRgb(path, expectedFrameCount = frameCount) {
  const { stdout } = await run(ffmpegPath, [
    '-v', 'error',
    '-i', path,
    '-f', 'rawvideo',
    '-pix_fmt', 'rgb24',
    'pipe:1',
  ], { encoding: 'buffer', maxBuffer: frameBytes * expectedFrameCount * 2 });
  assert.equal(stdout.length, frameBytes * expectedFrameCount, `unexpected decoded byte count for ${path}`);
  return Array.from({ length: expectedFrameCount }, (_, index) =>
    stdout.subarray(index * frameBytes, (index + 1) * frameBytes));
}

function meanSquaredError(left, right, invertLeft = false) {
  let total = 0;
  let samples = 0;
  for (let index = 0; index < left.length; index += 12) {
    const leftValue = invertLeft ? 255 - left[index] : left[index];
    const delta = leftValue - right[index];
    total += delta * delta;
    samples += 1;
  }
  return total / samples;
}

const directory = await mkdtemp(join(tmpdir(), 'openchatcut-clip-fx-'));
try {
  const source = join(directory, 'source.mp4');
  await run(ffmpegPath, [
    '-v', 'error',
    '-f', 'lavfi',
    '-i', `testsrc2=size=${width}x${height}:rate=${sourceRate}:duration=${sourceFrameCount / fps}`,
    '-frames:v', String(sourceFrameCount),
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    source,
  ]);

  setUploadsDirProvider(() => directory);
  process.env.OPENCHATCUT_RENDER_CONCURRENCY = '8';
  process.env.OPENCHATCUT_DISABLE_HARDWARE_ENCODING = '1';

  for (const { label, srcInFrame, playbackRate } of scenarios) {
    const item = {
      id: 'clip-1',
      name: 'source.mp4',
      kind: 'video',
      src: '/media/uploads/source.mp4',
      track: 'V1',
      startFrame: 0,
      durationInFrames: frameCount,
      srcInFrame,
      playbackRate,
      width,
      height,
    };
    const state = {
      id: `clip-fx-export-verification-${label}`,
      fps,
      width,
      height,
      fit: 'contain',
      items: [item],
      tracks: { V1: { kind: 'video' } },
      trackOrder: ['V1'],
      selectedId: null,
      selectedIds: [],
      assets: [],
    };
    const baselinePath = join(directory, `baseline-${label}.mp4`);
    const effectPath = join(directory, `effect-${label}.mp4`);

    await renderTimeline({ state, outputLocation: baselinePath, codec: 'h264', h264Profile: softwareH264 });
    await renderTimeline({
      state: {
        ...state,
        items: [{
          ...item,
          effects: [{
            id: 'invert-regression',
            assetId: 'builtin:fx-invert',
          }],
        }],
      },
      outputLocation: effectPath,
      codec: 'h264',
      h264Profile: softwareH264,
    });

    const [baselineFrames, effectFrames] = await Promise.all([
      decodeRgb(baselinePath),
      decodeRgb(effectPath),
    ]);
    const mismatches = [];
    const sameFrameDistances = [];
    for (let outputFrame = 0; outputFrame < frameCount; outputFrame += 1) {
      assert.ok(
        meanSquaredError(effectFrames[outputFrame], baselineFrames[outputFrame]) > 1_000,
        `effect export frame ${outputFrame} did not apply the WebGL effect`,
      );
      const sameFrameDistance = meanSquaredError(
        effectFrames[outputFrame],
        baselineFrames[outputFrame],
        true,
      );
      sameFrameDistances.push(sameFrameDistance);
      let closestBaselineFrame = -1;
      let closestDistance = Number.POSITIVE_INFINITY;
      for (let baselineFrame = 0; baselineFrame < frameCount; baselineFrame += 1) {
        const distance = meanSquaredError(
          effectFrames[outputFrame],
          baselineFrames[baselineFrame],
          true,
        );
        if (distance < closestDistance) {
          closestDistance = distance;
          closestBaselineFrame = baselineFrame;
        }
      }
      if (closestBaselineFrame !== outputFrame && sameFrameDistance > closestDistance + 1) {
        mismatches.push({ outputFrame, closestBaselineFrame });
      }
    }

    assert.deepEqual(mismatches, [], `${label} effect export reused baseline frames: ${JSON.stringify(mismatches)}`);
    const maximumSameFrameDistance = Math.max(...sameFrameDistances);
    assert.ok(
      maximumSameFrameDistance < 500,
      `${label} effect export diverged from the inverse of its same-index baseline frame: ${maximumSameFrameDistance}`,
    );
    console.log(`clipFxExport.verify: ${frameCount}/${frameCount} ${label} fractional-rate effect frames are transformed and frame-accurate (max inverse MSE ${maximumSameFrameDistance.toFixed(2)})`);
  }

  const transitionClipFrames = 45;
  const transitionDurationFrames = 20;
  const transitionFrameCount = transitionClipFrames * 2;
  const transitionStartFrame = transitionClipFrames - Math.floor(transitionDurationFrames / 2);
  const transitionItems = [
    {
      id: 'transition-outgoing',
      name: 'outgoing.mp4',
      kind: 'video',
      src: '/media/uploads/source.mp4',
      track: 'V1',
      startFrame: 0,
      durationInFrames: transitionClipFrames,
      srcInFrame: 0,
      width,
      height,
    },
    {
      id: 'transition-incoming',
      name: 'incoming.mp4',
      kind: 'video',
      src: '/media/uploads/source.mp4',
      track: 'V1',
      startFrame: transitionClipFrames,
      durationInFrames: transitionClipFrames,
      srcInFrame: 0,
      width,
      height,
    },
  ];
  const transitionState = {
    id: 'clip-fx-transition-export-verification',
    fps,
    width,
    height,
    fit: 'contain',
    items: transitionItems,
    tracks: { V1: { kind: 'video' } },
    trackOrder: ['V1'],
    transitions: [{
      id: 'transition-regression',
      type: 'cross-dissolve',
      durationInFrames: transitionDurationFrames,
      outgoingItemId: transitionItems[0].id,
      incomingItemId: transitionItems[1].id,
      trackId: 'V1',
      enabled: true,
    }],
    selectedId: null,
    selectedIds: [],
    assets: [],
  };
  const transitionBaselinePath = join(directory, 'transition-baseline.mp4');
  const transitionEffectPath = join(directory, 'transition-effect.mp4');
  await renderTimeline({
    state: transitionState,
    outputLocation: transitionBaselinePath,
    codec: 'h264',
    h264Profile: softwareH264,
  });
  await renderTimeline({
    state: {
      ...transitionState,
      items: [{
        ...transitionItems[0],
        effects: [{ id: 'transition-invert-regression', assetId: 'builtin:fx-invert' }],
      }, transitionItems[1]],
    },
    outputLocation: transitionEffectPath,
    codec: 'h264',
    h264Profile: softwareH264,
  });
  const [transitionBaselineFrames, transitionEffectFrames] = await Promise.all([
    decodeRgb(transitionBaselinePath, transitionFrameCount),
    decodeRgb(transitionEffectPath, transitionFrameCount),
  ]);
  assert.ok(
    meanSquaredError(
      transitionEffectFrames[transitionStartFrame - 1],
      transitionBaselineFrames[transitionStartFrame - 1],
    ) > 1_000,
    'transition fixture must visibly apply the outgoing effect before the transition window',
  );
  const transitionStartDistance = meanSquaredError(
    transitionEffectFrames[transitionStartFrame],
    transitionBaselineFrames[transitionStartFrame],
  );
  assert.ok(
    transitionStartDistance > 1_000,
    `transition start dropped the outgoing effect (MSE ${transitionStartDistance})`,
  );
  const transitionStartInverseDistance = meanSquaredError(
    transitionEffectFrames[transitionStartFrame],
    transitionBaselineFrames[transitionStartFrame],
    true,
  );
  assert.ok(
    transitionStartInverseDistance < 500,
    `transition start diverged from the filtered outgoing frame (inverse MSE ${transitionStartInverseDistance})`,
  );
  console.log(`clipFxExport.verify: transition start preserves the outgoing effect (MSE ${transitionStartDistance.toFixed(2)}, inverse MSE ${transitionStartInverseDistance.toFixed(2)})`);

  // A parent timeline can already know a competing effect ID. Each exported
  // child must still use the LUT supplied by its own project timeline.
  const effectId = 'plugin:same-look';
  const fragment = await readFile(new URL('./fx/lut.frag', import.meta.url), 'utf8');
  const colorLut = async (name, rgb) => {
    await writeFile(join(directory, `${name}.cube`), `LUT_3D_SIZE 2\n${Array(8).fill(rgb).join('\n')}\n`);
    return { [effectId]: {
      id: effectId, name, desc: '', frag: fragment, cube: `/media/uploads/${name}.cube`,
      props: [{ key: 'intensity', label: 'Intensity', default: 1, min: 0, max: 1 }],
    } };
  };
  const createChild = async (id, order, rgb) => ({
    id, order, name: id, fps, width, height, selectedId: null, fxDefs: await colorLut(id, rgb),
    items: [{
      id: `${id}-clip`, name: 'source.mp4', kind: 'video', src: '/media/uploads/source.mp4',
      track: 'V1', startFrame: 0, durationInFrames: 6, width, height,
      effects: [{ id: 'look', assetId: effectId }],
    }],
  });
  const children = await Promise.all([createChild('saved-red', 1, '1 0 0'), createChild('saved-green', 2, '0 1 0')]);
  const parent = {
    id: 'parent', order: 0, name: 'Parent', fps, width, height, selectedId: null,
    fxDefs: await colorLut('competing-blue', '0 0 1'),
    items: children.map((child, index) => ({
      id: `sequence-${child.id}`, kind: 'sequence', name: child.name, timelineId: child.id,
      track: 'V1', startFrame: index * 6, durationInFrames: 6,
    })),
  };
  const project = { version: 3, assets: [], mediaFolders: [], activeTimelineId: parent.id, timelines: [parent, ...children] };
  const stills = await renderTimelineStills({ state: parent, project, timelineId: parent.id, frames: [2, 8] });
  for (const [index, frame] of stills.entries()) {
    const jpg = join(directory, `scoped-lut-${index}.jpg`);
    await writeFile(jpg, Buffer.from(frame.base64, 'base64'));
    const { stdout } = await run(ffmpegPath, ['-v', 'error', '-i', jpg, '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { encoding: 'buffer' });
    assert.equal(stdout.length, 3);
    assert.ok(stdout[index] > 220 && stdout[(index + 1) % 3] < 35 && stdout[(index + 2) % 3] < 35,
      `timeline ${children[index].id} rendered competing LUT bytes (${[...stdout].join(',')})`);
  }
  console.log('clipFxExport.verify: nested timelines render their own saved same-ID LUTs');
} finally {
  await rm(directory, { recursive: true, force: true });
}
