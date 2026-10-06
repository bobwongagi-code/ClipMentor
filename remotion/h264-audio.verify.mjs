import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RenderInternals } from '@remotion/renderer';
import { renderH264WithPcmAudio } from './h264-audio.mjs';

const sampleRate = 48_000;
const durationSeconds = 3;
const root = await mkdtemp(path.join(tmpdir(), 'openchatcut-h264-audio-'));
const runFfmpeg = async (args) => RenderInternals.callFf({
  bin: 'ffmpeg',
  args: ['-hide_banner', '-loglevel', 'error', ...args],
  binariesDirectory: null,
  cancelSignal: undefined,
  logLevel: 'error',
  indent: false,
});
const runFfprobe = async (args) => RenderInternals.callFf({
  bin: 'ffprobe',
  args: ['-v', 'error', ...args],
  binariesDirectory: null,
  cancelSignal: undefined,
  logLevel: 'error',
  indent: false,
});

function createPcmWave() {
  const sampleCount = sampleRate * durationSeconds;
  const samples = Buffer.alloc(sampleCount * 2);
  let random = 0x6d2b79f5;
  let filtered = 0;
  for (let i = 0; i < sampleCount; i += 1) {
    random ^= random << 13;
    random ^= random >>> 17;
    random ^= random << 5;
    const noise = ((random >>> 16) & 0xffff) - 32768;
    filtered = 0.7 * noise + 0.3 * filtered;
    const time = i / sampleRate;
    const silentGap = time >= 1.08 && time < 1.21;
    const level = time < 0.7 ? 0.34 : time < 1.08 ? 0.22 : time < 1.8 ? 0.31 : 0.18;
    const value = silentGap ? 0 : Math.max(-32768, Math.min(32767, Math.round(filtered * level)));
    samples.writeInt16LE(value, i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.length, 40);
  return { wave: Buffer.concat([header, samples]), samples };
}

async function createVideoFrames(directory) {
  await mkdir(directory);
  const still = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwBfFaEYzqiH8OITBAtxm7fN1wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYBov8BDzRLTRAAAAAASUVORK5CYII=',
    'base64',
  );
  await Promise.all(Array.from({ length: durationSeconds * 24 }, (_, frame) => (
    writeFile(path.join(directory, `frame-${String(frame).padStart(4, '0')}.png`), still)
  )));
}

function sampleAt(pcm, index) {
  return pcm.readInt16LE(index * 2);
}

function findLag(reference, decoded) {
  const searchSamples = 4096;
  const windowStart = sampleRate / 2;
  const windowLength = 8192;
  const stride = 2;
  let best = { lag: 0, correlation: -Infinity };
  for (let lag = -searchSamples; lag <= searchSamples; lag += 1) {
    const start = windowStart + lag;
    if (start < 0 || start + windowLength >= decoded.length / 2) continue;
    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumYY = 0;
    let sumXY = 0;
    let count = 0;
    for (let i = 0; i < windowLength; i += stride) {
      const x = sampleAt(reference, windowStart + i);
      const y = sampleAt(decoded, start + i);
      sumX += x;
      sumY += y;
      sumXX += x * x;
      sumYY += y * y;
      sumXY += x * y;
      count += 1;
    }
    const centeredXX = count * sumXX - sumX * sumX;
    const centeredYY = count * sumYY - sumY * sumY;
    const denominator = Math.sqrt(centeredXX * centeredYY);
    const correlation = denominator === 0 ? 0 : (count * sumXY - sumX * sumY) / denominator;
    if (correlation > best.correlation) best = { lag, correlation };
  }
  return best;
}

async function extractPcm(input, output) {
  await runFfmpeg([
    '-i', input,
    '-map', '0:a:0', '-ac', '1', '-ar', String(sampleRate),
    '-c:a', 'pcm_s16le', '-y', output,
  ]);
  const wav = await readFile(output);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF', 'decoded audio must be WAV');
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    assert.ok(dataStart + size <= wav.length, `WAV ${id} chunk must fit in the file`);
    if (id === 'data') return wav.subarray(dataStart, dataStart + size);
    offset = dataStart + size + (size % 2);
  }
  assert.fail('decoded WAV must contain a data chunk');
}

async function videoPacketHashes(input) {
  const { stdout } = await runFfprobe([
    '-select_streams', 'v:0', '-show_packets', '-show_data_hash', 'sha256',
    '-show_entries', 'packet=data_hash', '-of', 'json', input,
  ]);
  return JSON.parse(stdout).packets.map((packet) => packet.data_hash);
}

async function assertHasVideoAndNoAudio(input) {
  const { stdout } = await runFfprobe([
    '-show_entries', 'stream=codec_type', '-of', 'json', input,
  ]);
  const types = JSON.parse(stdout).streams.map((stream) => stream.codec_type);
  assert.ok(types.includes('video'));
  assert.ok(!types.includes('audio'));
}

function assertAligned(measurement) {
  assert.ok(
    Math.abs(measurement.lag) <= 1,
    `audio should align within one sample; measured ${measurement.lag} samples`,
  );
}

try {
  const ffmpeg = RenderInternals.getExecutablePath({ type: 'ffmpeg', indent: false, logLevel: 'error' });
  const ffprobe = RenderInternals.getExecutablePath({ type: 'ffprobe', indent: false, logLevel: 'error' });
  await Promise.all([access(ffmpeg), access(ffprobe)]);

  const { wave, samples } = createPcmWave();
  const wavPath = path.join(root, 'nonperiodic.wav');
  const sourceMov = path.join(root, 'pcm-source.mov');
  const frameDirectory = path.join(root, 'frames');
  const videoOnlyMov = path.join(root, 'video-only.mov');
  const oldAac = path.join(root, 'old-intermediate.aac');
  const oldMp4 = path.join(root, 'old-adts-copy.mp4');
  const fixedMp4 = path.join(root, 'pcm-to-aac.mp4');
  await writeFile(wavPath, wave);
  await createVideoFrames(frameDirectory);
  await runFfmpeg([
    '-framerate', '24', '-start_number', '0', '-i', path.join(frameDirectory, 'frame-%04d.png'),
    '-frames:v', String(durationSeconds * 24),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-an', '-y', videoOnlyMov,
  ]);
  await runFfmpeg([
    '-i', videoOnlyMov, '-i', wavPath,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
    '-c:a', 'pcm_s16le', '-ar', String(sampleRate), '-ac', '1',
    '-shortest', '-y', sourceMov,
  ]);

  // Reproduce Remotion's AAC ADTS compression followed by a stream-copy mux.
  await runFfmpeg([
    '-i', wavPath, '-map', '0:a:0', '-c:a', 'libfdk_aac', '-f', 'adts',
    '-b:a', '320k', '-cutoff', '18000', '-y', oldAac,
  ]);
  await runFfmpeg([
    '-i', sourceMov, '-i', oldAac,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'copy',
    '-movflags', '+faststart', '-y', oldMp4,
  ]);
  const oldPcm = await extractPcm(oldMp4, path.join(root, 'old-decoded.wav'));
  const oldMeasurement = findLag(samples, oldPcm);
  assert.throws(() => assertAligned(oldMeasurement), assert.AssertionError,
    'ADTS + stream-copy path should fail the shared alignment gate');

  const renderOptionsSeen = [];
  const result = await renderH264WithPcmAudio({
    render: async (options) => {
      renderOptionsSeen.push(options);
      await writeFile(options.outputLocation, await readFile(sourceMov));
      return { rendered: true };
    },
    options: { codec: 'h264', outputLocation: fixedMp4, binariesDirectory: null, cancelSignal: undefined },
  });
  assert.deepEqual(result, { rendered: true });
  assert.equal(renderOptionsSeen[0].audioCodec, 'pcm-16');
  assert.equal(renderOptionsSeen[0].outputLocation, `${fixedMp4}.pcm.mov`);
  await assert.rejects(access(`${fixedMp4}.pcm.mov`), 'temporary PCM MOV should be removed');

  const fixedPcm = await extractPcm(fixedMp4, path.join(root, 'fixed-decoded.wav'));
  const fixedMeasurement = findLag(samples, fixedPcm);
  assertAligned(fixedMeasurement);

  const sourceVideoHashes = await videoPacketHashes(sourceMov);
  const fixedVideoHashes = await videoPacketHashes(fixedMp4);
  for (const [label, hashes] of [['source', sourceVideoHashes], ['final', fixedVideoHashes]]) {
    assert.equal(hashes.length, durationSeconds * 24, `${label} video should contain all expected packets`);
    assert.ok(hashes.every((hash) => typeof hash === 'string' && hash.length > 0),
      `${label} video packet hashes should be present`);
  }
  assert.deepEqual(fixedVideoHashes, sourceVideoHashes, 'AAC finalization must preserve video packets byte-for-byte');

  const silentOutput = path.join(root, 'silent-video.mp4');
  await renderH264WithPcmAudio({
    render: async (options) => {
      await writeFile(options.outputLocation, await readFile(videoOnlyMov));
      return 'silent render';
    },
    options: { codec: 'h264', outputLocation: silentOutput, binariesDirectory: null, cancelSignal: undefined },
  });
  await assertHasVideoAndNoAudio(silentOutput);

  const noOutputOptions = { codec: 'h264' };
  const noOutputResult = await renderH264WithPcmAudio({
    render: async (options) => options,
    options: noOutputOptions,
  });
  assert.equal(noOutputResult, noOutputOptions, 'missing output location should call render directly');

  const failedOutput = path.join(root, 'failed.mp4');
  const failedIntermediate = `${failedOutput}.pcm.mov`;
  await assert.rejects(renderH264WithPcmAudio({
    render: async (options) => {
      await writeFile(options.outputLocation, 'partial MOV');
      throw new Error('synthetic render failure');
    },
    options: { codec: 'h264', outputLocation: failedOutput },
  }), /synthetic render failure/);
  await assert.rejects(access(failedIntermediate), 'temporary PCM MOV should be removed after a render error');

  const muxFailedOutput = path.join(root, 'mux-failed.mp4');
  const muxFailedIntermediate = `${muxFailedOutput}.pcm.mov`;
  await assert.rejects(renderH264WithPcmAudio({
    render: async (options) => {
      await writeFile(options.outputLocation, 'not a MOV');
      return 'rendered';
    },
    options: { codec: 'h264', outputLocation: muxFailedOutput },
  }));
  await assert.rejects(access(muxFailedIntermediate), 'temporary PCM MOV should be removed after an FFmpeg error');

  console.log(JSON.stringify({
    oldAdtsCopyLagSamples: oldMeasurement.lag,
    oldAdtsCopyCorrelation: oldMeasurement.correlation,
    pcmToAacLagSamples: fixedMeasurement.lag,
    pcmToAacCorrelation: fixedMeasurement.correlation,
    preservedVideoPackets: fixedVideoHashes.length,
  }));
  console.log('H.264 PCM audio finalization verification passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
