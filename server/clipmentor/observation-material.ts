import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ffmpegBin, ffprobeBin } from '../media-binaries';
import { sha256File } from '../../shared/node-content-hash';
import type { ObservationMaterial } from '../../shared/clipmentor-source-video';
import { isObservationMaterial } from '../../shared/clipmentor-source-video';

interface Packet { stream_index: number; pts_time: string; duration_time?: string; flags: string; data_hash: string }
interface Probe { streams: Array<{ index: number; codec_type: string; codec_name: string }>; packets: Packet[]; format: { duration: string } }
const exec = promisify(execFile);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export function materialRange(ranges: number[][], duration: number): [number, number] {
  if (!finite(duration) || duration <= 0 || !ranges.length || ranges.some(r => !Array.isArray(r) || r.length !== 2
    || !r.every(finite) || r[0] < 0 || r[1] > duration || r[1] <= r[0])) throw Error('Invalid frozen observation range');
  return [Math.min(...ranges.map(r => r[0])), Math.max(...ranges.map(r => r[1]))];
}
async function probe(file: string, signal: AbortSignal): Promise<Probe> {
  const { stdout } = await exec(ffprobeBin(), ['-v','error','-show_packets','-show_data_hash','sha256',
    '-show_entries','packet=stream_index,pts_time,duration_time,flags,data_hash:stream=index,codec_type,codec_name:format=duration','-of','json',file],
  { signal, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  const result = JSON.parse(stdout) as Probe;
  if (!result.streams?.some(s => s.codec_type === 'video') || !result.streams.some(s => s.codec_type === 'audio')
    || !result.packets?.length || !finite(Number(result.format?.duration))) throw Error('Observation source requires playable video and audio');
  return result;
}

/** Verify every emitted AV packet against one contiguous parent subsequence, including source-time offset. */
export function verifyCopiedPackets(parent: Probe, child: Probe, requested?: [number,number]) {
  for(const media of [parent,child])if(media.streams.length!==2
    ||media.streams.filter(s=>s.codec_type==='video').length!==1||media.streams.filter(s=>s.codec_type==='audio').length!==1)
    throw Error('Excerpt requires one video and one audio stream; do not silently drop tracks');
  const offsets: number[] = [], ranges: Array<[number,number]> = [];
  for (const kind of ['video','audio']) {
    const sourceStream = parent.streams.find(s => s.codec_type === kind), outputStream = child.streams.find(s => s.codec_type === kind);
    if (!sourceStream || !outputStream || sourceStream.codec_name !== outputStream.codec_name) throw Error('Excerpt codec or audio changed');
    const before = parent.packets.filter(p => p.stream_index === sourceStream.index), after = child.packets.filter(p => p.stream_index === outputStream.index);
    if (!after.length || after.some(p => !p.data_hash || !Number.isFinite(Number(p.pts_time)))) throw Error('Excerpt packets unavailable');
    const candidates: number[] = [];
    for (let i = 0; i <= before.length - after.length; i++) if (before[i].data_hash === after[0].data_hash
      && after.every((p,j) => p.data_hash === before[i+j].data_hash)) candidates.push(i);
    if (candidates.length !== 1) throw Error('Excerpt parent packet identity ambiguous or changed');
    const copied = before.slice(candidates[0], candidates[0]+after.length);
    const offset = Number(copied[0].pts_time)-Number(after[0].pts_time);
    if (!Number.isFinite(offset)||after.some((p,i) => !Number.isFinite(Number(copied[i].pts_time))
      ||Math.abs(Number(copied[i].pts_time)-Number(p.pts_time)-offset) > 0.00002)) throw Error('Excerpt packet clock changed');
    offsets.push(offset);
    const track:[number,number]=[Math.min(...copied.map(p => Number(p.pts_time))), Math.max(...copied.map(p => Number(p.pts_time)+Number(p.duration_time ?? 0)))];
    if(requested) {
      const first=Math.min(...before.map(p=>Number(p.pts_time))),last=Math.max(...before.map(p=>Number(p.pts_time)+Number(p.duration_time??0)));
      if(track[0]>Math.max(requested[0],first)+0.00002||track[1]+0.00002<Math.min(requested[1],last))throw Error('Excerpt does not cover frozen question on both audio and video');
    }
    ranges.push(track);
  }
  if (Math.abs(offsets[0]-offsets[1]) > 0.00002) throw Error('Excerpt audio/video clock mismatch');
  return { offset: offsets[0], range: [Math.max(0,Math.min(...ranges.map(r => r[0]))),Math.max(...ranges.map(r => r[1]))] as [number,number],
    duration: Math.max(Number(child.format.duration), ...child.packets.map(p => Number(p.pts_time)+Number(p.duration_time ?? 0))) };
}

/** Selection is frozen before transport; one continuous, keyframe-expanded stream copy, never a failure fallback. */
export async function prepareObservationMaterial(options: { file: string; parentSha256: string; duration: number;
  range: [number,number] | null; directory: string; signal: AbortSignal }): Promise<{ file: string; binding: ObservationMaterial }> {
  const { file, parentSha256, duration, directory, signal } = options;
  signal.throwIfAborted();
  const range = options.range === null ? null : materialRange([options.range],duration);
  if (!/^[a-f0-9]{64}$/.test(parentSha256) || !finite(duration) || duration <= 0 || await sha256File(file) !== parentSha256) throw Error('Observation parent unavailable or changed');
  const parentBytes = (await stat(file)).size;
  if (!range || (range[0] === 0 && range[1] === duration)) return { file, binding: {
    version:'observation-material-v1',kind:'full_file',parent_sha256:parentSha256,parent_bytes:parentBytes,parent_duration_seconds:duration,
    requested_range_seconds:range,actual_source_range_seconds:[0,duration],submitted_sha256:parentSha256,submitted_bytes:parentBytes,
    submitted_duration_seconds:duration,source_seconds_at_submitted_zero:0,stream_copy:false,packet_payloads_verified:false,
    coverage:'submitted_range_only',complete_film_accepted:false } };
  await mkdir(directory,{recursive:true,mode:0o700});
  const cache = join(directory,sha(JSON.stringify([parentSha256,range])));
  const load = async () => {
    const binding = JSON.parse(await readFile(join(cache,'binding.json'),'utf8')) as ObservationMaterial;
    const result = join(cache,'excerpt.mp4');
    if (!isObservationMaterial(binding) || binding.kind !== 'stream_copy_excerpt'
      || binding.parent_sha256 !== parentSha256 || binding.parent_bytes !== parentBytes || binding.parent_duration_seconds !== duration
      || JSON.stringify(binding.requested_range_seconds) !== JSON.stringify(range) || !binding.packet_payloads_verified
      || binding.complete_film_accepted !== false || binding.coverage !== 'submitted_range_only'
      || await sha256File(result) !== binding.submitted_sha256 || (await stat(result)).size !== binding.submitted_bytes)
      throw Error('Saved observation excerpt identity mismatch');
    const copied = verifyCopiedPackets(await probe(file,signal),await probe(result,signal),range);
    if (JSON.stringify(copied.range) !== JSON.stringify(binding.actual_source_range_seconds)
      || copied.offset !== binding.source_seconds_at_submitted_zero || copied.duration !== binding.submitted_duration_seconds)
      throw Error('Saved observation excerpt clock mismatch');
    return { file:result,binding };
  };
  try { return await load(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const parent = await probe(file,signal), video = parent.streams.find(s => s.codec_type === 'video')!;
  if(parent.streams.length!==2||parent.streams.filter(s=>s.codec_type==='video').length!==1||parent.streams.filter(s=>s.codec_type==='audio').length!==1)
    throw Error('Excerpt requires one video and one audio stream; do not silently drop tracks');
  const keys = parent.packets.filter(p => p.stream_index === video.index && p.flags.includes('K')).map(p => Number(p.pts_time)).filter(finite).sort((a,b)=>a-b);
  const starts = keys.filter(t => t <= range[0]);
  if (!starts.length) throw Error('No decodable keyframe before observation');
  const start = Math.max(0,starts.at(-1)!), end = keys.find(t => t >= range[1]) ?? duration;
  const staging = await mkdtemp(join(directory,'.material-'));
  try {
    const output = join(staging,'excerpt.mp4');
    await exec(ffmpegBin(),['-v','error','-nostdin','-n','-ss',String(start),'-i',file,'-t',String(end-start),
      '-map','0:v:0','-map','0:a:0','-c','copy','-avoid_negative_ts','disabled','-movflags','+faststart',output],
    {signal,timeout:60_000,maxBuffer:65536});
    const copied = verifyCopiedPackets(parent,await probe(output,signal),range);
    if (copied.range[0] > range[0] || copied.range[1]+0.00002 < range[1]) throw Error('Excerpt does not cover frozen question range');
    if (await sha256File(file) !== parentSha256) throw Error('Observation parent changed during extraction');
    const binding: ObservationMaterial = {version:'observation-material-v1',kind:'stream_copy_excerpt',parent_sha256:parentSha256,parent_bytes:parentBytes,
      parent_duration_seconds:duration,requested_range_seconds:range,actual_source_range_seconds:copied.range,
      submitted_sha256:await sha256File(output),submitted_bytes:(await stat(output)).size,submitted_duration_seconds:copied.duration,
      source_seconds_at_submitted_zero:copied.offset,stream_copy:true,packet_payloads_verified:true,coverage:'submitted_range_only',complete_film_accepted:false};
    await writeFile(join(staging,'binding.json'),JSON.stringify(binding),{mode:0o600});
    try { await rename(staging,cache); } catch (error) { if (!['EEXIST','ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    return await load();
  } finally { await rm(staging,{recursive:true,force:true}); }
}
